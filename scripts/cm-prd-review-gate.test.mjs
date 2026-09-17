import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectPrdReview,recordPrdReview} from './cm-prd-review-gate.mjs';
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
