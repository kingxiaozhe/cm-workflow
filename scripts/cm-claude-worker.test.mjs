import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';

const config={cwd:'/tmp',model:'claude-fixture',cli:'never-dispatch-real-cli'};
const receipt={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(config)};
const messages=[
  {type:'system',subtype:'init',session_id:'fresh-review'},
  {type:'assistant',session_id:'fresh-review',parent_tool_use_id:null,
    message:{role:'assistant',content:[{type:'text',text:'review'}]}},
  {type:'result',subtype:'success',session_id:'fresh-review',is_error:false,num_turns:1,result:'{"verdict":"approved"}'},
];
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
