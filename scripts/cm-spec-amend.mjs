#!/usr/bin/env node
// Tiered re-approval of in-flight spec corrections; see runtime/js/cm-ai/spec-amendment.mjs.
//   inspect  只读：给出 0/1/2 级与原因
//   prepare  1 级时把批准时与现在的规格副本、审查提示写到 --out 目录
//   apply    0 级直接换绑；1 级需独立审查输出（--review-output）与审查者（--reviewer）
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectSpecAmendment,publicAmendment,prepareSpecAmendment,applySpecAmendment} from '../runtime/js/cm-ai/spec-amendment.mjs';

const usage=`usage: cm-spec-amend.mjs inspect --specs-dir PATH
       cm-spec-amend.mjs prepare --specs-dir PATH --out EMPTY_DIR
       cm-spec-amend.mjs apply --specs-dir PATH --reason TEXT [--review-output FILE --reviewer TEXT]`;

const NEXT={
  null:'规格与批准时相同，不需要换绑。',
  0:'0 级：只追加了版本记录行。运行 apply --reason 直接换绑，不需要审查，也不需要用户回复「开始」。',
  1:'1 级：执行中补正。先 prepare，把 review-prompt.md 交给另一个新上下文的审查者（不是写补正的人），保存其完整输出，再 apply --review-output --reviewer。生效后在下一条消息里告诉用户改了什么，不必等回复。',
  2:'2 级：要用户本人批准。展示改动摘要，请用户回复「开始」，再走 cm-ai-admission.mjs --approve。',
};

function parse(argv){
  const [command,...rest]=argv;
  if(!command||command==='--help'||command==='-h')return {help:true};
  if(!['inspect','prepare','apply'].includes(command))throw new Error('unknown command');
  const flags={'--specs-dir':'specsDir','--out':'outDir','--reason':'reason','--review-output':'reviewOutput','--reviewer':'reviewer'};
  const allowed={inspect:['specsDir'],prepare:['specsDir','outDir'],apply:['specsDir','reason','reviewOutput','reviewer']}[command];
  const result={command};
  for(let index=0;index<rest.length;index++){
    const key=flags[rest[index]];
    if(!key||!allowed.includes(key)||index+1>=rest.length||Object.hasOwn(result,key))throw new Error('invalid arguments');
    result[key]=rest[++index];
  }
  if(!result.specsDir)throw new Error('--specs-dir is required');
  if(command==='prepare'&&!result.outDir)throw new Error('--out is required');
  if(command==='apply'&&!result.reason)throw new Error('--reason is required');
  return result;
}

export function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  let input;
  try{input=parse(argv);}catch(error){stderr.write(`${usage}\nERROR: ${error.message}\n`);return 2;}
  if(input.help){stdout.write(`${usage}\n`);return 0;}
  const specsDir=path.resolve(input.specsDir);
  try{
    if(input.command==='inspect'){
      const result=publicAmendment(inspectSpecAmendment(specsDir));
      stdout.write(`${JSON.stringify({...result,next:NEXT[result.tier]})}\n`);return 0;
    }
    if(input.command==='prepare'){
      const result=prepareSpecAmendment(specsDir,{outDir:input.outDir});
      stdout.write(`${JSON.stringify({...result,next:NEXT[result.tier]})}\n`);return result.tier===1?0:1;
    }
    let reviewOutput;
    if(input.reviewOutput!==undefined)reviewOutput=fs.readFileSync(path.resolve(input.reviewOutput),'utf8');
    const result=applySpecAmendment(specsDir,{reason:input.reason,reviewOutput,reviewer:input.reviewer});
    stdout.write(`${JSON.stringify({...result,...(result.applied?{}:{next:NEXT[result.tier]})})}\n`);
    return result.applied?0:1;
  }catch(error){
    stderr.write(`${JSON.stringify({error:{code:error.code??error.message}})}\n`);return 1;
  }
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
