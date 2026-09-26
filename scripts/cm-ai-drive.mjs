#!/usr/bin/env node
// cm-ai host 的单步驾驶员。PLAN 路径相对 PLAN 文件；命令仅在 codeProject 内执行。
// 请求表来自 host-session.mjs operationNames（传输允许集）、host-conversation-execution.mjs
// developer/check/verificationGate、host-workflow-capabilities.mjs QA/文档接线、
// host-qa-executor.mjs logic/browser 和 host-documentation.mjs sync、
// host-qa-fix-owner.mjs fix_* 转发 cm-fix。保守预检整个 operation 可达的反问。
// operation                         possible host_request kinds; proving route
// advance                            develop, check; workflow adds documentation_sync,
//                                    qa_assess, qa_logic, qa_browser, documentation_inspect;
//                                    auto QA-fix adds fix_* below.
//                                    cm-ai-conversation-entry.mjs advance -> start/complete/qa/finish;
//                                    host-conversation-execution.mjs + host-workflow-capabilities.mjs.
// start/resume                        develop, check; cm-ai-conversation-entry.mjs start/resume
//                                    -> runner.executeEffect and host-conversation-execution.mjs.
// complete                            check; cm-ai-conversation-entry.mjs complete -> executeEffect.
// qa                                  qa_assess; cm-ai-conversation-entry.mjs qa
//                                    -> host-workflow-capabilities.mjs QA policy.
// finish/run_finalize                 documentation_inspect; cm-ai-conversation-entry.mjs
//                                    documentationFor -> host-workflow-capabilities.mjs.
// decision/qa_result                  none; cm-ai-conversation-entry.mjs decision/qa_result.
// fix_advance/fix_run                fix_learning, fix_diagnose, fix_test_author,
//                                    fix_repair, fix_retrospective; host-qa-fix-owner.mjs
//                                    forwards to cm-fix host.run/handle.
// fix_action                         selected cm-fix step; host-qa-fix-owner.mjs fix_action.
// status/cancel/fix_status/context_refresh: none; cm-ai-conversation-entry.mjs
//                                    status/cancel/context_refresh; host-qa-fix-owner.mjs fix_status.
// verification_precheck              optional execution.verificationGate in
//                                    host-conversation-execution.mjs; CLI has no runner for it.
// host-session.mjs's remaining names belong to other workflow hosts and are
// intentionally not advertised as cm-ai operations.
// For unsupported evidence kinds, preflight refuses before the host starts.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {decideHostQaPolicy} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {inspectCmAiQaTaskContext} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {readLearningRetrospectiveContent} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {inspectFixInvestigation} from '../runtime/js/cm-fix/investigation.mjs';
import {readRunDefinition} from './cm-ai-run.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const OPERATIONS=new Set(['advance','start','resume','status','cancel','decision','complete','qa','qa_result',
  'fix_status','fix_advance','fix_action','fix_run','run_finalize','context_refresh','finish']);
const ADVANCE=new Set(['advance','start','resume']);
const PACKAGE_OPERATIONS=new Set(['decision','complete','qa','qa_result','context_refresh','finish','run_finalize']);
const TEST_RUN_OPERATIONS=new Set(['qa_result','context_refresh','finish','run_finalize']);
const FIX_ASKS={advance:['fix_learning','fix_diagnose'],author_tests:['fix_learning','fix_test_author'],
  repair:['fix_learning','fix_repair'],retrospective:['fix_learning','fix_retrospective'],
  red_test:['fix_learning'],baseline:['fix_learning'],regression:['fix_learning'],
  post_review_regression:['fix_learning'],prepare_revision:['fix_learning']};
const FIX_ACTIONS=new Set(['red_test','baseline','author_tests','repair','regression','retrospective',
  'learning_writeback','handoff','final_review_package','final_review','publish_review','check_n5',
  'post_review_regression','publish_dossier','walkthrough','finish','prepare_revision',
  'cause_review_package','cause_review','abandon_step']);
const FILES={develop:'develop.json',qa_assess:'qa-assess.json',documentation_inspect:'documentation-inspect.json',
  documentation_sync:'documentation-sync.json',fix_learning:'learning.json',fix_diagnose:'diagnosis.json',
  fix_test_author:'test-edits.json',fix_repair:'repair-edits.json',fix_retrospective:'retrospective.json'};
const PAIR_FLAGS=new Set(['--allow-review-attempt','--review-config','--workflow-config',
  '--protected-conversation-config','--protected-config','--revise-qa-config','--qa-config-revision-reason',
  '--qa-fix-owner-config','--qa-fix-template-config','--qa-fix-review-config','--browser-qa',
  '--bootstrap-config','--allow-provider-development-attempt','--supersede-reason']);
const FLAG_FLAGS=new Set(['--allow-development','--allow-qa','--allow-qa-fix-start','--auto-qa-fix',
  '--allow-bootstrap-write','--rerun-unknown-qa','--rerun-blocked-qa','--failover',
  '--supersede-reviewed-evidence',
  ...['red-test','baseline','regression','learning-writeback','walkthrough','finish','abandon',
    'test-author','repair','cause-review','final-review'].map(name=>`--allow-qa-fix-${name}`)]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function requireShape(ok,label){if(!ok)stop(2,`答案格式错误：${label}`);}
function exact(value,allowed,label){requireShape(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),label);}
function answerPath(root,file){return path.join(root,file);}
function predictedQaAsks(definition,qa){
  // Reuse the executor's validated initial plan for policy applicability.
  // QA runs after this task completes, so project its task
  // state at that point before applying the executor's taskIds deferral rule.
  const executor=createHostQaExecutor({specsDir:definition.specsDir,codeProject:definition.codeProject,
    feature:definition.feature,requirements:definition.requirements,runtime:'codex',
    ...(definition.codeProjects?{codeProjects:definition.codeProjects}:{}),
    ...qa,timeoutMs:1800000,logHome:path.join(definition.specsDir,'.reviews','host-log-mirror')});
  const plan=executor.configuration.plan;
  const context=inspectCmAiQaTaskContext({specsDir:definition.specsDir,codeProject:definition.codeProject,
    feature:definition.feature});
  const completed=new Set(context.completed.filter(task=>task.feature===definition.feature).map(task=>task.id));
  const taskWasPending=!completed.has(definition.identity.taskId);
  completed.add(definition.identity.taskId);
  const pendingAfter=context.pending-(taskWasPending?1:0);
  const cases=plan.cases.filter(item=>pendingAfter===0||item.taskIds.every(taskId=>completed.has(taskId)));
  const asks=[];
  // The current executor still calls logic() for mapped cases; command evidence
  // only affects the later verdict. Keep the preflight conservative until that
  // runtime contract changes.
  if(cases.some(item=>item.kind==='logic'))
    asks.push('qa_logic');
  if(cases.some(item=>item.kind==='browser'&&!item.expected.some(value=>value.includes('[需确认]'))))
    asks.push('qa_browser');
  return asks;
}
function edits(value,root,label){
  requireShape(object(value),`${label} 应为路径到内容文件的对象`);
  for(const [target,local] of Object.entries(value)){
    requireShape(nonempty(target)&&typeof local==='string'&&local.length>0&&!path.isAbsolute(local)
      &&!local.split(/[\\/]/).includes('..'),`${label} 路径无效`);
    const file=answerPath(root,local);
    requireShape(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()
      &&fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep),`${label} 缺少安全的内容文件 ${file}`);
  }
}
export function validateCmAiAnswer(kind,value,root){
  if(kind==='develop'){
    requireShape(object(value)&&['succeeded','failed'].includes(value.status),'develop.json.status');
    if(value.status==='succeeded'){
      exact(value,['status','value','edits'],'develop.json');
      requireShape(object(value.value)&&['implemented','blocked'].includes(value.value.outcome),'develop.json.value.outcome');
      exact(value.value,['outcome','application','retrospective','reason'],'develop.json.value');
      if(value.value.outcome==='implemented')requireShape(object(value.value.application)
        &&['applied','no_relevant_lesson'].includes(value.value.application.status)
        &&(value.value.application.status==='applied'?nonempty(value.value.application.note):value.value.application.note===null)
        &&object(value.value.retrospective)&&Array.isArray(value.value.retrospective.candidates)
        &&['no_new_lesson','lesson_candidate','writeback_pending'].includes(value.value.retrospective.status),
      'develop.json.value Learning');
      if(value.value.application)exact(value.value.application,['status','note'],'develop.json.value.application');
      if(value.value.outcome==='implemented')try{readLearningRetrospectiveContent(value.value.retrospective);}
      catch{stop(2,'答案格式错误：develop.json.value.retrospective');}
      requireShape(object(value.edits),'develop.json.edits');edits(value.edits,root,'develop.json.edits');
    }else {exact(value,['status','code'],'develop.json');requireShape(nonempty(value.code),'develop.json.code');}
  }else if(kind==='qa_assess'){
    try{decideHostQaPolicy({assessment:value,pending:1,mergeEligible:false,unassessedTasks:1});}
    catch{stop(2,'答案格式错误：qa-assess.json');}
  }else if(kind==='documentation_inspect'){
    exact(value,['status','reason','at'],'documentation-inspect.json');
    requireShape(['completed','blocked'].includes(value.status)&&typeof value.reason==='string'
      &&value.reason.length<=200&&!/[\r\n\0]/.test(value.reason),'documentation-inspect.json');
    if(Object.hasOwn(value,'at'))requireShape(typeof value.at==='string'
      &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value.at)
      &&Number.isFinite(Date.parse(value.at)),'documentation-inspect.json.at');
  }
  else if(kind==='documentation_sync'){
    exact(value,['status','edits'],'documentation-sync.json');
    requireShape(object(value)&&value.status==='completed'&&object(value.edits),'documentation-sync.json');
    edits(value.edits,root,'documentation-sync.json.edits');
  }else if(kind==='fix_learning'){
    exact(value,['status','summary'],'learning.json');
    requireShape(['applied','no_relevant_lesson'].includes(value.status)
      &&nonempty(value.summary)&&value.summary.length<=1000&&!/[\r\n\0]/.test(value.summary),'learning.json');
  }else if(kind==='fix_diagnose'){
    exact(value,['status','rootCause','affectedPaths','plan','crossLayer','affectedModules','investigation'],'diagnosis.json');
    requireShape(['diagnosed','needs_evidence','design_change'].includes(value.status)
      &&nonempty(value.rootCause)&&nonempty(value.plan)&&typeof value.crossLayer==='boolean'
      &&Array.isArray(value.affectedPaths)&&value.affectedPaths.length>0
      &&Array.isArray(value.affectedModules)&&value.affectedModules.length>0
      &&[...value.affectedPaths,...value.affectedModules].every(item=>nonempty(item)
        &&!path.isAbsolute(item)&&!item.includes('\\')&&!item.split('/').includes('..')),'diagnosis.json');
    if(Object.hasOwn(value,'investigation'))try{inspectFixInvestigation(value.investigation,value.crossLayer);}
    catch{stop(2,'答案格式错误：diagnosis.json.investigation');}
  }
  else if(kind==='fix_retrospective')try{readLearningRetrospectiveContent(value);}
  catch{stop(2,'答案格式错误：retrospective.json');}
  else if(['fix_test_author','fix_repair'].includes(kind))edits(value,root,FILES[kind]);
}
function load(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-ai-drive.mjs --plan PLAN.json <operation>\nPLAN: config, mode, hostContext, originalHostContext (resume), runtime, permissions, answers, checks。\n人工答案放 answers/；check 只运行 PLAN.checks，不读取静态执行证据。\n');
    process.exit(0);
  }
  const loaded=loadPlanFile({name:'cm-ai-drive.mjs',known:OPERATIONS});
  const {plan,operation,base}=loaded;
  requireFields(plan,['config','mode','hostContext','permissions']);
  if(!['create','resume'].includes(plan.mode))stop(2,'mode 只能是 create 或 resume');
  if(!nonempty(plan.hostContext))stop(2,'hostContext 必须是当前真实会话 ID');
  if(plan.mode==='resume'&&!nonempty(plan.originalHostContext))stop(2,'resume 需要 originalHostContext');
  if(plan.mode==='create'&&plan.originalHostContext)stop(2,'originalHostContext 只在 resume 时有意义');
  if(!Array.isArray(plan.permissions)||!plan.permissions.every(x=>typeof x==='string'))stop(2,'permissions 必须是宿主参数数组');
  const permissions=[];
  for(let i=0;i<plan.permissions.length;i++){
    const flag=plan.permissions[i];
    if(FLAG_FLAGS.has(flag))permissions.push(flag);
    else if(PAIR_FLAGS.has(flag)&&nonempty(plan.permissions[i+1]))permissions.push(flag,plan.permissions[++i]);
    else stop(2,`permissions 无效或缺少参数: ${flag}`);
  }
  const supersedeFlag=permissions.includes('--supersede-reviewed-evidence');
  const supersedeReason=permissions.includes('--supersede-reason');
  if(supersedeFlag!==supersedeReason)
    stop(2,'--supersede-reviewed-evidence 与 --supersede-reason 必须同时提供');
  if(supersedeFlag&&plan.mode!=='create')stop(2,'supersede 只允许 mode create');
  const config=path.resolve(base,plan.config),answers=plan.answers?path.resolve(base,plan.answers):null;
  if(!fs.existsSync(config))stop(2,`运行定义不存在: ${config}`);
  let definition;
  try{definition=readRunDefinition(config);}catch(error){stop(2,`运行定义无效或 codeProject/specsDir 无法解析: ${error.code??error.message}`);}
  const store=path.join(definition.specsDir,'.reviews','.execution',definition.identity.runId);
  if(plan.mode==='resume'&&!fs.existsSync(path.join(store,'state.json')))stop(2,`恢复存档不存在: ${store}`);
  const workflowAt=permissions.indexOf('--workflow-config');let workflow=null;
  if(workflowAt!==-1){
    const file=path.resolve(base,permissions[workflowAt+1]);workflow=readJson(file,'workflow-config');
    if(workflow===undefined)stop(2,`workflow-config 不存在: ${file}`);
    permissions[workflowAt+1]=file;
  }
  for(let i=0;i<permissions.length;i++)if(PAIR_FLAGS.has(permissions[i])
    &&permissions[i]!=='--allow-review-attempt'&&permissions[i]!=='--browser-qa'
    &&permissions[i]!=='--qa-config-revision-reason'&&permissions[i]!=='--allow-provider-development-attempt'
    &&permissions[i]!=='--supersede-reason'){
    const file=path.resolve(base,permissions[i+1]);if(!fs.existsSync(file))stop(2,`${permissions[i]} 文件不存在: ${file}`);
    permissions[i+1]=file;i++;
  }
  const providerMode=permissions.includes('--protected-config');
  const protectedMode=providerMode||permissions.includes('--protected-conversation-config');
  const asks=[];
  if(ADVANCE.has(operation)){
    if(!providerMode)asks.push('develop');
    if(!protectedMode)asks.push('check');
  }
  if(plan.verificationPrecheck===true&&(ADVANCE.has(operation)||operation==='complete'))asks.push('verification_precheck');
  if(operation==='complete'&&!protectedMode)asks.push('check');
  if((operation==='advance'||operation==='qa')&&workflow?.qa){asks.push('qa_assess');
  }
  if(operation==='advance'&&workflow?.qa){
    try{asks.push(...predictedQaAsks(definition,workflow.qa));}
    catch(error){stop(2,`QA 请求预测失败: ${error.code??error.message}`);}
  }
  if(operation==='advance'&&workflow?.documentationPaths?.length&&!protectedMode)asks.push('documentation_sync');
  if(['advance','finish','run_finalize'].includes(operation)&&workflow)asks.push('documentation_inspect');
  if(operation==='advance'&&permissions.includes('--auto-qa-fix')){
    asks.push(...new Set(Object.values(FIX_ASKS).flat()));
  }
  if(['fix_advance','fix_run'].includes(operation))asks.push(...new Set(Object.values(FIX_ASKS).flat()));
  if(operation==='fix_action'){
    if(!FIX_ACTIONS.has(plan.fixOperation))stop(2,'fix_action 需要宿主支持的 fixOperation');
    if(plan.fixOperation==='abandon_step'&&(!nonempty(plan.reason)
      ||!permissions.includes('--allow-qa-fix-abandon')))stop(2,'abandon_step 需要 reason 与 --allow-qa-fix-abandon');
    asks.push(...(FIX_ASKS[plan.fixOperation]??[]));
  }
  if(['qa_logic','qa_browser','verification_precheck'].some(kind=>asks.includes(kind)))
    stop(2,`缺少真实执行 runner: ${asks.filter(kind=>['qa_logic','qa_browser','verification_precheck'].includes(kind)).join(', ')}；不能从静态答案文件应答`);
  if(asks.includes('check')){
    if(!Array.isArray(plan.checks)||plan.checks.length===0)stop(2,'步骤会反问 check，但 PLAN.checks 缺少真实命令列表');
    try{createHostCheck({cwd:definition.codeProject,commands:plan.checks});}
    catch(error){stop(2,`PLAN.checks 格式错误: ${error.code??error.message}`);}
  }
  const unique=[...new Set(asks.filter(kind=>FILES[kind]))];
  const answer=preflightAnswers(unique,kind=>{
    const file=answerPath(answers??'',FILES[kind]);
    if(!answers||!fs.existsSync(file))stop(2,`步骤 ${operation} 会反问 ${kind}，但答案文件不存在: ${file}`);
    const value=readJson(file,kind);validateCmAiAnswer(kind,value,answers);return value;
  });
  if(answer.develop?.status==='succeeded')for(const target of Object.keys(answer.develop.edits))
    if(!definition.scope.includes(target))stop(2,`develop.json.edits 越过批准 scope: ${target}`);
  if(answer.documentation_sync)for(const target of Object.keys(answer.documentation_sync.edits))
    if(!workflow.documentationPaths.includes(target))stop(2,`documentation-sync.json.edits 越过文档 scope: ${target}`);
  return {...loaded,definition,permissions,config,answers,answer};
}
function applyEdits(map,root,allowed){
  for(const target of Object.keys(map)){
    if(!allowed.includes(target))throw Error(`${target} 不在宿主允许的范围`);
    const file=path.resolve(root,target);
    if(!file.startsWith(root+path.sep))throw Error('编辑路径越界');
    for(let parent=path.dirname(file);parent!==root;parent=path.dirname(parent))
      if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('编辑路径经过符号链接');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('编辑路径是符号链接');
  }
  for(const [target,local] of Object.entries(map)){
    const file=path.resolve(root,target);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,fs.readFileSync(path.join(loaded.answers,local)));
  }
}
let loaded;
export function qaFixAnswerFor(row,answer,answerRoot){
  const kind=row.kind,value=answer[kind];
  if(kind==='fix_learning')return {contextDigest:row.payload.contextDigest,status:value.status,summary:value.summary};
  if(['fix_test_author','fix_repair'].includes(kind)){
    const edits=[];for(const [target,local] of Object.entries(value)){
      if(!Object.hasOwn(row.payload.expected??{},target))return {outcome:'blocked',edits:[]};
      edits.push({path:target,beforeSha256:row.payload.expected[target],content:fs.readFileSync(path.join(answerRoot,local),'utf8')});
    }
    return {outcome:kind==='fix_repair'?'repaired':'authored',edits};
  }
  return value??null;
}
async function answerFor(row,answer){
  const kind=row.kind,value=answer[kind];
  if(kind==='check'){
    const results=[];
    for(const command of loaded.plan.checks){
      const run=createHostCheck({cwd:loaded.definition.codeProject,commands:[command],
        onOutput:({stream,chunk})=>{process.stderr.write(`[drive check ${command.id} ${stream}] ${chunk.toString('utf8')}`);}});
      const [item]=await run({identity:row.payload.identity},{signal:new AbortController().signal});
      results.push(item);
      if(item.outcome!=='passed')break;
    }
    return results;
  }
  if(kind==='develop'){
    if(value.status!=='succeeded')return {status:'failed',code:value.code};
    if(row.payload.editMode==='protected-text-v1'){
      const edits=Object.entries(value.edits).map(([target,local])=>({path:target,
        beforeSha256:row.payload.expected?.[target]??null,content:fs.readFileSync(path.join(loaded.answers,local),'utf8')}));
      return {status:'succeeded',value:value.value,edits};
    }
    applyEdits(value.edits,loaded.definition.codeProject,row.payload.request.payload.scope);
    return {status:'succeeded',value:value.value};
  }
  if(kind==='documentation_sync'){
    applyEdits(value.edits,loaded.definition.codeProject,row.payload.paths);return {status:'completed'};
  }
  if(kind==='documentation_inspect')return {...value,syncId:row.payload.syncId,identity:row.payload.identity,
    packageDigest:row.payload.packageDigest,contextDigest:row.payload.contextDigest,
    at:value.at??new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
  if(kind.startsWith('fix_'))return qaFixAnswerFor(row,answer,loaded.answers);
  return value??null;
}
function main(){
  loaded=load();
  const {plan,operation,definition,permissions,config,answer}=loaded;
  if(PACKAGE_OPERATIONS.has(operation)&&!(typeof plan.packageDigest==='string'&&/^[a-f0-9]{64}$/.test(plan.packageDigest)))
    stop(2,`${operation} 需要 packageDigest（64 位十六进制）`);
  if(TEST_RUN_OPERATIONS.has(operation)&&!(operation==='qa_result'?nonempty(plan.testRunId)
    :plan.testRunId===null||nonempty(plan.testRunId)))stop(2,`${operation} 需要 testRunId（可为 null）`);
  const request={version:1,identity:definition.identity,
    ...(PACKAGE_OPERATIONS.has(operation)?{packageDigest:plan.packageDigest}:{}),
    ...(TEST_RUN_OPERATIONS.has(operation)?{testRunId:plan.testRunId}:{}),
    ...(['fix_status','fix_advance','fix_action','fix_run'].includes(operation)?{
      packageDigest:plan.packageDigest,testRunId:plan.testRunId,
      ...(operation==='fix_action'?{fixOperation:plan.fixOperation,
        ...(plan.fixOperation==='abandon_step'?{reason:plan.reason}:{})}: {})}: {})};
  if(operation.startsWith('fix_')&&(!nonempty(plan.packageDigest)||!nonempty(plan.testRunId)))
    stop(2,`${operation} 需要 packageDigest 和 testRunId`);
  driveHost({host:HOST,args:['serve','--config',config,'--mode',plan.mode,'--host-context',plan.hostContext,
    '--allow-development',
    ...(plan.originalHostContext?['--original-host-context',plan.originalHostContext]:[]),
    '--runtime',plan.runtime??'codex',...permissions.filter(flag=>flag!=='--allow-development')],cwd:definition.codeProject,operation,request,
    answers:answer,paths:{answers:loaded.answers},answerFor});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main();
