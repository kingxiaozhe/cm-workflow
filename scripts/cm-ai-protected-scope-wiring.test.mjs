// Factory provenance and real CLI preflight only. No check/developer/reviewer,
// native sandbox, Python, model service or task-owner writer is executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createConversationExecution,supportsConversationScopeSupplement,verifyConversationScopeSupplement,bindConversationScopeSupplement}
  from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {createProtectedScopeSupplement} from '../runtime/js/cm-ai/protected-scope-supplement.mjs';
import {runConfigMaterial,openControlRun} from './cm-ai-run.mjs';
import {buildCmAiDriveHostArgs,readDriverControl} from './cm-ai-drive.mjs';

const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-scope-wiring-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),answers=path.join(root,'answers');
  for(const dir of [codeProject,specsDir,answers])fs.mkdirSync(dir);
  const definition={version:1,specsDir,codeProject,feature:'1.fixture',
    identity:{repositoryId:'wiring-fixture',runId:'wiring-fixture-run',taskId:'T-001',attempt:1},
    scope:['code.js'],requirements:['requirements.md']};
  const definitionFile=path.join(root,'run.json');
  const write=(name,value)=>{const file=path.join(root,name);fs.writeFileSync(file,JSON.stringify(value)+'\n');return file;};
  write('run.json',definition);write('POLICY.json',policy);
  const featureRoot=path.join(specsDir,definition.feature);fs.mkdirSync(featureRoot);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(featureRoot,name),'# Fixture\n');
  fs.writeFileSync(path.join(featureRoot,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[definition.feature],specFiles:buildManifest(specsDir)}));
  const command=['node','-e',"const fs=require('node:fs');"
    +`const scope=new Set(JSON.parse(fs.readFileSync('${definitionFile}','utf8')).scope);`
    +"throw Error('WIRING TEST MUST NEVER EXECUTE PROJECT COMMANDS');"];
  const protection={checkCommands:[{id:'guard',command}],timeoutMs:10000};
  const bridge={call(){assert.fail('WIRING TEST MUST NEVER INVOKE A HOST TOOL');}};
  const make=(options={},d=definition,runtime='codex',workflow=null)=>createConversationExecution(d,'wiring-host',bridge,null,null,workflow,
    workflow!==null,runtime,{protection,controlPolicy:workflow?{...policy,qa:'run'}:policy,...options});
  const execution=make(),material=runConfigMaterial(definition,execution),fingerprint=digest(material);
  const scope=['code.js','settings.spec.tsx'];
  const raw={version:1,definitionFile,checkIds:['guard']};
  const supplement=createProtectedScopeSupplement(raw,{material,configFingerprint:fingerprint,scope});
  const env={...process.env,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const cli=(script,args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10000,env,maxBuffer:256*1024});
  const stateDir=path.join(specsDir,'.reviews','.execution',definition.identity.runId);
  const assertNoOwner=()=>assert.equal(fs.existsSync(path.join(specsDir,'.reviews','.execution','writer.sqlite')),false);
  return {root,definition,definitionFile,write,make,execution,material,fingerprint,scope,raw,supplement,protection,cli,env,stateDir,assertNoOwner};
}

test('only the actual protected factory capability can bind; protected recovery without supplement remains closed',async t=>{
  const f=fixture(t);
  assert.equal(supportsConversationScopeSupplement(f.execution),true);
  assert.equal(supportsConversationScopeSupplement({...f.execution}),false);
  assert.throws(()=>verifyConversationScopeSupplement({...f.execution},f.supplement,f.scope,f.fingerprint),{code:'scope_revision_unavailable'});
  assert.throws(()=>bindConversationScopeSupplement(f.execution,null,f.scope,f.fingerprint),{code:'scope_check_supplement_invalid'});
  await assert.rejects(openControlRun(f.definition,'resume',f.execution,{scopeRevision:{scope:f.scope,reason:'approved test additions'}}),
    {code:'recovery_launch_unavailable'});
  f.assertNoOwner();
});

test('preview and bind preserve original full configuration fingerprint; a fresh factory rebinds recorded evidence without launch flags',t=>{
  const f=fixture(t),before=JSON.stringify(f.material),configBefore=JSON.stringify(f.execution.configuration);
  assert.deepEqual(verifyConversationScopeSupplement(f.execution,f.supplement,f.scope,f.fingerprint),f.supplement);
  bindConversationScopeSupplement(f.execution,f.supplement,f.scope,f.fingerprint);
  assert.equal(JSON.stringify(f.execution.configuration),configBefore);
  assert.equal(JSON.stringify(runConfigMaterial(f.definition,f.execution)),before);
  assert.equal(digest(runConfigMaterial(f.definition,f.execution)),f.fingerprint);
  assert.throws(()=>bindConversationScopeSupplement(f.execution,f.supplement,f.scope,f.fingerprint),{code:'scope_revision_unavailable'});
  const resumed=f.make();
  bindConversationScopeSupplement(resumed,JSON.parse(JSON.stringify(f.supplement)),f.scope,f.fingerprint);
  assert.equal(digest(runConfigMaterial(f.definition,resumed)),f.fingerprint);
  const plan={mode:'resume',hostContext:'wiring-host',controlConfig:'POLICY.json',permissions:[]};
  assert.deepEqual(readDriverControl(plan,f.root,'status').policy,policy);
  const args=buildCmAiDriveHostArgs(plan,['--protected-conversation-config','protection.json'],f.definitionFile,path.join(f.root,'POLICY.json'));
  for(const flag of ['--scope-check-supplement','--revise-scope','--scope-revision-reason','--expected-control'])assert(!args.includes(flag));
  f.assertNoOwner();
});

test('private preview rejects changed original material and changed protection or QA command lists even with a newly self-consistent fingerprint',t=>{
  const f=fixture(t);
  const changed=structuredClone(f.supplement);changed.material.execution.protection.timeoutMs++;
  assert.throws(()=>verifyConversationScopeSupplement(f.execution,changed,f.scope,f.fingerprint),{code:'scope_check_supplement_invalid'});
  for(const change of [m=>{m.execution.protection.timeoutMs++;},m=>{m.execution.protection.checkCommands[0].command[2]+=';void 0;';}]){
    const material=structuredClone(f.material);change(material);
    const supplement=createProtectedScopeSupplement(f.raw,{material,configFingerprint:digest(material),scope:f.scope});
    assert.throws(()=>verifyConversationScopeSupplement(f.execution,supplement,f.scope,digest(material)),{code:'scope_check_supplement_drift'});
  }
  const workflow={qa:{commands:[{id:'qa-guard',caseIds:[],command:f.protection.checkCommands[0].command}],
    environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]};
  const execution=f.make({},f.definition,'codex',workflow),material=runConfigMaterial(f.definition,execution);
  material.execution=structuredClone(material.execution);material.execution.workflow.qa.commands[0].command[2]+=';void 1;';
  const supplement=createProtectedScopeSupplement({...f.raw,checkIds:['guard','qa-guard']},
    {material,configFingerprint:digest(material),scope:f.scope});
  assert.throws(()=>bindConversationScopeSupplement(execution,supplement,f.scope,digest(material)),{code:'scope_check_supplement_drift'});
  assert.equal(supportsConversationScopeSupplement(execution),true);
  f.assertNoOwner();
});

test('parallel, binary and multiple roots have no protected scope supplement capability; provider/bootstrap recovery cannot borrow it',async t=>{
  const f=fixture(t);
  const parallel=f.make({parallelMember:true});assert.equal(supportsConversationScopeSupplement(parallel),false);
  const binaryDefinition={...f.definition,scope:['font.ttf']};
  const binary=f.make({protection:{...f.protection,binaryAssets:{version:1,paths:['font.ttf'],sourceRoot:path.join(f.root,'answers')}}},binaryDefinition,'claude');
  assert.equal(supportsConversationScopeSupplement(binary),false);
  const nested=path.join(f.definition.codeProject,'app');fs.mkdirSync(nested);
  const multiDefinition={...f.definition,scope:['app/code.js'],codeProjects:[nested]};
  const multi=f.make({protection:{...f.protection,checkCommands:[{...f.protection.checkCommands[0],codeProject:nested}]}},multiDefinition);
  assert.equal(supportsConversationScopeSupplement(multi),false);
  for(const execution of [parallel,binary,multi]){
    assert.throws(()=>verifyConversationScopeSupplement(execution,f.supplement,f.scope,f.fingerprint),{code:'scope_revision_unavailable'});
    await assert.rejects(openControlRun(f.definition,'resume',execution,{scopeRevision:{scope:f.scope,reason:'approved',checkSupplement:f.raw}}),
      {code:'recovery_launch_unavailable'});
  }
  for(const execution of [{configuration:{controlPolicy:{...policy,development:'provider'},providerDevelopment:{model:'fixture'}}},
    {configuration:{controlPolicy:{...policy,bootstrap:'write'}}}])
    await assert.rejects(openControlRun(f.definition,'resume',execution,{scopeRevision:{scope:f.scope,reason:'approved',checkSupplement:f.raw}}),
      error=>['recovery_launch_unavailable','scope_revision_unavailable'].includes(error.code));
  f.assertNoOwner();
});

test('real host CLI refuses incomplete protected scope launch combinations before any owner exists',t=>{
  const f=fixture(t),base=mode=>['serve','--config',f.definitionFile,'--mode',mode,'--host-context','wiring-host','--control-config',path.join(f.root,'POLICY.json')];
  const supplement=['--scope-check-supplement','never-read.json'];
  for(const [mode,args,pattern] of [
    ['create',supplement,/invalid_input/],
    ['resume',supplement,/invalid_input/],
    ['resume',['--scope-revision-reason','approved'],/invalid_input/],
    ['create',['--revise-scope','never-read.json','--scope-revision-reason','approved',...supplement],/invalid_input/],
  ]){
    const result=f.cli(HOST,[...base(mode),...args]);assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,pattern);assert(!result.stdout.includes('host_ready'));
  }
  f.assertNoOwner();
});

test('real driver preflight restricts supplement registration to resume status with revise-scope and preserves existing evidence',t=>{
  const f=fixture(t);
  f.write('scope.json',f.scope);f.write('supplement.json',f.raw);
  // A sentinel existing archive lets the CLI reach its launch-shape preflight.
  // It is deliberately not a valid run; none of these cases may open a host.
  fs.mkdirSync(f.stateDir,{recursive:true});const state=path.join(f.stateDir,'state.json'),sentinel='{}\n';fs.writeFileSync(state,sentinel);
  const combinations=[['create','status',true],['resume','advance',true],['resume','status',false]];
  for(const [mode,operation,revision] of combinations){
    const permissions=['--scope-check-supplement','supplement.json',...(revision?['--revise-scope','scope.json']:[])];
    const plan=f.write('PLAN.json',{config:'run.json',controlConfig:'POLICY.json',mode,hostContext:'wiring-host',permissions});
    const result=f.cli(DRIVER,['--plan',plan,operation]);assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/Protected scope supplement registration requires explicit resume status with scope revision/);
    assert(!result.stdout.includes('host_ready'));assert.equal(fs.readFileSync(state,'utf8'),sentinel);
  }
  f.assertNoOwner();
});
