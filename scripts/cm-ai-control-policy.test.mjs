import test from 'node:test';
import {operatorGuidance,guidanceText} from '../runtime/js/cm-ai/operator-guidance.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createCmAiBatch,batchTaskRunId} from './cm-ai-batch-run.mjs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readControlPolicy,readControlPolicyFile,assertControlEntry,controlTarget,withControlPolicyHost}
  from '../runtime/js/cm-ai/control-policy.mjs';

const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const identity={repositoryId:'control-fixture',runId:'control-fixture-run',taskId:'T-001',attempt:1};
const snapshot=(revision=digest('a'))=>({revision,records:[{payload:{type:'init',config:{controlPolicy:policy}}}]});
const status={identity,state:'unknown',code:'execution_error',packageDigest:digest('package')};
const wire=(operation,extra={})=>({version:2,operation,requestId:'control-request',identity,...extra});
function temp(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-control-policy-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('control choices are strict and cannot turn data presence into execution permission',()=>{
  assert.deepEqual(readControlPolicy(policy),policy);
  for(const value of [{...policy,allow:true},{...policy,version:1},{...policy,development:'auto'},
    {...policy,qaFix:'auto'},{...policy,qa:'skip'},{...policy,bootstrap:'yes'}])assert.throws(()=>readControlPolicy(value));
  assert.deepEqual(readControlPolicy({...policy,qa:'run',qaFix:'manual'}).qaFix,'manual');
});
test('verification is an optional policy choice that keeps older policies byte-identical',()=>{
  // Absent is the policy every earlier run saved; its digest must not move.
  assert.equal(digest(readControlPolicy(policy)),digest(policy));
  assert.deepEqual(readControlPolicy({...policy,verification:'precheck'}),{...policy,verification:'precheck'});
  assert.deepEqual(readControlPolicy({...policy,verification:'disabled'}),{...policy,verification:'disabled'});
  for(const verification of ['on',true,null,'','PRECHECK'])
    assert.throws(()=>readControlPolicy({...policy,verification}),{code:'invalid_input'});
  // The choice is part of the saved run: a launch cannot add or drop it.
  assert.throws(()=>assertControlEntry(snapshot(),{...policy,verification:'precheck'}),{code:'fingerprint_mismatch'});
  const saved={revision:digest('a'),records:[{payload:{type:'init',config:{controlPolicy:{...policy,verification:'precheck'}}}}]};
  assert.throws(()=>assertControlEntry(saved,policy),{code:'fingerprint_mismatch'});
  assertControlEntry(saved,{...policy,verification:'precheck'});
});
test('policy file rejects duplicate keys, invalid UTF8 and symbolic links',t=>{
  const root=temp(t),file=path.join(root,'control.json');
  fs.writeFileSync(file,JSON.stringify(policy));assert.deepEqual(readControlPolicyFile(file),policy);
  fs.writeFileSync(file,JSON.stringify(policy).replace('"version":2','"version":1,"version":2'));
  assert.throws(()=>readControlPolicyFile(file),{code:'duplicate_model_json_key'});
  fs.writeFileSync(file,Buffer.from([0xff]));assert.throws(()=>readControlPolicyFile(file),{code:'invalid_input'});
  const link=path.join(root,'link.json');fs.symlinkSync(file,link);
  assert.throws(()=>readControlPolicyFile(link),{code:'invalid_input'});
});
test('legacy and current entries cannot silently cross or change bound choices',()=>{
  const legacy={records:[{payload:{type:'init',config:{version:3}}}]};
  assert.doesNotThrow(()=>assertControlEntry(legacy,null));assert.doesNotThrow(()=>assertControlEntry(snapshot(),policy));
  assert.throws(()=>assertControlEntry(legacy,policy),{code:'fingerprint_mismatch'});
  assert.throws(()=>assertControlEntry(snapshot(),null),{code:'fingerprint_mismatch'});
  assert.throws(()=>assertControlEntry(snapshot(),{...policy,bootstrap:'write'}),{code:'fingerprint_mismatch'});
});
test('only an exact current preview can invoke recovery; repeated/stale previews never mutate',async()=>{
  let current=snapshot(),mutations=0;
  const host=withControlPolicyHost({async handle(request){
    if(request.operation==='status')return status;
    mutations++;current=snapshot(digest(String(mutations)));return {outcome:'blocked',code:'develop_interrupted'};
  }},{identity,snapshot:()=>current});
  assert.equal((await host.handle(wire('abandon_effect'))).code,'invalid_input');
  const preview=(await host.handle(wire('status'))).controlTarget;
  assert.equal((await host.handle(wire('abandon_effect',{expectedControl:preview}))).code,'develop_interrupted');
  assert.equal((await host.handle(wire('abandon_effect',{expectedControl:preview}))).code,'snapshot_changed');
  assert.equal((await host.handle(wire('abandon_effect',{expectedControl:{...preview,identity:{...identity,attempt:2}}}))).code,'snapshot_changed');
  assert.equal(mutations,1);
  assert.equal((await host.handle({...wire('advance'),version:1})).code,'fingerprint_mismatch');
  assert.equal((await host.handle(wire('advance',{expectedControl:preview}))).code,'invalid_input');
});
test('ordinary flow is automatic; recovery cannot queue behind an in-flight mutation',async()=>{
  let release;const finished=new Promise(resolve=>release=resolve);
  const host=withControlPolicyHost({async handle(request){return request.operation==='status'?status:finished;}},
    {identity,snapshot});
  const running=host.handle(wire('advance'));
  assert.equal((await host.handle(wire('abandon_effect',{expectedControl:controlTarget(status,snapshot())}))).code,'host_busy');
  const busyStatus=await host.handle(wire('status'));assert.equal(busyStatus.controlTarget,undefined);
  release(status);assert.deepEqual(await running,status);
  assert.ok((await host.handle(wire('status'))).controlTarget);
});
test('QA-fix recovery binds the child preview as well as parent state',async()=>{
  const child={runId:'qa-child',revision:digest('child'),stage:'unknown'};let forwarded;
  const host=withControlPolicyHost({async handle(request){
    if(request.operation==='status')return status;
    if(request.operation==='fix_status')return {code:'qa_fix_incomplete',childControlTarget:child};
    forwarded=request;return {code:'fix_step_interrupted'};
  }},{identity,snapshot});
  const target=(await host.handle(wire('fix_status'))).controlTarget;
  assert.deepEqual(target.child,child);
  const recovery={fixOperation:'abandon_step',reason:'Synthetic interrupted child'};
  assert.equal((await host.handle(wire('fix_action',{...recovery,expectedControl:controlTarget(status,snapshot())}))).code,'invalid_input');
  await host.handle(wire('fix_action',{...recovery,expectedControl:target}));
  assert.deepEqual(forwarded.expectedFixControl,child);assert.equal(forwarded.expectedControl,undefined);
});

test('real owned journals keep legacy bytes and reject cross-entry resumes before writes',async t=>{
  const root=temp(t),codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  const definition={version:1,specsDir,codeProject,feature:'1.work',identity,scope:['target.mjs'],requirements:[]};
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}};
  const execution=control=>createConversationExecution(definition,'control-fixture-host',{call(){assert.fail('no provider dispatch');}},
    review,null,null,false,'codex',control?{controlPolicy:policy}:{});
  let run=await openControlRun(definition,'create',execution(false));assert.equal(run.blocked,undefined,JSON.stringify(run.blocked));run.close();
  const file=path.join(specsDir,'.reviews/.execution',identity.runId,'state.json'),before=fs.readFileSync(file);
  await assert.rejects(openControlRun(definition,'resume',execution(true)),{code:'fingerprint_mismatch'});
  assert.deepEqual(fs.readFileSync(file),before);
  run=await openControlRun(definition,'resume',execution(false));
  assert.equal((await run.host.handle({...wire('status'),version:1})).state,'ready');run.close();
  assert.deepEqual(fs.readFileSync(file),before);
  definition.identity={...identity,runId:'control-current-run'};
  run=await openControlRun(definition,'create',execution(true));
  const saved=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:identity.repositoryId,runId:definition.identity.runId}});
  assert.deepEqual(saved.records[0].payload.config.controlPolicy,policy);run.close();
  const newFile=path.join(specsDir,'.reviews/.execution',definition.identity.runId,'state.json'),newBytes=fs.readFileSync(newFile);
  await assert.rejects(openControlRun(definition,'resume',execution(false)),{code:'fingerprint_mismatch'});
  assert.deepEqual(fs.readFileSync(newFile),newBytes);
});


test('reused error codes do not swallow failures from the underlying host',async()=>{
  for(const operation of ['advance','abandon_effect'])for(const code of ['invalid_input','snapshot_changed','fingerprint_mismatch']){
    const failure=Object.assign(new Error('Underlying host failure'),{code});
    const host=withControlPolicyHost({async handle(request){
      if(request.operation==='status'&&operation==='advance')return status;
      throw failure;
    }},{identity,snapshot});
    await assert.rejects(host.handle(wire(operation,operation==='abandon_effect'
      ?{expectedControl:controlTarget(status,snapshot())}:{})),error=>error===failure);
  }
});


test('v2 wrapper re-renders recovery guidance without reads, mutations or journal changes',async()=>{
  let reads=0;const current=snapshot(),before=JSON.stringify(current);
  const native={workflow:'cm-ai',...status,pendingAction:'abandon_effect',outcome:'reported'};
  native.guidance=operatorGuidance(native);const nativeBefore=JSON.stringify(native);
  const requests=[];
  const host=withControlPolicyHost({async handle(request){requests.push(request);return native;}},
    {identity,snapshot:()=>{reads++;return current;}});
  for(const operation of ['status','advance']){
    const output=await host.handle(wire(operation));
    assert.doesNotMatch(guidanceText(output),/--allow-/);assert.match(guidanceText(output),/expectedControl/);
    const {guidance,controlTarget:target,...unchanged}=output;
    const {guidance:original,...expected}=native;assert.deepEqual(unchanged,expected);
  }
  assert.equal(reads,1,'guidance does not read state');assert.equal(requests.length,2,'guidance does not dispatch');
  assert.equal(JSON.stringify(current),before);assert.equal(JSON.stringify(native),nativeBefore);
});

test('v2 wrapper preserves an active-operation suppression',async()=>{
  const native={workflow:'cm-ai',...status,pendingAction:'abandon_effect',outcome:'reported'};
  native.guidance=operatorGuidance(native,{executionActive:true});
  const host=withControlPolicyHost({async handle(){return native;}},{identity,snapshot});
  const output=await host.handle(wire('status'));
  assert.equal(output.guidance.recoveryOperation,null);assert.match(guidanceText(output),/不重复派发/);
});


test('real v2 batch status and recovery render the batch target and leave status history unchanged',async t=>{
  const root=temp(t),codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),logHome=path.join(root,'logs');
  const feature='1.work',taskKey=`${feature}/T-001`,batchId='guidance-batch';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  // A clean disposable Git root without a commit; explicit scope remains authoritative.
  const initialized=spawnSync('git',['init','-q',codeProject],{encoding:'utf8'});assert.equal(initialized.status,0);
  fs.writeFileSync(path.join(codeProject,'.git/info/exclude'),'*\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  let calls=0;
  const configuration={version:1,repositoryId:identity.repositoryId,batchId,specsDir,codeProject,controlPolicy:policy,
    tasks:[{feature,taskId:'T-001',scope:['target.mjs'],requirements:[]}]};
  const batch=createCmAiBatch({configuration,logHome,executionFor:async definition=>createConversationExecution(
    definition,'control-fixture-host',{async call(operation){
      calls++;assert.equal(operation,'develop');fs.writeFileSync(path.join(codeProject,'target.mjs'),'// preserved edit\n');
      throw Object.assign(new Error('Synthetic disconnect'),{code:'host_disconnected'});
    }},{model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
      config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}},null,null,false,'codex',{controlPolicy:policy,qaLogHome:logHome})});
  const advance=await batch.handle({version:2,operation:'advance',requestId:'batch-advance'});
  assert.equal(advance.pendingAction,'develop_redo',JSON.stringify(advance));
  assert.match(guidanceText(advance),/完整批次 controlTarget/);assert.doesNotMatch(guidanceText(advance),/--allow-/);
  const journal=path.join(specsDir,'.reviews/.execution',batchTaskRunId(batchId,taskKey),'state.json');
  const before=fs.readFileSync(journal),log=path.join(specsDir,'运行日志.jsonl'),beforeLog=fs.readFileSync(log);
  const reported=await batch.handle({version:2,operation:'status',requestId:'batch-status'});
  assert.match(guidanceText(reported),/batchId、taskKey、member、batchDigest/);
  assert.deepEqual(fs.readFileSync(journal),before);assert.deepEqual(fs.readFileSync(log),beforeLog);assert.equal(calls,1);
  const expectedControl=await batch.controlTarget();
  assert.deepEqual(fs.readFileSync(journal),before);assert.deepEqual(fs.readFileSync(log),beforeLog);
  const recovered=await batch.handle({version:2,operation:'develop_redo',requestId:'batch-redo',taskKey,
    reason:'Synthetic stopped conversation',expectedControl});
  assert.equal(recovered.code,'develop_answer_missing',JSON.stringify(recovered));
  assert.match(guidanceText(recovered),/原批次入口/);assert.doesNotMatch(guidanceText(recovered),/--allow-|恢复原运行/);
  assert.equal(calls,1,'recovery only records confirmation');
  assert.equal(fs.readFileSync(path.join(codeProject,'target.mjs'),'utf8'),'// preserved edit\n');
});
