import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
const reply=(bridge,row,result={})=>bridge.accept({type:'host_result',sessionId:row.sessionId,
  callId:row.callId,requestDigest:row.requestDigest,result});

test('QA watchdog rejects late replies and old send failures cannot reject the next request',async()=>{
  const bridge=createHostToolBridge(),signal=new AbortController().signal,sent=[];let rejectOldSend;
  bridge.attach(row=>{if(row.type!=='host_request')return;sent.push(row);
    if(sent.length===1)return new Promise((_,reject)=>{rejectOldSend=reject;});});
  try{
    await assert.rejects(bridge.call('qa_logic',{},signal,{timeoutMs:10}),{code:'host_request_timeout'});
    assert.equal(getEventListeners(signal,'abort').length,0);
    const next=bridge.call('qa_logic',{},signal,{timeoutMs:1000});
    await Promise.resolve();rejectOldSend(Error('late failure'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(reply(bridge,sent[0]).accepted,false);
    assert.equal(reply(bridge,sent[1],{ok:true}).accepted,true);assert.deepEqual(await next,{ok:true});
    assert.equal(getEventListeners(signal,'abort').length,0);
  }finally{bridge.close();}
});

for(const mode of ['synchronous','cancel','close'])test(`QA watchdog cleanup: ${mode}`,async()=>{
  const bridge=createHostToolBridge(),controller=new AbortController();
  bridge.attach(row=>{if(row.type==='host_request'&&mode==='synchronous')reply(bridge,row,{ok:true});});
  const pending=bridge.call('qa_browser',{},controller.signal,{timeoutMs:20});
  if(mode==='cancel')controller.abort();if(mode==='close')bridge.close();
  if(mode==='synchronous')assert.deepEqual(await pending,{ok:true});
  else await assert.rejects(pending,{code:mode==='cancel'?'cancelled':'host_disconnected'});
  assert.equal(getEventListeners(controller.signal,'abort').length,0);bridge.close();
});
