#!/usr/bin/env node
// Skill hints: a UserPromptSubmit hook for Claude Code and Codex that matches the
// user's message against a keyword table and asks the model to mention at most two
// fitting skills in one line. It only hints; it never runs a skill.
//
// Decided 2026-10-23 (方案-技能提醒): keywords not AI, so nothing leaves the machine
// and no tokens are spent; the CM table ships here, the user's own table lives in
// ~/.cm-workflow/skill-hints.local.json and wins; the log keeps rule ids and times,
// never message text. Any error exits quietly so a message is never held up.
// Wiring is opt-in: `enable` adds the hook, the installer does not (yet).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SCRIPT_NAME='cm-skill-hints.mjs';
export const RULES_NAME='cm-skill-hints.json';
export const LOCAL_NAME='skill-hints.local.json';
// Copied together into ~/.cm-workflow/skill-hints so the hook runs without the CM tree.
// They are written before the script itself, so a failed copy leaves the old script.
const COMPANIONS=['cm-matt-skills.mjs','cm-config-lock.mjs',RULES_NAME];
export const MAX_PROMPT=2000;
export const MAX_HINTS=2;
export const ADOPT_WINDOW=5;
export const LOG_LIMIT=1024*1024;
export const PATTERN_BUDGET_MS=200;
const MAX_READ=1024*1024;
const HOSTS=['claude','codex'];
const SKILL_NAME=/^[\w.:-]+$/;

const homeOf=env=>env.HOME||os.homedir();
export const cmHome=env=>path.resolve(env.CM_WORKFLOW_HOME||path.join(homeOf(env),'.cm-workflow'));
export const logFile=env=>path.join(path.resolve(env.CM_WORKFLOW_LOG_HOME||path.join(cmHome(env),'logs')),'skill-hints.jsonl');
export const localPath=env=>path.join(cmHome(env),LOCAL_NAME);
export const installDir=env=>path.join(cmHome(env),'skill-hints');
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
  return {id:typeof rule.id==='string'&&rule.id?rule.id:`${user?'user':'cm'}:${rule.skill}`,skill:rule.skill,
    reason:String(rule.reason??''),author:rule.author===true,fallback,keywords,patterns,user};
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
  return {enabled:true,rules:[...user,...cm],localError:local.error??null,defaultsError:defaults.error??(defaults.missing?'missing':null),
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

export function pickHints({prompt,rules,host,env,hinted=[],authorCheck=null}){
  const lower=prompt.toLowerCase();
  const text=stripCode(lower);
  const byPattern=patternMatches(rules,text);
  const picked=[];
  for(const [index,rule] of rules.entries()){
    if(picked.length>=MAX_HINTS)break;
    if(!rule.keywords.some(word=>text.includes(word))&&!byPattern[index])continue;
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

export function contextText(hints,host){
  return ['[CM 技能提醒] 用户这条消息可能适合下面的技能。',
    `只有确实贴切时，才在回复末尾加一行：可以试 \`${mention('技能名',host)}\`：理由。不贴切就不提。`,
    '只提醒，不要替用户调用这些技能，也不要解释这条提醒的来历。',
    ...hints.map(hint=>`- ${mention(hint.skill,host)}：${hint.reason}`)].join('\n');
}

export async function hook(input,{env=process.env,host='claude',rulesFile=defaultRulesPath(),now=Date.now(),loadAuthor=loadAuthorCheck}={}){
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
  const hints=prompt.length>MAX_PROMPT?[]:pickHints({prompt,rules:loaded.rules,host,env,hinted:state.hinted,authorCheck});
  // Bookkeeping failures cost the statistics, never the hint itself.
  try{
    for(const item of adopted)appendLog(env,{t:time,event:'adopted',host,rule:item.rule,skill:item.skill});
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
  if(!hints.length)return '';
  return JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:contextText(hints,host)}});
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
export const hasHintHook=(config,env,host)=>(config?.hooks?.UserPromptSubmit??[]).some(group=>
  Array.isArray(group?.hooks)&&group.hooks.some(hook=>isOurs(hook,env,host)));
export function withHintHook(config,command){
  const next=structuredClone(config??{});
  next.hooks??={};
  const list=Array.isArray(next.hooks.UserPromptSubmit)?[...next.hooks.UserPromptSubmit]:[];
  list.push({hooks:[{type:'command',command,timeout:5}]});
  next.hooks.UserPromptSubmit=list;
  return next;
}

function copyInstall(env){
  const dir=installDir(env);
  for(const name of COMPANIONS)writeAtomic(path.join(dir,name),fs.readFileSync(path.join(here,name),'utf8'));
  writeAtomic(path.join(dir,SCRIPT_NAME),fs.readFileSync(fileURLToPath(import.meta.url),'utf8'));
}

const configFile=(host,env)=>host==='codex'?codexHooksPath(env):claudeSettingsPath(env);
const LABEL={claude:'Claude',codex:'Codex'};
class Drift extends Error{}

// Read, merge and replace happen under the lock CM's other config writers share.
// Programs outside CM do not take it, so the bytes are compared once more right
// before the rename; if they changed, nothing is written.
export async function enable({env=process.env,hosts=HOSTS,node=process.execPath,write=text=>process.stdout.write(text),beforeReplace,lockWaitMs}={}){
  const {withConfigLock,LockBusy}=await import('./cm-config-lock.mjs');
  try{copyInstall(env);}
  catch(error){write(`✗ 复制提醒脚本到 ${installDir(env)} 失败：${error.message}\n`);return 1;}
  let failed=0;
  for(const host of hosts){
    const file=configFile(host,env);
    let outcome;
    try{
      outcome=withConfigLock(env,file,()=>{
        const read=readJson(file);
        // A config we cannot parse is never rewritten: that would destroy user content.
        if(read.error)return `✗ ${LABEL[host]}：无法读取 ${file}（${read.error}），未改动。\n`;
        const config=read.value??{};
        if(hasHintHook(config,env,host))return `${LABEL[host]}：提醒钩子已挂，未改动。\n`;
        writeAtomic(file,JSON.stringify(withHintHook(config,hookCommand(env,host,node)),null,2)+'\n',{before:()=>{
          beforeReplace?.(file);
          const now=readJson(file);
          if(read.missing?!now.missing:now.text!==read.text)throw new Drift();
        }});
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
  if(hosts.includes('codex'))write('Codex 首次运行这条钩子时会请你确认信任；不确认它就不会运行。\n');
  write(`关闭：在 ${localPath(env)} 写 {"enabled": false}。\n`);
  return failed?1:0;
}

export function statusText({env=process.env,rulesFile=defaultRulesPath()}={}){
  const lines=[];
  const wired=HOSTS.map(host=>{
    const read=readJson(configFile(host,env));
    return `${LABEL[host]} ${read.error?`无法读取（${read.error}）`:hasHintHook(read.value,env,host)?'已挂':'未挂'}`;
  });
  const loaded=loadRules({env,rulesFile});
  lines.push(`skill hints: ${wired.join('，')}；开关 ${loaded.enabled?'开':`关（${localPath(env)} 里 enabled 为 false）`}`);
  if(loaded.enabled){
    lines.push(`  对照表：CM 自带 ${loaded.defaultsError?`读取失败（${loaded.defaultsError}）`:`${loaded.cmCount} 条`}；用户自加 ${loaded.userCount} 条；关掉自带 ${loaded.disabledCount} 条`);
    if(loaded.localError)lines.push(`  ⚠ ${localPath(env)} 读取失败（${loaded.localError}），用户规则未生效`);
  }
  return lines.join('\n')+'\n';
}

const USAGE='用法: cm-skill-hints.mjs hook --host claude|codex | status | enable [--claude] [--codex]\n';

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
  if(command==='enable'){
    const hosts=rest.length?rest.map(flag=>flag.replace(/^--/,'')):HOSTS;
    if(hosts.some(host=>!HOSTS.includes(host))){error(USAGE);return 2;}
    return enable({env,hosts});
  }
  error(USAGE);
  return 2;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  // The hook exits 0 whatever happens; other commands report their own code.
  process.exitCode=await main().catch(()=>process.argv[2]==='hook'?0:1);
}
