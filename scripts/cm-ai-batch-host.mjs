#!/usr/bin/env node
import {readBatchExecutionPolicy,freezeBatchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import {readBatchExternalModels,freezeBatchExternalModels,batchModelsFile} from '../runtime/js/cm-ai/external-group-models.mjs';
// Current-conversation transport for the existing batch driver, not a new loop.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmAiBatch,batchTaskRunId,BATCH_MEMBER_ACTIONS} from './cm-ai-batch-run.mjs';
import {validEnvironmentFailureReason} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {assertCreatableScope} from './cm-ai-run.mjs';
import {createConversationExecution,readConversationReviewConfiguration,readConversationReviewConfigurationValue,readConversationProtection,runReviewPreflight} from './cm-ai-host.mjs';
import {loadConfig,resolveProtectedRuntimes} from './cm-workflow-config.mjs';
import {preflightMatches} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudePreflightMatches} from '../runtime/js/cm-ai/worker-claude.mjs';
import {createHostToolBridge,HOST_ANSWER_BACKSTOP_MS} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost,parseHostInputLimit,inputLimitReason} from '../runtime/js/cm-ai/host-session.mjs';
import {validateHostWorkflowConfiguration,featureHasBrowserCases,readBrowserCapability} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest,json,need,shape} from '../runtime/js/cm-ai/effect-contract.mjs';
import {identifyApprovedBootstrapFeature} from '../runtime/js/cm-ai/bootstrap-feature.mjs';

const usage='cm-ai-batch-host.mjs serve --config PATH --host-context ID --allow-development --review-config PATH (required for a new batch; later launches pass the same file) [--execution-optimizations] [--external-models [--external-models-config PATH]] [--runtime codex|claude] [--input-limit BYTES] [--allow-review FEATURE/TASK:1|2]... [--allow-qa] [--rerun-unknown-qa | --rerun-blocked-qa [--qa-environment-failure REASON]] [--allow-develop-redo FEATURE/TASK]... [--allow-abandon-effect FEATURE/TASK]... [--allow-abandon-review FEATURE/TASK]... [--allow-bootstrap-review-recovery FEATURE/TASK]... [--verification-precheck] [--browser-qa available|unavailable] [--protected-conversation-config PATH | --protected-config PATH] [--allow-provider-development FEATURE/TASK:1|2]... [--hold-revision FEATURE/TASK]...';
const safeCode=error=>typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'batch_host_failed';
// Operator-facing reasons the batch owner writes itself (R4); others stay redacted.
const REASONED=new Set(['batch_resources_open','legacy_preflight_cache_invalid']);
const boundedReason=error=>REASONED.has(error?.code)&&typeof error.reason==='string'&&error.reason.length<=8192&&!/[\r\n\0]/.test(error.reason)?error.reason:null;
const actionFlags=new Map(Object.entries(BATCH_MEMBER_ACTIONS).map(([name,{flag}])=>[flag,name]));
// Single-task recovery inputs a batch cannot take: each member's fingerprint binds
// the whole batch workflow map, and a member cannot be rebound alone.
const UNSUPPORTED={'--revise-qa-config':'batch_qa_revision_unavailable','--qa-config-revision-reason':'batch_qa_revision_unavailable',
  '--rebind-spec-material':'batch_spec_rebind_unavailable','--spec-rebind-reason':'batch_spec_rebind_unavailable'};
const UNSUPPORTED_REASON={batch_qa_revision_unavailable:'批次不能修订单个成员的 QA 配置：每个成员的运行指纹绑定整批 workflows，改一个成员会让其他成员都无法恢复，单任务宿主也打不开批次成员运行。出口：QA 环境问题用 --rerun-blocked-qa（必要时加 --qa-environment-failure 原因）；确需改 QA 命令，取消本批次后用单任务宿主 cm-ai-host.mjs 以 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做该任务',
  batch_spec_rebind_unavailable:'批次成员不能换绑规格。出口：还原这些规格改动并重新批准后继续本批次；或取消本批次，还原该任务已改动的代码后，用单任务宿主 cm-ai-host.mjs 以 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做该任务'};

export async function serveHostTransport(options,rawInputLimit,serve=serveCmAiHost){
  return serve({...options,inputLimit:parseHostInputLimit(rawInputLimit)});
}

// Before 53c385e an execution-policy batch (without external models) cached its member
// loopback preflights in .reviews/.execution/<batchId>/preflight-<task>.json. The
// external run guard refuses that non-run directory, so such a batch could never open
// a member again. A directory that is exactly that old cache (only 0600 single-link
// preflight files of this batch's parallel members, each still bound to the launch
// review model, disabled skills and the member worktree cwd) moves file by file to
// the current location; an identical file already there drops the old copy. Anything
// else is refused with the directory named and nothing moved, so it is checked by hand.
export function migrateLegacyPreflightCache(batch,review,runtime){
  const legacy=path.join(batch.specsDir,'.reviews','.execution',batch.batchId);
  let stat;try{stat=fs.lstatSync(legacy);}catch(error){if(error.code==='ENOENT')return {moved:[],dropped:[]};throw error;}
  const refuse=detail=>{throw Object.assign(new Error('legacy_preflight_cache_invalid'),{code:'legacy_preflight_cache_invalid',
    reason:`运行目录下的 ${legacy} 不是可识别的旧版并行成员预检缓存（${detail}）。外部运行守卫会把它当作无法核实的运行，批次成员打不开；宿主没有移动或删除其中任何文件。`
      +`下一步：只读核对该目录；确认只是旧版 preflight 缓存且没有进程在写后，把它移出 .reviews/.execution（例如移到 .reviews/external-preflight-legacy/），再用同一批次配置重新启动批次宿主并 advance，成员会重新做一次本地 loopback 预检`});};
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||fs.realpathSync(legacy)!==legacy)refuse('不是权限 0700 的普通目录');
  if(review===null)refuse('本次启动没有 --review-config，无法核对缓存绑定的审查模型');
  const members=new Map((batch.parallel??[]).flat().map(key=>[`preflight-${key.slice(key.lastIndexOf('/')+1)}.json`,key.slice(key.lastIndexOf('/')+1)]));
  // The target and its parent are checked before anything is moved or deleted,
  // whether or not a file will be moved; a missing one is created 0700 (one level at
  // a time) and checked again only right before the first move.
  const parent=path.join(batch.specsDir,'.reviews','external-preflight'),target=path.join(parent,batch.batchId);
  const targetDirectories=create=>{
    for(const directory of [parent,target]){
      if(create)try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      let info;try{info=fs.lstatSync(directory);}catch(error){if(error.code==='ENOENT'&&!create)return;throw error;}
      if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||fs.realpathSync(directory)!==directory)
        refuse(`新位置 ${directory} 不是权限 0700 的普通目录`);
    }
  };
  targetDirectories(false);
  // One read per file through a no-follow fd bound to the path's dev+ino; only these
  // exact bytes are validated and compared. links: 2 only for an interrupted move,
  // where the old and new names are the same inode.
  const pinned=(file,links=1)=>{
    let before;try{before=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==links||(before.mode&0o077)!==0||before.size>64*1024)
      refuse(`${file} 不是权限 0600、${links} 个链接的普通文件`);
    let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch{refuse(`${file} 无法按不跟随链接的方式打开`);}
    try{
      const info=fs.fstatSync(fd);
      if(info.dev!==before.dev||info.ino!==before.ino||!info.isFile()||info.nlink!==links)refuse(`${file} 在核对时被替换`);
      return {bytes:fs.readFileSync(fd),dev:info.dev,ino:info.ino};
    }finally{fs.closeSync(fd);}
  };
  const same=(left,right)=>left!==null&&right!==null&&left.dev===right.dev&&left.ino===right.ino&&left.bytes.equals(right.bytes);
  const plan=[];
  for(const entry of fs.readdirSync(legacy,{withFileTypes:true})){
    const taskId=members.get(entry.name);if(!taskId)refuse(`含有不属于本批次并行成员预检缓存的条目 ${entry.name}`);
    const file=path.join(legacy,entry.name),destination=path.join(target,entry.name);
    let interrupted=false;
    try{const a=fs.lstatSync(file),b=fs.lstatSync(destination);interrupted=a.dev===b.dev&&a.ino===b.ino;}catch(error){if(error.code!=='ENOENT')throw error;}
    const source=pinned(file,interrupted?2:1);
    if(source===null)refuse(`${entry.name} 在核对时消失`);
    const cwd=path.resolve(batch.codeProject,'..','.cm-worktrees',batch.batchId.slice(0,8),taskId);
    const options={cwd,model:review.model,disabledSkills:review.disabledSkills,promptTransport:'stdin'};
    let cached;try{cached=readConversationReviewConfigurationValue(JSON.parse(source.bytes.toString('utf8')),null);}
    catch{refuse(`${entry.name} 不是预检缓存格式`);}
    if(Object.hasOwn(cached,'timeoutMs')||cached.model!==review.model||digest(cached.disabledSkills)!==digest(review.disabledSkills)
      ||!(runtime==='claude'?claudePreflightMatches:preflightMatches)(cached.preflight,options))
      refuse(`${entry.name} 绑定的审查模型、禁用技能或成员 worktree 指纹与本次启动不一致`);
    if(interrupted){plan.push({file,destination,source,action:'finish'});continue;}
    const existing=pinned(destination);
    if(existing!==null&&!existing.bytes.equals(source.bytes))refuse(`新位置 ${destination} 已有不同内容`);
    plan.push({file,destination,source,existing,action:existing===null?'move':'drop'});
  }
  // Commit without overwriting: link (fails on an existing name), re-read the linked
  // inode, then remove the old name. A duplicate is removed only after both sides are
  // re-read unchanged. A stop at any point leaves either the old file, or the same inode
  // under both names, which the next launch finishes ('finish').
  const moved=[],dropped=[];
  if(plan.some(item=>item.action==='move'))targetDirectories(true);
  for(const item of plan){
    const name=path.basename(item.file);
    if(item.action==='move'){
      try{fs.linkSync(item.file,item.destination);}
      catch(error){if(error.code==='EEXIST')refuse(`新位置 ${item.destination} 在迁移时出现`);throw error;}
      const linked=pinned(item.destination,2);
      if(!same(linked,item.source)){fs.unlinkSync(item.destination);refuse(`${name} 在迁移时被改动`);}
    }else if(item.action==='drop'){
      if(!same(pinned(item.file),item.source)||!same(pinned(item.destination),item.existing))refuse(`${name} 或新位置的副本在迁移时被改动`);
    }else if(!same(pinned(item.destination,2),item.source))refuse(`${name} 在迁移时被改动`);
    fs.unlinkSync(item.file);
    (item.action==='drop'?dropped:moved).push(name);
  }
  try{fs.rmdirSync(legacy);}catch(error){if(['ENOTEMPTY','EEXIST'].includes(error.code))refuse('迁移时目录里出现了新条目');throw error;}
  return {moved,dropped};
}
// strict: an execution-policy batch. Its member runs take the external run guard,
// which refuses any non-run directory under .reviews/.execution, so the loopback
// cache lives beside the external-model one instead.
async function memberReviewConfiguration(batch,definition,review,runtime,pair=null,allowPreflight=true,strict=false){
  if(strict&&!pair)migrateLegacyPreflightCache(batch,review,runtime);
  try{
    need(review!==null,'review_configuration_required');
    const options={cwd:definition.codeProject,model:review.model,...(pair?{effort:pair.effort}:{}),disabledSkills:review.disabledSkills,promptTransport:'stdin'};
    const matches=config=>config.model===review.model&&digest(config.disabledSkills)===digest(review.disabledSkills)
      &&(runtime==='claude'?claudePreflightMatches:preflightMatches)(config.preflight,options);
    const directory=path.join(batch.specsDir,'.reviews',...(pair||strict?['external-preflight']:['.execution']),batch.batchId);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    need(fs.realpathSync(directory)===directory,'invalid_preflight_cache');
    const file=path.join(directory,`preflight-${definition.identity.taskId}.json`);
    // The cached file stays a pure preflight diagnostic. The reviewer budget is a
    // launch argument, so it is applied on return and never written to the cache.
    const withTimeout=config=>review.timeoutMs==null?config:{...config,timeoutMs:review.timeoutMs};
    if(fs.existsSync(file)){
      const info=fs.lstatSync(file);need(info.isFile()&&!info.isSymbolicLink(),'invalid_preflight_cache');
      try{const cached=readConversationReviewConfiguration(file,pair);if(matches(cached))return withTimeout(cached);}
      catch{/* Invalid or obsolete diagnostics require a fresh loopback, never a rewritten fingerprint. */}
    }
    need(allowPreflight,'review_preflight_missing');
    const config=await runReviewPreflight(definition,{model:review.model,...(pair?{effort:pair.effort}:{}),runtime,disabledSkills:review.disabledSkills});
    need(matches(config),'review_preflight_failed');
    const temporary=`${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});
    try{fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return withTimeout(config);
  }catch{need(false,'review_preflight_failed');}
}

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Optional --execution-optimizations freezes policy v1 for new runs only; recovery retains the original policy and legacy runs reject retrofit. See docs/execution-optimizations.md.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('成员恢复（Q24）：--allow-develop-redo / --allow-abandon-effect / --allow-abandon-review / --allow-bootstrap-review-recovery FEATURE/TASK 各授权一次同名批次操作 {operation, requestId, taskKey, reason}，只转给批次当前停住的那个成员运行（同一 cm-ai 入口、只带这一项权限，不跨成员），之后 advance 继续本批次；缺授权返回 batch_member_action_authorization_required，非当前成员返回 batch_member_action_not_current。批次 cancel 后永久停止不变。--qa-environment-failure REASON 随 --rerun-blocked-qa / --rerun-unknown-qa 使用。--revise-qa-config 与 --rebind-spec-material 不支持（batch_qa_revision_unavailable / batch_spec_rebind_unavailable，原因里写明出口）。并行成员停在可在原运行内恢复的状态时返回 batch_parallel_member_recovery_required；结果未确认时返回 batch_parallel_member_unresolved 并留在原运行；只有原始存档为已 checkpoint 的 blocked 才改排串行第二代，且先停在 batch_member_rescheduled，下一次 advance 才开发第二代（普通批次与外部模型、执行策略批次相同）。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(usage+'\nOptional --input-limit BYTES sets the host input transport limit to an integer from 65536 to 4194304 (default 65536); it may change on resume.\nOptional --protected-conversation-config PATH uses the shared current-host scoped text proposals and native sandbox checks; {checkCommands,timeoutMs}. No extra model call, same Codex/Claude runtime and per-task Review permissions. Optional --protected-config PATH {model,checkCommands,timeoutMs} enables CLI development only for per-task --allow-provider-development FEATURE/TASK:1|2 grants; mutually exclusive with --protected-conversation-config. Optional bundle.bootstraps maps approved bootstrap task keys to {selection}; --allow-bootstrap-write grants only those fixed instruction/scaffold steps. Optional batch.codeProjects uses prefixed paths and checks with codeProject per command; one task remains one completion gate.\n--review-config PATH is required when no member run of the batch exists yet (like single-task create): it is bound into every member fingerprint and cannot be added on resume. It is {model,preflight[,disabledSkills][,timeoutMs]}; timeoutMs is the reviewer transport budget in milliseconds (integer 1-3600000, default 900000). It is independent of --protected-conversation-config/--protected-config and wins over their timeoutMs for the reviewer. It is not part of the authorized configuration digest, so a resumed run may raise it after review_transport_timeout.\n--browser-qa available|unavailable declares interactive QA capability for applicable feature carriers including browser and ios-simulator; the flag name is retained for compatibility.\nOptional --rerun-unknown-qa / --rerun-blocked-qa carry the same single-task QA recovery into a batch and require --allow-qa; they are mutually exclusive. A batch has no --mode, so each task applies the flag only when it resumes an existing run and has a QA executor; a created run or a task without QA ignores it rather than failing the whole batch. Semantics, limits and the qaRound cap are the single-task ones, unchanged.\nOptional --verification-precheck sends the written verification of the task and the collected checks back as a verification_precheck request before any handoff or review package is built. It may only block: a requirement reported unsatisfied stops the task at blocked / verification_precheck_failed with pendingAction resume and spends no review round. Passing it is not an approval, writes no receipt and does not replace the independent review. A task with no written verification is unaffected.\nOptional --hold-revision FEATURE/TASK (repeatable, launch-only, never persisted) stops that task after a changes_requested review with code revision_answer_required, before any second-round develop intent; the next launch without it resumes the revision. It only narrows what this launch does.\nBatch entry requires a clean Git main checkout (including untracked files); batch_main_dirty lists dirty files before any task or worktree starts. Serial tasks are committed automatically before batch_handoff, with task_commit recording the SHA (null if unchanged). A parallel member whose raw journal is a checkpointed blocked terminal preserves WIP on its retained branch and falls back once to serial generation 2 after ready members merge; that advance stops at batch_member_rescheduled and the next one develops generation 2. Unconfirmed members stay in their original run.\n');return 0;}
  let bridge;
  try{
    need(argv.length>=6&&argv[0]==='serve'&&argv[1]==='--config'&&argv[3]==='--host-context'
      &&argv[5]==='--allow-development','host_launch_authorization_required');
    const stat=fs.lstatSync(argv[2]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_batch_config');
    const bundle=json(JSON.parse(fs.readFileSync(argv[2],'utf8')));shape(bundle,['batch','workflows',...(Object.hasOwn(bundle,'bootstraps')?['bootstraps']:[])]);
    const {batch,workflows,bootstraps=null}=bundle;need(Array.isArray(batch.tasks),'invalid_batch_config');
    need(workflows!==null&&typeof workflows==='object'&&!Array.isArray(workflows),'invalid_batch_config');
    const keys=batch.tasks.map(task=>`${task.feature}/${task.taskId}`);
    if(bootstraps!==null){
      need(typeof bootstraps==='object'&&!Array.isArray(bootstraps),'invalid_bootstrap_config');
      for(const [key,config] of Object.entries(bootstraps)){
        need(keys.includes(key)&&key.startsWith(identifyApprovedBootstrapFeature(batch.specsDir)+'/'),'bootstrap_task_required');shape(config,['selection']);
      }
    }
    need(keys.length===Object.keys(workflows).length&&keys.every(key=>Object.hasOwn(workflows,key)),'workflow_task_mismatch');
    for(const key of keys)if(workflows[key]!==null)validateHostWorkflowConfiguration(workflows[key]);
    let review=null,allowQa=false,allowBootstrap=false,runtime=null,protection=null,providerConfig=null,browserQaFlag,inputLimitRaw;
    let rerunUnknownQa=false,rerunBlockedQa=false,verificationPrecheck=false,qaEnvironmentFailure=null;const approvals=new Set(),developments=new Map(),holds=new Set();
    const memberActions=Object.fromEntries(Object.keys(BATCH_MEMBER_ACTIONS).map(name=>[name,[]]));
    let externalEnabled=false,externalFile,executionPolicyEnabled=false;
    for(let index=6;index<argv.length;index++){
      const name=argv[index];
      if(name==='--execution-optimizations'){need(!executionPolicyEnabled,'invalid_arguments');executionPolicyEnabled=true;}
      else if(name==='--allow-qa'){need(!allowQa,'invalid_arguments');allowQa=true;}
      else if(name==='--rerun-unknown-qa'){need(!rerunUnknownQa,'invalid_arguments');rerunUnknownQa=true;}
      else if(name==='--rerun-blocked-qa'){need(!rerunBlockedQa,'invalid_arguments');rerunBlockedQa=true;}
      else if(name==='--verification-precheck'){need(!verificationPrecheck,'invalid_arguments');verificationPrecheck=true;}
      else if(name==='--qa-environment-failure'){
        need(qaEnvironmentFailure===null&&validEnvironmentFailureReason(argv[index+1]),'invalid_arguments');qaEnvironmentFailure=argv[++index];
      }
      else if(actionFlags.has(name)){
        // A recovery grant names one member; it is consumed by that member's first forwarded operation.
        const target=argv[++index],granted=memberActions[actionFlags.get(name)];
        if(!(typeof target==='string'&&keys.includes(target)&&!granted.includes(target)))
          throw Object.assign(new Error('invalid_arguments'),{code:'invalid_arguments',reason:`${name} 需要一个本批次的 FEATURE/TASK，且同一任务只给一次`});
        granted.push(target);
      }
      else if(Object.hasOwn(UNSUPPORTED,name)){
        const code=UNSUPPORTED[name];throw Object.assign(new Error(code),{code,reason:UNSUPPORTED_REASON[code]});
      }
      else if(name==='--browser-qa'){
        need(browserQaFlag===undefined&&typeof argv[index+1]==='string','invalid_arguments');browserQaFlag=argv[++index];
      }
      else if(name==='--allow-bootstrap-write'){need(!allowBootstrap&&bootstraps!==null,'invalid_arguments');allowBootstrap=true;}
      else if(name==='--protected-conversation-config'){
        need(protection===null&&providerConfig===null&&typeof argv[index+1]==='string','invalid_arguments');protection=readConversationProtection(argv[++index]);
      }
      else if(name==='--protected-config'){
        need(protection===null&&providerConfig===null&&typeof argv[index+1]==='string','invalid_arguments');
        const file=argv[++index],info=fs.lstatSync(file);
        need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_protected_config');
        providerConfig=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(providerConfig,['checkCommands','timeoutMs',...['model','effort'].filter(key=>Object.hasOwn(providerConfig,key))]);
      }
      else if(name==='--allow-provider-development'){
        const approval=argv[++index];need(typeof approval==='string','invalid_arguments');
        const split=approval.lastIndexOf(':'),key=approval.slice(0,split),attempt=approval.slice(split+1);
        need(keys.includes(key)&&['1','2'].includes(attempt),'invalid_arguments');
        need(!developments.has(key),'invalid_arguments');developments.set(key,Number(attempt));
      }
      else if(name==='--external-models'){need(!externalEnabled,'invalid_arguments');externalEnabled=true;}
      else if(name==='--external-models-config'){need(externalFile===undefined&&typeof argv[index+1]==='string','invalid_arguments');externalFile=argv[++index];}
      else if(name==='--runtime'){
        need(runtime===null&&['codex','claude'].includes(argv[index+1]),'invalid_runtime');runtime=argv[++index];
      }
      else if(name==='--input-limit'){
        need(inputLimitRaw===undefined&&typeof argv[index+1]==='string','invalid_arguments');
        inputLimitRaw=argv[++index];parseHostInputLimit(inputLimitRaw);
      }
      else if(name==='--review-config'){need(review===null&&typeof argv[index+1]==='string','invalid_arguments');review=argv[++index];}
      else if(name==='--hold-revision'){
        const held=argv[++index];need(typeof held==='string'&&keys.includes(held)&&!holds.has(held),'invalid_arguments');holds.add(held);
      }
      else if(name==='--allow-review'){
        const approval=argv[++index];need(typeof approval==='string'&&!approvals.has(approval),'invalid_arguments');
        const split=approval.lastIndexOf(':'),key=approval.slice(0,split),attempt=approval.slice(split+1);
        need(keys.includes(key)&&['1','2'].includes(attempt),'review_task_mismatch');approvals.add(approval);
      }else need(false,'invalid_arguments');
    }
    const started=keys.some(key=>fs.existsSync(path.join(batch.specsDir,'.reviews','.execution',batchTaskRunId(batch.batchId,key),'state.json')));
    // Same read-only create gate as the batch owner, before any model or policy configuration is read or frozen.
    for(const [index,task] of batch.tasks.entries())
      if(!Object.hasOwn(bootstraps??{},keys[index])&&!fs.existsSync(path.join(batch.specsDir,'.reviews','.execution',batchTaskRunId(batch.batchId,keys[index]),'state.json')))
        try{assertCreatableScope(task.scope);}catch(cause){cause.reason=`${keys[index]}: ${cause.reason}`;throw cause;}
    const executionPolicy=readBatchExecutionPolicy({batch,started,enabled:executionPolicyEnabled});
    const routes=providerConfig?resolveProtectedRuntimes(loadConfig({projectRoot:batch.codeProject}),runtime??'codex'):{reviewerRuntime:runtime??'codex'};
    const externalModels=readBatchExternalModels({batch,started,enabled:externalEnabled,inputFile:externalFile,providers:[routes.coderRuntime,routes.reviewerRuntime].filter(Boolean)});
    if(providerConfig&&!externalModels)shape(providerConfig,['model','checkCommands','timeoutMs']);
    if(providerConfig&&externalModels){
      const pair=externalModels.providers[routes.coderRuntime];
      need(!Object.hasOwn(providerConfig,'model')||providerConfig.model===pair.model,'external_model_configuration_conflict');
      need(!Object.hasOwn(providerConfig,'effort')||providerConfig.effort===pair.effort,'external_model_configuration_conflict');
      providerConfig={...providerConfig,...pair};
    }
    review=review===null?null:readConversationReviewConfiguration(review,externalModels?.providers[routes.reviewerRuntime]??null);
    need(!developments.size||providerConfig!==null,'protected_configuration_required');
    // Same launch-time assertion as the single-task host, evaluated across every
    // task whose approved contract can select a browser case.
    readBrowserCapability(browserQaFlag,keys.flatMap(key=>workflows[key]?.qa!=null
      &&featureHasBrowserCases(batch.specsDir,key.slice(0,key.lastIndexOf('/')),batch.codeProject)
        ?[workflows[key].qa.environment?.carrier??'browser']:[]));
    need(!approvals.size||review!==null,'review_configuration_required');
    // Same two guards as the single-task host. A batch has no --mode, so the
    // per-task resume check lives in createCmAiBatch rather than here.
    need(!(rerunUnknownQa&&rerunBlockedQa),'qa_recovery_authorization_required');
    need(!(rerunUnknownQa||rerunBlockedQa)||allowQa,'qa_recovery_authorization_required');
    need(qaEnvironmentFailure===null||rerunUnknownQa||rerunBlockedQa,'qa_recovery_authorization_required');
    need(allowQa||!Object.values(workflows).some(item=>item?.qa!=null),'qa_authorization_required');
    // Same rule as single-task create: the reviewer binding is part of every
    // member's durable fingerprint and cannot be added on resume. A batch none
    // of whose member runs exist yet is being created. Batches that already
    // started keep their original launch (older ones may have no review config).
    const created=keys.some(key=>fs.existsSync(path.join(path.resolve(batch.specsDir),'.reviews','.execution',
      batchTaskRunId(batch.batchId,key),'state.json')));
    if(!created&&review===null)throw Object.assign(new Error('review_configuration_required'),{code:'review_configuration_required',
      reason:'新批次必须带 --review-config：审查配置写进每个任务运行的指纹，恢复时不能再补。先用 cm-ai-host.mjs preflight 生成 review.json；'
        +'是否真正派发审查仍由 --allow-review 单独授权'});
    // Tool replies travel on the same input lines, so they share the one limit.
    bridge=createHostToolBridge({responseLimit:parseHostInputLimit(inputLimitRaw),answerTimeoutMs:HOST_ANSWER_BACKSTOP_MS});
    // The current conversation transport accepts one outstanding host call.
    // Queue those calls only; member runners and independent Review stay concurrent.
    let hostCallTail=Promise.resolve();
    const memberBridge={call(...args){
      const pending=hostCallTail.then(()=>bridge.call(...args));
      hostCallTail=pending.then(()=>{},()=>{});return pending;
    }};
    let reconciling=false;
    const driver=createCmAiBatch({configuration:{...batch,...(externalModels?{externalModels}:{}),...(executionPolicy?{executionPolicy}:{})},logHome:path.join(batch.specsDir,'.reviews','host-log-mirror'),
      runtime:runtime??'codex',checkCommands:(providerConfig??protection)?.checkCommands??null,checkTimeoutMs:(providerConfig??protection)?.timeoutMs??60000,
      rerunUnknownQa,rerunBlockedQa,qaEnvironmentFailure,memberActions,holdRevisions:[...holds],bootstrapKeys:Object.keys(bootstraps??{}),
      executionFor:async(definition,{parallelMember=false}={})=>{
        await freezeBatchExecutionPolicy(batch,executionPolicy);
        freezeBatchExternalModels(batch,externalModels);
        const key=`${definition.feature}/${definition.identity.taskId}`;
        const attempts=[1,2].filter(attempt=>approvals.has(`${key}:${attempt}`));
        const memberReview=parallelMember?await memberReviewConfiguration(batch,definition,review,externalModels?routes.reviewerRuntime:runtime??'codex',externalModels?.providers[routes.reviewerRuntime]??null,!reconciling,Boolean(executionPolicy)):review;
        const execution=createConversationExecution(definition,argv[4],parallelMember?memberBridge:bridge,memberReview,attempts,workflows[key],allowQa,runtime??'codex',
          {parallelMember,...(executionPolicy?{executionPolicy}:{}),...(externalModels?{externalModels,...(providerConfig?{reviewerRuntime:routes.reviewerRuntime}:{})}:{}),...(verificationPrecheck?{verificationPrecheck:true}:{}),batchWorkflowsDigest:digest(executionPolicy?{workflows,bootstraps,externalModels,executionPolicy}:externalModels?{workflows,bootstraps,externalModels}:bootstraps?{workflows,bootstraps}:workflows),qaLogHome:path.join(batch.specsDir,'.reviews','host-log-mirror'),
            // A protected CLI config also protects unauthorized tasks: they stay on the
            // current-session transport but with the same sandbox checks (protected-text edits).
            ...(protection?{protection}:providerConfig?{protection:{checkCommands:providerConfig.checkCommands,timeoutMs:providerConfig.timeoutMs}}:{}),
            ...(developments.has(key)?{
              providerDevelopment:{...(providerConfig.model?{model:providerConfig.model}:{}),...(Object.hasOwn(providerConfig,'effort')?{effort:providerConfig.effort}:{}),attempt:developments.get(key),
                ...resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime??'codex')},
            }:{}),...(bootstraps?.[key]?{bootstrap:{...bootstraps[key],allowWrite:allowBootstrap}}:{})});
        // Bind the entire approved capability map before the first task starts,
        // so a later task's commands/scope cannot silently change during resume.
        return execution;
      }});
    const host={async handle(request){
      try{reconciling=request.operation==='reconcile_review';return await driver.handle(request);}
      catch(cause){const reason=boundedReason(cause);return {outcome:'blocked',code:safeCode(cause),...(reason?{reason}:{})};}
    }};
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveHostTransport({host,input,output,toolBridge:bridge},inputLimitRaw);}
    finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){const code=safeCode(cause);error.write(JSON.stringify({error:{code,...(['browser_capability_required','browser_capability_unavailable','invalid_arguments','review_configuration_required','protected_scope',...Object.keys(UNSUPPORTED_REASON)].includes(code)
    &&typeof cause.reason==='string'?{reason:cause.reason}:{}),...(code==='request_too_large'?{reason:inputLimitReason(cause.limit)}:{})}})+'\n');return 1;}
  finally{bridge?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
