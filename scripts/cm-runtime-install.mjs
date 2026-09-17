#!/usr/bin/env node
// Shared post-install prompt. Skipped on --yes or redirected input/output.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {userRuntimesPath,readConfigText,parseUserRuntimes} from './cm-workflow-config.mjs';
import {writeUserRuntime} from './cm-runtime.mjs';
import {runtimeLanguage,runtimeText as t} from './cm-runtime-i18n.mjs';

export class PromptCancelled extends Error {}
// Queue lines so injected streams and pasted answers cannot lose later responses.
export function runtimeQuestions(input,output,lang=runtimeLanguage()){
  const rl=createInterface({input,output,terminal:false});
  const queue=[];let pending=null,closed=false,cancelled=false;
  rl.on('line',line=>{if(pending){const resolve=pending;pending=null;resolve(line);}else queue.push(line);});
  const close=()=>{closed=true;if(pending){pending(null);pending=null;}};
  rl.on('close',close);
  const interrupt=()=>{cancelled=true;queue.length=0;rl.close();close();};
  rl.on('SIGINT',interrupt);process.on('SIGINT',interrupt);
  return {
    async ask(question){
      if(cancelled||closed&&!queue.length)throw new PromptCancelled();
      output.write(question);
      const answer=queue.length?queue.shift():await new Promise(resolve=>{pending=resolve;});
      if(answer===null||cancelled)throw new PromptCancelled();
      return answer.trim();
    },
    close(){process.removeListener('SIGINT',interrupt);rl.close();},
  };
}
export async function askRuntimePreset(ask,lang=runtimeLanguage()){
  let choice,empty=0;
  do{
    choice=await ask(t('tools',lang));
    if(choice===''){if(++empty===3)throw new PromptCancelled();}else empty=0;
  }while(!['1','2','3'].includes(choice));
  if(choice!=='3')return choice==='1'?'codex-only':'claude-only';
  let coder;
  do{coder=await ask(t('coder',lang));}while(!['','1','2'].includes(coder));
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
      }catch(error){output.write(t('invalid',lang,{error:error.message}));}
      const keep=await ask(t('keep',lang));
      if(keep!=='n'&&keep!=='N')return;
    }
    const preset=await askRuntimePreset(ask,lang);
    output.write(t('installed',lang,{file:writeUserRuntime(preset,{lang}),preset}));
  }catch(error){if(error instanceof PromptCancelled)output.write(t('cancelled',lang));else throw error;}
  finally{questions.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await promptRuntime();}catch(error){console.error(t('failed',undefined,{error:error.message}));process.exitCode=1;}
}
