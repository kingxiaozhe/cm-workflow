import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {hostDiagnostic} from './fixtures/host-diagnostic.mjs';

function fixture(){
  const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  let clock=10;const trace=hostDiagnostic(child,{timeoutMs:60000,now:()=>clock});
  return {child,trace,tick:ms=>{clock+=ms;}};
}
test('fixture diagnostics retain last stage, time budget and child exit without changing the failure',()=>{
  const {child,trace,tick}=fixture();trace.send({operation:'advance',requestId:'private-request'});tick(30);
  trace.receive({type:'host_request',kind:'develop',payload:{private:'source'}});tick(50);
  trace.receive({result:{state:'blocked',code:'develop_answer_missing'}});
  child.stderr.emit('data',Buffer.from('private stderr'));child.emit('close',7,'SIGTERM');
  const failure=new Error('fixture failure');assert.equal(trace.attach(failure),failure);
  const data=failure.diagnostic;
  assert.equal(data.timeoutMs,60000);assert.equal(data.elapsedMs,80);assert.equal(data.lastKind,'develop');
  assert.equal(data.lastState,'blocked');assert.equal(data.lastCode,'develop_answer_missing');
  assert.equal(data.exitCode,7);assert.equal(data.signal,'SIGTERM');assert.equal(data.closed,true);
  assert.equal(data.stderrBytes,14);assert.equal(data.lastOperation,'advance');
  assert(!JSON.stringify(data).includes('private'));
});
test('fixture diagnostics bound history and allowlist even hostile metadata',()=>{
  const {child,trace}=fixture(),secret='private-synthetic-secret';
  for(let i=0;i<80;i++)trace.receive({type:secret,kind:secret,requestId:secret,
    result:{state:secret,code:secret},payload:{text:secret}});
  child.stdout.emit('data',Buffer.from(secret));child.stderr.emit('data',Buffer.from(secret));child.emit('close',null,secret);
  const data=trace.snapshot();assert.equal(data.events.length,32);assert.equal(data.eventCount,80);
  assert.equal(data.lastKind,'other');assert.equal(data.lastCode,'other');assert.equal(data.signal,'other');
  assert(!JSON.stringify(data).includes(secret));assert(JSON.stringify(data).length<6000);
  data.events[0].kind=secret;assert(!JSON.stringify(trace.snapshot()).includes(secret));
});
