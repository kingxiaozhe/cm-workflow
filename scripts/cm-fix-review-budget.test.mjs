// #15: cm-fix reviews wait for their own budget, record a timeout, and survive a
// host killed mid-review through one audited abandonment.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import {buildCmAiDriveRequest} from './cm-ai-drive.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-review-budget-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const moduleUrl=relative=>new URL(relative,import.meta.url).href;
const identity={repositoryId:'fixture',runId:'cause-budget-run',taskId:'T-FIX-cause',attempt:1};
const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',
  contextId:'logical-review',excludedThreadIds:['other-author']};
const diagnosis={status:'diagnosed',rootCause:'Cross-layer constant',plan:'Correct after red test',affectedPaths:['value.mjs'],
  affectedModules:['value'],crossLayer:true};

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'run-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  // The reproduction budget deliberately differs from the review budget below.
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Synthetic value mismatch',causeReview:reviewer,
    reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:3000}}};
  const authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>({status:'approved'})});
  const state={calls:0,hang:true};
  const run=createCauseReviewRun(async({prompt},{onEvent})=>{
    state.calls++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    onEvent({event:'thread.started',provider_thread:`fresh-review-${state.calls}`});
    if(state.hang)return new Promise(()=>{});
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'No finding in synthetic package'}};
  },'codex');
  const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  return {root,cwd,specsRoot,options,authority,state,run,statePath,records:()=>JSON.parse(fs.readFileSync(statePath)).records,
    bridge:{async call(){return diagnosis;}}};
}
async function decide(f,owner){
  const pkg=owner.causeReviewPackage();
  await f.authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
}

test('#15 the cause review waits for its own budget, then records the timeout instead of stopping at unknown forever',async()=>{
  const f=fixture(),causeReview={authorize:f.authority.authorize,run:f.run,timeoutMs:1000};
  let owner=openFixExecution(f.options,{causeReview,bridge:f.bridge});
  try{
    assert.equal((await owner.advance({authorized:true})).stage,'cause_review_required');
    await decide(f,owner);const started=Date.now();
    const timedOut=await owner.reviewCause();
    const elapsed=Date.now()-started;
    assert(elapsed>=950&&elapsed<2500,`the review budget (1000 ms), not the reproduction budget (3000 ms), applies: ${elapsed}`);
    assert.equal(timedOut.stage,'unknown');assert.equal(timedOut.pending,null);
    assert.equal(timedOut.causeReview.code,'transport_timeout');assert.equal(timedOut.reviewAbandonable,'cause_review');
    assert.deepEqual(f.records().map(row=>row.id).filter(id=>id.startsWith('fix-cause')),
      ['fix-cause-registered','fix-cause-started','fix-cause-result']);
    owner.close();owner=openFixExecution({...f.options,create:false},{causeReview,bridge:f.bridge});
    const result=f.records().find(row=>row.id==='fix-cause-result');
    const abandoned=owner.abandonReview({authorized:true,reason:'Reviewer exceeded its budget and was stopped'});
    assert.equal(abandoned.stage,'cause_review_required');
    assert.equal(abandoned.causeReviewAbandonment.resultDigest.length,64);
    assert.equal(abandoned.causeReviewAbandonment.providerThreadId,'fresh-review-1');
    assert.notEqual(result,undefined);
    f.state.hang=false;await decide(f,owner);
    assert.equal((await owner.reviewCause()).stage,'red_test_required');assert.equal(f.state.calls,2);
  }finally{owner.close();}
});

test('#15 a host killed during the cause review leaves an abandonable registration, and the retry completes',async()=>{
  const f=fixture();
  // The child is a real separate host process: it registers and starts the
  // review, then is killed before any result is written.
  const child=spawn(process.execPath,['--input-type=module','-e',`
    const {openFixExecution}=await import(${JSON.stringify(moduleUrl('../runtime/js/cm-fix/execution.mjs'))});
    const {createHostReviewAuthority}=await import(${JSON.stringify(moduleUrl('../runtime/js/cm-ai/host-review-authority.mjs'))});
    const {createCauseReviewRun}=await import(${JSON.stringify(moduleUrl('../runtime/js/cm-ai/codex-review-adapter.mjs'))});
    const options=${JSON.stringify(f.options)},reviewer=options.configuration.causeReview;
    const authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
    const run=createCauseReviewRun(async(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'killed-review'});
      process.stdout.write('STARTED\\n');return new Promise(()=>{});},'codex');
    const owner=openFixExecution(options,{causeReview:{authorize:authority.authorize,run,timeoutMs:600000},
      bridge:{async call(){return ${JSON.stringify(diagnosis)};}}});
    await owner.advance({authorized:true});const pkg=owner.causeReviewPackage();
    await authority.hostDecisionProvider.decide({identity:options.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    await owner.reviewCause();`],{env:process.env,stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{if(String(chunk).includes('STARTED'))resolve();});
    child.on('exit',code=>reject(new Error(`child exited early: ${code}`)));
  });
  const exited=new Promise(resolve=>child.on('exit',resolve));child.kill('SIGKILL');await exited;
  assert.deepEqual(f.records().map(row=>row.id).filter(id=>id.startsWith('fix-cause')),['fix-cause-registered','fix-cause-started']);
  f.state.hang=false;
  const owner=openFixExecution({...f.options,create:false},{causeReview:{authorize:f.authority.authorize,run:f.run,timeoutMs:5000},bridge:f.bridge});
  try{
    const stuck=owner.status();
    assert.equal(stuck.stage,'unknown');assert.equal(stuck.pending,'cause_review');assert.equal(stuck.reviewAbandonable,'cause_review');
    assert.equal(owner.abandonReview({authorized:true,reason:'Host process was killed; reviewer confirmed gone'}).stage,'cause_review_required');
    await decide(f,owner);
    assert.equal((await owner.reviewCause()).stage,'red_test_required');
    assert.equal(f.records().find(row=>row.id==='fix-cause-retry-started').payload.providerThreadId,'fresh-review-1');
  }finally{owner.close();}
});

test('#15 the shipped review host hands its review budget to the owner and the reviewer worker',()=>{
  const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'host-')));
  const review=timeoutMs=>({model:'synthetic',disabledSkills:[],...(timeoutMs?{timeoutMs}:{}),preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}});
  const seen=[];
  const host=(timeoutMs,executionPolicy=null)=>createFixReviewHost({codeProject,hostContextId:'host',review:review(timeoutMs),executionPolicy,permissions:['--allow-cause-review'],
    workerFactory:options=>{seen.push(options.timeoutMs);return async()=>({status:'failed',code:'unused'});}});
  const configured=host(1234).execution;
  assert.equal(configured.causeReview.timeoutMs,1234);assert.equal(configured.finalReview.timeoutMs,1234);
  const defaulted=host(null).execution;
  assert.equal(defaulted.causeReview.timeoutMs,900000);assert.equal(defaulted.finalReview.timeoutMs,900000);
  // The worker is built with the budget before the adapter validates the request.
  assert.throws(()=>configured.causeReview.run({},{signal:new AbortController().signal,onEvent:()=>true}),{code:'invalid_input'});
  assert.deepEqual(seen,[1234]);
  const optimized=host(1234,EXECUTION_POLICY_V1).execution;
  assert.throws(()=>optimized.causeReview.run({},{signal:new AbortController().signal,onEvent:()=>true}),{code:'invalid_input'});
  assert.throws(()=>optimized.finalReview.run({},{signal:new AbortController().signal,onEvent:()=>true}),{code:'invalid_input'});
  assert.deepEqual(seen,[1234,1234,1234]);
  assert.equal(fs.existsSync(path.join(isolated,'logs')),false);
});

test('#15 the cm-ai driver forwards the QA-fix abandon_review reason inside fix_action',()=>{
  const plan={packageDigest:'a'.repeat(64),testRunId:'qa-run',fixOperation:'abandon_review',reason:'Child reviewer stopped'};
  const identity={repositoryId:'r',runId:'run',taskId:'T-1',attempt:1};
  assert.deepEqual(buildCmAiDriveRequest('fix_action',plan,{identity}),{version:1,identity,packageDigest:plan.packageDigest,
    testRunId:plan.testRunId,fixOperation:'abandon_review',reason:plan.reason});
});

test('Q23 the cm-ai driver forwards the new QA-fix recovery fields inside fix_action',()=>{
  const identity={repositoryId:'r',runId:'run',taskId:'T-1',attempt:1},base={packageDigest:'a'.repeat(64),testRunId:'qa-run'};
  for(const fixOperation of ['rediagnose','rerun_blocked_step'])
    assert.deepEqual(buildCmAiDriveRequest('fix_action',{...base,fixOperation,reason:'理由'},{identity}),
      {version:1,identity,...base,fixOperation,reason:'理由'});
  const recover={...base,fixOperation:'recover_final_review',invocationId:'final-1',reviewPackageDigest:'b'.repeat(64),
    previousInvocationStopped:true,reason:'旧审查已停'};
  assert.deepEqual(buildCmAiDriveRequest('fix_action',recover,{identity}),{version:1,identity,...base,fixOperation:'recover_final_review',
    reason:'旧审查已停',invocationId:'final-1',reviewPackageDigest:'b'.repeat(64),previousInvocationStopped:true});
  assert.deepEqual(buildCmAiDriveRequest('fix_action',{...base,fixOperation:'revision_test_check'},{identity}),
    {version:1,identity,...base,fixOperation:'revision_test_check'});
});
