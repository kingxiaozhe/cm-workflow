import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {main} from './cm-fix-host.mjs';

// Real temporary files/commands/owner/CLI; model responses and diagnostics are
// synthetic. No live provider, XBrief writes, installation or Git operations.
async function fixture(t,mode){
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
  const permissions=['--allow-reproduction','--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
  const model='synthetic',review={model,disabledSkills:[],preflight:{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd,model,disabledSkills:[]})}};
  let calls=0,repairs=0;
  const workerFactory=()=>async({prompt},{onEvent})=>{
    calls++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    const thread=calls===1||mode==='reuse-thread'||['reuse-first-thread','revision-reuses-lost-thread'].includes(mode)&&calls===3?'old-thread':`new-thread-${calls}`;
    onEvent({event:'thread.started',provider_thread:thread});
    if(calls===1&&!['approved','changes_requested'].includes(mode)||mode==='loss-again'
      ||['twice-then-success','reuse-first-thread'].includes(mode)&&calls<=2)throw Error('Synthetic lost result');
    const verdict=mode==='changes_requested'||mode==='revision-reuses-lost-thread'&&calls===2?'changes_requested':'approved';
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict,packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
      findings:verdict==='changes_requested'?[{id:'F1',severity:'P2',path:'value.mjs',message:'Synthetic issue',evidence:'Fixture'}]:[],summary:'Synthetic'}};
  };
  const reviewHost=createFixReviewHost({codeProject:cwd,hostContextId:'fixture-host',review,permissions,workerFactory});
  const configuration={hostContextId:'fixture-host',...config,causeReview:reviewHost.reviewer};delete configuration.identity;
  const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}};
  const bridge={async call(kind){
    if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong value',plan:'Correct value',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
    if(kind==='fix_repair'){repairs++;fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;'+(repairs>1?' // revised':''));return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    throw Error(kind);
  }};
  const options={identity:config.identity,configuration,create:true};
  let owner=openFixExecution(options,{...reviewHost.execution,bridge,prepare:async()=>learning});
  t.after(()=>owner.close());
  const host=createFixHost({owner,config,permissions,authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority});
  for(const operation of ['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review'])
    await host.handle({requestId:operation,operation});
  const specsRoot=path.join(cwd,'docs/fixes'),statePath=path.join(specsRoot,'.reviews/.execution/recovery/state.json');
  const bytes=fs.readFileSync(statePath),state=JSON.parse(bytes),registered=state.records.find(r=>r.id==='fix-final-registered').payload;
  const request={requestId:'recover',operation:'recover_final_review',invocationId:registered.request.invocationId,
    packageDigest:registered.request.payload.reviewPackage.packageDigest,previousInvocationStopped:true,reason:'Human authorized one continuation; previous process stopped'};
  const configPath=path.join(root,'config.json'),reviewPath=path.join(root,'review.json');
  fs.writeFileSync(configPath,JSON.stringify(config));fs.writeFileSync(reviewPath,JSON.stringify(review));
  async function cli(requests,flags=[]){
    owner.close();const input=new PassThrough(),rows=[];let index=0;
    const next=()=>index<requests.length?input.write(JSON.stringify(requests[index++])+'\n'):input.end();
    const output=new Writable({write(chunk,enc,done){const row=JSON.parse(chunk.toString());rows.push(row);
      if(row.type==='host_ready'||Object.hasOwn(row,'requestId'))setImmediate(next);
      if(row.type==='host_request'){
        assert.equal(row.kind,'fix_learning');input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:learning.application})+'\n');
      }done();}});
    const args=['serve','--config',configPath,'--mode','resume','--host-context','fixture-host','--allow-reproduction','--review-config',reviewPath,...flags];
    assert.equal(await main(args,{input,output,error:output,reviewWorkerFactory:workerFactory}),0);
    return rows.filter(r=>r.requestId);
  }
  const reopen=()=>{owner.close();owner=openFixExecution({...options,create:false},{...reviewHost.execution,bridge,prepare:async()=>learning});return owner;};
  return {cwd,statePath,bytes,state,request,cli,reopen,owner:()=>owner,calls:()=>calls,repairs:()=>repairs};
}
const op=operation=>({requestId:operation,operation});

test('revision refuses lost earlier thread before persisting started, keeping replay valid',{timeout:15000},async t=>{
  const f=await fixture(t,'revision-reuses-lost-thread');
  const recovered=await f.cli([f.request,op('final_review'),op('publish_review')],['--allow-final-review-recovery','--allow-final-review']);
  assert.equal(recovered.at(-1).result.stage,'final_review_changes_requested');
  const owner=f.reopen();
  await owner.prepareRevision({authorized:true});await owner.repair({authorized:true});
  await owner.runRegression({authorized:true});await owner.retrospect();owner.createHandoff();
  assert.equal(owner.status().stage,'revision_final_review_required');
  const rows=await f.cli([op('final_review')],['--allow-final-review']);
  assert(!rows[0].error,JSON.stringify(rows[0]));assert.equal(rows[0].result.stage,'unknown');
  const records=JSON.parse(fs.readFileSync(f.statePath)).records;
  assert(records.some(r=>r.id==='fix-revision-final-registered'));
  assert(!records.some(r=>r.id==='fix-revision-final-started'));
  assert.equal(f.reopen().status().stage,'unknown');assert.equal(f.calls(),3);
});

for(const mode of ['twice-then-success','reuse-first-thread','loss-again'])test(`fresh invocation-bound continuation: ${mode}`,{timeout:15000},async t=>{
  const f=await fixture(t,mode);
  await f.cli([f.request,op('final_review')],['--allow-final-review','--allow-final-review-recovery']);
  assert.equal(f.calls(),2);
  const before=fs.readFileSync(f.statePath),beforeRecords=JSON.parse(before).records;
  const status=(await f.cli([op('status')]))[0].result;
  assert.equal(status.stage,'unknown');assert.equal(status.progress.finished,false);
  assert.equal(status.progress.recovery.needsFreshInvocationBinding,true);
  assert.equal(status.progress.recovery.authorizationGranted,false);
  assert.deepEqual(fs.readFileSync(f.statePath),before);
  const latest=status.finalReviewInvocation;
  const request={...f.request,invocationId:latest.invocationId,packageDigest:latest.packageDigest};
  const flags=['--allow-final-review-recovery','--final-review-recovery-invocation',latest.invocationId];
  for(const denied of [['--allow-final-review-recovery'],['--allow-final-review-recovery','--final-review-recovery-invocation',f.request.invocationId]]){
    const rows=await f.cli([request],denied);assert(rows[0].error);assert.deepEqual(fs.readFileSync(f.statePath),before);
  }
  const stale=await f.cli([f.request],flags);assert(stale[0].error);assert.deepEqual(fs.readFileSync(f.statePath),before);
  const prepared=await f.cli([request,request],flags);
  assert.equal(prepared[0].result.stage,'final_review_required');assert(prepared[1].error);assert.equal(f.calls(),2);
  const deniedDispatch=await f.cli([op('final_review')],['--allow-final-review-recovery','--allow-final-review']);
  assert(deniedDispatch[0].error);assert.equal(f.calls(),2);
  const reviewed=await f.cli([op('final_review'),op('final_review')],[...flags,'--allow-final-review']);
  assert.equal(f.calls(),3);assert.equal(f.repairs(),1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,beforeRecords.length),beforeRecords);
  if(mode==='loss-again'){
    assert.equal(reviewed[0].result.stage,'unknown');
    const newest=f.reopen().status().finalReviewInvocation;
    const bytes=fs.readFileSync(f.statePath);
    const staleBudget=await f.cli([{...request,invocationId:newest.invocationId}],flags);
    assert(staleBudget[0].error);assert.deepEqual(fs.readFileSync(f.statePath),bytes);
    assert.equal(f.calls(),3);return;
  }
  if(mode==='reuse-first-thread'){
    assert.equal(reviewed[0].result.stage,'unknown');assert.equal(reviewed[0].result.diagnostic.code,'final_context_mismatch');
    assert.equal(f.reopen().status().stage,'unknown');return;
  }
  assert.equal(reviewed[0].result.stage,'final_review_evidence_required');
  const rows=await f.cli(['publish_review','check_n5','post_review_regression','walkthrough','finish','completion_evidence','status'].map(op),
    ['--allow-regression','--allow-walkthrough','--allow-finish']);
  for(const row of rows)assert(!row.error,JSON.stringify(row));
  assert.equal(rows.at(-1).result.progress.finished,true);
  const state=JSON.parse(fs.readFileSync(f.statePath));
  const registration=state.records.find(r=>r.id==='fix-final-recovery-2-registered').payload;
  assert.equal(rows.find(r=>r.requestId==='completion_evidence').result.reviewRegistrationDigest,digest(registration));
  assert.equal(f.reopen().status().stage,'completed');assert.equal(f.calls(),3);
});

test('one authorized CLI continuation preserves old history and reaches the original finish',{timeout:15000},async t=>{
  const f=await fixture(t,'success');assert.equal(f.owner().status().stage,'unknown');
  assert.equal((await f.owner().reviewFinal()).stage,'unknown');assert.equal(f.calls(),1);
  const denied=await f.cli([f.request]);assert.equal(denied[0].error.code,'host_request_failed');
  assert.deepEqual(fs.readFileSync(f.statePath),f.bytes);
  const owner=f.reopen();
  assert.throws(()=>owner.recoverFinalReview(f.request),{code:'fix_review_recovery_authorization_required'});
  for(const change of [{invocationId:'wrong'},{packageDigest:'0'.repeat(64)},{previousInvocationStopped:false}])
    assert.throws(()=>owner.recoverFinalReview({...f.request,...change,authorized:true}),{code:'fix_review_recovery_mismatch'});
  fs.appendFileSync(path.join(f.cwd,'value.mjs'),' // drift');
  assert.throws(()=>owner.recoverFinalReview({...f.request,authorized:true}));
  fs.writeFileSync(path.join(f.cwd,'value.mjs'),'export const value=2;');
  assert.deepEqual(fs.readFileSync(f.statePath),f.bytes);
  const prepared=await f.cli([f.request],['--allow-final-review-recovery']);
  assert.equal(prepared[0].result.stage,'final_review_required');assert.equal(f.calls(),1);
  const noPermission=await f.cli([op('final_review')],['--allow-final-review']);
  assert.equal(noPermission[0].error.code,'host_request_failed');assert.equal(f.calls(),1);
  const noDispatchGrant=await f.cli([op('final_review')],['--allow-final-review-recovery']);
  assert.equal(noDispatchGrant[0].result.stage,'final_review_required');assert.equal(f.calls(),1);
  const rejectedAgain=await f.cli([f.request],['--allow-final-review-recovery']);
  assert.equal(rejectedAgain[0].error.code,'host_request_failed');
  const reviewed=await f.cli([op('final_review')],['--allow-final-review','--allow-final-review-recovery']);
  assert.equal(reviewed[0].result.stage,'final_review_evidence_required');assert.equal(f.calls(),2);
  const final=await f.cli(['publish_review','check_n5','post_review_regression','walkthrough','finish','completion_evidence'].map(op),['--allow-regression','--allow-walkthrough','--allow-finish']);
  for(const row of final)assert(!row.error,JSON.stringify(row));
  assert.equal(final.find(r=>r.requestId==='finish').result.stage,'completed');
  const state=JSON.parse(fs.readFileSync(f.statePath));assert.deepEqual(state.records.slice(0,f.state.records.length),f.state.records);
  const fresh=state.records.find(r=>r.id==='fix-final-recovery-registered').payload;
  assert.notEqual(fresh.request.invocationId,f.request.invocationId);assert.equal(fresh.request.identity.attempt,1);
  assert.equal(final.at(-1).result.reviewRegistrationDigest,digest(fresh));
  const resumed=f.reopen();assert.equal(resumed.status().stage,'completed');
  await resumed.reviewFinal();assert.equal(f.calls(),2);assert.equal(f.repairs(),1);
});

for(const mode of ['loss-again','reuse-thread','approved','changes_requested'])test(`continuation refuses unsafe reuse: ${mode}`,{timeout:10000},async t=>{
  const f=await fixture(t,mode);
  if(['approved','changes_requested'].includes(mode)){
    await f.cli([f.request],['--allow-final-review-recovery']).then(rows=>assert.equal(rows[0].error.code,'host_request_failed'));
    assert.deepEqual(fs.readFileSync(f.statePath),f.bytes);assert.equal(f.calls(),1);return;
  }
  const rows=await f.cli([f.request,op('final_review'),op('final_review'),f.request],['--allow-final-review','--allow-final-review-recovery']);
  assert.equal(rows[1].result.stage,'unknown');assert.equal(rows[2].result.stage,'unknown');
  assert.equal(rows[1].result.reason,'transport_incomplete');
  assert.deepEqual(rows[1].result.diagnostic,mode==='loss-again'?{phase:'transport',code:'execution_error'}:
    {phase:'registration',code:'final_context_mismatch'});
  // Immediate response only: replay neither invents diagnostics nor dispatches.
  assert.equal(rows[2].result.diagnostic,undefined);
  assert.equal(rows[3].error.code,'host_request_failed');assert.equal(f.calls(),2);
  assert.equal(f.reopen().status().stage,'unknown');assert.equal((await f.owner().reviewFinal()).stage,'unknown');
  assert.equal(f.calls(),2);assert.equal(f.repairs(),1);
});
