// A task scope with project rules or workflow evidence (AGENTS.md, .claude/,
// tasks.md, .cm-*) can never be developed: the developer adapter refuses it
// before any provider runs. Regression for the 2026-10-06 dogfood T-006 run,
// which a pre-gate host stranded at unknown/execution_error with no exit.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {protectedScopePaths,validateDeveloperScope} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {readRunnerHistory,runnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {assertNoUnrecordedPriorCode,prepareReviewedEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';
import {assertCreatableScope,openControlRun,validateRunDefinition} from './cm-ai-run.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {operatorGuidance} from '../runtime/js/cm-ai/operator-guidance.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';

const skip=!isSupportedExecutionPlatform();
const test=(name,fn)=>nodeTest(name,{skip},fn);
const PROTECTED=['AGENTS.md','.claude/rules/security.md'];
// The T-006 production shape: a task-learning (V3) run of a numbered feature.
const FEATURE='6.api-native-reading';

test('protected scope paths are listed by the same rule the developer adapter enforces',()=>{
  const scope=['src/app.js',...PROTECTED,'docs/CLAUDE.md','specs/tasks.md','.cm-workflow.yml','.codex/config.toml'];
  assert.deepEqual(protectedScopePaths(scope),[...PROTECTED,'docs/CLAUDE.md','specs/tasks.md','.cm-workflow.yml','.codex/config.toml']);
  assert.deepEqual(protectedScopePaths(['src/app.js','docs/agents-guide.md']),[]);
  for(const file of protectedScopePaths(scope))assert.throws(()=>validateDeveloperScope(['src/app.js',file]),{code:'protected_scope'});
  assert.doesNotThrow(()=>validateDeveloperScope(['src/app.js','docs/agents-guide.md']));
});

function projectFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-protected-create-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(path.join(specsDir,FEATURE),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,FEATURE,'tasks.md'),'- [ ] T-006: fixture\n');
  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# rules\n');
  return {root,specsDir,codeProject};
}
const reviewsAbsent=f=>assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false,'a refused create must leave no .reviews/.execution');

test('create refuses a scope with AGENTS.md before any journal, listing only the protected paths',async t=>{
  const f=projectFixture(t);
  const definition=validateRunDefinition({version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:FEATURE,
    identity:{repositoryId:'fixture',runId:'api-native-reading-T-006',taskId:'T-006',attempt:1},
    scope:['src/app.js',...PROTECTED],requirements:[]});
  assert.throws(()=>assertCreatableScope(definition.scope),error=>error.code==='protected_scope'
    &&error.paths.join()===PROTECTED.join()&&error.reason.includes('AGENTS.md、.claude/rules/security.md')&&!error.reason.includes('src/app.js'));
  await assert.rejects(openControlRun(definition,'create'),error=>error.code==='protected_scope'&&error.reason.includes('AGENTS.md'));
  reviewsAbsent(f);
  assert.doesNotThrow(()=>assertCreatableScope(['src/app.js','docs/agents-guide.md']));
});

test('a batch refuses a member to be created with a protected scope before it locks, logs or opens any run',t=>{
  const f=projectFixture(t);let opened=0;
  const configuration={version:1,repositoryId:'fixture',batchId:'protected-scope-batch',specsDir:f.specsDir,codeProject:f.codeProject,
    tasks:[{feature:FEATURE,taskId:'T-005',scope:['src/app.js'],requirements:[]},
      {feature:FEATURE,taskId:'T-006',scope:['src/tab.js',...PROTECTED],requirements:[]}]};
  assert.throws(()=>createCmAiBatch({configuration,executionFor:async()=>{opened++;return {};},logHome:path.join(f.root,'logs')}),
    error=>error.code==='protected_scope'&&error.reason.startsWith(`${FEATURE}/T-006: `)&&error.reason.includes('.claude/rules/security.md'));
  assert.equal(opened,0);reviewsAbsent(f);
  assert.equal(fs.existsSync(path.join(f.specsDir,'运行日志.jsonl')),false);assert.equal(fs.existsSync(path.join(f.root,'logs')),false);
  // A bootstrap rule task keeps its own instruction targets (host-bootstrap checks its business scope).
  assert.doesNotThrow(()=>createCmAiBatch({configuration,executionFor:async()=>({}),logHome:path.join(f.root,'logs'),
    bootstrapKeys:[`${FEATURE}/T-006`]}));
});

async function runnerFixture(t,scope){
  const {createTaskRunner}=await import('../runtime/js/cm-ai/task-runner.mjs');
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-protected-scope-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),reviewsDir=path.join(specsRoot,'.reviews');
  fs.mkdirSync(path.join(root,'.claude','rules'),{recursive:true});fs.mkdirSync(reviewsDir,{recursive:true});
  fs.mkdirSync(path.join(specsRoot,FEATURE));
  const tasksPath=path.join(specsRoot,FEATURE,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-006: fixture\n');
  for(const [file,content] of Object.entries({'code.js':'old\n','requirements.md':'fixture\n','AGENTS.md':'# rules\n',
    '.claude/rules/security.md':'# security\n'}))fs.writeFileSync(path.join(root,file),content);
  const identity={repositoryId:'fixture',runId:'api-native-reading-T-006',taskId:'T-006',attempt:1};
  const owner={tasksPath,feature:'api-native-reading',specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('protected-scope'),config:digest('fixture'),inputs:digest('original')},create:true};
  let store=openTaskExecutionStore(owner),developerCalls=0,developerRun=()=>{throw new Error('developer must not run');};
  const options={root,identity,scope,requirements:['requirements.md'],excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'claude',requestedModel:'current-session',contextId:'cm-conversation-author',
      run:(...args)=>{developerCalls++;return developerRun(...args);}},
    reviewers:[{id:'reviewer',adapterId:'claude-review-adapter',provider:'claude',requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-1','review-2'],run:()=>{throw new Error('reviewer must not run');}}],
    check:()=>{throw new Error('checks must not run');},
    taskCompletion:{reviewsDir,handoffs:[1,2].map(n=>path.join(reviewsDir,`api-native-reading-T-006-a${n}-handoff.json`))},
    taskLearning:{feature:FEATURE,hostHandoff:true},
    reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
      authorize:()=>{throw new Error('review must not be authorized');}}};
  const make=mode=>createTaskRunner({...options,persistence:{store,mode,version:3}});
  const statePath=path.join(reviewsDir,'.execution',identity.runId,'state.json');
  const reopen=()=>{store.close();store=openTaskExecutionStore({...owner,create:false});return make('resume');};
  t.after(()=>{store.close();fs.rmSync(temp,{recursive:true,force:true});});
  const files=[{scope:'project',path:'AGENTS.md',sha256:digest('agents')}];
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:FEATURE,identity,
    learningDigest:digest({version:1,feature:FEATURE,identity,files}),learningFiles:files};
  const develop=(id='develop-1')=>({version:1,id,identity,kind:'develop',learningInput});
  return {identity,options,statePath,root,specsRoot,tasksPath,develop,make:()=>make('create'),resume:()=>make('resume'),reopen,records:()=>store.snapshot().records,
    developerCalls:()=>developerCalls,setDeveloper:fn=>{developerRun=fn;},close:()=>store.close(),
    reopenStore:()=>{store=openTaskExecutionStore({...owner,create:false});}};
}
function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}

test('a protected scope blocks before dispatch as a definite blocked/protected_scope, never unknown',async t=>{
  const f=await runnerFixture(t,['code.js',...PROTECTED]);
  const result=await f.make().executeEffect(f.develop());
  assert.equal(result.state,'blocked');assert.equal(result.code,'protected_scope');
  for(const file of PROTECTED)assert(result.reason.includes(file),result.reason);
  assert.equal(f.developerCalls(),0);assert.deepEqual(result.calls,[]);
  assert.deepEqual(f.records().map(row=>row.payload.type),['init','effect-intent','effect-checkpoint']);
  // The block replays as recorded, is terminal, and a later develop is refused without dispatch.
  const resumed=f.reopen();
  assert.equal(resumed.status().state,'blocked');assert.equal(resumed.status().code,'protected_scope');
  const retry=await resumed.executeEffect(f.develop('develop-2'));
  assert.equal(retry.outcome,'rejected');assert.equal(retry.code,'stage_mismatch');assert.equal(f.developerCalls(),0);
  const guidance=operatorGuidance({workflow:'cm-ai',identity:f.identity,state:'blocked',code:'protected_scope',pendingAction:'none'});
  assert.equal(guidance.recoveryOperation,null);assert.match(guidance.nextStep,/新 runId/);
});

// Rewrite the new checkpoint into the exact shape a pre-gate host journaled for
// T-006: the adapter's refusal escaped as unknown/execution_error with one
// started developer call that never returned (state.json of 2026-10-05).
function strandLikeT006(f){
  const state=JSON.parse(fs.readFileSync(f.statePath,'utf8')),records=state.records;
  const init=records[0].payload,intent=records[1].payload.effect,last=records[2];
  const session=init.session,original=init.baseline,config=init.config;
  const request=requestFor({invocationId:`${session}.1`,identity:{...config.identity,attempt:1},role:'developer',
    provider:config.developer.provider,requestedModel:config.developer.requestedModel,contextId:config.developer.contextId,
    payload:{scope:config.scope,requirements:original.files.filter(file=>config.requirements.includes(file.path)),priorReview:null,
      learningInput:intent.learningInput}});
  const call={invocationId:request.invocationId,contextId:config.developer.contextId,provider:config.developer.provider,
    requestedModel:config.developer.requestedModel,effectiveModel:'unknown',channel:'fixture',started:true,terminal:'unknown',
    requestDigest:request.requestDigest,resultDigest:null};
  const checkpoint={...last.payload.checkpoint,state:'unknown',code:'execution_error',reason:null,sequence:1,calls:[call]};
  checkpoint.cache=[{effect:intent,digest:digest(intent),result:runnerStatus(checkpoint,config)}];
  records[2]={...last,payload:{...last.payload,checkpoint}};
  const {revision,...body}=state;body.records=rechain(records);
  f.close();fs.writeFileSync(f.statePath,JSON.stringify({...body,revision:digest(body)})+'\n',{mode:0o600});f.reopenStore();
  return call;
}

test('a stranded T-006 journal replays as blocked/protected_scope and its records stay byte for byte',async t=>{
  const f=await runnerFixture(t,['code.js',...PROTECTED]);
  await f.make().executeEffect(f.develop());
  const call=strandLikeT006(f);
  const legacyBytes=fs.readFileSync(f.statePath);
  const records=JSON.parse(legacyBytes).records;
  assert.deepEqual(records.map(row=>row.payload.type),['init','effect-intent','effect-checkpoint']);
  assert.equal(records[2].payload.checkpoint.state,'unknown');assert.equal(records[2].payload.checkpoint.code,'execution_error');
  // Before this fix the same records had no exit: unknown, reconcile, and no pending intent to abandon.
  const history=readRunnerHistory(records,records[0].payload.config,3);
  assert.equal(history.pending,null);assert.equal(history.pendingAbandonable,false);
  assert.equal(history.state.state,'blocked');assert.equal(history.state.code,'protected_scope');
  for(const file of PROTECTED)assert(history.state.reason.includes(file),history.state.reason);
  const resumed=f.resume();
  const status=resumed.status();
  assert.equal(status.state,'blocked');assert.equal(status.code,'protected_scope');
  assert.deepEqual(status.calls,[call]);
  const retry=await resumed.executeEffect(f.develop('develop-2'));
  assert.equal(retry.outcome,'rejected');assert.equal(f.developerCalls(),0);
  // abandon_effect is not needed and still refuses: there is no pending intent.
  assert.equal(resumed.abandonEffect({allowed:true,reason:'protected scope'}).outcome,'rejected');
  assert.equal(records[2].payload.checkpoint.learningResult,null);
  // The exit: a new run by the original gates. Both read the stranded journal and admit it.
  f.close();
  const next={specsDir:f.specsRoot,codeProject:f.root,feature:FEATURE,tasksPath:f.tasksPath,
    identity:{...f.identity,runId:'api-native-reading-T-006-r2'}};
  assert.doesNotThrow(()=>assertNoUnrecordedPriorCode(next));
  const supersession=prepareReviewedEvidenceSupersession({...next,reason:'scope 移除受保护规则文件后重建'});
  assert.deepEqual(supersession.previousRunIds,[f.identity.runId]);
  f.reopenStore();
  assert.deepEqual(fs.readFileSync(f.statePath),legacyBytes);
});

test('the same unknown developer shape without a protected scope is not protected_scope (pinned root: develop_dispatch_failed)',async t=>{
  const f=await runnerFixture(t,['code.js']);
  f.setDeveloper(()=>{throw new Error('adapter failure');});
  const result=await f.make().executeEffect(f.develop());
  assert.equal(result.state,'blocked');assert.equal(result.code,'develop_dispatch_failed');assert.equal(f.developerCalls(),1);
  // The genuine pre-gate shape has the same call fields the T-006 rewrite uses.
  assert.deepEqual(Object.keys(result.calls[0]),['invocationId','contextId','provider','requestedModel','effectiveModel',
    'channel','started','terminal','requestDigest','resultDigest']);
  assert.equal(result.calls[0].terminal,'unknown');assert.equal(result.calls[0].resultDigest,null);
  const resumed=f.reopen();
  // The journal keeps unknown/execution_error; with the code root still at the
  // round start, status offers the plain pre-dispatch redo (answer gaps, P1-3).
  const history=readRunnerHistory(f.records(),f.records()[0].payload.config,3);
  assert.deepEqual([history.state.state,history.state.code],['unknown','execution_error']);
  assert.deepEqual([resumed.status().state,resumed.status().code],['blocked','develop_dispatch_failed']);
});
