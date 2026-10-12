import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readDriverControl,controlDevelopAttempts,buildCmAiDriveHostArgs,buildCmAiDriveRequest} from './cm-ai-drive.mjs';
import {batchDevelopAttempts,buildCmAiBatchDriveHostArgs,buildCmAiBatchDriveRequest} from './cm-ai-batch-drive.mjs';
import {inspectDriverBootstrap} from '../runtime/js/cm-ai/drive-bootstrap.mjs';
import {createHostWorkflowCapabilities} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';

const SINGLE=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const BATCH=fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url));
const REVIEW=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const identity={repositoryId:'v2-drive-fixture',runId:'v2-drive-run',taskId:'T-001',attempt:1};
const key='1.work/T-001';
const answer={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt'}};
function fixture(t,batch=false,qaRun=false){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-v2-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),bin=path.join(root,'bin');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  if(batch)for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const r=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  const definition={version:1,specsDir,codeProject,feature:'1.work',identity,scope:['target.mjs'],requirements:['requirements.md']};
  const config=batch?{batch:{version:1,repositoryId:identity.repositoryId,batchId:'v2-batch-drive-run',specsDir,codeProject,
    tasks:[{feature:'1.work',taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']}]},
    workflows:{[key]:{qa:qaRun?{commands:[{id:'value',caseIds:[],command:[process.execPath,'-e',
      "import('./target.mjs').then(m=>{if(m.value!==43)process.exit(1)})"]}],
      environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}}:null,
      documentationPaths:[],applicableAgentFiles:[]}}}:definition;
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({...policy,...(qaRun?{qa:'run'}:{})}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  const answers=path.join(root,'answers',...(batch?['1.work','T-001']:[]));fs.mkdirSync(answers,{recursive:true});
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify(answer));
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value = 42;\n');
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected'}));
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  const review=verdict=>{
    let source=fs.readFileSync(REVIEW,'utf8');
    if(verdict==='changes_requested')source=source.replace("verdict:'approved'","verdict:'changes_requested'")
      .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise value',evidence:'Fixture finding'}]");
    fs.writeFileSync(path.join(bin,'codex'),source,{mode:0o700});
  };review('changes_requested');
  const plan=extra=>{
    const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'v2-fixture-host',controlConfig:'control.json',
      permissions:['--review-config','review.json'],answers:'answers',
      checks:batch?{[key]:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));
    return file;
  };
  const drive=(file,operation='advance')=>spawnSync(process.execPath,[batch?BATCH:SINGLE,'--plan',file,operation],{encoding:'utf8',timeout:60000,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  return {root,codeProject,specsDir,answers,plan,drive,review};
}

test('v2 launch arguments replace the development grant and leave legacy launch intact',()=>{
  const plan={mode:'create',hostContext:'host',controlConfig:'policy.json'};
  assert.deepEqual(buildCmAiDriveHostArgs(plan,[],'run.json','/fixture/policy.json').slice(0,9),
    ['serve','--config','run.json','--mode','create','--host-context','host','--control-config','/fixture/policy.json']);
  assert.deepEqual(buildCmAiBatchDriveHostArgs(plan,[],'batch.json','/fixture/policy.json').slice(0,9),
    ['serve','--config','batch.json','--mode','create','--host-context','host','--control-config','/fixture/policy.json']);
  assert.ok(buildCmAiDriveHostArgs({mode:'create',hostContext:'host'},[],'run.json').includes('--allow-development'));
  assert.deepEqual(buildCmAiBatchDriveHostArgs({mode:'create',hostContext:'host'},[],'run.json'),
    ['serve','--config','run.json','--host-context','host','--allow-development']);
});
test('v2 batch accepts direct policy launch with or without mode',t=>{
  const host=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
  for(const mode of [null,'create','resume']){
    const f=fixture(t,true),context='direct-v2-'+(mode??'no-mode');
    const args=['serve','--config',path.join(f.root,'run.json'),
      ...(mode?['--mode',mode]:[]),'--host-context',context,'--control-config',path.join(f.root,'control.json'),
      '--review-config',path.join(f.root,'review.json')];
    const request={version:2,operation:'status',requestId:'direct-status'};
    const result=spawnSync(process.execPath,[host,...args],{encoding:'utf8',timeout:20000,
      input:JSON.stringify(request)+'\n',env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),
        CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
    assert.equal(result.status,0,result.stderr);
    const rows=result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].type,'host_ready');
    const response=rows.find(row=>row.requestId==='direct-status');assert.ok(response,result.stdout);
    assert.notEqual(response.result.outcome,'rejected',result.stdout);
    assert.ok(response.result.state,result.stdout);
  }
});

test('v2 policy determines both rounds independently of legacy grant flags',()=>{
  assert.deepEqual(controlDevelopAttempts({state:'ready',attempt:1},'advance').attempts,[1,2]);
  assert.deepEqual(controlDevelopAttempts({state:'awaiting_review',attempt:1},'advance').attempts,[2]);
  assert.deepEqual(controlDevelopAttempts({state:'changes_requested',attempt:2},'advance').attempts,[2]);
  assert.deepEqual(batchDevelopAttempts({state:'ready',attempt:1},key,[],policy),[1,2]);
  assert.deepEqual(batchDevelopAttempts({state:'ready',attempt:1},key,[],{...policy,development:'provider'}),[]);
  assert.match(inspectDriverBootstrap({advance:true,definition:{},permissions:['--bootstrap-config','unused.json'],controlPolicy:policy}).gap,
    /invalid_arguments.*bootstrap disabled/,'disabled bootstrap refuses its configured writer without reading it');
});
test('v2 recovery preserves the caller target while ordinary advance needs no target',t=>{
  const f=fixture(t),base={controlConfig:'control.json',mode:'resume',permissions:[]};
  assert.deepEqual(readDriverControl(base,f.root,'advance').policy,policy);
  assert.throws(()=>readDriverControl(base,f.root,'develop_redo'),/expectedControl/);
  const target={version:2,identity,state:'unknown',revision:'preview-bound'};
  const p={...base,expectedControl:target};
  assert.equal(buildCmAiDriveRequest('develop_redo',p,{identity}).expectedControl,target);
  assert.equal(buildCmAiDriveRequest('advance',p,{identity}).expectedControl,undefined);
  assert.equal(buildCmAiDriveRequest('advance',p,{identity}).version,2);
  assert.equal(buildCmAiDriveRequest('advance',{},{identity}).version,1);
  const attempt2={...p,expectedControl:{...target,identity:{...identity,attempt:2}}};
  assert.equal(buildCmAiDriveRequest('develop_redo',attempt2,{identity},identity).identity.attempt,2,
    'recovery uses the preview identity rather than the definition or a new journal read');
  const batchTarget={version:2,batchId:'batch',taskKey:key,member:target,batchDigest:'preview'};
  assert.equal(buildCmAiBatchDriveRequest('develop_redo',{...p,taskKey:key,expectedControl:batchTarget}).expectedControl,batchTarget);
  assert.throws(()=>readDriverControl({...p,mode:'create'},f.root,'advance'),/create 禁止/);
});
test('v2 always separates QA disposition from execution while qa:null keeps legacy behavior',()=>{
  const options={definition:{specsDir:'/fixture/specs',codeProject:'/fixture/code',feature:'1.work',requirements:[]},
    configuration:{qa:null,documentationPaths:[],applicableAgentFiles:[]},bridge:{call:async()=>{}},allowQa:false};
  const old=createHostWorkflowCapabilities(options);
  assert.equal(old.qaDecisionProvider,undefined);assert.equal(old.qaExecutor,undefined);
  const v2=createHostWorkflowCapabilities({...options,controlPolicy:policy});
  assert.equal(typeof v2.qaDecisionProvider.decide,'function');assert.equal(v2.qaExecutor,undefined);
  const configured={...options,configuration:{...options.configuration,qa:{commands:[{id:'local',caseIds:[],command:[process.execPath,'-e','0']}],
    environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}}}};
  assert.equal(createHostWorkflowCapabilities({...configured,controlPolicy:policy}).qaExecutor,undefined,
    'a stored execution recipe does not enable a disabled executor');
  assert.throws(()=>createHostWorkflowCapabilities(configured),{code:'qa_authorization_required'},
    'legacy configured QA still requires its original authorization');
});
test('v2 rejects every allow flag as a migration error before opening a run',t=>{
  const f=fixture(t);
  for(const flag of ['--allow-development','--allow-review-attempt','--allow-unrecognized']){
    const r=f.drive(f.plan({permissions:[flag,'1']}));assert.equal(r.status,2,r.stderr);
    assert.match(r.stderr,/迁移错误.*--allow-\*/);
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews/.execution')),false);
  }
});
test('disabled bootstrap and QA Fix refuse configured capabilities before reading their files',t=>{
  const f=fixture(t);
  for(const flag of ['--bootstrap-config','--qa-fix-owner-config','--qa-fix-template-config','--protected-config']){
    const r=f.drive(f.plan({permissions:[flag,'missing.json']}));
    assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/invalid_arguments/);
    assert.doesNotMatch(r.stderr,/文件不存在|ENOENT/);
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews/.execution')),false);
  }
});
for(const batch of [false,true])test(`v2 ${batch?'batch':'single'} explicit recovery refuses missing preview before host launch`,t=>{
  const f=fixture(t,batch);
  const r=f.drive(f.plan({mode:'resume',originalHostContext:'v2-fixture-host',taskKey:key,reason:'Fixture stopped'}),'develop_redo');
  assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/expectedControl/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews/.execution')),false);
});
for(const batch of [false,true])test(`v2 ${batch?'batch':'single'} real host holds absent a2 and resumes with its own second-round answer`,t=>{
  const f=fixture(t,batch,batch),first=f.drive(f.plan());
  assert.equal(first.status,0,first.stderr);
  const result=JSON.parse(first.stdout).result;
  assert.equal(result.code,'revision_answer_required',first.stdout);
  assert.match(first.stderr,/应答 develop/);assert.match(first.stderr,/develop-a2\.json/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
  fs.writeFileSync(path.join(f.answers,'develop-a2.json'),JSON.stringify({...answer,edits:{'target.mjs':'second.txt'}}));
  fs.writeFileSync(path.join(f.answers,'second.txt'),'export const value = 43;\n');f.review('approved');
  const second=f.drive(f.plan({mode:'resume',originalHostContext:'v2-fixture-host'}));
  assert.equal(second.status,0,second.stderr);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
  let result2=JSON.parse(second.stdout).result;
  if(batch)for(let n=0;n<4&&result2.state!=='run_done';n++){
    const next=f.drive(f.plan({mode:'resume',originalHostContext:'v2-fixture-host'}));
    assert.equal(next.status,0,next.stderr);result2=JSON.parse(next.stdout).result;
  }
  assert.equal(result2.state,batch?'run_done':'fixture_completed',second.stdout);
  if(batch){
    assert.match(second.stderr,/应答 qa_assess/);
    assert.match(second.stderr,/检查结束.*value.*passed/,'actual QA command supplies the passed result');
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'));
  }
});

test('v2 protected provider real host dispatches two fresh independent reviews after a rejected first round',t=>{
  const f=fixture(t),bin=path.join(f.root,'bin'),witness=path.join(f.root,'protected-dispatch.jsonl');
  fs.writeFileSync(path.join(f.root,'control.json'),JSON.stringify({...policy,development:'provider'}));
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'codex'},
    roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'codex-cli'}}}));
  fs.writeFileSync(path.join(f.root,'protected.json'),JSON.stringify({model:'fixture',timeoutMs:5000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  // Only fixture Node processes run. The sandbox shim verifies the formal
  // profile/command arguments; this witness does not test native OS isolation.
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const args=process.argv.slice(2),witness=${JSON.stringify(witness)};
const record=row=>fs.appendFileSync(witness,JSON.stringify(row)+'\\n');
if(args[0]==='sandbox'){
  assert.equal(args[args.indexOf('-P')+1],'cm-specs');assert(args.includes('--include-managed-config'));
  const settings=args.filter((_,index)=>args[index-1]==='-c');
  assert(settings.includes('default_permissions="cm-specs"'));
  assert(settings.some(value=>value.startsWith('permissions.cm-specs=')&&value.includes('network={enabled=false}')));
  const command=args.slice(args.indexOf('--')+1);assert.deepEqual(command,[${JSON.stringify(process.execPath)},'--check','target.mjs']);
  record({type:'check'});const checked=cp.spawnSync(command[0],command.slice(1),{cwd:process.cwd(),encoding:'utf8'});
  process.stdout.write(checked.stdout??'');process.stderr.write(checked.stderr??'');process.exit(checked.status??1);
}
let prompt='';process.stdin.on('data',part=>prompt+=part);process.stdin.on('end',()=>{
  let value,thread;
  if(prompt.includes('<cm-developer-data-json>')){
    const data=JSON.parse(prompt.split('<cm-developer-data-json>\\n')[1].split('\\n')[0]),attempt=data.identity.attempt;
    assert.deepEqual(data.scope,['target.mjs']);assert.equal(data.specification.task.id,'T-001');
    const settings=args.filter((_,index)=>args[index-1]==='-c');assert(settings.includes('default_permissions="cm-specs"'));
    assert(args.includes('--output-schema'));record({type:'develop',attempt});
    fs.writeFileSync('target.mjs','export const value = '+(41+attempt)+';\\n');
    value={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}};thread='fixture-protected-author-'+attempt;
  }else{
    const data=JSON.parse(prompt.split('<cm-review-data-json>\\n')[1]),attempt=data.reviewPackage.identity.attempt;
    assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    if(attempt===2)assert.equal(data.priorReview.verdict,'changes_requested');
    thread='fixture-protected-independent-review-'+attempt;
    value={verdict:attempt===1?'changes_requested':'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:data.examinedPaths,findings:attempt===1?[{id:'F1',severity:'P2',path:'target.mjs',
      message:'Use the revised constant',evidence:'First synthetic review rejects 42'}]:[],summary:'Synthetic independent review'};
    record({type:'review',attempt,thread,verdict:value.verdict,packageDigest:value.packageDigest});
  }
  for(const event of [{type:'thread.started',thread_id:thread},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])
    process.stdout.write(JSON.stringify(event)+'\\n');
});
`,{mode:0o700});
  const result=f.drive(f.plan({permissions:['--review-config','review.json','--protected-config','protected.json']}));
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).result.state,'fixture_completed',result.stdout);
  const dispatched=fs.readFileSync(witness,'utf8').trim().split('\n').map(JSON.parse),reviews=dispatched.filter(row=>row.type==='review');
  assert.deepEqual(dispatched.filter(row=>row.type==='develop').map(row=>row.attempt),[1,2]);
  assert.deepEqual(reviews.map(row=>[row.attempt,row.verdict]),[[1,'changes_requested'],[2,'approved']]);
  assert.equal(new Set(reviews.map(row=>row.thread)).size,2);assert.notEqual(reviews[0].packageDigest,reviews[1].packageDigest);
  assert.ok(dispatched.filter(row=>row.type==='check').length>=3,'both rounds and completion run the real syntax command');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\] T-001/);
  const state=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')));
  const registrations=state.records.filter(row=>row.payload.type==='review-invocation-registered');
  assert.deepEqual(registrations.map(row=>row.payload.binding.identity.attempt),[1,2]);
  assert.equal(new Set(registrations.map(row=>row.payload.binding.invocationId)).size,2);
  for(const row of registrations){assert.equal(Object.hasOwn(row.payload,'grant'),false);assert.equal(Object.hasOwn(row.payload,'authorizationAt'),false);}
  assert.equal(state.records[0].payload.config.controlPolicy.development,'provider','v2 is bound in the actual durable run');
});
test('v2 disabled QA still assesses mandatory feature completion and cannot report run_done or passed',t=>{
  const f=fixture(t,true);f.review('approved');
  let r=f.drive(f.plan());assert.equal(r.status,0,r.stderr);
  let result=JSON.parse(r.stdout).result,combined=r.stderr;
  for(let n=0;n<3&&result.code!=='qa_triggered';n++){
    r=f.drive(f.plan({mode:'resume',originalHostContext:'v2-fixture-host'}));assert.equal(r.status,0,r.stderr);
    result=JSON.parse(r.stdout).result;combined+=r.stderr;
  }
  assert.match(combined,/应答 qa_assess/);
  assert.equal(result.code,'qa_triggered',JSON.stringify(result));assert.equal(result.pendingAction,'qa_execution');
  assert.notEqual(result.state,'run_done');
  const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row=>row.event==='qa'&&row.status==='triggered'&&row.reason==='feature_complete'));
  assert.equal(rows.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'),false);
});
test('batch refuses unavailable QA Fix mode before starting the host',t=>{
  const f=fixture(t,true);fs.writeFileSync(path.join(f.root,'control.json'),JSON.stringify({...policy,qa:'run',qaFix:'auto'}));
  const r=f.drive(f.plan());assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/invalid_arguments/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews/.execution')),false);
});
