#!/usr/bin/env node
// Reports whether the update announcement hook is wired, and — only when the user
// says yes — adds that one SessionStart hook to their Claude settings.
//
// Scope is deliberately narrow. The installer otherwise never touches settings.json,
// which belongs to the user: it may carry their own statusline and hooks. This adds
// the announcement hook alone and never the background updater, because announcing a
// new version is not the same decision as letting the tool replace itself.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createInterface} from 'node:readline';

export const ANNOUNCE_COMMAND='~/.cm-workflow/cm-announce.sh';
const DECLINED='announce-hook-declined';

export const settingsPath=(env=process.env)=>
  path.join(path.resolve(env.CLAUDE_HOME||path.join(env.HOME||os.homedir(),'.claude')),'settings.json');
export const declinedPath=(env=process.env)=>
  path.join(path.resolve(env.CM_WORKFLOW_HOME||path.join(env.HOME||os.homedir(),'.cm-workflow')),DECLINED);

export function readSettings(file){
  let text;
  try{text=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return {};throw error;}
  if(!text.trim())return {};
  // A settings file we cannot parse is never rewritten: that would destroy user content.
  return JSON.parse(text);
}

export const hasAnnounceHook=settings=>
  (settings?.hooks?.SessionStart??[]).some(group=>
    Array.isArray(group?.hooks)&&group.hooks.some(hook=>hook?.command===ANNOUNCE_COMMAND));

// Append to the existing SessionStart list; every other key and hook is preserved.
export function withAnnounceHook(settings){
  const next=structuredClone(settings??{});
  next.hooks??={};
  const sessionStart=Array.isArray(next.hooks.SessionStart)?[...next.hooks.SessionStart]:[];
  sessionStart.push({hooks:[{type:'command',command:ANNOUNCE_COMMAND,timeout:5}]});
  next.hooks.SessionStart=sessionStart;
  return next;
}

export function writeSettings(file,settings){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.cm-announce.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
  try{fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

export async function main({env=process.env,input=process.stdin,output=process.stdout,
  interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY)}={}){
  const file=settingsPath(env);
  let settings;
  try{settings=readSettings(file);}
  catch{output.write(`⚠ 无法解析 ${file}，未改动它。更新播报可按 docs/installation.md 手工开启。\n`);return 0;}
  if(hasAnnounceHook(settings)){output.write('更新播报已启用（新版本会在下次启动时告知）。\n');return 0;}

  const declined=declinedPath(env);
  if(fs.existsSync(declined)){output.write(`更新播报未启用（此前已选择不开启）。要开启：删除 ${declined} 后重新安装。\n`);return 0;}

  const manual=`要开启：在 ${file} 的 hooks.SessionStart 增加 {"type":"command","command":"${ANNOUNCE_COMMAND}","timeout":5}`;
  if(!interactive){output.write(`更新播报未启用。${manual}\n`);return 0;}

  const rl=createInterface({input,output,terminal:false});
  let answer;
  try{answer=await new Promise(resolve=>{
    output.write('  开启更新播报？新版本会在下次启动 Claude Code 时告知一次。这只增加一条播报 hook，不会自动升级。[y/N] ');
    rl.once('line',line=>resolve(line));rl.once('close',()=>resolve(null));
  });}finally{rl.close();}

  if(!/^y(es)?$/i.test((answer??'').trim())){
    try{fs.mkdirSync(path.dirname(declined),{recursive:true});fs.writeFileSync(declined,'');}catch{/* 记不住也只是下次再问一次 */}
    output.write(`  未开启。${manual}\n`);return 0;
  }
  try{writeSettings(file,withAnnounceHook(settings));}
  catch{output.write(`  ⚠ 写入 ${file} 失败，未改动它。${manual}\n`);return 0;}
  output.write('  已开启：下次启动 Claude Code 时会告知更新。\n');
  return 0;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url).pathname))
  process.exitCode=await main();
