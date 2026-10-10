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

test('Q16: a documentation_sync that never answers (docs unchanged) re-dispatches only documentation_sync',async t=>{
  const f=docFixture(t,'doc-timeout');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{hang:true}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_answer_missing','resume'],JSON.stringify(stuck));
  assert.match(stuck.reason,/只重发文档同步/);assert.match(stuck.reason,/call_timeout/);
  assert.equal(stuck.guidance.recoveryOperation,'advance');assert.match(stuck.guidance.summary,/不需要重新开发/);
  // The journal keeps the raw shape: unknown, with the developer answer recorded before the sync.
  const raw=records(f).at(-1).payload.checkpoint;
  assert.deepEqual([raw.state,raw.code,raw.calls.at(-1).terminal],['unknown','documentation_sync_answer_missing','unknown']);
  const started=records(f).find(row=>row.payload.type==='documentation-sync-started').payload;
  assert.deepEqual(started.documents.map(item=>item.path),['README.md']);
  assert.equal(raw.calls.at(-1).documentationSync,records(f).find(row=>row.payload.type==='documentation-sync-started').digest);
  assert.equal(f.calls.developer,1);assert.equal(code(f),'delivered\n');
  const before=records(f);
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# After\n'}],verdicts:['approved']}),[['advance',1]]);
  // The developer is never dispatched again: its journaled answer is reused.
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.deepEqual(added(f,before).slice(0,3),['documentation-sync-retry','intent:develop-1-retry-1','documentation-sync-started'],JSON.stringify(added(f,before)));
  const checkpoint=records(f).find((row,index)=>index>=before.length&&row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify(checkpoint.code));
  // The review package still compares with the task baseline: develop and docs edits are both reviewed.
  const changed=Object.fromEntries(checkpoint.reviewPackage.changes.map(change=>[change.path,
    Buffer.from(change.before.contentBase64,'base64').toString()]));
  assert.deepEqual(changed,{'README.md':'# Before\n','a.mjs':'old\n'});
  assert.ok(added(f,before).includes('intent:review-1'),JSON.stringify(delivered));
  assert.deepEqual(records(f).slice(0,before.length),before,'journal is append-only');
});

test('Q17: a documentation_sync answered blocked is a retryable block; advance re-dispatches only documentation_sync',async t=>{
  const f=docFixture(t,'doc-blocked');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_answer_blocked','resume'],JSON.stringify(stuck));
  // The user fixes the docs, then advance re-asks only documentation_sync.
  fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixed by the user\n');
  const [next]=await docSession(f,'resume',docExecution(f,{sync:[{}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.notEqual(next.code,'documentation_sync_answer_blocked',JSON.stringify(next));
  assert.equal(readme(f),'# Fixed by the user\n');
});

test('Q17: a documentation_sync that wrote outside the documentation paths is refused until those paths are restored',async t=>{
  const f=docFixture(t,'doc-scope');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# After\n',other:'rewritten by docs\n'}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_out_of_scope','resume'],JSON.stringify(stuck));
  assert.match(stuck.reason,/a\.mjs/);
  const before=records(f);
  const [refused]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([refused.outcome,refused.code],['rejected','documentation_sync_out_of_scope'],JSON.stringify(refused));
  assert.equal(records(f).length,before.length);assert.equal(f.calls.documentation,1);
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
  const [ok]=await docSession(f,'resume',docExecution(f,{sync:[{}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,2);
  assert.notEqual(ok.outcome,'rejected',JSON.stringify(ok));
});

test('Q16: a documentation_sync that changed the docs and never answered needs develop_redo; then only documentation_sync is redone',async t=>{
  const f=docFixture(t,'doc-stop');
  const [stuck]=await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{write:'# Half\n',hang:true}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','documentation_sync_answer_missing','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/--allow-develop-redo/);assert.equal(stuck.guidance.recoveryOperation,'develop_redo');
  assert.match(stuck.guidance.nextStep,/只重发文档同步/);
  const before=records(f);
  const [reported,refused]=await docSession(f,'resume',docExecution(f),[['advance',1],['develop_redo',1,{reason:'会话已停'}]]);
  assert.deepEqual([reported.outcome,reported.code],['reported','documentation_sync_answer_missing'],JSON.stringify(reported));
  assert.deepEqual([refused.outcome,refused.code],['rejected','develop_redo_authorization_required']);
  assert.equal(records(f).length,before.length);
  const [confirmed]=await docSession(f,'resume',docExecution(f),[['develop_redo',1,{reason:'会话已停止修改文档'}]],{allowDevelopRedo:true});
  assert.deepEqual([confirmed.outcome,confirmed.code,confirmed.pendingAction],['recorded','documentation_sync_answer_missing','resume'],JSON.stringify(confirmed));
  const record=records(f).at(-1).payload;
  assert.deepEqual([record.type,record.code,record.basis,record.reason],['documentation-sync-retry','documentation_sync_answer_missing','confirmed','会话已停止修改文档']);
  const [delivered]=await docSession(f,'resume',docExecution(f,{sync:[{write:'# Final\n'}],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1,'develop is never redispatched');assert.equal(f.calls.documentation,2);
  const checkpoint=records(f).find((row,index)=>index>before.length&&row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review',JSON.stringify(delivered));
  assert.equal(Buffer.from(checkpoint.reviewPackage.changes.find(change=>change.path==='README.md').before.contentBase64,'base64').toString(),'# Before\n');
  assert.deepEqual(records(f).slice(0,before.length),before,'journal is append-only');
});

test('Q16/Q17: documentation_sync retries are capped at two per run, then an explicit limit',async t=>{
  const f=docFixture(t,'doc-limit');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{status:'blocked'}]}),[['advance',1]]);
  for(const answer of [{answer:{status:'later'}},{status:'blocked'}]){
    const [next]=await docSession(f,'resume',docExecution(f,{sync:[answer]}),[['advance',1]]);
    assert.equal(next.state,'blocked',JSON.stringify(next));
  }
  assert.equal(f.calls.developer,1);assert.equal(f.calls.documentation,3);
  const [limit]=await docSession(f,'resume',docExecution(f),[['status',1]]);
  assert.deepEqual([limit.state,limit.code,limit.pendingAction],['blocked','documentation_sync_retry_limit','none'],JSON.stringify(limit));
  assert.match(limit.reason,/--supersede-reviewed-evidence/);assert.equal(limit.guidance.recoveryOperation,null);
  assert.deepEqual(records(f).filter(row=>row.payload.type==='documentation-sync-retry').map(row=>[row.payload.code,row.payload.basis]),
    [['documentation_sync_answer_blocked','answered'],['documentation_sync_answer_invalid','answered']]);
  // Retries hold no call or effect slot: three develop effects, one counted call.
  const {readRunnerHistory,developBudget,projectedRunnerStatus}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const history=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.deepEqual(developBudget(history.state),{calls:0,effects:0});
  assert.equal(projectedRunnerStatus(history,records(f)[0].payload.config).code,'documentation_sync_retry_limit');
});

test('Q16: drivers project the documentation block and prepare no developer answer for it',async t=>{
  const f=docFixture(t,'doc-driver');
  await docSession(f,'create',docExecution(f,{developer:['delivered\n'],sync:[{hang:true}]}),[['advance',1]]);
  const {readRunnerHistory,projectedRunnerStatus}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const {projectDevelopAttempts}=await import('./cm-ai-drive.mjs');
  const {batchDevelopAttempts}=await import('./cm-ai-batch-drive.mjs');
  const config=records(f)[0].payload.config,status=projectedRunnerStatus(readRunnerHistory(records(f),config,3),config);
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
  const before=records(f);
  const [refused]=await docSession(f,'resume',docExecution(f),[['advance',1]]);
  assert.deepEqual([refused.outcome,refused.code],['rejected','documentation_sync_out_of_scope'],JSON.stringify(refused));
  assert.equal(records(f).length,before.length);assert.equal(f.calls.documentation,1);
});
