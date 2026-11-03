#!/usr/bin/env node
// Saved specification preview only: no approval, session creation or execution.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectAcceptancePreview,acceptancePreviewLines} from '../runtime/js/cm-prd/acceptance-preview.mjs';
const usage='用法: cm-acceptance-preview.mjs --specs DIR [--feature NAME [--task T-ID]] [--task-grammar 1|2|3] [--json]\n只读；0 要求映射可预览，1 需澄清，2 输入/读取失败。不是批准或测试通过。\n';
export function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0])){stdout.write(usage);return 0;}
  try{
    const options={},allowed=new Set(['--specs','--feature','--task','--task-grammar','--json']);
    for(let i=0;i<argv.length;i++){
      const key=argv[i];if(!allowed.has(key)||Object.hasOwn(options,key))throw new Error('acceptance_preview_arguments_invalid');
      if(key==='--json')options[key]=true;
      else{const value=argv[++i];if(!value||value.startsWith('--'))throw new Error('acceptance_preview_arguments_invalid');options[key]=value;}
    }
    if(!options['--specs']||options['--task']&&!options['--feature'])throw new Error('acceptance_preview_arguments_invalid');
    const preview=inspectAcceptancePreview({specs:fs.realpathSync(path.resolve(options['--specs'])),
      feature:options['--feature']??null,taskId:options['--task']??null,
      ...(options['--task-grammar']?{taskGrammar:Number(options['--task-grammar'])}:{})});
    stdout.write(options['--json']?JSON.stringify(preview)+'\n':acceptancePreviewLines(preview).join('\n')+'\n');
    return preview.status==='ready'?0:1;
  }catch(error){const reason=error.code??error.message;
    stderr.write(`验收预览不可用：${/^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(reason)?reason:'acceptance_preview_read_failed'}\n`);return 2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
