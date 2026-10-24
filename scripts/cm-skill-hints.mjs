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
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SCRIPT_NAME='cm-skill-hints.mjs';
export const RULES_NAME='cm-skill-hints.json';
export const LOCAL_NAME='skill-hints.local.json';
export const MAX_PROMPT=2000;
export const MAX_HINTS=2;
export const ADOPT_WINDOW=5;
export const LOG_LIMIT=1024*1024;
const STATE_TTL_MS=7*24*60*60*1000;
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

// Where an author skill would be installed, per host. CM's own skills ship with CM.
export const skillRoots=(host,env)=>host==='codex'
  ?[path.join(homeOf(env),'.agents','skills'),path.join(path.resolve(env.CODEX_HOME||path.join(homeOf(env),'.codex')),'skills')]
  :[path.join(path.resolve(env.CLAUDE_HOME||path.join(homeOf(env),'.claude')),'skills')];
export const isInstalled=(skill,host,env)=>skillRoots(host,env).some(root=>fs.existsSync(path.join(root,skill,'SKILL.md')));
export const mention=(skill,host)=>`${host==='codex'?'$':'/'}${skill}`;

function readJson(file){
  let text;
  try{text=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return {missing:true};return {error:error.code||'read'};}
  try{return {value:text.trim()?JSON.parse(text):{}};}catch{return {error:'parse'};}
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

// User rules come first so they win a tie; `disable` switches off CM rules by id.
// A broken local file is ignored (the CM table still works) and reported by `status`.
export function loadRules({env=process.env,rulesFile=defaultRulesPath()}={}){
  const local=readJson(localPath(env));
  const settings=local.value&&typeof local.value==='object'&&!Array.isArray(local.value)?local.value:{};
  if(settings.enabled===false)return {enabled:false,rules:[]};
  const defaults=readJson(rulesFile);
  const disabled=new Set(strings(settings.disable));
  const user=(Array.isArray(settings.rules)?settings.rules:[]).map(rule=>normalizeRule(rule,true)).filter(Boolean);
  const cm=(Array.isArray(defaults.value?.rules)?defaults.value.rules:[])
    .map(rule=>normalizeRule(rule,false)).filter(rule=>rule&&!disabled.has(rule.id));
  return {enabled:true,rules:[...user,...cm],localError:local.error??null,defaultsError:defaults.error??(defaults.missing?'missing':null),
    userCount:user.length,disabledCount:disabled.size,cmCount:cm.length};
}

// Pasted logs and code are where stray keywords live, so fenced blocks never match.
export const stripCode=text=>text.replace(/```[\s\S]*?(?:```|$)/g,' ');
const matches=(rule,text)=>rule.keywords.some(word=>text.includes(word))||rule.patterns.some(pattern=>pattern.test(text));

// An author skill that is not installed falls back to its CM counterpart, or is dropped.
function resolve(rule,host,env){
  if(rule.user||!rule.author||isInstalled(rule.skill,host,env))return {rule:rule.id,skill:rule.skill,reason:rule.reason};
  return rule.fallback?{rule:rule.id,skill:rule.fallback.skill,reason:rule.fallback.reason}:null;
}

export function pickHints({prompt,rules,host,env,hinted=[]}){
  const lower=prompt.toLowerCase();
  const text=stripCode(lower);
  const picked=[];
  for(const rule of rules){
    if(picked.length>=MAX_HINTS)break;
    if(!matches(rule,text))continue;
    const hint=resolve(rule,host,env);
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
  const read=readJson(file).value;
  return {hinted:strings(read?.hinted),pending:Array.isArray(read?.pending)?read.pending.filter(item=>
    item&&typeof item.skill==='string'&&typeof item.rule==='string'&&Number.isInteger(item.left)):[]};
}
// Replace by rename of a freshly created file, so a link planted at the path is never written through.
function writeAtomic(file,text){
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}
  finally{try{fs.unlinkSync(temporary);}catch{/* 已改名或未创建 */}}
}
function pruneStates(dir,now){
  for(const name of fs.readdirSync(dir)){
    if(!/^[0-9a-f]{16}\.json$/.test(name))continue;
    const file=path.join(dir,name);
    try{if(now-fs.statSync(file).mtimeMs>STATE_TTL_MS)fs.unlinkSync(file);}catch{/* 下次再清 */}
  }
}

// Rule id, skill, host and time only: the message itself is never written.
export function appendLog(env,record){
  const file=logFile(env);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{
    if(fs.statSync(file).size>LOG_LIMIT){
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

export function hook(input,{env=process.env,host='claude',rulesFile=defaultRulesPath(),now=Date.now()}={}){
  if(env.CM_SKILL_HINTS==='off'||!HOSTS.includes(host))return '';
  const prompt=typeof input?.prompt==='string'?input.prompt:'';
  if(!prompt)return '';
  const loaded=loadRules({env,rulesFile});
  if(!loaded.enabled)return '';
  const session=typeof input.session_id==='string'&&input.session_id?input.session_id:null;
  const file=session?statePath(env,session):null;
  const state=file?readState(file):{hinted:[],pending:[]};
  const time=new Date(now).toISOString();
  const lower=prompt.toLowerCase();

  // Adopted = the user typed the hinted skill within the next ADOPT_WINDOW messages.
  const pending=[];
  const adopted=[];
  for(const item of state.pending){
    if(lower.includes(mention(item.skill,host).toLowerCase()))adopted.push(item);
    else if(item.left>1)pending.push({...item,left:item.left-1});
  }
  const hints=prompt.length>MAX_PROMPT?[]:pickHints({prompt,rules:loaded.rules,host,env,hinted:state.hinted});
  // Bookkeeping failures cost the statistics, never the hint itself.
  try{
    for(const item of adopted)appendLog(env,{t:time,event:'adopted',host,rule:item.rule,skill:item.skill});
    for(const hint of hints)appendLog(env,{t:time,event:'hint',host,rule:hint.rule,skill:hint.skill});
  }catch{/* 统计丢一条 */}
  if(file&&(hints.length||state.pending.length)){
    try{
      writeAtomic(file,JSON.stringify({hinted:[...state.hinted,...hints.map(hint=>hint.skill)],
        pending:[...pending,...hints.map(hint=>({rule:hint.rule,skill:hint.skill,left:ADOPT_WINDOW}))]}));
      pruneStates(path.dirname(file),now);
    }catch{/* 下条消息可能重复提醒一次 */}
  }
  if(!hints.length)return '';
  return JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:contextText(hints,host)}});
}

// ---- wiring: copy a stable script + table into ~/.cm-workflow/skill-hints and add the hook ----

const shellWord=word=>/^[\w@%+=:,./-]+$/.test(word)?word:`'${word.replace(/'/g,`'\\''`)}'`;
export const hookCommand=(env,host,node=process.execPath)=>
  `${shellWord(node)} ${shellWord(path.join(installDir(env),SCRIPT_NAME))} hook --host ${host}`;
const isOurs=hook=>typeof hook?.command==='string'&&hook.command.includes(SCRIPT_NAME);
export const hasHintHook=config=>(config?.hooks?.UserPromptSubmit??[]).some(group=>
  Array.isArray(group?.hooks)&&group.hooks.some(isOurs));
export function withHintHook(config,command){
  const next=structuredClone(config??{});
  next.hooks??={};
  const list=Array.isArray(next.hooks.UserPromptSubmit)?[...next.hooks.UserPromptSubmit]:[];
  list.push({hooks:[{type:'command',command,timeout:5}]});
  next.hooks.UserPromptSubmit=list;
  return next;
}

function copyInstall(env,{script=fileURLToPath(import.meta.url),rulesFile=defaultRulesPath()}={}){
  const dir=installDir(env);
  writeAtomic(path.join(dir,SCRIPT_NAME),fs.readFileSync(script,'utf8'));
  writeAtomic(path.join(dir,RULES_NAME),fs.readFileSync(rulesFile,'utf8'));
}

const configFile=(host,env)=>host==='codex'?codexHooksPath(env):claudeSettingsPath(env);
const LABEL={claude:'Claude',codex:'Codex'};

export function enable({env=process.env,hosts=HOSTS,node=process.execPath,write=text=>process.stdout.write(text)}={}){
  try{copyInstall(env);}
  catch(error){write(`✗ 复制提醒脚本到 ${installDir(env)} 失败：${error.message}\n`);return 1;}
  let failed=0;
  for(const host of hosts){
    const file=configFile(host,env);
    const read=readJson(file);
    // A config we cannot parse is never rewritten: that would destroy user content.
    if(read.error){write(`✗ ${LABEL[host]}：无法读取 ${file}（${read.error}），未改动。\n`);failed++;continue;}
    const config=read.value??{};
    if(hasHintHook(config)){write(`${LABEL[host]}：提醒钩子已挂，未改动。\n`);continue;}
    try{writeAtomic(file,JSON.stringify(withHintHook(config,hookCommand(env,host,node)),null,2)+'\n');}
    catch(error){write(`✗ ${LABEL[host]}：写入 ${file} 失败：${error.message}\n`);failed++;continue;}
    write(`${LABEL[host]}：已挂提醒钩子（${file}）。\n`);
  }
  if(hosts.includes('codex'))write('Codex 首次运行这条钩子时会请你确认信任；不确认它就不会运行。\n');
  write(`关闭：在 ${localPath(env)} 写 {"enabled": false}。\n`);
  return failed?1:0;
}

export function statusText({env=process.env,rulesFile=defaultRulesPath()}={}){
  const lines=[];
  const wired=HOSTS.map(host=>{
    const read=readJson(configFile(host,env));
    return `${LABEL[host]} ${read.error?`无法读取（${read.error}）`:hasHintHook(read.value)?'已挂':'未挂'}`;
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

export function main(argv=process.argv.slice(2),{env=process.env,readInput=()=>fs.readFileSync(0,'utf8'),
  write=text=>process.stdout.write(text),error=text=>process.stderr.write(text)}={}){
  const [command,...rest]=argv;
  if(command==='hook'){
    // Quiet on every failure: a hint is never worth holding up the user's message.
    try{
      const host=rest[0]==='--host'?rest[1]:'claude';
      const output=hook(JSON.parse(readInput()),{env,host});
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
  process.exitCode=main();
}
