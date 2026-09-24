#!/usr/bin/env node
// cm-ai-batch-host 的单步驾驶员；PLAN 路径相对 PLAN 文件。
// operation -> possible host_request kinds (conservative over all batch tasks):
// advance -> develop, check: cm-ai-batch-run.mjs handle/driveMember -> start,
//   host-conversation-execution.mjs worker/check. Protected config makes check
//   host-owned in createProjectExecution; provider development makes develop host-owned.
// advance -> qa_assess, qa_logic, qa_browser, documentation_sync,
//   documentation_inspect: host-workflow-capabilities.mjs createHostWorkflowCapabilities;
//   batch-run.mjs driveMember/handle can reach qa, context_refresh and finalization.
// advance -> verification_precheck: host-conversation-execution.mjs verificationGate.
// advance -> init_generate, init_verify: host-bootstrap.mjs via batch-host.mjs
//   bootstraps; init_verify contains execution evidence, so this driver refuses.
// status/cancel -> none: batch-run.mjs handle routes only these and advance;
//   host-session.mjs operationNames admits all three. Other operationNames belong
//   to child/single-task hosts and are not batch operations.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {decideHostQaPolicy} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {validateHostWorkflowConfiguration} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {validateRunDefinition} from './cm-ai-run.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {readConversationReviewConfiguration,readConversationProtection} from './cm-ai-host.mjs';
import {validateCmAiAnswer} from './cm-ai-drive.mjs';
import {stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
const KINDS={develop:'develop.json',qa_assess:'qa-assess.json',
  documentation_sync:'documentation-sync.json',documentation_inspect:'documentation-inspect.json'};
const PAIRS=new Set(['--runtime','--review-config','--browser-qa','--protected-conversation-config',
  '--protected-config','--allow-provider-development','--allow-review']);
const FLAGS=new Set(['--allow-qa','--rerun-unknown-qa','--rerun-blocked-qa','--verification-precheck',
  '--allow-bootstrap-write']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
function taskKey(task){return `${task.feature}/${task.taskId}`;}
function actualCwd(bundle,key,generation=1){
  if(generation===2)return bundle.batch.codeProject;
  const group=bundle.batch.parallel?.find(group=>group.includes(key));
  if(!group)return bundle.batch.codeProject;
  const id=key.slice(key.lastIndexOf('/')+1);
  return path.resolve(bundle.batch.codeProject,'..','.cm-worktrees',bundle.batch.batchId.slice(0,8),id);
}
function checkCommandShape(commands,key){
  if(!Array.isArray(commands)||!commands.length||commands.length>32)stop(2,`任务 ${key} 会反问 check，但 PLAN.checks.${key} 缺少真实命令列表`);
  const ids=new Set();
  for(const item of commands){
    if(!isObject(item)||Object.keys(item).sort().join()!=='command,id'
      ||!nonempty(item.id)||ids.has(item.id)||!Array.isArray(item.command)||!item.command.length
      ||item.command.some(arg=>typeof arg!=='string'||arg.includes('\0')))
      stop(2,`PLAN.checks.${key} 格式错误`);
    ids.add(item.id);
  }
}
function preflight(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-ai-batch-drive.mjs --plan PLAN.json <operation>\n'
      +'operation: advance, status, cancel。PLAN: config, mode, hostContext, permissions, answers, checks。\n');
    process.exit(0);
  }
  const loaded=loadPlanFile({name:'cm-ai-batch-drive.mjs',known:new Set(['advance','status','cancel'])});
  const {plan,base,operation}=loaded;
  requireFields(plan,['config','mode','hostContext','permissions']);
  if(!['create','resume'].includes(plan.mode))stop(2,'mode 只能是 create 或 resume');
  if(!nonempty(plan.hostContext))stop(2,'hostContext 必须是当前真实会话 ID');
  if(plan.mode==='resume'&&plan.originalHostContext!==plan.hostContext)
    stop(2,'batch 宿主没有跨会话恢复入口；resume 需要 originalHostContext 等于 hostContext');
  if(plan.mode==='create'&&plan.originalHostContext)stop(2,'originalHostContext 只在 resume 时有意义');
  if(!Array.isArray(plan.permissions))stop(2,'permissions 必须是宿主参数数组');
  const permissions=[];
  for(let i=0;i<plan.permissions.length;i++){
    const name=plan.permissions[i];
    if(FLAGS.has(name))permissions.push(name);
    else if(PAIRS.has(name)&&nonempty(plan.permissions[i+1]))permissions.push(name,plan.permissions[++i]);
    else stop(2,`permissions 无效或缺少参数: ${name}`);
  }
  const config=path.resolve(base,plan.config),bundle=readJson(config,'批次定义');
  if(bundle===undefined)stop(2,`批次定义不存在: ${config}`);
  const configInfo=fs.lstatSync(config);
  if(!configInfo.isFile()||configInfo.isSymbolicLink()||configInfo.size>64*1024)
    stop(2,`批次定义不是安全的普通文件: ${config}`);
  if(!isObject(bundle)||!isObject(bundle.batch)||!isObject(bundle.workflows)
    ||!Array.isArray(bundle.batch.tasks)||!bundle.batch.tasks.length)stop(2,`批次定义格式错误: ${config}`);
  const batch=bundle.batch,keys=batch.tasks.map(taskKey);
  if(new Set(keys).size!==keys.length||keys.length!==Object.keys(bundle.workflows).length
    ||keys.some(key=>!Object.hasOwn(bundle.workflows,key)))stop(2,'批次定义 workflows 与 tasks 不匹配');
  const definitions=new Map(),runs=new Map();
  try{
    for(const task of batch.tasks){
      const key=taskKey(task);
      definitions.set(key,validateRunDefinition({version:1,specsDir:batch.specsDir,
        codeProject:batch.codeProject,...(batch.codeProjects?{codeProjects:batch.codeProjects}:{}),
        feature:task.feature,identity:{repositoryId:batch.repositoryId,
          runId:`task-${digest({batchId:batch.batchId,task:key}).slice(0,48)}`,
          taskId:task.taskId,attempt:1},scope:task.scope,requirements:task.requirements}));
      runs.set(definitions.get(key).identity.runId,{key,generation:1});
      runs.set(`task-${digest({batchId:batch.batchId,task:key,generation:2}).slice(0,48)}`,
        {key,generation:2});
      if(bundle.workflows[key]!==null)validateHostWorkflowConfiguration(bundle.workflows[key]);
    }
    // Use the batch owner's selection/parallel-group validator without opening a run.
    createCmAiBatch({configuration:batch,executionFor:async()=>({}),
      logHome:path.join(batch.specsDir,'.reviews','host-log-mirror')});
  }catch(error){stop(2,`批次定义、scope 或 workflow 无效: ${error.code??error.message}`);}
  const log=path.join(batch.specsDir,'运行日志.jsonl');
  const stores=Array.from(definitions.values(),d=>path.join(batch.specsDir,'.reviews','.execution',d.identity.runId,'state.json'));
  const hasLog=fs.existsSync(log),hasStore=stores.some(file=>fs.existsSync(file));
  if(plan.mode==='resume'&&!hasLog&&!hasStore)
    stop(2,`恢复存档不存在: ${log} / ${stores.join(', ')}`);
  if(plan.mode==='create'&&operation==='advance'&&(hasLog||hasStore))
    stop(2,`批次已有存档，请用 resume: ${log}`);
  if(operation==='status'&&!hasStore)stop(2,`只读 status 需要已有任务存档: ${stores.join(', ')}`);
  for(let i=0;i<permissions.length;i++)if(PAIRS.has(permissions[i])){
    const name=permissions[i],value=permissions[++i];
    if(['--review-config','--protected-conversation-config','--protected-config'].includes(name)){
      const file=path.resolve(base,value),data=readJson(file,name);
      if(data===undefined)stop(2,`${name} 文件不存在: ${file}`);
      try{
        if(name==='--review-config')readConversationReviewConfiguration(file);
        else if(name==='--protected-conversation-config')readConversationProtection(file);
        else {
          if(!isObject(data)||Object.keys(data).sort().join()!=='checkCommands,model,timeoutMs'
            ||!nonempty(data.model)||!/^[A-Za-z0-9._-]+$/.test(data.model)
            ||!Number.isSafeInteger(data.timeoutMs)||data.timeoutMs<=0||data.timeoutMs>3600000)
            throw Error('invalid_protected_config');
          createHostCheck({cwd:batch.codeProject,commands:data.checkCommands,timeoutMs:data.timeoutMs});
        }
      }catch(error){stop(2,`${name} 配置无效: ${file}: ${error.code??error.message}`);}
      permissions[i]=file;
    }else if(['--allow-review','--allow-provider-development'].includes(name)){
      const cut=value.lastIndexOf(':');
      if(!keys.includes(value.slice(0,cut))||!['1','2'].includes(value.slice(cut+1)))
        stop(2,`${name} 任务授权无效: ${value}`);
    }
  }
  const argument=(name)=>permissions[permissions.indexOf(name)+1];
  if(permissions.includes('--runtime')&&!['codex','claude'].includes(argument('--runtime')))
    stop(2,'--runtime 只能是 codex 或 claude');
  if(permissions.includes('--browser-qa')&&!['available','unavailable'].includes(argument('--browser-qa')))
    stop(2,'--browser-qa 只能是 available 或 unavailable');
  if(permissions.includes('--allow-review')&&!permissions.includes('--review-config'))
    stop(2,'--allow-review 需要 --review-config');
  if(permissions.includes('--allow-provider-development')&&!permissions.includes('--protected-config'))
    stop(2,'--allow-provider-development 需要 --protected-config');
  if(Object.values(bundle.workflows).some(workflow=>workflow?.qa)&&!permissions.includes('--allow-qa'))
    stop(2,'有 QA 工作流时缺少 --allow-qa');
  const protectedMode=permissions.includes('--protected-config')||permissions.includes('--protected-conversation-config');
  const providerAll=permissions.includes('--protected-config')&&keys.every(key=>
    permissions.includes(`${key}:1`)&&permissions[permissions.indexOf(`${key}:1`)-1]==='--allow-provider-development');
  if(operation==='advance'&&permissions.includes('--verification-precheck'))
    stop(2,'缺少真实执行 runner: verification_precheck；不能从静态答案文件应答');
  if(operation==='advance'&&bundle.bootstraps&&Object.keys(bundle.bootstraps).length)
    stop(2,'缺少真实执行 runner: init_verify；不能从静态答案文件应答');
  const root=plan.answers?path.resolve(base,plan.answers):null,answers={};
  if(operation==='advance')for(const task of batch.tasks){
    const key=taskKey(task),workflow=bundle.workflows[key],kinds=[];
    if(!providerAll)kinds.push('develop');
    if(!protectedMode){
      kinds.push('check');
      if(workflow?.documentationPaths?.length)kinds.push('documentation_sync');
    }
    if(workflow?.qa){
      if(!batch.parallel?.some(group=>group.includes(key)))kinds.push('qa_assess');
      const cases=readJson(path.join(batch.specsDir,task.feature,'test-cases.json'),'test-cases');
      for(const kind of ['logic','browser'])if(cases?.cases?.some(item=>item.kind===kind))kinds.push(`qa_${kind}`);
    }
    if(workflow)kinds.push('documentation_inspect');
    const evidence=kinds.filter(kind=>['qa_logic','qa_browser'].includes(kind));
    if(evidence.length)stop(2,`缺少真实执行 runner: ${evidence.join(', ')}；不能从静态答案文件应答`);
    if(kinds.includes('check'))checkCommandShape(plan.checks?.[key],key);
    const taskRoot=root&&path.join(root,task.feature,task.taskId);
    answers[key]=preflightAnswers(kinds.filter(kind=>KINDS[kind]),kind=>{
      const file=path.join(taskRoot??'',KINDS[kind]);
      if(!taskRoot||!fs.existsSync(file))stop(2,`任务 ${key} 会反问 ${kind}，但答案文件不存在: ${file}`);
      const value=readJson(file,kind);
      validateCmAiAnswer(kind,value,taskRoot);
      return value;
    });
    const develop=answers[key].develop;
    if(develop?.status==='succeeded')for(const target of Object.keys(develop.edits))
      if(!definitions.get(key).scope.includes(target))stop(2,`任务 ${key} develop.json.edits 越过批准 scope: ${target}`);
    if(answers[key].documentation_sync)for(const target of Object.keys(answers[key].documentation_sync.edits))
      if(!workflow.documentationPaths.includes(target))stop(2,`任务 ${key} documentation-sync.json.edits 越过文档 scope: ${target}`);
  }
  return {...loaded,bundle,definitions,runs,config,permissions,answers,answerRoot:root};
}

let loaded;
function safeWrite(map,root,cwd,allowed){
  for(const [target,local] of Object.entries(map)){
    if(!allowed.includes(target))throw Error(`编辑越过本次 scope: ${target}`);
    const file=path.resolve(cwd,target);
    if(!file.startsWith(cwd+path.sep))throw Error('编辑路径越界');
    for(let parent=path.dirname(file);parent!==cwd;parent=path.dirname(parent))
      if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('编辑路径经过符号链接');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('编辑路径是符号链接');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,fs.readFileSync(path.join(root,local)));
  }
}
async function answerFor(row){
  const identity=row.payload.identity??row.payload.request?.identity;
  const binding=loaded.runs.get(identity?.runId),key=binding?.key;
  if(!Object.hasOwn(loaded.answers,key))return null;
  const cwd=actualCwd(loaded.bundle,key,binding.generation);
  const task=loaded.bundle.batch.tasks.find(task=>taskKey(task)===key);
  const root=path.join(loaded.answerRoot,task.feature,task.taskId);
  const value=loaded.answers[key][row.kind];
  if(row.kind==='check'){
    if(row.payload.codeProject!==cwd)return null;
    const results=[];
    for(const command of loaded.plan.checks[key]){
      const run=createHostCheck({cwd,commands:[command],onOutput:({stream,chunk})=>{
        process.stderr.write(`[drive check ${key} ${command.id} ${stream}] ${chunk.toString('utf8')}`);
      }});
      const [result]=await run({identity},{signal:new AbortController().signal});
      results.push(result);if(result.outcome!=='passed')break;
    }
    return results;
  }
  if(row.kind==='develop'){
    if(row.payload.codeProject!==cwd)return null;
    if(value.status!=='succeeded')return {status:'failed',code:value.code};
    if(row.payload.editMode==='protected-text-v1')return {status:'succeeded',value:value.value,
      edits:Object.entries(value.edits).map(([target,local])=>({path:target,
        beforeSha256:row.payload.expected?.[target]??null,content:fs.readFileSync(path.join(root,local),'utf8')}))};
    safeWrite(value.edits,root,cwd,row.payload.request.payload.scope);
    return {status:'succeeded',value:value.value};
  }
  if(row.kind==='documentation_sync'){
    safeWrite(value.edits,root,cwd,row.payload.paths);return {status:'completed'};
  }
  if(row.kind==='documentation_inspect')return {...value,syncId:row.payload.syncId,
    identity:row.payload.identity,packageDigest:row.payload.packageDigest,
    contextDigest:row.payload.contextDigest,
    at:value.at??new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
  if(row.kind==='qa_assess'){
    decideHostQaPolicy({assessment:value,pending:1,mergeEligible:false,unassessedTasks:1});return value;
  }
  return null;
}
function main(){
  loaded=preflight();
  const {plan,operation,bundle,config,permissions}=loaded;
  driveHost({host:HOST,args:['serve','--config',config,'--host-context',plan.hostContext,
    '--allow-development',...permissions],cwd:bundle.batch.codeProject,operation,
    answers:loaded.answers,answerFor});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main();
