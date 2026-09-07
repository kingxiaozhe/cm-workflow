import {writeHandoff,writeReview} from './native-gate-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync,spawn } from 'node:child_process';
import {registerHooks} from 'node:module';
import { checkCompletion } from './gate-bridge.mjs';
import { digest,json } from './effect-contract.mjs';
import { openTaskExecutionStore } from './task-owner.mjs';
import { readRunnerHistory } from './durable-runner-state.mjs';
import { createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective } from './cm-ai-context-refresh.mjs';
import childProcess from 'node:child_process';

// Intercept only the native writer's gate imports, after the real functions run.
// Tests remain serial and clear their callbacks in finally blocks.
async function installGateHooks(writerURL,gateURL){
  const source=`import {prepareMarkDone as prepare,verifyMarkDonePlan as verify} from ${JSON.stringify(gateURL)};
    export const after={};
    export function prepareMarkDone(...args){const result=prepare(...args);after.prepare?.();return result;}
    export function verifyMarkDonePlan(...args){const result=verify(...args);after.verify?.();return result;}`;
  const wrapper='data:text/javascript,'+encodeURIComponent(source);
  registerHooks({resolve(specifier,context,next){
    if(context.parentURL===writerURL&&specifier==='../../../scripts/cm-task-gate.mjs')return {url:wrapper,shortCircuit:true};
    return next(specifier,context);
  }});
  return (await import(wrapper)).after;
}
const gateAfter=await installGateHooks(new URL('../../runtime/js/cm-ai/task-commit.mjs',import.meta.url).href,
  new URL('../../scripts/cm-task-gate.mjs',import.meta.url).href);
const {createTaskRunner}=await import('./task-runner.mjs');

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const applicationFor=(request,status='no_relevant_lesson',note=null)=>createCmAiTaskLearningApplication({
  feature:request.payload.learningInput.feature,identity:request.identity,
  learningDigest:request.payload.learningInput.learningDigest,status,note});
function writeFixtureReview(reviewsDir,handoff,{attempt=1,verdict='approved'}={}) {
  writeReview(path.join(reviewsDir,`login-T-001-r${attempt}.md`),handoff,attempt,verdict);
}
function rewriteRunnerState(f,mutate) {
  f.getStore().close();
  const target=path.join(f.specsRoot,'.reviews','.execution',f.ownerOptions.identity.runId,'state.json');
  const state=JSON.parse(fs.readFileSync(target));mutate(state);
  let previousDigest=null;
  state.records=state.records.map((record,index)=>{const body={version:1,seq:index+1,id:record.id,kind:record.kind,
    payload:record.payload,previousDigest};const next={...body,digest:digest(body)};previousDigest=next.digest;return next;});
  const body={version:state.version,identity:state.identity,fingerprints:state.fingerprints,records:state.records};
  fs.writeFileSync(target,`${JSON.stringify({...body,revision:digest(body)})}\n`);
}

async function composedFixture(fn,{twoAttempts=false}={}) {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-composed-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),dir=path.join(specsRoot,'login');
  fs.mkdirSync(root);fs.mkdirSync(dir,{recursive:true});
  const tasksPath=path.join(dir,'tasks.md'),reviewsDir=path.join(specsRoot,'.reviews');
  fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\r\n',{mode:0o640});fs.mkdirSync(reviewsDir);
  fs.writeFileSync(path.join(root,'a.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'composed',taskId:'T-001',attempt:1};
  const handoffs=[1,2].map(a=>path.join(reviewsDir,`login-T-001-a${a}-handoff.json`));
  for(let a=1;a<=(twoAttempts?2:1);a++){
    writeHandoff(handoffs[a-1],root,['a.js'],a);
    writeReview(path.join(reviewsDir,`login-T-001-r${a}.md`),handoffs[a-1],a,twoAttempts&&a===1?'changes_requested':'approved');
  }
  const ownerOptions={tasksPath,feature:'login',specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('composed-v2'),config:digest('fixture'),inputs:digest('original')},create:true};
  const calls=[];let store=openTaskExecutionStore(ownerOptions);
  const options={root,identity,scope:['a.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:r=>{calls.push(r);fs.writeFileSync(path.join(root,'a.js'),`new ${r.identity.attempt}\n`);
      writeHandoff(handoffs[r.identity.attempt-1],root,['a.js'],r.identity.attempt);
      const result={outcome:'implemented'};
      if(Object.hasOwn(r.payload,'learningInput')){
        result.application=applicationFor(r);
        result.retrospective=createCmAiTaskLearningRetrospective({feature:r.payload.learningInput.feature,
          identity:r.identity,learningDigest:r.payload.learningInput.learningDigest,
          status:'no_new_lesson',candidates:[],reason:null});}
      return terminal(r,result);}},
    reviewers:[{id:'review',provider:'claude',requestedModel:'fixture',allowed:true,available:true,contexts:['r1','r2'],run:r=>{
      writeReview(path.join(reviewsDir,`login-T-001-r${r.identity.attempt}.md`),handoffs[r.identity.attempt-1],r.identity.attempt,twoAttempts&&r.identity.attempt===1?'changes_requested':'approved');
      calls.push(r);return terminal(r,twoAttempts&&r.identity.attempt===1?changeRequest(r):approved(r));}}],
    check:()=>checks,taskCompletion:{reviewsDir,handoffs}};
  const effect=(kind,attempt=1)=>({version:1,id:`${kind}-${attempt}`,identity:{...identity,attempt},kind});
  const create=(mode='create')=>createTaskRunner({...options,persistence:{store,mode,version:2}});
  const reopen=()=>{store.close();store=openTaskExecutionStore({...ownerOptions,create:false});return create('resume');};
  try{return await fn({temp,root,dir,specsRoot,tasksPath,reviewsDir,ownerOptions,options,calls,effect,create,reopen,getStore:()=>store});}
  finally{store.close();fs.rmSync(temp,{recursive:true,force:true});}
}

for(const twoAttempts of [false,true])test(`C3b one-owner composed completion with restart attempt${twoAttempts?2:1}`,()=>composedFixture(async f=>{
  let runner=f.create();const original=f.getStore().snapshot().records[0].payload.baseline;
  for(let a=1;a<=(twoAttempts?2:1);a++){
    await runner.executeEffect(f.effect('develop',a));runner=f.reopen();
    const review=await runner.executeEffect(f.effect('review',a));assert.equal(review.state,a===1&&twoAttempts?'changes_requested':'approved');runner=f.reopen();
  }
  const done=await runner.executeEffect(f.effect('complete',twoAttempts?2:1));assert.equal(done.state,'fixture_completed');
  const saved=f.getStore().snapshot(),records=saved.records;
  assert.deepEqual(records.slice(-4).map(r=>r.payload.type),['effect-intent','task-commit-intent','task-commit-result','effect-checkpoint']);
  assert.equal(done.taskCommit.intentDigest,records.at(-3).digest);assert.equal(done.taskCommit.resultDigest,records.at(-2).digest);
  assert.equal(records.at(-2).payload.commit.intentDigest,records.at(-3).digest);
  assert.equal(records.at(-3).payload.completeIntentDigest,records.at(-4).digest);
  assert.equal(records[0].payload.version,2);assert.deepEqual(records[0].payload.baseline,original);
  assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [x] T-001: fixture\r\n');assert.equal(fs.statSync(f.tasksPath).mode&0o7777,0o640);
  runner=f.reopen();assert.deepEqual(runner.status(),done);assert.deepEqual(await runner.executeEffect(f.effect('complete',twoAttempts?2:1)),done);
  assert.deepEqual(f.getStore().snapshot(),saved);assert.equal(f.calls.length,twoAttempts?4:2);
},{twoAttempts}));

test('F05 develop persists and replays one task-bound Learning input in the existing journal',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity:f.options.identity,
    learningDigest:null,learningFiles:[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}]};
  learningInput.learningDigest=digest({version:1,feature:learningInput.feature,identity:learningInput.identity,
    files:learningInput.learningFiles});
  const effect={...f.effect('develop'),learningInput};
  const runner=f.create();const developed=await runner.executeEffect(effect);

  assert.equal(developed.state,'awaiting_review');
  assert.equal(developed.learningWriteback.outcome,'no_new_lesson');
  const handoff=JSON.parse(fs.readFileSync(f.options.taskCompletion.handoffs[0]));
  assert.equal(handoff.evidence.filter(item=>item.startsWith('cm-learning-application-v1:')).length,1);
  assert.equal(handoff.evidence.filter(item=>item.startsWith('cm-learning-retrospective-v1:')).length,1);
  assert(!handoff.changed_files.includes('AGENTS.md'));
  assert.deepEqual(f.calls[0].payload.learningInput,learningInput);
  const saved=f.getStore().snapshot();
  assert.deepEqual(saved.records.find(record=>record.payload.type==='effect-intent').payload.effect.learningInput,learningInput);
  assert.deepEqual(f.reopen().status(),developed);
  const changed=saved.records.map(record=>({kind:record.kind,payload:structuredClone(record.payload)}));
  const input=changed.find(record=>record.payload.type==='effect-intent').payload.effect.learningInput;
  input.feature='2.profile';input.learningDigest=digest({version:1,feature:input.feature,identity:input.identity,files:input.learningFiles});
  let previousDigest=null;const rehashed=changed.map((record,index)=>{const body={version:1,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`,kind:record.kind,payload:record.payload,previousDigest};
    const next={...body,digest:digest(body)};previousDigest=next.digest;return next;});
  assert.throws(()=>readRunnerHistory(rehashed,rehashed[0].payload.config,2),{code:'identity_mismatch'});
}));

test('F05 runner writes project Learning before checks and includes AGENTS in the review package and replay',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n\n## 项目教训\n';fs.writeFileSync(agents,source,{mode:0o640});
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(source)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Review package missed instructions',
      action:'Write Learning before collecting checks',evidence:['experiments/js-orchestration/task-runner.test.mjs']}],reason:null});
  f.options.taskLearning={feature:'1.login'};let checked=false;
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),'new\n');
    return terminal(request,{outcome:'implemented',application:applicationFor(request,'applied',
      'Handoff 定稿必须早于独立 Review → 在最终 handoff 后生成 Review'),retrospective});};
  f.options.check=()=>{checked=true;assert.match(fs.readFileSync(agents,'utf8'),/cm-learning-v1:/);
    const handoff=JSON.parse(fs.readFileSync(f.options.taskCompletion.handoffs[0]));
    assert(handoff.changed_files.includes('AGENTS.md'));
    assert.equal(handoff.evidence.filter(item=>item.startsWith('cm-learning-application-v1:')).length,1);
    assert.equal(handoff.evidence.filter(item=>item.startsWith('cm-learning-retrospective-v1:')).length,1);
    return checks;};
  const runner=f.create(),developed=await runner.executeEffect({...f.effect('develop'),learningInput});
  assert.equal(checked,true);assert.equal(developed.state,'awaiting_review');
  assert.equal(developed.learningWriteback.outcome,'written');
  assert.deepEqual(developed.receipts,[]);
  const checkpoint=f.getStore().snapshot().records.at(-1).payload.checkpoint;
  assert.equal(checkpoint.learningResult.writeback.writebackDigest,developed.learningWriteback.writebackDigest);
  assert.equal(checkpoint.learningResult.application.status,'applied');
  assert.deepEqual(checkpoint.learningResult.retrospective,retrospective);
  assert.deepEqual(f.calls[0].payload.scope,['a.js']);
  assert.deepEqual(checkpoint.reviewPackage.scope,['AGENTS.md','a.js']);
  assert.deepEqual(checkpoint.reviewPackage.changes.map(change=>change.path),['AGENTS.md','a.js']);
  assert.deepEqual(f.reopen().status(),developed);
}));

test('F05 runner journals writeback_pending and stops before checks or review package',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n';fs.writeFileSync(agents,source);
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(source)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'lesson_candidate',candidates:[{classification:'memory_only',trigger:'Concurrent instruction edit',
      action:'Stop Learning writeback',evidence:['experiments/js-orchestration/task-runner.test.mjs']}],reason:null});
  f.options.taskLearning={feature:'1.login'};let checkCount=0;
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),'new\n');
    fs.writeFileSync(agents,'concurrent\n');return terminal(request,{outcome:'implemented',
      application:applicationFor(request),retrospective});};
  f.options.check=()=>{checkCount++;return checks;};
  const runner=f.create(),blocked=await runner.executeEffect({...f.effect('develop'),learningInput});
  assert.equal(checkCount,0);assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'learning_writeback_pending');
  assert.equal(blocked.packageDigest,null);assert.equal(blocked.learningWriteback.outcome,'writeback_pending');
  const checkpoint=f.getStore().snapshot().records.at(-1).payload.checkpoint;
  assert.equal(checkpoint.learningResult.writeback.reason,'agents_changed');
  assert.deepEqual(f.reopen().status(),blocked);assert.equal(fs.readFileSync(agents,'utf8'),'concurrent\n');
}));

test('F05 mismatched task-start application stops before Learning writeback or checks',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n';fs.writeFileSync(agents,source);
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(source)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'no_new_lesson',candidates:[],reason:null});
  f.options.taskLearning={feature:'1.login'};let checksRun=0;
  f.options.check=()=>{checksRun++;return checks;};
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),'new\n');
    const application=createCmAiTaskLearningApplication({feature:'1.login',identity:f.options.identity,
      learningDigest:'b'.repeat(64),status:'no_relevant_lesson',note:null});
    return terminal(request,{outcome:'implemented',application,retrospective});};
  const handoffBefore=fs.readFileSync(f.options.taskCompletion.handoffs[0]);
  const result=await f.create().executeEffect({...f.effect('develop'),learningInput});
  assert.equal(result.state,'unknown');assert.equal(checksRun,0);assert.equal(fs.readFileSync(agents,'utf8'),source);
  assert.deepEqual(fs.readFileSync(f.options.taskCompletion.handoffs[0]),handoffBefore);
}));

test('F05 no-new result cannot use Learning review scope to smuggle a developer AGENTS edit',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n';fs.writeFileSync(agents,source);
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(source)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  f.options.taskLearning={feature:'1.login'};
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),'new\n');
    fs.writeFileSync(agents,'developer edit\n');const retrospective=createCmAiTaskLearningRetrospective({
      feature:'1.login',identity:f.options.identity,learningDigest,status:'no_new_lesson',candidates:[],reason:null});
    return terminal(request,{outcome:'implemented',application:applicationFor(request),retrospective});};
  const runner=f.create(),result=await runner.executeEffect({...f.effect('develop'),learningInput});
  assert.equal(result.state,'unknown');assert.equal(result.code,'execution_error');assert.equal(result.packageDigest,null);
  assert.deepEqual(f.calls[0].payload.scope,['a.js']);assert.equal(f.reopen().status().state,'unknown');
}));

test('F05 attempt two keeps the first reviewed AGENTS change when the new retrospective has no lesson',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n\n## 项目教训\n';fs.writeFileSync(agents,source);
  const learning=(attempt,current)=>{const taskIdentity={...f.options.identity,attempt};
    const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(current)}];
    const learningDigest=digest({version:1,feature:'1.login',identity:taskIdentity,files:learningFiles});
    return {version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity:taskIdentity,
      learningDigest,learningFiles};};
  const first=learning(1,source);f.options.taskLearning={feature:'1.login'};
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),`new ${request.identity.attempt}\n`);
    const input=request.payload.learningInput,candidate={classification:'structured',trigger:'Attempt one lesson',
      action:'Keep it in cumulative review',evidence:['experiments/js-orchestration/task-runner.test.mjs']};
    const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:request.identity,
      learningDigest:input.learningDigest,status:request.identity.attempt===1?'lesson_candidate':'no_new_lesson',
      candidates:request.identity.attempt===1?[candidate]:[],reason:null});
    return terminal(request,{outcome:'implemented',application:applicationFor(request),retrospective});};
  const runner=f.create(),developed1=await runner.executeEffect({...f.effect('develop',1),learningInput:first});
  assert.equal(developed1.learningWriteback.outcome,'written');
  const reviewed1=await runner.executeEffect(f.effect('review',1));assert.equal(reviewed1.state,'changes_requested');
  const secondSource=fs.readFileSync(agents,'utf8'),second=learning(2,secondSource);
  const developed2=await runner.executeEffect({...f.effect('develop',2),learningInput:second});
  assert.equal(developed2.state,'awaiting_review');assert.equal(developed2.learningWriteback.outcome,'no_new_lesson');
  assert(developed2.packageDigest);
  assert(f.calls.filter(request=>request.role==='developer').every(request=>!request.payload.scope.includes('AGENTS.md')));
  const checkpoint=f.getStore().snapshot().records.at(-1).payload.checkpoint;
  assert(checkpoint.reviewPackage.changes.some(change=>change.path==='AGENTS.md'));
}, {twoAttempts:true}));

test('F05 develop rejects a forged Learning binding before dispatch or journal intent',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const input=(feature,identity,learningFiles)=>{const value={version:1,workflow:'cm-ai',phase:'task_learning_input',
    feature,identity,learningDigest:null,learningFiles};value.learningDigest=digest({version:1,feature,identity,files:learningFiles});return value;};
  const runner=f.create(),before=f.getStore().snapshot();
  const missing=await runner.executeEffect(f.effect('develop'));
  assert.equal(missing.outcome,'rejected');assert.equal(missing.code,'runner_learning');
  for(const [name,learningInput,code] of [
    ['identity',input('1.login',{...f.options.identity,taskId:'T-002'},[]),'identity_mismatch'],
    ['feature',input('2.profile',f.options.identity,[]),'identity_mismatch'],
    ['specs source',input('1.login',f.options.identity,[{scope:'specs',path:'private.env',sha256:'a'.repeat(64)}]),'invalid_input'],
    ['project source',input('1.login',f.options.identity,[{scope:'project',path:'notes.md',sha256:'a'.repeat(64)}]),'invalid_input'],
    ['noncanonical',input('1.login',f.options.identity,[{scope:'project',path:'./AGENTS.md',sha256:'a'.repeat(64)}]),'invalid_input'],
  ]){
    const result=await runner.executeEffect({...f.effect('develop'),learningInput});
    assert.equal(result.outcome,'rejected',name);assert.equal(result.code,code,name);
  }
  assert.equal(f.calls.length,0);assert.deepEqual(f.getStore().snapshot(),before);
}));

test('F05 repeated develop cannot replace the fixed Learning input for the same effect id',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity:f.options.identity,
    learningDigest:null,learningFiles:[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}]};
  learningInput.learningDigest=digest({version:1,feature:learningInput.feature,identity:learningInput.identity,
    files:learningInput.learningFiles});
  const runner=f.create(),effect={...f.effect('develop'),learningInput};
  await runner.executeEffect(effect);const before=f.getStore().snapshot();
  const changed=structuredClone(learningInput);changed.learningFiles[0].sha256='b'.repeat(64);
  changed.learningDigest=digest({version:1,feature:changed.feature,identity:changed.identity,files:changed.learningFiles});

  const result=await runner.executeEffect({...effect,learningInput:changed});
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'intent_conflict');
  assert.equal(f.calls.length,1);assert.deepEqual(f.getStore().snapshot(),before);
}));

test('F05 runner writes handoff evidence from persisted Learning and attachment replay stays idempotent',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  let runner=f.create();await runner.executeEffect({...f.effect('develop'),learningInput});
  const handoff=JSON.parse(fs.readFileSync(f.options.taskCompletion.handoffs[0]));
  const application=applicationFor(f.calls[0]);
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'no_new_lesson',candidates:[],reason:null});

  const live=runner.attachLearningEvidence({handoff,application,retrospective});
  runner=f.reopen();const restored=runner.attachLearningEvidence({handoff,application,retrospective});

  assert.deepEqual(restored,live);assert.equal(handoff.evidence.length,live.evidence.length);
  assert.equal(live.evidence.filter(item=>item.startsWith('cm-learning-application-v1:')).length,1);
  assert.equal(live.evidence.filter(item=>item.startsWith('cm-learning-retrospective-v1:')).length,1);
  assert(Object.isFrozen(live));
}));

test('F05 unsafe handoff replacement stops before checks or review',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  let checksRun=0;f.options.check=()=>{checksRun++;return checks;};
  const runner=f.create(),handoff=f.options.taskCompletion.handoffs[0],retained=`${handoff}.retained`;
  fs.renameSync(handoff,retained);fs.symlinkSync(retained,handoff);
  const result=await runner.executeEffect({...f.effect('develop'),learningInput});
  assert.equal(result.state,'unknown');assert.equal(result.packageDigest,null);assert.equal(checksRun,0);
  assert(fs.lstatSync(handoff).isSymbolicLink());fs.unlinkSync(handoff);fs.renameSync(retained,handoff);
  assert.equal(f.reopen().status().state,'unknown');
}));

test('F05 valid replacement during final handoff validation stops before checks or review',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  let checksRun=0;f.options.check=()=>{checksRun++;return checks;};
  const runner=f.create(),handoff=f.options.taskCompletion.handoffs[0],original=fs.readFileSync(handoff);
  const py=childProcess.spawnSync;let validations=0,replaced=false;
  try{
    childProcess.spawnSync=(command,args,options)=>{const result=py(command,args,options);
      if(command===process.execPath&&args?.[1]==='validate-handoff'&&++validations===2){
        const replacement=`${handoff}.replacement`;fs.writeFileSync(replacement,original);
        fs.renameSync(replacement,handoff);replaced=true;
      }
      return result;};
    const result=await runner.executeEffect({...f.effect('develop'),learningInput});
    assert.equal(result.state,'unknown');assert.equal(result.packageDigest,null);assert.equal(checksRun,0);
    assert.equal(replaced,true);assert.equal(f.reopen().status().state,'unknown');
  }finally{childProcess.spawnSync=py;}
}));

for(const [name,prefix] of [['application','cm-learning-application-v1:'],
  ['retrospective','cm-learning-retrospective-v1:']])
test(`F05 completion rejects a reviewed handoff missing the persisted ${name}`,()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const runner=f.create();await runner.executeEffect({...f.effect('develop'),learningInput});
  const reviewed=await runner.executeEffect(f.effect('review'));assert.equal(reviewed.state,'approved');
  const handoffPath=f.options.taskCompletion.handoffs[0],handoff=JSON.parse(fs.readFileSync(handoffPath));
  handoff.evidence=handoff.evidence.filter(item=>!item.startsWith(prefix));
  fs.writeFileSync(handoffPath,`${JSON.stringify(handoff,null,2)}\n`);writeFixtureReview(f.reviewsDir,handoffPath);
  const before=fs.readFileSync(f.tasksPath),result=await runner.executeEffect(f.effect('complete'));
  assert.equal(result.state,'blocked');assert.equal(result.code,'package_mismatch');
  assert.deepEqual(fs.readFileSync(f.tasksPath),before);
  assert(!f.getStore().snapshot().records.some(record=>record.payload.type==='task-commit-intent'));
}));

for(const [name,removeApplication,expected] of [
  ['matching old handoff',true,'fixture_completed'],['mixed application handoff',false,'blocked'],
])test(`F05 pre-application checkpoint with ${name}`,()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  let runner=f.create();await runner.executeEffect({...f.effect('develop'),learningInput});
  rewriteRunnerState(f,state=>{const checkpoint=state.records.at(-1).payload.checkpoint;
    delete checkpoint.learningResult.application;
    const resultDigest=digest({outcome:'implemented',retrospective:checkpoint.learningResult.retrospective});
    checkpoint.calls[0].resultDigest=resultDigest;checkpoint.cache.at(-1).result.calls[0].resultDigest=resultDigest;});
  const handoffPath=f.options.taskCompletion.handoffs[0],handoff=JSON.parse(fs.readFileSync(handoffPath));
  if(removeApplication)handoff.evidence=handoff.evidence.filter(item=>!item.startsWith('cm-learning-application-v1:'));
  fs.writeFileSync(handoffPath,`${JSON.stringify(handoff,null,2)}\n`);writeFixtureReview(f.reviewsDir,handoffPath);
  runner=f.reopen();assert.equal(runner.status().state,'awaiting_review');
  const reviewed=await runner.executeEffect(f.effect('review'));assert.equal(reviewed.state,'approved');
  const completed=await runner.executeEffect(f.effect('complete'));assert.equal(completed.state,expected);
  if(removeApplication)assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [x] T-001: fixture\r\n');
  else {assert.equal(completed.code,'package_mismatch');assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-001: fixture\r\n');
    assert(!f.getStore().snapshot().records.some(record=>record.payload.type==='task-commit-intent'));}
}));

test('F05 completion rejects written Learning omitted from handoff changed files',()=>composedFixture(async f=>{
  const agents=path.join(f.root,'AGENTS.md'),source='# Rules\n\n## 项目教训\n';fs.writeFileSync(agents,source);
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:sha(source)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Completion evidence drift',
      action:'Bind Learning to the existing completion gate',evidence:['experiments/js-orchestration/task-runner.test.mjs']}],reason:null});
  f.options.taskLearning={feature:'1.login'};
  f.options.developer.run=request=>{f.calls.push(request);fs.writeFileSync(path.join(f.root,'a.js'),'new\n');
    return terminal(request,{outcome:'implemented',application:applicationFor(request),retrospective});};
  const runner=f.create();await runner.executeEffect({...f.effect('develop'),learningInput});
  const reviewed=await runner.executeEffect(f.effect('review'));assert.equal(reviewed.state,'approved');
  const handoffPath=f.options.taskCompletion.handoffs[0],handoff=JSON.parse(fs.readFileSync(handoffPath));
  handoff.changed_files=handoff.changed_files.filter(item=>item!=='AGENTS.md');
  fs.writeFileSync(handoffPath,`${JSON.stringify(handoff,null,2)}\n`);writeFixtureReview(f.reviewsDir,handoffPath);
  const before=fs.readFileSync(f.tasksPath),result=await runner.executeEffect(f.effect('complete'));
  assert.equal(result.state,'blocked');assert.equal(result.code,'package_mismatch');
  assert.deepEqual(fs.readFileSync(f.tasksPath),before);
  assert(!f.getStore().snapshot().records.some(record=>record.payload.type==='task-commit-intent'));
}));

test('F05 runner refuses caller-supplied or jointly forged Learning bindings',()=>composedFixture(async f=>{
  f.options.taskLearning={feature:'1.login'};
  const learningFiles=[{scope:'project',path:'AGENTS.md',sha256:'a'.repeat(64)}];
  const learningDigest=digest({version:1,feature:'1.login',identity:f.options.identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',
    identity:f.options.identity,learningDigest,learningFiles};
  const runner=f.create();await runner.executeEffect({...f.effect('develop'),learningInput});
  const handoff=JSON.parse(fs.readFileSync(f.options.taskCompletion.handoffs[0]));
  const forgedDigest='b'.repeat(64),forged=createCmAiTaskLearningRetrospective({feature:'1.login',
    identity:f.options.identity,learningDigest:forgedDigest,status:'no_new_lesson',candidates:[],reason:null});
  const valid=createCmAiTaskLearningRetrospective({feature:'1.login',identity:f.options.identity,
    learningDigest,status:'no_new_lesson',candidates:[],reason:null});
  const application=applicationFor(f.calls[0]);
  const forgedApplication=createCmAiTaskLearningApplication({feature:'1.login',identity:f.options.identity,
    learningDigest:forgedDigest,status:'no_relevant_lesson',note:null});

  assert.throws(()=>runner.attachLearningEvidence({handoff,application,retrospective:forged}));
  assert.throws(()=>runner.attachLearningEvidence({handoff,application:forgedApplication,retrospective:valid}));
  assert.throws(()=>runner.attachLearningEvidence({handoff,application,retrospective:valid,learningInput:{...learningInput,
    learningDigest:forgedDigest}}));
}));

test('F05 legacy runner does not expose the Learning handoff attachment',()=>composedFixture(async f=>{
  assert(!Object.hasOwn(f.create(),'attachLearningEvidence'));
}));

test('C3b V3 host-authorized receipt enters the existing completion owner once',()=>composedFixture(async f=>{
  let dispatches=0;
  const reviewers=[{id:'review',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['r1','r2'],run:(request,{onEvent})=>{
      writeFixtureReview(f.reviewsDir,f.options.taskCompletion.handoffs[request.identity.attempt-1],{attempt:request.identity.attempt});
      dispatches++;onEvent({event:'thread.started',provider_thread:'actual-review'});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:approved(request)};
    }}];
  const reviewInvocation={developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
    authorize:(request,{authorizationAt})=>{const grant={version:1,kind:'cm-review-dispatch-grant',grantId:'grant-1',
      adapterId:'codex-review-adapter',invocationId:request.invocationId,requestDigest:request.requestDigest,
      identity:request.identity,reviewerId:'review',logicalContextId:request.contextId,
      packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'actual-main',decisionId:'decision-1',
      decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
      return {...grant,grantDigest:digest(grant)};
    }};
  const runner=createTaskRunner({...f.options,reviewers,reviewInvocation,
    persistence:{store:f.getStore(),mode:'create',version:3}});
  await runner.executeEffect(f.effect('develop'));const reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,'approved');assert.equal(reviewed.receipt.execution.channel,'host-authorized');
  const done=await runner.executeEffect(f.effect('complete'));assert.equal(done.state,'fixture_completed');
  assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [x] T-001: fixture\r\n');
  assert.deepEqual(await runner.executeEffect(f.effect('complete')),done);assert.equal(dispatches,1);
}));

test('C3b token resolver rejects unknown tokens before caller callbacks',async()=>{
  const {resolveFixtureCommit}=await import('./task-runner.mjs');assert.equal(typeof resolveFixtureCommit,'function');
  const {commitRunnerFixture}=await import('./task-commit.mjs');assert.equal(typeof commitRunnerFixture,'function');
  let hits=0;const bad=new Proxy({},{get(){hits++;throw Error('caller getter');},ownKeys(){hits++;return [];}});
  for(const token of [undefined,null,{},Object.freeze({}),bad]){
    assert.throws(()=>resolveFixtureCommit(token,bad,bad,bad),{code:'commit_capability_invalid'});
    assert.throws(()=>commitRunnerFixture(token,bad,bad,bad),{code:'commit_capability_invalid'});
  }assert.equal(hits,0);
});

for(const bad of ['commit','no-persistence','version','v1-selection','copied-store','raw-store','reviews-dir','handoff-dir','same-handoff','symlink','hardlink','learning-handoff-name'])
test(`C3b initialization rejects ${bad} without dispatch/write`,()=>composedFixture(async f=>{
  const options={...f.options,persistence:{store:f.getStore(),mode:'create',version:2},taskCompletion:structuredClone(f.options.taskCompletion)};
  if(bad==='commit')options.commit=()=>assert.fail('no generic commit');
  if(bad==='no-persistence')delete options.persistence;
  if(bad==='version')options.persistence.version=1;
  if(bad==='v1-selection')delete options.taskCompletion;
  if(bad==='copied-store')options.persistence.store={...f.getStore()};
  if(bad==='raw-store')options.persistence.store={snapshot:()=>assert.fail('not genuine'),append:()=>assert.fail('not genuine')};
  if(bad==='reviews-dir')options.taskCompletion.reviewsDir=f.root;
  if(bad==='handoff-dir')options.taskCompletion.handoffs[1]=path.join(f.root,'handoff.json');
  if(bad==='same-handoff')options.taskCompletion.handoffs[1]=options.taskCompletion.handoffs[0];
  if(bad==='symlink')fs.symlinkSync(options.taskCompletion.handoffs[0],options.taskCompletion.handoffs[1]);
  if(bad==='hardlink')fs.linkSync(options.taskCompletion.handoffs[0],options.taskCompletion.handoffs[1]);
  if(bad==='learning-handoff-name'){
    options.taskLearning={feature:'1.login'};
    const wrong=path.join(options.taskCompletion.reviewsDir,'profile-T-001-a1-handoff.json');
    fs.copyFileSync(options.taskCompletion.handoffs[0],wrong);options.taskCompletion.handoffs[0]=wrong;
  }
  assert.throws(()=>createTaskRunner(options));assert.equal(f.calls.length,0);
  assert.equal(f.getStore().snapshot().records.length,0);assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);
}));

test('C3b resume pins metadata and refuses nonempty create/default V1 adoption',()=>composedFixture(async f=>{
  f.create();const before=f.getStore().snapshot();assert.throws(()=>f.create(),{code:'runner_exists'});
  const options={...f.options,persistence:{store:f.getStore(),mode:'resume',version:2},taskCompletion:structuredClone(f.options.taskCompletion)};
  options.taskCompletion.handoffs[1]=path.join(f.reviewsDir,'other.json');assert.throws(()=>createTaskRunner(options));
  const {taskCompletion,...old}=f.options;
  assert.throws(()=>createTaskRunner({...old,commit:()=>{},persistence:{store:f.getStore(),mode:'resume'}}),{code:'runner_version'});
  assert.deepEqual(f.getStore().snapshot(),before);assert.equal(f.calls.length,0);
}));

for(const provider of ['codex','claude'])test(`C3b ${provider}-only remains independently reviewed`,()=>composedFixture(async f=>{
  f.options.developer.provider=provider;f.options.reviewers[0].provider=provider;
  const done=await f.create().run();assert.equal(done.state,'fixture_completed');assert.equal(done.receipt.route.mode,'same-provider');
  assert.notEqual(done.receipt.execution.contextId,f.options.developer.contextId);
}));
test('C3b absent review never marks fixture complete',()=>composedFixture(async f=>{
  f.options.reviewers=[];assert.equal((await f.create().run()).state,'pending_review');
  assert.equal(f.calls.length,0);assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);
}));

test('C3b delivered cancellation during fresh checks prevents native writes',()=>composedFixture(async f=>{
  let entered,release,checkCount=0;const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  f.options.check=()=>++checkCount===2?(entered(),waiting):checks;
  const runner=f.create();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const pending=runner.executeEffect(f.effect('complete'));await started;runner.cancel();release(checks);
  const end=await pending;assert.equal(end.state,'cancelled');assert.equal(end.taskCommit,null);
  assert(!f.getStore().snapshot().records.some(r=>r.payload.type.startsWith('task-commit-')));
  assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);assert.deepEqual(f.reopen().status(),end);
}));

for(const kind of ['task-commit-intent','task-commit-result','effect-checkpoint'])
test(`C3b failed ${kind} storage never emits success or retries`,()=>composedFixture(async f=>{
  const runner=f.create();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const rename=fs.renameSync;let hit=false;
  try{fs.renameSync=(a,b)=>{
    if(String(b).endsWith('/state.json')&&JSON.parse(fs.readFileSync(a)).records.at(-1).payload.type===kind){hit=true;throw Object.assign(Error('fixture storage fault'),{code:'EIO'});}
    return rename(a,b);};
    const end=await runner.executeEffect(f.effect('complete'));assert(hit);assert.equal(end.code,'store_failure');assert.equal(end.state,'unknown');
    assert.equal((await runner.executeEffect(f.effect('complete'))).code,'store_failure');
    assert.equal(fs.readFileSync(f.tasksPath,'utf8').includes('[x]'),kind!=='task-commit-intent');
  }finally{fs.renameSync=rename;}
  const resumed=f.reopen(),before=f.getStore().snapshot();assert.equal(resumed.status().state,'unknown');
  assert.equal(resumed.status().code,'reconciliation_required');await resumed.run();assert.deepEqual(f.getStore().snapshot(),before);
}));

test('C3b post-commit unknown survives workflow error without new effect authority',()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));
  const rename=fs.renameSync;
  try{fs.renameSync=(a,b)=>{if(b===f.tasksPath)throw Error('fixture rename fault');return rename(a,b);};
    assert.equal((await r.executeEffect(f.effect('complete'))).state,'unknown');
  }finally{fs.renameSync=rename;}
  const before=r.status();await r.run(()=>{throw Error('workflow');});const after=r.status();
  assert.equal(after.state,'unknown');assert.equal(after.code,before.code);assert.deepEqual(after.taskCommit,before.taskCommit);
  assert.equal(after.workflowError,'workflow_error');assert.deepEqual(f.reopen().status(),after);
}));

for(const point of ['prepare','verify','rename','result-gap'])test(`C3b late cancel at ${point} shares cursor and preserves cached history`,()=>composedFixture(async f=>{
  const r=f.create();const developed=await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));
  const rename=fs.renameSync;let hit=false;
  const cancel=()=>{hit=true;const s=r.cancel();assert.equal(s.cancellationRequested,true);};
  try{
    gateAfter.prepare=()=>{if(point==='prepare')cancel();};
    gateAfter.verify=()=>{if(point==='verify')cancel();};
    fs.renameSync=(a,b)=>{const result=rename(a,b);if(point==='rename'&&b===f.tasksPath)cancel();
      if(point==='result-gap'&&String(b).endsWith('/state.json')){
        const last=JSON.parse(fs.readFileSync(b)).records.at(-1);if(last.payload.type==='task-commit-result')queueMicrotask(cancel);
      }return result;};
    const done=await r.executeEffect(f.effect('complete'));assert(hit);assert.equal(done.state,'fixture_completed');assert.equal(done.cancelAfterCommit,true);
    assert.deepEqual(await r.executeEffect(f.effect('develop')),developed);assert.equal(developed.cancellationRequested,false);
    assert.deepEqual(f.reopen().status(),done);
  }finally{delete gateAfter.prepare;delete gateAfter.verify;fs.renameSync=rename;}
}));

for(const changed of ['source','evidence','tasks','temp'])test(`C3b native ${changed} change preserves exact unknown checkpoint`,()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));
  let hit=false;
  try{gateAfter.verify=()=>{hit=true;
      const file=changed==='source'?path.join(f.root,'a.js'):changed==='evidence'?f.options.taskCompletion.handoffs[0]:
        changed==='tasks'?f.tasksPath:path.join(f.dir,fs.readdirSync(f.dir).find(n=>n.startsWith('.cm-task.')));
      fs.appendFileSync(file,'changed\n');};
    const end=await r.executeEffect(f.effect('complete'));assert(hit);assert.equal(end.state,'unknown');assert.equal(end.code,'commit_unknown');
    assert(end.taskCommit.intentDigest);assert.equal(end.taskCommit.resultDigest,null);assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);
    assert.deepEqual(f.reopen().status(),end);
  }finally{delete gateAfter.verify;}
}));

test('C3b foreign revision during native verification poisons instead of adopting newest cursor',()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));
  let before,hit=false;
  try{gateAfter.verify=()=>{hit=true;
    const store=f.getStore();store.append({id:'foreign',kind:'cancel',payload:{},expectedRevision:store.snapshot().revision});before=store.snapshot();};
    const end=await r.executeEffect(f.effect('complete'));assert(hit);assert.equal(end.code,'store_failure');assert.equal(end.state,'unknown');
    assert.deepEqual(f.getStore().snapshot(),before);assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);
    assert.equal((await r.executeEffect(f.effect('complete'))).code,'store_failure');
  }finally{delete gateAfter.verify;}
}));

for(const phase of ['guard','append','readback'])test(`C3b caught reentry at ${phase} latches poison and refuses publication`,()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));
  const read=fs.readFileSync,rename=fs.renameSync;let armed=false,hit=false,before,intentInstalled=false;
  const reenter=()=>{if(!armed||hit)return;hit=true;const s=r.cancel();assert.equal(s.code,'store_failure');};
  try{
    gateAfter.prepare=()=>{before=f.getStore().snapshot();armed=true;};
    fs.readFileSync=(p,...rest)=>{const result=read(p,...rest);
      if(phase==='guard'&&String(p).endsWith('/.cm-task-owner.json'))reenter();
      if(phase==='readback'&&intentInstalled)reenter();return result;};
    fs.renameSync=(a,b)=>{if(phase==='append'&&String(b).endsWith('/state.json'))reenter();const result=rename(a,b);
      if(String(b).endsWith('/state.json')&&JSON.parse(read(b)).records.at(-1).payload.type==='task-commit-intent')intentInstalled=true;return result;};
    const end=await r.executeEffect(f.effect('complete'));assert(hit);assert.equal(end.state,'unknown');assert.equal(end.code,'store_failure');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);assert.equal((await r.executeEffect(f.effect('complete'))).code,'store_failure');
    const saved=f.getStore().snapshot();assert.equal(saved.records.length,before.records.length+(phase==='guard'?0:1));
    assert(!saved.records.some(x=>x.payload.type==='control'));assert.equal(end.cancellationRequested,false);
  }finally{delete gateAfter.prepare;fs.readFileSync=read;fs.renameSync=rename;}
}));

for(const mode of ['success','native-failure'])test(`C3b private capability lifetime ${mode} delegates to real native writer`,()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));f.getStore().close();
  const runnerURL=new URL('../../runtime/js/cm-ai/task-runner.mjs',import.meta.url).href;
  const writerURL=new URL('../../runtime/js/cm-ai/task-commit.mjs',import.meta.url).href;
  const wrapper=`import assert from 'node:assert/strict';
    import {commitRunnerFixture as native} from ${JSON.stringify(writerURL)};
    import {resolveFixtureCommit as resolve} from ${JSON.stringify(runnerURL)};
    export function commitRunnerFixture(token,store,input,signal){
      globalThis.captured={token,store};let hits=0;
      const hostile=new Proxy({},{get(){hits++;throw Error('callback');}});
      assert.throws(()=>resolve(token,hostile,hostile,hostile),{code:'commit_capability_invalid'});
      assert.throws(()=>resolve(new Proxy(token,{}),store,hostile,hostile),{code:'commit_capability_invalid'});
      assert.equal(hits,0);const first=resolve(token,store,'guard');
      assert.deepEqual(Object.keys(first).sort(),['owner','identity','fingerprints','inputDigest','phase','intentDigest','planDigest','resultDigest'].sort());
      assert.equal(first.phase,'prepared');assert.equal(first.intentDigest,null);assert.equal(first.planDigest,null);assert.equal(first.resultDigest,null);
      assert(Object.isFrozen(first)&&Object.isFrozen(first.owner)&&Object.isFrozen(first.identity));assert.deepEqual(first.identity,input.identity);
      for(const invoke of [()=>resolve(token,store,'guard',undefined),()=>resolve(token,store,'append-intent'),
        ()=>resolve(token,store,'other'),()=>resolve(token,store,'append-result',{}),()=>resolve(token,store,'append-intent',{},null)])
        assert.throws(invoke,{code:'commit_phase_invalid'});
      assert.throws(()=>resolve(token,store,'append-intent',{}));assert.equal(resolve(token,store,'guard').phase,'prepared');
      assert.throws(()=>native(token,store,{...input,root:'/wrong'},signal),{code:'commit_input_mismatch'});
      queueMicrotask(()=>{assert.throws(()=>resolve(token,store,'guard'),{code:'commit_capability_invalid'});globalThis.revoked=true;});
      try{const result=native(token,store,input,signal);const last=resolve(token,store,'guard');
        assert.equal(last.phase,'result');assert.equal(last.intentDigest,result.intentDigest);assert(last.resultDigest);
        assert.throws(()=>resolve(token,store,'append-intent',{}),{code:'commit_phase_invalid'});
        assert.throws(()=>resolve(token,store,'append-result',{}),{code:'commit_phase_invalid'});return result;
      }catch(e){assert.equal(resolve(token,store,'guard').phase,'intent');throw e;}
    }`;
  const source=`import assert from 'node:assert/strict';import fs from 'node:fs';
    import {registerHooks} from 'node:module';
    import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
    const runnerURL=${JSON.stringify(runnerURL)},wrapper=${JSON.stringify('data:text/javascript,'+encodeURIComponent(wrapper))};
    registerHooks({resolve(specifier,context,next){if(context.parentURL===runnerURL&&specifier==='./task-commit.mjs')return {url:wrapper,shortCircuit:true};return next(specifier,context);}});
    const gateAfter=await (${installGateHooks.toString()})(${JSON.stringify(writerURL)},${JSON.stringify(new URL('../../scripts/cm-task-gate.mjs',import.meta.url).href)});
    const {createTaskRunner,resolveFixtureCommit}=await import(runnerURL),[rawOptions,rawOwner,mode]=process.argv.slice(1);
    const options=JSON.parse(rawOptions),store=openTaskExecutionStore({...JSON.parse(rawOwner),create:false});
    options.developer.run=()=>assert.fail('no redispatch');options.reviewers.forEach(r=>r.run=()=>assert.fail('no redispatch'));
    options.check=()=>${JSON.stringify(checks)};options.persistence={store,mode:'resume',version:2};
    let hit=false;gateAfter.verify=()=>{hit=true;
      if(mode==='native-failure')fs.appendFileSync(options.taskCompletion.handoffs[0],'changed');};
    const runner=createTaskRunner(options),end=await runner.executeEffect({version:1,id:'complete-1',identity:options.identity,kind:'complete'});
    assert(hit);assert.equal(end.state,mode==='success'?'fixture_completed':'unknown');assert(globalThis.revoked);
    const {token}=globalThis.captured;assert.throws(()=>resolveFixtureCommit(token,store,'guard'),{code:'commit_capability_invalid'});
    assert(!Object.values(runner).includes(token));store.close();console.log('capability verified');`;
  const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',source,JSON.stringify(f.options),JSON.stringify(f.ownerOptions),mode],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.match(child.stdout,/capability verified/);
}));

for(const first of ['task-runner','task-commit'])test(`C3b uninstrumented import order ${first} first`,()=>{
  const other=first==='task-runner'?'task-commit':'task-runner';
  const source=`await import(${JSON.stringify(new URL('./'+first+'.mjs',import.meta.url).href)});
    await import(${JSON.stringify(new URL('./'+other+'.mjs',import.meta.url).href)});console.log('imports verified');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/imports verified/);
});

for(const point of ['outer-intent','nested-intent','nested-result','before-checkpoint','after-checkpoint'])
test(`C3b actual SIGKILL ${point} never replays incomplete completion`,()=>composedFixture(async f=>{
  const r=f.create();await r.executeEffect(f.effect('develop'));await r.executeEffect(f.effect('review'));f.getStore().close();
  const source=`import fs from 'node:fs';import assert from 'node:assert/strict';
    import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
    import {createTaskRunner} from ${JSON.stringify(new URL('./task-runner.mjs',import.meta.url).href)};
    const [rawOptions,rawOwner,point]=process.argv.slice(1),options=JSON.parse(rawOptions),store=openTaskExecutionStore({...JSON.parse(rawOwner),create:false});
    options.developer.run=()=>assert.fail('no redispatch');options.reviewers.forEach(r=>r.run=()=>assert.fail('no redispatch'));
    options.check=()=>${JSON.stringify(checks)};options.persistence={store,mode:'resume',version:2};
    const runner=createTaskRunner(options),rename=fs.renameSync;
    const pause=()=>{fs.writeSync(1,'PAUSED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    fs.renameSync=(a,b)=>{if(String(b).endsWith('/state.json')){
      const type=JSON.parse(fs.readFileSync(a)).records.at(-1).payload.type;
      if(point==='before-checkpoint'&&type==='effect-checkpoint')pause();
      const result=rename(a,b);
      if(point==='outer-intent'&&type==='effect-intent'||point==='nested-intent'&&type==='task-commit-intent'
        ||point==='nested-result'&&type==='task-commit-result'||point==='after-checkpoint'&&type==='effect-checkpoint')pause();return result;
    }return rename(a,b);};
    await runner.executeEffect({version:1,id:'complete-1',identity:options.identity,kind:'complete'});throw Error('missed pause');`;
  const child=spawn(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',source,JSON.stringify(f.options),JSON.stringify(f.ownerOptions),point],{stdio:['ignore','pipe','pipe']});
  const done=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let errors='',timer;
  child.stderr.on('data',b=>errors+=b);
  try{
    await new Promise((resolve,reject)=>{let output='';timer=setTimeout(()=>reject(Error('child deadline '+errors)),10000);
      child.stdout.on('data',b=>{output+=b;if(output.includes('PAUSED'))resolve();});
      child.once('close',code=>reject(Error('child exited '+code+' '+errors)));child.once('error',reject);});
    child.kill('SIGKILL');assert.equal((await done).signal,'SIGKILL');
    const resumed=f.reopen(),saved=f.getStore().snapshot(),end=resumed.status();
    assert.equal(end.state,point==='after-checkpoint'?'fixture_completed':'unknown');
    if(point!=='after-checkpoint')assert.equal(end.code,'reconciliation_required');
    const after=['nested-result','before-checkpoint','after-checkpoint'].includes(point);
    assert.equal(fs.readFileSync(f.tasksPath,'utf8').includes('[x]'),after);
    assert.equal(!!end.taskCommit?.resultDigest,after);const calls=f.calls.length;
    await resumed.run();await resumed.executeEffect(f.effect('complete'));assert.equal(f.calls.length,calls);
    assert.deepEqual(f.getStore().snapshot(),saved);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;}
}));

const identity={repositoryId:'fixture',runId:'s2b-run',taskId:'feature.T-1',attempt:1};
const checks=[{id:'unit',command:['node','test.mjs'],outcome:'passed',exitCode:0,evidence:'synthetic pass'}];
async function durableFixture(fn,alter=()=>{}) {
  const specs=fs.mkdtempSync(path.join(os.tmpdir(),'cm-durable-specs-'));
  const tasksPath=path.join(specs,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-1: fixture\n');
  const storeOptions={tasksPath,feature:'feature',specsRoot:specs,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('test-v1'),config:digest('fixture'),inputs:digest('original')},create:true};
  let store;
  try {return await fixture(async f=>{
    store=openTaskExecutionStore(storeOptions);
    const create=()=>createTaskRunner({...f.options,persistence:{store,mode:'create'}});
    const resume=()=>{store.close();store=openTaskExecutionStore({...storeOptions,create:false});
      return createTaskRunner({...f.options,persistence:{store,mode:'resume'}});};
    return fn({...f,create,resume,getStore:()=>store,specs});
  },alter);}finally{store?.close();fs.rmSync(specs,{recursive:true,force:true});}
}

test('S3b2b persists init session and resumes without recapturing a changed baseline',()=>durableFixture(async f=>{
  const r=f.create(),init=f.getStore().snapshot().records[0].payload;
  assert.match(init.session,/^[a-f0-9-]{36}$/);
  const resumed=f.resume();assert.equal(resumed.status().state,'ready');
  assert.equal(f.getStore().snapshot().records[0].payload.session,init.session);
  await resumed.executeEffect(intent('develop'));
  const again=f.resume();assert.equal(again.status().state,'awaiting_review');
  assert.equal(again.status().calls[0].invocationId,init.session+'.1');
  assert.equal(f.calls.length,1);assert.equal(r.status().state,'ready');
}));

test('S3b2b restores approved receipt and completed cache without repeat effects',()=>durableFixture(async f=>{
  let r=f.create();const dev=await r.executeEffect(intent('develop'));
  await r.executeEffect(intent('review'));r=f.resume();
  assert.equal(r.status().state,'approved');assert.deepEqual(await r.executeEffect(intent('develop')),dev);
  const done=await r.executeEffect(intent('complete'));r=f.resume();
  assert.deepEqual(r.status(),done);assert.deepEqual(await r.executeEffect(intent('complete')),done);
  assert.equal(f.calls.length,2);assert.equal(f.marker.length,1);
}));

test('S3b2b workflow error after review cannot restore approval',()=>durableFixture(async f=>{
  const r=f.create();await r.run(async ctx=>{await ctx.executeEffect(intent('develop'));
    await ctx.executeEffect(intent('review'));throw Error('workflow failed');});
  const restored=f.resume();assert.equal(restored.status().state,'blocked');
  assert.equal(restored.status().workflowError,'workflow_error');
  assert.equal((await restored.executeEffect(intent('complete'))).outcome,'rejected');assert.equal(f.marker.length,0);
}));

test('S3b2b resumes the second attempt and keeps original before bytes and findings',()=>durableFixture(async f=>{
  let r=f.create();await r.executeEffect(intent('develop'));await r.executeEffect(intent('review'));
  r=f.resume();assert.equal(r.status().state,'changes_requested');assert.equal(r.status().identity.attempt,2);
  await r.executeEffect(intent('develop',2));r=f.resume();
  await r.executeEffect(intent('review',2));await r.executeEffect(intent('complete',2));
  const pkg=f.getStore().snapshot().records.at(-1).payload.checkpoint.reviewPackage;
  assert.equal(Buffer.from(pkg.changes[0].before.contentBase64,'base64').toString(),'initial dirty\n');
  assert.equal(f.calls.find(c=>c.identity.attempt===2).payload.priorReview.verdict,'changes_requested');
  assert.equal(f.resume().status().state,'fixture_completed');assert.equal(f.marker.length,1);
},o=>{o.reviewers[0].run=r=>terminal(r,r.identity.attempt===1?changeRequest(r):approved(r));}));

for(const terminalState of ['developer-failed','package-failed'])test(`S3b2b attempt two ${terminalState} retains terminal history`,()=>durableFixture(async f=>{
  let r=f.create();await r.executeEffect(intent('develop'));await r.executeEffect(intent('review'));
  const old=r.status().packageDigest;r=f.resume();const end=await r.executeEffect(intent('develop',2));
  assert.equal(end.state,terminalState==='developer-failed'?'blocked':'unknown');
  assert.equal(end.packageDigest,old);assert.deepEqual(f.resume().status(),end);assert.equal(f.marker.length,0);
},(o,{root,calls})=>{
  o.reviewers[0].run=r=>terminal(r,changeRequest(r));const run=o.developer.run;
  o.developer.run=r=>{if(r.identity.attempt===1)return run(r);calls.push(r);
    if(terminalState==='developer-failed')return terminal(r,null,{status:'failed'});
    fs.writeFileSync(path.join(root,'out-of-scope'),'changed');return terminal(r,{outcome:'implemented'});};
}));

for(const reason of ['same','cross','not_authorized','unavailable','auth_required','permission_denied'])
test(`S3b2b independently reconstructs ${reason} route`,()=>durableFixture(async f=>{
  let r=f.create();await r.executeEffect(intent('develop'));await r.executeEffect(intent('review'));r=f.resume();
  assert.equal(r.status().state,'approved');assert.equal(r.status().receipt.route.mode,reason==='same'?'same-provider':'cross-provider');
  assert.equal((await r.executeEffect(intent('complete'))).state,'fixture_completed');
},o=>{
  if(reason==='cross')o.reviewers[0].provider='claude';
  if(['same','cross'].includes(reason))return;
  o.reviewers.push({...o.reviewers[0],id:'second',provider:'claude',contexts:['second-a1','second-a2']});
  if(reason==='not_authorized')o.reviewers[0].allowed=false;
  else if(reason==='unavailable')o.reviewers[0].available=false;
  else o.reviewers[0].run=r=>terminal(r,null,{status:reason,accepted:false});
}));

test('S3b2b failed checks can retain approved review but never complete',()=>durableFixture(async f=>{
  let r=f.create();await r.executeEffect(intent('develop'));await r.executeEffect(intent('review'));r=f.resume();
  assert.equal(r.status().state,'approved');const end=await r.executeEffect(intent('complete'));
  assert.equal(end.state,'blocked');assert.equal(end.code,'checks_not_passed');assert.deepEqual(f.resume().status(),end);
},o=>{o.check=()=>[{...checks[0],outcome:'failed',exitCode:1}];}));

for(const phase of ['idle','developer','reviewer','checks','complete-checks'])test(`S3b2b durable cancellation at ${phase}`,()=>durableFixture(async f=>{
  let unblock;const waiting=new Promise(r=>{unblock=r;});let entered;
  const started=new Promise(r=>{entered=r;});
  if(phase==='developer')f.options.developer.run=()=>{entered();return waiting;};
  if(phase==='checks')f.options.check=()=>{entered();return waiting;};
  if(phase==='reviewer')f.options.reviewers[0].run=()=>{entered();return waiting;};
  const r=f.create();
  if(['reviewer','complete-checks'].includes(phase))await r.executeEffect(intent('develop'));
  if(phase==='complete-checks'){
    await r.executeEffect(intent('review'));f.options.check=()=>{entered();return waiting;};
    // Functions are host-owned, so use a new runner for the same frozen metadata.
  }
  const target=phase==='complete-checks'?f.resume():r;
  if(phase==='idle'){target.cancel();assert.equal(f.resume().status().state,'cancelled');return;}
  const pending=target.executeEffect(intent(phase==='reviewer'?'review':phase==='complete-checks'?'complete':'develop'));
  await started;target.cancel();const end=await pending;unblock(null);
  assert.equal(end.state,'cancelled');assert.deepEqual(f.resume().status(),end);assert.equal(f.marker.length,0);
}));

test('S3b2b durable late cancel and workflow error preserve completed fact',()=>durableFixture(async f=>{
  let r;f.options.commit=()=>{r.cancel();return {outcome:'fixture_completed'};};r=f.create();
  const end=await r.run(async ctx=>{for(const k of ['develop','review','complete'])await ctx.executeEffect(intent(k));throw Error('after commit');});
  assert.equal(end.state,'fixture_completed');assert.equal(end.cancelAfterCommit,true);assert.equal(end.workflowError,'workflow_error');
  assert.deepEqual(f.resume().status(),end);
}));

test('S3b2b outstanding workflow error persists before cancellation/checkpoint',()=>durableFixture(async f=>{
  f.options.developer.run=()=>new Promise(()=>{});const r=f.create();
  const end=await r.run(ctx=>{void ctx.executeEffect(intent('develop'));throw Error('bad workflow');});
  assert.equal(end.state,'cancelled');assert.equal(end.workflowError,'workflow_error');assert.deepEqual(f.resume().status(),end);
  assert.deepEqual(f.getStore().snapshot().records.filter(r=>r.kind==='cancel').map(r=>r.payload.event),['workflow-error','cancel']);
}));

test('S3b2b publication waits for checkpoint; late callback cannot leak approved',()=>durableFixture(async f=>{
  const actual=f.getStore();let runner,observed;
  const store={snapshot:()=>actual.snapshot(),append:r=>{
    if(r.payload.type==='effect-checkpoint' && r.payload.checkpoint.state==='approved')observed=runner.status().state;
    return actual.append(r);
  }};
  runner=createTaskRunner({...f.options,persistence:{store,mode:'create'}});
  await runner.executeEffect(intent('develop'));await runner.executeEffect(intent('review'));
  assert.equal(observed,'awaiting_review');assert.equal(runner.status().state,'approved');
}));

for(const when of ['intent','checkpoint','control'])test(`S3b2b ${when} store failure poisons the live runner`,()=>durableFixture(async f=>{
  const actual=f.getStore();let armed=false,hits=0;
  const store={snapshot:()=>actual.snapshot(),append:r=>{
    if(armed && r.payload.type==={intent:'effect-intent',checkpoint:'effect-checkpoint',control:'control'}[when]){hits++;throw Error('injected');}
    return actual.append(r);
  }};
  const runner=createTaskRunner({...f.options,persistence:{store,mode:'create'}});armed=true;
  const result=when==='control'?runner.cancel():await runner.executeEffect(intent('develop'));
  assert.equal(hits,1);assert.equal(result.state,'unknown');assert.equal(result.code,'store_failure');
  assert.equal((await runner.executeEffect(intent('develop'))).code,'store_failure');
  assert.equal(f.calls.length,when==='checkpoint'?1:0);assert.equal(f.marker.length,0);
}));

for(const phase of ['before-dispatch','after-dispatch','after-cancel','after-develop-checkpoint','after-commit','after-commit-checkpoint'])
test(`S3b2b real SIGKILL ${phase} preserves effect namespace and never redispatches unknown`,()=>durableFixture(async f=>{
  f.getStore().close();
  const script=`import fs from 'node:fs';import path from 'node:path';
    import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
    import {createTaskRunner} from ${JSON.stringify(new URL('./task-runner.mjs',import.meta.url).href)};
    const [root,specs,phase]=process.argv.slice(1),identity=${JSON.stringify(identity)};
    const actual=openTaskExecutionStore({tasksPath:path.join(specs,'tasks.md'),feature:'feature',specsRoot:specs,
      identity:{repositoryId:identity.repositoryId,runId:identity.runId},fingerprints:${JSON.stringify({workflow:digest('test-v1'),config:digest('fixture'),inputs:digest('original')})},create:false});
    const pause=()=>{fs.writeSync(1,'PAUSED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    const store={snapshot:()=>actual.snapshot(),append:r=>{const value=actual.append(r);
      if(phase==='before-dispatch' && r.payload.type==='effect-intent')pause();
      if(phase==='after-cancel' && r.payload.type==='control' && r.payload.event==='cancel')pause();
      if(r.payload.type==='effect-checkpoint' && (phase==='after-develop-checkpoint' && r.payload.checkpoint.state==='awaiting_review'
        ||phase==='after-commit-checkpoint' && r.payload.checkpoint.state==='fixture_completed'))pause();return value;}};
    const terminal=(r,result)=>({version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,effectiveModel:'unknown',status:'succeeded',accepted:true,result});
    const runner=createTaskRunner({root,identity,scope:['a.js','new.js'],requirements:['requirements.md'],excludedContexts:['main','planner'],timeoutMs:1000,
      developer:{provider:'codex',requestedModel:'fixture-model',contextId:'developer',run:r=>{
        fs.appendFileSync(path.join(specs,'dispatches'),r.invocationId+'\\n');fs.writeFileSync(path.join(root,'a.js'),'implementation 1\\n');
        if(phase==='after-dispatch')pause();if(phase==='after-cancel')runner.cancel();return terminal(r,{outcome:'implemented'});}},
      reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture-model',allowed:true,available:true,contexts:['review-a1','review-a2'],
        run:r=>terminal(r,{verdict:'approved',packageDigest:r.payload.reviewPackage.packageDigest,examinedPaths:['a.js','requirements.md'],findings:[],summary:'synthetic independent examination'})}],
      check:()=>${JSON.stringify(checks)},commit:()=>{fs.appendFileSync(path.join(specs,'commits'),'committed\\n');if(phase==='after-commit')pause();return {outcome:'fixture_completed'};},persistence:{store,mode:'create'}});
    await runner.run();actual.close();`;
  const child=spawn(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',script,f.root,f.specs,phase],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>{stderr+=d;});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  let timer;
  try {
    await new Promise((resolve,reject)=>{let output='';timer=setTimeout(()=>reject(Error('child pause timeout '+stderr)),10000);
      child.stdout.on('data',d=>{output+=d;if(output.includes('PAUSED'))resolve();});
      child.once('exit',code=>reject(Error('child exited before pause '+code+' '+stderr)));});
    child.kill('SIGKILL');assert.equal((await closed).signal,'SIGKILL');
    const resumed=f.resume(),session=f.getStore().snapshot().records[0].payload.session;
    if(['before-dispatch','after-dispatch','after-cancel','after-commit'].includes(phase)) {
      assert.equal(resumed.status().state,'unknown');assert.equal(resumed.status().code,'reconciliation_required');
      assert.equal(resumed.status().cancellationRequested,phase==='after-cancel');
      await resumed.run();assert.equal(f.calls.length,0);assert.equal(f.marker.length,0);
    } else if(phase==='after-develop-checkpoint') {
      assert.equal(resumed.status().state,'awaiting_review');await resumed.run();
      assert.equal(f.calls.length,1);assert.equal(f.calls[0].role,'reviewer');assert.equal(f.calls[0].invocationId,session+'.2');
    } else {assert.equal(resumed.status().state,'fixture_completed');await resumed.run();assert.equal(f.calls.length,0);assert.equal(f.marker.length,0);}
    if(fs.existsSync(path.join(f.specs,'dispatches')))assert.equal(fs.readFileSync(path.join(f.specs,'dispatches'),'utf8'),session+'.1\n');
    if(phase.includes('commit'))assert.equal(fs.readFileSync(path.join(f.specs,'commits'),'utf8'),'committed\n');
  }finally{clearTimeout(timer);if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await closed;}
}));

for(const phase of ['init','checkpoint'])test(`S3b2b ${phase} over one MiB refuses without truncating`,()=>durableFixture(async f=>{
  if(phase==='init'){
    fs.writeFileSync(path.join(f.root,'requirements.md'),'x'.repeat(850000));
    assert.throws(()=>f.create(),{code:'limit_exceeded'});assert.equal(f.calls.length,0);assert.equal(f.getStore().snapshot().records.length,0);
  } else {
    f.options.developer.run=r=>{f.calls.push(r);fs.writeFileSync(path.join(f.root,'a.js'),'x'.repeat(850000));return terminal(r,{outcome:'implemented'});};
    const r=f.create();assert.equal((await r.executeEffect(intent('develop'))).code,'store_failure');
    assert.equal(f.getStore().snapshot().records.at(-1).payload.type,'effect-intent');assert.equal(f.calls.length,1);
    assert.equal((await r.executeEffect(intent('review'))).code,'store_failure');assert.equal(f.marker.length,0);
  }
}));

for(const operation of ['writeFileSync','renameSync','fsyncSync'])for(const stage of ['intent','checkpoint'])
test(`S3b2b real ${operation} fault at ${stage} blocks subsequent effects`,()=>durableFixture(async f=>{
  const actual=f.getStore();let armed=false,hits=0,runner;
  const saved=fs[operation];
  const store={snapshot:()=>actual.snapshot(),append:r=>{
    if(r.payload.type===(stage==='intent'?'effect-intent':'effect-checkpoint'))armed=true;
    return actual.append(r);
  }};
  runner=createTaskRunner({...f.options,persistence:{store,mode:'create'}});
  fs[operation]=function(...args){
    const applies=operation==='writeFileSync'?typeof args[0]==='number':
      operation==='renameSync'?String(args[1]).endsWith('/state.json'):fs.fstatSync(args[0]).isDirectory();
    if(armed && applies){hits++;throw Object.assign(Error('injected storage fault'),{code:'EIO'});}
    return Reflect.apply(saved,fs,args);
  };
  let result;
  try{result=await runner.executeEffect(intent('develop'));}finally{fs[operation]=saved;}
  assert.equal(hits,1);assert.equal(result.state,'unknown');assert.equal(result.code,'store_failure');
  assert.equal(f.calls.length,stage==='intent'?0:1);assert.equal((await runner.executeEffect(intent('review'))).code,'store_failure');
  assert.equal(f.marker.length,0);
}));

test('S3b2b R1 cancelled intent prefix retains requested flag when unknown',()=>durableFixture(async f=>{
  f.options.developer.run=()=>new Promise(()=>{});const r=f.create();const waiting=r.executeEffect(intent('develop'));
  const live=r.cancel(),saved=f.getStore().snapshot();await waiting;
  const reader={snapshot:()=>saved,append:()=>assert.fail('unknown cannot append')};
  const restored=createTaskRunner({...f.options,persistence:{store:reader,mode:'resume'}});
  assert.equal(restored.status().state,'unknown');assert.equal(restored.status().code,'reconciliation_required');
  assert.equal(live.cancellationRequested,true);assert.equal(restored.status().cancellationRequested,true);
  await restored.run();assert.equal(f.calls.length,0);assert.equal(f.marker.length,0);
}));

test('S3b2b R1 full record UTF8 byte limit includes envelope, exact limit passes plus one fails',()=>durableFixture(async f=>{
  f.options.developer.requestedModel='模型-fixture';
  const memoryStore=()=>{
    const records=[];return {snapshot:()=>({identity:{repositoryId:identity.repositoryId,runId:identity.runId},records,revision:digest(records)}),
      append:r=>{const record={version:1,seq:1,id:r.id,kind:r.kind,payload:r.payload,previousDigest:null};records.push({...record,digest:digest(record)});}};
  };
  const make=store=>createTaskRunner({...f.options,persistence:{store,mode:'create'}});
  let low=0,high=850000;
  while(low<high) {
    const mid=Math.ceil((low+high)/2);fs.writeFileSync(path.join(f.root,'requirements.md'),'x'.repeat(mid));
    try{make(memoryStore());low=mid;}catch(e){assert.equal(e.code,'limit_exceeded');high=mid-1;}
  }
  fs.writeFileSync(path.join(f.root,'requirements.md'),'x'.repeat(low));
  const probe=memoryStore();make(probe);let bytes=Buffer.byteLength(JSON.stringify(probe.snapshot().records[0]));
  assert(bytes<=1024*1024,'accepted full record above limit');
  f.options.developer.contextId+='p'.repeat(1024*1024-bytes);
  const exact=memoryStore();make(exact);assert.equal(Buffer.byteLength(JSON.stringify(exact.snapshot().records[0])),1024*1024);
  f.options.developer.contextId+='p';const overflow=memoryStore();assert.throws(()=>make(overflow),{code:'limit_exceeded'});
  assert.equal(overflow.snapshot().records.length,0);f.options.developer.contextId=f.options.developer.contextId.slice(0,-1);
  make(f.getStore());const saved=f.getStore().snapshot().records;
  assert.equal(Buffer.byteLength(JSON.stringify(saved[0])),1024*1024);assert.equal(f.calls.length,0);
  const oversized=structuredClone(saved);oversized[0].payload.config.developer.requestedModel+='字';
  assert.throws(()=>readRunnerHistory(oversized,oversized[0].payload.config),{code:'limit_exceeded'});
}));

test('S3b2b R1 cancel flag is monotonic but cache remains historical',()=>durableFixture(async f=>{
  const r=f.create();const developed=await r.executeEffect(intent('develop'));r.cancel();const restored=f.resume();
  assert.equal(restored.status().cancellationRequested,true);assert.equal(developed.cancellationRequested,false);
  assert.deepEqual(await restored.executeEffect(intent('develop')),developed);
  assert.equal(restored.status().cancellationRequested,true);assert.equal(f.calls.length,1);
}));
const intent=(kind,attempt=1,id=`${kind}-${attempt}`)=>({version:1,id,identity:{...identity,attempt},kind});
const terminal=(request,result,extra={})=>({version:1,invocationId:request.invocationId,
  contextId:request.contextId,provider:request.provider,effectiveModel:'unknown',status:'succeeded',accepted:true,result,...extra});
const approved=request=>({verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
  examinedPaths:[...new Set([...request.payload.reviewPackage.changes.map(c=>c.path),
    ...request.payload.reviewPackage.requirements.map(f=>f.path)])].sort(),findings:[],summary:'synthetic independent examination'});
async function fixture(fn,alter=()=>{}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-s2b-'));
  const calls=[],marker=[];
  fs.writeFileSync(path.join(root,'a.js'),'initial dirty\n');
  fs.writeFileSync(path.join(root,'requirements.md'),'synthetic requirement\n');
  const options={root,identity,scope:['a.js','new.js'],requirements:['requirements.md'],
    excludedContexts:['main','planner'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture-model',contextId:'developer',run:async r=>{
      calls.push(r);fs.writeFileSync(path.join(root,'a.js'),`implementation ${r.identity.attempt}\n`);
      return terminal(r,{outcome:'implemented'});
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture-model',allowed:true,available:true,
      contexts:['review-a1','review-a2'],run:async r=>{calls.push(r);return terminal(r,approved(r));}}],
    check:()=>structuredClone(checks),commit:r=>{marker.push(r);return {outcome:'fixture_completed'};}};
  try {alter(options,{root,calls,marker});return await fn({root,calls,marker,options,runner:createTaskRunner(options)});}
  finally {fs.rmSync(root,{recursive:true,force:true});}
}

test('S2b develop derives filesystem package through the sole effect entry',()=>fixture(async({runner,calls,marker})=>{
  const result=await runner.executeEffect(intent('develop'));
  assert.equal(result.state,'awaiting_review');assert.match(result.packageDigest,/^[a-f0-9]{64}$/);
  assert.equal(calls.length,1);assert.equal(calls[0].role,'developer');assert.equal(marker.length,0);
  assert(Object.isFrozen(calls[0].payload));assert.equal(runner.status().state,'awaiting_review');
}));

test('S2b review records actual fresh invocation and content-bound receipt, not task completion',()=>fixture(async({runner,calls,marker})=>{
  await runner.executeEffect(intent('develop'));
  const r=await runner.executeEffect(intent('review'));
  assert.equal(r.state,'approved');assert.equal(r.receipt.kind,'cm-review-receipt');
  assert.equal(r.receipt.execution.contextId,'review-a1');assert.equal(r.receipt.execution.channel,'fixture');
  assert.equal(r.receipt.execution.effectiveModel,'unknown');assert.equal(r.receipt.route.mode,'same-provider');
  assert.equal(r.receipt.packageDigest,r.packageDigest);assert.equal(calls.length,2);assert.equal(marker.length,0);
}));

test('S2b complete consumes internally registered review and commits fixture once',()=>fixture(async({runner,marker,calls})=>{
  await runner.executeEffect(intent('develop'));await runner.executeEffect(intent('review'));
  const done=await runner.executeEffect(intent('complete'));
  assert.equal(done.state,'fixture_completed');assert.equal(marker.length,1);assert.equal(calls.length,2);
  assert.equal(marker[0].receiptDigest,done.receipt.receiptDigest);
  assert.deepEqual(await runner.executeEffect(intent('complete')),done);assert.equal(marker.length,1);
}));

test('S2b default workflow automatically uses develop, review and completion gates',()=>fixture(async({runner,marker})=>{
  assert.equal((await runner.run()).state,'fixture_completed');assert.equal(marker.length,1);
}));

test('S2b workflow return done has no authority and its saved facade expires',()=>fixture(async({runner,marker,calls})=>{
  let saved;
  assert.equal((await runner.run(ctx=>{saved=ctx;return {done:true,approved:true};})).state,'ready');
  assert.equal((await saved.executeEffect(intent('develop'))).code,'workflow_closed');
  assert.equal(marker.length,0);assert.equal(calls.length,0);
}));

test('S2b unawaited effect with nonresponding adapter cancels at workflow return',()=>fixture(async({runner,marker})=>{
  const result=await runner.run(ctx=>{void ctx.executeEffect(intent('develop'));return 'done';});
  assert.equal(result.state,'cancelled');assert.equal(marker.length,0);
},o=>{o.developer.run=()=>new Promise(()=>{});}));

const second=o=>({...o.reviewers[0],id:'second',provider:'claude',contexts:['second-a1','second-a2']});
const finding={id:'F1',severity:'P2',path:'a.js',message:'synthetic defect',evidence:'synthetic reproduction'};
const changeRequest=r=>({...approved(r),verdict:'changes_requested',findings:[finding]});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

for(const provider of ['codex','claude'])test(`S2b ${provider}-only uses fresh same-provider review`,()=>fixture(async({runner,marker})=>{
  const result=await runner.run();assert.equal(result.state,'fixture_completed');assert.equal(marker.length,1);
  assert.equal(result.receipt.execution.provider,provider);assert.equal(result.receipt.route.mode,'same-provider');
},o=>{o.developer.provider=provider;o.reviewers[0].provider=provider;}));

test('S2b authorized cross-provider is recorded without guessing model',()=>fixture(async({runner})=>{
  const s=await runner.run();assert.equal(s.receipt.route.mode,'cross-provider');
  assert.equal(s.receipt.execution.requestedModel,'fixture-model');assert.equal(s.receipt.execution.effectiveModel,'unknown');
},o=>{o.reviewers[0].provider='claude';}));

for(const reason of ['not_authorized','unavailable','auth_required','permission_denied'])test(`S2b fallback only for ${reason}`,()=>fixture(async({runner,calls})=>{
  const s=await runner.run();assert.equal(s.state,'fixture_completed');
  assert.equal(s.receipt.execution.provider,'claude');assert.equal(s.receipt.route.fallbackReasons[0].reason,reason);
  assert.equal(calls.filter(c=>c.role==='reviewer').length,reason==='not_authorized'||reason==='unavailable'?1:2);
},(o,{calls})=>{
  o.reviewers.push(second(o));
  if(reason==='not_authorized')o.reviewers[0].allowed=false;
  else if(reason==='unavailable')o.reviewers[0].available=false;
  else o.reviewers[0].run=r=>{calls.push(r);return terminal(r,null,{status:reason,accepted:false});};
}));

for(const field of ['allowed','available'])test(`S2b no ${field} reviewer means zero development`,()=>fixture(async({runner,calls,marker})=>{
  assert.equal((await runner.run()).state,'pending_review');assert.equal(calls.length,0);assert.equal(marker.length,0);
},o=>{o.reviewers[0][field]=false;}));

test('S2b both known-unaccepted review channels leave pending without retry',()=>fixture(async({runner,calls,marker})=>{
  const s=await runner.run();assert.equal(s.state,'pending_review');assert.equal(s.identity.attempt,1);
  assert.equal(calls.length,3);await runner.run();assert.equal(calls.length,3);assert.equal(marker.length,0);
},(o,{calls})=>{o.reviewers.push(second(o));for(const r of o.reviewers)r.run=req=>{calls.push(req);return terminal(req,null,{status:'unavailable',accepted:false});};}));

for(const context of ['developer','main','planner','review-a1'])test(`S2b rejects reused/participating context ${context}`,async()=>{
  await assert.rejects(fixture(()=>assert.fail('must reject'),o=>{o.reviewers[0].contexts[1]=context;}),{code:'not_independent'});
});

test('S2b two attempts preserve original baseline, findings and historical cache',()=>fixture(async({runner,calls,marker})=>{
  const oldDev=await runner.executeEffect(intent('develop'));
  const oldReview=await runner.executeEffect(intent('review'));assert.equal(oldReview.state,'changes_requested');
  const before=runner.status();assert.deepEqual(await runner.executeEffect(intent('develop')),oldDev);
  assert.deepEqual(await runner.executeEffect(intent('review')),oldReview);assert.deepEqual(runner.status(),before);
  assert.equal((await runner.executeEffect(intent('develop',1,'new-old-id'))).code,'attempt_mismatch');
  await runner.executeEffect(intent('develop',2));const approved2=await runner.executeEffect(intent('review',2));
  assert.equal(approved2.state,'approved');assert.equal(approved2.receipts.length,2);
  const r2=calls.filter(c=>c.role==='reviewer')[1];assert.deepEqual(r2.payload.priorReview.findings,[finding]);
  assert.equal(Buffer.from(r2.payload.reviewPackage.changes[0].before.contentBase64,'base64').toString(),'initial dirty\n');
  assert.equal(r2.payload.reviewPackage.identity.attempt,2);
  assert.equal(calls.filter(c=>c.role==='developer')[1].payload.priorReview.verdict,'changes_requested');
  await runner.executeEffect(intent('complete',2));const done=runner.status();
  assert.deepEqual(await runner.executeEffect(intent('develop')),oldDev);assert.deepEqual(runner.status(),done);assert.equal(marker.length,1);
},(o,{calls})=>{o.reviewers[0].run=r=>{calls.push(r);return terminal(r,r.identity.attempt===1?changeRequest(r):approved(r));};}));

test('S2b two blocking reviews stop without third attempt or alternate reviewer',()=>fixture(async({runner,marker,calls})=>{
  const s=await runner.run();assert.equal(s.state,'blocked');assert.equal(s.code,'review_limit');assert.equal(s.receipts.length,2);
  assert.equal(marker.length,0);assert.equal(calls.length,4);
  assert.equal((await runner.executeEffect(intent('develop',2,'attempt-reset'))).outcome,'rejected');
  assert.equal((await runner.executeEffect(intent('develop',3))).outcome,'rejected');assert.equal(calls.length,4);
},(o,{calls})=>{o.reviewers.push(second(o));o.reviewers[0].run=r=>{calls.push(r);return terminal(r,changeRequest(r));};}));

for(const mutation of ['missing-path','empty-summary','bad-evidence','false-approved','missing-result','context','provider','invocation','version'])
test(`S2b malformed review ${mutation} never passes or washes verdict`,()=>fixture(async({runner,marker,calls})=>{
  const s=await runner.run();assert.equal(s.state,'unknown');assert.equal(marker.length,0);
  assert.equal(calls.filter(c=>c.role==='reviewer').length,1);
},(o,{calls})=>{o.reviewers.push(second(o));o.reviewers[0].run=r=>{
  calls.push(r);let result=approved(r),response=terminal(r,result);
  if(mutation==='missing-path')result.examinedPaths=[];
  if(mutation==='empty-summary')result.summary=' ';
  if(mutation==='bad-evidence')result.findings=[{...finding,severity:'P3',evidence:''}];
  if(mutation==='false-approved')result.findings=[finding];
  if(mutation==='missing-result')response.result=null;
  if(mutation==='context')response.contextId='developer';
  if(mutation==='provider')response.provider='claude';
  if(mutation==='invocation')response.invocationId='other';
  if(mutation==='version')response.version=2;
  return response;
};}));

for(const status of ['failed','unknown'])test(`S2b accepted ${status} does not fallback`,()=>fixture(async({runner,marker,calls})=>{
  const s=await runner.run();assert.equal(s.state,status==='failed'?'pending_review':'unknown');
  assert.equal(calls.length,2);assert.equal(marker.length,0);
},(o,{calls})=>{o.reviewers.push(second(o));o.reviewers[0].run=r=>{calls.push(r);return terminal(r,null,{status,accepted:true});};}));

test('S2b blocked verdict is recorded but never sent to alternate reviewer',()=>fixture(async({runner,marker,calls})=>{
  const s=await runner.run();assert.equal(s.state,'blocked');assert.equal(s.receipt.result.verdict,'blocked');
  assert.equal(calls.length,2);assert.equal(marker.length,0);
},(o,{calls})=>{o.reviewers.push(second(o));o.reviewers[0].run=r=>{calls.push(r);return terminal(r,{...approved(r),verdict:'blocked'});};}));

for(const mode of ['timeout','throw'])test(`S2b review ${mode} is unknown with no fallback`,()=>fixture(async({runner,calls,marker})=>{
  const s=await runner.run();assert.equal(s.state,'unknown');assert.equal(calls.length,2);assert.equal(marker.length,0);
},(o,{calls})=>{o.timeoutMs=10;o.reviewers.push(second(o));o.reviewers[0].run=r=>{calls.push(r);if(mode==='throw')throw Error('private exception');return new Promise(()=>{});};}));

test('S2b timed-out review late success cannot replace unknown or commit',async()=>{
  const late=deferred();let request;
  await fixture(async({runner,marker})=>{
    assert.equal((await runner.run()).state,'unknown');late.resolve(terminal(request,approved(request)));await tick();
    assert.equal(runner.status().state,'unknown');assert.equal(marker.length,0);
  },o=>{o.timeoutMs=10;o.reviewers[0].run=r=>{request=r;return late.promise;};});
});

for(const phase of ['developer','reviewer','check'])test(`S2b cancel during ${phase} aborts and ignores late success`,async()=>{
  const began=deferred(),late=deferred();let request,signal;
  await fixture(async({runner,marker,calls})=>{
    const running=runner.run();await began.promise;runner.cancel();assert(signal.aborted);
    assert.equal((await running).state,'cancelled');
    late.resolve(phase==='check'?checks:terminal(request,phase==='developer'?{outcome:'implemented'}:approved(request)));await tick();
    assert.equal(runner.status().state,'cancelled');assert.equal(marker.length,0);
    const n=calls.length;await runner.run();assert.equal(calls.length,n);
  },o=>{const handler=(r,opts)=>{request=r;signal=opts.signal;began.resolve();return late.promise;};
    if(phase==='developer')o.developer.run=handler;
    if(phase==='reviewer')o.reviewers[0].run=handler;
    if(phase==='check')o.check=handler;
  });
});

test('S2b cancel after review but before complete prevents commit and preserves history',()=>fixture(async({runner,marker})=>{
  const d=await runner.executeEffect(intent('develop'));await runner.executeEffect(intent('review'));runner.cancel();
  assert.equal((await runner.executeEffect(intent('complete'))).outcome,'rejected');
  assert.deepEqual(await runner.executeEffect(intent('develop')),d);assert.equal(runner.status().state,'cancelled');assert.equal(marker.length,0);
}));

test('S2b commit-entered cancellation is not reported as rollback',async()=>{
  let runnerRef;
  await fixture(async({runner,marker})=>{runnerRef=runner;const r=await runner.run();assert.equal(r.state,'fixture_completed');assert(r.cancelAfterCommit);assert.equal(marker.length,1);},
    (o,{marker})=>{o.commit=r=>{marker.push(r);runnerRef.cancel();return {outcome:'fixture_completed'};};});
});

test('S2b concurrent/reentrant effects reject busy; old ID exact replay has zero effects',async()=>{
  const start=deferred(),finish=deferred();let request;
  await fixture(async({runner,marker})=>{
    const first=runner.executeEffect(intent('develop'));await start.promise;
    assert.equal((await runner.executeEffect(intent('develop'))).code,'busy');
    assert.equal((await runner.executeEffect(intent('review'))).code,'busy');
    finish.resolve(terminal(request,{outcome:'implemented'}));const result=await first;
    assert.deepEqual(await runner.executeEffect(intent('develop')),result);
    assert.equal((await runner.executeEffect(intent('review',1,'develop-1'))).code,'intent_conflict');
    assert.equal((await runner.executeEffect(intent('develop',1,'different'))).code,'stage_mismatch');assert.equal(marker.length,0);
  },(o,{root})=>{o.developer.run=r=>{request=r;fs.writeFileSync(path.join(root,'a.js'),'changed');start.resolve();return finish.promise;};});
});

for(const extra of [{approved:true},{receipt:{approved:true}},{source:'host'},{version:2},{kind:'commit'}])
test(`S2b forged intent ${JSON.stringify(extra)} rejected without calls`,()=>fixture(async({runner,calls,marker})=>{
  assert.equal((await runner.executeEffect({...intent('develop'),...extra})).outcome,'rejected');assert.equal(calls.length,0);assert.equal(marker.length,0);
  assert.equal((await runner.executeEffect(intent('complete'))).outcome,'rejected');
}));

for(const field of ['repositoryId','runId','taskId','attempt'])test(`S2b intent ${field} mismatch rejects`,()=>fixture(async({runner,calls})=>{
  const i=intent('develop');i.identity[field]=field==='attempt'?2:'foreign';
  assert.equal((await runner.executeEffect(i)).outcome,'rejected');assert.equal(calls.length,0);
}));

for(const mutation of ['code','requirements','outside','checks'])test(`S2b completion invalidates changed ${mutation}`,()=>{
  let changed=false;
  return fixture(async({runner,root,marker})=>{
  await runner.executeEffect(intent('develop'));await runner.executeEffect(intent('review'));
  if(mutation==='code')fs.writeFileSync(path.join(root,'a.js'),'post-review edit');
  if(mutation==='requirements')fs.writeFileSync(path.join(root,'requirements.md'),'post-review requirement');
  if(mutation==='outside')fs.writeFileSync(path.join(root,'outside.txt'),'outside');
  if(mutation==='checks')changed=true;
  assert.equal((await runner.executeEffect(intent('complete'))).state,'blocked');assert.equal(marker.length,0);
  },o=>{o.check=()=>changed?[{...checks[0],evidence:'changed evidence'}]:checks;});
});

for(const outcome of ['failed','unavailable'])test(`S2b stable ${outcome} checks cannot be overridden by approved`,()=>fixture(async({runner,marker})=>{
  const r=await runner.run();assert.equal(r.state,'blocked');assert.equal(r.code,'checks_not_passed');
  assert.equal(r.receipt.result.verdict,'approved');assert.equal(marker.length,0);
},o=>{o.check=()=>[{...checks[0],outcome,exitCode:outcome==='failed'?1:null}];}));

for(const phase of ['before-review','during-review'])test(`S2b edits ${phase} do not produce approval`,()=>fixture(async({runner,root,marker})=>{
  await runner.executeEffect(intent('develop'));if(phase==='before-review')fs.writeFileSync(path.join(root,'a.js'),'changed after package');
  const r=await runner.executeEffect(intent('review'));assert.notEqual(r.state,'approved');assert.equal(marker.length,0);
},(o,{root})=>{if(phase==='during-review')o.reviewers[0].run=r=>{fs.writeFileSync(path.join(root,'a.js'),'reviewer edit');return terminal(r,approved(r));};}));

test('S2b gate rejects forged/re-signed/foreign receipts against trusted registration',()=>fixture(async({runner,calls})=>{
  await runner.executeEffect(intent('develop'));const state=await runner.executeEffect(intent('review'));
  const receipt=state.receipt,reviewPackage=calls.find(c=>c.role==='reviewer').payload.reviewPackage;
  const req={receipt,registered:receipt,execution:state.calls[1],reviewPackage,identity};
  assert.equal(checkCompletion(req).outcome,'eligible');
  for(const mutate of [r=>{r.version=2;},r=>{r.identity.runId='foreign';},r=>{r.execution.contextId='developer';},r=>{r.result.summary='altered';},r=>{r.packageDigest='0'.repeat(64);}]) {
    const changed=structuredClone(receipt);mutate(changed);const {receiptDigest:ignored,...data}=changed;changed.receiptDigest=digest(data);
    assert.throws(()=>checkCompletion({...req,receipt:changed}));
  }
  assert.throws(()=>checkCompletion({...req,registered:undefined}));
  assert.throws(()=>checkCompletion({...req,execution:{...state.calls[1],effectiveModel:'forged'}}));
  assert.throws(()=>checkCompletion({...req,identity:{...identity,runId:'foreign'}}));
}));

for(const kind of ['throw','promise','wrong'])test(`S2b ${kind} commit is unknown and never retried`,()=>fixture(async({runner,marker})=>{
  const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(marker.length,1);
  await runner.executeEffect(intent('complete'));await runner.run();assert.equal(marker.length,1);
},(o,{marker})=>{o.commit=r=>{marker.push(r);if(kind==='throw')throw Error('private');if(kind==='promise')return Promise.reject(Error('private'));return {outcome:'done'};};}));

for(const kind of ['wrong-developer','wrong-check','throw-check'])test(`S2b ${kind} fails without review or completion`,()=>fixture(async({runner,marker})=>{
  const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(marker.length,0);assert.equal(r.receipt,null);
},o=>{if(kind==='wrong-developer')o.developer.run=r=>terminal(r,{approved:true});
  if(kind==='wrong-check')o.check=()=>[];if(kind==='throw-check')o.check=()=>{throw Error('private');};}));

test('S2b input getters/non-JSON and mutations cannot acquire authority',()=>fixture(async({runner,marker})=>{
  let touched=0;const v=intent('develop');Object.defineProperty(v,'source',{enumerable:true,get(){touched++;return 'host';}});
  assert.equal((await runner.executeEffect(v)).outcome,'rejected');assert.equal(touched,0);
  for(const bad of [undefined,NaN,new Date(),Object.create(Array.prototype),{a:()=>{}},[,]])assert.throws(()=>json(bad));
  assert.throws(()=>json({large:'x'.repeat(1024*1024)}),{code:'limit_exceeded'});
  const s=runner.status();assert.throws(()=>{s.identity.runId='forged';},TypeError);assert.equal(marker.length,0);
}));

test('S2b workflow throw revokes facade and unawaited complete does not bypass checks',()=>fixture(async({runner,marker})=>{
  let saved;
  const r=await runner.run(async ctx=>{saved=ctx;await ctx.executeEffect(intent('develop'));await ctx.executeEffect(intent('review'));
    void ctx.executeEffect(intent('complete'));throw Error('private workflow message');});
  assert.equal(r.state,'cancelled');assert.equal(marker.length,0);assert.equal(r.workflowError,'workflow_error');
  assert.equal((await saved.executeEffect(intent('complete'))).code,'workflow_closed');
}));

test('S2b workflow throw after committed preserves outcome',()=>fixture(async({runner,marker})=>{
  const r=await runner.run(async ctx=>{for(const kind of ['develop','review','complete'])await ctx.executeEffect(intent(kind));throw Error('post-commit');});
  assert.equal(r.state,'fixture_completed');assert.equal(r.workflowError,'workflow_error');assert.equal(marker.length,1);
}));

test('S2b omitted timeout uses default without changing strict option keys',()=>fixture(async({runner})=>{
  assert.equal((await runner.run()).state,'fixture_completed');
},o=>{delete o.timeoutMs;}));

test('S2b reviewer array accessors reject before executing getters',async()=>{
  let touched=0;
  await assert.rejects(fixture(()=>assert.fail('must reject'),o=>{
    const candidate=o.reviewers[0];Object.defineProperty(o.reviewers,'0',{enumerable:true,get(){touched++;return candidate;}});
  }));assert.equal(touched,0);
});

test('S2b explicit unaccepted unavailable can fallback, accepted permission denial cannot',async()=>{
  for(const accepted of [false,true])await fixture(async({runner,calls,marker})=>{
    const r=await runner.run();assert.equal(r.state,accepted?'unknown':'fixture_completed');
    assert.equal(calls.length,accepted?2:3);assert.equal(marker.length,accepted?0:1);
  },(o,{calls})=>{o.reviewers.push(second(o));o.reviewers[0].run=r=>{calls.push(r);return terminal(r,null,{status:accepted?'permission_denied':'unavailable',accepted});};});
});

test('S2b final check cancellation and reviewer reentrant dispatch cannot sneak in a commit',async()=>{
  let ref,checksCount=0,busyResult;
  await fixture(async({runner,marker})=>{ref=runner;const result=await runner.run();assert.equal(result.state,'cancelled');assert.equal(marker.length,0);assert.equal(busyResult.code,'busy');},
    o=>{o.check=()=>{if(++checksCount===2)ref.cancel();return checks;};
      o.reviewers[0].run=async r=>{busyResult=await ref.executeEffect(intent('complete'));return terminal(r,approved(r));};});
});

test('S2b configuration is captured and not changed by caller during a run',()=>fixture(async({runner,options,marker})=>{
  options.identity.runId='external-mutation';options.reviewers[0].allowed=false;options.reviewers[0].run=()=>{throw Error('replaced');};
  assert.equal((await runner.run()).state,'fixture_completed');assert.equal(marker.length,1);
},o=>{o.identity={...identity};}));

test('S2b constructor rejects external restore, attempt2 and excess candidates',async()=>{
  for(const mutation of [o=>{o.snapshot={};},o=>{o.identity={...identity,attempt:2};},o=>{o.reviewers.push(second(o),second(o));}])
    await assert.rejects(fixture(()=>assert.fail('must reject'),mutation));
});

test('S2b protocol result size limit and getters fail without exposing private exception text',async()=>{
  let touched=0;
  for(const mode of ['large','accessor'])await fixture(async({runner,marker})=>{
    const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(marker.length,0);
    assert(!JSON.stringify(r).includes('private exception'));assert.equal(touched,0);
  },o=>{o.reviewers[0].run=r=>{const value=approved(r);if(mode==='large')value.summary='x'.repeat(1024*1024);
    else Object.defineProperty(value,'summary',{enumerable:true,get(){touched++;throw Error('private exception');}});
    return terminal(r,value);};});
});

test('S2b full package payload above 1MiB remains reviewable within S2a bound',()=>fixture(async({runner})=>{
  assert.equal((await runner.run()).state,'fixture_completed');
},(o,{root})=>{fs.writeFileSync(path.join(root,'a.js'),Buffer.alloc(800000,65));o.developer.run=r=>{
  fs.writeFileSync(path.join(root,'a.js'),Buffer.alloc(800000,66));return terminal(r,{outcome:'implemented'});
};}));

test('S2b explicitly null timeout is invalid, not the omitted default',async()=>{
  await assert.rejects(fixture(()=>{},o=>{o.timeoutMs=null;}),{code:'invalid_input'});
});

test('S2b provider exception code is not a channel for copying private data',()=>fixture(async({runner})=>{
  const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(r.code,'execution_error');
  assert(!JSON.stringify(r).includes('private-exception-detail'));
},o=>{o.developer.run=()=>{throw Object.assign(Error('private message'),{code:'private-exception-detail'});};}));

for(const phase of ['developer','reviewer','check'])for(const mode of ['getter-thenable','method-thenable','extra-getter'])
test(`S2b R1-P2-01 ${phase} rejects synchronous ${mode} before assimilation`,async()=>{
  let touched=0;
  const bad=value=>{
    if(mode==='method-thenable')return {then(resolve){touched++;resolve(value);}};
    const result=mode==='extra-getter'?value:{};
    Object.defineProperty(result,'then',{enumerable:true,get(){touched++;return mode==='extra-getter'?undefined:resolve=>resolve(value);}});
    return result;
  };
  await fixture(async({runner,marker})=>{
    const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(marker.length,0);assert.equal(touched,0);
  },(o,{root})=>{
    if(phase==='developer')o.developer.run=r=>{fs.writeFileSync(path.join(root,'a.js'),'implementation');return bad(terminal(r,{outcome:'implemented'}));};
    if(phase==='reviewer')o.reviewers[0].run=r=>bad(terminal(r,approved(r)));
    if(phase==='check')o.check=()=>bad(structuredClone(checks));
  });
});

for(const phase of ['developer','reviewer','check'])test(`S2b R1-P2-02 ${phase} exception code getter never runs and unknown is cached`,async()=>{
  let touched=0;
  const fail=()=>{throw Object.defineProperty(new Error('adapter failed'),'code',{get(){touched++;throw Error('private-classification-detail');}});};
  await fixture(async({runner,marker})=>{
    if(phase==='reviewer')await runner.executeEffect(intent('develop'));
    const i=intent(phase==='reviewer'?'review':'develop');
    const r=await runner.executeEffect(i);assert.equal(r.state,'unknown');assert.equal(r.code,'execution_error');
    assert.equal(touched,0);assert.equal(marker.length,0);assert(!JSON.stringify(r).includes('private-classification-detail'));
    assert.deepEqual(await runner.executeEffect(i),r);assert.equal(runner.status().state,'unknown');
  },o=>{if(phase==='developer')o.developer.run=fail;if(phase==='reviewer')o.reviewers[0].run=fail;if(phase==='check')o.check=fail;});
});

test('S2b R1-P2-01 native promise remains supported without reading overridden then',async()=>{
  let touched=0;
  await fixture(async({runner,marker})=>{assert.equal((await runner.run()).state,'fixture_completed');assert.equal(marker.length,1);assert.equal(touched,0);},
    o=>{o.reviewers[0].run=r=>{const p=Promise.resolve(terminal(r,approved(r)));
      Object.defineProperty(p,'then',{get(){touched++;throw Error('unexpected then read');}});return p;};});
});

test('S2b R1-P2-01 nonstandard promise container stops without reading constructor getter',async()=>{
  let touched=0;
  await fixture(async({runner,marker})=>{assert.equal((await runner.run()).state,'unknown');assert.equal(marker.length,0);assert.equal(touched,0);},
    o=>{o.reviewers[0].run=r=>{const p=Promise.resolve(terminal(r,approved(r)));
      Object.defineProperty(p,'constructor',{get(){touched++;throw Error('unexpected constructor read');}});return p;};});
});

test('S2b R1-P2-02 inherited code accessor and non-object throws classify without reading them',async()=>{
  let touched=0;
  for(const error of [null,'private thrown text',Object.create({get code(){touched++;throw Error('private inherited detail');}})])
    await fixture(async({runner})=>{const r=await runner.run();assert.equal(r.state,'unknown');assert.equal(r.code,'execution_error');assert.equal(touched,0);},o=>{o.developer.run=()=>{throw error;};});
});

// Separate processes are essential: node:test alone can miss a crash after runner.run()
// resolves unknown. Use strict mode too; never install a global rejection handler.
for(const phase of ['developer','reviewer','check','final-check','commit'])
for(const container of ['own-constructor','subclass','cross-realm','configurable-accessor','writable-constructor','producer-owned'])
for(const rejected of [true,false])
for(const delayed of [false,true])
test(`S2b R2-P2-01 ${phase} ${container} ${rejected?'rejected':'fulfilled'} ${delayed?'late':'immediate'} settles safely`,()=>{
  const source=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
    import vm from 'node:vm';
    import { createTaskRunner } from ${JSON.stringify(new URL('./task-runner.mjs',import.meta.url).href)};
    const identity=${JSON.stringify(identity)}, checks=${JSON.stringify(checks)};
    const terminal=${terminal.toString()}, approved=${approved.toString()};
    const fixture=${fixture.toString()};
    const phase=${JSON.stringify(phase)}, container=${JSON.stringify(container)}, rejected=${rejected}, delayed=${delayed};
    let touched=0, checksCount=0, saved, descriptor;
    const wrap=value=>{
      const payload=rejected?new Error('synthetic-private-rejection'):value;
      const executor=(resolve,reject)=>{const settle=()=>{(rejected?reject:resolve)(payload);};
        if(delayed)setTimeout(settle,5);else settle();};
      let p;
      if(container==='subclass')p=new (class extends Promise {
        static get [Symbol.species](){touched++;throw Error('unexpected species');}
      })(executor);
      else if(container==='cross-realm')p=new (vm.runInNewContext('Promise'))(executor);
      else p=new Promise(executor);
      if(container==='own-constructor')Object.defineProperty(p,'constructor',{value:Promise});
      if(container==='configurable-accessor')Object.defineProperty(p,'constructor',{
        configurable:true,get(){touched++;throw Error('unexpected constructor');}});
      if(container==='writable-constructor')Object.defineProperty(p,'constructor',{
        writable:true,value:class {constructor(){touched++;throw Error('unexpected constructor');}}});
      if(container==='producer-owned'){
        // Immutable accessor containers must be rejection-owned by their producer.
        Promise.prototype.then.call(p,()=>{},()=>{});
        Object.defineProperty(p,'constructor',{get(){touched++;throw Error('unexpected constructor');}});
      }
      Object.defineProperty(p,'then',{get(){touched++;throw Error('unexpected then');}});
      Object.defineProperty(p,'catch',{get(){touched++;throw Error('unexpected catch');}});
      saved=p;descriptor=Object.getOwnPropertyDescriptor(p,'constructor');return p;
    };
    await fixture(async({runner,marker})=>{
      const result=await runner.run();assert.equal(result.state,'unknown');
      assert.equal(marker.length,phase==='commit'?1:0);
      assert(!JSON.stringify(result).includes('synthetic-private-rejection'));
      assert.equal(touched,0);assert.deepEqual(Object.getOwnPropertyDescriptor(saved,'constructor'),descriptor);
      await new Promise(resolve=>setTimeout(resolve,20));assert.equal(touched,0);
      console.log('controlled-unknown');
    },(o,{marker})=>{
      if(phase==='developer')o.developer.run=r=>wrap(terminal(r,{outcome:'implemented'}));
      if(phase==='reviewer')o.reviewers[0].run=r=>wrap(terminal(r,approved(r)));
      if(phase==='check')o.check=()=>wrap(checks);
      if(phase==='final-check')o.check=()=>++checksCount===2?wrap(checks):checks;
      if(phase==='commit')o.commit=r=>{marker.push(r);return wrap({outcome:'fixture_completed'});};
    });`;
  const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',source],
    {encoding:'utf8',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);
  assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');
  assert.equal(child.stdout.trim(),'controlled-unknown');
});
