import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';

// The parser's optional registry must never touch the real user's CM home.
const isolated=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-revision-transport-')));
const previous={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(isolated,{recursive:true,force:true});});

// One real ready/request/reply/EOF exchange. Only the owner is a routing spy:
// no run is opened, no commands execute, and no provider or Review is invoked.
async function exchange(operation,{permissions=[]}={}){
  const calls=[],effects=[],handled=[],rows=[],diagnostics=[];
  const request={requestId:'revision-check',operation};
  const owner={
    async runRevisionTests(options){
      calls.push({method:'runRevisionTests',options});
      if(options.authorized!==true)throw Object.assign(new Error('regression_authorization_required'),{code:'regression_authorization_required'});
      effects.push('revision-test-check');return {stage:'revision_repair_required',fixture:'routing-only',completionEligible:false};
    },
    async runRegression(options){calls.push({method:'runRegression',options});return {stage:'handoff_required',fixture:'existing-routing-only'};},
  };
  const realHost=createFixHost({owner,config:{},permissions});
  const host={handle(raw){handled.push(raw);return realHost.handle(raw);}};
  const input=new PassThrough(),toolBridge=createHostToolBridge({answerTimeoutMs:1000});
  const output=new Writable({write(chunk,encoding,done){
    try{
      const row=JSON.parse(chunk.toString());rows.push(row);
      if(row.type==='host_ready')setImmediate(()=>input.write(JSON.stringify(request)+'\n'));
      else if(Object.hasOwn(row,'requestId'))setImmediate(()=>input.end());
      done();
    }catch(error){done(error);}
  }});
  const errorOutput=new Writable({write(chunk,encoding,done){try{diagnostics.push(JSON.parse(chunk.toString()));done();}catch(error){done(error);}}});
  const timer=setTimeout(()=>input.destroy(new Error('fixture_response_timeout')),3000);
  try{await serveCmAiHost({host,input,output,errorOutput,toolBridge,heartbeat:false});}
  finally{clearTimeout(timer);toolBridge.close();input.destroy();output.destroy();errorOutput.destroy();}
  assert.equal(rows.filter(row=>row.type==='host_ready').length,1);
  return {request,replies:rows.filter(row=>Object.hasOwn(row,'requestId')),calls,effects,handled,diagnostics};
}

test('revision test check crosses the real JSONL parser and exact permission-gated fix host route',async()=>{
  const out=await exchange('revision_test_check',{permissions:['--allow-regression']});
  assert.deepEqual(out.replies,[{requestId:'revision-check',result:{stage:'revision_repair_required',fixture:'routing-only',completionEligible:false}}],
    'CM_REVISION_TRANSPORT: an existing revision_test_check operation must reach the real host instead of invalid_request');
  assert.deepEqual(out.handled,[out.request]);
  assert.deepEqual(out.calls,[{method:'runRevisionTests',options:{authorized:true}}]);
  assert.deepEqual(out.effects,['revision-test-check']);assert.deepEqual(out.diagnostics,[]);
});

test('revision test check without the existing regression permission cannot perform revision work',async()=>{
  const out=await exchange('revision_test_check');
  assert.deepEqual(out.replies,[{requestId:'revision-check',error:{code:'host_request_failed'}}]);
  assert.deepEqual(out.handled,[out.request]);
  assert.deepEqual(out.calls,[{method:'runRevisionTests',options:{authorized:false}}]);
  assert.deepEqual(out.effects,[]);
  assert.equal(out.diagnostics.length,1);assert.equal(out.diagnostics[0].operation,'revision_test_check');
  assert.equal(out.diagnostics[0].code,'regression_authorization_required');
});

test('nearby invalid revision operation names are rejected by the parser before the host',async()=>{
  for(const operation of ['revision_tests_check','revision_test_check_required','revision-test-check','revision_test_check ']){
    const out=await exchange(operation,{permissions:['--allow-regression']});
    assert.deepEqual(out.replies,[{requestId:null,error:{code:'invalid_request'}}],operation);
    assert.deepEqual(out.handled,[]);assert.deepEqual(out.calls,[]);assert.deepEqual(out.effects,[]);assert.deepEqual(out.diagnostics,[]);
  }
});

test('the existing regression operation keeps its JSONL route and permission argument',async()=>{
  const out=await exchange('regression',{permissions:['--allow-regression']});
  assert.deepEqual(out.replies,[{requestId:'revision-check',result:{stage:'handoff_required',fixture:'existing-routing-only'}}]);
  assert.deepEqual(out.handled,[out.request]);
  assert.deepEqual(out.calls,[{method:'runRegression',options:{authorized:true}}]);assert.deepEqual(out.effects,[]);assert.deepEqual(out.diagnostics,[]);
});
