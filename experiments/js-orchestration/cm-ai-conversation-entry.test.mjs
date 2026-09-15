import {writeHandoff,writeReview} from './native-gate-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest} from './effect-contract.mjs';
import {createTaskRunner} from './task-runner.mjs';
import {openTaskExecutionStore} from './task-owner.mjs';
import {reviewPaths} from './review-runner.mjs';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective,
  encodeCmAiTaskLearningApplicationEvidence} from './cm-ai-context-refresh.mjs';

test('F01 conversation entry exposes the fixed Codex host boundary',async()=>{
  const module=await import('./cm-ai-conversation-entry.mjs').catch(()=>({}));
  assert.equal(typeof module.createCmAiConversationEntry,'function');
});

const identity={repositoryId:'fixture',runId:'conversation',taskId:'T-001',attempt:1};
const operation=(name,extra={})=>({version:1,operation:name,requestId:`${name}-1`,identity,...extra});
const qaDecision=(status,packageDigest,{reason,score,at,decisionId=`qa-${status}`})=>({decisionId,identity,
  packageDigest,status,reason,score,at});
// Downstream N7/N8 compatibility fixtures consume already-recorded historical
// skip evidence. New N6 decisions cannot skip a feature that is now complete.
async function seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at}){
  const {recordCmAiQaDecision}=await import('./cm-ai-qa-log.mjs');
  recordCmAiQaDecision({specsDir,codeProject,feature:'1.login',identity,packageDigest,logHome,
    decision:qaDecision('skipped',packageDigest,{reason:'docs_only',score:4,at})});
}
const documentationResult=(status,packageDigest,contextDigest,{reason='documentation synced',
  at='2026-09-04T15:00:00-07:00',syncId=`docs-${status}`}={})=>({syncId,identity,packageDigest,
  contextDigest,status,reason,at});
const writeTestRun=({specsDir,codeProject,logHome,phase,data,at})=>{
  const args=[path.resolve(import.meta.dirname,'../../scripts/cm-log-event.py'),'--workflow','cm-ai','--event','test_run',
    '--phase',phase,'--runtime','codex','--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,
    '--at',at,'--detail',phase==='start'?'QA started':'QA completed','--data-json',JSON.stringify(data)];
  const result=spawnSync('python3',args,{encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
};
const grantForRequest=(request,authorizationAt)=>{
  const body={version:1,kind:'cm-review-dispatch-grant',grantId:'grant-live',adapterId:'codex-review-adapter',
    invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,reviewerId:'reviewer',
    logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
    hostContextId:'actual-main',decisionId:'decision-live',decision:'approved',issuedAt:authorizationAt,
    expiresAt:authorizationAt+60000};
  return {...body,grantDigest:digest(body)};
};
const fixture=async fn=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-conversation-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature=path.join(specsDir,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(codeProject,'README.md'),'existing project\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),'- [ ] T-001: implement login\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login']}));
  try{return await fn({root,specsDir,codeProject});}finally{fs.rmSync(root,{recursive:true,force:true});}
};

test('start admits the selected feature/task and submits one deterministic develop effect',()=>fixture(async({specsDir,codeProject})=>{
  fs.writeFileSync(path.join(specsDir,'LESSONS.md'),'# Lessons\n');
  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Project rules\n');
  const effects=[];
  const ready={state:'ready',code:null,identity,packageDigest:null};
  const developed={state:'awaiting_review',code:null,identity,packageDigest:'a'.repeat(64)};
  const runner={status:()=>ready,executeEffect:async effect=>{effects.push(effect);return developed;},cancel:()=>ready,run:async()=>ready};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const result=await entry.handle(operation('start'));

  assert.equal(effects.length,1);
  assert.deepEqual({...effects[0],learningInput:undefined},{version:1,id:'develop-1',identity,kind:'develop',learningInput:undefined});
  assert.equal(effects[0].learningInput.phase,'task_learning_input');
  assert.deepEqual(effects[0].learningInput.learningFiles.map(file=>`${file.scope}:${file.path}`),[
    'project:AGENTS.md','specs:LESSONS.md',
  ]);
  assert.match(effects[0].learningInput.learningDigest,/^[a-f0-9]{64}$/);
  assert.equal(result.state,'awaiting_review');
  assert.equal(result.pendingAction,'decision');
  assert.equal(result.packageDigest,'a'.repeat(64));
  assert.equal(result.outcome,'advanced');
  assert(Object.isFrozen(result));
}));

test('status is read-only and returns only the safe runner summary',()=>fixture(async({specsDir,codeProject})=>{
  let reads=0,effects=0,cancels=0;
  const current={state:'unknown',code:'reconciliation_required',identity,packageDigest:'b'.repeat(64),
    calls:[{secret:'not public'}],reviewInvocation:{secret:'not public'}};
  const runner={status:()=>{reads++;return current;},executeEffect:async()=>{effects++;return current;},
    cancel:()=>{cancels++;return current;},run:async()=>current};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const first=await entry.handle(operation('status'));
  const second=await entry.handle(operation('status',{requestId:'status-2'}));

  assert.equal(reads,2);assert.equal(effects,0);assert.equal(cancels,0);
  assert.equal(first.pendingAction,'reconcile');assert.equal(second.state,'unknown');
  assert(!Object.hasOwn(first,'calls'));assert(!Object.hasOwn(first,'reviewInvocation'));
}));

test('cancel delegates only to the durable runner cancel control',()=>fixture(async({specsDir,codeProject})=>{
  let cancels=0,effects=0;
  const cancelled={state:'cancelled',code:'cancelled',identity,packageDigest:null};
  const runner={status:()=>cancelled,executeEffect:async()=>{effects++;return cancelled;},
    cancel:()=>{cancels++;return cancelled;},run:async()=>cancelled};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const result=await entry.handle(operation('cancel'));

  assert.equal(cancels,1);assert.equal(effects,0);
  assert.equal(result.state,'cancelled');assert.equal(result.pendingAction,'none');
}));

test('start reports specification approval as pending without touching the runner',()=>fixture(async({specsDir,codeProject})=>{
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login']}));
  let reads=0,effects=0;
  const ready={state:'ready',code:null,identity,packageDigest:null};
  const runner={status:()=>{reads++;return ready;},executeEffect:async()=>{effects++;return ready;},cancel:()=>ready,run:async()=>ready};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const result=await entry.handle(operation('start'));

  assert.equal(result.state,'awaiting_spec_approval');assert.equal(result.code,'spec_approval_required');
  assert.equal(result.pendingAction,'spec_approval');assert.equal(reads,0);assert.equal(effects,0);
}));

test('blocked admission preserves the current repair attempt and rejects an invented attempt',()=>fixture(async({specsDir,codeProject})=>{
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login']}));
  const attemptTwo={...identity,attempt:2};let reads=0,effects=0;
  let current={state:'changes_requested',code:null,identity:attemptTwo,packageDigest:'a'.repeat(64)};
  const runner={status:()=>{reads++;return current;},executeEffect:async()=>{effects++;return current;},
    cancel:()=>current,run:async()=>current};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
  assert.equal((await entry.handle(operation('resume'))).code,'spec_approval_required');assert.equal(reads,0);
  for(const name of ['start','resume','advance']){
    const result=await entry.handle({...operation(name),identity:attemptTwo});
    assert.equal(result.code,'spec_approval_required');assert.deepEqual(result.identity,attemptTwo);
  }
  current={...current,identity};
  assert.equal((await entry.handle({...operation('resume'),identity:attemptTwo})).code,'identity_mismatch');
  assert.equal(effects,0);
}));

test('decision without trusted host input waits, and message self-approval is rejected',()=>fixture(async({specsDir,codeProject})=>{
  let effects=0;
  const waiting={state:'awaiting_review',code:null,identity,packageDigest:'c'.repeat(64)};
  const runner={status:()=>waiting,executeEffect:async()=>{effects++;return waiting;},cancel:()=>waiting,run:async()=>waiting};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const result=await entry.handle(operation('decision',{packageDigest:'c'.repeat(64)}));
  const forged=await entry.handle({...operation('decision',{packageDigest:'c'.repeat(64)}),approved:true});

  assert.equal(result.state,'awaiting_review');assert.equal(result.code,'decision_required');
  assert.equal(result.pendingAction,'decision');assert.equal(result.outcome,'awaiting');
  assert.equal(forged.outcome,'rejected');assert.equal(forged.code,'invalid_input');assert.equal(effects,0);
}));

test('decision with current trusted host approval submits one deterministic review effect',()=>fixture(async({specsDir,codeProject})=>{
  const effects=[];
  const waiting={state:'awaiting_review',code:null,identity,packageDigest:'c'.repeat(64)};
  const reviewed={state:'pending_review',code:'provider_review_observed',identity,packageDigest:'c'.repeat(64)};
  const runner={status:()=>waiting,executeEffect:async effect=>{effects.push(effect);return reviewed;},
    cancel:()=>waiting,run:async()=>waiting};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    hostDecision:{status:'approved'}});

  const result=await entry.handle(operation('decision',{packageDigest:'c'.repeat(64)}));

  assert.deepEqual(effects,[{version:1,id:'review-1',identity,kind:'review'}]);
  assert.equal(result.state,'pending_review');assert.equal(result.pendingAction,'review_evidence');
  assert.equal(result.outcome,'advanced');
}));

test('denied host decision cannot enter the runner review path',()=>fixture(async({specsDir,codeProject})=>{
  let effects=0;
  const waiting={state:'awaiting_review',code:null,identity,packageDigest:'c'.repeat(64)};
  const denied={state:'pending_review',code:'permission_denied',identity,packageDigest:'c'.repeat(64)};
  const runner={status:()=>waiting,executeEffect:async()=>{effects++;return denied;},cancel:()=>waiting,run:async()=>waiting};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    hostDecision:{status:'denied',code:'permission_denied'}});

  const result=await entry.handle(operation('decision',{packageDigest:'c'.repeat(64)}));

  assert.equal(effects,0);assert.equal(result.state,'awaiting_review');assert.equal(result.code,'permission_denied');
  assert.equal(result.pendingAction,'decision');
}));

test('resume develops only ready work and otherwise reports the existing durable state',()=>fixture(async({specsDir,codeProject})=>{
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  for(const [state,code,action,expectedEffects] of [
    ['ready',null,'none',1],
    ['awaiting_review',null,'decision',0],
    ['pending_review','provider_review_observed','review_evidence',0],
    ['unknown','reconciliation_required','reconcile',0],
    ['cancelled','cancelled','none',0],
  ]){
    let effects=0;
    const current={state,code,identity,packageDigest:state==='ready'?null:'e'.repeat(64)};
    const developed={state:'awaiting_review',code:null,identity,packageDigest:'f'.repeat(64)};
    const runner={status:()=>current,executeEffect:async effect=>{effects++;assert.equal(effect.id,'develop-1');return developed;},
      cancel:()=>current,run:async()=>current};
    const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
    const result=await entry.handle(operation('resume',{requestId:`resume-${state}`}));
    assert.equal(effects,expectedEffects,state);
    assert.equal(result.pendingAction,state==='ready'?'decision':action,state);
    assert.equal(result.state,state==='ready'?'awaiting_review':state,state);
  }
}));

test('strict input, feature identity, and stale decisions reject before runner effects',()=>fixture(async({specsDir,codeProject})=>{
  let effects=0;
  const waiting={state:'awaiting_review',code:null,identity,packageDigest:'c'.repeat(64)};
  const runner={status:()=>waiting,executeEffect:async()=>{effects++;return waiting;},cancel:()=>waiting,run:async()=>waiting};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
  const wrongIdentity={...identity,runId:'other-run'};
  const getter={version:1,operation:'status',requestId:'status-getter',identity};
  Object.defineProperty(getter,'extra',{enumerable:true,get(){throw new Error('getter ran');}});

  assert.equal((await entry.handle({...operation('status'),extra:true})).code,'invalid_input');
  assert.equal((await entry.handle({...operation('status'),identity:wrongIdentity})).code,'identity_mismatch');
  assert.equal((await entry.handle(operation('decision',{packageDigest:'d'.repeat(64)}))).code,'stale_decision');
  assert.equal((await entry.handle(operation('complete',{packageDigest:'not-a-digest'}))).code,'invalid_input');
  assert.equal((await entry.handle(getter)).code,'invalid_input');
  const wrongFeature=createCmAiConversationEntry({specsDir,codeProject,feature:'2.profile',identity,runner});
  assert.equal((await wrongFeature.handle(operation('start'))).code,'task_mismatch');
  const malformed=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    hostDecision:{status:'approved',source:'message'}});
  assert.equal((await malformed.handle(operation('decision',{packageDigest:'c'.repeat(64)}))).code,'invalid_input');
  assert.equal(effects,0);
}));

for(const originalIdentity of [true,false])
test(`resume uses the runner current attempt for changes-requested work original=${originalIdentity}`,()=>fixture(async({specsDir,codeProject})=>{
  const attemptTwo={...identity,attempt:2},effects=[];
  const changed={state:'changes_requested',code:null,identity:attemptTwo,packageDigest:'a'.repeat(64)};
  const developed={state:'awaiting_review',code:null,identity:attemptTwo,packageDigest:'b'.repeat(64)};
  const runner={status:()=>changed,executeEffect:async effect=>{effects.push(effect);return developed;},
    cancel:()=>changed,run:async()=>changed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entryIdentity=originalIdentity?identity:attemptTwo;
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity:entryIdentity,runner});

  if(originalIdentity){
    const status=await entry.handle(operation('status'));
    assert.deepEqual(status.identity,attemptTwo);assert.equal(status.pendingAction,'resume');
    const stale=await entry.handle(operation('decision',{packageDigest:changed.packageDigest}));
    assert.equal(stale.code,'identity_mismatch');assert.equal(effects.length,0);
  }
  const result=await entry.handle({...operation('resume'),identity:entryIdentity});

  assert.equal(effects.length,1);assert.equal(effects[0].id,'develop-2');
  assert.deepEqual(effects[0].identity,attemptTwo);assert.equal(effects[0].kind,'develop');
  assert.equal(effects[0].learningInput.phase,'task_learning_input');
  assert.deepEqual(effects[0].learningInput.identity,attemptTwo);
  assert.equal(result.state,'awaiting_review');assert.equal(result.pendingAction,'decision');
}));

test('concurrent start preserves a busy runner rejection and current state',()=>fixture(async({specsDir,codeProject})=>{
  let active=false,startFirst,releaseFirst;
  const started=new Promise(resolve=>{startFirst=resolve;}),release=new Promise(resolve=>{releaseFirst=resolve;});
  const ready={state:'ready',code:null,identity,packageDigest:null};
  const developed={state:'awaiting_review',code:null,identity,packageDigest:'a'.repeat(64)};
  const runner={status:()=>ready,executeEffect:async()=>{
    if(active)return {outcome:'rejected',code:'busy'};
    active=true;startFirst();await release;active=false;return developed;
  },cancel:()=>ready,run:async()=>ready};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const first=entry.handle(operation('start'));await started;
  const second=await entry.handle(operation('start',{requestId:'start-concurrent'}));
  releaseFirst();await first;

  assert.equal(second.outcome,'rejected');assert.equal(second.code,'busy');
  assert.equal(second.state,'ready');assert.deepEqual(second.identity,identity);
}));

test('review stage and develop package/store rejections remain safe rejected summaries',()=>fixture(async({specsDir,codeProject})=>{
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  for(const [name,current,op,hostDecision] of [
    ['stage_mismatch',{state:'awaiting_review',code:null,identity,packageDigest:'c'.repeat(64)},
      operation('decision',{packageDigest:'c'.repeat(64)}),{status:'approved'}],
    ['package_mismatch',{state:'ready',code:null,identity,packageDigest:null},operation('start'),null],
    ['store_failure',{state:'ready',code:null,identity,packageDigest:null},operation('start'),null],
  ]){
    const runner={status:()=>current,executeEffect:async()=>({outcome:'rejected',code:name}),
      cancel:()=>current,run:async()=>current};
    const args={specsDir,codeProject,feature:'1.login',identity,runner};
    if(hostDecision)args.hostDecision=hostDecision;
    const result=await createCmAiConversationEntry(args).handle({...op,requestId:`reject-${name}`});
    assert.equal(result.outcome,'rejected',name);assert.equal(result.code,name,name);
    assert.equal(result.state,current.state,name);assert.deepEqual(result.identity,identity,name);
  }
}));

test('real V3/store composition completes through the existing owner and blocks post-review correction drift',()=>fixture(async({specsDir,codeProject})=>{
  const reviewsDir=path.join(specsDir,'.reviews');fs.mkdirSync(reviewsDir);
  fs.writeFileSync(path.join(codeProject,'code.js'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  const tasksPath=path.join(specsDir,'1.login','tasks.md'),taskBefore=fs.readFileSync(tasksPath);
  const handoffs=[1,2].map(attempt=>path.join(reviewsDir,`login-T-001-a${attempt}-handoff.json`));
  writeHandoff(handoffs[0],codeProject,['code.js']);
  const owner={tasksPath,feature:'login',specsRoot:specsDir,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('conversation'),config:digest('fixture'),inputs:digest('original')},create:true};
  let store=openTaskExecutionStore(owner);let developerCalls=0,reviewerCalls=0;
  try{
    const runnerOptions={root:codeProject,identity,scope:['code.js'],requirements:['requirements.md'],
      excludedContexts:['main'],timeoutMs:1000,
      developer:{provider:'codex',requestedModel:'fixture',contextId:'developer-logical',run:request=>{
        developerCalls++;fs.writeFileSync(path.join(codeProject,'code.js'),'new\n');
        writeHandoff(handoffs[0],codeProject,['code.js']);
        const learning=request.payload.learningInput;
        const application=createCmAiTaskLearningApplication({feature:learning.feature,identity:request.identity,
          learningDigest:learning.learningDigest,status:'no_relevant_lesson',note:null});
        const retrospective=createCmAiTaskLearningRetrospective({feature:learning.feature,identity:request.identity,
          learningDigest:learning.learningDigest,status:'no_new_lesson',candidates:[],reason:null});
        return {version:1,invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
          effectiveModel:'fixture',status:'succeeded',accepted:true,result:{outcome:'implemented',application,retrospective}};
      }},
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,
        available:true,contexts:['review-logical-1','review-logical-2'],run:(request,{onEvent})=>{
          writeReview(path.join(reviewsDir,'login-T-001-r1.md'),handoffs[0]);
          reviewerCalls++;onEvent({event:'thread.started',provider_thread:'actual-review'});
          onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
          onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
          return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};
        }}],
      check:()=>[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}],
      taskLearning:{feature:'1.login'},
      taskCompletion:{reviewsDir,handoffs},
      reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
        authorize:(request,{authorizationAt})=>grantForRequest(request,authorizationAt)}};
    let runner=createTaskRunner({...runnerOptions,persistence:{store,mode:'create',version:3}});
    const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
    const start=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
    const developed=await start.handle(operation('start'));
    await start.handle(operation('start',{requestId:'start-2'}));
    store.close();store=openTaskExecutionStore({...owner,create:false});
    runner=createTaskRunner({...runnerOptions,persistence:{store,mode:'resume',version:3}});
    const resumed=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
    const resumedResult=await resumed.handle(operation('resume'));
    const beforePremature=store.snapshot();
    const premature=await resumed.handle(operation('complete',{packageDigest:developed.packageDigest}));
    assert.equal(premature.outcome,'rejected');assert.equal(premature.code,'completion_not_ready');
    assert.deepEqual(store.snapshot(),beforePremature);assert.deepEqual(fs.readFileSync(tasksPath),taskBefore);
    const decide=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
      hostDecision:{status:'approved'}});
    const reviewed=await decide.handle(operation('decision',{packageDigest:developed.packageDigest}));
    await decide.handle(operation('decision',{requestId:'decision-2',packageDigest:developed.packageDigest}));
    const beforeStale=store.snapshot();
    const stale=await decide.handle(operation('complete',{packageDigest:'f'.repeat(64)}));
    assert.equal(stale.outcome,'rejected');assert.equal(stale.code,'stale_completion');
    assert.deepEqual(store.snapshot(),beforeStale);assert.deepEqual(fs.readFileSync(tasksPath),taskBefore);
    const completed=await decide.handle(operation('complete',{packageDigest:developed.packageDigest}));
    const afterComplete=store.snapshot(),tasksAfterComplete=fs.readFileSync(tasksPath);
    const repeated=await decide.handle(operation('complete',{requestId:'complete-2',packageDigest:developed.packageDigest}));

    assert.equal(developerCalls,1);assert.equal(reviewerCalls,1);
    assert.equal(resumedResult.state,'awaiting_review');assert.equal(resumedResult.pendingAction,'decision');
    assert.equal(reviewed.state,'approved');assert.equal(reviewed.code,null);assert.equal(reviewed.pendingAction,'complete');
    assert.equal(completed.state,'fixture_completed');assert.equal(completed.pendingAction,'qa');
    assert.equal(repeated.state,'fixture_completed');assert.equal(repeated.pendingAction,'qa');
    assert.deepEqual(store.snapshot(),afterComplete);assert.deepEqual(fs.readFileSync(tasksPath),tasksAfterComplete);
    assert.notDeepEqual(tasksAfterComplete,taskBefore);
    assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [x] T-001: implement login\n');
    assert.deepEqual(Object.keys(start),['handle']);assert(!Object.hasOwn(start,'complete'));

    fs.writeFileSync(path.join(codeProject,'code.js'),'post-review correction\n');
    const driftStatus=await decide.handle(operation('status',{requestId:'status-correction'}));
    assert.equal(driftStatus.state,'fixture_completed');assert.equal(driftStatus.code,'correction_review_required');
    assert.equal(driftStatus.pendingAction,'none');
    for(const [name,extra] of [
      ['complete',{}],['qa',{}],['qa_result',{testRunId:'qa-correction'}],
      ['context_refresh',{testRunId:null}],['finish',{testRunId:null}],['run_finalize',{testRunId:null}],
    ]){
      const blocked=await decide.handle(operation(name,{requestId:`${name}-correction`,
        packageDigest:developed.packageDigest,...extra}));
      assert.equal(blocked.outcome,'blocked',name);assert.equal(blocked.state,'fixture_completed',name);
      assert.equal(blocked.code,'correction_review_required',name);assert.equal(blocked.pendingAction,'none',name);
    }
    assert.deepEqual(store.snapshot(),afterComplete);assert.equal(fs.existsSync(path.join(specsDir,'运行日志.jsonl')),false);
    assert.equal(fs.existsSync(path.join(specsDir,'.cm-status.json')),false);
    assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [x] T-001: implement login\n');

    store.close();store=openTaskExecutionStore({...owner,create:false});
    runner=createTaskRunner({...runnerOptions,persistence:{store,mode:'resume',version:3}});
    const replay=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
    const replayStatus=await replay.handle(operation('status',{requestId:'status-correction-replay'}));
    assert.equal(replayStatus.state,'fixture_completed');assert.equal(replayStatus.code,'correction_review_required');
    fs.writeFileSync(path.join(codeProject,'code.js'),'new\n');
    const restored=await replay.handle(operation('status',{requestId:'status-correction-restored'}));
    assert.equal(restored.state,'fixture_completed');assert.equal(restored.code,null);
  }finally{store.close();}
}));

for(const mode of ['missing','skipped','triggered','blocked','correction'])
test(`advance continues from task completion through the existing QA boundary: ${mode}`,()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),log=path.join(specsDir,'运行日志.jsonl');
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n'+
    (mode==='skipped'?'- [ ] T-002: next task\n':''));
  const completed={state:'fixture_completed',code:mode==='correction'?'correction_review_required':null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('completed task must not redispatch'),
    cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const options={specsDir,codeProject,feature:'1.login',identity,runner,applicableAgentFiles:[],qaLogHome:path.join(root,'logs')};
  if(!['missing','correction'].includes(mode))options.qaDecision=qaDecision(mode,packageDigest,
    {reason:'synthetic',score:mode==='skipped'?4:null,at:'2026-09-04T19:00:00Z'});
  const entry=createCmAiConversationEntry(options),result=await entry.handle(operation('advance'));
  const expected={missing:'qa_decision_required',skipped:'context_refreshed',triggered:'qa_triggered',
    blocked:'qa_blocked',correction:'correction_review_required'};
  assert.equal(result.code,expected[mode]);assert.equal(result.operation,'advance');
  if(mode==='skipped')assert.equal(result.pendingAction,'start_next_task');
  if(mode==='triggered')assert.equal(result.pendingAction,'qa_execution');
  if(['missing','correction'].includes(mode))assert(!fs.existsSync(log));
  else{
    const before=fs.readFileSync(log);
    const resumed=await createCmAiConversationEntry(options).handle(operation('advance'));
    assert.equal(resumed.code,expected[mode]);assert.deepEqual(fs.readFileSync(log),before);
    assert.equal(before.toString().trim().split('\n').length,1);
  }
}));

test('cancelling advance between stages prevents QA start and dispatch',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no dispatch'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('triggered',packageDigest,
      {reason:'synthetic',score:null,at:'2026-09-04T19:00:00Z'}),
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:()=>assert.fail('cancelled before QA')}});
  const pending=entry.handle(operation('advance'));
  assert.equal((await entry.handle(operation('cancel'))).outcome,'cancelled');
  assert.equal((await pending).code,'cancelled');
  assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));
}));

for(const mode of ['PASS','FAIL','BLOCKED','cancel','timeout','invalid'])
test(`QA host execution records results and never redispatches on recovery: ${mode}`,()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),log=path.join(specsDir,'运行日志.jsonl');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no developer dispatch'),cancel:()=>completed,run:async()=>completed};
  let calls=0,release,started;const began=new Promise(resolve=>{started=resolve;});
  const options={specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:path.join(root,'logs'),
    qaDecision:qaDecision('triggered',packageDigest,{reason:'synthetic',score:null,at:'2026-09-04T19:00:00Z'}),
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:mode==='timeout'?10:1000,run:async(request,signal)=>{
      calls++;assert.equal(request.packageDigest,packageDigest);assert.equal(signal.aborted,false);
      assert.equal(JSON.parse(fs.readFileSync(log,'utf8').trim().split('\n').at(-1)).phase,'start');started();
      if(['cancel','timeout'].includes(mode))await new Promise(resolve=>{release=resolve;});
      const report=path.join(specsDir,'.reviews','qa-execution.md');fs.mkdirSync(path.dirname(report),{recursive:true});
      fs.writeFileSync(report,'# Isolated QA evidence\n');
      return {result:mode==='invalid'?'PASS':mode,passed:mode==='PASS'?1:0,failed:mode==='FAIL'?1:0,
        blocked:mode==='BLOCKED'?1:0,report};
    }}};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry(options),pending=entry.handle(operation('advance'));await began;
  if(mode==='cancel')await entry.handle(operation('cancel'));
  const result=await pending;
  assert.equal(result.code,{PASS:'qa_passed',FAIL:'qa_failed',BLOCKED:'qa_result_blocked',cancel:'cancelled',
    timeout:'qa_execution_timeout',invalid:'qa_result_invalid'}[mode]);
  release?.();await new Promise(resolve=>setImmediate(resolve));
  const before=fs.readFileSync(log),resumed=await createCmAiConversationEntry(options).handle(operation('advance'));
  assert.equal(resumed.code,['PASS','FAIL','BLOCKED'].includes(mode)?result.code:'qa_execution_unknown');
  assert.equal(calls,1);assert.deepEqual(fs.readFileSync(log),before);
}));

for(const mode of ['completed','blocked','mismatch','cancel','timeout'])
test(`documentation inspection drives the existing finalizer: ${mode}`,()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),logHome=path.join(root,'logs'),log=path.join(specsDir,'运行日志.jsonl');
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:'2026-09-04T19:00:00Z'});
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no dispatch'),cancel:()=>completed,run:async()=>completed};
  let started,release,calls=0;const began=new Promise(resolve=>{started=resolve;});
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[],qaLogHome:logHome,qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('historical QA')},
    documentationProvider:{timeoutMs:mode==='timeout'?10:1000,inspect:async binding=>{
      calls++;started();if(['cancel','timeout'].includes(mode))await new Promise(resolve=>{release=resolve;});
      return {syncId:binding.syncId,identity,packageDigest,contextDigest:mode==='mismatch'?'b'.repeat(64):binding.contextDigest,
        status:mode==='blocked'?'blocked':'completed',reason:'synthetic inspection',at:'2026-09-07T20:00:00Z'};
    }}});
  const pending=entry.handle(operation('advance'));await began;
  if(mode==='cancel')await entry.handle(operation('cancel'));
  const result=await pending;release?.();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.code,{completed:'run_done',blocked:'documentation_sync_blocked',mismatch:'stale_documentation',
    cancel:'cancelled',timeout:'documentation_timeout'}[mode]);
  assert.equal(calls,1);
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.event==='run_done').length,mode==='completed'?1:0);
}));

test('dynamic host QA resumes historical skip without rejudging or rewriting it',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),log=path.join(specsDir,'运行日志.jsonl'),logHome=path.join(root,'logs');
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:'2026-09-04T19:00:00Z'});
  const before=fs.readFileSync(log),completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no dispatch'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[],qaLogHome:logHome,qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('do not re-ask')}});
  const result=await entry.handle(operation('advance'));
  assert.equal(result.code,'documentation_sync_required');assert.equal(result.pendingAction,'documentation_sync');
  assert.deepEqual(fs.readFileSync(log),before);
}));

for(const mode of ['record','cancel','timeout','mismatch'])
test(`dynamic host QA decision binds the generated package: ${mode}`,()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),log=path.join(specsDir,'运行日志.jsonl');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no dispatch'),cancel:()=>completed,run:async()=>completed};
  let calls=0,release,started;
  const began=new Promise(resolve=>{started=resolve;});
  const options={specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:path.join(root,'logs'),
    qaDecisionProvider:{timeoutMs:mode==='timeout'?10:1000,decide:async(request,signal)=>{
      calls++;assert.deepEqual(request,{specsDir,codeProject,feature:'1.login',identity,packageDigest});
      assert(Object.isFrozen(request.identity));assert.equal(signal.aborted,false);started();
      if(['cancel','timeout'].includes(mode))await new Promise(resolve=>{release=resolve;});
      return qaDecision('triggered',mode==='mismatch'?'b'.repeat(64):packageDigest,
        {reason:'feature_complete',score:null,at:'2026-09-04T19:00:00Z'});
    }}};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry(options),pending=entry.handle(operation('advance'));
  await began;
  if(mode==='cancel')await entry.handle(operation('cancel'));
  const result=await pending;
  assert.equal(result.code,{record:'qa_triggered',cancel:'cancelled',timeout:'qa_decision_timeout',mismatch:'qa_decision_mismatch'}[mode]);
  if(mode==='record'){
    const before=fs.readFileSync(log);
    assert.equal((await createCmAiConversationEntry(options).handle(operation('advance'))).code,'qa_triggered');
    assert.deepEqual(fs.readFileSync(log),before);assert.equal(calls,1);
  }else{release?.();await new Promise(resolve=>setImmediate(resolve));assert(!fs.existsSync(log));}
}));

test('feature completion requires QA even when the host proposes a low-score skip',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64);
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('no dispatch'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('skipped',packageDigest,
      {reason:'docs_only',score:4,at:'2026-09-04T19:00:00Z'})});
  for(const name of ['qa','advance']){
    const result=await entry.handle(operation(name,name==='qa'?{packageDigest}:{}));
    assert.equal(result.code,'qa_mandatory_required');assert.equal(result.outcome,'awaiting');
  }
  assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));
}));

test('QA trigger records one existing-log event and stops before QA execution',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),effects=[];
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async effect=>{effects.push(effect);return completed;},
    cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',
      score:null,at:'2026-09-04T19:00:00Z'})});

  const first=await entry.handle(operation('qa',{packageDigest}));
  const repeated=await entry.handle(operation('qa',{requestId:'qa-2',packageDigest}));
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);

  assert.equal(first.outcome,'recorded');assert.equal(first.state,'fixture_completed');
  assert.equal(first.code,'qa_triggered');assert.equal(first.pendingAction,'qa_execution');
  assert.equal(repeated.code,'qa_triggered');assert.equal(rows.length,1);assert.equal(effects.length,0);
  assert.equal(rows[0].at,'2026-09-04T19:00:00+00:00');
  assert.deepEqual({...rows[0],at:undefined,event_id:undefined,project_path:undefined,specs_path:undefined},{
    schema_version:1,run_id:'conversation',at:undefined,workflow:'cm-ai',event:'qa',runtime:'codex',
    project:path.basename(codeProject),detail:'触发:feature_complete',project_path:undefined,specs_path:undefined,
    node:'N6',feature:'1.login',task:'T-001',attempt:1,package_digest:packageDigest,
    repository_id:'fixture',decision_id:'qa-triggered',status:'triggered',reason:'feature_complete',score:null,
    event_id:undefined});
}));

test('QA decision routes skip/block and rejects missing, stale, or premature input without logging',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='b'.repeat(64),completed={state:'fixture_completed',code:null,identity,packageDigest};
  const ready={state:'approved',code:null,identity,packageDigest};
  const runnerFor=status=>({status:()=>status,executeEffect:async()=>status,cancel:()=>status,run:async()=>status});
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const base={specsDir,codeProject,feature:'1.login',identity,qaLogHome:path.join(root,'logs')};

  const missing=await createCmAiConversationEntry({...base,runner:runnerFor(completed)})
    .handle(operation('qa',{packageDigest}));
  const stale=await createCmAiConversationEntry({...base,runner:runnerFor(completed),
    qaDecision:qaDecision('skipped',packageDigest,{reason:'small_change',score:5,
      at:'2026-09-04T12:01:00-07:00'})})
    .handle(operation('qa',{packageDigest:'c'.repeat(64)}));
  const premature=await createCmAiConversationEntry({...base,runner:runnerFor(ready),
    qaDecision:qaDecision('blocked',packageDigest,{reason:'qa_unavailable',score:null,
      at:'2026-09-04T12:02:00-07:00'})})
    .handle(operation('qa',{packageDigest}));
  const unbound=await createCmAiConversationEntry({...base,runner:runnerFor(completed),
    qaDecision:qaDecision('skipped','d'.repeat(64),{reason:'old_package',score:5,
      at:'2026-09-04T12:02:30-07:00'})})
    .handle(operation('qa',{packageDigest}));
  assert.equal(missing.outcome,'awaiting');assert.equal(missing.code,'qa_decision_required');
  assert.equal(missing.pendingAction,'qa');assert.equal(stale.code,'stale_qa');
  assert.equal(premature.code,'qa_not_ready');assert.equal(unbound.code,'qa_decision_mismatch');
  assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));

  const skipped=await createCmAiConversationEntry({...base,runner:runnerFor(completed),
    qaDecision:qaDecision('skipped',packageDigest,{reason:'small_change',score:5,
      at:'2026-09-04T12:03:00-07:00'})})
    .handle(operation('qa',{packageDigest}));
  const conflict=await createCmAiConversationEntry({...base,runner:runnerFor(completed),
    qaDecision:qaDecision('blocked',packageDigest,{reason:'qa_unavailable',score:null,
      at:'2026-09-04T12:04:00-07:00'})})
    .handle(operation('qa',{packageDigest}));
  assert.equal(skipped.code,'qa_skipped');assert.equal(skipped.pendingAction,'context_refresh');
  assert.equal(conflict.code,'qa_decision_conflict');assert.equal(conflict.pendingAction,'none');
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row=>row.status),['skipped']);
}));

test('QA blocked decision records once and stops',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='e'.repeat(64),completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('blocked',packageDigest,{reason:'qa_unavailable',
      score:null,at:'2026-09-04T12:04:30-07:00'})}).handle(operation('qa',{packageDigest}));
  assert.equal(result.code,'qa_blocked');assert.equal(result.pendingAction,'none');
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row=>row.status),['blocked']);
}));

test('QA log failure rejects without advancing or calling the runner',()=>fixture(async({root,codeProject})=>{
  const packageDigest='f'.repeat(64),missingSpecs=path.join(root,'missing-specs'),effects=[];
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async effect=>{effects.push(effect);return completed;},
    cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const result=await createCmAiConversationEntry({specsDir:missingSpecs,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',
      score:null,at:'2026-09-04T12:04:45-07:00'})}).handle(operation('qa',{packageDigest}));
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'qa_log_failed');
  assert.equal(result.pendingAction,'none');assert.equal(effects.length,0);
}));

test('QA decision can append after a valid authority log grows beyond one MiB',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='9'.repeat(64),log=path.join(specsDir,'运行日志.jsonl');
  fs.writeFileSync(log,`${JSON.stringify({schema_version:1,event:'progress',detail:'historical'})}\n`.repeat(22000));
  assert(fs.statSync(log).size>1024*1024);
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    qaLogHome:path.join(root,'logs'),qaDecision:qaDecision('skipped',packageDigest,{reason:'small_change',score:5,
      at:'2026-09-04T12:04:55-07:00'})}).handle(operation('qa',{packageDigest}));
  assert.equal(result.code,'qa_skipped');assert.equal(result.pendingAction,'context_refresh');
  const last=fs.readFileSync(log,'utf8').trim().split('\n').at(-1);
  assert.equal(JSON.parse(last).status,'skipped');
}));

test('QA log adapter rejects an invalid package binding before writing',()=>fixture(async({root,specsDir,codeProject})=>{
  const {recordCmAiQaDecision}=await import('./cm-ai-qa-log.mjs');
  assert.throws(()=>recordCmAiQaDecision({specsDir,codeProject,feature:'1.login',identity,
    packageDigest:'not-a-digest',logHome:path.join(root,'logs'),
    decision:qaDecision('blocked','a'.repeat(64),{reason:'qa_unavailable',score:null,
      at:'2026-09-04T12:05:00-07:00'})}),
  error=>error?.code==='invalid_input');
  assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));
}));

test('QA result advances only from one bound PASS start/complete pair with an in-root report',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='8'.repeat(64),testRunId='qa-run-pass',logHome=path.join(root,'logs'),effects=[];
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async effect=>{effects.push(effect);return completed;},
    cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const trigger=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
    qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
      at:'2026-09-04T13:00:00-07:00'})});
  assert.equal((await trigger.handle(operation('qa',{packageDigest}))).code,'qa_triggered');
  const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa-pass.md'),'passed\n');
  const binding={node:'N6',feature:'1.login',task:'T-001',attempt:1,repository_id:'fixture',
    package_digest:packageDigest,qa_decision_id:'qa-triggered',operation_id:testRunId};
  writeTestRun({specsDir,codeProject,logHome,phase:'start',at:'2026-09-04T13:01:00-07:00',
    data:{...binding,mode:'commands',case_count:2}});
  writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:'2026-09-04T13:02:00-07:00',
    data:{...binding,mode:'commands',case_count:2,passed:2,failed:0,blocked:0,result:'PASS',report:'.reviews/qa-pass.md'}});
  const log=path.join(specsDir,'运行日志.jsonl'),before=fs.readFileSync(log);
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});

  const result=await entry.handle(operation('qa_result',{packageDigest,testRunId}));
  const forged=await entry.handle({...operation('qa_result',{requestId:'qa-result-forged',packageDigest,testRunId}),result:'PASS'});

  assert.equal(result.outcome,'verified');assert.equal(result.code,'qa_passed');
  assert.equal(result.pendingAction,'context_refresh');assert.equal(forged.code,'invalid_input');
  assert.equal(effects.length,0);assert.deepEqual(fs.readFileSync(log),before);
}));

test('QA FAIL and BLOCKED results stop without runner effects',async()=>{
  for(const [rawResult,counts,expected] of [
    ['FAILED',{case_count:2,passed:1,failed:1,blocked:0},'qa_failed'],
    ['NEEDS_MANUAL',{case_count:2,passed:1,failed:0,blocked:1},'qa_result_blocked'],
  ])await fixture(async({root,specsDir,codeProject})=>{
    const packageDigest='7'.repeat(64),testRunId=`qa-run-${rawResult.toLowerCase()}`,logHome=path.join(root,'logs');
    const completed={state:'fixture_completed',code:null,identity,packageDigest};
    const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
    const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
    const trigger=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
      qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
        at:'2026-09-04T13:10:00-07:00'})});
    await trigger.handle(operation('qa',{packageDigest}));
    const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'result\n');
    const binding={node:'N6',feature:'1.login',task:'T-001',attempt:1,repository_id:'fixture',
      package_digest:packageDigest,qa_decision_id:'qa-triggered',operation_id:testRunId,mode:'commands'};
    writeTestRun({specsDir,codeProject,logHome,phase:'start',at:'2026-09-04T13:11:00-07:00',data:{...binding,case_count:2}});
    writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:'2026-09-04T13:12:00-07:00',
      data:{...binding,...counts,result:rawResult,report:'.reviews/qa.md'}});
    const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
      .handle(operation('qa_result',{packageDigest,testRunId}));
    assert.equal(result.code,expected);assert.equal(result.pendingAction,rawResult==='FAILED'?'fix_authorization':'none');
    const {inspectCmAiQaFailure}=await import('./cm-ai-qa-log.mjs');
    const source={specsDir,feature:'1.login',identity,packageDigest,testRunId};
    if(rawResult==='FAILED'){
      const before=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'));
      assert.deepEqual(inspectCmAiQaFailure(source),{identity,packageDigest,testRunId,
        qaDecisionId:'qa-triggered',qaRound:1,report:path.join(reviews,'qa.md'),
        counts:{total:2,passed:1,failed:1,blocked:0}});
      const reportBytes=fs.readFileSync(path.join(reviews,'qa.md'));
      for(const [policy,pending,status] of [['never','none','blocked'],['explicit','fix_authorization','authorization_required'],['auto','fix_dispatch','dispatch_required']]){
        fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{auto_fix:policy}}));
        const next=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
          .handle(operation('qa_result',{packageDigest,testRunId}));
        assert.equal(next.code,'qa_failed');assert.equal(next.pendingAction,pending);
        assert.equal(next.fixHandoff.status,status);assert.equal(next.fixHandoff.policy,policy);
        assert.equal(next.fixHandoff.execution,'not_started');assert.equal(next.fixHandoff.source.qaRound,1);
        assert.equal(next.fixHandoff.source.reportEvidence.path,'.reviews/qa.md');
        assert.match(next.fixHandoff.source.reportEvidence.sha256,/^[a-f0-9]{64}$/);
        assert.equal(next.fixHandoff.source.reportEvidence.contentBase64,undefined);
      }
      assert.deepEqual(fs.readFileSync(path.join(reviews,'qa.md')),reportBytes);
      assert.deepEqual(fs.readFileSync(path.join(specsDir,'运行日志.jsonl')),before);
      for(const round of [2,3]){
        const currentId=`qa-retest-${round}`;
        const current={...binding,attempt:round,operation_id:currentId};
        writeTestRun({specsDir,codeProject,logHome,phase:'start',at:`2026-09-04T13:${round+20}:00-07:00`,data:{...current,case_count:2}});
        writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:`2026-09-04T13:${round+20}:01-07:00`,data:{...current,...counts,result:rawResult,report:'.reviews/qa.md'}});
        const next=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
          .handle(operation('qa_result',{packageDigest,testRunId:currentId}));
        assert.equal(next.fixHandoff.source.qaRound,round);
        assert.equal(next.pendingAction,round===3?'none':'fix_dispatch');
        if(round===3)assert.equal(next.fixHandoff.reason,'qa_round_limit');
      }
    }else assert.throws(()=>inspectCmAiQaFailure(source),{code:'qa_failure_required'});
  });
});

test('QA result rejects incomplete, contradictory, or out-of-root evidence',async()=>{
  for(const kind of ['missing_start','contradictory_pass','blocking_case','outside_report'])await fixture(async({root,specsDir,codeProject})=>{
    const packageDigest='6'.repeat(64),testRunId=`qa-run-${kind}`,logHome=path.join(root,'logs');
    const completed={state:'fixture_completed',code:null,identity,packageDigest};
    const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
    const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
    await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
      qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
        at:'2026-09-04T13:20:00-07:00'})}).handle(operation('qa',{packageDigest}));
    const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'result\n');
    fs.writeFileSync(path.join(specsDir,'outside.md'),'outside\n');
    const binding={node:'N6',feature:'1.login',task:'T-001',attempt:1,repository_id:'fixture',
      package_digest:packageDigest,qa_decision_id:'qa-triggered',operation_id:testRunId,mode:'commands'};
    writeTestRun({specsDir,codeProject,logHome,phase:'start',
      at:'2026-09-04T13:21:00-07:00',data:{...binding,case_count:2}});
    writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:'2026-09-04T13:22:00-07:00',
      data:{...binding,case_count:2,passed:2,failed:0,blocked:0,result:'PASS',
        report:kind==='outside_report'?'outside.md':'.reviews/qa.md'}});
    // Corrupt an otherwise valid local fixture after production logging, so the
    // consumer's negative cases do not stop at the producer's own safeguards.
    const log=path.join(specsDir,'运行日志.jsonl');
    let rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    if(kind==='missing_start')rows=rows.filter(row=>!(row.event==='test_run'&&row.phase==='start'));
    if(kind==='contradictory_pass')rows.at(-1).passed=1;
    if(kind==='blocking_case')rows.splice(rows.length-1,0,{...rows.at(-1),phase:'case_blocked',
      event_id:'synthetic-blocked-case',at:'2026-09-04T13:21:30-07:00',case_id:'B-001',result:'BLOCKED'});
    fs.writeFileSync(log,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
      .handle(operation('qa_result',{packageDigest,testRunId}));
    assert.equal(result.outcome,'rejected');assert.equal(result.pendingAction,'none');
    assert.equal(result.code,kind==='missing_start'?'qa_result_incomplete':
      kind==='outside_report'?'qa_report_invalid':'qa_result_invalid');
  });
});

test('QA result cannot reuse a matching test run written before the trigger decision',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='5'.repeat(64),testRunId='qa-run-before-trigger',logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'old\n');
  const binding={node:'N6',feature:'1.login',task:'T-001',attempt:1,repository_id:'fixture',
    package_digest:packageDigest,qa_decision_id:'qa-triggered',operation_id:testRunId,mode:'commands'};
  writeTestRun({specsDir,codeProject,logHome,phase:'start',at:'2026-09-04T13:29:00-07:00',
    data:{...binding,case_count:1}});
  writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:'2026-09-04T13:29:30-07:00',
    data:{...binding,case_count:1,passed:1,failed:0,blocked:0,result:'PASS',report:'.reviews/qa.md'}});
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
    qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
      at:'2026-09-04T13:30:00-07:00'})}).handle(operation('qa',{packageDigest}));
  const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
    .handle(operation('qa_result',{packageDigest,testRunId}));
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'qa_result_invalid');
  assert.equal(result.pendingAction,'none');
}));

test('only the latest QA round can decide whether the workflow advances',async()=>{
  for(const scenario of [
    {name:'pass_then_fail',first:'PASS',second:'FAIL',secondComplete:true,newCode:'qa_failed'},
    {name:'pass_then_incomplete',first:'PASS',second:null,secondComplete:false,newCode:'qa_result_incomplete'},
    {name:'fail_then_pass',first:'FAIL',second:'PASS',secondComplete:true,newCode:'qa_passed'},
  ])await fixture(async({root,specsDir,codeProject})=>{
    const packageDigest='4'.repeat(64),logHome=path.join(root,'logs'),firstId=`${scenario.name}-1`,secondId=`${scenario.name}-2`;
    const completed={state:'fixture_completed',code:null,identity,packageDigest};
    const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
    const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'rounds\n');
    const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
    await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
      qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
        at:'2026-09-04T13:40:00-07:00'})}).handle(operation('qa',{packageDigest}));
    const base={node:'N6',feature:'1.login',task:'T-001',repository_id:'fixture',
      package_digest:packageDigest,qa_decision_id:'qa-triggered',mode:'commands'};
    const writeRound=(operationId,attempt,result,minute,complete=true)=>{
      const binding={...base,operation_id:operationId,attempt};
      writeTestRun({specsDir,codeProject,logHome,phase:'start',at:`2026-09-04T13:${minute}:00-07:00`,
        data:{...binding,case_count:1}});
      if(complete)writeTestRun({specsDir,codeProject,logHome,phase:'complete',
        at:`2026-09-04T13:${minute}:30-07:00`,data:{...binding,case_count:1,passed:result==='PASS'?1:0,
          failed:result==='FAIL'?1:0,blocked:0,result,report:'.reviews/qa.md'}});
    };
    writeRound(firstId,1,scenario.first,'41');writeRound(secondId,2,scenario.second,'42',scenario.secondComplete);
    const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner});
    const old=await entry.handle(operation('qa_result',{requestId:`${scenario.name}-old`,packageDigest,testRunId:firstId}));
    const latest=await entry.handle(operation('qa_result',{requestId:`${scenario.name}-new`,packageDigest,testRunId:secondId}));
    assert.equal(old.code,'qa_result_stale',scenario.name);assert.equal(old.pendingAction,'none',scenario.name);
    assert.equal(latest.code,scenario.newCode,scenario.name);
    assert.equal(latest.pendingAction,scenario.newCode==='qa_passed'?'context_refresh':
      scenario.newCode==='qa_failed'?'fix_authorization':'none',scenario.name);
    const {inspectCmAiQaFailure}=await import('./cm-ai-qa-log.mjs');
    const source={specsDir,feature:'1.login',identity,packageDigest};
    assert.throws(()=>inspectCmAiQaFailure({...source,testRunId:firstId}),{code:'qa_result_stale'});
    if(scenario.second==='FAIL')assert.equal(inspectCmAiQaFailure({...source,testRunId:secondId}).qaRound,2);
    else assert.throws(()=>inspectCmAiQaFailure({...source,testRunId:secondId}),
      {code:scenario.secondComplete?'qa_failure_required':'qa_result_incomplete'});
  });
});

test('QA rounds cannot repeat, move backwards, or reset after the third attempt',async()=>{
  for(const [name,attempts] of [
    ['duplicate',[1,1]],
    ['backwards',[1,2,1]],
    ['reset_after_three',[1,2,3,1]],
  ])await fixture(async({root,specsDir,codeProject})=>{
    const packageDigest='3'.repeat(64),logHome=path.join(root,'logs');
    const completed={state:'fixture_completed',code:null,identity,packageDigest};
    const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
    const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'rounds\n');
    const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
    await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
      qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
        at:'2026-09-04T14:00:00-07:00'})}).handle(operation('qa',{packageDigest}));
    let latestId;
    attempts.forEach((attempt,index)=>{
      latestId=`${name}-${index+1}`;
      const binding={node:'N6',feature:'1.login',task:'T-001',repository_id:'fixture',package_digest:packageDigest,
        qa_decision_id:'qa-triggered',operation_id:latestId,attempt,mode:'commands',case_count:1};
      writeTestRun({specsDir,codeProject,logHome,phase:'start',at:`2026-09-04T14:0${index+1}:00-07:00`,data:binding});
      writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:`2026-09-04T14:0${index+1}:30-07:00`,
        data:{...binding,passed:index===attempts.length-1?1:0,failed:index===attempts.length-1?0:1,blocked:0,
          result:index===attempts.length-1?'PASS':'FAIL',report:'.reviews/qa.md'}});
    });
    const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner})
      .handle(operation('qa_result',{requestId:`${name}-result`,packageDigest,testRunId:latestId}));
    assert.equal(result.outcome,'rejected',name);assert.equal(result.code,'qa_result_invalid',name);
    assert.equal(result.pendingAction,'none',name);
  });
});

test('F05 task learning input returns only task-bound AGENTS and LESSONS metadata',()=>fixture(async({specsDir,codeProject})=>{
  fs.writeFileSync(path.join(specsDir,'LESSONS.md'),'# Lessons\n');
  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Project rules\n');
  fs.mkdirSync(path.join(codeProject,'src'));
  fs.writeFileSync(path.join(codeProject,'src','AGENTS.md'),'# Source rules\n');
  fs.mkdirSync(path.join(codeProject,'.claude','rules'),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'.claude','CLAUDE.md'),'@rules/testing.md\n');
  fs.writeFileSync(path.join(codeProject,'.claude','rules','testing.md'),'# Tests\n');
  const {inspectCmAiTaskLearningInput}=await import('./cm-ai-context-refresh.mjs');

  const first=inspectCmAiTaskLearningInput({specsDir,codeProject,feature:'1.login',identity,
    applicableAgentFiles:['src/AGENTS.md']});
  const repeated=inspectCmAiTaskLearningInput({specsDir,codeProject,feature:'1.login',identity,
    applicableAgentFiles:['src/AGENTS.md']});

  assert.equal(first.version,1);assert.equal(first.workflow,'cm-ai');assert.equal(first.phase,'task_learning_input');
  assert.equal(first.feature,'1.login');assert.deepEqual(first.identity,identity);
  assert.match(first.learningDigest,/^[a-f0-9]{64}$/);assert.equal(repeated.learningDigest,first.learningDigest);
  assert.deepEqual(first.learningFiles.map(file=>`${file.scope}:${file.path}`),[
    'project:AGENTS.md','project:src/AGENTS.md','specs:LESSONS.md',
  ]);
  assert(first.learningFiles.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
  assert(Object.isFrozen(first));assert(Object.isFrozen(first.learningFiles));

  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Changed project rules\n');
  const changed=inspectCmAiTaskLearningInput({specsDir,codeProject,feature:'1.login',identity,
    applicableAgentFiles:['src/AGENTS.md']});
  assert.notEqual(changed.learningDigest,first.learningDigest);
}));

test('F05 task learning input deduplicates the trusted applicable AGENTS list',()=>fixture(async({specsDir,codeProject})=>{
  fs.mkdirSync(path.join(codeProject,'src'));
  fs.writeFileSync(path.join(codeProject,'src','AGENTS.md'),'# Source rules\n');
  const {inspectCmAiTaskLearningInput}=await import('./cm-ai-context-refresh.mjs');

  const result=inspectCmAiTaskLearningInput({specsDir,codeProject,feature:'1.login',identity,
    applicableAgentFiles:['src/AGENTS.md','src/AGENTS.md']});

  assert.deepEqual(result.learningFiles.map(file=>file.path),['src/AGENTS.md']);
}));

test('F05 task learning input treats optional files as empty and rejects wrong task or escaped AGENTS',()=>fixture(async({root,specsDir,codeProject})=>{
  const {inspectCmAiTaskLearningInput}=await import('./cm-ai-context-refresh.mjs');
  const input={specsDir,codeProject,feature:'1.login',identity,applicableAgentFiles:[]};

  const empty=inspectCmAiTaskLearningInput(input);
  assert.deepEqual(empty.learningFiles,[]);assert.match(empty.learningDigest,/^[a-f0-9]{64}$/);
  assert.throws(()=>inspectCmAiTaskLearningInput({...input,identity:{...identity,taskId:'T-002'}}),
    {code:'learning_context_invalid'});
  fs.mkdirSync(path.join(root,'outside'));fs.writeFileSync(path.join(root,'outside','AGENTS.md'),'# Outside\n');
  assert.throws(()=>inspectCmAiTaskLearningInput({...input,applicableAgentFiles:['../outside/AGENTS.md']}),
    {code:'context_invalid'});
}));

test('F05 task Learning application records applied or no-relevant in existing handoff evidence',()=>{
  const base={feature:'1.login',identity,learningDigest:'a'.repeat(64)};
  const applied=createCmAiTaskLearningApplication({...base,status:'applied',
    note:'身份边界不能靠字符串碰巧命中 → 复验完整 task identity'});
  const none=createCmAiTaskLearningApplication({...base,status:'no_relevant_lesson',note:null});
  assert.equal(applied.status,'applied');assert.equal(none.note,null);
  assert.match(encodeCmAiTaskLearningApplicationEvidence(applied),/^cm-learning-application-v1:/);
  assert(Object.isFrozen(applied));assert.match(applied.applicationDigest,/^[a-f0-9]{64}$/);
  for(const invalid of [
    {...base,status:'applied',note:null},
    {...base,status:'no_relevant_lesson',note:'invented'},
    {...base,status:'applied',note:'line one\nline two'},
    {...base,status:'applied',note:'line one\u2028line two'},
  ])assert.throws(()=>createCmAiTaskLearningApplication(invalid));
  assert.throws(()=>encodeCmAiTaskLearningApplicationEvidence({...applied,applicationDigest:'b'.repeat(64)}));
});

test('F05 task retrospective encodes the three closeout results for existing handoff evidence',async()=>{
  const {createCmAiTaskLearningRetrospective,encodeCmAiTaskLearningEvidence}=await import('./cm-ai-context-refresh.mjs');
  const base={feature:'1.login',identity,learningDigest:'a'.repeat(64)};
  const candidate={classification:'structured',trigger:'Learning source changes during resume',
    action:'Reject replacement of the fixed task snapshot',evidence:['experiments/js-orchestration/task-runner.test.mjs']};
  const none=createCmAiTaskLearningRetrospective({...base,status:'no_new_lesson',candidates:[],reason:null});
  const found=createCmAiTaskLearningRetrospective({...base,status:'lesson_candidate',candidates:[candidate],reason:null});
  const reorderedIdentity={attempt:identity.attempt,taskId:identity.taskId,runId:identity.runId,repositoryId:identity.repositoryId};
  const reordered=createCmAiTaskLearningRetrospective({reason:null,candidates:[{evidence:candidate.evidence,
    action:candidate.action,trigger:candidate.trigger,classification:candidate.classification}],status:'lesson_candidate',
    learningDigest:base.learningDigest,identity:reorderedIdentity,feature:base.feature});
  const pending=createCmAiTaskLearningRetrospective({...base,status:'writeback_pending',candidates:[candidate],
    reason:'AGENTS.md changed concurrently'});

  assert.deepEqual([none.status,found.status,pending.status],['no_new_lesson','lesson_candidate','writeback_pending']);
  for(const result of [none,found,pending]){
    assert.match(result.retrospectiveDigest,/^[a-f0-9]{64}$/);assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.candidates));assert.equal(encodeCmAiTaskLearningEvidence(result),
      `cm-learning-retrospective-v1:${JSON.stringify(result)}`);
  }
  assert.equal(encodeCmAiTaskLearningEvidence(reordered),encodeCmAiTaskLearningEvidence(found));
  const direct={retrospectiveDigest:found.retrospectiveDigest,reason:found.reason,candidates:[{evidence:candidate.evidence,
    action:candidate.action,trigger:candidate.trigger,classification:candidate.classification}],status:found.status,
    learningDigest:found.learningDigest,identity:reorderedIdentity,feature:found.feature,phase:found.phase,
    workflow:found.workflow,version:found.version};
  assert.equal(encodeCmAiTaskLearningEvidence(direct),encodeCmAiTaskLearningEvidence(found));
});

test('F05 task retrospective rejects contradictory, unsafe, oversized, or tampered results',async()=>{
  const {createCmAiTaskLearningRetrospective,encodeCmAiTaskLearningEvidence}=await import('./cm-ai-context-refresh.mjs');
  const base={feature:'1.login',identity,learningDigest:'a'.repeat(64)},candidate={classification:'memory_only',
    trigger:'A verified constraint was observed',action:'Recheck it on the next task',evidence:['docs/fix.md']};
  for(const input of [
    {...base,status:'no_new_lesson',candidates:[candidate],reason:null},
    {...base,status:'lesson_candidate',candidates:[],reason:null},
    {...base,status:'writeback_pending',candidates:[candidate],reason:null},
    {...base,status:'lesson_candidate',candidates:Array(4).fill(candidate),reason:null},
    {...base,status:'lesson_candidate',candidates:[{...candidate,trigger:'line one\nline two'}],reason:null},
    {...base,status:'lesson_candidate',candidates:[{...candidate,trigger:'line one\u2028line two'}],reason:null},
    {...base,status:'lesson_candidate',candidates:[{...candidate,action:'line one\u2029line two'}],reason:null},
    {...base,status:'lesson_candidate',candidates:[{...candidate,evidence:['../secret']}],reason:null},
    {...base,status:'lesson_candidate',candidates:[{...candidate,evidence:['docs/fix.md','docs/fix.md']}],reason:null},
  ])assert.throws(()=>createCmAiTaskLearningRetrospective(input));
  const valid=createCmAiTaskLearningRetrospective({...base,status:'lesson_candidate',candidates:[candidate],reason:null});
  assert.throws(()=>encodeCmAiTaskLearningEvidence({...valid,retrospectiveDigest:'b'.repeat(64)}));
});

test('F05 task retrospective remains one existing handoff evidence string without schema changes',()=>fixture(async({root})=>{
  const {createCmAiTaskLearningRetrospective,encodeCmAiTaskLearningEvidence}=await import('./cm-ai-context-refresh.mjs');
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,learningDigest:'a'.repeat(64),
    status:'no_new_lesson',candidates:[],reason:null});
  const handoff=path.join(root,'handoff.json');
  fs.writeFileSync(handoff,JSON.stringify({schema_version:1,task_id:'T-001',attempt:1,status:'ready_for_review',
    changed_files:['src/example.ts'],verification:[{command:'node --test',status:'passed',evidence:'fixture'}],
    evidence:[encodeCmAiTaskLearningEvidence(retrospective)],blockers:[],scope_deviation:[]}));
  const result=spawnSync('python3',[path.resolve(import.meta.dirname,'../../scripts/cm-task-gate.py'),'validate-handoff',
    '--handoff',handoff,'--task','T-001','--attempt','1'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}));

test('F05 task handoff attachment binds trusted Learning input and appends one evidence item',()=>fixture(async({root})=>{
  const {attachCmAiTaskLearningEvidence,createCmAiTaskLearningRetrospective}=await import('./cm-ai-context-refresh.mjs');
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity,
    learningDigest,learningFiles};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,learningDigest,
    status:'no_new_lesson',candidates:[],reason:null});
  const handoff={schema_version:1,task_id:'T-001',attempt:1,status:'ready_for_review',
    changed_files:['src/example.ts'],verification:[{command:'node --test',status:'passed',evidence:'fixture'}],
    evidence:['implementation complete'],blockers:[],scope_deviation:[]};

  const attached=attachCmAiTaskLearningEvidence({handoff,feature:'1.login',identity,learningInput,retrospective});
  const replayed=attachCmAiTaskLearningEvidence({handoff:attached,feature:'1.login',identity,learningInput,retrospective});

  assert.equal(attached.evidence.length,2);assert.match(attached.evidence[1],/^cm-learning-retrospective-v1:/);
  assert.deepEqual(replayed,attached);assert.equal(handoff.evidence.length,1);assert(Object.isFrozen(attached));
  const target=path.join(root,'handoff.json');fs.writeFileSync(target,JSON.stringify(attached));
  const result=spawnSync('python3',[path.resolve(import.meta.dirname,'../../scripts/cm-task-gate.py'),'validate-handoff',
    '--handoff',target,'--task','T-001','--attempt','1'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}));

test('F05 task handoff attachment rejects stale identity, Learning digest, or conflicting evidence',async()=>{
  const {attachCmAiTaskLearningEvidence,createCmAiTaskLearningRetrospective}=await import('./cm-ai-context-refresh.mjs');
  const files=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity,files});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity,
    learningDigest,learningFiles:files};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,learningDigest,
    status:'no_new_lesson',candidates:[],reason:null});
  const handoff={schema_version:1,task_id:'T-001',attempt:1,status:'ready_for_review',changed_files:['src/example.ts'],
    verification:[{command:'node --test',status:'passed',evidence:'fixture'}],evidence:['implementation complete'],
    blockers:[],scope_deviation:[]};
  const attempt2={...identity,attempt:2};
  const otherTask={...identity,taskId:'T-002'};
  const staleRetrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,
    learningDigest:'b'.repeat(64),status:'no_new_lesson',candidates:[],reason:null});
  const otherIdentityRetrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:attempt2,
    learningDigest,status:'no_new_lesson',candidates:[],reason:null});
  for(const input of [
    {handoff,feature:'2.profile',identity,learningInput,retrospective},
    {handoff,feature:'1.login',identity,learningInput:{...learningInput,
      learningFiles:[{...files[0],sha256:'b'.repeat(64)}]},retrospective},
    {handoff,feature:'1.login',identity,learningInput,retrospective:staleRetrospective},
    {handoff,feature:'1.login',identity,learningInput,retrospective:otherIdentityRetrospective},
    {handoff:{...handoff,task_id:otherTask.taskId},feature:'1.login',identity,learningInput,retrospective},
    {handoff:{...handoff,attempt:2},feature:'1.login',identity,learningInput,retrospective},
    {handoff:{...handoff,evidence:['cm-learning-retrospective-v1:{"version":1}']},feature:'1.login',identity,
      learningInput,retrospective},
  ])assert.throws(()=>attachCmAiTaskLearningEvidence(input));
});

test('N7 refresh rereads disk context after QA skip and selects the next task without writing',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='2'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const featureDir=path.join(specsDir,'1.login');
  fs.writeFileSync(path.join(featureDir,'tasks.md'),'- [x] T-001: implement login\n- [ ] T-002: add profile\n');
  fs.writeFileSync(path.join(specsDir,'LESSONS.md'),'first lesson\n');
  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Project rules\n');
  fs.mkdirSync(path.join(codeProject,'src'));
  fs.writeFileSync(path.join(codeProject,'src','AGENTS.md'),'# Source rules\n');
  fs.mkdirSync(path.join(codeProject,'.claude','rules'),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'.claude','CLAUDE.md'),'@rules/testing.md\n');
  fs.writeFileSync(path.join(codeProject,'.claude','rules','testing.md'),'# Tests\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const decision=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
    qaDecision:qaDecision('skipped',packageDigest,{reason:'docs_only',score:4,at:'2026-09-04T14:10:00-07:00'})});
  await decision.handle(operation('qa',{packageDigest}));
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:['src/AGENTS.md']});
  const before=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'));
  const first=await entry.handle(operation('context_refresh',{packageDigest,testRunId:null}));

  assert.equal(first.outcome,'refreshed');assert.equal(first.code,'context_refreshed');
  assert.equal(first.pendingAction,'start_next_task');
  assert.deepEqual(first.nextTask,{feature:'1.login',id:'T-002',description:'add profile'});
  assert.match(first.contextDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(first.contextFiles.map(file=>`${file.scope}:${file.path}`),[
    'project:.claude/CLAUDE.md','project:.claude/rules/testing.md','project:AGENTS.md','project:src/AGENTS.md',
    'specs:1.login/design.md','specs:1.login/requirements.md','specs:1.login/tasks.md','specs:LESSONS.md',
  ]);
  assert(first.contextFiles.every(file=>/^[a-f0-9]{64}$/.test(file.sha256)));
  assert.deepEqual(fs.readFileSync(path.join(specsDir,'运行日志.jsonl')),before);

  fs.writeFileSync(path.join(specsDir,'LESSONS.md'),'updated lesson\n');
  const second=await entry.handle(operation('context_refresh',{requestId:'context-refresh-2',packageDigest,testRunId:null}));
  assert.notEqual(second.contextDigest,first.contextDigest);
}));

test('N7 refresh rejects missing or incomplete QA evidence and accepts the latest PASS',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='1'.repeat(64),testRunId='n7-pass',logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});
  assert.equal((await entry.handle(operation('context_refresh',{packageDigest,testRunId:null}))).code,'context_not_ready');
  await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,qaLogHome:logHome,
    qaDecision:qaDecision('triggered',packageDigest,{reason:'feature_complete',score:null,
      at:'2026-09-04T14:20:00-07:00'})}).handle(operation('qa',{packageDigest}));
  assert.equal((await entry.handle(operation('context_refresh',{requestId:'context-incomplete',packageDigest,testRunId:null}))).code,
    'context_not_ready');
  const reviews=path.join(specsDir,'.reviews');fs.mkdirSync(reviews);fs.writeFileSync(path.join(reviews,'qa.md'),'pass\n');
  const binding={node:'N6',feature:'1.login',task:'T-001',attempt:1,repository_id:'fixture',package_digest:packageDigest,
    qa_decision_id:'qa-triggered',operation_id:testRunId,mode:'commands',case_count:1};
  writeTestRun({specsDir,codeProject,logHome,phase:'start',at:'2026-09-04T14:21:00-07:00',data:binding});
  writeTestRun({specsDir,codeProject,logHome,phase:'complete',at:'2026-09-04T14:22:00-07:00',
    data:{...binding,passed:1,failed:0,blocked:0,result:'PASS',report:'.reviews/qa.md'}});
  const passed=await entry.handle(operation('context_refresh',{requestId:'context-pass',packageDigest,testRunId}));
  assert.equal(passed.code,'context_refreshed');assert.equal(passed.pendingAction,'start_next_task');
}));

test('N7 refresh routes all-terminal disk state to N8 without running it',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='0'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T14:30:00-07:00"});
  const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]})
    .handle(operation('context_refresh',{packageDigest,testRunId:null}));
  assert.equal(result.outcome,'refreshed');assert.equal(result.code,'context_complete');
  assert.equal(result.pendingAction,'finish');assert.equal(result.nextTask,null);
}));

test('N7 refresh preserves renewed approval and blocked admission stops',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='a'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T14:40:00-07:00"});
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});

  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login']}));
  const awaiting=await entry.handle(operation('context_refresh',{requestId:'context-awaiting',packageDigest,testRunId:null}));
  assert.equal(awaiting.outcome,'awaiting');assert.equal(awaiting.state,'awaiting_spec_approval');
  assert.equal(awaiting.code,'spec_approval_required');assert.equal(awaiting.pendingAction,'spec_approval');

  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login']}));
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'no task rows\n');
  const blocked=await entry.handle(operation('context_refresh',{requestId:'context-blocked',packageDigest,testRunId:null}));
  assert.equal(blocked.outcome,'awaiting');assert.equal(blocked.state,'blocked');
  assert.equal(blocked.code,'tasks_invalid');assert.equal(blocked.pendingAction,'none');
}));

test('N7 refresh rejects an applicable AGENTS path outside the project',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='b'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  fs.mkdirSync(path.join(root,'outside'));fs.writeFileSync(path.join(root,'outside','AGENTS.md'),'# Outside\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T14:50:00-07:00"});
  const result=await createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:['../outside/AGENTS.md']})
    .handle(operation('context_refresh',{packageDigest,testRunId:null}));
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'context_invalid');
  assert.equal(result.pendingAction,'none');
}));

test('N8 finish requires documentation sync after all tasks are terminal without writing run_done',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='c'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  let effects=0;
  const runner={status:()=>completed,executeEffect:async()=>{effects++;return completed;},cancel:()=>completed,run:async()=>completed};
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T15:01:00-07:00"});
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});
  const before=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'));

  const result=await entry.handle(operation('finish',{packageDigest,testRunId:null}));

  assert.equal(result.outcome,'awaiting');assert.equal(result.code,'documentation_sync_required');
  assert.equal(result.pendingAction,'documentation_sync');assert.equal(result.state,'fixture_completed');
  assert.equal(effects,0);assert.deepEqual(fs.readFileSync(path.join(specsDir,'运行日志.jsonl')),before);
  assert.equal(fs.existsSync(path.join(specsDir,'.cm-status.json')),false);
}));

test('N8 finish accepts one current trusted documentation result but only advances to run finalization',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='d'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const second=path.join(specsDir,'2.profile');fs.mkdirSync(second);
  fs.writeFileSync(path.join(second,'requirements.md'),'# Profile requirements\n');
  fs.writeFileSync(path.join(second,'design.md'),'# Profile design\n');
  fs.writeFileSync(path.join(second,'tasks.md'),'- [x] T-002: implement profile\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login','2.profile']}));
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T15:02:00-07:00"});
  const refreshEntry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});
  const refresh=await refreshEntry.handle(operation('context_refresh',{packageDigest,testRunId:null}));
  assert(refresh.contextFiles.some(file=>file.scope==='specs'&&file.path==='2.profile/requirements.md'));
  const before=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'));
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[],documentationResult:documentationResult('completed',packageDigest,refresh.contextDigest)});

  const result=await entry.handle(operation('finish',{packageDigest,testRunId:null}));

  assert.equal(result.outcome,'verified');assert.equal(result.code,'documentation_synced');
  assert.equal(result.pendingAction,'run_finalize');assert.equal(result.state,'fixture_completed');
  assert.equal(result.contextDigest,refresh.contextDigest);
  assert.deepEqual(fs.readFileSync(path.join(specsDir,'运行日志.jsonl')),before);
  assert.equal(fs.existsSync(path.join(specsDir,'.cm-status.json')),false);

  fs.writeFileSync(path.join(second,'requirements.md'),'# Profile requirements changed after sync\n');
  const stale=await entry.handle(operation('finish',{requestId:'finish-stale',packageDigest,testRunId:null}));
  assert.equal(stale.outcome,'rejected');assert.equal(stale.code,'stale_documentation');
  assert.equal(stale.pendingAction,'none');
}));

test('N8 finish preserves a trusted documentation block and refuses pending task state',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='e'.repeat(64),logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T15:03:00-07:00"});
  const refreshEntry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});
  const refresh=await refreshEntry.handle(operation('context_refresh',{packageDigest,testRunId:null}));
  const blockedEntry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[],documentationResult:documentationResult('blocked',packageDigest,refresh.contextDigest,
      {reason:'README consistency failed'})});
  const blocked=await blockedEntry.handle(operation('finish',{packageDigest,testRunId:null}));
  assert.equal(blocked.outcome,'blocked');assert.equal(blocked.code,'documentation_sync_blocked');
  assert.equal(blocked.pendingAction,'none');

  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [ ] T-001: implement login\n');
  const pending=await blockedEntry.handle(operation('finish',{requestId:'finish-pending',packageDigest,testRunId:null}));
  assert.equal(pending.outcome,'rejected');assert.equal(pending.code,'run_not_ready');
}));

async function finalizationEntry({root,specsDir,codeProject,packageDigest}) {
  const logHome=path.join(root,'logs');
  const completed={state:'fixture_completed',code:null,identity,packageDigest};
  const runner={status:()=>completed,executeEffect:async()=>assert.fail('runner effect'),cancel:()=>completed,run:async()=>completed};
  fs.writeFileSync(path.join(specsDir,'1.login','tasks.md'),'- [x] T-001: implement login\n');
  const {createCmAiConversationEntry}=await import('./cm-ai-conversation-entry.mjs');
await seedLegacyQaSkip({specsDir,codeProject,packageDigest,logHome,at:"2026-09-04T15:10:00-07:00"});
  const refreshEntry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[]});
  const refresh=await refreshEntry.handle(operation('context_refresh',{packageDigest,testRunId:null}));
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature:'1.login',identity,runner,
    applicableAgentFiles:[],qaLogHome:logHome,
    documentationResult:documentationResult('completed',packageDigest,refresh.contextDigest)});
  return {entry,logHome,refresh};
}

test('N8 run finalization writes the existing run_done and status once without runner effects',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='f'.repeat(64);
  const {entry}=await finalizationEntry({root,specsDir,codeProject,packageDigest});

  const first=await entry.handle(operation('run_finalize',{packageDigest,testRunId:null}));
  const second=await entry.handle(operation('run_finalize',{requestId:'run-finalize-2',packageDigest,testRunId:null}));

  assert.equal(first.outcome,'finalized');assert.equal(first.code,'run_done');assert.equal(first.pendingAction,'none');
  assert.equal(first.deduplicated,false);assert.equal(second.deduplicated,true);
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const done=rows.filter(row=>row.event==='run_done');assert.equal(done.length,1);
  assert.equal(done[0].run_id,identity.runId);assert.equal(done[0].node,'N8');
  assert.equal(done[0].package_digest,packageDigest);assert.equal(done[0].documentation_sync_id,'docs-completed');
  const status=JSON.parse(fs.readFileSync(path.join(specsDir,'.cm-status.json'),'utf8'));
  assert.deepEqual(Object.keys(status),['node','feature','task','detail','state','at']);
  assert.equal(status.node,'N8');assert.equal(status.feature,'1.login');assert.equal(status.task,'T-001');
  assert.equal(status.state,'run_done');assert.match(status.at,/^\d{2}:\d{2}:\d{2}$/);
}));

test('N8 run finalization preserves writer resource blocking and does not create run_done status',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='9'.repeat(64);
  const {entry,logHome}=await finalizationEntry({root,specsDir,codeProject,packageDigest});
  const args=[path.resolve(import.meta.dirname,'../../scripts/cm-log-event.py'),'--workflow','cm-ai','--event','resource',
    '--phase','acquired','--runtime','codex','--project-root',codeProject,'--specs-dir',specsDir,
    '--run-id',identity.runId,'--detail','测试资源已创建','--data-json',
    JSON.stringify({resource_id:'profile-finalize',resource_kind:'test_profile',cleanup_required:true})];
  const acquired=spawnSync('python3',args,{encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}});
  assert.equal(acquired.status,0,acquired.stderr);

  const result=await entry.handle(operation('run_finalize',{packageDigest,testRunId:null}));

  assert.equal(result.outcome,'rejected');assert.equal(result.code,'run_log_failed');
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.some(row=>row.event==='run_done'),false);
  assert.equal(fs.existsSync(path.join(specsDir,'.cm-status.json')),false);
}));

test('N8 run finalization rejects an invalid status target before writing run_done',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='8'.repeat(64);
  const {entry}=await finalizationEntry({root,specsDir,codeProject,packageDigest});
  fs.mkdirSync(path.join(specsDir,'.cm-status.json'));
  const before=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'));

  const result=await entry.handle(operation('run_finalize',{packageDigest,testRunId:null}));

  assert.equal(result.outcome,'rejected');assert.equal(result.code,'status_invalid');
  assert.deepEqual(fs.readFileSync(path.join(specsDir,'运行日志.jsonl')),before);
}));

test('N8 run finalization replays the same run_done after an unknown status commit',()=>fixture(async({root,specsDir,codeProject})=>{
  const packageDigest='7'.repeat(64);
  const {entry}=await finalizationEntry({root,specsDir,codeProject,packageDigest});
  const rename=fs.renameSync;let interrupted=false;
  try {
    fs.renameSync=(source,target)=>{
      if(!interrupted&&target===path.join(specsDir,'.cm-status.json')){
        interrupted=true;throw Object.assign(Error('fixture status commit'),{code:'EIO'});
      }
      return rename(source,target);
    };
    const first=await entry.handle(operation('run_finalize',{packageDigest,testRunId:null}));
    assert.equal(first.outcome,'rejected');assert.equal(first.code,'run_finalize_unknown');
  } finally {fs.renameSync=rename;}

  const second=await entry.handle(operation('run_finalize',{requestId:'run-finalize-replay',packageDigest,testRunId:null}));

  assert.equal(second.outcome,'finalized');assert.equal(second.deduplicated,true);
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.event==='run_done').length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(specsDir,'.cm-status.json'),'utf8')).state,'run_done');
}));
