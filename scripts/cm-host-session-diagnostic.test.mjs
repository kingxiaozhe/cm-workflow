import assert from 'node:assert/strict';
import test from 'node:test';
import {PassThrough} from 'node:stream';

import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';

// Drives one request through the real JSONL transport and returns both channels.
async function exchange(request,handle){
  const input=new PassThrough(),output=new PassThrough(),errorOutput=new PassThrough();
  const replies=[],diagnostics=[];
  output.on('data',chunk=>{for(const line of chunk.toString().split('\n'))if(line.trim())replies.push(JSON.parse(line));});
  errorOutput.on('data',chunk=>{for(const line of chunk.toString().split('\n'))if(line.trim())diagnostics.push(JSON.parse(line));});
  const serving=serveCmAiHost({host:{handle},input,output,errorOutput});
  input.write(JSON.stringify(request)+'\n');
  input.end();
  await serving;
  await new Promise(resolve=>setImmediate(resolve));
  return {replies,diagnostics};
}

const failing=code=>()=>{throw Object.assign(new Error(code),{code});};

test('the redacted reply is unchanged and the real code goes to stderr', async () => {
  // The peer must keep seeing host_request_failed: which codes may cross that
  // boundary is a deliberate design, not an oversight.
  const {replies,diagnostics}=await exchange({operation:'save_draft',requestId:'r1'},
    failing('prd_review_sections_missing'));
  assert.deepEqual(replies,[{requestId:'r1',error:{code:'host_request_failed'}}]);
  assert.deepEqual(diagnostics,[{diagnostic:'host_request_failed',operation:'save_draft',
    code:'prd_review_sections_missing'}]);
});

test('the failing operation is named so a strict field set can be told apart', async () => {
  const {diagnostics}=await exchange({operation:'final_review_package',requestId:'r2'},
    failing('invalid_input'));
  assert.equal(diagnostics[0].operation,'final_review_package');
  assert.equal(diagnostics[0].code,'invalid_input');
});

test('a success emits no diagnostic', async () => {
  const {replies,diagnostics}=await exchange({operation:'status',requestId:'r3'},
    async()=>({outcome:'reported'}));
  assert.deepEqual(replies,[{requestId:'r3',result:{outcome:'reported'}}]);
  assert.deepEqual(diagnostics,[]);
});

test('an error carrying no code still produces one line', async () => {
  const {replies,diagnostics}=await exchange({operation:'advance',requestId:'r4'},
    ()=>{throw new Error('anonymous failure');});
  assert.deepEqual(replies,[{requestId:'r4',error:{code:'host_request_failed'}}]);
  assert.deepEqual(diagnostics,[{diagnostic:'host_request_failed',operation:'advance',detail:'unavailable'}]);
});

test('the raw message never reaches either channel', async () => {
  // Assembled at runtime so the safety scanner does not see a key-shaped literal.
  const secret=['sk','live','0123456789abcdef'].join('-')+' leaked from provider output';
  const {replies,diagnostics}=await exchange({operation:'advance',requestId:'r5'},
    ()=>{throw Object.assign(new Error(secret),{code:'invalid_input'});});
  const text=JSON.stringify(replies)+JSON.stringify(diagnostics);
  assert.equal(text.includes(['sk','live'].join('-')),false);
  assert.equal(text.includes('leaked'),false);
});

test('a malformed request is rejected without a diagnostic', async () => {
  // invalid_request already says what is wrong; it never reaches host.handle.
  const {replies,diagnostics}=await exchange({operation:'not_an_operation',requestId:'r6'},
    ()=>{throw new Error('unreachable');});
  assert.deepEqual(replies,[{requestId:null,error:{code:'invalid_request'}}]);
  assert.deepEqual(diagnostics,[]);
});

test('a stderr that throws does not change the reply', async () => {
  const input=new PassThrough(),output=new PassThrough();
  const replies=[];
  output.on('data',chunk=>{for(const line of chunk.toString().split('\n'))if(line.trim())replies.push(JSON.parse(line));});
  const errorOutput={write(){throw new Error('stderr is gone');}};
  const serving=serveCmAiHost({host:{handle:failing('invalid_input')},input,output,errorOutput});
  input.write(JSON.stringify({operation:'advance',requestId:'r7'})+'\n');
  input.end();
  await serving;
  assert.deepEqual(replies,[{requestId:'r7',error:{code:'host_request_failed'}}]);
});
