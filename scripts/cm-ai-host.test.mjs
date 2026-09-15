import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';

const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const identity={repositoryId:'host-fixture',runId:'host-fixture-run',taskId:'T-001',attempt:1};
const request=(operation,requestId=operation)=>({version:1,operation,requestId,identity});
function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-host-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work',config=path.join(root,'run.json');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope:['target.mjs'],requirements:['requirements.md']}));
  return {root,specsDir,codeProject,config,args:['serve','--config',config,'--mode','create','--host-context','native-host-fixture','--allow-development']};
}

function runCli(f,mode,action='create'){
  return new Promise((resolve,reject)=>{
    const args=[...f.args];args[4]=action;
    const child=spawn(process.execPath,[cli,...args],{stdio:['pipe','pipe','pipe'],env:f.env??process.env});
    let buffer='',stderr='',closed=false,sessionId;const rows=[],calls=[];
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('host fixture timed out'));},15000);
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    const response=(row,result)=>({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        if(!line)continue;
        try{
          const row=JSON.parse(line);rows.push(row);
          if(row.type==='host_ready')sessionId=row.sessionId;
          if(row.type==='host_request'){
            calls.push(row.kind);
            if(action!=='create')assert((mode==='authorized-review'&&['check','qa_assess','documentation_inspect'].includes(row.kind))
              ||(f.workflow&&row.kind==='documentation_inspect'),'resume must not resend development');
            if(mode==='disconnect'){child.stdin.end();continue;}
            if(mode==='cancel'){send(request('status'));send(request('cancel'));continue;}
            if(f.fix&&row.kind==='fix_learning'){
              send(response(row,{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'Synthetic no project lessons'}));
            }else if(f.fix&&row.kind==='fix_diagnose'){
              send(response(row,{status:'diagnosed',rootCause:'Wrong exported constant',affectedPaths:['target.mjs','README.md'],
                affectedModules:['value'],plan:'Set value and documentation to 43',crossLayer:false,
                investigation:{discardedAlternatives:[],boundaryAnalysis:null}}));
            }else if(f.fix&&row.kind==='fix_repair'){
              if(f.protected){
                assert.equal(row.payload.editMode,'protected-text-v1');
                send(response(row,{outcome:'repaired',edits:[
                  {path:'target.mjs',beforeSha256:row.payload.expected['target.mjs'],content:'export const value = 43;\n'},
                  {path:'README.md',beforeSha256:row.payload.expected['README.md'],content:'# Fixture value\n\nExports value = 43.\n'}]}));
                continue;
              }
              fs.writeFileSync(path.join(f.codeProject,'target.mjs'),'export const value = 43;\n');
              fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixture value\n\nExports value = 43.\n');
              send(response(row,{outcome:'repaired'}));
            }else if(f.fix&&row.kind==='fix_retrospective'){
              send(response(row,{status:'no_new_lesson',candidates:[],reason:null}));
            }else if(row.kind==='develop'){
              assert.equal(row.payload.request.provider,f.runtime??'codex');
              assert.equal(row.payload.route.runtime,f.runtime??'codex');
              assert.equal(row.payload.route.role,'coder');
              assert.equal(row.payload.route.route_state,'current-runtime');
              assert.equal(row.payload.codeProject,f.codeProject);
              assert.deepEqual(row.payload.request.payload.scope,f.workflow?['target.mjs','README.md']:['target.mjs']);
              // Wrong-session self-reported results must not settle the live call.
              send({...response(row,{status:'succeeded',value:{outcome:'implemented'}}),sessionId:'wrong-session'});
              fs.writeFileSync(path.join(f.codeProject,'target.mjs'),'export const value = 42;\n');
              send(response(row,{status:'succeeded',value:{outcome:'implemented',
                application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}}}));
            }else if(row.kind==='documentation_sync'){
              assert(f.workflow);assert.deepEqual(row.payload.paths,['README.md']);
              fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Verified fixture value\n\nExports value = 42.\n');
              send(response(row,{status:'completed'}));
            }else if(row.kind==='qa_assess'){
              assert(f.workflow);assert.equal(row.payload.pending,0);
              send(response(row,{scores:{scope:1,risk:1,accumulation:1,boundary:1},
                changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}}));
            }else if(row.kind==='documentation_inspect'){
              assert(f.workflow);assert(fs.readFileSync(path.join(f.codeProject,'README.md'),'utf8').includes(f.fix?'43':'42'));
              const {syncId,identity,packageDigest,contextDigest}=row.payload;
              send(response(row,{syncId,identity,packageDigest,contextDigest,status:'completed',reason:'Actual fixture README checked',
                at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')}));
            }else{
              assert.equal(row.kind,'check');
              assert.equal(row.payload.route.role,'tester');
              assert.equal(row.payload.route.route_state,'local-tool');
              const command=[process.execPath,'--check',path.join(f.codeProject,'target.mjs')];
              const checked=spawnSync(command[0],command.slice(1),{timeout:3000});assert.equal(checked.status,0);
              send(response(row,[{id:'syntax',command,outcome:'passed',exitCode:0,evidence:'Actual isolated node --check exited 0'}]));
            }
          }
          if(row.requestId==='advance'&&row.result&&!closed){
            closed=true;
            if(mode!=='disconnect'||action==='resume')send({type:'host_close',sessionId});
          }
        }catch(error){clearTimeout(timer);child.kill('SIGTERM');reject(error);return;}
      }
    });
    child.once('close',code=>{clearTimeout(timer);resolve({code,stderr,rows,calls});});
    send(request('advance'));
  });
}

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
    const expected=mode==='disconnect'?'unknown':'cancelled';
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.state,expected);
    if(mode==='cancel')assert(first.rows.some(row=>row.requestId==='status'));
    const resumed=await runCli(f,mode,'resume');assert.equal(resumed.code,0,resumed.stderr);assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,expected);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const mode of ['normal','disconnect','cancel'])test(`Claude conversation uses original runner development and recovery: ${mode}`,async()=>{
  const f=fixture();f.runtime='claude';f.args.push('--runtime','claude');
  try{
    const first=await runCli(f,mode);assert.equal(first.code,0,first.stderr);
    const state=mode==='normal'?'awaiting_review':mode==='disconnect'?'unknown':'cancelled';
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.state,state);
    assert.deepEqual(first.calls,mode==='normal'?['develop','check']:['develop']);
    const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(logs.filter(row=>row.phase==='route').every(row=>row.runtime==='claude'));
    const reopened=await runCli(f,mode,'resume');assert.equal(reopened.code,0,reopened.stderr);
    assert.deepEqual(reopened.calls,[]);
    assert.equal(reopened.rows.find(row=>row.requestId==='advance').result.state,state);
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

for(const variant of ['codex','claude','protected'])test(`automatic fix ${variant} CLI starts before QA and finishes through original transport`,async()=>{
  const runtime=variant==='protected'?'codex':variant;
  const f=fixture();f.workflow=true;f.fix=true;f.runtime=runtime;
  try{
    f.protected=variant==='protected';
    const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));definition.scope.push('README.md');
    if(f.protected){const nested=path.join(f.codeProject,'specs');fs.renameSync(f.specsDir,nested);f.specsDir=nested;definition.specsDir=nested;}
    fs.writeFileSync(f.config,JSON.stringify(definition));
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{auto_fix:'auto',delivery:'diff'}}));
    fs.writeFileSync(path.join(f.codeProject,'red.mjs'),"import {value} from './target.mjs';if(value!==43){console.error('BUG');process.exit(1)}");
    fs.writeFileSync(path.join(f.codeProject,'baseline.mjs'),"import {value} from './target.mjs';if(typeof value!=='number')process.exit(1)");
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,runtime);fs.copyFileSync(fileURLToPath(new URL(`./fixtures/${runtime}-review-process.mjs`,import.meta.url)),fake);fs.chmodSync(fake,0o700);
    if(f.protected){
      const located=spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'});assert.equal(located.status,0);
      const real=located.stdout.trim(),reviewFixture=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
      fs.writeFileSync(fake,String.raw`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');
const args=process.argv.slice(2),real=${JSON.stringify(real)};
if(args[0]==='sandbox'){const r=cp.spawnSync(real,args,{stdio:'inherit'});process.exit(r.status??1);}
let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
  if(!input.includes('<cm-developer-data-json>')){
    const r=cp.spawnSync(process.execPath,[${JSON.stringify(reviewFixture)},...args],{input,encoding:'utf8'});
    process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
  }
  const profile=[];for(let i=0;i<args.length;i++)if(args[i]==='-c'&&/^(default_permissions=|permissions.cm-specs=)/.test(args[i+1]))profile.push(args[i],args[i+1]);
  a.equal(profile.length,4);
  const code="const fs=require('node:fs');fs.writeFileSync('target.mjs','export const value = 42;\\n');fs.writeFileSync('README.md','# Before fix\\n');";
  const r=cp.spawnSync(real,['sandbox','-P','cm-specs','--include-managed-config','-C',process.cwd(),...profile,'--',process.execPath,'-e',code],{encoding:'utf8'});
  if(r.status!==0){process.stderr.write(r.stderr??'');process.exit(1);}
  for(const row of [{type:'thread.started',thread_id:'synthetic-protected-developer'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}})}},{type:'turn.completed'}])process.stdout.write(JSON.stringify(row)+'\n');
});
`,{mode:0o700});
      // Every original fix command also asserts actual native specs/instruction protection.
      const assertion="import fs from 'node:fs';import a from 'node:assert/strict';"
        +"for(const file of ['specs/1.work/tasks.md','AGENTS.md'])a.throws(()=>fs.writeFileSync(file,'forged'),e=>['EPERM','EACCES'].includes(e.code));\n";
      for(const name of ['red.mjs','baseline.mjs'])fs.writeFileSync(path.join(f.codeProject,name),assertion+fs.readFileSync(path.join(f.codeProject,name),'utf8'));
    }
    f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_LOG_HOME:path.join(f.root,'private-logs')};
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',runtime],
      {encoding:'utf8',env:f.env,timeout:5000});
    assert.equal(preview.status,0,preview.stderr);
    const review=JSON.parse(preview.stdout),reviewFile=path.join(f.root,'review.json');
    fs.writeFileSync(reviewFile,JSON.stringify(review));
    const command=[process.execPath,'red.mjs'];
    const workflowFile=path.join(f.root,'workflow.json');
    fs.writeFileSync(workflowFile,JSON.stringify({documentationPaths:['README.md'],applicableAgentFiles:[],
      qa:{commands:[{id:'value-check',command,caseIds:[]}],environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
    const permissions=['red-test','baseline','repair','regression','final-review','walkthrough','finish'];
    const reviewHost=createFixReviewHost({codeProject:f.codeProject,hostContextId:'native-host-fixture',runtime,review,
      permissions:permissions.map(name=>`--allow-${name}`)});
    const configuration={hostContextId:'native-host-fixture',...(runtime==='claude'?{runtime}:{}),defect:'Exported value must be 43',
      ...(f.protected?{protectSpecs:true}:{}),
      causeReview:reviewHost.reviewer,reproduction:{cwd:f.codeProject,command,expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd:f.codeProject,testFiles:['red.mjs'],command,expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      baseline:{cwd:f.codeProject,testFiles:['baseline.mjs'],commands:[{id:'baseline',command:[process.execPath,'baseline.mjs']}],timeoutMs:2000},
      repair:{scope:['target.mjs','README.md'],requirements:['requirements.md']},
      walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read exported value'],expected:['43'],kind:'commands',command}]}};
    const template=path.join(f.root,'template.json');fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration}));
    f.args.push('--runtime',runtime,'--review-config',reviewFile,'--allow-review-attempt','1','--workflow-config',workflowFile,'--allow-qa',
      '--qa-fix-template-config',template,'--qa-fix-review-config',reviewFile,'--allow-qa-fix-start','--auto-qa-fix',
      ...permissions.map(name=>`--allow-qa-fix-${name}`));
    if(f.protected){
      const protectedFile=path.join(f.root,'protected.json');
      fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
      f.args.push('--protected-config',protectedFile,'--allow-provider-development-attempt','1');
      fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration:{...configuration,protectSpecs:false}}));
      const denied=await runCli(f,'normal');assert.equal(denied.code,1);assert(denied.stderr.includes('protected_fix_required'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration}));
    }
    assert.equal(fs.existsSync(path.join(f.specsDir,'运行日志.jsonl')),false);
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'run_done',JSON.stringify(first.rows.at(-1)));
    for(const kind of [...(f.protected?[]:['develop']),'fix_diagnose','fix_repair','fix_retrospective'])assert.equal(first.calls.filter(item=>item===kind).length,1,kind);
    if(f.protected)assert(!first.calls.some(kind=>['develop','check','documentation_sync'].includes(kind)));
    assert(first.calls.includes('fix_learning')); // Original owner refreshes Learning before multiple stages.
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,'run_done');
    assert.deepEqual(resumed.calls,['documentation_inspect']);
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.workflow==='cm-ai'&&row.event==='test_run'&&row.phase==='start').length,2);
    assert.equal(rows.filter(row=>row.workflow==='cm-ai'&&row.event==='run_done').length,1);
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const runtime of ['codex','claude'])for(const workflow of [false,true])test(`configured ${runtime} CLI waits for the authorized attempt and resumes via the original review worker/gate workflow=${workflow}`,async()=>{
  const f=fixture();
  try{
    f.workflow=workflow;
    if(runtime==='claude'){f.runtime=runtime;f.args.push('--runtime',runtime);}
    if(workflow){
      const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));definition.scope.push('README.md');
      fs.writeFileSync(f.config,JSON.stringify(definition));
    }
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,runtime);fs.copyFileSync(fileURLToPath(new URL(`./fixtures/${runtime}-review-process.mjs`,import.meta.url)),fake);
    fs.chmodSync(fake,0o700);f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH};
    // Actual separate CLI and loopback diagnostic process; the executable is synthetic.
    let review;
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture',
      ...(runtime==='claude'?['--runtime','claude']:[])],
      {encoding:'utf8',env:f.env,timeout:5000});
    assert.equal(preview.status,0,preview.stderr);
    review=JSON.parse(preview.stdout);assert.equal(review.preflight.passed,true);
    if(runtime==='codex')assert.equal(review.preflight.real_model_requests,0);
    else assert.equal(review.preflight.isolation,'macos-loopback-sandbox');
    assert.equal(review.preflight.listener_closed,true);
    const config=path.join(f.root,'review.json');fs.writeFileSync(config,JSON.stringify(review));
    f.args.push('--review-config',config);
    if(runtime==='claude'){
      fs.writeFileSync(config,JSON.stringify({...review,preflight:{...review.preflight,provider:'codex'}}));
      const denied=spawnSync(process.execPath,[cli,...f.args,'--allow-review-attempt','1'],{encoding:'utf8',env:f.env,timeout:3000});
      assert.equal(denied.status,1);assert(denied.stderr.includes('tool_preflight_missing'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
      fs.writeFileSync(config,JSON.stringify(review));
    }
    if(workflow){
      const workflowFile=path.join(f.root,'workflow.json');
      fs.writeFileSync(workflowFile,JSON.stringify({documentationPaths:['README.md'],applicableAgentFiles:[],
        qa:{commands:[{id:'value-check',command:[process.execPath,'-e',"import('./target.mjs').then(m=>{if(m.value!==42)process.exit(1)})"],caseIds:[]}],
          environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
      f.args.push('--workflow-config',workflowFile);
      const denied=spawnSync(process.execPath,[cli,...f.args],{encoding:'utf8',env:f.env,timeout:5000});
      assert.equal(denied.status,1);assert(denied.stderr.includes('qa_authorization_required'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
      f.args.push('--allow-qa');
    }
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[ ] T-001'));
    // An approved different round cannot authorize this pending round.
    f.args.push('--allow-review-attempt','2');
    const wrong=await runCli(f,'normal','resume');assert.equal(wrong.code,0,wrong.stderr);
    assert.deepEqual(wrong.calls,[]);assert.equal(wrong.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    f.args[f.args.length-1]='1';
    const completed=await runCli(f,'authorized-review','resume');assert.equal(completed.code,0,completed.stderr);
    assert.deepEqual(completed.calls,workflow?['check','qa_assess','documentation_inspect']:['check']);
    const result=completed.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,workflow?'run_done':'fixture_completed');assert.equal(result.code,workflow?'run_done':'qa_decision_required');
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
    const reopened=await runCli(f,'normal','resume');assert.equal(reopened.code,0,reopened.stderr);
    assert.deepEqual(reopened.calls,workflow?['documentation_inspect']:[]);
    assert.equal(reopened.rows.find(row=>row.requestId==='advance').result.code,workflow?'run_done':'qa_decision_required');
    if(workflow){
      const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.event==='run_done').length,1);
      assert.equal(rows.filter(row=>row.event==='test_run'&&row.phase==='start').length,1);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
