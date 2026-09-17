import {buildManifest} from './cm-spec-manifest.mjs';
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
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
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
            if(row.kind==='develop'){
              const material=row.payload.request.payload.specification;
              assert.equal(material.task.id,'T-001');assert.equal(material.task.description,'fixture');
              assert.deepEqual(material.sources,buildManifest(f.specsDir));
              assert.equal(material.designExcerpt,fs.readFileSync(path.join(f.specsDir,'1.work','design.md'),'utf8'));
              assert.deepEqual(row.payload.request.payload.scope,JSON.parse(fs.readFileSync(f.config)).scope);
            }
            if(action!=='create')assert((f.develop&&row.kind==='develop')||(mode==='authorized-review'&&['check','qa_assess','documentation_inspect'].includes(row.kind))
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
            }else if(row.kind==='develop'&&f.develop){
              send(response(row,f.develop(row.payload)));
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
    send(f.request??request('advance'));
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
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,...(f.protected?{runtimes:{available:'codex'}}:{}),policies:{auto_fix:'auto',delivery:'diff'}}));
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

for(const runtime of ['codex','claude'])for(const initialWorkflow of ['absent','qa-null','qa'])test(`configured ${runtime} CLI waits for the authorized attempt and resumes via the original review worker/gate workflow=${initialWorkflow}`,async()=>{
  const workflow=initialWorkflow==='qa';
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
    if(!workflow)fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixture value 42\n');
    const attachmentFile=path.join(f.root,'attachment.json');
    const attachmentConfig={documentationPaths:[],applicableAgentFiles:[],
      qa:{commands:[{id:'syntax',command:[process.execPath,'--check','target.mjs'],caseIds:[]}],
        environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}};
    if(initialWorkflow==='qa-null'){
      fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
      f.args.push('--workflow-config',attachmentFile);
    }
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    const initialArgs=[...f.args];
    const attemptAttachment=()=>{
      fs.writeFileSync(attachmentFile,JSON.stringify(attachmentConfig));
      if(initialWorkflow==='absent')f.args.push('--workflow-config',attachmentFile);
      f.args.push('--allow-qa');
    };
    if(!workflow){
      attemptAttachment();
      const early=await runCli(f,'normal','resume');
      assert.equal(early.code,1);assert.match(early.stderr,/qa_attach_not_completed/);assert.deepEqual(early.calls,[]);
      f.args=[...initialArgs];
      if(initialWorkflow==='qa-null')fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
    }

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
    if(!workflow){
      const stateFile=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
      const before=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      attemptAttachment();
      // Explicit QA permission is still required, even though task work is done.
      f.args.pop();
      const denied=await runCli(f,'normal','resume');assert.equal(denied.code,1);
      assert.match(denied.stderr,/qa_authorization_required/);assert.deepEqual(denied.calls,[]);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),before);
      f.args.push('--allow-qa');
      // No hidden host-context or definition changes can ride the attachment.
      const originalHost=f.args[6];f.args[6]='different-host';
      const changedHost=await runCli(f,'normal','resume');assert.equal(changedHost.code,1);
      assert.match(changedHost.stderr,/fingerprint_mismatch/);f.args[6]=originalHost;
      const originalDefinition=fs.readFileSync(f.config,'utf8');
      for(const field of ['scope','requirements']){
        const changed=JSON.parse(originalDefinition);changed[field].push('extra.md');
        fs.writeFileSync(f.config,JSON.stringify(changed));
        const rejected=await runCli(f,'normal','resume');assert.equal(rejected.code,1);
        assert.match(rejected.stderr,/fingerprint_mismatch/);fs.writeFileSync(f.config,originalDefinition);
      }
      f.workflow=true;
      const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
      const {digest}=await import('../runtime/js/cm-ai/effect-contract.mjs');
      const history=readRunnerHistory(before.records,before.records[0].payload.config,3);
      f.request={...request('qa','advance'),packageDigest:history.state.reviewPackage.packageDigest};
      const attached=await runCli(f,'authorized-review','resume');assert.equal(attached.code,0,attached.stderr);
      assert.deepEqual(attached.calls,['qa_assess']);
      assert.equal(attached.rows.find(row=>row.requestId==='advance').result.code,'qa_triggered');
      delete f.request;
      // A killed no-result N6 run needs a fresh, explicit resume permission.
      // The option is transport authority, never part of the stored fingerprint.
      const {recordCmAiQaRun}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
      recordCmAiQaRun({specsDir:f.specsDir,codeProject:f.codeProject,feature:'1.work',identity,
        packageDigest:history.state.reviewPackage.packageDigest,testRunId:'interrupted-qa',mode:'commands',caseCount:1,
        phase:'start',logHome:path.join(f.root,'logs')});
      const unknown=await runCli(f,'normal','resume');assert.equal(unknown.code,0,unknown.stderr);
      assert.equal(unknown.rows.find(row=>row.requestId==='advance').result.code,'qa_execution_unknown');
      assert.deepEqual(unknown.calls,[]);
      f.args.push('--rerun-unknown-qa');
      const finished=await runCli(f,'normal','resume');assert.equal(finished.code,0,finished.stderr);
      f.args.pop();
      assert.deepEqual(finished.calls,['documentation_inspect']);
      assert.equal(finished.rows.find(row=>row.requestId==='advance').result.state,'run_done');
      const qaRows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
        .filter(row=>row.event==='test_run');
      assert.deepEqual(qaRows.filter(row=>row.phase==='start').map(row=>row.attempt),[1,1]);
      assert.equal(qaRows.filter(row=>row.phase==='abandoned').length,1);
      const after=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      assert.deepEqual(after.fingerprints,before.fingerprints);
      assert.deepEqual(after.records.slice(0,before.records.length),before.records);
      const records=after.records.filter(row=>row.payload.type==='qa-attached');assert.equal(records.length,1);
      assert.deepEqual(Object.keys(records[0].payload.record).sort(),['attachedAt','hostContextId','qaFingerprint','version']);
      assert.equal(records[0].payload.record.hostContextId,'native-host-fixture');
      // Replay rejects a duplicate even with a correctly recalculated hash chain.
      const last=records[0],body={...last,seq:after.records.length+1,
        id:`runner.${String(after.records.length+1).padStart(6,'0')}`,previousDigest:after.records.at(-1).digest};
      delete body.digest;
      assert.throws(()=>readRunnerHistory([...after.records,{...body,digest:digest(body)}],
        after.records[0].payload.config,3),{code:'qa_attachment_duplicate'});
      assert.equal(readRunnerHistory(after.records,after.records[0].payload.config,3).state.state,'fixture_completed');
      // Crash prefix: attachment durable, audit row absent. Resume repairs it.
      const log=path.join(f.specsDir,'运行日志.jsonl');
      fs.writeFileSync(log,fs.readFileSync(log,'utf8').trim().split('\n')
        .filter(line=>JSON.parse(line).phase!=='qa_attach').join('\n')+'\n');
      const again=await runCli(f,'normal','resume');assert.equal(again.code,0,again.stderr);
      assert.deepEqual(again.calls,['documentation_inspect']);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),after);
      const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const attachLogs=logs.filter(row=>row.event==='decision'&&row.phase==='qa_attach');assert.equal(attachLogs.length,1);
      assert.equal(attachLogs[0].qaFingerprint,records[0].payload.record.qaFingerprint);
      assert.equal(logs.filter(row=>row.event==='test_run'&&row.phase==='start').length,2);
      // Removing QA after it was bound cannot fall back to the original config.
      const attachedArgs=[...f.args];f.args=[...initialArgs];
      if(initialWorkflow==='qa-null')fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
      const removed=await runCli(f,'normal','resume');assert.equal(removed.code,1);assert.match(removed.stderr,/fingerprint_mismatch/);
      f.args=attachedArgs;
      fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:{...attachmentConfig.qa,
        commands:[{id:'different',command:[process.execPath,'--version'],caseIds:[]}]}}));
      const changed=await runCli(f,'normal','resume');assert.equal(changed.code,1);assert.match(changed.stderr,/fingerprint_mismatch/);
      assert.deepEqual(changed.calls,[]);assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),after);
    }
    if(workflow){
      const file=f.args[f.args.indexOf('--workflow-config')+1];
      const config=JSON.parse(fs.readFileSync(file,'utf8'));config.qa.commands[0].id='different';
      fs.writeFileSync(file,JSON.stringify(config));
      const changed=await runCli(f,'normal','resume');assert.equal(changed.code,1);assert.match(changed.stderr,/fingerprint_mismatch/);
      const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.event==='run_done').length,1);
      assert.equal(rows.filter(row=>row.event==='test_run'&&row.phase==='start').length,1);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Real local child processes with synthetic provider output. Only `codex sandbox`
// delegates to the installed CLI; no real model is ever requested.
function installDispatchFakes(f){
  const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const located=spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'});assert.equal(located.status,0);
  for(const provider of ['codex','claude']){
    const reviewFixture=fileURLToPath(new URL(`./fixtures/${provider}-review-process.mjs`,import.meta.url));
    fs.writeFileSync(path.join(bin,provider),String.raw`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');
const provider=${JSON.stringify(provider)},args=process.argv.slice(2),real=${JSON.stringify(located.stdout.trim())};
if(args[0]==='sandbox'){const r=cp.spawnSync(real,args,{stdio:'inherit'});process.exit(r.status??1);}
let prompt='';process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
  if(!prompt.includes('<cm-developer-data-json>')){
    if(prompt.includes('<cm-review-data-json>')){
      const material=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]).reviewPackage.specification;
      a.equal(material.feature,'1.work');a.equal(material.task.id,'T-001');a.equal(material.sources.length,3);
    }
    const r=cp.spawnSync(process.execPath,[${JSON.stringify(reviewFixture)},...args],{input:prompt,encoding:'utf8'});
    process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
  }
  const material=JSON.parse(prompt.split('<cm-developer-data-json>\n')[1].split('\n')[0]).specification;
  a.equal(material.feature,'1.work');a.equal(material.task.description,'fixture');a.equal(material.sources.length,3);
  const content='export const value = 42;\n';
  const value={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
  let events;
  if(provider==='codex'){
    const profile=[];for(let i=0;i<args.length;i++)if(args[i]==='-c'&&/^(default_permissions=|permissions.cm-specs=)/.test(args[i+1]))profile.push(args[i],args[i+1]);
    a.equal(profile.length,4);
    const r=cp.spawnSync(real,['sandbox','-P','cm-specs','--include-managed-config','-C',process.cwd(),...profile,'--',process.execPath,'-e',"require('node:fs').writeFileSync('target.mjs',"+JSON.stringify(content)+")"],{encoding:'utf8'});
    if(r.status!==0){process.stderr.write(r.stderr??'');process.exit(1);}
    events=[{type:'thread.started',thread_id:'synthetic-coder-codex'},{type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}];
  }else{
    a.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');a.equal(args[args.indexOf('--allowedTools')+1],'Read,Grep,Glob');
    a.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');a(args.includes('--no-session-persistence'));
    a(args.includes('--json-schema'));const schema=JSON.parse(args[args.indexOf('--json-schema')+1]);
    a.equal(Object.hasOwn(schema,'$schema'),false);a.equal(Object.hasOwn(schema,'$id'),false);
    a.deepEqual(schema.properties.status.enum,['succeeded','failed']);
    a(prompt.includes('Protected current-host mode: do not write files'));
    a.equal(fs.existsSync('target.mjs'),false);
    const expected=JSON.parse(prompt.trim().split('\n').at(-1)).expected;
    const proposal={status:'succeeded',value,edits:[{path:'target.mjs',beforeSha256:expected['target.mjs'],content}]};
    const session_id='synthetic-coder-claude';
    events=[{type:'system',subtype:'init',session_id},{type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'proposal'}]}},
      {type:'result',session_id,subtype:'success',is_error:false,num_turns:1,result:'',structured_output:proposal}];
  }
  for(const event of events)process.stdout.write(JSON.stringify(event)+'\n');
});
`,{mode:0o700});
  }
  f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')};
}
for(const [available,coder,reviewer,runtime] of [
  ['codex','codex','codex','codex'],['codex','codex','codex','claude'],['claude','claude','claude','codex'],
  ['both','codex','claude','claude'],['both','claude','codex','codex'],
])test(`protected dispatch ${available}: ${runtime} host -> ${coder} coder -> ${reviewer} reviewer`,async()=>{
  const f=fixture();
  try{
    installDispatchFakes(f);
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available},
      roles:{coder:{adapter:`${coder}-cli`},reviewer:{adapter:`${reviewer}-cli`}}}));
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',reviewer],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const reviewFile=path.join(f.root,'review.json'),protectedFile=path.join(f.root,'protected.json');
    fs.writeFileSync(reviewFile,preview.stdout);
    fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,
      checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
    f.args.push('--runtime',runtime,'--review-config',reviewFile,'--protected-config',protectedFile);
    const denied=await runCli(f,'normal');assert.equal(denied.code,1);assert.match(denied.stderr,/provider_development_authorization_required/);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    f.args.push('--allow-provider-development-attempt','1');
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'decision_required');assert.deepEqual(first.calls,[]);
    assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
    const readRoutes=()=>fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.phase==='route'&&row.event==='decision');
    assert.equal(readRoutes().filter(row=>row.role==='coder'&&row.route_state===(coder===runtime?'current-runtime':'cli-dispatch')).length,1);
    assert.equal(readRoutes().filter(row=>row.role==='reviewer').length,0);
    f.args.push('--allow-review-attempt','2');
    const wrong=await runCli(f,'normal','resume');assert.equal(wrong.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    assert.equal(readRoutes().filter(row=>row.role==='reviewer').length,0);
    f.args[f.args.length-1]='1';
    const reviewed=await runCli(f,'normal','resume');assert.equal(reviewed.code,0,reviewed.stderr);
    assert.equal(reviewed.rows.find(row=>row.requestId==='advance').result.state,'fixture_completed',JSON.stringify(reviewed.rows));
    const route=readRoutes().find(row=>row.role==='reviewer');assert(route);
    assert.equal(route.adapter,`${reviewer}-cli`);assert.equal(route.route_state,reviewer===runtime?'current-runtime':'cli-dispatch');
    const receipt=fs.readFileSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md'),'utf8');
    assert.match(receipt,new RegExp(`reviewer: ${reviewer}-cli`));assert.match(receipt,/independent: true/);
    const gate=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-task-gate.mjs',import.meta.url)),'check-n4',
      '--handoff',path.join(f.specsDir,'.reviews','work-T-001-a1-handoff.json'),
      '--reviews-dir',path.join(f.specsDir,'.reviews'),'--feature','work','--task','T-001','--project-root',f.codeProject],{encoding:'utf8'});
    assert.equal(gate.status,0,gate.stderr);assert.equal(JSON.parse(gate.stdout).content_bound,true);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const available of ['unknown','codex'])test(`legacy protected ${available} run resumes with its original fingerprint and contexts`,async()=>{
  const f=fixture();
  try{
    installDispatchFakes(f);
    const projectConfig=path.join(f.codeProject,'.cm-workflow.json');
    const declaration={version:1,...(available==='codex'?{runtimes:{available}}:{})};
    fs.writeFileSync(projectConfig,JSON.stringify(declaration));
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture'],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const reviewFile=path.join(f.root,'review.json'),protectedFile=path.join(f.root,'protected.json');
    fs.writeFileSync(reviewFile,preview.stdout);
    fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,
      checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
    // The original unmodified createCodexExecution constructs a genuine old run;
    // no hand-written fingerprints, journals or approval receipts.
    const initializer=path.join(f.root,'old-host.mjs');
    fs.writeFileSync(initializer,`
import fs from 'node:fs';
import {readRunDefinition,createCodexExecution,openControlRun} from ${JSON.stringify(new URL('./cm-ai-run.mjs',import.meta.url).href)};
import {createHostReviewAuthority} from ${JSON.stringify(new URL('../runtime/js/cm-ai/host-review-authority.mjs',import.meta.url).href)};
const definition=readRunDefinition(${JSON.stringify(f.config)}),review=JSON.parse(fs.readFileSync(${JSON.stringify(reviewFile)}));
const config=JSON.parse(fs.readFileSync(${JSON.stringify(protectedFile)}));
const authority=createHostReviewAuthority({hostContextId:'native-host-fixture',reviewerId:'reviewer',adapterId:'codex-review-adapter',decide:async()=>null});
const execution=await createCodexExecution({codeProject:definition.codeProject,specsRoot:definition.specsDir,
 developerModel:config.model,checkCommands:config.checkCommands,timeoutMs:config.timeoutMs,
 hostContextId:'native-host-fixture',developerContextId:'cm-protected-author',reviewerModel:review.model,
 reviewerPreflight:review.preflight,disabledSkills:review.disabledSkills},
 {hostDecision:null,developmentAttempt:1,hostDecisionProvider:authority.hostDecisionProvider,authorizeReview:authority.authorize,
 authorizeDevelopment:()=>({status:'approved'})});
const run=await openControlRun(definition,'create',execution);
try{console.log(JSON.stringify(await run.host.handle(${JSON.stringify(request('advance'))})));}finally{run.close();}
`);
    const old=spawnSync(process.execPath,[initializer],{encoding:'utf8',env:f.env,timeout:10000});
    assert.equal(old.status,0,old.stderr);assert.equal(JSON.parse(old.stdout).code,'decision_required');
    f.args.push('--protected-config',protectedFile,'--allow-provider-development-attempt','1','--review-config',reviewFile,'--allow-review-attempt','1');
    // A changed two-provider declaration cannot recover through Codex-only compatibility.
    fs.writeFileSync(projectConfig,JSON.stringify({version:1,runtimes:{available:'both'},
      roles:{coder:{adapter:'claude-cli'},reviewer:{adapter:'codex-cli'}}}));
    const mismatch=await runCli(f,'normal','resume');assert.equal(mismatch.code,1);assert.match(mismatch.stderr,/fingerprint_mismatch/);
    assert(!fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x]'));
    fs.writeFileSync(projectConfig,JSON.stringify(declaration));
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.match(resumed.stderr,/resumed original Codex protected execution after exact fingerprint validation/);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,'fixture_completed');
    assert.deepEqual(resumed.calls,[]);
    assert.match(fs.readFileSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md'),'utf8'),/reviewer: codex-cli/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

function protectedResultFixture(){
  const f=fixture(),definition=JSON.parse(fs.readFileSync(f.config));
  const nested=path.join(f.codeProject,'specs');fs.renameSync(f.specsDir,nested);
  f.specsDir=nested;definition.specsDir=nested;fs.writeFileSync(f.config,JSON.stringify(definition));
  const config=path.join(f.root,'conversation-protection.json');
  fs.writeFileSync(config,JSON.stringify({timeoutMs:5000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  f.args.push('--protected-conversation-config',config);
  f.env={...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')};
  return f;
}
const implementedValue=()=>({outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}});
const lastCheckpoint=f=>JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')))
  .records.filter(row=>row.payload.type==='effect-checkpoint').at(-1).payload.checkpoint;

test('protected local invalid_result writes nothing and corrected CLI resume keeps run and attempt',async()=>{
  const f=protectedResultFixture(),target=path.join(f.codeProject,'target.mjs');
  try{
    f.develop=payload=>{
      assert.equal(payload.editMode,'protected-text-v1');assert.equal(payload.expected['target.mjs'],null);
      return {status:'succeeded',value:{...implementedValue(),
        retrospective:{status:'no_new_lesson',candidates:[],reason:'No new lesson'}},
      edits:[{path:'target.mjs',beforeSha256:null,content:'export const value = 42;\n'}]};
    };
    for(const mode of ['create',...Array(6).fill('resume')]){
      const rejected=await runCli(f,'normal',mode);assert.equal(rejected.code,0,rejected.stderr);
      const result=rejected.rows.find(row=>row.requestId==='advance').result;
      assert.equal(result.state,'blocked');assert.equal(result.code,'developer_result_invalid');
      assert.equal(result.pendingAction,'resume');assert.deepEqual(result.identity,identity);
      assert(!fs.existsSync(target));
      const checkpoint=lastCheckpoint(f);assert.equal(checkpoint.calls.at(-1).terminal,'failed');
      assert.deepEqual(checkpoint.calls.at(-1).failureResult,{code:'invalid_result',reason:'invalid_input',retryable:true});
    }
    f.develop=payload=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]});
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    const result=resumed.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,'awaiting_review');assert.equal(result.code,'decision_required');
    assert.deepEqual(result.identity,identity);assert.equal(fs.readFileSync(target,'utf8'),'export const value = 42;\n');
    assert.deepEqual(lastCheckpoint(f).calls.map(call=>call.terminal),[...Array(7).fill('failed'),'succeeded']);
    const reopened=await runCli(f,'normal','resume');assert.equal(reopened.code,0,reopened.stderr);
    assert.deepEqual(reopened.calls,[]);assert.equal(reopened.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const matches of [true,false])test(`protected old proposal compares exact output with expected disk hashes: matches=${matches}`,async()=>{
  const f=protectedResultFixture(),target=path.join(f.codeProject,'target.mjs');
  try{
    // Simulate a proposal already applied before this invocation was rejected.
    const content='export const value = 42;\n';
    f.develop=()=>({status:'succeeded',value:{...implementedValue(),
      retrospective:{status:'no_new_lesson',candidates:[],reason:'invalid'}},edits:[]});
    const failed=await runCli(f,'normal');assert.equal(failed.code,0,failed.stderr);
    assert.equal(failed.rows.find(row=>row.requestId==='advance').result.code,'developer_result_invalid');
    fs.writeFileSync(target,matches?content:'export const value = 99;\n');
    const before=fs.readFileSync(target);
    f.develop=()=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:null,content}]});
    const run=await runCli(f,'normal','resume');assert.equal(run.code,0,run.stderr);
    const result=run.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,matches?'awaiting_review':'blocked');
    assert.equal(result.code,matches?'decision_required':'protected_edit_stale');
    assert.deepEqual(fs.readFileSync(target),before);
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,result.code);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const mode of ['blocked','disconnect'])test(`protected ${mode} cannot use the local invalid-result retry entry`,async()=>{
  const f=protectedResultFixture();
  try{
    f.develop=()=>({status:'succeeded',value:{...implementedValue(),outcome:'blocked'},edits:[]});
    const result=await runCli(f,mode==='disconnect'?'disconnect':'normal');assert.equal(result.code,0,result.stderr);
    const status=result.rows.find(row=>row.requestId==='advance').result;
    assert.equal(status.state,mode==='blocked'?'blocked':'unknown');
    assert.equal(status.code,mode==='blocked'?'failed':'unknown');
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,status.state);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const variant of ['delete-absent','missing-edits','extra-field'])test(`protected malformed proposal ${variant} fails before sandbox writes`,async()=>{
  const f=protectedResultFixture();
  try{
    f.develop=()=>({status:'succeeded',value:implementedValue(),
      ...(variant==='missing-edits'?{}:{edits:[{path:'target.mjs',beforeSha256:null,
        content:variant==='delete-absent'?null:'export const value = 42;\n'}]}),
      ...(variant==='extra-field'?{extra:true}:{})});
    const result=await runCli(f,'normal');assert.equal(result.code,0,result.stderr);
    const status=result.rows.find(row=>row.requestId==='advance').result;
    assert.equal(status.state,'blocked');assert.equal(status.code,'developer_result_invalid');
    assert.equal(lastCheckpoint(f).calls.at(-1).terminal,'failed');
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Step 21: exercise actual worker timers/cleanup and durable CLI restart, with
// synthetic providers only. The installed Codex is used solely for sandbox checks.
function installTimeoutReviewer(f,runtime){
  installDispatchFakes(f);
  const fake=path.join(f.root,'bin',runtime),delegate=fake+'-delegate';
  fs.renameSync(fake,delegate);
  const modeFile=path.join(f.root,'review-mode.json');
  fs.writeFileSync(modeFile,JSON.stringify('approved'));
  fs.writeFileSync(fake,String.raw`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');
const args=process.argv.slice(2),runtime=${JSON.stringify(runtime)},modeFile=${JSON.stringify(modeFile)};
if(args[0]==='sandbox'){const r=cp.spawnSync(${JSON.stringify(delegate)},args,{stdio:'inherit'});process.exit(r.status??1);}
let prompt='';process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
 const mode=JSON.parse(fs.readFileSync(modeFile));
 if(mode==='approved'||!prompt.includes('<cm-review-data-json>')){
  const r=cp.spawnSync(${JSON.stringify(delegate)},args,{input:prompt,encoding:'utf8'});
  process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
 }
 const thread=crypto.randomUUID(),send=e=>process.stdout.write(JSON.stringify(e)+'\n');
 if(runtime==='codex'){
  send({type:'thread.started',thread_id:thread});send({type:'turn.started'});
  if(mode==='result')send({type:'item.completed',item:{type:'agent_message',text:'{"verdict":"approved"}'}});
 }else{
  send({type:'system',subtype:'init',session_id:thread});
  if(mode==='result'){
   send({type:'assistant',session_id:thread,parent_tool_use_id:null,
    message:{role:'assistant',content:[{type:'text',text:'{"verdict":"approved"}'}]}});
   send({type:'result',subtype:'success',session_id:thread,is_error:false,num_turns:1,result:'{"verdict":"approved"}'});
  }
 }
 setInterval(()=>{},1000);
});
`,{mode:0o700});
  return mode=>fs.writeFileSync(modeFile,JSON.stringify(mode));
}
for(const [runtime,second] of [['codex','approved'],['claude','approved'],['codex','timeout'],['codex','result'],['claude','result']])
test(`protected conversation review timeout ${runtime} -> ${second}`,async()=>{
  const f=protectedResultFixture();
  try{
    f.runtime=runtime;f.args.push('--runtime',runtime);
    const setMode=installTimeoutReviewer(f,runtime);
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',runtime],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const config=path.join(f.root,'review.json');fs.writeFileSync(config,preview.stdout);
    f.args.push('--review-config',config,'--allow-review-attempt','1');
    f.develop=payload=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]});
    setMode(second==='result'?'result':'timeout');
    const start=Date.now(),first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    const result=first.rows.find(row=>row.requestId==='advance').result;
    // A 60s default would hit runCli's 15s watchdog instead of returning here.
    assert(Date.now()-start>=4900);assert(Date.now()-start<14000);
    assert.equal(result.state,second==='result'?'unknown':'pending_review');
    assert.equal(result.code,second==='result'?'transport_timeout':'review_transport_timeout');
    assert.equal(result.pendingAction,second==='result'?'reconcile':'resume');
    const before=lastCheckpoint(f),original=before.reviewInvocation;
    assert.equal(before.calls.at(-1).terminal,second==='result'?'unknown':'failed');
    assert.equal(original.result.outcome,'timed_out');
    assert.equal(original.result.reconciliationRequired,second==='result');
    assert.equal(original.result.inspection.code,'transport_timeout');
    assert.equal(original.result.observation.events.at(-1).event,'process_closed');
    assert.equal(original.result.observation.events.at(-1).timed_out,true);
    const snapshot=()=>JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')));
    const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
    const history=snapshot(),configuration=history.records[0].payload.config;
    assert.equal(readRunnerHistory(history.records,configuration,3).state.state,result.state);
    // Prefix recovery never redispatches an invocation whose checkpoint is absent.
    for(const type of ['review-invocation-registered','review-invocation-started','review-invocation-result']){
      const index=history.records.findIndex(row=>row.payload.type===type);
      const recovered=readRunnerHistory(history.records.slice(0,index+1),configuration,3);
      assert.equal(recovered.state.state,'unknown');assert.equal(recovered.state.code,'reconciliation_required');
    }
    setMode(second==='result'?'approved':second);
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    const end=resumed.rows.find(row=>row.requestId==='advance').result,after=lastCheckpoint(f);
    assert.deepEqual(end.identity,identity);assert.deepEqual(resumed.calls,[]);
    if(second==='result'){
      assert.equal(end.state,'unknown');assert.deepEqual(after,before);
    }else{
      assert.equal(end.state,second==='approved'?'fixture_completed':'blocked');
      assert.equal(end.code,second==='approved'?'qa_decision_required':'review_transport_timeout');
      assert.equal(after.cache.find(entry=>entry.effect.id==='review-1-retry-1').effect.identity.attempt,1);
      assert.notEqual(after.reviewInvocation.registration.grant.invocationId,original.registration.grant.invocationId);
      assert.notEqual(after.reviewInvocation.registration.grant.grantId,original.registration.grant.grantId);
      assert.notEqual(after.reviewInvocation.started,original.started);
      assert.deepEqual(after.calls.slice(0,before.calls.length),before.calls);
      assert.deepEqual(after.cache.slice(0,before.cache.length),before.cache);
      if(second==='timeout'){
        const blocked=await runCli(f,'normal','resume');assert.equal(blocked.code,0,blocked.stderr);
        assert.equal(blocked.rows.find(row=>row.requestId==='advance').result.state,'blocked');
        assert.deepEqual(lastCheckpoint(f),after);
      }else assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
    }
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

test('unknown QA rerun requires resume and separate QA permission before opening the owner',()=>{
  const f=fixture();
  try{
    const workflow=path.join(f.root,'workflow.json');
    fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],qa:{commands:[],
      environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
    for(const mode of ['create','resume']){
      const args=[...f.args];args[4]=mode;
      const result=spawnSync(process.execPath,[cli,...args,'--workflow-config',workflow,'--rerun-unknown-qa',
        ...(mode==='create'?['--allow-qa']:[])],{encoding:'utf8',timeout:3000});
      assert.equal(result.status,1);assert.match(result.stderr,/qa_recovery_authorization_required/);
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
