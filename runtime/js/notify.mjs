// Optional "a person is needed" notices, shared by every workflow.
// Provider-neutral: hands one user-configured local command (no shell) a short
// message built only from structured fields. It never answers, continues or
// authorizes anything. Nothing here waits: the command runs under a detached,
// unref'd launcher (notify-run.mjs) that owns its own 15 s timeout, so a
// workflow's exit time, exit code, output and state never depend on it.
// Problems only append one line to notify.log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

export const NOTIFY_LIMITS=Object.freeze({sameKeyMs:6*3600*1000,perMinute:4,perDay:150,
  commandTimeoutMs:15000,titleChars:60,bodyChars:500,defaultWaitMinutes:10,defaultCheckWaitMinutes:45,
  defaultIdleMinutes:45});
const LOCK_STALE_MS=30000,LOG_LIMIT=256*1024;
const RUNNER=fileURLToPath(new URL('./notify-run.mjs',import.meta.url));

export function notifyHome(env=process.env){
  return path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
}

// One line per problem; never the message, the command's output or any env.
export function appendNotifyLog(home,now,{event='-',workflow='-',hash='-',result}){
  try{
    const file=path.join(home,'notify.log');
    try{if(fs.statSync(file).size>LOG_LIMIT)fs.renameSync(file,`${file}.1`);}catch{}
    const word=(value,max)=>String(value??'-').replace(/[^A-Za-z0-9_.:-]+/g,'_').slice(0,max)||'-';
    fs.appendFileSync(file,`${new Date(now).toISOString()} ${word(event,12)} ${word(workflow,24)} key=${word(hash,16)} ${String(result).replace(/[^A-Za-z0-9_ .:-]+/g,'_').slice(0,80)}\n`,{mode:0o600});
  }catch{}
}

// One line per process and kind: an unusable file turns notices off; an
// unusable `text` only falls back to the default text (notices stay on).
const warned=new Set();
const warnOnce=(env,kind,result)=>{
  if(warned.has(kind))return;warned.add(kind);
  appendNotifyLog(notifyHome(env),Date.now(),{event:'config',result});
};
const warn=(env,reason)=>warnOnce(env,'config',`off invalid_config ${reason}`);

// Pure check of notify.json text: {config} or {reason}. Shared by the
// runtime reader below and by /cm:notify, which must not write notify.log.
export function parseNotifyConfig(raw){
  let value;
  try{value=JSON.parse(raw);}catch{return {reason:'not_json'};}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)return {reason:'version'};
  const {command}=value;
  if(!Array.isArray(command)||command.length<1||command.length>32
    ||!command.every(item=>typeof item==='string'&&item.length>0&&item.length<=4096&&!item.includes('\0'))){
    return {reason:'command'};
  }
  if(!path.isAbsolute(command[0]))return {reason:'command_not_absolute'};
  const minutes=value.waitMinutes??NOTIFY_LIMITS.defaultWaitMinutes;
  if(typeof minutes!=='number'||!Number.isFinite(minutes)||minutes<=0||minutes>1440)return {reason:'wait_minutes'};
  const checkMinutes=value.checkWaitMinutes??NOTIFY_LIMITS.defaultCheckWaitMinutes;
  if(typeof checkMinutes!=='number'||!Number.isFinite(checkMinutes)||checkMinutes<=0||checkMinutes>1440)return {reason:'check_wait_minutes'};
  const idleMinutes=value.idleMinutes??NOTIFY_LIMITS.defaultIdleMinutes;
  if(typeof idleMinutes!=='number'||!Number.isFinite(idleMinutes)||idleMinutes<=0||idleMinutes>1440)return {reason:'idle_minutes'};
  const ms=value=>Math.max(1,Math.round(value*60000));
  const config={command:[...command],waitMs:ms(minutes),checkWaitMs:ms(checkMinutes),idleMs:ms(idleMinutes)};
  // An unusable `text` never turns notices off: the default text is used and
  // the caller is told why (textReason), so a typo cannot silence notices.
  if(value.text===undefined)return {config};
  const text=normalizeNotifyText(value.text);
  if(text.reason)return {config,textReason:text.reason};
  return {config:{...config,text:text.text}};
}

// null = feature off. Under `node --test` only an explicit CM_WORKFLOW_HOME
// enables it, so a test suite never reaches the user's real configuration.
// An invalid file is reported in notify.log only, never on workflow output.
export function readNotifyConfig(env=process.env){
  if(env.NODE_TEST_CONTEXT&&!env.CM_WORKFLOW_HOME)return null;
  const file=path.join(notifyHome(env),'notify.json');
  let raw;
  try{raw=fs.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')warn(env,`unreadable_${error.code??'error'}`);return null;}
  const parsed=parseNotifyConfig(raw);
  if(parsed.reason){warn(env,parsed.reason);return null;}
  if(parsed.textReason)warnOnce(env,'text',`default_text text_config ${parsed.textReason}`);
  return parsed.config;
}

// Messages carry only these structured fields. Absolute paths (POSIX, drive
// letter, UNC; also when glued to CJK text) are redacted and control
// characters removed; every field and the whole message are bounded.
const cut=(text,max)=>{const chars=Array.from(text);return chars.length<=max?text:chars.slice(0,max-1).join('')+'…';};
function clean(value,max){
  if(typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))return '';
  const text=String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g,' ')
    .replace(/(?<![A-Za-z0-9_.~-])(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s'"`，。；;、）)]+/g,'<路径>')
    .replace(/\s+/g,' ').trim();
  return cut(text,max);
}
const projectName=value=>typeof value==='string'&&value?clean(path.basename(value),40):'';

// Local 24-hour HH:MM in the process time zone (TZ) unless one is injected.
export function localClock(now,timeZone){
  const parts=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',
    ...(timeZone?{timeZone}:{})}).formatToParts(new Date(now));
  const pick=type=>parts.find(part=>part.type===type)?.value??'00';
  return `${pick('hour')}:${pick('minute')}`;
}

// Optional user text (notify.json `text`): a title prefix, one headline per
// event, which structured fields appear in which order, and their labels.
// Nothing else: no templates or expressions. Custom strings go through the same
// clean() as field values (paths redacted, control characters removed) and are
// capped; the whole title and body keep their caps.
export const NOTIFY_TEXT_FIELDS=Object.freeze(['project','workflow','runId','task','stage','code','nextAction','time']);
const TEXT_EVENTS=['done','waiting','idle','idle_waiting','dead','default'];
const TEXT_CAPS=Object.freeze({titlePrefix:16,headline:24,label:12});
const FIELD_CAPS={workflow:24,runId:64,task:40,stage:48,code:64,nextAction:200};
export const DEFAULT_NOTIFY_TEXT=Object.freeze({titlePrefix:'CM',
  headlines:Object.freeze({done:'流程已结束',waiting:'等待会话应答',idle:'疑似空转',idle_waiting:'在等你',dead:'宿主已退出未收尾',default:'需要人处理'}),
  fields:Object.freeze({default:Object.freeze(['nextAction','project','workflow','task','stage','code','time']),
    done:Object.freeze(['project','task','time'])}),
  labels:Object.freeze({nextAction:'下一步',project:'项目',workflow:'流程',runId:'运行',task:'任务',stage:'阶段',code:'原因',time:'时间'})});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const onlyKeys=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));
// {text} merged over the default, or {reason}. Idempotent on its own output.
export function normalizeNotifyText(value){
  if(!plain(value))return {reason:'text'};
  if(!onlyKeys(value,['titlePrefix','headlines','fields','labels']))return {reason:'text_key'};
  const text={titlePrefix:DEFAULT_NOTIFY_TEXT.titlePrefix,headlines:{...DEFAULT_NOTIFY_TEXT.headlines},
    fields:{default:[...DEFAULT_NOTIFY_TEXT.fields.default],done:[...DEFAULT_NOTIFY_TEXT.fields.done]},labels:{...DEFAULT_NOTIFY_TEXT.labels}};
  // A custom string must still say something after cleaning; the prefix may be empty.
  const word=(raw,max,empty=false)=>{if(typeof raw!=='string')return null;const cleaned=clean(raw,max);return cleaned||empty&&!raw.trim()?cleaned:null;};
  if(value.titlePrefix!==undefined){
    const prefix=word(value.titlePrefix,TEXT_CAPS.titlePrefix,true);if(prefix===null)return {reason:'title_prefix'};
    text.titlePrefix=prefix;
  }
  for(const [name,keys,cap] of [['headlines',TEXT_EVENTS,TEXT_CAPS.headline],['labels',NOTIFY_TEXT_FIELDS,TEXT_CAPS.label]]){
    if(value[name]===undefined)continue;
    if(!plain(value[name])||!onlyKeys(value[name],keys))return {reason:name};
    for(const [key,raw] of Object.entries(value[name])){const cleaned=word(raw,cap);if(cleaned===null)return {reason:name};text[name][key]=cleaned;}
  }
  if(value.fields!==undefined){
    if(!plain(value.fields)||!onlyKeys(value.fields,['default','done']))return {reason:'fields'};
    for(const [key,list] of Object.entries(value.fields)){
      if(!Array.isArray(list)||list.length<1||new Set(list).size!==list.length
        ||!list.every(item=>NOTIFY_TEXT_FIELDS.includes(item)))return {reason:'fields'};
      text.fields[key]=[...list];
    }
  }
  return {text};
}

// The default text is a next-step-first layout; a finished run only names
// project, task and time. `text` is a normalized notify.json `text`; anything
// unusable falls back to the default.
export function buildNotifyMessage(fields,{now=Date.now(),timeZone,text}={}){
  const spec=text===undefined||text===null?DEFAULT_NOTIFY_TEXT:normalizeNotifyText(text).text??DEFAULT_NOTIFY_TEXT;
  const workflow=clean(fields.workflow,24)||'cm',project=projectName(fields.project);
  const event=Object.hasOwn(spec.headlines,fields.event)&&fields.event!=='default'?fields.event:'default';
  const head=[spec.titlePrefix,workflow,spec.headlines[event]].filter(Boolean).join(' ');
  const title=cut(`${head}${project?` · ${project}`:''}`,NOTIFY_LIMITS.titleChars);
  const value=name=>name==='time'?localClock(now,timeZone):name==='project'?project:name==='workflow'?workflow
    :clean(fields[name],FIELD_CAPS[name]);
  const rows=spec.fields[fields.event==='done'?'done':'default'].map(name=>[spec.labels[name],value(name)]);
  const lines=rows.filter(([,value])=>value).map(([label,value])=>`${label}：${value}`);
  return {title,body:cut(lines.join('\n'),NOTIFY_LIMITS.bodyChars)};
}

const keyHash=key=>createHash('sha256').update(key).digest('hex').slice(0,16);

// Cross-process lock without any waiting. The lock file is published complete
// (written to a temp file, then hard-linked into place, which fails if a lock
// exists). A busy lock skips the notice at once. A stale lock (owner gone or
// older than 30 s; the critical section takes milliseconds) is reclaimed only
// by renaming it to a unique name and confirming it is byte-identical to the
// stale lock that was judged; anything else is put back and the notice skipped.
function readLock(file){try{return fs.readFileSync(file,'utf8');}catch{return null;}}
function stale(raw){
  let value;try{value=JSON.parse(raw);}catch{return false;}
  if(!Number.isSafeInteger(value?.pid)||!Number.isFinite(value?.at))return false;
  if(Date.now()-value.at>LOCK_STALE_MS)return true;
  if(value.pid===process.pid)return false;
  try{process.kill(value.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
function publishLock(file,body){
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,body,{mode:0o600});fs.linkSync(temp,file);return true;}
  catch{return false;}
  finally{try{fs.unlinkSync(temp);}catch{}}
}
function takeLock(file){
  const token=randomUUID(),body=JSON.stringify({pid:process.pid,at:Date.now(),token});
  if(publishLock(file,body))return body;
  const seen=readLock(file);
  if(seen===null||!stale(seen))return null;
  const grave=`${file}.stale-${randomUUID()}`;
  try{fs.renameSync(file,grave);}catch{return null;}
  if(readLock(grave)!==seen){try{fs.linkSync(grave,file);}catch{}try{fs.unlinkSync(grave);}catch{}return null;}
  try{fs.unlinkSync(grave);}catch{}
  return publishLock(file,body)?body:null;
}
function releaseLock(file,body){if(readLock(file)===body){try{fs.unlinkSync(file);}catch{}}}

// Dedup and throttle across processes. Any lock or parse trouble skips the
// notice instead of waiting on it.
function reserve(home,hash,now){
  const lockFile=path.join(home,'notify-state.lock'),stateFile=path.join(home,'notify-state.json');
  const lock=takeLock(lockFile);if(lock===null)return 'state_busy';
  try{
    let state={version:1,keys:{},sends:[]};
    try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}
    catch(error){if(error.code!=='ENOENT')return 'state_invalid';}
    if(!state||state.version!==1||!state.keys||typeof state.keys!=='object'||Array.isArray(state.keys)
      ||!Array.isArray(state.sends)||!state.sends.every(Number.isFinite)
      ||!Object.values(state.keys).every(Number.isFinite))return 'state_invalid';
    const keys=Object.fromEntries(Object.entries(state.keys).filter(([,at])=>now-at<NOTIFY_LIMITS.sameKeyMs&&at<=now));
    const sends=state.sends.filter(at=>now-at<24*3600*1000&&at<=now);
    if(Object.hasOwn(keys,hash))return 'duplicate';
    if(sends.filter(at=>now-at<60000).length>=NOTIFY_LIMITS.perMinute)return 'rate_minute';
    if(sends.length>=NOTIFY_LIMITS.perDay)return 'rate_day';
    keys[hash]=now;sends.push(now);
    const temp=`${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try{fs.writeFileSync(temp,JSON.stringify({version:1,keys,sends}),{mode:0o600});fs.renameSync(temp,stateFile);}
    catch{try{fs.unlinkSync(temp);}catch{}return 'state_write_failed';}
    return 'ok';
  }finally{releaseLock(lockFile,lock);}
}

// Never throws and never waits. Returns {sent, reason}; sent means the command
// was handed to the detached launcher, whose own failures go to notify.log.
export function notify(fields,{env=process.env,now=Date.now(),timeoutMs=NOTIFY_LIMITS.commandTimeoutMs}={}){
  try{
    const config=readNotifyConfig(env);if(!config)return {sent:false,reason:'off'};
    if(typeof fields?.key!=='string'||!fields.key)return {sent:false,reason:'invalid_key'};
    const home=notifyHome(env),hash=keyHash(fields.key),event=fields.event??'stuck',workflow=clean(fields.workflow,24)||'cm';
    const reserved=reserve(home,hash,now);
    if(reserved!=='ok'){
      if(reserved!=='duplicate')appendNotifyLog(home,now,{event,workflow,hash,result:`skipped ${reserved}`});
      return {sent:false,reason:reserved};
    }
    const message=buildNotifyMessage(fields,{now,text:config.text});
    const payload={...message,event};
    for(const name of ['project','workflow','runId','task','stage','code','nextAction']){
      const value=name==='project'?projectName(fields.project):clean(fields[name],name==='nextAction'?200:64);
      if(value)payload[name]=value;
    }
    const child=spawn(process.execPath,[RUNNER,home,hash,event,workflow,String(timeoutMs),'--',...config.command],
      {detached:true,stdio:'ignore',windowsHide:true,
        env:{...env,CM_NOTIFY_TITLE:message.title,CM_NOTIFY_BODY:message.body,CM_NOTIFY_PAYLOAD:JSON.stringify(payload)}});
    child.on('error',()=>appendNotifyLog(home,Date.now(),{event,workflow,hash,result:'failed launcher'}));
    child.unref();
    return {sent:true,reason:'launched'};
  }catch{return {sent:false,reason:'error'};}
}

// Host registry: one small private file per live host session under
// <home>/hosts, so the read-only patrol (scripts/cm-patrol.mjs) can tell a host
// that died from one that is merely idle. Written only when notices are
// configured, updated on events the host already has (start, each reply),
// removed at session end. Best-effort: never throws, never changes the host.
export const HOST_REGISTRY_MAX_AGE_MS=48*3600*1000;
const SESSION_KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function hostRegistryDir(env=process.env){return path.join(notifyHome(env),'hosts');}
export function writeHostRegistry({sessionKey,workflow,project,startedAt,row=null,operation=null},{env=process.env,now=Date.now()}={}){
  try{
    if(!readNotifyConfig(env)||!SESSION_KEY.test(sessionKey))return false;
    const dir=hostRegistryDir(env);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const result=obj(row?.result);
    const entry={version:1,pid:process.pid,sessionKey,workflow:clean(workflow,24)||'cm',
      project:typeof project==='string'?project:'',startedAt:new Date(startedAt).toISOString(),at:new Date(now).toISOString(),
      operation:clean(operation,32)||null,
      runId:text(result.identity?.runId)??text(result.runId)??text(result.batchId)??null,
      task:text(result.identity?.taskId)??text(result.taskId)??null,
      stage:text(result.stage)??text(result.state)??text(result.status)??null};
    const file=path.join(dir,`${sessionKey}.json`),temp=`${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp,JSON.stringify(entry),{mode:0o600});fs.renameSync(temp,file);return true;
  }catch{return false;}
}
// Same test guard as readNotifyConfig: a test suite without an explicit
// CM_WORKFLOW_HOME never touches the user's real directory, not even to unlink.
export function removeHostRegistry(sessionKey,{env=process.env}={}){
  if(env.NODE_TEST_CONTEXT&&!env.CM_WORKFLOW_HOME)return;
  try{if(SESSION_KEY.test(sessionKey))fs.unlinkSync(path.join(hostRegistryDir(env),`${sessionKey}.json`));}catch{}
}

// Host side: one notice when a host_request has waited waitMinutes for the
// session's answer. The timer never keeps the process alive.
const CHECK_KINDS=new Set(['check','verification_precheck','init_verify']);
export function scheduleWaitNotice({kind,callId,workflow,project,env=process.env}){
  try{
    const config=readNotifyConfig(env);if(!config)return null;
    // A check request is answered only after the session has run the project's
    // check commands (xcodebuild, test suites), which normally take tens of
    // minutes; waiting that long is not idleness, so it uses its own threshold.
    const waitMs=CHECK_KINDS.has(kind)?config.checkWaitMs:config.waitMs;
    const minutes=Math.max(1,Math.round(waitMs/60000));
    const timer=setTimeout(()=>{notify({key:`wait|${workflow}|${callId}`,event:'waiting',workflow,project,stage:kind,
      code:'waiting_session_answer',nextAction:`宿主已等待会话应答约 ${minutes} 分钟，请回到会话处理`},{env});},waitMs);
    timer.unref?.();
    return ()=>clearTimeout(timer);
  }catch{return null;}
}

// Host side: one notice when an operation has replied, nothing is in flight
// and the session has not sent the next operation for idleMinutes (polls excluded). A last
// result that already waits on a person (or ended the run) says so instead of
// "idle". Built only from that result's structured fields; the timer never
// keeps the process alive.
export function scheduleIdleNotice({workflow,project,sessionKey,seq,row,since=Date.now(),env=process.env}){
  try{
    const config=readNotifyConfig(env);if(!config)return null;
    // `since` is the last real reply: re-arming after a poll keeps that deadline.
    const delay=Math.max(1,Math.min(config.idleMs,config.idleMs-(Date.now()-since)));
    const minutes=Math.max(1,Math.round(config.idleMs/60000));
    const kind=classifyDriveResult(workflow,row),result=obj(row?.result);
    const runId=text(result.identity?.runId)??text(result.runId)??text(result.batchId);
    const task=text(result.identity?.taskId)??text(result.taskId);
    const stage=text(result.stage)??text(result.state)??text(result.status);
    const nextAction=kind==='done'?`流程已结束，宿主仍开着约 ${minutes} 分钟没有下一步，请回到会话收尾或开始下一项`
      :kind==='stuck'?`上一步停在需要你处理的状态，约 ${minutes} 分钟没有下一步，请回到会话处理`
      :`上一步已结束约 ${minutes} 分钟，会话没有发下一步，请回到会话查看`;
    const timer=setTimeout(()=>{notify({key:`idle|${workflow}|${sessionKey}|${seq}`,event:kind?'idle_waiting':'idle',
      workflow,project,runId,task,stage,code:kind?'waiting_for_you':'no_next_step',nextAction},{env});},delay);
    timer.unref?.();
    return ()=>clearTimeout(timer);
  }catch{return null;}
}

// Driver side: decide from the final host response (or the driver's own stop)
// whether a person is needed. Each workflow is classified by its own result
// contract (see the host named in each entry); normal progress returns null.
// 'stuck' = stopped until a person acts; 'done' = the run has ended.
const text=value=>typeof value==='string'&&value?value:null;
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const STUCK_COMMON=new Set(['blocked','cancelled','failed','interrupted']);
const verdict=(value,{done,stuck})=>stuck.has(value)?'stuck':done.has(value)?'done':null;
// cm-fix owner projection (runtime/js/cm-fix/execution.mjs, progress.mjs): stages
// on the normal path continue; everything else falls through to "a person
// decides", exactly like fixProgress's requiresUser fallback.
const FIX_FLOW=new Set(['reproduce','diagnose','cause_review_required','test_author_required','red_test_required',
  'design_change_required','baseline_required','repair_required','regression_required','handoff_required',
  'learning_writeback_required','handoff_ready','final_review_required','final_review_evidence_required',
  'completion_gate_required','post_review_regression_required','closeout_required','escalation_required',
  'observation_resume_prepared','observation_diagnose_required','revision_prepared','revision_test_author_required',
  'revision_test_check_required']);
function classifyFix(r){
  const stage=text(r.stage);if(!stage)return null;
  if(stage==='completed')return 'done';
  if(r.progress&&typeof r.progress==='object'){if(r.progress.finished===true)return 'done';if(r.progress.requiresUser===true)return 'stuck';}
  // A refused review authorization keeps the stage (execution.mjs) but waits on a person.
  if(text(r.reason)==='permission_denied')return 'stuck';
  return FIX_FLOW.has(stage)||FIX_FLOW.has(stage.replace(/^revision_/,''))?null:'stuck';
}
// cm-ai conversation entry (runtime/js/cm-ai/cm-ai-conversation-entry.mjs, operator-guidance.mjs,
// task-runner.mjs) and the QA-fix owner (host-qa-fix-owner.mjs). The only run end is
// run_done; start_next_task hands over to the next task and is progress.
const AI_PROGRESS_CODES=new Set(['context_refreshed','context_complete','qa_skipped','qa_passed','documentation_synced',
  'documentation_sync_required','revision_answer_required']);
const AI_STUCK_STATES=new Set(['blocked','unknown','pending_review','cancelled','awaiting_spec_approval']);
const AI_STUCK_ACTIONS=new Set(['reconcile','abandon_effect','abandon_review','reconcile_review','bootstrap_review_recover',
  'review_evidence','spec_rebind','fix_authorization','fix_dispatch','qa_execution']);
const AI_STUCK_CODES=new Set(['decision_required','permission_denied','provider_development_authorization_required',
  'qa_decision_required','qa_mandatory_required','qa_triggered','qa_blocked','qa_failed','qa_result_blocked',
  'qa_execution_unknown','correction_review_required','project_qa_not_passed','documentation_sync_blocked',
  'handoff_exists','spec_drift','qa_fix_code_unmatched',
  // Q23-Q26: QA-fix and batch recovery refusals and stops (host-qa-fix-owner.mjs, cm-ai-batch-run.mjs).
  'qa_fix_action_authorization_required','batch_member_action_authorization_required','batch_member_action_not_current',
  'batch_member_action_unavailable','batch_parallel_member_recovery_required','batch_resources_open',
  'batch_parallel_member_unresolved','batch_member_rescheduled']);
function classifyAi(r){
  const state=text(r.state),code=text(r.code),outcome=text(r.outcome);
  if(state==='run_done'&&['run_done','run_done_degraded'].includes(code))return 'done';
  if(code==='qa_fix_incomplete')return classifyFix({stage:r.fixStage});
  if(['qa_fix_completed','qa_fix_active','qa_fix_owner_busy'].includes(code)||outcome==='abandoned')return null;
  if(r.pendingAction==='start_next_task'||AI_PROGRESS_CODES.has(code))return null;
  if(['rejected','denied','cancelled','blocked','awaiting'].includes(outcome)||AI_STUCK_STATES.has(state)
    ||AI_STUCK_ACTIONS.has(r.pendingAction)||AI_STUCK_CODES.has(code))return 'stuck';
  return null;
}
const CLASSIFY={
  'cm-ai':classifyAi,
  // scripts/cm-ai-batch-run.mjs: member results pass through; batch-level stops
  // carry outcome blocked/cancelled; the last member's run_done ends the batch.
  'cm-ai-batch':classifyAi,
  'cm-fix':classifyFix,
  // runtime/js/cm-prd/analysis.mjs, change.mjs, summary.mjs, draft-save.mjs, review-*.mjs; scripts/cm-prd-host.mjs.
  'cm-prd'(r){
    const stage=text(r.stage),status=text(r.status),review=obj(r.reviewState);
    if(stage==='awaiting_review'||status==='awaiting_review')return 'done';
    if(STUCK_COMMON.has(stage)||STUCK_COMMON.has(status))return 'stuck';
    if(['awaiting_user','awaiting_planning_user','awaiting_design_user','self_check_needs_human','change_confirmation',
      'change_rejected','inputs_replaced'].includes(stage))return 'stuck';
    if(stage==='change_check_failed'&&Number(r.round)>=2)return 'stuck';
    if(/^change_(requirements|design|tasks|check)$/.test(stage??'')&&text(r.question))return 'stuck';
    if(status&&(/_unknown$/.test(status)||['correction_recovery_required','correction_recovery_conflict','disposition_details_need_verification'].includes(status)))return 'stuck';
    if(status==='human_summary_prepared'&&r.readyForAwaitingReview===false)return 'stuck';
    if(status==='review_findings_ready'&&r.verdict==='blocked')return 'stuck';
    if(['review_unknown','review_cancelled'].includes(review.status)||review.verdict==='blocked'
      ||obj(review.gate).outcome==='dispatch_unknown')return 'stuck';
    if(Array.isArray(obj(r.recovery).calls)&&r.recovery.calls.some(call=>obj(call).status==='unknown'))return 'stuck';
    return null;
  },
  // scripts/cm-idea-host.mjs.
  'cm-idea'(r){
    const stage=text(r.stage),recovery=obj(r.recovery);
    if(stage==='saved')return 'done';
    // A pending call (unknown, or recorded but not yet consumed/refused) waits on
    // resume, abandon or discard; an interrupted save waits on reconciliation.
    if(recovery.writing===true||['unknown','recorded'].includes(obj(recovery.call).status))return 'stuck';
    if(stage==='draft_ready')return r.confirmationRequired===true?null:'stuck';
    return ['awaiting_user','save_unknown','save_blocked',...STUCK_COMMON].includes(stage)?'stuck':null;
  },
  // scripts/cm-init-host.mjs, runtime/js/cm-init/draft-generation.mjs (generation returns status, no stage).
  'cm-init'(r){
    const stage=text(r.stage)??(r.status==='blocked'?'blocked':null),recovery=obj(r.recovery);
    if(['rules_written','rules_present'].includes(stage))return 'done';
    if(recovery.writing===true||['unknown','recorded'].includes(obj(recovery.call).status))return 'stuck';
    return ['analysis_blocked','verification_blocked','confirmation_required','confirmation_rejected','review_changes_requested',
      'review_blocked','write_incomplete','write_unknown',...STUCK_COMMON].includes(stage)?'stuck':null;
  },
  // runtime/js/cm-refactor/workflow.mjs.
  'cm-refactor'(r){
    const stage=text(r.stage);
    if(['done','not_needed','rejected'].includes(stage))return 'done';
    return ['awaiting_finish','rulebook_rejected','correction_required',...STUCK_COMMON].includes(stage)?'stuck':null;
  },
  // runtime/js/cm-test/host.mjs: verdict in result.overall when stage is reported.
  'cm-test'(r){
    if(r.historical===true)return null;
    const stage=text(r.stage);
    if(stage==='reported')return verdict(r.overall,{stuck:new Set(['FAIL','BLOCKED','FINDING']),
      done:new Set(['PASS','GENERATED','NO_CHANGES','ANALYZED','PARTIAL','REVIEWED','NO_FINDING'])})??'stuck';
    return STUCK_COMMON.has(stage)?'stuck':null;
  },
  // runtime/js/cm-check/host.mjs: verdict nested in result.result.overall.
  'cm-check'(r){
    const stage=text(r.stage);
    if(stage==='reported')return verdict(obj(r.result).overall,{stuck:new Set(['FAILED','BLOCKED']),
      done:new Set(['PASSED','MECHANICAL_ONLY'])})??'stuck';
    return STUCK_COMMON.has(stage)?'stuck':null;
  },
};
// Inspection operations never notify (per host help and driver READ_ONLY sets).
const READ_ONLY=new Set(['status','fix_status','cancel','qa_result','context_refresh','read_batch','inspect_correction',
  'final_review_package','review_findings','completion_evidence','cause_review_package']);
export const NOTIFY_WORKFLOWS=Object.freeze(Object.keys(CLASSIFY));
export function classifyDriveResult(workflow,row){
  if(row?.error)return 'stuck';
  const classify=CLASSIFY[workflow];
  return classify?classify(obj(row?.result)):null;
}
export function driveNotice({host,cwd,args=[],operation,row=null,failure=null}){
  if(READ_ONLY.has(operation))return null;
  const workflow=path.basename(String(host??'')).replace(/-host\.mjs$/,'').replace(/\.mjs$/,'')||'cm';
  const kind=failure?'stuck':classifyDriveResult(workflow,row);
  if(!kind)return null;
  const done=kind==='done',result=obj(row?.result),progress=obj(result.progress),nested=obj(result.result);
  const code=text(failure)??text(row?.error?.code)??text(result.code)??text(result.reason)??text(result.blocker)
    ??text(progress.blocker)??text(result.overall)??text(nested.overall)??text(result.state)??text(result.status)??text(result.stage)??null;
  const runId=text(result.identity?.runId)??text(result.runId)??text(result.batchId);
  const task=text(result.identity?.taskId)??text(result.taskId);
  const attempt=Number.isSafeInteger(result.identity?.attempt)?result.identity.attempt:null;
  const stage=text(result.stage)??text(result.state)??text(result.status)??operation??null;
  const run=runId??`args:${keyHash(args.map(String).join('\0'))}`;
  return {key:[workflow,run,task??'',attempt??'',stage??'',done?'done':code??''].join('|'),
    event:kind,workflow,project:cwd?path.basename(path.resolve(cwd)):null,runId,task,stage,
    code:done?(text(result.code)??text(result.overall)??text(nested.overall)??'done'):code,
    // A finished unit is the natural point to start a fresh session (runtime/model-efficiency.md).
    nextAction:done?'建议在新会话里开始下一个任务，减少重复读入的上下文':text(result.guidance?.nextStep)??text(progress.nextAction)??text(result.nextAction)};
}
