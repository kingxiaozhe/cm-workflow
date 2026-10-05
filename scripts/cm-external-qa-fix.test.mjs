import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import {expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

// Real parent/child stores and grants; synthetic provider results. No native
// Codex sandbox, network, install or user's runtime configuration is needed.
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qa-fix-session-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const A='session-A',B='session-B',C='session-C';
const prepare=async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),
  status:'no_relevant_lesson',summary:'Synthetic fixture'}});
const diagnosis={status:'diagnosed',rootCause:'Wrong constant across layers',affectedPaths:['value.mjs'],
  affectedModules:['value'],plan:'Set value to 2 after review',crossLayer:true};
function events(onEvent,thread){
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
}
async function fixture(t,{childHost=A,causeContext=null,lostCauseReviews=0,external=false,lateCause=false,optimized=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qa-fix-session-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.value';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Value must be 2.');
  fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Fixture');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement value\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const identity={repositoryId:'fixture',runId:'qa-parent',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['value.mjs'],requirements:['requirements.md']};
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',disabledSkills:[],promptTransport:'stdin'})}};
  const workflow={documentationPaths:[],applicableAgentFiles:[],qa:{commands:[{id:'value',command:[process.execPath,'red.mjs'],caseIds:[]}],
    environment:{kind:'web',carrier:'browser',target:'synthetic-local',scope:'local'}}};
  const bridge={async call(kind){
    assert.equal(kind,'develop');fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
    return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
  }};
  const executionFor=live=>{
    const execution=createConversationExecution(definition,live,bridge,review,1,workflow,true,'codex',
      live===A?{}:{originalHostContextId:A});
    execution.check=createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]});
    execution.reviewers[0].run=async(request,{onEvent})=>{
      events(onEvent,'synthetic-parent-review');
      return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};
    };
    execution.qaDecisionProvider={...execution.qaDecisionProvider,decide:async binding=>({decisionId:'qa-parent',identity:binding.identity,
      packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-08T01:00:00Z'})};
    execution.qaExecutor={...execution.qaExecutor,run:async()=>{
      const report=path.join(specsDir,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic QA FAIL: value must be 2.');
      return {result:'FAIL',passed:0,failed:1,blocked:0,report};
    }};
    return execution;
  };
  let parent=null,owner=null;
  t.after(()=>{owner?.close();parent?.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=operation=>({version:1,requestId:operation,operation,identity});
  parent=await openControlRun(definition,'create',executionFor(A));
  const failed=await parent.host.handle(request('advance'));
  assert.equal(failed.code,'qa_failed',JSON.stringify(failed));parent.close();parent=null;
  const qaSource={feature,identity,packageDigest:failed.packageDigest,testRunId:failed.fixHandoff.source.testRunId,
    handoffDigest:failed.fixHandoff.handoffDigest};
  const permissions=['--allow-cause-review'];
  let causeReviews=0;
  const models={schemaVersion:1,providers:{codex:{model:'fixture',effort:'low'}}};
  const childReview=external?{...review,...(lateCause?{timeoutMs:20}:{}),effort:'low',preflight:{...review.preflight,config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',effort:'low'})}}:review;
  const reviewHost=live=>createFixReviewHost({codeProject,hostContextId:live,review:childReview,permissions,...(optimized?{executionPolicy:EXECUTION_POLICY_V1,specsDir}:{}),...(external?{externalModels:models}:{}),workerFactory:()=>async({prompt},{onEvent,signal,onTerminal})=>{
    const parsed=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]),data=parsed.presentation?expandReviewData(parsed):parsed;
    if(lateCause){causeReviews++;onEvent({event:'thread.started',provider_thread:'synthetic-child-review'});onEvent({event:'turn.started',item_type:null});
      return new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{
        for(const event of [{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:null,signal:'SIGTERM',timed_out:false}])onEvent(event);
        onTerminal({status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Original QA child review'}});resolve({status:'cancelled',code:'cancelled'});
      },5),{once:true}));
    }
    if(++causeReviews<=lostCauseReviews){onEvent({event:'thread.started',provider_thread:`lost-child-review-${causeReviews}`});
      throw Error('Synthetic lost cause review');}
    events(onEvent,'synthetic-child-review');
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'Synthetic cause review'}};
  }});
  const configuration={...(optimized?{executionPolicy:EXECUTION_POLICY_V1}:{}),...(external?{externalModels:models}:{}),hostContextId:childHost,defect:'Value must be 2',qaSource,
    causeReview:{...reviewHost(A).reviewer,...(causeContext?{contextId:causeContext}:{})},
    reproduction:{cwd:codeProject,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  const fix={specsRoot:specsDir,identity:qaFixIdentity(qaSource),configuration};
  const childDir=path.join(specsDir,'.reviews','.execution',fix.identity.runId),statePath=path.join(childDir,'state.json');
  const bound=operation=>({...request(operation),packageDigest:failed.packageDigest,testRunId:qaSource.testRunId});
  const close=()=>{owner?.close();owner=null;};
  const open=async(live,{allowStart=true,template=false,allowAbandon=false,lostDiagnosis=false}={})=>{
    close();const execution=executionFor(live);assert.equal(execution.configuration.hostContextId,A);
    parent=await openControlRun(definition,'resume',execution);
    const rh=reviewHost(live);
    const {qaSource:ignored,...templateConfiguration}=configuration;
    owner=createQaFixOwnerHost({parent,...(optimized?{executionPolicy:EXECUTION_POLICY_V1}:{}),...(external?{externalModels:models}:{}),hostContextId:live,parentHostContextId:execution.configuration.hostContextId,
      reopenParent:()=>openControlRun(definition,'resume',execution),allowStart,
      ...(template?{template:{specsRoot:specsDir,feature,identity,configuration:templateConfiguration}}:{fix}),
      fixPermissions:allowAbandon?[...permissions,'--allow-abandon']:permissions,
      fixAuthorities:{authority:rh.authority,finalAuthority:rh.finalAuthority},
      fixExecution:{...rh.execution,prepare,bridge:{async call(kind){assert.equal(kind,'fix_diagnose');
        if(lostDiagnosis)throw Error('Synthetic lost diagnosis');return diagnosis;}}}});
    parent=null;return owner;
  };
  const records=()=>JSON.parse(fs.readFileSync(statePath)).records;
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const fake=path.join(bin,'codex');fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);fs.chmodSync(fake,0o700);
  for(const [name,value] of Object.entries({run:definition,review,workflow,fix}))fs.writeFileSync(path.join(root,`${name}.json`),JSON.stringify(value));
  return {causeReviews:()=>causeReviews,models,open,close,bound,fix,childDir,statePath,records,reviewHost,root,bin,request};
}


test('QA child inherits one frozen pair, reopens original parent and preserves child snapshot across sessions',async t=>{
  const f=await fixture(t,{external:true});let owner=await f.open(A,{template:true});
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
  assert.deepEqual(f.records()[0].payload.configuration.externalModels,f.models);
  assert.equal((await owner.handle({...f.bound('fix_action'),fixOperation:'cause_review'})).fixStage,'red_test_required');
  f.close();const before=f.records();owner=await f.open(B);
  assert.equal((await owner.handle(f.bound('fix_status'))).fixStage,'red_test_required');assert.deepEqual(f.records(),before);
  f.close();f.fix.configuration.externalModels={schemaVersion:1,providers:{codex:{model:'other',effort:'high'}}};
  await assert.rejects(f.open(C),{code:'external_model_pair_conflict'});
});
test('QA child refuses retrofitting legacy definition with new provider defaults',async t=>{
  const f=await fixture(t,{external:true});delete f.fix.configuration.externalModels;
  await assert.rejects(f.open(A),{code:'external_model_legacy_child_inheritance_forbidden'});
  assert(!fs.existsSync(f.statePath));
});

test('QA fix_action reconciles original late child invocation across parent reopen with zero provider authority',async t=>{
  const f=await fixture(t,{external:true,lateCause:true});let owner=await f.open(A,{template:true});
  await owner.handle(f.bound('fix_advance'));
  const unknown=await owner.handle({...f.bound('fix_action'),fixOperation:'cause_review'});assert.equal(unknown.fixStage,'unknown',JSON.stringify(unknown));
  const invocationId=f.records().find(r=>r.id==='fix-cause-registered').payload.request.invocationId;
  assert.equal(f.causeReviews(),1);f.close();owner=await f.open(B);
  const resolved=await owner.handle({...f.bound('fix_action'),fixOperation:'reconcile_review',invocationId});
  assert.equal(resolved.fixStage,'cause_review_evidence_required',JSON.stringify(resolved));assert.equal(f.causeReviews(),1);
  assert.equal((await owner.handle({...f.bound('fix_action'),fixOperation:'cause_review'})).fixStage,'red_test_required');assert.equal(f.causeReviews(),1);
});

test('QA optimization child inherits frozen policy and resumes original child without dispatch',async t=>{
  const f=await fixture(t,{optimized:true});let owner=await f.open(A,{template:true});
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
  assert.deepEqual(f.records()[0].payload.configuration.executionPolicy,EXECUTION_POLICY_V1);
  assert.equal((await owner.handle({...f.bound('fix_action'),fixOperation:'cause_review'})).fixStage,'red_test_required');
  f.close();const before=f.records();owner=await f.open(B);
  assert.equal((await owner.handle(f.bound('fix_status'))).fixStage,'red_test_required');assert.deepEqual(f.records(),before);assert.equal(f.causeReviews(),1);
});
test('QA optimization refuses retrofitting a legacy child before opening a store',async t=>{
  const f=await fixture(t,{optimized:true});delete f.fix.configuration.executionPolicy;
  await assert.rejects(f.open(A),{code:'execution_policy_legacy_child_inheritance_forbidden'});assert(!fs.existsSync(f.statePath));
});
