import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {inspectPrdReviewResponse,publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {recoverPrdResponse} from '../runtime/js/cm-prd/response-recovery.mjs';
import {normalizePrdReviewTimestamp} from '../runtime/js/cm-prd/review-time.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

function fixture(t,{legacy=false}={}){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-response-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'.reviews'));
  fs.mkdirSync(path.join(specs,'docs'));fs.writeFileSync(path.join(specs,'docs/input.md'),'Synthetic input');
  const prepared=preparePrdReview({specs,stage:'split',feature:'1.guide',draft:{draftDigest:'a'.repeat(64),features:[{
    directory:'1.guide',name:'guide',documents:[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide'},
      {path:'design.md',content:'## 方案摘要\nDocumentation'},{path:'tasks.md',content:'- [ ] T-001: Guide'}]}]}});
  const response={reviewer:'codex-subagent',contextId:'/root/reviewer',independent:true,at:'2026-10-05T02:06:36Z',degradedReason:null,
    result:{verdict:'approved',packageDigest:prepared.packageDigest,examinedPaths:['1.guide/design.md','1.guide/requirements.md','1.guide/tasks.md'],findings:[],summary:'Synthetic original verdict'}};
  const entry={skillDir:path.resolve('skills/cm-prd'),project:specs,specs};
  const identity={entry,runtime:'codex'},sessionId='prd-efficiency-fixture';
  const open=(enabled=!legacy)=>openPrdSession({specs,sessionId,identity,executionPolicy:enabled?EXECUTION_POLICY_V1:null});
  const input={original:response,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author'};
  const payload={package:{...prepared.reviewPackage,packageDigest:prepared.packageDigest},authorContextId:'author',mode:'independent'};
  return {specs,entry,identity,sessionId,open,response,input,payload,prepared,stateFile:path.join(specs,'.reviews/prd-sessions',sessionId,'state.json')};
}
test('strict pure preflight rejects extra null before any publication filesystem work',t=>{
  const f=fixture(t),before=JSON.stringify(f.response);
  assert.throws(()=>inspectPrdReviewResponse({...f.input,response:f.response}),/invalid_input/);
  assert.throws(()=>publishPrdReview({specs:'/does-not-exist',...f.input,response:f.response}),/invalid_input/);
  assert.equal(JSON.stringify(f.response),before);
});
test('mechanical projection retains verdict, independence and original response bytes',t=>{
  const f=fixture(t),before=JSON.stringify(f.response),r=recoverPrdResponse(f.input);
  assert.equal(r.response.at,'2026-10-05T02:06:36.000Z');assert(!Object.hasOwn(r.response,'degradedReason'));
  assert.deepEqual(r.response.result,f.response.result);assert.equal(r.response.contextId,f.response.contextId);
  assert.equal(r.response.independent,true);assert.equal(JSON.stringify(f.response),before);
  assert.equal(inspectPrdReviewResponse({...f.input,response:r.response}).result.verdict,'approved');
});
for(const [name,change] of [
  ['extra unknown field',r=>r.surprise=true],['author context',r=>r.contextId='author'],
  ['changed independence',r=>r.independent=false],['non-null degradation',r=>r.degradedReason='invented'],
  ['invalid approved verdict',r=>r.result.findings=[{severity:'P1',path:'1.guide/design.md',summary:'bad',detail:'bad'}]],
])test(`projection cannot repair ${name}`,t=>{const f=fixture(t);change(f.response);assert.throws(()=>recoverPrdResponse(f.input));});
test('timestamp repair accepts exact instants and refuses lossy or guessed timestamps',()=>{
  assert.equal(normalizePrdReviewTimestamp('2026-10-05T04:06:36.000000+02:00'),'2026-10-05T02:06:36.000Z');
  for(const value of ['2026-02-30T00:00:00Z','2026-10-05T02:06:36','2026-10-05T02:06:36-00:00',
    '2026-10-05T02:06:36.0001Z','2026-10-05T24:00:00Z','2026-10-05T02:06:60Z','tomorrow'])
    assert.throws(()=>normalizePrdReviewTimestamp(value),/prd_review_timestamp_invalid/);
});
test('recorded original-call repair is bound, replay-safe, durable after commit and dispatch-free',async t=>{
  const f=fixture(t);let s=f.open(),calls=0;
  s.begin({operation:'final_review',mode:'independent',stage:'split',feature:'1.guide'},null);
  await s.call('prd_review',f.payload,new AbortController().signal,async()=>{calls++;return f.response;});
  const original=s.state.active.calls[0],originalBytes=JSON.stringify(original);
  const binding={callId:original.callId,requestDigest:original.requestDigest,resultDigest:digest(original.result),packageDigest:f.prepared.packageDigest,reason:'Repair recorded formatting only'};
  for(const field of ['callId','requestDigest','resultDigest','packageDigest']){
    const before=fs.readFileSync(f.stateFile);assert.throws(()=>s.repairReviewResponse({...binding,[field]:'wrong'}),/prd_recovery_binding/);
    assert.deepEqual(fs.readFileSync(f.stateFile),before);
  }
  const repair=s.repairReviewResponse(binding),after=fs.readFileSync(f.stateFile);
  assert.equal(Buffer.from(repair.originalBase64,'base64').toString(),JSON.stringify(original.result));
  const {responseRepair,...stillOriginal}=s.state.active.calls[0];assert.equal(JSON.stringify(stillOriginal),originalBytes);
  assert.deepEqual(s.repairReviewResponse(binding),repair);assert.deepEqual(fs.readFileSync(f.stateFile),after);
  s.close();s=f.open(false);s.replay();
  const replay=await s.call('prd_review',f.payload,new AbortController().signal,()=>assert.fail('duplicate dispatch'));
  assert.equal(replay.at,'2026-10-05T02:06:36.000Z');assert.equal(calls,1);
  s.commit({reviewState:'recorded'});s.close();s=f.open(false);
  assert.deepEqual(s.repairReviewResponse(binding),repair);assert.equal(s.state.responseRepairs.length,1);s.close();
});
test('unknown original call stays unknown and cannot be repaired or redispatched',async t=>{
  const f=fixture(t),s=f.open();s.begin({operation:'final_review',mode:'independent'},null);
  await assert.rejects(s.call('prd_review',f.payload,new AbortController().signal,async()=>{throw Error('lost');}));
  const call=s.state.active.calls[0],before=fs.readFileSync(f.stateFile);
  assert.throws(()=>s.repairReviewResponse({callId:call.callId,requestDigest:call.requestDigest,resultDigest:'a'.repeat(64),packageDigest:f.prepared.packageDigest,reason:'missing'}),/prd_recovery_binding/);
  s.replay();await assert.rejects(s.call('prd_review',f.payload,new AbortController().signal,()=>assert.fail('duplicate')),/prd_host_result_unknown/);
  assert.deepEqual(fs.readFileSync(f.stateFile),before);s.close();
});
test('legacy session is byte-preserved and cannot acquire optimization policy',t=>{
  const f=fixture(t,{legacy:true});let s=f.open();s.checkpoint({original:true});s.close();const before=fs.readFileSync(f.stateFile);
  assert.throws(()=>f.open(true),/execution_policy_legacy_run/);assert.deepEqual(fs.readFileSync(f.stateFile),before);
  s=f.open(false);assert.equal(s.state.version,1);assert(!Object.hasOwn(s.state,'executionPolicy'));s.close();
});
test('real host transport routes repair without invoking a review channel',async t=>{
  const f=fixture(t),s=f.open();s.begin({operation:'final_review',mode:'independent',stage:'split',feature:'1.guide'},null);
  await s.call('prd_review',f.payload,new AbortController().signal,async()=>f.response);
  const c=s.state.active.calls[0];s.close();
  const binding={callId:c.callId,requestDigest:c.requestDigest,resultDigest:digest(c.result),packageDigest:f.prepared.packageDigest,reason:'Actual JSONL routing'};
  const host=spawnSync(process.execPath,['scripts/cm-prd-host.mjs','serve','--skill-dir',f.entry.skillDir,'--project',f.specs,
    '--specs',f.specs,'--runtime','codex','--allow-log-write','--session',f.sessionId,'--allow-review-write','--host-context','author'],
    {input:JSON.stringify({operation:'repair_review_response',requestId:'repair',binding})+'\n',encoding:'utf8',timeout:10000,
      env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.specs,'mirror')}});
  assert.equal(host.status,0,host.stderr);const rows=host.stdout.trim().split('\n').map(JSON.parse);
  assert(!rows.some(r=>r.type==='host_request'));const result=rows.find(r=>r.requestId==='repair');
  assert.equal(result?.result?.outcome,'original_response_repaired',host.stdout+host.stderr);
});

test('real PRD driver preflights original-call repair and makes no new host request',async t=>{
  const f=fixture(t),s=f.open();s.begin({operation:'final_review',mode:'independent',stage:'split',feature:'1.guide'},null);
  await s.call('prd_review',f.payload,new AbortController().signal,async()=>f.response);const call=s.state.active.calls[0];s.close();
  const binding={callId:call.callId,requestDigest:call.requestDigest,resultDigest:digest(call.result),packageDigest:f.prepared.packageDigest,reason:'Repair original stored formatting'};
  const planFile=path.join(f.specs,'plan.json');
  const plan={project:f.specs,specs:f.specs,session:f.sessionId,runtime:'codex',hostContext:'author',permissions:['--allow-review-write'],request:{binding}};
  // PLAN stays outside source inputs so the admission identity cannot change.
  const before=fs.readFileSync(f.stateFile);fs.writeFileSync(planFile,JSON.stringify({...plan,request:{binding:{...binding,resultDigest:'b'.repeat(64)}}}));
  const env={...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.specs,'mirror')};
  const denied=spawnSync(process.execPath,['scripts/cm-prd-drive.mjs','--plan',planFile,'repair_review_response'],{encoding:'utf8',env,timeout:15000});
  assert.equal(denied.status,2,denied.stdout+denied.stderr);assert.deepEqual(fs.readFileSync(f.stateFile),before);
  fs.writeFileSync(planFile,JSON.stringify(plan));
  const result=spawnSync(process.execPath,['scripts/cm-prd-drive.mjs','--plan',planFile,'repair_review_response'],{encoding:'utf8',env,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).result.outcome,'original_response_repaired');
  assert(!result.stderr.includes('host_request'));const stored=JSON.parse(fs.readFileSync(f.stateFile));assert.equal(stored.active.calls.length,1);assert.deepEqual(stored.active.calls[0].result,call.result);
});
