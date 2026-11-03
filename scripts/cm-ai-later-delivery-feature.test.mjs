// AI潮 specs7 (2026-11-03): every feature numbers its tasks from T-001, so a
// later reviewed delivery of another feature's T-005 was mistaken for a rerun of
// this run's own T-005 and dropped. The completed run then reported its shared
// files as unreviewed (correction_review_required) once QA was attached.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {completedReviewedDeliveries,sameDeliveryTask} from '../runtime/js/cm-ai/reviewed-deliveries.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-later-delivery-feature-'));
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

test('a later reviewed delivery of another feature\'s same-numbered task is adopted; a same-feature rerun is not',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'project-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  for(const feature of ['1.value','2.more']){
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
    for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Synthetic fixture');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement\n');
  }
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.value','2.more'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'shared.md'),'# Shared\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Synthetic requirements.');
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),'process.exit(0)');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const execution=({write,qa})=>({configuration:{kind:'synthetic-feature-delivery'},timeoutMs:2000,excludedContexts:['parent-host'],
    developer:{provider:'codex',requestedModel:'synthetic',contextId:'author',run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
      write();return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
      contexts:['review-1','review-2'],run:async(request,{onEvent})=>{
        events(onEvent,`synthetic-review-${request.identity.runId}`);
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['parent-host']},
    check:createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]}),
    qaLogHome:path.join(root,'logs'),qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:`qa-${binding.identity.runId}`,
      identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-11-03T01:00:00Z'})},
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
      const result=qa(),report=path.join(specsDir,'.reviews',`${binding.testRunId}.md`);
      fs.writeFileSync(report,`Synthetic QA ${result}`);
      return {result,passed:result==='PASS'?1:0,failed:result==='FAIL'?1:0,blocked:0,report};}},
    applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async binding=>({
      syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
      status:'completed',reason:'Synthetic documentation unchanged',at:'2026-11-03T02:00:00Z'})}});
  const identity={repositoryId:'fixture',runId:'feature1-T001',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature:'1.value',identity,scope:['shared.md'],requirements:['requirements.md']};
  const parentExecution=execution({write:()=>fs.writeFileSync(path.join(codeProject,'shared.md'),'# Shared\nfeature 1\n'),qa:()=>'FAIL'});
  let run=await openControlRun(definition,'create',parentExecution);
  let before;
  try{
    assert.equal((await run.host.handle({version:1,requestId:'p',operation:'advance',identity})).code,'qa_failed');
    before=await run.host.handle({version:1,requestId:'b',operation:'status',identity});
  }finally{run.close();}
  // Feature 2's own T-001 is reviewed later and appends to the same shared file.
  const laterIdentity={repositoryId:'fixture',runId:'feature2-T001',taskId:'T-001',attempt:1};
  const later=await openControlRun({version:1,specsDir,codeProject,feature:'2.more',identity:laterIdentity,
    scope:['shared.md'],requirements:['requirements.md']},'create',
    execution({write:()=>fs.appendFileSync(path.join(codeProject,'shared.md'),'feature 2\n'),qa:()=>'PASS'}));
  try{
    const done=await later.host.handle({version:1,requestId:'l',operation:'advance',identity:laterIdentity});
    assert.equal(done.code,'project_qa_not_passed',JSON.stringify(done));
  }finally{later.close();}

  // Discovery keys a task by its feature tasks.md and task id. Unknown stays conservative.
  const found=tasksPath=>completedReviewedDeliveries({specsRoot:specsDir,root:codeProject,identity,tasksPath}).map(item=>item.runId);
  assert.deepEqual(found(path.join(specsDir,'1.value','tasks.md')),['feature2-T001']);
  assert.deepEqual(found(path.join(specsDir,'2.more','tasks.md')),[],'a rerun of the same feature and task is never adopted');
  assert.deepEqual(found(null),[],'without a feature the historical task-id exclusion holds');

  run=await openControlRun(definition,'resume',parentExecution);
  try{
    const status=await run.host.handle({version:1,requestId:'s',operation:'status',identity});
    assert.notEqual(status.code,'correction_review_required',JSON.stringify(status));
    assert.deepEqual([status.state,status.code,status.pendingAction],[before.state,before.code,before.pendingAction]);
  }finally{run.close();}
});

test('sameDeliveryTask compares tasks.md only when both sides record one',()=>{
  const a='/specs/1.a/tasks.md',b='/specs/2.b/tasks.md';
  assert.equal(sameDeliveryTask({taskId:'T-005',tasksPath:a},{taskId:'T-005',tasksPath:b}),false);
  assert.equal(sameDeliveryTask({taskId:'T-005',tasksPath:a},{taskId:'T-005',tasksPath:a}),true);
  assert.equal(sameDeliveryTask({taskId:'T-005',tasksPath:null},{taskId:'T-005',tasksPath:b}),true);
  assert.equal(sameDeliveryTask({taskId:'T-005',tasksPath:a},{taskId:'T-006',tasksPath:a}),false);
});
