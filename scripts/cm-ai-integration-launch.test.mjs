import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {controlLaunchTarget} from './cm-ai-run.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {createReviewedIntegrationFixture,syntheticIntegrationReview,fileRecord} from './fixtures/reviewed-integration.mjs';

const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const DRIVE=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const expectedDigest='a'.repeat(64);
function cliFixture(t,{protectedMode=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-integration-launch-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=0;\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',file),'# Synthetic fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: synthetic integration launch\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  const definition={version:1,codeProject,specsDir,feature:'1.work',
    identity:{repositoryId:'integration-launch',runId:'integration-launch-original',taskId:'T-001',attempt:1},
    scope:['target.mjs'],requirements:[]};
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(definition));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(policy));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(root,'evidence.json'),'{}\n');
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),path.join(bin,'codex'));
  fs.chmodSync(path.join(bin,'codex'),0o700);
  if(protectedMode)fs.writeFileSync(path.join(root,'protected.json'),JSON.stringify({
    checkCommands:[{id:'synthetic',command:[process.execPath,'--check','target.mjs']}],timeoutMs:30000}));
  const permissions=['--review-config','review.json',...(protectedMode?['--protected-conversation-config','protected.json']:[])];
  const integration=['--integration-evidence','evidence.json','--accept-integration-digest',expectedDigest,'--expected-control','target.json'];
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
    CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const drive=(operation='status',extra={})=>{
    fs.writeFileSync(path.join(root,'plan.json'),JSON.stringify({config:'run.json',controlConfig:'control.json',
      mode:'resume',hostContext:'integration-launch-host',permissions,...extra}));
    const result=spawnSync(process.execPath,[DRIVE,'--plan',path.join(root,'plan.json'),operation],{cwd:root,env,encoding:'utf8',timeout:30000});
    return {...result,value:result.stdout.trim()?JSON.parse(result.stdout).result:null};
  };
  const host=(extra=[],{mode='resume',control=true,hostContext='integration-launch-host'}={})=>
    spawnSync(process.execPath,[HOST,'serve','--config','run.json','--mode',mode,'--host-context',hostContext,
      ...(control?['--control-config','control.json']:['--allow-development']),...permissions,...extra],
    {cwd:root,env,encoding:'utf8',input:'',timeout:30000});
  const stateFile=path.join(specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
  return {root,codeProject,specsDir,env,definition,permissions,integration,drive,host,stateFile,
    target:value=>fs.writeFileSync(path.join(root,'target.json'),JSON.stringify(value))};
}
function ready(t,options){
  const f=cliFixture(t,options),created=f.drive('status',{mode:'create'});
  assert.equal(created.status,0,created.stderr);assert.equal(created.value.state,'ready',JSON.stringify(created.value));
  f.target(created.value.launchControlTarget);return {...f,launchTarget:created.value.launchControlTarget};
}

test('real host requires paired explicit integration authority, v2 resume and a frozen launch target',t=>{
  const f=cliFixture(t);
  const cases=[
    {args:['--integration-evidence','evidence.json']},
    {args:['--accept-integration-digest',expectedDigest]},
    {args:f.integration.filter((_,i)=>i<4)},
    {args:f.integration,options:{mode:'create'}},
    {args:f.integration,options:{control:false}},
    {args:['--integration-evidence','evidence.json','--accept-integration-digest','invalid','--expected-control','target.json']},
  ];
  f.target({version:2,identity:f.definition.identity,state:'ready',code:null,packageDigest:null,
    effectId:null,invocationId:null,revision:'0'.repeat(64)});
  for(const {args,options} of cases){
    const result=f.host(args,options);assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/invalid_input|host_launch_authorization_required/);
    assert.equal(fs.existsSync(f.stateFile),false,'invalid launch must not create an execution store');
  }
});

test('real driver rejects integration advance and every mixed launch before opening the host',t=>{
  const f=ready(t),before=fs.readFileSync(f.stateFile);
  const attempts=[
    ['advance',f.integration],['start',f.integration],['cancel',f.integration],['qa',f.integration],
    ['status',f.integration.slice(0,2)],['status',f.integration.slice(2)],
    ['status',['--integration-evidence','evidence.json','--accept-integration-digest','A'.repeat(64),'--expected-control','target.json']],
    ['status',[...f.integration,'--rebind-spec-material','--spec-rebind-reason','Synthetic rebind']],
    ['status',[...f.integration,'--rerun-blocked-qa']],
    ['status',[...f.integration,'--hold-revision']],
  ];
  for(const [operation,extra] of attempts){
    const result=f.drive(operation,{permissions:[...f.permissions,...extra]});
    assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/受控集成接纳|permissions/);
    assert.deepEqual(fs.readFileSync(f.stateFile),before);
  }
  const host=f.host([...f.integration,'--rerun-blocked-qa']);
  assert.equal(host.status,1,host.stderr);assert.match(host.stderr,/invalid_input/);
  assert.deepEqual(fs.readFileSync(f.stateFile),before);
});

for(const protectedMode of [false,true])test(`real driver resolves evidence paths and rejects stale launch targets before writes (${protectedMode?'protected':'conversation'})`,t=>{
  const f=ready(t,{protectedMode}),before=fs.readFileSync(f.stateFile);
  f.target({...f.launchTarget,revision:'0'.repeat(64)});
  const targetBefore=fs.readFileSync(path.join(f.root,'target.json'));
  const result=f.drive('status',{hostContext:'integration-launch-new-host',originalHostContext:'integration-launch-host',
    permissions:[...f.permissions,...f.integration]});
  assert.equal(result.status,71,result.stderr);assert.match(result.stderr,/snapshot_changed/);
  assert.deepEqual(fs.readFileSync(f.stateFile),before,'stale launch cannot append a session join or acceptance');
  assert.deepEqual(fs.readFileSync(path.join(f.root,'target.json')),targetBefore,'driver must not refresh the frozen target');
  assert.equal(fs.existsSync(path.join(f.root,expectedDigest)),false,'approved digest is a value, not a filename');
  f.target(f.launchTarget);
  const notCompleted=f.drive('status',{permissions:[...f.permissions,...f.integration]});
  assert.equal(notCompleted.status,71,notCompleted.stderr);assert.match(notCompleted.stderr,/integration_parent_not_completed/);
  assert.deepEqual(fs.readFileSync(f.stateFile),before,'valid target does not permit acceptance of an incomplete parent');
});

test('integration launch validates option shape and remains unavailable without original control policy',async t=>{
  const f=await createReviewedIntegrationFixture(t),before=fs.readFileSync(f.statePath('parent'));
  const expectedControl=controlLaunchTarget(f.snapshot('parent'));
  const reviewedIntegration={evidenceFile:f.evidenceFile,expectedDigest:digest(f.plan)};
  await assert.rejects(f.openParent({reviewedIntegration,expectedControl}),{code:'recovery_launch_unavailable'});
  await assert.rejects(f.openParent({reviewedIntegration:{...reviewedIntegration,allowed:true},expectedControl}),{code:'invalid_input'});
  await assert.rejects(f.openParent({reviewedIntegration:{...reviewedIntegration,evidenceFile:'relative.json'},expectedControl}),{code:'invalid_input'});
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),before);
});

test('original owner accepts a reviewed integration once, exposes status only and preserves all counts',async t=>{
  const f=await createReviewedIntegrationFixture(t,{controlPolicy:policy});
  const before=f.snapshot('parent'),calls={...f.calls};
  const reviewedIntegration={evidenceFile:f.evidenceFile,expectedDigest:digest(f.plan)};
  const options={reviewedIntegration,expectedControl:controlLaunchTarget(before)};
  const run=await f.openParent(options);
  try{
    const status=await run.controlHost.handle({...f.request('parent','status'),version:2});
    assert.equal(status.state,'fixture_completed',JSON.stringify(status));assert.equal(status.code,null);
    const after=f.snapshot('parent');assert.deepEqual(after.records.slice(0,-1),before.records);
    assert.equal(after.records.at(-1).payload.type,'reviewed-integration-accepted');
    assert.equal(after.records.length,before.records.length+1);assert.deepEqual(f.calls,calls);
    for(const operation of ['start','decision','complete','advance','qa','cancel','finish','run_finalize','fix_run','fix_action','revise_scope','development_rework']){
      const blocked=await run.host.handle(f.request('parent',operation));
      assert.deepEqual(blocked,{outcome:'rejected',code:'integration_launch_status_only'});
    }
    assert.deepEqual(f.snapshot('parent'),after);assert.deepEqual(f.calls,calls);
  }finally{run.close();}
  const acceptedBytes=fs.readFileSync(f.statePath('parent'));
  await assert.rejects(f.openParent(options),{code:'snapshot_changed'});
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),acceptedBytes);
  const reopened=await f.openParent({...options,expectedControl:controlLaunchTarget(f.snapshot('parent'))});
  try{
    assert.equal((await reopened.controlHost.handle({...f.request('parent','status'),version:2})).code,null);
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),acceptedBytes,'idempotent acceptance appends no duplicate');
  }finally{reopened.close();}
  assert.deepEqual(f.calls,calls);
});

test('completed parent rejects wrong approved digest and changed evidence without altering any original record',async t=>{
  const f=await createReviewedIntegrationFixture(t,{controlPolicy:policy}),before=fs.readFileSync(f.statePath('parent'));
  const expectedControl=controlLaunchTarget(f.snapshot('parent')),calls={...f.calls};
  await assert.rejects(f.openParent({expectedControl,reviewedIntegration:{evidenceFile:f.evidenceFile,expectedDigest:'0'.repeat(64)}}),
    {code:'integration_target_changed'});
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),before);
  fs.writeFileSync(f.evidenceFile,JSON.stringify({plan:f.plan,review:{...f.review,result:{}}}));
  await assert.rejects(f.openParent({expectedControl,reviewedIntegration:{evidenceFile:f.evidenceFile,expectedDigest:digest(f.plan)}}));
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),before);assert.deepEqual(f.calls,calls);
});

test('integration launch preserves a legal original provider configuration',async t=>{
  const f=await createReviewedIntegrationFixture(t,{controlPolicy:{...policy,development:'provider'},providerDevelopment:true});
  const before=f.snapshot('parent'),calls={...f.calls};
  const run=await f.openParent({expectedControl:controlLaunchTarget(before),
    reviewedIntegration:{evidenceFile:f.evidenceFile,expectedDigest:digest(f.plan)}});
  try{
    const status=await run.controlHost.handle({...f.request('parent','status'),version:2});
    assert.equal(status.state,'fixture_completed',JSON.stringify(status));assert.equal(status.code,null);
    assert.deepEqual(f.snapshot('parent').records.slice(0,-1),before.records);assert.deepEqual(f.calls,calls);
  }finally{run.close();}
});

test('real CLI driver accepts exact reviewed document evidence, then the transport refuses advance and QA-fix',async t=>{
  const f=cliFixture(t),doc='docs/guide.md',before='# Guide\nApproved paragraph.\n',after=before+'Integrated paragraph.\n';
  fs.mkdirSync(path.join(f.codeProject,'docs'));fs.writeFileSync(path.join(f.codeProject,doc),'# Guide\n');
  f.definition.scope.push(doc);fs.writeFileSync(path.join(f.root,'run.json'),JSON.stringify(f.definition));
  const answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value=1;\n');fs.writeFileSync(path.join(answers,'guide.txt'),before);
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',
    value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt',[doc]:'guide.txt'}}));
  const setup={answers:'answers',checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]};
  const start=f.drive('start',{...setup,mode:'create'});assert.equal(start.status,0,start.stderr);
  assert.equal(start.value.state,'awaiting_review',JSON.stringify(start.value));
  const decision=f.drive('decision',{...setup,packageDigest:start.value.packageDigest});
  assert.equal(decision.status,0,decision.stderr);assert.equal(decision.value.state,'approved',JSON.stringify(decision.value));
  const completed=f.drive('complete',{...setup,packageDigest:start.value.packageDigest});
  assert.equal(completed.status,0,completed.stderr);assert.equal(completed.value.state,'fixture_completed',JSON.stringify(completed.value));
  const snapshot=()=>readExecutionSnapshot({specsRoot:f.specsDir,identity:{repositoryId:f.definition.identity.repositoryId,runId:f.definition.identity.runId}});
  const original=snapshot(),history=readRunnerHistory(original.records,original.records[0].payload.config,3);
  const plan={version:1,kind:'cm-reviewed-integration-v1',author:{provider:'codex',contextId:'synthetic-integration-author'},
    target:{identity:f.definition.identity,rootDigest:history.original.rootDigest,baselineDigest:history.original.baselineDigest,
      packageDigest:history.state.reviewPackage.packageDigest,recordCount:original.records.length,lastDigest:original.records.at(-1).digest},
    sources:[],documents:[{path:doc,before:fileRecord(doc,before),after:fileRecord(doc,after)}]};
  const review=await syntheticIntegrationReview(f.root,plan,{[doc]:{before,after}});
  fs.writeFileSync(path.join(f.root,'evidence.json'),JSON.stringify({plan,review})+'\n');
  fs.writeFileSync(path.join(f.codeProject,doc),after);f.target(controlLaunchTarget(original));
  const permissions=[...f.permissions,'--integration-evidence','evidence.json','--accept-integration-digest',digest(plan),'--expected-control','target.json'];
  const accepted=f.drive('status',{permissions});assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(accepted.value.state,'fixture_completed',JSON.stringify(accepted.value));assert.equal(accepted.value.code,null);
  const acceptedSnapshot=snapshot(),acceptedBytes=fs.readFileSync(f.stateFile);
  assert.deepEqual(acceptedSnapshot.records.slice(0,-1),original.records);
  assert.equal(acceptedSnapshot.records.at(-1).payload.type,'reviewed-integration-accepted');
  f.target(accepted.value.launchControlTarget);
  const operations=['status','advance','fix_run','cancel'];
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[HOST,'serve','--config','run.json','--mode','resume','--host-context','integration-launch-host',
      '--control-config','control.json',...permissions],{cwd:f.root,env:f.env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',index=0;const rows=[];
    const timer=setTimeout(()=>{child.kill();reject(Error('synthetic integration transport deadline'));},30000);
    const next=()=>{if(index===operations.length){child.stdin.end();return;}
      const operation=operations[index++];child.stdin.write(JSON.stringify({version:2,operation,requestId:operation,identity:f.definition.identity})+'\n');};
    child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(!line.trim())continue;const row=JSON.parse(line);rows.push(row);
        if(row.type==='host_request'){child.kill();reject(Error('integration launch dispatched a tool'));}
        if(row.type==='host_ready'||row.requestId)next();
      }
    });
    child.on('close',code=>{clearTimeout(timer);resolve({code,stderr,rows});});
  });
  assert.equal(result.code,0,result.stderr);
  assert.equal(result.rows.find(row=>row.requestId==='status').result.code,null);
  for(const operation of operations.slice(1))assert.deepEqual(result.rows.find(row=>row.requestId===operation).result,
    {outcome:'rejected',code:'integration_launch_status_only'});
  assert.deepEqual(fs.readFileSync(f.stateFile),acceptedBytes,'idempotent raw launch and rejected operations preserve all bytes');
});
