import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {recordCmAiQaDecision} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'fixture',runId:'conversation-ops',taskId:'T-001',attempt:1};
const packageDigest='8'.repeat(64);
const operation=(name,requestId=name)=>({version:1,operation:name,requestId,identity,packageDigest,testRunId:null});
const control=name=>({version:1,operation:name,requestId:name,identity});

async function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-conversation-ops-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.login';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: finished\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  fs.writeFileSync(path.join(codeProject,'README.md'),'existing project\n');
  let current={state:'ready',code:null,identity,packageDigest},effects=0;
  let execute=async()=>{throw Error('unexpected runner effect');};
  const runner={status:()=>current,executeEffect:async effect=>{effects++;return execute(effect);},
    cancel:()=>current,run:async()=>current};
  const entry=extra=>createCmAiConversationEntry({specsDir,codeProject,feature,identity,runner,
    applicableAgentFiles:[],...extra});
  const complete=()=>{current={...current,state:'fixture_completed'};};
  const setStatus=(state,code,reason)=>{current={...current,state,code,...(reason?{reason}:{})};};
  const seedQa=()=>recordCmAiQaDecision({specsDir,codeProject,feature,identity,packageDigest,
    logHome:path.join(root,'logs'),decision:{decisionId:'qa-skipped',identity,packageDigest,
      status:'skipped',reason:'fixture',score:4,at:'2026-09-04T15:10:00-07:00'}});
  try{return await run({root,specsDir,codeProject,entry,complete,setStatus,seedQa,effects:()=>effects,
    setExecutor:fn=>{execute=fn;},setCompletionBlocks:fn=>{runner.completionBlocks=fn;},status:()=>current});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('A4 completion retry routes a new effect id through the same run',()=>fixture(async f=>{
  f.setStatus('blocked','completion_checks_changed');f.setCompletionBlocks(()=>1);
  let expectedId='complete-1-retry-1';
  f.setExecutor(effect=>{
    assert.equal(effect.kind,'complete');assert.equal(effect.id,expectedId);
    f.setStatus('fixture_completed',null);return f.status();
  });
  const entry=f.entry(),before=await entry.handle(control('status'));
  assert.equal(before.pendingAction,'complete');
  const result=await entry.handle({version:1,operation:'complete',requestId:'complete',identity,packageDigest});
  assert.equal(result.state,'fixture_completed',JSON.stringify(result));assert.equal(f.effects(),1);
  f.setStatus('blocked','completion_checks_changed');f.setCompletionBlocks(()=>2);
  expectedId='complete-1-retry-2';
  await entry.handle(control('advance'));
  assert.equal(f.effects(),2);
}));

test('check output block reaches operator status with paths and resume action',()=>fixture(async f=>{
  f.setStatus('blocked','check_output_out_of_scope','out_of_scope: build/product');
  const result=await f.entry().handle(control('status'));
  assert.equal(result.code,'check_output_out_of_scope');
  assert.equal(result.pendingAction,'resume');
  assert.equal(result.reason,'out_of_scope: build/product');
}));

test('context_refresh requires a completed task and returns its bound context summary',()=>fixture(async f=>{
  const request=operation('context_refresh');
  assert.equal((await f.entry().handle(request)).code,'context_not_ready');
  f.complete();f.seedQa();
  const result=await f.entry().handle(request);
  assert.deepEqual(result,{version:1,workflow:'cm-ai',operation:'context_refresh',requestDigest:digest(request),
    identity,outcome:'refreshed',state:'fixture_completed',code:'context_complete',packageDigest,
    pendingAction:'finish',nextTask:null,contextDigest:result.contextDigest,contextFiles:result.contextFiles});
  assert.match(result.contextDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.contextFiles.map(file=>file.path),[
    '1.login/design.md','1.login/requirements.md','1.login/tasks.md']);
  assert.equal(f.effects(),0);
}));

test('idle unknown cancel reports unchanged durable state',()=>fixture(async f=>{
  f.setStatus('unknown','reconciliation_required');
  const entry=f.entry(),result=await entry.handle(control('cancel'));
  assert.equal(result.outcome,'reported');
  assert.equal(result.state,'unknown');
  assert.equal(result.code,'reconciliation_required');
  assert.equal(result.pendingAction,'reconcile');
}));

test('cancel stops an in-flight advance on a completed runner',()=>fixture(async f=>{
  f.complete();
  const entry=f.entry(),advance=entry.handle(control('advance'));
  const cancelled=await entry.handle(control('cancel'));
  assert.equal(cancelled.outcome,'cancelled');
  assert.equal(cancelled.state,'fixture_completed');
  assert.equal((await advance).code,'cancelled');
}));

test('run_finalize requires documentation sync and returns the final outcome without runner effects',()=>fixture(async f=>{
  f.complete();f.seedQa();
  const refresh=await f.entry().handle(operation('context_refresh'));
  const request=operation('run_finalize');
  assert.equal((await f.entry().handle(request)).code,'run_not_ready');
  const documentationResult={syncId:'docs-completed',identity,packageDigest,contextDigest:refresh.contextDigest,
    status:'completed',reason:'documentation synced',at:'2026-09-04T15:20:00-07:00'};
  const result=await f.entry({documentationResult,qaLogHome:path.join(f.root,'logs')}).handle(request);
  assert.deepEqual(result,{version:1,workflow:'cm-ai',operation:'run_finalize',requestDigest:digest(request),
    identity,outcome:'finalized',state:'run_done',code:'run_done',packageDigest,pendingAction:'none',
    contextDigest:refresh.contextDigest,deduplicated:false,degraded:false});
  assert.equal(f.effects(),0);
}));
