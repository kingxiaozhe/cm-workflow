import {buildManifest} from './cm-spec-manifest.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {createConversationExecution,main as hostMain} from './cm-ai-host.mjs';
import {readRunDefinition,openControlRun} from './cm-ai-run.mjs';
import {fixtureProcesses} from './fixtures/process-cleanup.mjs';
import {cli,identity,request,fixture,launchArgs,runCli,protectedResultFixture,implementedValue,lastCheckpoint,installTimeoutReviewer} from './cm-ai-host-fixture.mjs';

test('single host input limit parsing and transport pass-through need no running host',async()=>{
  const {serveHostTransport}=await import('./cm-ai-host.mjs');
  assert.equal(typeof serveHostTransport,'function');
  const seen=[];
  for(const raw of [undefined,'65536','1048576','4194304']){
    await serveHostTransport({host:{}},raw,async options=>{seen.push(options.inputLimit);});
  }
  assert.deepEqual(seen,[65536,65536,1048576,4194304]);
  for(const raw of ['65535','4194305','1.5','NaN']){
    await assert.rejects(serveHostTransport({host:{}},raw,async()=>{}),/invalid_arguments/);
  }
});
test('single host help documents input limit',()=>{
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--input-limit BYTES/);
});
test('single host CLI rejects out-of-range and non-integer input limits before opening a run',()=>{
  for(const raw of ['65535','4194305','1.5']){
    const run=spawnSync(process.execPath,[cli,'serve','--config','unused','--mode','create',
      '--host-context','fixture','--allow-development','--input-limit',raw],{encoding:'utf8'});
    assert.equal(run.status,1);assert.match(run.stderr,/invalid_arguments/);
  }
});
test('killing a real host at develop request leaves the original effect intent for recovery',async()=>{
  const f=fixture();
  try{
    let buffer='',sawDevelop=false,stderr='';
    const child=spawn(process.execPath,[cli,...launchArgs(f)],{stdio:['pipe','pipe','pipe'],env:process.env});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('host kill fixture timed out: '+stderr));},10000);
      child.stdout.on('data',chunk=>{
        buffer+=chunk;
        let newline;
        while((newline=buffer.indexOf('\n'))!==-1){
          const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
          if(!line)continue;
          const row=JSON.parse(line);
          if(row.type==='host_ready')child.stdin.write(JSON.stringify(request('advance'))+'\n');
          if(row.type==='host_request'&&row.kind==='develop'){sawDevelop=true;child.kill('SIGKILL');}
        }
      });
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    const exited=await done;
    assert.equal(sawDevelop,true,stderr);assert.equal(exited.signal,'SIGKILL');
    const state=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json'),'utf8'));
    assert(state.records.some(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='develop'));
    assert.equal(state.records.some(row=>row.payload.type==='effect-checkpoint'),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('resume accepts a changed transport input limit without changing the durable fingerprint',async()=>{
  const f=fixture(),bridge=createHostToolBridge();
  try{
    const definition=readRunDefinition(f.config);
    const execution=createConversationExecution(definition,'native-host-fixture',bridge,null,null,null,false,'codex');
    const first=await openControlRun(definition,'create',execution);first.close();
    const state=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
    const before=JSON.parse(fs.readFileSync(state,'utf8')).fingerprints;
    let limit;
    const {serveHostTransport}=await import('./cm-ai-host.mjs');
    await serveHostTransport({host:{}},'65536',async options=>{limit=options.inputLimit;});
    assert.equal(limit,65536);
    const resumed=await openControlRun(definition,'resume',execution);resumed.close();
    const otherSession=createConversationExecution(definition,'other-host-fixture',bridge,null,null,null,false,'codex');
    await assert.rejects(openControlRun(definition,'resume',otherSession),{code:'fingerprint_mismatch'});
    await serveHostTransport({host:{}},'1048576',async options=>{limit=options.inputLimit;});
    assert.equal(limit,1048576);
    assert.deepEqual(JSON.parse(fs.readFileSync(state,'utf8')).fingerprints,before);
  }finally{bridge.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('D1 SIGKILL at a real host develop request leaves an intent without checkpoint',async()=>{
  const f=fixture();
  try{
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[cli,...launchArgs(f)],{stdio:['pipe','pipe','pipe']});
      let buffer='',asked=false;
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('host request timeout'));},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.stdout.on('data',chunk=>{
        buffer+=chunk;
        for(let newline;(newline=buffer.indexOf('\n'))!==-1;){
          const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
          if(!line)continue;
          const row=JSON.parse(line);
          if(row.type==='host_ready')child.stdin.write(JSON.stringify(request('advance'))+'\n');
          if(row.type==='host_request'&&row.kind==='develop'){asked=true;child.kill('SIGKILL');}
        }
      });
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,asked});});
    });
    assert.equal(result.signal,'SIGKILL');assert.equal(result.asked,true);
    const state=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
    const records=JSON.parse(fs.readFileSync(state,'utf8')).records;
    assert.equal(records.at(-1).payload.type,'effect-intent');
    assert.equal(records.some(row=>row.payload.type==='effect-checkpoint'),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('split-root SwiftUI Claude control run creates a baseline beside Git-ignored Xcode and SwiftPM output',async()=>{
  const f=fixture(),bridge=createHostToolBridge();
  try{
    const specs5=path.join(f.root,'specs5'),app=path.join(f.root,'app');
    fs.renameSync(f.specsDir,specs5);fs.renameSync(f.codeProject,app);
    fs.mkdirSync(path.join(app,'Sources'));fs.writeFileSync(path.join(app,'Sources','App.swift'),'import SwiftUI\n');
    fs.writeFileSync(path.join(app,'.gitignore'),'custom-cache/\n');
    assert.equal(spawnSync('git',['init','-q',app]).status,0);
    fs.mkdirSync(path.join(app,'.build'));fs.symlinkSync('missing',path.join(app,'.build','workspace-state'));
    fs.mkdirSync(path.join(app,'custom-cache'));fs.symlinkSync('missing',path.join(app,'custom-cache','linked'));
    fs.mkdirSync(path.join(app,'DerivedData','Build'),{recursive:true});
    for(let i=0;i<10005;i++)fs.writeFileSync(path.join(app,'DerivedData','Build',String(i)),'');
    fs.mkdirSync(path.join(app,'App.xcodeproj','xcuserdata'),{recursive:true});
    fs.writeFileSync(path.join(app,'App.xcodeproj','xcuserdata','UserInterfaceState.xcuserstate'),'bplist00');
    fs.writeFileSync(path.join(app,'.DS_Store'),'finder');
    const run=JSON.parse(fs.readFileSync(f.config,'utf8'));
    fs.writeFileSync(f.config,JSON.stringify({...run,specsDir:specs5,codeProject:app,scope:['Sources/App.swift']}));
    const definition=readRunDefinition(f.config);
    const execution=createConversationExecution(definition,'native-host-fixture',bridge,null,null,null,false,'claude');
    const opened=await openControlRun(definition,'create',execution);
    try{
      const baseline=opened.runner?.baseline??JSON.parse(fs.readFileSync(path.join(specs5,'.reviews','.execution',identity.runId,'state.json'),'utf8')).records[0].payload.baseline;
      assert(baseline.files.some(file=>file.path==='Sources/App.swift'));
      assert(!baseline.files.some(file=>/\.build|DerivedData|xcuserdata|custom-cache|DS_Store/.test(file.path)));
    }finally{opened.close();}
  }finally{bridge.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('host create reports the offending unsupported file on stderr before transport starts',async()=>{
  const f=fixture(),lines=[];
  try{
    fs.symlinkSync('missing',path.join(f.codeProject,'alien.swift'));
    const exit=await hostMain(launchArgs(f),{input:{},output:{write(){}},error:{write(value){lines.push(value);}}});
    assert.equal(exit,1);
    assert.match(lines.join(''),/\[host\] unsupported_file: alien\.swift/);
    assert.match(lines.join(''),/"reason":"unsupported_file: alien\.swift"/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('host create refuses a scope with AGENTS.md and lists the protected paths before any journal exists',async()=>{
  const f=fixture(),lines=[],output=[];
  try{
    const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));
    fs.writeFileSync(f.config,JSON.stringify({...definition,scope:['target.mjs','AGENTS.md','.claude/rules/security.md']}));
    fs.writeFileSync(path.join(f.codeProject,'AGENTS.md'),'# rules\n');
    const exit=await hostMain(launchArgs(f),{input:{},output:{write(value){output.push(value);}},error:{write(value){lines.push(value);}}});
    assert.equal(exit,1);assert.deepEqual(output,[]);
    const error=JSON.parse(lines.join('').trim().split('\n').at(-1)).error;
    assert.equal(error.code,'protected_scope');
    assert.match(error.reason,/AGENTS\.md、\.claude\/rules\/security\.md/);
    assert.doesNotMatch(error.reason,/target\.mjs/);
    // No init, no intent, no execution directory, no review record of any kind.
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


test('current conversation CLI performs real file/check work and stops at the original unauthorised review gate',async()=>{
  const f=fixture();
  try{
    const denied=spawnSync(process.execPath,[cli,...f.args.slice(0,-1)],{encoding:'utf8',timeout:3000});
    assert.equal(denied.status,1);assert(denied.stderr.includes('host_launch_authorization_required'));
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.deepEqual(first.calls,['develop','check']);
    const roleEvents=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.event==='decision'&&row.phase==='route');
    assert.deepEqual(roleEvents.map(row=>row.role),['coder','tester']);
    assert(roleEvents.every(row=>!Object.hasOwn(row,'effective_model')&&row.task==='T-001'));
    const result=first.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,'awaiting_review');assert.equal(result.code,'decision_required');
    assert(first.rows.some(row=>row.type==='host_response'&&row.accepted===false));
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[ ] T-001'));
    const handoff=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','work-T-001-a1-handoff.json'),'utf8'));
    assert.equal(handoff.status,'ready_for_review');assert(handoff.changed_files.includes('target.mjs'));
    const second=await runCli(f,'normal','resume');assert.equal(second.code,0,second.stderr);
    assert.deepEqual(second.calls,[]);assert.equal(second.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    const resumedRoles=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.event==='decision'&&row.phase==='route');
    assert.deepEqual(resumedRoles,roleEvents);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('invalid role configuration blocks CLI before any current-conversation tool request',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),'{invalid-config');
    const result=await runCli(f,'normal');
    assert.deepEqual(result.calls,[]);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
    assert(!fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x]'));
    const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8');
    assert(logs.includes('invalid_workflow_config'));assert(!logs.includes('invalid-config'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const mode of ['disconnect','cancel'])test(`current conversation ${mode} preserves the original recovery boundary`,async()=>{
  const f=fixture();
  try{
    const first=await runCli(f,mode);assert.equal(first.code,0,first.stderr);
    assert.deepEqual(first.calls,['develop']);
    // A disconnected session may still be writing: the run waits for the
    // operator's develop_redo (answer gaps P1-2) and advance dispatches nothing.
    const expected=mode==='disconnect'?['blocked','develop_answer_missing','develop_redo']:['cancelled'];
    const outcome=row=>mode==='disconnect'?[row.result.state,row.result.code,row.result.pendingAction]:[row.result.state];
    assert.deepEqual(outcome(first.rows.find(row=>row.requestId==='advance')),expected);
    if(mode==='cancel')assert(first.rows.some(row=>row.requestId==='status'));
    const resumed=await runCli(f,mode,'resume');assert.equal(resumed.code,0,resumed.stderr);assert.deepEqual(resumed.calls,[]);
    assert.deepEqual(outcome(resumed.rows.find(row=>row.requestId==='advance')),expected);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const mode of ['normal','disconnect','cancel'])test(`Claude conversation uses original runner development and recovery: ${mode}`,async()=>{
  const f=fixture();f.runtime='claude';f.args.push('--runtime','claude');
  try{
    const first=await runCli(f,mode);assert.equal(first.code,0,first.stderr);
    const state=mode==='normal'?'awaiting_review':mode==='disconnect'?'blocked':'cancelled';
    const advanced=first.rows.find(row=>row.requestId==='advance').result;
    assert.equal(advanced.state,state);
    if(mode==='disconnect')assert.deepEqual([advanced.code,advanced.pendingAction],['develop_answer_missing','develop_redo']);
    assert.deepEqual(first.calls,mode==='normal'?['develop','check']:['develop']);
    const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(logs.filter(row=>row.phase==='route').every(row=>row.runtime==='claude'));
    const reopened=await runCli(f,mode,'resume');assert.equal(reopened.code,0,reopened.stderr);
    // Resume plus advance never redispatches before develop_redo.
    assert.deepEqual(reopened.calls,[]);
    const reopenedAdvance=reopened.rows.find(row=>row.requestId==='advance').result;
    assert.equal(reopenedAdvance.state,state);
    if(mode==='disconnect')assert.deepEqual([reopenedAdvance.code,reopenedAdvance.pendingAction],['develop_answer_missing','develop_redo']);
    f.args=f.args.slice(0,-2);
    const wrongRuntime=await runCli(f,mode,'resume');
    assert.equal(wrongRuntime.code,1);assert.deepEqual(wrongRuntime.calls,[]);
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[ ] T-001'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('Claude Review option rejects before store instead of borrowing the Codex reviewer',()=>{
  const f=fixture();
  try{
    const result=spawnSync(process.execPath,[cli,...f.args,'--runtime','claude','--allow-review-attempt','1'],{encoding:'utf8',timeout:3000});
    assert.equal(result.status,1);assert(result.stderr.includes('review_configuration_required'));
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('unconfigured Claude preserves P4a persisted reviewer metadata and denies direct dispatch',()=>{
  const f=fixture(),bridge=createHostToolBridge();
  try {
    const execution=createConversationExecution(JSON.parse(fs.readFileSync(f.config,'utf8')),
      'native-host-fixture',bridge,null,null,null,false,'claude');
    const {run,...persisted}=execution.reviewers[0];
    assert.deepEqual(persisted,{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',
      requestedModel:'unconfigured',allowed:true,available:true,
      contexts:['cm-conversation-review-1','cm-conversation-review-2']});
    assert.throws(()=>run({},{}),{code:'review_configuration_required'});
  } finally {bridge.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('bridge cancellation before publication cannot dispatch a late host request',async()=>{
  const bridge=createHostToolBridge(),controller=new AbortController(),sent=[];
  bridge.attach(value=>{sent.push(value);});
  const pending=bridge.call('develop',{fixture:true},controller.signal);controller.abort();
  await assert.rejects(pending,{code:'cancelled'});await Promise.resolve();
  assert(!sent.some(row=>row.type==='host_request'));bridge.close();
});


// Regression (2026-09-28): a host stopped by the fixture watchdog while its
// detached fake reviewer hung left that reviewer running for 17+ hours.
test('fixture watchdog stopping a host mid-review leaves no process from the fixture root',async()=>{
  const f=protectedResultFixture();
  try{
    f.runtime='claude';f.args.push('--runtime','claude');
    const setMode=installTimeoutReviewer(f,'claude');
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime','claude'],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    // Keep the 15-minute reviewer budget: only the watchdog can end this review.
    const review=JSON.parse(preview.stdout);assert.equal(review.timeoutMs,900000);
    const config=path.join(f.root,'review.json');fs.writeFileSync(config,JSON.stringify(review));
    f.args.push('--review-config',config,'--allow-review-attempt','1');
    f.develop=payload=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]});
    setMode('timeout');
    const hung=path.join(f.root,'review-mode.json.hung');
    // Fire as soon as the reviewer hangs, but never later than the usual
    // fixture deadline: a host stalled before review is a bounded failure.
    f.watchdog=expire=>{
      const poll=setInterval(()=>{if(fs.existsSync(hung)&&fs.readFileSync(hung,'utf8')){clearInterval(poll);expire();}},25);
      const limit=setTimeout(expire,Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000));
      return ()=>{clearInterval(poll);clearTimeout(limit);};
    };
    await assert.rejects(runCli(f,'normal'),/host fixture timed out/);
    assert(fs.existsSync(hung),'the host was stopped by the outer deadline before its reviewer hung');
    const reviewer=Number(fs.readFileSync(hung,'utf8'));assert(Number.isSafeInteger(reviewer)&&reviewer>1);
    const gone=()=>{try{process.kill(reviewer,0);return false;}catch(error){return error.code==='ESRCH';}};
    for(const deadline=Date.now()+3000;!gone()&&Date.now()<deadline;)await new Promise(resolve=>setTimeout(resolve,25));
    assert(gone(),`hung fake reviewer ${reviewer} survived the watchdog`);
    assert.deepEqual(fixtureProcesses(f.root),[]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('new host refuses unapproved manifest bytes before any developer call',async()=>{
  const f=fixture();
  try{
    fs.appendFileSync(path.join(f.specsDir,'1.work','design.md'),'changed interface');
    const result=await runCli(f,'normal');
    assert.deepEqual(result.calls,[]);
    assert.match(JSON.stringify(result.rows)+result.stderr,/spec_drift/);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('host develops from specification with no code requirements and replays identical material',async()=>{
  const f=fixture();
  try{
    const definition=JSON.parse(fs.readFileSync(f.config));definition.requirements=[];
    fs.writeFileSync(f.config,JSON.stringify(definition));
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.state,'awaiting_review');
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('protected proposal cannot write after specification drifts during developer call; blocked history resumes',async()=>{
  const f=protectedResultFixture(),target=path.join(f.codeProject,'target.mjs');
  try{
    f.develop=()=>{
      fs.appendFileSync(path.join(f.specsDir,'1.work','design.md'),'changed while provider was running');
      return {status:'succeeded',value:implementedValue(),edits:[{path:'target.mjs',beforeSha256:null,content:'export const value = 42;\n'}]};
    };
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    const result=first.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,'blocked',JSON.stringify(result));assert.equal(result.code,'spec_drift');assert(!fs.existsSync(target));
    assert.equal(lastCheckpoint(f).code,'spec_drift');
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,[]);assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,'spec_drift');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const flag of ['--rerun-unknown-qa','--rerun-blocked-qa'])test(`${flag} requires resume and separate QA permission before opening the owner`,()=>{
  const f=fixture();
  try{
    const workflow=path.join(f.root,'workflow.json');
    fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],qa:{commands:[],
      environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
    for(const mode of ['create','resume']){
      const args=[...f.args];args[4]=mode;
      const result=spawnSync(process.execPath,[cli,...args,'--workflow-config',workflow,flag,
        ...(mode==='create'?['--allow-qa']:[])],{encoding:'utf8',timeout:3000});
      assert.equal(result.status,1);assert.match(result.stderr,/qa_recovery_authorization_required/);
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('step31 CLI resumes completed evidence BLOCKED QA and reaches the original finalizer',async()=>{
  const f=fixture();f.workflow=true;
  try{
    const definition=JSON.parse(fs.readFileSync(f.config));definition.scope.push('README.md');
    fs.writeFileSync(f.config,JSON.stringify(definition));
    fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixture value 42\n');
    fs.writeFileSync(path.join(f.specsDir,'1.work','requirements.md'),'- [AC-001]: fixture\n');
    fs.writeFileSync(path.join(f.specsDir,'1.work','test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
      cases:[{id:'TC-001',kind:'browser',blocking:true,origin:'user',acIds:['AC-001'],taskIds:['T-001'],
        title:'Synthetic browser',preconditions:[],steps:['Observe fixture'],expected:['Fixture works'],cleanup:[]}]}));
    fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,'codex');fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);fs.chmodSync(fake,0o700);
    f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH};
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture'],{encoding:'utf8',env:f.env,timeout:5000});
    assert.equal(preview.status,0,preview.stderr);
    const review=path.join(f.root,'review.json');fs.writeFileSync(review,preview.stdout);
    const workflow=path.join(f.root,'workflow.json');
    fs.writeFileSync(workflow,JSON.stringify({documentationPaths:['README.md'],applicableAgentFiles:[],qa:{
      commands:[{id:'value-check',command:[process.execPath,'-e',"import('./target.mjs').then(m=>{if(m.value!==42)process.exit(1)})"],caseIds:[]}],
      environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
    f.args.push('--review-config',review,'--allow-review-attempt','1','--workflow-config',workflow,'--allow-qa','--browser-qa','available');
    let corrected=false;
    f.qaBrowser=payload=>{
      const file=path.join(f.specsDir,'.reviews','browser-evidence.txt');fs.writeFileSync(file,'Synthetic observed browser evidence');
      return {verdict:'PASS',evidence:corrected?[file]:[file,'docs/browser-qa.md（T-001）'],environment:payload.environment,cleanup:'completed'};
    };
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'qa_result_blocked');
    const tasks=fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'));
    const checkpoint=fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json'));
    const status=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.cm-status.json')));assert.equal(status.state,'qa_blocked');
    corrected=true;
    const without=await runCli(f,'normal','resume');assert.equal(without.code,0,without.stderr);assert.deepEqual(without.calls,[]);
    const unchanged=without.rows.find(row=>row.requestId==='advance').result;
    assert.equal(unchanged.pendingAction,'none');assert.equal(unchanged.code,'qa_result_blocked');
    f.args.push('--rerun-blocked-qa');
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,['qa_browser','documentation_inspect']);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,'run_done');
    f.args.pop();
    const again=await runCli(f,'normal','resume');assert.equal(again.code,0,again.stderr);
    assert.deepEqual(again.calls,['documentation_inspect']);
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const qa=rows.filter(row=>row.event==='test_run');
    const starts=qa.filter(row=>row.phase==='start');assert.deepEqual(starts.map(row=>row.attempt),[1,2]);
    assert.equal(starts[1].previous_test_run_id,starts[0].operation_id);
    const superseded=qa.find(row=>row.phase==='superseded');assert.deepEqual(superseded.blocked_cases,['TC-001']);
    assert.equal(superseded.reason,'host_evidence_problem');
    assert.deepEqual(qa.filter(row=>row.phase==='complete').map(row=>row.result),['BLOCKED','PASS']);
    assert.equal(rows.filter(row=>row.event==='qa').length,1);
    assert.deepEqual(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md')),tasks);
    assert.deepEqual(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')),checkpoint);
    if(process.env.CM_STEP31_REPRO==='1'){
      console.log('STEP31 without flag',JSON.stringify(unchanged));
      console.log('STEP31 initial status mirror',JSON.stringify(status));
      for(const row of qa.filter(row=>['start','superseded','complete'].includes(row.phase)))console.log(JSON.stringify(row));
      console.log('STEP31 resumed',JSON.stringify(resumed.rows.find(row=>row.requestId==='advance').result));
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('F7 CLI explicitly revises missing QA commands after N5 and resumes the same run',async()=>{
  const f=fixture();
  try{
    f.workflow=true;
    const definition=JSON.parse(fs.readFileSync(f.config));definition.scope.push('README.md');
    fs.writeFileSync(f.config,JSON.stringify(definition));
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,'codex');fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);
    fs.chmodSync(fake,0o700);f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH};
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture'],
      {encoding:'utf8',env:f.env,timeout:15000});assert.equal(preview.status,0,preview.stderr);
    const review=path.join(f.root,'review.json');fs.writeFileSync(review,preview.stdout);
    const oldWorkflow={documentationPaths:['README.md'],applicableAgentFiles:[],qa:{commands:[],
      environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}}};
    const oldFile=path.join(f.root,'workflow-old.json'),file=path.join(f.root,'workflow.json');
    fs.writeFileSync(oldFile,JSON.stringify(oldWorkflow));fs.writeFileSync(file,JSON.stringify(oldWorkflow));
    f.args.push('--review-config',review,'--allow-review-attempt','1','--workflow-config',file,'--allow-qa');
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'qa_result_blocked');
    const stateFile=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
    const before=JSON.parse(fs.readFileSync(stateFile));
    fs.writeFileSync(file,JSON.stringify({...oldWorkflow,qa:{...oldWorkflow.qa,
      commands:[{id:'syntax',command:[process.execPath,'--check','target.mjs'],caseIds:[]}]}}));
    const denied=await runCli(f,'normal','resume');assert.equal(denied.code,1);assert.match(denied.stderr,/fingerprint_mismatch/);
    f.args.push('--revise-qa-config',oldFile,'--qa-config-revision-reason','Correct missing QA command');
    const resumed=await runCli(f,'authorized-review','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,'run_done');
    assert.deepEqual(resumed.calls,['documentation_inspect']);
    const after=JSON.parse(fs.readFileSync(stateFile));assert.deepEqual(after.records.slice(0,before.records.length),before.records);
    assert.equal(after.records.filter(row=>row.payload.type==='qa-config-revised').length,1);
    f.args.splice(-4);
    const again=await runCli(f,'normal','resume');assert.equal(again.code,0,again.stderr);
    assert.equal(again.rows.find(row=>row.requestId==='advance').result.code,'run_done');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),after);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Protected current-session driver answers (#10, #11, #31). These reach the real
// Codex sandbox that applies protected edits, so they live in this excluded file.
const protectedDriver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
function protectedDriveFixture({scope,files={},checkCommands=[{id:'noop',command:['/usr/bin/true']}]}){
  const f=fixture(),definition=JSON.parse(fs.readFileSync(f.config,'utf8'));
  definition.scope=scope;fs.writeFileSync(f.config,JSON.stringify(definition));
  for(const [file,content] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(f.codeProject,file)),{recursive:true});
    fs.writeFileSync(path.join(f.codeProject,file),content);fs.chmodSync(path.join(f.codeProject,file),0o644);
  }
  const answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands,timeoutMs:120000}));
  f.content=(name,bytes)=>fs.writeFileSync(path.join(answers,name),bytes);
  f.developAnswer=edits=>fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',
    value:implementedValue(),edits}));
  f.drive=(permissions=[],umask='022')=>{
    const plan=path.join(f.root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'create',hostContext:'native-host-fixture',
      permissions:['--protected-conversation-config','protection.json','--review-config',f.reviewFile,...permissions],answers:'answers'}));
    return spawnSync('/bin/sh',['-c',`umask ${umask}; exec "$0" "$@"`,process.execPath,protectedDriver,'--plan',plan,'advance'],
      {encoding:'utf8',timeout:120000,
        env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
  };
  return f;
}
const lastPackageChanges=f=>new Map(lastCheckpoint(f).reviewPackage.changes.map(change=>[change.path,change]));
test('#10 the driver carries a protected develop reply above 64 KiB once --input-limit is raised',()=>{
  const f=protectedDriveFixture({scope:['App.xcodeproj/project.pbxproj']});
  try{
    const content='// !$*UTF8*$!\n'+'\t\tA1D0000000000000000001 /* x */ = {isa = PBXBuildFile; };\n'.repeat(1500);
    f.content('pbxproj.txt',content);f.developAnswer({'App.xcodeproj/project.pbxproj':'pbxproj.txt'});
    const run=f.drive(['--input-limit','1048576']);
    assert.equal(run.signal,null,'driver waited on a rejected reply');assert.equal(run.status,0,run.stderr);
    assert.equal(JSON.parse(run.stdout).result.state,'awaiting_review',run.stdout);
    assert.equal(fs.readFileSync(path.join(f.codeProject,'App.xcodeproj','project.pbxproj'),'utf8'),content);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('#11 #31 protected driver deletes, sets the executable bit, creates new files 0644 and keeps BOM/CRLF text exact',()=>{
  const f=protectedDriveFixture({scope:['scripts/test.sh','old/Legacy.swift','new/Legacy.swift','App/Home.swift'],
    files:{'scripts/test.sh':'#!/bin/sh\necho TEST SUCCEEDED\n','old/Legacy.swift':'// legacy\n'},
    checkCommands:[{id:'test',command:['./scripts/test.sh']}]});
  try{
    const home=Buffer.from('﻿import SwiftUI\r\nstruct Home {}\r\n','utf8');
    f.content('legacy.swift','// legacy\n');f.content('home.swift',home);
    f.developAnswer({'scripts/test.sh':{mode:'0755'},'old/Legacy.swift':{delete:true},
      'new/Legacy.swift':'legacy.swift','App/Home.swift':'home.swift'});
    const run=f.drive([],'077');
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.state,'awaiting_review',run.stdout);
    assert.equal(fs.statSync(path.join(f.codeProject,'scripts/test.sh')).mode&0o777,0o755);
    assert.equal(fs.existsSync(path.join(f.codeProject,'old/Legacy.swift')),false);
    assert.equal(fs.statSync(path.join(f.codeProject,'new/Legacy.swift')).mode&0o777,0o644);
    assert.equal(fs.statSync(path.join(f.codeProject,'App/Home.swift')).mode&0o777,0o644);
    assert.deepEqual(fs.readFileSync(path.join(f.codeProject,'App/Home.swift')),home);
    const changes=lastPackageChanges(f);
    assert.equal(changes.get('scripts/test.sh').before.mode,0o644);assert.equal(changes.get('scripts/test.sh').after.mode,0o755);
    assert.equal(changes.get('old/Legacy.swift').after,null);
    assert.equal(changes.get('new/Legacy.swift').after.mode,0o644);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Explicit batch choice (2026-10-06 AI潮 6.api-native-reading before 5.author-column).
const withEarlierPendingFeature=f=>{
  const early=path.join(f.specsDir,'0.early');fs.mkdirSync(early);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(early,name),'# Early\n');
  fs.writeFileSync(path.join(early,'tasks.md'),'- [ ] T-001: earlier batch, after this one\n');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['0.early','1.work'],specFiles:buildManifest(f.specsDir)}));
};
const serveOnce=(f,extra,mode='create')=>{
  const args=[...launchArgs(f)];args[4]=mode;
  const out=spawnSync(process.execPath,[cli,...args,...extra],{encoding:'utf8',timeout:20000,
    input:[request('status')].map(JSON.stringify).join('\n')+'\n'});
  return {...out,rows:out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};
};
test('host --feature creates a later approved feature run; without it the original task_selection_mismatch stays',()=>{
  const f=fixture();
  try{
    withEarlierPendingFeature(f);
    const refused=serveOnce(f,[]);
    assert.equal(refused.status,1);assert.match(refused.stderr,/task_selection_mismatch/);assert.match(refused.stderr,/--feature 1\.work/);
    const wrong=serveOnce(f,['--feature','0.early']);
    assert.equal(wrong.status,1);assert.match(wrong.stderr,/invalid_arguments/);
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution',identity.runId)),false);
    const created=serveOnce(f,['--feature','1.work']);
    assert.equal(created.status,0,created.stderr);
    assert.equal(created.rows[0].type,'host_ready');
    assert.equal(created.rows.find(row=>row.requestId==='status').result.identity.taskId,'T-001');
    const resumed=serveOnce(f,['--feature','1.work'],'resume');
    assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.rows[0].type,'host_ready');
    // The choice is bound into the run: resuming without it is a different run.
    const unbound=serveOnce(f,[],'resume');
    assert.equal(unbound.status,1);assert.match(unbound.stderr,/fingerprint_mismatch/);
    assert.match(fs.readFileSync(path.join(f.specsDir,'0.early','tasks.md'),'utf8'),/- \[ \] T-001/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Kept from the 0.16.6 project patch: runs T-001..T-003 of that batch were
// created with --runtime codex --review-runtime claude and resume only with it.
const crossToolRoles='version: 1\nruntimes: {available: both}\nroles:\n  coder: {adapter: codex-cli, source: subscription}\n  reviewer: {adapter: claude-cli, source: subscription}\n';
test('--review-runtime binds the other tool as reviewer and must be repeated on resume',async()=>{
  const f=fixture(),bridge=createHostToolBridge();
  try{
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),crossToolRoles);
    const definition=readRunDefinition(f.config);
    const {claudeReviewFingerprint}=await import('../runtime/js/cm-ai/worker-claude.mjs');
    const model='fixture';const review={model,disabledSkills:[],preflight:{passed:true,provider:'claude',
      config_fingerprint:claudeReviewFingerprint({cwd:f.codeProject,model}),prompt_transport:'stdin'}};
    const make=options=>createConversationExecution(definition,'native-host-fixture',bridge,review,null,null,false,'codex',options);
    const original=make({reviewRuntime:'claude'});
    assert.equal(original.developer.provider,'codex');assert.equal(original.reviewers[0].provider,'claude');
    assert.equal(original.configuration.reviewRuntime,'claude');
    const first=await openControlRun(definition,'create',original);first.close();
    const resumed=await openControlRun(definition,'resume',make({reviewRuntime:'claude'}));resumed.close();
    await assert.rejects(openControlRun(definition,'resume',make({})),{code:'fingerprint_mismatch'});
    assert.throws(()=>make({reviewRuntime:'codex'}),{code:'runtime_selection_mismatch'});
    assert.throws(()=>make({reviewRuntime:'other'}),{code:'invalid_runtime'});
    assert.throws(()=>createConversationExecution(definition,'native-host-fixture',bridge,{...review,preflight:{}},1,null,false,'codex',{reviewRuntime:'claude'}),{code:'tool_preflight_missing'});
  }finally{bridge.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('ordinary CLI accepts --review-runtime claude under a Codex host and refuses an invalid runtime before any journal',()=>{
  for(const reviewRuntime of ['claude','other']){
    const f=fixture();
    try{
      fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),crossToolRoles);
      const out=serveOnce(f,['--runtime','codex','--review-runtime',reviewRuntime]);
      if(reviewRuntime==='claude'){assert.equal(out.status,0,out.stderr);assert.equal(out.rows[0].type,'host_ready');}
      else{assert.equal(out.status,1);assert.match(out.stderr,/invalid_runtime/);
        assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution',identity.runId)),false);}
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});
