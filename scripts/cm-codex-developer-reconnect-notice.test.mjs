import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexDeveloperWorker} from '../runtime/js/cm-ai/worker-codex-developer.mjs';

const reconnect=n=>({type:'error',message:`Reconnecting... ${n}/5 (stream disconnected before completion: synthetic)`});
const start=[{type:'thread.started',thread_id:'synthetic-developer-reconnect'},{type:'turn.started'}];
const finish=[{type:'item.completed',item:{type:'agent_message',text:'{"outcome":"implemented"}'}},{type:'turn.completed'}];
const succeeded={status:'succeeded',value:{outcome:'implemented'},providerThread:'synthetic-developer-reconnect'};

async function stream(rows,{throwNotice=false}={}){
  const notices=[];
  const run=codexDeveloperWorker({cwd:'/fixture',model:'gpt-6.1-sol',effort:'high',learning:false,timeoutMs:1000,
    onNotice:notice=>{notices.push(notice);if(throwNotice)throw Error('synthetic notice sink failure');},
    spawnProcess(){
      const child=new EventEmitter();
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      queueMicrotask(()=>{
        for(const row of rows)child.stdout.write(JSON.stringify(row)+'\n');
        child.stdout.end();child.stderr.end();child.emit('close',0,null);
      });
      return child;
    }});
  const result=await run({prompt:'synthetic developer reconnect test'},{signal:new AbortController().signal});
  return {result,notices};
}

test('developer reconnect 2/5 through 5/5 followed by HTTPS fallback succeeds',async()=>{
  const reconnects=[2,3,4,5].map(reconnect);
  const fallback={type:'item.completed',item:{type:'error',message:'Falling back to HTTPS transport. synthetic'}};
  const actual=await stream([...start,...reconnects,fallback,...finish]);
  assert.deepEqual(actual.result,succeeded);
  assert.deepEqual(actual.notices,[...reconnects.map(row=>row.message),fallback.item.message]);
});

test('developer reconnect notices cannot hide a later turn.failed',async()=>{
  const actual=await stream([...start,reconnect(2),reconnect(3),{type:'turn.failed',error:{message:'Reconnecting... 4/5'}}]);
  assert.deepEqual(actual.result,{status:'unknown',code:'provider_failed'});
  assert.deepEqual(actual.notices,[reconnect(2).message,reconnect(3).message]);
});

test('developer non-reconnect top-level errors remain fatal',async()=>{
  for(const message of ['request failed','prefix Reconnecting... 2/5','Reconnecting.. 2/5','Reconnecting... two/5',null]){
    const actual=await stream([...start,{type:'error',message},...finish]);
    assert.deepEqual(actual.result,{status:'unknown',code:'provider_failed'});
    assert.deepEqual(actual.notices,[]);
  }
});

test('developer reconnect limit allows 32 notices independently of eight item notices',async()=>{
  const reconnects=Array.from({length:32},(_,n)=>reconnect(n+1));
  const items=Array.from({length:8},()=>({type:'item.completed',item:{type:'error',message:'synthetic startup notice'}}));
  const actual=await stream([...start,...reconnects,...items,...finish]);
  assert.deepEqual(actual.result,succeeded);
  assert.deepEqual(actual.notices,[...reconnects.map(row=>row.message),...items.map(row=>row.item.message)]);
});

test('developer reconnect notice 33 fails instead of allowing an endless stream',async()=>{
  const actual=await stream([...start,...Array.from({length:33},(_,n)=>reconnect(n+1)),...finish]);
  assert.deepEqual(actual.result,{status:'unknown',code:'provider_failed'});
  assert.deepEqual(actual.notices,Array.from({length:32},(_,n)=>reconnect(n+1).message));
});

test('developer reconnect notices are bounded and notice sink failure does not fail a turn',async()=>{
  const notice={...reconnect(1),message:reconnect(1).message+'x'.repeat(400)};
  const actual=await stream([...start,notice,...finish],{throwNotice:true});
  assert.deepEqual(actual.result,succeeded);
  assert.deepEqual(actual.notices,[notice.message.slice(0,200)]);
});

test('developer reconnect before thread may recover but cannot replace thread initialization',async()=>{
  const recovered=await stream([reconnect(1),...start,...finish]);
  assert.deepEqual(recovered.result,succeeded);
  assert.deepEqual(recovered.notices,[reconnect(1).message]);
  const missing=await stream([reconnect(1),{type:'turn.started'},...finish]);
  assert.deepEqual(missing.result,{status:'unknown',code:'thread_missing'});
  assert.deepEqual(missing.notices,[reconnect(1).message]);
});

test('developer reconnect after completion remains fatal without emitting a notice',async()=>{
  const actual=await stream([...start,...finish,reconnect(1)]);
  assert.deepEqual(actual.result,{status:'unknown',code:'provider_failed'});
  assert.deepEqual(actual.notices,[]);
});

test('developer reconnect does not reset or bypass existing item and turn guards',async()=>{
  const item={type:'item.completed',item:{type:'error',message:'synthetic startup notice'}};
  for(const [rows,code] of [
    [[...start,...Array(8).fill(item),reconnect(1),item,...finish],'invalid_event'],
    [[start[0],reconnect(1),...finish],'turn_missing'],
    [[...start,reconnect(1),start[0],...finish],'thread_mismatch'],
    [[...start,reconnect(1),start[1],...finish],'duplicate_turn'],
  ]){
    const actual=await stream(rows);
    assert.deepEqual(actual.result,{status:'unknown',code});
  }
});
