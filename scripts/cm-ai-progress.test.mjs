import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess,{spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';

const driver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-progress-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'home');
process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const identity={repositoryId:'progress-fixture',runId:'progress-fixture-run',taskId:'T-001',attempt:1};
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-progress-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.sample';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['target.mjs'],requirements:['requirements.md']};
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(definition));
  const statusPath=path.join(specsDir,'.cm-status.json');
  const old={node:'N6',feature,task:'T-OLD',state:'qa_passed',detail:'old pass',at:'00:00:00'};
  fs.writeFileSync(statusPath,JSON.stringify(old));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value=42;\n');
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:{outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt'}}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{}}));
  const plan=(checks,extra={})=>{
    const file=path.join(root,'plan.json');
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'progress-fixture-host',
      permissions:['--review-config','review.json'],answers:'answers',checks,...extra}));return file;
  };
  const env={...process.env,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const run=(checks,extra={})=>spawnSync(process.execPath,[driver,'--plan',plan(checks,extra),'advance'],{encoding:'utf8',timeout:30000,env});
  return {root,specsDir,codeProject,feature,definition,statusPath,old,env,plan,run,
    status:()=>JSON.parse(fs.readFileSync(statusPath,'utf8')),
    events:()=>fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}
const check=(id,body)=>({id,command:[process.execPath,'-e',body]});
const control=(operation,selected=identity)=>({version:1,operation,requestId:operation,identity:selected});

for(const runtime of ['codex','claude'])test(`${runtime}: live check replaces old task status before command executes`,t=>{
  const f=fixture(t);
  const probe=`const s=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(f.statusPath)}));if(s.task!=='T-001'||s.state!=='checking'){console.error('CM_PROGRESS_STALE '+JSON.stringify(s));process.exit(1)}`;
  const run=f.run([check('probe',probe)],{runtime});
  assert.equal(run.status,0,run.stderr);
  const result=JSON.parse(run.stdout).result;
  assert.equal(result.state,'awaiting_review','CM_PROGRESS_STALE '+run.stderr);
  const status=f.status();assert.equal(status.task,'T-001');assert.equal(status.state,'awaiting_review');
  assert.equal(status.run_id,identity.runId);assert.equal(status.attempt,1);assert.equal(status.node,'N4');
  const events=f.events().filter(row=>row.event==='progress');
  assert(events.some(row=>row.phase==='start'&&row.phase_name==='developing'));
  assert(events.some(row=>row.phase==='start'&&row.phase_name==='checking'));
  assert(!events.some(row=>row.phase_name==='reviewing'),'No reviewer invocation was authorized');
  for(const start of events.filter(row=>row.phase==='start'))assert(events.some(row=>row.phase==='complete'&&row.operation_id===start.operation_id));
  assert(fs.readFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'utf8').includes('- [ ] T-001'));
});

test('failed checks project blocked and do not start later commands or independent review',t=>{
  const f=fixture(t),marker=path.join(f.root,'unexpected');
  const run=f.run([check('broken',"console.error('fixture assertion failed');process.exit(2)"),
    check('later',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong')`)]);
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout).result;
  assert.equal(result.code,'develop_checks_not_passed');assert.equal(result.pendingAction,'resume');
  assert.equal(f.status().state,'blocked');assert.equal(f.status().code,'develop_checks_not_passed');
  assert.equal(f.status().task,identity.taskId);assert.equal(fs.existsSync(marker),false);
  assert.match(run.stderr,/开始检查.*broken/);assert.match(run.stderr,/检查结束.*broken.*failed/);
  assert(!f.events().some(row=>row.event==='progress'&&row.phase_name==='reviewing'));
});

test('a quiet command announces its start before finishing and preserves the JSON result channel',async t=>{
  const f=fixture(t),plan=f.plan([check('quiet',"setTimeout(()=>process.exit(0),700)")]);
  const child=spawn(process.execPath,[driver,'--plan',plan,'advance'],{env:f.env,stdio:['ignore','pipe','pipe']});
  let out='',err='',seen=false,code;
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');});
  child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{
    err+=b;if(!seen&&/开始检查.*quiet/.test(err)){seen=true;assert.equal(child.exitCode,null);assert.equal(f.status().state,'checking');}
  });
  code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0,err);assert(seen,'a quiet check must be visible while it is running');
  assert.match(err,/检查结束.*quiet.*passed/);assert.equal(JSON.parse(out).result.state,'awaiting_review');
});

test('read-only status and foreign/invalid operations preserve existing projection bytes',async t=>{
  const f=fixture(t);let effects=0;
  const current={state:'awaiting_review',code:null,identity,packageDigest:'a'.repeat(64),calls:[]};
  const entry=createCmAiConversationEntry({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,
    runner:{status:()=>current,executeEffect:async()=>{effects++;return current;},cancel:()=>current,run:async()=>current}});
  const before=fs.readFileSync(f.statusPath);
  assert.equal((await entry.handle(control('status'))).state,'awaiting_review');
  assert.equal((await entry.handle(control('advance',{...identity,runId:'foreign-run'}))).outcome,'rejected');
  assert.equal((await entry.handle({...control('advance'),extra:true})).outcome,'rejected');
  assert.deepEqual(fs.readFileSync(f.statusPath),before);assert.equal(effects,0);
});

test('check phase is visible to a manual current-session bridge before it replies',async t=>{
  const f=fixture(t);let seen=false;
  const bridge={call:async kind=>{assert.equal(kind,'check');seen=true;assert.equal(f.status().task,'T-001');assert.equal(f.status().state,'checking');return [];} };
  const execution=createConversationExecution(f.definition,'progress-host',bridge,null,null,null,false,'codex');
  await execution.check({identity},{signal:new AbortController().signal});assert(seen);
});

test('status projection failures do not change a successful check or follow a target symlink',async t=>{
  const f=fixture(t),outside=path.join(f.root,'outside.json');fs.writeFileSync(outside,'KEEP');
  fs.unlinkSync(f.statusPath);fs.symlinkSync(outside,f.statusPath);
  let calls=0;const result=[{id:'check',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}];
  const execution=createConversationExecution(f.definition,'progress-host',{call:async()=>{calls++;return result;}},null,null,null,false,'codex');
  assert.deepEqual(await execution.check({identity},{signal:new AbortController().signal}),result);
  assert.equal(calls,1);assert.equal(fs.readFileSync(outside,'utf8'),'KEEP');assert(fs.lstatSync(f.statusPath).isSymbolicLink());
});

test('an already cancelled check cannot overwrite the existing projection',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.statusPath),controller=new AbortController();controller.abort();
  const execution=createConversationExecution(f.definition,'progress-host',{call:async()=>{throw Error('must not dispatch');}},null,null,null,false,'codex');
  await assert.rejects(async()=>execution.check({identity},{signal:controller.signal}),/cancelled/);
  assert.deepEqual(fs.readFileSync(f.statusPath),before);
});

test('protected checks announce quiet command boundaries through the same executor',{skip:spawnSync('codex',['--version']).status!==0},async t=>{
  const f=fixture(t),events=[],original=process.stderr.write;
  process.stderr.write=function(chunk,...args){
    if(String(chunk).includes('[check]'))events.push({text:String(chunk),status:f.status()});
    return original.call(this,chunk,...args);
  };
  t.after(()=>{process.stderr.write=original;});
  const execution=createConversationExecution(f.definition,'progress-protected-host',{
    call:async()=>{throw Error('protected checks must not use the external bridge');}},null,null,null,false,'codex',{
    protection:{checkCommands:[check('protected-quiet',"setTimeout(()=>process.exit(0),100)")],timeoutMs:15000}});
  const result=await execution.check({identity},{signal:new AbortController().signal});
  assert.equal(result[0].outcome,'passed',JSON.stringify(result));
  assert.equal(events.length,2);assert.match(events[0].text,/开始检查.*protected-quiet/);
  assert.equal(events[0].status.state,'checking');assert.match(events[1].text,/检查结束.*protected-quiet.*passed/);
});

test('check observers cannot change verdicts or prevent process cleanup',async t=>{
  const {createHostCheck}=await import('../runtime/js/cm-ai/host-check.mjs');
  const f=fixture(t),events=[];
  const run=createHostCheck({cwd:f.codeProject,commands:[check('bad',"process.exit(3)"),check('not-run',"process.exit(0)")],
    onProgress:event=>{events.push(event);throw Error('display unavailable');}});
  const result=await run({identity},{signal:new AbortController().signal});
  assert.equal(result.length,1);assert.equal(result[0].outcome,'failed');assert.equal(result[0].exitCode,3);
  assert.deepEqual(events.map(row=>[row.phase,row.id]),[['start','bad'],['complete','bad']]);
});

test('late QA completion cannot overwrite a newer task, including identical task numbers in another feature',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const {writeCmAiQaStatus}=await import('../runtime/js/cm-ai/cm-ai-run-finalizer.mjs');
  const f=fixture(t);
  writeCmAiQaStatus({specsDir:f.specsDir,feature:f.feature,identity,phase:'case_start',caseId:'TC-001'});
  const current={...identity,runId:'newer-progress-run'};
  writeStatusProjection({specsDir:f.specsDir,feature:'2.other',identity:current,node:'N3',state:'checking',detail:'new check',claim:true});
  const before=fs.readFileSync(f.statusPath);
  writeCmAiQaStatus({specsDir:f.specsDir,feature:f.feature,identity,phase:'complete',result:{result:'PASS',passed:1,failed:0,blocked:0}});
  assert.deepEqual(fs.readFileSync(f.statusPath),before);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.cm-run.json')),false,'projection must not move the run pointer');
});

test('stale phase token is refused even for the same task and run',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const f=fixture(t),base={specsDir:f.specsDir,feature:f.feature,identity,node:'N3',state:'checking',detail:'checking'};
  const old=writeStatusProjection({...base,claim:true});
  const current=writeStatusProjection({...base,node:'N4',state:'reviewing',detail:'reviewing',claim:true});
  assert.equal(writeStatusProjection({...base,state:'blocked',expectedToken:old.token}).written,false);
  assert.equal(f.status().progress_id,current.token);assert.equal(f.status().state,'reviewing');
});

test('two processes serialize a newer claim with an older completion under the existing log lock',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const f=fixture(t),base={feature:f.feature,identity,node:'N3',state:'checking',detail:'checking'};
  const old=writeStatusProjection({specsDir:f.specsDir,...base,claim:true});
  const next={...base,identity:{...identity,runId:'newer-progress-run',taskId:'T-002'},claim:true,expectedToken:null};
  const logPython=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
  const logNode=fileURLToPath(new URL('./cm-log-event.mjs',import.meta.url));
  const holder=spawn('python3',['-u','-c',
    `import importlib.util,os,sys,subprocess\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('lock_adapter',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.acquire_file_lock(Path(sys.argv[2])/'.cm-run.lock',private=False)\nprint('locked',flush=True)\nsys.stdin.readline()\nenv=os.environ.copy();env.update(CM_LOG_LOCK_ADAPTER='1',CM_LOG_LOCK_PARENT_PID=str(os.getpid()),CM_LOG_PROJECT_LOCK=str(Path(sys.argv[2])/'.cm-run.lock'))\nr=subprocess.run([sys.argv[3],sys.argv[4],'--status-only','--specs-dir',sys.argv[2],'--status-json',sys.argv[5]],env=env,check=True)\n`,
    logPython,f.specsDir,process.execPath,logNode,JSON.stringify(next)],{stdio:['pipe','pipe','pipe']});
  const children=[holder];t.after(()=>{for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');});
  const waitLine=(child,pattern)=>new Promise((resolve,reject)=>{
    let value='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture line timeout'));},10000);
    child.stdout.on('data',b=>{value+=b;if(pattern.test(value)){clearTimeout(timer);resolve();}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const exit=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const holderExit=exit(holder);await waitLine(holder,/locked/);
  const completion={...base,state:'blocked',claim:false,expectedToken:old.token,specsDir:f.specsDir};
  const moduleUrl=new URL('../runtime/js/cm-ai/status-projection.mjs',import.meta.url).href;
  const late=spawn(process.execPath,['--input-type=module','-e',
    `import {writeStatusProjection} from ${JSON.stringify(moduleUrl)};process.stdout.write('ready\\n');console.log(JSON.stringify(writeStatusProjection(${JSON.stringify(completion)})));`],{stdio:['ignore','pipe','pipe']});
  children.push(late);let lateOut='',errors='';late.stdout.on('data',b=>{lateOut+=b;});
  for(const c of children)c.stderr.on('data',b=>{errors+=b;});
  const lateExit=exit(late);await waitLine(late,/ready/);
  // The old completion has its previous token, but cannot validate-and-replace
  // while the newer claimant owns the lock. The claimant writes before release.
  holder.stdin.end('claim\n');
  assert.equal(await holderExit,0,errors);assert.equal(await lateExit,0,errors);
  assert.match(lateOut,/"written":false/);assert.equal(f.status().task,'T-002');
});

for(const verdict of ['approved','changes_requested'])test(`${verdict}: review projection waits for an observed provider thread`,t=>{
  const f=fixture(t),bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const observed=path.join(f.root,'observed-review.json');
  const source=fs.readFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),'utf8');
  const fake=source.replace("import {randomUUID} from 'node:crypto';","import {randomUUID} from 'node:crypto';\nimport fs from 'node:fs';")
    .replace('  for(const value of',`  const statusPath=${JSON.stringify(f.statusPath)};
  if(JSON.parse(fs.readFileSync(statusPath)).state!=='review_starting')throw Error('review started prematurely');
  for(const value of`)
    .replace("    process.stdout.write(JSON.stringify(value)+'\\n');",`    {
      process.stdout.write(JSON.stringify(value)+'\\n');
      if(value.type==='thread.started'){
        const deadline=Date.now()+5000;let status;
        do{
          await new Promise(resolve=>setTimeout(resolve,10));status=JSON.parse(fs.readFileSync(statusPath));
        }while(status.state!=='reviewing'&&Date.now()<deadline);
        if(status.state!=='reviewing')throw Error('observed review was not projected');
        fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(status));
      }
    }`);
  fs.writeFileSync(path.join(bin,'codex'),verdict==='approved'?fake:fake
    .replace("verdict:'approved'","verdict:'changes_requested'")
    .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise value',evidence:'Synthetic fixture finding'}]"),{mode:0o700});
  f.env.PATH=bin+path.delimiter+f.env.PATH;
  fs.writeFileSync(path.join(f.root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,
    cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  const first=f.run([check('ok','0')]);assert.equal(first.status,0,first.stderr);
  assert.equal(f.status().state,'awaiting_review');assert.equal(fs.existsSync(observed),false);
  const plan=f.plan(undefined,{mode:'resume',originalHostContext:'progress-fixture-host',answers:undefined,
    packageDigest:JSON.parse(first.stdout).result.packageDigest,
    permissions:['--review-config','review.json','--allow-review-attempt','1']});
  const run=spawnSync(process.execPath,[driver,'--plan',plan,'decision'],{env:f.env,encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.state,verdict,run.stdout+run.stderr);
  assert.equal(JSON.parse(fs.readFileSync(observed)).state,'reviewing');assert.equal(f.status().state,verdict);
  assert.equal(f.status().attempt,verdict==='approved'?1:2);
  assert(fs.readFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'utf8').includes('- [ ] T-001'));
  if(verdict==='approved'){
    const completed=f.run([check('ok','0')],{mode:'resume',originalHostContext:'progress-fixture-host'});
    assert.equal(completed.status,0,completed.stderr);
    assert.equal(JSON.parse(completed.stdout).result.state,'fixture_completed',completed.stdout+completed.stderr);
    assert.equal(f.status().state,'fixture_completed');assert.equal(f.status().node,'N5');
    assert.equal(f.status().code,'qa_decision_required');
  }
});

test('late N8 finalization records its own history but cannot claim another task status',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const {recordCmAiRunDone}=await import('../runtime/js/cm-ai/cm-ai-run-finalizer.mjs');
  const f=fixture(t);
  writeStatusProjection({specsDir:f.specsDir,feature:f.feature,identity:{...identity,runId:'newer-run',taskId:'T-002'},
    node:'N3',state:'checking',detail:'checking',claim:true});
  const before=fs.readFileSync(f.statusPath);
  const receipt=recordCmAiRunDone({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,
    packageDigest:'a'.repeat(64),contextDigest:'b'.repeat(64),documentationSyncId:'fixture-docs',logHome:path.join(f.root,'logs')});
  assert.equal(receipt.runId,identity.runId);assert.deepEqual(fs.readFileSync(f.statusPath),before);
  assert(f.events().some(row=>row.event==='run_done'&&row.run_id===identity.runId));
});

test('a cancelled in-flight control response cannot replace the final cancellation status',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const f=fixture(t);let finish;
  writeStatusProjection({specsDir:f.specsDir,feature:f.feature,identity,node:'N4',state:'reviewing',detail:'reviewing',claim:true});
  let current={state:'approved',code:null,identity,packageDigest:'a'.repeat(64),calls:[]};
  const entry=createCmAiConversationEntry({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,
    runner:{status:()=>current,executeEffect:()=>new Promise(resolve=>{finish=resolve;}),
      cancel:()=>{current={...current,state:'cancelled'};return current;},run:async()=>current}});
  const pending=entry.handle({...control('complete'),packageDigest:current.packageDigest});
  assert.equal(typeof finish,'function');
  const cancelled=await entry.handle(control('cancel'));assert.equal(cancelled.state,'cancelled');
  assert.equal(f.status().state,'cancelled');assert.equal(f.status().node,'N4');
  const before=fs.readFileSync(f.statusPath);
  finish({...current,state:'fixture_completed'});await pending;
  assert.deepEqual(fs.readFileSync(f.statusPath),before);
});

test('a repeated QA completion cannot replace the same run finalization',async t=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const {writeCmAiQaStatus}=await import('../runtime/js/cm-ai/cm-ai-run-finalizer.mjs');
  const f=fixture(t);
  writeStatusProjection({specsDir:f.specsDir,feature:f.feature,identity,node:'N8',state:'run_done',detail:'done',claim:true});
  const before=fs.readFileSync(f.statusPath);
  writeCmAiQaStatus({specsDir:f.specsDir,feature:f.feature,identity,phase:'complete',result:{result:'PASS',passed:1,failed:0,blocked:0}});
  assert.deepEqual(fs.readFileSync(f.statusPath),before);
});

test('N8 recovers a real status target failure without duplicating the durable completion',async t=>{
  const {recordCmAiRunDone}=await import('../runtime/js/cm-ai/cm-ai-run-finalizer.mjs');
  const f=fixture(t),input={specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,
    packageDigest:'a'.repeat(64),contextDigest:'b'.repeat(64),documentationSyncId:'fixture-docs',logHome:path.join(f.root,'logs')};
  fs.unlinkSync(f.statusPath);
  const original=childProcess.spawnSync;let injected=false;
  try{
    childProcess.spawnSync=(command,args,options)=>{
      const result=original(command,args,options);
      if(!injected&&args.includes('run_done')){injected=true;fs.mkdirSync(f.statusPath);}
      return result;
    };
    assert.throws(()=>recordCmAiRunDone(input),error=>error.code==='run_finalize_unknown');
  }finally{childProcess.spawnSync=original;if(injected)fs.rmdirSync(f.statusPath);}
  assert(injected);const receipt=recordCmAiRunDone(input);assert.equal(receipt.deduplicated,true);
  assert.equal(f.events().filter(row=>row.event==='run_done').length,1);assert.equal(f.status().state,'run_done');
});

test('status-only text in ordinary event data does not select the internal status command',t=>{
  const f=fixture(t),before=fs.readFileSync(f.statusPath);
  const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
  const run=spawnSync('python3',[writer,'--workflow','cm-ai','--event','progress','--runtime','codex',
    '--specs-dir',f.specsDir,'--project-root',f.codeProject,'--run-id',identity.runId,'--detail','--status-only'],
    {encoding:'utf8',env:f.env});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).pointer_written,true);
  assert.equal(f.events().at(-1).detail,'--status-only');assert.deepEqual(fs.readFileSync(f.statusPath),before);
});
