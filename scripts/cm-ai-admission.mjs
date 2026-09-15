#!/usr/bin/env node
// Product CLI for the shipped read-only cm-ai N1/N2 admission authority.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';

const usage='usage: cm-ai-admission.mjs --specs-dir PATH --code-project PATH [--code-project PATH ...] [--approval-response TEXT | --yes]';

function parse(argv){
  const result={codeProjects:[]};
  for(let index=0;index<argv.length;index++){
    const flag=argv[index];
    if(flag==='--help'||flag==='-h')return {help:true};
    if(flag==='--yes'){if(result.assumeYes||Object.hasOwn(result,'approvalResponse'))throw new Error('approval input is duplicated');result.assumeYes=true;continue;}
    if(flag==='--code-project'){
      if(index+1>=argv.length||result.codeProjects.length>=16)throw new Error('invalid arguments');
      result.codeProjects.push(argv[++index]);continue;
    }
    const key={'--specs-dir':'specsDir','--approval-response':'approvalResponse'}[flag];
    if(!key||index+1>=argv.length||Object.hasOwn(result,key))throw new Error('invalid arguments');
    result[key]=argv[++index];
  }
  if(!result.specsDir||result.codeProjects.length===0)throw new Error('specs and code project paths are required');
  if(result.assumeYes&&Object.hasOwn(result,'approvalResponse'))throw new Error('approval input is duplicated');
  return result;
}

export function main(argv=process.argv.slice(2)){
  let input;
  try{input=parse(argv);}catch(error){process.stderr.write(`${usage}\nERROR: ${error.message}\n`);return 2;}
  if(input.help){process.stdout.write(`${usage}\n`);return 0;}
  const projectResults=input.codeProjects.map(codeProject=>inspectCmAiAdmission({...input,codeProject}));
  const firstBlocked=projectResults.find(item=>item.state==='blocked');
  const reference=firstBlocked??projectResults[0];
  const decision=JSON.stringify({state:reference.state,reason:reference.reason,features:reference.features,nextTask:reference.nextTask});
  const mismatch=!firstBlocked&&projectResults.some(item=>JSON.stringify({state:item.state,reason:item.reason,features:item.features,nextTask:item.nextTask})!==decision);
  const selected=mismatch?{...reference,state:'blocked',reason:'project_admission_mismatch',nextTask:null}:reference;
  const result={...selected,codeProject:input.codeProjects.length===1?selected.codeProject:null,
    codeProjects:projectResults.map(item=>item.codeProject),
    projectAdmissions:projectResults.map(item=>({codeProject:item.codeProject,state:item.state,reason:item.reason}))};
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.state==='blocked'?1:0;
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
