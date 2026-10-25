#!/usr/bin/env node
// Skill hints: a UserPromptSubmit hook for Claude Code and Codex that matches the
// user's message against a keyword table and shows the user at most two fitting
// skills. Most rules only hint; the few marked `invoke` start an author skill instead
// (see "Auto-invoke" below).
//
// The hint goes to the user directly (`systemMessage`), not to the model: real
// sessions showed a model told "mention it only if it fits" left even clear cases
// out (2026-10-24). Shown directly, it is always seen and costs no context.
//
// Decided 2026-10-23 (方案-技能提醒): keywords not AI, so nothing leaves the machine
// and no tokens are spent; the CM table ships here, the user's own table lives in
// ~/.cm-workflow/skill-hints.local.json and wins; the log keeps rule ids and times,
// never message text. Any error exits quietly so a message is never held up.
// Wiring is on by default (decided 2026-10-25): each installer runs `install --host <its
// host>`, which adds the hook once per host and otherwise only refreshes the copy the hook
// runs. It never wires against the user's choice: --no-skill-hints,
// CM_SKILL_HINTS_INSTALL=off, "enabled": false, or a hook the user removed after it was
// there (see "settled hosts" below). `enable` still adds the hook by hand.
//
// Auto-invoke, decided 2026-10-25 (方案-技能自动调用): author skills the model cannot
// start itself (`disable-model-invocation`) get a rule with `invoke`. When one fits, the
// hook tells the model to read that skill's SKILL.md and follow it (mode "direct"), or to
// ask the user first (mode "ask"), and shows the user one line saying so. Whether it fits
// is judged by Jev when a TypeSafe key exists (cm-skill-judge.mjs: first 500 characters
// only, never a message that looks like it holds a secret, 3 seconds at most), else and
// on any Jev failure by the rule's keywords. Only the pinned author version is started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SCRIPT_NAME='cm-skill-hints.mjs';
export const RULES_NAME='cm-skill-hints.json';
export const LOCAL_NAME='skill-hints.local.json';
export const AUTO_NAME='skill-hints.auto.json';
// Copied together into ~/.cm-workflow/skill-hints so the hook runs without the CM tree.
// They are written before the script itself, so a failed copy leaves the old script.
const COMPANIONS=['cm-matt-skills.mjs','cm-config-lock.mjs','cm-skill-judge.mjs',RULES_NAME];
export const MAX_PROMPT=2000;
export const MAX_HINTS=2;
export const ADOPT_WINDOW=5;
export const LOG_LIMIT=1024*1024;
export const PATTERN_BUDGET_MS=200;
const MAX_READ=1024*1024;
const HOSTS=['claude','codex'];
const SKILL_NAME=/^[\w.:-]+$/;
const INVOKE_MODES=['direct','ask'];

const homeOf=env=>env.HOME||os.homedir();
export const cmHome=env=>path.resolve(env.CM_WORKFLOW_HOME||path.join(homeOf(env),'.cm-workflow'));
export const logFile=env=>path.join(path.resolve(env.CM_WORKFLOW_LOG_HOME||path.join(cmHome(env),'logs')),'skill-hints.jsonl');
export const localPath=env=>path.join(cmHome(env),LOCAL_NAME);
export const installDir=env=>path.join(cmHome(env),'skill-hints');
export const autoPath=env=>path.join(cmHome(env),AUTO_NAME);
export const claudeSettingsPath=env=>path.join(path.resolve(env.CLAUDE_HOME||path.join(homeOf(env),'.claude')),'settings.json');
export const codexHooksPath=env=>path.join(path.resolve(env.CODEX_HOME||path.join(homeOf(env),'.codex')),'hooks.json');
const here=path.dirname(fileURLToPath(import.meta.url));
export const defaultRulesPath=()=>path.join(here,RULES_NAME);

// An author skill counts only when it is the pinned author version (same contract as
// cm-matt-skills: a same-named skill with other content is not it). Checked lazily,
// only for rules that matched, and only in the current host's skills directory.
// The checker is loaded inside the hook's quiet boundary; if it cannot be loaded,
// no author skill counts as installed and CM counterparts are hinted instead.
export async function loadAuthorCheck(specifier='./cm-matt-skills.mjs'){
  try{
    const {SKILLS,UPSTREAM,skillState,skillRoots}=await import(new URL(specifier,import.meta.url).href);
    return {skills:SKILLS,license:UPSTREAM.license.sha256,skillState,skillRoots};
  }catch{return null;}
}
export function isAuthorInstalled(name,host,env,check){
  const skill=check?.skills.find(item=>item.name===name);
  const root=check?.skillRoots(env).find(item=>item.runtime===host)?.root;
  return Boolean(skill&&root)&&check.skillState(root,skill,check.license)==='author';
}
export const mention=(skill,host)=>`${host==='codex'?'$':'/'}${skill}`;
// Loaded like the author checker: if it cannot be loaded, every invoke rule uses keywords.
export async function loadJudge(specifier='./cm-skill-judge.mjs'){
  try{return await import(new URL(specifier,import.meta.url).href);}catch{return null;}
}

// Only a regular file of bounded size is read: a FIFO or device at one of these
// paths would otherwise block the hook. `allowEmpty` is for CM's own files; a host
// config that is empty is not valid JSON and is reported, never rewritten.
export function readJson(file,{allowEmpty=false}={}){
  let text;
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile())return {error:'not-file'};
    if(st.size>MAX_READ)return {error:'too-large'};
    text=fs.readFileSync(file,'utf8');
  }catch(error){if(error.code==='ENOENT')return {missing:true};return {error:error.code||'read'};}
  if(!text.trim())return allowEmpty?{value:{},text}:{error:'empty'};
  try{return {value:JSON.parse(text),text};}catch{return {error:'parse'};}
}

const strings=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'&&item.trim()):[];
export function normalizeRule(rule,user){
  if(!rule||typeof rule!=='object'||typeof rule.skill!=='string'||!SKILL_NAME.test(rule.skill))return null;
  const keywords=strings(rule.keywords).map(word=>word.toLowerCase());
  const patterns=strings(rule.patterns).flatMap(source=>{try{return [new RegExp(source,'i')];}catch{return [];}});
  if(!keywords.length&&!patterns.length)return null;
  const fallback=rule.fallback&&typeof rule.fallback.skill==='string'&&SKILL_NAME.test(rule.fallback.skill)
    ?{skill:rule.fallback.skill,reason:String(rule.fallback.reason??'')}:null;
  // Starting a skill is for CM's own author rules only; a user rule never gets it.
  const invoke=!user&&rule.author===true&&INVOKE_MODES.includes(rule.invoke?.mode)&&typeof rule.invoke.when==='string'&&rule.invoke.when.trim()
    ?{mode:rule.invoke.mode,when:rule.invoke.when,...(typeof rule.invoke.near==='string'&&rule.invoke.near.trim()?{near:rule.invoke.near}:{})}:null;
  return {id:typeof rule.id==='string'&&rule.id?rule.id:`${user?'user':'cm'}:${rule.skill}`,skill:rule.skill,
    reason:String(rule.reason??''),author:rule.author===true,fallback,keywords,patterns,user,invoke};
}

// User rules come first so they win a tie. A user rule with a CM rule's id replaces
// it, and `disable` switches CM rules off by id. A broken local file is ignored (the
// CM table still works) and reported by `status`.
export function loadRules({env=process.env,rulesFile=defaultRulesPath()}={}){
  const local=readJson(localPath(env),{allowEmpty:true});
  const settings=local.value&&typeof local.value==='object'&&!Array.isArray(local.value)?local.value:{};
  if(settings.enabled===false)return {enabled:false,rules:[]};
  const defaults=readJson(rulesFile,{allowEmpty:true});
  const user=(Array.isArray(settings.rules)?settings.rules:[]).map(rule=>normalizeRule(rule,true)).filter(Boolean);
  const disabled=new Set(strings(settings.disable));
  const replaced=new Set(user.map(rule=>rule.id));
  const cm=(Array.isArray(defaults.value?.rules)?defaults.value.rules:[])
    .map(rule=>normalizeRule(rule,false)).filter(rule=>rule&&!disabled.has(rule.id)&&!replaced.has(rule.id));
  return {enabled:true,rules:[...user,...cm],judge:settings.judge!==false,localError:local.error??null,defaultsError:defaults.error??(defaults.missing?'missing':null),
    userCount:user.length,disabledCount:disabled.size,cmCount:cm.length};
}

// Pasted logs and code are where stray keywords live, so fenced blocks never match.
export const stripCode=text=>text.replace(/```[\s\S]*?(?:```|$)/g,' ');

// A user regex can backtrack for minutes; it runs in a context with a hard time
// budget, and on timeout no pattern counts as matched (keywords still do).
export function patternMatches(rules,text,budget=PATTERN_BUDGET_MS){
  const lists=rules.map(rule=>rule.patterns);
  if(!lists.some(list=>list.length))return lists.map(()=>false);
  try{
    return vm.runInNewContext('lists.map(list=>list.some(pattern=>pattern.test(text)))',{lists,text},{timeout:budget});
  }catch{return lists.map(()=>false);}
}

// An author skill that is not installed falls back to its CM counterpart, or is dropped.
function resolve(rule,host,env,authorCheck){
  if(rule.user||!rule.author||isAuthorInstalled(rule.skill,host,env,authorCheck))return {rule:rule.id,skill:rule.skill,reason:rule.reason};
  return rule.fallback?{rule:rule.id,skill:rule.fallback.skill,reason:rule.fallback.reason}:null;
}

// `/name` or `$name` as a whole token: not `/cm-fix-extra`, not the tail of a URL or
// path. It must start the message or follow whitespace or an opening/separating
// punctuation mark or a backtick; a letter of any script before it (as in `文档/cm-fix`)
// does not count.
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const BEFORE='(?<=^|[\\s`(\\[{<"\'“‘（【「『《，。、；：！？,;!?])';
export const typed=(prompt,skill,host)=>
  new RegExp(`${BEFORE}${escape(mention(skill,host))}(?![\\w.:/-])`,'i').test(prompt);

// Which rules' keywords or patterns occur in the message (fenced code left out).
export function keywordHits(rules,prompt){
  const text=stripCode(prompt.toLowerCase());
  const byPattern=patternMatches(rules,text);
  return rules.map((rule,index)=>rule.keywords.some(word=>text.includes(word))||byPattern[index]);
}

export function pickHints({prompt,rules,host,env,hinted=[],authorCheck=null}){
  const lower=prompt.toLowerCase();
  const hits=keywordHits(rules,prompt);
  const picked=[];
  for(const [index,rule] of rules.entries()){
    if(picked.length>=MAX_HINTS)break;
    if(!hits[index])continue;
    const hint=resolve(rule,host,env,authorCheck);
    if(!hint||hinted.includes(hint.skill)||picked.some(item=>item.skill===hint.skill))continue;
    // The user already typed or named it: nothing to remind.
    if(lower.includes(hint.skill.toLowerCase()))continue;
    picked.push(hint);
  }
  return picked;
}

// Per-session state: skills already hinted, and hints still waiting to be adopted.
const statePath=(env,session)=>path.join(installDir(env),'state',
  `${crypto.createHash('sha256').update(String(session)).digest('hex').slice(0,16)}.json`);
function readState(file){
  const read=readJson(file,{allowEmpty:true}).value;
  return {hinted:strings(read?.hinted),pending:Array.isArray(read?.pending)?read.pending.filter(item=>
    item&&typeof item.skill==='string'&&typeof item.rule==='string'&&Number.isInteger(item.left)):[]};
}
// Replace by rename of a freshly created file, so a link planted at the path is never written through.
function writeAtomic(file,text,{before}={}){
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{
    fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});
    before?.();
    fs.renameSync(temporary,file);
  }finally{try{fs.unlinkSync(temporary);}catch{/* 已改名或未创建 */}}
}

// Rule id, skill, host and time only: the message itself is never written.
// A log path that is not a regular file is left alone (appending could block).
export function appendLog(env,record){
  const file=logFile(env);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile())return;
    if(st.size>LOG_LIMIT){
      const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
      writeAtomic(file,lines.slice(Math.ceil(lines.length/2)).join('\n')+'\n');
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  fs.appendFileSync(file,JSON.stringify(record)+'\n',{mode:0o600});
}

// ---- auto-invoke ----

// A message that opens with a command (`/grill-me …`, `$handoff`) already names its
// skill: the host runs it, so nothing is judged or added.
export const opensWithCommand=prompt=>/^\s*[/$][\w.:-]+(?:\s|$)/.test(prompt);
export const skillFile=(skill,host,env,check)=>
  path.join(check.skillRoots(env).find(item=>item.runtime===host).root,skill,'SKILL.md');

// What the model is told. The "direct" wording is the one the 2026-10-25 gate test
// measured (5 of 5 sessions read the file first and followed it).
export function invokeContext({skill,mode,reason},file,host){
  const read=host==='claude'?`先用 Read 工具读取 ${file}`:`先读取文件 ${file}`;
  if(mode==='direct')return `[CM 技能提醒] 这条消息属于作者技能 ${skill} 的场景。请${read}，再严格按其中的步骤执行（该技能不能用 Skill 工具调起，必须读文件照做）。`;
  return `[CM 技能提醒] 这条消息可能适合用作者技能 ${skill}（${reason}）。作者把它设为手动调用，因为它动静较大，所以请先用一句话问用户要不要用它，别的什么都先不做。用户同意后，${read.slice(1)}，再严格按其中的步骤执行；用户不同意就照常回答。`;
}
export const invokeLine=({skill,mode},host)=>mode==='direct'
  ?`🤖 技能自动调用：已让模型用 ${mention(skill,host)}`
  :`🤖 技能自动调用：已让模型先问你要不要用 ${mention(skill,host)}`;

// The invoke rule to start for this message, or null. Jev decides when it answered;
// keywords decide when it could not (no key, secret, timeout, error, switched off).
export async function pickInvoke({prompt,rules,host,env,authorCheck,judgeModule,useJudge=true,judgeOptions={}}){
  const candidates=rules.filter(rule=>rule.invoke&&isAuthorInstalled(rule.skill,host,env,authorCheck));
  if(!candidates.length||opensWithCommand(prompt))return {rule:null,candidates};
  let verdict={error:useJudge?'no-judge':'off'};
  if(useJudge&&judgeModule){
    verdict=await judgeModule.judge({prompt,env,...judgeOptions,
      choices:candidates.map(rule=>({skill:rule.skill,when:rule.invoke.when,near:rule.invoke.near}))});
  }
  if(!verdict.error)return {rule:candidates.find(rule=>rule.skill===verdict.skill)??null,via:'jev',candidates};
  const hits=keywordHits(candidates,prompt);
  return {rule:candidates.find((rule,index)=>hits[index])??null,via:'keyword',error:verdict.error,candidates};
}

export const messageText=(hints,host)=>
  hints.map(hint=>`💡 技能提醒：可以试 ${mention(hint.skill,host)}——${hint.reason}`).join('\n');

export async function hook(input,{env=process.env,host='claude',rulesFile=defaultRulesPath(),now=Date.now(),loadAuthor=loadAuthorCheck,
  loadJudgeModule=loadJudge,judgeOptions={}}={}){
  if(env.CM_SKILL_HINTS==='off'||!HOSTS.includes(host))return '';
  const prompt=typeof input?.prompt==='string'?input.prompt:'';
  if(!prompt)return '';
  const loaded=loadRules({env,rulesFile});
  if(!loaded.enabled)return '';
  const session=typeof input.session_id==='string'&&input.session_id?input.session_id:null;
  const file=session?statePath(env,session):null;
  const state=file?readState(file):{hinted:[],pending:[]};
  const time=new Date(now).toISOString();

  // Adopted = the user typed the hinted skill within the next ADOPT_WINDOW messages.
  const pending=[];
  const adopted=[];
  for(const item of state.pending){
    if(typed(prompt,item.skill,host))adopted.push(item);
    else if(item.left>1)pending.push({...item,left:item.left-1});
  }
  const authorCheck=loaded.rules.some(rule=>rule.author)?await loadAuthor():null;
  const short=prompt.length<=MAX_PROMPT;
  const invoked=short&&loaded.rules.some(rule=>rule.invoke)
    ?await pickInvoke({prompt,rules:loaded.rules,host,env,authorCheck,useJudge:loaded.judge,judgeOptions,
      judgeModule:loaded.judge?await loadJudgeModule():null})
    :{rule:null,candidates:[]};
  // An installed invoke rule is handled above only; the rest hint as before.
  const handled=new Set(invoked.candidates.map(rule=>rule.id));
  const hints=short?pickHints({prompt,rules:loaded.rules.filter(rule=>!handled.has(rule.id)),host,env,hinted:state.hinted,authorCheck}):[];
  const start=invoked.rule?{skill:invoked.rule.skill,mode:invoked.rule.invoke.mode,reason:invoked.rule.reason}:null;
  // Bookkeeping failures cost the statistics, never the hint itself.
  try{
    for(const item of adopted)appendLog(env,{t:time,event:'adopted',host,rule:item.rule,skill:item.skill});
    // A missing key is the normal state for most users, not worth a line per message.
    if(invoked.error&&!['no-key','off'].includes(invoked.error))appendLog(env,{t:time,event:'judge-error',host,error:invoked.error});
    if(start)appendLog(env,{t:time,event:'invoke',host,rule:invoked.rule.id,skill:start.skill,mode:start.mode,via:invoked.via});
    for(const hint of hints)appendLog(env,{t:time,event:'hint',host,rule:hint.rule,skill:hint.skill});
  }catch{/* 统计丢一条 */}
  // Session state is never removed (decided 2026-10-24): a session resumed months
  // later must still not repeat a hint. Each file is a few hundred bytes.
  if(file&&(hints.length||state.pending.length)){
    try{
      writeAtomic(file,JSON.stringify({hinted:[...state.hinted,...hints.map(hint=>hint.skill)],
        pending:[...pending,...hints.map(hint=>({rule:hint.rule,skill:hint.skill,left:ADOPT_WINDOW}))]}));
    }catch{/* 下条消息可能重复提醒一次 */}
  }
  if(!start&&!hints.length)return '';
  const lines=[...(start?[invokeLine(start,host)]:[]),...(hints.length?[messageText(hints,host)]:[])];
  const output={systemMessage:lines.join('\n')};
  if(start)output.hookSpecificOutput={hookEventName:'UserPromptSubmit',
    additionalContext:invokeContext(start,skillFile(start.skill,host,env,authorCheck),host)};
  return JSON.stringify(output);
}

// ---- wiring: copy a stable script + table into ~/.cm-workflow/skill-hints and add the hook ----

const shellWord=word=>/^[\w@%+=:,./-]+$/.test(word)?word:`'${word.replace(/'/g,`'\\''`)}'`;
const managedTail=(env,host)=>`${shellWord(path.join(installDir(env),SCRIPT_NAME))} hook --host ${host}`;
export const hookCommand=(env,host,node=process.execPath)=>`${shellWord(node)} ${managedTail(env,host)}`;
// Ours = a command hook that is exactly "<node> <managed copy> hook --host <host>",
// where <node> is one shell word naming a node executable.
function isOurs(hook,env,host){
  if(hook?.type!=='command'||typeof hook.command!=='string')return false;
  const tail=' '+managedTail(env,host);
  if(!hook.command.endsWith(tail))return false;
  const word=hook.command.slice(0,-tail.length);
  const interpreter=/^[^\s']+$/.test(word)?word:/^'[^']+'$/.test(word)?word.slice(1,-1):null;
  return Boolean(interpreter)&&/^node(?:\.exe)?$/i.test(path.basename(interpreter));
}
// A UserPromptSubmit that is not a list holds no hook of ours. A config of the wrong shape
// is reported by status and refused by enable: merging into it would drop what is there.
const promptHooks=config=>config?.hooks?.UserPromptSubmit;
const plainObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
export function shapeError(config){
  if(config===undefined)return null;
  if(!plainObject(config))return '顶层不是对象';
  if(config.hooks!==undefined&&!plainObject(config.hooks))return 'hooks 不是对象';
  const list=promptHooks(config);
  return list!==undefined&&!Array.isArray(list)?'UserPromptSubmit 不是列表':null;
}
export const hasHintHook=(config,env,host)=>{
  const list=promptHooks(config);
  return Array.isArray(list)&&list.some(group=>Array.isArray(group?.hooks)&&group.hooks.some(hook=>isOurs(hook,env,host)));
};
export function withHintHook(config,command){
  const next=structuredClone(config??{});
  next.hooks??={};
  const list=Array.isArray(next.hooks.UserPromptSubmit)?[...next.hooks.UserPromptSubmit]:[];
  list.push({hooks:[{type:'command',command,timeout:5}]});
  next.hooks.UserPromptSubmit=list;
  return next;
}

const COPIED=[...COMPANIONS,SCRIPT_NAME];
const sourceOf=name=>name===SCRIPT_NAME?fileURLToPath(import.meta.url):path.join(here,name);
// 'dir' only for a real directory: a link there would take every copy somewhere else.
const copyDirKind=env=>{
  try{return fs.lstatSync(installDir(env)).isDirectory()?'dir':'other';}
  catch(error){return error.code==='ENOENT'?'missing':'other';}
};
// The copy reports on and refreshes from itself only: it cannot see the installed version.
const runningFromCopy=env=>{try{return fs.realpathSync(here)===fs.realpathSync(installDir(env));}catch{return false;}};
function copyInstall(env){
  const dir=installDir(env);
  if(copyDirKind(env)==='other')throw new Error(`${dir} 不是普通目录，未写入`);
  for(const name of COPIED)writeAtomic(path.join(dir,name),fs.readFileSync(sourceOf(name),'utf8'));
}

const configFile=(host,env)=>host==='codex'?codexHooksPath(env):claudeSettingsPath(env);

// Turned on = our hook is in a host config, or the copy directory exists (enable writes
// it before the hook, and the hook keeps its state there). A link at that path does not
// count. Read-only: nothing is created to find out.
export function hintsInstalled(env){
  if(copyDirKind(env)==='dir')return true;
  return HOSTS.some(host=>{try{return hasHintHook(readJson(configFile(host,env)).value,env,host);}catch{return false;}});
}
// Copied files that differ from this version's. Missing, linked or special files count as
// different and are never opened (a FIFO would block status; the hook refuses a linked table).
export function staleCopies(env){
  return COPIED.filter(name=>{
    try{
      const source=fs.readFileSync(sourceOf(name));
      const st=fs.lstatSync(path.join(installDir(env),name));
      return !st.isFile()||st.size!==source.length||!fs.readFileSync(path.join(installDir(env),name)).equals(source);
    }catch{return true;}
  });
}
const refreshCommand=()=>`node ${shellWord(fileURLToPath(import.meta.url))} refresh`;

// Run by the installers: bring an enabled user's copy to this version. Only the four
// copied files are replaced; host configs, Codex trust, session state and logs are not
// touched, and a user who never enabled hints gets nothing. Failure is a warning.
export function refresh({env=process.env,write=text=>process.stdout.write(text)}={}){
  if(!hintsInstalled(env))return 0;
  if(runningFromCopy(env)){write(`⚠ 这是运行副本本身（${installDir(env)}），拿不到已装版本，未刷新；请运行已装 CM 里的 cm-skill-hints.mjs refresh\n`);return 1;}
  try{copyInstall(env);}
  catch(error){write(`⚠ 技能提醒运行副本未刷新（${installDir(env)}）：${error.message}；可稍后运行 ${refreshCommand()}\n`);return 1;}
  write(`技能提醒：运行副本已刷新（${installDir(env)}）。\n`);
  return 0;
}
const LABEL={claude:'Claude',codex:'Codex'};
class Drift extends Error{}

// Read, merge and replace happen under the lock CM's other config writers share.
// Programs outside CM do not take it, so the bytes are compared once more right
// before the rename; if they changed, nothing is written.
export async function enable({env=process.env,hosts=HOSTS,node=process.execPath,write=text=>process.stdout.write(text),beforeReplace,lockWaitMs,
  notes=true,requireRecord=false,copyFiles=copyInstall}={}){
  const {withConfigLock,LockBusy}=await import('./cm-config-lock.mjs');
  // The record is written before the copy, so a copy this run leaves half made is never
  // taken for an old enable's (see settledHosts). Only the installer insists on it.
  const noted=await noteRecord(env,[],{lockWaitMs});
  if(noted.warning){
    write(noted.warning);
    if(requireRecord)return 1;
  }
  try{copyFiles(env);}
  catch(error){write(`✗ 复制提醒脚本到 ${installDir(env)} 失败：${error.message}\n`);return 1;}
  let failed=0;
  const done=[];
  for(const host of hosts){
    const file=configFile(host,env);
    let outcome;
    try{
      outcome=withConfigLock(env,file,()=>{
        const read=readJson(file);
        // A config we cannot parse is never rewritten: that would destroy user content.
        if(read.error)return `✗ ${LABEL[host]}：无法读取 ${file}（${read.error}），未改动。\n`;
        const shape=shapeError(read.value);
        if(shape)return `✗ ${LABEL[host]}：${file} 格式异常（${shape}），未改动。\n`;
        const config=read.value??{};
        if(hasHintHook(config,env,host)){done.push(host);return `${LABEL[host]}：提醒钩子已挂，未改动。\n`;}
        writeAtomic(file,JSON.stringify(withHintHook(config,hookCommand(env,host,node)),null,2)+'\n',{before:()=>{
          beforeReplace?.(file);
          const now=readJson(file);
          if(read.missing?!now.missing:now.text!==read.text)throw new Drift();
        }});
        done.push(host);
        return `${LABEL[host]}：已挂提醒钩子（${file}）。\n`;
      },lockWaitMs===undefined?{}:{waitMs:lockWaitMs});
    }catch(error){
      outcome=error instanceof Drift?`✗ ${LABEL[host]}：${file} 刚被其他程序改动，未改写；请重跑 enable。\n`
        :error instanceof LockBusy?`✗ ${LABEL[host]}：另一个 CM 程序正在改 ${file}，未改写；请稍后重跑 enable。\n`
        :`✗ ${LABEL[host]}：写入 ${file} 失败：${error.message}\n`;
    }
    if(outcome.startsWith('✗'))failed++;
    write(outcome);
  }
  if(done.length&&!noted.warning){
    const after=await noteRecord(env,done,{lockWaitMs});
    if(after.warning){write(after.warning);failed++;}
  }
  if(!notes)return failed?1:0;
  if(hosts.includes('codex'))write(CODEX_TRUST);
  write(`关掉提醒：在 ${localPath(env)} 写 {"enabled": false}。\n`);
  return failed?1:0;
}
const CODEX_TRUST='Codex 首次运行这条钩子时会请你确认信任；不确认它就不会运行。\n';

// ---- install-time default ----
// Settled hosts are those whose install-time default has been applied: the hook was added
// or found there, or an install was told not to add it (--no-skill-hints,
// CM_SKILL_HINTS_INSTALL=off). A settled host without our hook is never wired by an install.
// The record is ~/.cm-workflow/skill-hints.auto.json, outside the copy directory, so
// removing that directory to switch hints off is still respected. It is written before the
// copy is made, so a copy without a record can only come from an `enable` older than the
// record: that user already chose their hosts, and both count as settled.
// A record CM cannot read or whose shape is unknown is kept as is, and no install adds a
// hook while it is there.
function readRecord(env){
  const read=readJson(autoPath(env));
  if(read.missing)return {state:'missing',read};
  const value=read.value;
  if(read.error||!plainObject(value)||value.version!==1||!Array.isArray(value.hosts)||!value.hosts.every(host=>HOSTS.includes(host)))
    return {state:'invalid',read,reason:read.error??'格式异常'};
  return {state:'ok',read,hosts:HOSTS.filter(host=>value.hosts.includes(host))};
}
const legacyHosts=env=>copyDirKind(env)==='dir'?[...HOSTS]:[];
export function settledHosts(env){
  const record=readRecord(env);
  return {state:record.state,reason:record.reason,
    hosts:record.state==='ok'?record.hosts:record.state==='missing'?legacyHosts(env):[...HOSTS]};
}
const recordWarning=(env,reason)=>`⚠ 技能提醒：${autoPath(env)} 异常（${reason}），已保留原样；修好或删掉它之前，安装不会自动挂钩子。\n`;
// Adds hosts to the record. Read, check, merge and replace happen under the shared config
// lock, and the bytes are compared again right before the rename. Never throws: a problem
// comes back as one warning line.
async function noteRecord(env,add,{lockWaitMs,beforeReplace}={}){
  const file=autoPath(env);
  try{
    const {withConfigLock,LockBusy}=await import('./cm-config-lock.mjs');
    try{
      return withConfigLock(env,file,()=>{
        const record=readRecord(env);
        if(record.state==='invalid')return {warning:recordWarning(env,record.reason)};
        const base=record.state==='ok'?record.hosts:legacyHosts(env);
        const next=HOSTS.filter(host=>base.includes(host)||add.includes(host));
        if(record.state==='ok'&&next.length===base.length)return {hosts:next};
        writeAtomic(file,JSON.stringify({version:1,hosts:next})+'\n',{before:()=>{
          beforeReplace?.();
          const now=readJson(file);
          if(record.read.missing?!now.missing:now.text!==record.read.text)throw new Drift();
        }});
        return {hosts:next};
      },lockWaitMs===undefined?{}:{waitMs:lockWaitMs});
    }catch(error){
      const why=error instanceof Drift?'刚被其他程序改动':error instanceof LockBusy?'另一个 CM 程序正在改它':error.message;
      return {warning:`⚠ 技能提醒：未能记下已处理的端（${file}：${why}）；不影响本次安装，下次安装再记。\n`};
    }
  }catch(error){return {warning:`⚠ 技能提醒：未能记下已处理的端（${file}：${error.message}）。\n`};}
}

const OFF_NOTE=env=>`关掉提醒：在 ${localPath(env)} 写 {"enabled": false}`;
const TYPESAFE_NOTE='有 TypeSafe 密钥时，handoff、wayfinder、improve-codebase-architecture 三个作者技能会把消息前 500 字发给 TypeSafe 判断。';

// Why an install must not add the hook now, or null. `optOut` is the user saying no to the
// install default (settled); `pause` is something CM cannot read, so it does nothing.
function installGate(env,skip){
  if(skip)return {optOut:'安装参数 --no-skill-hints'};
  if(env.CM_SKILL_HINTS_INSTALL==='off')return {optOut:'环境变量 CM_SKILL_HINTS_INSTALL=off'};
  const local=readJson(localPath(env),{allowEmpty:true});
  if(local.missing)return null;
  const value=local.value;
  if(local.error)return {pause:`${localPath(env)} 读取失败（${local.error}）`};
  if(!plainObject(value)||(value.enabled!==undefined&&typeof value.enabled!=='boolean'))
    return {pause:`${localPath(env)} 格式异常（应为对象，enabled 只能是 true 或 false）`};
  if(value.enabled===false)return {off:`${localPath(env)} 里 enabled 为 false`};
  return null;
}

// Run by the installers for their own host. Adds the hook once, unless the user said no;
// in every other case it only refreshes an existing copy. Never throws; 1 means a warning.
export async function install({env=process.env,host,skip=false,node=process.execPath,write=text=>process.stdout.write(text),lockWaitMs,
  beforeRecord,beforeRecordReplace,copyFiles}={}){
  try{
    const label=LABEL[host];
    const note=async()=>{beforeRecord?.();const noted=await noteRecord(env,[host],{lockWaitMs,beforeReplace:beforeRecordReplace});if(noted.warning)write(noted.warning);return noted.warning?1:0;};
    const gate=installGate(env,skip);
    if(gate?.optOut){
      write(`技能提醒：按${gate.optOut}，这次没给 ${label} 挂钩子，以后安装也不会自动挂；要挂上运行 ${enableCommand(host)}。`
        +`已挂着的钩子不受影响，要关掉提醒在 ${localPath(env)} 写 {"enabled": false}。\n`);
      const code=refresh({env,write});
      return Math.max(code,await note());
    }
    if(gate){
      write(gate.pause?`⚠ 技能提醒：${gate.pause}，这次没给 ${label} 挂钩子；改好后重装或运行 ${enableCommand(host)}。\n`
        :`技能提醒：${gate.off}，没给 ${label} 挂钩子。\n`);
      return refresh({env,write});
    }
    const file=configFile(host,env);
    const read=readJson(file);
    if(!read.error&&!shapeError(read.value)&&hasHintHook(read.value,env,host)){
      const code=refresh({env,write});
      return Math.max(code,await note());
    }
    const settled=settledHosts(env);
    if(settled.state==='invalid'){
      write(recordWarning(env,settled.reason).replace(/\n$/,`这次没给 ${label} 挂钩子。\n`));
      return Math.max(refresh({env,write}),1);
    }
    if(settled.hosts.includes(host)){
      write(settled.state==='ok'
        ?`技能提醒：${label} 的钩子之前挂过后被移除，或你让安装别挂；这次不自动挂，要挂上运行 ${enableCommand(host)}。\n`
        :`技能提醒：你之前开启技能提醒时没给 ${label} 挂钩子（或后来移除了），这次不自动挂；要挂上运行 ${enableCommand(host)}。\n`);
      return refresh({env,write});
    }
    const code=await enable({env,hosts:[host],node,write,lockWaitMs,notes:false,requireRecord:true,...(copyFiles?{copyFiles}:{})});
    const now=readJson(file);
    if(!now.error&&hasHintHook(now.value,env,host)){
      write(`技能提醒：已给 ${label} 挂上技能提醒钩子，消息里有合适的技能时会提示你。${OFF_NOTE(env)}`
        +`（重装加 --no-skill-hints 只是不自动挂，不会摘掉已挂的钩子）。${TYPESAFE_NOTE}\n`);
      if(host==='codex')write(CODEX_TRUST);
    }
    return code;
  }catch(error){
    write(`⚠ 技能提醒钩子未处理：${error.message}\n`);
    return 1;
  }
}
const enableCommand=host=>`node ${shellWord(fileURLToPath(import.meta.url))} enable --${host}`;

export function statusText({env=process.env,rulesFile=defaultRulesPath()}={}){
  const lines=[];
  const wired=HOSTS.map(host=>{
    const read=readJson(configFile(host,env));
    const shape=read.error?null:shapeError(read.value);
    return `${LABEL[host]} ${read.error?`无法读取（${read.error}）`:shape?`格式异常（${shape}）`
      :hasHintHook(read.value,env,host)?'已挂':'未挂'}`;
  });
  const loaded=loadRules({env,rulesFile});
  lines.push(`skill hints: ${wired.join('，')}；开关 ${loaded.enabled?'开':`关（${localPath(env)} 里 enabled 为 false）`}`);
  // Same gate and record as `install`, so status never says "on" where an install would not wire.
  const gate=installGate(env,false);
  const settled=settledHosts(env);
  lines.push(gate?.optOut?`  安装时自动挂：已关闭（${gate.optOut.replace('环境变量 ','')}）`
    :gate?.off?`  安装时自动挂：已关闭（${gate.off}）`
    :gate?.pause?`  安装时自动挂：暂停（${gate.pause}）`
    :settled.state==='invalid'?`  安装时自动挂：暂停（${autoPath(env)} 异常：${settled.reason}）`
    :`  安装时自动挂：开；已处理过：${settled.hosts.length?`${settled.hosts.map(host=>LABEL[host]).join('、')}（这些端不会再被自动挂上）`:'无'}`);
  if(!hintsInstalled(env))lines.push('  运行副本：未建（还没开启）');
  else if(runningFromCopy(env))lines.push('  ⚠ 这是从运行副本本身查的，无法核验它与已装版本是否一致；请用已装 CM 里的 cm-skill-hints.mjs status');
  else{
    const kind=copyDirKind(env);
    const stale=kind==='dir'?staleCopies(env):[];
    lines.push(kind==='missing'?`  ⚠ 运行副本缺失（${installDir(env)}），钩子跑不起来；运行 ${refreshCommand()} 补上`
      :kind==='other'?`  ⚠ 运行副本目录不是普通目录（${installDir(env)}），CM 不会写进去；请移走后运行 ${refreshCommand()}`
      :stale.length?`  ⚠ 运行副本与已装版本不一致（${stale.join('、')}）；运行 ${refreshCommand()} 刷新`
      :'  运行副本：与已装版本一致');
  }
  if(loaded.enabled){
    lines.push(`  对照表：CM 自带 ${loaded.defaultsError?`读取失败（${loaded.defaultsError}）`:`${loaded.cmCount} 条`}；用户自加 ${loaded.userCount} 条；关掉自带 ${loaded.disabledCount} 条`);
    if(loaded.localError)lines.push(`  ⚠ ${localPath(env)} 读取失败（${loaded.localError}），用户规则未生效`);
    lines.push(loaded.judge?'  自动调用：有 TypeSafe 密钥（TYPESAFE_API_KEY 或钥匙串）时由 Jev 判断，否则用关键词'
      :`  自动调用：已关 Jev（${localPath(env)} 里 judge 为 false），只用关键词`);
  }
  return lines.join('\n')+'\n';
}

const USAGE='用法: cm-skill-hints.mjs hook --host claude|codex | status | refresh | enable [--claude] [--codex] | install --host claude|codex [--no-skill-hints]\n';

export async function main(argv=process.argv.slice(2),{env=process.env,readInput=()=>fs.readFileSync(0,'utf8'),
  write=text=>process.stdout.write(text),error=text=>process.stderr.write(text)}={}){
  const [command,...rest]=argv;
  if(command==='hook'){
    // Quiet on every failure: a hint is never worth holding up the user's message.
    try{
      const host=rest[0]==='--host'?rest[1]:'claude';
      const output=await hook(JSON.parse(readInput()),{env,host});
      if(output)write(output+'\n');
    }catch{/* 安静跳过 */}
    return 0;
  }
  if(command==='status'&&!rest.length){write(statusText({env}));return 0;}
  if(command==='refresh'&&!rest.length)return refresh({env,write});
  if(command==='enable'){
    const hosts=rest.length?rest.map(flag=>flag.replace(/^--/,'')):HOSTS;
    if(hosts.some(host=>!HOSTS.includes(host))){error(USAGE);return 2;}
    return enable({env,hosts});
  }
  if(command==='install'){
    const [flag,host,...extra]=rest;
    const skip=extra.length===1&&extra[0]==='--no-skill-hints';
    if(flag!=='--host'||!HOSTS.includes(host)||(extra.length&&!skip)){error(USAGE);return 2;}
    return install({env,host,skip,write});
  }
  error(USAGE);
  return 2;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  // The hook exits 0 whatever happens; other commands report their own code.
  process.exitCode=await main().catch(()=>process.argv[2]==='hook'?0:1);
}
