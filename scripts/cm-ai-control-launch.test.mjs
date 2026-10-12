import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun,controlLaunchTarget} from './cm-ai-run.mjs';
import {readLaunchControlFile} from './cm-ai-host.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'};
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
function fixture(t,{legacy=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-control-launch-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture');
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),'# fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement a\n- [ ] T-002: implement b\n');
  const approve=()=>fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  approve();
  const identity={repositoryId:'launch-fixture',runId:'launch-run-0001',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const execution={configuration:{kind:'synthetic-launch-v1',hostContextId:'main',...(legacy?{}:{controlPolicy:policy})},
    timeoutMs:1000,excludedContexts:['main'],developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:()=>{throw new Error('must not execute');}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-1','review-2'],run:()=>{throw new Error('must not review');}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['main']},
    check:createHostCheck({cwd:codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})};
  const qa={commands:[],environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}};
  execution.qaLogHome=path.join(root,'logs');
  execution.qaDecisionProvider={timeoutMs:1000,decide:()=>{throw new Error('must not assess');}};
  const configure=qa=>{
    execution.configuration.workflow={qa,documentationPaths:[],applicableAgentFiles:[]};
    execution.qaExecutor=createHostQaExecutor({codeProject,specsDir,feature,requirements:['requirements.md'],runtime:'codex',
      ...qa,timeoutMs:60000,logHome:execution.qaLogHome});
  };configure(qa);
  const storeIdentity={repositoryId:identity.repositoryId,runId:identity.runId};
  const snapshot=()=>readExecutionSnapshot({specsRoot:specsDir,identity:storeIdentity});
  const stateFile=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  return {root,codeProject,specsDir,feature,identity,definition,execution,qa,configure,approve,snapshot,stateFile};
}
async function initialize(f){const run=await openControlRun(f.definition,'create',f.execution);run.close();return controlLaunchTarget(f.snapshot());}

test('v2 startup recovery refuses every missing target before durable records change',async t=>{
  const f=fixture(t);await initialize(f);const before=fs.readFileSync(f.stateFile);
  for(const options of [{specRebindReason:'same task'}, {rerunUnknownQa:true}, {rerunBlockedQa:true},
    {qaConfigRevision:{previousWorkflow:f.execution.configuration.workflow,reason:'explicit revision'}}]){
    await assert.rejects(openControlRun(f.definition,'resume',f.execution,options),{code:'invalid_input'});
    assert.deepEqual(fs.readFileSync(f.stateFile),before);
  }
});

test('writer-held replay rejects stale revision, state, code and package instead of refreshing preview',async t=>{
  const f=fixture(t),target=await initialize(f),before=fs.readFileSync(f.stateFile);
  for(const drift of [{revision:'0'.repeat(64)},{state:'fixture_completed'},{code:'qa_result_blocked'},{packageDigest:'1'.repeat(64)}]){
    await assert.rejects(openControlRun(f.definition,'resume',f.execution,{specRebindReason:'same task',expectedControl:{...target,...drift}}),
      {code:'snapshot_changed'});
    assert.deepEqual(fs.readFileSync(f.stateFile),before);
  }
  assert.deepEqual(controlLaunchTarget(f.snapshot()),target);
});

test('valid launch preview permits specification rebind and preserves its concrete reason',async t=>{
  const f=fixture(t),target=await initialize(f);
  fs.writeFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'- [ ] T-001: implement a\n- [ ] T-002: implement b with another output\n');f.approve();
  const reason='Only T-002 changed; keep the original T-001 contract.';
  const run=await openControlRun(f.definition,'resume',f.execution,{specRebindReason:reason,expectedControl:target});run.close();
  const rows=f.snapshot().records.filter(row=>row.payload.type==='specification-rebound');
  assert.equal(rows.length,1);assert.equal(rows[0].payload.record.reason,reason);
  await assert.rejects(openControlRun(f.definition,'resume',f.execution,{specRebindReason:reason,expectedControl:target}),{code:'snapshot_changed'});
});

test('QA configuration revision verifies the old preview before append and retains the reason',async t=>{
  const f=fixture(t),target=await initialize(f),previousWorkflow=structuredClone(f.execution.configuration.workflow),before=fs.readFileSync(f.stateFile);
  f.configure({...f.qa,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs'],caseIds:[]}]});
  const reason='Add the originally omitted syntax check.';
  const options={qaConfigRevision:{previousWorkflow,reason}};
  await assert.rejects(openControlRun(f.definition,'resume',f.execution,{...options,expectedControl:{...target,revision:'0'.repeat(64)}}),{code:'snapshot_changed'});
  assert.deepEqual(fs.readFileSync(f.stateFile),before);
  const run=await openControlRun(f.definition,'resume',f.execution,{...options,expectedControl:target});run.close();
  const revision=f.snapshot().records.find(row=>row.payload.type==='qa-config-revised');
  assert.equal(revision.payload.record.reason,reason);assert.equal(revision.payload.record.qaRound,0);
});

test('QA rerun flags accept a valid explicit target without manufacturing a QA outcome',async t=>{
  const f=fixture(t),target=await initialize(f),before=fs.readFileSync(f.stateFile);
  for(const options of [{rerunUnknownQa:true},{rerunBlockedQa:true,qaEnvironmentFailure:'Observed fixture environment failure.'}]){
    const run=await openControlRun(f.definition,'resume',f.execution,{...options,expectedControl:target});run.close();
    assert.deepEqual(fs.readFileSync(f.stateFile),before);
  }
});

test('v1 recovery retains its original no-target and fingerprint behavior',async t=>{
  const f=fixture(t,{legacy:true});await initialize(f);
  fs.writeFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'- [ ] T-001: implement a\n- [ ] T-002: another unchanged dependency\n');f.approve();
  const run=await openControlRun(f.definition,'resume',f.execution,{specRebindReason:'Legacy explicit reason.'});run.close();
  assert.equal(f.snapshot().records.find(row=>row.payload.type==='specification-rebound').payload.record.reason,'Legacy explicit reason.');
});

test('target file rejects unknown fields, malformed targets, symlinks and hardlinks',async t=>{
  const f=fixture(t),target=await initialize(f),file=path.join(f.root,'target.json');
  fs.writeFileSync(file,JSON.stringify(target));assert.deepEqual(readLaunchControlFile(file),target);
  fs.writeFileSync(file,JSON.stringify({...target,extra:true}));assert.throws(()=>readLaunchControlFile(file));
  fs.writeFileSync(file,JSON.stringify({...target,revision:'invalid'}));assert.throws(()=>readLaunchControlFile(file));
  fs.writeFileSync(file,JSON.stringify(target).replace('"version":2','"version":1,"version":2'));
  assert.throws(()=>readLaunchControlFile(file),{code:'duplicate_model_json_key'});
  fs.writeFileSync(file,JSON.stringify(target));const alias=path.join(f.root,'alias');fs.linkSync(file,alias);
  assert.throws(()=>readLaunchControlFile(file),{code:'invalid_input'});fs.unlinkSync(alias);
  fs.renameSync(file,alias);fs.symlinkSync(alias,file);assert.throws(()=>readLaunchControlFile(file),{code:'invalid_input'});
});

test('real v2 CLI publishes a launch target, refuses a stale target and rebinds with the saved target',t=>{
  const f=fixture(t),config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json'),
    review=path.join(f.root,'review.json'),workflow=path.join(f.root,'workflow.json'),targetFile=path.join(f.root,'target.json');
  fs.writeFileSync(config,JSON.stringify(f.definition));fs.writeFileSync(control,JSON.stringify(policy));
  fs.writeFileSync(workflow,JSON.stringify(f.execution.configuration.workflow));
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  const serve=(mode,extra=[])=>{
    const result=spawnSync(process.execPath,[cli,'serve','--config',config,'--mode',mode,'--host-context','main',
      '--control-config',control,'--review-config',review,'--workflow-config',workflow,...extra],
      {encoding:'utf8',timeout:20000,input:JSON.stringify({version:2,requestId:'status',operation:'status',identity:f.identity})+'\n',
        env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
    return {...result,rows:result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};
  };
  const created=serve('create');assert.equal(created.status,0,created.stderr);
  const original=created.rows.find(row=>row.requestId==='status').result;
  assert.deepEqual(original.launchControlTarget,controlLaunchTarget(f.snapshot()));
  fs.writeFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'- [ ] T-001: implement a\n- [ ] T-002: add another output\n');f.approve();
  const preview=serve('resume');assert.equal(preview.status,0,preview.stderr);
  const current=preview.rows.find(row=>row.requestId==='status').result;
  assert.equal(current.controlTarget.code,'spec_drift');
  assert.deepEqual(current.launchControlTarget,original.launchControlTarget,'live spec drift does not refresh the durable launch preview');
  const before=fs.readFileSync(f.stateFile),reason='Only another task changed; preserve T-001.';
  const extra=['--rebind-spec-material','--spec-rebind-reason',reason,'--expected-control',targetFile];
  fs.writeFileSync(targetFile,JSON.stringify({...original.launchControlTarget,revision:'0'.repeat(64)}));
  const refused=serve('resume',extra);assert.equal(refused.status,1);assert.match(refused.stderr,/snapshot_changed/);
  assert.match(refused.stderr,/launchControlTarget/);assert.deepEqual(fs.readFileSync(f.stateFile),before);
  fs.writeFileSync(targetFile,JSON.stringify(original.launchControlTarget));
  const recovered=serve('resume',extra);assert.equal(recovered.status,0,recovered.stderr);
  assert.equal(recovered.rows.find(row=>row.requestId==='status').result.code,null);
  assert.equal(f.snapshot().records.find(row=>row.payload.type==='specification-rebound').payload.record.reason,reason);
});

test('v2 argv requires target for startup recovery and refuses external allow flags or create supersession',t=>{
  const f=fixture(t),config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json');
  fs.writeFileSync(config,JSON.stringify(f.definition));fs.writeFileSync(control,JSON.stringify(policy));
  const args=['serve','--config',config,'--mode','resume','--host-context','main','--control-config',control];
  for(const extra of [['--rebind-spec-material','--spec-rebind-reason','fixture'],['--rerun-blocked-qa'],
    ['--revise-qa-config','previous.json','--qa-config-revision-reason','fixture']]){
    const result=spawnSync(process.execPath,[cli,...args,...extra],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/invalid_input/);
  }
  for(const flag of ['--allow-qa','--allow-unknown']){
    const result=spawnSync(process.execPath,[cli,...args,flag],{encoding:'utf8'});
    assert.equal(result.status,1);assert.match(result.stderr,/invalid_arguments/);
  }
  const create=[...args];create[4]='create';
  const result=spawnSync(process.execPath,[cli,...create,'--supersede-reviewed-evidence','--supersede-reason','fixture'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/supersede_unavailable/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution')),false);
});

test('v2 manual QA Fix loads status with a simple owner without unused review or authoring adapters',t=>{
  const f=fixture(t),config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json'),
    review=path.join(f.root,'review.json'),workflow=path.join(f.root,'workflow.json'),fix=path.join(f.root,'fix.json');
  fs.writeFileSync(config,JSON.stringify(f.definition));fs.writeFileSync(control,JSON.stringify({...policy,qaFix:'manual'}));
  fs.writeFileSync(workflow,JSON.stringify(f.execution.configuration.workflow));
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  fs.writeFileSync(fix,JSON.stringify({specsRoot:f.specsDir,identity:{...f.identity,runId:'simple-child'},configuration:{
    hostContextId:'main',runtime:'codex',reproduction:{cwd:f.codeProject},
    qaSource:{identity:f.identity,feature:f.feature,packageDigest:'a'.repeat(64),testRunId:'fixture-qa'}}}));
  const args=[cli,'serve','--config',config,'--mode','create','--host-context','main','--control-config',control,
    '--review-config',review,'--workflow-config',workflow,'--qa-fix-owner-config',fix];
  const input=[{version:2,requestId:'status',operation:'status',identity:f.identity},
    {version:2,requestId:'fix_status',operation:'fix_status',identity:f.identity,packageDigest:'a'.repeat(64),testRunId:'fixture-qa'}]
    .map(JSON.stringify).join('\n')+'\n';
  const result=spawnSync(process.execPath,args,{input,encoding:'utf8',timeout:20000,
    env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
  assert.equal(result.status,0,result.stderr);
  const rows=result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].type,'host_ready');assert.equal(rows.find(row=>row.requestId==='status').result.state,'ready');
  assert.ok(rows.find(row=>row.requestId==='fix_status'),'fix_status reaches the original owner; this ready fixture has no matching QA failure');
  assert.doesNotMatch(result.stderr,/test_author_configuration_required|repair_configuration_required|review_configuration_required/);
  const missingReview=spawnSync(process.execPath,args.filter((value,index)=>value!=='--review-config'&&args[index-1]!=='--review-config'),
    {encoding:'utf8'});
  assert.equal(missingReview.status,1);assert.match(missingReview.stderr,/review_configuration_required/);assert.match(missingReview.stderr,/--review-config/);
  assert.doesNotMatch(missingReview.stderr,/allow-review-attempt/);
});

test('resume with missing stored evidence preserves the owner refusal for v1 and v2',async t=>{
  for(const legacy of [false,true])for(const depth of [0,2,3]){
    const f=fixture(t,{legacy});let dir=f.specsDir;
    for(const part of ['.reviews','.execution',f.identity.runId].slice(0,depth)){
      dir=path.join(dir,part);fs.mkdirSync(dir,{mode:0o700});
    }
    await assert.rejects(openControlRun(f.definition,'resume',f.execution),{code:depth===3?'store_layout_legacy':'store_missing'});
    assert.equal(fs.existsSync(f.stateFile),false);
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution',f.identity.runId,'writer.sqlite')),false);
  }
});

test('missing state in an existing writer layout is left for the owner without replacement',async t=>{
  for(const legacy of [false,true]){
    const f=fixture(t,{legacy});await initialize(f);fs.unlinkSync(f.stateFile);
    await assert.rejects(openControlRun(f.definition,'resume',f.execution),{code:'ENOENT'});
    assert.equal(fs.existsSync(f.stateFile),false);
    assert.equal(fs.statSync(path.join(path.dirname(f.stateFile),'writer.sqlite')).isFile(),true);
  }
});
