// A review-gate refusal inside the real cm-prd host must reach the operator as a
// stable code and a reason naming the receipt and artifact (stderr only), instead
// of host_request_failed with detail:"unavailable". The peer reply is unchanged.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {recordPrdReview} from './cm-prd-review-gate.mjs';

// Runtime declarations and log mirrors never touch the invoking user's home.
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-gate-diagnostic-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

const version='\n| 日期 | 版本 | 说明 |\n| --- | --- | --- |\n| 2026-09-08 | v1 | original |\n';
const docs=()=>[
  {path:'requirements.md',content:'## 需求版本'+version+'\n## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Read guide\n'},
  {path:'design.md',content:'## 设计版本'+version+'\n## 方案摘要\nExisting guide\n'},
  {path:'tasks.md',content:'## 任务版本'+version+'\n- [x] T-001: Existing guide\n- [ ] T-002: Draft appendix\n'}];
const revised=()=>docs().map(doc=>({path:doc.path,content:doc.content.replace('| 2026-09-08 | v1 | original |',
  '| 2026-09-08 | v1 | original |\n| 2026-09-08 | v2 | change |')+(doc.path==='tasks.md'?'\n- [ ] T-003: [NEW] Add example\n':'\nUpdated example\n')}));

function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-gate-diagnostic-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'docs'));fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic guide');
  fs.mkdirSync(path.join(dir,'1.guide'));
  for(const doc of docs())fs.writeFileSync(path.join(dir,'1.guide',doc.path),doc.content,{mode:0o600});
  const reviews=path.join(dir,'.reviews');fs.mkdirSync(reviews,{mode:0o700});
  const evidence=path.join(reviews,'prd-guide-split-r1.md'),receipt=path.join(reviews,'prd-guide-split-disposition.json');
  fs.writeFileSync(evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.guide/tasks.md\n---\nSynthetic original review',{mode:0o600});
  recordPrdReview({stage:'split',feature:'guide',evidence,receipt,disposition:'no_findings',finding_count:0,unresolved_count:0,
    artifact:docs().map(doc=>path.join(dir,'1.guide',doc.path))});
  return dir;
}

// Drives the real host: start -> confirmation -> decision -> save_draft.
async function hostChange(t,dir){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--project',dir,'--specs',dir,'--runtime','codex','--allow-log-write','--allow-spec-write','--change','1.guide'],
    {env:process.env,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let stderr='',sessionId,seq=0;child.stderr.on('data',bytes=>stderr+=bytes);
  const pending=new Map();let ready,failed;const started=new Promise((yes,no)=>{ready=yes;failed=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const respond=({kind,payload})=>{
    if(kind==='prd_analyze')return {status:'analyzed',summary:'Add example',openQuestions:[]};
    if(kind==='prd_generate'){const full=payload.phase==='change_tasks';
      return {status:full?'draft':'documents',summary:'Add example',features:[{directory:'1.guide',
        documents:revised().filter(doc=>full||doc.path==='requirements.md'||payload.phase==='change_design'&&doc.path==='design.md'),
        ...(full?{testCasesReason:'no_observable_behavior'}:{})}],removed:[]};}
    assert.equal(kind,'prd_self_check');
    return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
      checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic exact task and code inspection']}))}))};
  };
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;ready();}
    else if(message.type==='host_request')send({type:'host_result',sessionId,callId:message.callId,
      requestDigest:message.requestDigest,result:respond(message)});
    else if(message.requestId&&pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',()=>{if(!sessionId)failed(Error(stderr));});
  await started;
  const request=(operation,fields={})=>new Promise(resolve=>{const requestId=`r-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});});
  let reply=await request('start',{text:'Add example'});
  for(const text of ['Requirements','Design','Tasks','Check'])reply=await request('advance',{text});
  assert.equal(reply.result.stage,'change_confirmation',JSON.stringify(reply));
  const proposalDigest=reply.result.proposal.proposalDigest;
  assert.equal((await request('decision',{proposalDigest,approved:true,allowUserCaseChanges:false})).result.stage,'confirmed');
  const saved=await request('save_draft');
  send({type:'host_close',sessionId});const [code]=await once(child,'close');assert.equal(code,0,stderr);
  return {saved,diagnostics:stderr.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))};
}

test('a stale review stops save_draft with the gate code and the receipt and artifact on stderr', {timeout:120000},async t=>{
  const dir=fixture(t);
  fs.appendFileSync(path.join(dir,'1.guide/design.md'),'\nEdited after its review\n');
  const before=fs.readFileSync(path.join(dir,'1.guide/design.md'));
  const {saved,diagnostics}=await hostChange(t,dir);
  assert.deepEqual(saved.error,{code:'host_request_failed'});
  assert.equal(diagnostics.length,1);
  const [diagnostic]=diagnostics;
  assert.deepEqual({diagnostic:diagnostic.diagnostic,operation:diagnostic.operation,code:diagnostic.code},
    {diagnostic:'host_request_failed',operation:'save_draft',code:'prd_review_artifact_changed'});
  assert.equal(diagnostic.detail,undefined);
  assert.deepEqual(Object.keys(diagnostic.reason).sort(),['artifact','currentSha256','receipt','recordedSha256']);
  assert.equal(diagnostic.reason.receipt,'.reviews/prd-guide-split-disposition.json');
  assert.equal(diagnostic.reason.artifact,'1.guide/design.md');
  assert.notEqual(diagnostic.reason.recordedSha256,diagnostic.reason.currentSha256);
  // Nothing was written: the refusal happens before the save touches specs.
  assert.ok(fs.readFileSync(path.join(dir,'1.guide/design.md')).equals(before));
  assert.equal(fs.existsSync(path.join(dir,'.cm-specs-status')),false);
});
