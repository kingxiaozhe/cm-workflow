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
import {readRegularFileSync} from './notify-safe-read.mjs';

export const NOTIFY_LIMITS=Object.freeze({sameKeyMs:6*3600*1000,perDay:150,
  windowMs:10*60000,perWindow:3,followUpMs:2*3600*1000,attentionTtlMs:24*3600*1000,
  commandTimeoutMs:15000,titleChars:60,bodyChars:500,defaultWaitMinutes:10,defaultCheckWaitMinutes:45,
  defaultIdleMinutes:45});
const LOCK_STALE_MS=30000,LOG_LIMIT=256*1024;
// Lock and dedup state are tiny JSON files; perDay sends bound the state size.
const CONTROL_FILE_LIMIT=256*1024;
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
  const config={command:[...command],waitMs:ms(minutes),checkWaitMs:ms(checkMinutes),idleMs:ms(idleMinutes),
    followUpMs:NOTIFY_LIMITS.followUpMs,windowMs:NOTIFY_LIMITS.windowMs,perWindow:NOTIFY_LIMITS.perWindow};
  // Optional frequency: {followUpMinutes, windowMinutes, perWindow}. Unknown keys or out-of-range values are an error.
  if(value.frequency!==undefined){
    const frequency=value.frequency;
    if(!frequency||typeof frequency!=='object'||Array.isArray(frequency)
      ||!Object.keys(frequency).every(key=>['followUpMinutes','windowMinutes','perWindow'].includes(key)))return {reason:'frequency'};
    const range=(raw,max)=>raw===undefined||(typeof raw==='number'&&Number.isFinite(raw)&&raw>=1&&raw<=max);
    if(!range(frequency.followUpMinutes,1440)||!range(frequency.windowMinutes,1440)
      ||!(frequency.perWindow===undefined||(Number.isInteger(frequency.perWindow)&&frequency.perWindow>=1&&frequency.perWindow<=50)))return {reason:'frequency'};
    if(frequency.followUpMinutes!==undefined)config.followUpMs=ms(frequency.followUpMinutes);
    if(frequency.windowMinutes!==undefined)config.windowMs=ms(frequency.windowMinutes);
    if(frequency.perWindow!==undefined)config.perWindow=frequency.perWindow;
  }
  // An unusable `text` never turns notices off: the default text is used and
  // the caller is told why (textReason), so a typo cannot silence notices.
  // Optional layout: "full" (default) or "compact" (project, session, reason only).
  if(value.layout!==undefined){
    if(!['full','compact'].includes(value.layout))return {reason:'layout'};
    if(value.layout==='compact')config.layout='compact';
  }
  if(value.text===undefined)return {config};
  const text=normalizeNotifyText(value.text);
  if(text.reason)return {config,textReason:text.reason};
  return {config:{...config,text:text.text}};
}

// The runtime reads notify.json through the same safe boundary as /cm:notify
// (readRegularFileSync in notify-safe-read.mjs, a side-effect-free twin of the
// sender's reader; a drift test keeps the two identical): never through a
// symlink, only a regular file of at most 64 KiB, opened without blocking (a
// FIFO is refused, never waited on), and the opened handle must be the checked
// file. Still synchronous and never throws.
const UNSAFE_READ={permission:'not_regular_file',too_large:'too_large'};

// null = feature off. Under `node --test` only an explicit CM_WORKFLOW_HOME
// enables it, so a test suite never reaches the user's real configuration.
// An invalid file is reported in notify.log only, never on workflow output.
export function readNotifyConfig(env=process.env){
  if(env.NODE_TEST_CONTEXT&&!env.CM_WORKFLOW_HOME)return null;
  const file=path.join(notifyHome(env),'notify.json');
  let raw;
  try{raw=readRegularFileSync(file,'notify.json',{bytes:true}).toString('utf8');}
  catch(error){if(error?.state!=='missing')warn(env,`unreadable_${UNSAFE_READ[error?.reason]??'error'}`);return null;}
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
// The last two path segments: "app" alone does not say which project.
const projectName=value=>{
  if(typeof value!=='string'||!value)return '';
  const base=path.basename(value),parent=path.basename(path.dirname(value));
  return clean(parent&&parent!=='.'&&parent!==base&&path.dirname(value)!==value?`${parent}/${base}`:base,48);
};
// The session the host was started for: the value of --host-context (a UUID
// is shortened to its first 8 characters). Printed by the driver so the
// notice can be matched to the session that has to act.
const SESSION_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function notifySessionLabel(args=[]){
  const list=Array.isArray(args)?args.map(String):[];
  const at=list.indexOf('--host-context'),raw=at>=0?list[at+1]:null;
  if(typeof raw!=='string'||!raw||raw.startsWith('--'))return null;
  return SESSION_UUID.test(raw)?raw.slice(0,8).toLowerCase():clean(raw,24)||null;
}
// The title the person sees for the Claude Code session that runs this
// process (its sidebar name): the last custom-title (else ai-title) record in
// the tail of <claude config>/projects/*/<CLAUDE_CODE_SESSION_ID>.jsonl. Only
// the last 1 MiB is read. Static links (a linked project directory or
// transcript) and replacements the re-checks below can see are refused; see
// the known limit there for concurrent swaps. Under node --test only an
// explicit CM_NOTIFY_CLAUDE_PROJECTS directory is read. null when unknown.
const TITLE_TAIL_BYTES=1024*1024;
const TITLE_DIR_LIMIT=2000;
export function sessionTitle(env=process.env){
  try{
    const id=env.CLAUDE_CODE_SESSION_ID;
    if(typeof id!=='string'||!SESSION_UUID.test(id))return null;
    const projects=env.CM_NOTIFY_CLAUDE_PROJECTS||(env.NODE_TEST_CONTEXT?null
      :path.join(env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects'));
    if(!projects)return null;
    // The projects root may itself be a link (a moved config directory); the
    // project directories below it and the transcript must not be.
    const dirs=fs.readdirSync(projects,{withFileTypes:true}).filter(entry=>entry.isDirectory()).slice(0,TITLE_DIR_LIMIT);
    const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
    for(const dir of dirs){
      const folder=path.join(projects,dir.name),file=path.join(folder,`${id}.jsonl`);
      let before,stat;
      try{before=fs.lstatSync(folder);stat=fs.lstatSync(file);}catch{continue;}
      if(!before.isDirectory()||!stat.isFile())continue;
      const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
      try{
        // Node has no openat: re-check after opening. The project directory
        // must still be the same real directory, and the transcript path must
        // still name the opened regular file; a directory swapped for a link
        // (or swapped and restored) around the open fails one of these.
        // Known limit: repeated swaps between these checks are not covered.
        // Whoever can swap this directory can already write the transcript
        // (and so its title) directly; the checks only keep static links,
        // FIFOs and simple replacements out.
        const opened=fs.fstatSync(fd);
        let after,again;try{after=fs.lstatSync(folder);again=fs.lstatSync(file);}catch{return null;}
        if(!opened.isFile()||!same(opened,stat)||!after.isDirectory()||!same(after,before)||!same(again,opened))return null;
        const length=Math.min(opened.size,TITLE_TAIL_BYTES),buffer=Buffer.alloc(length);
        fs.readSync(fd,buffer,0,length,opened.size-length);
        let custom=null,ai=null;
        for(const line of buffer.toString('utf8').split('\n')){
          if(!line.includes('-title"'))continue;
          let row;try{row=JSON.parse(line);}catch{continue;}
          if(row?.type==='custom-title'&&typeof row.customTitle==='string')custom=row.customTitle;
          if(row?.type==='ai-title'&&typeof row.aiTitle==='string')ai=row.aiTitle;
        }
        return clean(custom??ai??'',40)||null;
      }finally{fs.closeSync(fd);}
    }
    return null;
  }catch{return null;}
}
// Without a returned run id, the launch arguments identify the run (the
// driver passes the same arguments to the host it starts).
export const launchRunKey=(args=[])=>`args:${keyHash((Array.isArray(args)?args:[]).map(String).join('\0'))}`;
// One attention record per project and session: stuck, waiting and idle
// notices about the same session are one thing to handle, not three.
export function attentionKeyFor({project,session,workflow,runId}){
  const label=projectName(project)||'-';
  return session?`attn|${label}|${session}`:`attn|${label}|${clean(workflow,24)||'cm'}|${clean(runId,64)||'-'}`;
}

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
export const NOTIFY_TEXT_FIELDS=Object.freeze(['project','workflow','runId','feature','task','stage','code','nextAction','time']);
const TEXT_EVENTS=['done','waiting','idle','idle_waiting','dead','default'];
const TEXT_CAPS=Object.freeze({titlePrefix:16,headline:24,label:12});
const FIELD_CAPS={workflow:24,runId:64,feature:48,task:40,stage:48,code:96,nextAction:200};
export const DEFAULT_NOTIFY_TEXT=Object.freeze({titlePrefix:'CM',
  headlines:Object.freeze({done:'流程已结束',waiting:'等待会话应答',idle:'疑似空转',idle_waiting:'在等你',dead:'宿主已退出未收尾',default:'需要人处理'}),
  // Project is in the title; workflow, feature, task and session in the subtitle.
  fields:Object.freeze({default:Object.freeze(['nextAction','code','time']),
    done:Object.freeze(['nextAction','time'])}),
  labels:Object.freeze({nextAction:'下一步',project:'项目',workflow:'流程',runId:'运行',feature:'功能',task:'任务',stage:'阶段',code:'卡在',time:'时间'})});
// Common stop codes in plain words; the code itself stays in brackets so it can be searched.
const CODE_WORDS=Object.freeze({qa_decision_required:'在等 QA 判定',qa_mandatory_required:'在等必需 QA 判定',
  qa_triggered:'QA 已触发，缺执行器',waiting_session_answer:'在等会话应答',waiting_for_you:'在等你处理',no_next_step:'会话没有发下一步',
  fingerprint_mismatch:'启动参数与创建时不一致',review_blocked:'审查判定无法通过',review_limit:'审查轮次用完',
  host_exited:'宿主中途退出',host_request_unanswered:'宿主请求没人应答',host_response_rejected:'宿主应答被拒绝',
  permission_denied:'权限被拒绝',spec_drift:'规格有改动，需重新批准',awaiting_spec_approval:'在等规格批准',
  blocked:'被阻断',cancelled:'已取消',failed:'失败',interrupted:'被中断',
  checks_not_passed:'检查没通过',develop_checks_not_passed:'开发检查没通过',qa_failed:'QA 没通过',qa_blocked:'QA 被阻断',
  qa_result_blocked:'QA 结果被阻断',qa_execution_unknown:'QA 执行结果不明',project_qa_not_passed:'项目 QA 没通过',
  correction_review_required:'需要重新审查改动',documentation_sync_blocked:'文档同步被阻断',handoff_exists:'交接记录已存在',
  provider_development_authorization_required:'需要你授权外部开发',host_process_gone:'宿主进程已退出',run_done:'跑完了'});
// Codes without an entry: "subject + outcome" from the words in the code, so
// the reason is still in Chinese; null when the code says neither.
const CODE_SUBJECTS=[['qa_fix','QA 修复'],['qa','QA'],['review','审查'],['develop','开发'],['checks','检查'],['check','检查'],
  ['spec','规格'],['documentation','文档'],['batch','批次'],['fix','修复'],['host','宿主'],['bootstrap','初始化'],
  ['permission','权限'],['verification','验证'],['completion','完成'],['scope','范围'],['provider','外部模型']];
const CODE_OUTCOMES=[['not_passed','没通过'],['failed','失败'],['blocked','被阻断'],['authorization_required','要你授权'],
  ['approval_required','要你批准'],['required','要你处理'],['timeout','超时'],['unknown','结果不明'],['interrupted','被中断'],
  ['drift','有改动'],['exhausted','次数用完'],['unavailable','不可用'],['invalid','无效'],['denied','被拒绝'],['cancelled','已取消']];
function codeChinese(code){
  if(!code)return null;
  if(Object.hasOwn(CODE_WORDS,code))return CODE_WORDS[code];
  const outcome=CODE_OUTCOMES.find(([word])=>code===word||code.endsWith(`_${word}`));
  if(!outcome)return null;
  const subject=CODE_SUBJECTS.find(([word])=>code===word||code.startsWith(`${word}_`)||code.includes(`_${word}_`));
  return `${subject?subject[1]:''}${outcome[1]}`;
}
const codeWords=code=>{const value=clean(code,64);if(!value)return '';
  const words=codeChinese(value);return words?`${words}（${value}）`:value;};
// Custom strings first lose every Unicode format character (\p{Cf}: bidi
// controls U+202A-202E, U+2066-2069, U+200E/200F, U+061C; zero-width U+200B-200D,
// U+2060, U+FEFF; soft hyphen, tag characters), so they cannot reorder or hide
// text. Unlike field values, a path is redacted whatever precedes it: every
// span starting at "/", "~/", a drive letter with ":\" or ":/", or a UNC "\\" up to the next
// whitespace or listed punctuation becomes <路径> (so "CI/CD" becomes "CI<路径>").
// Then the usual clean(). Something visible (a letter, digit, punctuation or
// symbol) must remain. Field values and the default text are not touched.
const FORMAT_CHARS=/\p{Cf}+/gu,VISIBLE=/[\p{L}\p{N}\p{P}\p{S}]/u;
const TEXT_PATH=/(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s'"`，。；;、）)]+/g;
const cleanText=(raw,max)=>clean(raw.replace(FORMAT_CHARS,'').replace(/[\u0000-\u001f\u007f-\u009f]+/g,' ').replace(TEXT_PATH,'<路径>'),max);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const onlyKeys=(value,keys)=>Object.keys(value).every(key=>keys.includes(key));
// {text} merged over the default, or {reason}. Idempotent on its own output.
export function normalizeNotifyText(value){
  if(!plain(value))return {reason:'text'};
  if(!onlyKeys(value,['titlePrefix','headlines','fields','labels']))return {reason:'text_key'};
  const text={titlePrefix:DEFAULT_NOTIFY_TEXT.titlePrefix,headlines:{...DEFAULT_NOTIFY_TEXT.headlines},
    fields:{default:[...DEFAULT_NOTIFY_TEXT.fields.default],done:[...DEFAULT_NOTIFY_TEXT.fields.done]},labels:{...DEFAULT_NOTIFY_TEXT.labels}};
  // A custom string must still show something after cleaning; only the prefix
  // may be given as exactly "" (no prefix).
  const word=(raw,max,empty=false)=>{
    if(typeof raw!=='string')return null;if(empty&&raw==='')return '';
    const cleaned=cleanText(raw,max);return VISIBLE.test(cleaned)?cleaned:null;};
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
export function buildNotifyMessage(fields,{now=Date.now(),timeZone,text,followUp=false,suppressed=0,layout='full'}={}){
  const spec=text===undefined||text===null?DEFAULT_NOTIFY_TEXT:normalizeNotifyText(text).text??DEFAULT_NOTIFY_TEXT;
  const workflow=clean(fields.workflow,24)||'cm',project=projectName(fields.project);
  const event=Object.hasOwn(spec.headlines,fields.event)&&fields.event!=='default'?fields.event:'default';
  if(layout==='compact'){
    // Only which project, which session and why it stopped. A code without a
    // plain-words entry falls back to the event headline; the code itself stays
    // in the stdin JSON for anyone who needs it.
    const session=clean(fields.sessionTitle,40)||clean(fields.session,24),code=clean(fields.code,64);
    const reason=(event!=='done'&&codeChinese(code))||spec.headlines[event];
    const lines=[`${followUp?'第 2 次：':''}${reason}`];
    if(Number.isSafeInteger(suppressed)&&suppressed>0)lines.push(`另有 ${suppressed} 条提醒已合并`);
    return {title:cut(project||workflow,NOTIFY_LIMITS.titleChars),subtitle:session?`会话：${session}`:workflow,
      body:cut(lines.join('\n'),NOTIFY_LIMITS.bodyChars)};
  }
  const head=[spec.titlePrefix,spec.headlines[event]].filter(Boolean).join(' ');
  const title=cut(`${head}${project?` · ${project}`:''}`,NOTIFY_LIMITS.titleChars);
  const feature=clean(fields.feature,FIELD_CAPS.feature),task=clean(fields.task,FIELD_CAPS.task);
  const session=clean(fields.sessionTitle,40)||clean(fields.session,24);
  // The session is what says where to act: it is kept whole and the rest is shortened first.
  const sessionPart=session?` · 会话 ${session}`:'',rest=[workflow,[feature,task].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const subtitle=cut(rest,Math.max(1,NOTIFY_LIMITS.titleChars-Array.from(sessionPart).length))+sessionPart;
  const value=name=>name==='time'?localClock(now,timeZone):name==='project'?project:name==='workflow'?workflow
    :name==='code'?codeWords(fields.code):clean(fields[name],FIELD_CAPS[name]);
  const rows=spec.fields[fields.event==='done'?'done':'default'].map(name=>[spec.labels[name],value(name)]);
  const lines=rows.filter(([,value])=>value).map(([label,value])=>`${label}：${value}`);
  if(followUp)lines.unshift('第 2 次提醒：上次提醒后仍未处理');
  if(Number.isSafeInteger(suppressed)&&suppressed>0)lines.push(`另有 ${suppressed} 条提醒为避免刷屏已合并，请一并查看各会话`);
  return {title,subtitle,body:cut(lines.join('\n'),NOTIFY_LIMITS.bodyChars)};
}

const keyHash=key=>createHash('sha256').update(key).digest('hex').slice(0,16);

// Cross-process lock without any waiting. The lock file is published complete
// (written to a temp file, then hard-linked into place, which fails if a lock
// exists). A busy lock skips the notice at once. A stale lock (owner gone or
// older than 30 s; the critical section takes milliseconds) is reclaimed only
// by renaming it to a unique name and confirming it is byte-identical to the
// stale lock that was judged; anything else is put back and the notice skipped.
// Bounded read of a control file we may not own. lstat first: a symlink (even a
// dangling one, and even where O_NOFOLLOW is 0 as on Windows), a non-regular
// file or an oversized file never counts as readable. The descriptor is opened
// without following links and without blocking (a FIFO cannot stall the host),
// and must be the same inode lstat saw. Returns {missing:true} only for ENOENT;
// every other trouble returns null, which skips the notice.
function readBounded(file,limit){
  let before;
  try{before=fs.lstatSync(file);}catch(error){return error.code==='ENOENT'?{missing:true}:null;}
  if(before.isSymbolicLink()||!before.isFile()||before.size>limit)return null;
  let descriptor=null;
  try{
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const info=fs.fstatSync(descriptor);
    if(!info.isFile()||info.size>limit||info.dev!==before.dev||info.ino!==before.ino)return null;
    const buffer=Buffer.alloc(info.size);
    let offset=0;while(offset<info.size){const n=fs.readSync(descriptor,buffer,offset,info.size-offset,offset);if(n===0)break;offset+=n;}
    return {text:buffer.subarray(0,offset).toString('utf8')};
  }catch{return null;}
  finally{if(descriptor!==null)try{fs.closeSync(descriptor);}catch{}}
}
function readLock(file){const read=readBounded(file,CONTROL_FILE_LIMIT);return read===null||read.missing?null:read.text;}
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
// Attention levels: idle < waiting/stuck. A higher level, or a stuck notice
// with a different code, is a new state and is sent at once; the same state
// is sent once more after followUpMs and then not again until it changes or
// the record expires (attentionTtlMs). A notice over the window limit is not
// sent but counted, and the next sent notice says how many were merged.
const ATTENTION_LEVEL=Object.freeze({idle:1,waiting:2,idle_waiting:2,stuck:2});
function readState(home){
  const read=readBounded(path.join(home,'notify-state.json'),CONTROL_FILE_LIMIT);if(read===null)return null;
  if(read.missing)return {version:2,keys:{},attention:{},sends:[],suppressed:0};
  let state;try{state=JSON.parse(read.text);}catch{return null;}
  if(!state||![1,2].includes(state.version)||!state.keys||typeof state.keys!=='object'||Array.isArray(state.keys)
    ||!Array.isArray(state.sends)||!state.sends.every(Number.isFinite)
    ||!Object.values(state.keys).every(Number.isFinite))return null;
  if(state.version===1)return {version:2,keys:state.keys,attention:{},sends:state.sends,suppressed:0};
  const record=item=>item&&typeof item==='object'&&Number.isInteger(item.level)&&Number.isInteger(item.count)
    &&Number.isFinite(item.lastAt)&&(item.code===null||typeof item.code==='string');
  if(!state.attention||typeof state.attention!=='object'||Array.isArray(state.attention)
    ||!Object.values(state.attention).every(record)||!Number.isSafeInteger(state.suppressed)||state.suppressed<0)return null;
  return state;
}
function writeState(home,state){
  const stateFile=path.join(home,'notify-state.json'),temp=`${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,stateFile);return true;}
  catch{try{fs.unlinkSync(temp);}catch{}return false;}
}
function withState(home,update){
  const lockFile=path.join(home,'notify-state.lock');
  const lock=takeLock(lockFile);if(lock===null)return {status:'state_busy'};
  try{
    const state=readState(home);if(state===null)return {status:'state_invalid'};
    return update(state);
  }finally{releaseLock(lockFile,lock);}
}
function reserve(home,{hash,attention=null,event,code=null},now,limits){
  return withState(home,state=>{
    const keys=Object.fromEntries(Object.entries(state.keys).filter(([,at])=>now-at<NOTIFY_LIMITS.sameKeyMs&&at<=now));
    const sends=state.sends.filter(at=>now-at<24*3600*1000&&at<=now);
    const records=Object.fromEntries(Object.entries(state.attention).filter(([,item])=>now-item.lastAt<NOTIFY_LIMITS.attentionTtlMs&&item.lastAt<=now));
    let followUp=false,next=null;
    if(attention===null){if(Object.hasOwn(keys,hash))return {status:'duplicate'};}
    else{
      const level=ATTENTION_LEVEL[event]??2,record=records[attention];
      const changed=!record||level>record.level||(event==='stuck'&&code&&code!==record.code);
      if(changed)next={level,code:event==='stuck'?code:(record?.code??null),count:1,lastAt:now};
      else if(record.count===1&&now-record.lastAt>=limits.followUpMs){followUp=true;next={...record,count:2,lastAt:now};}
      else return {status:'duplicate'};
    }
    const persist=extra=>writeState(home,{version:2,keys,attention:records,sends,suppressed:state.suppressed,...extra});
    if(sends.filter(at=>now-at<limits.windowMs).length>=limits.perWindow||sends.length>=NOTIFY_LIMITS.perDay){
      const status=sends.length>=NOTIFY_LIMITS.perDay?'rate_day':'rate_window';
      return persist({suppressed:state.suppressed+1})?{status}:{status:'state_write_failed'};
    }
    if(attention===null)keys[hash]=now;else records[attention]=next;
    sends.push(now);
    return persist({suppressed:0})?{status:'ok',followUp,suppressed:state.suppressed}:{status:'state_write_failed'};
  });
}

// A real step forward ends the attention record, so the next stop is sent at
// once. Only a record from before the step (lastAt <= before) is removed: a
// newer stop recorded meanwhile stays. A busy lock is retried a few times;
// a clear that still fails is logged, never silently dropped.
export async function clearAttention(attentionKey,{env=process.env,before=Date.now(),attempts=10,delayMs=100}={}){
  try{
    if(typeof attentionKey!=='string'||!attentionKey||!readNotifyConfig(env))return false;
    const home=notifyHome(env),hash=keyHash(attentionKey);
    for(let attempt=1;;attempt++){
      const result=withState(home,state=>{
        const record=state.attention[hash];
        if(!record||record.lastAt>before)return {status:'unchanged'};
        const attention={...state.attention};delete attention[hash];
        return writeState(home,{...state,version:2,attention})?{status:'ok'}:{status:'state_write_failed'};
      });
      if(result.status==='ok')return true;
      if(result.status==='unchanged')return false;
      if(result.status!=='state_busy'||attempt>=attempts){
        appendNotifyLog(home,Date.now(),{event:'clear',hash,result:`failed ${result.status}`});return false;
      }
      await new Promise(resolve=>setTimeout(resolve,delayMs));
    }
  }catch{return false;}
}

const LEVEL_OF=Object.freeze({done:'passive',idle:'active'});
// Never throws and never waits. Returns {sent, reason}; sent means the command
// was handed to the detached launcher, whose own failures go to notify.log.
export function notify(fields,{env=process.env,now=Date.now(),timeoutMs=NOTIFY_LIMITS.commandTimeoutMs}={}){
  try{
    const config=readNotifyConfig(env);if(!config)return {sent:false,reason:'off'};
    if(typeof fields?.key!=='string'||!fields.key)return {sent:false,reason:'invalid_key'};
    const home=notifyHome(env),hash=keyHash(fields.key),event=fields.event??'stuck',workflow=clean(fields.workflow,24)||'cm';
    const attention=typeof fields.attentionKey==='string'&&fields.attentionKey&&Object.hasOwn(ATTENTION_LEVEL,event)
      ?keyHash(fields.attentionKey):null;
    const reserved=reserve(home,{hash,attention,event,code:clean(fields.code,64)||null},now,config);
    if(reserved.status!=='ok'){
      if(reserved.status!=='duplicate')appendNotifyLog(home,now,{event,workflow,hash,result:`skipped ${reserved.status}`});
      return {sent:false,reason:reserved.status};
    }
    if(fields.sessionTitle===undefined)fields={...fields,sessionTitle:sessionTitle(env)};
    const message=buildNotifyMessage(fields,{now,text:config.text,layout:config.layout,followUp:reserved.followUp,suppressed:reserved.suppressed});
    const payload={...message,event};
    for(const name of ['project','workflow','runId','feature','task','stage','code','nextAction','session','sessionTitle']){
      const value=name==='project'?projectName(fields.project):clean(fields[name],name==='nextAction'?200:64);
      if(value)payload[name]=value;
    }
    const group=projectName(fields.project)||'CM',level=LEVEL_OF[event]??'timeSensitive';
    const child=spawn(process.execPath,[RUNNER,home,hash,event,workflow,String(timeoutMs),'--',...config.command],
      {detached:true,stdio:'ignore',windowsHide:true,
        env:{...env,CM_NOTIFY_TITLE:message.title,CM_NOTIFY_SUBTITLE:message.subtitle,CM_NOTIFY_BODY:message.body,
          CM_NOTIFY_GROUP:group,CM_NOTIFY_LEVEL:level,CM_NOTIFY_PAYLOAD:JSON.stringify(payload)}});
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
      stage:text(result.stage)??text(result.state)??text(result.status)??null,
      // The session that started this host, so a later patrol can name it.
      sessionTitle:sessionTitle(env)};
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
// A host that is still waiting re-sends once followUpMs after its first notice
// (reserve() decides whether it is due); answering or ending the session
// cancels it. A driver that already exited has no process left to do this.
function armed(delay,fire,config){
  let follow=null;
  const timer=setTimeout(()=>{fire();follow=setTimeout(fire,config.followUpMs);follow.unref?.();},delay);
  timer.unref?.();
  return ()=>{clearTimeout(timer);if(follow)clearTimeout(follow);};
}
export function scheduleWaitNotice({kind,callId,workflow,project,args=process.argv.slice(2),session=notifySessionLabel(args),env=process.env}){
  try{
    const config=readNotifyConfig(env);if(!config)return null;
    // A check request is answered only after the session has run the project's
    // check commands (xcodebuild, test suites), which normally take tens of
    // minutes; waiting that long is not idleness, so it uses its own threshold.
    const waitMs=CHECK_KINDS.has(kind)?config.checkWaitMs:config.waitMs;
    const minutes=Math.max(1,Math.round(waitMs/60000));
    return armed(waitMs,()=>notify({key:`wait|${workflow}|${callId}`,event:'waiting',workflow,project,stage:kind,session,
      attentionKey:attentionKeyFor({project,session,workflow,runId:launchRunKey(args)}),
      code:'waiting_session_answer',nextAction:`宿主已等待会话应答约 ${minutes} 分钟，请回到会话处理`},{env}),config);
  }catch{return null;}
}

// Host side: one notice when an operation has replied, nothing is in flight
// and the session has not sent the next operation for idleMinutes (polls excluded). A last
// result that already waits on a person (or ended the run) says so instead of
// "idle". Built only from that result's structured fields; the timer never
// keeps the process alive.
export function scheduleIdleNotice({workflow,project,sessionKey,seq,row,since=Date.now(),args=process.argv.slice(2),session=notifySessionLabel(args),env=process.env}){
  try{
    const config=readNotifyConfig(env);if(!config)return null;
    // `since` is the last real reply: re-arming after a poll keeps that deadline.
    const delay=Math.max(1,Math.min(config.idleMs,config.idleMs-(Date.now()-since)));
    const minutes=Math.max(1,Math.round(config.idleMs/60000));
    const kind=classifyDriveResult(workflow,row),result=obj(row?.result);
    const runId=text(result.identity?.runId)??text(result.runId)??text(result.batchId);
    const task=text(result.identity?.taskId)??text(result.taskId),feature=text(result.feature);
    const stage=text(result.stage)??text(result.state)??text(result.status);
    const nextAction=kind==='done'?`流程已结束，宿主仍开着约 ${minutes} 分钟没有下一步，请回到会话收尾或开始下一项`
      :kind==='stuck'?`上一步停在需要你处理的状态，约 ${minutes} 分钟没有下一步，请回到会话处理`
      :`上一步已结束约 ${minutes} 分钟，会话没有发下一步，请回到会话查看`;
    return armed(delay,()=>notify({key:`idle|${workflow}|${sessionKey}|${seq}`,event:kind?'idle_waiting':'idle',
      workflow,project,runId,feature,task,stage,session,attentionKey:attentionKeyFor({project,session,workflow,runId:runId??launchRunKey(args)}),
      code:kind?'waiting_for_you':'no_next_step',nextAction},{env}),config);
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
const AI_STUCK_CODES=new Set(['permission_denied','provider_development_authorization_required',
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
  const run=runId??launchRunKey(args);
  const project=cwd?path.resolve(cwd):null,session=notifySessionLabel(args),feature=text(result.feature)??text(result.identity?.feature);
  return {key:[workflow,run,task??'',attempt??'',stage??'',done?'done':code??''].join('|'),
    ...(done?{}:{attentionKey:attentionKeyFor({project,session,workflow,runId:run})}),
    event:kind,workflow,project,runId,feature,task,stage,session,
    code:done?(text(result.code)??text(result.overall)??text(nested.overall)??'done'):code,
    // A finished unit is the natural point to start a fresh session (runtime/model-efficiency.md).
    nextAction:done?'会话边界：换新会话，下一项在新会话里运行':text(result.guidance?.nextStep)??text(progress.nextAction)??text(result.nextAction)};
}

// The attention record a successful, non-read-only step clears (see clearAttention).
export function driveProgressKey({host,cwd,args=[],operation,row=null,failure=null}){
  if(READ_ONLY.has(operation)||failure||row?.error)return null;
  const workflow=path.basename(String(host??'')).replace(/-host\.mjs$/,'').replace(/\.mjs$/,'')||'cm';
  if(classifyDriveResult(workflow,row))return null;
  const result=obj(row?.result),runId=text(result.identity?.runId)??text(result.runId)??text(result.batchId);
  // Same fallback as driveNotice: without a returned run, the launch arguments identify it.
  const run=runId??launchRunKey(args);
  return attentionKeyFor({project:cwd?path.resolve(cwd):null,session:notifySessionLabel(args),workflow,runId:run});
}

// One stderr line telling which project and session this driver's notices name.
export function notifyIdentityLine({cwd,args=[]},{env=process.env}={}){
  try{
    if(!readNotifyConfig(env))return null;
    const project=projectName(cwd?path.resolve(cwd):''),session=sessionTitle(env)??notifySessionLabel(args);
    return `提醒里的标识：项目 ${project||'-'}${session?` · 会话 ${session}`:''}`;
  }catch{return null;}
}
