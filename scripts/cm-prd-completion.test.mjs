import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {inspectPrdChangeSnapshot,inspectPrdChangeProposal,applyPrdChange} from '../runtime/js/cm-prd/change.mjs';
import {loadConfig} from './cm-workflow-config.mjs';
import {recordPrdReview} from './cm-prd-review-gate.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version='\n| 日期 | 版本 | 说明 |\n| --- | --- | --- |\n| 2026-09-08 | v1 | original |\n';
const docs=()=>[
  {path:'requirements.md',content:'## 需求版本'+version+'\n## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Read guide\n'},
  {path:'design.md',content:'## 设计版本'+version+'\n## 方案摘要\nExisting guide\n'},
  {path:'tasks.md',content:'## 任务版本'+version+'\n- [x] T-001: Existing guide\n- [ ] T-002: Draft appendix\n'}];
const revised=()=>docs().map(doc=>({path:doc.path,content:doc.content.replace('| 2026-09-08 | v1 | original |','| 2026-09-08 | v1 | original |\n| 2026-09-08 | v2 | change |')
  .replace('Existing guide\n','Existing guide\n')+(doc.path==='tasks.md'?'\n- [ ] T-003: [NEW] Add example\n':'\nUpdated example\n')}));
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-complete-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));fs.mkdirSync(path.join(dir,'mirror'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic guide');fs.mkdirSync(path.join(dir,'1.guide'));
  for(const doc of docs())fs.writeFileSync(path.join(dir,'1.guide',doc.path),doc.content,{mode:0o600});return dir;}
async function client(t,dir,respond,{session,change=true,review=false}={}){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--project',dir,'--specs',dir,'--runtime','codex','--allow-log-write','--allow-spec-write',
    ...(change?['--change','1.guide']:[]),...(session?['--session',session]:[]),
    ...(review?['--allow-review-write','--allow-disposition-write','--host-context','synthetic-author']:[])],
    {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});let error='',sessionId,seq=0;
  child.stderr.on('data',bytes=>error+=bytes);const pending=new Map();let readyResolve,readyReject;
  const ready=new Promise((yes,no)=>{readyResolve=yes;readyReject=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;readyResolve();}
    else if(message.type==='host_request')Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(readyReject);
    else if(message.requestId&&pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)readyReject(Error(error));for(const resolve of pending.values())resolve({closed:code,error});pending.clear();});
  await ready;
  return {child,request:async(operation,fields={})=>{const requestId=`test-${++seq}`;return new Promise(resolve=>{
    pending.set(requestId,resolve);send({requestId,operation,...fields});});},
    close:async()=>{send({type:'host_close',sessionId});const [code]=await once(child,'close');assert.equal(code,0,error);}};
}
function changeResponse({kind,payload}){
  if(kind==='prd_analyze')return {status:'analyzed',summary:'Add example',openQuestions:[]};
  if(kind==='prd_generate'){
    const all=revised(),full=payload.phase==='change_tasks';
    return {status:full?'draft':'documents',summary:'Add example',features:[{directory:'1.guide',
      documents:all.filter(doc=>full||doc.path==='requirements.md'||payload.phase==='change_design'&&doc.path==='design.md'),
      ...(full?{testCasesReason:'no_observable_behavior'}:{})}],removed:[]};
  }
  assert.equal(kind,'prd_self_check');return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
    checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic fixture exact original task and code inspection']}))}))};
}
test('actual change CLI resumes unsaved phase across processes and stops at human review', {timeout:25000},async t=>{
  const dir=fixture(t);let calls=0;const respond=message=>{calls++;return changeResponse(message);};
  let c=await client(t,dir,respond);let result=await c.request('start',{text:'Add example'});assert.equal(result.result.stage,'change_requirements');
  result=await c.request('advance',{text:'Requirements'});assert.equal(result.result.stage,'change_design');
  const {runId}= (await c.request('status')).result;await c.close();
  c=await client(t,dir,respond,{session:runId});assert.equal((await c.request('status')).result.stage,'change_design');
  for(const text of ['Design','Tasks','Check']){result=await c.request('advance',{text});assert.ok(result.result,JSON.stringify(result));}
  assert.equal(result.result.stage,'change_confirmation');const proposalDigest=result.result.proposal.proposalDigest;
  assert.equal((await c.request('save_draft')).error.code,'host_request_failed');
  assert.ok((await c.request('decision',{proposalDigest,approved:true,allowUserCaseChanges:false})).result);
  result=await c.request('save_draft');assert.equal(result.result.status,'awaiting_review');assert.equal(result.result.counts.preservedCompletedTasks,1);
  assert.equal(calls,5);assert.match(fs.readFileSync(path.join(dir,'1.guide/tasks.md'),'utf8'),/- \[x\] T-001: Existing guide/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.cm-specs-status'))).specFiles.length,3);await c.close();
  const rows=fs.readFileSync(path.join(dir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const progress=rows.filter(row=>row.event==='progress');assert.ok(progress.length>0);
  for(const row of progress.filter(row=>row.phase==='start'))assert.equal(progress.filter(other=>other.phase==='complete'
    &&other.operation_id===row.operation_id&&other.segment===row.segment).length,1);
  c=await client(t,dir,()=>assert.fail('completed recovery must not call host'),{session:runId});
  assert.equal((await c.request('status')).result.stage,'awaiting_review');await c.close();
});
test('unknown host generation resumes only its exact original receipt, no repeat call', {timeout:25000},async t=>{
  const dir=fixture(t);let original;
  let c=await client(t,dir,message=>{
    if(message.kind==='prd_generate'){original=message;setImmediate(()=>c.child.kill('SIGKILL'));return undefined;}
    return changeResponse(message);
  });await c.request('start',{text:'Add example'});const runId=(await c.request('status')).result.runId;
  const crashed=await c.request('advance',{text:'Requirements'});assert.equal(crashed.closed,null);
  c=await client(t,dir,()=>assert.fail('unknown call may not be dispatched again'),{session:runId});
  assert.ok((await c.request('advance',{text:'Try again'})).error);
  assert.ok((await c.request('resume',{resolution:null})).error);
  const recovery=original.payload.recovery;
  const result=await c.request('resume',{resolution:{callId:recovery.callId,requestDigest:recovery.requestDigest,
    result:changeResponse(original),evidence:'Synthetic original host saved output, not a new generation'}});
  assert.equal(result.result.stage,'change_design');await c.close();
});
test('controlled inventory revision retains old review and archives removed feature/assets',t=>{
  const dir=fixture(t);fs.mkdirSync(path.join(dir,'2.obsolete'));for(const doc of docs())
    fs.writeFileSync(path.join(dir,'2.obsolete',doc.path),doc.content.replace('[x]','[ ]'),{mode:0o600});
  fs.writeFileSync(path.join(dir,'2.obsolete','asset.txt'),'original retained asset');fs.mkdirSync(path.join(dir,'.reviews'));
  const evidence=path.join(dir,'.reviews/prd-guide-split-r1.md'),receipt=path.join(dir,'.reviews/prd-guide-split-disposition.json');
  fs.writeFileSync(evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.guide/tasks.md\n---\nSynthetic original review',{mode:0o600});
  recordPrdReview({stage:'split',feature:'guide',evidence,receipt,disposition:'no_findings',finding_count:0,unresolved_count:0,
    artifact:docs().map(doc=>path.join(dir,'1.guide',doc.path))});
  const originalReview=fs.readFileSync(evidence),before=inspectPrdChangeSnapshot(dir),raw={status:'draft',summary:'Explicit inventory revision',removed:['2.obsolete'],features:[
    {directory:'1.guide',documents:revised(),testCasesReason:'no_observable_behavior'},
    {directory:'3.examples',documents:docs().map(doc=>({...doc,content:doc.content.replace('[x]','[ ]')})),testCasesReason:'no_observable_behavior'}]};
  const selected=['1.guide','2.obsolete'],proposal=inspectPrdChangeProposal(before,raw,selected,loadConfig({projectRoot:dir}));
  const result=applyPrdChange({specs:dir,before,proposal,selected});assert.deepEqual(result.features,['1.guide','3.examples']);
  assert.ok(fs.readFileSync(evidence).equals(originalReview));assert.equal(fs.existsSync(path.join(dir,'2.obsolete')),false);
  assert.equal(fs.readFileSync(path.join(dir,`.reviews/prd-change-${proposal.proposalDigest}-removed/2.obsolete/asset.txt`),'utf8'),'original retained asset');
  assert.equal(applyPrdChange({specs:dir,before,proposal,selected}).status,'awaiting_review');
  fs.writeFileSync(path.join(dir,'1.guide/design.md'),'User third version');
  assert.throws(()=>applyPrdChange({specs:dir,before,proposal,selected}),/conflict/);
  assert.equal(fs.readFileSync(path.join(dir,'1.guide/design.md'),'utf8'),'User third version');
});
test('change cannot invent completion or erase completed lines; user case changes are surfaced',t=>{
  const dir=fixture(t),before=inspectPrdChangeSnapshot(dir),config=loadConfig({projectRoot:dir});
  const raw={status:'draft',summary:'Change',removed:[],features:[{directory:'1.guide',documents:revised(),testCasesReason:'no_observable_behavior'}]};
  for(const mode of ['erase','invent']){const bad=structuredClone(raw);const task=bad.features[0].documents.find(doc=>doc.path==='tasks.md');
    task.content=mode==='erase'?task.content.replace('[x]','[ ]'):task.content.replace('- [ ] T-002: Draft appendix','- [x] T-002: Draft appendix [CHANGED]');
    assert.throws(()=>inspectPrdChangeProposal(before,bad,['1.guide'],config),/prd_completed_task/);}
  const synthetic={...before,files:{...before.files,'1.guide/test-cases.json':JSON.stringify({cases:[{id:'TC-001',origin:'user',expected:'Original user intent'}]})}};
  const proposal=inspectPrdChangeProposal(synthetic,raw,['1.guide'],config);assert.equal(proposal.changedUserCases.length,1);
});
test('generate_cases false retains unchanged existing generated cases, forbids new generation',t=>{
  const dir=fixture(t),before=inspectPrdChangeSnapshot(dir),config=loadConfig({projectRoot:dir});
  const contract={schemaVersion:'1.0',feature:'guide',cases:[{id:'TC-001',origin:'generated',kind:'logic',blocking:true,
    acIds:['AC-001'],taskIds:['T-002'],title:'Existing case',preconditions:[],steps:['Read guide'],expected:['Guide available'],cleanup:[]}]};
  const content=JSON.stringify(contract),source={...before,files:{...before.files,'1.guide/test-cases.json':content}};
  const raw={status:'draft',summary:'Keep original cases',removed:[],features:[{directory:'1.guide',testCasesReason:null,
    documents:[...revised(),{path:'test-cases.json',content}]}]};
  const disabled={...config,policies:{...config.policies,generate_cases:false}};
  assert.equal(inspectPrdChangeProposal(source,raw,['1.guide'],disabled).changedUserCases.length,0);
  const modified=structuredClone(raw);contract.cases[0].expected=['New generated expectation'];
  modified.features[0].documents.at(-1).content=JSON.stringify(contract);
  assert.throws(()=>inspectPrdChangeProposal(source,modified,['1.guide'],disabled),/prd_generated_cases_disabled/);
  const noCases={...raw,features:[{directory:'1.guide',documents:revised(),testCasesReason:'generation_disabled'}]};
  assert.equal(inspectPrdChangeProposal(before,noCases,['1.guide'],disabled).features[0].testCasesReason,'generation_disabled');
});
for(const recoveryMode of ['process-loss','mode-mismatch','publication-conflict'])test(`new draft/original review recovery: ${recoveryMode}`, {timeout:25000},async t=>{
  const dir=fixture(t);let original,calls=0;
  const reviewResult=payload=>({reviewer:'codex-subagent',contextId:'synthetic-independent',independent:true,at:'2026-09-08T00:00:00.000Z',
    result:{verdict:'approved',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic no findings'}});
  const respond=message=>{
    calls++;const {kind,payload}=message;
    if(kind==='prd_analyze')return {status:'analyzed',summary:'New documentation',sourcePaths:['docs/input.md'],openQuestions:[]};
    if(kind==='prd_generate')return {status:'draft',summary:'New guide',features:[{name:'new-guide',documents:docs().map(doc=>({
      ...doc,content:doc.content.replace('[x]','[ ]')})),testCasesReason:'no_observable_behavior'}]};
    if(kind==='prd_self_check')return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
      checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic original context check']}))}))};
    assert.equal(kind,'prd_review');original=message;
    if(recoveryMode==='publication-conflict'){
      fs.mkdirSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md'));return reviewResult(payload);
    }
    setImmediate(()=>c.child.kill('SIGKILL'));return undefined;
  };
  let c=await client(t,dir,respond,{change:false,review:true});
  await c.request('start',{text:'New guide'});await c.request('advance',{text:'Draft'});
  const prior=(await c.request('status')).result,runId=prior.runId;await c.close();
  c=await client(t,dir,respond,{session:runId,change:false,review:true});
  const restored=(await c.request('status')).result;assert.deepEqual(restored.draft,prior.draft);assert.equal(restored.selfCheckRound,1);
  await c.request('advance',{text:'Check'});await c.request('save_draft');
  assert.ok((await c.request('prepare_revision',{reason:'Cannot bypass original split'})).error);
  const initial=await c.request('final_review',{stage:'split',feature:'2.new-guide',mode:'independent'});
  if(recoveryMode==='publication-conflict'){
    assert.equal(initial.result.reviewState.status,'review_unknown');
    const pending=(await c.request('status')).result.recovery;
    assert.equal(pending.calls[0].status,'recorded');await c.close();
    fs.rmdirSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md'));
  }
  c=await client(t,dir,()=>assert.fail('original review must not be dispatched again'),{session:runId,change:false,review:true});
  const {payload}=original,recovery=payload.recovery;
  const result=reviewResult(payload);
  if(recoveryMode==='mode-mismatch')Object.assign(result,{reviewer:'self-degraded',contextId:'synthetic-author',independent:false,degradedReason:'Synthetic original host selected an unapproved mode'});
  let reply=await c.request('resume',{resolution:recoveryMode==='publication-conflict'?null:{callId:recovery.callId,requestDigest:recovery.requestDigest,result,
    evidence:'Synthetic retained original reviewer output'}});
  if(recoveryMode==='mode-mismatch'){
    assert.ok(reply.error);assert.equal(fs.existsSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md')),false);
    assert.equal((await c.request('status')).result.recovery.calls[0].status,'recorded');await c.close();return;
  }
  assert.equal(reply.result.reviewState.status,'review_recorded',JSON.stringify(reply));
  const evidence=fs.readFileSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md'));
  const findings=(await c.request('review_findings',{stage:'split',feature:'2.new-guide'})).result;
  reply=await c.request('review_disposition',{stage:'split',feature:'2.new-guide',packageDigest:findings.packageDigest,decisions:[],artifacts:findings.reviewedArtifacts});
  assert.equal(reply.result.status,'disposition_recorded');
  reply=await c.request('prepare_revision',{reason:'Explicit requirements revision and inventory changes for human confirmation'});
  assert.equal(reply.result.mode,'change');assert.equal(reply.result.stage,'ready');assert.deepEqual(reply.result.selected,['2.new-guide']);
  assert.ok(fs.readFileSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md')).equals(evidence));
  assert.equal(fs.existsSync(path.join(dir,'.reviews/prd-new-guide-split-r2.md')),false);assert.equal(calls,4);await c.close();
});
