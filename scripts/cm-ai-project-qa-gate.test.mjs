// #17 run_done needs every feature's latest QA to pass; #18 later reviewed
// deliveries of other runs must not lock an earlier run's QA recovery.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {explainReviewedDrift} from '../runtime/js/cm-ai/fix-code-association.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-project-qa-gate-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const lesson={status:'lesson_candidate',reason:null,candidates:[{classification:'structured',
  trigger:'Later task lesson',action:'Keep fixtures small',evidence:['b.mjs']}]};
const noLesson={status:'no_new_lesson',candidates:[],reason:null};

// Two approved features: 1.work/T-002 carries one blocking browser case, 2.next/T-003 is the project's last task.
function project(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'project-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  for(const [feature,task] of [['1.work','T-002'],['2.next','T-003']]){
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
    fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# D\n');
    fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),feature==='1.work'?'# R\n\n- AC-001: page renders\n':'# R\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),`- [ ] ${task}: fixture\n`);
  }
  fs.writeFileSync(path.join(specsDir,'1.work','test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases:[
    {id:'TC-001',origin:'generated',kind:'browser',blocking:true,acIds:['AC-001'],taskIds:['T-002'],title:'renders',
      preconditions:['fixture'],steps:['open'],expected:['visible'],cleanup:[]}]}));
  const manifest=buildManifest(specsDir);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work','2.next'],
    specFiles:manifest,testCases:manifest.filter(item=>item.path.endsWith('/test-cases.json'))}));
  for(const file of ['a.mjs','b.mjs'])fs.writeFileSync(path.join(codeProject,file),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  const state={browserUp:false,documentation:0,reviews:new Map()};
  const logHome=path.join(specsDir,'.reviews','host-log-mirror');
  const environment={kind:'web',carrier:'browser',target:'fixture',scope:'local'};
  const execution=(feature,{write,retrospective=noLesson,verdict=()=>'approved',decision=null})=>({
    configuration:{kind:'synthetic-host-v1',hostContextId:'control',workflow:{qa:{commands:[],environment},documentationPaths:[],applicableAgentFiles:[]}},
    timeoutMs:5000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      write();return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective}};}})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:(review,{onEvent})=>{
        onEvent({event:'thread.started',provider_thread:`thread-${review.identity.runId}-${review.identity.attempt}`});
        onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
        onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
        const result=verdict(review.identity);
        return {status:'succeeded',value:{verdict:result,packageDigest:review.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(review.payload.reviewPackage),findings:result==='approved'?[]:
            [{id:'F1',severity:'P2',path:'b.mjs',message:'Again',evidence:'Synthetic'}],summary:'Synthetic review'}};}}],
    reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],authorize:(review,{authorizationAt})=>{
      const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${review.identity.runId}-${review.identity.attempt}`,
        adapterId:'codex-review-adapter',invocationId:review.invocationId,requestDigest:review.requestDigest,identity:review.identity,
        reviewerId:'reviewer',logicalContextId:review.contextId,packageDigest:review.payload.reviewPackage.packageDigest,hostContextId:'control',
        decisionId:'decision',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
      return {...body,grantDigest:digest(body)};}},
    hostDecision:{status:'approved'},check:createHostCheck({cwd:codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]}),
    qaLogHome:logHome,applicableAgentFiles:[],
    documentationProvider:{timeoutMs:5000,inspect:async binding=>{state.documentation++;
      return {syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
        status:'completed',reason:'Documentation checked',at:'2026-09-28T00:00:00Z'};}},
    qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:`qa-${binding.identity.runId}`,identity:binding.identity,
      packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-28T00:00:00Z',...decision})},
    qaExecutor:createHostQaExecutor({specsDir,codeProject,feature,requirements:['requirements.md'],runtime:'codex',
      commands:[{id:'unit',command:[process.execPath,'--check','a.mjs'],caseIds:[]}],environment,timeoutMs:60000,logHome,
      browser:async browserRequest=>{
        if(!state.browserUp)return {verdict:'BLOCKED',evidence:[],environment:browserRequest.environment,cleanup:'failed'};
        const shot=path.join(specsDir,'.reviews','tc-001.txt');fs.writeFileSync(shot,'observed');
        return {verdict:'PASS',evidence:[shot],environment:browserRequest.environment,cleanup:'not_needed'};}})});
  const definition=(feature,taskId,scope)=>({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'gate-fixture',runId:`run-${taskId}`,taskId,attempt:1},scope,requirements:['requirements.md']});
  const advance=async(def,exec,mode,options)=>{
    const run=await openControlRun(def,mode,exec,options);
    try{return await run.host.handle({version:1,operation:'advance',requestId:'advance',identity:def.identity});}finally{run.close();}
  };
  const first=definition('1.work','T-002',['a.mjs']);
  const firstExecution=()=>execution('1.work',{write:()=>fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n')});
  // Re-approve after a deliberate tasks.md change so admission stays ready.
  const reapprove=()=>{const manifest=buildManifest(specsDir);
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work','2.next'],
      specFiles:manifest,testCases:manifest.filter(item=>item.path.endsWith('/test-cases.json'))}));};
  return {root,codeProject,specsDir,state,execution,definition,advance,first,firstExecution,reapprove};
}
const status=p=>JSON.parse(fs.readFileSync(path.join(p.specsDir,'.cm-status.json'),'utf8'));

test('#17 an earlier feature whose QA is BLOCKED keeps the project from run_done until it is recovered; #18 its recovery survives a later reviewed task',async()=>{
  const p=project();
  const blocked=await p.advance(p.first,p.firstExecution(),'create');
  assert.equal(blocked.code,'qa_result_blocked');
  const admission=inspectCmAiAdmission({specsDir:p.specsDir,codeProject:p.codeProject});
  assert.equal(admission.nextTask.id,'T-003');
  assert.deepEqual(admission.warnings.filter(line=>line.includes('QA 未通过')).length,1);
  assert.match(admission.warnings.find(line=>line.includes('QA 未通过')),/1\.work.*T-002.*run-T-002.*BLOCKED/);
  // The later task appends an AGENTS.md lesson and edits the earlier task's own file.
  const last=p.definition('2.next','T-003',['a.mjs','b.mjs']);
  const lastExecution=()=>p.execution('2.next',{retrospective:lesson,write:()=>{
    fs.writeFileSync(path.join(p.codeProject,'b.mjs'),'export const b=1;\n');fs.writeFileSync(path.join(p.codeProject,'a.mjs'),'export const a=2;\n');}});
  const refused=await p.advance(last,lastExecution(),'create');
  assert.equal(refused.code,'project_qa_not_passed',JSON.stringify(refused));
  assert.equal(refused.outcome,'blocked');assert.equal(refused.pendingAction,'none');
  assert.deepEqual(refused.outstandingQa,[{feature:'1.work',runId:'run-T-002',taskId:'T-002',attempt:1,status:'qa_blocked'}]);
  assert.match(refused.reason,/1\.work/);
  assert.equal(p.state.documentation,0,'finish refuses before the N8 documentation check');
  assert.notEqual(status(p).state,'run_done');
  // A host calling run_finalize directly is refused the same way.
  const testRunId=fs.readFileSync(path.join(p.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    .filter(row=>row.event==='test_run'&&row.run_id==='run-T-003'&&row.phase==='start').at(-1).operation_id;
  const direct=await openControlRun(last,'resume',lastExecution());
  try{
    const finalized=await direct.host.handle({version:1,operation:'run_finalize',requestId:'finalize',identity:last.identity,
      packageDigest:refused.packageDigest,testRunId});
    assert.equal(finalized.code,'project_qa_not_passed',JSON.stringify(finalized));
  }finally{direct.close();}
  assert.notEqual(status(p).state,'run_done');
  assert(fs.readFileSync(path.join(p.codeProject,'AGENTS.md'),'utf8').includes('Later task lesson'));
  // Back to the earlier run: the later, separately reviewed delivery does not lock it.
  p.state.browserUp=true;
  const recovered=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.notEqual(recovered.code,'correction_review_required',JSON.stringify(recovered));
  assert.equal(recovered.code,'run_done',JSON.stringify(recovered));
  const finished=await p.advance(last,lastExecution(),'resume');
  assert.equal(finished.code,'run_done',JSON.stringify(finished));
  assert.equal(status(p).state,'run_done');
});

test('#18 unreviewed tampering with the earlier task file still requires correction review and names the file',async()=>{
  const p=project();
  await p.advance(p.first,p.firstExecution(),'create');
  const last=p.definition('2.next','T-003',['b.mjs']);
  await p.advance(last,p.execution('2.next',{retrospective:lesson,write:()=>fs.writeFileSync(path.join(p.codeProject,'b.mjs'),'export const b=1;\n')}),'create');
  fs.appendFileSync(path.join(p.codeProject,'a.mjs'),'// unreviewed\n');
  p.state.browserUp=true;
  const locked=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.equal(locked.code,'correction_review_required');assert.equal(locked.pendingAction,'none');
  assert.equal(locked.reason,'未经审查的改动：a.mjs');
});

test('#18 an unfinished later run is not a reviewed delivery',async()=>{
  const p=project();
  await p.advance(p.first,p.firstExecution(),'create');
  const last=p.definition('2.next','T-003',['b.mjs']);
  const pending=await p.advance(last,p.execution('2.next',{write:()=>fs.writeFileSync(path.join(p.codeProject,'b.mjs'),'export const b=1;\n'),
    verdict:()=>'changes_requested'}),'create');
  assert.notEqual(pending.state,'fixture_completed');
  p.state.browserUp=true;
  const locked=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.equal(locked.code,'correction_review_required');assert.equal(locked.reason,'未经审查的改动：b.mjs');
});

test('#18 the root CM workflow config is editable after completion; an unreviewed extra file is not',async()=>{
  const p=project();
  await p.advance(p.first,p.firstExecution(),'create');
  // Needed for --auto-qa-fix: policies.auto_fix lives in the project config.
  fs.writeFileSync(path.join(p.codeProject,'.cm-workflow.yml'),'version: 1\npolicies:\n  auto_fix: auto\n');
  fs.writeFileSync(path.join(p.codeProject,'notes.txt'),'unreviewed\n');
  p.state.browserUp=true;
  const locked=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.equal(locked.code,'correction_review_required');assert.equal(locked.reason,'未经审查的改动：notes.txt');
  fs.rmSync(path.join(p.codeProject,'notes.txt'));
  const recovered=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.equal(recovered.code,'context_refreshed',JSON.stringify(recovered));
  assert.equal(status(p).state,'qa_passed');
});

test('#18 reviewed transitions apply only from their reviewed before-state, in either discovery order',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'drift-')));
  const identity=runId=>({repositoryId:'drift',runId,taskId:`T-${runId}`,attempt:1});
  fs.writeFileSync(path.join(root,'a.mjs'),'a0\n');fs.writeFileSync(path.join(root,'b.mjs'),'b0\n');fs.writeFileSync(path.join(root,'req.md'),'r\n');
  const own=captureReviewBaseline({root,identity:identity('own'),scope:['a.mjs'],requirements:['req.md']});
  const check=[{id:'c',command:['true'],outcome:'passed',exitCode:0,evidence:'ok'}];
  fs.writeFileSync(path.join(root,'a.mjs'),'a1\n');
  const ownPackage=createReviewPackage({root,baseline:own,checks:check});
  // The parent's own approving review happened at t=10.
  const delivery=(runId,edit,reviewedAt)=>{
    const baseline=captureReviewBaseline({root,identity:identity(runId),scope:['b.mjs'],requirements:['req.md']});
    fs.writeFileSync(path.join(root,'b.mjs'),edit);
    return {runId,packages:[{pkg:createReviewPackage({root,baseline,checks:check}),reviewedAt}]};
  };
  const second=delivery('second','b1\n',20),third=delivery('third','b2\n',30);
  const composed=own.files.map(file=>file.path==='a.mjs'?ownPackage.changes[0].after:file);
  const explain=(deliveries,after=10)=>explainReviewedDrift({root,baseline:own,composed,ownScope:['a.mjs'],deliveries,after});
  explain([second,third]);explain([third,second]);
  // Without the intermediate delivery the later transition's before-state never matches.
  assert.throws(()=>explain([third]),error=>error.code==='fix_current_code_unexplained'&&error.paths.join()==='b.mjs');
  // Deliveries reviewed before the parent, or with no review time, never count.
  assert.throws(()=>explain([second,third],25),error=>error.paths.join()==='b.mjs');
  assert.throws(()=>explain([second,third],null),error=>error.paths.join()==='b.mjs');
  // A reviewed transition cannot explain content it did not produce.
  fs.writeFileSync(path.join(root,'b.mjs'),'bX\n');
  assert.throws(()=>explain([second,third]),error=>error.paths.join()==='b.mjs');
  fs.writeFileSync(path.join(root,'b.mjs'),'b2\n');
  // The CM config is tolerated only outside the run's own scope.
  fs.writeFileSync(path.join(root,'.cm-workflow.yml'),'version: 1\n');explain([second,third]);
  assert.throws(()=>explainReviewedDrift({root,baseline:own,composed,ownScope:['a.mjs','.cm-workflow.yml'],deliveries:[second,third],after:10}),
    error=>error.paths.join()==='.cm-workflow.yml');
});

test('#18 an old reviewed transition cannot disguise an unreviewed revert, and a cyclic history still finds the true later delivery',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'cycle-')));
  const identity=runId=>({repositoryId:'cycle',runId,taskId:`T-${runId}`,attempt:1});
  const check=[{id:'c',command:['true'],outcome:'passed',exitCode:0,evidence:'ok'}];
  fs.writeFileSync(path.join(root,'a.mjs'),'A\n');fs.writeFileSync(path.join(root,'req.md'),'r\n');
  const change=(runId,content)=>{
    const baseline=captureReviewBaseline({root,identity:identity(runId),scope:['a.mjs'],requirements:['req.md']});
    fs.writeFileSync(path.join(root,'a.mjs'),content);
    return {baseline,pkg:createReviewPackage({root,baseline,checks:check})};
  };
  // Old task A->B (reviewed at 5), parent B->A (reviewed at 10), a later dead end
  // A->X that was undone (15) and the true later task A->C (20). A first-match
  // choice would take the dead end and then fail to explain C.
  const old=change('a-old','B\n'),parent=change('parent','A\n');
  const deadEnd=change('b-dead-end','X\n');fs.writeFileSync(path.join(root,'a.mjs'),'A\n');
  const later=change('c-later','C\n');
  const composed=parent.baseline.files.map(file=>file.path==='a.mjs'?parent.pkg.changes[0].after:file);
  const deliveries=[{runId:'a-old',packages:[{pkg:old.pkg,reviewedAt:5}]},{runId:'b-dead-end',packages:[{pkg:deadEnd.pkg,reviewedAt:15}]},
    {runId:'c-later',packages:[{pkg:later.pkg,reviewedAt:20}]}];
  const explain=()=>explainReviewedDrift({root,baseline:parent.baseline,composed,ownScope:['a.mjs'],deliveries,after:10});
  explain();
  // Someone reverts the parent's own change by hand: the old A->B must not explain it.
  fs.writeFileSync(path.join(root,'a.mjs'),'B\n');
  assert.throws(explain,error=>error.code==='fix_current_code_unexplained'&&error.paths.join()==='a.mjs');
});

test('#18 a permission-only change to the delivered file still requires correction review',{skip:process.platform==='win32'},async()=>{
  const p=project();
  await p.advance(p.first,p.firstExecution(),'create');
  fs.chmodSync(path.join(p.codeProject,'a.mjs'),0o755);
  p.state.browserUp=true;
  const locked=await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true});
  assert.equal(locked.code,'correction_review_required');assert.equal(locked.reason,'未经审查的改动：a.mjs');
  fs.chmodSync(path.join(p.codeProject,'a.mjs'),0o644);
  assert.equal((await p.advance(p.first,p.firstExecution(),'resume',{rerunBlockedQa:true})).code,'context_refreshed');
});

test('#17 a feature completed outside N6 has no completion QA and blocks run_done',async()=>{
  const p=project();
  // T-002 was ticked by hand: no run, no QA row for 1.work.
  const tasks=path.join(p.specsDir,'1.work','tasks.md');
  fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replace('- [ ] T-002','- [x] T-002'));
  const admission=inspectCmAiAdmission({specsDir:p.specsDir,codeProject:p.codeProject});
  assert.match(admission.warnings.find(line=>line.includes('QA 未通过')),/1\.work（任务已全部完成，但没有 QA 记录）/);
  const last=p.definition('2.next','T-003',['b.mjs']);
  const refused=await p.advance(last,p.execution('2.next',{write:()=>fs.writeFileSync(path.join(p.codeProject,'b.mjs'),'export const b=1;\n')}),'create');
  assert.equal(refused.code,'project_qa_not_passed',JSON.stringify(refused));
  assert.deepEqual(refused.outstandingQa,[{feature:'1.work',runId:null,taskId:null,attempt:null,status:'qa_missing'}]);
  assert.notEqual(status(p).state,'run_done');
});

test('#17 a skip is fine while tasks remain, but a terminal feature whose latest decision is a skip blocks run_done',async()=>{
  const p=project();
  const tasks=path.join(p.specsDir,'1.work','tasks.md');
  fs.writeFileSync(tasks,'- [ ] T-001: first\n- [ ] T-002: fixture\n');p.reapprove();
  const first=p.definition('1.work','T-001',['a.mjs']);
  const skipped=await p.advance(first,p.execution('1.work',{write:()=>fs.writeFileSync(path.join(p.codeProject,'a.mjs'),'export const a=1;\n'),
    decision:{status:'skipped',reason:'risk_score_below_threshold',score:4}}),'create');
  assert.equal(skipped.code,'context_refreshed',JSON.stringify(skipped));
  const midway=inspectCmAiAdmission({specsDir:p.specsDir,codeProject:p.codeProject});
  assert.equal(midway.nextTask.id,'T-002');assert(!midway.warnings.some(line=>line.includes('QA 未通过')),JSON.stringify(midway.warnings));
  // The feature's final task is then finished outside the workflow.
  fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replace('- [ ] T-002','- [x] T-002'));
  const last=p.definition('2.next','T-003',['b.mjs']);
  const refused=await p.advance(last,p.execution('2.next',{write:()=>fs.writeFileSync(path.join(p.codeProject,'b.mjs'),'export const b=1;\n')}),'create');
  assert.equal(refused.code,'project_qa_not_passed',JSON.stringify(refused));
  assert.deepEqual(refused.outstandingQa,[{feature:'1.work',runId:'run-T-001',taskId:'T-001',attempt:1,status:'qa_skipped'}]);
});
