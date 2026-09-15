import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {codexDeveloperWorker,developerArgs} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
import {commonArgs} from '../runtime/js/cm-ai/codex-config.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';

const script=`let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
if(process.argv[1]==='hang'){setInterval(()=>{},1000);return;}
require('node:fs').writeFileSync('implementation.txt','synthetic implementation');
emit({type:'item.completed',item:{type:'command_execution',exit_code:0,aggregated_output:'private fixture output'}});
emit({type:'item.completed',item:{type:'file_change',changes:[{path:'implementation.txt',kind:'add'}]}});
emit({type:'item.completed',item:{type:'agent_message',text:'progress, not final JSON'}});
emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'implemented'})}});
emit({type:'turn.completed'});
if(process.argv[1]==='bad')emit({type:'error',message:'private failure'});
});`;

async function fixture(fn){
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'cm-coder-'));
  try{await fn(cwd);}finally{fs.rmSync(cwd,{recursive:true,force:true});}
}

test('coding argv enables tools without weakening reviewer argv',()=>{
  const options={cwd:'/fixture',model:'fixture',schemaPath:'/schema.json'};
  const coding=developerArgs(options),review=commonArgs(options);
  assert.equal(coding[coding.indexOf('--sandbox')+1],'workspace-write');
  assert.equal(review[review.indexOf('--sandbox')+1],'read-only');
  assert(review.includes('shell_tool'));assert(coding.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(coding.at(-1),'-');assert(!coding.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('protected worker refuses a specs symlink substituted while awaiting dispatch',()=>fixture(async temp=>{
  const cwd=fs.realpathSync(temp),specsRoot=path.join(cwd,'specs');fs.mkdirSync(specsRoot);
  let calls=0;
  const worker=codexDeveloperWorker({cwd,specsRoot,model:'fixture',schemaPath:'/unused',
    spawnProcess:()=>{calls++;assert.fail('invalid protection must not dispatch');}});
  fs.renameSync(specsRoot,path.join(cwd,'original-specs'));
  fs.symlinkSync(path.join(cwd,'original-specs'),specsRoot);
  const result=await worker({prompt:'synthetic'},{signal:new AbortController().signal});
  assert.deepEqual(result,{status:'unavailable',code:'specs_protection_invalid'});
  assert.equal(calls,0);
}));

test('real isolated subprocess writes fixture and adapter binds its final result',()=>fixture(async cwd=>{
  let calls=0;
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused-schema',spawnProcess:(cli,args,options)=>{
    calls++;assert.equal(cli,'codex');assert.equal(options.shell,false);assert.equal(args.at(-1),'-');
    return spawn(process.execPath,['-e',script,'ok'],options);
  }});
  const run=createCodexDeveloperRun({worker,requestedModel:'fixture'});
  const r=requestFor({invocationId:'dev-1',identity:{repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},
    role:'developer',provider:'codex',requestedModel:'fixture',contextId:'dev',
    payload:{scope:['implementation.txt'],requirements:[],priorReview:null}});
  const result=await run(r,{signal:new AbortController().signal});
  assert.equal(result.status,'succeeded');assert.equal(result.invocationId,r.invocationId);
  assert.equal(result.providerThreadId,'isolated-fixture');
  assert.equal(fs.readFileSync(path.join(cwd,'implementation.txt'),'utf8'),'synthetic implementation');
  assert(!JSON.stringify(result).includes('private fixture output'));
  assert.equal((await run(r,{signal:new AbortController().signal})).status,'unavailable');assert.equal(calls,1);
}));
test('failure after provider completion never becomes successful implementation',()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',script,'bad'],options)});
  const result=await worker({prompt:'synthetic'},{signal:new AbortController().signal});
  assert.equal(result.status,'unknown');assert.equal(result.code,'provider_failed');
}));

test('timeout closes the child without classifying it as user cancellation',()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',timeoutMs:100,
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',script,'hang'],options)});
  const result=await worker({prompt:'synthetic'},{signal:new AbortController().signal});
  assert.equal(result.status,'unknown');assert.equal(result.code,'timeout');
}));

test('runner develops through subprocess then stops at its existing review boundary',()=>fixture(async cwd=>{
  fs.writeFileSync(path.join(cwd,'requirements.md'),'Write a synthetic implementation file.');
  let schema,commits=0,checks=0;
  const worker=codexDeveloperWorker({cwd,model:'fixture',learning:false,
    spawnProcess:(_,args,options)=>{
      schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
      return spawn(process.execPath,['-e',script,'ok'],options);
    }});
  const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1};
  const runner=createTaskRunner({root:cwd,identity,scope:['implementation.txt'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:2000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:createCodexDeveloperRun({worker,requestedModel:'fixture'})},
    reviewers:[{id:'review',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-1','review-2'],run:()=>{assert.fail('development must not dispatch review');}}],check:()=>{
      checks++;assert.equal(fs.readFileSync(path.join(cwd,'implementation.txt'),'utf8'),'synthetic implementation');
      return [{id:'fixture-content',command:['node','fixture-content-check'],outcome:'passed',exitCode:0,evidence:'Host verified exact synthetic file bytes'}];
    },commit:()=>{commits++;return {outcome:'fixture_completed'};}});
  const state=await runner.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(state.state,'awaiting_review',JSON.stringify(state));assert.match(state.packageDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(schema.properties.outcome.enum,['implemented','blocked']);
  assert.equal(checks,1);assert.equal(commits,0);
}));

test('cancellation kills a TERM-resistant descendant inheriting output pipes',()=>fixture(async cwd=>{
  const ac=new AbortController();let child;
  const descendant=`process.on('SIGTERM',()=>{});
    process.stdout.write(JSON.stringify({type:'item.started',item:{type:'command_execution',id:'descendant-ready'}})+'\\n');
    setTimeout(()=>{require('node:fs').writeFileSync('leaked.txt','still running');process.exit(0);},2500);`;
  const parent=`process.stdin.resume();
    process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'tree'})+'\\n');
    process.stdout.write(JSON.stringify({type:'turn.started'})+'\\n');
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
    setInterval(()=>{},1000);`;
  const worker=codexDeveloperWorker({cwd,model:'fixture',learning:false,timeoutMs:5000,
    spawnProcess:(_,__,options)=>{
      assert.equal(options.detached,true);
      child=spawn(process.execPath,['-e',parent],options);
      child.stdout.on('data',bytes=>{if(bytes.toString().includes('descendant-ready'))ac.abort();});
      return child;
    }});
  try{
    const result=await worker({prompt:'synthetic'},{signal:ac.signal});
    assert.equal(result.status,'unknown');assert.equal(result.code,'cancelled');
    assert.equal(fs.existsSync(path.join(cwd,'leaked.txt')),false);
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{}}
}));
