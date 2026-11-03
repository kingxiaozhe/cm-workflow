#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRunAnalysis,runAnalysisLines} from '../runtime/js/run-analysis.mjs';
const usage='用法: cm-run-analysis.mjs --specs DIR [--run-id ID] [--json]\n读取规格目录的运行日志；不执行工作流或修改状态。\n';
export function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0])){stdout.write(usage);return 0;}
  try{
    const options={};
    for(let i=0;i<argv.length;i++){
      const name=argv[i];if(!['--specs','--run-id','--json'].includes(name)||Object.hasOwn(options,name))throw Error('run_analysis_arguments_invalid');
      if(name==='--json')options[name]=true;
      else{const value=argv[++i];if(!value||value.startsWith('--'))throw Error('run_analysis_arguments_invalid');options[name]=value;}
    }
    if(!options['--specs'])throw Error('run_analysis_arguments_invalid');
    const report=inspectRunAnalysis({specs:path.resolve(options['--specs']),runId:options['--run-id']??null});
    stdout.write(options['--json']?JSON.stringify(report)+'\n':runAnalysisLines(report).join('\n')+'\n');return 0;
  }catch(error){const reason=error.code??error.message;
    stderr.write(`运行分析不可用：${/^run_analysis_[a-z_]+$/.test(reason)?reason:'run_analysis_read_failed'}\n`);return 2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
