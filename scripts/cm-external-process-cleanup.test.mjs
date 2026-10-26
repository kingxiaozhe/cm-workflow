import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {ownedProcessCleanup} from '../runtime/js/cm-ai/owned-process-cleanup.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readModelJson,writeModelJson} from '../runtime/js/cm-ai/model-configuration-file.mjs';
const fixture=t=>{const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-security-fix-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const options=root=>({cwd:root,model:'synthetic-reviewer',effort:'high',schemaPath:path.join(root,'schema.json')});
const worker=(root,extra={})=>{const config=options(root);return codexWorker({...config,preflight:{passed:true,cli_model:config.model,config_fingerprint:configFingerprint(config)},...extra});};

for(const uncertain of [false,true])test(`Claude terminal receipt requires owned descendant cleanup: ${uncertain?'unknown':'confirmed'}`,
  {skip:process.platform==='win32'},async t=>{
  const root=fixture(t),script=path.join(root,'claude-leader.mjs'),pidFile=path.join(root,'descendant.pid');let leader;
  t.after(()=>{if(leader?.pid)try{process.kill(-leader.pid,'SIGKILL');}catch{}});
  fs.writeFileSync(script,`import {spawn} from 'node:child_process';import fs from 'node:fs';
for await(const chunk of process.stdin){};
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>{
 fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
 const session_id='original-session',out=value=>console.log(JSON.stringify({...value,session_id}));
 out({type:'system',subtype:'init'});
 out({type:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'done'}]}});
 out({type:'result',subtype:'success',is_error:false,num_turns:1,structured_output:{ok:true}});process.exit(0);
});`);
  const options={cwd:root,model:'fixture'};let receipt=null;
  const run=claudeWorker({...options,timeoutMs:3000,preflight:{passed:true,provider:'claude',prompt_transport:'stdin',
    config_fingerprint:claudeReviewFingerprint(options)},
    ...(uncertain?{killProcess:()=>{throw Object.assign(new Error('fixture permission denied'),{code:'EPERM'});}}:{}),
    spawnProcess:(_cli,_args,opts)=>leader=spawn(process.execPath,[script],opts)});
  const result=await run({prompt:'fixture'},{signal:new AbortController().signal,onEvent:()=>{},onTerminal:value=>{
    assert.equal(alive(Number(fs.readFileSync(pidFile,'utf8'))),false);receipt=value;
  }});
  const descendant=Number(fs.readFileSync(pidFile,'utf8'));
  if(uncertain){assert.equal(result.code,'process_cleanup_unknown');assert.equal(receipt,null);assert.equal(alive(descendant),true);}
  else {assert.deepEqual(result,{status:'succeeded',value:{ok:true}});assert.deepEqual(receipt,result);assert.equal(alive(descendant),false);}
});


test('Windows old reviewer keeps successful dispatch; termination uncertainty cannot become cancelled',async t=>{
  const root=fixture(t),original=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{value:'win32'});
  try{
    let kills=0;
    for(const mode of ['success','timeout','cancel']){
      const good=mode==='success',controller=new AbortController();
      const spawnProcess=(_cli,_args,opts)=>{
        assert.equal(opts.detached,false);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null,'SIGTERM'));};
        if(good)queueMicrotask(()=>{
          for(const row of [{type:'thread.started',thread_id:'fresh'},{type:'turn.started'},
            {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed'}])child.stdout.write(JSON.stringify(row)+'\n');
          child.emit('close',0,null);
        });return child;
      };
      const timer=mode==='cancel'?setTimeout(()=>controller.abort(),10):null;
      try{
        const result=await worker(root,{spawnProcess,timeoutMs:mode==='cancel'?1000:20})({prompt:'fixture'},
          {signal:controller.signal,onEvent:()=>{},onTerminal:()=>assert.fail('Windows cannot attest process-tree cleanup')});
        assert.deepEqual(result,good?{status:'succeeded',value:{ok:true}}:{status:'failed',code:'process_cleanup_unknown'});
      }finally{clearTimeout(timer);}
    }
    assert.equal(kills,2);
  }finally{Object.defineProperty(process,'platform',original);}
});

// Signal delivery is asynchronous. The last member can be exiting until the
// next event-loop turn; a probe must not run in the SIGKILL delivery turn.
test('owned cleanup waits for asynchronous exit before its first group probe',{skip:process.platform==='win32'},async()=>{
  const calls=[];let reaped=false;
  const cleanup=ownedProcessCleanup({pid:12345},{graceMs:0,killProcess:(pid,signal)=>{
    assert.equal(pid,-12345);calls.push(signal);
    if(signal==='SIGKILL'){setTimeout(()=>{reaped=true;},0);return;}
    if(signal===0){
      if(!reaped)throw Object.assign(new Error('synthetic exit still pending'),{code:'EPERM'});
      throw Object.assign(new Error('synthetic group gone'),{code:'ESRCH'});
    }
  }});
  await cleanup();assert.equal(reaped,true);assert.deepEqual(calls,['SIGTERM','SIGKILL',0]);
});

for(const failureAt of ['SIGTERM','SIGKILL',0])test(`owned cleanup stops at permission refusal during ${failureAt}`,{skip:process.platform==='win32'},async()=>{
  const calls=[];
  const cleanup=ownedProcessCleanup({pid:12345},{graceMs:0,killProcess:(pid,signal)=>{
    assert.equal(pid,-12345);calls.push(signal);
    if(signal===failureAt)throw Object.assign(new Error('synthetic permission denied'),{code:'EPERM'});
  }});
  await assert.rejects(cleanup(),{code:'process_cleanup_unknown'});
  assert.deepEqual(calls,['SIGTERM','SIGKILL',0].slice(0,['SIGTERM','SIGKILL',0].indexOf(failureAt)+1));
  await assert.rejects(cleanup(),{code:'process_cleanup_unknown'});
  assert.equal(calls.length,['SIGTERM','SIGKILL',0].indexOf(failureAt)+1);
});

test('owned cleanup keeps a live group unknown at its original deadline',{skip:process.platform==='win32'},async()=>{
  const calls=[];
  const cleanup=ownedProcessCleanup({pid:12345},{graceMs:0,killWaitMs:0,killProcess:(pid,signal)=>{
    assert.equal(pid,-12345);calls.push(signal);
  }});
  await assert.rejects(cleanup(),{code:'process_cleanup_unknown'});
  assert.deepEqual(calls,['SIGTERM','SIGKILL',0]);
});

// 2026-10-27 (macOS 26 measured): a process group whose only member is our own child
// that already exited but is not reaped yet (a zombie) answers kill(-pgid, 0|SIGTERM)
// with EPERM; after the reap it is ESRCH. A provider CLI that exits right after its
// error used to end process_cleanup_unknown. A stop is proven only once our direct
// child's exit is observed and a re-probe answers ESRCH (no process table is read).
const exitedChild=(pid=12345)=>Object.assign(new EventEmitter(),{pid,exitCode:1,signalCode:null});
const denied=()=>{throw Object.assign(new Error('synthetic permission denied'),{code:'EPERM'});};
test('owned cleanup: a real child that exited at once (unreaped zombie group) is proven stopped',{skip:process.platform==='win32'},async()=>{
  const child=spawn(process.execPath,['-e','process.exit(1)'],{detached:true,stdio:'ignore'});
  const started=Date.now();while(Date.now()-started<400){} // the child exits; this loop keeps it unreaped
  await ownedProcessCleanup(child,{graceMs:0})();
  assert.notEqual(child.exitCode,null);
});
// EPERM is resolved only through our own child: after its exit is observed, a re-probe
// within the same budget must answer ESRCH (stopped) or deliver (a live member).
const waitingChild=(pid=12345)=>Object.assign(new EventEmitter(),{pid,exitCode:null,signalCode:null});
test('owned cleanup: EPERM until our child is reaped, then ESRCH, is a stop; the wait never blocks the event loop',{skip:process.platform==='win32'},async()=>{
  const child=waitingChild(),calls=[];let reaped=false,ticked=false;
  setTimeout(()=>{ticked=true;},10);
  setTimeout(()=>{reaped=true;child.exitCode=1;child.emit('exit',1,null);},40);
  await ownedProcessCleanup(child,{graceMs:0,killProcess:(pid,signal)=>{
    assert.equal(pid,-12345);calls.push(signal);
    throw Object.assign(new Error('synthetic'),{code:reaped?'ESRCH':'EPERM'});
  }})();
  assert.equal(ticked,true,'a 10 ms timer ran while waiting for the exit');
  assert.deepEqual(calls,['SIGTERM','SIGTERM']);
});
test('owned cleanup: an EPERM that persists after our child exited stays unknown',{skip:process.platform==='win32'},async()=>{
  const started=Date.now();
  await assert.rejects(ownedProcessCleanup(exitedChild(),{graceMs:0,exitBudgetMs:200,killProcess:denied})(),{code:'process_cleanup_unknown'});
  assert(Date.now()-started<1000,'bounded by the budget');
});
// Review 2026-10-27 round 2: every signal used to get the full exit budget again, so a
// probe that met EPERM at the kill deadline still waited the whole budget past it.
test('owned cleanup: an EPERM probe at the kill deadline does not wait past it',{skip:process.platform==='win32'},async()=>{
  const started=Date.now();
  await assert.rejects(ownedProcessCleanup(exitedChild(),{graceMs:0,killWaitMs:0,exitBudgetMs:200,killProcess:(pid,signal)=>{
    if(signal===0)denied();
  }})(),{code:'process_cleanup_unknown'});
  assert(Date.now()-started<150,`ended at the kill deadline, not ${Date.now()-started} ms later`);
});
test('owned cleanup: a member that answers once our child exited is live, not stopped',{skip:process.platform==='win32'},async()=>{
  const calls=[];let first=true;
  await assert.rejects(ownedProcessCleanup(exitedChild(),{graceMs:0,killWaitMs:0,killProcess:(pid,signal)=>{
    calls.push(signal);if(first){first=false;denied();}
  }})(),{code:'process_cleanup_unknown'});
  // It was treated as alive: escalated to SIGKILL and still probed alive at the deadline.
  assert.deepEqual(calls,['SIGTERM','SIGTERM','SIGKILL',0]);
});
test('owned cleanup: EPERM without an observed exit of our child stays unknown, even if a later probe says ESRCH',{skip:process.platform==='win32'},async()=>{
  await assert.rejects(ownedProcessCleanup(waitingChild(),{graceMs:0,exitBudgetMs:30,killProcess:denied})(),{code:'process_cleanup_unknown'});
  let first=true;
  await assert.rejects(ownedProcessCleanup(waitingChild(),{graceMs:0,exitBudgetMs:30,killProcess:()=>{
    if(first){first=false;denied();}throw Object.assign(new Error('synthetic'),{code:'ESRCH'});
  }})(),{code:'process_cleanup_unknown'});
});
test('owned cleanup: a zombie leader with a live descendant is killed, not taken for stopped',{skip:process.platform==='win32'},async t=>{
  const root=fixture(t),pidFile=path.join(root,'grandchild.pid');
  const child=spawn(process.execPath,['-e',`const c=require('child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();process.exit(0);`],{detached:true,stdio:'ignore'});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  while(!fs.existsSync(pidFile))await new Promise(resolve=>setTimeout(resolve,10));
  const grandchild=Number(fs.readFileSync(pidFile,'utf8'));
  await ownedProcessCleanup(child,{graceMs:50})();
  assert.equal(alive(grandchild),false,'the TERM-ignoring descendant was killed');
});
test('Codex reviewer that exits right after its 429 ends reviewer_rate_limited, not process_cleanup_unknown',{skip:process.platform==='win32'},async t=>{
  const root=fixture(t),script=path.join(root,'codex-429.mjs');
  fs.writeFileSync(script,`let input='';for await(const part of process.stdin)input+=part;
const message='exceeded retry limit, last status: 429 Too Many Requests';
for(const value of [{type:'thread.started',thread_id:'t-429'},{type:'turn.started'},{type:'error',message},{type:'turn.failed',error:{message}}])
  process.stdout.write(JSON.stringify(value)+'\\n');
process.exit(1);`);
  for(let attempt=0;attempt<3;attempt++){
    const result=await worker(root,{promptTransport:'stdin',timeoutMs:5000,spawnProcess:(_cli,_args,opts)=>spawn(process.execPath,[script],opts),
      preflight:{passed:true,cli_model:'synthetic-reviewer',prompt_transport:'stdin',
        config_fingerprint:configFingerprint({...options(root),promptTransport:'stdin'})}})({prompt:'p'},{signal:new AbortController().signal,onEvent:()=>{}});
    assert.deepEqual(result,{status:'failed',code:'reviewer_rate_limited'},`attempt ${attempt}`);
  }
});
