#!/usr/bin/env node
// Prints the batch configuration /cm-ai runs for the feature admission selects,
// grouped from the approved tasks.md (runtime/js/cm-ai/batch-plan.mjs). The
// session no longer writes groups by hand; the batch host validates them again.
//
// stdout: {mode:"batch",feature,groups,config} — pass config to cm-ai-batch-host
//         as the batch configuration file;
//         {mode:"serial",feature,reason} — run the feature's tasks one at a time
//         with cm-ai-admission --print-run-definition, as before;
//         {mode:"complete"} — no task is left.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './cm-workflow-config.mjs';
import {planCmAiBatch,parallelSettings} from '../runtime/js/cm-ai/batch-plan.mjs';

const usage='usage: cm-ai-batch-plan.mjs --specs-dir PATH --code-project PATH --repository-id ID --batch-id ID';
function parse(argv){
  const flags=new Map([['--specs-dir','specsDir'],['--code-project','codeProject'],['--repository-id','repositoryId'],
    ['--batch-id','batchId']]);
  const input={};
  for(let index=0;index<argv.length;index+=2){
    const key=flags.get(argv[index]);
    if(!key||index+1>=argv.length||Object.hasOwn(input,key))return null;
    input[key]=argv[index+1];
  }
  return ['specsDir','codeProject','repositoryId','batchId'].every(key=>typeof input[key]==='string')?input:null;
}
export function main(argv=process.argv.slice(2)){
  if(argv.length===1&&['--help','-h'].includes(argv[0])){process.stdout.write(usage+'\n');return 0;}
  const input=parse(argv);
  if(!input){process.stderr.write(usage+'\n');return 2;}
  try{
    const specsDir=fs.realpathSync(path.resolve(input.specsDir)),codeProject=fs.realpathSync(path.resolve(input.codeProject));
    const settings=parallelSettings(loadConfig({projectRoot:codeProject}));
    const plan=planCmAiBatch({specsDir,codeProject,repositoryId:input.repositoryId,batchId:input.batchId,settings});
    process.stdout.write(JSON.stringify(plan)+'\n');return 0;
  }catch(error){
    process.stderr.write(JSON.stringify({error:{code:error.code??'batch_plan_failed',
      ...(typeof error.reason==='string'?{reason:error.reason}:{})}})+'\n');return 1;
  }
}
function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
