import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const reconnect = n => ({type:'error',message:`Reconnecting... ${n}/5 (stream disconnected before completion: synthetic)`});
const start = [{type:'thread.started',thread_id:'synthetic-reconnect'},{type:'turn.started'}];
const finish = [{type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed'}];

async function stream(rows,{throwNotice=false}={}) {
  const options={cwd:'/fixture',model:'fixture',effort:'high'},events=[],notices=[],terminals=[],diagnostics=[];
  let kills=0;
  const run=codexWorker({...options,schemaPath:'/unused',timeoutMs:1000,
    preflight:{passed:true,cli_model:options.model,config_fingerprint:configFingerprint(options)},
    onNotice:notice=>{notices.push(notice);if(throwNotice)throw Error('synthetic notice sink failure');},
    onDiagnostic:diagnostic=>diagnostics.push(diagnostic),
    spawnProcess(){
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      let closed=false;
      const close=()=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',0,null);};
      child.kill=()=>{kills++;queueMicrotask(close);return true;};
      queueMicrotask(()=>{
        for(const row of rows){if(kills)break;child.stdout.write(JSON.stringify(row)+'\n');}
        close();
      });
      return child;
    }});
  const result=await run({prompt:'synthetic reconnect test'},{signal:new AbortController().signal,
    onEvent:event=>events.push(event),onTerminal:terminal=>terminals.push(terminal)});
  return {result,events,notices,terminals,diagnostics,kills};
}

test('Codex reconnect 2/5 through 5/5 followed by HTTPS fallback succeeds',async()=>{
  const notices=[2,3,4,5].map(reconnect);
  const fallback={type:'item.completed',item:{type:'error',message:'Falling back to HTTPS transport. synthetic'}};
  const actual=await stream([...start,...notices,fallback,...finish]);
  assert.deepEqual(actual.result,{status:'succeeded',value:{ok:true}});
  assert.deepEqual(actual.notices,[...notices.map(row=>row.message),fallback.item.message]);
  assert.deepEqual(actual.events.map(row=>row.event),['thread.started','turn.started','item.completed','turn.completed','process_closed']);
  assert.deepEqual(actual.terminals,[{status:'succeeded',value:{ok:true}}]);
  assert.deepEqual(actual.diagnostics,[]);
});

test('Codex reconnect notices cannot hide a later turn.failed',async()=>{
  const actual=await stream([...start,reconnect(2),reconnect(3),{type:'turn.failed',error:{message:'request failed'}}]);
  assert.deepEqual(actual.result,{status:'failed',code:'provider_failed'});
  assert.equal(actual.notices.length,2);
  assert.deepEqual(actual.events.filter(row=>['error','turn.failed'].includes(row.event)).map(row=>row.event),['turn.failed']);
  assert.deepEqual(actual.terminals,[{status:'failed',code:'provider_failed'}]);
});

test('Codex non-reconnect top-level errors remain fatal',async()=>{
  for(const message of ['request failed','prefix Reconnecting... 2/5','Reconnecting.. 2/5','Reconnecting... two/5',null]){
    const actual=await stream([...start,{type:'error',message},...finish]);
    assert.deepEqual(actual.result,{status:'failed',code:'provider_failed'});
    assert.deepEqual(actual.notices,[]);
    assert.equal(actual.events.find(row=>row.event==='error').event,'error');
  }
});

test('Codex reconnect limit allows 32 notices independently of eight item notices',async()=>{
  const reconnects=Array.from({length:32},(_,n)=>reconnect(n+1));
  const items=Array.from({length:8},()=>({type:'item.completed',item:{type:'error',message:'synthetic startup notice'}}));
  const actual=await stream([...start,...reconnects,...items,...finish]);
  assert.deepEqual(actual.result,{status:'succeeded',value:{ok:true}});
  assert.equal(actual.notices.length,40);
});

test('Codex reconnect notice 33 fails instead of allowing an endless stream',async()=>{
  const actual=await stream([...start,...Array.from({length:33},(_,n)=>reconnect(n+1)),...finish]);
  assert.deepEqual(actual.result,{status:'failed',code:'provider_failed'});
  assert.equal(actual.notices.length,32);
  assert.equal(actual.events.filter(row=>row.event==='error').length,1);
  assert.deepEqual(actual.terminals,[{status:'failed',code:'provider_failed'}]);
});

test('Codex reconnect notices are bounded and notice sink failure does not fail a turn',async()=>{
  const notice={...reconnect(1),message:reconnect(1).message+'x'.repeat(400)};
  const actual=await stream([...start,notice,...finish],{throwNotice:true});
  assert.deepEqual(actual.result,{status:'succeeded',value:{ok:true}});
  assert.deepEqual(actual.notices,[notice.message.slice(0,200)]);
});

// 2026-10-26: a real Codex review ended with this pair after its own retries.
// The class is kept, never the provider text; other errors stay provider_failed.
const limited='exceeded retry limit, last status: 429 Too Many Requests';
test('Codex 429 / Too Many Requests / rate limit ends as reviewer_rate_limited (class only, no text)',async()=>{
  for(const rows of [
    [{type:'error',message:limited},{type:'turn.failed',error:{message:limited}}],
    [{type:'turn.failed',error:{message:limited}}],
    [{type:'error',message:'stream error: Too Many Requests'}],
    [{type:'error',message:'Rate limit reached for requests'},{type:'turn.failed',error:{message:'request failed'}}],
  ]){
    const actual=await stream([...start,...rows]);
    assert.deepEqual(actual.result,{status:'failed',code:'reviewer_rate_limited'},JSON.stringify(rows));
    assert.deepEqual(actual.terminals,[{status:'failed',code:'reviewer_rate_limited'}]);
    assert(!JSON.stringify(actual.events).includes('429'),'no provider text in published events');
  }
});

test('Codex failure naming only the HTTP status 429 is a rate limit',async()=>{
  for(const message of ['unexpected status HTTP 429','HTTP 429']){
    const actual=await stream([...start,{type:'error',message},{type:'turn.failed',error:{message}}]);
    assert.deepEqual(actual.result,{status:'failed',code:'reviewer_rate_limited'},message);
  }
});

test('Codex non-rate-limit failures stay provider_failed; a 429 reconnect notice that recovers still succeeds',async()=>{
  for(const message of ['request failed','status 500 Internal Server Error','error 4290 unrelated id']){
    const actual=await stream([...start,{type:'error',message},{type:'turn.failed',error:{message}}]);
    assert.deepEqual(actual.result,{status:'failed',code:'provider_failed'},message);
    assert.deepEqual(actual.terminals,[{status:'failed',code:'provider_failed'}]);
  }
  const notice={type:'error',message:'Reconnecting... 1/5 (unexpected status 429 Too Many Requests)'};
  const recovered=await stream([...start,notice,...finish]);
  assert.deepEqual(recovered.result,{status:'succeeded',value:{ok:true}});
});
