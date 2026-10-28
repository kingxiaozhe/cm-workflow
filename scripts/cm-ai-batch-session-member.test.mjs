// Grammar 3 session last task inside a batch (design 3.3): the planner's execution
// table batch.memberDevelopment, its checks in the batch owner, the batch host's member
// construction and the factory's development check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture as hostFixture,syntheticReviewConfig} from './cm-ai-host-fixture.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {planCmAiBatch} from '../runtime/js/cm-ai/batch-plan.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {readRunDefinition} from './cm-ai-run.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const scope=file=>`\n  - 范围: \`${file}\``;
const session='\n  - 开发: 会话';
const tasks=(mark=3)=>[1,2,3].map(n=>`- [ ] T-00${n}: t${n}${scope(`t${n}.js`)}${n===mark?session:''}`).join('\n')+'\n';
function specs(t,text,{taskGrammar=3}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-session-member-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(codeProject,'README.md'),'# fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work','tasks.md'),text);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir),
    ...(taskGrammar?{taskGrammar}:{})}));
  return {root,specsDir,codeProject,plan:()=>planCmAiBatch({specsDir,codeProject,repositoryId:'r',batchId:'session-batch-1',
    settings:{enabled:true,max:2,worktree_all:false}})};
}
const create=(f,configuration)=>createCmAiBatch({configuration,executionFor:async()=>({}),logHome:path.join(f.root,'log')});

test('the batch owner accepts the planned table and checks it against tasks.md again',t=>{
  const f=specs(t,tasks()),{batch}=f.plan().config;
  assert.deepEqual(batch.memberDevelopment,{'1.work/T-003':'session'});
  assert.ok(create(f,batch));
  const without=({memberDevelopment,...rest})=>rest;
  // A new grammar-3 batch must carry the table its tasks.md implies, and only that.
  assert.throws(()=>create(f,without(batch)),{code:'member_development_mismatch'});
  assert.throws(()=>create(f,{...batch,memberDevelopment:{'1.work/T-002':'session'}}),{code:'member_development_mismatch'});
  for(const memberDevelopment of [{},{'1.work/T-003':'provider'},{'1.work/T-999':'session'},null,[]])
    assert.throws(()=>create(f,{...batch,memberDevelopment}),{code:'invalid_member_development'},JSON.stringify(memberDevelopment));
  assert.throws(()=>create(f,{...batch,parallel:[['1.work/T-001','1.work/T-003']]}),error=>['session_task_parallel','parallel_final_task_excluded'].includes(error.code));
  // The narrow rule is re-read from tasks.md, whatever the configuration says.
  fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),tasks(2));
  assert.throws(()=>create(f,{...batch,memberDevelopment:{'1.work/T-002':'session'}}),{code:'session_task_not_final'});
  fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),tasks(2).replace(scope('t3.js'),scope('t3.js')+session));
  assert.throws(()=>create(f,batch),{code:'session_task_multiple'});
});

test('the batch owner refuses a hand-written configuration whose session member is not the last to run',t=>{
  const f=specs(t,tasks()),{parallel,...batch}=f.plan().config.batch;
  const write=deps=>fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),tasks()+'\n'+deps.join('\n')+'\n');
  // Dependencies the planner would refuse; this configuration is written by hand, in tasks.md order.
  write(['- T-001 依赖 T-003']);
  assert.throws(()=>create(f,batch),error=>error.code==='session_task_depended_on'&&/任务 T-001 直接或间接依赖.*T-003/.test(error.reason));
  write(['- T-001 依赖 T-002','- T-002 依赖 T-003']);
  assert.throws(()=>create(f,batch),error=>error.code==='session_task_depended_on'&&/任务 T-001, T-002 直接或间接依赖.*T-003/.test(error.reason));
  // Without dependencies, a configuration that lists the session member before another member.
  write([]);
  const reordered={...batch,tasks:[batch.tasks[0],batch.tasks[2],batch.tasks[1]]};
  assert.throws(()=>create(f,reordered),error=>error.code==='session_task_not_final'&&/1\.work\/T-003.*1\.work\/T-002/.test(error.reason));
  // Legal: the session member waits for the others and runs last.
  write(['- T-003 依赖 T-001, T-002']);
  assert.ok(create(f,batch));
});

test('a batch without session members keeps its configuration; grammar 2 never reads the mark',t=>{
  for(const taskGrammar of [null,2]){
    const f=specs(t,tasks(),{taskGrammar}),{batch}=f.plan().config;
    assert.equal(Object.hasOwn(batch,'memberDevelopment'),false);assert.ok(create(f,batch));
    assert.throws(()=>create(f,{...batch,memberDevelopment:{'1.work/T-003':'session'}}),{code:'member_development_mismatch'});
  }
});

test('the table is in planDigest: a started batch resumes only with the configuration it began with',async t=>{
  const f=specs(t,tasks()),{batch}=f.plan().config,{memberDevelopment,...old}=batch;
  const start=configuration=>fs.writeFileSync(path.join(f.specsDir,'运行日志.jsonl'),JSON.stringify({workflow:'cm-ai',event:'decision',
    phase:'batch_start',run_id:batch.batchId,schema_version:1,repository_id:'r',plan_digest:digest(configuration),from_key:'1.work/T-001'})+'\n');
  const status=async configuration=>{
    try{return await create(f,configuration).handle({operation:'status',requestId:'status'});}catch(error){return {code:error.code};}
  };
  start(batch);
  assert.notEqual((await status(batch)).code,'batch_plan_mismatch');
  assert.equal((await status(old)).code,'batch_plan_mismatch');
  // A batch started before the table existed resumes without it (no table injected) and refuses one added later.
  start(old);
  assert.notEqual((await status(old)).code,'batch_plan_mismatch');
  assert.equal((await status(batch)).code,'batch_plan_mismatch');
});

const crossToolRoles='version: 1\nruntimes: {available: both}\nroles:\n  coder: {adapter: codex-cli, source: subscription}\n  reviewer: {adapter: claude-cli, source: subscription}\n';
const providerPolicy={version:2,development:'provider',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
test('factory: under a provider policy a session member carries no providerDevelopment and is reviewed by the declared reviewer',()=>{
  const f=hostFixture(),bridge=createHostToolBridge();
  try{
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),crossToolRoles);
    const definition=readRunDefinition(f.config),protection={checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],timeoutMs:5000};
    const make=(options,review=syntheticReviewConfig(f.codeProject,'claude'))=>createConversationExecution(definition,'session-member-host',bridge,
      review,null,null,false,'codex',{controlPolicy:providerPolicy,protection,...options});
    const member=make({memberDevelopment:'session',reviewRuntime:'claude'});
    assert.equal(Object.hasOwn(member.configuration,'providerDevelopment'),false);
    assert.equal(member.configuration.reviewRuntime,'claude');assert.deepEqual(member.configuration.protection,protection);
    assert.equal(member.developer.provider,'codex');assert.equal(member.reviewers[0].provider,'claude');
    const provider={model:'fixture',attempt:1,coderRuntime:'codex',reviewerRuntime:'claude'};
    // The development check follows the table, both ways; it is not dropped.
    assert.throws(()=>make({memberDevelopment:'session',providerDevelopment:provider}),{code:'invalid_arguments'});
    assert.throws(()=>make({}),{code:'invalid_arguments'});
    assert.ok(make({providerDevelopment:provider}).configuration.providerDevelopment);
    assert.throws(()=>make({memberDevelopment:'provider',providerDevelopment:provider}),{code:'invalid_input'});
    // The paired runtime checks stay: a reviewer the project does not declare is refused.
    assert.throws(()=>make({memberDevelopment:'session',reviewRuntime:'codex'},syntheticReviewConfig(f.codeProject,'codex')),{code:'runtime_selection_mismatch'});
    assert.throws(()=>make({memberDevelopment:'session',reviewRuntime:'claude',reviewerRuntime:'claude'}),{code:'runtime_selection_mismatch'});
    // A conversation policy is unchanged by the mark.
    const conversation=createConversationExecution(definition,'session-member-host',bridge,syntheticReviewConfig(f.codeProject,'claude'),null,null,false,'codex',
      {controlPolicy:{...providerPolicy,development:'conversation'},protection,memberDevelopment:'session',reviewRuntime:'claude'});
    assert.equal(Object.hasOwn(conversation.configuration,'providerDevelopment'),false);
  }finally{bridge.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

// The batch host with createCmAiBatch and the factory stubbed, so production parsing
// and executionFor run while the factory boundary is captured (as cm-ai-batch-host.test.mjs).
const cli=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
async function stubbedHost(root){
  const stub=path.join(root,'stub.mjs'),host=path.join(root,'batch-host.mjs');
  const hostModule=new URL('./cm-ai-host.mjs',import.meta.url).href,sessionModule=new URL('../runtime/js/cm-ai/host-session.mjs',import.meta.url).href;
  fs.writeFileSync(stub,`
export {readConversationReviewConfiguration,readConversationReviewConfigurationValue,readConversationProtection,runReviewPreflight} from ${JSON.stringify(hostModule)};
export {parseHostInputLimit,inputLimitReason} from ${JSON.stringify(sessionModule)};
export const calls=[];export let scheduler;
export {batchTaskRunId,BATCH_MEMBER_ACTIONS} from ${JSON.stringify(new URL('./cm-ai-batch-run.mjs',import.meta.url).href)};
export function createConversationExecution(...args){calls.push(args);return {};}
export function createCmAiBatch(options){scheduler=options;return {async handle(){
  for(const task of options.configuration.tasks)await options.executionFor({feature:task.feature,identity:{taskId:task.taskId},
    codeProject:options.configuration.codeProject},{parallelMember:false});return {};}};}
export async function serveCmAiHost({host}){await host.handle({});}
`);
  const stubUrl=pathToFileURL(stub).href;
  fs.writeFileSync(host,fs.readFileSync(cli,'utf8').replace(/from '([^']+)'/g,(match,specifier)=>{
    if(['./cm-ai-batch-run.mjs','./cm-ai-host.mjs','../runtime/js/cm-ai/host-session.mjs'].includes(specifier))return `from '${stubUrl}'`;
    return specifier.startsWith('.')?`from '${new URL(specifier,new URL('./cm-ai-batch-host.mjs',import.meta.url)).href}'`:match;
  }));
  return {main:(await import(pathToFileURL(host).href)).main,capture:await import(stubUrl)};
}
test('batch host: a v2 provider batch builds its session member on the protected session transport with reviewRuntime',async t=>{
  const f=specs(t,tasks()),{batch,workflows}=f.plan().config;
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),crossToolRoles);
  const write=(name,value)=>{const file=path.join(f.root,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
  const protection={model:'fixture-coder',checkCommands:[{id:'syntax',command:[process.execPath,'--check','t1.js']}],timeoutMs:12345};
  const files={bundle:write('batch.json',{batch,workflows}),old:write('old.json',{batch:(({memberDevelopment,...rest})=>rest)(batch),workflows}),
    control:write('control.json',providerPolicy),review:write('review.json',syntheticReviewConfig(f.codeProject,'claude')),protected:write('protected.json',protection)};
  const {main,capture}=await stubbedHost(f.root);
  let stderr='';const io={input:{},output:{write(){}},error:{write(value){stderr+=value;}}};
  const args=(bundle,...extra)=>['serve','--config',bundle,'--host-context','session-member-host','--control-config',files.control,
    '--review-config',files.review,'--protected-config',files.protected,...extra];
  assert.equal(await main(args(files.bundle),io),0,stderr);
  const [first,second,last]=capture.calls.map(call=>call[8]);
  for(const member of [first,second]){
    assert.deepEqual(member.providerDevelopment,{model:'fixture-coder',attempt:1,coderRuntime:'codex',reviewerRuntime:'claude'});
    assert.equal(Object.hasOwn(member,'memberDevelopment'),false);assert.equal(Object.hasOwn(member,'reviewRuntime'),false);
  }
  assert.equal(last.memberDevelopment,'session');assert.equal(last.reviewRuntime,'claude');
  for(const absent of ['providerDevelopment','reviewerRuntime'])assert.equal(Object.hasOwn(last,absent),false,absent);
  assert.deepEqual(last.protection,{checkCommands:protection.checkCommands,timeoutMs:12345});
  assert.deepEqual(last.controlPolicy,providerPolicy);
  // The table is bound into every member's batchWorkflowsDigest and the batch configuration.
  assert.ok(capture.calls.every(call=>call[8].batchWorkflowsDigest===digest({workflows,bootstraps:null,memberDevelopment:batch.memberDevelopment})));
  assert.deepEqual(capture.scheduler.configuration.memberDevelopment,batch.memberDevelopment);
  // A batch without the table keeps its exact projection and gives every member to the provider.
  capture.calls.length=0;
  assert.equal(await main(args(files.old),io),0,stderr);
  assert.ok(capture.calls.every(call=>call[8].batchWorkflowsDigest===digest(workflows)&&call[8].providerDevelopment&&!Object.hasOwn(call[8],'memberDevelopment')));
  assert.equal(Object.hasOwn(capture.scheduler.configuration,'memberDevelopment'),false);
  // Refusals before any member is built.
  capture.calls.length=0;
  stderr='';assert.equal(await main(args(files.bundle,'--execution-optimizations'),io),1);
  assert.equal(JSON.parse(stderr).error.code,'session_member_unsupported_config');
  stderr='';assert.equal(await main(args(files.bundle,'--runtime','claude'),io),1);
  assert.equal(JSON.parse(stderr).error.code,'session_coder_runtime_mismatch');
  assert.equal(capture.calls.length,0);
});

test('batch host: a legacy provider grant cannot name a session member',async t=>{
  const f=specs(t,tasks()),{batch,workflows}=f.plan().config;
  const write=(name,value)=>{const file=path.join(f.root,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
  const bundle=write('batch.json',{batch,workflows}),review=write('review.json',syntheticReviewConfig(f.codeProject,'codex'));
  const protectedFile=write('protected.json',{model:'fixture',checkCommands:[],timeoutMs:1000});
  const {main,capture}=await stubbedHost(f.root);
  let stderr='';const io={input:{},output:{write(){}},error:{write(value){stderr+=value;}}};
  const base=['serve','--config',bundle,'--host-context','session-member-host','--allow-development','--review-config',review,'--protected-config',protectedFile];
  assert.equal(await main([...base,'--allow-provider-development','1.work/T-003:1'],io),1);
  assert.equal(JSON.parse(stderr).error.code,'invalid_arguments');
  stderr='';assert.equal(await main([...base,'--allow-provider-development','1.work/T-001:1'],io),0,stderr);
  assert.equal(capture.calls.at(-1)[8].memberDevelopment,'session');
  assert.equal(Object.hasOwn(capture.calls.at(-1)[8],'reviewRuntime'),false,'legacy batches keep their reviewer');
});
