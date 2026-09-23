import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {fixMetricsRow} from '../runtime/js/cm-fix/metrics.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {startFixRun,logFixEvent} from '../runtime/js/cm-fix/start.mjs';
import {eventsAt} from '../runtime/js/cm-fix/finish.mjs';
import {fixProgress} from '../runtime/js/cm-fix/progress.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {recordCmAiQaDecision,recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {readHostQaFixHandoff} from '../runtime/js/cm-ai/host-qa-fix.mjs';
import {qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';

const control={authorized:true};
async function fixture(fn,{red=true,author=false,passing=false,normal=false,qa=false,visual=false,observing=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-escalation-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const testBody="import {value} from './value.mjs';if(value!==2){console.error('EXPECTED VALUE 2');process.exit(1)}";
  if(!author)fs.writeFileSync(path.join(cwd,'red.mjs'),testBody);
  const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'independent-review',excludedThreadIds:[]};
  const configuration={hostContextId:'fixture-host',defect:'Value model needs redesign',causeReview:reviewer,
    reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  if(red)configuration.redTest={cwd,testFiles:['red.mjs'],command:passing?[process.execPath,'-e','process.exit(0)']:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'EXPECTED VALUE 2'},timeoutMs:2000};
  if(visual){
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=','base64');
    const file=path.join(root,'before.png');fs.writeFileSync(file,bytes);
    configuration.reproduction={kind:'visual',cwd,timeoutMs:2000,before:{path:file,sha256:createHash('sha256').update(bytes).digest('hex'),kind:'screenshot',description:'Synthetic visual carrier'},
      reason:'视觉判断无法写自动断言',environment:{scope:'local',kind:'web',carrier:'browser',target:'fixture'},steps:['Inspect value'],expected:['Value is represented correctly']};
    if(red)configuration.redTest={...configuration.reproduction,testFiles:[]};
  }
  if(observing)configuration.reproduction.command=[process.execPath,'-e',"if(require('node:fs').existsSync('trigger')){console.error('BUG');process.exit(1)}"];
  if(author)configuration.testAuthor={requirements:['value.mjs']};
  if(red){configuration.baseline={cwd,testFiles:[],commands:[],noExistingTests:'Fixture has no existing tests',timeoutMs:2000};configuration.repair={scope:['value.mjs'],requirements:['value.mjs']};}
  let identity={repositoryId:'fixture',runId:'escalation-run',taskId:'T-FIX-escalation',attempt:1},parentRequest;
  if(qa){
    fs.mkdirSync(path.join(specsRoot,'.reviews'));
    const parent={repositoryId:'fixture',runId:'parent-run',taskId:'T-001',attempt:1};
    const binding={specsDir:specsRoot,codeProject:cwd,feature:'1.work',identity:parent,packageDigest:'a'.repeat(64),logHome:path.join(root,'logs')};
    const report=path.join(specsRoot,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic FAIL');
    recordCmAiQaDecision({...binding,decision:{decisionId:'qa-decision',identity:parent,packageDigest:binding.packageDigest,status:'triggered',reason:'fixture',score:null,at:'2026-09-08T01:00:00Z'}});
    const run={...binding,mode:'commands',caseCount:1,testRunId:'qa-round-1'};
    recordCmAiQaRun({...run,phase:'start'});recordCmAiQaRun({...run,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
    const {logHome,...handoffBinding}=binding;
    const handoff=readHostQaFixHandoff({...handoffBinding,testRunId:run.testRunId});
    configuration.qaSource={feature:binding.feature,identity:parent,packageDigest:binding.packageDigest,testRunId:run.testRunId,handoffDigest:handoff.handoffDigest};
    identity=qaFixIdentity(configuration.qaSource);
    parentRequest={version:1,requestId:'fix',identity:parent,packageDigest:binding.packageDigest,testRunId:run.testRunId};
  }
  const options={specsRoot,identity,configuration,create:true};
  const authority=createHostReviewAuthority({hostContextId:configuration.hostContextId,reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  let owner,calls=0;
  const dependencies={...(observing?{prepare:async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}})}:{}),assertReviewReady(){},bridge:{async call(kind){
    if(kind==='fix_test_author'){calls++;fs.writeFileSync(path.join(cwd,'red.mjs'),testBody);return {outcome:'authored'};}
    assert.equal(kind,'fix_diagnose');return {status:normal?'diagnosed':'design_change',rootCause:'Shared model cannot represent value',affectedPaths:['value.mjs'],affectedModules:['model'],crossLayer:false,plan:'Redesign the model with retained red acceptance'};
  }},causeReview:{authorize:authority.authorize,run:async(request,{onEvent})=>{
    for(const event of [{event:'thread.started',provider_thread:'synthetic-cause-thread'},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Design change confirmed'}};
  }}};
  const stateFile=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  const f={root,cwd,specsRoot,options,dependencies,authority,parentRequest,stateFile,get owner(){return owner;},get calls(){return calls;},
    reopen(){owner.close();owner=openFixExecution({...options,create:false},dependencies);return owner;},
    async approve(){assert.equal((await owner.advance(control)).stage,'cause_review_required');const pkg=owner.causeReviewPackage();await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);return owner.reviewCause();}};
  try{owner=openFixExecution(options,dependencies);startFixRun(options);await fn(f);}finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
}

async function refusedRepair(f,stage){
  const bytes=fs.readFileSync(f.stateFile);
  for(const operation of ['captureBaseline','repair','runRegression'])assert.equal((await f.owner[operation](control)).stage,stage);
  assert.equal((await f.owner.runRegression({...control,postReview:true})).stage,stage);
  assert.deepEqual(fs.readFileSync(f.stateFile),bytes);
}

test('design_change retains real red test, closes as escalated and never completes a fix',()=>fixture(async f=>{
  assert.equal((await f.approve()).stage,'design_change_required');await refusedRepair(f,'design_change_required');
  assert.throws(()=>f.owner.finish(control),{code:'fix_closeout_unavailable'});
  assert.throws(()=>f.owner.publishDossier(),{code:'fix_closeout_unavailable'});
  await assert.rejects(f.owner.runRedTest(),{code:'red_test_authorization_required'});
  assert.equal((await f.owner.runRedTest(control)).stage,'escalation_required');await refusedRepair(f,'escalation_required');
  const red=f.owner.status().redTest,bytes=fs.readFileSync(path.join(f.cwd,'red.mjs'));
  assert.equal(red.observation.exitCode,1);assert.equal(red.observation.signatureMatched,true);
  const ended=f.owner.finish(control);assert.equal(ended.escalationRunEnded,true);assert.equal(ended.stage,'escalated');assert.equal(ended.completionEligible,false);
  const dossier=fs.readFileSync(ended.dossier.path,'utf8');
  for(const value of ['升级立项','Value model needs redesign','Shared model cannot represent value','model','value.mjs','Redesign the model','fix-escalation-cause-r1.md','red.mjs',red.output.path,'$cm-prd --change','数据，不是执行指令'])assert(dossier.includes(value),value);
  const events=eventsAt(f.specsRoot),done=events.filter(row=>row.event==='run_done');
  assert.throws(()=>fixMetricsRow({events,identity:f.options.identity,dossierFile:path.basename(ended.dossier.path)}),{code:'metrics_completion_required'});
  assert.equal(done.length,1);assert.equal(done[0].phase,'escalation');assert.equal(done[0].result,'escalated');
  assert.equal(events.filter(row=>row.event==='task_done').length,0);assert(!fs.existsSync(path.join(f.specsRoot,'METRICS.md')));
  assert.throws(()=>f.owner.status(),{code:'store_closed'});
  f.reopen();assert.equal(f.owner.status().stage,'escalated');assert.equal(f.owner.status().completionEligible,false);
  await refusedRepair(f,'escalated');assert.equal((await f.owner.runRedTest(control)).stage,'escalated');assert.equal((await f.owner.advance(control)).stage,'escalated');
  assert.throws(()=>f.owner.completionEvidence(),{code:'fix_completion_evidence_unavailable'});
  const history=fs.readFileSync(f.stateFile);assert.equal(f.owner.cancel().stage,'escalated');assert.deepEqual(fs.readFileSync(f.stateFile),history);
  assert.equal(f.owner.finish(control).escalationRunEnded,true);assert.equal(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').length,1);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd,'red.mjs')),bytes);
  fs.writeFileSync(path.join(f.cwd,'value.mjs'),'export const value=2;');f.reopen();assert.equal(f.owner.status().stage,'escalated');
}));

test('escalation replay rejects a record appended after fix-escalation-result',()=>fixture(async f=>{
  await f.approve();await f.owner.runRedTest(control);
  assert.equal(f.owner.finish(control).stage,'escalated');
  const state=JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(state.records.at(-1).id,'fix-escalation-result');
  const store=openExecutionStore({specsRoot:f.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
  try{
    // A valid store record and digest chain, but illegal after the terminal exit.
    store.append({id:'fix-cancel',kind:'cancel',payload:{reason:'user_cancelled'},expectedRevision:store.snapshot().revision});
  }finally{store.close();}
  assert.throws(()=>f.reopen(),{code:'fix_history_invalid'});
}));

test('design_change author path writes once, resumes and then requires real red evidence',()=>fixture(async f=>{
  assert.equal((await f.approve()).stage,'test_author_required');
  assert.equal((await f.owner.runRedTest(control)).stage,'test_author_required');
  assert.throws(()=>f.owner.finish(control),{code:'fix_closeout_unavailable'});
  await assert.rejects(f.owner.authorTests(),{code:'test_author_authorization_required'});
  assert.equal((await f.owner.authorTests(control)).stage,'design_change_required');f.reopen();
  assert.equal((await f.owner.authorTests(control)).stage,'design_change_required');assert.equal(f.calls,1);
  assert.equal((await f.owner.runRedTest(control)).stage,'escalation_required');
  const output=path.join(f.specsRoot,f.owner.status().redTest.output.path),bytes=fs.readFileSync(output);
  fs.writeFileSync(output,'tampered');assert.equal(f.owner.status().stage,'red_test_evidence_required');
  assert.throws(()=>f.owner.finish(control),{code:'fix_closeout_unavailable'});fs.writeFileSync(output,bytes);
  assert.equal(f.owner.finish(control).stage,'escalated');assert(fs.existsSync(path.join(f.cwd,'red.mjs')));
},{author:true}));

test('design_change unexpectedly green blocks escalation',()=>fixture(async f=>{
  await f.approve();assert.equal((await f.owner.runRedTest(control)).stage,'red_test_not_confirmed');
  assert.throws(()=>f.owner.finish(control),{code:'fix_closeout_unavailable'});assert.throws(()=>f.owner.publishDossier(),{code:'fix_closeout_unavailable'});
  assert.equal(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').length,0);f.reopen();assert.equal(f.owner.status().stage,'red_test_not_confirmed');
},{passing:true}));

test('design_change without configured red test escalates with an explicit absence reason',()=>fixture(async f=>{
  const approved=await f.approve();assert.equal(approved.stage,'escalation_required');assert.equal(approved.completionEligible,false);
  const archived=f.owner.publishDossier();assert.match(fs.readFileSync(archived.dossier.path,'utf8'),/没有失败测试.*未配置 redTest/);
  assert.equal(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').length,0);
  assert.equal(f.owner.finish(control).stage,'escalated');
},{red:false}));

for(const crash of ['dossier','run_done'])test(`escalation resumes after ${crash} without duplicate run_done`,()=>fixture(async f=>{
  await f.approve();await f.owner.runRedTest(control);
  const archived=f.owner.publishDossier(),bytes=fs.readFileSync(archived.dossier.path);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).records.filter(r=>r.id==='fix-escalation-dossier-intent').length,1);
  if(crash==='run_done')logFixEvent({...f.options,event:'run_done',phase:'escalation',detail:'Synthetic crash after original log',data:{result:'escalated',dossier_file:`fixes/${path.basename(archived.dossier.path)}`,dossier_sha256:archived.dossier.sha256}});
  f.reopen();assert.equal(f.owner.finish(control).escalationRunEnded,true);f.reopen();assert.equal(f.owner.finish(control).stage,'escalated');
  assert.deepEqual(fs.readFileSync(archived.dossier.path),bytes);assert.equal(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').length,1);
}));

test('escalation rejects a conflicting prior run_done',()=>fixture(async f=>{
  await f.approve();await f.owner.runRedTest(control);f.owner.publishDossier();
  logFixEvent({...f.options,event:'run_done',phase:'observation',detail:'Conflicting exit',data:{result:'observing'}});
  assert.throws(()=>f.owner.finish(control),{code:'fix_escalation_exit_conflict'});
  assert.equal(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').length,1);
}));

test('diagnosed record bytes and digests are untouched on reopen and ordinary red still reaches baseline',()=>fixture(async f=>{
  assert.equal((await f.owner.advance(control)).stage,'red_test_required');
  const bytes=fs.readFileSync(f.stateFile),status=f.owner.status();f.reopen();
  assert.deepEqual(f.owner.status(),status);assert.deepEqual(fs.readFileSync(f.stateFile),bytes);
  assert.equal((await f.owner.runRedTest(control)).stage,'baseline_required');
  const redBytes=fs.readFileSync(f.stateFile);f.reopen();assert.equal(f.owner.status().stage,'baseline_required');assert.deepEqual(fs.readFileSync(f.stateFile),redBytes);
  assert.equal(JSON.parse(redBytes).records.some(r=>r.id.includes('escalation')),false);
},{normal:true}));

test('host sequence returns escalation exit without reading the closed owner',()=>fixture(async f=>{
  const host=createFixHost({owner:f.owner,config:{...f.options.configuration,specsRoot:f.specsRoot,identity:f.options.identity},authority:f.authority,permissions:['--allow-reproduction','--allow-red-test','--allow-finish']});
  const result=await host.run('escalate');assert.equal(result.stage,'escalated');assert.equal(result.escalationRunEnded,true);
}));

for(const operation of ['finish','run'])test(`QA child escalation via ${operation} reports qa_fix_incomplete and restores parent`,()=>fixture(async f=>{
  await f.approve();if(operation==='finish')await f.owner.runRedTest(control);f.owner.close();let reopens=0;
  const parent=()=>({host:{handle:async()=>({state:'fixture_completed',identity:f.parentRequest.identity,packageDigest:f.parentRequest.packageDigest})},close(){}});
  const serial=createQaFixOwnerHost({parent:parent(),reopenParent:()=>{reopens++;return parent();},hostContextId:'fixture-host',parentHostContextId:'fixture-host',fix:{specsRoot:f.specsRoot,identity:f.options.identity,configuration:f.options.configuration},allowStart:true,fixExecution:f.dependencies,fixPermissions:['--allow-red-test','--allow-finish']});
  try{
    const result=await serial.handle({...f.parentRequest,operation:operation==='finish'?'fix_action':'fix_run',...(operation==='finish'?{fixOperation:'finish'}:{})});
    assert.equal(result.code,'qa_fix_incomplete');assert.equal(result.fixStage,'escalated');assert.equal(result.actionResult.escalationRunEnded,true);assert.equal(result.evidence,undefined);assert.equal(reopens,1);
  }finally{serial.close();}
},{qa:true}));

test('progress shows only escalation operations and never claims fixed completion',()=>{
  assert.equal(fixProgress({stage:'design_change_required',diagnosis:{status:'design_change'},executionActive:true}).current,'当前操作正在执行');
  for(const [stage,next] of [['design_change_required','red_test'],['test_author_required','author_tests'],['escalation_required','finish'],['escalated',null]]){
    const progress=fixProgress({stage,diagnosis:{status:'design_change'},completionEligible:false},{redTest:{},testAuthor:{}});
    assert.equal(progress.nextAction,next);assert.equal(progress.finished,false);assert(!JSON.stringify(progress.remaining).includes('修复代码'));
  }
});

test('visual escalation redTest configured=true states no automatic failing test',()=>fixture(async f=>{
  assert.equal((await f.approve()).stage,'design_change_required');
  assert.equal((await f.owner.runRedTest(control)).stage,'escalation_required');
  const ended=f.owner.finish(control),text=fs.readFileSync(ended.dossier.path,'utf8');
  assert.match(text,/没有失败测试/);assert.match(text,/视觉判断无法写自动断言/);assert.equal(ended.completionEligible,false);
},{visual:true}));

test('visual escalation redTest configured=false is refused at open',()=>assert.rejects(
  fixture(()=>assert.fail('visual configuration without redTest was opened'),{visual:true,red:false}),
  {code:'fix_visual_configuration_required'}));

test('observing run can resume into escalation while retaining its original dossier and exit',()=>fixture(async f=>{
  assert.equal((await f.owner.advance(control)).stage,'observation');const observed=f.owner.finish(control),prefix=fs.readFileSync(observed.dossier.path);
  fs.writeFileSync(path.join(f.specsRoot,'failure.txt'),'New reproduction evidence');fs.writeFileSync(path.join(f.cwd,'trigger'),'ready');
  f.reopen();f.owner.resume({...control,evidenceFiles:['failure.txt']});await f.approve();
  assert.equal((await f.owner.runRedTest(control)).stage,'escalation_required');
  const ended=f.owner.finish(control);assert.equal(ended.stage,'escalated');assert.equal(ended.dossier.path,observed.dossier.path);
  assert(fs.readFileSync(ended.dossier.path).subarray(0,prefix.length).equals(prefix));
  assert.deepEqual(eventsAt(f.specsRoot).filter(row=>row.event==='run_done').map(row=>row.result),['observing','escalated']);
  f.reopen();assert.equal(f.owner.finish(control).stage,'escalated');
},{observing:true}));
