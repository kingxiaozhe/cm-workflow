// Read-only JS entry for the existing CM runtime checker.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function reject(code) {
  const error=new Error(code);
  error.code=code;
  throw error;
}

function text(value,code) {
  if(typeof value!=='string'||value.length===0||value.includes('\0'))reject(code);
  return value;
}

function realDirectory(raw,code) {
  try {
    const target=fs.realpathSync(path.resolve(text(raw,code)));
    const stat=fs.lstatSync(target);
    if(!stat.isDirectory()||stat.isSymbolicLink())reject(code);
    return target;
  } catch(error) {
    if(error?.code===code)throw error;
    reject(code);
  }
}

function realFile(raw,code) {
  try {
    const target=fs.realpathSync(path.resolve(text(raw,code)));
    const stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink())reject(code);
    return target;
  } catch(error) {
    if(error?.code===code)throw error;
    reject(code);
  }
}

function ownedFile(root,relative,code) {
  try {
    const target=path.join(root,relative);
    const stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(target)!==target)reject(code);
    return target;
  } catch(error) {
    if(error?.code===code)throw error;
    reject(code);
  }
}

export function createCmCheckInvocation(input) {
  const allowed=['skillDir','project'];
  if(input&&Object.hasOwn(input,'config'))allowed.push('config');
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).length!==allowed.length||!allowed.every(key=>Object.hasOwn(input,key)))reject('invalid_input');
  const skillDir=realDirectory(input.skillDir,'skill_path_invalid');
  const workflowRoot=realDirectory(path.resolve(skillDir,'../..'),'skill_path_invalid');
  if(skillDir!==path.join(workflowRoot,'skills','cm-check'))reject('skill_path_invalid');
  ownedFile(workflowRoot,'skills/cm-check/SKILL.md','skill_path_invalid');
  const checker=ownedFile(workflowRoot,'scripts/cm-check-runtime.sh','checker_path_invalid');
  const project=realDirectory(input.project,'project_path_invalid');
  const args=['--project',project];
  let config=null;
  if(Object.hasOwn(input,'config')){
    config=realFile(input.config,'config_path_invalid');
    args.push('--config',config);
  }
  args.push('--print-effective');
  return Object.freeze({workflow:'cm-check',workflowRoot,skillDir,checker,project,config,args:Object.freeze(args)});
}

export function runCmCheck(input) {
  const invocation=createCmCheckInvocation(input);
  let result;
  try {
    result=childProcess.spawnSync(invocation.checker,invocation.args,{cwd:invocation.project,stdio:'inherit'});
  } catch {
    reject('checker_unavailable');
  }
  if(result.error||result.signal!==null||!Number.isInteger(result.status))reject('checker_unavailable');
  return Object.freeze({
    workflow:invocation.workflow,
    outcome:result.status===0?'passed':'failed',
    exitCode:result.status,
    invocation
  });
}

function parseCli(argv) {
  const input={};
  let printEffective=false;
  for(let index=0;index<argv.length;index+=1){
    const flag=argv[index];
    if(flag==='--print-effective'){
      if(printEffective)reject('invalid_arguments');
      printEffective=true;
      continue;
    }
    if(!['--skill-dir','--project','--config'].includes(flag)||index+1>=argv.length)reject('invalid_arguments');
    const key=flag==='--skill-dir'?'skillDir':flag.slice(2);
    if(Object.hasOwn(input,key))reject('invalid_arguments');
    input[key]=argv[index+1];
    index+=1;
  }
  if(!printEffective||!Object.hasOwn(input,'skillDir')||!Object.hasOwn(input,'project'))reject('invalid_arguments');
  return input;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const result=runCmCheck(parseCli(process.argv.slice(2)));
    process.exitCode=result.exitCode;
  } catch(error) {
    process.stderr.write(`cm-check JS entry: ${error?.code??'checker_unavailable'}\n`);
    process.exitCode=2;
  }
}
