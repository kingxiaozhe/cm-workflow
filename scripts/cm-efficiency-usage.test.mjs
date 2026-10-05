import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createProviderUsageCapture,readProviderUsage} from '../runtime/js/cm-ai/provider-usage.mjs';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {codexDeveloperWorker} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
import {claudeDeveloperWorker} from '../runtime/js/cm-ai/worker-claude-developer.mjs';
import {createNativeUsageLog} from '../runtime/js/cm-ai/native-usage-log.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
test('official usage has exact counts, optional fields unavailable and no reasoning/cache double count',()=>{
  assert.deepEqual(readProviderUsage('codex',{input_tokens:100,output_tokens:20,cached_input_tokens:70,output_tokens_details:{reasoning_tokens:5}}),
    {usage_state:'observed',input_tokens:100,output_tokens:20,cache_read_tokens:70,reasoning_tokens:5});
  assert.deepEqual(readProviderUsage('claude',{input_tokens:10,output_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:30}),
    {usage_state:'observed',input_tokens:10,output_tokens:20,cache_read_tokens:70,cache_write_tokens:30});
  assert.deepEqual(readProviderUsage('codex',{input_tokens:100,output_tokens:20}),{usage_state:'observed',input_tokens:100,output_tokens:20});
  for(const raw of [undefined,null,{}, {input_tokens:'100',output_tokens:20},{input_tokens:1,output_tokens:2,cached_input_tokens:3},
    {input_tokens:100,output_tokens:20,output_tokens_details:{reasoning_tokens:21}}])assert.deepEqual(readProviderUsage('codex',raw),{usage_state:'unavailable'});
});
test('duplicate terminal usage is emitted once; conflicting counters and missing usage stay unavailable',()=>{
  const rows=[],capture=createProviderUsageCapture('codex',row=>rows.push(row));
  capture.terminal({input_tokens:1,output_tokens:2});capture.terminal({input_tokens:1,output_tokens:2});capture.complete();capture.complete();assert.equal(rows.length,1);
  const other=createProviderUsageCapture('codex',row=>rows.push(row));other.terminal({input_tokens:1,output_tokens:2});other.terminal({input_tokens:1,output_tokens:3});other.complete();
  assert.deepEqual(rows[1],{usage_state:'unavailable'});createProviderUsageCapture('codex',row=>rows.push(row)).complete();assert.deepEqual(rows[2],{usage_state:'unavailable'});
});
for(const provider of ['codex','claude'])for(const role of ['reviewer','developer'])for(const present of [true,false])
test(`${provider} ${role} actual fake process captures ${present?'native usage':'missing usage'} once and ignores answer counters`,async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-usage-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const rows=[],claims=[];
  const value=role==='reviewer'?{verdict:'approved',packageDigest:'a'.repeat(64),examinedPaths:['file'],findings:[],summary:'Synthetic test',input_tokens:999999}:
    {status:'succeeded',value:{outcome:'implemented',reason:null},edits:[]};
  // Codex developer expects its value, Claude developer expects the complete proposal.
  const answer=provider==='codex'&&role==='developer'?value.value:value;
  const usage=present?{input_tokens:100,output_tokens:20,...(provider==='codex'?{cached_input_tokens:70}:{cache_read_input_tokens:70})}:undefined;
  const events=provider==='codex'?[{type:'thread.started',thread_id:'synthetic-thread'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(answer)}},{type:'turn.completed',...(usage?{usage}:{})}]:
    [{type:'system',subtype:'init',session_id:'synthetic-session'},
      {type:'assistant',session_id:'synthetic-session',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:JSON.stringify(answer)}]}},
      {type:'result',subtype:'success',session_id:'synthetic-session',is_error:false,num_turns:1,result:JSON.stringify(answer),structured_output:answer,...(usage?{usage}:{})}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`);
  const spawnProcess=(_cli,_args,options)=>spawn(process.execPath,[script],options);
  const opts={cwd,model:'fixture',spawnProcess,onUsage:row=>rows.push(row),onUsageClaim:()=>claims.push('original-dispatch'),timeoutMs:3000};
  const preflight=provider==='codex'?{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint(opts)}:
    {passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(opts)};
  // Codex fingerprint includes prompt transport, set before computing it.
  if(provider==='codex')preflight.config_fingerprint=configFingerprint({...opts,promptTransport:'stdin'});
  const worker=role==='developer'?(provider==='codex'?codexDeveloperWorker:claudeDeveloperWorker)(opts):
    (provider==='codex'?codexWorker:claudeWorker)({...opts,preflight,promptTransport:'stdin',schemaPath:'synthetic-schema'});
  const result=await worker({prompt:'Synthetic only'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(claims.length,1);assert.equal(rows.length,1);
  assert.deepEqual(rows[0],present?{usage_state:'observed',input_tokens:100,output_tokens:20,cache_read_tokens:70}:{usage_state:'unavailable'});
  await worker({prompt:'Second dispatch denied'},{signal:new AbortController().signal,onEvent:()=>{}});assert.equal(rows.length,1);assert.equal(claims.length,1);
});

for(const present of [true,false])test(`Claude developer failed original terminal ${present?'records':'lacks'} official usage and never succeeds`,async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-failed-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const rows=[];
  const events=[{type:'system',subtype:'init',session_id:'original-session'},
    {type:'result',subtype:'error_max_turns',session_id:'original-session',is_error:true,num_turns:1,...(present?{usage:{input_tokens:100,output_tokens:20}}:{})}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`);
  const worker=claudeDeveloperWorker({cwd,model:'fixture',timeoutMs:3000,onUsage:row=>rows.push(row),spawnProcess:(_cli,_args,options)=>spawn(process.execPath,[script],options)});
  const result=await worker({prompt:'Synthetic failed execution'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.equal(result.status,'unavailable');assert.equal(result.code,'provider_failed');assert.equal(rows.length,1);
  assert.deepEqual(rows[0],present?{usage_state:'observed',input_tokens:100,output_tokens:20}:{usage_state:'unavailable'});
});
test('Codex native optional components are preserved, missing remain unavailable and conflicts rejected',()=>{
  assert.deepEqual(readProviderUsage('codex',{input_tokens:100,output_tokens:20,cached_input_tokens:70,cache_write_input_tokens:4,reasoning_output_tokens:5}),
    {usage_state:'observed',input_tokens:100,output_tokens:20,cache_read_tokens:70,cache_write_tokens:4,reasoning_tokens:5});
  assert.deepEqual(readProviderUsage('codex',{input_tokens:100,output_tokens:20,reasoning_output_tokens:21}),{usage_state:'unavailable'});
  assert.deepEqual(readProviderUsage('codex',{input_tokens:100,output_tokens:20,reasoning_output_tokens:5,output_tokens_details:{reasoning_tokens:6}}),{usage_state:'unavailable'});
});

for(const provider of ['codex','claude'])for(const role of ['reviewer','developer'])for(const present of [true,false])
test(`${provider} ${role} actual original failure terminal preserves ${present?'usage':'unavailable'} without success or redispatch`,async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-terminal-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const rows=[],claims=[],usage=present?{input_tokens:100,output_tokens:20}:undefined;
  const events=provider==='codex'?[{type:'thread.started',thread_id:'original-thread'},{type:'turn.started'},
    {type:'error',message:'Synthetic original failure',usage:{input_tokens:999999,output_tokens:999999}},
    {type:'turn.failed',error:{message:'Synthetic original failure'},...(usage?{usage}:{})}]:
    [{type:'system',subtype:'init',session_id:'original-session'},
      {type:'result',subtype:'error_during_execution',session_id:'original-session',is_error:true,num_turns:1,...(usage?{usage}:{})}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});`);
  const opts={cwd,model:'fixture',timeoutMs:3000,onUsage:row=>rows.push(row),onUsageClaim:()=>claims.push('dispatch'),spawnProcess:(_cli,_args,options)=>spawn(process.execPath,[script],options)};
  const preflight=provider==='codex'?{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({...opts,promptTransport:'stdin'})}:
    {passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(opts)};
  const worker=role==='developer'?(provider==='codex'?codexDeveloperWorker:claudeDeveloperWorker)(opts):
    (provider==='codex'?codexWorker:claudeWorker)({...opts,preflight,promptTransport:'stdin',schemaPath:'synthetic-schema'});
  const result=await worker({prompt:'Synthetic failure only'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.notEqual(result.status,'succeeded');assert.equal(result.code,'provider_failed');assert.equal(rows.length,1);assert.equal(claims.length,1);
  assert.deepEqual(rows[0],present?{usage_state:'observed',input_tokens:100,output_tokens:20}:{usage_state:'unavailable'});
});

test('bare fix native usage uses original global-only writer contract and deduplicates actual invocation',async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-bare-'))),home=path.join(cwd,'private-logs'),previous=process.env.CM_WORKFLOW_LOG_HOME;
  process.env.CM_WORKFLOW_LOG_HOME=home;t.after(()=>{if(previous===undefined)delete process.env.CM_WORKFLOW_LOG_HOME;else process.env.CM_WORKFLOW_LOG_HOME=previous;fs.rmSync(cwd,{recursive:true,force:true});});
  const request={invocationId:'bare-fix-original-call',requestedModel:'fixture',identity:{repositoryId:'fixture',runId:'bare-fix-run',taskId:'T-FIX-bare',attempt:1}};
  const log=createNativeUsageLog({definition:{codeProject:cwd,specsDir:null,feature:'fix'},request,provider:'codex',role:'reviewer',workflow:'cm-fix'});
  const events=[{type:'thread.started',thread_id:'bare-original-thread'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'approved'})}},
    {type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});`);
  const options={cwd,model:'fixture',promptTransport:'stdin',timeoutMs:3000,schemaPath:'synthetic-schema',
    spawnProcess:(_cli,_args,opts)=>spawn(process.execPath,[script],opts),onUsageClaim:()=>log.claimed(),onUsage:usage=>log.complete(usage,'success')};
  options.preflight={passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint(options)};
  assert.equal((await codexWorker(options)({prompt:'Synthetic bare fix review'},{signal:new AbortController().signal,onEvent:()=>{}})).status,'succeeded');
  const readRows=()=>fs.readdirSync(path.join(home,'runs'),{recursive:true}).filter(file=>file.endsWith('.jsonl')).flatMap(file=>fs.readFileSync(path.join(home,'runs',file),'utf8').trim().split('\n').map(JSON.parse));
  const rows=readRows();assert.equal(rows.filter(r=>r.event==='model_call').length,1);const usage=rows.filter(r=>r.event==='model_usage');assert.equal(usage.length,1);
  assert.equal(usage[0].input_tokens,10);assert.equal(usage[0].output_tokens,2);assert.equal(usage[0].call_id,request.invocationId);assert.equal(usage[0].task,request.identity.taskId);
  log.complete({usage_state:'observed',input_tokens:10,output_tokens:2},'success');assert.deepEqual(readRows(),rows);
  assert(!fs.existsSync(path.join(cwd,'.reviews')));assert(!fs.existsSync(path.join(cwd,'null')));
});
for(const provider of ['codex','claude'])test(`${provider} reviewer records valid native usage even when charged answer JSON is invalid`,async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-invalid-answer-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const rows=[],usage={input_tokens:10,output_tokens:2};
  const events=provider==='codex'?[{type:'thread.started',thread_id:'original-thread'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:'invalid JSON'}},{type:'turn.completed',usage}]:
    [{type:'system',subtype:'init',session_id:'original-session'},
      {type:'assistant',session_id:'original-session',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'invalid JSON'}]}},
      {type:'result',subtype:'success',session_id:'original-session',is_error:false,num_turns:1,result:'invalid JSON',usage}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});`);
  const opts={cwd,model:'fixture',promptTransport:'stdin',schemaPath:'synthetic-schema',timeoutMs:3000,onUsage:r=>rows.push(r),spawnProcess:(_cli,_args,options)=>spawn(process.execPath,[script],options)};
  opts.preflight=provider==='codex'?{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint(opts)}:
    {passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(opts)};
  const result=await (provider==='codex'?codexWorker:claudeWorker)(opts)({prompt:'Synthetic invalid answer'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.notEqual(result.status,'succeeded');assert.equal(result.code,'invalid_output_json');assert.deepEqual(rows,[{usage_state:'observed',input_tokens:10,output_tokens:2}]);
});
for(const role of ['reviewer','developer'])test(`Codex ${role} mismatched native thread cannot attest later usage`,async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-context-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));const rows=[];
  const events=[{type:'thread.started',thread_id:'original-thread'},{type:'turn.started'},{type:'thread.started',thread_id:'other-thread'},
    {type:'turn.failed',error:{message:'Wrong thread'},usage:{input_tokens:999,output_tokens:999}}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});`);
  const opts={cwd,model:'fixture',promptTransport:'stdin',schemaPath:'synthetic-schema',timeoutMs:3000,onUsage:r=>rows.push(r),spawnProcess:(_cli,_args,options)=>spawn(process.execPath,[script],options)};
  opts.preflight={passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint(opts)};
  const result=await (role==='reviewer'?codexWorker:codexDeveloperWorker)(opts)({prompt:'Synthetic spoofed context'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.notEqual(result.status,'succeeded');assert.equal(result.code,'thread_mismatch');assert.deepEqual(rows,[{usage_state:'unavailable'}]);
});
test('Claude malformed failure metadata keeps legacy failure classification and cannot attest usage',async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-failure-compat-')));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));const rows=[];
  const events=[{type:'system',subtype:'init',session_id:'original-session'},
    {type:'result',subtype:'error_during_execution',session_id:'original-session',is_error:true,usage:{input_tokens:999,output_tokens:999}}];
  const script=path.join(cwd,'fake.mjs');fs.writeFileSync(script,`for await(const part of process.stdin){};process.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});`);
  const result=await claudeDeveloperWorker({cwd,model:'fixture',timeoutMs:3000,onUsage:r=>rows.push(r),spawnProcess:(_cli,_args,opts)=>spawn(process.execPath,[script],opts)})
    ({prompt:'Synthetic malformed failure'},{signal:new AbortController().signal,onEvent:()=>{}});
  assert.equal(result.status,'unavailable');assert.equal(result.code,'provider_failed');assert.deepEqual(rows,[{usage_state:'unavailable'}]);
});
