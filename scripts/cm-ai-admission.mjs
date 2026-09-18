#!/usr/bin/env node
// Product CLI for the shipped read-only cm-ai N1/N2 admission authority.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {validateRunDefinition} from './cm-ai-run.mjs';

const usage='usage: cm-ai-admission.mjs --specs-dir PATH --code-project PATH [--code-project PATH ...] [--approval-response TEXT | --yes] [--print-run-definition --scope a,b [--requirements c,d] [--run-id X] [--repository-id Y]]';

function parse(argv){
  const result={codeProjects:[]};
  for(let index=0;index<argv.length;index++){
    const flag=argv[index];
    if(flag==='--help'||flag==='-h')return {help:true};
    if(flag==='--print-run-definition'){
      if(result.printRunDefinition)throw new Error('invalid arguments');
      result.printRunDefinition=true;continue;
    }
    if(flag==='--yes'){if(result.assumeYes||Object.hasOwn(result,'approvalResponse'))throw new Error('approval input is duplicated');result.assumeYes=true;continue;}
    if(flag==='--code-project'){
      if(index+1>=argv.length||result.codeProjects.length>=16)throw new Error('invalid arguments');
      result.codeProjects.push(argv[++index]);continue;
    }
    const key={'--specs-dir':'specsDir','--approval-response':'approvalResponse',
      '--scope':'scope','--requirements':'requirements','--run-id':'runId','--repository-id':'repositoryId'}[flag];
    if(!key||index+1>=argv.length||Object.hasOwn(result,key))throw new Error('invalid arguments');
    result[key]=argv[++index];
  }
  if(!result.specsDir||result.codeProjects.length===0)throw new Error('specs and code project paths are required');
  if(result.assumeYes&&Object.hasOwn(result,'approvalResponse'))throw new Error('approval input is duplicated');
  if(!result.printRunDefinition&&['scope','requirements','runId','repositoryId'].some(key=>Object.hasOwn(result,key)))
    throw new Error('run definition options require --print-run-definition');
  return result;
}

function buildRunDefinition(admission,input){
  if(!admission.codeProject)throw new Error('--print-run-definition requires one --code-project');
  let repositoryId=input.repositoryId;
  if(repositoryId===undefined){
    let name;
    try{name=JSON.parse(fs.readFileSync(path.join(admission.codeProject,'package.json'),'utf8')).name;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    repositoryId=name??path.basename(admission.codeProject);
  }
  const list=value=>value===undefined||value===''?[]:value.split(',').map(item=>item.trim());
  const definition={version:1,specsDir:admission.specsDir,codeProject:admission.codeProject,
    feature:admission.nextTask.feature,
    identity:{repositoryId,runId:input.runId??`${admission.nextTask.feature.replace(/^\d+\./,'')}-${admission.nextTask.id}`,
      taskId:admission.nextTask.id,attempt:1},
    scope:list(input.scope),requirements:list(input.requirements)};
  return validateRunDefinition(definition);
}

export function main(argv=process.argv.slice(2)){
  let input;
  try{input=parse(argv);}catch(error){process.stderr.write(`${usage}\nERROR: ${error.message}\n`);return 2;}
  if(input.help){process.stdout.write(`${usage}\n`);return 0;}
  if(input.printRunDefinition&&!Object.hasOwn(input,'scope')){
    process.stderr.write('--print-run-definition 需要 --scope：本任务允许修改的文件，相对代码根，逗号分隔（例：--scope src/todos.js,test/todos.test.js）\n');
    return 2;
  }
  const projectResults=input.codeProjects.map(codeProject=>inspectCmAiAdmission({...input,codeProject}));
  const firstBlocked=projectResults.find(item=>item.state==='blocked');
  const reference=firstBlocked??projectResults[0];
  const decision=JSON.stringify({state:reference.state,reason:reference.reason,features:reference.features,nextTask:reference.nextTask});
  const mismatch=!firstBlocked&&projectResults.some(item=>JSON.stringify({state:item.state,reason:item.reason,features:item.features,nextTask:item.nextTask})!==decision);
  const selected=mismatch?{...reference,state:'blocked',reason:'project_admission_mismatch',nextTask:null}:reference;
  const result={...selected,codeProject:input.codeProjects.length===1?selected.codeProject:null,
    codeProjects:projectResults.map(item=>item.codeProject),
    projectAdmissions:projectResults.map(item=>({codeProject:item.codeProject,state:item.state,reason:item.reason}))};
  if(input.printRunDefinition&&result.state==='ready'){
    try{process.stdout.write(`${JSON.stringify(buildRunDefinition(result,input))}\n`);return 0;}
    catch(error){process.stderr.write(`${JSON.stringify({error:{code:error.code??error.message}})}\n`);return 1;}
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.state==='blocked'?1:0;
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
