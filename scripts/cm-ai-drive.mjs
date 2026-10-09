#!/usr/bin/env node
// cm-ai host 的单步驾驶员。PLAN 路径相对 PLAN 文件；命令仅在 codeProject 内执行。
// 请求表来自 host-session.mjs operationNames（传输允许集）、host-conversation-execution.mjs
// developer/check/verificationGate、host-workflow-capabilities.mjs QA/文档接线、
// host-qa-executor.mjs logic/browser 和 host-documentation.mjs sync、
// host-qa-fix-owner.mjs fix_* 转发 cm-fix。保守预检整个 operation 可达的反问。
// operation                         possible host_request kinds; proving route
// advance                            develop, check; bootstrap instructions replace develop with
//                                    init_generate (answer file) and init_verify (answer file plus
//                                    commands this driver runs; drive-bootstrap.mjs);
//                                    workflow adds documentation_sync,
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
// status/cancel/abandon_review/abandon_effect/bootstrap_review_recover/develop_redo/fix_status/context_refresh: none; cm-ai-conversation-entry.mjs
//                                    status/cancel/context_refresh; host-qa-fix-owner.mjs fix_status.
// verification_precheck              optional execution.verificationGate in
//                                    host-conversation-execution.mjs; CLI has no runner for it.
// host-session.mjs's remaining names belong to other workflow hosts and are
// intentionally not advertised as cm-ai operations.
// For unsupported evidence kinds, preflight refuses before the host starts.
import fs from 'node:fs';
import {readLaunchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createHostCheck,reportHostCheckProgress} from '../runtime/js/cm-ai/host-check.mjs';
import {decideHostQaPolicy} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {inspectCmAiQaTaskContext} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {readLearningRetrospectiveContent} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {inspectFixInvestigation} from '../runtime/js/cm-fix/investigation.mjs';
import {readRunDefinition,assertCreatableRunId} from './cm-ai-run.mjs';
import {REVIEW_MATERIAL_LIMITS,captureReviewBaseline,reviewMaterialSizes,projectedReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve,taskReviewScope} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {hostHandoffDocument} from '../runtime/js/cm-ai/host-handoff.mjs';
import {taskLearningHandoffBytes} from '../runtime/js/cm-ai/cm-ai-learning-handoff-writer.mjs';
import {projectLearningWriteback} from '../runtime/js/cm-ai/cm-ai-learning-writer.mjs';
import {inspectCmAiTaskLearningInput,createCmAiTaskLearningApplication,
  createCmAiTaskLearningRetrospective} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {codeProjectPaths,resolveCodeProjects} from '../runtime/js/cm-ai/code-projects.mjs';
import {parseHostInputLimit} from '../runtime/js/cm-ai/host-session.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readCloseoutReport} from '../runtime/js/cm-ai/knowledge-closeout.mjs';
import {readRunnerHistory,attemptBaseline,projectedRunnerStatus,RECHECK_CODES} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {developmentRetryable} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost,planCheckTimeout} from '../runtime/js/cm-ai/drive-core.mjs';
import {attemptAnswerName,inspectDriverBootstrap,readBootstrapRulesAnswers,createBootstrapRulesResponder} from '../runtime/js/cm-ai/drive-bootstrap.mjs';
import {driverLiveEvidence} from '../runtime/js/cm-ai/live-evidence.mjs';

// PLAN.liveEvidence: fresh current-session evidence; see docs/live-evidence-drivers.md.
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const OPERATIONS=new Set(['advance','start','resume','status','cancel','reconcile_review','abandon_review','abandon_effect','bootstrap_review_recover','develop_redo','decision','complete','qa','qa_result',
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
  'cause_review_package','cause_review','reconcile_review','abandon_step','abandon_review']);
const FILES={develop:'develop.json',qa_assess:'qa-assess.json',documentation_inspect:'documentation-inspect.json',
  documentation_sync:'documentation-sync.json',fix_learning:'learning.json',fix_diagnose:'diagnosis.json',
  fix_test_author:'test-edits.json',fix_repair:'repair-edits.json',fix_retrospective:'retrospective.json'};
const PAIR_FLAGS=new Set(['--external-models-config','--allow-review-attempt','--review-config','--workflow-config',
  '--input-limit',
  '--protected-conversation-config','--protected-config','--revise-qa-config','--qa-config-revision-reason','--qa-environment-failure',
  '--qa-fix-owner-config','--qa-fix-template-config','--qa-fix-review-config','--browser-qa',
  '--bootstrap-config','--allow-provider-development-attempt','--supersede-reason','--spec-rebind-reason',
  '--review-runtime','--feature']);
const FLAG_FLAGS=new Set(['--execution-optimizations','--external-models','--allow-development','--allow-qa','--allow-qa-fix-start','--auto-qa-fix',
  '--verification-precheck',
  '--allow-bootstrap-write','--allow-abandon-review','--allow-abandon-effect','--allow-bootstrap-review-recovery','--allow-develop-redo','--rerun-unknown-qa','--rerun-blocked-qa','--failover',
  '--supersede-reviewed-evidence','--accept-superseded-code-drift','--rebind-spec-material',
  ...['red-test','baseline','regression','learning-writeback','walkthrough','finish','abandon','abandon-review',
    'test-author','repair','cause-review','final-review'].map(name=>`--allow-qa-fix-${name}`)]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
// Needs the resolved --bootstrap-config path in permissions.
export const bootstrapDriverGap=(operation,definition,permissions)=>
  inspectDriverBootstrap({advance:ADVANCE.has(operation),definition,permissions}).gap;
export const abandonReviewPlanError=(operation,plan,permissions)=>operation!=='abandon_review'?null:
  plan.mode==='resume'&&permissions.includes('--allow-abandon-review')
  &&typeof plan.reason==='string'&&plan.reason.trim().length>0
  &&Buffer.byteLength(plan.reason,'utf8')<=500&&!/[\r\n\0]/.test(plan.reason)?null:
    'abandon_review 需要 resume、--allow-abandon-review 与单行 reason（最多 500 UTF-8 字节）';
export const abandonEffectPlanError=(operation,plan,permissions)=>operation!=='abandon_effect'?null:
  plan.mode==='resume'&&permissions.includes('--allow-abandon-effect')
  &&typeof plan.reason==='string'&&plan.reason.trim().length>0
  &&Buffer.byteLength(plan.reason,'utf8')<=500&&!/[\r\n\0]/.test(plan.reason)?null:
    'abandon_effect 需要 resume、--allow-abandon-effect 与单行 reason（最多 500 UTF-8 字节）';
export const developRedoPlanError=(operation,plan,permissions)=>operation!=='develop_redo'?null:
  plan.mode==='resume'&&permissions.includes('--allow-develop-redo')
  &&typeof plan.reason==='string'&&plan.reason.trim().length>0
  &&Buffer.byteLength(plan.reason,'utf8')<=500&&!/[\r\n\0]/.test(plan.reason)?null:
    'develop_redo 需要 resume、--allow-develop-redo 与单行 reason（最多 500 UTF-8 字节），并先确认会话已停止修改代码';
export const bootstrapReviewRecoveryPlanError=(operation,plan,permissions)=>operation!=='bootstrap_review_recover'?null:
  plan.mode==='resume'&&permissions.includes('--allow-bootstrap-review-recovery')
  &&typeof plan.reason==='string'&&plan.reason.trim().length>0
  &&Buffer.byteLength(plan.reason,'utf8')<=500&&!/[\r\n\0]/.test(plan.reason)?null:
    'bootstrap_review_recover 需要 resume、--allow-bootstrap-review-recovery 与单行 reason（最多 500 UTF-8 字节）';
function requireShape(ok,label){if(!ok)stop(2,`答案格式错误：${label}`);}
function exact(value,allowed,label){requireShape(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),label);}
function answerPath(root,file){return path.join(root,file);}
export const developFilename=(root,attempt)=>attemptAnswerName(root,'develop',attempt);
// develop.json.edits maps an approved scope path to one of:
//   "content-file"                 write these bytes (existing mode kept, new file 0644)
//   {file:"content-file",mode}     write, then set mode
//   {mode:"0755"|"0644"}           only change the permission bits of an existing file
//   {delete:true}                  delete an existing file
// A rename is a delete of the old path plus a write of the new one, both in scope.
const DEVELOP_MODES=new Map([['0644',0o644],['0755',0o755]]);
const answerError=message=>Object.assign(new Error(message),{answerShape:true});
function safeContentFile(local,root,label){
  if(!(typeof local==='string'&&local.length>0&&!path.isAbsolute(local)&&!local.split(/[\\/]/).includes('..')))
    throw answerError(`${label} 路径无效`);
  const file=answerPath(root,local);
  if(!(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()
    &&fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep)))throw answerError(`${label} 缺少安全的内容文件 ${file}`);
  return local;
}
export function readDevelopEntry(target,entry,root,label='develop.json.edits'){
  if(!nonempty(target))throw answerError(`${label} 路径无效`);
  if(typeof entry==='string')return {kind:'write',local:safeContentFile(entry,root,label)};
  const at=`${label}.${target}`;
  if(!object(entry))throw answerError(`${at} 应为内容文件名，或 {file,mode} / {mode} / {delete:true}`);
  const keys=Object.keys(entry).sort().join(',');
  if(Object.hasOwn(entry,'delete')){
    if(keys!=='delete')throw answerError(`${at}: delete 不能与 file、mode 同时出现`);
    if(entry.delete!==true)throw answerError(`${at}.delete 只能是 true`);
    return {kind:'delete'};
  }
  if(!['file','file,mode','mode'].includes(keys))throw answerError(`${at} 只允许 file、mode 或 delete 字段`);
  if(Object.hasOwn(entry,'mode')&&!DEVELOP_MODES.has(entry.mode))throw answerError(`${at}.mode 只能是字符串 "0644" 或 "0755"`);
  return Object.hasOwn(entry,'file')?{kind:'write',local:safeContentFile(entry.file,root,label),
    ...(Object.hasOwn(entry,'mode')?{mode:entry.mode}:{})}:{kind:'mode',mode:entry.mode};
}
function developEntries(map,root,label){
  if(!object(map))throw answerError(`${label} 应为路径到内容文件或权限/删除声明的对象`);
  return Object.entries(map).map(([target,entry])=>[target,readDevelopEntry(target,entry,root,label)]);
}
// Protected text mode carries content as JSON strings. Only well-formed UTF-8
// survives that round trip byte for byte (BOM and CRLF included); anything else
// would be silently replaced, so it is refused instead.
const strictUtf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function protectedText(bytes,target){
  try{return strictUtf8.decode(bytes);}
  catch{throw answerError(`${target} 不是合法 UTF-8 文本；受保护模式只能提交 UTF-8 文本，二进制文件（图片、证书等）请移出 scope 或改用非受保护模式`);}
}
export function protectedDevelopEdits(map,answersRoot,codeProject,expected){
  return developEntries(map,answersRoot,'develop.json.edits').map(([target,entry])=>{
    const beforeSha256=expected?.[target]??null;
    if(entry.kind==='delete')return {path:target,beforeSha256,content:null};
    const source=entry.kind==='mode'?path.join(codeProject,target):answerPath(answersRoot,entry.local);
    return {path:target,beforeSha256,content:protectedText(fs.readFileSync(source),target),
      ...(entry.mode?{mode:entry.mode}:{})};
  });
}
export function applyDevelopEdits(map,answersRoot,codeProject,allowed){
  const entries=developEntries(map,answersRoot,'develop.json.edits');
  for(const [target,entry] of entries){
    if(!allowed.includes(target))throw Error(`${target} 不在宿主允许的范围`);
    const file=path.resolve(codeProject,target);
    if(!file.startsWith(codeProject+path.sep))throw Error('编辑路径越界');
    for(let parent=path.dirname(file);parent!==codeProject;parent=path.dirname(parent))
      if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw Error('编辑路径经过符号链接');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('编辑路径是符号链接');
    if(entry.kind!=='write'&&!(fs.existsSync(file)&&fs.lstatSync(file).isFile()))throw Error(`${target} 不存在，无法删除或改权限`);
  }
  for(const [target,entry] of entries){
    const file=path.resolve(codeProject,target);
    if(entry.kind==='delete'){fs.unlinkSync(file);continue;}
    if(entry.kind==='mode'){fs.chmodSync(file,DEVELOP_MODES.get(entry.mode));continue;}
    const existed=fs.existsSync(file);
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,fs.readFileSync(answerPath(answersRoot,entry.local)));
    if(entry.mode||!existed)fs.chmodSync(file,entry.mode?DEVELOP_MODES.get(entry.mode):0o644);
  }
}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function diskScopeEntry(codeProject,target){
  const file=path.join(codeProject,target);let stat;
  try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink())return {unsupported:true};
  return {size:stat.size,mode:stat.mode&0o7777,source:file,
    sha256:stat.size<=REVIEW_MATERIAL_LIMITS.file?sha256(fs.readFileSync(file)):null};
}
const kib=bytes=>`${bytes} 字节`;
// Everything the runner would refuse only after the answer is written and the
// checks have run is refused here instead, with the path and the limit. The
// runner stays the authority; this is the same rule applied earlier.
// What the next develop starts from, read the way the runner will read it: the
// baseline (the one the host is about to capture for a new run, or the run's own
// journaled one), the material the review package snapshot selects from the
// current tree (scope, requirements and every AGENTS.md), and the journal bytes
// the rest of the develop checkpoint already takes. Null when the host itself
// will report the problem.
// The develop checkpoint is the package (projected exactly below, handoff
// included) plus the rest of the runner frame. For the rest the driver takes the
// previous checkpoint of this run and adds upper bounds for what the new
// develop adds: its call, its cache entry (the previous status plus that call),
// the Learning result and the check evidence the stand-in checks cannot know.
const FRAME_ALLOWANCE=16*1024,CHECK_EVIDENCE_ALLOWANCE=512;
const size=value=>Buffer.byteLength(JSON.stringify(value??null));
export function journalRestBytes(records){
  const last=records.findLast(row=>row.payload.type==='effect-checkpoint');
  if(!last)return {restBytes:0,resultBytes:0,receiptsBytes:2,callsBytes:2};
  const frame=last.payload.checkpoint;
  return {restBytes:size(last.payload)-size(frame.reviewPackage),resultBytes:size(frame.cache.at(-1)?.result),
    receiptsBytes:size(frame.receipts),callsBytes:size(frame.calls)};
}
export function developPreview({definition,codeProject=definition.codeProject,journal=null,parallelSelection=null,exact=true}){
  let baseline=journal?.baseline??null;
  try{
    if(baseline===null){
      // The same baseline the runner captures (taskReviewScope, specsRoot, specification).
      baseline=captureReviewBaseline({root:codeProject,specsRoot:definition.specsDir,identity:definition.identity,
        scope:taskReviewScope(definition.scope),requirements:definition.requirements,specification:{specsRoot:definition.specsDir,feature:definition.feature},
        ...(definition.codeProjects?{codeProjectPaths:codeProjectPaths(codeProject,resolveCodeProjects(codeProject,definition.codeProjects))}:{})});
      // The new run journals this baseline as one record, next to its own metadata.
      const bytes=Buffer.byteLength(JSON.stringify(baseline));
      if(bytes+FRAME_ALLOWANCE>JOURNAL_PAYLOAD_LIMIT){
        const largest=baseline.files.filter(file=>Object.hasOwn(file,'contentBase64')).sort((a,b)=>b.size-a.size).slice(0,3)
          .map(file=>`${file.path} ${kib(file.size)}`).join('，');
        stop(2,`任务基线的运行存档记录约 ${kib(bytes)}，超过单条记录上限 ${JOURNAL_PAYLOAD_LIMIT}（含运行元数据）；最大的基线材料是 ${largest}；请把大文件移出 scope/requirements 后再建运行`);
      }
    }
    return {definition,baseline,material:reviewMaterialSizes({root:codeProject,baseline}),parallelSelection,
      exact:exact&&!definition.codeProjects,...(journal?.frame??journalRestBytes([]))};
  }catch(error){
    if(error.code==='limit_exceeded')stop(2,`交付前的审查材料已超出审查包上限：${error.message}`);
    return null;
  }
}
// The package the runner will build for this delivery, byte for byte: the same
// Learning records, AGENTS.md writeback, handoff and package assembly, applied to
// the projected scope files. Digest values do not change any length, so the
// implementation hash stands in as 64 hex digits. Null when the runner would not
// build a package from it at all (blocked outcome, pending writeback, no change).
export function projectDevelopCheckpoint({preview,codeProject,attempt,value,projected,checks}){
  const {definition}=preview,identity={...definition.identity,attempt};
  if(value.value?.outcome!=='implemented')return null;
  const learningInput=inspectCmAiTaskLearningInput({specsDir:definition.specsDir,codeProject,feature:definition.feature,
    identity,applicableAgentFiles:[],...(definition.featureSelection?{featureSelection:definition.featureSelection.feature}:{})},{admission:null,parallelSelection:preview.parallelSelection});
  const binding={feature:definition.feature,identity,learningDigest:learningInput.learningDigest};
  const application=createCmAiTaskLearningApplication({...binding,...value.value.application});
  const retrospective=createCmAiTaskLearningRetrospective({...binding,...value.value.retrospective});
  const files=new Map(projected);let includeAgents=false;
  if(retrospective.status==='writeback_pending')return null;
  if(retrospective.status==='lesson_candidate'){
    const current=files.get('AGENTS.md'),disk=path.join(codeProject,'AGENTS.md');
    const exists=current?current.contentBase64!==null:fs.existsSync(disk);
    const source=!exists?'':current?Buffer.from(current.contentBase64,'base64').toString('utf8'):fs.readFileSync(disk,'utf8');
    const plan=projectLearningWriteback({source,retrospective});
    if(plan.outcome==='writeback_pending')return null;
    if(plan.outcome==='written'){includeAgents=true;files.set('AGENTS.md',{path:'AGENTS.md',
      contentBase64:Buffer.from(plan.content).toString('base64'),
      mode:current?.mode??(exists?fs.statSync(disk).mode&0o7777:0o644)});}
  }
  const baseline=attemptBaseline(preview.baseline,attempt),scopeFiles=[...files.values()];
  let initial;
  try{initial=projectedReviewPackage({root:codeProject,baseline,checks,scopeFiles});}
  catch(error){if(['empty_changes','out_of_scope','read_failed'].includes(error.code))return null;throw error;}
  const {payload}=hostHandoffDocument({baseline,checks,reviewPackage:initial,implementationSha256:'0'.repeat(64)});
  const handoff=taskLearningHandoffBytes({handoff:payload,feature:definition.feature,identity,learningInput,
    application,retrospective,includeAgents});
  const pkg=projectedReviewPackage({root:codeProject,baseline,checks,scopeFiles,handoff:{
    name:`${definition.feature.replace(/^\d+\./,'')}-${identity.taskId}-a${attempt}-handoff.json`,
    contentBase64:handoff.toString('base64'),mode:0o600}});
  return {pkg,learningBytes:size({application,retrospective})};
}
// Stand-in results for the declared checks: the package carries their ids and
// commands, and their real evidence is only known once they run.
export const plannedCheckResults=commands=>(Array.isArray(commands)&&commands.length?commands:[{id:'check',command:['check']}])
  .map(({id,command})=>({id,command,outcome:'passed',exitCode:0,evidence:'host check exited 0'}));
export function preflightDevelopDeliveries({deliveries,answersRoot,codeProject,scope,requirements,
  baseline='disk',diskChecks=true,protectedMode=false,inputLimit=65536,preview=null,checks=plannedCheckResults(null)}){
  const {file:FILE,total:TOTAL,count:COUNT}=REVIEW_MATERIAL_LIMITS;
  let material=diskChecks&&preview?new Map(preview.material.map(item=>[item.path,item.size])):null;
  const projected=new Map();
  let previous=diskChecks?new Map(scope.map(target=>[target,diskScopeEntry(codeProject,target)])):null;
  const base=!diskChecks?null:baseline==='disk'?previous:baseline;
  // Without the tree (a later batch task), the scope files the answers write are
  // still known to exist in the review material with exactly these sizes; the
  // unknown rest can only add to the total. Their count is at most the scope's,
  // which the run definition already caps at the package's file count. Which of
  // them the package carries in full depends on the baseline that task starts
  // from, so the driver cannot size its journal record here; an oversized
  // delivery is caught by the runner after it is written and stays retryable
  // (blocked/develop_package_too_large).
  const delivered=diskChecks?null:new Map();
  for(const {file,value,attempt=1} of deliveries){
    if(value.status!=='succeeded')continue;
    const label=path.basename(file);let entries;
    try{entries=developEntries(value.edits,answersRoot,`${label}.edits`);}catch(error){stop(2,`答案格式错误：${error.message}`);}
    const next=previous&&new Map(previous);
    for(const [target,entry] of entries){
      const before=previous?.get(target)??null;
      // Scope and requirements may overlap; every review package must still carry
      // each requirement file, so a delivery cannot delete one.
      if(entry.kind==='delete'&&requirements.includes(target))
        stop(2,`${label}.edits.${target}: 该路径同时列在运行定义的 requirements 中，审查包要求它存在，不能删除；可改写其内容，或先在新运行定义里把它移出 requirements`);
      if(entry.kind!=='write'){
        if(entry.kind==='delete')delivered?.delete(target);
        if(previous&&(before===null||before.unsupported))
          stop(2,`${label}.edits.${target}: 要${entry.kind==='delete'?'删除':'改权限'}的文件在交付前不存在或不是普通文件`);
        next?.set(target,entry.kind==='delete'?null:{...before,mode:DEVELOP_MODES.get(entry.mode)});
        continue;
      }
      const source=answerPath(answersRoot,entry.local),size=fs.lstatSync(source).size;
      if(size>FILE)stop(2,`${label}.edits.${target}: 内容 ${kib(size)}，超过审查包单文件上限 ${FILE}（1 MiB）；大文件请移出 scope`);
      if(scope.includes(target))delivered?.set(target,size);
      next?.set(target,{size,source,sha256:sha256(fs.readFileSync(source)),
        mode:entry.mode?DEVELOP_MODES.get(entry.mode):before&&!before.unsupported?before.mode:0o644});
    }
    if(protectedMode){
      const edits=[];
      try{
        for(const [target,entry] of entries){
          if(entry.kind==='delete'){edits.push({path:target,beforeSha256:'0'.repeat(64),content:null});continue;}
          const source=entry.kind==='write'?answerPath(answersRoot,entry.local):previous?.get(target)?.source??path.join(codeProject,target);
          if(!fs.existsSync(source))continue;
          edits.push({path:target,beforeSha256:'0'.repeat(64),content:protectedText(fs.readFileSync(source),target),
            ...(entry.mode?{mode:entry.mode}:{})});
        }
      }catch(error){stop(2,`${label}.edits: ${error.message}`);}
      const uuid='00000000-0000-4000-8000-000000000000';
      const bytes=Buffer.byteLength(JSON.stringify({type:'host_result',sessionId:uuid,callId:uuid,requestDigest:'0'.repeat(64),
        result:{status:'succeeded',value:value.value,edits}}));
      const max=4*1024*1024;
      if(bytes>inputLimit)stop(2,`${label} 在受保护模式下的应答约 ${kib(bytes)}，超过宿主输入上限 ${inputLimit}（--input-limit，默认 65536）；`
        +(bytes<=max?`在 PLAN.permissions 加 "--input-limit","${Math.min(max,2**Math.ceil(Math.log2(bytes)))}" 后重试`
          :`已超过 --input-limit 最大值 ${max}，受保护模式无法一次送达，请缩小本任务 scope 或拆分任务`));
    }
    if(delivered){
      const total=[...delivered.values()].reduce((sum,size)=>sum+size,0);
      const largest=[...delivered].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([target,size])=>`${target} ${kib(size)}`).join('，');
      if(total>TOTAL)stop(2,`${label}: 仅答案写入的 scope 文件就合计 ${kib(total)}，超过审查包上限 ${TOTAL}（2 MiB），与该任务开跑时的树无关；最大的是 ${largest}`);
    }
    if(!next)continue;
    for(const [target,entry] of next)if(entry&&!entry.unsupported&&entry.size>FILE)
      stop(2,`${label}: 交付后 ${target} 为 ${kib(entry.size)}，超过审查包单文件上限 ${FILE}（1 MiB）；大文件请移出 scope`);
    // The snapshot's material with this delivery's scope files applied on top.
    if(material){
      const after=new Map(material);
      for(const [target,entry] of next){if(entry&&!entry.unsupported)after.set(target,entry.size);else after.delete(target);}
      const total=[...after.values()].reduce((sum,size)=>sum+size,0);
      const largest=[...after].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([target,size])=>`${target} ${kib(size)}`).join('，');
      if(total>TOTAL)stop(2,`${label}: 交付后审查材料（scope、requirements 与树中全部 AGENTS.md 正文）合计 ${kib(total)}，超过审查包上限 ${TOTAL}（2 MiB）；最大的是 ${largest}`);
      if(after.size>COUNT)stop(2,`${label}: 交付后审查材料共 ${after.size} 个文件，超过审查包上限 ${COUNT}`);
      material=after;
    }
    // The develop checkpoint journals the review package as one record. Build the
    // package this delivery would produce with the runner's own assembly code and
    // check it, plus the rest of the checkpoint, against the same budget.
    const projectable=material&&entries.every(([target])=>!next.get(target)?.unsupported);
    if(projectable){
      for(const [target] of entries){
        const after=next.get(target);
        projected.set(target,after===null?{path:target,contentBase64:null,mode:null}
          :{path:target,contentBase64:fs.readFileSync(after.source).toString('base64'),mode:after.mode});
      }
      const projection=preview.exact?projectDevelopCheckpoint({preview,codeProject,attempt,value,projected,checks}):null;
      if(projection){
        const {pkg}=projection,packageBytes=size(pkg);
        const bytes=packageBytes+preview.restBytes+preview.resultBytes+projection.learningBytes
          +FRAME_ALLOWANCE+CHECK_EVIDENCE_ALLOWANCE*checks.length;
        const reserve=developCheckpointReserve({examinedPathsBytes:size(reviewPaths(pkg)),receiptsBytes:preview.receiptsBytes,
          callsBytes:preview.callsBytes+1024,writebackBytes:1024});
        const budget=JOURNAL_PAYLOAD_LIMIT-reserve;
        if(bytes>budget){
          const largest=pkg.changes.filter(change=>change.after).map(change=>change.after).sort((a,b)=>b.size-a.size).slice(0,3)
            .map(file=>`${file.path} ${kib(file.size)}`).join('，');
          stop(2,`${label}: 交付后的开发检查点约 ${kib(bytes)}（其中审查包 ${kib(packageBytes)}，含 handoff），超过运行存档单条记录上限 ${JOURNAL_PAYLOAD_LIMIT} `
            +`减去为有界审查与完成记录预留的 ${reserve}（即 ${budget}）；最大的改动文件是 ${largest}；请缩小这些文件或移出 scope`);
        }
      }
    }
    // A Learning writeback can still change AGENTS.md, so only a delivery that
    // cannot write it is known to be empty before the runner sees it.
    const lessonFree=value.value?.outcome==='implemented'&&value.value.retrospective?.status==='no_new_lesson';
    if(base&&lessonFree&&scope.every(target=>{
      const a=base.get(target)??null,b=next.get(target)??null;
      return a===null&&b===null||a!==null&&b!==null&&!a.unsupported&&!b.unsupported&&a.sha256!==null&&a.sha256===b.sha256&&a.mode===b.mode;
    }))stop(2,`${label}: 交付后与任务基线相比没有任何改动（edits 为空，或内容和权限都与基线相同）；审查包不能为空，请写入实际修改后再试`);
    previous=next;
  }
}
// The original baseline of an existing run, keyed by scope path, from its journal.
export function baselineScope(baseline,scope){
  const files=new Map((baseline?.files??[]).map(file=>[file.path,file]));
  return new Map(scope.map(target=>{const file=files.get(target);
    return [target,file?{size:file.size,mode:file.mode,sha256:file.sha256}:null];}));
}
export const inputLimitFrom=permissions=>{
  const at=permissions.indexOf('--input-limit');
  try{return parseHostInputLimit(at===-1?undefined:permissions[at+1]);}
  catch{stop(2,'--input-limit 需要 65536–4194304 的整数（字节）');}
};
// Read-only view of an existing run: its runner state and original baseline.
export function readRunJournal(definition){
  const snapshot=readExecutionSnapshot({specsRoot:definition.specsDir,identity:{
    repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});
  const first=snapshot.records[0];
  return {history:readRunnerHistory(snapshot.records,first.payload.config,3),config:first.payload.config,baseline:first.payload.baseline,
    frame:journalRestBytes(snapshot.records)};
}
function reachableDevelopAttempts({plan,operation,journal,permissions}){
  if(plan.mode==='create'){
    const reviewAfterDevelop=operation==='advance'
      &&permissions.some((flag,index)=>flag==='--allow-review-attempt'&&permissions[index+1]==='1');
    return {attempts:reviewAfterDevelop?[1,2]:[1],reviewFirst:false,reviewAfterDevelop,packageDigest:null,learning:null};
  }
  if(journal.error)stop(2,`无法只读检查恢复存档: ${journal.error.code??journal.error.message}`);
  // learning is the journal's Learning result the next develop effect starts from
  // (bootstrap rules bind their on-disk files to its recorded evidence).
  // Q28: decide from what the host will show (projected answer-gap blocks), not the raw replay state.
  return {...projectDevelopAttempts(projectedRunnerStatus(journal.history,journal.config),operation,permissions),
    learning:journal.history.state.learningResult??null};
}
export function projectDevelopAttempts(status,operation,permissions){
  const {state,attempt,reviewPackage}=status;
  // One advance can continue past the round-1 review into round 2 when it holds
  // --allow-review-attempt 1 (Codex round 1 on Q28): preflight that round too.
  const reviewAfterDevelop=operation==='advance'&&attempt===1
    &&permissions.some((flag,index)=>flag==='--allow-review-attempt'&&permissions[index+1]==='1');
  // A re-check (check_answer_*) re-runs only the checks: no developer answer for
  // this round, only for the round its review may lead to.
  if(state==='blocked'&&RECHECK_CODES.includes(status.code))
    return {attempts:reviewAfterDevelop?[2]:[],reviewFirst:false,reviewAfterDevelop,holdable:true,packageDigest:null};
  if(developmentRetryable(status))
    return {attempts:reviewAfterDevelop?[1,2]:[attempt],reviewFirst:false,reviewAfterDevelop,holdable:true,packageDigest:null};
  if(state==='ready'&&attempt===1&&operation==='advance'
    &&permissions.some((flag,index)=>flag==='--allow-review-attempt'&&permissions[index+1]==='1'))
    return {attempts:[1,2],reviewFirst:false,reviewAfterDevelop:true,packageDigest:null};
  if(['ready','changes_requested'].includes(state))return {attempts:[attempt],reviewFirst:false,packageDigest:null};
  if(operation==='advance'&&['awaiting_review','pending_review'].includes(state)
    &&permissions.some((flag,index)=>flag==='--allow-review-attempt'&&Number(permissions[index+1])===attempt)
    &&attempt<2)return {attempts:[attempt+1],reviewFirst:true,
      packageDigest:reviewPackage?.packageDigest??null};
  return {attempts:[],reviewFirst:false,packageDigest:null};
}
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
  // A case bound only to [DROPPED] tasks is never planned, so never asked.
  const dropped=new Set(context.dropped);
  const cases=plan.cases.filter(item=>!(item.taskIds.length>0&&item.taskIds.every(taskId=>dropped.has(taskId))))
    .filter(item=>pendingAfter===0||item.taskIds.every(taskId=>completed.has(taskId)));
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
      requireShape(object(value.edits),'develop.json.edits');
      try{developEntries(value.edits,root,'develop.json.edits');}catch(error){stop(2,`答案格式错误：${error.message}`);}
    }else {exact(value,['status','code'],'develop.json');requireShape(nonempty(value.code),'develop.json.code');}
  }else if(kind==='qa_assess'){
    try{decideHostQaPolicy({assessment:value,pending:1,mergeEligible:false,unassessedTasks:1});}
    catch{stop(2,'答案格式错误：qa-assess.json');}
  }else if(kind==='documentation_inspect'){
    exact(value,['status','reason','at','closeout'],'documentation-inspect.json');
    if(Object.hasOwn(value,'closeout'))try{readCloseoutReport(value.closeout);}
    catch{stop(2,'答案格式错误：documentation-inspect.json.closeout');}
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
    process.stdout.write('用法: cm-ai-drive.mjs --plan PLAN.json <operation>\nPLAN: config, mode, hostContext, originalHostContext (换会话 resume 必填), runtime, permissions, answers, checks, checkTimeoutMs。\nchecks 每项为 {id,command,timeoutMs?}；checkTimeoutMs 与每项 timeoutMs 为 1..3600000 整数，默认 900000 ms（15 分钟）。\nabandon_review 需要 mode:resume、permissions:["--allow-abandon-review"] 与 PLAN.reason；abandon_effect 需要 mode:resume、permissions:["--allow-abandon-effect"] 与 PLAN.reason（均为单行、最多 500 UTF-8 字节）。develop_redo 需要 mode:resume、permissions:["--allow-develop-redo"] 与 PLAN.reason，先确认会话已停止修改代码。 bootstrap_review_recover 需要 mode:resume、permissions:["--allow-bootstrap-review-recovery"] 与 PLAN.reason；只核对原运行的已写规则与 handoff，不需要答案文件。\n人工答案放 answers/；check 只运行 PLAN.checks，不读取静态执行证据。bootstrap T-001 骨架可用；T-002 规范任务（纯规范 scope、单代码根、非 --protected-config）读 answers/init-generate.json（{status:"generated",documents:[{path,contentFile}]}，覆盖全部 targets）与 answers/init-verify.json（commands 为驾驶员实跑的草稿命令 {id,command,timeoutMs?}，可选 commandsNotRun；checks 只含 globs/file_references/constraint_preservation/rule_applicability；constraintChanges:[]；application/retrospective 沿原 Learning）；第 1 轮也可用 *-a1.json，第 2 轮只读 init-generate-a2.json 与 init-verify-a2.json，且须先 decision 读取首轮 findings，不能带 --allow-review-attempt 跨轮。commands 在宿主接受启动后、发送操作前由驾驶员实跑（须先带 --allow-bootstrap-write 等宿主授权；受保护模式在 specs 沙箱内），失败或改动了预检核对的文件即退出 2 且不发送操作（create 时改用 resume 重跑）；结果只来自实跑，答案文件不能提供。\n'
      +'develop.json.edits 每项是 scope 路径到下列之一："内容文件"（写入；已有文件保留权限，新文件 0644）、{"file":"内容文件","mode":"0755"|"0644"}、{"mode":"0755"|"0644"}（只改已有文件权限）、{"delete":true}（删除已有文件）。改名 = 删旧路径 + 写新路径，两者都要在 scope 内；同时列在 requirements 里的路径不能删除。\n'
      +'启动前拒绝：单个 scope 文件超过 1 MiB、审查材料（按审查包快照：scope、requirements 与树中全部 AGENTS.md 正文）合计超过 2 MiB 或超过 256 个文件、交付后与任务基线完全相同（edits 为空或内容和权限都没变）、开发检查点（含 handoff 与 AGENTS.md 回写，按宿主同一套构建代码计）装不进运行存档单条 1 MiB 记录减去为有界审查与完成记录推出的预留，或任务基线装不进一条记录。受保护模式（--protected-conversation-config）只收合法 UTF-8 文本，应答大于 --input-limit（默认 65536）时提示应加的值。\n'
      +'runId 需 8–128 个字符（运行日志要求），create 前检查。resume 时按存档里的当前轮次发送 identity，第 2 轮的 decision/complete/qa 等无需手改。\n');
    process.exit(0);
  }
  const loaded=loadPlanFile({name:'cm-ai-drive.mjs',known:OPERATIONS});
  const {plan,operation,base}=loaded;
  requireFields(plan,['config','mode','hostContext','permissions']);
  if(Object.hasOwn(plan,'verificationPrecheck')&&typeof plan.verificationPrecheck!=='boolean')stop(2,'verificationPrecheck 需要 boolean');
  try{planCheckTimeout(plan);}catch(error){stop(2,error.message);}
  if(!['create','resume'].includes(plan.mode))stop(2,'mode 只能是 create 或 resume');
  if(!nonempty(plan.hostContext))stop(2,'hostContext 必须是当前真实会话 ID');
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
  if(permissions.includes('--accept-superseded-code-drift')&&!supersedeFlag)
    stop(2,'--accept-superseded-code-drift 需要 --supersede-reviewed-evidence 与 --supersede-reason');
  if(supersedeFlag&&plan.mode!=='create')stop(2,'supersede 只允许 mode create');
  if(permissions.includes('--rebind-spec-material')!==permissions.includes('--spec-rebind-reason')
    ||permissions.includes('--rebind-spec-material')&&plan.mode!=='resume')
    stop(2,'--rebind-spec-material 只用于 mode resume，并须同时提供 --spec-rebind-reason 原因');
  const abandonError=abandonReviewPlanError(operation,plan,permissions);
  if(abandonError)stop(2,abandonError);
  const abandonEffectError=abandonEffectPlanError(operation,plan,permissions);
  if(abandonEffectError)stop(2,abandonEffectError);
  const developRedoError=developRedoPlanError(operation,plan,permissions);
  if(developRedoError)stop(2,developRedoError);
  const bootstrapRecoveryError=bootstrapReviewRecoveryPlanError(operation,plan,permissions);
  if(bootstrapRecoveryError)stop(2,bootstrapRecoveryError);
  const config=path.resolve(base,plan.config),answers=plan.answers?path.resolve(base,plan.answers):null;
  if(!fs.existsSync(config))stop(2,`运行定义不存在: ${config}`);
  let definition;
  try{definition=readRunDefinition(config);}catch(error){stop(2,`运行定义无效或 codeProject/specsDir 无法解析: ${error.code??error.message}`);}
  // --feature is forwarded to the host, which binds it as featureSelection.
  // Use that same effective definition here (Learning input, bootstrap checks).
  const featureAt=permissions.indexOf('--feature');
  if(featureAt!==-1){
    const selected=permissions[featureAt+1];
    if(selected!==definition.feature||definition.featureSelection&&definition.featureSelection.feature!==selected)
      stop(2,`--feature ${selected} 必须与运行定义的 feature ${definition.feature} 一致`);
    definition={...definition,featureSelection:{version:1,feature:selected}};
  }
  if(plan.mode==='create')try{assertCreatableRunId(definition.identity);}
  catch(error){stop(2,`运行定义的 ${error.code.replace(/^invalid_config: /,'')}；宿主未启动，请换一个更长的 runId`);}
  const store=path.join(definition.specsDir,'.reviews','.execution',definition.identity.runId);
  if(plan.mode==='resume'&&!fs.existsSync(path.join(store,'state.json')))stop(2,`恢复存档不存在: ${store}`);
  let journal=null;
  if(plan.mode==='resume')try{journal=readRunJournal(definition);}catch(error){journal={error};}
  // The run definition always says attempt 1. Package-bound operations must name
  // the attempt the run is on now, so send that; an unreadable journal keeps the
  // original identity and the host decides, exactly as before.
  const identity=journal?.history?{...definition.identity,attempt:journal.history.state.attempt}:definition.identity;
  const workflowAt=permissions.indexOf('--workflow-config');let workflow=null;
  if(workflowAt!==-1){
    const file=path.resolve(base,permissions[workflowAt+1]);workflow=readJson(file,'workflow-config');
    if(workflow===undefined)stop(2,`workflow-config 不存在: ${file}`);
    permissions[workflowAt+1]=file;
  }
  const permissionFiles=[];
  for(let i=0;i<permissions.length;i++)if(PAIR_FLAGS.has(permissions[i])
    &&permissions[i]!=='--allow-review-attempt'&&permissions[i]!=='--browser-qa'
    &&permissions[i]!=='--qa-config-revision-reason'&&permissions[i]!=='--qa-environment-failure'&&permissions[i]!=='--allow-provider-development-attempt'
    &&permissions[i]!=='--supersede-reason'&&permissions[i]!=='--spec-rebind-reason'&&permissions[i]!=='--input-limit'
    &&permissions[i]!=='--review-runtime'&&permissions[i]!=='--feature'){
    const file=path.resolve(base,permissions[i+1]);if(!fs.existsSync(file))stop(2,`${permissions[i]} 文件不存在: ${file}`);
    permissions[i+1]=file;permissionFiles.push(file);i++;
  }
  const bootstrap=inspectDriverBootstrap({advance:ADVANCE.has(operation),definition,permissions});
  if(bootstrap.gap)stop(2,bootstrap.gap);
  const rules=bootstrap.mode==='instructions';
  const providerMode=permissions.includes('--protected-config');
  const protectedMode=providerMode||permissions.includes('--protected-conversation-config');
  const asks=[];
  if(ADVANCE.has(operation)){
    // A pure rules scope never reaches develop: host-bootstrap.mjs asks the session instead.
    if(rules)asks.push('init_generate','init_verify');
    else if(!providerMode)asks.push('develop');
    if(!protectedMode)asks.push('check');
  }
  if((plan.verificationPrecheck===true||permissions.includes('--verification-precheck'))&&(ADVANCE.has(operation)||operation==='complete'))asks.push('verification_precheck');
  if(operation==='complete'&&!protectedMode)asks.push('check');
  if((operation==='advance'||operation==='qa')&&workflow?.qa){asks.push('qa_assess');
  }
  if((operation==='advance'||operation==='qa')&&workflow?.qa){
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
    if(plan.fixOperation==='reconcile_review'&&(plan.mode!=='resume'||!nonempty(plan.invocationId)))stop(2,'fix reconciliation requires resume and original invocationId');
    if(!FIX_ACTIONS.has(plan.fixOperation))stop(2,'fix_action 需要宿主支持的 fixOperation');
    const abandonFlag=plan.fixOperation==='abandon_review'?'--allow-qa-fix-abandon-review':'--allow-qa-fix-abandon';
    if(['abandon_step','abandon_review'].includes(plan.fixOperation)&&(!nonempty(plan.reason)
      ||!permissions.includes(abandonFlag)))stop(2,`${plan.fixOperation} 需要 reason 与 ${abandonFlag}`);
    asks.push(...(FIX_ASKS[plan.fixOperation]??[]));
  }
  let live;
  try{live=driverLiveEvidence(plan,{base,protectedRoots:[definition.codeProject,...(definition.codeProjects??[]),definition.specsDir],
    allowedKinds:['qa_logic','qa_browser','verification_precheck'],maxBytes:inputLimitFrom(permissions)});}
  catch(error){stop(2,error.message);}
  const missing=asks.filter(kind=>['qa_logic','qa_browser','verification_precheck'].includes(kind)&&!live.has(kind));
  if(missing.length)stop(2,`缺少真实执行 runner: ${missing.join(', ')}；不能从静态答案文件应答`);
  const executionPolicy=readLaunchExecutionPolicy({definition,mode:plan.mode??'create',enabled:permissions.includes('--execution-optimizations')});
  if(asks.includes('check')){
    if(!Array.isArray(plan.checks)||plan.checks.length===0)stop(2,'步骤会反问 check，但 PLAN.checks 缺少真实命令列表');
    try{
      for(const item of plan.checks){
        if(!object(item)||Object.keys(item).some(key=>!['id','command','timeoutMs',...(executionPolicy?['sameExecutionAs']:[])].includes(key)))throw Error('PLAN.checks 每项只允许 id、command、timeoutMs');
        planCheckTimeout(plan,item);
      }
      for(const [index,item] of plan.checks.entries())if(Object.hasOwn(item,'sameExecutionAs')&&planCheckTimeout(plan,item)!==planCheckTimeout(plan,plan.checks[index-1]))throw Error('sameExecutionAs requires the same timeout');
      createHostCheck({cwd:definition.codeProject,reuseDeclared:executionPolicy!==null,commands:plan.checks.map(({timeoutMs,...item})=>item)});
    }
    catch(error){stop(2,`PLAN.checks 格式错误: ${error.code??error.message}`);}
  }
  const reachable=(asks.includes('develop')||rules)&&!providerMode
    ?reachableDevelopAttempts({plan,operation,journal,permissions})
    :{attempts:[],reviewFirst:false,packageDigest:null};
  const bootstrapAnswers=rules
    ?readBootstrapRulesAnswers({answers,operation,definition,plan,permissions,bootstrap,reachable}):null;
  const developAnswers=new Map(),deliveries=[];let holdRevision=false;
  if(asks.includes('develop'))for(const attempt of reachable.attempts){
    const file=answerPath(answers??'',developFilename(answers??'',attempt));
    if(!answers||!fs.existsSync(file)){
      const reviewFile=`.reviews/${definition.feature.replace(/^\d+\./,'')}-${definition.identity.taskId}-r1.md`;
      // Resuming a retryable block: let the redo and its review run, then stop
      // at changes_requested (revision_answer_required) instead of asking a
      // round-2 develop nobody can answer.
      if(reachable.reviewAfterDevelop&&reachable.holdable&&attempt===2){
        holdRevision=true;
        stderr(`没有 ${path.basename(file)}：本次 advance 的首轮审查若要求修改，任务会停在 changes_requested（revision_answer_required），不会发起第 2 轮开发；读取 ${reviewFile} 的 findings，写 answers/develop-a2.json 后再 advance`);
        continue;
      }
      if(reachable.reviewAfterDevelop&&attempt===2)
        stop(2,`缺少 ${file}；本次 advance 带 --allow-review-attempt 1，宿主完成首轮审查后可能直接进入第 2 轮 develop。可选：1) 从 PLAN.permissions 移除 --allow-review-attempt 1，先 advance 到 awaiting_review；再用该运行返回的 packageDigest 执行 decision，读取 ${reviewFile} 的 findings；若要求修改，写 answers/develop-a2.json 后 advance。2) 若有意一次跑完，预先写 answers/develop-a2.json 后重试 advance。develop-a2.json 必须针对首轮 findings 修改；与第 1 轮被要求修改的代码逐字节相同时，第 2 轮停在 blocked/develop_unchanged_after_review，不送审，改好后再 advance。`);
      if(reachable.reviewFirst)stop(2,`缺少 ${path.basename(file)}；请先以 decision 和当前 packageDigest ${reachable.packageDigest} 单独运行审查，读取 .reviews/${definition.feature.replace(/^\d+\./,'')}-${definition.identity.taskId}-r${attempt-1}.md 中的 findings，写 answers/develop-a${attempt}.json 后再 advance`);
      stop(2,`步骤 ${operation} 会反问 develop，但答案文件不存在: ${file}`);
    }
    const value=readJson(file,'develop');validateCmAiAnswer('develop',value,answers);
    if(value.status==='succeeded')for(const target of Object.keys(value.edits))
      if(!definition.scope.includes(target))stop(2,`${path.basename(file)}.edits 越过批准 scope: ${target}`);
    developAnswers.set(attempt,value);deliveries.push({file,value,attempt});
  }
  if(deliveries.length)preflightDevelopDeliveries({deliveries,answersRoot:answers,codeProject:definition.codeProject,
    scope:definition.scope,requirements:definition.requirements,
    baseline:plan.mode==='create'?'disk':baselineScope(journal.baseline,definition.scope),
    protectedMode,inputLimit:inputLimitFrom(permissions),checks:plannedCheckResults(protectedMode?null:plan.checks),
    preview:developPreview({definition,journal:plan.mode==='create'?null:journal,
      exact:!permissions.includes('--bootstrap-config')})});
  const unique=[...new Set(asks.filter(kind=>FILES[kind]&&kind!=='develop'))];
  const answer=preflightAnswers(unique,kind=>{
    const file=answerPath(answers??'',FILES[kind]);
    if(!answers||!fs.existsSync(file))stop(2,`步骤 ${operation} 会反问 ${kind}，但答案文件不存在: ${file}`);
    const value=readJson(file,kind);validateCmAiAnswer(kind,value,answers);return value;
  });
  if(answer.documentation_sync)for(const target of Object.keys(answer.documentation_sync.edits))
    if(!workflow.documentationPaths.includes(target))stop(2,`documentation-sync.json.edits 越过文档 scope: ${target}`);
  return {...loaded,definition,identity,permissions,config,answers,answer,developAnswers,live,executionPolicy,holdRevision,
    bootstrapRules:bootstrapAnswers&&createBootstrapRulesResponder({definition,plan,bootstrap,answers:bootstrapAnswers,
      // Same execution as the task checks: the host's specs sandbox in protected mode, else the driver's own.
      specsRoot:protectedMode?definition.specsDir:null,watch:[config,...permissionFiles]})};
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
async function answerFor(row,answer,paths,control){
  if(loaded.live.has(row.kind))return loaded.live.answer(row,control);
  if(['init_generate','init_verify'].includes(row.kind))return loaded.bootstrapRules?.[row.kind](row)??null;
  const kind=row.kind,value=kind==='develop'
    ?loaded.developAnswers.get(row.payload.request?.identity?.attempt??row.payload.identity?.attempt)
    :answer[kind];
  if(kind==='check'){
    const results=[];
    const groups=[];
    for(const command of loaded.plan.checks){
      const timeoutMs=planCheckTimeout(loaded.plan,command);
      if(groups.at(-1)?.timeoutMs!==timeoutMs)groups.push({timeoutMs,commands:[]});
      const {timeoutMs:ignored,...item}=command;groups.at(-1).commands.push(item);
    }
    for(const group of groups){
      let currentId=group.commands[0].id;
      const run=createHostCheck({cwd:loaded.definition.codeProject,commands:group.commands,
        reuseDeclared:loaded.executionPolicy!==null,timeoutMs:group.timeoutMs,
        onProgress:event=>{if(event.phase==='start')currentId=event.id;reportHostCheckProgress(event);},
        onOutput:({stream,chunk})=>{process.stderr.write(`[drive check ${currentId} ${stream}] ${chunk.toString('utf8')}`);}});
      const rows=await run({identity:row.payload.identity},control);results.push(...rows);
      if(rows.some(item=>item.outcome!=='passed'))break;
    }
    return results;
  }
  if(kind==='develop'){
    if(!value)throw Error(`develop attempt ${row.payload.request?.identity?.attempt??row.payload.identity?.attempt} 未预检，拒绝复用旧答案`);
    if(value.status!=='succeeded')return {status:'failed',code:value.code};
    if(row.payload.editMode==='protected-text-v1')return {status:'succeeded',value:value.value,
      edits:protectedDevelopEdits(value.edits,loaded.answers,loaded.definition.codeProject,row.payload.expected)};
    applyDevelopEdits(value.edits,loaded.answers,loaded.definition.codeProject,row.payload.request.payload.scope);
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
export function buildCmAiDriveRequest(operation,plan,definition,identity=definition.identity){
  return {version:1,identity,
    ...(operation==='reconcile_review'?{invocationId:plan.invocationId}:{}),
    ...(['abandon_review','abandon_effect','bootstrap_review_recover','develop_redo'].includes(operation)?{reason:plan.reason}:{}),
    ...(PACKAGE_OPERATIONS.has(operation)?{packageDigest:plan.packageDigest}:{}),
    ...(TEST_RUN_OPERATIONS.has(operation)?{testRunId:plan.testRunId}:{}),
    ...(['fix_status','fix_advance','fix_action','fix_run'].includes(operation)?{
      packageDigest:plan.packageDigest,testRunId:plan.testRunId,
      ...(operation==='fix_action'?{fixOperation:plan.fixOperation,...(plan.fixOperation==='reconcile_review'?{invocationId:plan.invocationId}:{}),
        ...(['abandon_step','abandon_review'].includes(plan.fixOperation)?{reason:plan.reason}:{})}: {})}: {})};
}
export function buildCmAiDriveHostArgs(plan,permissions,config){
  return ['serve','--config',config,'--mode',plan.mode,'--host-context',plan.hostContext,
    '--allow-development',
    ...(plan.verificationPrecheck===true&&!permissions.includes('--verification-precheck')?['--verification-precheck']:[]),
    ...(plan.originalHostContext?['--original-host-context',plan.originalHostContext]:[]),
    '--runtime',plan.runtime??'codex',...permissions.filter(flag=>flag!=='--allow-development')];
}
async function main(){
  loaded=load();
  const {plan,operation,definition,permissions,config,answer}=loaded;
  if(operation==='reconcile_review'&&(plan.mode!=='resume'||!nonempty(plan.invocationId)))
    stop(2,'reconcile_review requires resume and original invocationId');
  if(PACKAGE_OPERATIONS.has(operation)&&!(typeof plan.packageDigest==='string'&&/^[a-f0-9]{64}$/.test(plan.packageDigest)))
    stop(2,`${operation} 需要 packageDigest（64 位十六进制）`);
  if(TEST_RUN_OPERATIONS.has(operation)&&!(operation==='qa_result'?nonempty(plan.testRunId)
    :plan.testRunId===null||nonempty(plan.testRunId)))stop(2,`${operation} 需要 testRunId（可为 null）`);
  const request=buildCmAiDriveRequest(operation,plan,definition,loaded.identity);
  if(operation.startsWith('fix_')&&(!nonempty(plan.packageDigest)||!nonempty(plan.testRunId)))
    stop(2,`${operation} 需要 packageDigest 和 testRunId`);
  // Rules init_verify commands really run once the host has accepted the launch
  // (host_ready) and before the operation is sent: a failure never becomes an
  // unknown develop effect, and the host's own launch validation came first.
  driveHost({host:HOST,args:[...buildCmAiDriveHostArgs(plan,permissions,config),...(loaded.holdRevision?['--hold-revision']:[])],cwd:definition.codeProject,operation,request,
    answers:answer,paths:{answers:loaded.answers},answerFor,
    ...(loaded.bootstrapRules?{beforeRequest:()=>loaded.bootstrapRules.prepare(plan.mode)}:{})});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>stop(1,`驾驶员失败：${error.message}`));
