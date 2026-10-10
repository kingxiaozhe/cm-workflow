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
// develop_redo/abandon_effect/abandon_review/bootstrap_review_recover -> none:
//   batch-run.mjs memberAction forwards one to the stopped member's cm-ai entry (Q24).
import {readBatchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import {readBatchExternalModels,batchModelsFile} from '../runtime/js/cm-ai/external-group-models.mjs';
import {loadConfig,resolveProtectedRuntimes} from './cm-workflow-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostCheck,reportHostCheckProgress} from '../runtime/js/cm-ai/host-check.mjs';
import {decideHostQaPolicy} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {validateHostWorkflowConfiguration} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {validateRunDefinition} from './cm-ai-run.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {readConversationReviewConfiguration,readConversationProtection} from './cm-ai-host.mjs';
import {validateCmAiAnswer,developFilename,preflightDevelopDeliveries,baselineScope,inputLimitFrom,
  applyDevelopEdits,protectedDevelopEdits,developPreview,plannedCheckResults,journalRestBytes} from './cm-ai-drive.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory,projectedRunnerStatus,RECHECK_CODES} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {developmentRetryable} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost,planCheckTimeout} from '../runtime/js/cm-ai/drive-core.mjs';

import {driverLiveEvidence} from '../runtime/js/cm-ai/live-evidence.mjs';

// PLAN.liveEvidence: fresh current-session evidence; see docs/live-evidence-drivers.md.
const HOST=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
const KINDS={develop:'develop.json',qa_assess:'qa-assess.json',
  documentation_sync:'documentation-sync.json',documentation_inspect:'documentation-inspect.json'};
// Q24: per-member recovery grants (cm-ai-batch-host.mjs) and their batch operation.
const MEMBER_ACTION_FLAGS={develop_redo:'--allow-develop-redo',abandon_effect:'--allow-abandon-effect',
  abandon_review:'--allow-abandon-review',bootstrap_review_recover:'--allow-bootstrap-review-recovery'};
const PAIRS=new Set(['--external-models-config','--runtime','--review-config','--browser-qa','--protected-conversation-config',
  '--protected-config','--allow-provider-development','--allow-review','--input-limit','--qa-environment-failure',...Object.values(MEMBER_ACTION_FLAGS)]);
const FLAGS=new Set(['--execution-optimizations','--external-models','--allow-qa','--rerun-unknown-qa','--rerun-blocked-qa','--verification-precheck',
  '--allow-bootstrap-write']);
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nonempty=x=>typeof x==='string'&&x.trim().length>0;
function taskKey(task){return `${task.feature}/${task.taskId}`;}
export function batchMemberActionPlanError(operation,plan,permissions,keys){
  const flag=MEMBER_ACTION_FLAGS[operation];if(!flag)return null;
  if(plan.mode!=='resume')return `${operation} 只用于 mode resume`;
  if(!keys.includes(plan.taskKey))return `${operation} 需要 PLAN.taskKey 为本批次当前停住的成员 FEATURE/TASK`;
  if(!(typeof plan.reason==='string'&&plan.reason.trim().length>0&&Buffer.byteLength(plan.reason,'utf8')<=500&&!/[\r\n\0]/.test(plan.reason)))
    return `${operation} 需要单行 PLAN.reason（最多 500 UTF-8 字节）`;
  if(!permissions.some((name,index)=>name===flag&&permissions[index+1]===plan.taskKey))return `${operation} 需要 permissions 中的 ${flag} ${plan.taskKey}`;
  return null;
}
export function batchDevelopAttempts(state,key,permissions){
  // The round-1 review this launch authorizes may lead into round 2 within the
  // same advance (Codex round 1 on Q28): list it too; a missing a2 answer then
  // holds the task after that review (revision_answer_required) instead of
  // sending an unanswerable develop request.
  const reviewNext=state.attempt===1&&permissions.some((flag,index)=>flag==='--allow-review'&&permissions[index+1]===`${key}:1`);
  // A re-check (check_answer_*) re-runs only the checks: no developer answer for this round.
  if(state.state==='blocked'&&RECHECK_CODES.includes(state.code))return reviewNext?[2]:[];
  if(developmentRetryable(state))return reviewNext?[1,2]:[state.attempt];
  if(state.state==='ready'&&state.attempt===1&&permissions.some((flag,index)=>
    flag==='--allow-review'&&permissions[index+1]===`${key}:1`))return [1,2];
  if(['ready','changes_requested'].includes(state.state))return [state.attempt];
  if(['awaiting_review','pending_review'].includes(state.state)&&state.attempt<2
    &&permissions.some((flag,index)=>flag==='--allow-review'
      &&permissions[index+1]===`${key}:${state.attempt}`))return [state.attempt+1];
  return [];
}
function actualCwd(bundle,key,generation=1){
  if(generation===2)return bundle.batch.codeProject;
  const group=bundle.batch.parallel?.find(group=>group.includes(key));
  if(!group)return bundle.batch.codeProject;
  const id=key.slice(key.lastIndexOf('/')+1);
  return path.resolve(bundle.batch.codeProject,'..','.cm-worktrees',bundle.batch.batchId.slice(0,8),id);
}
function checkCommandShape(commands,key,plan,executionPolicy){
  if(!Array.isArray(commands)||!commands.length||commands.length>32)stop(2,`任务 ${key} 会反问 check，但 PLAN.checks.${key} 缺少真实命令列表`);
  const ids=new Set();
  for(const item of commands){
    if(!isObject(item)||Object.keys(item).some(field=>!['id','command','timeoutMs',...(executionPolicy?['sameExecutionAs']:[])].includes(field))
      ||!nonempty(item.id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id)
      ||ids.has(item.id)||!Array.isArray(item.command)||!item.command.length
      ||item.command.some(arg=>typeof arg!=='string'||!arg.trim()||arg.includes('\0')))
      stop(2,`PLAN.checks.${key} 格式错误`);
    try{planCheckTimeout(plan,item);}catch(error){stop(2,error.message);}
    ids.add(item.id);
  }
  try{
    for(const [index,item] of commands.entries())if(Object.hasOwn(item,'sameExecutionAs')&&(index===0||planCheckTimeout(plan,item)!==planCheckTimeout(plan,commands[index-1])))throw Error('alias timeout mismatch');
    createHostCheck({cwd:process.cwd(),commands:commands.map(({timeoutMs,...item})=>item),reuseDeclared:executionPolicy!==null});
  }catch(error){stop(2,`PLAN.checks.${key} 格式错误: ${error.code??error.message}`);}
}
function preflight(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-ai-batch-drive.mjs --plan PLAN.json <operation>\n'
      +'operation: advance, status, cancel, reconcile_review（taskKey、invocationId）, develop_redo / abandon_effect / abandon_review / bootstrap_review_recover（resume、PLAN.taskKey、单行 PLAN.reason，permissions 带对应 --allow-… 任务）。PLAN: config, mode, hostContext, permissions, answers, checks, checkTimeoutMs。\n'
      +'checks 每项为 {id,command,timeoutMs?}；超时为 1..3600000 整数，默认 900000 ms（15 分钟）。\n'
      +'develop.json.edits 与单任务驾驶员相同：内容文件、{file,mode}、{mode}、{delete:true}；启动前同样拒绝超限、空交付与受保护模式下的非 UTF-8 内容（尚未开跑的后续任务不看代码树，只做答案本身就能判定的检查：单文件 1 MiB、答案写入的 scope 文件合计 2 MiB，等等；运行存档单条记录上限要看该任务开跑时的代码树，驾驶员事先算不出，超限交付写入后由宿主拦下，停在可重试的 blocked/develop_package_too_large）。\n'
      +'带 --allow-review 任务:1 但还没有 develop-a2.json 时照常启动：审查若要求修改，该任务停在 changes_requested（revision_answer_required），读 .reviews/<feature>-<task>-r1.md 的 findings 写好 develop-a2.json 后再 advance。\n');
    process.exit(0);
  }
  const loaded=loadPlanFile({name:'cm-ai-batch-drive.mjs',known:new Set(['advance','status','cancel','reconcile_review',...Object.keys(MEMBER_ACTION_FLAGS)])});
  const {plan,base,operation}=loaded;
  requireFields(plan,['config','mode','hostContext','permissions']);
  try{planCheckTimeout(plan);}catch(error){stop(2,error.message);}
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
    createCmAiBatch({configuration:batch,executionFor:async()=>({}),bootstrapKeys:Object.keys(bundle.bootstraps??{}),
      logHome:path.join(batch.specsDir,'.reviews','host-log-mirror')});
  }catch(error){stop(2,`批次定义、scope 或 workflow 无效: ${error.code??error.message}${error.code==='protected_scope'&&typeof error.reason==='string'?`；${error.reason}`:''}`);}
  const log=path.join(batch.specsDir,'运行日志.jsonl');
  // Members the batch already rescheduled into a serial second generation
  // (batch_member_blocked). Their gen-2 run starts fresh at attempt 1.
  const rescheduled=new Set(),handedOff=new Set();
  if(fs.existsSync(log))for(const line of fs.readFileSync(log,'utf8').split('\n')){
    if(!line.trim())continue;let row;try{row=JSON.parse(line);}catch{continue;}
    if(row?.workflow==='cm-ai'&&row.event==='decision'&&row.phase==='batch_member_blocked'&&row.run_id===batch.batchId
      &&row.generation===2&&typeof row.from_key==='string')rescheduled.add(row.from_key);
    // A handed-off task never develops again; a merged parallel member's worktree is gone,
    // so its journal cannot be replayed here (the batch host verifies it on its own).
    if(row?.workflow==='cm-ai'&&row.event==='decision'&&row.phase==='batch_handoff'&&row.run_id===batch.batchId
      &&typeof row.from_key==='string')handedOff.add(row.from_key);
  }
  const stores=Array.from(definitions.values(),d=>path.join(batch.specsDir,'.reviews','.execution',d.identity.runId,'state.json'));
  const hasLog=fs.existsSync(log),hasStore=stores.some(file=>fs.existsSync(file));
  if(plan.mode==='resume'&&!hasLog&&!hasStore)
    stop(2,`恢复存档不存在: ${log} / ${stores.join(', ')}`);
  if(plan.mode==='create'&&operation==='advance'&&(hasLog||hasStore))
    stop(2,`批次已有存档，请用 resume: ${log}`);
  if(operation==='status'&&!hasStore)stop(2,`只读 status 需要已有任务存档: ${stores.join(', ')}`);
  const argumentValue=name=>permissions.includes(name)?permissions[permissions.indexOf(name)+1]:undefined;
  if(argumentValue('--external-models-config'))permissions[permissions.indexOf('--external-models-config')+1]=path.resolve(base,argumentValue('--external-models-config'));
  const chosenRuntime=argumentValue('--runtime')??'codex';
  const routes=permissions.includes('--protected-config')?resolveProtectedRuntimes(loadConfig({projectRoot:batch.codeProject}),chosenRuntime):{reviewerRuntime:chosenRuntime};
  let executionPolicy;
  try{executionPolicy=readBatchExecutionPolicy({batch,started:hasStore,enabled:permissions.includes('--execution-optimizations')});}catch(error){stop(2,error.code??'execution_policy_invalid');}
  let externalModels;
  try{externalModels=readBatchExternalModels({batch,started:hasStore,enabled:permissions.includes('--external-models'),inputFile:argumentValue('--external-models-config'),providers:[routes.coderRuntime,routes.reviewerRuntime].filter(Boolean)});}catch(error){stop(2,error.code??'external_model_configuration_invalid');}
  if(operation==='reconcile_review'&&(plan.mode!=='resume'||!keys.includes(plan.taskKey)||!nonempty(plan.invocationId)))stop(2,'reconcile_review requires resume, taskKey and original invocationId');
  const memberError=batchMemberActionPlanError(operation,plan,permissions,keys);if(memberError)stop(2,memberError);
  for(let i=0;i<permissions.length;i++)if(PAIRS.has(permissions[i])){
    const name=permissions[i],value=permissions[++i];
    if(['--review-config','--protected-conversation-config','--protected-config'].includes(name)){
      const file=path.resolve(base,value),data=readJson(file,name);
      if(data===undefined)stop(2,`${name} 文件不存在: ${file}`);
      try{
        if(name==='--review-config')readConversationReviewConfiguration(file,externalModels?.providers[routes.reviewerRuntime]??null);
        else if(name==='--protected-conversation-config')readConversationProtection(file);
        else {
          if(!isObject(data)||Object.keys(data).some(key=>!['checkCommands','model','effort','timeoutMs'].includes(key))
            ||!externalModels&&(!nonempty(data.model)||!/^[A-Za-z0-9._-]+$/.test(data.model))
            ||!Number.isSafeInteger(data.timeoutMs)||data.timeoutMs<=0||data.timeoutMs>3600000)
            throw Error('invalid_protected_config');
          createHostCheck({cwd:batch.codeProject,commands:data.checkCommands,timeoutMs:data.timeoutMs});
        }
      }catch(error){stop(2,`${name} 配置无效: ${file}: ${error.code??error.message}`);}
      permissions[i]=file;
    }else if(Object.values(MEMBER_ACTION_FLAGS).includes(name)){
      if(!keys.includes(value))stop(2,`${name} 需要本批次的 FEATURE/TASK: ${value}`);
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
  let live;
  try{live=driverLiveEvidence(plan,{base,protectedRoots:[batch.codeProject,batch.specsDir,path.resolve(batch.codeProject,'..','.cm-worktrees'),...(batch.codeProjects??[])],
    allowedKinds:['qa_logic','qa_browser','verification_precheck'],maxBytes:inputLimitFrom(permissions)});}
  catch(error){stop(2,error.message);}
  if(operation==='advance'&&permissions.includes('--verification-precheck')&&!live.has('verification_precheck'))
    stop(2,'缺少真实执行 runner: verification_precheck；不能从静态答案文件应答');
  if(operation==='advance'&&bundle.bootstraps&&Object.keys(bundle.bootstraps).length)
    stop(2,'缺少真实执行 runner: init_verify；不能从静态答案文件应答');
  const root=plan.answers?path.resolve(base,plan.answers):null,answers={},developAnswers=new Map(),holds=[];
  const inputLimit=inputLimitFrom(permissions);
  // Tasks that start from today's tree: the first task (and its parallel group) of
  // a new batch. Later tasks start from trees earlier tasks have not written yet.
  const firstGroup=batch.parallel?.find(group=>group.includes(keys[0]))??[keys[0]];
  if(operation==='advance')for(const task of batch.tasks){
    const key=taskKey(task),workflow=bundle.workflows[key],kinds=[];
    if(!providerAll)kinds.push('develop');
    if(!protectedMode){
      kinds.push('check');
      if(workflow?.documentationPaths?.length)kinds.push('documentation_sync');
    }
    if(workflow?.qa){
      // A rescheduled second generation runs serially and asks qa_assess like a serial task.
      if(!batch.parallel?.some(group=>group.includes(key))||rescheduled.has(key))kinds.push('qa_assess');
      const cases=readJson(path.join(batch.specsDir,task.feature,'test-cases.json'),'test-cases');
      for(const kind of ['logic','browser'])if(cases?.cases?.some(item=>item.kind===kind))kinds.push(`qa_${kind}`);
    }
    if(workflow)kinds.push('documentation_inspect');
    const evidence=kinds.filter(kind=>['qa_logic','qa_browser'].includes(kind)&&!live.has(kind));
    if(evidence.length)stop(2,`缺少真实执行 runner: ${evidence.join(', ')}；不能从静态答案文件应答`);
    if(kinds.includes('check'))checkCommandShape(plan.checks?.[key],key,plan,executionPolicy);
    const taskRoot=root&&path.join(root,task.feature,task.taskId);
    const perAttempt=new Map();
    if(kinds.includes('develop')){
      let attempts=[1],current=1,journal=null;
      if(plan.mode==='resume'&&handedOff.has(key)){attempts=[];journal={handedOff:true};}
      else if(plan.mode==='resume'){
        const runIds=[...runs].filter(([,binding])=>binding.key===key).sort((a,b)=>b[1].generation-a[1].generation);
        // A rescheduled member whose gen-2 run does not exist yet is a new run: preflight
        // its attempt-1 answer instead of the finished first generation.
        const existing=runIds.find(([runId,binding])=>(binding.generation===2||!rescheduled.has(key))
          &&fs.existsSync(path.join(batch.specsDir,'.reviews','.execution',runId,'state.json')));
        if(existing)try{
          const snapshot=readExecutionSnapshot({specsRoot:batch.specsDir,identity:{repositoryId:batch.repositoryId,runId:existing[0]}});
          const history=readRunnerHistory(snapshot.records,snapshot.records[0].payload.config,3);
          // Q28: decide from what the host will show (projected answer-gap blocks), not the raw replay state.
          attempts=batchDevelopAttempts(projectedRunnerStatus(history,snapshot.records[0].payload.config),key,permissions);current=history.state.attempt;
          journal={baseline:snapshot.records[0].payload.baseline,generation:existing[1].generation,
            frame:journalRestBytes(snapshot.records)};
        }catch(error){stop(2,`任务 ${key} 无法只读检查恢复存档: ${error.code??error.message}`);}
      }
      // A task with no run yet (a new batch, or a later task on resume) starts at
      // attempt 1; a first-round review grant can then reach attempt 2 as well.
      if(journal===null&&permissions.some((flag,index)=>flag==='--allow-review'&&permissions[index+1]===`${key}:1`))attempts=[1,2];
      const deliveries=[],definition=definitions.get(key);
      for(const attempt of attempts){
        const file=path.join(taskRoot??'',developFilename(taskRoot??'',attempt));
        if(!taskRoot||!fs.existsSync(file)){
          // A later attempt is only reached if the review this launch authorizes asks
          // for changes. Without its answer the task stops right after that review.
          if(attempt>current){
            holds.push(key);
            stderr(`任务 ${key} 没有 ${path.basename(file)}：本次授权的审查若要求修改，任务会停在 changes_requested（revision_answer_required），不会发起第 ${attempt} 轮开发；读取 .reviews/${task.feature.replace(/^\d+\./,'')}-${task.taskId}-r${attempt-1}.md 的 findings，写 ${file} 后再 advance`);
            continue;
          }
          stop(2,attempt===1?`任务 ${key} 会反问 develop，但答案文件不存在: ${file}`
            :`任务 ${key} 已在第 ${attempt} 轮等待修订，但答案文件不存在: ${file}；读取 .reviews/${task.feature.replace(/^\d+\./,'')}-${task.taskId}-r${attempt-1}.md 的 findings 后写入再 advance`);
        }
        const value=readJson(file,'develop');validateCmAiAnswer('develop',value,taskRoot);
        if(value.status==='succeeded')for(const target of Object.keys(value.edits))
          if(!definition.scope.includes(target))stop(2,`任务 ${key} ${path.basename(file)}.edits 越过批准 scope: ${target}`);
        perAttempt.set(attempt,value);deliveries.push({file,value,attempt});
      }
      if(deliveries.length){
        const known=journal!==null||plan.mode==='create'&&firstGroup.includes(key);
        const cwd=journal?actualCwd(bundle,key,journal.generation):batch.codeProject;
        const codeProject=fs.existsSync(cwd)?cwd:batch.codeProject;
        preflightDevelopDeliveries({deliveries,answersRoot:taskRoot,codeProject,
          scope:definition.scope,requirements:definition.requirements,diskChecks:known,
          baseline:journal?baselineScope(journal.baseline,definition.scope):'disk',protectedMode,inputLimit,
          checks:plannedCheckResults(protectedMode?null:plan.checks?.[key]),
          preview:known?developPreview({definition,codeProject,journal,
            parallelSelection:batch.parallel?.find(group=>group.includes(key))
              ?{version:1,group:batch.parallel.find(group=>group.includes(key)).map(member=>definitions.get(member).identity.taskId)}:null}):null});
      }
    }
    developAnswers.set(key,perAttempt);
    answers[key]=preflightAnswers(kinds.filter(kind=>KINDS[kind]&&kind!=='develop'),kind=>{
      const file=path.join(taskRoot??'',KINDS[kind]);
      if(!taskRoot||!fs.existsSync(file))stop(2,`任务 ${key} 会反问 ${kind}，但答案文件不存在: ${file}`);
      const value=readJson(file,kind);
      validateCmAiAnswer(kind,value,taskRoot);
      return value;
    });
    if(answers[key].documentation_sync)for(const target of Object.keys(answers[key].documentation_sync.edits))
      if(!workflow.documentationPaths.includes(target))stop(2,`任务 ${key} documentation-sync.json.edits 越过文档 scope: ${target}`);
  }
  return {...loaded,executionPolicy,bundle,definitions,runs,config,permissions,answers,developAnswers,answerRoot:root,holds,live};
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
async function answerFor(row,answers,paths,control){
  if(loaded.live.has(row.kind))return loaded.live.answer(row,control);
  const identity=row.payload.identity??row.payload.request?.identity;
  const binding=loaded.runs.get(identity?.runId),key=binding?.key;
  if(!Object.hasOwn(loaded.answers,key))return null;
  const cwd=actualCwd(loaded.bundle,key,binding.generation);
  const task=loaded.bundle.batch.tasks.find(task=>taskKey(task)===key);
  const root=path.join(loaded.answerRoot,task.feature,task.taskId);
  const value=row.kind==='develop'?loaded.developAnswers.get(key)?.get(identity?.attempt):loaded.answers[key][row.kind];
  if(row.kind==='check'){
    if(row.payload.codeProject!==cwd)return null;
    const results=[];
    const groups=[];
    for(const command of loaded.plan.checks[key]){
      const timeoutMs=planCheckTimeout(loaded.plan,command);
      if(groups.at(-1)?.timeoutMs!==timeoutMs)groups.push({timeoutMs,commands:[]});
      const {timeoutMs:ignored,...item}=command;groups.at(-1).commands.push(item);
    }
    for(const group of groups){
      let currentId=group.commands[0].id;
      const run=createHostCheck({cwd,commands:group.commands,reuseDeclared:loaded.executionPolicy!==null,
        timeoutMs:group.timeoutMs,onProgress:event=>{if(event.phase==='start')currentId=event.id;reportHostCheckProgress(event);},
        onOutput:({stream,chunk})=>process.stderr.write(`[drive check ${key} ${currentId} ${stream}] ${chunk.toString('utf8')}`)});
      const rows=await run({identity},control);results.push(...rows);if(rows.some(row=>row.outcome!=='passed'))break;
    }
    return results;
  }
  if(row.kind==='develop'){
    if(!value)throw Error(`任务 ${key} develop attempt ${identity?.attempt} 未预检，拒绝复用旧答案`);
    if(row.payload.codeProject!==cwd)return null;
    if(value.status!=='succeeded')return {status:'failed',code:value.code};
    if(row.payload.editMode==='protected-text-v1')return {status:'succeeded',value:value.value,
      edits:protectedDevelopEdits(value.edits,root,cwd,row.payload.expected)};
    applyDevelopEdits(value.edits,root,cwd,row.payload.request.payload.scope);
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
    '--allow-development',...permissions,...loaded.holds.flatMap(key=>['--hold-revision',key])],cwd:bundle.batch.codeProject,operation,request:operation==='reconcile_review'?{taskKey:plan.taskKey,invocationId:plan.invocationId}
      :Object.hasOwn(MEMBER_ACTION_FLAGS,operation)?{taskKey:plan.taskKey,reason:plan.reason}:{},
    answers:loaded.answers,answerFor});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main();
