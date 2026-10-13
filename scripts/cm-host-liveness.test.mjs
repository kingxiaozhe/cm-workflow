import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {beginHostStage} from '../runtime/js/cm-ai/host-stage-observer.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(rows,predicate,timeout=1500){
  const end=Date.now()+timeout;
  while(Date.now()<end){const found=rows.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail(`missing row: ${JSON.stringify(rows)}`);
}
function session(handle,{heartbeat=false}={}){
  const input=new PassThrough(),output=new PassThrough(),rows=[],bridge=createHostToolBridge();
  output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))if(line)rows.push(JSON.parse(line));});
  const serving=serveCmAiHost({host:{handle:(request)=>handle(request,bridge)},input,output,toolBridge:bridge,heartbeat});
  return {rows,bridge,input,serving,send:row=>input.write(JSON.stringify(row)+'\n')};
}

test('host busy explains active request and close refuses a running operation without stopping it',async()=>{
  let resolve;const done=new Promise(r=>{resolve=r;});
  const s=session(async()=>{await done;return {outcome:'complete'};});
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');
    s.send({requestId:'first',operation:'advance'});await tick();
    s.send({requestId:'second',operation:'advance'});
    const busy=await waitFor(s.rows,r=>r.requestId==='second');
    assert.equal(busy.error.code,'host_busy');assert.equal(busy.error.inFlight.requestId,'first');
    assert.equal(busy.error.inFlight.operation,'advance');assert.equal(busy.error.inFlight.stage,'advance');
    assert.ok(Number.isFinite(Date.parse(busy.error.inFlight.startedAt)));assert.match(busy.error.message,/继续等待/);
    s.send({type:'host_close',sessionId:ready.sessionId});
    const refused=await waitFor(s.rows,r=>r.type==='host_response');
    assert.equal(refused.code,'host_close_busy');assert.equal(refused.accepted,false);
    assert.equal(refused.inFlight.requestId,'first');
    resolve();await waitFor(s.rows,r=>r.requestId==='first');
    s.send({type:'host_close',sessionId:ready.sessionId});await s.serving;
    assert.equal(s.rows.at(-1).closing,true);
  }finally{resolve();s.input.end();await s.serving;}
});

test('bridge close validates session and force, exposes metadata only and preserves pending reply',async()=>{
  const bridge=createHostToolBridge(),rows=[];bridge.attach(row=>{rows.push(row);});
  const pending=bridge.call('develop',{secret:'never expose this'},new AbortController().signal,{timeoutMs:1000});
  try{
    await tick();const request=rows.find(r=>r.type==='host_request'),snapshot=bridge.inFlight();
    assert.deepEqual(Object.keys(snapshot).sort(),['callId','deadlineMs','kind','startedAt']);
    assert.equal(snapshot.kind,'develop');assert.equal(snapshot.deadlineMs-Date.parse(snapshot.startedAt),1000);
    assert.equal(bridge.accept({type:'host_close',sessionId:'wrong',force:true}).code,'host_response_mismatch');
    assert.equal(bridge.accept({type:'host_close',sessionId:request.sessionId,force:'true'}).code,'host_response_mismatch');
    assert.equal(bridge.accept({type:'host_close',sessionId:request.sessionId}).code,'host_close_busy');
    assert.equal(bridge.accept({...request,type:'host_result',kind:undefined,payload:undefined}).accepted,false);
    const result={type:'host_result',sessionId:request.sessionId,callId:request.callId,requestDigest:request.requestDigest,result:{ok:true}};
    assert.equal(bridge.accept(result).accepted,true);assert.deepEqual(await pending,{ok:true});
    assert.equal(bridge.inFlight(),null);assert.equal(bridge.accept({type:'host_close',sessionId:request.sessionId}).closing,true);
  }finally{bridge.close();await pending.catch(()=>{});}
});

test('forced close explicitly warns and interrupts a pending bridge call',{timeout:3000},async()=>{
  const s=session(async(request,bridge)=>{try{await bridge.call('develop',{},new AbortController().signal);return {bad:true};}catch(error){return {code:error.code};}});
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');s.send({requestId:'active',operation:'advance'});
    await waitFor(s.rows,r=>r.type==='host_request');s.send({type:'host_close',sessionId:ready.sessionId,force:true});
    const closed=await waitFor(s.rows,r=>r.type==='host_response');assert.equal(closed.closing,true);
    await s.serving;assert.match(closed.warning,/unknown/);
    assert.equal(s.rows.find(r=>r.requestId==='active').result.code,'host_disconnected');
  }finally{s.input.end();await s.serving;}
});

test('heartbeat is opt-in, contains no payload, and idle ticks do not claim progress or poll runner',{timeout:14000},async()=>{
  let calls=0;const s=session(async(request,bridge)=>{calls++;return bridge.call('check',{private:'payload'},new AbortController().signal,{timeoutMs:13000});},{heartbeat:true});
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');assert.deepEqual(ready.heartbeat,{intervalMs:5000,timeoutMs:30000});
    const first=await waitFor(s.rows,r=>r.type==='host_heartbeat');assert.equal(first.inFlight,null);
    s.send({requestId:'check',operation:'advance'});const request=await waitFor(s.rows,r=>r.type==='host_request');
    const beat=await waitFor(s.rows,r=>r.type==='host_heartbeat'&&r.inFlight?.call,6000);
    assert.equal(beat.inFlight.stage,'check');assert.equal(beat.inFlight.call.kind,'check');assert.equal(beat.pid,process.pid);
    assert.equal(beat.sessionId,ready.sessionId);assert.equal(calls,1);assert.equal(JSON.stringify(beat).includes('payload'),false);
    assert.equal(beat.lastProgressAt,beat.inFlight.call.startedAt);
    const second=await waitFor(s.rows,r=>r.type==='host_heartbeat'&&r.at!==beat.at&&r.inFlight?.call,6000);
    assert.equal(second.lastProgressAt,beat.lastProgressAt);assert.deepEqual(second.inFlight,beat.inFlight);
    s.send({type:'host_result',sessionId:ready.sessionId,callId:request.callId,requestDigest:request.requestDigest,result:{ok:true}});
    await waitFor(s.rows,r=>r.requestId==='check');s.send({type:'host_close',sessionId:ready.sessionId});await s.serving;
    const old=session(async()=>({ok:true}));const oldReady=await waitFor(old.rows,r=>r.type==='host_ready');
    assert.equal(oldReady.heartbeat,undefined);assert.equal(old.rows.some(r=>r.type==='host_heartbeat'),false);
    old.send({type:'host_close',sessionId:oldReady.sessionId});await old.serving;
  }finally{s.input.end();await s.serving;}
});

for(const operation of ['status','cancel'])test(`close refuses in-flight ${operation} control`,async()=>{
  let resolve;const done=new Promise(r=>{resolve=r;});const s=session(async()=>{await done;return {ok:true};});
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');s.send({requestId:'control',operation});await tick();
    s.send({type:'host_close',sessionId:ready.sessionId});
    const refused=await waitFor(s.rows,r=>r.type==='host_response');
    assert.equal(refused.code,'host_close_busy');assert.equal(refused.inFlight.operation,operation);
    resolve();await waitFor(s.rows,r=>r.requestId==='control');s.send({type:'host_close',sessionId:ready.sessionId});await s.serving;
  }finally{resolve();s.input.end();await s.serving;}
});

test('poll reusing requestId cannot release a different running operation',async()=>{
  let resolve;const done=new Promise(r=>{resolve=r;});const s=session(async request=>{
    if(request.operation==='advance')await done;return {operation:request.operation};
  });
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');s.send({requestId:'same',operation:'advance'});await tick();
    s.send({requestId:'same',operation:'status'});await waitFor(s.rows,r=>r.result?.operation==='status');
    s.send({type:'host_close',sessionId:ready.sessionId});
    const refused=await waitFor(s.rows,r=>r.type==='host_response');assert.equal(refused.code,'host_close_busy');
    assert.equal(refused.inFlight.operation,'advance');resolve();await waitFor(s.rows,r=>r.result?.operation==='advance');
    s.send({type:'host_close',sessionId:ready.sessionId});await s.serving;
  }finally{resolve();s.input.end();await s.serving;}
});

test('close sent synchronously when the result is written is allowed',async()=>{
  const input=new PassThrough(),output=new PassThrough(),bridge=createHostToolBridge(),rows=[];let sessionId;
  output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))if(line){
    const row=JSON.parse(line);rows.push(row);
    if(row.type==='host_ready'){sessionId=row.sessionId;input.write(JSON.stringify({requestId:'instant',operation:'advance'})+'\n');}
    if(row.requestId==='instant')input.write(JSON.stringify({type:'host_close',sessionId})+'\n');
  }});
  const serving=serveCmAiHost({host:{handle:async()=>({ok:true})},input,output,toolBridge:bridge});
  try{const closed=await waitFor(rows,r=>r.type==='host_response');assert.equal(closed.closing,true);await serving;assert.equal(rows.some(r=>r.code==='host_close_busy'),false);}
  finally{input.end();await serving;}
});

test('CM_HOST_HEARTBEAT enables the wire contract without changing host operations',async()=>{
  const previous=process.env.CM_HOST_HEARTBEAT;process.env.CM_HOST_HEARTBEAT='1';
  const input=new PassThrough(),output=new PassThrough(),bridge=createHostToolBridge(),rows=[];
  output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))if(line)rows.push(JSON.parse(line));});
  const serving=serveCmAiHost({host:{handle:async()=>assert.fail('heartbeat must not invoke host')},input,output,toolBridge:bridge});
  try{
    const ready=await waitFor(rows,r=>r.type==='host_ready');assert.deepEqual(ready.heartbeat,{intervalMs:5000,timeoutMs:30000});
    await waitFor(rows,r=>r.type==='host_heartbeat');input.write(JSON.stringify({type:'host_close',sessionId:ready.sessionId})+'\n');await serving;
  }finally{input.end();await serving;if(previous===undefined)delete process.env.CM_HOST_HEARTBEAT;else process.env.CM_HOST_HEARTBEAT=previous;}
});

test('native stage exposes its real budget without requiring a bridge call',async()=>{
  let resolve;const done=new Promise(r=>{resolve=r;});const s=session(async()=>{
    const end=beginHostStage('check',5000);try{await done;return {ok:true};}finally{end();}
  });
  try{
    const ready=await waitFor(s.rows,r=>r.type==='host_ready');s.send({requestId:'native',operation:'advance'});await tick();
    s.send({requestId:'duplicate',operation:'advance'});const busy=await waitFor(s.rows,r=>r.requestId==='duplicate');
    assert.equal(busy.error.inFlight.stage,'check');assert.equal(busy.error.inFlight.call,null);
    const stage=busy.error.inFlight.nativeStage;assert.equal(stage.kind,'check');assert.equal(stage.deadlineMs-Date.parse(stage.startedAt),5000);
    s.send({type:'host_close',sessionId:ready.sessionId});assert.equal((await waitFor(s.rows,r=>r.type==='host_response')).code,'host_close_busy');
    resolve();await waitFor(s.rows,r=>r.requestId==='native');s.send({type:'host_close',sessionId:ready.sessionId});await s.serving;
  }finally{resolve();s.input.end();await s.serving;}
});
