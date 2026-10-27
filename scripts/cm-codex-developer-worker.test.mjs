import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexDeveloperWorker,developerArgs} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
import {commonArgs} from '../runtime/js/cm-ai/codex-config.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {ownerGuardSource} from './fixtures/process-cleanup.mjs';

// The hang mode never exits on its own; the guard ends it if this test process dies first.
const script=`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
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
  const parent=`${ownerGuardSource()}process.stdin.resume();
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

// 2026-10-26: a Codex developer that hits the API rate limit (429 / Too Many Requests /
// rate limit, the same rule as the Codex reviewer) ends as developer_rate_limited;
// other provider failures stay provider_failed. Only the class is kept.
const limitedScript=message=>`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
emit({type:'error',message:${JSON.stringify(message)}});emit({type:'turn.failed',error:{message:${JSON.stringify(message)}}});
setTimeout(()=>process.exit(1),5000);
});`;
for(const [message,code] of [['exceeded retry limit, last status: 429 Too Many Requests','developer_rate_limited'],
  ['unexpected status HTTP 429','developer_rate_limited'],['Rate limit reached','developer_rate_limited'],
  ['request failed','provider_failed'],['error 4290 unrelated id','provider_failed']])
test(`Codex developer failure "${message}" ends as ${code}`,()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',limitedScript(message)],options)});
  const result=await worker({prompt:'synthetic'},{signal:new AbortController().signal});
  assert.deepEqual(result,{status:'unknown',code});
}));

// Codex review round 1: the class is collected from every failure event of the turn
// (as the Codex reviewer does), whichever carries it; the terminal stays the first.
const failedPair=(first,second)=>`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
emit({type:'error',message:${JSON.stringify(first)}});emit({type:'turn.failed',error:{message:${JSON.stringify(second)}}});
setTimeout(()=>process.exit(1),5000);
});`;
for(const [first,second,code] of [['Request failed','HTTP 429 Too Many Requests','developer_rate_limited'],
  ['HTTP 429 Too Many Requests','Request failed','developer_rate_limited'],['Request failed','stream closed','provider_failed']])
test(`Codex developer error "${first}" then turn.failed "${second}" ends as ${code}`,()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',failedPair(first,second)],options)});
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code});
}));

// Ticket 11: Codex can write the generic error line first and the turn.failed naming
// the 429 a moment later. Killing the group on the first line used to lose the class.
const delayedPair=delayMs=>`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
emit({type:'error',message:'Request failed'});
${delayMs===null?'':`setTimeout(()=>emit({type:'turn.failed',error:{message:'HTTP 429 Too Many Requests'}}),${delayMs});`}
setTimeout(()=>process.exit(1),5000);
});`;
test('Codex developer keeps the 429 of a turn.failed written 400 ms after a generic error',()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',delayedPair(400)],options)});
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'developer_rate_limited'});
}));
test('Codex developer stops a lone generic error within the short grace, not the call timeout',()=>fixture(async cwd=>{
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',timeoutMs:60000,
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',delayedPair(null)],options)});
  const started=Date.now();
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'provider_failed'});
  assert.ok(Date.now()-started<4500,`stopped after ${Date.now()-started} ms`);
}));

// Codex review r1 (ticket 11): a cancel or timeout during the grace keeps its own code,
// and a second error line stops at once instead of waiting out the grace.
test('Codex developer cancel and timeout during the error grace keep cancelled and timeout',()=>fixture(async cwd=>{
  const cancelled=new AbortController();
  const cancel=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>{setTimeout(()=>cancelled.abort(),300);return spawn(process.execPath,['-e',delayedPair(null)],options);}});
  assert.deepEqual(await cancel({prompt:'synthetic'},{signal:cancelled.signal}),{status:'unknown',code:'cancelled'});
  const timeout=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',timeoutMs:500,
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',delayedPair(null)],options)});
  assert.deepEqual(await timeout({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'timeout'});
}));
test('Codex developer stops at once on a second error line and keeps its 429 class',()=>fixture(async cwd=>{
  const script=`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
emit({type:'error',message:'Request failed'});setTimeout(()=>emit({type:'error',message:'HTTP 429 Too Many Requests'}),100);
setTimeout(()=>process.exit(1),5000);
});`;
  const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
    spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',script],options)});
  const started=Date.now();
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'developer_rate_limited'});
  // Without the immediate stop the 2 s grace plus the 1 s kill escalation would pass 3 s.
  assert.ok(Date.now()-started<2700,`stopped after ${Date.now()-started} ms`);
}));

test('Codex developer starts no grace for an unterminated error read at close',async()=>{
  const timers=()=>process.getActiveResourcesInfo().filter(name=>name==='Timeout').length;
  const worker=codexDeveloperWorker({cwd:'/fixture',model:'fixture',schemaPath:'/unused',
    spawnProcess(){
      // In-memory child without a pid: group signals are skipped, only the stream matters.
      const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin.on('finish',()=>{
        child.stdout.write([{type:'thread.started',thread_id:'fixture'},{type:'turn.started'}].map(x=>JSON.stringify(x)+'\n').join(''));
        child.stdout.end(JSON.stringify({type:'error',message:'Request failed'}));
        child.stdout.once('end',()=>{child.emit('exit',1,null);child.emit('close',1,null);});
      });
      return child;
    }});
  const before=timers();
  assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'provider_failed'});
  assert.equal(timers(),before,'no grace timer left after the call settled');
});

// 2026-10-27: a Codex developer that exits right after its failed turn (its group is
// then only our unreaped zombie child, EPERM on macOS) is proven stopped, so the call
// keeps its class instead of process_cleanup_failed.
test('Codex developer exiting at once after a 429 keeps developer_rate_limited (no cleanup failure)',()=>fixture(async cwd=>{
  const script=`${ownerGuardSource()}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
emit({type:'thread.started',thread_id:'isolated-fixture'});emit({type:'turn.started'});
emit({type:'error',message:'HTTP 429 Too Many Requests'});emit({type:'turn.failed',error:{message:'HTTP 429 Too Many Requests'}});
process.exit(1);
});`;
  for(let attempt=0;attempt<3;attempt++){
    const worker=codexDeveloperWorker({cwd,model:'fixture',schemaPath:'/unused',
      spawnProcess:(_,__,options)=>spawn(process.execPath,['-e',script],options)});
    assert.deepEqual(await worker({prompt:'synthetic'},{signal:new AbortController().signal}),{status:'unknown',code:'developer_rate_limited'},`attempt ${attempt}`);
  }
}));
