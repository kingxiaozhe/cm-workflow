import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {writeHandoff} from '../experiments/js-orchestration/native-gate-fixture.mjs';

const identity={repositoryId:'fixture',runId:'review-drift',taskId:'T-001',attempt:1};
const terminal=(request,result)=>({version:1,invocationId:request.invocationId,
  contextId:request.contextId,provider:request.provider,effectiveModel:'fixture',
  status:'succeeded',accepted:true,result});

for(const [name,change,expected] of [
  ['specification',({design})=>fs.appendFileSync(design,'changed during review\n'),'spec_drift'],
  ['code root',({code})=>fs.writeFileSync(path.join(code,'stray.js'),'changed during review\n'),'review_package_changed'],
  ['specification and code root',({design,code})=>{
    fs.writeFileSync(path.join(code,'stray.js'),'changed during review\n');
    fs.appendFileSync(design,'changed during review\n');
  },'spec_drift'],
])test(`review-time ${name} drift reports ${expected}`,async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-drift-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specsRoot=path.join(root,'specs'),feature='1.fixture';
  fs.mkdirSync(code);fs.mkdirSync(path.join(specsRoot,feature),{recursive:true});
  fs.writeFileSync(path.join(code,'code.js'),'old\n');
  fs.writeFileSync(path.join(specsRoot,feature,'requirements.md'),'# Requirements\n- [ ] [AC-001] Fixture\n');
  const design=path.join(specsRoot,feature,'design.md');fs.writeFileSync(design,'# Design\n');
  fs.writeFileSync(path.join(specsRoot,feature,'tasks.md'),'- [ ] T-001: implement fixture\n');
  fs.writeFileSync(path.join(specsRoot,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],
    specFiles:buildManifest(specsRoot)}));
  const reviewsDir=path.join(specsRoot,'.reviews');fs.mkdirSync(reviewsDir);
  const owner={tasksPath:path.join(specsRoot,feature,'tasks.md'),feature,specsRoot,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('review-drift'),config:digest('fixture'),inputs:digest('fixture')}};
  let store=openTaskExecutionStore({...owner,create:true});
  t.after(()=>store.close());
  const learningFiles=[],learningDigest=digest({version:1,feature,identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature,identity,learningDigest,learningFiles};
  const handoffs=[1,2].map(attempt=>path.join(reviewsDir,
    `${feature}-${identity.taskId}-a${attempt}-handoff.json`));
  let reviews=0;
  const runner=createTaskRunner({root:code,identity,scope:['code.js'],requirements:[],
    specification:{specsRoot,feature},taskLearning:{feature},excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:request=>{
      fs.writeFileSync(path.join(code,'code.js'),'new\n');
      writeHandoff(handoffs[0],code,['code.js']);
      return terminal(request,{outcome:'implemented',
        application:createCmAiTaskLearningApplication({feature,identity,learningDigest,status:'no_relevant_lesson',note:null}),
        retrospective:createCmAiTaskLearningRetrospective({feature,identity,learningDigest,
          status:'no_new_lesson',candidates:[],reason:null})});
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:request=>{
        reviews++;change({code,design});
        return terminal(request,{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Fixture review'});
      }}],
    check:()=>[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    taskCompletion:{reviewsDir,handoffs},
    persistence:{store,mode:'create',version:2}});
  const effect=kind=>({version:1,id:kind,identity,kind,...(kind==='develop'?{learningInput}:{})});
  assert.equal((await runner.executeEffect(effect('develop'))).state,'awaiting_review');
  const result=await runner.executeEffect(effect('review'));
  assert.equal(reviews,1);
  assert.equal(result.state,'blocked');assert.equal(result.code,expected);
  assert.equal(result.receipts.length,expected==='spec_drift'?0:1);
  if(expected==='review_package_changed')assert.equal(result.receipt.result.verdict,'approved');
  store.close();store=openTaskExecutionStore({...owner,create:false});
  const resumed=createTaskRunner({root:code,identity,scope:['code.js'],requirements:[],
    specification:{specsRoot,feature},taskLearning:{feature},excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:()=>{throw new Error('must not redevelop');}},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not rereview');}}],
    check:()=>[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    taskCompletion:{reviewsDir,handoffs},persistence:{store,mode:'resume',version:2}});
  assert.equal(resumed.status().code,expected);
  if(expected==='spec_drift'){
    fs.writeFileSync(design,'# Design\n');
    assert.equal(resumed.status().code,'spec_drift');
  }else{
    fs.unlinkSync(path.join(code,'stray.js'));
    assert.equal(resumed.status().state,'approved');
  }
});
