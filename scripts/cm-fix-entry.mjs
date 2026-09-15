// Read-only admission for the existing cm-fix workflow.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function reject(code) {
  const error=new Error(code);
  error.code=code;
  throw error;
}

function frozen(value) {
  if(value&&typeof value==='object'){
    for(const item of Object.values(value))frozen(item);
    Object.freeze(value);
  }
  return value;
}

function text(value,code) {
  if(typeof value!=='string'||value.trim().length===0||value.includes('\0'))reject(code);
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

function workflowRoot(skillDir) {
  const skill=realDirectory(skillDir,'skill_path_invalid');
  const root=realDirectory(path.resolve(skill,'../..'),'skill_path_invalid');
  if(skill!==path.join(root,'skills','cm-fix'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  if(realDirectory(path.join(root,'templates'),'skill_path_invalid')!==path.join(root,'templates'))
    reject('skill_path_invalid');
  for(const file of ['skills/cm-fix/SKILL.md','skills/cm-fix/references/cross-boundary-debugging.md',
    'runtime/project-context.md','runtime/orchestration.md','runtime/review.md','runtime/logging.md',
    'runtime/project-learning.md','scripts/cm-fix-entry.mjs'])ownedFile(root,file,'skill_path_invalid');
  return {root,skill,layout};
}

function normalizeInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))reject('invalid_input');
  const keys=Object.keys(input),allowed=new Set(['skillDir','project','specs','defectPresent']);
  if(!['skillDir','project','defectPresent'].every(key=>keys.includes(key))
    ||keys.some(key=>!allowed.has(key))||typeof input.defectPresent!=='boolean')reject('invalid_input');
  return input;
}

export function inspectCmFixAdmission(raw) {
  const input=normalizeInput(raw);
  const {root,skill,layout}=workflowRoot(input.skillDir);
  const project=realDirectory(input.project,'project_path_invalid');
  const specs=Object.hasOwn(input,'specs')?realDirectory(input.specs,'specs_path_invalid'):null;
  const base={
    schemaVersion:1,workflow:'cm-fix',workflowRoot:root,skillDir:skill,runtimeLayout:layout,
    project,specs,mode:specs===null?'bare':'specs',requiredRoles:['coder','tester','reviewer'],
    roleResolution:'pending',logging:'pending',learning:'pending',reviewPreflightRequired:true,
    executionAuthorized:false,writeAuthorized:false
  };
  if(!input.defectPresent)return frozen({...base,status:'blocked',reason:'defect_required',
    next:'collect_defect_description'});
  return frozen({...base,status:'ready',reason:null,next:'reproduce',reproductionRequired:true,
    unreproducedNext:'observation',designIssueNext:'cm-prd_change',maxReviewRounds:2});
}

function parseCli(argv) {
  const input={defectPresent:false},values=new Map([
    ['--skill-dir','skillDir'],['--project','project'],['--specs','specs']
  ]);
  for(let index=0;index<argv.length;index+=1){
    const flag=argv[index];
    if(flag==='--defect-present'){
      if(input.defectPresent)reject('invalid_arguments');
      input.defectPresent=true;continue;
    }
    const key=values.get(flag);
    if(!key||Object.hasOwn(input,key)||index+1>=argv.length
      ||values.has(argv[index+1])||argv[index+1]==='--defect-present')reject('invalid_arguments');
    input[key]=argv[index+1];index+=1;
  }
  return input;
}

function isMainModule(entry) {
  if(!entry)return false;
  try {
    return fs.realpathSync(entry)===fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(entry)===fileURLToPath(import.meta.url);
  }
}

if(isMainModule(process.argv[1])){
  try {
    const result=inspectCmFixAdmission(parseCli(process.argv.slice(2)));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-fix-entry.mjs'))
      reject('entry_path_invalid');
    const output=`${JSON.stringify(result)}\n`;
    if(result.status==='ready')process.stdout.write(output);
    else { process.stderr.write(output);process.exitCode=2; }
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-fix',status:'error',
      reason:error?.code??'admission_failed',executionAuthorized:false,writeAuthorized:false})}\n`);
    process.exitCode=2;
  }
}
