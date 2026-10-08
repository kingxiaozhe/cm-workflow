// A standalone cm-fix run that changed a completed cm-ai task's files, was
// independently reviewed and closed normally, is a later reviewed delivery of
// that task's code root (2026-10-08, AI潮 author-column-T-010 after
// api-native-reading-fix-story-return: --rerun-blocked-qa stopped at
// correction_review_required naming only the fix's reviewed files).
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {completedReviewedDeliveries} from '../runtime/js/cm-ai/reviewed-deliveries.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-run-delivery-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const events=(onEvent,thread)=>{
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
};

// A cm-ai task completes (value 0 -> 1, QA PASS, run_done); then a standalone
// cm-fix run in the same specs and code root repairs value 1 -> 2, stopping
// before or after its normal closeout.
async function completedTaskThenFix({finish}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'project-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  fs.mkdirSync(path.join(specsDir,'1.value'),{recursive:true});
  for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,'1.value',`${name}.md`),'# Synthetic fixture');
  fs.writeFileSync(path.join(specsDir,'1.value','tasks.md'),'- [ ] T-001: implement\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.value'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Value should be 2.');
  fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const authority=createHostReviewAuthority({hostContextId:'parent-host',reviewerId:'reviewer',adapterId:'codex-review-adapter',
    decide:async()=>({status:'approved'})});
  const execution={configuration:{kind:'synthetic-parent'},timeoutMs:2000,excludedContexts:['parent-host'],hostDecision:null,
    hostDecisionProvider:authority.hostDecisionProvider,
    developer:{provider:'codex',requestedModel:'synthetic',contextId:'author',run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
      fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
      contexts:['parent-review-1','parent-review-2'],run:async(request,{onEvent})=>{
        events(onEvent,`synthetic-review-${request.identity.runId}`);
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['parent-host'],authorize:authority.authorize},
    check:createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]}),
    qaLogHome:path.join(root,'logs'),qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:`qa-${binding.identity.runId}`,
      identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-10-08T01:00:00Z'})},
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
      const report=path.join(specsDir,'.reviews',`${binding.testRunId}.md`);fs.writeFileSync(report,'Synthetic QA PASS');
      return {result:'PASS',passed:1,failed:0,blocked:0,report};}},
    applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async binding=>({
      syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
      status:'completed',reason:'Synthetic documentation unchanged',at:'2026-10-08T02:00:00Z'})}};
  const identity={repositoryId:'fixture',runId:'parent-run',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature:'1.value',identity,scope:['value.mjs'],requirements:['requirements.md']};
  const parent=await openControlRun(definition,'create',execution);
  try{assert.equal((await parent.host.handle({version:1,requestId:'first',operation:'advance',identity})).code,'run_done');}
  finally{parent.close();}

  const fixIdentity={repositoryId:'fixture',runId:'story-fix',taskId:'T-FIX-story-fix',attempt:1};
  const permissions=['--allow-reproduction','--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
  const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'synthetic',disabledSkills:[]})}};
  let reviews=0;
  const reviewHost=createFixReviewHost({codeProject,hostContextId:'fix-host',review,permissions,workerFactory:()=>async({prompt},{onEvent})=>{
    reviews++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);events(onEvent,`synthetic-fix-review-${reviews}`);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
      findings:[],summary:'Synthetic independent fix review'}};}});
  const config={identity:fixIdentity,defect:'Value must be 2',
    reproduction:{cwd:codeProject,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd:codeProject,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd:codeProject,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['requirements.md']},
    walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read value'],expected:['2'],kind:'commands',command:[process.execPath,'red.mjs']}]}};
  const configuration={hostContextId:'fix-host',...config,causeReview:reviewHost.reviewer};delete configuration.identity;
  const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}};
  const bridge={async call(kind){
    if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',plan:'Change 1 to 2',affectedPaths:['value.mjs'],
      affectedModules:['value'],crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
    if(kind==='fix_repair'){fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    throw Error(kind);
  }};
  const owner=openFixExecution({specsRoot:specsDir,identity:fixIdentity,configuration,create:true},{...reviewHost.execution,bridge,prepare:async()=>learning});
  try{
    const host=createFixHost({owner,config:{...config,specsRoot:specsDir},permissions,authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority});
    for(const operation of ['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review','publish_review',
      'check_n5','post_review_regression','walkthrough',...(finish?['finish']:[])]){
      const result=await host.handle({requestId:operation,operation});assert(!result?.error,`${operation}: ${JSON.stringify(result)}`);
    }
    assert.equal(owner.status().stage,finish?'completed':'closeout_required');
  }finally{owner.close();}
  assert(reviews>=1);
  const status=async()=>{const run=await openControlRun(definition,'resume',execution);
    try{return await run.host.handle({version:1,requestId:`status-${Math.random()}`,operation:'status',identity});}finally{run.close();}};
  return {codeProject,specsDir,identity,status};
}

test('a completed, independently reviewed cm-fix run is a later reviewed delivery; an unreviewed edit is still refused',{timeout:120000},async()=>{
  const {codeProject,specsDir,identity,status}=await completedTaskThenFix({finish:true});
  const deliveries=completedReviewedDeliveries({specsRoot:specsDir,root:codeProject,identity});
  assert.deepEqual(deliveries.map(item=>[item.runId,item.taskId,item.packages.map(entry=>entry.pkg.changes.map(change=>change.path))]),
    [['story-fix','T-FIX-story-fix',[['value.mjs']]]]);
  assert(Number.isSafeInteger(deliveries[0].packages[0].reviewedAt));
  const accepted=await status();
  assert.equal(accepted.state,'fixture_completed');assert.equal(accepted.code,null,JSON.stringify(accepted));
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(value!==2)process.exit(1)");
  const refused=await status();
  assert.equal(refused.code,'correction_review_required');assert.equal(refused.reason,'未经审查的改动：existing.mjs');
});

test('a cm-fix run that has not reached its normal completed closeout is not a reviewed delivery',{timeout:120000},async()=>{
  const {codeProject,specsDir,identity,status}=await completedTaskThenFix({finish:false});
  assert.deepEqual(completedReviewedDeliveries({specsRoot:specsDir,root:codeProject,identity}),[]);
  const refused=await status();
  assert.equal(refused.code,'correction_review_required');assert.equal(refused.reason,'未经审查的改动：value.mjs');
});
