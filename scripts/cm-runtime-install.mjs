#!/usr/bin/env node
// Shared post-install prompt. Skipped on --yes or redirected input/output.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {userRuntimesPath,readConfigText,parseUserRuntimes} from './cm-workflow-config.mjs';
import {writeUserRuntime} from './cm-runtime.mjs';

export async function promptRuntime(argv=process.argv.slice(2),input=process.stdin,output=process.stdout){
  if(argv.some(arg=>arg!=='--yes'))throw new Error('usage: cm-runtime-install.mjs [--yes]');
  if(argv.includes('--yes')||!input.isTTY||!output.isTTY)return;
  const rl=createInterface({input,output});let closed=false;
  rl.on('close',()=>{closed=true;});
  const ask=async question=>{
    if(closed)throw new Error('输入已关闭，未修改运行时声明');
    return (await rl.question(question)).trim();
  };
  try{
    const file=userRuntimesPath();
    if(fs.existsSync(file)){
      try{
        const current=parseUserRuntimes(readConfigText(file));
        output.write(`当前用户级默认: ${current.runtimes.available} / ${current.preset}\n`);
      }catch(error){output.write(`当前用户级默认无效: ${error.message}\n`);}
      const keep=await ask('保留？[Y/n] ');
      if(keep!=='n'&&keep!=='N')return;
    }
    let choice;
    do{choice=await ask('你手上有哪个 AI 工具？[1] 只有 Codex [2] 只有 Claude [3] 两个都有: ');}while(!['1','2','3'].includes(choice));
    let preset=choice==='1'?'codex-only':'claude-only';
    if(choice==='3'){
      let coder;
      do{coder=await ask('谁写代码？[1] Codex（Claude 审，推荐） [2] Claude（Codex 审）: ');}while(!['','1','2'].includes(coder));
      preset=coder==='2'?'claude-codes':'codex-codes';
    }
    output.write(`✓ 用户级运行时默认已写入 ${writeUserRuntime(preset)} (${preset})\n`);
  }finally{rl.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await promptRuntime();}catch(error){console.error(`运行时声明未完成: ${error.message}`);process.exitCode=1;}
}
