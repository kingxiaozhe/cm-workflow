import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {claudeDeveloperWorker,claudeDeveloperArgs} from '../runtime/js/cm-ai/worker-claude-developer.mjs';
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
function fakeWorker(cwd,{value=proposal,mode='normal',timeoutMs=3000}={}){
  const source=`let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    if(!input.includes('Return {status,value,edits}'))process.exit(9);
    if(${JSON.stringify(mode)}==='timeout'){setInterval(()=>{},1000);return;}
    const session_id='synthetic-claude-developer';
    const value=${JSON.stringify(value)};
    const events=[{type:'system',subtype:'init',session_id}];
    if(${JSON.stringify(mode)}==='read')events.push(
      {type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:'target.txt'}}]}},
      {type:'user',session_id,message:{role:'user',content:[{type:'tool_result',tool_use_id:'read-1',content:'fixture text'}]}});
    events.push({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:
      ${JSON.stringify(mode)}==='write'?[{type:'tool_use',id:'bad',name:'Write',input:{}}]:[{type:'text',text:'proposal'}]}},
      {type:'result',session_id,subtype:${JSON.stringify(mode)}==='failed'?'error_during_execution':'success',
      is_error:${JSON.stringify(mode)}==='failed',num_turns:1,result:JSON.stringify(value)});
    for(const event of events)process.stdout.write(JSON.stringify(event)+'\\n');
  });`;
  return claudeDeveloperWorker({cwd,model:'fixture',timeoutMs,spawnProcess:(cli,args,options)=>{
    assert.equal(cli,'claude');assert.equal(options.shell,false);assert.equal(options.detached,true);
    assert.deepEqual(args,claudeDeveloperArgs('fixture'));
    assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
    assert.equal(args[args.indexOf('--allowedTools')+1],'Read,Grep,Glob');
    assert.equal(args[args.indexOf('--permission-mode')+1],'dontAsk');
    for(const key of ['NODE_OPTIONS','ANTHROPIC_BASE_URL','HTTP_PROXY','CLAUDE_CODE_USE_BEDROCK'])assert.equal(options.env[key],undefined);
    return spawn(process.execPath,['-e',source],options);
  }});
}
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
