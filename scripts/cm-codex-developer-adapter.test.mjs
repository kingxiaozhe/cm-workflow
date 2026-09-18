import test from 'node:test';
import {readFileSync} from 'node:fs';
import {validateClaudeProposal} from '../runtime/js/cm-ai/worker-claude-developer.mjs';
import assert from 'node:assert/strict';
import {requestFor,terminalFor,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import * as codex from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import * as claude from '../runtime/js/cm-ai/claude-developer-adapter.mjs';
import {validateDeveloperValue} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {invalidDeveloperCall} from '../runtime/js/cm-ai/durable-runner-state.mjs';

test('blocked reason is bounded for both providers while durable failure stays non-retryable',async()=>{
  for(const [provider,create,build] of [
    ['codex',codex.createCodexDeveloperRun,codex.buildCodexDeveloperPrompt],
    ['claude',claude.createClaudeDeveloperRun,claude.buildClaudeDeveloperPrompt],
  ])for(const learning of [false,true]){
    const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},feature='1.fixture',learningFiles=[];
    const r=requestFor({invocationId:'dev-1',identity,role:'developer',provider,requestedModel:'fixture',contextId:'developer',
      payload:{scope:['src/a.mjs'],requirements:[],priorReview:null,...(learning?{learningInput:{version:1,workflow:'cm-ai',
        phase:'task_learning_input',feature,identity,learningFiles,learningDigest:digest({version:1,feature,identity,files:learningFiles})}}:{})}});
    const value={outcome:'blocked',reason:'等待契约\nExpected stub throws'};
    assert.equal(validateDeveloperValue(value,r).reason,value.reason);
    assert(build(r).includes('A blocked result may include reason'));
    for(const reason of ['x'.repeat(1000),'界'.repeat(333)+'x',''])validateDeveloperValue({...value,reason},r);
    for(const reason of ['x'.repeat(1001),'界'.repeat(334),'NUL\0',12])assert.throws(()=>validateDeveloperValue({...value,reason},r));
    assert.throws(()=>validateDeveloperValue({...value,extra:true},r));
    assert.throws(()=>validateDeveloperValue({...value,outcome:'implemented'},r));
    const run=create({requestedModel:'fixture',worker:async()=>({status:'succeeded',value})});
    const result=await run(r,{signal:new AbortController().signal});
    assert.equal(result.status,'failed');assert.equal(result.result,null);
    assert.equal(invalidDeveloperCall({terminal:result.status}),false);
    assert.throws(()=>terminalFor({...result,result:{code:'developer_blocked',reason:value.reason}},r));
  }
});
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
  for(const response of [{status:'cancelled'},{status:'mystery'},{status:'unknown',detail:undefined},null]){
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
  const result=await run(request(),control());
  assert.equal(result.status,'failed');assert.deepEqual(result.result,{code:'invalid_result',reason:'invalid_result'});
  assert.throws(()=>buildCodexDeveloperPrompt(requestFor({...request(),payload:{...request().payload,scope:['../tasks.md']}})));
});

test('worker exceptions and timeout signals remain unknown',async()=>{
  for(const code of ['execution_error','call_timeout']){
    const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{throw Object.assign(new Error(code),{code});}});
    assert.equal((await run(request(),control())).status,'unknown');
  }
  const controller=new AbortController();
  const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
    controller.abort();return {status:'succeeded',value:{outcome:'implemented'}};
  }});
  assert.equal((await run(request(),{signal:controller.signal})).status,'unknown');
});

test('local value shape and Learning contract failures are explicit invalid_result',async()=>{
  const base=request(),feature='1.fixture',learningFiles=[];
  const learningDigest=digest({version:1,feature,identity:base.identity,files:learningFiles});
  const r=requestFor({...base,payload:{...base.payload,learningInput:{version:1,workflow:'cm-ai',
    phase:'task_learning_input',feature,identity:base.identity,learningDigest,learningFiles}}});
  const valid={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
  for(const value of [undefined,null,{}, {...valid,extra:true},{...valid,application:{status:'applied',note:null}},
    {...valid,retrospective:{status:'no_new_lesson',candidates:[],reason:'No lesson'}}]){
    const run=createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>({status:'succeeded',value})});
    const result=await run(r,control());assert.equal(result.status,'failed');
    assert.deepEqual(result.result,{code:'invalid_result',reason:'invalid_input'});
  }
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
  assert.throws(()=>validateDeveloperValue({outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:'No new lesson today'}},r),{code:'invalid_input'});
  assert.throws(()=>validateDeveloperValue({outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
  {...r,identity:{...r.identity,taskId:'T-002'}}),{code:'identity_mismatch'});
});
}

test('structured developer failures cannot broaden reviewer or unknown envelopes',()=>{
  const r=requestFor({invocationId:'review-1',identity:{repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},
    role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'reviewer',payload:{}});
  const raw={version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
    effectiveModel:'unknown',status:'failed',accepted:true,result:{code:'invalid_result',reason:'invalid_input'}};
  assert.throws(()=>terminalFor(raw,r));
  const dev={...r,role:'developer'};
  assert.throws(()=>terminalFor({...raw,status:'unknown'},dev));
  assert.throws(()=>terminalFor({...raw,result:{...raw.result,retryable:true}},dev));
  assert.throws(()=>terminalFor({...raw,result:{code:'made_up',reason:'invalid_input'}},dev));
});


test('nullable developer reason preserves outcome semantics with and without Learning',async()=>{
  for(const learning of [false,true])for(const provider of ['codex','claude']){
    const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},feature='1.fixture',learningFiles=[];
    const r=requestFor({invocationId:'dev-1',identity,role:'developer',provider,requestedModel:'fixture',contextId:'developer',
      payload:{scope:['src/a.mjs'],requirements:[],priorReview:null,...(learning?{learningInput:{version:1,workflow:'cm-ai',
        phase:'task_learning_input',feature,identity,learningFiles,learningDigest:digest({version:1,feature,identity,files:learningFiles})}}:{})}});
    for(const outcome of ['implemented','blocked'])for(const reason of [null,'Required module is missing']){
      const value={outcome,reason,...(learning?{application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}:{})};
      const transported=provider==='claude'?validateClaudeProposal({status:'succeeded',value,edits:[]}).value:value;
      assert.deepEqual(transported,value);
      const invalid=outcome==='implemented'&&reason!==null;
      if(invalid)assert.throws(()=>validateDeveloperValue(transported,r));
      else if(reason===null){
        const {reason:omitted,...withoutReason}=value;
        assert.deepEqual(validateDeveloperValue(transported,r),validateDeveloperValue(withoutReason,r));
        assert.equal(value.reason,null); // Validation does not mutate worker output.
      }else assert.equal(validateDeveloperValue(transported,r).reason,reason);
      const create=provider==='codex'?codex.createCodexDeveloperRun:claude.createClaudeDeveloperRun;
      const result=await create({requestedModel:'fixture',worker:async()=>({status:'succeeded',value:transported})})(r,{signal:new AbortController().signal});
      assert.equal(result.status,outcome==='implemented'&&!invalid?'succeeded':'failed');
      if(invalid)assert.equal(result.result.code,'invalid_result');
      else if(outcome==='blocked'){
        assert.equal(result.result,null);
        assert.equal(result.blockedReason,reason===null?undefined:reason);
      }
    }
  }
});

test('developer schemas expose nullable reason without relaxing strict object shapes',()=>{
  for(const name of ['codex-developer-basic-output','codex-developer-output','claude-developer-proposal']){
    const schema=JSON.parse(readFileSync(new URL(`../runtime/js/cm-ai/${name}.schema.json`,import.meta.url),'utf8'));
    const value=name.startsWith('claude')?schema.properties.value:schema;
    assert.deepEqual(value.properties.reason,{type:['string','null']});
    assert.equal(schema.additionalProperties,false);
    assert.equal(value.additionalProperties,false);
    if(name.startsWith('codex'))assert.deepEqual([...value.required].sort(),Object.keys(value.properties).sort());
    else assert.deepEqual(value.required,['outcome']);
  }
});
