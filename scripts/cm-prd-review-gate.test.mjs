import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectPrdReview,recordPrdReview} from './cm-prd-review-gate.mjs';
import {diagnosticReason} from '../runtime/js/cm-ai/diagnostic-reason.mjs';
import {executionDiagnostic} from '../runtime/js/cm-ai/effect-contract.mjs';
function fixture(t,documents){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-marks-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.reviews'));
  const args={stage:'split',feature:'guide',evidence:path.join(root,'.reviews/prd-guide-split-r1.md'),
    receipt:path.join(root,'.reviews/prd-guide-split-disposition.json')};
  fs.writeFileSync(args.evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - tasks.md\n---\nSynthetic fixture review');
  for(const [name,content] of Object.entries(documents))fs.writeFileSync(path.join(root,name),content);
  const record={...args,disposition:'no_findings',finding_count:0,unresolved_count:0,
    artifact:Object.keys(documents).map(name=>path.join(root,name))};
  recordPrdReview(record);return {root,args,record};
}
for(const mark of ['x','X'])test(`receipt accepts only runtime ${mark} marks without rewriting evidence`,t=>{
  const {root,args,record}=fixture(t,{'tasks.md':'- [ ] T-001: 文档\r\n','requirements.md':'- [ ] [AC-001] 文档\r\n'});
  const receipt=fs.readFileSync(args.receipt),evidence=fs.readFileSync(args.evidence);
  assert.deepEqual(inspectPrdReview(args),{stage:'split',feature:'guide',outcome:'completed',disposition:'no_findings'});
  for(const name of ['tasks.md','requirements.md']){
    const file=path.join(root,name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('[ ]',`[${mark}]`));
  }
  assert.deepEqual(inspectPrdReview(args),{stage:'split',feature:'guide',outcome:'completed',disposition:'no_findings',runtimeMarksNormalized:true});
  assert.equal(recordPrdReview(record).outcome,'already_recorded');
  assert.deepEqual(fs.readFileSync(args.receipt),receipt);assert.deepEqual(fs.readFileSync(args.evidence),evidence);
});
for(const [name,before,after] of [
  ['tasks.md','- [ ] T-001: Guide\n','- [x] T-001: Guides\n'],
  ['requirements.md','- [ ] [AC-001] Guide\n','- [x] [AC-001] Guides\n'],
  ['tasks.md','- [ ] T-001: Guide\r\n','- [x] T-001: Guide\n'],
  ['tasks.md','- [ ] T-001: Guide\n- [DROPPED] T-002: Old\n','- [x] T-001: Guide\n- [CHANGED] T-002: Old\n'],
  ['tasks.md','```md\n- [ ] T-001: Example\n```','```md\n- [x] T-001: Example\n```'],
  ['tasks.md','    - [ ] T-001: Example','    - [x] T-001: Example'],
  ['tasks.md','Prose - [ ] T-001: Example','Prose - [x] T-001: Example'],
  ['tasks.md','- [ ] General checkbox','- [x] General checkbox'],
  ['tasks.md','- [ ] [AC-001] Wrong file','- [x] [AC-001] Wrong file'],
  ['design.md','- [ ] T-001: Example','- [x] T-001: Example'],
  ['test-cases.json','{"cases":[]}','{"cases":[]}\n'],
  ['test-cases.json','{"note":"- [ ] T-001: Example"}','{"note":"- [x] T-001: Example"}'],
])test(`receipt rejects non-runtime drift: ${name} ${JSON.stringify(after)}`,t=>{
  const {root,args}=fixture(t,{[name]:before});fs.writeFileSync(path.join(root,name),after);
  assert.throws(()=>inspectPrdReview(args),/PRD review artifact changed after disposition/);
});
test('runtime mark in another artifact cannot mask JSON drift',t=>{
  const {root,args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide','test-cases.json':'{"cases":[]}'});
  fs.writeFileSync(path.join(root,'tasks.md'),'- [x] T-001: Guide');
  fs.appendFileSync(path.join(root,'test-cases.json'),' ');
  assert.throws(()=>inspectPrdReview(args),/PRD review artifact changed after disposition/);
});
test('raw completed receipt remains valid but unchecking it cannot match a normalized receipt',t=>{
  const {root,args}=fixture(t,{'tasks.md':'- [x] T-001: Guide'});
  assert.equal(inspectPrdReview(args).runtimeMarksNormalized,undefined);
  fs.writeFileSync(path.join(root,'tasks.md'),'- [ ] T-001: Guide');
  assert.throws(()=>inspectPrdReview(args),/PRD review artifact changed after disposition/);
});
test('normalization does not replace invalid UTF-8 with a formerly reviewed replacement character',t=>{
  const {root,args}=fixture(t,{'tasks.md':'- [ ] T-001: \ufffd'});
  fs.writeFileSync(path.join(root,'tasks.md'),Buffer.concat([Buffer.from('- [x] T-001: '),Buffer.from([0xff])]));
  assert.throws(()=>inspectPrdReview(args),/PRD review artifact changed after disposition/);
});
// Hosts read error.code and the tagged reason; the CLI and its Python oracle keep reading the message.
const refusal=(action,code,message)=>{
  let error;try{action();}catch(caught){error=caught;}
  assert.ok(error,`expected ${code}`);assert.equal(error.code,code);if(message)assert.equal(error.message,message);
  return diagnosticReason(error);
};
test('a changed artifact refuses with a stable code naming the receipt and the artifact',t=>{
  const {root,args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});
  const recorded=createHash('sha256').update('- [ ] T-001: Guide\n').digest('hex');
  fs.writeFileSync(path.join(root,'tasks.md'),'- [ ] T-001: Guides\n');
  assert.deepEqual(refusal(()=>inspectPrdReview(args),'prd_review_artifact_changed','PRD review artifact changed after disposition'),
    {receipt:'.reviews/prd-guide-split-disposition.json',artifact:'tasks.md',recordedSha256:recorded,
      currentSha256:createHash('sha256').update('- [ ] T-001: Guides\n').digest('hex')});
});
test('every other gate refusal reachable from hosts carries a stable code',t=>{
  const cases=[
    ['prd_review_receipt_evidence_mismatch',({args})=>fs.appendFileSync(args.evidence,'\nedited'),
      {receipt:'.reviews/prd-guide-split-disposition.json',evidence:'.reviews/prd-guide-split-r1.md'}],
    ['prd_review_r2_forbidden',({args})=>fs.writeFileSync(args.evidence.replace('-r1.md','-r2.md'),'second attempt'),
      {evidence:'.reviews/prd-guide-split-r2.md'}],
    ['prd_review_evidence_missing',({args})=>fs.unlinkSync(args.evidence),
      {receipt:'.reviews/prd-guide-split-disposition.json',evidence:'.reviews/prd-guide-split-r1.md'}],
    ['prd_review_receipt_invalid',({args})=>fs.writeFileSync(args.receipt,'{not json'),{receipt:'.reviews/prd-guide-split-disposition.json'}],
    ['prd_review_receipt_invalid',({args})=>fs.writeFileSync(args.receipt,'null'),{receipt:'.reviews/prd-guide-split-disposition.json'}],
    ['prd_review_dispatch_invalid',({args})=>fs.writeFileSync(args.evidence.replace('-r1.md','-dispatch.json'),'{}'),
      {dispatch:'.reviews/prd-guide-split-dispatch.json'}],
    ['prd_review_evidence_invalid',({args})=>fs.writeFileSync(args.evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\n---\nBody'),
      {evidence:'.reviews/prd-guide-split-r1.md',field:'scope'}],
    ['prd_review_record_timestamp_invalid',({args})=>fs.writeFileSync(args.evidence,'---\nat: yesterday\nreviewer: codex-subagent\nindependent: true\nscope:\n  - tasks.md\n---\nBody'),
      {file:'.reviews/prd-guide-split-r1.md',field:'at'}],
  ];
  for(const [code,damage,reason] of cases){
    const context=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});damage(context);
    assert.deepEqual(refusal(()=>inspectPrdReview(context.args),code),reason,code);
  }
  const {root,record}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});fs.unlinkSync(record.receipt);
  assert.deepEqual(refusal(()=>recordPrdReview({...record,artifact:[path.join(root,'tasks.md'),path.join(root,'tasks.md')]}),
    'prd_review_artifact_duplicate','artifact must not be duplicated'),{artifact:'tasks.md'});
  refusal(()=>inspectPrdReview({...record,stage:'final'}),'prd_review_stage_invalid','invalid stage');
});
test('an unsafe artifact path is refused without echoing the raw path',t=>{
  for(const unsafe of ['/private/owner/secret-notes.md','../outside.md']){
    const {args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});
    const receipt=JSON.parse(fs.readFileSync(args.receipt,'utf8'));receipt.artifacts[0].path=unsafe;
    fs.writeFileSync(args.receipt,JSON.stringify(receipt)+'\n');
    const reason=refusal(()=>inspectPrdReview(args),'prd_review_artifact_unsafe','PRD review receipt contains an unsafe artifact path');
    assert.deepEqual(reason,{receipt:'.reviews/prd-guide-split-disposition.json'},unsafe);
    assert.equal(JSON.stringify(reason).includes(unsafe),false,unsafe);
  }
});
test('invalid UTF-8 in evidence, receipt or dispatch refuses with a tagged code and keeps the decoder message',t=>{
  const invalid=Buffer.from([0x2d,0x2d,0x2d,0x0a,0xff,0xfe,0x0a]);
  for(const [code,file,reason] of [
    ['prd_review_evidence_invalid',args=>args.evidence,{evidence:'.reviews/prd-guide-split-r1.md'}],
    ['prd_review_receipt_invalid',args=>args.receipt,{receipt:'.reviews/prd-guide-split-disposition.json'}],
    ['prd_review_dispatch_invalid',args=>args.evidence.replace('-r1.md','-dispatch.json'),{dispatch:'.reviews/prd-guide-split-dispatch.json'}],
  ]){
    const {args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});fs.writeFileSync(file(args),invalid);
    let error;try{inspectPrdReview(args);}catch(caught){error=caught;}
    assert.equal(error?.code,code);assert.deepEqual(diagnosticReason(error),reason,code);
    assert.match(error.message,/encoded data was not valid/i,code);
  }
});
test('an unreadable review file refuses with a code and a specs-relative name, never the absolute path',t=>{
  if(process.getuid?.()===0)return t.skip('root can read any file');
  for(const [code,file,reason] of [
    ['prd_review_evidence_invalid',args=>args.evidence,{evidence:'.reviews/prd-guide-split-r1.md'}],
    ['prd_review_receipt_invalid',args=>args.receipt,{receipt:'.reviews/prd-guide-split-disposition.json'}],
    ['prd_review_dispatch_invalid',args=>{const dispatch=args.evidence.replace('-r1.md','-dispatch.json');
      fs.writeFileSync(dispatch,JSON.stringify({schema_version:1,stage:'split',feature:'guide',package_sha256:'a'.repeat(64),status:'started',at:'2026-09-08T00:00:00Z'}));return dispatch;},
      {dispatch:'.reviews/prd-guide-split-dispatch.json'}],
  ]){
    const {root,args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});const target=file(args);fs.chmodSync(target,0o000);
    t.after(()=>{try{fs.chmodSync(target,0o600);}catch{}});
    let error;try{inspectPrdReview(args);}catch(caught){error=caught;}
    fs.chmodSync(target,0o600);
    assert.equal(error?.code,code);assert.deepEqual(diagnosticReason(error),reason,code);
    assert.equal(Object.hasOwn(error,'path'),false,code);
    const shown=JSON.stringify({...executionDiagnostic(error),reason:diagnosticReason(error)});
    assert.equal(shown.includes(root),false,code);
  }
});
test('every count refusal names the receipt and the field',t=>{
  for(const [field,edit] of [['unresolved_count',value=>({...value,unresolved_count:1})],
    ['finding_count',value=>({...value,finding_count:-1})],['disposition',value=>({...value,disposition:'maybe'})],
    ['finding_count',value=>({...value,finding_count:2,unresolved_count:0})]]){
    const {args}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});
    fs.writeFileSync(args.receipt,JSON.stringify(edit(JSON.parse(fs.readFileSync(args.receipt,'utf8'))))+'\n');
    const reason=refusal(()=>inspectPrdReview(args),field==='disposition'?'prd_review_disposition_invalid':'prd_review_counts_invalid');
    assert.deepEqual(reason,{receipt:'.reviews/prd-guide-split-disposition.json',field},field);
  }
  const {root,record}=fixture(t,{'tasks.md':'- [ ] T-001: Guide\n'});fs.unlinkSync(record.receipt);
  assert.deepEqual(refusal(()=>recordPrdReview({...record,finding_count:0,unresolved_count:1}),'prd_review_counts_invalid'),
    {receipt:'.reviews/prd-guide-split-disposition.json',field:'unresolved_count'});
  assert.equal(fs.existsSync(path.join(root,'.reviews/prd-guide-split-disposition.json')),false);
});
