import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {PassThrough,Writable} from 'node:stream';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {preflight} from './cm-fix-drive.mjs';
import {spawnSync} from 'node:child_process';

async function fixture(t,fn,{secondVerdict='approved',secondThread='fresh-review-2',prepare=null,redTest=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-rediagnosis-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(code);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(code,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'rediagnosis-run',taskId:'T-FIX-rediagnosis',attempt:1};
  const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'independent-review',excludedThreadIds:[]};
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Fixture mismatch',causeReview:reviewer,
    reproduction:{cwd:code,command:[process.execPath,'-e',"require('node:fs').appendFileSync('visits','1');process.stderr.write('BUG');process.exit(3)"],expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}}};
  if(redTest)options.configuration.redTest={...options.configuration.reproduction,testFiles:['value.mjs']};
  const authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  let calls=0,diagnoses=0;const diagnosis={status:'diagnosed',rootCause:'Fixture old cause',plan:'Fixture plan',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};
  const causeReview={authorize:authority.authorize,run:createCauseReviewRun(async({prompt},{onEvent})=>{
    const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);calls++;
    for(const event of [{event:'thread.started',provider_thread:calls===1?'fresh-review-1':secondThread},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
    return {status:'succeeded',value:{verdict:calls===1?'changes_requested':secondVerdict,packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:(calls===1||secondVerdict==='changes_requested')?[{id:'F1',severity:'P2',path:'value.mjs',message:'Cause is incomplete',evidence:'Fixture finding'}]:[],summary:'Fixture independent review'}};
  },'codex')};
  const bridge={async call(kind,payload){assert.equal(kind,'fix_diagnose');diagnoses++;
    if(diagnoses>1){assert.equal(payload.reviewFeedback.verdict,'changes_requested');return {...diagnosis,rootCause:'Fixture revised cause',crossLayer:false};}
    return diagnosis;}};
  let owner=openFixExecution(options,{bridge,causeReview,prepare});
  const state=path.join(specsRoot,'.reviews/.execution',identity.runId,'state.json');
  const review=async()=>{const pkg=owner.causeReviewPackage();await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);return owner.reviewCause();};
  const reopen=(overrides={})=>{owner.close();owner=openFixExecution({...options,create:false},{bridge,causeReview,prepare,...overrides});return owner;};
  try{await owner.advance({authorized:true});await review();assert.equal(owner.status().stage,'rediagnosis_required');
    await fn({root,code,specsRoot,identity,options,authority,bridge,causeReview,state,review,reopen,owner:()=>owner,counts:()=>({calls,diagnoses})});
  }finally{owner.close();}
}
test('original run rediagnoses after cause rejection, preserves history, and requires fresh independent review',async t=>fixture(t,async f=>{
  const old=JSON.parse(fs.readFileSync(f.state)).records;
  const first=fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r1.md'));
  let owner=f.reopen();await assert.rejects(owner.rediagnose({reason:'Address F1'}),{code:'fix_rediagnosis_authorization_required'});
  const host=createFixHost({owner,config:{...f.options.configuration,...f.options},permissions:['--allow-rediagnosis']});
  const input=new PassThrough();let output='';
  const sink=new Writable({write(chunk,encoding,done){output+=chunk;done();}});
  input.end(JSON.stringify({requestId:'redo',operation:'rediagnose',reason:'Address F1'})+'\n');
  await serveCmAiHost({host,input,output:sink});
  const changed=JSON.parse(output).result;
  assert.equal(changed.stage,'cause_review_required');assert.equal(changed.completionEligible,false);
  const next=JSON.parse(fs.readFileSync(f.state)).records;assert.deepEqual(next.slice(0,old.length),old);
  assert.equal(fs.readFileSync(path.join(f.code,'visits'),'utf8'),'1');
  owner=f.reopen();assert.equal(owner.status().stage,'cause_review_required');assert.equal(owner.status().diagnosis.rootCause,'Fixture revised cause');
  assert.equal((await f.review()).stage,'red_test_required');
  assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r1.md')),first);
  assert.match(fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'),'utf8'),/round: 2\nverdict: approved/);
  owner=f.reopen();assert.equal(owner.status().stage,'red_test_required');
  await assert.rejects(owner.rediagnose({authorized:true,reason:'Again'}),{code:'fix_rediagnosis_unavailable'});
  assert.deepEqual(f.counts(),{calls:2,diagnoses:2});
}));
const revised={status:'diagnosed',rootCause:'Fixture revised cause',plan:'Fixture plan',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:false};
const tooManyAlternatives={...revised,investigation:{boundaryAnalysis:null,
  discardedAlternatives:[1,2,3,4].map(n=>({option:`Fixture option ${n}`,reason:'Fixture reason'}))}};
async function hostRediagnose(f,reason='Address F1'){
  const owner=f.owner(),host=createFixHost({owner,config:{...f.options.configuration,...f.options},permissions:['--allow-rediagnosis']});
  const input=new PassThrough();let output='',errors='';
  const sink=new Writable({write(chunk,encoding,done){output+=chunk;done();}});
  const errorOutput=new Writable({write(chunk,encoding,done){errors+=chunk;done();}});
  input.end(JSON.stringify({requestId:'redo',operation:'rediagnose',reason})+'\n');
  await serveCmAiHost({host,input,output:sink,errorOutput});
  return {reply:JSON.parse(output),errors};
}
const ids=file=>JSON.parse(fs.readFileSync(file)).records.map(row=>row.id);
test('regression: invalid rediagnosis answer is invalid_diagnosis, stays pending, and a valid answer under the same intent reaches cause-r2',async t=>fixture(t,async f=>{
  const before=JSON.parse(fs.readFileSync(f.state)).records;
  f.bridge.call=async kind=>{assert.equal(kind,'fix_diagnose');return tooManyAlternatives;};
  f.reopen();
  const rejected=await hostRediagnose(f);
  assert.deepEqual(rejected.reply.error,{code:'host_request_failed'});
  const diagnostic=JSON.parse(rejected.errors.trim().split('\n').at(-1));
  assert.equal(diagnostic.code,'invalid_diagnosis');assert.match(diagnostic.reason,/investigation\.discardedAlternatives.*最多 3 项，实际 4 项/);
  let owner=f.reopen();
  assert.equal(owner.status().stage,'unknown');assert.equal(owner.status().pending,'rediagnosis');
  const pendingIds=ids(f.state);assert.deepEqual(pendingIds.slice(before.length),['fix-rediagnosis-intent']);
  await assert.rejects(owner.rediagnose({authorized:true,reason:'Retry'}),{code:'invalid_diagnosis'});
  assert.deepEqual(ids(f.state),pendingIds);
  let asked=0;f.bridge.call=async(kind,payload)=>{asked++;assert.equal(payload.reviewFeedback.verdict,'changes_requested');return revised;};
  owner=f.reopen();
  assert.equal((await hostRediagnose(f,'Resubmit valid answer')).reply.result.stage,'cause_review_required');
  const next=JSON.parse(fs.readFileSync(f.state)).records;
  assert.deepEqual(next.slice(0,before.length),before);
  assert.deepEqual(next.slice(before.length).map(row=>row.id),['fix-rediagnosis-intent','fix-rediagnosis-result']);
  assert.equal(next[before.length].payload.reason,'Address F1');
  owner=f.reopen();assert.equal(owner.status().diagnosis.rootCause,'Fixture revised cause');
  assert.equal((await f.review()).stage,'red_test_required');
  assert.match(fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'),'utf8'),/round: 2\nverdict: approved/);
  assert.equal(asked,1);assert.equal(f.counts().calls,2);
  assert.equal(fs.readFileSync(path.join(f.code,'visits'),'utf8'),'1');
}));
for(const secondVerdict of ['approved','changes_requested'])test(`regression: an old journal ending in fix-rediagnosis-intent without a result resumes by re-asking under that intent (${secondVerdict})`,async t=>fixture(t,async f=>{
  // Old runtime: intent appended, answer rejected inside the catch, nothing else written.
  f.bridge.call=async()=>{throw Error('Fixture lost result');};
  const result=await f.owner().rediagnose({authorized:true,reason:'Address F1'});
  assert.equal(result.stage,'unknown');assert.equal(result.pending,'rediagnosis');
  const stuck=fs.readFileSync(f.state),stuckIds=ids(f.state);
  assert.equal(stuckIds.at(-1),'fix-rediagnosis-intent');
  let owner=f.reopen();
  assert.equal((await owner.advance({authorized:true})).stage,'unknown');
  const host=createFixHost({owner,config:{...f.options.configuration,...f.options},permissions:['--allow-rediagnosis']});
  const status=await host.handle({requestId:'s',operation:'status'});
  assert.equal(status.progress.blocker,'rediagnosis_answer_required');assert.match(status.progress.nextAction,/rediagnose/);
  assert.deepEqual(fs.readFileSync(f.state),stuck);
  f.bridge.call=async()=>revised;
  owner=f.reopen();
  assert.equal((await owner.rediagnose({authorized:true,reason:'Resume pending rediagnosis'})).stage,'cause_review_required');
  assert.deepEqual(ids(f.state),[...stuckIds,'fix-rediagnosis-result']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)).records.slice(0,stuckIds.length),JSON.parse(stuck).records);
  // The re-ask used the registered continuation: the review limit still applies.
  const stage=secondVerdict==='approved'?'red_test_required':'rediagnosis_review_limit_reached';
  assert.equal((await f.review()).stage,stage);
  owner=f.reopen();assert.equal(owner.status().stage,stage);
  await assert.rejects(owner.rediagnose({authorized:true,reason:'Again'}),{code:'fix_rediagnosis_unavailable'});
  assert.equal(ids(f.state).filter(id=>id==='fix-rediagnosis-intent').length,1);
  assert.equal(fs.readFileSync(path.join(f.code,'visits'),'utf8'),'1');
},{secondVerdict}));
test('driver preflight refuses an invalid rediagnosis answer before starting the host',async t=>fixture(t,async f=>{
  const config=path.join(f.root,'driver-config.json'),answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(config,JSON.stringify({specsRoot:f.specsRoot,identity:f.identity,reproduction:f.options.configuration.reproduction}));
  fs.writeFileSync(path.join(answers,'learning.json'),JSON.stringify({status:'no_relevant_lesson',summary:'Fixture'}));
  const run=file=>{fs.writeFileSync(path.join(answers,'diagnosis-rediagnosis.json'),JSON.stringify(file));
    const script=`import {preflight} from ${JSON.stringify(new URL('./cm-fix-drive.mjs',import.meta.url).href)};preflight(${JSON.stringify({operation:'rediagnose',plan:{cwd:f.code,mode:'resume'},paths:{config,answers}})});`;
    return spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});};
  const before=fs.readFileSync(f.state);
  const refused=run(tooManyAlternatives);
  assert.equal(refused.status,2);assert.match(refused.stderr,/diagnosis-rediagnosis\.json.*investigation\.discardedAlternatives.*最多 3 项，实际 4 项.*宿主未启动/);
  assert.equal(run(revised).status,0);
  assert.deepEqual(fs.readFileSync(f.state),before);
}));
for(const failure of ['source','evidence','reason'])test(`rediagnosis refuses ${failure} before registering a new effect`,async t=>fixture(t,async f=>{
  const before=fs.readFileSync(f.state);
  if(failure==='source')fs.writeFileSync(path.join(f.code,'value.mjs'),'export const value=2;');
  if(failure==='evidence')fs.writeFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'),'Other evidence');
  await assert.rejects(f.owner().rediagnose({authorized:true,reason:failure==='reason'?'bad\nreason':'Address F1'}),
    {code:failure==='source'?'fix_rediagnosis_source_changed':failure==='evidence'?'fix_rediagnosis_evidence_conflict':'fix_rediagnosis_reason_invalid'});
  assert.deepEqual(fs.readFileSync(f.state),before);
}));

test('a second cause rejection reaches a durable limit without allowing a third diagnosis or review',async t=>fixture(t,async f=>{
  await f.owner().rediagnose({authorized:true,reason:'Address F1'});
  assert.equal((await f.review()).stage,'rediagnosis_review_limit_reached');
  const before=fs.readFileSync(f.state),owner=f.reopen();
  assert.equal(owner.status().stage,'rediagnosis_review_limit_reached');
  await assert.rejects(owner.rediagnose({authorized:true,reason:'Again'}),{code:'fix_rediagnosis_unavailable'});
  await assert.rejects(f.review());
  assert.deepEqual(fs.readFileSync(f.state),before);assert.deepEqual(f.counts(),{calls:2,diagnoses:2});
},{secondVerdict:'changes_requested'}));
test('the original reviewer thread cannot be reused as the revised cause review',async t=>fixture(t,async f=>{
  await f.owner().rediagnose({authorized:true,reason:'Address F1'});
  const result=await f.review();assert.notEqual(result.stage,'red_test_required');assert.equal(result.completionEligible,false);
  const owner=f.reopen();assert.notEqual(owner.status().stage,'red_test_required');
  assert.equal(fs.existsSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md')),false);
},{secondThread:'fresh-review-1'}));

const learningFor=summary=>{const contextDigest=digest([]);return {contextDigest,files:[],application:{contextDigest,status:'no_relevant_lesson',summary}};};
test('driver resumes with recorded application after real Learning writeback without an answer file',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-drive-writeback-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs'),answers=path.join(root,'answers');
  for(const dir of [cwd,specsRoot,answers])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  const identity={repositoryId:'fixture',runId:'writeback-run',taskId:'T-FIX-writeback',attempt:1};
  const reproduction={cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000};
  const owner=openFixExecution({identity,specsRoot,create:true,configuration:{hostContextId:'fixture-host',defect:'Wrong constant',reproduction,
    redTest:{...reproduction,testFiles:['red.mjs']},baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['value.mjs']}}},{prepare:async()=>learningFor('Current application'),assertReviewReady(){},bridge:{async call(kind){
      if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['one'],crossLayer:false,plan:'Correct constant'};
      if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
      if(kind==='fix_retrospective')return {status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Wrong constant',action:'Keep regression check',evidence:['red.mjs']}],reason:null};
      throw Error(kind);
    }}});
  t.after(()=>owner.close());
  await owner.advance({authorized:true});await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});
  await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();owner.writeLearning({authorized:true});
  assert.equal(owner.status().stage,'handoff_ready');
  const state=path.join(specsRoot,'.reviews/.execution',identity.runId,'state.json'),before=fs.readFileSync(state);
  const rows=JSON.parse(before).records;assert.ok(rows.some(row=>row.id==='fix-learning-writeback-result'&&!row.payload.application));
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({specsRoot,identity,reproduction}));
  const script=`import {preflight} from ${JSON.stringify(new URL('./cm-fix-drive.mjs',import.meta.url).href)};console.log(JSON.stringify(preflight(${JSON.stringify({operation:'post_review_regression',plan:{cwd,mode:'resume'},paths:{config,answers}})}).answers));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).learning,owner.status().learning.application);
  assert.equal(fs.existsSync(path.join(answers,'learning.json')),false);
  assert.deepEqual(fs.readFileSync(state),before);
});
test('driver continuation after revised cause approval uses current Learning and reaches the real red gate',async t=>fixture(t,async f=>{
  let owner=f.reopen({prepare:async()=>learningFor('Revised application after F1')});
  await owner.rediagnose({authorized:true,reason:'Address F1'});await f.review();
  assert.equal(owner.status().stage,'red_test_required');
  const config=path.join(f.root,'driver-config.json'),answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(config,JSON.stringify({specsRoot:f.specsRoot,identity:f.identity,reproduction:f.options.configuration.reproduction}));
  const selected=preflight({operation:'red_test',plan:{cwd:f.code,mode:'resume'},paths:{config,answers}});
  assert.equal(selected.answers.learning.summary,owner.status().learning.application.summary);
  owner=f.reopen({prepare:async()=>learningFor(selected.answers.learning.summary)});
  assert.equal((await owner.runRedTest({authorized:true})).stage,'baseline_required');
  assert.equal(fs.readFileSync(path.join(f.code,'visits'),'utf8'),'11');
},{prepare:async()=>learningFor('Original application'),redTest:true}));
for(const failure of ['source','evidence','symlink'])test(`rediagnosis rechecks ${failure} after awaited preparation and preserves its continuation`,async t=>fixture(t,async f=>{
  const before=fs.readFileSync(f.state),r1=fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r1.md'));
  const owner=f.reopen({prepare:async()=>{
    await Promise.resolve();
    if(failure==='source')fs.writeFileSync(path.join(f.code,'value.mjs'),'export const value=999;');
    else if(failure==='symlink')fs.symlinkSync('missing-review',path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'));
    else fs.writeFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'),'Occupied during preparation');
    return learningFor('Fresh application');
  }});
  await assert.rejects(owner.rediagnose({authorized:true,reason:'Address F1'}),
    {code:failure==='source'?'fix_rediagnosis_source_changed':'fix_rediagnosis_evidence_conflict'});
  assert.deepEqual(fs.readFileSync(f.state),before);assert.equal(owner.status().stage,'rediagnosis_required');
  assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r1.md')),r1);
  assert.equal(fs.readFileSync(path.join(f.code,'visits'),'utf8'),'1');
  assert.deepEqual(f.counts(),{calls:1,diagnoses:1});
  if(failure==='source')fs.writeFileSync(path.join(f.code,'value.mjs'),'export const value=1;');
  else fs.unlinkSync(path.join(f.specsRoot,'.reviews/fix-rediagnosis-cause-r2.md'));
  const retry=f.reopen({prepare:async()=>learningFor('Fresh application')});
  assert.equal((await retry.rediagnose({authorized:true,reason:'Address F1 after conflict cleared'})).stage,'cause_review_required');
  assert.deepEqual(f.counts(),{calls:1,diagnoses:2});
}));
