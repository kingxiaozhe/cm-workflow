// Read-only admission for the existing cm-init workflow.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const IGNORED_ROOT_ENTRIES=new Set(['.git','.DS_Store']);

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
  if(skill!==path.join(root,'skills','cm-init'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  if(realDirectory(path.join(root,'templates'),'skill_path_invalid')!==path.join(root,'templates'))
    reject('skill_path_invalid');
  ownedFile(root,'skills/cm-init/SKILL.md','skill_path_invalid');
  ownedFile(root,'runtime/project-context.md','skill_path_invalid');
  ownedFile(root,'scripts/cm-init-entry.mjs','skill_path_invalid');
  return {root,skill,layout};
}

function normalizeInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).length!==2||!Object.hasOwn(input,'skillDir')||!Object.hasOwn(input,'project'))
    reject('invalid_input');
  return input;
}

function hasProjectMaterial(project) {
  try {
    return fs.readdirSync(project).some(name=>!IGNORED_ROOT_ENTRIES.has(name));
  } catch {
    reject('project_path_invalid');
  }
}

export function inspectCmInitAdmission(raw) {
  const input=normalizeInput(raw);
  const {root,skill,layout}=workflowRoot(input.skillDir);
  const project=realDirectory(input.project,'project_path_invalid');
  const existing=hasProjectMaterial(project);
  return frozen({
    schemaVersion:1,workflow:'cm-init',status:existing?'ready':'blocked',
    reason:existing?null:'existing_project_required',next:existing?'analyze_project':'cm-prd',
    workflowRoot:root,skillDir:skill,runtimeLayout:layout,project,
    projectState:existing?'existing':'empty',executionAuthorized:false,writeAuthorized:false
  });
}

function parseCli(argv) {
  const input={};
  for(let index=0;index<argv.length;index+=1){
    const flag=argv[index];
    if(!['--skill-dir','--project'].includes(flag)||index+1>=argv.length
      ||['--skill-dir','--project'].includes(argv[index+1]))reject('invalid_arguments');
    const key=flag==='--skill-dir'?'skillDir':'project';
    if(Object.hasOwn(input,key))reject('invalid_arguments');
    input[key]=argv[index+1];index+=1;
  }
  if(!Object.hasOwn(input,'skillDir')||!Object.hasOwn(input,'project'))reject('invalid_arguments');
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
    const result=inspectCmInitAdmission(parseCli(process.argv.slice(2)));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-init-entry.mjs'))
      reject('entry_path_invalid');
    const output=`${JSON.stringify(result)}\n`;
    if(result.status==='ready')process.stdout.write(output);
    else { process.stderr.write(output);process.exitCode=2; }
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-init',status:'error',
      reason:error?.code??'admission_failed',executionAuthorized:false,writeAuthorized:false})}\n`);
    process.exitCode=2;
  }
}
