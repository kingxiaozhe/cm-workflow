import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';

for(const mode of ['history','retest','unknown','failed-retest','double-pass','double-fail','automatic','automatic-explicit','automatic-cancel','automatic-observation'])test(`real parent owner switches through child repair: ${mode}`,async()=>{
  const double=mode.startsWith('double-');
  const automatic=mode.startsWith('automatic');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-parent-fix-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.value';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  const identity={repositoryId:'fixture',runId:'parent-run',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['value.mjs'],requirements:['requirements.md']};
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),double?'Value should be 3.':'Value should be 2.');
  if(double)fs.writeFileSync(path.join(codeProject,'red-second.mjs'),"import {value} from './value.mjs';if(value!==3){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff',
    ...(automatic?{auto_fix:mode==='automatic-explicit'?'explicit':'auto'}:{})}}));
  for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Synthetic fixture');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement value\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  let developers=0,parentReviews=0,childReviews=0,repairs=0,qaRuns=0,parent=null,serial=null;
  const events=(onEvent,thread)=>{
    for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
      {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
  };
  const authority=createHostReviewAuthority({hostContextId:'parent-host',reviewerId:'reviewer',adapterId:'codex-review-adapter',decide:async()=>({status:'approved'})});
  const execution={configuration:{kind:'synthetic-parent-fix'},timeoutMs:2000,excludedContexts:['parent-host'],hostDecision:null,
    hostDecisionProvider:authority.hostDecisionProvider,
    developer:{provider:'codex',requestedModel:'synthetic',contextId:'author',run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
      developers++;fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
    }})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
      contexts:['parent-review-1','parent-review-2'],run:async(request,{onEvent})=>{
        parentReviews++;events(onEvent,'synthetic-parent-review');
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic parent review; QA exposes remaining defect'}};
      }}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['parent-host'],authorize:authority.authorize},
    check:createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]}),
    qaLogHome:path.join(root,'logs'),qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:'qa-parent',identity:binding.identity,packageDigest:binding.packageDigest,
      status:'triggered',reason:'feature_complete',score:null,at:'2026-09-08T01:00:00Z'})},
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
      qaRuns++;
      if(qaRuns>1){
        assert.equal(binding.qaRound,qaRuns);
        if(mode==='unknown')throw Error('Synthetic QA interruption');
        assert.equal(fs.readFileSync(path.join(codeProject,'value.mjs'),'utf8'),`export const value=${qaRuns};`);
        const report=path.join(specsDir,'.reviews',`qa-retest-${qaRuns}.md`);fs.writeFileSync(report,`Synthetic QA round ${qaRuns}.`);
        return mode==='failed-retest'||mode==='automatic-observation'||(double&&(qaRuns===2||mode==='double-fail'))?{result:'FAIL',passed:0,failed:1,blocked:0,report}
          :{result:'PASS',passed:1,failed:0,blocked:0,report};
      }
      const report=path.join(specsDir,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic QA: value 1 does not satisfy expected 2.');
      return {result:'FAIL',passed:0,failed:1,blocked:0,report};
    }},...(mode==='retest'||double||automatic?{applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async binding=>({
      syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
      status:'completed',reason:'Synthetic documentation unchanged',at:'2026-09-08T02:00:00Z'})}}:{})};
  const request=operation=>({version:1,requestId:operation,operation,identity});
  try{
    parent=await openControlRun(definition,'create',execution);
    const failed=await parent.host.handle(request('advance'));
    assert.equal(failed.code,'qa_failed',JSON.stringify(failed));
    const tasksPath=path.join(specsDir,feature,'tasks.md'),tasks=fs.readFileSync(tasksPath);
    assert(tasks.toString().includes('[x]'));
    const handoff=failed.fixHandoff,qaSource={feature,identity,packageDigest:failed.packageDigest,
      testRunId:handoff.source.testRunId,handoffDigest:handoff.handoffDigest};
    const childIdentity=qaFixIdentity(qaSource),permissions=['--allow-red-test','--allow-baseline','--allow-repair',
      '--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
    const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
      config_fingerprint:configFingerprint({cwd:codeProject,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}};
    const reviewHost=createFixReviewHost({codeProject,hostContextId:'parent-host',review,permissions,workerFactory:()=>async({prompt},{onEvent})=>{
      childReviews++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);events(onEvent,`synthetic-child-review-${childReviews}`);
      return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
        examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic independent child review'}};
    }});
    const configuration={hostContextId:'parent-host',qaSource,defect:'Value must be 2',causeReview:reviewHost.reviewer,
      reproduction:{cwd:codeProject,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd:codeProject,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      baseline:{cwd:codeProject,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
      repair:{scope:['value.mjs'],requirements:['requirements.md']},
      walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read value'],expected:['2'],kind:'commands',command:[process.execPath,'red.mjs']}]}};
    const makeSerial=(parent,childIdentity,configuration,repairValue)=>createQaFixOwnerHost({parent,reopenParent:()=>openControlRun(definition,'resume',execution),
      ...(double||automatic?{template:{specsRoot:specsDir,feature,identity,configuration:Object.fromEntries(Object.entries(configuration).filter(([key])=>key!=='qaSource'))}}
        :{fix:{specsRoot:specsDir,identity:childIdentity,configuration}}),allowStart:true,autoFix:automatic,fixPermissions:permissions,
      fixAuthorities:{authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority},fixExecution:{...reviewHost.execution,
        prepare:async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}}),
        bridge:{async call(kind){
          if(kind==='fix_diagnose'&&mode==='automatic-cancel'){
            assert.equal((await serial.handle(request('status'))).code,'qa_fix_active');
            await assert.rejects(serial.handle(request('advance')),{code:'host_busy'});
            await assert.rejects(serial.handle({...request('cancel'),identity:{...identity,runId:'wrong'}}),{code:'qa_fix_source_mismatch'});
            assert.equal((await serial.handle(request('cancel'))).code,'qa_fix_active');
          }
          if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['value'],
            plan:`Change ${repairValue-1} to ${repairValue}`,crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
          if(kind==='fix_repair'){repairs++;fs.writeFileSync(path.join(codeProject,'value.mjs'),`export const value=${repairValue};`);return {outcome:'repaired'};}
          if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
          throw Error(`Unexpected host capability: ${kind}`);
        }}}});
    serial=makeSerial(parent,childIdentity,configuration,2);parent=null;
    if(automatic){
      const result=await serial.handle(request('advance'));
      const expected=mode==='automatic'?'run_done':mode==='automatic-explicit'?'qa_failed':'qa_fix_incomplete';
      assert.equal(result.code,expected,JSON.stringify(result));
      if(mode==='automatic-cancel')assert.equal(result.fixStage,'cancelled');
      if(mode==='automatic-observation')assert.equal(result.fixStage,'observation');
      const repaired=['automatic','automatic-observation'].includes(mode);
      assert.equal(qaRuns,repaired?2:1);
      assert.equal(repairs,repaired?1:0);assert.equal(childReviews,repaired?1:0);
      assert.deepEqual(fs.readFileSync(tasksPath),tasks);
      const again=await serial.handle(request('advance'));
      assert.equal(again.code,expected,JSON.stringify(again));
      assert.equal(qaRuns,repaired?2:1);assert.equal(developers,1);assert.equal(parentReviews,1);
      return;
    }
    const bound={...request('fix_advance'),packageDigest:failed.packageDigest,testRunId:qaSource.testRunId};
    assert.equal((await serial.handle(bound)).fixStage,'red_test_required');
    let result;
    for(const fixOperation of ['red_test','baseline','repair','regression','retrospective','handoff','final_review',
      'publish_review','check_n5','post_review_regression','walkthrough','finish']){
      result=await serial.handle({...bound,operation:'fix_action',fixOperation});
      assert.notEqual(result.fixStage,'unknown',`${fixOperation}: ${JSON.stringify(result)}`);
      if(fixOperation==='repair')assert.equal((await serial.handle(request('status'))).code,'correction_review_required');
    }
    assert.equal(result.code,'qa_fix_completed',JSON.stringify(result));
    assert.equal(result.association.kind,'cm-fix-code-association');
    assert.equal(result.association.parentPackageDigest,failed.packageDigest);
    assert.equal(result.association.fixPackageDigest,result.evidence.reviewPackage.packageDigest);
    assert.equal(result.accepted.qaRound,1);
    assert.deepEqual(result.accepted.evidence,result.evidence);
    assert.deepEqual(result.evidence.qaSource,qaSource);
    assert.equal(result.evidence.identity.runId,childIdentity.runId);
    assert.deepEqual((await serial.handle({...bound,operation:'fix_status'})).evidence,result.evidence);
    const resumed=await serial.handle(request('status'));
    assert.equal(resumed.state,'fixture_completed');assert.equal(resumed.code,null);
    assert.equal(resumed.packageDigest,failed.packageDigest);assert.deepEqual(fs.readFileSync(tasksPath),tasks);
    assert.equal(qaRuns,1);
    assert.equal(developers,1);assert.equal(parentReviews,1);assert.equal(childReviews,1);assert.equal(repairs,1);
    serial.close();serial=null;
    parent=await openControlRun(definition,'resume',execution);
    const acceptedRevision=parent.checkpoint();
    assert.deepEqual(parent.acceptCompletedFix(result.evidence),result.accepted);
    assert.equal(parent.checkpoint(),acceptedRevision); // Resume/idempotence, not a second acceptance.
    assert.equal((await parent.host.handle(request('status'))).code,null);
    assert.equal(parent.checkpoint(),acceptedRevision); // Status remains read-only.
    parent.close();parent=null;
    if(double){
      parent=await openControlRun(definition,'resume',execution);
      const secondFailure=await parent.host.handle(request('advance'));
      assert.equal(secondFailure.code,'qa_failed');assert.equal(secondFailure.fixHandoff.source.qaRound,2);
      const nextSource={feature,identity,packageDigest:failed.packageDigest,
        testRunId:secondFailure.fixHandoff.source.testRunId,handoffDigest:secondFailure.fixHandoff.handoffDigest};
      const nextIdentity=qaFixIdentity(nextSource);
      const nextConfiguration={...configuration,qaSource:nextSource,defect:'Remaining defect: value must be 3',
        reproduction:{...configuration.reproduction,command:[process.execPath,'red-second.mjs']},
        redTest:{...configuration.redTest,testFiles:['red-second.mjs'],command:[process.execPath,'red-second.mjs']},
        walkthrough:{...configuration.walkthrough,flows:[{...configuration.walkthrough.flows[0],
          expected:['3'],command:[process.execPath,'red-second.mjs']}]}};
      serial=makeSerial(parent,nextIdentity,nextConfiguration,3);parent=null;
      const nextBound={...bound,testRunId:nextSource.testRunId};
      const second=await serial.handle({...nextBound,operation:'fix_run'});
      assert.equal(second.code,'qa_fix_completed',JSON.stringify(second));assert.equal(second.accepted.qaRound,2);
      serial.close();serial=null;
      parent=await openControlRun(definition,'resume',execution);
      assert.deepEqual(parent.acceptCompletedFix(second.evidence),second.accepted);
      const third=await parent.host.handle(request('advance'));
      assert.equal(third.code,mode==='double-pass'?'run_done':'qa_failed',JSON.stringify(third));
      if(mode==='double-fail'){
        assert.equal(third.fixHandoff.source.qaRound,3);
        assert.equal(third.fixHandoff.status,'blocked');assert.equal(third.fixHandoff.reason,'qa_round_limit');
      }
      assert.equal(qaRuns,3);assert.equal(repairs,2);assert.equal(childReviews,2);
      parent.close();parent=await openControlRun(definition,'resume',execution);
      assert.equal((await parent.host.handle(request('advance'))).code,third.code);
      assert.equal(qaRuns,3);assert.deepEqual(fs.readFileSync(tasksPath),tasks);
      assert.equal(developers,1);assert.equal(parentReviews,1);
      return;
    }
    if(mode!=='history'){
      parent=await openControlRun(definition,'resume',execution);
      const retested=await parent.host.handle(request('advance'));
      assert.equal(retested.code,mode==='unknown'?'invalid_input':mode==='failed-retest'?'qa_failed':'run_done',JSON.stringify(retested));
      if(mode==='failed-retest')assert.equal(retested.fixHandoff.source.qaRound,2);
      assert.equal(qaRuns,2);
      parent.close();parent=await openControlRun(definition,'resume',execution);
      const repeated=await parent.host.handle(request('advance'));
      assert.equal(repeated.code,mode==='unknown'?'qa_execution_unknown':mode==='failed-retest'?'qa_failed':'run_done',JSON.stringify(repeated));
      assert.equal(qaRuns,2);assert.deepEqual(fs.readFileSync(tasksPath),tasks);
      fs.writeFileSync(path.join(codeProject,'value.mjs'),'unreviewed drift');
      assert.equal((await parent.host.handle(request('advance'))).code,'correction_review_required');
      assert.equal(qaRuns,2);
      return;
    }
    // A later QA must not erase the prior completed child's evidence. Use the
    // existing log writer; this is not automatic parent re-QA implementation.
    const nextQa={specsDir,codeProject,feature,identity,packageDigest:failed.packageDigest,
      testRunId:'qa-round-two',qaRound:2,mode:'commands',caseCount:1,logHome:path.join(root,'logs')};
    recordCmAiQaRun({...nextQa,phase:'start'});
    const childOptions={specsRoot:specsDir,identity:childIdentity,configuration,create:false};
    let reopened=openFixExecution(childOptions);
    try{
      assert.deepEqual(reopened.completionEvidence(),result.evidence);
      const host=createFixHost({owner:reopened,config:{...configuration,specsRoot:specsDir,identity:childIdentity},permissions:['--allow-reproduction']});
      assert.deepEqual(await host.handle({requestId:'history',operation:'completion_evidence'}),result.evidence);
      await assert.rejects(host.handle({requestId:'stale-action',operation:'advance'}),{code:'qa_result_stale'});
    }finally{reopened.close();}
    const passedReport=path.join(specsDir,'.reviews','qa-second.md');fs.writeFileSync(passedReport,'Synthetic second round PASS');
    recordCmAiQaRun({...nextQa,phase:'complete',result:{result:'PASS',passed:1,failed:0,blocked:0,report:passedReport}});
    reopened=openFixExecution(childOptions);
    try{assert.deepEqual(reopened.completionEvidence(),result.evidence);}finally{reopened.close();}
    fs.appendFileSync(handoff.source.report,'tampered historical report');
    assert.throws(()=>openFixExecution(childOptions),{code:'fix_qa_source_changed'});
  }finally{serial?.close();parent?.close();fs.rmSync(root,{recursive:true,force:true});}
});
