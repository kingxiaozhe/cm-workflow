import {readExecutionPolicy} from './execution-policy.mjs';
import {readExternalModels} from './external-models.mjs';
import {beforeFirstQaRound,qaRevisionFollows,readQaConfigRevision} from './qa-config-revision.mjs';
import {readCloseoutPolicy} from './knowledge-closeout.mjs';
// Host-only S3b2b journal grammar. Data validation grants no provider authority.
import {digest,need,shape,id,text,hex,json,validIdentity,validTaskLearningInput,validCallTimeout,validBlockedReason,requestFor,JOURNAL_REASON_LIMIT,boundedReason} from './effect-contract.mjs';
import {readReviewBaseline,readReviewPackage,reviewSpecsPath,reviewMaterialLimitReason} from './review-package.mjs';
import {reviewResult,reviewReceipt} from './review-runner.mjs';
import {checkCompletion} from './gate-bridge.mjs';
import path from 'node:path';
import {readCommitIntent,readCommitResult} from './task-commit-codec.mjs';
import {inspectProviderReview,hasProviderReviewResult,inspectProviderReviewFailure,inspectProviderReviewReconciliation,REVIEWER_PROVIDER_FAILURES,abandonableReviewerExit,reviewerGoneWithoutResult} from './provider-review-observation.mjs';
import {readReconciliationReceipt} from './review-reconciliation.mjs';
import {readCmAiProjectLearningWriteback} from './cm-ai-learning-writer.mjs';
import {readCmAiTaskLearningApplication} from './cm-ai-context-refresh.mjs';
import {reviewExclusions} from './effect-contract.mjs';
import {validateAcceptedFix} from './accepted-fix.mjs';
import {readBootstrapEvidence,validateBootstrapReviewPackage} from './host-bootstrap.mjs';
import {validateCodeProjectPaths,assertCodeProjectSelections,MAX_CODE_PROJECTS} from './code-projects.mjs';
import {identifyApprovedBootstrapFeature} from './bootstrap-feature.mjs';
import {readSpecificationRebind} from './specification-material.mjs';
import {protectedScopePaths} from './developer-adapter.mjs';
import {validWorkerPid,validStartTime} from './worker-process-identity.mjs';

const LIMIT=16*1024*1024;
// The developer adapter refuses a protected scope on every dispatch, before any
// provider runs. A run with such a scope can never develop: it is a definite
// block, not an unknown outcome. Bootstrap runs scope their own rule paths.
export const protectedDevelopScope=config=>config.bootstrap?[]:protectedScopePaths(config.scope);
export const protectedScopeBlockReason=paths=>boundedReason('protected_scope: 任务 scope 含受保护路径：',paths,
  '。开发适配器在派发前拒绝，未派发开发、未写入文件；本运行不能继续。从 scope 移除这些路径后按原门禁新建运行，'
  +'规则文件走 docs/js-workflow-control.md「项目规则文件的修改通道」。');
export const MAX_AI_JOINED_HOSTS=16;
const same=(a,b)=>need(digest(a)===digest(b),'runner_history_mismatch');
const prefix=(a,b)=>{need(b.length>=a.length,'runner_history_mismatch');same(a,b.slice(0,a.length));};
const uuid=s=>need(typeof s==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s),'runner_session');
const states=['ready','awaiting_review','approved','changes_requested','fixture_completed','blocked','unknown','cancelled','pending_review'];
export const stageAllowed=(kind,state,code=null,reviewVerdict=null)=>
  kind==='develop'&&state==='blocked'&&['developer_result_invalid','verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed','develop_unchanged_after_review','develop_empty_changes','develop_requirement_missing','develop_package_too_large','bootstrap_verification_failed','bootstrap_instruction_conflict','develop_call_timeout','develop_answer_invalid',...RECHECK_CODES,DEVELOP_REDO_CODE,DISPATCH_RETRY_CODE,DEVELOP_INTERRUPTED_CODE,...DOCUMENTATION_SYNC_CODES].includes(code)
  ||kind==='review'&&state==='pending_review'&&(REVIEW_RETRY_CODES.includes(code)||REVIEW_NOT_DISPATCHED_CODES.includes(code))
  ||kind==='complete'&&state==='blocked'&&(['completion_checks_changed','completion_package_changed',COMPLETE_RECHECK_CODE].includes(code)
    ||code==='review_package_changed'&&reviewVerdict==='approved')
  ||kind==='develop'&&state==='blocked'&&code==='review_package_changed'&&reviewVerdict==='changes_requested'
  ||({develop:['ready','changes_requested'],review:['awaiting_review'],complete:['approved']})[kind]?.includes(state)===true;
// Local rejected values keep audit records but do not consume provider rounds.
export const invalidDeveloperCall=call=>call.terminal==='failed'&&call.failureResult?.code==='invalid_result'&&call.failureResult.retryable===true;
// reconciliationRequired=false is an explicit new result, not a reinterpretation
// of historical unknown/timed_out records which retain reconciliationRequired=true.
export const reviewTransportTimeout=result=>result?.outcome==='timed_out'&&result.reconciliationRequired===false
  &&!hasProviderReviewResult(result.observation.events);
// outcome "failed" is a new explicit result (see inspectProviderReviewFailure);
// historical unknown results keep reconciliationRequired=true and never read as it.
export const reviewerFailure=result=>result?.outcome==='failed'&&result.reconciliationRequired===false
  &&result.inspection?.kind==='cm-provider-review-failure';
// Every retryable review ending shares one redispatch per attempt with abandon.
export const reviewRetryCode=result=>reviewTransportTimeout(result)?'review_transport_timeout'
  :reviewerFailure(result)?(result.inspection.category==='verdict'?'review_verdict_invalid':'review_provider_failed'):null;
export const REVIEW_RETRY_CODES=Object.freeze(['review_transport_timeout','review_abandoned','review_provider_failed','review_verdict_invalid']);
// A review registered but never handed to the reviewer: the dispatch grant had
// expired, or the dispatch clock ran backwards (task-runner, outcome not_dispatched,
// call started:false). No reviewer process ran and no verdict exists, so nothing has
// to be proven stopped: the round may dispatch again under a fresh grant (new effect
// id, same review round). Such an effect holds no call or effect slot. Only the
// runner's not_dispatched halt yields pending_review with these codes.
export const REVIEW_NOT_DISPATCHED_CODES=Object.freeze(['grant_expired','clock_invalid']);
const notDispatchedEffect=entry=>entry.effect.kind==='review'&&entry.result.state==='pending_review'
  &&REVIEW_NOT_DISPATCHED_CODES.includes(entry.result.code)&&entry.result.reviewInvocation?.result?.outcome==='not_dispatched';
// Bounded on its own (it holds no call or effect slot): at most two such redispatches
// per review round, like the no-result ones. The count is the round's not-dispatched
// effects in the checkpointed cache, so live and replay read the same number; once the
// round's latest end is the third, no review effect is admitted (live and replay) and
// status shows the explicit limit block.
export const MAX_REVIEW_NOT_DISPATCHED_RETRIES=2;
export const REVIEW_NOT_DISPATCHED_LIMIT_CODE='review_not_dispatched_limit';
export const reviewNotDispatchedCount=(cache,attempt)=>cache.filter(entry=>entry.effect.identity.attempt===attempt&&notDispatchedEffect(entry)).length;
export const reviewNotDispatchedExhausted=s=>s.state==='pending_review'&&REVIEW_NOT_DISPATCHED_CODES.includes(s.code)
  &&reviewNotDispatchedCount(s.cache,s.attempt)>MAX_REVIEW_NOT_DISPATCHED_RETRIES;
export const reviewNotDispatchedLimitReason=code=>`${REVIEW_NOT_DISPATCHED_LIMIT_CODE}: 本轮独立审查已登记 ${MAX_REVIEW_NOT_DISPATCHED_RETRIES+1} 次，每次都在派发前作废（最近一次 pending_review/${code}：授权过期或派发时钟倒退），审查进程从未启动。`
  +`本运行不再重派，也没有接受这个状态的恢复操作（supersede 不接受原始 pending_review）。先查清宿主从授权到派发为何超过授权有效期（60 秒内）或本机时钟为何倒退；保留本运行记录与代码，把本 reason 交给维护者处理。`;
const timeoutEffect=entry=>entry.effect.kind==='review'&&reviewRetryCode(entry.result.reviewInvocation?.result)!==null
  &&entry.result.code===reviewRetryCode(entry.result.reviewInvocation.result);
export const reviewRetrySpent=(cache,calls,attempt,contextId)=>cache.some(entry=>entry.effect.identity.attempt===attempt&&timeoutEffect(entry))
  ||calls.some(call=>call.terminal==='abandoned'&&call.contextId===contextId);
// V5 (A34/A36): no-result redispatches of one review round (attempt), counted
// apart from the two review rounds: the automatic one (a retryable end that went
// back to pending_review), operator abandonments (abandoned calls), and the
// review-redispatch records an operator writes (abandon_review) from a spent
// retryable block. The automatic transition still grants only the first
// (reviewTimeoutTransition, unchanged so older journals replay as written); the
// second needs that record, which carries the operator's confirmation that the
// original call's reviewer process stopped: a timeout only aborted it and the
// host never waited for its exit, so nothing else proves it gone.
// Never a third verdict: a redispatch exists only because the round accepted none.
export const MAX_REVIEW_REDISPATCHES=2;
export const reviewRedispatchCount=(cache,calls,attempt,contextId,records=0)=>
  cache.filter(entry=>entry.effect.identity.attempt===attempt&&timeoutEffect(entry)&&entry.result.state==='pending_review').length
  +calls.filter(call=>call.terminal==='abandoned'&&call.contextId===contextId).length+records;
// The spent retryable block of this round (reviewTimeoutTransition gave blocked).
const spentRetryBlock=s=>{
  const entry=s.cache.at(-1);
  // An end whose worker could not confirm its process-group cleanup never qualifies.
  return s.state==='blocked'&&REVIEW_RETRY_CODES.includes(s.code)&&entry?.effect.kind==='review'
    &&s.reviewInvocation?.result?.observation?.result?.code!=='process_cleanup_unknown'
    &&entry.effect.identity.attempt===s.attempt&&timeoutEffect(entry)&&entry.result.state==='blocked'&&entry.result.code===s.code
    &&s.reviewInvocation?.registration?.grant?.invocationId!=null
    &&entry.result.reviewInvocation?.registration?.grant?.invocationId===s.reviewInvocation.registration.grant.invocationId;
};
export const reviewRedispatchable=(s,contextId,records=0)=>spentRetryBlock(s)
  &&reviewRedispatchCount(s.cache,s.calls,s.attempt,contextId,records)<MAX_REVIEW_REDISPATCHES;
export const reviewRedispatchExhausted=(s,contextId,records=0)=>spentRetryBlock(s)
  &&reviewRedispatchCount(s.cache,s.calls,s.attempt,contextId,records)>=MAX_REVIEW_REDISPATCHES;
export const REVIEW_REDISPATCH_LIMIT_CODE='review_redispatch_limit';
export const reviewRedispatchLimitReason=code=>`${REVIEW_REDISPATCH_LIMIT_CODE}: 本轮独立审查已无结论重派 ${MAX_REVIEW_REDISPATCHES} 次（原记录 blocked/${code}），`
  +'不再自动重派，也不计为审查轮次。先查清审查进程为何一直没有结论（登录、额度、网络或审查答复格式），'
  +'修好后用 --supersede-reviewed-evidence 新建运行重做；本运行记录保留不改写。';
export const reviewRedispatchStopReason=code=>`review_redispatch_stop_required: 本轮独立审查第二次没有结论（blocked/${code}），本轮还剩 1 次无结论重派。`
  +'宿主只中止了原调用、没有等到审查进程退出，不能证明它已停止：先确认原审查进程（含子进程）已退出，'
  +'再用 --allow-abandon-review 发送 abandon_review（单行 reason）登记确认，之后 advance 重新取得授权并重派；不算审查轮次。';
export const reviewTimeoutTransition=(result,cache,attempt,calls=[],contextId=null)=>{
  const code=reviewRetryCode(result);
  return code===null?null:{state:reviewRetrySpent(cache,calls,attempt,contextId)?'blocked':'pending_review',code};
};
// Six counted provider calls per run. Locally rejected developer values,
// automatic review retries and abandoned invocations hold no slot.
export const MAX_RUNNER_CALLS=6;
// A develop the host answer limit cut off (call_timeout, call terminal unknown).
// It produced nothing the runner accepted. Only while the code root still equals
// where it started (checked live, see developTimeoutBasis) can the run go on, so
// it holds no call or effect slot; MAX_DEVELOP_TIMEOUT_RETRIES bounds the redos.
export const developTimeoutEffect=entry=>entry.effect.kind==='develop'&&entry.result.state==='unknown'
  &&entry.result.code==='call_timeout';
export const MAX_DEVELOP_TIMEOUT_RETRIES=2;
export const DEVELOP_CALL_TIMEOUT_REASON='develop_call_timeout: 开发应答超过宿主请求上限（默认 30 分钟），代码根仍与本轮开发开始时一致；'
  +'在原运行 advance 重发本轮开发（新 effect id，审查轮次不变）。迟到的应答仍被拒绝。';
// The tree a timed-out develop started from, when the journal pins it: the
// reviewed attempt-1 package (attempt 2) or the original baseline (attempt 1,
// nothing delivered yet). A develop redone from a blocked delivery left
// unrecorded edits on disk, so its start cannot be proven: null, stays unknown.
// The binding outlives the develop-timeout-retry record (blocked/develop_call_timeout):
// the redo re-verifies the same start right before dispatch.
export const developTimeoutState=s=>s.state==='unknown'&&s.code==='call_timeout'
  ||s.state==='blocked'&&s.code==='develop_call_timeout';
export function developTimeoutBasis(s,configuration=null) {
  if(configuration?.mode==='instructions')return null;
  const last=s.cache.at(-1),call=s.calls.at(-1);
  if(!(developTimeoutState(s)&&last&&developTimeoutEffect(last)
    &&last.effect.identity.attempt===s.attempt&&call?.terminal==='unknown'&&call.channel==='fixture'))return null;
  if(s.cache.filter(developTimeoutEffect).length>MAX_DEVELOP_TIMEOUT_RETRIES)return null;
  return pinnedDevelopStart(s,developTimeoutEffect);
}
// The tree the round's develop effects all started from, when the journal pins
// it: the reviewed attempt-1 package (attempt 2) or the original baseline
// (attempt 1, nothing delivered yet). Earlier develops of this attempt that
// produced nothing the runner accepted (skip) are passed over; any other entry
// means unrecorded edits may exist, so the start cannot be proven (null). The
// caller still compares the live code root with it.
function pinnedDevelopStart(s,skip,from=s.cache.length-2){
  for(let i=from;i>=0;i--){
    const entry=s.cache[i];
    if(skip(entry)&&entry.effect.identity.attempt===s.attempt)continue;
    return s.attempt===2&&entry.effect.kind==='review'&&entry.result.state==='changes_requested'
      &&s.reviewPackage?.identity.attempt===1&&s.priorReview?.verdict==='changes_requested'?'reviewed_package':null;
  }
  return s.attempt===1&&s.reviewPackage===null?'baseline':null;
}
// A current-session answer the host rejected locally (invalid_result without the
// protected retryable flag: e.g. application.note over 512 characters). It was
// journaled as blocked/failed. Like a protected invalid value it holds no call
// or effect slot; MAX_DEVELOP_ANSWER_RETRIES bounds the redos. Edits the session
// already wrote stay on disk and are part of the redone delivery, which is
// built from the round's start and reviewed like any other.
export const developAnswerInvalidEffect=entry=>{
  const call=entry.result.calls?.at(-1);
  return entry.effect.kind==='develop'&&entry.result.state==='blocked'&&entry.result.code==='failed'
    &&call?.terminal==='failed'&&call.requestedModel==='current-session'&&call.failureResult?.code==='invalid_result'
    &&!Object.hasOwn(call.failureResult,'retryable');
};
export const MAX_DEVELOP_ANSWER_RETRIES=2;
export const DEVELOP_ANSWER_LIMITS='application.note 为单行且不超过 512 个字符（no_relevant_lesson 时为 null）；'
  +'retrospective 的 reason 与每个候选的 trigger、action 为单行且不超过 240 个字符；候选 1–3 个，每个 1–8 条相对路径证据（单行、不超过 512 个字符）';
const answerReasons={application_note_limit:'application.note 超过 512 个字符或含换行'};
export const developAnswerInvalidReason=failure=>`develop_answer_invalid: 开发应答未通过交付合同校验（${answerReasons[failure?.reason]??failure?.reason??'invalid_input'}）；`
  +`上限：${DEVELOP_ANSWER_LIMITS}。会话已写的代码保留，在原运行 advance 重发本轮开发（新 effect id，审查轮次不变），按上限重新应答。`;
// The journaled blocked/failed develop is the last effect and the cap is not spent.
export function developAnswerRetryable(s,configuration=null) {
  if(configuration?.mode==='instructions')return false;
  const last=s.cache.at(-1);
  return s.state==='blocked'&&['failed','develop_answer_invalid'].includes(s.code)&&last!==undefined
    &&developAnswerInvalidEffect(last)&&last.effect.identity.attempt===s.attempt
    &&s.cache.filter(developAnswerInvalidEffect).length<=MAX_DEVELOP_ANSWER_RETRIES;
}
// V3 answer gaps: the delivery already reached the disk (the developer call
// succeeded and its Learning was written back), but a later step never got a
// usable answer: the task checks or the verification precheck (timed out,
// disconnected, late, or malformed), or the completion re-check before any
// task-commit-intent. The developer is never dispatched again: advance journals
// develop-recheck (or complete-recheck) and re-runs only those later steps.
// Neither the source effect nor its re-check holds a call or effect slot;
// MAX_ANSWER_GAP_RETRIES bounds each kind per run. Old journals are projected
// the same way on replay; their records are never rewritten.
export const MAX_ANSWER_GAP_RETRIES=2;
const CHECK_ANSWER_MISSING=['call_timeout','execution_error','host_disconnected','host_request_timeout','role_log_failed'];
// limit_exceeded is left out: it is also how older runtimes recorded package and
// journal size limits, which a re-check does not resolve. An oversized check
// answer is refused by the bridge and times out (check_answer_missing).
const CHECK_ANSWER_INVALID=['invalid_input','invalid_result','verification_precheck_invalid'];
// A53: the delivery touched paths outside the task scope (not only files the
// checks created). The paths are named; once the operator moved or restored
// them, a re-check rebuilds the handoff and package without a new develop.
export const OUT_OF_SCOPE_RECHECK_CODE='develop_out_of_scope';
export const RECHECK_CODES=Object.freeze(['check_answer_missing','check_answer_invalid',OUT_OF_SCOPE_RECHECK_CODE]);
export const COMPLETE_RECHECK_CODE='complete_recheck_failed';
// learningWriteback mirrors the checkpointed Learning result, which the journal
// grammar only accepts after this effect's own developer call succeeded (or on a
// re-check that kept it unchanged).
export const developRecheckSource=entry=>{
  const result=entry.result,call=result.calls?.at(-1);
  return entry.effect.kind==='develop'&&result.state==='unknown'
    &&[...CHECK_ANSWER_MISSING,...CHECK_ANSWER_INVALID,'out_of_scope'].includes(result.code)
    &&call?.terminal==='succeeded'&&call.channel==='fixture'
    &&result.learningWriteback!=null&&result.learningWriteback.outcome!=='writeback_pending';
};
export function developRecheckCode(s,config,recorded=0){
  if(config.bootstrap?.mode==='instructions'||config.taskLearning?.hostHandoff!==true)return null;
  const last=s.cache.at(-1);
  if(!last||last.effect.identity.attempt!==s.attempt||!developRecheckSource(last)
    ||s.learningResult==null||s.receipt!==null)return null;
  if(s.state==='blocked'&&RECHECK_CODES.includes(s.code))return s.code;
  if(!(s.state==='unknown'&&s.code===last.result.code)||recorded>=MAX_ANSWER_GAP_RETRIES)return null;
  return last.result.code==='out_of_scope'?OUT_OF_SCOPE_RECHECK_CODE
    :CHECK_ANSWER_INVALID.includes(last.result.code)?'check_answer_invalid':'check_answer_missing';
}
// detail: the source checkpoint's reason, which names the out-of-scope paths.
const outOfScopePaths=detail=>typeof detail==='string'&&/^out_of_scope:/.test(detail)
  ?detail.replace(/^out_of_scope:\s*/,'').split(/,\s*/).filter(Boolean).slice(0,20):[];
export const developRecheckReason=(code,source,detail=null)=>code===OUT_OF_SCOPE_RECHECK_CODE
  ?boundedReason(`${code}: 开发已交付并写回 Learning，但改动超出任务 scope（原记录 unknown/${source}）：`,(paths=>paths.length?paths:['见原记录'])(outOfScopePaths(detail)),
    '。这些路径可能是会话越界写的，也可能是你自己的改动：移走或还原它们（确需改动就先走规格变更扩大 scope）后，在原运行 advance 只重跑检查、验证预检、handoff 与审查包，不重发开发、不占名额（每运行最多 2 次）。')
  :`${code}: 开发已交付并写回 Learning，但之后的检查或验证预检没有拿到可用应答（原记录 unknown/${source}）。`
  +'先确认上一次检查命令已经停止；在原运行 advance 只重跑检查、验证预检、handoff 与审查包，不重发开发，不占开发调用与 effect 名额（每运行最多 2 次）。';
export const completeRecheckSource=entry=>entry.effect.kind==='complete'&&entry.result.state==='unknown'
  &&[...CHECK_ANSWER_MISSING,'invalid_input'].includes(entry.result.code)
  &&entry.result.taskCommit===null;
export function completeRecheckable(s,recorded=0){
  const last=s.cache.at(-1);
  if(!last||last.effect.identity.attempt!==s.attempt||!completeRecheckSource(last)||s.taskCommit!=null)return false;
  if(s.state==='blocked'&&s.code===COMPLETE_RECHECK_CODE)return true;
  return s.state==='unknown'&&s.code===last.result.code&&recorded<MAX_ANSWER_GAP_RETRIES;
}
export const completeRecheckReason=source=>`${COMPLETE_RECHECK_CODE}: 完成前复查没有正常结束（检查应答缺失、断开，或宿主在写入提交意图前出错；原记录 unknown/${source}），task-commit-intent 尚未写入，tasks.md 未改动。`
  +'先按宿主 stderr 的 diagnostic 修好原因（如缺失的 handoff 或检查环境）；'
  +'在原运行发送 complete 重新复查并完成，不重新开发或审查（每运行最多 2 次）。';
// V2 + R3: a current-session develop whose answer never arrived (timed out with
// the code root changed or its start not pinned, disconnected, late) or came back
// as a bare failure. The session may still be writing and the host cannot see
// it, so nothing is redispatched until the operator confirms it stopped:
// develop_redo with a reason, journaled as develop-answer-redo. The redo sends
// the same round under a new effect id. Edits already on disk stay and are part
// of the redone delivery, whose review package is built against the task
// baseline captured when the run was created (never re-captured), so no edit
// skips the checks and the independent review. Provider development and
// instruction bootstrap are excluded (their writers or half-writes need their
// own reconciliation); the host also excludes protected current-session mode,
// where a changed root can only be a partially applied proposal.
export const DEVELOP_REDO_CODE='develop_answer_missing';
export const MAX_DEVELOP_REDOS=2;
export const developAnswerMissingEffect=entry=>{
  const result=entry.result,call=result.calls?.at(-1);
  if(entry.effect.kind!=='develop'||call?.requestedModel!=='current-session'||call.channel!=='fixture')return false;
  return result.state==='unknown'&&result.code==='unknown'&&call.terminal==='unknown'
    ||result.state==='blocked'&&result.code==='failed'&&call.terminal==='failed'
      &&!Object.hasOwn(call,'failureResult')&&!Object.hasOwn(call,'blockedReason');
};
// V9: a provider develop (Codex writes in its sandbox, Claude proposes and the
// host applies) that ended without a usable result. Its worker may outlive the
// call, so a redo is offered only for an effect whose worker identity this
// runtime journaled (workerJournal intent marker): the host then proves the
// recorded process group gone before the redo record is written.
export const providerStuckCause=entry=>{
  const result=entry.result,call=result.calls?.at(-1);
  if(entry.effect.kind!=='develop'||!call||call.requestedModel==='current-session'||call.channel!=='fixture')return null;
  if(result.state==='unknown'&&call.terminal==='unknown')return result.code==='call_timeout'?'provider_call_timeout':'provider_unknown';
  // Only an explicit invalid proposal: a bare failure may be a legitimate
  // blocked answer without a reason, which stays terminal (A11).
  if(result.state==='blocked'&&result.code==='failed'&&call.terminal==='failed'&&!Object.hasOwn(call,'blockedReason')
    &&call.failureResult?.code==='invalid_result'&&call.failureResult.retryable!==true)return 'provider_failed';
  if(result.state==='blocked'&&result.code==='unavailable'&&call.terminal==='unavailable')return 'provider_unavailable';
  return null;
};
// What the stuck develop was ('call_timeout', 'unknown', 'execution_error',
// 'failed' or a provider_* cause), or null when this exit does not apply.
// workers: the journaled worker records by effect id (readRunnerHistory).
export function developRedoCause(s,config,recorded=0,workers=null){
  if(config.bootstrap?.mode==='instructions'||recorded>=MAX_DEVELOP_REDOS)return null;
  if(config.developer.requestedModel!=='current-session'){
    const last=s.cache.at(-1);
    if(!last||last.effect.identity.attempt!==s.attempt||s.receipt!==null)return null;
    const cause=providerStuckCause(last);
    if(cause===null||s.state!==last.result.state||s.code!==last.result.code)return null;
    return workers?.[last.effect.id]?.journal===true?cause:null;
  }
  const last=s.cache.at(-1);
  if(!last||last.effect.identity.attempt!==s.attempt||s.receipt!==null)return null;
  if(developTimeoutEffect(last)&&s.calls.at(-1)?.terminal==='unknown'
    &&(s.state==='unknown'&&s.code==='call_timeout'||s.state==='blocked'&&s.code==='develop_call_timeout'))return 'call_timeout';
  if(developAnswerMissingEffect(last)&&s.state===last.result.state&&s.code===last.result.code)return last.result.code;
  // A dispatch failure whose round start cannot be proven unchanged (legacy
  // execution_error, a start the journal does not pin, or a root that changed,
  // also after its develop-dispatch-retry record) needs the same confirmation.
  if(developDispatchFailedEffect(last)&&(s.state==='unknown'&&s.code===last.result.code
    ||s.state==='blocked'&&s.code===DISPATCH_RETRY_CODE))return last.result.code;
  return null;
}
// V1/V3 (P1-3): the current-session developer run failed before the session was
// asked anything: the host's own role routing (its run-log write or the workflow
// role configuration) threw, the call never returned (terminal unknown, no
// result). Those codes are raised only before the bridge request, so nothing
// was dispatched and nothing written: develop_dispatch_failed, redone like any
// retryable develop block after a develop-dispatch-retry record. Older runtimes
// collapsed the same failure into execution_error, which a failure after the
// answer can also produce; such a journal gets this exit only while the code
// root still equals the round's pinned start (checked live, like #198), and
// otherwise the operator-confirmed develop_redo.
export const DISPATCH_RETRY_CODE='develop_dispatch_failed';
export const DISPATCH_FAILURE_CODES=Object.freeze(['role_log_failed','invalid_workflow_config']);
export const developDispatchFailedEffect=entry=>{
  const result=entry.result,call=result.calls?.at(-1);
  return entry.effect.kind==='develop'&&result.state==='unknown'
    &&[...DISPATCH_FAILURE_CODES,'execution_error'].includes(result.code)
    &&call?.terminal==='unknown'&&call.resultDigest===null&&call.requestedModel==='current-session'&&call.channel==='fixture';
};
// The round start the journal pins ('baseline' or 'reviewed_package'), or null.
// Like #198 the binding outlives the develop-dispatch-retry record
// (blocked/develop_dispatch_failed): the host compares the live code root with
// this start before every redispatch, the first one and any after a restart.
export function developDispatchBasis(s,config,recorded=0){
  if(config.bootstrap?.mode==='instructions'||config.developer.requestedModel!=='current-session')return null;
  const last=s.cache.at(-1);
  if(!last||last.effect.identity.attempt!==s.attempt||s.receipt!==null||!developDispatchFailedEffect(last))return null;
  if(!(s.state==='unknown'&&s.code===last.result.code&&recorded<MAX_DEVELOP_REDOS
    ||s.state==='blocked'&&s.code===DISPATCH_RETRY_CODE))return null;
  return pinnedDevelopStart(s,entry=>developDispatchFailedEffect(entry)||developTimeoutEffect(entry));
}
// Q16/Q17 (V2): documentation_sync runs inside the final task's develop, after
// the session already answered the develop. This runtime journals that answer
// and the documentation start (documentation-sync-started) right before it asks
// the sync, and marks the developer call with that record's digest
// (call.documentationSync). A sync that then ends without a usable answer is
// checkpointed unknown with one of these codes; only documentation_sync is
// asked again, by a develop intent whose adapter reuses the journaled answer.
// The developer is never dispatched again, and the review package still
// compares with the task baseline captured at create. The source holds no call
// or effect slot; MAX_DOCUMENTATION_SYNC_RETRIES bounds the retries per run.
// Journals without the record keep their old projection.
//
// R3: nothing the host observes proves the documentation writer stopped. A
// lost answer may simply not have written yet, and an accepted answer only ends
// the host's wait, not the session's writes. So every retry first needs the
// operator's stop confirmation for that exact source call (develop_redo with a
// reason, journaled as documentation-sync-retry), or the effect-interrupted
// record of a host that died during the sync (the same confirmation, given
// through abandon_effect). The disk is a separate gate, checked right before
// every redispatch (also after a restart): the code root outside the
// documentation paths still equals the documentation start, and the
// documentation paths still equal what they were when the stop was confirmed.
export const DOCUMENTATION_SYNC_INTERRUPTED_CODE='documentation_sync_interrupted';
export const DOCUMENTATION_SYNC_CODES=Object.freeze(['documentation_sync_answer_missing','documentation_sync_answer_invalid',
  'documentation_sync_answer_blocked','documentation_sync_out_of_scope',DOCUMENTATION_SYNC_INTERRUPTED_CODE]);
export const MAX_DOCUMENTATION_SYNC_RETRIES=2;
// The workflow configuration accepts up to 256 documentation paths
// (host-workflow-capabilities.mjs); the record accepts every one of them.
export const MAX_DOCUMENTATION_PATHS=256;
// The documentation paths and their sha256 (null: absent) a record names: in
// the task scope, distinct, 1..MAX_DOCUMENTATION_PATHS of them.
export function validDocumentationStates(documents,scope){
  need(Array.isArray(documents)&&documents.length>0&&documents.length<=MAX_DOCUMENTATION_PATHS,'runner_documentation');
  const seen=new Set();
  for(const item of documents){
    shape(item,['path','sha256']);
    need(typeof item.path==='string'&&scope.includes(item.path)&&!seen.has(item.path),'runner_documentation');
    seen.add(item.path);if(item.sha256!==null)hex(item.sha256);
  }
  return documents;
}
export const DOCUMENTATION_SYNC_LIMIT_CODE='documentation_sync_retry_limit';
export const documentationSyncSource=entry=>{
  const result=entry.result,call=result.calls?.at(-1);
  return entry.effect.kind==='develop'&&result.state==='unknown'&&DOCUMENTATION_SYNC_CODES.includes(result.code)
    &&call?.terminal==='unknown'&&call.resultDigest===null&&typeof call.documentationSync==='string'
    &&call.channel==='fixture'&&result.learningWriteback==null;
};
// The checkpointed failure (state unknown, last effect) still waiting for its
// stop confirmation, while the run has a retry left; its code, or null.
export function documentationSyncRetryCode(s,config,recorded=0){
  if(config.bootstrap)return null;
  const last=s.cache.at(-1);
  if(!last||last.effect.identity.attempt!==s.attempt||!documentationSyncSource(last))return null;
  return s.state==='unknown'&&s.code===last.result.code&&recorded<MAX_DOCUMENTATION_SYNC_RETRIES?s.code:null;
}
const documentationSyncCauses={
  documentation_sync_answer_missing:'文档同步没有拿到应答（超时、断开、迟到被拒或宿主核对时出错）',
  documentation_sync_answer_invalid:'文档同步的应答格式不合格（只接受 {"status":"completed"} 或 {"status":"blocked"}）',
  documentation_sync_answer_blocked:'文档同步答复 blocked，文档没有同步完',
  documentation_sync_out_of_scope:'文档同步改了文档路径以外的文件',
  documentation_sync_interrupted:'宿主在文档同步中途退出'};
const documentationDetail=(code,detail)=>{
  if(typeof detail!=='string'||!detail)return '';
  if(code==='documentation_sync_out_of_scope'){
    const paths=detail.replace(/^out_of_scope:\s*/,'').split(/,\s*/).filter(Boolean).slice(0,20);
    return paths.length?`：${paths.join(', ')}`:'';
  }
  return code==='documentation_sync_answer_missing'&&/^[a-z_]{1,64}$/.test(detail)?`（${detail}）`:'';
};
const DOCUMENTATION_SYNC_TAIL='只重发文档同步，复用运行存档里已记录的开发应答，不重发开发；盘上的开发与文档改动保留，审查包仍对照本运行创建时的任务基线，经检查与独立审查；不占调用与 effect 名额（每运行最多 2 次）。';
const documentationSyncFixes={
  documentation_sync_answer_blocked:'按会话说明补齐或修正文档、解决阻碍；',
  documentation_sync_out_of_scope:'把这些文件还原到文档同步开始时的内容（宿主按运行存档里的摘要核对，没还原就拒绝；确需修改先走规格变更）；'};
const documentationSyncGate='重发前宿主再核对：文档路径以外的文件与文档同步开始时一致，文档路径与确认停写时一致，任一不符就拒绝、不写记录。';
// Before the confirmation: shown as blocked with pendingAction develop_redo.
export const documentationSyncStopReason=(code,detail=null)=>`${code}: 开发已应答并写入运行存档，但${documentationSyncCauses[code]}${documentationDetail(code,detail)}。`
  +'宿主无法证明会话已停止修改文档（没应答可能只是还没写，已应答也只结束了宿主的等待）；'
  +`先确认会话已停止修改文档，${documentationSyncFixes[code]??''}再以 --mode resume --allow-develop-redo 启动并发送 develop_redo（单行 reason，写入运行存档）；之后 advance `
  +DOCUMENTATION_SYNC_TAIL+documentationSyncGate;
// After the confirmation (documentation-sync-retry or effect-interrupted).
export const documentationSyncRetryReason=(code,detail=null)=>`${code}: ${documentationSyncCauses[code]}${documentationDetail(code,detail)}；`
  +(code===DOCUMENTATION_SYNC_INTERRUPTED_CODE?'操作员已确认旧宿主与会话停止写入（effect-interrupted）。':'操作员已确认会话停止修改文档（documentation-sync-retry）。')
  +'在原运行 advance '+DOCUMENTATION_SYNC_TAIL+documentationSyncGate+'确认之后若你又改了文档，再发送一次 develop_redo 重新确认（不另占次数）。';
export const documentationSyncLimitReason=source=>`${DOCUMENTATION_SYNC_LIMIT_CODE}: 文档同步重发（原记录 ${source}）已在本运行用满 ${MAX_DOCUMENTATION_SYNC_RETRIES} 次，不再重发。`
  +'先查清会话为何一直不应答、答复 blocked 或越界写文件；修好后用 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做，'
  +'本运行留在盘上的改动需还原，或加 --accept-superseded-code-drift 作为已有代码记录。';
export const developDispatchReason=source=>`${DISPATCH_RETRY_CODE}: 开发请求在派发给会话之前失败（原记录 unknown/${source}）`
  +(DISPATCH_FAILURE_CODES.includes(source)?'，宿主自己的角色路由出错，未派发':'')+'，代码根仍与本轮开发起点一致（每次重发前再核对）'
  +'。修好 reason 指出的宿主环境（运行日志写入、工作流角色配置）后在原运行 advance 用新 effect id 重发本轮开发；不占调用与 effect 名额（每运行最多 2 次）。';
const redoCauses={call_timeout:'开发应答超时且代码根已变化或本轮起点无法核对',
  role_log_failed:'开发请求派发前宿主运行日志写入失败，但代码根已变化或本轮起点无法核对',
  invalid_workflow_config:'开发请求派发前工作流角色配置无效，但代码根已变化或本轮起点无法核对',unknown:'开发应答中断（会话断开、应答形状错或结果不明）',
  execution_error:'开发调用以 execution_error 结束、结果不明',failed:'开发应答只回了 failed、没有可用结果',
  provider_call_timeout:'provider 开发进程超时、结果不明',provider_unknown:'provider 开发进程中断或输出无法解析、结果不明',
  provider_failed:'provider 开发提案未通过本地校验',provider_unavailable:'provider 开发进程启动失败或报告失败'};
const providerCause=cause=>String(cause).startsWith('provider_');
export const developRedoRequiredReason=cause=>providerCause(cause)
  ?`${DEVELOP_REDO_CODE}: ${redoCauses[cause]??cause}。provider 进程组可能仍在写文件；以 --mode resume --allow-develop-redo 启动并发送 develop_redo（单行 reason），`
    +'宿主先按运行存档里记下的进程身份（pid、启动时间）核对进程组已退出，核对不了（Windows、无权限、读不到启动时间）就拒绝。'
    +'之后 advance 用新 effect id 重发本轮开发：盘上改动保留，审查包仍对照本运行创建时的任务基线，经检查与独立审查；不占调用与 effect 名额（每运行最多 2 次）。'
  :`${DEVELOP_REDO_CODE}: ${redoCauses[cause]??cause}。会话可能仍在写文件，宿主看不到；`
  +'先确认会话已停止修改代码，再以 --mode resume --allow-develop-redo 启动并发送 develop_redo（单行 reason，写入运行存档）。'
  +'之后 advance 用新 effect id 重发本轮开发：盘上改动保留，审查包仍对照本运行创建时的任务基线，经检查与独立审查；不占调用与 effect 名额（每运行最多 2 次）。';
export const developRedoReason=cause=>`${DEVELOP_REDO_CODE}: ${redoCauses[cause]??cause}；`
  +(providerCause(cause)?'宿主已核对 provider 进程组退出（develop-answer-redo）。':'操作员已确认会话停写（develop-answer-redo）。')
  +'在原运行 advance 用新 effect id 重发本轮开发；盘上改动保留并经检查与独立审查，审查轮次不变。';
// V8: the host died with an effect intent and no checkpoint. abandon_effect
// journals effect-interrupted instead of voiding the run: the pending effect is
// retired (it never got a slot) and the run continues from the step's own
// retryable block. A develop becomes blocked/develop_interrupted and is redone
// under a new effect id; edits already on disk stay and are reviewed against
// the task baseline captured at create (never re-captured). A review that was
// never registered returns to awaiting_review. A completion without a
// task-commit-intent returns to the state it started from. Old journals keep
// their records; their effect-abandoned records still end the run.
export const DEVELOP_INTERRUPTED_CODE='develop_interrupted';
export const developInterruptedReason=provider=>`${DEVELOP_INTERRUPTED_CODE}: 宿主在本轮开发中途退出，开发意图已登记但结果没写入；`
  +(provider?'宿主已核对 provider 进程组退出（或进程从未启动）。':'操作员已确认会话停写。')
  +'在原运行 advance 用新 effect id 重发本轮开发：盘上改动保留，审查包仍对照本运行创建时的任务基线，经检查与独立审查；不占调用与 effect 名额。';
// A45: the host died after task-commit-intent and before its result. Shown
// instead of unknown/reconciliation_required; complete then follows only the
// journaled commit plan (tasks.md before or after, never a redone completion).
export const COMMIT_INTERRUPTED_CODE='complete_commit_interrupted';
export const COMMIT_INTERRUPTED_REASON=`${COMMIT_INTERRUPTED_CODE}: 宿主在写入任务完成的提交意图之后、提交结果之前退出，tasks.md 可能已勾选也可能未勾选。`
  +'发送 complete：宿主只按运行存档里的提交计划核对 tasks.md——已是提交后的内容就补记结果；仍是提交前的内容且证据文件未变、代码仍等于审查通过的交付，就按原计划写完；其余情况拒绝并保留现场。不重新复查、不重新开发。';
export const REVIEW_INTERRUPTED_REASON='review_interrupted: 宿主在审查登记前退出，审查没有派发；在原运行 advance 重新取得本轮审查授权并派发，不占重派次数。';
// A pending develop's round start as the journal pins it (see pinnedDevelopStart):
// nothing of this attempt may have been accepted or left unrecorded edits.
export const pendingDevelopStart=s=>pinnedDevelopStart(s,entry=>developDispatchFailedEffect(entry)||developTimeoutEffect(entry),s.cache.length-1);
// The same start for a checkpointed provider develop being redone (it is the
// last cache entry; earlier redo sources of this attempt produced nothing accepted).
export const redoDevelopStart=s=>pinnedDevelopStart(s,entry=>developDispatchFailedEffect(entry)||developTimeoutEffect(entry)||developRedoSource(entry));
// What may sit between a pending intent and an effect-interrupted record.
// documentation-sync-started (Q16) keeps a host death during the sync interruptible as before.
const INTERRUPTIBLE_TRAILERS={develop:['control','develop-worker','documentation-sync-started'],review:['control','host-joined'],complete:['control']};
// A provider develop that ended without a usable result is, like a current-session
// one, a redo source (developRedoCause): it holds no call or effect slot either.
export const developRedoSource=entry=>developAnswerMissingEffect(entry)||providerStuckCause(entry)!==null;
export const countedCalls=(calls,cache)=>calls.filter(call=>!invalidDeveloperCall(call)&&call.terminal!=='abandoned').length
  -cache.filter(timeoutEffect).length-cache.filter(developTimeoutEffect).length-cache.filter(developAnswerInvalidEffect).length
  -cache.filter(developRedoSource).length-cache.filter(developDispatchFailedEffect).length-cache.filter(notDispatchedEffect).length
  -cache.filter(documentationSyncSource).length;
// A review effect whose journaled result the operator abandoned (below) no
// longer holds one of the six effect slots; its retry does.
const abandonedResult=(entry,calls)=>entry.effect.kind==='review'&&entry.result.state==='unknown'
  &&calls.some(call=>call.terminal==='abandoned'&&call.invocationId===entry.result.reviewInvocation?.registration?.grant?.invocationId);
// Completion holds no effect slot. It makes no provider call, it is admitted
// only from an approved review (stageAllowed), and every outcome but a
// completion re-check block ends the run; those blocks have their own bound,
// MAX_COMPLETION_RETRIES below. So an approved run can always complete, even
// when an older version already spent all six slots on develop and review.
const COMPLETION_RETRY_CODES=['completion_checks_changed','completion_package_changed'];
const completionBlock=entry=>entry.effect.kind==='complete'&&entry.result.state==='blocked'
  &&COMPLETION_RETRY_CODES.includes(entry.result.code);
export const completionBlockCount=cache=>cache.filter(completionBlock).length;
export const completedEffectCount=(cache,calls=[])=>cache.filter(entry=>!(entry.effect.kind==='develop'
  &&entry.result.state==='blocked'&&['developer_result_invalid','check_output_out_of_scope'].includes(entry.result.code))
  &&!timeoutEffect(entry)&&!developTimeoutEffect(entry)&&!developAnswerInvalidEffect(entry)&&!developRecheckSource(entry)
  &&!developRedoSource(entry)&&!developDispatchFailedEffect(entry)&&!notDispatchedEffect(entry)&&!documentationSyncSource(entry)
  &&!abandonedResult(entry,calls)&&entry.effect.kind!=='complete').length;
// The six-effect cap counts develop and review effects only; completion (above),
// QA, documentation and finalization hold no slot.
export const MAX_RUNNER_EFFECTS=6;
// Only develop and review intents need a free slot; complete is gated by stage.
export const effectSlotFree=(kind,cache,calls)=>kind==='complete'||completedEffectCount(cache,calls)<MAX_RUNNER_EFFECTS;
// A delivery is only worth starting while it could still be reviewed: its own
// call and effect slot, and its review's. Otherwise the run could only end in a
// refused checkpoint after the developer or reviewer already ran, so it stops
// before dispatch instead. This is the budget, whatever block made the delivery
// retryable. (Today every counted develop/review effect in a developable state
// also holds a counted call, so the call term decides; the effect term keeps
// the rule true for blocks that could stop before their developer call.)
export const developBudget=s=>({calls:countedCalls(s.calls,s.cache),effects:completedEffectCount(s.cache,s.calls)});
export const developBudgetExhausted=s=>{
  if(!stageAllowed('develop',s.state,s.code,s.priorReview?.verdict))return false;
  // A re-check makes no developer call: only its review needs one.
  const used=developBudget(s),calls=RECHECK_CODES.includes(s.code)?1:2;
  return used.calls+calls>MAX_RUNNER_CALLS||used.effects+2>MAX_RUNNER_EFFECTS;
};
// At most this many re-checks after a blocked completion. Each re-runs only the
// local checks and the commit gate, so a small fixed bound keeps the journal
// bounded; an environment that keeps changing needs fixing, not more attempts.
export const MAX_COMPLETION_RETRIES=3;
export const completionRetriesExhausted=s=>s.state==='blocked'&&COMPLETION_RETRY_CODES.includes(s.code)
  &&completionBlockCount(s.cache)>MAX_COMPLETION_RETRIES;
export const completionRetryLimitReason=({fromCode,completionBlocks})=>
  `completion_retry_limit: 完成前复查已 ${completionBlocks} 次被拦下（最多重试 ${MAX_COMPLETION_RETRIES} 次），上次停在 blocked/${fromCode}。`
  +'先修好检查环境（结果不稳定的检查、会在代码根生成新文件的命令），再用 --supersede-reviewed-evidence 新建运行';
export const developRetryLimitReason=({countedCalls:calls,countedEffects:effects,fromState,fromCode})=>
  `develop_retry_limit: 本运行已用 ${calls} 次计数调用（上限 ${MAX_RUNNER_CALLS}）、${effects} 个计数 effect`
  +`（上限 ${MAX_RUNNER_EFFECTS}），再交付一次将无法送审；上次停在 ${fromState}${fromCode?`/${fromCode}`:''}。`
  +'按该原因修好根因后，用 --supersede-reviewed-evidence 新建运行';
// The latest review of the current attempt was checkpointed unknown with a
// journaled, never-accepted result: a final message cut off by a timeout, or a
// failure of a class that is now retried automatically but was recorded as
// unknown (older versions, or after a final message). Nothing ever accepted its
// verdict, so, exactly like an interrupted registered review, the operator may
// abandon it and spend one of the round's MAX_REVIEW_REDISPATCHES. A Claude reviewer stopped
// at its boundary (unexpected_tool_or_content) qualifies only under
// abandonableReviewerExit: process closed, nothing received, and a rejection
// that cannot have run a tool. Other tool, context and output limit breaks,
// observation_invalid and legacy timed_out without inspection stay out.
// A journaled review end with no accepted verdict that the operator may abandon:
// a timeout, a fixed provider failure, a Claude boundary exit that cannot have
// run a tool (abandonableReviewerExit), or (V5, A33) an end whose reviewer
// process the worker proved gone without a final message (reviewerGoneWithoutResult).
export const abandonableReviewOutcome=result=>result?.inspection!=null&&result.reconciliationRequired===true
  &&(result.outcome==='timed_out'||result.outcome==='unknown'
    &&(Object.hasOwn(REVIEWER_PROVIDER_FAILURES,result.observation?.result?.code)
      ||result.inspection.provider==='claude'&&abandonableReviewerExit(result.observation)
      ||reviewerGoneWithoutResult(result.observation)));
export function abandonableReviewResult(s,contextId,records=0){
  const entry=s.cache.at(-1),result=s.reviewInvocation?.result;
  return s.state==='unknown'&&entry?.effect.kind==='review'&&entry.effect.identity.attempt===s.attempt
    &&entry.result.state==='unknown'&&abandonableReviewOutcome(result)
    &&entry.result.reviewInvocation?.registration?.grant?.invocationId===s.reviewInvocation.registration?.grant?.invocationId
    &&reviewRedispatchCount(s.cache,s.calls,s.attempt,contextId,records)<MAX_REVIEW_REDISPATCHES;
}
// R4: why a no-verdict review end cannot be abandoned, with its real exit.
export function reviewAbandonRefusal(s,contextId,records=0){
  const entry=s.cache.at(-1),result=s.reviewInvocation?.result;
  if(s.state!=='unknown'||entry?.effect.kind!=='review'||entry.effect.identity.attempt!==s.attempt||!result||result.outcome==='observed')return null;
  if(reviewRedispatchCount(s.cache,s.calls,s.attempt,contextId,records)>=MAX_REVIEW_REDISPATCHES)
    return {code:'review_abandon_budget_exhausted',reason:`本轮独立审查已无结论重派 ${MAX_REVIEW_REDISPATCHES} 次，不能再放弃重派；查清原因后用 --supersede-reviewed-evidence 新建运行重做。`};
  if(result.observation?.result?.code==='process_cleanup_unknown')
    return {code:'review_process_unverified',reason:'审查 worker 报告进程组清理结果不明（process_cleanup_unknown），宿主无法证明旧审查进程已退出，不放行重派；手工确认该进程组已不存在后，用 --supersede-reviewed-evidence 新建运行重做。'};
  if(result.inspection==null)
    return {code:'review_observation_invalid',reason:'审查事件流本身不合法（observation_invalid），宿主无法判断审查进程是否给出过结论，不放行重派；核对原审查证据后用 --supersede-reviewed-evidence 新建运行重做。'};
  if(!abandonableReviewOutcome(result))
    return {code:'review_boundary_unverified',reason:'审查进程越界（工具或内容边界）后退出，或退出时可能已收到结论，宿主不能证明重派安全；核对原审查证据与磁盘后用 --supersede-reviewed-evidence 新建运行重做。'};
  return null;
}
export function validateTaskLearningReviewPackage(rawPackage,writeback,learningInput,bootstrap=null,configuration=null) {
  validTaskLearningInput(learningInput,learningInput.identity,learningInput.feature);
  const reviewPackage=readReviewPackage(rawPackage);
  const agents=reviewPackage.changes.find(change=>change.path==='AGENTS.md')??null;
  if(bootstrap!==null){
    need(configuration?.mode==='instructions'&&learningInput.feature===configuration.feature,'runner_learning');
    validateBootstrapReviewPackage(reviewPackage,bootstrap,configuration,learningInput.identity,writeback);
    if(writeback.outcome==='no_new_lesson'||writeback.outcome==='deduplicated')return true;
  }
  if(writeback.outcome==='written')need(agents?.after?.sha256===writeback.agentsFile.sha256,'runner_learning');
  else if(writeback.outcome==='no_new_lesson'){
    const expected=learningInput.learningFiles.find(file=>file.scope==='project'&&file.path==='AGENTS.md')??null;
    if(agents!==null)need(expected!==null&&agents.after?.sha256===expected.sha256,'runner_learning');
  }else need(writeback.outcome==='deduplicated'
    &&(agents===null||agents.after?.sha256===writeback.agentsFile.sha256),'runner_learning');
  return true;
}
// Only a completed bootstrap development whose package construction failed can
// be reconciled locally. Its developer call, checks and Learning writeback are
// already durable; a second develop would lose the original review baseline.
export function bootstrapReviewRecoverable(s,pending=null,configuration=null) {
  const last=s.cache.at(-1),call=s.calls.at(-1);
  return configuration?.mode==='instructions'&&pending===null&&s.attempt===1
    &&(s.state==='unknown'&&s.code==='execution_error'
      ||s.state==='blocked'&&s.code==='bootstrap_review_mismatch')
    &&s.reviewPackage===null&&s.receipt===null&&s.reviewInvocation===null
    &&last?.effect.kind==='develop'&&last.effect.identity.attempt===s.attempt
    &&last.result.state===s.state&&last.result.code===s.code
    &&call?.terminal==='succeeded'&&s.learningResult?.bootstrap!=null
    &&s.learningResult.writeback?.outcome!=='writeback_pending'
    &&Array.isArray(s.currentChecks)&&s.currentChecks.length>0
    &&s.currentChecks.every(item=>item.outcome==='passed'&&(item.kind==='visual'||item.exitCode===0));
}
// limit only widens the builder's own copy check so a caller can measure an
// oversized record exactly; the store still refuses it (JOURNAL_PAYLOAD_LIMIT).
export const runnerPayload=(type,fields,version=1,limit=undefined)=>{need([1,2].includes(version),'runner_version');
  return json(version===1?{version,protocol:'cm-task-runner',type,...fields}:{...fields,version,protocol:'cm-task-runner',type},limit);};
export const runnerPayloadV3=(type,fields,limit=undefined)=>json({...fields,version:3,protocol:'cm-task-runner',type},limit);
export function boundRunnerRecord({id,kind,payload},seq) {
  // Exact S3a envelope width. Digest contents do not affect encoded byte count.
  json({version:1,seq,id,kind,payload,previousDigest:seq>1?'0'.repeat(64):null,digest:'0'.repeat(64)});
}
export function attemptBaseline(original,attempt) {
  const {baselineDigest,...data}=original,next={...data,identity:{...original.identity,attempt}};
  return readReviewBaseline({...next,baselineDigest:digest(next)});
}
export function initialRunnerState(config,session,version=1) {
  return {state:config.reviewers.some(r=>r.allowed&&r.available)?'ready':'pending_review',code:null,attempt:1,session,sequence:0,
    reviewPackage:null,currentChecks:null,receipt:null,receipts:[],calls:[],cache:[],priorReview:null,cancelAfterCommit:false,workflowError:null,cancellationRequested:false,
    ...(version>=2?{taskCommit:null}:{}),...(version===3?{reviewInvocation:null}:{}),
    ...(Object.hasOwn(config,'taskLearning')?{learningResult:null}:{})};
}
export function runnerStatus(s,config) {
  return json({state:s.state,code:s.code,...(s.reason?{reason:s.reason}:{}),identity:{...config.identity,attempt:s.attempt},packageDigest:s.reviewPackage?.packageDigest??null,
    receipt:s.receipt,receipts:s.receipts,calls:s.calls,cancelAfterCommit:s.cancelAfterCommit,workflowError:s.workflowError,cancellationRequested:s.cancellationRequested,
    ...(Object.hasOwn(s,'taskCommit')?{taskCommit:s.taskCommit}:{}),
    ...(Object.hasOwn(s,'reviewInvocation')?{reviewInvocation:s.reviewInvocation}:{}),
    ...(Object.hasOwn(config,'taskLearning')?{learningWriteback:s.learningResult?.writeback??null}:{})},LIMIT);
}
export function controlledState(state,event,outstanding,version=1) {
  const s=structuredClone(state);
  const unresolvedReview=version===3&&s.reviewInvocation?.result?.reconciliationRequired===true
    &&s.reviewInvocation.registration?.grant?.identity?.attempt===s.attempt;
  if(event==='workflow-error') {s.workflowError='workflow_error';if(!outstanding && s.state!=='fixture_completed'
    && !(s.state==='unknown'&&(version>=2&&s.taskCommit||unresolvedReview))){s.state='blocked';s.code='workflow_error';if(Object.hasOwn(s,'reason'))s.reason=null;}}
  else if(event==='late-cancel'){s.cancelAfterCommit=true;s.cancellationRequested=true;}
  else if(event==='cancel') {if(!['blocked','unknown','cancelled','fixture_completed'].includes(s.state)){s.state='cancelled';s.code='cancelled';if(Object.hasOwn(s,'reason'))s.reason=null;s.cancellationRequested=true;}}
  else need(false,'runner_control');
  return s;
}
function packageLink(pkg,original,attempt,checks) {
  const p=readReviewPackage(pkg),b=attemptBaseline(original,attempt);
  same(p.identity,b.identity);same(p.scope,b.scope);same(p.checks,checks);
  need(p.baseIdentity===b.baselineDigest && p.rootDigest===b.rootDigest,'runner_package');
  const files=new Map(b.files.map(f=>[f.path,f]));
  for(const c of p.changes){same(c.before,files.get(c.path)??null);if(c.after===null)files.delete(c.path);else files.set(c.path,c.after);}
  if(Object.hasOwn(p,'unchangedScope')){
    const changed=new Set(p.changes.map(c=>c.path));
    same(p.unchangedScope,b.scope.filter(path=>!changed.has(path)&&files.has(path))
      .map(path=>({path,sha256:files.get(path).sha256})));
  }
  same(p.specification??null,b.specification??null);
  same(p.requirements,b.requirements.map(path=>files.get(path)??null));
  same(p.codeProjectPaths??null,b.codeProjectPaths??null);
  same(p.ignorePolicy??null,b.ignorePolicy??null);
  if(Object.hasOwn(b,'bootstrapRequirements'))same(p.bootstrapRequirements,{feature:b.bootstrapRequirements.feature,
    rootDigest:digestRoot(b.bootstrapRequirements.specsRoot),files:b.bootstrapRequirements.files});
  else need(!Object.hasOwn(p,'bootstrapRequirements'),'runner_package');
}
function callRequest(call,adapter,contextId,role,payload,identity,session,index) {
  shape(call,['invocationId','contextId','provider','requestedModel','effectiveModel','channel','started','terminal','requestDigest','resultDigest',
    ...(Object.hasOwn(call,'providerThreadId')?['providerThreadId']:[]),
    ...(Object.hasOwn(call,'failureResult')?['failureResult']:[]),
    ...(Object.hasOwn(call,'blockedReason')?['blockedReason']:[]),
    ...(Object.hasOwn(call,'documentationSync')?['documentationSync']:[])]);
  // Q16: the documentation-sync-started record this developer call journaled.
  if(Object.hasOwn(call,'documentationSync')){need(role==='developer','runner_call');hex(call.documentationSync);}
  if(Object.hasOwn(call,'blockedReason')){
    need(role==='developer'&&call.terminal==='failed'&&!Object.hasOwn(call,'failureResult'),'runner_call');
    validBlockedReason(call.blockedReason);
  }
  if(Object.hasOwn(call,'providerThreadId')){need(role==='developer','runner_call');id(call.providerThreadId);}
  need(call.invocationId===`${session}.${index}` && call.contextId===contextId && call.provider===adapter.provider
    && call.requestedModel===adapter.requestedModel && call.channel==='fixture' && call.started===true,'runner_call');
  text(call.effectiveModel);hex(call.requestDigest);
  need(['succeeded','failed','unknown','cancelled','unavailable','auth_required','permission_denied'].includes(call.terminal),'runner_call');
  if(call.resultDigest!==null)hex(call.resultDigest);
  if(Object.hasOwn(call,'failureResult')){
    need(role==='developer'&&call.terminal==='failed','runner_call');
    shape(call.failureResult,['code','reason',...(Object.hasOwn(call.failureResult,'retryable')?['retryable']:[])]);
    if(Object.hasOwn(call.failureResult,'retryable'))need(call.failureResult.retryable===true
      &&call.failureResult.code==='invalid_result'&&adapter.requestedModel==='current-session','runner_call');
    need(['invalid_result','protected_edit_stale','bootstrap_verification_failed'].includes(call.failureResult.code),'runner_call');id(call.failureResult.reason);
    if(call.failureResult.code==='bootstrap_verification_failed')need(call.failureResult.reason===call.failureResult.code,'runner_call');
    same(call.resultDigest,digest(call.failureResult));
  }else if(['failed','unavailable','auth_required','permission_denied'].includes(call.terminal))same(call.resultDigest,digest(null));
  const request=requestFor({invocationId:call.invocationId,identity,role,provider:adapter.provider,
    requestedModel:adapter.requestedModel,contextId,payload});
  need(call.requestDigest===request.requestDigest,'runner_request');return request;
}
// Supersession context (never a verdict) rides only in attempt-1 develop and
// review requests, so it is bound by their request digests on replay.
export const supersededReviewPayload=(carried,attempt)=>carried&&attempt===1?{supersededReview:carried}:{};
function reviewRequest(before,config,session,carried=null) {
  const reviewer=config.reviewers[0];
  return requestFor({invocationId:`${session}.${before.sequence+1}`,identity:{...config.identity,attempt:before.attempt},
    role:'reviewer',provider:reviewer.provider,requestedModel:reviewer.requestedModel,
    contextId:reviewer.contexts[before.attempt-1],payload:{reviewPackage:before.reviewPackage,priorReview:before.priorReview,
      ...supersededReviewPayload(carried,before.attempt)}});
}
function grantBody(grant) {
  const {grantDigest,...body}=grant;return body;
}
export function validateReviewDispatchGrant(raw,expected) {
  const grant=json(raw),request=expected.request;
  shape(grant,['version','kind','grantId','adapterId','invocationId','requestDigest','identity','reviewerId','logicalContextId',
    'packageDigest','hostContextId','decisionId','decision','issuedAt','expiresAt','grantDigest']);
  need(grant.version===1&&grant.kind==='cm-review-dispatch-grant'&&grant.decision==='approved','runner_grant');
  [grant.grantId,grant.adapterId,grant.invocationId,grant.reviewerId,grant.logicalContextId,grant.hostContextId,grant.decisionId].forEach(id);
  [grant.requestDigest,grant.packageDigest,grant.grantDigest].forEach(hex);validIdentity(grant.identity);
  for(const n of [grant.issuedAt,expected.authorizationAt,expected.registeredAt,grant.expiresAt])need(Number.isSafeInteger(n),'runner_grant');
  need(grant.expiresAt-grant.issuedAt>=1&&grant.expiresAt-grant.issuedAt<=60000
    &&grant.issuedAt<=expected.authorizationAt&&expected.authorizationAt<=expected.registeredAt
    &&expected.registeredAt<grant.expiresAt,'runner_grant');
  same(grant.identity,request.identity);need(grant.adapterId===expected.adapterId&&grant.invocationId===request.invocationId
    &&grant.requestDigest===request.requestDigest&&grant.reviewerId===expected.reviewerId
    &&grant.logicalContextId===request.contextId&&grant.packageDigest===expected.packageDigest,'runner_grant');
  need(expected.hostContextIds.includes(grant.hostContextId),'runner_grant');
  need(digest(grantBody(grant))===grant.grantDigest,'runner_grant');return grant;
}
function readRegistration(p,before,effect,config,session,carried=null) {
  shape(p,['version','protocol','type','effectId','reviewerId','adapterId','requestDigest','authorizationAt','registeredAt','grant']);
  need(p.effectId===effect.id,'runner_invocation');
  const request=reviewRequest(before,config,session,carried),reviewer=config.reviewers[0];
  need(p.reviewerId===reviewer.id&&p.adapterId===reviewer.adapterId&&p.requestDigest===request.requestDigest,'runner_grant');
  const grant=validateReviewDispatchGrant(p.grant,{request,reviewerId:reviewer.id,adapterId:reviewer.adapterId,
    packageDigest:before.reviewPackage.packageDigest,hostContextIds:[config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds],
    authorizationAt:p.authorizationAt,registeredAt:p.registeredAt});
  return {request,record:json({reviewerId:p.reviewerId,adapterId:p.adapterId,requestDigest:p.requestDigest,
    authorizationAt:p.authorizationAt,registeredAt:p.registeredAt,grant})};
}
function readStarted(p,registration,effect,config) {
  shape(p,['version','protocol','type','effectId','invocationId','providerThreadId']);
  need(p.effectId===effect.id&&p.invocationId===registration.request.invocationId,'runner_invocation');id(p.providerThreadId);
  const excluded=new Set([config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds,
    registration.request.contextId]);
  need(!excluded.has(p.providerThreadId),'runner_invocation');return p.providerThreadId;
}
function readInvocationResult(p,registration,started,effect,config) {
  const common=['version','protocol','type','effectId','invocationId','dispatchAt','outcome','observation','inspection','reconciliationRequired'];
  need(p.effectId===effect.id&&p.invocationId===registration.request.invocationId,'runner_invocation');
  need(typeof p.reconciliationRequired==='boolean','runner_invocation');
  if(p.outcome==='not_dispatched')need(p.dispatchAt===null||Number.isSafeInteger(p.dispatchAt),'runner_invocation');
  else need(Number.isSafeInteger(p.dispatchAt)&&registration.record.registeredAt<=p.dispatchAt
    &&p.dispatchAt<registration.record.grant.expiresAt,'runner_invocation');
  const expectation={request:registration.request,developerThreadId:config.reviewInvocation.developerThreadId,
    excludedThreadIds:config.reviewInvocation.excludedThreadIds};
  let inspected=null;
  if(['observed','unknown'].includes(p.outcome)&&p.inspection!==null) {
    shape(p,common);const observation=json(p.observation,512*1024);
    inspected=inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));same(p.inspection,inspected);
    need(inspected.providerThreadId===started,'runner_invocation');
    if(p.outcome==='observed')need(inspected.observationStatus==='completed'&&p.reconciliationRequired===false,'runner_invocation');
    else need(['unknown','cancelled'].includes(inspected.observationStatus)&&p.reconciliationRequired===true,'runner_invocation');
  } else if(p.outcome==='unknown') {
    shape(p,[...common,'reason']);need(p.reason==='observation_invalid'&&p.inspection===null&&p.reconciliationRequired===true,'runner_invocation');
    const observation=json(p.observation,512*1024);need(observation.requestDigest===registration.request.requestDigest,'runner_invocation');
    let rejected=false;try{inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));}catch{rejected=true;}
    const first=observation.events?.find?.(event=>event?.event==='thread.started')?.provider_thread??null;
    need(rejected||first===registration.request.contextId,'runner_invocation');
    if(started===null)need(first===null||[config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds,
      registration.request.contextId].includes(first),'runner_invocation');
    else need(first===started,'runner_invocation');
  } else if(['cancelled','timed_out'].includes(p.outcome)) {
    shape(p,common);
    const observation=json(p.observation,512*1024),check=inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));
    if(p.inspection===null)need(p.reconciliationRequired===true,'runner_invocation'); // legacy result
    else {
      same(p.inspection,check);need(p.outcome==='timed_out','runner_invocation');
      need(p.reconciliationRequired===(Boolean(config.externalModels||config.executionPolicy)||hasProviderReviewResult(observation.events)),'runner_invocation');
    }
    need(check.providerThreadId===started,'runner_invocation');
    need(p.outcome==='cancelled'?check.observationStatus==='cancelled':check.code==='transport_timeout','runner_invocation');
  } else if(p.outcome==='failed') {
    shape(p,common);need(p.reconciliationRequired===Boolean(config.externalModels||config.executionPolicy),'runner_invocation');
    const observation=json(p.observation,512*1024);
    const failure=inspectProviderReviewFailure(JSON.stringify(observation),JSON.stringify(expectation));
    need(failure!==null,'runner_invocation');same(p.inspection,failure);
    need(failure.providerThreadId===started,'runner_invocation');
  } else if(p.outcome==='not_dispatched') {
    shape(p,[...common,'reason']);need(['grant_expired','clock_invalid'].includes(p.reason)
      &&p.observation===null&&p.inspection===null&&p.reconciliationRequired===true&&started===null,'runner_invocation');
    need(p.reason==='grant_expired'?Number.isSafeInteger(p.dispatchAt)&&p.dispatchAt>=registration.record.grant.expiresAt:
      p.dispatchAt===null||p.dispatchAt<registration.record.registeredAt,'runner_invocation');
  } else need(false,'runner_invocation');
  return json(Object.fromEntries(Object.entries(p).filter(([key])=>!['version','protocol','type','effectId','invocationId'].includes(key))),512*1024);
}
function invocationCall(call,registration,started,result,before) {
  shape(call,['invocationId','contextId','provider','requestedModel','effectiveModel','channel','started','terminal','requestDigest','resultDigest','providerThreadId']);
  const request=registration.request;need(call.invocationId===request.invocationId&&call.contextId===request.contextId
    &&call.provider===request.provider&&call.requestedModel===request.requestedModel&&call.effectiveModel==='unknown'
    &&call.channel==='host-authorized'&&call.requestDigest===request.requestDigest
    &&call.providerThreadId===started,'runner_call');
  const expectedTerminal=result.outcome==='observed'?'succeeded':result.outcome==='cancelled'?'cancelled':
    result.outcome==='not_dispatched'?'not_dispatched':reviewTransportTimeout(result)||reviewerFailure(result)?'failed':'unknown';
  need(call.started===(result.outcome!=='not_dispatched')&&call.terminal===expectedTerminal
    &&call.resultDigest===digest(result.outcome==='observed'?result.inspection.review:result)
    &&before.sequence+1===Number(request.invocationId.split('.').at(-1)),'runner_call');
}
function checkpoint(before,raw,effect,config,original,session,controls,version=1,taskCommit=null,invocation=null,carried=null,documentation=null) {
  const s=json(raw,LIMIT);
  shape(s,['state','code','attempt','session','sequence','reviewPackage','currentChecks','receipt','receipts','calls','cache',
    ...(Object.hasOwn(s,'reason')?['reason']:[]),
    'priorReview','cancelAfterCommit','workflowError','cancellationRequested',...(version>=2?['taskCommit']:[]),...(version===3?['reviewInvocation']:[]),
    ...(Object.hasOwn(config,'taskLearning')?['learningResult']:[])]);
  if(Object.hasOwn(s,'reason'))need(s.reason===null||typeof s.reason==='string'&&s.reason.length<=JOURNAL_REASON_LIMIT
    &&!/\r|\n|\0/.test(s.reason),'runner_diagnostic');
  if(version>=2){
    same(s.taskCommit,effect.kind==='complete'?taskCommit:null);
    if(effect.kind==='complete'){
      if(taskCommit===null)need(s.state!=='fixture_completed','runner_commit');
      else if(taskCommit.resultDigest===null)need(s.state==='unknown','runner_commit');
      else need(['fixture_completed','unknown'].includes(s.state),'runner_commit');
    }
  }
  need(states.includes(s.state) && [1,2].includes(s.attempt) && s.session===session,'runner_state');
  need(s.code===null || typeof s.code==='string' && s.code.length<=128,'runner_state');
  need(typeof s.cancelAfterCommit==='boolean' && [null,'workflow_error'].includes(s.workflowError),'runner_state');
  need(typeof s.cancellationRequested==='boolean','runner_state');
  // An abandoned invocation holds no effect slot (its pending effect was never
  // checkpointed, or its journaled result was abandoned), so it holds no call
  // slot either; the attempt's one redispatch is bounded by reviewRetrySpent.
  need(Array.isArray(s.calls) && countedCalls(s.calls,s.cache)<=MAX_RUNNER_CALLS && s.sequence===s.calls.length,'runner_calls');
  need(Array.isArray(s.receipts) && s.receipts.length<=2 && Array.isArray(s.cache) && completedEffectCount(s.cache,s.calls)<=6,'runner_limits');
  prefix(before.calls,s.calls);prefix(before.receipts,s.receipts);prefix(before.cache,s.cache);
  need(s.cache.length===before.cache.length+1,'runner_cache');
  const entry=s.cache.at(-1);shape(entry,['effect','digest','result']);same(entry.effect,effect);same(entry.digest,digest(effect));
  same(entry.result,runnerStatus(s,config));
  const added=s.calls.slice(before.calls.length),identity={...config.identity,attempt:before.attempt};
  let accepted=null,expectedState=null,expectedCode=null,expectedAttempt=before.attempt;
  if(effect.kind!=='develop'&&Object.hasOwn(config,'taskLearning'))same(s.learningResult,before.learningResult);
  if(effect.kind==='develop') {
    need(added.length<=1 && s.receipts.length===before.receipts.length,'runner_develop');same(s.receipt,null);same(s.priorReview,before.priorReview);
    // A re-check (develop-recheck) dispatches no developer: it keeps the Learning
    // result and stands on the developer call that already succeeded.
    const recheck=before.state==='blocked'&&RECHECK_CODES.includes(before.code);
    if(recheck){need(added.length===0&&before.learningResult!=null&&before.calls.at(-1)?.terminal==='succeeded','runner_develop');
      same(s.learningResult,before.learningResult);}
    const developerCall=recheck?before.calls.at(-1):added[0];
    if(added.length)callRequest(added[0],config.developer,config.developer.contextId,'developer',{
      scope:config.scope,requirements:original.files.filter(f=>config.requirements.includes(f.path)),priorReview:before.priorReview,
      ...supersededReviewPayload(carried,before.attempt),
      ...(Object.hasOwn(original,'specification')?{specification:original.specification}:{}),
      ...(Object.hasOwn(effect,'learningInput')?{learningInput:effect.learningInput}:{})
    },identity,session,before.calls.length+1);
    // Q16: a developer call carries the documentation-sync-started record it
    // journaled (exactly that one), and a delivery is the answer it recorded.
    need((added[0]?.documentationSync??null)===(documentation?.digest??null),'runner_documentation');
    if(documentation&&added[0].terminal==='succeeded')
      need(added[0].resultDigest===digest(documentation.payload.result),'runner_documentation');
    if(s.state==='unknown'&&DOCUMENTATION_SYNC_CODES.includes(s.code))
      need(documentation!==null&&added[0].terminal==='unknown'&&added[0].resultDigest===null,'runner_documentation');
    // A documentation-only redo of the final task's develop journals a sync again.
    if(before.state==='blocked'&&DOCUMENTATION_SYNC_CODES.includes(before.code)&&added[0]?.terminal==='succeeded')
      need(documentation!==null,'runner_documentation');
    // A live-session init_verify that did not pass: the host wrote nothing, and
    // the develop keeps exactly the Learning/bootstrap evidence it started from.
    const verificationFailed=added[0]?.terminal==='failed'&&added[0].failureResult?.code==='bootstrap_verification_failed';
    if(verificationFailed){
      need(config.bootstrap?.mode==='instructions'&&Object.hasOwn(config,'taskLearning')
        &&['blocked','cancelled'].includes(s.state),'runner_learning');
      same(s.learningResult,before.learningResult);
    }else if(Object.hasOwn(config,'taskLearning')){
      if(s.learningResult!==null){
        const hasApplication=Object.hasOwn(s.learningResult,'application');
        const hasBootstrap=Object.hasOwn(s.learningResult,'bootstrap');
        need(hasBootstrap===(config.bootstrap?.mode==='instructions'),'runner_learning');
        shape(s.learningResult,[...(hasApplication?['application']:[]),'retrospective','writeback',...(hasBootstrap?['bootstrap']:[])]);
        if(hasBootstrap){
          const evidence=readBootstrapEvidence(s.learningResult.bootstrap,config.bootstrap,identity);
          need(evidence.invocationId===added[0]?.invocationId,'runner_learning');
          for(const file of evidence.files){
            const previous=before.learningResult?.bootstrap?.files.find(item=>item.path===file.path);
            const initial=config.bootstrap?.committedBasis
              ?config.bootstrap.committedBasis.files.find(item=>item.path===file.path)?.sha256??null
              :file.path==='AGENTS.md'?effect.learningInput.learningFiles.find(item=>item.scope==='project'
                &&item.path==='AGENTS.md')?.sha256??null:null;
            const expected=file.path==='AGENTS.md'&&previous&&before.learningResult.writeback.outcome==='written'
              ?before.learningResult.writeback.agentsFile.sha256:previous?.afterSha256??initial;
            need(file.beforeSha256===expected,'runner_learning');
          }
        }
        let application=null;
        if(hasApplication){application=readCmAiTaskLearningApplication(s.learningResult.application);
          need(application.feature===effect.learningInput.feature
            &&application.learningDigest===effect.learningInput.learningDigest,'runner_learning');
          same(application.identity,effect.learningInput.identity);}
        const writeback=readCmAiProjectLearningWriteback(s.learningResult.writeback,
          {learningInput:effect.learningInput,retrospective:s.learningResult.retrospective});
        need((recheck||added.length===1)&&developerCall?.terminal==='succeeded','runner_learning');
        same(developerCall.resultDigest,digest({outcome:'implemented',...(hasApplication?{application}:{}),
          retrospective:s.learningResult.retrospective,...(hasBootstrap?{bootstrap:s.learningResult.bootstrap}:{})}));
        if(writeback.outcome==='writeback_pending'){
          expectedState='blocked';expectedCode='learning_writeback_pending';
        }
      }else need(s.state==='unknown'||s.state==='cancelled'
        ||Object.hasOwn(original,'specification')&&s.state==='blocked'&&s.code==='spec_drift'
        // The host gate rejected the delivery after Learning was already written
        // back: the writeback stands, only the review package was not built.
        ||s.state==='blocked'&&['verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed','bootstrap_instruction_conflict'].includes(s.code)
        ||added.length===0&&s.state==='blocked'&&s.code==='protected_scope'
        ||added[0]&&['failed','unavailable','auth_required','permission_denied'].includes(added[0].terminal),'runner_learning');
    }
    if(digest(s.reviewPackage)!==digest(before.reviewPackage)) {
      const developerResult=Object.hasOwn(config,'taskLearning')
        ?{outcome:'implemented',...(s.learningResult&&Object.hasOwn(s.learningResult,'application')
          ?{application:s.learningResult.application}:{}),retrospective:s.learningResult?.retrospective,
          ...(s.learningResult?.bootstrap?{bootstrap:s.learningResult.bootstrap}:{})}:{outcome:'implemented'};
      need((recheck||added.length===1) && developerCall?.terminal==='succeeded' && developerCall.resultDigest===digest(developerResult),'runner_develop');
      if(Object.hasOwn(config,'taskLearning'))need(s.learningResult!==null
        &&s.learningResult.writeback.outcome!=='writeback_pending','runner_learning');
      packageLink(s.reviewPackage,original,before.attempt,s.currentChecks);
      if(Object.hasOwn(config,'taskLearning'))validateTaskLearningReviewPackage(s.reviewPackage,
        s.learningResult.writeback,effect.learningInput,s.learningResult.bootstrap??null,config.bootstrap??null);
      expectedState='awaiting_review';
    }
    // The developer call succeeded and is never retried, but the host gate blocked
    // between the checks and the review package. No package exists, so no review
    // round was spent; the attempt counter does not move either.
    // develop_unchanged_after_review: attempt 2 matched the rejected attempt-1 artifact.
    if(developerCall?.terminal==='succeeded'&&['verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed','develop_unchanged_after_review','develop_empty_changes','develop_requirement_missing','develop_package_too_large'].includes(s.code)) {
      // s.receipt is null for every develop checkpoint (above); at attempt 2 the
      // state before still holds the attempt-1 receipt, so only receipts compare.
      need(digest(s.reviewPackage)===digest(before.reviewPackage),'runner_develop');
      same(s.receipts,before.receipts);
      if(s.code==='develop_unchanged_after_review')
        need(before.attempt===2&&before.priorReview?.verdict==='changes_requested','runner_develop');
      expectedState='blocked';expectedCode=s.code;
    }
    if(added[0]?.terminal==='succeeded'&&s.code==='bootstrap_review_mismatch'){
      need(config.bootstrap?.mode==='instructions'&&s.reviewPackage===null&&s.learningResult?.bootstrap!=null,
        'runner_develop');
      expectedState='blocked';expectedCode=s.code;
    }
    if(added.length===0&&s.code==='bootstrap_instruction_conflict'){
      need(config.bootstrap?.mode==='instructions','runner_develop');
      same(s.learningResult,before.learningResult);
      expectedState='blocked';expectedCode=s.code;
    }
    if(added.length===0&&s.code==='protected_scope'){
      need(protectedDevelopScope(config).length>0&&digest(s.reviewPackage)===digest(before.reviewPackage),'runner_develop');
      if(Object.hasOwn(config,'taskLearning'))same(s.learningResult,before.learningResult);
      expectedState='blocked';expectedCode=s.code;
    }
    if(added[0] && ['failed','unavailable','auth_required','permission_denied'].includes(added[0].terminal)) {
      expectedState='blocked';expectedCode=invalidDeveloperCall(added[0])
        ?'developer_result_invalid':['protected_edit_stale','bootstrap_verification_failed'].includes(added[0].failureResult?.code)
          ?added[0].failureResult.code:added[0].terminal;
    }
  } else if(effect.kind==='review'&&version===3) {
    same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    if(!invocation?.registration){
      need(!invocation?.result&&added.length===0&&s.sequence===before.sequence,'runner_invocation');
      same(s.reviewInvocation,before.reviewInvocation);same(s.receipt,before.receipt);same(s.receipts,before.receipts);same(s.priorReview,before.priorReview);
      if(controls.cancelled===true){expectedState='cancelled';expectedCode='cancelled';}
      else if(s.code==='permission_denied')expectedState='pending_review';
      else if(Object.hasOwn(original,'specification')&&s.code==='spec_drift')expectedState='blocked';
      else {need(['authorization_invalid','clock_invalid'].includes(s.code),'runner_invocation');expectedState='unknown';}
      expectedCode??=s.code;
    } else {
    need(invocation.result&&added.length===1,'runner_invocation');
    invocationCall(added[0],invocation.registration,invocation.started,invocation.result,before);
    const diagnostic={registration:invocation.registration.record,started:invocation.started,result:invocation.result};
    same(s.reviewInvocation,diagnostic);
    if(invocation.result.outcome==='observed'&&Object.hasOwn(original,'specification')&&s.code==='spec_drift'){
      same(s.receipt,before.receipt);same(s.receipts,before.receipts);same(s.priorReview,before.priorReview);
      expectedState='blocked';expectedCode='spec_drift';
    }else if(invocation.result.outcome==='observed'){
      need(s.receipts.length===before.receipts.length+1,'runner_receipt');
      const rawReceipt=s.receipts.at(-1),result=reviewResult(invocation.result.inspection.review,before.reviewPackage);
      accepted=reviewReceipt({request:invocation.registration.request,call:added[0],result,
        reviewPackage:before.reviewPackage,developerProvider:config.developer.provider,fallbackReasons:[]});
      same(rawReceipt,accepted);same(s.receipt,accepted);same(s.priorReview,result);
      if(result.verdict==='approved')expectedState='approved';
      else if(result.verdict==='changes_requested'&&before.attempt===1){expectedState='changes_requested';expectedAttempt=2;}
      else {expectedState='blocked';expectedCode=result.verdict==='changes_requested'?'review_limit':'review_blocked';}
      if(s.code==='review_package_changed'){
        need(typeof s.reason==='string'&&s.reason.length>0,'runner_diagnostic');
        expectedState='blocked';expectedCode=s.code;
      }
    }
    else if(invocation.result.outcome==='cancelled'){need(controls.cancelled===true,'runner_control');expectedState='cancelled';expectedCode='cancelled';}
    else if(invocation.result.outcome==='not_dispatched'){expectedState='pending_review';expectedCode=invocation.result.reason;}
    else {const retry=reviewTimeoutTransition(invocation.result,before.cache,before.attempt,before.calls,
      config.reviewers[0].contexts[before.attempt-1]);
      expectedState=retry?.state??'unknown';expectedCode=retry?.code??invocation.result.reason??invocation.result.inspection?.code??'reconciliation_required';}
    if(invocation.result.outcome!=='observed'){
      same(s.receipt,before.receipt);same(s.receipts,before.receipts);same(s.priorReview,before.priorReview);
    }
    }
  } else if(effect.kind==='review') {
    same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    const reasons=[];let index=0;
    for(const candidate of config.reviewers) {
      if(!candidate.allowed || !candidate.available){reasons.push({id:candidate.id,reason:!candidate.allowed?'not_authorized':'unavailable'});continue;}
      if(index===added.length)break;
      const call=added[index++],request=callRequest(call,candidate,candidate.contexts[before.attempt-1],'reviewer',{
        reviewPackage:before.reviewPackage,priorReview:before.priorReview,
        ...supersededReviewPayload(carried,before.attempt)},identity,session,before.calls.length+index);
      if(['unavailable','auth_required','permission_denied'].includes(call.terminal)){reasons.push({id:candidate.id,reason:call.terminal});continue;}
      need(index===added.length,'runner_fallback');
      if(s.receipts.length===before.receipts.length+1) {
        const rawReceipt=s.receipts.at(-1),result=reviewResult(rawReceipt.result,before.reviewPackage);
        accepted=reviewReceipt({request,call,result,reviewPackage:before.reviewPackage,developerProvider:config.developer.provider,fallbackReasons:reasons});
        same(rawReceipt,accepted);
        if(result.verdict==='approved')expectedState='approved';
        else if(result.verdict==='changes_requested' && before.attempt===1){expectedState='changes_requested';expectedAttempt=2;}
        else {expectedState='blocked';expectedCode=result.verdict==='changes_requested'?'review_limit':'review_blocked';}
        if(s.code==='review_package_changed'){
          need(typeof s.reason==='string'&&s.reason.length>0,'runner_diagnostic');
          expectedState='blocked';expectedCode=s.code;
        }
      } else if(call.terminal==='failed'){expectedState='pending_review';expectedCode='failed';}
      break;
    }
    need(index===added.length && s.receipts.length===before.receipts.length+(accepted?1:0),'runner_receipt');
    same(s.receipt,accepted??before.receipt);same(s.priorReview,accepted?.result??before.priorReview);
    if(!accepted && reasons.length===config.reviewers.length){expectedState='pending_review';expectedCode='review_channels_unavailable';}
  } else {
    need(added.length===0,'runner_complete');same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    same(s.receipts,before.receipts);same(s.receipt,before.receipt);same(s.priorReview,before.priorReview);
    if(s.state==='fixture_completed') {
      checkCompletion({receipt:s.receipt,registered:before.receipt,execution:s.calls.find(c=>c.invocationId===s.receipt?.id),
        reviewPackage:s.reviewPackage,identity});expectedState='fixture_completed';
    } else if(s.state==='blocked'){
      expectedState='blocked';
      if(['completion_checks_changed','completion_package_changed'].includes(s.code)){
        need(effect.kind==='complete'&&['approved','blocked'].includes(before.state)
          &&(before.state==='approved'||['completion_checks_changed','completion_package_changed','review_package_changed',COMPLETE_RECHECK_CODE].includes(before.code)),'runner_transition');
        expectedCode=s.code;
        if(s.code==='completion_package_changed')need(typeof s.reason==='string'&&s.reason.length>0,'runner_diagnostic');
      }
    }
  }
  if(Object.hasOwn(original,'specification')&&s.state==='blocked'&&s.code==='spec_drift'){
    need(s.receipts.length===before.receipts.length,'runner_receipt');
    same(s.reviewPackage,before.reviewPackage);expectedState='blocked';expectedCode='spec_drift';
  }
  need(s.attempt===expectedAttempt,'runner_attempt');
  // Terminal failure may retain materials; it cannot confer a new dispatch capability.
  if(!['unknown','cancelled'].includes(s.state))need(s.state===expectedState,'runner_transition');
  if(expectedCode && !['unknown','cancelled'].includes(s.state))need(s.code===expectedCode,'runner_transition');
  if(['awaiting_review','approved','fixture_completed'].includes(s.state)) {
    need(s.code===null,'runner_transition');packageLink(s.reviewPackage,original,s.attempt,s.currentChecks);
  }
  need(s.workflowError===(controls.workflowError??before.workflowError),'runner_control');
  need(s.cancelAfterCommit===(controls.cancelAfterCommit||before.cancelAfterCommit),'runner_control');
  need(s.cancellationRequested===(!!controls.cancelled||!!controls.cancelAfterCommit||before.cancellationRequested),'runner_control');
  if(controls.cancelled)need(s.state==='cancelled','runner_control');
  // Runners before the retryable package-limit transition journaled this exact
  // host gate as unknown/limit_exceeded. Reproject only the unambiguous case:
  // development succeeded, every check passed, and no review package exists.
  // The original record remains byte-for-byte in the journal; a resumed frame
  // carries the corrected projection forward.
  if(effect.kind==='develop'&&before.attempt===1&&config.bootstrap?.mode!=='instructions'
    &&s.state==='unknown'&&s.code==='limit_exceeded'
    &&added[0]?.terminal==='succeeded'&&digest(s.reviewPackage)===digest(before.reviewPackage)
    &&s.receipt===null&&Array.isArray(s.currentChecks)&&s.currentChecks.length>0
    &&s.currentChecks.every(item=>item.outcome==='passed'&&(item.kind==='visual'||item.exitCode===0))
    &&reviewMaterialLimitReason(s.reason)){
    const recovered=structuredClone(s);
    const detail=(s.reason??'review material exceeded its bounded size').replace(/^limit_exceeded:\s*/, '');
    recovered.state='blocked';recovered.code='develop_package_too_large';
    recovered.reason=boundedReason('develop_package_too_large: ',[detail],
      '; shrink the changed files or move generated artifacts out of scope, then resume to redo this attempt');
    recovered.cache.at(-1).result=runnerStatus(recovered,config);
    return recovered;
  }
  // A42: since #160 a completion re-check whose check list (ids or commands)
  // or visual carriers differed from the reviewed package ended in a terminal
  // package_mismatch whose reason is the bare code; nothing else produced that
  // reason, and the reviewed code had matched. A retried complete re-verifies
  // everything. A reason naming changed paths, and the older no-reason shape
  // (it also covered a Learning handoff mismatch and pre-#160 code drift, so
  // the journal cannot prove it was only checks), stay terminal.
  if(effect.kind==='complete'&&s.state==='blocked'&&s.code==='package_mismatch'
    &&s.reason==='package_mismatch'&&s.taskCommit==null
    &&(before.state==='approved'||before.state==='blocked'
      &&[...COMPLETION_RETRY_CODES,'review_package_changed',COMPLETE_RECHECK_CODE].includes(before.code))){
    const recovered=structuredClone(s);
    recovered.code='completion_checks_changed';
    recovered.reason='completion_checks_changed: 旧版本把完成复查与审查包的检查清单或检查证据差异记成了 package_mismatch（代码未变）；发送 complete 按审查包的检查清单重新复查并完成。';
    recovered.cache.at(-1).result=runnerStatus(recovered,config);
    return recovered;
  }
  // Runners before the create-time scope gate dispatched a protected scope and
  // journaled the adapter's pre-dispatch refusal as unknown/execution_error,
  // with no exit. Reproject only that exact shape: one developer call that never
  // returned a result, nothing built, no Learning. The record stays unchanged.
  if(effect.kind==='develop'&&s.state==='unknown'&&s.code==='execution_error'
    &&protectedDevelopScope(config).length>0&&added.length===1&&added[0].terminal==='unknown'
    &&added[0].resultDigest===null&&digest(s.reviewPackage)===digest(before.reviewPackage)
    &&s.receipt===null&&s.receipts.length===before.receipts.length
    &&(!Object.hasOwn(config,'taskLearning')||s.learningResult===null)){
    const recovered=structuredClone(s);
    recovered.state='blocked';recovered.code='protected_scope';
    recovered.reason=protectedScopeBlockReason(protectedDevelopScope(config));
    recovered.cache.at(-1).result=runnerStatus(recovered,config);
    return recovered;
  }
  return structuredClone(s);
}

function completionConfig(config,version){
  shape(config,['root','identity','scope','requirements','excludedContexts','timeoutMs','developer','reviewers','completion',
    ...(version===3?['reviewInvocation']:[]),...(Object.hasOwn(config,'taskLearning')?['taskLearning']:[]),
    ...['bootstrap','codeProjectPaths','knowledgeCloseout','externalModels','executionPolicy'].filter(key=>Object.hasOwn(config,key))]);
  if(Object.hasOwn(config,'knowledgeCloseout'))readCloseoutPolicy(config.knowledgeCloseout);
  if(Object.hasOwn(config,'executionPolicy')){same(config.executionPolicy,readExecutionPolicy(config.executionPolicy));need(version===3,'execution_policy_runner_version');}
  if(Object.hasOwn(config,'externalModels')){same(config.externalModels,readExternalModels(config.externalModels));need(version===3,'external_model_runner_version');}
  if(Object.hasOwn(config,'codeProjectPaths')){
    same(config.codeProjectPaths,validateCodeProjectPaths(config.codeProjectPaths));
    assertCodeProjectSelections(config.codeProjectPaths,[...config.scope,...config.requirements]);
  }
  if(Object.hasOwn(config,'bootstrap')){
    need(config.taskLearning?.feature===config.bootstrap.feature
      &&config.bootstrap.feature===identifyApprovedBootstrapFeature([config.bootstrap.feature]),'bootstrap_task_required');
    same(config.bootstrap.identity,config.identity);same(config.bootstrap.scope,config.scope);
    need(config.bootstrap.codeProject===config.root,'bootstrap_binding_changed');
  }
  // V1 gets these data constraints from createTaskRunner before reading history.
  // The new standalone V2 reader must enforce them before exposing initial state.
  validIdentity(config.identity);need(config.identity.attempt===1);
  validCallTimeout(config.timeoutMs);
  need(Array.isArray(config.excludedContexts)&&config.excludedContexts.length>0);config.excludedContexts.forEach(id);
  shape(config.developer,['provider','requestedModel','contextId']);
  id(config.developer.contextId);text(config.developer.requestedModel);need(['codex','claude'].includes(config.developer.provider));
  need(Array.isArray(config.reviewers)&&config.reviewers.length<=2);
  const used=new Set([...config.excludedContexts,config.developer.contextId]),ids=new Set();
  for(const r of config.reviewers){
    shape(r,['id','provider','requestedModel','allowed','available','contexts',...(version===3?['adapterId']:[])]);id(r.id);need(!ids.has(r.id));ids.add(r.id);
    text(r.requestedModel);need(['codex','claude'].includes(r.provider)&&typeof r.allowed==='boolean'&&typeof r.available==='boolean');
    if(version===3)id(r.adapterId);
    need(Array.isArray(r.contexts)&&r.contexts.length===2);
    for(const c of r.contexts){id(c);need(!used.has(c),'not_independent');used.add(c);}
  }
  const c=config.completion;shape(c,['version','mode','owner','fingerprints','reviewsDir','handoffs']);
  need(c.version===1&&c.mode==='fixture-task','runner_completion');
  shape(c.owner,['tasksPath','feature','specsRoot']);shape(c.fingerprints,['workflow','config','inputs']);
  Object.values(c.fingerprints).forEach(hex);text(c.owner.feature);
  const absolute=p=>need(typeof p==='string'&&!p.includes('\0')&&path.isAbsolute(p)&&path.resolve(p)===p,'runner_completion');
  [config.root,c.owner.tasksPath,c.owner.specsRoot,c.reviewsDir].forEach(absolute);
  need(c.owner.tasksPath.startsWith(c.owner.specsRoot+path.sep),'runner_completion');
  if(Object.hasOwn(config,'taskLearning')){
    shape(config.taskLearning,['feature',...(Object.hasOwn(config.taskLearning,'hostHandoff')?['hostHandoff']:[])]);
    text(config.taskLearning.feature);
    if(Object.hasOwn(config.taskLearning,'hostHandoff'))need(config.taskLearning.hostHandoff===true,'runner_learning');
  }
  reviewSpecsPath(config.root,c.owner.specsRoot);
  need([path.join(c.owner.specsRoot,'.reviews'),path.join(path.dirname(c.owner.tasksPath),'.reviews')].includes(c.reviewsDir),'runner_completion');
  need(Array.isArray(c.handoffs)&&c.handoffs.length===2&&c.handoffs[0]!==c.handoffs[1],'runner_completion');
  for(const p of c.handoffs){absolute(p);need(path.dirname(p)===c.reviewsDir,'runner_completion');}
  if(version===3){
    need(config.reviewers.length===1&&['codex','claude'].includes(config.reviewers[0].provider)
      &&config.reviewers[0].allowed&&config.reviewers[0].available,'runner_invocation');
    const v=config.reviewInvocation;shape(v,['developerThreadId','excludedThreadIds']);id(v.developerThreadId);
    need(Array.isArray(v.excludedThreadIds)&&v.excludedThreadIds.length>0&&v.excludedThreadIds.length<=32,'runner_invocation');
    const actual=new Set([v.developerThreadId]);for(const item of v.excludedThreadIds){id(item);need(!actual.has(item),'runner_invocation');actual.add(item);}
  }
  return c;
}
const workerSummary=w=>({journal:w.journal===true,spawned:w.spawning!==null,started:w.started,
  applies:w.applies.map(item=>({started:item.started}))});
// What a redo, interruption or void record names when the host proved every
// started writer's process group gone: the provider worker and each sandbox
// subprocess that applied a protected proposal (the exact develop-worker
// records it checked). null: nothing was started, so there is nothing to prove.
export const workerGoneBinding=summary=>{
  const worker=summary?.started??null,applies=(summary?.applies??[]).filter(item=>item.started).map(item=>item.started);
  if(worker===null&&!applies.length)return null;
  return {worker:worker&&{recordDigest:worker.digest,pid:worker.pid},
    applies:applies.map(item=>({recordDigest:item.digest,pid:item.pid})),verdict:'gone'};
};
// Every writer the journal shows as about to start also journaled its pid.
// A pending effect with a spawning record and no pid is unprovable.
const writersComplete=w=>(w.spawning===null||w.started!==null)&&w.applies.every(item=>item.started!==null);
const bindingMatches=(p,expected)=>expected===null?!Object.hasOwn(p,'worker')
  :Object.hasOwn(p,'worker')&&digest(p.worker)===digest(expected);
// R2: an interrupted step of the same kind is retired at most this many times
// per run; afterwards abandon_effect only voids the run (effect-abandoned).
export const MAX_EFFECT_INTERRUPTIONS=2;
export const EFFECT_INTERRUPT_LIMIT_CODE='effect_interrupt_limit';
export const effectInterruptLimitReason=kind=>`${EFFECT_INTERRUPT_LIMIT_CODE}: 宿主中途退出后在原运行内恢复 ${kind} 已用满 ${MAX_EFFECT_INTERRUPTIONS} 次。`
  +'先查清宿主为何反复中断；确认旧宿主与写入方已退出后，abandon_effect 只能作废本运行（effect-abandoned），再用 --supersede-reviewed-evidence 新建运行。';
function fullEnvelope(r,index,previousDigest){
  shape(r,['version','seq','id','kind','payload','previousDigest','digest']);hex(r.digest);
  need(r.version===1&&r.seq===index+1&&r.previousDigest===previousDigest,'runner_chain');
  const {digest:recordDigest,...body}=r;need(recordDigest===digest(body),'runner_chain');
}
export function readRunnerHistory(raw,config,version=1) {
  need([1,2,3].includes(version),'runner_version');
  if(version>=2)config=json(config,LIMIT);
  const records=json(raw,LIMIT);need(Array.isArray(records) && records.length>0,'runner_missing');
  need(records[0]?.payload?.version===version,'runner_version');
  const completion=version>=2?completionConfig(config,version):null;
  let original,session,state,pending=null,beforeIntent=null,controlCount=0,controls={},completeIntentDigest=null,transaction=null;
  let invocation={registration:null,started:null,result:null};let registrationRecord=null,startedRecord=null,resultRecord=null,lastReview=null;
  const acceptedFixes=[],joinedHosts=[],reviewerThreads=[];let qaAttachment=null,qaRevision=null,joinedForInvocation=false,supersession=null;
  const answerGaps={developRecheck:0,completeRecheck:0,developRedo:0,developDispatch:0,documentationSync:0,reviewRedispatch:{1:0,2:0}};
  // Q16: documentation-sync-started records by digest, and the pending develop's.
  const documentationRecords=new Map();let pendingDocumentation=null,documentationStop=null;
  // V8/V9: interrupted intents (their ids are never reused) and the provider
  // worker records of the pending develop and of every checkpointed develop.
  const interrupted=[],workers={};let pendingWorker=null;
  const reviewConfig=(calls=[])=>({...config,reviewInvocation:{...config.reviewInvocation,
    excludedThreadIds:reviewExclusions({excludedThreadIds:[...config.reviewInvocation.excludedThreadIds,...joinedHosts]},
      calls,config.developer.contextId)}});
  const reconciliationBinding=()=>({effectId:lastReview.effect.id,invocationId:lastReview.request.invocationId,
    registeredDigest:lastReview.registrationRecord.digest,startedDigest:lastReview.startedRecord?.digest??null,
    resultDigest:lastReview.resultRecord.digest});
  // A pending effect that effect-interrupted may retire: no task-commit-intent,
  // not cancelled, a review never registered, and after the intent only the
  // records its kind may leave behind (controls, a join, worker records).
  // Q16: the documentation start a pending develop belongs to. Its own once
  // documentation_sync was asked; before that (a documentation-only redo whose
  // host died between its intent and its new start record) the start of the
  // failure the redo was confirmed for, which the intent's prior state names.
  const documentationOrigin=()=>{
    if(pending?.kind!=='develop')return null;
    if(pendingDocumentation!==null)return pendingDocumentation;
    if(beforeIntent?.state!=='blocked'||!DOCUMENTATION_SYNC_CODES.includes(beforeIntent.code))return null;
    const digest=beforeIntent.calls.at(-1)?.documentationSync,payload=documentationRecords.get(digest);
    return payload===undefined?null:{digest,payload};
  };
  const pendingInterruptible=(effect,intentIndex,end)=>version===3&&!(config.externalModels||config.executionPolicy)
    &&effect!==null&&Object.hasOwn(INTERRUPTIBLE_TRAILERS,effect.kind)&&transaction===null&&state.taskCommit?.intentDigest==null
    &&!controls.cancelled&&!controls.workflowError&&(effect.kind!=='review'||!invocation.registration)
    &&interrupted.filter(item=>item.kind===effect.kind).length<MAX_EFFECT_INTERRUPTIONS
    // Q16: one that died during documentation_sync is a documentation retry and
    // shares that cap; once spent, abandon_effect only voids the run.
    &&(documentationOrigin()===null||answerGaps.documentationSync<MAX_DOCUMENTATION_SYNC_RETRIES)
    &&records.slice(intentIndex+1,end).every(row=>INTERRUPTIBLE_TRAILERS[effect.kind].includes(row.payload.type));
  // A pending develop whose only trailers are controls and worker records may
  // still be voided (effect-abandoned) once the interruption cap is spent.
  const pendingWorkerVoidable=(effect,intentIndex,end)=>version===3&&!(config.externalModels||config.executionPolicy)
    &&effect?.kind==='develop'&&transaction===null&&state.taskCommit?.intentDigest==null
    &&records.slice(intentIndex+1,end).some(row=>row.payload.type==='develop-worker')
    &&records.slice(intentIndex+1,end).every(row=>['control','develop-worker'].includes(row.payload.type));
  const roundRedispatches=()=>reviewRedispatchCount(state.cache,state.calls,state.attempt,
    config.reviewers[0].contexts[state.attempt-1],answerGaps.reviewRedispatch[state.attempt]);
  const pendingReviewExhausted=()=>pending?.kind==='review'&&invocation.registration!==null
    &&(invocation.result===null||invocation.result.outcome!=='observed')&&roundRedispatches()>=MAX_REVIEW_REDISPATCHES;
  // A38: a pending review whose result reached the journal but whose checkpoint
  // did not, and the result is a no-verdict end the operator could abandon.
  const pendingResultAbandonable=()=>!(config.externalModels||config.executionPolicy)&&version===3&&pending?.kind==='review'
    &&invocation.registration!==null&&invocation.result!==null&&invocation.result.outcome!=='observed'
    &&!controls.cancelled&&!controls.workflowError
    &&(abandonableReviewOutcome(invocation.result)||reviewRetryCode(invocation.result)!==null)
    &&roundRedispatches()<MAX_REVIEW_REDISPATCHES;
  for(const [index,r] of records.entries()) {
    if(index>0)need(records[index-1].payload.type!=='effect-abandoned','runner_abandon');
    boundRunnerRecord(r,index+1);
    if(version>=2)fullEnvelope(r,index,index?records[index-1].digest:null);
    need(r.id===`runner.${String(index+1).padStart(6,'0')}`,'runner_sequence');
    const p=r.payload;need(p.version===version && p.protocol==='cm-task-runner','runner_version');
    const common=['version','protocol','type'];
    if(index===0) {
      shape(p,[...common,'config','baseline','session']);need(p.type==='init' && r.kind==='result','runner_init');
      same(p.config,config);session=p.session;uuid(session);original=readReviewBaseline(p.baseline);
      const reviewScope=Object.hasOwn(config,'taskLearning')&&!config.scope.includes('AGENTS.md')
        ?[...config.scope,'AGENTS.md']:[...config.scope];
      same(original.identity,config.identity);same(original.scope,reviewScope.sort());same(original.requirements,[...config.requirements].sort());
      same(original.codeProjectPaths??null,config.codeProjectPaths??null);
      same(original.bootstrapRequirements??null,config.bootstrap?.bootstrapRequirements??null);
      if(Object.hasOwn(original,'specification')){
        need(completion&&config.taskLearning,'runner_package');
        same(original.specificationRoot,completion.owner.specsRoot);
        same(original.specification.feature,config.taskLearning.feature);
      }
      same(original.specsPath??null,completion?reviewSpecsPath(config.root,completion.owner.specsRoot):null);
      same(original.rootDigest,digestRoot(config.root));state=initialRunnerState(config,session,version);continue;
    }
    if(version===3&&p.type==='specification-rebound') {
      // An explicit rebind never changes runner state; it only lets the bound
      // material verify against re-approved sources (specification-material.mjs).
      shape(p,[...common,'record']);
      need(r.kind==='result'&&pending===null&&Object.hasOwn(original,'specification')
        &&['develop','review','complete'].some(kind=>stageAllowed(kind,state.state,state.code,state.priorReview?.verdict)),
      'spec_rebind_invalid');
      readSpecificationRebind(p.record,{taskId:config.identity.taskId,boundDigest:digest(original.specification)});
    } else if(version===3&&p.type==='evidence-superseded') {
      shape(p,[...common,'record']);
      need(r.kind==='result'&&index===1&&pending===null&&state.state==='ready'&&supersession===null,'supersede_record_invalid');
      supersession=readEvidenceSupersession(p.record,{feature:config.taskLearning.feature,
        taskId:config.identity.taskId,newRunId:config.identity.runId});
    } else if(version===3&&p.type==='bootstrap-review-recovered') {
      shape(p,[...common,'fromDigest','reviewPackage','reason','at']);
      need(r.kind==='result'&&p.fromDigest===records[index-1].digest
        &&bootstrapReviewRecoverable(state,pending,config.bootstrap),'bootstrap_review_recovery_unavailable');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'bootstrap_review_recovery_unavailable');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,
        'bootstrap_review_recovery_unavailable');
      packageLink(p.reviewPackage,original,state.attempt,state.currentChecks);
      validateTaskLearningReviewPackage(p.reviewPackage,state.learningResult.writeback,
        state.cache.at(-1).effect.learningInput,state.learningResult.bootstrap,config.bootstrap);
      state.reviewPackage=readReviewPackage(p.reviewPackage);
      state.state='awaiting_review';state.code=null;state.reason=null;
    } else if(p.type==='effect-intent') {
      shape(p,[...common,'effect',...(Object.hasOwn(p,'workerJournal')?['workerJournal']:[])]);need(r.kind==='intent' && pending===null,'runner_intent');
      const e=p.effect;shape(e,['version','id','identity','kind',...(Object.hasOwn(e,'learningInput')?['learningInput']:[])]);
      validIdentity(e.identity);id(e.id);
      // The marker says this runtime journals the provider worker's identity
      // (develop-worker) for this effect; only provider development carries it.
      // Current-session development carries it when protected proposals are
      // applied by a sandbox subprocess (apply records only).
      if(Object.hasOwn(p,'workerJournal'))need(version===3&&p.workerJournal===true&&e.kind==='develop','runner_worker');
      need(!interrupted.some(item=>item.effectId===e.id),'runner_cache');
      pendingWorker={journal:p.workerJournal===true,spawning:null,started:null,applies:[]};
      if(e.kind==='develop'&&Object.hasOwn(config,'taskLearning'))need(Object.hasOwn(e,'learningInput'),'runner_learning');
      if(Object.hasOwn(e,'learningInput')){need(e.kind==='develop'&&Object.hasOwn(config,'taskLearning'),'runner_learning');
        validTaskLearningInput(e.learningInput,e.identity,config.taskLearning.feature);}
      same(e.identity,{...config.identity,attempt:state.attempt});need(e.version===1 && stageAllowed(e.kind,state.state,state.code,state.priorReview?.verdict),'runner_stage');
      need(!(e.kind==='review'&&reviewNotDispatchedExhausted(state)),'runner_stage');
      need(effectSlotFree(e.kind,state.cache,state.calls) && !state.cache.some(c=>c.effect.id===e.id),'runner_cache');
      pending=e;beforeIntent=structuredClone(state);controls={};completeIntentDigest=e.kind==='complete'?r.digest:null;pendingDocumentation=null;documentationStop=null;
      invocation={registration:null,started:null,result:null};registrationRecord=null;startedRecord=null;resultRecord=null;
      joinedForInvocation=false;lastReview=null;
    } else if(version===3&&p.type==='host-joined') {
      shape(p,[...common,'hostContextId']);id(p.hostContextId);
      // Only one join in a pending review effect, before registration. A crash
      // after this record is a valid unknown prefix; opening never adds a join.
      need(r.kind==='result'&&pending?.kind==='review'&&!invocation.registration&&!joinedForInvocation
        &&!controls.cancelled&&!controls.workflowError,'runner_invocation');
      need(![config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds,
        ...joinedHosts].includes(p.hostContextId),'runner_invocation');
      need(![config.developer.contextId,...config.reviewers.flatMap(r=>r.contexts),...reviewerThreads]
        .includes(p.hostContextId),'not_independent');
      need(joinedHosts.length<MAX_AI_JOINED_HOSTS,'host_limit');
      joinedHosts.push(p.hostContextId);joinedForInvocation=true;
    } else if(version===3&&p.type==='review-invocation-registered') {
      need(r.kind==='intent'&&pending?.kind==='review'&&!invocation.registration,'runner_invocation');
      invocation.registration=readRegistration(p,beforeIntent,pending,reviewConfig(),session,supersession?.carriedReview??null);
      registrationRecord=r;
    } else if(version===3&&p.type==='review-invocation-started') {
      need(r.kind==='result'&&invocation.registration&&!invocation.started&&!invocation.result,'runner_invocation');
      invocation.started=readStarted(p,invocation.registration,pending,reviewConfig(beforeIntent.calls));
      startedRecord=r;
      reviewerThreads.push(invocation.started);
    } else if(version===3&&p.type==='review-invocation-result') {
      need(r.kind==='result'&&invocation.registration&&!invocation.result,'runner_invocation');
      invocation.result=readInvocationResult(p,invocation.registration,invocation.started,pending,reviewConfig(beforeIntent.calls));
      if(invocation.result.outcome==='cancelled')need(controls.cancelled===true,'runner_control');
      resultRecord=r;
    } else if(version===3&&['review-invocation-receipt','review-invocation-reconciled'].includes(p.type)) {
      const bindingKeys=['effectId','invocationId','registeredDigest','startedDigest','resultDigest'];
      shape(p,[...common,...bindingKeys,...(p.type==='review-invocation-receipt'?['receipt']:['receiptDigest','checkpoint'])]);
      need((config.externalModels||config.executionPolicy)&&r.kind==='result'&&pending===null&&lastReview!==null
        &&(state.state==='unknown'&&lastReview.invocation.result.reconciliationRequired===true
          ||state.state==='pending_review'&&reviewTransportTimeout(lastReview.invocation.result))
        &&lastReview.invocation.result.inspection!==null&&lastReview.invocation.started!==null,
      'review_reconciliation_unavailable');
      same(Object.fromEntries(bindingKeys.map(key=>[key,p[key]])),reconciliationBinding());
      if(p.type==='review-invocation-receipt'){
        need(!lastReview.reconciliation,'review_reconciliation_duplicate');
        const receipt=readReconciliationReceipt(p.receipt);
        prefix(lastReview.invocation.result.observation.events,receipt.events);
        const observation={version:1,kind:'cm-provider-review-observation',requestDigest:lastReview.request.requestDigest,
          events:receipt.events,result:receipt.result};
        const inspection=inspectProviderReviewReconciliation(JSON.stringify(observation),JSON.stringify({request:lastReview.request,
          developerThreadId:config.reviewInvocation.developerThreadId,
          excludedThreadIds:reviewConfig(lastReview.before.calls).reviewInvocation.excludedThreadIds}));
        need(inspection.providerThreadId===lastReview.invocation.started,'review_reconciliation_binding');
        const result={dispatchAt:lastReview.invocation.result.dispatchAt,
          outcome:inspection.observationStatus==='completed'?'observed':'failed',observation,inspection,reconciliationRequired:false};
        lastReview.reconciliation={receiptDigest:r.digest,result};
      }else{
        need(lastReview.reconciliation?.receiptDigest===p.receiptDigest,'review_reconciliation_evidence_required');
        state=checkpoint(lastReview.before,p.checkpoint,lastReview.effect,config,original,session,lastReview.controls,version,
          state.taskCommit??null,{...lastReview.invocation,result:lastReview.reconciliation.result},supersession?.carriedReview??null);
        lastReview=null;
      }
    } else if(version===3&&p.type==='develop-retry-limit') {
      // Terminal: written instead of a develop intent when no delivery can still
      // be reviewed. Every field is recomputed from the replayed state.
      shape(p,[...common,'fromState','fromCode','countedCalls','countedEffects']);
      const used=developBudget(state);
      need(r.kind==='result'&&pending===null&&developBudgetExhausted(state)&&p.fromState===state.state
        &&p.fromCode===state.code&&p.countedCalls===used.calls&&p.countedEffects===used.effects,'runner_retry_limit');
      state.state='blocked';state.code='develop_retry_limit';
      state.reason=developRetryLimitReason(p);lastReview=null;
    } else if(version===3&&p.type==='develop-answer-retry') {
      // Written by advance for a current-session answer the host rejected as
      // invalid; replay re-derives the whole condition from the journal.
      shape(p,[...common,'effectId','invocationId']);
      need(r.kind==='result'&&pending===null&&state.code==='failed'&&developAnswerRetryable(state,config.bootstrap)
        &&p.effectId===state.cache.at(-1).effect.id&&p.invocationId===state.calls.at(-1).invocationId,'runner_develop_answer');
      state.code='develop_answer_invalid';state.reason=developAnswerInvalidReason(state.calls.at(-1).failureResult);lastReview=null;
    } else if(version===3&&p.type==='develop-timeout-retry') {
      // Written by advance after it found the code root unchanged since the
      // timed-out develop started; replay re-derives everything but the disk.
      shape(p,[...common,'effectId','invocationId','basis']);
      const basis=developTimeoutBasis(state,config.bootstrap);
      need(r.kind==='result'&&pending===null&&state.state==='unknown'&&basis!==null&&p.basis===basis
        &&p.effectId===state.cache.at(-1).effect.id&&p.invocationId===state.calls.at(-1).invocationId,'runner_develop_timeout');
      state.state='blocked';state.code='develop_call_timeout';state.reason=DEVELOP_CALL_TIMEOUT_REASON;lastReview=null;
    } else if(version===3&&p.type==='develop-recheck') {
      // Written by advance for a delivered develop whose later checks never got
      // a usable answer; everything is re-derived from the replayed journal.
      shape(p,[...common,'effectId','invocationId','code']);
      const code=developRecheckCode(state,config,answerGaps.developRecheck);
      need(r.kind==='result'&&pending===null&&state.state==='unknown'&&code!==null&&p.code===code
        &&p.effectId===state.cache.at(-1).effect.id&&p.invocationId===state.calls.at(-1).invocationId,'runner_develop_recheck');
      answerGaps.developRecheck++;
      state.state='blocked';state.code=code;state.reason=developRecheckReason(code,state.cache.at(-1).result.code,state.cache.at(-1).result.reason);lastReview=null;
    } else if(version===3&&p.type==='develop-answer-redo') {
      // The operator confirmed the session stopped writing (R3); the redo itself
      // is the next develop intent. Re-derived from the journal, never the disk.
      const cause=developRedoCause(state,config,answerGaps.developRedo,workers);
      need(r.kind==='result'&&pending===null&&cause!==null&&p.cause===cause
        &&p.effectId===state.cache.at(-1).effect.id&&p.invocationId===state.calls.at(-1).invocationId,'runner_develop_redo');
      // Every started provider writer must have been proven gone by the host;
      // a Claude proposal also needs the live root at the round start (basis).
      const provider=cause.startsWith('provider_');
      shape(p,[...common,'effectId','invocationId','cause','reason','at',...['worker','basis'].filter(key=>Object.hasOwn(p,key))]);
      need(bindingMatches(p,provider?workerGoneBinding(workers[p.effectId]):null),'runner_develop_redo');
      if(provider&&config.developer.provider==='claude')need(p.basis!=null&&p.basis===redoDevelopStart(state),'runner_develop_redo');
      else need(!Object.hasOwn(p,'basis'),'runner_develop_redo');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_develop_redo');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_develop_redo');
      answerGaps.developRedo++;
      state.state='blocked';state.code=DEVELOP_REDO_CODE;state.reason=developRedoReason(cause);lastReview=null;
    } else if(version===3&&p.type==='develop-dispatch-retry') {
      // Written by advance when the develop failed before dispatch; a legacy
      // execution_error is admitted only on a journal-pinned start (the live
      // host compared the code root with it before writing this record).
      shape(p,[...common,'effectId','invocationId','basis']);
      const basis=developDispatchBasis(state,config,answerGaps.developDispatch);
      need(r.kind==='result'&&pending===null&&state.state==='unknown'&&basis!==null&&p.basis===basis
        &&p.effectId===state.cache.at(-1).effect.id&&p.invocationId===state.calls.at(-1).invocationId,'runner_develop_dispatch');
      answerGaps.developDispatch++;
      state.reason=developDispatchReason(state.code);
      state.state='blocked';state.code=DISPATCH_RETRY_CODE;lastReview=null;
    } else if(version===3&&p.type==='documentation-sync-started') {
      // Q16: written by the final task's develop right before it asks
      // documentation_sync: the developer answer it already accepted and the
      // documentation start. Bound to the pending develop's own developer call.
      shape(p,[...common,'effectId','invocationId','result','effectiveModel','documents','othersDigest']);
      need(r.kind==='result'&&pending?.kind==='develop'&&p.effectId===pending.id&&pendingDocumentation===null
        &&!config.bootstrap&&p.invocationId===`${session}.${beforeIntent.calls.length+1}`
        &&!controls.cancelled&&!controls.workflowError,'runner_documentation');
      text(p.effectiveModel);hex(p.othersDigest);json(p.result,256*1024);
      need(p.result!==null&&typeof p.result==='object'&&!Array.isArray(p.result),'runner_documentation');
      validDocumentationStates(p.documents,config.scope);
      // A documentation-only redo carries exactly the answer its source journaled.
      if(beforeIntent.state==='blocked'&&DOCUMENTATION_SYNC_CODES.includes(beforeIntent.code)){
        const source=documentationRecords.get(beforeIntent.calls.at(-1)?.documentationSync);
        need(source&&digest(source.result)===digest(p.result)&&source.effectiveModel===p.effectiveModel
          &&digest(source.documents.map(item=>item.path))===digest(p.documents.map(item=>item.path)),'runner_documentation');
      }
      pendingDocumentation={digest:r.digest,payload:p};documentationRecords.set(r.digest,p);
    } else if(version===3&&p.type==='documentation-sync-retry') {
      // Q16/Q17 (R3): develop_redo's stop confirmation for one failed
      // documentation_sync, bound to its developer call and start record, with
      // the documentation paths as they were at the confirmation. From the
      // checkpointed failure (unknown) it spends one of the run's retries; from
      // an already confirmed block (a re-confirmation after the operator's own
      // edits) it only replaces the confirmed documentation state.
      shape(p,[...common,'effectId','invocationId','startDigest','code','documents','reason','at']);
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_documentation_retry');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_documentation_retry');
      need(r.kind==='result'&&pending===null,'runner_documentation_retry');
      const call=state.calls.at(-1),start=documentationRecords.get(call?.documentationSync);
      need(start!==undefined&&p.invocationId===call.invocationId&&p.startDigest===call.documentationSync,'runner_documentation_retry');
      validDocumentationStates(p.documents,config.scope);
      same(p.documents.map(item=>item.path),start.documents.map(item=>item.path));
      if(state.state==='unknown'){
        const code=documentationSyncRetryCode(state,config,answerGaps.documentationSync);
        need(code!==null&&p.code===code&&p.effectId===state.cache.at(-1).effect.id,'runner_documentation_retry');
        answerGaps.documentationSync++;
        documentationStop={effectId:p.effectId,invocationId:p.invocationId,startDigest:p.startDigest,
          detail:state.cache.at(-1).result.reason??null};
      }else need(state.state==='blocked'&&DOCUMENTATION_SYNC_CODES.includes(state.code)&&p.code===state.code
        &&documentationStop!==null&&p.effectId===documentationStop.effectId&&p.invocationId===documentationStop.invocationId
        &&p.startDigest===documentationStop.startDigest,'runner_documentation_retry');
      state.state='blocked';state.code=p.code;state.reason=documentationSyncRetryReason(p.code,documentationStop.detail);lastReview=null;
    } else if(version===3&&p.type==='complete-recheck') {
      shape(p,[...common,'effectId','source']);
      need(r.kind==='result'&&pending===null&&state.state==='unknown'&&completeRecheckable(state,answerGaps.completeRecheck)
        &&p.effectId===state.cache.at(-1).effect.id&&p.source===state.code,'runner_complete_recheck');
      answerGaps.completeRecheck++;
      state.state='blocked';state.code=COMPLETE_RECHECK_CODE;state.reason=completeRecheckReason(p.source);lastReview=null;
    } else if(version===3&&p.type==='review-redispatch') {
      // V5 (A34): written by abandon_review from this round's spent retryable
      // review block while the round has a no-result redispatch left: the
      // operator confirmed (reason) the original call's reviewer stopped. The
      // redispatch itself is the next review intent. Re-derived from the journal.
      need(!(config.externalModels||config.executionPolicy),'external_review_reconciliation_required');
      shape(p,[...common,'effectId','invocationId','attempt','code','reason','at']);
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_review_redispatch');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_review_redispatch');
      const contextId=config.reviewers[0].contexts[state.attempt-1];
      need(r.kind==='result'&&pending===null&&p.attempt===state.attempt
        &&reviewRedispatchable(state,contextId,answerGaps.reviewRedispatch[state.attempt])
        &&p.code===state.code&&p.effectId===state.cache.at(-1).effect.id
        &&p.invocationId===state.reviewInvocation.registration.grant.invocationId,'runner_review_redispatch');
      answerGaps.reviewRedispatch[state.attempt]++;
      state.state='pending_review';lastReview=null;
    } else if(version===3&&p.type==='completion-retry-limit') {
      // Terminal: written instead of a complete intent once the re-check bound
      // is spent. Every field is recomputed from the replayed state.
      shape(p,[...common,'fromCode','completionBlocks']);
      need(r.kind==='result'&&pending===null&&completionRetriesExhausted(state)&&p.fromCode===state.code
        &&p.completionBlocks===completionBlockCount(state.cache),'runner_retry_limit');
      state.state='blocked';state.code='completion_retry_limit';state.reason=completionRetryLimitReason(p);lastReview=null;
    } else if(version===3&&p.type==='review-invocation-abandoned'&&Object.hasOwn(p,'resultDigest')&&pending===null) {
      need(!(config.externalModels||config.executionPolicy),'external_review_reconciliation_required');
      // Abandoning a checkpointed review whose journaled result was never accepted.
      shape(p,[...common,'effectId','invocationId','registeredDigest','startedDigest','resultDigest','reason','at']);
      need(r.kind==='result'&&pending===null&&lastReview!==null
        &&abandonableReviewResult(state,config.reviewers[0].contexts[state.attempt-1],answerGaps.reviewRedispatch[state.attempt]),'runner_abandon');
      need(p.effectId===lastReview.effect.id&&state.cache.at(-1).effect.id===lastReview.effect.id
        &&p.invocationId===lastReview.request.invocationId&&p.registeredDigest===lastReview.registrationRecord.digest
        &&p.startedDigest===(lastReview.startedRecord?.digest??null)&&p.resultDigest===lastReview.resultRecord.digest,'runner_abandon');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_abandon');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_abandon');
      const call=state.calls.find(item=>item.invocationId===p.invocationId);
      need(call?.terminal==='unknown'&&call.channel==='host-authorized','runner_abandon');
      // The invocation keeps its slot and its result digest; only its terminal
      // records the operator's exit, which also marks the attempt's retry spent.
      call.terminal='abandoned';
      state.state='pending_review';state.code='review_abandoned';
      state.reviewInvocation={registration:state.reviewInvocation.registration,started:state.reviewInvocation.started,
        result:{outcome:'abandoned',reason:p.reason,at:p.at,recordDigest:r.digest}};
      lastReview=null;
    } else if(version===3&&p.type==='review-invocation-abandoned') {
      need(!(config.externalModels||config.executionPolicy),'external_review_reconciliation_required');
      // A38: a pending review whose no-verdict result reached the journal right
      // before the host died (no checkpoint) is abandoned like a pending one,
      // bound to that result record, which must be the record just before.
      const withResult=Object.hasOwn(p,'resultDigest');
      shape(p,[...common,'effectId','invocationId','registeredDigest','startedDigest',...(withResult?['resultDigest']:[]),'reason','at']);
      need(r.kind==='result'&&pending?.kind==='review'&&invocation.registration
        &&(withResult?pendingResultAbandonable()&&records[index-1]===resultRecord&&p.resultDigest===resultRecord.digest:!invocation.result)
        &&!controls.cancelled&&!controls.workflowError
        // A redispatch's intent was issued from pending_review (V5: up to two per round).
        &&(state.state==='awaiting_review'||state.state==='pending_review'&&REVIEW_RETRY_CODES.includes(state.code)),'runner_abandon');
      need(p.effectId===pending.id&&p.invocationId===invocation.registration.request.invocationId
        &&p.registeredDigest===registrationRecord.digest
        &&p.startedDigest===(startedRecord?.digest??null),'runner_abandon');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_abandon');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_abandon');
      need(roundRedispatches()<MAX_REVIEW_REDISPATCHES,'runner_abandon_budget');
      const request=invocation.registration.request;
      state.calls.push({invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
        requestedModel:request.requestedModel,effectiveModel:'unknown',channel:'host-authorized',
        started:startedRecord!==null,terminal:'abandoned',requestDigest:request.requestDigest,
        resultDigest:r.digest,providerThreadId:invocation.started});
      state.sequence++;
      state.state='pending_review';state.code='review_abandoned';
      state.reviewInvocation={registration:invocation.registration.record,started:invocation.started,
        result:{outcome:'abandoned',reason:p.reason,at:p.at,recordDigest:r.digest}};
      pending=null;beforeIntent=null;invocation={registration:null,started:null,result:null};
    } else if(version===3&&p.type==='develop-worker') {
      // V9: the writers of the pending develop, journaled by the host right
      // before (…spawning) and right after (…started: pid = process group,
      // start time) each spawns: the provider worker once, and each sandbox
      // subprocess that applies a protected proposal (one per root, at most
      // MAX_CODE_PROJECTS). Bound to the
      // develop's invocation; never after a cancel or workflow error.
      const started=['started','apply_started'].includes(p.phase);
      shape(p,[...common,'effectId','invocationId','phase',...(started?['pid','startTime']:[])]);
      need(r.kind==='result'&&pending?.kind==='develop'&&p.effectId===pending.id&&pendingWorker?.journal===true
        &&p.invocationId===`${session}.${beforeIntent.calls.length+1}`&&!controls.cancelled&&!controls.workflowError,'runner_worker');
      if(started)need(validWorkerPid(p.pid)&&validStartTime(p.startTime),'runner_worker');
      const identity={digest:r.digest,pid:p.pid,startTime:p.startTime};
      const provider=config.developer.requestedModel!=='current-session',open=pendingWorker.applies.at(-1);
      if(p.phase==='spawning'){need(provider&&pendingWorker.spawning===null&&!pendingWorker.applies.length,'runner_worker');pendingWorker.spawning=r.digest;}
      else if(p.phase==='started'){need(provider&&pendingWorker.spawning!==null&&pendingWorker.started===null&&!pendingWorker.applies.length,'runner_worker');pendingWorker.started=identity;}
      else if(p.phase==='apply_spawning'){need((!open||open.started!==null)&&pendingWorker.applies.length<MAX_CODE_PROJECTS,'runner_worker');pendingWorker.applies.push({started:null});}
      else{need(p.phase==='apply_started'&&open&&open.started===null,'runner_worker');open.started=identity;}
    } else if(version===3&&p.type==='effect-interrupted') {
      need(!(config.externalModels||config.executionPolicy),'external_review_reconciliation_required');
      shape(p,[...common,'effectId','effectKind','intentDigest','lastRecordDigest','reason','at',
        ...['basis','worker','startDigest','documents'].filter(key=>Object.hasOwn(p,key))]);
      const intentIndex=records.slice(0,index).findLastIndex(row=>row.payload.type==='effect-intent');
      // Q16: a develop that died during documentation_sync names its start record
      // and the documentation paths as they were when the operator confirmed
      // the old host and session stopped (this record); exactly then.
      const origin=documentationOrigin(),documentationInterrupted=origin!==null;
      need(documentationInterrupted===Object.hasOwn(p,'startDigest')&&documentationInterrupted===Object.hasOwn(p,'documents'),'runner_interrupt');
      if(documentationInterrupted){
        need(p.startDigest===origin.digest,'runner_interrupt');
        validDocumentationStates(p.documents,config.scope);
        same(p.documents.map(item=>item.path),origin.payload.documents.map(item=>item.path));
      }
      need(r.kind==='result'&&pending&&intentIndex>=0&&pendingInterruptible(pending,intentIndex,index),'runner_interrupt');
      need(p.effectId===pending.id&&p.effectKind===pending.kind&&p.intentDigest===records[intentIndex].digest
        &&p.lastRecordDigest===records[index-1].digest,'runner_interrupt');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_interrupt');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_interrupt');
      const provider=config.developer.requestedModel!=='current-session';
      if(pending.kind==='develop'){
        // A provider worker that may have started is retired only with the
        // host's proof that its process group is gone; no record, no proof.
        if(provider)need(pendingWorker.journal===true,'runner_interrupt');
        need(writersComplete(pendingWorker)&&bindingMatches(p,workerGoneBinding(pendingWorker)),'runner_interrupt');
        // basis: the live host proved the code root still equals the pinned round
        // start where every write is an applied proposal (protected current-session
        // development, Claude provider development): a partial apply is restored
        // by a person first, never sent to review as a new delivery (V6).
        const proposalApply=provider&&config.developer.provider==='claude';
        if(proposalApply)need(p.basis!=null&&p.basis===pendingDevelopStart(state),'runner_interrupt');
        else if(Object.hasOwn(p,'basis'))need(!provider&&p.basis===pendingDevelopStart(state),'runner_interrupt');
        const request=requestFor({invocationId:`${session}.${state.calls.length+1}`,identity:{...config.identity,attempt:state.attempt},
          role:'developer',provider:config.developer.provider,requestedModel:config.developer.requestedModel,
          contextId:config.developer.contextId,payload:{scope:config.scope,
            requirements:original.files.filter(f=>config.requirements.includes(f.path)),priorReview:state.priorReview,
            ...supersededReviewPayload(supersession?.carriedReview??null,state.attempt),
            ...(Object.hasOwn(original,'specification')?{specification:original.specification}:{}),
            ...(Object.hasOwn(pending,'learningInput')?{learningInput:pending.learningInput}:{})}});
        state.calls.push({invocationId:request.invocationId,contextId:config.developer.contextId,provider:config.developer.provider,
          requestedModel:config.developer.requestedModel,effectiveModel:'unknown',channel:'fixture',started:true,
          terminal:'abandoned',requestDigest:request.requestDigest,resultDigest:r.digest,
          ...(documentationInterrupted?{documentationSync:origin.digest}:{})});
        state.sequence++;
        if(documentationInterrupted){
          // The developer had answered (journaled): redo only documentation_sync.
          answerGaps.documentationSync++;
          documentationStop={effectId:pending.id,invocationId:request.invocationId,startDigest:p.startDigest,detail:null};
          state.state='blocked';state.code=DOCUMENTATION_SYNC_INTERRUPTED_CODE;
          state.reason=documentationSyncRetryReason(DOCUMENTATION_SYNC_INTERRUPTED_CODE);
        }else{state.state='blocked';state.code=DEVELOP_INTERRUPTED_CODE;state.reason=developInterruptedReason(provider);}
      }else{
        need(!Object.hasOwn(p,'basis')&&!Object.hasOwn(p,'worker'),'runner_interrupt');
        if(pending.kind==='review'){state.state='awaiting_review';state.code=null;state.reason=REVIEW_INTERRUPTED_REASON;}
        else {state.state=beforeIntent.state;state.code=beforeIntent.code;state.reason=beforeIntent.reason??null;}
      }
      interrupted.push({effectId:pending.id,kind:pending.kind});
      pending=null;beforeIntent=null;invocation={registration:null,started:null,result:null};pendingWorker=null;pendingDocumentation=null;
      joinedForInvocation=false;lastReview=null;
    } else if(version===3&&p.type==='effect-abandoned') {
      need(!(config.externalModels||config.executionPolicy),'external_review_reconciliation_required');
      shape(p,[...common,'effectId','effectKind','intentDigest','reason','at',
        ...['lastRecordDigest','worker'].filter(key=>Object.hasOwn(p,key))]);
      let intentIndex=index-1;
      while(intentIndex>=0&&(records[intentIndex].payload.type==='control'
        ||pending?.kind==='develop'&&records[intentIndex].payload.type==='documentation-sync-started'))intentIndex--;
      // A36: a registered review whose no-result redispatches this round
      // (MAX_REVIEW_REDISPATCHES) are spent can no longer be abandoned with abandon_review. Voiding the run
      // (then superseding it) is its only exit; it must name the last record.
      const exhaustedReview=pendingReviewExhausted();
      const lastIntent=records.slice(0,index).findLastIndex(row=>row.payload.type==='effect-intent');
      // A develop with journaled writers is voided only with their gone-proof.
      const workerVoid=pendingWorkerVoidable(pending,lastIntent,index);
      if(exhaustedReview||workerVoid)intentIndex=lastIntent;
      if(workerVoid)need(writersComplete(pendingWorker)&&bindingMatches(p,workerGoneBinding(pendingWorker))
        &&Object.hasOwn(p,'lastRecordDigest'),'runner_abandon');
      else need(!Object.hasOwn(p,'worker'),'runner_abandon');
      const intent=records[intentIndex];
      need(r.kind==='result'&&pending&&['develop','complete','review'].includes(pending.kind)
        &&intent?.payload.type==='effect-intent'&&transaction===null
        &&state.taskCommit?.intentDigest==null,'runner_abandon');
      need(p.effectId===pending.id&&p.effectKind===pending.kind
        &&p.intentDigest===intent.digest
        &&(Object.hasOwn(p,'lastRecordDigest')
          ?p.lastRecordDigest===records[index-1].digest:intentIndex===index-1&&!exhaustedReview&&!workerVoid)
        &&(pending.kind!=='review'||!invocation.registration&&!joinedForInvocation||exhaustedReview),'runner_abandon');
      need(typeof p.reason==='string'&&p.reason.trim().length>0&&Buffer.byteLength(p.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(p.reason),'runner_abandon');
      need(typeof p.at==='string'&&Number.isFinite(Date.parse(p.at))&&new Date(p.at).toISOString()===p.at,'runner_abandon');
      state.state='cancelled';state.code='effect_abandoned';state.reason=p.reason;state.sequence++;
      pending=null;beforeIntent=null;
    } else if(p.type==='effect-checkpoint') {
      shape(p,[...common,'effectId','checkpoint']);need(r.kind==='result' && pending && p.effectId===pending.id,'runner_checkpoint');
      state=checkpoint(beforeIntent,p.checkpoint,pending,config,original,session,controls,version,state.taskCommit??null,invocation,
        supersession?.carriedReview??null,pendingDocumentation);pendingDocumentation=null;
      lastReview=version===3&&pending.kind==='review'&&invocation.result?{effect:pending,request:invocation.registration.request,
        registrationRecord,startedRecord,resultRecord,before:beforeIntent,controls,invocation}:null;
      if(pending.kind==='develop'&&pendingWorker?.journal)workers[pending.id]=workerSummary(pendingWorker);
      pending=null;beforeIntent=null;invocation={registration:null,started:null,result:null};pendingWorker=null;
    } else if(version>=2 && ['task-commit-intent','task-commit-result'].includes(p.type)){
      shape(p,[...common,'effectId','completeIntentDigest','commit']);
      need(pending?.kind==='complete'&&p.effectId===pending.id&&p.completeIntentDigest===completeIntentDigest&&!controls.cancelled,'runner_commit');
      if(p.type==='task-commit-intent'){
        need(r.kind==='commit-intent'&&transaction===null
          &&(beforeIntent.state==='approved'||beforeIntent.state==='blocked'
            &&['completion_checks_changed','completion_package_changed','review_package_changed',COMPLETE_RECHECK_CODE].includes(beforeIntent.code)),'runner_commit');
        const c=readCommitIntent(p.commit,{owner:completion.owner,identity:pending.identity,fingerprints:completion.fingerprints});
        const base=attemptBaseline(original,pending.identity.attempt),s=beforeIntent;
        checkCompletion({receipt:s.receipt,registered:s.receipts.find(x=>x.id===s.receipt?.id),
          execution:s.calls.find(x=>x.invocationId===s.receipt?.id),reviewPackage:s.reviewPackage,identity:pending.identity});
        same(c.proof,{root:config.root,baselineDigest:base.baselineDigest,packageDigest:s.reviewPackage.packageDigest,
          receiptDigest:s.receipt.receiptDigest,checksDigest:s.reviewPackage.checksDigest});
        need(c.plan.evidence.every(e=>path.dirname(e.path)===completion.reviewsDir)
          &&completion.handoffs.slice(0,pending.identity.attempt).every(h=>c.plan.evidence.some(e=>e.path===h)),'runner_commit_selectors');
        transaction={effectId:pending.id,completeIntentDigest,intentRecord:r,resultRecord:null};
        state.taskCommit={intentDigest:r.digest,planDigest:c.plan.planDigest,resultDigest:null,outcome:null};
      }else{
        need(r.kind==='commit-result'&&transaction&&transaction.resultRecord===null,'runner_commit');
        readCommitResult(p.commit,{intentDigest:transaction.intentRecord.digest,planDigest:state.taskCommit.planDigest});
        transaction.resultRecord=r;state.taskCommit={...state.taskCommit,resultDigest:r.digest,outcome:'fixture_committed'};
      }
    } else if(version===3&&p.type==='qa-attached') {
      shape(p,[...common,'record']);
      need(r.kind==='result'&&pending===null&&state.state==='fixture_completed','qa_attach_not_completed');
      need(qaRevision===null,'qa_revision_chain_invalid');
      need(qaAttachment===null,'qa_attachment_duplicate');qaAttachment=readQaAttachment(p.record);
    } else if(version===3&&p.type==='qa-config-revised') {
      shape(p,[...common,'record']);
      need(r.kind==='result'&&pending===null,'qa_revision_not_completed');
      const revision=readQaConfigRevision(p.record);
      // Before any QA round the revision may precede N5; it still never lands
      // inside an effect or after cancellation, and binds the current package.
      if(beforeFirstQaRound(revision))need(state.state!=='cancelled','qa_revision_not_completed');
      else need(state.state==='fixture_completed','qa_revision_not_completed');
      need(revision.packageDigest===(beforeFirstQaRound(revision)?state.reviewPackage?.packageDigest??null
        :state.reviewPackage.packageDigest)&&revision.taskAttempt===state.attempt,'package_mismatch');
      if(qaRevision)need(revision.fromFingerprint===qaRevision.toFingerprint
        &&revision.invariantDigest===qaRevision.invariantDigest
        &&revision.previousQaDigest===qaRevision.qaDigest&&qaRevisionFollows(revision,qaRevision),'qa_revision_chain_invalid');
      else need(revision.fromFingerprint===(qaAttachment?.qaFingerprint??completion.fingerprints.config),'qa_revision_chain_invalid');
      qaRevision=revision;
    } else if(version===3&&p.type==='qa-fix-accepted') {
      shape(p,[...common,'record']);need(r.kind==='result'&&pending===null&&state.state==='fixture_completed','fix_parent_not_completed');
      acceptedFixes.push(validateAcceptedFix({record:p.record,previous:acceptedFixes,
        baseline:attemptBaseline(original,state.attempt),parentPackage:state.reviewPackage,feature:config.taskLearning?.feature}));
    } else if(p.type==='control') {
      shape(p,[...common,'event']);need(r.kind==='cancel' && ++controlCount<=16,'runner_control');
      if(p.event==='late-cancel')need(state.state==='fixture_completed' || pending?.kind==='complete','runner_control');
      if(p.event==='cancel')need(state.state!=='fixture_completed','runner_control');
      if(version>=2&&p.event==='cancel')need(transaction===null,'runner_control');
      const next=controlledState(state,p.event,pending!==null,version);need(digest(next)!==digest(state),'runner_control');state=next;
      if(pending){if(p.event==='cancel')controls.cancelled=true;if(p.event==='late-cancel')controls.cancelAfterCommit=true;
        if(p.event==='workflow-error')controls.workflowError='workflow_error';}
    } else need(false,'runner_record');
  }
  if(pending){state.state='unknown';state.code='reconciliation_required';
    if(version===3&&invocation.registration)state.reviewInvocation={registration:invocation.registration.record,
      started:invocation.started,result:invocation.result};}
  const pendingAbandonable=!(config.externalModels||config.executionPolicy)&&version===3&&pending!==null
    &&['develop','complete','review'].includes(pending.kind)
    &&!transaction&&state.taskCommit?.intentDigest==null
    &&(pending.kind!=='review'||!invocation.registration&&!joinedForInvocation)
    &&records.slice(records.findLastIndex(row=>row.payload.type==='effect-intent')+1)
      .every(row=>row.payload.type==='control'||pending.kind==='develop'&&row.payload.type==='documentation-sync-started');
  const reviewResultAbandon=!(config.externalModels||config.executionPolicy)&&version===3&&pending===null&&lastReview!==null
    &&abandonableReviewResult(state,config.reviewers[0].contexts[state.attempt-1],answerGaps.reviewRedispatch[state.attempt])
    ?{effectId:lastReview.effect.id,invocationId:lastReview.request.invocationId,
      registeredDigest:lastReview.registrationRecord.digest,startedDigest:lastReview.startedRecord?.digest??null,
      resultDigest:lastReview.resultRecord.digest}:null;
  const lastIntentIndex=records.findLastIndex(row=>row.payload.type==='effect-intent');
  const interruptible=pending!==null&&pendingInterruptible(pending,lastIntentIndex,records.length);
  const interruptLimit=pending!==null&&!interruptible
    &&interrupted.filter(item=>item.kind===pending.kind).length>=MAX_EFFECT_INTERRUPTIONS;
  const workerVoidable=pending!==null&&pendingWorkerVoidable(pending,lastIntentIndex,records.length);
  return {original,session,state,pending,acceptedFixes,qaAttachment,answerGaps,
    ...(version===3?{joinedHosts,reviewerThreads,supersession,pendingAbandonable,reviewResultAbandon,
      interrupted,workers,pendingInterruptible:interruptible,pendingReviewExhausted:pendingReviewExhausted(),
      pendingResultAbandonable:pending!==null&&pendingResultAbandonable(),
      pendingInterruptLimit:interruptLimit,pendingWorkerVoidable:workerVoidable,
      pendingWorker:pending?.kind==='develop'&&pendingWorker?workerSummary(pendingWorker):null,
      pendingDocumentation:documentationOrigin(),
      reviewReconciliation:lastReview?.reconciliation&&['unknown','pending_review'].includes(state.state)?{...reconciliationBinding(),
        ...lastReview.reconciliation,request:lastReview.request,effect:lastReview.effect,before:lastReview.before}:null,
      pendingObservedReview:pending?.kind==='review'&&invocation.result?.outcome==='observed'
        ?{request:invocation.registration.request,registration:invocation.registration.record,
          started:invocation.started,result:invocation.result}:null}:{}),
    ...(version>=2?{transaction}:{})};
}
// R2: each answer-gap exit has two uses per run. Once spent, the same stuck shape
// is shown as an explicit limit block instead of falling back to an exit-less
// unknown/reconcile: its code names the spent exit and its reason names what is
// left (fix the root cause, then a superseding run). Derived from the journal
// on every read, never journaled itself, so replay shows the same block.
// A spent develop_dispatch_failed exit falls to the confirmed develop_redo, so it
// has no limit code of its own.
export const ANSWER_GAP_LIMIT_CODES=Object.freeze(['check_answer_retry_limit','complete_recheck_limit','develop_redo_limit',DOCUMENTATION_SYNC_LIMIT_CODE]);
const gapLimitReason=(code,what,source)=>`${code}: ${what}（原记录 ${source}）已在本运行用满 ${MAX_ANSWER_GAP_RETRIES} 次，不再自动重做。`
  +'先查清根因（会话为何一直不应答或答复不合格、宿主环境为何失败）；修好后用 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做，'
  +'本运行留在盘上的改动需还原，或加 --accept-superseded-code-drift 作为已有代码记录。';
export function answerGapLimit(s,config,gaps={}){
  if(!['unknown','blocked'].includes(s.state))return null;
  const source=`${s.state}/${s.code}`;
  if(s.state==='unknown'&&(gaps.developRecheck??0)>=MAX_ANSWER_GAP_RETRIES&&developRecheckCode(s,config,0)!==null)
    return {code:'check_answer_retry_limit',reason:gapLimitReason('check_answer_retry_limit','开发后的检查或验证预检重跑',source)};
  if(s.state==='unknown'&&(gaps.completeRecheck??0)>=MAX_ANSWER_GAP_RETRIES&&completeRecheckable(s,0))
    return {code:'complete_recheck_limit',reason:gapLimitReason('complete_recheck_limit','完成前复查重跑',source)};
  if(s.state==='unknown'&&(gaps.documentationSync??0)>=MAX_DOCUMENTATION_SYNC_RETRIES&&documentationSyncRetryCode(s,config,0)!==null)
    return {code:DOCUMENTATION_SYNC_LIMIT_CODE,reason:documentationSyncLimitReason(source)};
  if((gaps.developRedo??0)>=MAX_DEVELOP_REDOS&&developRedoCause(s,config,0,gaps.workers??null)!==null)
    return {code:'develop_redo_limit',reason:gapLimitReason('develop_redo_limit','确认停写后的开发重发',source)};
  return null;
}
// Q28: the status a host would show for a replayed journal, as far as the
// journal alone decides it. Drivers prepare answers from this (never from the
// raw replay state, which still reads unknown/call_timeout or blocked/failed
// for the retryable answer-gap blocks). Exits that also need a live disk check
// (#198 develop_call_timeout, a legacy pinned dispatch failure) are projected
// as available: preparing an answer that ends up unused is harmless, while a
// missing one ends a real redo in host_close. Exits that need an operator
// confirmation first (develop_redo) are not projected as retryable.
export function projectedRunnerStatus(history,config){
  const s=history.state,gaps=history.answerGaps??{};
  const project=code=>({...s,state:'blocked',code});
  if(s.state==='blocked'&&s.code==='failed'&&developAnswerRetryable(s,config.bootstrap))return project('develop_answer_invalid');
  if(s.state==='blocked'&&s.code==='failed'){const limit=answerGapLimit(s,config,gaps);
    return limit?{...s,state:'blocked',code:limit.code,reason:limit.reason}:s;}
  // V5: a spent retryable review block with a no-result redispatch left waits
  // for the operator's stop confirmation (abandon_review → review-redispatch);
  // a fully spent one is a limit.
  if(s.state==='blocked'&&!(config.externalModels||config.executionPolicy)&&Array.isArray(config.reviewers)){
    const contextId=config.reviewers[0].contexts[s.attempt-1],records=gaps.reviewRedispatch?.[s.attempt]??0;
    if(reviewRedispatchable(s,contextId,records))return {...s,reviewRedispatchStopRequired:true,reason:reviewRedispatchStopReason(s.code)};
    if(reviewRedispatchExhausted(s,contextId,records))return {...s,code:REVIEW_REDISPATCH_LIMIT_CODE,reason:reviewRedispatchLimitReason(s.code)};
  }
  if(reviewNotDispatchedExhausted(s))return {...s,state:'blocked',code:REVIEW_NOT_DISPATCHED_LIMIT_CODE,reason:reviewNotDispatchedLimitReason(s.code)};
  if(s.state!=='unknown')return s;
  const recheck=developRecheckCode(s,config,gaps.developRecheck??0);
  if(recheck!==null)return project(recheck);
  if(completeRecheckable(s,gaps.completeRecheck??0))return project(COMPLETE_RECHECK_CODE);
  // Q16/Q17: a failed documentation_sync needs the operator's stop
  // confirmation (develop_redo) first, so it is not projected as retryable.
  if(s.code==='call_timeout'&&developTimeoutBasis(s,config.bootstrap)!==null)return project('develop_call_timeout');
  if(developDispatchBasis(s,config,gaps.developDispatch??0)!==null)return project(DISPATCH_RETRY_CODE);
  const limit=answerGapLimit(s,config,gaps);
  return limit?{...s,state:'blocked',code:limit.code,reason:limit.reason}:s;
}
// Baseline rootDigest uses bytes of the canonical root, not JSON string encoding.
import {createHash} from 'node:crypto';
import {readQaAttachment} from './qa-attachment.mjs';
import {readEvidenceSupersession} from './reviewed-evidence-supersession-record.mjs';
import fs from 'node:fs';
const digestRoot=root=>createHash('sha256').update(fs.realpathSync(root)).digest('hex');
