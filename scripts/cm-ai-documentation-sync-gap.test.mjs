// Q16/Q17: documentation_sync runs inside the final task's develop, after the
// session already answered the develop. A sync that never answers, answers
// blocked, or writes outside the documentation paths must not end in an
// exit-less unknown, and must never redispatch develop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {gapFixture,gapExecution,identity,records,added} from './cm-ai-answer-gap-fixture.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

// paths: the documentation paths (README.md first, always written by {write}).
const docFixture=(t,name,paths=['README.md'])=>{
  const f=gapFixture(t,name);
  fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Before\n');
  f.calls.documentation=0;f.docPaths=paths;
  return f;
};
const docDefinition=f=>({version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
  identity:identity(1),scope:['a.mjs',...f.docPaths],requirements:['requirements.md']});
// sync: one item per documentation_sync call: 'hang' never answers, {write}
// writes README.md (or {other} writes a.mjs) and answers {status} (default completed).
function docExecution(f,{developer=[],sync=[],verdicts=[]}={}){
  const queue=[...sync];
  return {...gapExecution(f,{developer,verdicts}),...(f.timeoutMs?{timeoutMs:f.timeoutMs}:{}),documentationSync:{paths:f.docPaths,run:async(request,signal)=>{
    f.calls.documentation++;
    const item=queue.shift();
    if(item===undefined)throw Object.assign(new Error('unexpected documentation call'),{code:'unexpected_documentation_call'});
    if(item.write!==undefined)fs.writeFileSync(path.join(f.codeProject,'README.md'),item.write);
    if(item.other!==undefined)fs.writeFileSync(path.join(f.codeProject,'a.mjs'),item.other);
    if(item.hang)return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'})),{once:true}));
    if(item.throw)throw Object.assign(new Error(item.throw),{code:item.throw});
    return item.answer??{status:item.status??'completed'};
  }}};
}
async function docSession(f,mode,execution,operations,options={}){
  const run=await openControlRun(docDefinition(f),mode,execution,options);
  const results=[];
  try{
    for(const [operation,attempt,extra] of operations)
      results.push(await run.host.handle({version:1,operation,requestId:`${operation}-${results.length}`,identity:identity(attempt),...extra}));
  }finally{run.close();}
  return results;
}
const readme=f=>fs.readFileSync(path.join(f.codeProject,'README.md'),'utf8');
const code=f=>fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8');

// R3: the operator's stop confirmation (develop_redo + reason), journaled as
// documentation-sync-retry. Nothing else lets a documentation-only redo start.
const confirm=(f,reason='会话已停止修改文档')=>docSession(f,'resume',docExecution(f),
  [['develop_redo',1,{reason}]],{allowDevelopRedo:true}).then(([result])=>result);
// Every failure kind waits for develop_redo first: advance alone reports and
// journals nothing, and documentation_sync is not asked again.
async function assertWaitsForStop(f,code){
  const before=records(f),calls=f.calls.documentation;
  const [reported,refused]=await docSession(f,'resume',docExecution(f),[['advance',1],['develop_redo',1,{reason:'已停'}]]);
  assert.deepEqual([reported.outcome,reported.code,reported.pendingAction],['reported',code,'develop_redo'],JSON.stringify(reported));
  assert.deepEqual([refused.outcome,refused.code],['rejected','develop_redo_authorization_required']);
  assert.deepEqual(records(f),before);assert.equal(f.calls.documentation,calls);
}

test('Q16: a documentation_sync that never answers waits for the stop confirmation even with the docs unchanged, then redoes only documentation_sync',async t=>{
  const f=docFixture(t,'doc-timeout');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{hang:true}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_answer_missing','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/只重发文档同步/);assert.match(stuck.reason,/call_timeout/);assert.match(stuck.reason,/--allow-develop-redo/);
  assert.equal(stuck.guidance.recoveryOperation,'develop_redo');assert.match(stuck.guidance.summary,/不需要重新开发/);
  // The journal keeps the raw shape: unknown, with the developer answer recorded before the sync.
  const raw=records(f).at(-1).payload.checkpoint;
  assert.deepEqual([raw.state,raw.code,raw.calls.at(-1).terminal],['unknown','documentation_sync_answer_missing','unknown']);
  const started=records(f).find(row=>row.payload.type==='documentation-sync-started');
  assert.deepEqual(started.payload.documents.map(item=>item.path),['README.md']);
  assert.equal(raw.calls.at(-1).documentationSync,started.digest);
  assert.equal(f.calls.developer,1);assert.equal(code(f),'delivered\n');
  await assertWaitsForStop(f,'documentation_sync_answer_missing');
  const before=records(f);
  const confirmed=await confirm(f);
  assert.deepEqual([confirmed.outcome,confirmed.code,confirmed.pendingAction],['recorded','documentation_sync_answer_missing','resume'],JSON.stringify(confirmed));
  assert.equal(confirmed.guidance.recoveryOperation,'advance');
  const record=records(f).at(-1).payload;
  assert.deepEqual([record.type,record.code,record.reason,record.startDigest,record.invocationId],
    ['documentation-sync-retry','documentation_sync_answer_missing','会话已停止修改文档',started.digest,raw.calls.at(-1).invocationId]);
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# After\n'}],verdicts:['approved']}),[['advance',1]]);
  // The developer is never dispatched again: its journaled answer is reused.
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.deepEqual(added(f,before).slice(0,3),['documentation-sync-retry','intent:develop-1-retry-1','documentation-sync-started'],JSON.stringify(added(f,before)));
  const checkpoint=records(f).find((row,index)=>index>before.length&&row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify(checkpoint.code));
  // The review package still compares with the task baseline: develop and docs edits are both reviewed.
  const changed=Object.fromEntries(checkpoint.reviewPackage.changes.map(change=>[change.path,
    Buffer.from(change.before.contentBase64,'base64').toString()]));
  assert.deepEqual(changed,{'README.md':'# Before\n','a.mjs':'old\n'});
  assert.ok(added(f,before).includes('intent:review-1'),JSON.stringify(delivered));
  assert.deepEqual(records(f).slice(0,before.length),before,'journal is append-only');
});

test('Q17: a documentation_sync answered blocked also waits for the stop confirmation; after the user fixes the docs only documentation_sync is redone',async t=>{
  const f=docFixture(t,'doc-blocked');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_answer_blocked','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/已应答也只结束了宿主的等待/);
  await assertWaitsForStop(f,'documentation_sync_answer_blocked');
  // The user fixes the docs, confirms the session stopped, then advance re-asks only documentation_sync.
  fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixed by the user\n');
  assert.equal((await confirm(f)).outcome,'recorded');
  const [next]=await docSession(f,'resume',docExecution(f,{sync:[{}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.notEqual(next.code,'documentation_sync_answer_blocked',JSON.stringify(next));
  assert.equal(readme(f),'# Fixed by the user\n');
});

test('Q17: a documentation_sync that wrote outside the documentation paths is refused until those paths are restored',async t=>{
  const f=docFixture(t,'doc-scope');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# After\n',other:'rewritten by docs\n'}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_out_of_scope','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/a\.mjs/);
  await assertWaitsForStop(f,'documentation_sync_out_of_scope');
  assert.equal((await confirm(f)).outcome,'recorded');
  const before=records(f);
  const [refused]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([refused.outcome,refused.code],['rejected','documentation_sync_out_of_scope'],JSON.stringify(refused));
  assert.match(refused.reason,/a\.mjs/);
  assert.equal(records(f).length,before.length);assert.equal(f.calls.documentation,1);
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
  const [ok]=await docSession(f,'resume',docExecution(f,{sync:[{}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.notEqual(ok.outcome,'rejected',JSON.stringify(ok));
});

test('R3 on resume: docs changed after the confirmation (the old writer still alive) are refused until confirmed again; other files are refused outright',async t=>{
  const f=docFixture(t,'doc-after-stop');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# Half\n',hang:true}]}),[['advance',1]]);
  // The confirmation is journaled; the host then exits before any redo intent.
  assert.equal((await confirm(f)).outcome,'recorded');
  // The old writer was still alive: it writes the docs after the confirmation.
  fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Written late\n');
  const before=records(f);
  const [refused]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([refused.outcome,refused.code],['rejected','documentation_sync_changed_after_stop'],JSON.stringify(refused));
  assert.equal(records(f).length,before.length);assert.equal(f.calls.documentation,1);
  // Confirmed again (now really stopped): spends no extra retry.
  assert.equal((await confirm(f,'旧会话已确认停止')).outcome,'recorded');
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  assert.equal(readRunnerHistory(records(f),records(f)[0].payload.config,3).answerGaps.documentationSync,1);
  // A non-documentation change after the confirmation is refused, too.
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'changed later\n');
  const [scope]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([scope.outcome,scope.code],['rejected','documentation_sync_out_of_scope'],JSON.stringify(scope));
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
  const [ok]=await docSession(f,'resume',docExecution(f,{sync:[{}],verdicts:['approved']}),[['advance',1]]);
  assert.notEqual(ok.outcome,'rejected',JSON.stringify(ok));
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
});

test('Q16/Q17: documentation_sync retries are capped at two per run, then an explicit limit',async t=>{
  const f=docFixture(t,'doc-limit');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  for(const answer of [{answer:{status:'later'}},{status:'blocked'}]){
    assert.equal((await confirm(f)).outcome,'recorded');
    const [next]=await docSession(f,'resume',docExecution(f,{sync:[answer]}),[['advance',1]]);
    assert.equal(next.state,'blocked',JSON.stringify(next));
  }
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,3);
  const [limit]=await docSession(f,'resume',docExecution(f),[['status',1]]);
  assert.deepEqual([limit.state,limit.code,limit.pendingAction],['blocked','documentation_sync_retry_limit','none'],JSON.stringify(limit));
  assert.match(limit.reason,/--supersede-reviewed-evidence/);assert.equal(limit.guidance.recoveryOperation,null);
  const third=await confirm(f);
  assert.equal(third.outcome,'rejected',JSON.stringify(third));
  assert.deepEqual(records(f).filter(row=>row.payload.type==='documentation-sync-retry').map(row=>row.payload.code),
    ['documentation_sync_answer_blocked','documentation_sync_answer_invalid']);
  // Retries hold no call or effect slot: three develop effects, no counted call.
  const {readRunnerHistory,developBudget,projectedRunnerStatus}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const history=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.deepEqual(developBudget(history.state),{calls:0,effects:0});
  assert.equal(projectedRunnerStatus(history,records(f)[0].payload.config).code,'documentation_sync_retry_limit');
});

test('Q16: drivers prepare no developer answer for a documentation block, before or after the confirmation',async t=>{
  const f=docFixture(t,'doc-driver');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{hang:true}]}),[['advance',1]]);
  const {readRunnerHistory,projectedRunnerStatus}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const {projectDevelopAttempts}=await import('./cm-ai-drive.mjs');
  const {batchDevelopAttempts}=await import('./cm-ai-batch-drive.mjs');
  const project=()=>{const config=records(f)[0].payload.config;return projectedRunnerStatus(readRunnerHistory(records(f),config,3),config);};
  // Before the confirmation the journal alone shows no retryable block.
  assert.deepEqual([project().state,project().code],['unknown','documentation_sync_answer_missing']);
  await confirm(f);
  const status=project();
  assert.deepEqual([status.state,status.code],['blocked','documentation_sync_answer_missing']);
  assert.deepEqual(projectDevelopAttempts(status,'advance',[]).attempts,[]);
  assert.deepEqual(batchDevelopAttempts(status,'1.work/T-002',[]),[]);
});

test('older journals keep their projection: a develop that failed out_of_scope without a documentation record stays unknown',async t=>{
  const f=docFixture(t,'doc-legacy');
  // What runtimes before the documentation record wrote for Q17: the developer
  // run itself threw out_of_scope (no documentation-sync-started, no marked call).
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
  await docSession(f,'create',gapExecution(f,{developer:[{beforeDispatch:'out_of_scope'}]}),[['advance',1]]);
  assert.deepEqual([records(f).at(-1).payload.checkpoint.state,records(f).at(-1).payload.checkpoint.code],['unknown','out_of_scope']);
  assert.ok(!records(f).some(row=>row.payload.type==='documentation-sync-started'));
  const before=records(f);
  const [status]=await docSession(f,'resume',gapExecution(f),[['status',1]]);
  assert.deepEqual([status.state,status.code,status.pendingAction],['unknown','out_of_scope','reconcile'],JSON.stringify(status));
  assert.deepEqual(records(f),before);
});

// Q16 (review r1 #3): the record accepts every documentation path the workflow
// configuration accepts (up to 256), so a large list never ends in store_failure.
// Documentation paths sit inside the task scope, itself capped at 256 paths
// (review-package FILE_COUNT), so with a.mjs and the AGENTS.md Learning path a run reaches 254; the record's own
// 256 bound is checked on replay below.
for(const count of [65,254])
test(`documentation-sync-started holds ${count} documentation paths`,async t=>{
  const paths=['README.md',...Array.from({length:count-1},(_,index)=>`docs/d${String(index).padStart(3,'0')}.md`)];
  const f=docFixture(t,`doc-many-${count}`,paths);
  fs.mkdirSync(path.join(f.codeProject,'docs'));
  const [result]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# After\n'}]}),[['advance',1]]);
  assert.notEqual(result.code,'store_failure',JSON.stringify(result));
  const started=records(f).find(row=>row.payload.type==='documentation-sync-started');
  assert.equal(started.payload.documents.length,count);
  const checkpoint=records(f).find(row=>row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify([checkpoint.code,checkpoint.reason]));
});

test('the documentation record accepts 256 documentation paths and refuses 257',async()=>{
  const {validDocumentationStates,MAX_DOCUMENTATION_PATHS}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const {validateHostWorkflowConfiguration}=await import('../runtime/js/cm-ai/host-workflow-capabilities.mjs');
  const docs=count=>Array.from({length:count},(_,i)=>`docs/d${String(i).padStart(3,'0')}.md`);
  // Same bound as the workflow configuration.
  assert.equal(MAX_DOCUMENTATION_PATHS,256);
  validateHostWorkflowConfiguration({qa:null,documentationPaths:docs(256),applicableAgentFiles:[]});
  assert.throws(()=>validateHostWorkflowConfiguration({qa:null,documentationPaths:docs(257),applicableAgentFiles:[]}));
  assert.equal(validDocumentationStates(docs(256).map(p=>({path:p,sha256:null})),docs(257)).length,256);
  assert.throws(()=>validDocumentationStates(docs(257).map(p=>({path:p,sha256:null})),docs(257)),{code:'runner_documentation'});
});

// Review r1 #2: a develop-scope file that Git ignores (a.mjs here) is kept by
// the task baseline; the documentation start must keep it too, so an edit to it
// during or after documentation_sync is caught before a stale answer is reused.
const ignoredFixture=(t,name)=>{
  const f=docFixture(t,name);
  const {spawnSync}=awaitSpawn;
  // Git ignore queries make each capture slower than the 1.5 s fixture limit.
  f.timeoutMs=20000;
  fs.writeFileSync(path.join(f.codeProject,'.gitignore'),'a.mjs\n');
  for(const args of [['init','-q'],['add','.gitignore','README.md','requirements.md'],
    ['-c','user.name=t','-c','user.email=t@example.invalid','commit','-q','-m','init']]){
    const result=spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  return f;
};
const awaitSpawn=await import('node:child_process');
test('a gitignored develop-scope file written by documentation_sync is out of scope',async t=>{
  const f=ignoredFixture(t,'doc-ignored-during');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# After\n',other:'rewritten by docs\n'}]}),[['advance',1]]);
  assert.equal(stuck.code,'documentation_sync_out_of_scope',JSON.stringify(stuck));
  assert.match(stuck.reason,/a\.mjs/);
});
test('a gitignored develop-scope file changed after a failed documentation_sync blocks the retry',async t=>{
  const f=ignoredFixture(t,'doc-ignored-after');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal(stuck.code,'documentation_sync_answer_blocked',JSON.stringify(stuck));
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'changed after the sync\n');
  assert.equal((await confirm(f)).outcome,'recorded');
  const before=records(f);
  const [refused]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([refused.outcome,refused.code],['rejected','documentation_sync_out_of_scope'],JSON.stringify(refused));
  assert.equal(records(f).length,before.length);assert.equal(f.calls.documentation,1);
});

test('guidance for every documentation block names develop_redo first and never a develop redo',async()=>{
  const {operatorGuidance}=await import('../runtime/js/cm-ai/operator-guidance.mjs');
  const {DOCUMENTATION_SYNC_CODES}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  for(const code of DOCUMENTATION_SYNC_CODES){
    const base={workflow:'cm-ai',state:'blocked',code,identity:{taskId:'T-002'}};
    const stop=operatorGuidance({...base,pendingAction:'develop_redo'});
    assert.equal(stop.recoveryOperation,'develop_redo',code);assert.match(stop.nextStep,/只重发文档同步/,code);
    assert.doesNotMatch(stop.nextStep,/重发本轮开发/,code);
    const ready=operatorGuidance({...base,pendingAction:'resume'});
    assert.equal(ready.recoveryOperation,'advance',code);assert.match(ready.nextStep,/不重新开发/,code);
  }
});

// Review r1 #4: the host dies during documentation_sync (intent and start
// record journaled, no checkpoint). abandon_effect records the interruption with
// the start binding; the run then redoes only documentation_sync, never develop,
// and the interruption counts toward the same two retries.
async function dieDuringSync(f,execution){
  let entered;const inSync=new Promise(resolve=>{entered=resolve;});
  const sync=execution.documentationSync.run;
  execution.documentationSync.run=(request,signal)=>{entered();return sync(request,signal);};
  const run=await openControlRun(docDefinition(f),fs.existsSync(f.store)?'resume':'create',execution);
  const advancing=run.host.handle({version:1,operation:'advance',requestId:'advance-dying',identity:identity(1)});
  advancing.catch(()=>{});
  await inSync;run.close();
  // The dead host's advance never settles; its closed store refuses any later write.
}
test('Q16 host exit during documentation_sync: abandon_effect, then only documentation_sync is redone, within the shared cap',async t=>{
  const f=docFixture(t,'doc-interrupted');
  await dieDuringSync(f,docExecution(f,{developer:['delivered\n'],sync:[{write:'# Half\n',hang:true}]}));
  assert.equal(records(f).at(-1).payload.type,'documentation-sync-started',JSON.stringify(records(f).map(row=>row.payload.type)));
  const [pending]=await docSession(f,'resume',docExecution(f),[['status',1]]);
  assert.equal(pending.pendingAction,'abandon_effect',JSON.stringify(pending));
  const [interrupted]=await docSession(f,'resume',docExecution(f),
    [['abandon_effect',1,{reason:'旧宿主与会话都已退出'}]],{allowAbandonEffect:true});
  assert.deepEqual([interrupted.state,interrupted.code,interrupted.pendingAction],['blocked','documentation_sync_interrupted','resume'],JSON.stringify(interrupted));
  assert.equal(interrupted.guidance.recoveryOperation,'advance');
  const record=records(f).at(-1).payload,started=records(f).find(row=>row.payload.type==='documentation-sync-started');
  assert.deepEqual([record.type,record.startDigest,record.documents[0].path],['effect-interrupted',started.digest,'README.md']);
  const before=records(f);
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# Final\n'}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1,'develop is never redispatched');assert.equal(f.calls.documentation,2);
  const checkpoint=records(f).find((row,index)=>index>=before.length&&row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify(delivered));
  assert.equal(Buffer.from(checkpoint.reviewPackage.changes.find(change=>change.path==='a.mjs').before.contentBase64,'base64').toString(),'old\n');
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  assert.equal(readRunnerHistory(records(f),records(f)[0].payload.config,3).answerGaps.documentationSync,1);
});
test('Q16 host exit during documentation_sync after both retries are spent: abandon_effect only voids the run',async t=>{
  const f=docFixture(t,'doc-interrupted-cap');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await docSession(f,'resume',docExecution(f,{sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await dieDuringSync(f,docExecution(f,{sync:[{hang:true}]}));
  const [voided]=await docSession(f,'resume',docExecution(f),[['abandon_effect',1,{reason:'旧宿主已退出'}]],{allowAbandonEffect:true});
  assert.deepEqual([voided.state,voided.code],['cancelled','effect_abandoned'],JSON.stringify(voided));
  assert.equal(f.calls.developer,1);
});
test('Q16 host exit during a documentation_sync retry: the interruption is the second retry, the developer answer survives, a third failure hits the cap',async t=>{
  const f=docFixture(t,'doc-interrupted-after-retry');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await dieDuringSync(f,docExecution(f,{sync:[{hang:true}]}));
  const [interrupted]=await docSession(f,'resume',docExecution(f),[['abandon_effect',1,{reason:'旧宿主与会话都已退出'}]],{allowAbandonEffect:true});
  assert.equal(interrupted.code,'documentation_sync_interrupted',JSON.stringify(interrupted));
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  assert.equal(readRunnerHistory(records(f),records(f)[0].payload.config,3).answerGaps.documentationSync,2);
  // The developer answer of the first run is what the second documentation_sync is built on.
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal(f.calls.developer,1);
  assert.equal(delivered.code,'documentation_sync_retry_limit',JSON.stringify(delivered));
  assert.equal(f.calls.documentation,3,'first, the interrupted retry, the last attempt');
});

// Review r2 #1: the host dies after the redo's new effect-intent, before its new
// documentation-sync-started. The torn tail is made by dropping that last record
// (the chain and the revision are re-sealed, as the store would have left them).
function dropLastRecord(f){
  const state=JSON.parse(fs.readFileSync(f.store,'utf8'));
  state.records.pop();const {revision,...data}=state;
  fs.writeFileSync(f.store,JSON.stringify({...data,revision:digest(data)})+'\n');
}
test('Q16 host exit between a documentation redo\'s intent and its start record: abandon_effect redoes only documentation_sync within the cap',async t=>{
  const f=docFixture(t,'doc-intent-only');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await dieDuringSync(f,docExecution(f,{sync:[{hang:true}]}));
  const first=records(f).find(row=>row.payload.type==='documentation-sync-started');
  dropLastRecord(f);
  assert.equal(records(f).at(-1).payload.type,'effect-intent',JSON.stringify(records(f).map(row=>row.payload.type)));
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const probe=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.equal(probe.pendingDocumentation?.digest,first.digest,'the redo inherits the failed start');
  const [pending]=await docSession(f,'resume',docExecution(f),[['status',1]]);
  assert.equal(pending.pendingAction,'abandon_effect',JSON.stringify(pending));
  const [interrupted]=await docSession(f,'resume',docExecution(f),
    [['abandon_effect',1,{reason:'旧宿主与会话都已退出'}]],{allowAbandonEffect:true});
  assert.deepEqual([interrupted.state,interrupted.code,interrupted.pendingAction],['blocked','documentation_sync_interrupted','resume'],JSON.stringify(interrupted));
  const record=records(f).at(-1).payload;
  assert.deepEqual([record.type,record.startDigest],['effect-interrupted',first.digest]);
  assert.equal(readRunnerHistory(records(f),records(f)[0].payload.config,3).answerGaps.documentationSync,2);
  const before=records(f);
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# Final\n'}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1,'develop is never redispatched');assert.equal(f.calls.documentation,3);
  const checkpoint=records(f).find((row,index)=>index>=before.length&&row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify(delivered));
});
test('Q16 host exit between a documentation redo\'s intent and its start record, with both retries spent: abandon_effect only voids the run',async t=>{
  const f=docFixture(t,'doc-intent-only-cap');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await docSession(f,'resume',docExecution(f,{sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.equal((await confirm(f)).outcome,'recorded');
  await dieDuringSync(f,docExecution(f,{sync:[{hang:true}]}));
  dropLastRecord(f);
  const [voided]=await docSession(f,'resume',docExecution(f),[['abandon_effect',1,{reason:'旧宿主已退出'}]],{allowAbandonEffect:true});
  assert.deepEqual([voided.state,voided.code],['cancelled','effect_abandoned'],JSON.stringify(voided));
  assert.equal(f.calls.developer,1);
});

// Review r2 #3: a documentation redo carries the Learning input bound to the
// delivered develop answer, so a LESSONS.md edited while the run waited (it is
// outside the documentation paths and the code root) does not end as runner_learning.
for(const kind of ['answer_missing','answer_invalid','answer_blocked','out_of_scope','interrupted'])
test(`Q16/Q17 a LESSONS.md edited during the wait does not block the documentation redo (${kind})`,async t=>{
  const f=docFixture(t,`doc-learning-${kind}`);
  const failure={answer_missing:{hang:true},answer_invalid:{throw:'invalid_result'},answer_blocked:{status:'blocked'},
    out_of_scope:{other:'rewritten by docs\n'}}[kind];
  if(kind==='interrupted'){
    await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{hang:true}]}),[['advance',1]]);
    await confirm(f);
    await dieDuringSync(f,docExecution(f,{sync:[{hang:true}]}));
    const [done]=await docSession(f,'resume',docExecution(f),[['abandon_effect',1,{reason:'旧宿主与会话都已退出'}]],{allowAbandonEffect:true});
    assert.equal(done.code,'documentation_sync_interrupted',JSON.stringify(done));
  }else{
    await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[failure]}),[['advance',1]]);
    if(kind==='out_of_scope')fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
    assert.equal((await confirm(f)).outcome,'recorded');
  }
  fs.writeFileSync(path.join(f.specsDir,'LESSONS.md'),'## 待触发备忘\n- [待触发] 等待期间新增\n');
  const before=records(f);
  const [redone]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# Final\n'}],verdicts:['approved']}),[['advance',1]]);
  assert.notEqual(redone.code,'runner_learning',JSON.stringify(redone));
  assert.equal(f.calls.developer,1,'develop is never redispatched');
  const intent=records(f).slice(before.length).find(row=>row.payload.type==='effect-intent');
  assert.deepEqual(intent.payload.effect.learningInput,records(f).find(row=>row.payload.type==='effect-intent').payload.effect.learningInput);
  assert.ok(records(f).some((row,index)=>index>=before.length&&row.payload.type==='effect-checkpoint'),JSON.stringify(redone));
});
