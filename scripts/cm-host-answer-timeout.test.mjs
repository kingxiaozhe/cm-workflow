// R0: every bridge call has a deadline. A call without its own timeoutMs stops
// at the host answer limit; an answer that arrives after a call was stopped is
// refused as host_response_late with one diagnostic line.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostToolBridge,hostAnswerTimeoutMs,HOST_ANSWER_TIMEOUT_DEFAULT_MS,HOST_ANSWER_TIMEOUT_MAX_MS,
  HOST_ANSWER_BACKSTOP_MS} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

test('host answer limit: default 30 minutes, 1-60 minutes from CM_HOST_ANSWER_TIMEOUT_MINUTES, backstop above 60',()=>{
  assert.equal(hostAnswerTimeoutMs({}),HOST_ANSWER_TIMEOUT_DEFAULT_MS);
  assert.equal(HOST_ANSWER_TIMEOUT_DEFAULT_MS,30*60000);
  assert.equal(hostAnswerTimeoutMs({CM_HOST_ANSWER_TIMEOUT_MINUTES:'5'}),5*60000);
  assert.equal(hostAnswerTimeoutMs({CM_HOST_ANSWER_TIMEOUT_MINUTES:'60'}),HOST_ANSWER_TIMEOUT_MAX_MS);
  for(const bad of ['0','61','1.5','x','-1',' 5'])
    assert.throws(()=>hostAnswerTimeoutMs({CM_HOST_ANSWER_TIMEOUT_MINUTES:bad}),{code:'host_answer_timeout_invalid'},bad);
  assert.ok(HOST_ANSWER_BACKSTOP_MS>HOST_ANSWER_TIMEOUT_MAX_MS);
  assert.throws(()=>createHostToolBridge({answerTimeoutMs:HOST_ANSWER_BACKSTOP_MS+1}),{code:'host_answer_timeout_invalid'});
});

test('a call without its own timeout stops at the host answer limit and a late answer is refused with one diagnostic',async()=>{
  const bridge=createHostToolBridge({answerTimeoutMs:1000}),sent=[];
  bridge.attach(value=>{sent.push(value);});
  // The default deadline is unref'd; keep this test process alive while it runs.
  const keep=setInterval(()=>{},100);
  try{
    const started=Date.now();
    await assert.rejects(bridge.call('prd_generate',{fixture:true},new AbortController().signal),{code:'host_request_timeout'});
    assert.ok(Date.now()-started>=900);
    const request=sent.find(row=>row.type==='host_request');assert.ok(request);
    const lines=[],write=process.stderr.write;
    process.stderr.write=(chunk,...rest)=>{lines.push(String(chunk));return true;};
    let late;
    try{late=bridge.accept({type:'host_result',sessionId:request.sessionId,callId:request.callId,
      requestDigest:request.requestDigest,result:{status:'late'}});}
    finally{process.stderr.write=write;}
    assert.deepEqual(late,{accepted:false,code:'host_response_late'});
    const diagnostics=lines.filter(line=>line.includes('host_response_late'));
    assert.equal(diagnostics.length,1);
    assert.deepEqual(JSON.parse(diagnostics[0]),{diagnostic:'host_response_late',kind:'prd_generate',
      callId:request.callId,stoppedBy:'host_request_timeout'});
    // An answer for a call this bridge never issued stays a plain mismatch.
    assert.deepEqual(bridge.accept({type:'host_result',sessionId:request.sessionId,callId:'other',
      requestDigest:request.requestDigest,result:{}}),{accepted:false,code:'host_response_mismatch'});
  }finally{clearInterval(keep);bridge.close();}
});

test('an explicit per-call timeout still wins over the host answer limit',async()=>{
  const bridge=createHostToolBridge({answerTimeoutMs:60000});bridge.attach(()=>{});
  const started=Date.now();
  await assert.rejects(bridge.call('qa_assess',{},new AbortController().signal,{timeoutMs:50}),{code:'host_request_timeout'});
  assert.ok(Date.now()-started<5000);bridge.close();
});

test('a request that first runs project commands waits for the 60-minute maximum, not the general limit',async()=>{
  const bridge=createHostToolBridge({answerTimeoutMs:1000}),sent=[];bridge.attach(value=>{sent.push(value);});
  const keep=setInterval(()=>{},100);
  try{
    const pending=bridge.call('init_verify',{},new AbortController().signal);
    await new Promise(resolve=>setTimeout(resolve,1300));
    const request=sent.find(row=>row.type==='host_request');
    assert.deepEqual(bridge.accept({type:'host_result',sessionId:request.sessionId,callId:request.callId,
      requestDigest:request.requestDigest,result:{ok:true}}),{accepted:true,callId:request.callId});
    assert.deepEqual(await pending,{ok:true});
  }finally{clearInterval(keep);bridge.close();}
});
