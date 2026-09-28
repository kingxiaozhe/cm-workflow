import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {withHandoffDiagnostic} from './cm-ai-host.mjs';
import {controlledState,stageAllowed,completedEffectCount,runnerStatus,readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths,reviewReceipt} from '../runtime/js/cm-ai/review-runner.mjs';
import {createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';

test('adapter exception code getter cannot escape the runner failure boundary',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-runner-error-code-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'code.js'),'old\n');
  fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'error-code',taskId:'T-001',attempt:1};
  let getterReads=0;
  const runner=createTaskRunner({root,identity,scope:['code.js'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:()=>{
      const error=new Error('adapter failure');
      Object.defineProperty(error,'code',{get(){getterReads++;throw new Error('private getter');}});
      throw error;
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not review');}}],
    check:()=>[],commit:()=>{throw new Error('must not commit');}});
  const result=await runner.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(result.state,'unknown');
  assert.equal(result.code,'execution_error');
  assert.equal(getterReads,0);
});

test('check-created untracked output blocks with paths and retries in the same run',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-output-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'code.js'),'old');
  fs.writeFileSync(path.join(root,'requirements.md'),'fixture');
  const identity={repositoryId:'fixture',runId:'check-output',taskId:'T-001',attempt:1};
  let checks=0;
  const hostCheck=createHostCheck({cwd:root,commands:[{id:'build',command:[process.execPath,'-e',
    "require('node:fs').mkdirSync('build',{recursive:true});require('node:fs').writeFileSync('build/product','x')"]}]});
  const runner=createTaskRunner({root,identity,scope:['code.js'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:5000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:request=>{
      fs.writeFileSync(path.join(root,'code.js'),'new');
      return {version:1,invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
        effectiveModel:'fixture',status:'succeeded',accepted:true,result:{outcome:'implemented'}};
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not review');}}],
    check:async(...args)=>{checks++;return checks===1?hostCheck(...args):
      [{id:'build',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}];},
    commit:()=>{throw new Error('must not commit');}});
  const first=await runner.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(first.state,'blocked');assert.equal(first.code,'check_output_out_of_scope');
  assert.equal(runner.verificationBlocks(),1);
  assert.match(first.reason,/build\/product/);assert(!first.reason.includes(root));
  fs.rmSync(path.join(root,'build'),{recursive:true});
  const second=await runner.executeEffect({version:1,id:'develop-2',identity,kind:'develop'});
  assert.equal(second.state,'awaiting_review');assert.equal(second.code,null);
  assert.equal(checks,2);
});

test('developer-created out of scope file remains unknown with a path diagnostic',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-developer-outscope-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'code.js'),'old');fs.writeFileSync(path.join(root,'requirements.md'),'fixture');
  const identity={repositoryId:'fixture',runId:'developer-outscope',taskId:'T-001',attempt:1};
  const runner=createTaskRunner({root,identity,scope:['code.js'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:5000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:request=>{
      fs.writeFileSync(path.join(root,'code.js'),'new');fs.writeFileSync(path.join(root,'unexpected.js'),'developer');
      return {version:1,invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
        effectiveModel:'fixture',status:'succeeded',accepted:true,result:{outcome:'implemented'}};
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not review');}}],
    check:async()=>[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    commit:()=>{throw new Error('must not commit');}});
  const result=await runner.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(result.state,'unknown');assert.equal(result.code,'out_of_scope');
  assert.match(result.reason,/unexpected\.js/);assert(!result.reason.includes(root));
});

test('host stderr repeats the bounded relative scope diagnostic',async()=>{
  let stderr='';
  const host=withHandoffDiagnostic({handle:async()=>({state:'blocked',code:'check_output_out_of_scope',
    reason:'out_of_scope: build/product'})},{write:text=>{stderr+=text;}});
  const result=await host.handle({operation:'status'});
  assert.equal(result.reason,'out_of_scope: build/product');
  assert.match(stderr,/build\/product/);
});

test('a later control error clears stale scope paths from status',()=>{
  const next=controlledState({state:'blocked',code:'check_output_out_of_scope',
    reason:'out_of_scope: build/product',workflowError:null},'workflow-error',false);
  assert.equal(next.code,'workflow_error');
  assert.equal(next.reason,null);
});

test('legacy state without a reason remains readable and check-output retry does not consume the effect cap',()=>{
  const state={state:'blocked',code:'out_of_scope',attempt:1,reviewPackage:null,receipt:null,receipts:[],calls:[],
    cancelAfterCommit:false,workflowError:null,cancellationRequested:false};
  const status=runnerStatus(state,{identity:{repositoryId:'fixture',runId:'legacy',taskId:'T-001',attempt:1}});
  assert.equal(Object.hasOwn(status,'reason'),false);
  assert.equal(stageAllowed('develop','blocked','check_output_out_of_scope'),true);
  assert.equal(completedEffectCount([{effect:{kind:'develop'},result:{state:'blocked',code:'check_output_out_of_scope'}}]),0);
  assert.equal(stageAllowed('develop','blocked','develop_checks_not_passed'),true);
  assert.equal(stageAllowed('develop','blocked','checks_not_passed'),false);
  assert.equal(completedEffectCount([{effect:{kind:'complete'},result:{state:'blocked',code:'checks_not_passed'}}]),1);
});

test('check-output block and reason replay from the stored run before retry',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-replay-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specs=path.join(root,'specs');
  fs.mkdirSync(code);fs.mkdirSync(path.join(specs,'.reviews'),{recursive:true});
  fs.writeFileSync(path.join(code,'code.js'),'old');fs.writeFileSync(path.join(code,'requirements.md'),'fixture');
  const tasksPath=path.join(specs,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const identity={repositoryId:'fixture',runId:'check-replay',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'feature',specsRoot:specs,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('fixture'),config:digest('fixture-config'),inputs:digest('fixture-input')},create:true};
  let store=openTaskExecutionStore(owner);
  t.after(()=>store.close());
  let checks=0;
  const options={root:code,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs:5000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:request=>{
      fs.writeFileSync(path.join(code,'code.js'),'new');
      return {version:1,invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
        effectiveModel:'fixture',status:'succeeded',accepted:true,result:{outcome:'implemented'}};
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not review');}}],
    check:async()=>{
      checks++;
      if(checks===1){fs.mkdirSync(path.join(code,'build'));fs.writeFileSync(path.join(code,'build/product'),'x');}
      return [{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}];
    },commit:()=>{throw new Error('must not commit');}};
  const first=createTaskRunner({...options,persistence:{store,mode:'create'}});
  const blocked=await first.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(blocked.code,'check_output_out_of_scope');
  assert.equal(first.verificationBlocks(),1);
  store.close();store=openTaskExecutionStore({...owner,create:false});
  const resumed=createTaskRunner({...options,persistence:{store,mode:'resume'}});
  assert.equal(resumed.status().reason,blocked.reason);
  assert.equal(resumed.verificationBlocks(),1);
  fs.rmSync(path.join(code,'build'),{recursive:true});
  const next=await resumed.executeEffect({version:1,id:'develop-2',identity,kind:'develop'});
  assert.equal(next.state,'awaiting_review');
});

test('legacy completion checks_not_passed never reopens develop live or after replay',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-legacy-complete-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specs=path.join(root,'specs');
  fs.mkdirSync(code);fs.mkdirSync(path.join(specs,'.reviews'),{recursive:true});
  fs.writeFileSync(path.join(code,'code.js'),'old');
  fs.writeFileSync(path.join(code,'requirements.md'),'fixture');
  const tasksPath=path.join(specs,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const identity={repositoryId:'fixture',runId:'legacy-complete',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'feature',specsRoot:specs,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('legacy-complete'),config:digest('fixture'),inputs:digest('fixture')},create:true};
  let store=openTaskExecutionStore(owner);
  t.after(()=>store.close());
  let checks=0,developCalls=0;
  const terminal=(request,result)=>({version:1,invocationId:request.invocationId,contextId:request.contextId,
    provider:request.provider,effectiveModel:'fixture',status:'succeeded',accepted:true,result});
  const options={root:code,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs:5000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:request=>{
      developCalls++;fs.writeFileSync(path.join(code,'code.js'),'new');
      return terminal(request,{outcome:'implemented'});
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:request=>terminal(request,{verdict:'approved',
        packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'fixture review'})}],
    check:()=>{checks++;return [{id:'unit',command:['fixture'],outcome:checks===1?'passed':'failed',
      exitCode:checks===1?0:1,evidence:'fixture'}];},
    commit:()=>{throw new Error('must not commit');}};
  const effect=(kind,id=kind)=>({version:1,id,identity,kind});
  const first=createTaskRunner({...options,persistence:{store,mode:'create'}});
  assert.equal((await first.executeEffect(effect('develop'))).state,'awaiting_review');
  assert.equal((await first.executeEffect(effect('review'))).state,'approved');
  store.close();

  // A pre-D1 journal could approve a failed-check review package. Rebind its
  // package, request and receipt so replay validates the actual legacy path.
  const statePath=path.join(specs,'.reviews','.execution',identity.runId,'state.json');
  const saved=JSON.parse(fs.readFileSync(statePath,'utf8'));
  const failed=[{id:'unit',command:['fixture'],outcome:'failed',exitCode:1,evidence:'fixture'}];
  const legacyPackage=createReviewPackage({root:code,baseline:saved.records[0].payload.baseline,checks:failed});
  const dev=saved.records.find(record=>record.payload.type==='effect-checkpoint'
    &&record.payload.checkpoint.state==='awaiting_review').payload.checkpoint;
  const approved=saved.records.at(-1).payload.checkpoint;
  dev.reviewPackage=legacyPackage;dev.currentChecks=failed;
  dev.cache.at(-1).result.packageDigest=legacyPackage.packageDigest;
  const reviewCall=approved.calls.at(-1);
  const reviewRequest=requestFor({invocationId:reviewCall.invocationId,identity,role:'reviewer',
    provider:'codex',requestedModel:'fixture',contextId:'review-one',
    payload:{reviewPackage:legacyPackage,priorReview:null}});
  const reviewResult={verdict:'approved',packageDigest:legacyPackage.packageDigest,
    examinedPaths:reviewPaths(legacyPackage),findings:[],summary:'fixture review'};
  reviewCall.requestDigest=reviewRequest.requestDigest;reviewCall.resultDigest=digest(reviewResult);
  const receipt=reviewReceipt({request:reviewRequest,call:reviewCall,result:reviewResult,
    reviewPackage:legacyPackage,developerProvider:'codex',fallbackReasons:[]});
  approved.reviewPackage=legacyPackage;approved.currentChecks=failed;
  approved.receipt=receipt;approved.receipts=[receipt];approved.priorReview=reviewResult;
  approved.cache[0]=structuredClone(dev.cache[0]);
  const reviewed=approved.cache.at(-1).result;
  reviewed.packageDigest=legacyPackage.packageDigest;
  reviewed.receipt=receipt;reviewed.receipts=[receipt];reviewed.calls=approved.calls;
  for(let i=0;i<saved.records.length;i++){
    const {digest:ignored,...record}=saved.records[i];
    record.previousDigest=i?saved.records[i-1].digest:null;
    saved.records[i]={...record,digest:digest(record)};
  }
  const {revision:ignored,...body}=saved;
  fs.writeFileSync(statePath,JSON.stringify({...body,revision:digest(body)})+'\n');
  assert.equal(readRunnerHistory(saved.records,saved.records[0].payload.config).state.state,'approved');
  const reopen=()=>{
    store.close();store=openTaskExecutionStore({...owner,create:false});
    return createTaskRunner({...options,persistence:{store,mode:'resume'}});
  };
  const live=reopen();
  assert.equal(live.status().state,'approved');
  assert.equal(live.status().receipt.checksDigest,digest(failed));
  const blocked=await live.executeEffect(effect('complete'));
  assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'checks_not_passed');
  assert.equal(live.status().code,'checks_not_passed');
  assert.equal(live.verificationBlocks(),0);
  assert.deepEqual(await live.executeEffect(effect('develop','develop-after-complete')),
    {outcome:'rejected',code:'stage_mismatch'});
  assert.equal(developCalls,1);
  const replay=reopen();
  assert.equal(replay.status().code,'checks_not_passed');
  assert.deepEqual(await replay.executeEffect(effect('develop','develop-after-replay')),
    {outcome:'rejected',code:'stage_mismatch'});
  assert.equal(developCalls,1);
});
