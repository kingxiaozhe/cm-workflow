// A project's 运行日志.jsonl only grows. Past 1 MiB, cm-fix read it whole under
// the review-material limit and every fix run failed at its completion
// projection, including each later resume (2026-10-07, AI潮
// api-native-reading-fix-story-return: check_n5 limit_exceeded, then every resume).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {eventsAt} from '../runtime/js/cm-fix/finish.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';

const MiB=1024*1024;
// Valid rows of other runs and workflows, as a long-lived project accumulates.
function growLog(file,bytes){
  const filler='x'.repeat(900);let written=0,index=0;
  const lines=[];
  while(written<bytes){
    const line=JSON.stringify({schema_version:1,workflow:index%2?'cm-ai':'cm-prd',event:'progress',phase:'start',
      run_id:`other-run-${index}`,at:'2026-10-01T00:00:00Z',detail:filler})+'\n';
    lines.push(line);written+=Buffer.byteLength(line);index++;
  }
  fs.appendFileSync(file,lines.join(''));
}

test('cm-fix completes check_n5, post_review_regression, walkthrough and finish with a run log above 1 MiB',{timeout:120000},async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-large-log-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  const logHome=process.env.CM_WORKFLOW_LOG_HOME;process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'mirror');
  t.after(()=>{if(logHome===undefined)delete process.env.CM_WORKFLOW_LOG_HOME;else process.env.CM_WORKFLOW_LOG_HOME=logHome;
    fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const config={identity:{repositoryId:'fixture',runId:'large-log',taskId:'T-FIX-large-log',attempt:1},defect:'Wrong value',
    reproduction:{cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['value.mjs']},
    walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read value'],expected:['value is 2'],kind:'commands',command:[process.execPath,'red.mjs']}]}};
  const permissions=['--allow-reproduction','--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
  const model='synthetic',review={model,disabledSkills:[],preflight:{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd,model,disabledSkills:[]})}};
  let calls=0;
  const workerFactory=()=>async({prompt},{onEvent})=>{
    calls++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    onEvent({event:'thread.started',provider_thread:`thread-${calls}`});
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic'}};
  };
  const reviewHost=createFixReviewHost({codeProject:cwd,hostContextId:'fixture-host',review,permissions,workerFactory});
  const configuration={hostContextId:'fixture-host',...config,causeReview:reviewHost.reviewer};delete configuration.identity;
  const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}};
  const bridge={async call(kind){
    if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong value',plan:'Correct value',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
    if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    throw Error(kind);
  }};
  const options={specsRoot,identity:config.identity,configuration,create:true};
  const execution={...reviewHost.execution,bridge,prepare:async()=>learning};
  let owner=openFixExecution(options,execution);t.after(()=>owner.close());
  const hostFor=current=>createFixHost({owner:current,config:{...config,specsRoot},permissions,authority:reviewHost.authority,finalAuthority:reviewHost.finalAuthority});
  let host=hostFor(owner);
  const run=async operation=>{const result=await host.handle({requestId:operation,operation});assert(!result?.error,`${operation}: ${JSON.stringify(result)}`);return result;};
  for(const operation of ['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review','publish_review'])await run(operation);
  const log=path.join(specsRoot,'运行日志.jsonl');
  growLog(log,MiB+256*1024);
  assert(fs.statSync(log).size>MiB);
  // The old whole-file read: exactly the limit this run would have hit.
  assert.throws(()=>readReviewSourceFiles(specsRoot,['运行日志.jsonl']),{code:'limit_exceeded'});
  const ownRows=eventsAt(specsRoot).filter(row=>row.run_id===config.identity.runId);
  assert(ownRows.length>0&&eventsAt(specsRoot).every(row=>row.workflow==='cm-fix'));
  await run('check_n5');
  // A resume opens the owner and projects completion from the log again.
  owner.close();owner=openFixExecution({...options,create:false},execution);host=hostFor(owner);
  for(const operation of ['post_review_regression','walkthrough'])await run(operation);
  growLog(log,64*1024);
  const finished=await run('finish');
  assert.equal(finished.stage??finished.result?.stage,'completed',JSON.stringify(finished));
  owner.close();owner=openFixExecution({...options,create:false},execution);
  assert.equal(owner.status().stage,'completed');
  // Completion still binds this run only: the dossier row and the completion events are its own.
  const done=eventsAt(specsRoot).filter(row=>row.run_id===config.identity.runId&&['task_done','run_done'].includes(row.event));
  assert.deepEqual(done.map(row=>row.event),['task_done','run_done']);
  assert(calls>=1);
});

test('the streamed log reader keeps the single-link, no-symlink and plain-JSON guarantees of the old reader',async t=>{
  const {readStableLogRows}=await import('../runtime/js/cm-ai/log-rows.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-stable-log-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const log=path.join(root,'运行日志.jsonl');
  // An accepted historical row of another workflow nested deeper than the host
  // object normalizer allows (40): it must not block a cm-fix read.
  let deep={};for(let index=0;index<60;index++)deep={nested:deep};
  fs.writeFileSync(log,[{workflow:'cm-prd',run_id:'other',data:deep},{workflow:'cm-fix',run_id:'mine',n:1},{workflow:'cm-fix',run_id:'mine',n:2}]
    .map(row=>JSON.stringify(row)).join('\n')+'\n\n');
  const pick=row=>row.workflow==='cm-fix';
  assert.deepEqual(readStableLogRows(log,pick,'fix_log_failed').map(row=>row.n),[1,2]);
  const link=path.join(root,'hard.jsonl');fs.linkSync(log,link);
  assert.throws(()=>readStableLogRows(log,pick,'fix_log_failed'),{code:'fix_log_failed'});
  fs.unlinkSync(link);
  const symlink=path.join(root,'symlink.jsonl');fs.symlinkSync(log,symlink);
  assert.throws(()=>readStableLogRows(symlink,pick,'fix_log_failed'),{code:'fix_log_failed'});
  fs.appendFileSync(log,'{not json\n');
  assert.throws(()=>readStableLogRows(log,pick,'fix_log_failed'),{code:'fix_log_failed'});
});
