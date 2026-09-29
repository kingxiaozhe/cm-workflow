// #17/#18: the project is refused run_done while feature 1's QA FAILs; its QA
// fix is still accepted after a later, separately reviewed task changed the tree.
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
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readProjectInstructionContext} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {attemptBaseline,readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {validateAcceptedFix} from '../runtime/js/cm-ai/accepted-fix.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {composeFixCode,inspectFixCodeAssociation} from '../runtime/js/cm-ai/fix-code-association.mjs';
import {approvedReviewAt,fixReviewedAt,verifyDeliverySteps} from '../runtime/js/cm-ai/reviewed-deliveries.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-later-delivery-'));
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

// The later task is reviewed before the QA fix, so in both variants it is the
// fix's recorded preceding step (v1 -> later -> fix). shared: it also rewrites
// the earlier task's value.mjs, so the fix's own before-state depends on it.
for(const variant of ['separate','shared'])test(`#18 a QA fix for an earlier feature is accepted after a later reviewed task (${variant}); #17 the project reaches run_done only then`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'project-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  for(const [feature,task] of [['1.value','T-001'],['2.more','T-002']]){
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
    for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Synthetic fixture');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),`- [ ] ${task}: implement\n`);
  }
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.value','2.more'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Value should be 2.');
  fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  let qaRuns=0,childReviews=0,documentation=0;
  const execution=({feature,write,retrospective={status:'no_new_lesson',candidates:[],reason:null},qa})=>{
    const authority=createHostReviewAuthority({hostContextId:'parent-host',reviewerId:'reviewer',adapterId:'codex-review-adapter',
      decide:async()=>({status:'approved'})});
    return {configuration:{kind:'synthetic-parent-fix'},timeoutMs:2000,excludedContexts:['parent-host'],hostDecision:null,
      hostDecisionProvider:authority.hostDecisionProvider,
      developer:{provider:'codex',requestedModel:'synthetic',contextId:'author',run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
        write();return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective}};}})},
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
        contexts:['parent-review-1','parent-review-2'],run:async(request,{onEvent})=>{
          events(onEvent,`synthetic-review-${request.identity.runId}`);
          return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};}}],
      reviewInvocation:{developerThreadId:'author',excludedThreadIds:['parent-host'],authorize:authority.authorize},
      check:createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]}),
      qaLogHome:path.join(root,'logs'),qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:`qa-${binding.identity.runId}`,
        identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-28T01:00:00Z'})},
      qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
        const result=qa(binding),report=path.join(specsDir,'.reviews',`${binding.testRunId}.md`);
        fs.writeFileSync(report,`Synthetic QA ${result}`);
        return {result,passed:result==='PASS'?1:0,failed:result==='FAIL'?1:0,blocked:0,report};}},
      applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async binding=>{documentation++;return {
        syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
        status:'completed',reason:'Synthetic documentation unchanged',at:'2026-09-28T02:00:00Z'};}}};
  };
  const identity={repositoryId:'fixture',runId:'parent-run',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature:'1.value',identity,scope:['value.mjs'],requirements:['requirements.md']};
  const parentExecution=execution({feature:'1.value',write:()=>fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;'),
    qa:()=>(++qaRuns===1?'FAIL':'PASS')});
  const request=operation=>({version:1,requestId:operation,operation,identity});
  let parent=null,serial=null;
  try{
    parent=await openControlRun(definition,'create',parentExecution);
    const failed=await parent.host.handle(request('advance'));
    assert.equal(failed.code,'qa_failed',JSON.stringify(failed));
    parent.close();parent=null;
    // The later task of another feature lands first: a reviewed AGENTS.md lesson and a new file.
    const laterIdentity={repositoryId:'fixture',runId:'later-run',taskId:'T-002',attempt:1};
    const laterDefinition={version:1,specsDir,codeProject,feature:'2.more',identity:laterIdentity,
      scope:variant==='shared'?['more.mjs','value.mjs']:['more.mjs'],requirements:['requirements.md']};
    const laterExecution=execution({feature:'2.more',write:()=>{fs.writeFileSync(path.join(codeProject,'more.mjs'),'export const more=1;');
      if(variant==='shared')fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1; // shared with a later task');},
      retrospective:{status:'lesson_candidate',reason:null,candidates:[{classification:'structured',trigger:'Later lesson',
        action:'Keep value constants in one module',evidence:['more.mjs']}]},qa:()=>'PASS'});
    let later=await openControlRun(laterDefinition,'create',laterExecution);
    const refused=await later.host.handle({version:1,requestId:'later',operation:'advance',identity:laterIdentity});later.close();
    assert.equal(refused.code,'project_qa_not_passed',JSON.stringify(refused));
    assert.deepEqual(refused.outstandingQa.map(item=>[item.feature,item.runId,item.status]),[['1.value','parent-run','qa_failed']]);
    assert.equal(documentation,0);
    assert(fs.readFileSync(path.join(codeProject,'AGENTS.md'),'utf8').includes('Later lesson'));
    // Back to feature 1: repair its QA failure through the original child owner.
    const qaSource={feature:'1.value',identity,packageDigest:failed.packageDigest,testRunId:failed.fixHandoff.source.testRunId,
      handoffDigest:failed.fixHandoff.handoffDigest};
    const childIdentity=qaFixIdentity(qaSource),permissions=['--allow-red-test','--allow-baseline','--allow-repair',
      '--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
    const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
      config_fingerprint:configFingerprint({cwd:codeProject,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}};
    const reviewHost=createFixReviewHost({codeProject,hostContextId:'parent-host',review,permissions,workerFactory:()=>async({prompt},{onEvent})=>{
      childReviews++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);events(onEvent,`synthetic-child-review-${childReviews}`);
      return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
        examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic independent child review'}};}});
    const configuration={hostContextId:'parent-host',qaSource,defect:'Value must be 2',causeReview:reviewHost.reviewer,
      reproduction:{cwd:codeProject,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd:codeProject,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      baseline:{cwd:codeProject,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
      repair:{scope:['value.mjs'],requirements:['requirements.md']},
      walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read value'],expected:['2'],kind:'commands',command:[process.execPath,'red.mjs']}]}};
    parent=await openControlRun(definition,'resume',parentExecution);
    serial=createQaFixOwnerHost({parent,hostContextId:'parent-host',parentHostContextId:'parent-host',
      reopenParent:()=>openControlRun(definition,'resume',parentExecution),fix:{specsRoot:specsDir,identity:childIdentity,configuration},
      allowStart:true,fixPermissions:permissions,fixAuthorities:{authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority},
      fixExecution:{...reviewHost.execution,
        // The child rereads the project instructions, now including the later lesson.
        prepare:async()=>{const files=readProjectInstructionContext(codeProject).map(({content,...metadata})=>metadata),contextDigest=digest(files);
          return {files,contextDigest,application:{contextDigest,status:'no_relevant_lesson',summary:'Fixture'}};},
        bridge:{async call(kind){
          if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['value'],
            plan:'Change 1 to 2',crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
          if(kind==='fix_repair'){fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
          if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
          throw Error(`Unexpected host capability: ${kind}`);
        }}}});
    parent=null;
    // The earlier run is not locked by the later reviewed delivery.
    assert.equal((await serial.handle(request('status'))).code,null);
    const bound={...request('fix_advance'),packageDigest:failed.packageDigest,testRunId:qaSource.testRunId};
    assert.equal((await serial.handle(bound)).fixStage,'red_test_required');
    let result;
    for(const fixOperation of ['red_test','baseline','repair','regression','retrospective','handoff','final_review',
      'publish_review','check_n5','post_review_regression','walkthrough','finish']){
      result=await serial.handle({...bound,operation:'fix_action',fixOperation});
      assert.notEqual(result.fixStage,'unknown',`${fixOperation}: ${JSON.stringify(result)}`);
    }
    assert.equal(result.code,'qa_fix_completed',JSON.stringify(result));
    assert.equal(result.accepted.qaRound,1);
    const association=result.accepted.association;
    assert.equal(association.version,2);
    assert.deepEqual(association.laterDeliveries.map(step=>[step.beforeFix,step.runId,step.changes.map(change=>change.path).sort()]),
      [[0,'later-run',['AGENTS.md','more.mjs',...(variant==='shared'?['value.mjs']:[])]]]);
    serial.close();serial=null;
    // Durable replay reproduces the association from the journal alone.
    const state=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',identity.runId,'state.json')));
    const history=readRunnerHistory(state.records,state.records[0].payload.config,3);
    const accepted=state.records.find(row=>row.payload.type==='qa-fix-accepted').payload.record;
    const check=record=>validateAcceptedFix({record,previous:[],baseline:attemptBaseline(history.original,history.state.attempt),
      parentPackage:history.state.reviewPackage,feature:'1.value'});
    check(accepted);
    if(variant==='shared'){
      // The recorded step is re-proved against the real later run's store, and only
      // as a delivery reviewed after this run's own approving review.
      const proof=after=>verifyDeliverySteps({specsRoot:specsDir,root:codeProject,identity,after,steps:accepted.association.laterDeliveries});
      proof(approvedReviewAt(history.state));
      assert.throws(()=>proof(Number.MAX_SAFE_INTEGER-1),{code:'fix_association_unverified'});
      // The fix's own place in the order is the final review registration its
      // evidence cites, for exactly its package.
      assert.ok(Number.isSafeInteger(fixReviewedAt(specsDir,accepted.evidence)));
      assert.equal(fixReviewedAt(specsDir,{...accepted.evidence,reviewPackage:{...accepted.evidence.reviewPackage,packageDigest:'0'.repeat(64)}}),null);
      const stripped=structuredClone(accepted);stripped.association={...stripped.association,version:1};delete stripped.association.laterDeliveries;
      assert.throws(()=>check(stripped),{code:'fix_before_mismatch'});
      const forged=structuredClone(accepted);forged.association.laterDeliveries[0].changes.find(change=>change.path==='value.mjs').after.sha256='0'.repeat(64);
      assert.throws(()=>check(forged));
    }
    parent=await openControlRun(definition,'resume',parentExecution);
    const done=await parent.host.handle(request('advance'));
    assert.equal(done.code,'run_done',JSON.stringify(done));assert.equal(qaRuns,2);
    parent.close();parent=null;
    later=await openControlRun(laterDefinition,'resume',laterExecution);
    const finished=await later.host.handle({version:1,requestId:'later-again',operation:'advance',identity:laterIdentity});later.close();
    assert.equal(finished.code,'run_done',JSON.stringify(finished));
    if(variant==='shared'){
      // A forged journal step with every digest recomputed must not pass: the
      // record chain, association and composition are all made self-consistent.
      const statePath=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json'),original=fs.readFileSync(statePath);
      const forge=mutate=>{
        const saved=JSON.parse(original);const records=structuredClone(saved.records);
        const index=records.findIndex(row=>row.payload.type==='qa-fix-accepted'),record=records[index].payload.record;
        mutate(record.association.laterDeliveries);
        record.association.currentFilesDigest=digest(composeFixCode({baseline:attemptBaseline(history.original,history.state.attempt),
          parentPackage:history.state.reviewPackage,fixPackages:[record.evidence.reviewPackage],steps:record.association.laterDeliveries}).files);
        check(record);
        for(let at=index;at<records.length;at++){
          const {digest:ignored,...body}=records[at];body.previousDigest=at?records[at-1].digest:null;records[at]={...body,digest:digest(body)};
        }
        const {revision,...body}=saved,next={...body,records};
        fs.writeFileSync(statePath,JSON.stringify({...next,revision:digest(next)})+'\n');
      };
      const status=async()=>{const run=await openControlRun(definition,'resume',parentExecution);
        try{return await run.host.handle(request('status'));}finally{run.close();}};
      try{
        // A run that does not exist: replay cannot re-prove it, every live use refuses it.
        forge(steps=>{steps[0].runId='ghost-run';steps[0].packageDigest='e'.repeat(64);});
        const ghost=await status();
        assert.equal(ghost.code,'correction_review_required');assert.match(ghost.reason,/无法按其运行存档核实/);
        // The real run with a package it never reviewed, or a step not derivable from its package.
        forge(steps=>{steps[0].packageDigest='f'.repeat(64);});
        await assert.rejects(openControlRun(definition,'resume',parentExecution),{code:'fix_association_unverified'});
        forge(steps=>{steps[0].changes=steps[0].changes.filter(change=>change.path!=='AGENTS.md');});
        await assert.rejects(openControlRun(definition,'resume',parentExecution),{code:'fix_association_unverified'});
      }finally{fs.writeFileSync(statePath,original);}
      assert.equal((await status()).code,null);
    }
  }finally{serial?.close();parent?.close();}
});

// Two files x.mjs/y.mjs; each writer captures its own baseline first, so its
// package records the reviewed before-state it actually saw.
function unitRoot(prefix,files){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,prefix)));
  for(const [name,content] of Object.entries({...files,'req.md':'r\n'}))fs.writeFileSync(path.join(root,name),content);
  const checks=[{id:'c',command:['true'],outcome:'passed',exitCode:0,evidence:'ok'}];
  const write=(runId,scope,edits)=>{
    const baseline=captureReviewBaseline({root,identity:{repositoryId:'unit',runId,taskId:`T-${runId}`,attempt:1},scope,requirements:['req.md']});
    for(const [name,content] of Object.entries(edits))fs.writeFileSync(path.join(root,name),content);
    return {baseline,pkg:createReviewPackage({root,baseline,checks})};
  };
  return {root,write};
}

test('#18 every later delivery and the QA fix apply in durable review order: (A,0)->(B,1)->(A,2)->(B,0), then the fix x B->C',()=>{
  const {root,write}=unitRoot('ordered-',{'x.mjs':'base\n','y.mjs':'0\n'});
  const scope=['x.mjs','y.mjs'];
  // Parent (reviewed at 10), three later tasks (20, 30, 40), the fix (50).
  const parent=write('parent',scope,{'x.mjs':'A\n'});
  const d1=write('d1',scope,{'x.mjs':'B\n','y.mjs':'1\n'}),d2=write('d2',scope,{'x.mjs':'A\n','y.mjs':'2\n'});
  const d3=write('d3',scope,{'x.mjs':'B\n','y.mjs':'0\n'}),fix=write('fix',['x.mjs'],{'x.mjs':'C\n'});
  const deliveries=()=>[{runId:'d3',packages:[{pkg:d3.pkg,reviewedAt:40}]},{runId:'d1',packages:[{pkg:d1.pkg,reviewedAt:20}]},
    {runId:'d2',packages:[{pkg:d2.pkg,reviewedAt:30}]}];
  const verified=[];
  const input={root,baseline:parent.baseline,parentPackage:parent.pkg,fixPackages:[fix.pkg],after:10,deliveries,
    fixTime:pkg=>pkg.packageDigest===fix.pkg.packageDigest?50:null,verifySteps:steps=>verified.push(steps.map(step=>step.runId).join())};
  assert.throws(()=>composeFixCode(input),{code:'fix_before_mismatch'});
  const association=inspectFixCodeAssociation({...input,extend:true});
  // Exactly the ordered list used, re-proved against the stores.
  assert.equal(association.version,2);
  assert.deepEqual(association.laterDeliveries.map(item=>[item.beforeFix,item.runId]),[[0,'d1'],[0,'d2'],[0,'d3']]);
  assert.equal(association.currentFilesDigest,digest(composeFixCode({...input,steps:association.laterDeliveries}).files));
  assert.deepEqual(verified,['d1,d2,d3']);
  const steps=association.laterDeliveries;
  assert.equal(digest(inspectFixCodeAssociation({...input,steps})),digest(association));
  // The record is exactly that list: a missing, reordered or extra step, or no store verifier, is refused.
  for(const wrong of [[],steps.slice(1),[steps[1],steps[0],steps[2]]])
    assert.throws(()=>inspectFixCodeAssociation({...input,steps:wrong}),{code:'fix_association_unverified'});
  assert.throws(()=>inspectFixCodeAssociation({...input,steps,verifySteps:null}),{code:'fix_association_unverified'});
  // The fix sits at its own durable time: without one there is no order, and
  // reviewed before d3 it no longer finds x=B.
  assert.throws(()=>inspectFixCodeAssociation({...input,extend:true,fixTime:null}),{code:'fix_association_unverified'});
  assert.throws(()=>inspectFixCodeAssociation({...input,extend:true,fixTime:()=>35}),{code:'fix_before_mismatch'});
  // Every delivery counts: leaving one out, or one reviewed before the parent, breaks the chain.
  assert.throws(()=>inspectFixCodeAssociation({...input,extend:true,deliveries:()=>deliveries().filter(item=>item.runId!=='d2')}),
    error=>error.code==='fix_current_code_unexplained'&&error.paths.join()==='x.mjs,y.mjs');
  assert.throws(()=>inspectFixCodeAssociation({...input,extend:true,after:25}),{code:'fix_current_code_unexplained'});
  // A later task reviewed after the fix is applied live on top, never recorded.
  const tail=write('tail',['y.mjs'],{'y.mjs':'9\n'});
  const withTail=()=>[...deliveries(),{runId:'tail',packages:[{pkg:tail.pkg,reviewedAt:60}]}];
  assert.equal(digest(inspectFixCodeAssociation({...input,steps,deliveries:withTail})),digest(association));
  fs.writeFileSync(path.join(root,'y.mjs'),'0\n');
  assert.throws(()=>inspectFixCodeAssociation({...input,steps,deliveries:withTail}),
    error=>error.code==='fix_current_code_unexplained'&&error.paths.join()==='y.mjs');
  inspectFixCodeAssociation({...input,steps});
  // The root CM config is tolerated only where other runs' deliveries are read;
  // without them the historical exact match holds.
  fs.writeFileSync(path.join(root,'.cm-workflow.yml'),'version: 1\n');
  inspectFixCodeAssociation({...input,steps});
  const {deliveries:ignored,...bare}=input;
  assert.throws(()=>inspectFixCodeAssociation({...bare,root,baseline:d3.baseline,parentPackage:d3.pkg,fixPackages:[fix.pkg]}),
    {code:'fix_current_code_unexplained'});
  fs.rmSync(path.join(root,'.cm-workflow.yml'));
  inspectFixCodeAssociation({...bare,root,baseline:d3.baseline,parentPackage:d3.pkg,fixPackages:[fix.pkg]});
  if(process.platform!=='win32'){
    // A mode-only change to the fixed file after acceptance is not explained either.
    fs.chmodSync(path.join(root,'x.mjs'),0o755);
    assert.throws(()=>inspectFixCodeAssociation({...input,steps}),{code:'fix_current_code_unexplained'});
    fs.chmodSync(path.join(root,'x.mjs'),0o644);
    inspectFixCodeAssociation({...input,steps});
    // Nor is one on a file whose content no reviewed package touched.
    fs.chmodSync(path.join(root,'req.md'),0o755);
    assert.throws(()=>inspectFixCodeAssociation({...input,steps}),
      error=>error.code==='fix_current_code_unexplained'&&error.paths.join()==='req.md');
  }
});

test('#18 a 13-file delivery and 13 later one-file deliveries before the fix are all recorded, in order, quickly',()=>{
  const names=Array.from({length:13},(_,index)=>`f${String(index).padStart(2,'0')}.mjs`);
  const {root,write}=unitRoot('many-',{...Object.fromEntries(names.map(name=>[name,'0\n'])),'value.mjs':'0\n'});
  const parent=write('parent',['value.mjs'],{'value.mjs':'1\n'});
  const wide=write('wide',names,Object.fromEntries(names.map(name=>[name,'1\n'])));
  const narrow=names.map((name,index)=>{const runId=`n${String(index).padStart(2,'0')}`;return {runId,...write(runId,[name],{[name]:'2\n'})};});
  const fix=write('fix',['value.mjs'],{'value.mjs':'2\n'});
  const deliveries=()=>[...narrow.map((item,index)=>({runId:item.runId,packages:[{pkg:item.pkg,reviewedAt:30+index}]})).reverse(),
    {runId:'wide',packages:[{pkg:wide.pkg,reviewedAt:20}]}];
  const started=process.hrtime.bigint();
  const association=inspectFixCodeAssociation({root,baseline:parent.baseline,parentPackage:parent.pkg,fixPackages:[fix.pkg],extend:true,
    after:10,deliveries,fixTime:()=>100,verifySteps:()=>{}});
  assert.ok(Number(process.hrtime.bigint()-started)/1e6<5000);
  assert.deepEqual(association.laterDeliveries.map(item=>item.runId),['wide',...narrow.map(item=>item.runId)]);
  assert.ok(association.laterDeliveries.every(item=>item.beforeFix===0));
});
