// Fixed N6 decision adapter for the JS CM log authority through its platform lock adapter.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest,hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';
import {readQaAttachment} from './qa-attachment.mjs';
import {writeCmAiQaStatus} from './cm-ai-run-finalizer.mjs';
import {scanRows} from './log-rows.mjs';
import {QA_MAX_ROUNDS,qaRoundLimit,nonProductSupersession} from './qa-round-budget.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {beforeFirstQaRound,qaRevisionChain,readQaConfigRevision} from './qa-config-revision.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const MiB=1024*1024;

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);

export function recordCmAiQaAttachment({specsDir,codeProject,feature,identity,record,logHome}){
  record=readQaAttachment(record);validIdentity(identity);text(feature);
  const args=[writer,'--workflow','cm-ai','--event','decision','--phase','qa_attach','--runtime','codex',
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,'--at',record.attachedAt,
    '--detail','附加 N6 QA','--data-json',JSON.stringify({feature,task:identity.taskId,qaFingerprint:record.qaFingerprint})];
  let result;
  try{result=childProcess.spawnSync('python3',args,{timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL',
    ...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout),'qa_log_failed');
  return readResult(result.stdout,identity,specsDir);
}

export function readDecision(raw,identity,packageDigest) {
  const decision=json(raw);shape(decision,['decisionId','identity','packageDigest','status','reason','score','at']);
  id(decision.decisionId);validIdentity(decision.identity);hex(decision.packageDigest);
  need(sameIdentity(decision.identity,identity)&&decision.packageDigest===packageDigest,'qa_decision_mismatch');
  need(['triggered','skipped','blocked'].includes(decision.status));
  text(decision.reason);need(decision.reason.length<=200&&!/[\n\r\0]/.test(decision.reason));
  need(typeof decision.at==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(decision.at)
    &&Number.isFinite(Date.parse(decision.at)));
  if(decision.score!==null)need(Number.isInteger(decision.score)&&decision.score>=4&&decision.score<=20);
  if(decision.status==='skipped')need(Number.isInteger(decision.score)&&decision.score<=7);
  if(decision.status==='triggered'&&decision.score!==null)need(decision.score>=8);
  return json({...decision,at:decision.at.endsWith('Z')?`${decision.at.slice(0,-1)}+00:00`:decision.at});
}

export {scanRows} from './log-rows.mjs';

// Older hosts recorded a missed qa_assess answer window as a durable
// blocked/host_request_timeout decision. One explicit recovery may append a
// superseding decision linked by previous_decision_id; history is never
// rewritten and every reader consumes the last row of that two-row chain.
export const timedOutQaDecision=decision=>decision?.status==='blocked'&&decision.reason==='host_request_timeout';
export function effectiveQaDecisionRow(rows,code){
  if(rows.length===0)return null;
  need(rows.length<=2&&rows[0].previous_decision_id===undefined,code);
  if(rows.length===2)need(timedOutQaDecision(rows[0])&&rows[1].previous_decision_id===rows[0].decision_id
    &&rows[1].decision_id!==rows[0].decision_id,code);
  return rows.at(-1);
}

function existingDecision(specsDir,feature,identity,packageDigest,decision,previousDecisionId=null) {
  const log=path.join(path.resolve(specsDir),'运行日志.jsonl');
  if(!fs.existsSync(log)){need(previousDecisionId===null,'qa_decision_conflict');return false;}
  try {
    const matches=[];scanRows(log,row=>{if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
      &&row.repository_id===identity.repositoryId&&row.run_id===identity.runId&&row.feature===feature
      &&row.task===identity.taskId&&row.attempt===identity.attempt&&row.package_digest===packageDigest)matches.push(row);});
    if(matches.length===0){need(previousDecisionId===null,'qa_decision_conflict');return false;}
    const row=effectiveQaDecisionRow(matches,'qa_decision_conflict');
    if(row.decision_id===decision.decisionId){
      need(row.status===decision.status&&row.reason===decision.reason&&row.score===decision.score&&row.at===decision.at
        &&(row.previous_decision_id??null)===previousDecisionId,'qa_decision_conflict');
      return true;
    }
    // Only the single recorded timeout decision can be superseded, and once.
    need(previousDecisionId!==null&&matches.length===1&&row.decision_id===previousDecisionId
      &&timedOutQaDecision(row),'qa_decision_conflict');
    return false;
  } catch(error) {
    if(error?.code==='qa_decision_conflict')throw error;
    need(false,'qa_log_failed');
  }
}

function readResult(stdout,identity,specsDir) {
  try {
    const result=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout)),MiB);
    shape(result,['event_id','run_id','project_log','global_log','global_written','pointer_written','deduplicated','degraded']);
    id(result.event_id);need(result.run_id===identity.runId);text(result.project_log);text(result.global_log);
    need(path.resolve(result.project_log)===path.join(path.resolve(specsDir),'运行日志.jsonl'));
    need(typeof result.global_written==='boolean'&&(typeof result.pointer_written==='boolean'||result.pointer_written===null)
      &&typeof result.deduplicated==='boolean'&&typeof result.degraded==='boolean');
    return result;
  } catch {need(false,'qa_log_failed');}
}

export function recordCmAiQaDecision(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','decision'];
  if(input&&Object.hasOwn(input,'logHome'))keys.push('logHome');
  if(input&&Object.hasOwn(input,'previousDecisionId'))keys.push('previousDecisionId');
  shape(input,keys);text(input.specsDir);text(input.codeProject);text(input.feature);validIdentity(input.identity);
  hex(input.packageDigest);
  const previousDecisionId=input.previousDecisionId??null;if(previousDecisionId!==null)id(previousDecisionId);
  const decision=readDecision(input.decision,input.identity,input.packageDigest);
  if(existingDecision(input.specsDir,input.feature,input.identity,input.packageDigest,decision,previousDecisionId))return;
  const detail=(decision.status==='triggered'?`触发:${decision.reason}`:
    decision.status==='skipped'?`跳过:评分${decision.score}`:`阻塞:${decision.reason}`)
    +(previousDecisionId===null?'':`（重新评估，替代 ${previousDecisionId}）`);
  const data={node:'N6',feature:input.feature,task:input.identity.taskId,attempt:input.identity.attempt,
    repository_id:input.identity.repositoryId,package_digest:input.packageDigest,decision_id:decision.decisionId,
    status:decision.status,reason:decision.reason,score:decision.score,
    ...(previousDecisionId===null?{}:{previous_decision_id:previousDecisionId})};
  const args=[writer,'--workflow','cm-ai','--event','qa','--runtime','codex','--project-root',input.codeProject,
    '--specs-dir',input.specsDir,'--run-id',input.identity.runId,'--at',decision.at,'--detail',detail,
    '--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  if(decision.status==='skipped'&&decision.reason==='merged_to_feature_qa'){
    // N6 requires an explicit merge decision as well as the per-task QA row.
    // Write first: a crash may repeat this same idempotent log operation, never QA.
    const mergeArgs=[...args];mergeArgs[mergeArgs.indexOf('--event')+1]='decision';
    mergeArgs[mergeArgs.indexOf('--detail')+1]='合并至feature级QA';
    mergeArgs.push('--phase','qa_merge');
    let merged;
    try{merged=childProcess.spawnSync('python3',mergeArgs,options);}catch{need(false,'qa_log_failed');}
    need(!merged.error&&merged.status===0&&merged.signal===null&&Buffer.isBuffer(merged.stdout),'qa_log_failed');
    readResult(merged.stdout,input.identity,input.specsDir);
  }
  let result;
  try{result=childProcess.spawnSync('python3',args,options);}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout)
    &&result.stdout.length<=MiB,'qa_log_failed');
  return readResult(result.stdout,input.identity,input.specsDir);
}

function findDecisionRow(input) {
  shape(input,['specsDir','feature','identity','packageDigest']);
  text(input.specsDir);text(input.feature);validIdentity(input.identity);hex(input.packageDigest);
  const log=path.join(path.resolve(input.specsDir),'运行日志.jsonl');
  if(!fs.existsSync(log))return null;
  const matches=[];
  try {scanRows(log,row=>{if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
    &&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
    &&row.feature===input.feature&&row.task===input.identity.taskId&&row.attempt===input.identity.attempt
    &&row.package_digest===input.packageDigest)matches.push(row);});}
  catch{need(false,'context_not_ready');}
  if(matches.length===0)return null;
  const row=effectiveQaDecisionRow(matches,'context_not_ready');id(row.decision_id);
  need(['triggered','skipped','blocked'].includes(row.status),'context_not_ready');
  return row;
}

export function findCmAiQaDecision(input) {
  const row=findDecisionRow(input);if(row===null)return null;
  return readDecision({status:row.status,decisionId:row.decision_id,identity:input.identity,
    packageDigest:input.packageDigest,reason:row.reason,score:row.score,at:row.at},input.identity,input.packageDigest);
}

// True when the effective decision is the linked replacement of a timed-out
// decision (the durable effect of one explicit --rerun-blocked-qa recovery).
export function replacesTimedOutQaDecision(input) {
  return findDecisionRow(input)?.previous_decision_id!==undefined;
}

export function inspectCmAiQaDecision(input) {
  const row=findDecisionRow(input);need(row,'context_not_ready');
  return Object.freeze({status:row.status,decisionId:row.decision_id});
}

export function reportFile(specsDir,raw) {
  text(raw);need(!raw.includes('\0'),'qa_report_invalid');
  try {
    const specs=fs.realpathSync(specsDir),reviews=path.join(specs,'.reviews'),reviewsStat=fs.lstatSync(reviews);
    need(reviewsStat.isDirectory()&&!reviewsStat.isSymbolicLink(),'qa_report_invalid');
    const candidate=path.isAbsolute(raw)?path.resolve(raw):path.resolve(specs,raw);
    const lexical=path.relative(reviews,candidate);
    need(lexical.length>0&&!lexical.startsWith(`..${path.sep}`)&&!path.isAbsolute(lexical),'qa_report_invalid');
    const resolved=fs.realpathSync(candidate),relative=path.relative(fs.realpathSync(reviews),resolved),stat=fs.lstatSync(candidate);
    need(relative.length>0&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)
      &&stat.isFile()&&!stat.isSymbolicLink(),'qa_report_invalid');
    return resolved;
  } catch(error) {
    if(error?.code==='qa_report_invalid')throw error;
    need(false,'qa_report_invalid');
  }
}

function partialPassCases(items,code){
  need(!items.some(({row})=>row.phase==='complete'||row.phase==='case_blocked'
    ||(row.phase==='case_complete'&&row.result!=='PASS')),code);
  const cases=items.filter(({row})=>row.phase==='case_complete').map(({row})=>row.case_id);
  for(const caseId of cases)id(caseId);
  return [...new Set(cases)].sort();
}

// A call stopped by its whole-execution timeout (qa_execution_timeout) records
// no complete. When every recorded browser case is PASS or a BLOCKED whose host
// request timed out without a session answer, --rerun-unknown-qa may supersede
// it into the next round. Current executors mark each case_blocked row with
// host_request_timeout. Older rows lack the field, and nothing they recorded tells
// a missed answer from an answer downgraded to BLOCKED (cleanup failed, other
// environment) near the deadline: they count only with the full request window
// elapsed since case_start (log times are whole seconds) and an explicit operator
// attestation (--qa-environment-failure), recorded on the superseded row.
// A session-declared BLOCKED, any FAIL or other BLOCKED refuses.
// Q06/Q11: the same holds for a call stopped by a host death or a hard-invalid
// answer. Rows the session itself declared BLOCKED (host_declared_blocked), and
// rows the host judged BLOCKED for an evidence, environment or cleanup gap
// (blocked_reason, written by current executors), are host or answer problems
// too: they are listed as host_blocked_cases. An unresolved [需确认], a missing
// capability, a FAIL, or an older row that cannot tell still refuses.
const HOST_JUDGED_BLOCKED=['evidence','environment','cleanup'];
// context {specsDir,feature}: the approved test contract decides [需确认].
function timedOutCases(items,code,requestTimeoutMs,attestation=null,allowHostBlocked=false,context=null){
  need(attestation===null||validEnvironmentFailureReason(attestation),code);
  need(requestTimeoutMs===null||Number.isSafeInteger(requestTimeoutMs)&&requestTimeoutMs>0&&requestTimeoutMs<=3600000,code);
  need(!items.some(({row})=>['complete','abandoned','superseded'].includes(row.phase)
    ||(row.phase==='case_complete'&&row.result!=='PASS')),code);
  const started=new Map(),timedOut=[],hostBlocked=[];
  for(const {row} of items){
    if(row.phase==='case_start'){id(row.case_id);started.set(row.case_id,row.at);}
    if(row.phase!=='case_blocked')continue;
    id(row.case_id);need(row.result==='BLOCKED',code);
    if(row.host_declared_blocked===true||HOST_JUDGED_BLOCKED.includes(row.blocked_reason)){
      // An original FAIL the host downgraded, a row that does not keep the
      // session's verdict, and an unresolved [需确认] in the approved contract
      // refuse before any host-fault eligibility.
      need(allowHostBlocked&&context!==null&&['PASS','BLOCKED'].includes(row.answered_verdict)
        &&(row.host_declared_blocked!==true||row.answered_verdict==='BLOCKED')
        &&!['needs_confirmation','unavailable'].includes(row.blocked_reason),code);
      hostBlocked.push(row.case_id);continue;
    }
    if(Object.hasOwn(row,'host_request_timeout'))need(row.host_request_timeout===true,code);
    else{
      const elapsed=Date.parse(row.at)-Date.parse(started.get(row.case_id));
      need(requestTimeoutMs!==null&&Number.isFinite(elapsed)&&elapsed>=requestTimeoutMs-1000,code);
      need(attestation!==null,code==='qa_execution_unknown'?'qa_environment_failure_required':code);
    }
    timedOut.push(row.case_id);
  }
  need(timedOut.length+hostBlocked.length>0,code);
  if(hostBlocked.length){const contract=contractCases(context.specsDir,context.feature,code);
    for(const caseId of hostBlocked)need(!confirmationPending(contract.get(caseId)),code);}
  const passed=items.filter(({row})=>row.phase==='case_complete').map(({row})=>row.case_id);
  return {timedOut:[...new Set(timedOut)].sort(),hostBlocked:[...new Set(hostBlocked)].sort(),passed:[...new Set(passed)].sort()};
}

// host-check reports a command that produced no exit code as `unavailable`
// (timeout, kill, spawn or output transport): an environment outcome, not the
// product's answer. A real non-zero exit stays a product FAIL unless the
// operator explicitly declares, and the log records, an environment failure.
const UNAVAILABLE_COMMAND=/^host check: (?:timeout|signal_exit|spawn_failed|output_limit|output_read_failed|output_capture_failed|cleanup_failed)$/;
const unavailableCommand=row=>row?.kind==='commands'&&row.exitCode===null
  &&Array.isArray(row.evidence)&&UNAVAILABLE_COMMAND.test(row.evidence.at(-1));
const exitedCommand=row=>row?.kind==='commands'&&Number.isSafeInteger(row.exitCode)&&row.exitCode!==0;
export const validEnvironmentFailureReason=value=>typeof value==='string'&&value.trim().length>0
  &&Buffer.byteLength(value,'utf8')<=500&&!/[\r\n\0]/.test(value);

// The feature's test contract, the same file the executor plans from, is the
// authority for an unresolved [需确认] expectation; report markers only confirm it.
function contractCases(specsDir,feature,code){
  need(typeof feature==='string'&&/^\d+\.[A-Za-z0-9._-]+$/.test(feature),code);
  const source=path.join(path.resolve(specsDir),feature,'test-cases.json');
  if(!fs.existsSync(source))return new Map();
  try{
    const stat=fs.lstatSync(source);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MiB,code);
    const contract=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(source)));
    need(Array.isArray(contract?.cases),code);
    return new Map(contract.cases.map(item=>[item.id,item]));
  }catch{need(false,code);}
}
// A case missing from the contract counts as unresolved (fail closed).
const confirmationPending=item=>!Array.isArray(item?.expected)||item.expected.some(value=>String(value).includes('[需确认]'));
// The eligibility rule of released versions before recovery_rule 2. Superseded
// rows they wrote (no recovery_rule) are replayed with exactly this predicate.
// Rows without recovery_rule are exactly the pre-branch released format: the
// intermediate commits of this change are squash-merged and never reach users.
const legacyEligible=(row,environment)=>!row.sourceChanged&&(
  row.kind==='logic'&&row.staticVerdict==='INSUFFICIENT_EVIDENCE'
  ||row.kind==='browser'&&(typeof row.evidenceProblem==='string'&&row.evidenceProblem.length>0
    ||row.cleanup==='failed'||row.hostRequestTimeout===true
    ||environment!=null&&row.environment!=null&&digest(row.environment)!==digest(environment)));

// The executor's report format: one JSON row per `## {id}` section after the summary.
// deferred_cases and not_applicable (cases bound only to dropped tasks) are lists, not rows.
function readReportCases(text,code){
  return text.split(/^## /m).slice(1).flatMap(section=>{
    const split=section.indexOf('\n'),name=section.slice(0,split);
    const row=JSON.parse(section.slice(split+1));
    if(['deferred_cases','not_applicable'].includes(name)&&Array.isArray(row))return [];
    need(row.id===name&&['commands','logic','browser'].includes(row.kind),code);id(row.id);return [row];
  });
}
// A report row's PASS backed by authoritative inputs: a command's own zero exit,
// the durable browser case_complete PASS row, or a logic case the approved
// contract resolves whose mapped commands all exited 0 and that is not CONTRADICTED.
function passBacking(items,specsDir,feature,cases,code){
  const byId=new Map(cases.map(row=>[row.id,row])),contract=contractCases(specsDir,feature,code);
  const logged=new Map(items.filter(({row})=>['case_complete','case_blocked'].includes(row.phase))
    .map(({row})=>[row.case_id,row.phase==='case_blocked'?'BLOCKED':row.result]));
  const resolved=row=>!confirmationPending(contract.get(row.id))&&row.needsConfirmation!==true;
  const logicPass=row=>resolved(row)&&row.staticVerdict!=='CONTRADICTED'
    &&Array.isArray(row.commandEvidence)&&row.commandEvidence.length>0
    &&row.commandEvidence.every(item=>byId.get(item)?.kind==='commands'&&byId.get(item).exitCode===0);
  const backed=row=>row.kind==='commands'?row.exitCode===0:row.kind==='browser'?logged.get(row.id)==='PASS':logicPass(row);
  return {byId,logged,resolved,logicPass,backed};
}

// Read the executor's existing report format, including pre-recovery reports.
// Summary counts alone cannot distinguish product failures from host evidence gaps.
// incomplete: the call wrote its fixed report but no complete row (a pre-fix host
// rejected stale_qa in between). The report is then the only result; its counts
// stand in for the complete row and every other rule applies unchanged.
// verdictRule (recovery_rule 3): a browser BLOCKED counts as a host fault only
// when the durable case row keeps the session's own verdict (answered_verdict)
// and it was not a FAIL; rows without it (older format) are not recoverable here.
function recoverableCases(items,specsDir,environment,code='qa_rerun_not_blocked_by_evidence',environmentFailure=false,legacyRule=false,incomplete=false,verdictRule=false){
  const completes=items.filter(({row})=>row.phase==='complete'),start=items[0]?.row;
  need(completes.length===(incomplete?0:1)&&start?.phase==='start'&&!(incomplete&&(legacyRule||environmentFailure)),code);
  let complete=incomplete?null:completes[0].row;
  if(incomplete){
    const report=path.join(specsDir,'.reviews',`${start.operation_id}-execution.md`);
    complete={mode:start.mode,case_count:start.case_count,report,result:null,passed:null,failed:null,blocked:null};
  }
  let cases;
  try{
    const file=reportFile(specsDir,complete.report);need(fs.statSync(file).size<=MiB,code);
    const text=fs.readFileSync(file,'utf8');cases=readReportCases(text,code);
    if(incomplete){
      const count=verdict=>cases.filter(row=>row.verdict===verdict).length;
      Object.assign(complete,{passed:count('PASS'),failed:count('FAIL'),blocked:count('BLOCKED')});
      complete.result=complete.failed>0?'FAIL':complete.blocked>0?'BLOCKED':'PASS';
      need(new RegExp(`^Overall: ${complete.result}$`,'m').test(text),code);
    }
  }catch{need(false,code);}
  need((environmentFailure?complete.result==='FAIL'&&complete.failed>0
      :complete.result==='BLOCKED'&&complete.failed===0&&complete.blocked>0)
    &&complete.mode===start.mode&&complete.case_count===start.case_count
    &&['case_count','passed','failed','blocked'].every(key=>Number.isSafeInteger(complete[key])&&complete[key]>=0)
    &&complete.passed+complete.failed+complete.blocked===start.case_count
    &&!items.some(({row})=>row.phase==='case_complete'&&row.result!=='PASS'),code);
  need(cases.length===start.case_count&&new Set(cases.map(row=>row.id)).size===cases.length
    &&cases.filter(row=>row.verdict==='PASS').length===complete.passed
    &&cases.filter(row=>row.verdict==='FAIL').length===complete.failed
    &&cases.filter(row=>row.verdict==='BLOCKED').length===complete.blocked,code);
  const byId=new Map(cases.map(row=>[row.id,row]));
  const mapped=(row,test)=>Array.isArray(row.commandEvidence)&&row.commandEvidence.some(item=>test(byId.get(item)));
  const blocked=cases.filter(row=>row.verdict==='BLOCKED'),failed=cases.filter(row=>row.verdict==='FAIL');
  if(legacyRule){for(const row of blocked)need(legacyEligible(row,environment),code);return {blocked:blocked.map(row=>row.id).sort(),failed:[]};}
  // A case may be rerun only if the approved contract has no unresolved
  // [需确认] expectation for it; the report marker must not say otherwise.
  const {logged,resolved,logicPass,backed}=passBacking(items,specsDir,start.feature,cases,code);
  // Without a complete row the report's own counts are the result: every PASS
  // it claims must be backed by the authoritative inputs as well.
  if(incomplete)for(const row of cases.filter(row=>row.verdict==='PASS'))need(backed(row),code);
  // A host-declared BLOCKED is proven by the durable case_blocked log row the
  // executor appended when the session answered, not by the mutable report.
  const declaredInLog=new Set(items.filter(({row})=>row.phase==='case_blocked'&&row.host_declared_blocked===true)
    .map(({row})=>row.case_id));
  const blockedRows=new Map(items.filter(({row})=>row.phase==='case_blocked').map(({row})=>[row.case_id,row]));
  // An original FAIL the host downgraded, a missing capability and an unresolved
  // [需确认] refuse before any host-fault eligibility.
  const sessionVerdictOk=row=>{
    if(!verdictRule)return true;
    const logged=blockedRows.get(row.id);
    if(!logged||['needs_confirmation','unavailable'].includes(logged.blocked_reason))return false;
    if(row.hostRequestTimeout===true&&logged.host_request_timeout===true&&!Object.hasOwn(logged,'answered_verdict'))return true;
    return ['PASS','BLOCKED'].includes(logged.answered_verdict)
      &&(logged.answered_verdict!=='BLOCKED'||logged.host_declared_blocked===true);
  };
  const eligible=row=>(
    row.kind==='logic'&&resolved(row)&&(row.staticVerdict==='INSUFFICIENT_EVIDENCE'
      // Blocked only by a mapped command without exit code, derived from the
      // recorded command rows; the executor's marker has to agree.
      ||row.staticVerdict==='SUPPORTED'&&mapped(row,unavailableCommand)&&row.commandUnavailable===true)
    ||row.kind==='browser'&&resolved(row)&&sessionVerdictOk(row)&&(typeof row.evidenceProblem==='string'&&row.evidenceProblem.length>0
      ||row.cleanup==='failed'||row.hostRequestTimeout===true||declaredInLog.has(row.id)&&row.hostDeclaredBlocked===true
      ||environment!=null&&row.environment!=null&&digest(row.environment)!==digest(environment))
    ||unavailableCommand(row));
  // A row BLOCKED only because the source changed during execution is recovered
  // by what it was before the change: PASS, or a BLOCKED that is itself
  // recoverable. A FAIL, or a verdict that cannot be told, stays non-recoverable.
  // Reports written before verdictBeforeSourceChange existed are read from the
  // command's own exit code and the durable browser case row; logic fails closed.
  // The report is mutable, so a recorded verdictBeforeSourceChange must agree with
  // what the command's exit code, the durable browser case row or the mapped
  // commands of a logic case show; any disagreement is treated as unknown.
  const before=row=>{
    const claimed=Object.hasOwn(row,'verdictBeforeSourceChange')?row.verdictBeforeSourceChange:undefined;
    const derived=row.kind==='commands'?(row.exitCode===0?'PASS':unavailableCommand(row)?'BLOCKED':exitedCommand(row)?'FAIL':null)
      :row.kind==='browser'?logged.get(row.id)??null
      :claimed==='PASS'?(logicPass(row)?'PASS':null):['BLOCKED','FAIL'].includes(claimed)?claimed:null;
    return claimed===undefined||claimed===derived?derived:null;
  };
  for(const row of blocked)need(row.sourceChanged===true?(before(row)==='PASS'||before(row)==='BLOCKED'&&eligible(row))
    :eligible(row),code);
  // Only declared (otherwise failed is empty): every failure must be a command
  // exit, or a logic case failed by such a mapped command. Browser and
  // CONTRADICTED failures never are.
  for(const row of failed)need(exitedCommand(row)
    ||row.kind==='logic'&&row.staticVerdict!=='CONTRADICTED'&&mapped(row,exitedCommand),code);
  return {blocked:blocked.map(row=>row.id).sort(),failed:failed.map(row=>row.id).sort()};
}

// Supersession is authorized by the owner journal, never a self-reported log digest.
function validateConfigurationSupersession(row,specsDir,code){
  const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:row.repository_id,runId:row.run_id}});
  const {revisions}=qaRevisionChain(snapshot);
  const record=revisions.find(r=>digest(r)===row.qa_revision_digest),config=snapshot.records[0]?.payload?.config;
  need(record&&record.testRunId===row.operation_id&&record.qaRound===row.attempt
    &&record.packageDigest===row.package_digest&&config?.identity?.taskId===row.task&&config?.taskLearning?.feature===row.feature,code);
}

// Abandonment reuses a round; superseded completed evidence advances it.
function validateRunSequence(items,code='qa_round_invalid',specsDir){
  const starts=[],ids=new Set();let current=null,abandoned=false,superseded=false,freed=0;
  for(const item of items){
    const row=item.row;
    if(row.phase==='start'){
      id(row.operation_id);need(!ids.has(row.operation_id),code);ids.add(row.operation_id);
      need(row.attempt===(current?current.attempt+(abandoned?0:1):1)&&row.attempt<=qaRoundLimit(freed),code);
      if(abandoned){
        // Legacy successors retain their plan; explicit links may bind a fresh plan.
        if(row.previous_test_run_id===undefined)need(row.mode===current.mode&&row.case_count===current.case_count,code);
        else need(row.previous_test_run_id===current.operation_id,code);
      }else if(superseded)need(row.previous_test_run_id===current.operation_id,code);
      else {
        need(row.previous_test_run_id===undefined,code);
        if(current)need(!items.some(entry=>entry.position<item.position&&entry.row.operation_id===current.operation_id
          &&entry.row.phase==='complete'&&['BLOCKED','NEEDS_MANUAL'].includes(entry.row.result)),code);
      }
      current=row;abandoned=false;superseded=false;starts.push(item);
    }else{
      need(current&&row.operation_id===current.operation_id&&row.attempt===current.attempt&&!abandoned&&!superseded,code);
      if(row.phase==='superseded'){
        need(current.attempt<qaRoundLimit(freed+(nonProductSupersession(row.reason)?1:0))&&row.previous_test_run_id===current.operation_id
          &&row.mode===current.mode&&row.case_count===current.case_count,code);
        const prior=items.filter(entry=>entry.position<item.position&&entry.row.operation_id===row.operation_id);
        if(row.reason==='qa_configuration_revision'){
          need(prior.filter(entry=>entry.row.phase==='complete').length===1,code);
          validateConfigurationSupersession(row,specsDir,code);
        }else if(row.reason==='host_request_timeout'){
          // Rows before host_blocked_cases existed could list no such case.
          const cases=timedOutCases(prior,code,row.request_timeout_ms??null,row.legacy_timeout_attestation??null,
            Object.hasOwn(row,'host_blocked_cases'),{specsDir,feature:row.feature});
          need(row.request_timeout_ms!==null&&JSON.stringify(row.timed_out_cases)===JSON.stringify(cases.timedOut)
            &&JSON.stringify(row.host_blocked_cases??[])===JSON.stringify(cases.hostBlocked)
            &&(!Object.hasOwn(row,'host_blocked_cases')||cases.hostBlocked.length>0)
            &&JSON.stringify(row.partial_pass_cases)===JSON.stringify(cases.passed),code);
        }else{
          const declared=row.reason==='declared_environment_failure';
          need(declared?validEnvironmentFailureReason(row.environment_failure_reason):row.reason==='host_evidence_problem',code);
          // Rows without recovery_rule were written by released versions before
          // this change (the pre-branch format) under the original rule.
          const legacy=row.recovery_rule===undefined;need(legacy||[2,3].includes(row.recovery_rule),code);
          // incomplete_report: the superseded call had a fixed report but no complete row.
          const incomplete=row.incomplete_report===true;
          need(row.incomplete_report===undefined||incomplete&&!legacy&&!declared
            &&!prior.some(entry=>entry.row.phase==='complete'),code);
          const cases=recoverableCases(prior,specsDir,row.expected_environment,code,declared,legacy,incomplete,row.recovery_rule===3);
          need(JSON.stringify(row.blocked_cases)===JSON.stringify(cases.blocked)
            &&(declared?JSON.stringify(row.failed_cases)===JSON.stringify(cases.failed):row.failed_cases===undefined),code);
        }
        if(nonProductSupersession(row.reason))freed++;
        superseded=true;
      }
      if(row.phase==='abandoned'){
        need(row.previous_test_run_id===current.operation_id&&row.reason==='host_terminated'
          &&row.mode===current.mode&&row.case_count===current.case_count,code);
        const prior=items.filter(entry=>entry.position<item.position&&entry.row.operation_id===row.operation_id);
        const passed=partialPassCases(prior,code);
        // Step 26 records omitted this field and could only abandon empty runs.
        need(JSON.stringify(row.partial_pass_cases===undefined?[]:row.partial_pass_cases)===JSON.stringify(passed)
          &&(row.partial_pass_cases!==undefined||passed.length===0),code);
        abandoned=true;
      }
    }
  }
  need(starts.length>0,code);starts.freed=freed;return starts;
}

function qaRunRows(input){
  const decision=findCmAiQaDecision(input);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];let position=0;
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    const index=position++;
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run'
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push({row,position:index});
  });
  return rows;
}

// Only a trusted resumed owner calls this after fresh explicit authorization.
// Retain unknown for non-PASS results, even if their evidence files vanished.
export function inspectCmAiQaRecovery(input,{blocked=false,environment=null,environmentFailure=null,timedOut=false,requestTimeoutMs=null,attestation=null}={}){
  const rows=qaRunRows(input),starts=validateRunSequence(rows,'qa_round_invalid',input.specsDir),start=starts.at(-1).row;
  const runs=rows.filter(item=>item.row.operation_id===start.operation_id);
  // Reject an operation ID reused under another decision, identity or package.
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row.event==='test_run'&&row.operation_id===start.operation_id)
      need(rows.some(item=>JSON.stringify(item.row)===JSON.stringify(row)),'qa_result_mismatch');
  });
  if(blocked){
    // After a crash between superseded and start, the recorded row decides
    // whether this was a declared environment failure; the flag is not re-read.
    const recorded=runs.find(({row})=>row.phase==='superseded')?.row;
    const declared=recorded?recorded.reason==='declared_environment_failure':environmentFailure!==null;
    const prior=runs.filter(({row})=>row.phase!=='superseded');
    const incomplete=recorded?recorded.incomplete_report===true:!prior.some(({row})=>row.phase==='complete');
    // A fresh supersession is written under recovery_rule 3; a recorded row keeps its own rule.
    const cases=recoverableCases(prior,input.specsDir,environment,'qa_rerun_not_blocked_by_evidence',declared,
      recorded!==undefined&&recorded.recovery_rule===undefined,incomplete,recorded===undefined||recorded.recovery_rule===3);
    // A recorded supersession is already counted in starts.freed.
    need(start.attempt<qaRoundLimit(starts.freed+(recorded===undefined&&!declared?1:0)),'qa_round_invalid');
    return {testRunId:start.operation_id,qaRound:start.attempt,mode:start.mode,caseCount:start.case_count,
      blockedCases:cases.blocked,failedCases:cases.failed,superseded:recorded!==undefined,incompleteReport:incomplete};
  }
  const report=path.join(input.specsDir,'.reviews',`${start.operation_id}-execution.md`);
  let exists=false;try{fs.lstatSync(report);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(timedOut){
    // After a crash between superseded and start, the recorded row decides.
    const recorded=runs.find(({row})=>row.phase==='superseded')?.row;
    need(recorded===undefined?!exists:recorded.reason==='host_request_timeout','qa_execution_unknown');
    const timeout=recorded?recorded.request_timeout_ms??null:requestTimeoutMs;
    const attested=recorded?recorded.legacy_timeout_attestation??null:attestation;
    const cases=timedOutCases(runs.filter(({row})=>row.phase!=='superseded'),'qa_execution_unknown',timeout,attested,
      recorded===undefined||Object.hasOwn(recorded,'host_blocked_cases'),{specsDir:input.specsDir,feature:start.feature});
    need(start.attempt<qaRoundLimit(starts.freed+(recorded===undefined?1:0)),'qa_round_invalid');
    return {testRunId:start.operation_id,qaRound:start.attempt,mode:start.mode,caseCount:start.case_count,
      timedOutCases:cases.timedOut,hostBlockedCases:cases.hostBlocked,partialPassCases:cases.passed,
      requestTimeoutMs:timeout,attestation:attested,superseded:recorded!==undefined};
  }
  const passed=partialPassCases(runs,'qa_execution_unknown');
  // A report without complete is an unconfirmed result: a host that found the run
  // stale after an all-PASS execution records no complete. Only that all-PASS,
  // fully backed report may be discarded and rerun; anything else stays unknown.
  if(exists)try{
    const text=fs.readFileSync(reportFile(input.specsDir,report),'utf8'),cases=readReportCases(text,'qa_execution_unknown');
    const {backed}=passBacking(runs,input.specsDir,start.feature,cases,'qa_execution_unknown');
    need(/^Overall: PASS$/m.test(text)&&cases.length===start.case_count&&new Set(cases.map(row=>row.id)).size===cases.length
      &&cases.every(row=>row.verdict==='PASS'&&backed(row)),'qa_execution_unknown');
  }catch{need(false,'qa_execution_unknown');}
  return {testRunId:start.operation_id,qaRound:start.attempt,mode:start.mode,caseCount:start.case_count,
    partialPassCases:passed,abandoned:runs.some(({row})=>row.phase==='abandoned')};
}

// Discover the latest invocation from the authoritative log, never a second checkpoint.
export function latestCmAiQaRun(input) {
  const decision=findCmAiQaDecision(input);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];
  try{scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run'
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push(row);
  });}catch{need(false,'qa_result_invalid');}
  if(rows.length===0)return null;
  const starts=rows.filter(row=>row.phase==='start');need(starts.length>0,'qa_result_invalid');
  const testRunId=starts.at(-1).operation_id;id(testRunId);
  return {testRunId,...inspectCmAiQaResult({...input,testRunId})};
}

// Configuration revision consumes another round. Unknown in-flight QA must be
// reconciled separately; changing its configuration is not cancellation proof.
export function inspectCmAiQaRevisionTarget({specsDir,feature,identity,packageDigest}){
  const input={specsDir,feature,identity,packageDigest};
  latestCmAiQaRun(input);
  const rows=qaRunRows(input),starts=validateRunSequence(rows,'qa_round_invalid',input.specsDir),start=starts.at(-1).row;
  need(start.attempt<3,'qa_round_invalid');
  need(!rows.some(({row})=>row.operation_id===start.operation_id&&['superseded','abandoned'].includes(row.phase)),'qa_revision_pending');
  return {testRunId:start.operation_id,qaRound:start.attempt,mode:start.mode,caseCount:start.case_count};
}

export function inspectCmAiQaConfigurationRecovery(input){
  const rows=qaRunRows(input);
  if(rows.at(-1)?.row.reason!=='qa_configuration_revision'||rows.at(-1)?.row.phase!=='superseded')return null;
  validateRunSequence(rows,'qa_round_invalid',input.specsDir);
  const row=rows.at(-1).row;
  return {testRunId:row.operation_id,qaRound:row.attempt,mode:row.mode,caseCount:row.case_count,superseded:true};
}

// Log positions of this run's first N6 test_run row (under any decision,
// package or attempt: a QA round has started) and of one revision mirror row.
function preRoundPositions({specsDir,feature,identity},revisionDigest=null){
  text(specsDir);text(feature);validIdentity(identity);
  const log=path.join(path.resolve(specsDir),'运行日志.jsonl');
  let position=0,firstRun=null,mirror=null;
  if(fs.existsSync(log))scanRows(log,row=>{const index=position++;
    if(row?.workflow!=='cm-ai'||row.run_id!==identity.runId||row.repository_id!==identity.repositoryId)return;
    if(firstRun===null&&row.event==='test_run'&&row.node==='N6'&&row.feature===feature&&row.task===identity.taskId)firstRun=index;
    if(mirror===null&&revisionDigest!==null&&row.event==='decision'&&row.phase==='qa_config_revise'
      &&row.qa_revision_digest===revisionDigest)mirror=index;});
  return {firstRun,mirror};
}
export const hasCmAiQaRun=input=>preRoundPositions(input).firstRun!==null;

// The owner journal authorizes the change; this deterministic row is its audit
// mirror, written before any QA round. A journal-only crash is repaired only
// while no round exists, and a mirror after a round fails closed on every open.
function recordPreRoundRevision(input,record){
  const {specsDir,codeProject,feature,identity}=input,revisionDigest=digest(record);
  const {firstRun,mirror}=preRoundPositions(input,revisionDigest);
  need(firstRun===null||mirror!==null&&mirror<firstRun,'qa_revision_invalid');
  if(mirror!==null)return;
  const data={node:'N6',feature,task:identity.taskId,attempt:identity.attempt,repository_id:identity.repositoryId,
    package_digest:record.packageDigest,qa_revision_digest:revisionDigest,from_fingerprint:record.fromFingerprint,
    to_fingerprint:record.toFingerprint,reason:record.reason};
  const args=[writer,'--workflow','cm-ai','--event','decision','--phase','qa_config_revise','--runtime','codex',
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,'--at',record.revisedAt,
    '--detail','首轮 QA 前修订 QA 配置，不消耗轮次','--data-json',JSON.stringify(data)];
  let result;
  try{result=childProcess.spawnSync('python3',args,{timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL',
    ...(input.logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:input.logHome}}:{})});}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout),'qa_log_failed');
  return readResult(result.stdout,identity,specsDir);
}

export function recordCmAiQaConfigurationRevision(input,raw){
  const record=readQaConfigRevision(raw),{specsDir,feature,identity,packageDigest}=input;
  if(beforeFirstQaRound(record))return recordPreRoundRevision(input,record);
  const rows=qaRunRows({specsDir,feature,identity,packageDigest});
  const existing=rows.find(({row})=>row.phase==='superseded'&&row.qa_revision_digest===digest(record));
  if(existing){
    validateConfigurationSupersession(existing.row,input.specsDir,'qa_revision_invalid');
    return;
  }
  const target=inspectCmAiQaRevisionTarget(input);
  need(target.testRunId===record.testRunId&&target.qaRound===record.qaRound,'qa_revision_invalid');
  return recordCmAiQaRun({...input,...target,phase:'superseded',configurationRevision:record});
}

export function recordCmAiQaRun(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','testRunId','mode','caseCount','phase'];
  if(Object.hasOwn(input,'result'))keys.push('result');
  if(Object.hasOwn(input,'logHome'))keys.push('logHome');
  if(Object.hasOwn(input,'qaRound'))keys.push('qaRound');
  if(Object.hasOwn(input,'previousTestRunId'))keys.push('previousTestRunId');
  if(Object.hasOwn(input,'deferredCases'))keys.push('deferredCases');
  if(Object.hasOwn(input,'droppedTaskCases'))keys.push('droppedTaskCases');
  if(Object.hasOwn(input,'droppedTaskCommands'))keys.push('droppedTaskCommands');
  if(Object.hasOwn(input,'expectedEnvironment'))keys.push('expectedEnvironment');
  if(Object.hasOwn(input,'configurationRevision'))keys.push('configurationRevision');
  if(Object.hasOwn(input,'environmentFailure'))keys.push('environmentFailure');
  if(Object.hasOwn(input,'timedOutRecovery'))keys.push('timedOutRecovery');
  shape(input,keys);validIdentity(input.identity);id(input.testRunId);hex(input.packageDigest);
  text(input.specsDir);text(input.codeProject);text(input.feature);
  need(['commands','browser','all'].includes(input.mode));
  need(Number.isSafeInteger(input.caseCount)&&input.caseCount>0);
  need(['start','complete','abandoned','superseded'].includes(input.phase));
  const qaRound=input.qaRound??1;
  need(Number.isSafeInteger(qaRound)&&qaRound>=1&&qaRound<=QA_MAX_ROUNDS,'qa_round_invalid');
  const binding={specsDir:input.specsDir,feature:input.feature,identity:input.identity,packageDigest:input.packageDigest};
  let passed=[],blockedCases=[],failedCases=[],declaredFailure=null,incompleteReport=false,timedOut=null;
  if(Object.hasOwn(input,'environmentFailure'))need(input.phase==='superseded'&&!input.configurationRevision
    &&validEnvironmentFailureReason(input.environmentFailure),'qa_recovery_authorization_required');
  if(input.configurationRevision){
    need(input.phase==='superseded','qa_revision_invalid');
    const record=readQaConfigRevision(input.configurationRevision),target=inspectCmAiQaRevisionTarget(binding);
    need(record.taskAttempt===input.identity.attempt&&record.testRunId===input.testRunId&&target.testRunId===input.testRunId&&record.packageDigest===input.packageDigest
      &&target.qaRound===qaRound&&record.qaRound===qaRound&&target.mode===input.mode&&target.caseCount===input.caseCount,'qa_revision_invalid');
  }else if(input.timedOutRecovery){
    shape(input.timedOutRecovery,['requestTimeoutMs','attestation']);
    need(input.phase==='superseded'&&!Object.hasOwn(input,'expectedEnvironment')&&!Object.hasOwn(input,'environmentFailure'),'qa_recovery_authorization_required');
    timedOut=inspectCmAiQaRecovery(binding,{timedOut:true,requestTimeoutMs:input.timedOutRecovery.requestTimeoutMs,
      attestation:input.timedOutRecovery.attestation});
    need(timedOut.testRunId===input.testRunId&&timedOut.qaRound===qaRound
      &&timedOut.mode===input.mode&&timedOut.caseCount===input.caseCount,'qa_round_invalid');
    if(timedOut.superseded)return;
  }else if(input.phase==='superseded'){
    const previous=inspectCmAiQaRecovery(binding,{blocked:true,environment:input.expectedEnvironment,
      environmentFailure:input.environmentFailure??null});
    blockedCases=previous.blockedCases;failedCases=previous.failedCases;incompleteReport=previous.incompleteReport;
    declaredFailure=input.environmentFailure??null;
    need(previous.testRunId===input.testRunId&&previous.qaRound===qaRound
      &&previous.mode===input.mode&&previous.caseCount===input.caseCount,'qa_round_invalid');
    if(previous.superseded)return;
  }else if(input.phase==='abandoned'){
    const previous=inspectCmAiQaRecovery(binding);
    passed=previous.partialPassCases;
    need(previous.testRunId===input.testRunId&&previous.qaRound===qaRound
      &&previous.mode===input.mode&&previous.caseCount===input.caseCount,'qa_round_invalid');
    if(previous.abandoned)return;
  }else if(input.phase==='start'){
    let previous;
    if(Object.hasOwn(input,'previousTestRunId')){
      const rows=qaRunRows(binding),last=rows.at(-1)?.row,superseded=last?.phase==='superseded';
      previous=inspectCmAiQaConfigurationRecovery(binding)??(superseded&&last.reason==='host_request_timeout'
        ?inspectCmAiQaRecovery(binding,{timedOut:true}):inspectCmAiQaRecovery(binding,{blocked:superseded,environment:last?.expected_environment}));
      need((previous.abandoned||previous.superseded)&&previous.testRunId===input.previousTestRunId
        &&previous.qaRound+(superseded?1:0)===qaRound,'qa_round_invalid');
    }else previous=latestCmAiQaRun(binding);
    scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
      need(!(row.event==='test_run'&&row.operation_id===input.testRunId),'qa_round_invalid');
    });
    // Q14: a round beyond three starts only when host-caused rounds gave one back.
    const prior=qaRunRows(binding);
    need(qaRound<=qaRoundLimit(prior.length?validateRunSequence(prior,'qa_round_invalid',input.specsDir).freed:0),'qa_round_invalid');
    if(previous===null)need(qaRound===1,'qa_round_invalid');
    else if(!Object.hasOwn(input,'previousTestRunId')){
      const failure=inspectCmAiQaFailure({...binding,testRunId:previous.testRunId});
      need(qaRound===failure.qaRound+1&&input.testRunId!==previous.testRunId,'qa_round_invalid');
    }
  }else need(readCmAiQaRunRound({...binding,testRunId:input.testRunId})===qaRound,'qa_round_invalid');
  const decision=findCmAiQaDecision({specsDir:input.specsDir,feature:input.feature,identity:input.identity,
    packageDigest:input.packageDigest});need(decision?.status==='triggered','qa_not_triggered');
  const data={node:'N6',repository_id:input.identity.repositoryId,feature:input.feature,task:input.identity.taskId,
    package_digest:input.packageDigest,qa_decision_id:decision.decisionId,operation_id:input.testRunId,
    attempt:qaRound,mode:input.mode,case_count:input.caseCount};
  if(input.phase==='start'){
    if(Object.hasOwn(input,'previousTestRunId'))data.previous_test_run_id=input.previousTestRunId;
    const deferred=json(input.deferredCases??[]);need(Array.isArray(deferred),'qa_plan_invalid');
    for(const item of deferred){
      shape(item,['id','taskIds']);id(item.id);
      need(Array.isArray(item.taskIds)&&item.taskIds.length>0,'qa_plan_invalid');
      for(const taskId of item.taskIds)id(taskId);
    }
    data.deferred_cases=deferred;
    // Cases bound only to [DROPPED] tasks and commands declared only for them: not planned.
    for(const [key,field,list] of [['droppedTaskCases','dropped_task_cases','taskIds'],['droppedTaskCommands','dropped_task_commands','caseIds']]){
      const items=json(input[key]??[]);need(Array.isArray(items),'qa_plan_invalid');
      for(const item of items){
        shape(item,['id',list]);id(item.id);need(Array.isArray(item[list])&&item[list].length>0,'qa_plan_invalid');
        for(const value of item[list])id(value);
      }
      if(items.length)data[field]=items;
    }
  }else need(!Object.hasOwn(input,'droppedTaskCases')&&!Object.hasOwn(input,'droppedTaskCommands'),'qa_plan_invalid');
  if(input.phase==='abandoned')Object.assign(data,{previous_test_run_id:input.testRunId,reason:'host_terminated',partial_pass_cases:passed});
  if(timedOut)Object.assign(data,{previous_test_run_id:input.testRunId,reason:'host_request_timeout',
    timed_out_cases:timedOut.timedOutCases,partial_pass_cases:timedOut.partialPassCases,
    ...(timedOut.hostBlockedCases.length?{host_blocked_cases:timedOut.hostBlockedCases}:{}),
    ...(timedOut.requestTimeoutMs===null?{}:{request_timeout_ms:timedOut.requestTimeoutMs}),
    ...(timedOut.attestation===null?{}:{legacy_timeout_attestation:timedOut.attestation})});
  else if(input.phase==='superseded')Object.assign(data,{previous_test_run_id:input.testRunId,
    reason:declaredFailure===null?'host_evidence_problem':'declared_environment_failure',recovery_rule:3,
    blocked_cases:blockedCases,expected_environment:input.expectedEnvironment??null,
    ...(incompleteReport?{incomplete_report:true}:{}),
    ...(declaredFailure===null?{}:{failed_cases:failedCases,environment_failure_reason:declaredFailure})});
  if(input.configurationRevision){
    delete data.blocked_cases;delete data.expected_environment;delete data.recovery_rule;
    Object.assign(data,{reason:'qa_configuration_revision',qa_revision_digest:digest(input.configurationRevision)});
    validateConfigurationSupersession({...data,run_id:input.identity.runId},input.specsDir,'qa_revision_invalid');
  }
  if(input.phase==='complete'){
    const result=json(input.result);shape(result,['result','passed','failed','blocked','report']);
    for(const key of ['passed','failed','blocked'])need(Number.isSafeInteger(result[key])&&result[key]>=0,'qa_result_invalid');
    need(result.passed+result.failed+result.blocked===input.caseCount,'qa_result_invalid');
    need((result.result==='PASS'&&result.passed===input.caseCount)
      ||(result.result==='FAIL'&&result.failed>0)||(result.result==='BLOCKED'&&result.blocked>0),'qa_result_invalid');
    reportFile(input.specsDir,result.report);Object.assign(data,result);
  }else need(!Object.hasOwn(input,'result'));
  const args=[writer,'--workflow','cm-ai','--event','test_run','--phase',input.phase,'--runtime','codex',
    '--project-root',input.codeProject,'--specs-dir',input.specsDir,'--run-id',input.identity.runId,
    '--detail',`QA ${input.phase}`,'--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  const result=childProcess.spawnSync('python3',args,options);
  need(!result.error&&result.status===0&&result.signal===null,'qa_log_failed');
  const logged=readResult(result.stdout,input.identity,input.specsDir);
  if(input.phase==='complete')writeCmAiQaStatus({specsDir:input.specsDir,feature:input.feature,
    identity:input.identity,phase:'complete',result:input.result});
  return logged;
}

// Read the registered round before executing cases or publishing their result.
// Task attempt remains bound by the QA decision; it is not the QA round.
export function readCmAiQaRunRound(input){
  shape(input,['specsDir','feature','identity','packageDigest','testRunId']);
  const {testRunId,...binding}=input;id(testRunId);
  const decision=findCmAiQaDecision(binding);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row.workflow==='cm-ai'&&row.event==='test_run'&&row.run_id===input.identity.runId
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.feature===input.feature
      &&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push(row);
  });
  const starts=validateRunSequence(rows.map((row,position)=>({row,position})),'qa_round_invalid',input.specsDir);
  const start=starts.at(-1).row;
  need(start.operation_id===testRunId&&!rows.some(row=>row.operation_id===testRunId
    &&['complete','abandoned'].includes(row.phase)),'qa_round_invalid');
  return start.attempt;
}

export function inspectCmAiQaResult(input) {
  return inspectQaResult(input,false);
}

// Input to the separate cm-fix lifecycle, not permission to modify or rerun QA.
// Shares the exact latest-round validator; never lets callers select an old FAIL.
export function inspectCmAiQaFailure(input) {
  return inspectQaResult(input,true);
}

// Historical evidence only. Never use this to select a new repair or QA action.
export function readCmAiQaFailureHistory(input) {
  return inspectQaResult(input,true,true);
}

function inspectQaResult(input,failureSource,historical=false) {
  shape(input,['specsDir','feature','identity','packageDigest','testRunId']);
  text(input.specsDir);text(input.feature);validIdentity(input.identity);hex(input.packageDigest);id(input.testRunId);
  const log=path.join(path.resolve(input.specsDir),'运行日志.jsonl');
  need(fs.existsSync(log),'qa_result_incomplete');
  const decisions=[],allRuns=[];let position=0;
  try {scanRows(log,row=>{
    const item={row,position:position++};
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
      &&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.attempt===input.identity.attempt
      &&row.package_digest===input.packageDigest)decisions.push(item);
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run')allRuns.push(item);
  });}catch{need(false,'qa_result_invalid');}
  need(effectiveQaDecisionRow(decisions.map(item=>item.row),'qa_not_triggered')?.status==='triggered','qa_not_triggered');
  const decision=decisions.at(-1),decisionId=decision.row.decision_id;id(decisionId);
  const selected=allRuns.filter(item=>item.row.operation_id===input.testRunId);
  need(selected.length>0,'qa_result_incomplete');
  const bound=row=>row.node==='N6'&&row.repository_id===input.identity.repositoryId
    &&row.run_id===input.identity.runId&&row.feature===input.feature&&row.task===input.identity.taskId
    &&row.package_digest===input.packageDigest
    &&row.qa_decision_id===decisionId;
  for(const {row} of selected)need(bound(row),'qa_result_mismatch');
  const candidates=allRuns.filter(item=>item.position>decision.position&&bound(item.row));
  need(candidates.length>0,'qa_result_invalid');
  for(const {row} of candidates)need(typeof row.operation_id==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.operation_id)
    &&Number.isSafeInteger(row.attempt)&&row.attempt>=1&&row.attempt<=QA_MAX_ROUNDS,'qa_result_invalid');
  const latestStarts=candidates.filter(item=>item.row.phase==='start');
  need(latestStarts.length>0,'qa_result_incomplete');
  validateRunSequence(candidates,'qa_result_invalid',input.specsDir);
  const latestStart=latestStarts.at(-1);
  if(!historical)need(latestStart.row.operation_id===input.testRunId,'qa_result_stale');
  const runs=candidates.filter(item=>item.row.operation_id===input.testRunId);
  if(!historical)need(!runs.some(({row})=>row.phase==='superseded'&&row.reason==='qa_configuration_revision'),'qa_result_superseded');
  need(runs.length>0,'qa_result_invalid');
  const starts=runs.filter(item=>item.row.phase==='start'),completes=runs.filter(item=>item.row.phase==='complete');
  need(starts.length===1&&completes.length===1,'qa_result_incomplete');
  need(decision.position<starts[0].position&&starts[0].position<completes[0].position,'qa_result_invalid');
  const start=starts[0].row,complete=completes[0].row;
  text(start.mode);text(complete.mode);need(start.mode===complete.mode&&start.attempt===complete.attempt,'qa_result_invalid');
  for(const key of ['case_count','passed','failed','blocked'])
    need(Number.isSafeInteger(complete[key])&&complete[key]>=0,'qa_result_invalid');
  need(Number.isSafeInteger(start.case_count)&&start.case_count>0&&start.case_count===complete.case_count
    &&complete.passed+complete.failed+complete.blocked===complete.case_count,'qa_result_invalid');
  text(complete.result);const result=complete.result.toUpperCase();
  let status;
  if(['PASS','PASSED'].includes(result)){
    need(complete.passed===complete.case_count&&complete.failed===0&&complete.blocked===0
      &&!runs.some(item=>item.row.phase==='case_blocked'),'qa_result_invalid');status='passed';
  }else if(['FAIL','FAILED'].includes(result)){
    need(complete.failed>0,'qa_result_invalid');status='failed';
  }else if(['BLOCKED','NEEDS_MANUAL'].includes(result)){
    need(complete.blocked>0,'qa_result_invalid');status='blocked';
  }else need(false,'qa_result_invalid');
  const report=reportFile(input.specsDir,complete.report);
  if(failureSource){
    need(status==='failed','qa_failure_required');
    return json({identity:input.identity,packageDigest:input.packageDigest,testRunId:input.testRunId,
      qaDecisionId:decisionId,qaRound:start.attempt,report,
      counts:{total:complete.case_count,passed:complete.passed,failed:complete.failed,blocked:complete.blocked}});
  }
  return Object.freeze({status});
}
