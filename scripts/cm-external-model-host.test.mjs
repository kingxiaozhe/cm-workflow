import test from 'node:test';
import {EXECUTION_POLICY_V1,readLaunchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun,readRunDefinition} from './cm-ai-run.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {readLaunchExternalModels} from '../runtime/js/cm-ai/external-model-launch.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {resolveProtectedRuntimes,loadConfig} from './cm-workflow-config.mjs';
import {acquireExternalRunGuard} from '../runtime/js/cm-ai/external-run-guard.mjs';
import {fileURLToPath} from 'node:url';
const value={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null},reason:null};
const scripts=fileURLToPath(new URL('.',import.meta.url));
async function fixture(fn,{both=false,session=false,reviewProvider='codex',efficiency=false}={}){
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-external-host-')));
  const prior={PATH:process.env.PATH,CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
  let run;
  try{
    const codeProject=path.join(tmp,'code'),specsDir=path.join(tmp,'specs'),bin=path.join(tmp,'bin'),home=path.join(tmp,'home');
    for(const folder of [codeProject,bin,home,path.join(specsDir,'1.work')])fs.mkdirSync(folder,{recursive:true});
    for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: fixture\n');
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=0;\n');
    if(!both)fs.writeFileSync(path.join(codeProject,'.cm-workflow.yml'),'version: 1\nruntimes:\n  available: codex\n');
    const definition={version:1,specsDir,codeProject,feature:'1.work',identity:{repositoryId:'fixture',runId:'external-run',taskId:'T-001',attempt:1},scope:['target.mjs'],requirements:['requirements.md']};
    const config=path.join(tmp,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
    const models={schemaVersion:1,providers:{codex:{model:'fixture-codex',effort:'low'},...(both?{claude:{model:'fixture-claude',effort:'max'}}:{})}};
    const settings=path.join(home,'external-models-v1.json');fs.writeFileSync(settings,JSON.stringify(models));
    const sent=path.join(tmp,'sent.jsonl');
    const source=`import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
if(process.argv[2]==='sandbox'){const args=process.argv.slice(2),i=args.indexOf('--');const result=spawnSync(args[i+1],args.slice(i+2),{stdio:'inherit'});process.exit(result.status??1);}
fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify({provider:process.env.CM_FAKE_PROVIDER,argv:process.argv.slice(2)})+'\\n');
let prompt='';for await(const part of process.stdin)prompt+=part;
const dev=prompt.includes('<cm-developer-data-json>');const data=JSON.parse(prompt.split(dev?'<cm-developer-data-json>\\n':'<cm-review-data-json>\\n')[1]);
if(dev)fs.writeFileSync('target.mjs','export const value=1;\\n');
const value=dev?${JSON.stringify(value)}:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Fake CLI only'};
const out=e=>console.log(JSON.stringify(e));const usage={input_tokens:100,output_tokens:20,...(process.env.CM_FAKE_PROVIDER==='claude'?{cache_read_input_tokens:70}:{cached_input_tokens:70})};
if(process.env.CM_FAKE_PROVIDER==='claude'){const session_id=randomUUID();out({type:'system',subtype:'init',session_id});out({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}]}});out({type:'result',subtype:'success',session_id,is_error:false,num_turns:1,result:JSON.stringify(value),structured_output:value,usage});}
else for(const event of [{type:'thread.started',thread_id:dev?'fake-author':'fake-review'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed',usage}])out(event);
`;
    const fake=path.join(tmp,'fake.mjs');fs.writeFileSync(fake,source);
    for(const provider of ['codex','claude'])fs.writeFileSync(path.join(bin,provider),`#!/bin/sh\nCM_FAKE_PROVIDER=${provider} exec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o755});
    process.env.PATH=bin+path.delimiter+prior.PATH;process.env.CM_WORKFLOW_HOME=home;process.env.CM_WORKFLOW_LOG_HOME=path.join(tmp,'logs');
    const pair=models.providers[reviewProvider];const review={...pair,disabledSkills:[],timeoutMs:5000,preflight:{passed:true,cli_model:pair.model,prompt_transport:'stdin',
      ...(reviewProvider==='claude'?{provider:'claude'}:{}),config_fingerprint:(reviewProvider==='claude'?claudeReviewFingerprint:configFingerprint)({cwd:codeProject,...pair})}};
    let bridgeCalls=0;
    const bridge={call:async kind=>{
      if(kind==='develop'){bridgeCalls++;fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=1;\n');return {status:'succeeded',value};}
      if(kind==='check')return [{id:'fixture-check',command:['controlled'],outcome:'passed',exitCode:0,evidence:'fake host'}];
      assert.fail('Unexpected bridge '+kind);
    }};
    const protection={checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],timeoutMs:5000};
    const routes=resolveProtectedRuntimes(loadConfig({projectRoot:codeProject}),'codex');
    const execution=(selected=models,{legacy=false}={})=>createConversationExecution(definition,'fixture-host',bridge,
      legacy?((({effort,...rest})=>({...rest,model:'fixture-codex',preflight:{...rest.preflight,config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture-codex'})}}))(review)):review,
      1,null,false,'codex',{
        ...(efficiency?{executionPolicy:EXECUTION_POLICY_V1}:{}),
        ...(!legacy?{externalModels:selected}:{}),
        ...(!session?{protection,providerDevelopment:{model:legacy?'fixture-codex':selected.providers.codex.model,
          ...(!legacy?{effort:selected.providers.codex.effort}:{}),attempt:1,...routes}}:{}),
      });
    const operation=(name,extra={})=>({version:1,operation:name,requestId:name,identity:definition.identity,...extra});
    const snapshot=()=>readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:'fixture',runId:'external-run'}});
    const calls=()=>fs.existsSync(sent)?fs.readFileSync(sent,'utf8').trim().split('\n').map(JSON.parse):[];
    const open=async(mode='create',selection=models,options={})=>run=await openControlRun(definition,mode,execution(selection,options));
    await fn({tmp,definition,config,models,settings,review,protection,operation,snapshot,calls,open,close:()=>run?.close(),bridgeCalls:()=>bridgeCalls,execution});
  }finally{run?.close();for(const [key,old] of Object.entries(prior)){if(old===undefined)delete process.env[key];else process.env[key]=old;}fs.rmSync(tmp,{recursive:true,force:true});}
}
test('real driver accepts the provider-only flags; read-only inspection survives corrupt defaults',()=>fixture(async f=>{
  const protectedFile=path.join(f.tmp,'protected.json'),reviewFile=path.join(f.tmp,'review.json'),planFile=path.join(f.tmp,'plan.json');
  fs.writeFileSync(protectedFile,JSON.stringify(f.protection));
  fs.writeFileSync(reviewFile,JSON.stringify(f.review));
  const plan={config:f.config,mode:'create',hostContext:'fixture-host',runtime:'codex',permissions:[
    '--external-models','--protected-config',protectedFile,'--allow-provider-development-attempt','1','--review-config',reviewFile]};
  fs.writeFileSync(planFile,JSON.stringify(plan));
  const drive=()=>spawnSync(process.execPath,[path.join(scripts,'cm-ai-drive.mjs'),'--plan',planFile,'status'],{encoding:'utf8',timeout:15000});
  const created=drive();assert.equal(created.status,0,created.stderr+created.stdout);
  const before=f.snapshot();assert.deepEqual(before.records[0].payload.config.externalModels,f.models);assert.equal(f.calls().length,0);
  fs.writeFileSync(f.settings,'invalid new defaults');plan.mode='resume';plan.permissions=plan.permissions.filter(flag=>flag!=='--external-models');fs.writeFileSync(planFile,JSON.stringify(plan));
  const resumed=drive();assert.equal(resumed.status,0,resumed.stderr+resumed.stdout);assert.equal(f.calls().length,0);
  const inspected=spawnSync(process.execPath,[path.join(scripts,'cm-model-setup.mjs'),'inspect-run','--input',f.config],{encoding:'utf8',timeout:10000});
  assert.equal(inspected.status,0,inspected.stderr);const result=JSON.parse(inspected.stdout);assert(result.readOnly);assert.equal(result.state,'ready');assert.equal(result.providerConfirmed,false);
  assert.equal(f.snapshot().revision,before.revision);
}));
test('new mode owns a serial lease and a different run ID cannot bypass unfinished work',()=>fixture(async f=>{
  const run=await f.open();
  assert.throws(()=>acquireExternalRunGuard(f.definition),{code:'store_busy'});
  const otherSpecs=path.join(f.tmp,'other-specs');fs.mkdirSync(otherSpecs);
  assert.throws(()=>acquireExternalRunGuard({...f.definition,specsDir:otherSpecs}),{code:'external_code_specs_conflict'});
  let status=await run.host.handle(f.operation('start'));assert.equal(status.state,'awaiting_review');
  const fake=path.join(f.tmp,'fake.mjs');fs.writeFileSync(fake,fs.readFileSync(fake,'utf8').replace("verdict:'approved'","verdict:'invalid'"));
  status=await run.host.handle(f.operation('decision',{packageDigest:status.packageDigest}));assert.equal(status.state,'unknown');f.close();
  const before=f.snapshot().revision;
  assert.throws(()=>acquireExternalRunGuard({...f.definition,identity:{...f.definition.identity,runId:'other-new-run'}}),{code:'external_prior_attempt_unresolved'});
  assert.equal(f.snapshot().revision,before);assert.equal(f.calls().length,2);
  assert.throws(()=>acquireExternalRunGuard({...f.definition,specsDir:otherSpecs,identity:{...f.definition.identity,runId:'cross-spec-run'}}),{code:'external_code_specs_conflict'});
  const different={...f.definition,identity:{...f.definition.identity,runId:'legacy-other-run'}};
  await assert.rejects(()=>openControlRun(different,'create',null,{supersedeReason:'try legacy restart',acceptSupersededCodeDrift:true}),{code:'external_prior_attempt_unresolved'});
  assert.equal(f.snapshot().revision,before);assert.equal(f.calls().length,2);
}));
test('rejected admission, task selection and forged execution publish no binding or lease',()=>fixture(async f=>{
  const noOwnership=()=>{assert(!fs.existsSync(path.join(f.definition.codeProject,'.cm-external-models-v1.json')));
    assert(!fs.existsSync(path.join(f.definition.specsDir,'.cm-external-models-v1')));assert.equal(f.calls().length,0);};
  const statusFile=path.join(f.definition.specsDir,'.cm-specs-status'),approval=fs.readFileSync(statusFile);
  fs.rmSync(statusFile);const blocked=await f.open();assert(blocked.blocked);f.close();noOwnership();
  fs.writeFileSync(statusFile,approval);
  const other={...f.definition,identity:{...f.definition.identity,taskId:'T-002'}};
  await assert.rejects(()=>openControlRun(other,'create',null),{code:'task_selection_mismatch'});noOwnership();
  const original=f.execution();const forged={...original,configuration:{...original.configuration}};
  await assert.rejects(()=>openControlRun(f.definition,'create',forged),{code:'external_execution_factory_required'});noOwnership();
}));
test('one Codex pair reaches actual dev and fresh review; immutable snapshot resumes with corrupt new defaults',()=>fixture(async f=>{
  const run=await f.open();let state=await run.host.handle(f.operation('start'));assert.equal(state.state,'awaiting_review',JSON.stringify(state));
  state=await run.host.handle(f.operation('decision',{packageDigest:state.packageDigest}));assert.equal(state.state,'approved',JSON.stringify(state));
  state=await run.host.handle(f.operation('complete',{packageDigest:state.packageDigest}));assert.equal(state.state,'fixture_completed',JSON.stringify(state));
  const calls=f.calls();assert.equal(calls.length,2);for(const call of calls){assert(call.argv.includes('model="fixture-codex"'));assert(call.argv.includes('model_reasoning_effort="low"'));}
  assert(calls[1].argv.includes('--ephemeral'));assert(!calls[1].argv.includes('resume'));
  const snapshot=f.snapshot(),init=snapshot.records[0].payload;assert.deepEqual(init.config.externalModels,f.models);
  assert.equal(init.config.developer.requestedModel,'fixture-codex');
  assert(snapshot.records.some(row=>row.payload.type==='review-invocation-registered'));
  assert(snapshot.records.some(row=>row.payload.type==='review-invocation-started'));
  assert(snapshot.records.some(row=>row.payload.type==='review-invocation-result'));
  f.close();fs.writeFileSync(f.settings,'corrupt changed preferences');
  const saved=readLaunchExternalModels({definition:f.definition,mode:'resume',providers:['codex']});assert.deepEqual(saved,f.models);
  const resumed=await f.open('resume',saved);assert.equal((await resumed.host.handle(f.operation('status'))).state,'fixture_completed');assert.equal(f.calls().length,2);
  assert.throws(()=>readLaunchExternalModels({definition:f.definition,mode:'resume',inputFile:f.settings}),{code:'external_model_resume_selection_forbidden'});
}));
test('host session development stays current-session; only independent review uses provider pair',()=>fixture(async f=>{
  const run=await f.open();let state=await run.host.handle(f.operation('start'));assert.equal(state.state,'awaiting_review',JSON.stringify(state));
  assert.equal(f.bridgeCalls(),1);assert.equal(f.calls().length,0);
  assert.equal(f.snapshot().records[0].payload.config.developer.requestedModel,'current-session');
  state=await run.host.handle(f.operation('decision',{packageDigest:state.packageDigest}));assert.equal(state.state,'approved',JSON.stringify(state));
  assert.equal(f.calls().length,1);assert(f.calls()[0].argv.includes('model_reasoning_effort="low"'));
},{session:true}));
test('both-runtime routing still uses Codex development and fresh Claude review with its own single pair',()=>fixture(async f=>{
  const run=await f.open();let state=await run.host.handle(f.operation('start'));assert.equal(state.state,'awaiting_review',JSON.stringify(state));
  state=await run.host.handle(f.operation('decision',{packageDigest:state.packageDigest}));assert.equal(state.state,'approved',JSON.stringify(state));
  const [dev,review]=f.calls();assert.equal(dev.provider,'codex');assert.equal(review.provider,'claude');assert.equal(review.argv[review.argv.indexOf('--model')+1],'fixture-claude');assert.equal(review.argv[review.argv.indexOf('--effort')+1],'max');assert(review.argv.includes('--no-session-persistence'));
},{both:true,reviewProvider:'claude'}));
test('legacy current-session run resumes without reading or applying saved provider preferences',()=>fixture(async f=>{
  const old=f.execution(null,{legacy:true});const run=await openControlRun(f.definition,'create',old);run.close();
  assert(!Object.hasOwn(f.snapshot().records[0].payload.config,'externalModels'));
  fs.writeFileSync(f.settings,'invalid defaults');assert.equal(readLaunchExternalModels({definition:f.definition,mode:'resume'}),null);
  assert.throws(()=>readLaunchExternalModels({definition:f.definition,mode:'resume',enabled:true}),{code:'external_model_resume_selection_forbidden'});
  const reopened=await openControlRun(f.definition,'resume',old);reopened.close();
  assert.equal(f.calls().length,0);
},{session:true}));

test('new execution policy is frozen and resume retains it with the feature flag absent',()=>fixture(async f=>{
  const run=await f.open();const snapshot=f.snapshot();const frozen=snapshot.records[0].payload.config.executionPolicy;
  assert.deepEqual(frozen,EXECUTION_POLICY_V1);
  assert.deepEqual(readLaunchExecutionPolicy({definition:f.definition,mode:'resume'}),EXECUTION_POLICY_V1);
  const before=JSON.stringify(snapshot);f.close();
  await f.open('resume');assert.equal(JSON.stringify(f.snapshot()),before);f.close();
  assert.equal(readLaunchExecutionPolicy({definition:f.definition,mode:'create'}),null);
}, {efficiency:true}));
test('old native execution cannot acquire new optimization policy on resume',()=>fixture(async f=>{
  await f.open();const before=JSON.stringify(f.snapshot());
  assert.throws(()=>readLaunchExecutionPolicy({definition:f.definition,mode:'resume',enabled:true}),/execution_policy_legacy_run/);
  assert.equal(readLaunchExecutionPolicy({definition:f.definition,mode:'resume'}),null);assert.equal(JSON.stringify(f.snapshot()),before);
}));

for(const reviewer of ['codex','claude'])test(`${reviewer} new policy actual dev/review records original usage once and replay adds no tokens`,()=>fixture(async f=>{
  const run=await f.open();let result=await run.host.handle(f.operation('start'));assert.equal(result.state,'awaiting_review',JSON.stringify(result));
  result=await run.host.handle(f.operation('decision',{packageDigest:result.packageDigest}));assert.equal(result.state,'approved',JSON.stringify(result));
  const log=path.join(f.definition.specsDir,'运行日志.jsonl');const rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const usages=rows().filter(r=>r.event==='model_usage'),claims=rows().filter(r=>r.event==='model_call');
  assert.equal(usages.length,2);assert.equal(claims.length,2);assert.equal(new Set(usages.map(r=>r.call_id)).size,2);
  for(const row of usages){assert.equal(row.input_tokens,100);assert.equal(row.output_tokens,20);assert.equal(row.cache_read_tokens,70);assert.equal(row.usage_state,'observed');assert.equal(row.effective_model,undefined);assert.equal(row.source,'native-cli-terminal');assert(claims.some(c=>c.call_id===row.call_id));}
  const prior=JSON.stringify(usages);f.close();await f.open('resume');assert.equal(JSON.stringify(rows().filter(r=>r.event==='model_usage')),prior);assert.equal(f.calls().length,2);
},{efficiency:true,both:reviewer==='claude',reviewProvider:reviewer}));
