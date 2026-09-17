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
  const values=(args,flag)=>args.flatMap((arg,i)=>arg===flag?[args[i+1]]:[]);
  const reviewDisabled=values(review,'--disable'),codingDisabled=values(coding,'--disable');
  for(const name of ['shell_tool','unified_exec','code_mode_host']){
    assert(reviewDisabled.includes(name));assert(!codingDisabled.includes(name));
  }
  assert.deepEqual(codingDisabled,reviewDisabled.filter(name=>!['shell_tool','unified_exec','code_mode_host'].includes(name)));
  assert.deepEqual(values(coding,'--enable'),['shell_tool','unified_exec']);
  assert(!coding.includes('code_mode'));assert(!coding.includes('code_mode_host'));
  assert(coding.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(coding.at(-1),'-');assert(!coding.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('coding and review argv both suppress the user skills catalog (2026-09-16: 18249 -> 11706 input tokens)',()=>{
  const options={cwd:'/fixture',model:'fixture',schemaPath:'/schema.json'};
  for(const args of [developerArgs(options),commonArgs(options)]){
    const i=args.indexOf('skills.include_instructions=false');
    assert(i>0,'skills.include_instructions=false missing');assert.equal(args[i-1],'-c');
    assert.equal(args.filter(arg=>arg==='skills.include_instructions=false').length,1);
    // Per-folder disables stay as the second defence; the catalog switch must precede them.
    const config=args.findIndex(arg=>arg.startsWith('skills.config='));
    assert(config>i);assert.equal(args[config-1],'-c');
    assert(!args.some(arg=>/^skills\.max_context_tokens=/.test(arg)));
    assert(!args.includes('skip_host_skill_discovery'));assert(!args.includes('--ignore-rules'));
  }
});

test('coding tool channel preserves the specs read-only permission profile',()=>fixture(async temp=>{
  const cwd=fs.realpathSync(temp),specsRoot=path.join(cwd,'specs');fs.mkdirSync(specsRoot);
  const args=developerArgs({cwd,specsRoot,model:'fixture',schemaPath:'/schema.json'});
  assert(!args.includes('code_mode_host'));assert(!args.includes('code_mode'));
  assert(!args.includes('--sandbox'));assert(args.includes('default_permissions="cm-specs"'));
  assert(args.includes(`permissions.cm-specs={extends=":workspace",filesystem={${JSON.stringify(specsRoot)}="read",":workspace_roots"={"AGENTS.md"="read","CLAUDE.md"="read",".claude"="read"}},network={enabled=false}}`));
  assert.deepEqual(args.flatMap((arg,i)=>arg==='--enable'?[args[i+1]]:[]),['shell_tool','unified_exec']);
}));

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

const startupNotices=[
  'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.',
  'Skill descriptions were shortened to fit the skills context budget. '+ 'x'.repeat(200),
];
const noticeEvent=message=>({type:'item.completed',item:{type:'error',message,extra:'not retained'}});
const noticeStream=[{type:'thread.started',thread_id:'notice-fixture'},noticeEvent(startupNotices[0]),
  {type:'turn.started'},noticeEvent(startupNotices[1])];
const completedStream=[{type:'item.completed',item:{type:'agent_message',text:'{"outcome":"implemented"}'}},
  {type:'turn.completed'}];
for(const [name,events,code,expectedNotices=startupNotices,exitCode=0] of [
  ['startup notices',[...noticeStream,...completedStream],null],
  ['no notices',[noticeStream[0],noticeStream[2],...completedStream],null,[]],
  ['duplicate notice',[...noticeStream,noticeEvent(startupNotices[0]),...completedStream],null,[...startupNotices,startupNotices[0]]],
  ['changed notice',[...noticeStream,noticeEvent('different diagnostic'),...completedStream],null,[...startupNotices,'different diagnostic']],
  ['eight notices',[...noticeStream,...Array.from({length:6},()=>noticeEvent('extra')),...completedStream],null,[...startupNotices,...Array(6).fill('extra')]],
  ['ninth notice',[...noticeStream,...Array.from({length:7},()=>noticeEvent('extra')),...completedStream],'invalid_event',[...startupNotices,...Array(6).fill('extra')]],
  ['nonzero exit',[...noticeStream,...completedStream],'incomplete_result',startupNotices,1],
  ['top-level error',[...noticeStream,{type:'error',message:'fatal'},...completedStream],'provider_failed'],
  ['turn failed',[...noticeStream,{type:'turn.failed',error:{message:'fatal'}},...completedStream],'provider_failed'],
  ['unknown item',[...noticeStream,{type:'item.completed',item:{type:'future_item'}},...completedStream],'unexpected_tool_or_item'],
  ['unfinished error item',[...noticeStream,{type:'item.started',item:{type:'error',message:'unfinished'}},...completedStream],'unexpected_tool_or_item'],
  ['malformed notice',[...noticeStream,noticeEvent(null),...completedStream],'invalid_event'],
  ['notice before thread',[noticeEvent('early'),...noticeStream,...completedStream],'thread_missing',[]],
  ['notice after terminal',[...noticeStream,...completedStream,noticeEvent('late')],'invalid_event'],
  ['notice after failure',[...noticeStream,{type:'turn.failed'},noticeEvent('late'),...completedStream],'provider_failed'],
  ['notices without result',noticeStream,'incomplete_result'],
])test(`developer notice stream: ${name}`,()=>fixture(async cwd=>{
  const emit=`process.stdin.resume();for(const row of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(row)+'\\n');process.exitCode=${exitCode};`;
  const notices=[];
  const worker=codexDeveloperWorker({cwd,model:'fixture',learning:false,onNotice:message=>notices.push(message),
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',emit],options)});
  const result=await worker({prompt:'synthetic'},{signal:new AbortController().signal});
  if(code)assert.deepEqual(result,{status:'unknown',code});
  else assert.deepEqual(result,{status:'succeeded',value:{outcome:'implemented'},providerThread:'notice-fixture'});
  assert.deepEqual(notices,expectedNotices.map(x=>x.slice(0,200)));
  assert(!JSON.stringify(result).includes('not retained'));
}));

for(const mode of ['omitted','non-function','throwing'])test(`developer notice callback: ${mode}`,()=>fixture(async cwd=>{
  let calls=0;
  const callbacks={omitted:{},'non-function':{onNotice:'ignored'},throwing:{onNotice(){calls++;throw Error('diagnostic sink failed');}}};
  const events=[...noticeStream,...completedStream];
  const emit=`process.stdin.resume();for(const row of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(row)+'\\n');`;
  const worker=codexDeveloperWorker({cwd,model:'fixture',learning:false,...callbacks[mode],
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',emit],options)});
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),
    {status:'succeeded',value:{outcome:'implemented'},providerThread:'notice-fixture'});
  assert.equal(calls,mode==='throwing'?2:0);
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),
    {status:'unavailable',code:'worker_dispatch_limit'});
}));
