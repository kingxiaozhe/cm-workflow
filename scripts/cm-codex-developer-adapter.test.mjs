import test from 'node:test';
import assert from 'node:assert/strict';
import {requestFor,terminalFor,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import * as codex from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import * as claude from '../runtime/js/cm-ai/claude-developer-adapter.mjs';
for(const [provider,createCodexDeveloperRun,buildCodexDeveloperPrompt] of [
  ['codex',codex.createCodexDeveloperRun,codex.buildCodexDeveloperPrompt],
  ['claude',claude.createClaudeDeveloperRun,claude.buildClaudeDeveloperPrompt],
]){
const request=()=>requestFor({invocationId:'dev-1',identity:{repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},
  role:'developer',provider,requestedModel:'fixture',contextId:'developer',
  payload:{scope:['src/a.mjs'],requirements:[],priorReview:null}});
const control=()=>({signal:new AbortController().signal});

test('developer result binds to runner request, not worker identity claims',async()=>{
  const r=request();let captured;
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async(p,c)=>{
    captured={p,c};return {status:'succeeded',value:{outcome:'implemented'},effectiveModel:'forged'};
  }});
  const c=control(),result=await run(r,c);
  assert.equal(terminalFor(result,r).effectiveModel,'unknown');
  assert.equal(result.provider,provider);
  assert.equal(result.status,'succeeded');assert.equal(captured.c,c);
  assert.deepEqual(Object.keys(captured.p),['prompt']);
  assert(captured.p.prompt.includes('Do not commit'));assert(captured.p.prompt.includes('src/a.mjs'));
});

test('invalid digest, role, model and cancelled input never reach worker',async()=>{
  let calls=0;const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{calls++;}});
  await assert.rejects(run({...request(),requestDigest:'0'.repeat(64)},control()));
  await assert.rejects(run(requestFor({...request(),role:'reviewer'}),control()));
  await assert.rejects(run(requestFor({...request(),requestedModel:'other'}),control()));
  await assert.rejects(run(requestFor({...request(),provider:provider==='codex'?'claude':'codex'}),control()));
  const ac=new AbortController();ac.abort();await assert.rejects(run(request(),{signal:ac.signal}),{code:'cancelled'});
  assert.equal(calls,0);
});

test('provider ambiguity is unknown and is not retried',async()=>{
  for(const response of [{status:'cancelled'},{status:'mystery'},null]){
    let calls=0;const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{calls++;return response;}});
    // Invalid JSON terminal shape is also ambiguous, not successful.
    const result=await run(request(),control());assert.equal(result.status,'unknown');assert.equal(calls,1);
  }
});

test('host-owned instructions and workflow evidence never reach the developer',async()=>{
  let calls=0;
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{calls++;}});
  for(const p of ['AGENTS.md','nested/agents.md','.claude/settings.json','.codex/hooks.json',
    '.git/config','CLAUDE.md','tasks.md','specs/运行日志.jsonl','.reviews/r1.md','nested/.cm-run.json']){
    const base=request();
    const r=requestFor({...base,payload:{...base.payload,scope:[p]}});
    await assert.rejects(run(r,control()),{code:'protected_scope'});
  }
  assert.equal(calls,0);
  assert.match(buildCodexDeveloperPrompt(request()),/src\/a.mjs/);
});

test('developer cannot return a completion envelope as implementation',async()=>{
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>({status:'succeeded',value:{outcome:'completed'}})});
  await assert.rejects(run(request(),control()),{code:'invalid_result'});
  assert.throws(()=>buildCodexDeveloperPrompt(requestFor({...request(),payload:{...request().payload,scope:['../tasks.md']}})));
});

test('explicit blocked implementation returns failure, never completion',async()=>{
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>({status:'succeeded',value:{outcome:'blocked'}})});
  const result=await run(request(),control());
  assert.equal(result.status,'failed');assert.equal(result.result,null);
});

test('Learning observations use existing constructors for task-bound evidence',async()=>{
  const base=request(),feature='1.fixture',learningFiles=[];
  const learningDigest=digest({version:1,feature,identity:base.identity,files:learningFiles});
  const r=requestFor({...base,payload:{...base.payload,learningInput:{version:1,workflow:'cm-ai',
    phase:'task_learning_input',feature,identity:base.identity,learningDigest,learningFiles}}});
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>({status:'succeeded',value:{
    outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:null}}})});
  const {result}=await run(r,control());
  assert.equal(result.application.learningDigest,learningDigest);
  assert.deepEqual(result.application.identity,base.identity);
  assert.equal(result.retrospective.feature,feature);
  const {applicationDigest,...body}=result.application;assert.equal(applicationDigest,digest(body));
});
}
