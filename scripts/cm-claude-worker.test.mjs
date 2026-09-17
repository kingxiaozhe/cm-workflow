import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {claudeWorker,claudeReviewArgs,claudeReviewFingerprint,claudePreflightMatches} from '../runtime/js/cm-ai/worker-claude.mjs';

const config={cwd:'/tmp',model:'claude-fixture',cli:'never-dispatch-real-cli'};
const receipt={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(config)};
const messages=[
  {type:'system',subtype:'init',session_id:'fresh-review'},
  {type:'assistant',session_id:'fresh-review',parent_tool_use_id:null,
    message:{role:'assistant',content:[{type:'text',text:'review'}]}},
  {type:'result',subtype:'success',session_id:'fresh-review',is_error:false,num_turns:1,result:'{"verdict":"approved"}'},
];
test('review schema is canonical without metadata and invalidates legacy preflight fingerprint',()=>{
  const args=claudeReviewArgs(config.model),index=args.indexOf('--json-schema');
  assert.ok(index>0);assert.equal(args.lastIndexOf('--json-schema'),index);
  const expected=JSON.parse(readFileSync(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url),'utf8'));
  delete expected.$schema;delete expected.$id;
  const schema=JSON.parse(args[index+1]);assert.deepEqual(schema,expected);
  assert.equal('$schema' in schema,false);assert.equal('$id' in schema,false);
  // The schema changes the effective CLI configuration, so old diagnostic receipts must expire.
  const legacyArgs=args.slice();legacyArgs.splice(index,2);
  const legacy=createHash('sha256').update(JSON.stringify({cwd:config.cwd,cli:config.cli,args:legacyArgs,
    environmentPolicy:1,promptTransport:'stdin'})).digest('hex');
  assert.notEqual(claudeReviewFingerprint(config),legacy);
  assert.equal(claudePreflightMatches({...receipt,config_fingerprint:legacy},config),false);
  assert.equal(claudePreflightMatches(receipt,config),true);
});
function fake(action, observed) {
  return (cli,args,options)=>{
    observed.push({cli,args,options});
    const child=new EventEmitter();
    child.pid=12345;observed.at(-1).child=child;
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    let input='';child.stdin.on('data',chunk=>{input+=chunk;});
    let closed=false;
    const close=(code,signal)=>{if(!closed){closed=true;child.emit('close',code,signal);}};
    child.kill=signal=>{queueMicrotask(()=>close(null,signal));return true;};
    child.stdin.on('finish',()=>queueMicrotask(()=>action({child,close,input})));
    return child;
  };
}
const rateLimit=(overrides={})=>({type:'rate_limit_event',session_id:'fresh-review',
  rate_limit_info:{status:'allowed',resetsAt:123,nested:{raw:'private'},list:['private']},...overrides});
test('successful forbidden tool triggers synchronous group SIGKILL without completion',async()=>{
  const observed=[],events=[],kills=[];
  const worker=claudeWorker({...config,preflight:receipt,
    killProcess:(pid,signal)=>{kills.push({pid,signal});observed.at(-1).child.kill(signal);},
    spawnProcess:fake(({child})=>{
      const wire=[messages[0],{...messages[1],message:{role:'assistant',content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{}}]}},
        {type:'user',session_id:'fresh-review',message:{role:'user',content:[{type:'tool_result',tool_use_id:'bash-1',is_error:false}]}},
        ...messages.slice(1)];
      child.stdout.write(wire.map(JSON.stringify).join('\n')+'\n');
      assert.deepEqual(kills,[{pid:-12345,signal:'SIGKILL'}]);
    },observed)});
  const result=await worker({prompt:'synthetic'}, {signal:new AbortController().signal,onEvent:e=>events.push(e)});
  assert.deepEqual(result,{status:'failed',code:'unexpected_tool_or_content'});
  assert.ok(!events.some(e=>e.event==='turn.completed'||e.event==='item.completed'));
  assert.equal(events.at(-1).signal,'SIGKILL');
});
async function runMessages(wireMessages,onNotice){
  const observed=[],events=[];
  const worker=claudeWorker({...config,preflight:receipt,onNotice,
    killProcess:(_pid,signal)=>observed.at(-1).child.kill(signal),
    spawnProcess:fake(({child,close})=>{
      child.stdout.write(wireMessages.map(JSON.stringify).join('\n')+'\n');close(0,null);
    },observed)});
  const result=await worker({prompt:'synthetic-only'},
    {signal:new AbortController().signal,onEvent:e=>events.push(e)});
  return {result,events};
}
test('worker forwards scalar-only rate limit notices without changing results or observer events',async()=>{
  const baseline=await runMessages(messages);
  for(const count of [1,8]){
    const notices=[],wire=[messages[0],...Array.from({length:count},()=>rateLimit()),...messages.slice(1)];
    const actual=await runMessages(wire,n=>notices.push(n));
    assert.deepEqual(actual,baseline);
    assert.deepEqual(notices,Array.from({length:count},()=>({kind:'rate_limit',info:{status:'allowed',resetsAt:123}})));
    assert.deepEqual(await runMessages(wire),baseline);
    assert.deepEqual(await runMessages(wire,()=>{throw Error('notice consumer');}),baseline);
  }
});
test('worker rejects mismatched, excessive, unknown and terminal rate limit events',async()=>{
  for(const [wire,code,count] of [
    [[messages[0],rateLimit({session_id:'other'}),...messages.slice(1)],'session_mismatch',0],
    [[messages[0],...Array.from({length:9},()=>rateLimit()),...messages.slice(1)],'unexpected_event',8],
    [[messages[0],rateLimit({type:'foo_event'}),...messages.slice(1)],'unexpected_event',0],
    [[rateLimit(),...messages],'missing_init',0],
    [[...messages,rateLimit()],'unexpected_event',0],
  ]){
    const notices=[],{result,events}=await runMessages(wire,n=>notices.push(n));
    assert.deepEqual(result,{status:'failed',code});assert.equal(notices.length,count);
    assert.ok(events.every(e=>['thread.started','turn.started','item.completed','turn.completed','process_closed'].includes(e.event)));
  }
});
test('single stdin dispatch maps actual close; prompt never enters argv; repeat refused',async()=>{
  const observed=[],events=[],control={signal:new AbortController().signal,onEvent:e=>events.push(e)};
  const worker=claudeWorker({...config,preflight:receipt,spawnProcess:fake(({child,close,input})=>{
    assert.equal(input,'synthetic-only');
    const wire=messages.map(JSON.stringify).join('\n');
    child.stdout.write(wire.slice(0,13));child.stdout.write(wire.slice(13));close(0,null);
  },observed)});
  assert.equal((await worker({prompt:'synthetic-only'},control)).status,'succeeded');
  assert.equal((await worker({prompt:'synthetic-only'},control)).code,'worker_dispatch_limit');
  assert.equal(observed.length,1);assert.ok(!observed[0].args.includes('synthetic-only'));
  assert.ok(observed[0].args.includes('--safe-mode'));
  assert.equal(observed[0].options.env.CLAUDE_CODE_MAX_RETRIES,'0');
  assert.deepEqual(events.at(-1),{event:'process_closed',exit_code:0,signal:null,timed_out:false});
});
test('failure, timeout, explicit cancellation and missing preflight remain distinct',async()=>{
  for(const kind of ['signal','invalid','limit','timeout','cancel','spawn']) {
    const observed=[],events=[],controller=new AbortController();
    const worker=claudeWorker({...config,preflight:receipt,timeoutMs:kind==='timeout'?5:1000,
      killProcess:(_pid,signal)=>observed.at(-1).child.kill(signal),
      spawnProcess:kind==='spawn'?()=>{throw Error('private diagnostic');}:fake(({child,close})=>{
        if(kind==='signal')close(null,'SIGTERM');
        if(kind==='invalid')child.stdout.write('not-json\n');
        if(kind==='limit')child.stdout.write('x'.repeat(1_000_001));
        if(kind==='cancel')controller.abort();
      },observed)});
    const result=await worker({prompt:'synthetic'}, {signal:controller.signal,onEvent:e=>events.push(e)});
    assert.equal(result.status,kind==='cancel'?'cancelled':'failed');
    assert.equal(result.code,({signal:'incomplete_result',invalid:'invalid_event',limit:'output_limit',
      timeout:'timeout',cancel:'cancelled',spawn:'spawn_failed'})[kind]);
    if(kind==='timeout')assert.equal(events.at(-1).timed_out,true);
  }
  let count=0;
  for(const preflight of [undefined,{...receipt,provider:'codex'},{...receipt,config_fingerprint:'wrong'}]) {
    const result=await claudeWorker({...config,preflight,spawnProcess:()=>{count++;}})
      ({prompt:'synthetic'},{signal:new AbortController().signal,onEvent:()=>{}});
    assert.equal(result.code,'tool_preflight_missing');
  }
  assert.equal(count,0);
});
test('timeout kills inherited-pipe descendants, including TERM-ignoring children',
  {skip:process.platform==='win32'},async()=>{
    for (const descendantStdio of ['inherit','ignore']) {
    let descendant;
    const worker=claudeWorker({...config,preflight:receipt,timeoutMs:300,
      spawnProcess:(_cli,_args,options)=>{
        const child=spawn(process.execPath,['-e',
          `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','${descendantStdio}','${descendantStdio}']});
          process.stderr.write(String(c.pid)+'\\n');setInterval(()=>{},1000);`],options);
        child.stderr.on('data',chunk=>{descendant=Number(String(chunk).trim());});
        return child;
      }});
    try {
      const started=Date.now();
      const result=await worker({prompt:'synthetic'}, {signal:new AbortController().signal,onEvent:()=>{}});
      assert.equal(result.code,'timeout');assert.ok(Date.now()-started<4000);
      assert.ok(Date.now()-started>=1200,'leader close must not cancel group escalation');
      assert.ok(Number.isInteger(descendant));
    } finally {
      if(Number.isInteger(descendant))try{process.kill(descendant,'SIGKILL');}catch{}
    }
    }
  });
