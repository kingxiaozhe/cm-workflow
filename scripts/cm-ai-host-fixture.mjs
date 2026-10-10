// Shared real-host fixture for the cm-ai-host*.test.mjs files (the Codex-sandbox
// set that CI cannot host). Importing it isolates CM_WORKFLOW_HOME/LOG_HOME for the
// importing test file and sweeps every fixture root for leaked processes when that
// file finishes, exactly as the single file did before it was split.
// Not a test file itself; every fixture works in its own temporary root.
import {buildManifest} from './cm-spec-manifest.mjs';
import {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {guardFixtureSource,killFixtureProcesses} from './fixtures/process-cleanup.mjs';

// Keep runtime declarations and log mirrors independent of the invoking user's home.
const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-host-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));
// Every fixture root is swept once the file finishes: a surviving fake CLI or
// host is a leak even if its test passed (2026-09-28: fake reviewers ran 17h).
const fixtureRoots=new Set();
after(()=>{
  const leaked=[...fixtureRoots].flatMap(root=>killFixtureProcesses(root));
  assert.deepEqual(leaked.map(row=>row.command.slice(0,160)),[],'fixture processes outlived their tests');
});

export const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
export const identity={repositoryId:'host-fixture',runId:'host-fixture-run',taskId:'T-001',attempt:1};
export const request=(operation,requestId=operation)=>({version:1,operation,requestId,identity});

export function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-host-')));fixtureRoots.add(root);
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work',config=path.join(root,'run.json');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope:['target.mjs'],requirements:['requirements.md']}));
  // create requires a bound review configuration; it grants no review attempt.
  const reviewFile=path.join(root,'placeholder-review.json');
  fs.writeFileSync(reviewFile,JSON.stringify({model:'fixture',preflight:{}}));
  return {root,specsDir,codeProject,config,reviewFile,args:['serve','--config',config,'--mode','create','--host-context','native-host-fixture','--allow-development']};
}
// A test that supplies its own --review-config keeps it; others use the placeholder.
export const launchArgs=f=>f.args.includes('--review-config')?f.args:[...f.args,'--review-config',f.reviewFile];

export function runCli(f,mode,action='create'){
  return new Promise((resolve,reject)=>{
    const args=[...launchArgs(f)];args[4]=action;
    const child=spawn(process.execPath,[cli,...args],{stdio:['pipe','pipe','pipe'],env:f.env??process.env});
    let buffer='',stderr='',closed=false,sessionId;const rows=[],calls=[];
    // Provider children run in their own process groups: stopping only the host
    // would orphan a hung fake reviewer, so failure and watchdog paths stop the
    // whole fixture tree. f.watchdog(expire) may replace the timer; it returns a disarm function.
    let disarm=()=>{};
    const fail=error=>{
      disarm();child.kill('SIGKILL');
      try{killFixtureProcesses(f.root);}catch(cleanup){error=new AggregateError([error,cleanup],String(error?.message??error));}
      reject(error);
    };
    disarm=(f.watchdog??(expire=>{const timer=setTimeout(expire,Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000));
      return ()=>clearTimeout(timer);}))(()=>fail(new Error('host fixture timed out')));
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
              ||(f.workflow&&row.kind==='documentation_inspect')||(f.qaBrowser&&row.kind==='qa_browser'),'resume must not resend development');
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
            }else if(row.kind==='qa_browser'&&f.qaBrowser){
              send(response(row,f.qaBrowser(row.payload)));
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
        }catch(error){fail(error);return;}
      }
    });
    child.once('close',code=>{disarm();resolve({code,stderr,rows,calls});});
    send(f.request??request('advance'));
  });
}


// Real local child processes with synthetic provider output. Only `codex sandbox`
// delegates to the installed CLI; no real model is ever requested.
export function installDispatchFakes(f){
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

export function protectedResultFixture(){
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
export const implementedValue=()=>({outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}});
export const lastCheckpoint=f=>JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')))
  .records.filter(row=>row.payload.type==='effect-checkpoint').at(-1).payload.checkpoint;


// Step 21: exercise actual worker timers/cleanup and durable CLI restart, with
// synthetic providers only. The installed Codex is used solely for sandbox checks.
export function installTimeoutReviewer(f,runtime){
  installDispatchFakes(f);
  const fake=path.join(f.root,'bin',runtime),delegate=fake+'-delegate';
  fs.renameSync(fake,delegate);
  const modeFile=path.join(f.root,'review-mode.json');
  fs.writeFileSync(modeFile,JSON.stringify('approved'));
  fs.writeFileSync(fake,guardFixtureSource(String.raw`#!${process.execPath}
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
   send({type:'result',subtype:'success',session_id:thread,is_error:false,num_turns:1,structured_output:{verdict:'approved'},result:'{"verdict":"approved"}'});
  }
 }
 // A hung reviewer announces its pid so the watchdog regression can find it.
 fs.writeFileSync(modeFile+'.hung',String(process.pid));
 setInterval(()=>{},1000);
});
`),{mode:0o700});
  return mode=>fs.writeFileSync(modeFile,JSON.stringify(mode));
}
