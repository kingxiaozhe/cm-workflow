// Native host/driver fixtures use temporary CLI protocol shims, never a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createConversationExecution,readReviewerSwitchConfiguration} from './cm-ai-host.mjs';
import {runConfigMaterial} from './cm-ai-run.mjs';
import {conversationReviewerSwitch,bindConversationReviewerSwitch} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {killFixtureProcesses} from './fixtures/process-cleanup.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const CODEX=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const identity={repositoryId:'switch-native',runId:'switch-native-run',taskId:'T-001',attempt:1};
const roles='version: 1\nruntimes: {available: both}\nroles:\n  coder: {adapter: codex-cli, source: subscription}\n  reviewer: {adapter: claude-cli, source: subscription}\n';
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-reviewer-switch-')));
  t.after(()=>{killFixtureProcesses(root);fs.rmSync(root,{recursive:true,force:true});});
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.yml'),roles);
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['target.mjs'],requirements:[]};
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,provider:'claude',cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd:codeProject,model:'fixture'})}};
  const switchConfiguration={version:1,provider:'codex',review:{model:'fixture',disabledSkills:[],preflight:{passed:true,
    cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',disabledSkills:[]})}}};
  const config=path.join(root,'switch.json');fs.writeFileSync(config,JSON.stringify(switchConfiguration));
  const bridge={call:()=>assert.fail('factory cannot dispatch')};
  const execution=(options={})=>createConversationExecution(definition,'native-switch-host',bridge,review,null,null,false,'codex',
    {controlPolicy:policy,reviewRuntime:'claude',...options});
  return {root,definition,review,switchConfiguration,config,execution};
}

test('switch factory retains exact original configuration and reviewer metadata; copied factories cannot bind',t=>{
  const f=fixture(t),original=f.execution(),switched=f.execution({reviewerSwitchConfiguration:f.switchConfiguration});
  assert.deepEqual(runConfigMaterial(f.definition,switched),runConfigMaterial(f.definition,original));
  const descriptors=execution=>execution.reviewers.map(({run,...descriptor})=>descriptor);
  assert.deepEqual(descriptors(switched),descriptors(original));
  const candidate=conversationReviewerSwitch(switched);
  assert.equal(candidate.configurationDigest,digest(f.switchConfiguration));
  assert.equal(candidate.toReviewer.provider,'codex');assert.equal(candidate.toReviewer.requestedModel,'fixture');
  assert.deepEqual(candidate.toReviewer.contexts,original.reviewers[0].contexts);
  assert.equal(conversationReviewerSwitch({...switched}),null);
  assert.throws(()=>bindConversationReviewerSwitch({...switched},candidate),{code:'reviewer_switch_configuration_required'});
  assert.throws(()=>bindConversationReviewerSwitch(switched,{...candidate,configurationDigest:'a'.repeat(64)}),
    {code:'reviewer_switch_configuration_mismatch'});
  bindConversationReviewerSwitch(switched,candidate);
  assert.deepEqual(descriptors(switched),descriptors(original));
  assert.deepEqual(runConfigMaterial(f.definition,switched),runConfigMaterial(f.definition,original));
});

test('switch config parser normalizes disabledSkills and factory requires exact Codex preflight',t=>{
  const f=fixture(t),withoutSkills=structuredClone(f.switchConfiguration);delete withoutSkills.review.disabledSkills;
  fs.writeFileSync(f.config,JSON.stringify(withoutSkills));
  assert.deepEqual(readReviewerSwitchConfiguration(f.config,f.definition),f.switchConfiguration);
  for(const [name,make] of [['symlink',file=>fs.symlinkSync(f.config,file)],['hardlink',file=>fs.linkSync(f.config,file)]]){
    const alias=path.join(f.root,name+'.json');make(alias);
    assert.throws(()=>readReviewerSwitchConfiguration(alias,f.definition));fs.unlinkSync(alias);
  }
  const linkedParent=path.join(f.root,'linked-parent');fs.symlinkSync(f.root,linkedParent,'dir');
  assert.throws(()=>readReviewerSwitchConfiguration(path.join(linkedParent,'switch.json'),f.definition));fs.unlinkSync(linkedParent);
  for(const root of [f.definition.codeProject,f.definition.specsDir]){
    const inside=path.join(root,'switch.json');fs.writeFileSync(inside,JSON.stringify(f.switchConfiguration));
    assert.throws(()=>readReviewerSwitchConfiguration(inside,f.definition),{code:'reviewer_switch_configuration_invalid'});
  }
  for(const revise of [c=>{c.review.model='changed';},c=>{c.review.preflight={};},c=>{c.provider='claude';},
    c=>{c.review.timeoutMs=0;},c=>{c.review.extra=true;}]){
    const changed=structuredClone(f.switchConfiguration);revise(changed);
    assert.throws(()=>f.execution({reviewerSwitchConfiguration:changed}));
  }
  assert.throws(()=>f.execution({reviewerSwitchConfiguration:f.switchConfiguration,parallelMember:true}),
    {code:'reviewer_switch_unavailable'});
});

function nativeFixture(t,{protectedScope=false,reusedThread=null}={}){
  const f=fixture(t),{root,definition}=f,bin=path.join(root,'bin'),answers=path.join(root,'answers');
  fs.mkdirSync(bin);fs.mkdirSync(answers);
  for(const [name,value] of [['run.json',definition],['control.json',protectedScope?{...policy,qa:'run'}:policy],['review.json',f.review]])
    fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:{outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
    edits:{'target.mjs':'target.txt'}}));
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value=42;\n');
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected empty documentation scope'}));
  const witness=path.join(root,'review-calls'),claude=path.join(root,'claude-fixture.mjs');
  fs.writeFileSync(claude,`import fs from 'node:fs';\nlet prompt='';for await(const part of process.stdin)prompt+=part;
fs.appendFileSync(${JSON.stringify(witness)},'claude\\n');
const marker='<cm-review-data-json>\\n',data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
const session_id='claude-thread-'+data.reviewPackage.identity.attempt,out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
out({type:'system',subtype:'init',session_id});
if(data.reviewPackage.identity.attempt===1){
const value={verdict:'changes_requested',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Change value to 43',evidence:'Fixture source has value 42'}],summary:'Synthetic first review'};
out({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}]}});
out({type:'result',subtype:'success',session_id,is_error:false,num_turns:1,result:JSON.stringify(value),structured_output:value});process.exit(0);}
out({type:'assistant',session_id,parent_tool_use_id:null,error:'rate_limit',is_api_error_message:true,
message:{role:'assistant',content:[{type:'text',text:'API Error: 429 rate limited'}]}});
out({type:'result',subtype:'success',is_error:true,session_id,num_turns:1,result:'API Error: 429 rate limited',
terminal_reason:'api_error',api_error_status:429});process.exit(1);`);
  const realCodex=protectedScope?spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'}).stdout.trim():null;
  if(protectedScope)assert.ok(realCodex,'protected native fixture requires the installed Codex sandbox');
  const codex=path.join(root,'codex-fixture.mjs');fs.writeFileSync(codex,`import fs from 'node:fs';
if(process.argv[2]==='sandbox'){const {spawnSync}=await import('node:child_process');
const result=spawnSync(${JSON.stringify(realCodex)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);}
const reusedThread=${JSON.stringify(reusedThread)};
if(reusedThread){const write=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>{
let output=String(chunk);try{const event=JSON.parse(output);if(event.type==='thread.started')event.thread_id=reusedThread;
output=JSON.stringify(event)+'\\n';}catch{}return write(output,...args);};}
fs.appendFileSync(${JSON.stringify(witness)},'codex\\n');await import(${JSON.stringify(new URL('file://'+CODEX).href)});`);
  for(const [name,file] of [['claude',claude],['codex',codex]])fs.writeFileSync(path.join(bin,name),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(file)} "$@"\n`,{mode:0o700});
  const basePermissions=['--review-config','review.json','--review-runtime','claude'];
  if(protectedScope){
    const additions='added.test.mjs',baseline=Array.from({length:96},(_,index)=>({path:`protected-${index}.txt`,content:`preserve ${index}\n`}));
    for(const file of baseline)fs.writeFileSync(path.join(definition.codeProject,file.path),file.content);
    fs.writeFileSync(path.join(definition.codeProject,additions),'export const protectedValue=0;\n');
    fs.writeFileSync(path.join(answers,'added.txt'),'export const protectedValue=1;\n');
    const check=[process.execPath,'-e',"const fs=require('node:fs'),assert=require('node:assert/strict');"
      +`const scope=new Set(JSON.parse(fs.readFileSync('${path.join(root,'run.json')}','utf8')).scope);`
      +`for(const file of ${JSON.stringify(baseline)})assert.equal(fs.readFileSync(file.path,'utf8'),file.content);`
      +`if(!scope.has('${additions}'))assert.equal(fs.readFileSync('${additions}','utf8'),'export const protectedValue=0;\\n');`
      +`assert.equal(fs.readFileSync('${additions}','utf8'),'export const protectedValue=1;\\n');`
      +"assert.ok([42,43].some(value=>fs.readFileSync('target.mjs','utf8').includes('export const value='+value+';')));"];
    fs.writeFileSync(path.join(root,'protected.json'),JSON.stringify({checkCommands:[{id:'syntax',command:check}],timeoutMs:15000}));
    fs.writeFileSync(path.join(root,'workflow.json'),JSON.stringify({qa:{commands:[{id:'syntax',caseIds:[],command:check}],
      environment:{kind:'web',carrier:'browser',target:'isolated-fixture',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
    basePermissions.push('--protected-conversation-config','protected.json','--workflow-config','workflow.json','--input-limit','1048576');
  }
  const plan=(permissions=basePermissions,extra={})=>{
    const file=path.join(root,'plan.json');fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'resume',hostContext:'native-switch-host',
      runtime:'codex',controlConfig:'control.json',permissions,answers:'answers',
      checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));return file;
  };
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const drive=(permissions=basePermissions,operation='status',extra={})=>{
    const run=spawnSync(process.execPath,[DRIVER,'--plan',plan(permissions,extra),operation],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,
      env});
    let result=null;try{result=JSON.parse(run.stdout).result;}catch{}
    return {...run,result};
  };
  const state=path.join(definition.specsDir,'.reviews','.execution',identity.runId,'state.json');
  const records=()=>JSON.parse(fs.readFileSync(state)).records;
  const calls=()=>fs.existsSync(witness)?fs.readFileSync(witness,'utf8').trim().split('\n'):[];
  const startFirstReview=()=>{
    const created=drive(basePermissions,'advance',{mode:'create'});
    if(!protectedScope)return created;
    assert.equal(created.status,0,created.stderr);assert.equal(created.result.code,'develop_checks_not_passed',created.stdout);
    const preview=drive();assert.equal(preview.status,0,preview.stderr);
    fs.writeFileSync(path.join(root,'scope-expected.json'),JSON.stringify(preview.result.launchControlTarget));
    fs.writeFileSync(path.join(root,'scope.json'),JSON.stringify(['added.test.mjs','target.mjs']));
    fs.writeFileSync(path.join(root,'scope-check.json'),JSON.stringify({version:1,definitionFile:path.join(root,'run.json'),checkIds:['syntax']}));
    const revised=drive([...basePermissions,'--revise-scope','scope.json','--scope-revision-reason','Approve the exact regression test path',
      '--expected-control','scope-expected.json','--scope-check-supplement','scope-check.json']);
    assert.equal(revised.status,0,revised.stderr);assert.ok(records().some(row=>row.payload.type==='scope-revised'));
    const first=JSON.parse(fs.readFileSync(path.join(answers,'develop.json')));first.edits['added.test.mjs']='added.txt';
    fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify(first));
    return drive(basePermissions,'advance');
  };
  return {...f,drive,state,records,calls,basePermissions,answers,startFirstReview,protectedScope,env};
}

async function refuseActiveWriter(f,register){
  const child=spawn(process.execPath,[HOST,'serve','--config',path.join(f.root,'run.json'),'--mode','resume',
    '--host-context','native-switch-host','--control-config',path.join(f.root,'control.json'),
    '--review-config',path.join(f.root,'review.json'),'--review-runtime','claude'],{env:f.env,stdio:['pipe','pipe','pipe']});
  let buffer='',sessionId,errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const closed=new Promise(resolve=>child.once('close',resolve));
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('fixture owner did not become ready')),10000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',()=>{clearTimeout(timer);if(!sessionId)reject(Error('fixture owner closed: '+errors));});
      child.stdout.on('data',chunk=>{buffer+=chunk;let newline;
        while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;
          const row=JSON.parse(line);if(row.type==='host_ready'){sessionId=row.sessionId;clearTimeout(timer);resolve();}}
      });
    });
    const before=fs.readFileSync(f.state),occupied=f.drive(register);
    assert.notEqual(occupied.status,0);assert.match(occupied.stderr,/store_busy/);assert.deepEqual(fs.readFileSync(f.state),before);
  }finally{
    if(sessionId)child.stdin.end(JSON.stringify({type:'host_close',sessionId})+'\n');else child.kill('SIGKILL');
    await closed;
  }
}

async function runNativeSwitch(t,options={}){
    const f=nativeFixture(t,options),frozen=['run.json','control.json','review.json',...(options.protectedScope?['protected.json','workflow.json']:[])]
      .map(name=>({file:path.join(f.root,name),bytes:fs.readFileSync(path.join(f.root,name))}));
    const created=f.startFirstReview();
    assert.equal(created.status,0,created.stderr);assert.equal(created.result.state,'changes_requested',created.stdout);
    assert.deepEqual(f.calls(),['claude']);
    const revised=JSON.parse(fs.readFileSync(path.join(f.answers,'develop.json')));
    revised.edits={...revised.edits,'target.mjs':'target-a2.txt'};
    fs.writeFileSync(path.join(f.answers,'develop-a2.json'),JSON.stringify(revised));
    fs.writeFileSync(path.join(f.answers,'target-a2.txt'),(options.protectedScope?'/*'+'x'.repeat(620*1024)+'*/\n':'')+'export const value=43;\n');
    const failed=f.drive(f.basePermissions,'advance');assert.equal(failed.status,0,failed.stderr);
    assert.equal(failed.result.code,'review_provider_failed',failed.stdout);assert.equal(failed.result.identity.attempt,2);
    assert.deepEqual(f.calls(),['claude','claude']);
    if(options.protectedScope){
      assert.ok(f.records().some(row=>row.payload.type==='effect-checkpoint'&&row.payload.packageMaterial===true),
        'the large second-round package must use the unchanged material/reference capacity mechanism');
      assert.ok(f.records().some(row=>row.payload.type==='effect-checkpoint'&&row.payload.packageRef));
    }
    const initial=fs.readFileSync(f.state),before=JSON.parse(initial),preview=f.drive();
    assert.equal(preview.status,0,preview.stderr);assert.ok(preview.result.launchControlTarget);
    const expected=path.join(f.root,'expected.json');fs.writeFileSync(expected,JSON.stringify(preview.result.launchControlTarget));
    const kept=[...f.basePermissions,'--reviewer-switch-config',f.config];
    const register=[...kept,'--reviewer-switch-reason','Use the explicitly selected Codex reviewer','--expected-control',expected];
    const noReason=f.drive(kept);assert.notEqual(noReason.status,0);assert.match(noReason.stderr,/reviewer_switch_authorization_required/);
    assert.deepEqual(fs.readFileSync(f.state),initial);
    fs.writeFileSync(expected,JSON.stringify({...preview.result.launchControlTarget,revision:'a'.repeat(64)}));
    const stale=f.drive(register);assert.notEqual(stale.status,0);assert.match(stale.stderr,/snapshot_changed/);
    assert.deepEqual(fs.readFileSync(f.state),initial);
    fs.writeFileSync(expected,JSON.stringify(preview.result.launchControlTarget));
    if(!options.protectedScope)await refuseActiveWriter(f,register);
    const invalidOperation=f.drive(register,'advance');assert.equal(invalidOperation.status,2);assert.deepEqual(f.calls(),['claude','claude']);
    const registered=f.drive(register);assert.equal(registered.status,0,registered.stderr);assert.deepEqual(f.calls(),['claude','claude']);
    const registeredBytes=fs.readFileSync(f.state),after=JSON.parse(registeredBytes);
    assert.deepEqual(after.fingerprints,before.fingerprints);
    assert.deepEqual(after.records.slice(0,before.records.length),before.records);
    assert.equal(after.records.filter(row=>row.payload.type==='reviewer-switched').length,1);
    assert.match(fs.readFileSync(path.join(f.definition.specsDir,'1.work/tasks.md'),'utf8'),/\[ \]/);
    const again=f.drive(register);assert.equal(again.status,0,again.stderr);assert.deepEqual(fs.readFileSync(f.state),registeredBytes);
    const missing=f.drive();assert.notEqual(missing.status,0);assert.match(missing.stderr,/reviewer_switch_configuration_required/);
    assert.deepEqual(fs.readFileSync(f.state),registeredBytes);
    const changed=structuredClone(f.switchConfiguration);changed.review.timeoutMs=12345;fs.writeFileSync(f.config,JSON.stringify(changed));
    const drift=f.drive(kept);assert.notEqual(drift.status,0);assert.match(drift.stderr,/reviewer_switch_configuration_mismatch/);
    assert.deepEqual(fs.readFileSync(f.state),registeredBytes);fs.writeFileSync(f.config,JSON.stringify(f.switchConfiguration));
    const resumed=f.drive(kept,'advance');
    if(options.reusedThread){
      assert.equal(resumed.status,1,resumed.stdout+resumed.stderr);
      const records=f.records(),develops=rows=>rows.filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='develop');
      const history=readRunnerHistory(records,records[0].payload.config,3);
      assert.equal(history.state.code,'observation_invalid');assert.equal(history.state.state,'unknown');
      assert.equal(history.state.attempt,2);assert.deepEqual(f.calls(),['claude','claude','codex']);
      assert.deepEqual(develops(records),develops(before.records),'a rejected reviewer must not repeat development');
      assert.equal(records.filter(row=>row.payload.type==='review-invocation-registered').length,3,'the rejected invocation still consumes its normal call');
      assert.deepEqual(records.slice(0,before.records.length),before.records,'the original calls and attempt history remain exact');
      const failedReview=records.findLast(row=>row.payload.type==='review-invocation-result').payload;
      assert.equal(failedReview.inspection,null);assert.equal(failedReview.reconciliationRequired,true);
      assert.ok(failedReview.observation.events.some(event=>event.event==='thread.started'&&event.provider_thread===options.reusedThread));
      assert.equal(records.some(row=>row.payload.type==='task-commit-result'),false,'no completion may follow an independent-context violation');
      assert.match(fs.readFileSync(path.join(f.definition.specsDir,'1.work/tasks.md'),'utf8'),/\[ \]/);
      for(const {file,bytes} of frozen)assert.deepEqual(fs.readFileSync(file),bytes);
      return;
    }
    assert.equal(resumed.status,0,resumed.stderr);
    assert.equal(resumed.result.state,options.protectedScope?'run_done':'fixture_completed',resumed.stdout);assert.deepEqual(f.calls(),['claude','claude','codex']);
    assert.equal(resumed.result.identity.attempt,2);
    const develops=records=>records.filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='develop');
    assert.deepEqual(develops(f.records()),develops(before.records),'switching must not repeat development');
    assert.equal(f.records().findLast(row=>row.payload.type==='review-invocation-registered').payload.binding.packageDigest,
      failed.result.packageDigest,'the new invocation must bind the failed second-round package');
    assert.equal(f.records().filter(row=>row.payload.type==='review-invocation-registered').length,3);
    const restored=f.drive(kept);assert.equal(restored.status,0,restored.stderr);assert.deepEqual(f.calls(),['claude','claude','codex']);
    assert.match(fs.readFileSync(path.join(f.definition.codeProject,'.cm-workflow.yml'),'utf8'),/reviewer: \{adapter: claude-cli/);
    for(const {file,bytes} of frozen)assert.deepEqual(fs.readFileSync(file),bytes,'frozen launch inputs must remain byte exact');
    if(options.protectedScope){
      assert.deepEqual(f.records().filter(row=>row.payload.type==='scope-revised'),before.records.filter(row=>row.payload.type==='scope-revised'));
      for(let index=0;index<96;index++)assert.equal(fs.readFileSync(path.join(f.definition.codeProject,`protected-${index}.txt`),'utf8'),`preserve ${index}\n`);
      const qa=fs.readFileSync(path.join(f.definition.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(qa.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'),
        'the original projected QA guard must execute and be accepted');
    }
}

test('native reviewer switch registers without a model, retains original launch and requires exact config on every resume',
  {skip:!isSupportedExecutionPlatform()},t=>runNativeSwitch(t));
test('protected scope recovery, 620 KiB second-round material and original QA survive a reviewer switch',
  {skip:!isSupportedExecutionPlatform()||process.platform!=='darwin'},t=>runNativeSwitch(t,{protectedScope:true}));
test('native switch rejects a Codex reviewer that reuses the original host physical thread',
  {skip:!isSupportedExecutionPlatform()},t=>runNativeSwitch(t,{reusedThread:'native-switch-host'}));
