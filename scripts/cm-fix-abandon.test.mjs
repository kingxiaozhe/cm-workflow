import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {redTestFiles,verifyFixRedEvidence} from '../runtime/js/cm-fix/red-test.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {fixHandoffEvidence,fixDefectHandoffEvidence} from '../runtime/js/cm-fix/handoff.mjs';

const diagnosis={status:'diagnosed',rootCause:'Wrong value',affectedPaths:['value.mjs'],
  affectedModules:['value'],plan:'Correct value',crossLayer:false};

async function fixture(t,{observation=false,reviewMode=null,crossLayer=false,lesson=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-abandon-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
  fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;\n');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(cwd,'requirements.md'),'Value must be 2');
  const identity={repositoryId:'fixture',runId:'abandon-run',taskId:'T-FIX-abandon',attempt:1};
  const configuration={hostContextId:'host',defect:'Wrong value',
    reproduction:{cwd,command:observation?[process.execPath,'-e',"if(require('node:fs').existsSync('enable')){console.error('BUG');process.exit(1)}"]:
      [process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['requirements.md']}};
  let reviews=0;
  const model='synthetic';
  const reviewHost=reviewMode?createFixReviewHost({codeProject:cwd,hostContextId:'host',
    review:{model,disabledSkills:[],preflight:{passed:true,cli_model:model,prompt_transport:'stdin',
      config_fingerprint:configFingerprint({cwd,model,disabledSkills:[]})}},
    permissions:['--allow-final-review','--allow-cause-review','--allow-repair'],workerFactory:()=>async({prompt},{onEvent})=>{
      reviews++;
      const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
      onEvent({event:'thread.started',provider_thread:`fixture-review-${reviews}`});
      if(reviewMode==='lost'||reviewMode==='second_lost'&&reviews===2)throw Error('Synthetic lost review result');
      for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
        {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
      const verdict=['changes_requested','second_lost'].includes(reviewMode)?'changes_requested':'approved';
      return {status:'succeeded',value:{verdict,packageDigest:data.reviewPackage.packageDigest,
        examinedPaths:data.examinedPaths,
        findings:verdict==='changes_requested'?[{id:'F1',severity:'P2',path:'value.mjs',message:'Revise value',evidence:'Fixture'}]:[],
        summary:'Synthetic review'}};
    }}):null;
  if(reviewHost)configuration.causeReview=reviewHost.reviewer;
  const options={specsRoot,identity,configuration,create:true};
  let loseObservation=true,loseRevisionRepair=true;
  const bridge={async call(kind,payload){
    if(kind==='fix_diagnose'){
      if(observation&&payload.observationEvidence&&loseObservation){loseObservation=false;throw Error('Lost observation answer');}
      return crossLayer?{...diagnosis,crossLayer:true}:diagnosis;
    }
    if(kind==='fix_repair'){
      if(['changes_requested','second_lost'].includes(reviewMode)&&payload.identity.attempt===2&&loseRevisionRepair){
        loseRevisionRepair=false;throw Error('Lost revision repair answer');
      }
      fs.writeFileSync(path.join(cwd,'value.mjs'),payload.identity.attempt===2?'export const value=2; // revised\n':'export const value=2;\n');
      return {outcome:'repaired'};
    }
    if(kind==='fix_retrospective')return (lesson===true||lesson==='revision'&&payload.identity.attempt===2)?{status:'lesson_candidate',candidates:[{classification:'memory_only',
      trigger:'Repeated value bug',action:'Check constants',evidence:['requirements.md']}],reason:null}
      :{status:'no_new_lesson',candidates:[],reason:null};
    throw Error(kind);
  }};
  const learning={files:[],contextDigest:digest([]),application:{contextDigest:digest([]),
    status:'no_relevant_lesson',summary:'No fixture instructions'}};
  const dependencies={bridge,prepare:async()=>learning,...(reviewHost?reviewHost.execution:{assertReviewReady:()=>{}})};
  let owner=openFixExecution(options,dependencies);
  t.after(()=>owner?.close());
  const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  const records=()=>JSON.parse(fs.readFileSync(statePath)).records;
  const append=(id,kind,payload)=>{
    owner.close();owner=null;
    const state=JSON.parse(fs.readFileSync(statePath));
    const store=openExecutionStore({specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
    try{store.append({id,kind,payload,expectedRevision:store.snapshot().revision});}finally{store.close();}
    owner=openFixExecution({...options,create:false},dependencies);
  };
  const reopen=()=>{owner.close();owner=openFixExecution({...options,create:false},dependencies);return owner;};
  return {cwd,specsRoot,identity,configuration,options,statePath,records,append,reopen,owner:()=>owner,reviewHost,reviews:()=>reviews};
}

test('an unknown red test needs explicit authorization and reason, then redoes with distinct records and evidence',async t=>{
  const f=await fixture(t);
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  const before=fs.readFileSync(f.statePath);
  f.append('fix-red-test-intent','intent',{testFiles:redTestFiles(f.configuration.redTest)});
  const oldOutput=path.join(f.specsRoot,'.reviews','fix-abandon-a1-red-output.md');
  fs.writeFileSync(oldOutput,'abandoned attempt output');
  assert.equal(f.owner().status().stage,'unknown');
  assert.equal(f.owner().abandonStep({reason:'Lost test result',authorized:true}).stage,'red_test_required');
  assert.equal((await f.owner().runRedTest({authorized:true})).stage,'baseline_required',JSON.stringify(f.records().map(r=>r.id)));
  assert(f.records().some(row=>row.id==='fix-red-test-retry-1-intent'));
  assert(f.records().some(row=>row.id==='fix-red-test-retry-1-result'));
  assert(f.records().some(row=>row.id==='fix-abandoned-1'));
  assert.match(f.owner().status().redTest.output.path,/retry-1/);
  assert.equal(fs.readFileSync(oldOutput,'utf8'),'abandoned attempt output');
  const events=fs.readFileSync(path.join(f.specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(events.some(row=>row.event==='abandon'&&row.pending==='red_test'&&row.reason==='Lost test result'));
  assert.notDeepEqual(fs.readFileSync(f.statePath),before);
});

test('a lost diagnosis can be abandoned only by an explicit owner call',async t=>{
  const f=await fixture(t);
  f.append('fix-reproduce-intent','intent',{stage:'reproduce'});
  assert.equal(f.owner().status().stage,'unknown');
  const before=fs.readFileSync(f.statePath);
  assert.equal((await f.owner().advance({authorized:true})).stage,'unknown');
  assert.deepEqual(fs.readFileSync(f.statePath),before);
  assert.throws(()=>f.owner().abandonStep({reason:'Process crashed',authorized:false}),{code:'fix_abandon_unavailable'});
  assert.equal(f.owner().abandonStep({reason:'Process crashed',authorized:true}).stage,'reproduce');
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  assert.deepEqual(f.owner().status().abandoned.map(row=>row.pending),['reproduce']);
  assert(f.records().some(row=>row.id==='fix-reproduce-retry-1-intent'));
  assert.equal(f.reopen().status().stage,'red_test_required');
});

test('a run without abandonment keeps its exact stored bytes on reopen and advance',async t=>{
  const f=await fixture(t);
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  const before=fs.readFileSync(f.statePath);
  const ids=f.records().map(row=>row.id);
  assert.deepEqual(ids.filter(id=>/^(fix-reproduce|fix-diagnose)-/.test(id)),
    ['fix-reproduce-intent','fix-reproduce-result','fix-diagnose-intent','fix-diagnose-result']);
  assert.deepEqual(f.owner().status().abandoned,[]);
  assert.equal(f.reopen().status().stage,'red_test_required');
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  assert.deepEqual(fs.readFileSync(f.statePath),before);
});

test('host refuses abandon without its launch flag',async t=>{
  const f=await fixture(t);
  f.append('fix-reproduce-intent','intent',{stage:'reproduce'});
  const host=createFixHost({owner:f.owner(),config:{...f.configuration,specsRoot:f.specsRoot,identity:f.identity},permissions:[]});
  await assert.rejects(host.handle({requestId:'a',operation:'abandon_step',reason:'Process crashed'}),{code:'fix_abandon_unavailable'});
  const allowed=createFixHost({owner:f.owner(),config:{...f.configuration,specsRoot:f.specsRoot,identity:f.identity},
    permissions:['--allow-abandon']});
  await assert.rejects(allowed.handle({requestId:'b',operation:'abandon_step'}),{code:'fix_abandon_unavailable'});
});

test('owner rejects abandon at a normal stage before looking for an unknown intent',async t=>{
  const f=await fixture(t);
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  const before=fs.readFileSync(f.statePath);
  const refusal=authorized=>{
    try{f.owner().abandonStep({authorized,reason:'No unknown step to abandon'});}
    catch(error){assert.equal(error.code,'fix_abandon_unavailable');return error;}
    assert.fail('abandonStep accepted a normal stage');
  };
  const missingAuthorization=refusal(false),wrongStage=refusal(true);
  // Both conditions belong to the same entry gate. A later missing-intent error
  // has the same code, but would mean the normal-stage check was bypassed.
  assert.equal(wrongStage.origin,missingAuthorization.origin);
  assert.deepEqual(fs.readFileSync(f.statePath),before);
  assert.deepEqual(f.owner().status().abandoned,[]);
});

test('host with --allow-abandon still rejects a normal stage without changing the store',async t=>{
  const f=await fixture(t);
  assert.equal((await f.owner().advance({authorized:true})).stage,'red_test_required');
  const before=fs.readFileSync(f.statePath);
  const config={...f.configuration,specsRoot:f.specsRoot,identity:f.identity};
  const request={requestId:'normal-stage',operation:'abandon_step',reason:'No unknown step to abandon'};
  const withoutFlag=createFixHost({owner:f.owner(),config,permissions:[]});
  const withFlag=createFixHost({owner:f.owner(),config,permissions:['--allow-abandon']});
  const rejection=async host=>host.handle(request).then(()=>assert.fail('host accepted a normal stage'),error=>{
    assert.equal(error.code,'fix_abandon_unavailable');return error;
  });
  const missingAuthorization=await rejection(withoutFlag),wrongStage=await rejection(withFlag);
  assert.equal(wrongStage.origin,missingAuthorization.origin);
  assert.deepEqual(fs.readFileSync(f.statePath),before);
  assert.deepEqual(f.owner().status().abandoned,[]);
});

async function toRepair(f){
  await f.owner().advance({authorized:true});
  await f.owner().runRedTest({authorized:true});
  assert.equal((await f.owner().captureBaseline({authorized:true})).stage,'repair_required');
}

test('abandoned repair and regression replay and redo to the clean next stages',async t=>{
  const f=await fixture(t);
  await toRepair(f);
  const atRepair=f.owner().status();
  const baseline=captureReviewBaseline({root:f.cwd,specsRoot:f.specsRoot,identity:f.identity,
    scope:f.configuration.repair.scope,requirements:f.configuration.repair.requirements});
  f.append('fix-repair-intent','intent',{baseline,redDigest:digest(atRepair.redTest),testBaselineDigest:digest(atRepair.baseline)});
  assert.equal(f.owner().status().stage,'unknown');
  assert.equal(f.owner().abandonStep({authorized:true,reason:'Repair response lost'}).stage,'repair_required');
  assert.equal((await f.owner().repair({authorized:true})).stage,'regression_required');
  const atRegression=f.owner().status();
  f.append('fix-regression-intent','intent',{repairDigest:digest(atRegression.repair),
    redDigest:digest(atRegression.redTest),baselineDigest:digest(atRegression.baseline)});
  assert.equal(f.owner().abandonStep({authorized:true,reason:'Regression process crashed'}).stage,'regression_required');
  assert.equal(f.reopen().status().stage,'regression_required');
  assert.equal((await f.owner().runRegression({authorized:true})).stage,'handoff_required');
  assert.deepEqual(f.owner().status().abandoned.map(row=>row.pending),['repair','regression']);
  assert.deepEqual(f.records().filter(row=>/^fix-abandoned-/.test(row.id)).map(row=>row.id),
    ['fix-abandoned-1','fix-abandoned-2']);
  for(const base of ['fix-repair','fix-regression']){
    assert(f.records().some(row=>row.id===`${base}-intent`));
    assert(f.records().some(row=>row.id===`${base}-retry-1-intent`));
    assert(f.records().some(row=>row.id===`${base}-retry-1-result`));
  }
});

test('reason, stage and replay digest validation reject invalid abandonment',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'too early'}),{code:'fix_abandon_unavailable'});
  f.append('fix-reproduce-intent','intent',{stage:'reproduce'});
  for(const reason of ['', '  ', 'a\nb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'x'.repeat(1001)])
    assert.throws(()=>f.owner().abandonStep({authorized:true,reason}),{code:'fix_abandon_unavailable'});
  assert.equal(f.owner().status().abandoned.length,0);
  assert.throws(()=>f.append('fix-abandoned-1','result',{pending:'reproduce',reason:'Crash',abandonedAt:Date.now(),
    intentDigest:'0'.repeat(64)}),{code:'fix_history_invalid'});
});

test('eight explicit abandonments are durable and the ninth is refused',async t=>{
  const f=await fixture(t);
  for(let n=1;n<=8;n++){
    f.append(n===1?'fix-reproduce-intent':`fix-reproduce-retry-${n-1}-intent`,'intent',{stage:'reproduce'});
    assert.equal(f.owner().status().stage,'unknown');
    assert.equal(f.owner().abandonStep({authorized:true,reason:`Crash ${n}`}).stage,'reproduce');
    assert.equal(f.reopen().status().abandoned.length,n);
  }
  f.append('fix-reproduce-retry-8-intent','intent',{stage:'reproduce'});
  const bytes=fs.readFileSync(f.statePath);
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Crash 9'}),{code:'fix_abandon_limit'});
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
  assert.equal((await f.owner().advance({authorized:true})).stage,'unknown');
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

test('observation diagnosis can be abandoned and redone on the same reviewed run',async t=>{
  const f=await fixture(t,{observation:true});
  assert.equal((await f.owner().advance({authorized:true})).stage,'observation');
  startFixRun(f.options);
  assert.equal(f.owner().finish({authorized:true}).observationRunEnded,true);
  f.reopen();
  fs.writeFileSync(path.join(f.specsRoot,'evidence.txt'),'Observed BUG after enabling the path');
  fs.writeFileSync(path.join(f.cwd,'enable'),'1');
  assert.equal(f.owner().resume({authorized:true,evidenceFiles:['evidence.txt']}).stage,'observation_resume_prepared');
  assert.equal((await f.owner().advance({authorized:true})).stage,'unknown');
  assert.equal(f.owner().status().pending,'observation_diagnose');
  assert.equal(f.owner().abandonStep({authorized:true,reason:'Lost diagnosis answer'}).stage,'observation_diagnose_required');
  assert.equal(f.reopen().status().stage,'observation_diagnose_required');
  assert.equal((await f.owner().advance({authorized:true})).stage,'cause_review_required');
  assert(f.records().some(row=>/fix-observation-(?:\d+-)?diagnose-retry-1-intent/.test(row.id)));
  assert(f.records().some(row=>/fix-observation-(?:\d+-)?diagnose-retry-1-result/.test(row.id)));
});

test('an unknown final review cannot use local abandonment',async t=>{
  const f=await fixture(t,{reviewMode:'lost'});
  await toRepair(f);
  assert.equal((await f.owner().repair({authorized:true})).stage,'regression_required');
  assert.equal((await f.owner().runRegression({authorized:true})).stage,'handoff_required');
  assert.equal((await f.owner().retrospect()).stage,'handoff_ready');
  assert.equal(f.owner().createHandoff().stage,'final_review_required');
  const pkg=f.owner().finalReviewPackage();
  await f.reviewHost.finalAuthority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
  assert.equal((await f.owner().reviewFinal()).stage,'unknown');
  assert.equal(f.owner().status().pending,'final_review');
  const before=fs.readFileSync(f.statePath);
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Do not abandon review'}),{code:'fix_abandon_unavailable'});
  assert.deepEqual(fs.readFileSync(f.statePath),before);
});

test('an unknown cause review cannot use local abandonment',async t=>{
  const f=await fixture(t,{reviewMode:'lost',crossLayer:true});
  assert.equal((await f.owner().advance({authorized:true})).stage,'cause_review_required');
  const pkg=f.owner().causeReviewPackage();
  await f.reviewHost.authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
  assert.equal((await f.owner().reviewCause()).stage,'unknown');
  assert.equal(f.owner().status().pending,'cause_review');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Review result lost'}),{code:'fix_abandon_unavailable'});
});

test('an unknown handoff cannot use local abandonment',async t=>{
  const f=await fixture(t);
  await toRepair(f);
  await f.owner().repair({authorized:true});
  await f.owner().runRegression({authorized:true});
  assert.equal((await f.owner().retrospect()).stage,'handoff_ready');
  const status=f.owner().status();
  const redOutput=verifyFixRedEvidence(status.redTest,f.configuration.redTest,f.specsRoot);
  const evidence=[...fixHandoffEvidence({identity:f.identity,learning:status.learning,retrospective:status.retrospective}),
    ...fixDefectHandoffEvidence({configuration:f.configuration,reproduction:status.reproduction,
      diagnosis:status.diagnosis,redTest:status.redTest,redOutput})];
  f.append('fix-handoff-intent','intent',{packageDigest:f.owner().implementationPackage().packageDigest,evidence,redOutput});
  assert.equal(f.owner().status().pending,'handoff');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Inspect handoff files first'}),{code:'fix_abandon_unavailable'});
});

test('an unknown Learning writeback cannot use local abandonment',async t=>{
  const f=await fixture(t,{lesson:true});
  await toRepair(f);
  await f.owner().repair({authorized:true});
  await f.owner().runRegression({authorized:true});
  assert.equal((await f.owner().retrospect()).stage,'learning_writeback_required');
  const status=f.owner().status();
  f.append('fix-learning-writeback-intent','intent',{identity:f.identity,learningDigest:digest(status.learning),
    retrospectiveDigest:digest(status.retrospective),packageDigest:status.retrospective.packageDigest});
  assert.equal(f.owner().status().pending,'learning_writeback');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Inspect project instructions first'}),{code:'fix_abandon_unavailable'});
});

async function toRevision(f){
  await toRepair(f);
  await f.owner().repair({authorized:true});
  await f.owner().runRegression({authorized:true});
  await f.owner().retrospect();
  f.owner().createHandoff();
  const pkg=f.owner().finalReviewPackage();
  await f.reviewHost.finalAuthority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
  assert.equal((await f.owner().reviewFinal()).stage,'final_review_evidence_required');
  assert.equal(f.owner().publishReview().stage,'final_review_changes_requested');
  assert.equal((await f.owner().prepareRevision({authorized:true})).stage,'revision_prepared');
}

async function completeRevisionRepair(f){
  assert.equal((await f.owner().repair({authorized:true})).stage,'unknown');
  assert.equal(f.owner().status().pending,'revision_repair');
  assert.equal(f.owner().abandonStep({authorized:true,reason:'Lost local repair answer'}).stage,'revision_prepared');
  assert.equal(f.reopen().status().stage,'revision_prepared');
  assert.equal((await f.owner().repair({authorized:true})).stage,'revision_regression_required');
}

test('revision repair can be abandoned and redone without resetting the review round',async t=>{
  const f=await fixture(t,{reviewMode:'changes_requested'});
  await toRevision(f);
  await completeRevisionRepair(f);
  assert(f.records().some(row=>row.id==='fix-revision-repair-retry-1-intent'));
  assert(f.records().some(row=>row.id==='fix-revision-repair-retry-1-result'));
  assert.equal(f.owner().status().revision.nextIdentity.attempt,2);
});

test('revision Learning writeback cannot use local abandonment',async t=>{
  const f=await fixture(t,{reviewMode:'changes_requested',lesson:'revision'});
  await toRevision(f);await completeRevisionRepair(f);
  assert.equal((await f.owner().runRegression({authorized:true})).stage,'revision_handoff_required');
  assert.equal((await f.owner().retrospect()).stage,'revision_learning_writeback_required');
  const status=f.owner().status();
  f.append('fix-revision-learning-writeback-intent','intent',{identity:status.revision.nextIdentity,
    learningDigest:digest(status.revision.learning),retrospectiveDigest:digest(status.revisionRetrospective),
    packageDigest:status.revisionRetrospective.packageDigest});
  assert.equal(f.owner().status().pending,'revision_learning_writeback');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Inspect project instructions first'}),{code:'fix_abandon_unavailable'});
});

test('revision handoff cannot use local abandonment',async t=>{
  const f=await fixture(t,{reviewMode:'changes_requested'});
  await toRevision(f);await completeRevisionRepair(f);
  await f.owner().runRegression({authorized:true});
  assert.equal((await f.owner().retrospect()).stage,'revision_handoff_ready');
  const handoff=path.join(f.specsRoot,'.reviews',`fix-abandon-${f.identity.taskId}-a2-handoff.json`);
  fs.symlinkSync(path.join(f.cwd,'requirements.md'),handoff);
  assert.equal(f.owner().createHandoff().stage,'unknown');
  assert.equal(f.owner().status().pending,'revision_handoff');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Inspect handoff file first'}),{code:'fix_abandon_unavailable'});
});

test('revision final review cannot use local abandonment',async t=>{
  const f=await fixture(t,{reviewMode:'second_lost'});
  await toRevision(f);await completeRevisionRepair(f);
  await f.owner().runRegression({authorized:true});
  await f.owner().retrospect();
  assert.equal(f.owner().createHandoff().stage,'revision_final_review_required');
  const pkg=f.owner().finalReviewPackage();
  await f.reviewHost.finalAuthority.hostDecisionProvider.decide({identity:f.owner().status().revision.nextIdentity,
    packageDigest:pkg.packageDigest},new AbortController().signal);
  assert.equal((await f.owner().reviewFinal()).stage,'unknown');
  assert.equal(f.owner().status().pending,'revision_final_review');
  assert.throws(()=>f.owner().abandonStep({authorized:true,reason:'Review result lost'}),{code:'fix_abandon_unavailable'});
});
