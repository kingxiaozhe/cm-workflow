#!/usr/bin/env node
// Shared post-install prompt. Skipped on --yes or redirected input/output.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {userRuntimesPath,readConfigText,parseUserRuntimes} from './cm-workflow-config.mjs';
import {writeUserRuntime,prepareRuntimePreview,formatRuntimePreview} from './cm-runtime.mjs';
import {runtimeLanguage,runtimeText as t} from './cm-runtime-i18n.mjs';

export class PromptCancelled extends Error {}
// Queue lines so injected streams and pasted answers cannot lose later responses.
export function runtimeQuestions(input,output,lang=runtimeLanguage()){
  const rl=createInterface({input,output,terminal:false});
  const queue=[];let pending=null,closed=false,cancelled=false,unterminated=false;
  // 输入最后一行没回车就结束（EOF），那一行不算数：防止未提交的 y 被当成确认。
  input.on('data',chunk=>{const text=String(chunk);if(text.length)unterminated=!text.endsWith('\n');});
  rl.on('line',line=>{if(pending){const resolve=pending;pending=null;resolve(line);}else queue.push(line);});
  const close=()=>{closed=true;if(pending){pending(null);pending=null;}};
  rl.on('close',close);
  const interrupt=()=>{cancelled=true;queue.length=0;rl.close();close();};
  rl.on('SIGINT',interrupt);process.on('SIGINT',interrupt);
  return {
    // fresh=true（确认题）：确认码是此刻才生成的，提问显示前已排队的行一律丢弃。
    async ask(question,{fresh=false}={}){
      if(fresh)queue.length=0;
      if(cancelled||closed&&!queue.length)throw new PromptCancelled();
      output.write(question);
      const answer=queue.length?queue.shift():await new Promise(resolve=>{pending=resolve;});
      if(answer===null||cancelled)throw new PromptCancelled();
      if(closed&&!queue.length&&unterminated)throw new PromptCancelled();
      return answer.trim();
    },
    close(){process.removeListener('SIGINT',interrupt);rl.close();},
  };
}
// 保存确认：必须输入本次提问随机生成的 8 位确认码（每次提问重新生成，不由预览内容算出，
// 所以重复预览、提前粘贴都复用不了）。回车、n、y 等其他输入一律取消，不写。
export const newConfirmCode=()=>randomBytes(4).toString('hex');   // 8 位十六进制，碰撞概率约 1/43 亿
export async function askConfirm(ask,preview,lang=runtimeLanguage(),code=newConfirmCode()){
  return (await ask(t('confirm',lang,{code}),{fresh:true})).toLowerCase()===code;
}
export async function askRuntimePreset(ask,lang=runtimeLanguage()){
  // 空回车默认选 Claude（工具题=只有 Claude，写代码题=Claude 写）。
  let choice;
  do{choice=await ask(t('tools',lang));if(choice==='')choice='2';}while(!['1','2','3'].includes(choice));
  if(choice!=='3')return choice==='1'?'codex-only':'claude-only';
  let coder;
  do{coder=await ask(t('coder',lang));if(coder==='')coder='2';}while(!['1','2'].includes(coder));
  return coder==='2'?'claude-codes':'codex-codes';
}
export async function promptRuntime(argv=process.argv.slice(2),input=process.stdin,output=process.stdout){
  const args=[...argv];let culture;
  const index=args.indexOf('--lang');
  if(index>=0){culture=args[index+1];if(!culture||culture.startsWith('--'))throw new Error('missing --lang value');args.splice(index,2);}
  if(args.some(arg=>arg!=='--yes'))throw new Error('usage: cm-runtime-install.mjs [--yes] [--lang CULTURE]');
  if(args.includes('--yes')||!input.isTTY||!output.isTTY)return;
  const lang=runtimeLanguage({...process.env,...(culture?{LANG:culture}:{})});
  const questions=runtimeQuestions(input,output,lang),ask=questions.ask;
  try{
    const file=userRuntimesPath();
    if(fs.existsSync(file)){
      try{
        const current=parseUserRuntimes(readConfigText(file));
        output.write(t('current',lang,{available:current.runtimes.available,preset:current.preset}));
      }catch(error){output.write(t('invalid',lang,{file,error:error.message}));return;}
      const keep=await ask(t('keep',lang));
      if(keep!=='n'&&keep!=='N')return;
    }else if((await ask(t('configure',lang))).toLowerCase()!=='y')return;
    const preset=await askRuntimePreset(ask,lang);
    const preview=prepareRuntimePreview(null,preset,{user:true,lang});
    output.write(formatRuntimePreview(preview,lang));
    if(!await askConfirm(ask,preview,lang))throw new PromptCancelled();
    output.write(t('installed',lang,{file:writeUserRuntime(preset,{lang,preview}),preset}));
  }catch(error){if(error instanceof PromptCancelled)output.write(t('cancelled',lang));else throw error;}
  finally{questions.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await promptRuntime();}catch(error){console.error(t('failed',undefined,{error:error.message}));process.exitCode=1;}
}
