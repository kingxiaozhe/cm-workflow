import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {captureReviewBaseline,readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';
import {readTestExtensionPlan,verifyExtensionFiles,extendRevisionReviewBaseline,inventory} from '../runtime/js/cm-fix/test-extension.mjs';

// Real temporary files/commands/owner/CLI; model responses and diagnostics are
// synthetic. No live provider, XBrief writes, installation or Git operations.
async function fixture(t,mode='changes_requested',hooks={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-review-recovery-')));
  const cwd=path.join(root,'code');fs.mkdirSync(cwd);
  const logHome=process.env.CM_WORKFLOW_LOG_HOME;process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'mirror');
  t.after(()=>{if(logHome===undefined)delete process.env.CM_WORKFLOW_LOG_HOME;else process.env.CM_WORKFLOW_LOG_HOME=logHome;fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const config={identity:{repositoryId:'fixture',runId:'recovery',taskId:'T-FIX-one',attempt:1},defect:'Wrong value',
    reproduction:{cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['value.mjs']},
    walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read value'],expected:['value is 2'],kind:'commands',command:[process.execPath,'red.mjs']}]}};
  const permissions=['--allow-cause-review','--allow-reproduction','--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
  const model='synthetic',review={model,disabledSkills:[],preflight:{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd,model,disabledSkills:[]})}};
  let calls=0,repairs=0,authors=0;
  const workerFactory=()=>async({prompt},{onEvent})=>{
    calls++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    const thread=calls===1||mode==='reuse-thread'||['reuse-first-thread','revision-reuses-lost-thread'].includes(mode)&&calls===3?'old-thread':`new-thread-${calls}`;
    onEvent({event:'thread.started',provider_thread:thread});
    if(calls===1&&!['approved','changes_requested','cause-tests'].includes(mode)||mode==='loss-again'
      ||['twice-then-success','reuse-first-thread'].includes(mode)&&calls<=2)throw Error('Synthetic lost result');
    const verdict=mode==='changes_requested'&&calls===1||mode==='revision-reuses-lost-thread'&&calls===2?'changes_requested':'approved';
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict,packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
      findings:verdict==='changes_requested'?[{id:'F1',severity:'P2',path:'value.mjs',message:'Add missing boundary coverage',evidence:'Fixture'}]:[],summary:'Synthetic'}};
  };
  const reviewHost=createFixReviewHost({codeProject:cwd,hostContextId:'fixture-host',review,permissions,workerFactory});
  const configuration={hostContextId:'fixture-host',...config,causeReview:reviewHost.reviewer};delete configuration.identity;
  const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}};
  const bridge={async call(kind){
    if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong value',plan:'Correct value',affectedPaths:mode==='cause-tests'?['value.mjs','red.mjs']:['value.mjs'],affectedModules:mode==='cause-tests'?['value','two','three']:['value'],crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
    if(kind==='fix_test_author'){authors++;if(hooks.author)await hooks.author(cwd);else fs.appendFileSync(path.join(cwd,'red.mjs'),'\n// additional boundary assertion\nif(!Number.isInteger(value))process.exit(2);');return {outcome:'authored'};}
    if(kind==='fix_repair'){repairs++;if(!(hooks.noSourceRevision&&repairs>1))fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;'+(repairs>1?' // revised':''));return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    throw Error(kind);
  }};
  if(mode==='cause-tests'){configuration.testAuthor={requirements:['value.mjs']};delete configuration.walkthrough;}
  const options={identity:config.identity,configuration,create:true};
  let owner=openFixExecution(options,{...reviewHost.execution,bridge,prepare:async()=>learning});
  t.after(()=>owner.close());
  const host=createFixHost({owner,config,permissions,authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority});
  if(mode==='cause-tests'){
    await owner.advance({authorized:true});
    const pkg=owner.causeReviewPackage();await reviewHost.authority.hostDecisionProvider.decide({identity:config.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    await owner.reviewCause();
    return {owner:()=>owner,cwd,options,authors:()=>authors,reviewHost};
  }
  for(const operation of ['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review'])
    await host.handle({requestId:operation,operation});
  const specsRoot=path.join(cwd,'docs/fixes'),statePath=path.join(specsRoot,'.reviews/.execution/recovery/state.json');
  const bytes=fs.readFileSync(statePath),state=JSON.parse(bytes),registered=state.records.find(r=>r.id==='fix-final-registered').payload;
  const request={requestId:'recover',operation:'recover_final_review',invocationId:registered.request.invocationId,
    packageDigest:registered.request.payload.reviewPackage.packageDigest,previousInvocationStopped:true,reason:'Human authorized one continuation; previous process stopped'};
  const reopen=()=>{owner.close();owner=openFixExecution({...options,create:false},{...reviewHost.execution,bridge,prepare:async()=>learning});return owner;};
  return {cwd,statePath,bytes,state,request,reopen,host:()=>createFixHost({owner,config,permissions,authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority}),owner:()=>owner,calls:()=>calls,repairs:()=>repairs,authors:()=>authors,options};
}

const plan={testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],reason:'Coverage: integer boundary omitted by round 1 tests; original failure remains archived.',findingIds:['F1']};
test('F56 F4 revision test-author executes and retains original red evidence',async t=>{
  const f=await fixture(t),owner=f.owner();owner.publishReview();
  const before=JSON.parse(fs.readFileSync(f.statePath)).records;
  assert.throws(()=>openFixExecution({...f.options,identity:{...f.options.identity,runId:'other-run'}}),{code:'fix_evidence_name_taken'});
  const red=owner.status().redTest,bytes=fs.readFileSync(path.join(f.cwd,'docs/fixes',red.output.path));
  await owner.prepareRevision({authorized:true,tests:plan});
  await owner.authorTests({authorized:true});
  assert.equal(f.authors(),1,'F4 authorTests never dispatched in revision_prepared');
  assert.equal(owner.status().stage,'revision_test_check_required');
  await owner.runRevisionTests({authorized:true});
  assert.equal(owner.status().stage,'revision_prepared');
  await owner.repair({authorized:true});await owner.runRegression({authorized:true});
  assert.equal(owner.status().stage,'revision_handoff_required');
  await owner.retrospect();owner.createHandoff();
  assert.equal(owner.status().stage,'revision_final_review_required');
  assert.deepEqual(owner.status().redTest,red);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd,'docs/fixes',red.output.path)),bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,before.length),before);
  assert.equal(f.reopen().status().stage,'revision_final_review_required');
  for(const operation of ['final_review','publish_review','check_n5','post_review_regression','walkthrough','finish'])await f.host().handle({requestId:operation,operation});
  assert.equal(f.reopen().status().stage,'completed');
});
test('F56 F6 reviewed affected test accepts only registered author changes',async t=>{
  const f=await fixture(t,'cause-tests'),owner=f.owner();
  assert.equal(owner.status().stage,'test_author_required');
  const stateFile=path.join(f.cwd,'docs/fixes/.reviews/.execution/recovery/state.json');
  const history=JSON.parse(fs.readFileSync(stateFile)).records;
  const causeFile=path.join(f.cwd,'docs/fixes/.reviews/fix-one-cause-r1.md'),receipt=fs.readFileSync(causeFile);
  await owner.authorTests({authorized:true});
  assert.equal(owner.status().stage,'red_test_required');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).records.slice(0,history.length),history);
  assert.deepEqual(fs.readFileSync(causeFile),receipt);
  await owner.runRedTest({authorized:true});assert.equal(owner.status().stage,'baseline_required');
  fs.appendFileSync(path.join(f.cwd,'value.mjs'),' // unauthorized source change');
  assert.equal(owner.status().stage,'cause_review_drift');
  fs.writeFileSync(path.join(f.cwd,'value.mjs'),'export const value=1;');
  fs.appendFileSync(causeFile,'tampered');
  assert.equal(owner.status().stage,'cause_review_evidence_required');
});

test('F56 coverage-only revision does not require a fake business edit',async t=>{
  const f=await fixture(t,'changes_requested',{noSourceRevision:true}),owner=f.owner();owner.publishReview();
  await owner.prepareRevision({authorized:true,tests:plan});await owner.authorTests({authorized:true});await owner.runRevisionTests({authorized:true});
  await owner.repair({authorized:true});
  assert.equal(owner.status().stage,'revision_regression_required');
  assert.deepEqual(owner.status().revisionRepair.changedFiles,[]);
  await owner.runRegression({authorized:true});await owner.retrospect();owner.createHandoff();
  assert.equal(owner.status().stage,'revision_final_review_required');
});

test('F56 extension accepts a new file and extended baseline test in the same review',async t=>{
  const f=await fixture(t,'changes_requested',{author(cwd){
    fs.appendFileSync(path.join(cwd,'existing.mjs'),';if(!Number.isInteger(value))process.exit(2);');
    fs.writeFileSync(path.join(cwd,'boundary.mjs'),"import {value} from './value.mjs';if(value!==2)process.exit(3)");
  }}),owner=f.owner();owner.publishReview();
  const selected={...plan,testFiles:['boundary.mjs','existing.mjs'],command:[process.execPath,'--test','boundary.mjs','existing.mjs']};
  await owner.prepareRevision({authorized:true,tests:selected});await owner.authorTests({authorized:true});
  assert.equal(owner.status().stage,'revision_test_check_required');
  const before=owner.status().baseline;
  assert.equal((await owner.repair({authorized:true})).stage,'revision_test_check_required');
  await owner.runRevisionTests({authorized:true});await owner.repair({authorized:true});await owner.runRegression({authorized:true});
  assert.equal(owner.status().stage,'revision_handoff_required');
  await owner.retrospect();owner.createHandoff();
  const pkg=owner.finalReviewPackage();
  assert(pkg.changes.some(change=>change.path==='boundary.mjs'&&change.before===null));
  assert(pkg.changes.some(change=>change.path==='existing.mjs'&&change.before!==null));
  assert.deepEqual(owner.status().baseline,before);
});

test('F56 coverage failure is recorded honestly and must pass after repair',async t=>{
  const f=await fixture(t),owner=f.owner();owner.publishReview();
  await owner.prepareRevision({authorized:true,tests:{...plan,command:[process.execPath,'-e','process.exit(5)']}});
  await owner.authorTests({authorized:true});await owner.runRevisionTests({authorized:true});
  assert.equal(owner.status().stage,'revision_prepared');
  assert.equal(owner.status().revisionTestCheck.observations[0].exitCode,5);
  assert.equal(owner.status().redTest.observation.exitCode,1);
  await owner.repair({authorized:true});await owner.runRegression({authorized:true});
  assert.equal(owner.status().stage,'revision_regression_blocked');
  assert.equal(owner.status().revisionRegression.testExtension.observations[0].exitCode,5);
  assert.equal(f.reopen().status().stage,'revision_regression_blocked');
});

test('F56 lost test-author result remains unknown and never dispatches again',async t=>{
  const f=await fixture(t,'changes_requested',{author(cwd){fs.appendFileSync(path.join(cwd,'red.mjs'),'\n// interrupted edit');throw Error('lost');}});
  const owner=f.owner();owner.publishReview();await owner.prepareRevision({authorized:true,tests:plan});
  assert.equal((await owner.authorTests({authorized:true})).stage,'unknown');
  const resumed=f.reopen();await resumed.authorTests({authorized:true});await resumed.runRevisionTests({authorized:true});
  assert.equal(resumed.status().stage,'unknown');assert.equal(f.authors(),1);
});

test('F56 unauthorized edit after preparation is refused before registering author intent',async t=>{
  const f=await fixture(t),owner=f.owner();owner.publishReview();await owner.prepareRevision({authorized:true,tests:plan});
  const records=JSON.parse(fs.readFileSync(f.statePath)).records;
  fs.appendFileSync(path.join(f.cwd,'value.mjs'),' // unauthorized');
  await owner.authorTests({authorized:true});
  assert.equal(f.authors(),0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records,records);
  assert.equal(f.reopen().status().stage,'revision_test_evidence_required');
});

test('F56 rejects missing findings, business scope, permissions, late edits and changed raw red',async t=>{
  const f=await fixture(t),owner=f.owner();owner.publishReview();
  await assert.rejects(owner.prepareRevision({authorized:true,tests:{...plan,findingIds:['absent']}}),{code:'fix_test_extension_finding_required'});
  await assert.rejects(owner.prepareRevision({authorized:true,tests:{...plan,testFiles:['value.mjs']}}),{code:'fix_test_extension_scope'});
  await assert.rejects(owner.prepareRevision({authorized:true,tests:{...plan,reason:''}}));
  await owner.prepareRevision({authorized:true,tests:plan});
  await assert.rejects(owner.authorTests(),{code:'test_author_authorization_required'});
  await owner.authorTests({authorized:true});
  await assert.rejects(owner.runRevisionTests(),{code:'regression_authorization_required'});
  await owner.runRevisionTests({authorized:true});
  const redFile=path.join(f.cwd,'docs/fixes',owner.status().redTest.output.path),red=fs.readFileSync(redFile);
  const altered=JSON.parse(red);altered.stderrBase64=Buffer.from('BUG changed historical output').toString('base64');
  fs.writeFileSync(redFile,JSON.stringify(altered));assert.equal(owner.status().stage,'red_test_evidence_required');fs.writeFileSync(redFile,red);
  fs.appendFileSync(path.join(f.cwd,'red.mjs'),' // unregistered');
  assert.equal(owner.status().stage,'revision_test_evidence_required');
});

test('F56 existing prepared revision can append a test plan without rewriting preparation',async t=>{
  const f=await fixture(t),owner=f.owner();owner.publishReview();await owner.prepareRevision({authorized:true});
  const before=JSON.parse(fs.readFileSync(f.statePath)).records;
  await owner.prepareRevision({authorized:true,tests:plan});
  assert.equal(owner.status().stage,'revision_test_author_required');
  await owner.authorTests({authorized:true});await owner.runRevisionTests({authorized:true});await owner.repair({authorized:true});
  assert.equal(owner.status().stage,'revision_regression_required');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,before.length),before);
  assert.equal(f.reopen().status().stage,'revision_regression_required');
});

test('F56 M2 extension plan rejects an absent file reserved for business repair',()=>{
  // A new file passes the existing-file restriction; only repair-scope exclusion
  // prevents authoring it as a test before the business repair creates it.
  const context={configuration:{redTest:{testFiles:['red.mjs']},baseline:{testFiles:['existing.mjs']},
    repair:{scope:['new-business.mjs']}},feedback:{review:{verdict:'changes_requested',findings:[{id:'F1'}]}},files:[]};
  assert.deepEqual(readTestExtensionPlan({...plan,testFiles:['new-boundary.mjs']},context).testFiles,['new-boundary.mjs']);
  for(const file of ['new-business.mjs','NEW-BUSINESS.mjs'])
    assert.throws(()=>readTestExtensionPlan({...plan,testFiles:[file]},context),{code:'fix_test_extension_scope'});
});

test('F56 M3 extension file verification rejects post-author edits before downstream evidence',t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-extension-drift-')));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,'new-boundary.mjs'),authored='if(2+2!==4)throw Error("boundary");';
  fs.writeFileSync(file,authored);
  const extension={plan:{...plan,testFiles:['new-boundary.mjs']},files:inventory(readReviewSourceFiles(cwd,['new-boundary.mjs']))};
  const registered=JSON.stringify(extension);
  assert.doesNotThrow(()=>verifyExtensionFiles(cwd,extension));
  fs.writeFileSync(file,'if(2+2!==4)throw Error("tampered");');
  assert.throws(()=>verifyExtensionFiles(cwd,extension),{code:'fix_test_extension_drift'});
  assert.equal(JSON.stringify(extension),registered);
  fs.writeFileSync(file,authored);assert.doesNotThrow(()=>verifyExtensionFiles(cwd,extension));
});

test('F56 M4 review baseline promotion rejects changed overlapping test bytes',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-extension-baseline-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'existing.mjs'),'// original reviewed test');
  const options={root:cwd,specsRoot,identity:{repositoryId:'fixture',runId:'baseline',taskId:'T-FIX-overlap',attempt:2},requirements:['value.mjs']};
  const original=captureReviewBaseline({...options,scope:['value.mjs']}),bytes=JSON.stringify(original);
  assert.equal(Object.hasOwn(original.files.find(file=>file.path==='existing.mjs'),'contentBase64'),false);
  const author=captureReviewBaseline({...options,scope:['existing.mjs']});
  const promoted=extendRevisionReviewBaseline(original,author);
  assert.deepEqual(promoted.files.find(file=>file.path==='existing.mjs'),author.files.find(file=>file.path==='existing.mjs'));
  fs.writeFileSync(path.join(cwd,'existing.mjs'),'// hidden edit before test author');
  const drifted=captureReviewBaseline({...options,scope:['existing.mjs']});
  assert.throws(()=>extendRevisionReviewBaseline(original,drifted),{code:'fix_revision_source_mismatch'});
  assert.equal(JSON.stringify(original),bytes);
});
