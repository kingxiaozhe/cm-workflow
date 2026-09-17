import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {claudeDeveloperWorker,claudeDeveloperArgs,validateClaudeProposal} from '../runtime/js/cm-ai/worker-claude-developer.mjs';
import {createProjectExecution} from '../runtime/js/cm-ai/host-project-execution.mjs';
import {buildClaudeDeveloperPrompt} from '../runtime/js/cm-ai/claude-developer-adapter.mjs';
import {protectedTextInstructions} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'proposal-fixture',runId:'proposal-run',taskId:'T-001',attempt:1};
const proposal={status:'succeeded',value:{outcome:'implemented'},edits:[{path:'target.txt',beforeSha256:null,content:'safe text\n'}]};
function prompt(){
  const body={version:1,invocationId:'dev-1',identity,role:'developer',provider:'claude',requestedModel:'fixture',
    contextId:'author',payload:{scope:['target.txt'],requirements:[],priorReview:null}};
  return buildClaudeDeveloperPrompt({...body,requestDigest:digest(body)})+protectedTextInstructions;
}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-claude-development-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function fakeWorker(cwd,{value=proposal,mode='normal',timeoutMs=3000,noticeEvents=[],noticeAt=1,onNotice,
  resultFields={},toolName='Read',toolResultId='read-1',
  assistantContent=[{type:'text',text:'proposal'}]}={}){
  const source=`let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    if(!input.includes('Return {status,value,edits}'))process.exit(9);
    if(${JSON.stringify(mode)}==='timeout'){setInterval(()=>{},1000);return;}
    const session_id='synthetic-claude-developer';
    const value=${JSON.stringify(value)};
    const events=[{type:'system',subtype:'init',session_id}];
    if(${JSON.stringify(mode)}==='read')events.push(
      {type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'read-1',name:${JSON.stringify(toolName)},input:{file_path:'target.txt'}}]}},
      {type:'user',session_id,message:{role:'user',content:[{type:'tool_result',tool_use_id:${JSON.stringify(toolResultId)},content:'fixture text'}]}});
    events.push({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:
      ${JSON.stringify(mode)}==='write'?[{type:'tool_use',id:'bad',name:'Write',input:{}}]:${JSON.stringify(assistantContent)}}},
      {type:'result',session_id,subtype:${JSON.stringify(mode)}==='failed'?'error_during_execution':'success',
      is_error:${JSON.stringify(mode)}==='failed',num_turns:1,result:JSON.stringify(value),...${JSON.stringify(resultFields)}});
    events.splice(${JSON.stringify(noticeAt)},0,...${JSON.stringify(noticeEvents)});
    for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');
  });`;
  return claudeDeveloperWorker({cwd,model:'fixture',timeoutMs,onNotice,spawnProcess:(cli,args,options)=>{
    assert.equal(cli,'claude');assert.equal(options.shell,false);assert.equal(options.detached,true);
    assert.deepEqual(args,claudeDeveloperArgs('fixture'));
    assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
    assert.equal(args[args.indexOf('--allowedTools')+1],'Read,Grep,Glob');
    const index=args.indexOf('--json-schema');assert.ok(index>0);assert.equal(args.lastIndexOf('--json-schema'),index);
    const schema=JSON.parse(args[index+1]);assert.equal(Object.hasOwn(schema,'$schema'),false);assert.equal(Object.hasOwn(schema,'$id'),false);
    assert.deepEqual(schema.properties.status.enum,['succeeded','failed']);
    assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
    for(const key of ['NODE_OPTIONS','ANTHROPIC_BASE_URL','HTTP_PROXY','CLAUDE_CODE_USE_BEDROCK'])assert.equal(options.env[key],undefined);
    return spawn(process.execPath,['-e',source],options);
  }});
}
const rateLimit=(overrides={})=>({type:'rate_limit_event',session_id:'synthetic-claude-developer',
  rate_limit_info:{status:'allowed',rateLimitType:'five_hour',resetsAt:123,active:true,reason:null,
    nested:{raw:'private'},list:['private']},...overrides});
test('developer forwards scalar notices while preserving proposals and read-tool state',async t=>{
  const root=fixture(t),events=[],control={signal:new AbortController().signal,onEvent:e=>events.push(e)};
  const baseline=await fakeWorker(root)({prompt:prompt()},control);
  for(const [mode,noticeAt,count] of [['normal',1,1],['normal',2,8],['read',2,8]]){
    const notices=[],noticeEvents=Array.from({length:count},()=>rateLimit());
    const result=await fakeWorker(root,{mode,noticeAt,noticeEvents,onNotice:n=>notices.push(n)})({prompt:prompt()},control);
    assert.deepEqual(result,baseline);
    assert.deepEqual(notices,Array.from({length:count},()=>({kind:'rate_limit',info:{status:'allowed',
      rateLimitType:'five_hour',resetsAt:123,active:true,reason:null}})));
  }
  for(const onNotice of [undefined,()=>{throw Error('notice consumer');}]){
    const result=await fakeWorker(root,{noticeEvents:[rateLimit()],onNotice})({prompt:prompt()},control);
    assert.deepEqual(result,baseline);
  }
  assert.deepEqual(events,[]);assert.deepEqual(fs.readdirSync(root),[]);
});
const thinkingTokens=()=>({type:'system',subtype:'thinking_tokens',session_id:'synthetic-claude-developer',estimated_tokens:10});
const thoughts={type:'assistant',session_id:'synthetic-claude-developer',parent_tool_use_id:null,
  message:{role:'assistant',content:[{type:'thinking',thinking:'private',signature:'sig'},{type:'redacted_thinking',data:'private'}]}};
test('developer thinking events preserve proposal and read tool pairing with developer schema',async t=>{
  const root=fixture(t),control={signal:new AbortController().signal};
  const baseline=await fakeWorker(root)({prompt:prompt()},control);
  for(const [mode,noticeAt,count] of [['normal',1,2],['normal',2,64],['read',2,2]]){
    const result=await fakeWorker(root,{mode,noticeAt,
      noticeEvents:[rateLimit(),...Array.from({length:count},thinkingTokens),thoughts],
      assistantContent:[...thoughts.message.content,{type:'text',text:'proposal'}]})({prompt:prompt()},control);
    assert.deepEqual(result,baseline);
  }
  const mixed=await fakeWorker(root,{assistantContent:[...thoughts.message.content,
    {type:'tool_use',id:'forbidden',name:'Bash',input:{}}]})({prompt:prompt()},control);
  assert.equal(mixed.code,'unexpected_tool_or_content');
  assert.deepEqual(fs.readdirSync(root),[]);
});
test('developer thinking preserves initial, terminal, count and unknown-system rejection',async t=>{
  const root=fixture(t),control={signal:new AbortController().signal};
  for(const [noticeEvents,noticeAt,code] of [
    [Array.from({length:65},thinkingTokens),1,'unexpected_event'],
    [[{...thinkingTokens(),subtype:'unknown'}],1,'unexpected_event'],
    [[{...thinkingTokens(),subtype:'init'}],1,'unexpected_event'],
    [[{...thinkingTokens(),session_id:'other'}],1,'session_mismatch'],
    [[thinkingTokens()],0,'missing_init'],
    [[thinkingTokens()],3,'invalid_event'],
  ]){
    const result=await fakeWorker(root,{noticeEvents,noticeAt})({prompt:prompt()},control);
    assert.deepEqual(result,{status:'unknown',code});
  }
  const result=await fakeWorker(root,{assistantContent:thoughts.message.content})({prompt:prompt()},control);
  assert.deepEqual(result,{status:'unknown',code:'unexpected_result'});
});
test('developer rejects mismatched, excessive, unknown and terminal rate limit events',async t=>{
  const root=fixture(t);
  for(const [noticeEvents,noticeAt,code,count] of [
    [[rateLimit({session_id:'other'})],1,'session_mismatch',0],
    [Array.from({length:9},()=>rateLimit()),1,'unexpected_event',8],
    [[rateLimit({type:'foo_event'})],1,'unexpected_event',0],
    [[rateLimit()],0,'missing_init',0],
    [[rateLimit()],3,'invalid_event',0],
  ]){
    const notices=[],result=await fakeWorker(root,{noticeEvents,noticeAt,onNotice:n=>notices.push(n)})
      ({prompt:prompt()},{signal:new AbortController().signal});
    assert.deepEqual(result,{status:'unknown',code});assert.equal(notices.length,count);
  }
  assert.deepEqual(fs.readdirSync(root),[]);
});
for(const mode of ['normal','read'])test(`Claude ${mode} process returns a proposal without writing files`,async t=>{
  const root=fixture(t),worker=fakeWorker(root,{mode});
  const result=await worker({prompt:prompt()},{signal:new AbortController().signal});
  assert.equal(result.status,'succeeded');assert.deepEqual(result.edits,proposal.edits);
  assert.equal(result.providerThread,'synthetic-claude-developer');assert.deepEqual(fs.readdirSync(root),[]);
  assert.equal((await worker({prompt:prompt()},{signal:new AbortController().signal})).code,'worker_dispatch_limit');
});
for(const [mode,code] of [['timeout','timeout'],['failed','provider_failed'],['write','unexpected_tool_or_content']])test(`Claude ${mode} fails closed`,async t=>{
  const root=fixture(t),result=await fakeWorker(root,{mode,timeoutMs:mode==='timeout'?100:3000})({prompt:prompt()},{signal:new AbortController().signal});
  assert.equal(result.code,code);assert.equal(result.status,mode==='failed'?'unavailable':'unknown');assert.deepEqual(fs.readdirSync(root),[]);
});
test('spawn throw and asynchronous missing executable are unavailable; aborted calls never spawn',async t=>{
  const cwd=fixture(t);
  for(const options of [{spawnProcess(){throw Error('fixture');}},{cli:path.join(cwd,'missing')}]){
    const result=await claudeDeveloperWorker({cwd,model:'fixture',...options})({prompt:prompt()},{signal:new AbortController().signal});
    assert.deepEqual(result,{status:'unavailable',code:'spawn_failed'});
  }
  const controller=new AbortController();controller.abort();
  const result=await claudeDeveloperWorker({cwd,model:'fixture',spawnProcess(){assert.fail('spawn');}})({prompt:prompt()},{signal:controller.signal});
  assert.equal(result.status,'cancelled');
});
for(const content of ['binary\0data','x'.repeat(65536),'bad\ud800text'])test(`invalid text proposal rejected (${content.length} characters)`,async t=>{
  const cwd=fixture(t),value={...proposal,edits:[{...proposal.edits[0],content}]};
  const result=await fakeWorker(cwd,{value})({prompt:prompt()},{signal:new AbortController().signal});
  assert.notEqual(result.status,'succeeded');assert.deepEqual(fs.readdirSync(cwd),[]);
});
test('actual proposal cannot escape scope or use stale expected hashes at host commit',async t=>{
  const root=fixture(t),codeProject=path.join(root,'code'),specsDir=path.join(codeProject,'specs');fs.mkdirSync(specsDir,{recursive:true});
  const project=createProjectExecution({definition:{codeProject,specsDir},protection:{timeoutMs:3000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--version']}]}});
  const scope=['target.txt'],expected=project.expected(scope),signal=new AbortController().signal;
  for(const edit of [{path:'../escape',beforeSha256:null,content:'bad'},{path:'target.txt',beforeSha256:'0'.repeat(64),content:'bad'}]){
    const result=await fakeWorker(codeProject,{value:{...proposal,edits:[edit]}})({prompt:prompt()},{signal});
    assert.equal(result.status,'succeeded');
    await assert.rejects(project.commit({scope,expected,identity,signal,edits:result.edits}),{code:edit.path==='target.txt'?'protected_edit_stale':'out_of_scope'});
    assert(!fs.existsSync(path.join(codeProject,'target.txt')));assert(!fs.existsSync(path.join(root,'escape')));
  }
});

test('developer arguments carry the dedicated schema and exact success/failure prompt',()=>{
  const args=claudeDeveloperArgs('fixture');
  const schema=JSON.parse(args[args.indexOf('--json-schema')+1]);
  assert.deepEqual(schema,JSON.parse(fs.readFileSync(new URL('../runtime/js/cm-ai/claude-developer-proposal.schema.json',import.meta.url),'utf8')));
  assert.deepEqual(schema.required,['status']);assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.edits.maxItems,64);
  assert.match(protectedTextInstructions,/status must be exactly "succeeded" on success \(with value and edits\) or "failed" \(with code\)/);
  assert.match(protectedTextInstructions,/structured output schema; never wrap it in markdown fences/);
});
test('developer pairs StructuredOutput and prefers its proposal over fenced text',async t=>{
  const root=fixture(t),control={signal:new AbortController().signal};
  for(const toolName of ['Read','Grep','Glob','StructuredOutput']){
    const result=await fakeWorker(root,{mode:'read',toolName,
      resultFields:{structured_output:proposal,result:'```json\n{"status":"ok"}\n```'}})({prompt:prompt()},control);
    assert.deepEqual(result,{...proposal,providerThread:'synthetic-claude-developer'});
  }
  const mismatch=await fakeWorker(root,{mode:'read',toolName:'StructuredOutput',toolResultId:'unknown',
    resultFields:{structured_output:proposal}})({prompt:prompt()},control);
  assert.deepEqual(mismatch,{status:'unknown',code:'unexpected_tool_or_content'});
  const unpaired=await fakeWorker(root,{assistantContent:[{type:'tool_use',id:'schema-1',name:'StructuredOutput',input:proposal}],
    resultFields:{structured_output:proposal}})({prompt:prompt()},control);
  assert.deepEqual(unpaired,{status:'unknown',code:'unexpected_result'});
  for(const toolName of ['Bash','Write','Edit','Task','WebFetch']){
    const result=await fakeWorker(root,{mode:'read',toolName,resultFields:{structured_output:proposal}})({prompt:prompt()},control);
    assert.deepEqual(result,{status:'unknown',code:'unexpected_tool_or_content'});
  }
  assert.deepEqual(fs.readdirSync(root),[]);
});
test('developer explicitly classifies malformed fallback JSON and rejects invalid structured output',async t=>{
  const root=fixture(t),control={signal:new AbortController().signal};
  for(const result of ['```json\n'+JSON.stringify(proposal)+'\n```','{broken','']){
    assert.deepEqual(await fakeWorker(root,{resultFields:{result}})({prompt:prompt()},control),
      {status:'unknown',code:'invalid_output_json'});
  }
  for(const value of [{...proposal,status:'ok'},{status:'ok',code:'bad'}]){
    assert.throws(()=>validateClaudeProposal(value),{code:'invalid_result'});
    assert.deepEqual(await fakeWorker(root,{value})({prompt:prompt()},control),{status:'unknown',code:'invalid_result'});
  }
  for(const structured_output of [null,{status:'ok',code:'bad'}]){
    assert.deepEqual(await fakeWorker(root,{resultFields:{structured_output}})({prompt:prompt()},control),
      {status:'unknown',code:'invalid_result'});
  }
  const failed={status:'failed',code:'implementation_blocked'};
  assert.deepEqual(await fakeWorker(root,{resultFields:{structured_output:failed}})({prompt:prompt()},control),
    {...failed,providerThread:'synthetic-claude-developer'});
});
test('proposal validation preserves schema fields and strict success/failure branches',()=>{
  const candidate={classification:'structured',trigger:'retry',action:'check',evidence:['target.txt']};
  const learning={...proposal,value:{outcome:'implemented',application:{status:'applied',note:'checked'},
    retrospective:{status:'lesson_candidate',candidates:[candidate],reason:null}}};
  for(const valid of [proposal,{status:'failed',code:'blocked'},learning,
    {...proposal,value:{outcome:'blocked'}},
    {...proposal,value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}}},
    {...learning,value:{...learning.value,retrospective:{status:'writeback_pending',candidates:[{...candidate,classification:'memory_only'}],reason:'pending'}}},
    {...proposal,edits:Array.from({length:64},()=>({...proposal.edits[0],beforeSha256:'a'.repeat(64),content:null}))}]){
    assert.deepEqual(validateClaudeProposal(valid),valid);
  }
  for(const invalid of [null,{},[],{status:'failed'}, {status:'failed',code:''},{status:'failed',code:1},
    {status:'failed',code:'blocked',edits:[]},{status:'succeeded',value:proposal.value},
    {...proposal,code:'extra'},{...proposal,value:{outcome:'ok'}},{...proposal,value:{outcome:'implemented',extra:true}},
    {...proposal,value:{outcome:'implemented',application:{status:'unknown',note:null}}},
    {...proposal,value:{outcome:'implemented',application:{status:'applied',note:42}}},
    ...[{status:'unknown',candidates:[],reason:null},{status:'no_new_lesson',candidates:[],reason:1},
      {status:'lesson_candidate',candidates:Array(4).fill(candidate),reason:null},
      ...[{...candidate,classification:'other'},{...candidate,evidence:[42]},{...candidate,trigger:42},{...candidate,extra:true}]
        .map(c=>({status:'lesson_candidate',candidates:[c],reason:null}))]
      .map(retrospective=>({...proposal,value:{outcome:'implemented',retrospective}})),
    {...proposal,edits:Array(65).fill(proposal.edits[0])},
    ...[{path:''},{beforeSha256:'A'.repeat(64)},{beforeSha256:'a'.repeat(63)},{beforeSha256:1},{content:1},{extra:true}]
      .map(edit=>({...proposal,edits:[{...proposal.edits[0],...edit}]}))]){
    assert.throws(()=>validateClaudeProposal(invalid),undefined,JSON.stringify(invalid));
  }
});
