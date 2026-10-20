// Real isolated owner/driver and native sandbox checks. Reviewer processes emit
// synthetic fresh-thread protocol evidence, never an independent model review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture as hostFixture,implementedValue} from './cm-ai-host-fixture.mjs';
import {specsPermissionArgs} from '../runtime/js/cm-ai/codex-config.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {readReviewFileBytes,compressedReviewSourceRecord,readReviewSourceRecords,captureReviewBaseline,createReviewPackage,readReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {compactReviewData,expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const CORE=new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
const CHECK=new URL('../runtime/js/cm-ai/host-check.mjs',import.meta.url).href;
const REVIEW=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=value=>Buffer.from(`export const value = ${value};\n`);
function fixture(t,{rules=false,largeMaterial=null}={}){
  const f=hostFixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const scope=[...Array.from({length:31},(_,n)=>`part-${String(n).padStart(2,'0')}.mjs`),'requirements.md'];
  const largeText=phase=>largeMaterial==='incompressible'?'//'+randomBytes(390*1024).toString('base64')+'\n':'//'+phase.repeat(520*1024)+'\n';
  const largeBefore=largeMaterial?Buffer.from(largeText('b')):null,largeCurrent=largeMaterial?Buffer.from(largeText('c')):null;
  const additions=['tracked-extra.mjs','new-one.mjs','new-two.mjs','new-three.mjs'];
  const definition=JSON.parse(fs.readFileSync(f.config));definition.scope=scope;
  fs.writeFileSync(f.config,JSON.stringify(definition));
  for(const file of [...scope,additions[0]])fs.writeFileSync(path.join(f.codeProject,file),bytes(0),{mode:0o644});
  if(largeMaterial)fs.writeFileSync(path.join(f.codeProject,scope[1]),largeBefore);
  fs.writeFileSync(path.join(f.codeProject,'other-protected.txt'),'preserve\n');
  const rulePaths=['.claude/rules/fixture.md','AGENTS.md'];
  const ruleText=(file,phase)=>`# Synthetic ${file} ${phase}\nPreserve the exact approved business scope.\n`;
  if(rules){fs.mkdirSync(path.join(f.codeProject,'.claude/rules'),{recursive:true});
    for(const file of rulePaths)fs.writeFileSync(path.join(f.codeProject,file),ruleText(file,'Git-before-B'),{mode:0o644});}

  // Git mutations are confined to this disposable fixture, never the source tree.
  const git=(...args)=>{
    const r=spawnSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
      {cwd:f.codeProject,encoding:'utf8',env:{...f.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  git('init','-q');git('add','--',...scope.filter(file=>file!=='requirements.md'),additions[0],'other-protected.txt',...(rules?rulePaths:[]));
  git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic review origin');
  const commit=git('rev-parse','HEAD');assert.match(commit,/^[a-f0-9]{40}$/);
  // All original scope is dirty before the run exists. Recovered r2 must compare
  // it with the complete Git task origin, rather than silently rebasing it away.
  for(const file of [...scope,...additions]){fs.writeFileSync(path.join(f.codeProject,file),bytes(1));fs.chmodSync(path.join(f.codeProject,file),0o644);}
  if(largeMaterial)fs.writeFileSync(path.join(f.codeProject,scope[1]),largeCurrent);
  if(rules)for(const file of rulePaths)fs.writeFileSync(path.join(f.codeProject,file),ruleText(file,'creation-A'));
  const policy=path.join(f.root,'POLICY.json'),workflow=path.join(f.root,'workflow.json');
  const command=['codex','sandbox','-P','cm-specs','--include-managed-config','-C',f.codeProject,
    ...specsPermissionArgs({cwd:f.codeProject,specsRoot:f.specsDir}),'--',process.execPath,'-e',
    `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync('other-protected.txt','utf8'),'preserve\\n');for(const p of ${JSON.stringify(scope)})assert.ok(fs.readFileSync(p).length>0);console.log('native continuation check executed');`];
  fs.writeFileSync(policy,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
  fs.writeFileSync(workflow,JSON.stringify({qa:{commands:[{id:'native',caseIds:[],command}],
    environment:{kind:'web',carrier:'browser',target:'synthetic-continuation',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
  const answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'final.txt'),'//'+'y'.repeat(700*1024)+'\n');
  fs.writeFileSync(path.join(answers,'develop-a2.json'),JSON.stringify({status:'succeeded',value:implementedValue(),edits:{[scope[0]]:'final.txt'}}));
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Synthetic fixture has no documentation targets'}));
  let fake=fs.readFileSync(REVIEW,'utf8').replace("verdict:'approved'","verdict:data.reviewPackage.identity.attempt===1?'changes_requested':'approved'")
    .replace('findings:[]',`findings:data.reviewPackage.identity.attempt===1?[{id:'F1',severity:'P2',path:${JSON.stringify(scope[0])},message:'Revise the first file',evidence:'Synthetic fixture finding'}]:[]`);
  if(rules&&largeMaterial){
    const helper=new URL('./fixtures/material-review-codex-helper.mjs',import.meta.url).href;
    const materialMode="settings.some(value=>value.startsWith('mcp_servers=')&&value.includes('review-material-server.mjs'))";
    fake=`import {expandMaterialFixturePrompt} from ${JSON.stringify(helper)};\n`+fake.replace(/^#![^\n]*\n/,'')
      .replace("if(settings.includes('model_provider=\"cm_local_tool_preview\"')){",
        `if(settings.includes('model_provider="cm_local_tool_preview"')&&${materialMode}){await expandMaterialFixturePrompt(args,prompt);process.exitCode=1;}else if(settings.includes('model_provider="cm_local_tool_preview"')){`)
      .replace("}else{\n  const marker=",`}else{\n  const materialMode=${materialMode};let toolCount=0;\n  const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');\n  if(materialMode){emit({type:'thread.started',thread_id:randomUUID()});emit({type:'turn.started'});\n    prompt=await expandMaterialFixturePrompt(args,prompt,{batchCount:8,onToolResult:result=>emit({type:'item.completed',item:{id:'material-'+(++toolCount),type:'mcp_tool_call',server:'cm_review',tool:'read_material',result}})});\n  }\n  const marker=`)
      .replace("[{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'},\n    {type:'item.completed'",
        "[...(materialMode?[]:[{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'}]),\n    {type:'item.completed'");
  }
  // Keep the native sandbox delegation installed by hostFixture; replace only
  // the imported synthetic reviewer module, not the real Codex executable.
  const fakeReview=path.join(f.root,'synthetic-review.mjs');fs.writeFileSync(fakeReview,fake);
  const fakeCli=path.join(f.root,'synthetic-review-bin','codex');
  fs.writeFileSync(fakeCli,fs.readFileSync(fakeCli,'utf8').replace(new URL('file://'+REVIEW).href,new URL('file://'+fakeReview).href));
  const permissions=['--review-config',f.reviewFile,'--workflow-config',workflow];
  const originalPlan=path.join(f.root,'PLAN-original.json');
  const planBase={config:f.config,controlConfig:'POLICY.json',mode:'resume',hostContext:'native-host-fixture',permissions,answers:'answers',
    checks:[{id:'native',command}]};
  fs.writeFileSync(originalPlan,JSON.stringify(planBase));let sequence=0;
  const stateFile=path.join(f.specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
  const state=()=>JSON.parse(fs.readFileSync(stateFile));
  const history=()=>{const s=state();return readRunnerHistory(s.records,s.records[0].payload.config,3);};
  const frozen=()=>[f.config,originalPlan,policy,workflow,f.reviewFile].map(file=>({path:file,bytes:fs.readFileSync(file)}));
  const origin=()=>({version:1,commit,additions:[...additions].sort().map(file=>{const content=fs.readFileSync(path.join(f.codeProject,file));
    return {path:file,source:'User approved this exact synthetic fixture addition',sha256:sha(content),size:content.length,mode:0o644};})});
  const drive=(operation,{register=false,target,originValue=origin(),scopeValue=[...scope,...additions],...extra}={})=>{
    const plan=path.join(f.root,`PLAN-resume-${++sequence}.json`),registered=[];
    if(register){
      fs.writeFileSync(path.join(f.root,'SCOPE.json'),JSON.stringify(scopeValue));
      fs.writeFileSync(path.join(f.root,'ORIGIN.json'),JSON.stringify(originValue));
      fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));
      registered.push('--revise-scope','SCOPE.json','--scope-revision-reason','Approved exact synthetic task continuation',
        '--expected-control','launch.json','--task-review-origin','ORIGIN.json');
    }
    fs.writeFileSync(plan,JSON.stringify({...planBase,...extra,permissions:[...permissions,...registered]}));
    const r=spawnSync(process.execPath,[DRIVER,'--plan',plan,operation],{encoding:'utf8',env:f.env,timeout:60000,maxBuffer:4*1024*1024});
    return {...r,value:r.stdout.trim()?JSON.parse(r.stdout).result:null};
  };
  // Produce real old-format inline history with an isolated version simulation.
  // This is not an original release binary and never changes the active runtime.
  const legacy=path.join(f.root,'legacy-inline-producer');fs.mkdirSync(legacy);
  const source=fileURLToPath(new URL('../',import.meta.url));
  for(const name of ['runtime','scripts','skills','agents','templates','package.json','cm-VERSION']){
    if(fs.existsSync(path.join(source,name)))fs.cpSync(path.join(source,name),path.join(legacy,name),{recursive:true});
  }
  const runner=path.join(legacy,'runtime/js/cm-ai/task-runner.mjs');
  const oldRunner=fs.readFileSync(runner,'utf8'),matches=oldRunner.match(/^  const packageMaterialEnabled=.*;$/gm);
  assert.equal(matches?.length,1,'legacy producer must replace only its known capacity eligibility declaration');
  fs.writeFileSync(runner,oldRunner.replace(matches[0],'  const packageMaterialEnabled=()=>false; // isolated legacy inline producer'));
  const legacyHost=path.join(legacy,'scripts/cm-ai-host.mjs');
  const live=(mode,attempt,content,{activeHost=legacyHost,expectedScope=scope}={})=>{
    const wrapper=path.join(f.root,`live-${++sequence}.mjs`);
    fs.writeFileSync(wrapper,`import fs from 'node:fs';import assert from 'node:assert/strict';import {driveHost} from ${JSON.stringify(CORE)};import {createHostCheck} from ${JSON.stringify(CHECK)};
const check=createHostCheck({cwd:${JSON.stringify(f.codeProject)},commands:[{id:'native',command:${JSON.stringify(command)}}]});
await driveHost({host:${JSON.stringify(activeHost)},args:['serve','--config',${JSON.stringify(f.config)},'--mode',${JSON.stringify(mode)},'--host-context','native-host-fixture','--control-config',${JSON.stringify(policy)},'--workflow-config',${JSON.stringify(workflow)},'--review-config',${JSON.stringify(f.reviewFile)}],cwd:${JSON.stringify(f.codeProject)},operation:'start',answers:{},request:{version:2,identity:${JSON.stringify({...definition.identity,attempt})}},answerFor:async row=>{
if(row.kind==='develop'){assert.deepEqual(row.payload.request.payload.scope,${JSON.stringify(expectedScope)});fs.writeFileSync(${JSON.stringify(path.join(f.root,'last-developer-request.json'))},JSON.stringify(row.payload.request));fs.writeFileSync(${JSON.stringify(path.join(f.codeProject,scope[0]))},${JSON.stringify(content)});return {status:'succeeded',value:${JSON.stringify(implementedValue())}};}
if(row.kind==='check')return check({identity:row.payload.identity},{signal:new AbortController().signal});return null;}});`);
    const r=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env:f.env,timeout:60000,maxBuffer:4*1024*1024});
    return {...r,value:r.stdout.trim()?JSON.parse(r.stdout).result:null};
  };
  const begin=()=>{
    const first=live('create',1,bytes(2).toString());assert.equal(first.status,0,first.stderr);assert.equal(first.value.state,'awaiting_review',JSON.stringify(first.value));
    const rejected=drive('decision',{packageDigest:first.value.packageDigest});assert.equal(rejected.status,0,rejected.stderr);
    assert.equal(rejected.value.state,'changes_requested',JSON.stringify(rejected.value));
    const blocked=live('resume',2,'//'+'x'.repeat(700*1024)+'\n');assert.equal(blocked.status,0,blocked.stderr);
    assert.equal(blocked.value.code,'develop_package_too_large',JSON.stringify(blocked.value));assert.equal(blocked.value.identity.attempt,2);
    const before=state(),status=drive('status');assert.equal(status.status,0,status.stderr);
    return {before,target:status.value.launchControlTarget};
  };
  const acceptRules=()=>{
    assert.ok(rules);for(const file of rulePaths)fs.writeFileSync(path.join(f.codeProject,file),ruleText(file,'accepted-current-C'));
    git('add','--',...scope,...additions,...rulePaths);
    git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic fully committed candidate');
    const candidateCommit=git('rev-parse','HEAD');assert.notEqual(candidateCommit,commit);
    assert.equal(git('status','--porcelain','--',...scope,...additions,...rulePaths),'');
    const baseline=state().records[0].payload.baseline;
    const ruleAcceptance={version:1,sourceBaselineDigest:baseline.baselineDigest,candidateCommit,
      source:'Human authorized these exact synthetic rule bytes for fresh independent review',
      files:rulePaths.map(file=>{const content=fs.readFileSync(path.join(f.codeProject,file));
        return {path:file,creationSha256:sha(Buffer.from(ruleText(file,'creation-A'))),sha256:sha(content),size:content.length,mode:0o644};})};
    return {...origin(),ruleAcceptance};
  };
  return {...f,scope,additions,definition,commit,command,originalPlan,stateFile,state,history,frozen,origin,drive,live,begin,
    git,rulePaths,ruleText,acceptRules,largeBefore,largeCurrent};
}

function checkpoint(f){return f.state().records.findLast(row=>row.payload.type==='effect-checkpoint').payload.checkpoint;}
function archivedR1(f){return fs.readdirSync(path.join(f.specsDir,'.reviews')).filter(name=>name.includes('-a1-'))
  .sort().map(name=>({path:name,bytes:fs.readFileSync(path.join(f.specsDir,'.reviews',name))}));}

test('native original a2 task continuation reviews complete Git before, preserves its prefix and reaches required QA',t=>{
  const f=fixture(t),frozen=f.frozen(),{before,target}=f.begin(),r1=archivedR1(f);assert.ok(r1.length>0,'r1 evidence must exist before continuation');
  const beforePreflight=fs.readFileSync(f.stateFile),preflight=f.drive('preflight',{register:true,target});
  assert.equal(preflight.status,0,preflight.stdout+'\n'+preflight.stderr);const report=JSON.parse(preflight.stdout);
  assert.equal(report.readOnly,true);assert.equal(report.status,'ready_for_owner_validation');
  assert.equal(report.actions.length,1);assert.deepEqual(report.target,target);assert.deepEqual(report.actions[0].target,target);
  assert.equal(report.actions[0].operation,'resume/status --revise-scope --task-review-origin');
  assert.ok(Number.isSafeInteger(report.registrationBytes)&&report.registrationBytes<=1024*1024);
  assert.deepEqual(fs.readFileSync(f.stateFile),beforePreflight,'preflight must not append records or take owner actions');
  assert.deepEqual(f.frozen(),frozen,'preflight must preserve original frozen inputs');
  const registered=f.drive('status',{register:true,target});assert.equal(registered.status,0,registered.stderr);
  assert.deepEqual(registered.value.effectiveScope,[...f.scope,...f.additions].sort());
  const after=f.state();assert.deepEqual(after.fingerprints,before.fingerprints);
  assert.deepEqual(after.records.slice(0,before.records.length),before.records);
  assert.equal(after.records.length,before.records.length+1);
  assert.equal(after.records.at(-1).payload.type,'scope-continued');
  assert.equal(registered.value.identity.attempt,2);
  const resumed=f.drive('status');assert.equal(resumed.status,0,resumed.stderr);
  assert.deepEqual(f.state().records,after.records,'normal resume must not register another continuation');
  const developed=f.drive('advance');assert.equal(developed.status,0,developed.stderr);
  assert.equal(developed.value.state,'run_done',JSON.stringify(developed.value));
  const finalHistory=f.history(),pkg=finalHistory.state.reviewPackage;
  const expected=[...f.scope,...f.additions].sort();assert.deepEqual(pkg.changes.map(row=>row.path),expected);
  for(const file of [...f.scope.filter(file=>file!=='requirements.md'),f.additions[0]])
    assert.equal(Buffer.from(pkg.changes.find(row=>row.path===file).before.contentBase64,'base64').toString(),bytes(0).toString(),file);
  for(const file of ['requirements.md',...f.additions.slice(1)])assert.equal(pkg.changes.find(row=>row.path===file).before,null,file);
  assert.equal(pkg.changes.find(row=>row.path===f.scope[1]).after.contentBase64,bytes(1).toString('base64'),
    'unchanged since create but dirty since task origin must be reviewed');
  assert.equal(finalHistory.state.attempt,2);
  assert.ok(finalHistory.state.receipts.some(row=>row.identity.attempt===1&&row.result.verdict==='changes_requested'));
  assert.ok(finalHistory.state.receipts.some(row=>row.identity.attempt===2&&row.result.verdict==='approved'));
  assert.ok((developed.stderr.match(/检查结束.*native.*passed/g)??[]).length>=3,
    'advance must execute real develop checks, completion prechecks, and required QA');
  const replay=f.drive('status');assert.equal(replay.status,0,replay.stderr);
  assert.equal(replay.value.state,'fixture_completed',JSON.stringify(replay.value));
  const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(logs.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'));
  assert.deepEqual(f.frozen(),frozen);assert.deepEqual(archivedR1(f),r1);
  assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);
  assert.deepEqual(f.state().fingerprints,before.fingerprints);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\] T-001/);
  if(process.env.CM_TASK_CONTINUATION_EVIDENCE){
    const records=f.state().records,encoding=records.map(row=>({id:row.id,type:row.payload.type,
      payloadBytes:Buffer.byteLength(JSON.stringify(row.payload)),effectId:row.payload.effectId??null,
      packageMaterial:row.payload.packageMaterial??false,packageRef:row.payload.packageRef??null}));
    const registration=encoding.find(row=>row.type==='scope-continued');
    fs.writeFileSync(process.env.CM_TASK_CONTINUATION_EVIDENCE,JSON.stringify({version:1,
      evidenceClass:'local native owner; synthetic reviewer protocol, not independent review',
      legacyProducer:'isolated copy with legacy inline capacity eligibility; not an original release binary',
      originalRecords:before.records.length,prefixPreserved:true,fingerprintsPreserved:true,r1FilesPreserved:r1.map(row=>row.path),
      preflight:{readOnly:report.readOnly,status:report.status,target:report.target,actions:report.actions,
        registrationBytes:report.registrationBytes,capacity:report.capacity},
      actualEncoding:{registrationBytes:registration.payloadBytes,maxPayloadBytes:Math.max(...encoding.map(row=>row.payloadBytes)),
        payloadLimit:1024*1024,records:encoding},
      reviews:finalHistory.state.receipts.map(row=>({attempt:row.identity.attempt,verdict:row.result.verdict,
        providerThreadId:row.execution.providerThreadId,packageDigest:row.packageDigest,receiptDigest:row.receiptDigest})),
      qa:logs.filter(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete').map(row=>
        ({result:row.result,testRunId:row.test_run_id??null,attempt:row.attempt??null})),
      finalState:developed.value.state,finalCode:developed.value.code},null,2)+'\n');
  }
});

test('native a2 continuation refuses stale, missing origin, digest drift and symlink without changing history',async t=>{
  const f=fixture(t),{before,target}=f.begin(),stateBytes=fs.readFileSync(f.stateFile),frozen=f.frozen();
  const refused=(options,pattern)=>{
    const r=f.drive('status',{register:true,target,...options});assert.notEqual(r.status,0,r.stderr);assert.match(r.stderr,pattern);
    assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);assert.deepEqual(f.frozen(),frozen);
  };
  refused({target:{...target,revision:'0'.repeat(64)}},/snapshot_changed/);
  refused({originValue:{...f.origin(),additions:f.origin().additions.slice(1)}},/task_review_origin|task_continuation|scope_continuation|invalid_input/);
  const changed=f.origin();changed.additions[0].sha256='0'.repeat(64);
  refused({originValue:changed},/task_review_origin|snapshot_changed|task_continuation|scope_continuation/);
  const file=path.join(f.codeProject,f.additions[3]),original=fs.readFileSync(file);
  fs.unlinkSync(file);fs.symlinkSync(f.additions[0],file);
  try{refused({},/unsupported_file|unsupported_path|task_review_origin|task_continuation|scope_continuation/);}finally{fs.unlinkSync(file);fs.writeFileSync(file,original);}
  const writer=openExecutionStore({specsRoot:f.specsDir,identity:before.identity,fingerprints:before.fingerprints,create:false});
  try{refused({},/store_busy|host_busy/);}finally{writer.close();}
  // Interrupt only a disposable fixture host after its registration is durable.
  // No operation is sent, so the restart cannot repeat development or review.
  const args=['serve','--config',f.config,'--mode','resume','--host-context','native-host-fixture',
    '--control-config',path.join(f.root,'POLICY.json'),'--review-config',f.reviewFile,'--workflow-config',path.join(f.root,'workflow.json'),
    '--revise-scope',path.join(f.root,'SCOPE.json'),'--scope-revision-reason','Approved exact synthetic task continuation',
    '--expected-control',path.join(f.root,'launch.json'),'--task-review-origin',path.join(f.root,'ORIGIN.json')];
  const child=spawn(process.execPath,[HOST,...args],{env:f.env,stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('isolated registration host did not become ready: '+errors));},15000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{output+=chunk;for(const line of output.split('\n').filter(Boolean)){
      try{if(JSON.parse(line).type==='host_ready'){clearTimeout(timer);resolve();}}catch{}
    }});
    child.on('close',code=>{clearTimeout(timer);if(!output.includes('host_ready'))reject(new Error('registration failed '+code+': '+errors));});
  });
  const interrupted=fs.readFileSync(f.stateFile);child.kill('SIGKILL');
  await new Promise(resolve=>child.once('close',resolve));
  const pinned=fs.readFileSync(file);fs.appendFileSync(file,'changed after registration');
  const drifted=f.drive('status');assert.notEqual(drifted.status,0);assert.match(drifted.stderr,/task_review_origin_changed/);
  assert.deepEqual(fs.readFileSync(f.stateFile),interrupted,'post-registration drift must not append or silently adopt code');
  fs.writeFileSync(file,pinned);
  const recovered=f.drive('status');assert.equal(recovered.status,0,recovered.stderr);
  assert.deepEqual(fs.readFileSync(f.stateFile),interrupted,'restart after durable registration must not append or re-execute');
  assert.deepEqual(recovered.value.effectiveScope,[...f.scope,...f.additions].sort());
  const acceptedBytes=fs.readFileSync(f.stateFile);
  const duplicate=f.drive('status',{register:true,target});assert.notEqual(duplicate.status,0,duplicate.stderr);
  assert.match(duplicate.stderr,/snapshot_changed|task_continuation|scope_continuation|scope_revision_unavailable/);
  assert.deepEqual(fs.readFileSync(f.stateFile),acceptedBytes);
  assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);
});

test('authorized rule acceptance keeps creation A and Git before B while reviewing committed current C through fresh r2 and QA',t=>{
  const f=fixture(t,{rules:true,largeMaterial:'compressible'}),frozen=f.frozen(),{before,target}=f.begin(),r1=archivedR1(f);
  const initial=f.history(),originValue=f.acceptRules(),business=[...f.scope,...f.additions].sort();
  assert.equal(before.records.at(-1).payload.checkpoint.code,'develop_package_too_large');
  assert.equal(initial.state.attempt,2);assert.equal(initial.pending,null);
  assert.equal(initial.state.receipts.length,1);assert.equal(initial.state.receipts[0].result.verdict,'changes_requested');
  assert.equal(initial.state.receipts.some(row=>row.identity.attempt===2),false);
  assert.deepEqual(initial.original.scope,[...f.scope,'AGENTS.md'].sort());
  for(const file of f.rulePaths){
    const original=initial.original.files.find(row=>row.path===file);
    assert.equal(original.sha256,sha(Buffer.from(f.ruleText(file,'creation-A'))),file);
    assert.notEqual(original.sha256,sha(Buffer.from(f.ruleText(file,'Git-before-B'))),file);
  }
  const preflightBytes=fs.readFileSync(f.stateFile),preflight=f.drive('preflight',{register:true,target,originValue});
  assert.equal(preflight.status,0,preflight.stdout+'\n'+preflight.stderr);
  const report=JSON.parse(preflight.stdout);
  assert.equal(report.status,'ready_for_owner_validation');assert.equal(report.readOnly,true);
  assert.deepEqual(report.target,target);assert.deepEqual(fs.readFileSync(f.stateFile),preflightBytes);
  const registered=f.drive('status',{register:true,target,originValue});
  assert.equal(registered.status,0,registered.stdout+'\n'+registered.stderr);
  assert.deepEqual(registered.value.effectiveScope,business);assert.equal(business.length,36);
  const accepted=f.state();assert.equal(accepted.records.length,before.records.length+1);
  assert.deepEqual(accepted.records.slice(0,before.records.length),before.records);
  assert.equal(accepted.records.at(-1).payload.type,'scope-continued');
  assert.deepEqual(accepted.records.at(-1).payload.taskReviewOrigin.authorization.ruleAcceptance,originValue.ruleAcceptance);
  const projected=f.history();assert.deepEqual(projected.original,initial.original);
  assert.deepEqual(projected.state.calls,initial.state.calls,'acceptance must not reset provider call count');
  assert.deepEqual(projected.state.cache,initial.state.cache,'acceptance must preserve failed a2 effect and all earlier effects');
  assert.equal(projected.state.attempt,2);assert.equal(projected.pending,null);
  assert.deepEqual(projected.taskContinuation.baseline.scope,[...business,...f.rulePaths].sort());
  for(const file of f.rulePaths){
    assert.deepEqual(readReviewFileBytes(projected.taskContinuation.baseline.files.find(row=>row.path===file)),
      Buffer.from(f.ruleText(file,'Git-before-B')),file);
  }
  // Exercise the real owner request boundary with a local current-conversation
  // answer, then let the ordinary driver dispatch the fresh synthetic r2.
  const develop=f.live('resume',2,'//'+'y'.repeat(700*1024)+'\n',{activeHost:HOST,expectedScope:business});
  assert.equal(develop.status,0,develop.stdout+'\n'+develop.stderr);
  assert.equal(develop.value.state,'awaiting_review',JSON.stringify(develop.value));
  const request=JSON.parse(fs.readFileSync(path.join(f.root,'last-developer-request.json')));
  assert.deepEqual(request.payload.scope,business,'review visibility must not authorize rule editing');
  assert.equal(request.payload.scope.some(file=>f.rulePaths.includes(file)),false);
  const awaiting=f.history();assert.equal(awaiting.state.receipts.length,1,'no local approval may complete fresh r2');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[ \] T-001/);
  const finished=f.drive('advance');assert.equal(finished.status,0,finished.stdout+'\n'+finished.stderr);
  assert.equal(finished.value.state,'run_done',JSON.stringify(finished.value));
  const final=f.history(),pkg=final.state.reviewPackage;
  assert.deepEqual(pkg.scope,[...business,...f.rulePaths].sort());
  assert.deepEqual(pkg.ruleAcceptance,originValue.ruleAcceptance,'final fresh review package carries exact accepted manifest');
  const large=pkg.changes.find(row=>row.path===f.scope[1]);
  assert.deepEqual(readReviewFileBytes(large.before),f.largeBefore);assert.deepEqual(readReviewFileBytes(large.after),f.largeCurrent);
  assert.equal(large.before.sha256,sha(f.largeBefore));assert.equal(large.after.sha256,sha(f.largeCurrent));
  assert.equal(typeof large.before.contentGzipBase64,'string');assert.equal(typeof large.after.contentGzipBase64,'string');
  const rawMaterialBytes=pkg.changes.reduce((sum,row)=>sum+(row.before?.size??0)+(row.after?.size??0),0);
  assert.ok(rawMaterialBytes<2*1024*1024,'source material remains under unchanged aggregate byte budget');
  assert.ok(f.largeBefore.toString('base64').length+f.largeCurrent.toString('base64').length>1024*1024,
    'the actual complete before and after alone exceed the unchanged journal cap when inline');
  assert.ok(Buffer.byteLength(JSON.stringify(pkg))<1024*1024,'lossless gzip fits the original journal cap');
  assert.deepEqual(pkg.changes.map(row=>row.path),[...business,...f.rulePaths].sort());
  for(const file of f.rulePaths){const change=pkg.changes.find(row=>row.path===file);
    assert.deepEqual(readReviewFileBytes(change.before),Buffer.from(f.ruleText(file,'Git-before-B')),file);
    assert.deepEqual(readReviewFileBytes(change.after),Buffer.from(f.ruleText(file,'accepted-current-C')),file);
    assert.equal(fs.readFileSync(path.join(f.codeProject,file),'utf8'),f.ruleText(file,'accepted-current-C'));
  }
  assert.deepEqual(final.original,initial.original,'creation baseline A remains exact durable history');
  assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);
  assert.deepEqual(f.state().fingerprints,before.fingerprints);assert.deepEqual(f.frozen(),frozen);assert.deepEqual(archivedR1(f),r1);
  assert.deepEqual(final.state.receipts.map(row=>[row.identity.attempt,row.result.verdict]),[[1,'changes_requested'],[2,'approved']]);
  assert.notEqual(final.state.receipts[0].execution.providerThreadId,final.state.receipts[1].execution.providerThreadId);
  assert.deepEqual(final.state.calls.slice(0,initial.state.calls.length),initial.state.calls);
  assert.ok(final.state.calls.length>initial.state.calls.length);
  const materialProof=fs.readdirSync(path.join(f.specsDir,'.reviews')).filter(name=>/^material-[a-f0-9]{64}\.json$/.test(name))
    .map(name=>JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews',name))))
    .find(proof=>proof.packageDigest===pkg.packageDigest);
  assert.ok(materialProof,'large complete prompt must produce real fixed-reader coverage evidence');
  assert.equal(materialProof.kind,'cm-review-material-evidence');assert.equal(materialProof.providerThreadId,final.state.receipts[1].execution.providerThreadId);
  assert.equal(materialProof.pageReadCount,materialProof.manifest.pageCount);
  assert.equal(materialProof.pages.length,materialProof.manifest.pageCount);assert.ok(materialProof.pages.length>1);
  assert.equal(materialProof.promptSha256,materialProof.manifest.promptSha256);
  const {evidenceDigest,...proofBody}=materialProof;assert.equal(evidenceDigest,digest(proofBody));
  const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(logs.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'));
  const replay=f.drive('status');assert.equal(replay.status,0,replay.stderr);assert.equal(replay.value.state,'fixture_completed');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\] T-001/);
  if(process.env.CM_RULE_ACCEPTANCE_EVIDENCE)fs.writeFileSync(process.env.CM_RULE_ACCEPTANCE_EVIDENCE,JSON.stringify({version:1,
    evidenceClass:'local native owner; synthetic reviewer protocol, not independent model review',
    creationBaselineDigest:initial.original.baselineDigest,gitBeforeCommit:f.commit,candidateCommit:originValue.ruleAcceptance.candidateCommit,
    businessScope:business,reviewScope:pkg.scope,ruleAcceptance:originValue.ruleAcceptance,
    originalRecordCount:before.records.length,prefixPreserved:true,fingerprintsPreserved:true,
    originalCalls:initial.state.calls.length,finalCalls:final.state.calls.length,
    reviews:final.state.receipts.map(row=>({attempt:row.identity.attempt,verdict:row.result.verdict,
      providerThreadId:row.execution.providerThreadId,packageDigest:row.packageDigest})),
    finalPackageDigest:pkg.packageDigest,canonicalPackageSha256:sha(Buffer.from(JSON.stringify(pkg))),materialProof,
    ruleChanges:pkg.changes.filter(row=>f.rulePaths.includes(row.path)),requiredQa:'PASS',finalState:replay.value.state},null,2)+'\n');
});

test('authorized rule acceptance refuses unbound metadata, protected paths and committed-byte drift without changing history',async t=>{
  const f=fixture(t,{rules:true}),{before,target}=f.begin(),originValue=f.acceptRules(),stateBytes=fs.readFileSync(f.stateFile),frozen=f.frozen();
  const bad=mutate=>{const value=structuredClone(originValue);mutate(value.ruleAcceptance,value);return value;};
  const refused=(origin=originValue,extra={},pattern=/task_review_origin|snapshot_changed|task_continuation|scope_continuation|rule_acceptance|invalid_input/)=>{
    const result=f.drive('status',{register:true,target,originValue:origin,...extra});
    assert.notEqual(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stderr,pattern);
    assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);assert.deepEqual(f.frozen(),frozen);
  };
  refused(originValue,{target:{...target,revision:'0'.repeat(64)}});
  refused(bad(a=>a.sourceBaselineDigest='0'.repeat(64)));
  refused(bad(a=>a.files[0].creationSha256='0'.repeat(64)));
  refused(bad(a=>a.files[0].sha256='0'.repeat(64)));
  refused(bad(a=>a.candidateCommit=f.commit));
  refused(bad(a=>a.source=''));
  refused(bad(a=>a.files[0].path='.codex/config.toml'));
  refused(bad(a=>a.files.push({...a.files[0]})));
  refused(bad(a=>a.files[0].mode=0o755));
  refused(bad(a=>a.files[0].size++));
  refused(bad(a=>a.files[0].path='.claude/rules/new-uncreated.md'));
  // A commit with the identical tree isolates HEAD binding from byte matching.
  f.git('-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Synthetic HEAD identity drift');
  refused();originValue.ruleAcceptance.candidateCommit=f.git('rev-parse','HEAD');
  const drift=path.join(f.codeProject,f.rulePaths[0]),current=fs.readFileSync(drift);
  fs.appendFileSync(drift,'uncommitted rule drift\n');try{refused();}finally{fs.writeFileSync(drift,current);}
  const writer=openExecutionStore({specsRoot:f.specsDir,identity:before.identity,fingerprints:before.fingerprints,create:false});
  try{refused(originValue,{},/store_busy|host_busy/);}finally{writer.close();}
  const accepted=f.drive('status',{register:true,target,originValue});assert.equal(accepted.status,0,accepted.stdout+'\n'+accepted.stderr);
  const acceptedBytes=fs.readFileSync(f.stateFile),replay=f.drive('status');assert.equal(replay.status,0,replay.stderr);
  assert.deepEqual(fs.readFileSync(f.stateFile),acceptedBytes,'restart must preserve the one durable acceptance');
  fs.appendFileSync(drift,'changed after acceptance\n');
  try{const result=f.drive('status');assert.notEqual(result.status,0);assert.match(result.stderr,/task_review_origin_changed|rule_acceptance_changed/);
    assert.deepEqual(fs.readFileSync(f.stateFile),acceptedBytes);}finally{fs.writeFileSync(drift,current);}
  const duplicate=f.drive('status',{register:true,target,originValue});assert.notEqual(duplicate.status,0);
  assert.match(duplicate.stderr,/snapshot_changed|task_continuation|scope_continuation|scope_revision_unavailable/);
  assert.deepEqual(fs.readFileSync(f.stateFile),acceptedBytes);
});

test('rule acceptance lossless codec accepts sub-64KiB material and rejects altered bytes or metadata',t=>{
  const material=Buffer.from('Preserve the exact authorized rules and full review source.\n'.repeat(80));
  assert.ok(material.length>=1024&&material.length<64*1024);
  const original={path:'.claude/rules/small.md',type:'file',mode:0o644,size:material.length,
    sha256:sha(material),contentBase64:material.toString('base64')};
  const compressed=compressedReviewSourceRecord(original);
  assert.equal(typeof compressed.contentGzipBase64,'string');assert.equal(Object.hasOwn(compressed,'contentBase64'),false);
  assert.deepEqual(readReviewFileBytes(compressed),material);assert.equal(compressed.size,material.length);assert.equal(compressed.sha256,sha(material));
  assert.equal(original.contentBase64,material.toString('base64'),'encoding a derived record must not mutate historic inline material');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-rule-presentation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const selected=['AGENTS.md','small.mjs'];
  for(const file of selected)fs.writeFileSync(path.join(root,file),material);
  fs.writeFileSync(path.join(root,'requirements.md'),'Approved synthetic codec fixture\n');
  const baseline=captureReviewBaseline({root,identity:{repositoryId:'rule-codec',runId:'rule-codec-run',taskId:'T-001',attempt:2},
    scope:selected,requirements:['requirements.md']});
  const after=Buffer.concat([material,Buffer.from('Full accepted content remains visible.\n')]);
  for(const file of selected)fs.writeFileSync(path.join(root,file),after);
  const ordinary=createReviewPackage({root,baseline,checks:[{id:'codec',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'local codec fixture'}]});
  const changes=ordinary.changes.map(row=>({...row,before:compressedReviewSourceRecord(row.before),after:compressedReviewSourceRecord(row.after)}));
  const {packageDigest,...body}={...ordinary,changes,artifactDigest:digest(changes)};
  const canonical=readReviewPackage({...body,packageDigest:digest(body)});
  const data={reviewPackage:canonical,priorReview:null,examinedPaths:selected},shown=compactReviewData(data);
  assert.deepEqual(expandReviewData(shown),data,'model presentation must preserve the canonical package and digest');
  for(const value of [material,after])assert.ok(Object.values(shown.contents).some(row=>row.encoding==='utf8'&&row.content===value.toString()),
    'sub-64KiB rule and business contents must be complete plain text in the model presentation');
  assert.deepEqual(shown.reviewPackage.changes.map(row=>row.path),selected);
  const truncated=Buffer.from(compressed.contentGzipBase64,'base64').subarray(0,10).toString('base64');
  for(const bad of [{...compressed,contentGzipBase64:truncated},{...compressed,contentBase64:original.contentBase64},
    {...compressed,sha256:'0'.repeat(64)},{...compressed,size:material.length-1}])assert.throws(()=>readReviewSourceRecords([bad]));
});

test('rule acceptance preflight retains a real uncompressible complete-package capacity refusal and original history',t=>{
  const f=fixture(t,{rules:true,largeMaterial:'incompressible'}),{before,target}=f.begin(),originValue=f.acceptRules();
  const frozen=f.frozen(),stateBytes=fs.readFileSync(f.stateFile),r1=archivedR1(f);
  const result=f.drive('preflight',{register:true,target,originValue});
  assert.notEqual(result.status,0,result.stdout+'\n'+result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.status,'blocked');assert.equal(report.readOnly,true);
  assert.ok(report.issues.some(row=>/capacity|limit|too_large/.test(row.code)),JSON.stringify(report));
  assert.equal(report.issues.some(row=>/rule_acceptance/.test(row.code)),false,'exact valid rule acceptance is not the blocking condition');
  assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);assert.deepEqual(f.frozen(),frozen);assert.deepEqual(archivedR1(f),r1);
  assert.equal(f.history().state.attempt,2);assert.equal(f.history().state.code,'develop_package_too_large');
  assert.deepEqual(f.state().records,before.records);
});
