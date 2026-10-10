#!/usr/bin/env node
import {readLaunchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import {readLaunchExternalModels} from '../runtime/js/cm-ai/external-model-launch.mjs';
import {loadExternalModels,externalPair} from '../runtime/js/cm-ai/external-models.mjs';
// Opt-in current-conversation host. Review requires a separately authorized
// attempt and the registered V3 boundary; preflight is only local diagnostics.
import {selectExternalModels} from '../runtime/js/cm-ai/external-models.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {REVIEWED_HANDOFF_HINT} from '../runtime/js/cm-ai/host-handoff.mjs';
import {readRunDefinition,openControlRun,createCodexExecution,assertCreatableScope} from './cm-ai-run.mjs';
import {createConversationExecution as executionFor} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {createHostToolBridge,HOST_ANSWER_BACKSTOP_MS} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost,parseHostInputLimit,inputLimitReason} from '../runtime/js/cm-ai/host-session.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixLearningPreparation} from '../runtime/js/cm-fix/learning.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {loadConfig,declaredRuntimes,resolveProtectedRuntimes} from './cm-workflow-config.mjs';
import {readHostWorkflowConfiguration,featureHasBrowserCases,readBrowserCapability} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest,json,need,shape,id} from '../runtime/js/cm-ai/effect-contract.mjs';
export {executionFor as createConversationExecution,reviewConfiguration as readConversationReviewConfiguration};
export function withHandoffDiagnostic(host,error){
  return {...host,async handle(request){
    const result=await host.handle(request);
    if(result?.code==='handoff_exists')error.write(`[host] ${REVIEWED_HANDOFF_HINT}\n`);
    if(['out_of_scope','check_output_out_of_scope','unsupported_file','limit_exceeded','package_mismatch',
      'review_package_changed','completion_package_changed'].includes(result?.code)&&typeof result.reason==='string')
      error.write(`[host] ${result.reason}\n`);
    return result;
  }};
}
export {conversationProtection} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
export function readConversationProtection(file){
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_protected_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['checkCommands','timeoutMs']);return config;
}
export function readBootstrapConfiguration(file){
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_bootstrap_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['selection']);return config;
}
// Launch-input refusals keep their code and name the input, so the operator can
// find the exit without reading the host source.
const refuse=(ok,code,reason)=>{if(!ok)throw Object.assign(new Error(code),{code,reason});};
const REASONED_CODES=['supersede_unavailable','supersede_code_drift','handoff_exists','browser_capability_required',
  'browser_capability_unavailable','invalid_arguments','fingerprint_mismatch','task_selection_mismatch','review_configuration_required',
  'spec_rebind_refused','spec_rebind_unavailable','protected_scope'];
const fixLocalPermissions=new Map(['red-test','baseline','regression','learning-writeback','walkthrough','finish','abandon',
  'abandon-review','test-author','repair','cause-review','final-review','rediagnosis','rerun-blocked-step','final-review-recovery']
  .map(name=>[`--allow-qa-fix-${name}`,`--allow-${name}`]));

const usage='cm-ai-host.mjs serve --config RUN_DEFINITION.json --mode create|resume --host-context ID --allow-development --review-config PATH (required at create; resume passes the same file) [--original-host-context ID] [--runtime codex|claude] [--review-runtime codex|claude] [--feature N.slug] [--input-limit BYTES] [--failover] [--allow-review-attempt 1|2] [--allow-abandon-review] [--allow-abandon-effect] [--allow-bootstrap-review-recovery] [--allow-develop-redo] [--hold-revision] [--workflow-config PATH] [--allow-qa] [--browser-qa available|unavailable]\nInput limit is transport-only: integer 65536-4194304 bytes, default 65536; it bounds every input line and every tool reply, and may change on resume. A longer line stops the session with request_too_large. Review config is {model,preflight[,disabledSkills][,timeoutMs]}; timeoutMs is the reviewer transport budget in milliseconds (integer 1-3600000, default 900000), independent of protected mode and outside the authorized configuration digest. --browser-qa declares interactive QA capability for applicable carriers including browser and ios-simulator.\nNew runs: --external-models [--external-models-config FILE] freezes one pair per actual external provider; resume reads only its snapshot. preflight --config RUN_DEFINITION.json --external-provider codex|claude uses the saved pair.\ncm-ai-host.mjs preflight --config RUN_DEFINITION.json --review-model MODEL [--runtime codex|claude] (synthetic loopback only)';

export function formatClaudeModelHint(config,version=null){
  const marker=config?.preflight?.request_checks?.find(check=>check?.model_recognized===false);
  if(!marker)return null;
  const model=marker.reported_model??config.model;
  return `Model ${model} is not accepted by the installed Claude CLI${version?` (${version})`:''}. Try a family alias accepted by Claude CLI 2.1.x, for example claude-opus-5; this is not a list of available ids.`;
}
function claudeCliVersion(){
  try{
    const result=spawnSync('claude',['--version'],{encoding:'utf8',timeout:2000,maxBuffer:1024});
    const value=result.status===0?result.stdout.trim():'';
    return /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(value)?value:null;
  }catch{return null;}
}

export async function serveHostTransport(options,rawInputLimit,serve=serveCmAiHost){
  return serve({...options,inputLimit:parseHostInputLimit(rawInputLimit)});
}

function reviewConfiguration(file,pair=null){
  const info=fs.lstatSync(file);
  need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_review_config');
  let config=json(JSON.parse(fs.readFileSync(file,'utf8')));
  if(pair){need(!Object.hasOwn(config,'model')||config.model===pair.model,'external_model_configuration_conflict');
    need(!Object.hasOwn(config,'effort')||config.effort===pair.effort,'external_model_configuration_conflict');config={...config,...pair};}
  shape(config,['model','preflight',...(pair?['effort']:[]),...(Object.hasOwn(config,'disabledSkills')?['disabledSkills']:[]),
    ...(Object.hasOwn(config,'timeoutMs')?['timeoutMs']:[])]);
  need(typeof config.model==='string'&&/^[a-zA-Z0-9._-]+$/.test(config.model),'invalid_review_config');
  const disabledSkills=config.disabledSkills??[];
  need(Array.isArray(disabledSkills)&&disabledSkills.length<=4096
    &&disabledSkills.every(item=>typeof item==='string'&&path.isAbsolute(item)&&!/[\n\r\0]/.test(item)),'invalid_review_config');
  // Reviewer transport budget only. It is not part of the authorized configuration
  // digest, so a resumed run may raise it after a transport timeout.
  if(Object.hasOwn(config,'timeoutMs'))need(Number.isInteger(config.timeoutMs)
    &&config.timeoutMs>=1&&config.timeoutMs<=3600000,'invalid_review_config');
  return json({...config,disabledSkills});
}

// Shared synthetic loopback diagnostic; a receipt never grants Review permission.
export async function runReviewPreflight(definition,{model,effort,runtime='codex',disabledSkills}={}){
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  if(runtime==='claude'){
    const {previewClaudeTools}=await import('../runtime/js/cm-ai/claude-tool-preview.mjs');
    const config=await previewClaudeTools({cwd:definition.codeProject,model,effort});
    return config;
  }
  const {previewIsolated,previewTools}=await import('../runtime/js/cm-ai/tool-preview.mjs');
  const preview=disabledSkills===undefined?previewIsolated:previewTools;
  const receipt=await preview({cwd:definition.codeProject,model,effort,allowCodeProject:true,promptTransport:'stdin',
    ...(disabledSkills===undefined?{}:{disabledSkills})});
  // No raw startup diagnostics, headers, prompt or discovered content.
  return {model,...(effort===undefined?{}:{effort}),disabledSkills:receipt.disabledSkillFolders,preflight:{passed:receipt.passed,
    cli_model:receipt.cli_model,config_fingerprint:receipt.config_fingerprint,prompt_transport:receipt.prompt_transport,
    real_model_requests:receipt.real_model_requests,listener_closed:receipt.listener_closed}};
}

async function protectedExecutionFor(definition,hostContextId,extra,review,mode,workflow,bridge,bootstrap=null,externalModels=null,executionPolicy=null){
  const runtime=extra.get('--runtime')??'codex';
  const selected=resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime);
  need(review!==null,'review_configuration_required');
  need(['1','2'].includes(extra.get('--allow-provider-development-attempt')),'provider_development_authorization_required');
  const attempt=Number(extra.get('--allow-provider-development-attempt'));
  need(mode!=='create'||attempt===1,'invalid_development_attempt');
  // Child fix configuration is checked before opening the parent store below.
  const file=extra.get('--protected-config'),info=fs.lstatSync(file);
  need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_protected_config');
  let config=json(JSON.parse(fs.readFileSync(file,'utf8')));
  if(externalModels){const pair=externalModels.providers[selected.coderRuntime];need(!Object.hasOwn(config,'model')||config.model===pair.model,'external_model_configuration_conflict');need(!Object.hasOwn(config,'effort')||config.effort===pair.effort,'external_model_configuration_conflict');config={...config,...pair};}
  shape(config,['model','checkCommands','timeoutMs',...(externalModels?['effort']:[])]);
  return executionFor(definition,hostContextId,bridge,review,
    extra.has('--allow-review-attempt')?Number(extra.get('--allow-review-attempt')):null,
    workflow,extra.has('--allow-qa'),runtime,{
      ...(extra.has('--original-host-context')?{originalHostContextId:extra.get('--original-host-context')}:{}),
      protection:{checkCommands:config.checkCommands,timeoutMs:config.timeoutMs},
      providerDevelopment:{model:config.model,attempt,...selected,...(externalModels?{effort:config.effort}:{})},
      ...(executionPolicy?{executionPolicy}:{}),
      ...(externalModels?{externalModels}:{}),
      ...(extra.has('--verification-precheck')?{verificationPrecheck:true}:{}),
      ...(bootstrap?{bootstrap:{...bootstrap,allowWrite:extra.has('--allow-bootstrap-write')}}:{}),
    });
}


// Existing Codex-only runs retain their exact configuration/context identities.
// A successful original fingerprint check is the sole authority for this path;
// no migration, journal rewrite, or in-flight provider switch is permitted.
async function legacyProtectedExecutionFor(definition,hostContextId,extra,review,mode,workflow,bridge,bootstrap=null){
  need((extra.get('--runtime')??'codex')==='codex','protected_runtime_unsupported');
  need(!extra.has('--verification-precheck'),'verification_precheck_unavailable');
  need(review!==null,'review_configuration_required');
  need(['1','2'].includes(extra.get('--allow-provider-development-attempt')),'provider_development_authorization_required');
  const attempt=Number(extra.get('--allow-provider-development-attempt'));
  need(mode!=='create'||attempt===1,'invalid_development_attempt');
  // Child fix configuration is checked before opening the parent store below.
  const file=extra.get('--protected-config'),info=fs.lstatSync(file);
  need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_protected_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['model','checkCommands','timeoutMs']);
  const authority=createHostReviewAuthority({hostContextId,reviewerId:'reviewer',adapterId:'codex-review-adapter',
    decide:async binding=>String(binding.identity.attempt)===extra.get('--allow-review-attempt')?{status:'approved'}:null});
  return createCodexExecution({codeProject:definition.codeProject,specsRoot:definition.specsDir,
    developerModel:config.model,checkCommands:config.checkCommands,timeoutMs:config.timeoutMs,
    hostContextId,developerContextId:'cm-protected-author',reviewerModel:review.model,
    reviewerPreflight:review.preflight,disabledSkills:review.disabledSkills,
    ...(workflow?{workflow:{definition,configuration:workflow}}:{}),
    ...(bootstrap?{bootstrap:{definition,selection:bootstrap.selection}}:{})},
  {hostDecision:null,developmentAttempt:attempt,hostDecisionProvider:authority.hostDecisionProvider,authorizeReview:authority.authorize,
    ...(workflow?{workflow:{bridge,allowQa:extra.has('--allow-qa')}}:{}),
    ...(bootstrap?{bootstrap:{bridge,allowWrite:extra.has('--allow-bootstrap-write')}}:{}),
    authorizeDevelopment:request=>({status:request.identity.attempt===attempt
      &&digest({...request.identity,attempt:1})===digest(definition.identity)?'approved':'denied'})});
}
function canResumeLegacyProtected(definition,runtime){
  if(runtime!=='codex')return false;
  const config=loadConfig({projectRoot:definition.codeProject});
  return ['unknown','codex'].includes(declaredRuntimes(config).available)
    &&['coder','reviewer'].every(role=>['current-ai','codex-cli'].includes(config.roles[role].adapter));
}

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Optional --execution-optimizations freezes policy v1 for new runs only; recovery retains the original policy and legacy runs reject retrofit. See docs/execution-optimizations.md.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--original-host-context ID is resume-only: keep the creating session in durable configuration while --host-context remains the real live session. Omit it for same-session resume; a different session must declare the creating session. Equal IDs are equivalent to omission. Parent conversation runs only; legacy protected runs, batch and QA-fix children are unchanged.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Approved bootstrap feature (0.bootstrap or a single numbered *.bootstrap): --bootstrap-config PATH {selection:null for scaffold, or original cm-init selection for rules} and --allow-bootstrap-write. Original scope must include fixed instruction targets; they are host-written inside the original task effect, checked/reviewed and reloaded. No Git/install/network grant. Optional codeProjects selects disjoint real roots below codeProject; prefix scope/requirements and use protected current-session checks with a declared codeProject per command.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Protected current-session mode (Codex or Claude; also batch): --protected-conversation-config PATH with {checkCommands,timeoutMs}; timeoutMs bounds check commands and is the reviewer budget only when review-config has no timeoutMs. A review transport timeout with no result can resume once per attempt with fresh review authorization; a result-bearing timeout still requires reconciliation. No extra model call. The current host returns scoped UTF-8 edits (optional mode "0755"/"0644" on written files; new files are 0644); native Codex sandbox applies them and runs the declared checks. Original author runtime, per-attempt Review and QA permissions remain required. Do not combine with --protected-config. The input limit defaults to 64 KiB and may be raised with --input-limit; unavailable/binary changes stop, never switch to direct writes.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Protected single-task CLI mode: add --protected-config PATH --allow-provider-development-attempt 1|2 and --review-config PATH. Protected config is {model,checkCommands,timeoutMs}; roots and host identity come from the original run definition and launch. This explicitly permits one task attempt of real developer execution and its declared native-sandbox checks; --allow-development alone does not. Review separately requires --allow-review-attempt 1|2. Diagnostics are required but are not review authorization. Optional original --workflow-config PATH and --allow-qa connect protected QA commands and documentation within the same developer invocation before Review; host semantic/browser/inspection requests retain their original contracts, not arbitrary writes. Default current-session mode is unchanged. Protected parent mode selects coder/reviewer CLIs from the project declaration; Claude returns protected-text-v1 proposals for host validation and sandbox application; original QA-fix options require child configuration.protectSpecs=true and all original child action permissions. Protected fix writes use text proposals, not direct host edits. The original QA/documentation/finalizer gates remain required. No installation or Git authority.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--browser-qa is required when the approved contract for this feature contains blocking or policy-enabled interactive QA cases and QA is enabled. It covers the declared carrier (browser, ios-simulator, and others); the flag name is retained for compatibility. It is a declaration by the launching session, not a probe. The gate applies to create and resume, and is not persisted. unavailable refuses to start.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--revise-qa-config PREVIOUS_WORKFLOW.json --qa-config-revision-reason REASON: 仅 resume 且 --allow-qa；核对旧配置后追加 QA 修订，旧 QA 作废留史，下一轮仍受三轮上限约束。未知 QA 须先处理；不能修改开发配置或重开 N5。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--auto-qa-fix optionally connects parent advance -> fix_run -> re-QA. Requires --qa-fix-template-config, --allow-qa-fix-start, original action permissions and project policies.auto_fix=auto. Explicit/never policies stop. Unknown, blocked or incomplete repair stops; status/cancel remain available and no fourth QA round is dispatched.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--qa-fix-template-config PATH is an alternative to --qa-fix-owner-config. Supply {specsRoot, feature, identity: parent identity, configuration: original fix configuration without qaSource}. Each fix request binds it to the latest completed QA failure; identity/digests are generated, commands/scope/permissions are not. Existing child configuration remains immutable.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('fix_run continuously executes normal stages of the fixed QA child using the same binding as fix_advance. Requires --allow-qa-fix-start and every original per-action permission/configuration. Stops on unknown, blocked, observation, revision-required or unchanged state; a design-change child closes as escalated and reports qa_fix_incomplete, never qa_fix_completed. It does not auto-switch child configuration or run parent QA.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('fix_action delegates to the shared original cm-fix dispatcher. Local flags: --allow-qa-fix-red-test, --allow-qa-fix-baseline, --allow-qa-fix-regression, --allow-qa-fix-learning-writeback, --allow-qa-fix-walkthrough, --allow-qa-fix-finish, --allow-qa-fix-abandon, --allow-qa-fix-abandon-review, --allow-qa-fix-rediagnosis, --allow-qa-fix-rerun-blocked-step, --allow-qa-fix-final-review-recovery [--qa-fix-final-review-recovery-invocation ID]. Recovery fixOperations rediagnose, rerun_blocked_step (reason), revision_test_check (regression flag) and recover_final_review ({invocationId, reviewPackageDigest = the child final review package digest, previousInvocationStopped:true, reason}) go to the same cm-fix dispatcher with the same conditions as cm-fix-host; a missing flag returns qa_fix_action_authorization_required naming the parent flag, a cm-fix refusal returns its own code, and the parent reopens either way. abandon_step also requires a reason in the fix_action request and only applies to eligible local unknown steps; abandon_review requires --allow-qa-fix-abandon-review and a reason, and applies once to the child cause review and once to its second-round final review while that registered review has no review result. The parent run\'s own --allow-abandon-review does not reach the child. Adapter flags: --allow-qa-fix-test-author, --allow-qa-fix-repair, --allow-qa-fix-cause-review, --allow-qa-fix-final-review, with separate --qa-fix-review-config PATH and matching original child reviewer metadata. All require --allow-qa-fix-start and the original action configuration/gates. Parent --review-config/--allow-review-attempt do not grant child review permission.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-qa-fix-start additionally permits fix_advance to create or resume the fixed QA child and run only its original Learning/reproduction/diagnosis stages. Child runtime must match this host. A new child hostContextId must be the live session or the parent durable creator; an existing child retains its fingerprint-verified configuration. Child opens and review grants use the live session. It does not authorize test authoring, repair, independent provider Review, finish, Git or re-QA. Active child status/cancel use the original child owner; repeated advance never resets an unknown or completed step.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--qa-fix-owner-config PATH enables read-only fix_status. The file contains the existing fix owner definition {specsRoot, identity, configuration}, including its exact original qaSource and immutable configuration, not provider grants. fix_status binds the parent identity/packageDigest/testRunId, serially closes the parent writer, opens only an existing child, reads its original completion evidence, closes it and resumes the same parent. It does not create/execute repairs, rerun QA or clear correction gates.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Protected current-session invalid_result means local value/Learning validation failed before file writes. Fix the reply, keep the same configuration, host identity and runId, restart with --mode resume and advance: blocked/developer_result_invalid retries develop at the same attempt. no_new_lesson requires reason:null (dogfood incident: nonempty reason previously wrote files then stranded the run as unknown). Already-applied proposals must match expected disk hashes; conflicts block as protected_edit_stale. Worker exceptions/timeouts and old unknown history are not retryable.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('New cm-ai runs carry approved specification data in developer requests and review packages: task/verification, all AC lines, design (64 KiB UTF-8 maximum, truncated:true above it), task-related test cases and manifest hashes. Sources must match .cm-specs-status.specFiles or spec_drift blocks. requirements may be [] or additional code-project files; specs never become writable scope. Legacy runs/packages retain their original representation. Dogfood: separate specs/code roots previously left developers and reviewers without task/interface contracts.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Completed fixture_completed runs originally without QA may explicitly attach N6 once on --mode resume with --workflow-config (non-null qa) and --allow-qa. Original definition, scope, requirements, identity and non-workflow configuration must match. The immutable qa-attached journal record binds the full resumed config fingerprint; later resumes require that same configuration and fresh --allow-qa. qa still requests qa_assess; no automatic decision or repeated development/Review. Dogfood: missing workflow at create previously stranded mandatory feature QA.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--rerun-unknown-qa requires --mode resume and fresh --allow-qa with the original workflow config. Only an unfinished QA invocation whose recorded case results are all PASS and which has no fixed execution report may be abandoned and rerun under a new testRunId at the same qaRound. The abandoned record lists partial_pass_cases; every case is rerun and old PASS evidence is history only. FAIL/BLOCKED results and unclosed resources remain blocked; no complete is fabricated. Exception: a call stopped as a whole (qa_execution_timeout) with no report and no FAIL, whose every case_blocked is a host request timeout (host_request_timeout: true; an older row without that field needs the full qa.timeoutMs elapsed since case_start plus an operator --qa-environment-failure REASON attesting no session answer, recorded verbatim as legacy_timeout_attestation, otherwise qa_environment_failure_required) and never session-declared, is superseded (reason host_request_timeout) and rerun at qaRound+1; --rerun-blocked-qa on it is refused as qa_rerun_unknown_qa_required. The same applies to a call stopped as a whole (timeout, host death or a hard-invalid answer) whose other BLOCKED rows were session-declared or host-judged evidence/environment/cleanup gaps (blocked_reason): they are listed as host_blocked_cases. The whole-round deadline scales with the frozen plan (commands x command timeout, logic cases x request window, browser cases x two windows, plus one minute; at least 30 minutes, at most 24 hours). A cleanup_failed QA command resource whose recorded process group the host proves gone is released first (released_by host_verified).\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--rerun-blocked-qa requires --mode resume, the original --workflow-config and fresh --allow-qa. Only the latest completed BLOCKED invocation with zero failures and exclusively host/environment evidence gaps can be superseded: browser evidenceProblem, failed cleanup, environment mismatch, host timeout or a host-declared BLOCKED answer; logic INSUFFICIENT_EVIDENCE or blocked only by a mapped command without exit code; QA commands that produced no exit code (timeout, killed, spawn/output failure). Missing/deferred command rows ([需确认], commands-unavailable, no-applicable-cases, no browser capability) and source drift are excluded. A new testRunId reruns every case at qaRound+1 (three rounds, plus at most two given back for rounds superseded for host or answer problems: host_request_timeout, host_evidence_problem); superseded and start link previous_test_run_id. The flag is consumed once, never persisted; no development/Review/task replay or new QA decision. Do not combine with --rerun-unknown-qa.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('For a QA decision an older host recorded as blocked/host_request_timeout, --rerun-blocked-qa instead re-asks qa_assess once and appends a decision linked by previous_decision_id; history is kept (current hosts report a missed qa_assess window as retryable rejected/qa_decision_timeout and record nothing). --qa-environment-failure REASON (with --rerun-blocked-qa, single line, at most 500 UTF-8 bytes) declares that the non-zero QA command exits of the latest completed FAIL came from the environment: only command exits and logic cases failed solely by them qualify, never browser FAIL or CONTRADICTED; the superseded row records reason, failed_cases and blocked_cases. Every rerun reuses the three-round QA budget. Single-task host only.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-abandon-review: resume 原 run 后发送 abandon_review，request.reason 必须是单行且不超过 500 UTF-8 字节。操作员先确认旧 host 与 review 进程已退出；旗标只消费一次，不写入配置。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-abandon-effect: resume 原 run 后发送 abandon_effect，request.reason 必须是单行且不超过 500 UTF-8 字节。用于宿主在 develop/review（登记前）/complete（无 task-commit-intent）中途退出、只留下意图的运行：操作员先确认旧 host、会话写入和 effect 启动的检查/构建进程均已退出，宿主写 effect-interrupted，运行不作废，而从这一步的可重试阻断继续（develop_interrupted 后 advance 重发本轮；审查回到 awaiting_review；完成回到原状态）。provider 开发须存档记有 worker 进程身份且宿主核对进程组已退出；受保护当前会话开发须代码根仍等于本轮起点。已登记且本轮重派已用完的审查仍按旧规则作废运行（effect-abandoned），之后可 supersede。写了 task-commit-intent 的完成改发 complete 按提交计划收尾。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--hold-revision: 本次启动在第 1 轮审查要求修改后停在 changes_requested（revision_answer_required），不发起第 2 轮开发意图；只缩小本次启动，不写入配置，下次不带它即继续修订。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-develop-redo: resume 原 run 后发送 develop_redo，request.reason 必须是单行且不超过 500 UTF-8 字节。当前会话开发（非受保护）的应答没拿到，或 provider 开发结果不明且存档记有 worker 进程身份（宿主先核对进程组已退出），pendingAction=develop_redo 时可用；操作员先确认会话已停止修改代码，宿主写入 develop-answer-redo 记录，之后 advance 重发本轮开发。旗标只消费一次，不写入配置。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-bootstrap-review-recovery: resume 原 run 后发送 bootstrap_review_recover；只在 bootstrap develop 已完成且审查包构建失败时核对现有文件、handoff 与原始证据，并追加恢复记录，不重新派发开发。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--supersede-reviewed-evidence --supersede-reason REASON：仅新建同任务运行；旧运行都已终止且 tasks.md 未勾选时，先在新 journal 记授权，再归档旧审查证据。若保留直接前驱运行留下的代码漂移，可额外使用 --accept-superseded-code-drift；漂移文件会作为新运行的已有代码并记录当前 SHA-256。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--rebind-spec-material --spec-rebind-reason REASON：仅 resume。规格经 cm-prd --change 重新批准后，若本任务的描述、验证要求、验收标准、设计摘录与测试用例都未变，只换绑批准哈希并写 specification-rebound 记录，已有开发与审查结论保留；内容有变则拒绝并列出变化。status 的 spec_drift 会说明是否可换绑。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('当前会话手动驱动请用 scripts/cm-ai-drive.mjs（批次 cm-ai-batch-drive.mjs；修复 cm-fix-drive.mjs；规格 cm-prd-drive.mjs）；详情见 skills/cm-ai/references/js-host.md。\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('External-model mode freezes one model/effort pair per provider. Unknown or invalid external results require reconciliation; automatic retries and abandonment are disabled. See docs/external-models.md.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(usage+'\n');return 0;}
  let run,bridge;
  try{
    if(argv[0]==='preflight'){
      if([5,7].includes(argv.length)&&argv[1]==='--config'&&argv[3]==='--external-provider'){
        need(argv.length===5||argv[5]==='--external-models-config','invalid_arguments');
        const runtime=argv[4],pair=loadExternalModels(argv[6]).providers[runtime];need(pair,'external_model_setup_required');
        const config=await runReviewPreflight(readRunDefinition(argv[2]),{...pair,runtime});output.write(JSON.stringify({...config,timeoutMs:900000})+'\n');return config.preflight.passed?0:1;
      }
      need((argv.length===5||argv.length===7)&&argv[1]==='--config'&&argv[3]==='--review-model','invalid_arguments');
      const runtime=argv.length===5?'codex':argv[6];
      need(argv.length===5||argv[5]==='--runtime','invalid_arguments');
      need(['codex','claude'].includes(runtime),'invalid_runtime');
      const definition=readRunDefinition(argv[2]);
      const config=await runReviewPreflight(definition,{model:argv[4],runtime});
      output.write(JSON.stringify({...config,timeoutMs:900000})+'\n');
      if(runtime==='claude'){
        const hint=formatClaudeModelHint(config,claudeCliVersion());if(hint)error.write(hint+'\n');
      }
      return config.preflight.passed?0:1;
    }
    need(argv.length>=8&&argv[0]==='serve'&&argv[1]==='--config'&&argv[3]==='--mode'
      &&argv[5]==='--host-context'&&argv[7]==='--allow-development','host_launch_authorization_required');
    const extra=new Map();
    for(let index=8;index<argv.length;index++){
      const name=argv[index];refuse(!extra.has(name),'invalid_arguments',`参数重复：${name}`);
      refuse(['--execution-optimizations','--external-models','--external-models-config','--verification-precheck','--revise-qa-config','--qa-config-revision-reason','--qa-environment-failure','--supersede-reviewed-evidence','--supersede-reason','--accept-superseded-code-drift','--rebind-spec-material','--spec-rebind-reason','--original-host-context','--bootstrap-config','--allow-bootstrap-write','--protected-conversation-config','--protected-config','--allow-provider-development-attempt','--review-config','--allow-review-attempt','--allow-abandon-review','--allow-abandon-effect','--allow-bootstrap-review-recovery','--allow-develop-redo','--hold-revision','--workflow-config','--allow-qa','--browser-qa','--rerun-unknown-qa','--rerun-blocked-qa','--runtime','--review-runtime','--feature','--input-limit','--failover','--qa-fix-owner-config','--qa-fix-template-config','--qa-fix-review-config','--qa-fix-final-review-recovery-invocation','--allow-qa-fix-start','--auto-qa-fix',...fixLocalPermissions.keys()].includes(name),'invalid_arguments',`未知参数：${name}`);
      if(['--execution-optimizations','--external-models','--verification-precheck','--supersede-reviewed-evidence','--accept-superseded-code-drift','--rebind-spec-material','--allow-bootstrap-write','--allow-qa','--allow-abandon-review','--allow-abandon-effect','--allow-bootstrap-review-recovery','--allow-develop-redo','--hold-revision','--rerun-unknown-qa','--rerun-blocked-qa','--failover','--allow-qa-fix-start','--auto-qa-fix',...fixLocalPermissions.keys()].includes(name))extra.set(name,true);
      else{refuse(typeof argv[index+1]==='string'&&!argv[index+1].startsWith('--'),'invalid_arguments',`${name} 需要一个值`);extra.set(name,argv[++index]);}
    }
    let inputLimit;
    try{inputLimit=parseHostInputLimit(extra.get('--input-limit'));}
    catch(error){refuse(error.code!=='invalid_arguments','invalid_arguments','--input-limit 须为 65536–4194304 的整数字节数');throw error;}
    const revisionRequested=extra.has('--revise-qa-config')||extra.has('--qa-config-revision-reason');
    need(!extra.has('--supersede-reviewed-evidence')&&!extra.has('--supersede-reason')&&!extra.has('--accept-superseded-code-drift')
      ||(argv[4]==='create'&&extra.has('--supersede-reviewed-evidence')&&extra.has('--supersede-reason')),
    'supersede_unavailable');
    need(!revisionRequested||(argv[4]==='resume'&&extra.has('--allow-qa')&&extra.has('--revise-qa-config')
      &&extra.has('--qa-config-revision-reason')&&!extra.has('--rerun-unknown-qa')&&!extra.has('--rerun-blocked-qa')),'qa_revision_authorization_required');
    need(!extra.has('--allow-abandon-review')||argv[4]==='resume','review_abandon_unavailable');
    refuse(extra.has('--rebind-spec-material')===extra.has('--spec-rebind-reason')&&(!extra.has('--rebind-spec-material')||argv[4]==='resume'),
      'spec_rebind_unavailable','--rebind-spec-material 只用于 --mode resume，并须同时提供单行 --spec-rebind-reason 原因');
    need(!extra.has('--allow-abandon-effect')||argv[4]==='resume','effect_abandon_unavailable');
    need(!extra.has('--allow-bootstrap-review-recovery')||argv[4]==='resume','bootstrap_review_recovery_unavailable');
    need(!extra.has('--allow-develop-redo')||argv[4]==='resume','develop_redo_unavailable');
    const qaConfigRevision=revisionRequested?{previousWorkflow:readHostWorkflowConfiguration(extra.get('--revise-qa-config')),
      reason:extra.get('--qa-config-revision-reason')}:null;
    const originalHostContextId=extra.get('--original-host-context')??null;
    if(originalHostContextId!==null){need(argv[4]==='resume','original_host_context_unavailable');id(originalHostContextId);}
    if(originalHostContextId===argv[6])extra.delete('--original-host-context');
    let review=null;
    const workflow=extra.has('--workflow-config')?readHostWorkflowConfiguration(extra.get('--workflow-config')):null;
    let allowedAttempt=null;
    if(extra.has('--allow-review-attempt')){refuse(['1','2'].includes(extra.get('--allow-review-attempt')),'invalid_arguments','--allow-review-attempt 只接受 1 或 2');allowedAttempt=Number(extra.get('--allow-review-attempt'));}
    refuse(!extra.has('--allow-qa')||workflow?.qa!=null,'invalid_arguments',
      workflow===null?'--allow-qa 需要同时提供 --workflow-config':'--allow-qa 需要 --workflow-config 中的 qa 不为 null；本运行没有 QA 时去掉 --allow-qa');
    need(!(extra.has('--rerun-unknown-qa')&&extra.has('--rerun-blocked-qa')),'qa_recovery_authorization_required');
    need(!(extra.has('--rerun-unknown-qa')||extra.has('--rerun-blocked-qa'))||(argv[4]==='resume'&&extra.has('--allow-qa')),'qa_recovery_authorization_required');
    need(!extra.has('--qa-environment-failure')||extra.has('--rerun-blocked-qa')||extra.has('--rerun-unknown-qa'),'qa_recovery_authorization_required');
    const hasFix=extra.has('--qa-fix-owner-config')||extra.has('--qa-fix-template-config');
    need(!(extra.has('--qa-fix-owner-config')&&extra.has('--qa-fix-template-config')),'invalid_fix_config');
    need(!extra.has('--allow-qa-fix-start')||hasFix,'qa_fix_source_required');
    need(!extra.has('--qa-fix-review-config')||hasFix,'qa_fix_source_required');
    need(!extra.has('--auto-qa-fix')||(extra.has('--qa-fix-template-config')&&extra.has('--allow-qa-fix-start')),'qa_fix_auto_authorization_required');
    need(![...fixLocalPermissions.keys()].some(flag=>extra.has(flag))||extra.has('--allow-qa-fix-start'),'qa_fix_start_authorization_required');
    // Same binding as cm-fix-host --final-review-recovery-invocation, for the child.
    refuse(!extra.has('--qa-fix-final-review-recovery-invocation')||extra.has('--allow-qa-fix-final-review-recovery'),'invalid_arguments',
      '--qa-fix-final-review-recovery-invocation 需要同时提供 --allow-qa-fix-final-review-recovery');
    if(extra.has('--qa-fix-final-review-recovery-invocation'))id(extra.get('--qa-fix-final-review-recovery-invocation'));
    need(!extra.has('--allow-provider-development-attempt')||extra.has('--protected-config'),'protected_configuration_required');
    refuse(!(extra.has('--review-runtime')&&(extra.has('--protected-config')||extra.has('--external-models'))),'invalid_arguments',
      '--review-runtime 只用于普通当前会话宿主；--protected-config 与 --external-models 按 roles 自行选择审查端');
    refuse(!(extra.has('--protected-config')&&extra.has('--protected-conversation-config')),'invalid_arguments','--protected-config 与 --protected-conversation-config 不能同时使用');
    const protection=extra.has('--protected-conversation-config')?readConversationProtection(extra.get('--protected-conversation-config')):null;
    const bootstrap=extra.has('--bootstrap-config')?readBootstrapConfiguration(extra.get('--bootstrap-config')):null;
    need(!extra.has('--allow-bootstrap-write')||bootstrap!==null,'bootstrap_configuration_required');
    // Checked before the definition is read so the conflict is reported on its own.
    need(!(extra.has('--failover')&&extra.has('--protected-config')),'failover_unsupported_in_protected_mode');
    let definition=readRunDefinition(argv[2]);
    // --feature binds an explicit batch choice into the run definition, exactly
    // as a printed featureSelection does; resume must repeat it (fingerprint).
    if(extra.has('--feature')){
      refuse(extra.get('--feature')===definition.feature&&(!definition.featureSelection
        ||definition.featureSelection.feature===definition.feature),'invalid_arguments',
        `--feature ${extra.get('--feature')} 必须与运行定义的 feature ${definition.feature} 一致`);
      definition={...definition,featureSelection:{version:1,feature:definition.feature}};
    }
    // Before any frozen model/policy configuration, execution or journal write.
    if(argv[4]==='create'&&bootstrap===null)assertCreatableScope(definition.scope);
    const boundRuntime=extra.get('--runtime')??'codex';
    const routes=extra.has('--protected-config')?resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),boundRuntime):{reviewerRuntime:boundRuntime};
    const executionPolicy=readLaunchExecutionPolicy({definition,mode:argv[4],enabled:extra.has('--execution-optimizations')});
    const externalModels=readLaunchExternalModels({definition,mode:argv[4],enabled:extra.has('--external-models'),inputFile:extra.get('--external-models-config'),providers:[routes.coderRuntime,routes.reviewerRuntime].filter(Boolean)});
    need(!externalModels||!extra.has('--failover'),'external_model_failover_unsupported');
    review=extra.has('--review-config')?reviewConfiguration(extra.get('--review-config'),externalModels?.providers[routes.reviewerRuntime]??null):null;
    // Launch-time capability assertion. See host-workflow-capabilities: this is a
    // fresh declaration, not a probe the host performs.
    readBrowserCapability(extra.get('--browser-qa'),
      workflow?.qa!=null&&featureHasBrowserCases(definition.specsDir,definition.feature,definition.codeProject)
        ?[workflow.qa.environment?.carrier??'browser']:[]);
    // Tool replies travel on the same input lines, so they share the one limit.
    bridge=createHostToolBridge({responseLimit:inputLimit,answerTimeoutMs:HOST_ANSWER_BACKSTOP_MS});
    // Startup-only role failover. The project's runtimes.available declaration is
    // primary: it fixes which runtimes may be chosen and, via roles.coder, the
    // requested start runtime. The CLI probe only confirms reachability. It never
    // switches an in-flight task; a switch is always announced, never silent.
    // Protected mode binds both roles before dispatch; startup failover remains a separate path.
    let runtime=extra.get('--runtime')??'codex';
    if(extra.has('--failover')){
      const {selectRuntime,describeSelection}=await import('../runtime/js/cm-ai/runtime-failover.mjs');
      const {probeRuntimes}=await import('./cm-failover.mjs');
      const {loadConfig,declaredRuntimes,runtimeForAdapter}=await import('./cm-workflow-config.mjs');
      const config=loadConfig({projectRoot:definition.codeProject}),declared=declaredRuntimes(config);
      const requested=extra.get('--runtime')??runtimeForAdapter(config.roles.coder.adapter);
      const reach=new Map(probeRuntimes().map(result=>[result.runtime,result.available]));
      const selection=selectRuntime({role:'developer',requested,allowed:[...declared.allowed],
        probe:(candidate)=>reach.get(candidate)===true});
      runtime=selection.runtime;
      error.write(`cm-ai-host failover: 声明 runtimes.available=${declared.available}; ${describeSelection(selection)}\n`);
      if(selection.switched)error.write('cm-ai-host failover: CLI 可解析不等于配额可用；本次切换只决定起跑运行时。\n');
    }
    const templated=extra.has('--qa-fix-template-config');let fix=null;
    if(hasFix){
      const file=extra.get(templated?'--qa-fix-template-config':'--qa-fix-owner-config'),info=fs.lstatSync(file);
      need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_fix_config');
      fix=json(JSON.parse(fs.readFileSync(file,'utf8')),64*1024);
      if(extra.has('--protected-config')||protection)need(fix.configuration?.protectSpecs===true,'protected_fix_required');
    }
    // The reviewer binding is part of the durable configuration fingerprint, so
    // it cannot be added on resume. Requiring it at create removes the trap of
    // a run that can reach awaiting_review but never be reviewed. Authorizing a
    // review attempt is still the separate --allow-review-attempt.
    refuse(argv[4]!=='create'||review!==null,'review_configuration_required',
      'create 必须带 --review-config：审查配置写进运行指纹，resume 时不能再补。先用 cm-ai-host.mjs preflight --config 运行定义 --review-model 模型 --runtime 端 生成 review.json；是否真正派发审查仍由 --allow-review-attempt 单独授权');
    let execution;
    if(argv[4]==='resume'&&!extra.has('--original-host-context')&&extra.has('--protected-config')&&!externalModels&&!executionPolicy&&canResumeLegacyProtected(definition,runtime)){
      try{
        execution=await legacyProtectedExecutionFor(definition,argv[6],extra,review,argv[4],workflow,bridge,bootstrap);
        run=await openControlRun(definition,argv[4],execution,{qaConfigRevision,rerunUnknownQa:extra.has('--rerun-unknown-qa'),rerunBlockedQa:extra.has('--rerun-blocked-qa'),qaEnvironmentFailure:extra.get('--qa-environment-failure')??null,supersedeReason:extra.get('--supersede-reason')??null,acceptSupersededCodeDrift:extra.has('--accept-superseded-code-drift'),allowAbandonReview:extra.has('--allow-abandon-review'),allowAbandonEffect:extra.has('--allow-abandon-effect'),allowBootstrapReviewRecovery:extra.has('--allow-bootstrap-review-recovery'),allowDevelopRedo:extra.has('--allow-develop-redo'),...(extra.has('--hold-revision')?{holdRevision:true}:{}),specRebindReason:extra.get('--spec-rebind-reason')??null});
        error.write('cm-ai-host: resumed original Codex protected execution after exact fingerprint validation.\n');
      }catch(cause){
        if(!['fingerprint_mismatch','tool_preflight_missing'].includes(cause.code))throw cause;
        execution=undefined;
      }
    }
    if(!run){
      execution=extra.has('--protected-config')
        ?await protectedExecutionFor(definition,argv[6],extra,review,argv[4],workflow,bridge,bootstrap,externalModels,executionPolicy)
        :executionFor(definition,argv[6],bridge,review,allowedAttempt,workflow,extra.has('--allow-qa'),runtime,
          {...(extra.has('--review-runtime')?{reviewRuntime:extra.get('--review-runtime')}:{}),...(executionPolicy?{executionPolicy}:{}),...(externalModels?{externalModels}:{}),...(extra.has('--verification-precheck')?{verificationPrecheck:true}:{}),...(extra.has('--original-host-context')?{originalHostContextId:extra.get('--original-host-context')}:{}),...(protection?{protection}:{}),...(bootstrap?{bootstrap:{...bootstrap,allowWrite:extra.has('--allow-bootstrap-write')}}:{})});
      run=await openControlRun(definition,argv[4],execution,{qaConfigRevision,rerunUnknownQa:extra.has('--rerun-unknown-qa'),rerunBlockedQa:extra.has('--rerun-blocked-qa'),qaEnvironmentFailure:extra.get('--qa-environment-failure')??null,supersedeReason:extra.get('--supersede-reason')??null,acceptSupersededCodeDrift:extra.has('--accept-superseded-code-drift'),allowAbandonReview:extra.has('--allow-abandon-review'),allowAbandonEffect:extra.has('--allow-abandon-effect'),allowBootstrapReviewRecovery:extra.has('--allow-bootstrap-review-recovery'),allowDevelopRedo:extra.has('--allow-develop-redo'),...(extra.has('--hold-revision')?{holdRevision:true}:{}),specRebindReason:extra.get('--spec-rebind-reason')??null});
    }
    if(run.blocked){output.write(JSON.stringify({outcome:'blocked',admission:run.blocked})+'\n');return 1;}
    if(hasFix){
      need(fs.realpathSync(fix.specsRoot)===fs.realpathSync(definition.specsDir)
        &&fs.realpathSync(fix.configuration.reproduction.cwd)===fs.realpathSync(definition.codeProject)
        &&(templated?fix.feature:fix.configuration.qaSource.feature)===definition.feature,'qa_fix_source_mismatch');
      if(templated)need(digest(fix.identity)===digest(definition.identity),'qa_fix_source_mismatch');
      if(extra.has('--allow-qa-fix-start'))need((fix.configuration.runtime??'codex')===runtime,'qa_fix_host_mismatch');
      const fixPermissions=[...fixLocalPermissions].filter(([flag])=>extra.has(flag)).map(([,permission])=>permission);
      const fixRuntime=fix.configuration.runtime??'codex';
      const fixModels=externalModels?selectExternalModels(externalModels,[fixRuntime]):null;
      const fixReview=extra.has('--qa-fix-review-config')?reviewConfiguration(extra.get('--qa-fix-review-config'),fixModels?.providers[fixRuntime]??null):null;
      need(!fixPermissions.includes('--allow-test-author')||(fix.configuration.testAuthor&&fixReview),'test_author_configuration_required');
      need(!fixPermissions.includes('--allow-repair')||(fix.configuration.repair&&fixReview),'repair_configuration_required');
      const fixReviewHost=createFixReviewHost({codeProject:definition.codeProject,
        hostContextId:argv[6],runtime:fix.configuration.runtime??'codex',
        review:fixReview,permissions:fixPermissions,externalModels:fixModels,executionPolicy,specsDir:definition.specsDir});
      if(fixModels||executionPolicy){
        if(fixModels&&fix.configuration.causeReview)need(fix.configuration.causeReview.requestedModel===fixModels.providers[fixRuntime].model&&fix.configuration.causeReview.provider===fixRuntime,'external_model_pair_conflict');
        if(fixReview){
          // Preserve explicit reviewer contexts/exclusions; changing them changes the durable run.
          need(!fix.configuration.causeReview||digest(fix.configuration.causeReview)===digest(fixReviewHost.reviewer),'qa_fix_review_configuration_mismatch');
          fix={...fix,configuration:{...fix.configuration,causeReview:fixReviewHost.reviewer,...(fixModels?{externalModels:fixModels}:{})}};
        }
      }else if(fixReview)need(digest(fix.configuration.causeReview??null)===digest(fixReviewHost.reviewer),'qa_fix_review_configuration_mismatch');
      const host=createQaFixOwnerHost({parent:run,hostContextId:argv[6],parentHostContextId:execution.configuration.hostContextId,...(templated?{template:fix}:{fix}),reopenParent:()=>openControlRun(definition,'resume',execution),
        externalModels:fixModels,executionPolicy,fixPermissions,fixAuthorities:{authority:fixReviewHost.authority,finalAuthority:fixReviewHost.finalAuthority},
        allowStart:extra.has('--allow-qa-fix-start'),autoFix:extra.has('--auto-qa-fix'),
        recoveryInvocationId:extra.get('--qa-fix-final-review-recovery-invocation')??null,fixExecution:{bridge,...fixReviewHost.execution,
          prepare:createFixLearningPreparation({bridge,codeProject:definition.codeProject,
            applicableAgentFiles:fix.configuration.applicableAgentFiles??[]})}});
      run={host,close:host.close};
    }
    // PTY sessions are used by desktop tool hosts. Disable echo only on this
    // process's own terminal so tool results are not mistaken for output frames.
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    const diagnosticHost=withHandoffDiagnostic(run.host,error);
    try{await serveHostTransport({host:diagnosticHost,input,output,toolBridge:bridge,errorOutput:error},extra.get('--input-limit'));}
    finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){
    const preflightDiagnostic=argv[0]==='preflight'&&['EPERM','EACCES'].includes(cause?.code)
      &&cause?.syscall==='listen'&&cause?.address==='127.0.0.1'
      ?{operation:'listen',systemCode:cause.code,address:'loopback'}:null;
    const code=typeof cause?.code==='string'&&(/^[a-z][a-z0-9_]{0,63}$/.test(cause.code)
      ||cause.code.startsWith('invalid_config: '))?cause.code:'host_launch_failed';
    const snapshotReason=['out_of_scope','unsupported_file','limit_exceeded','package_mismatch'].includes(code)
      &&typeof cause?.message==='string'&&cause.message.length<=8192&&!/[\r\n\0]/.test(cause.message)
      ?cause.message:null;
    const reason=REASONED_CODES.includes(code)&&typeof cause?.reason==='string'&&cause.reason.length<=8192
      &&!/[\r\n\0]/.test(cause.reason)?cause.reason:null;
    if(code==='handoff_exists')error.write(`[host] ${REVIEWED_HANDOFF_HINT}\n`);
    if(['supersede_code_drift','fingerprint_mismatch'].includes(code)&&reason)error.write(`[host] ${reason}\n`);
    if(snapshotReason)error.write(`[host] ${snapshotReason}\n`);
    const limitReason=code==='request_too_large'?inputLimitReason(cause.limit):null;
    if(limitReason)error.write(`[host] request_too_large: ${limitReason}\n`);
    error.write(JSON.stringify({error:{code,...(snapshotReason?{reason:snapshotReason}:{}),...(limitReason?{reason:limitReason}:{}),...(reason?{reason}:{}),
      ...(preflightDiagnostic?{diagnostic:preflightDiagnostic}:{})}})+'\n');return 1;
  }finally{bridge?.close();run?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
