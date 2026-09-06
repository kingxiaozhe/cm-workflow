// Read-only admission for the existing cm-idea workflow.
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
  if(skill!==path.join(root,'skills','cm-idea'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  if(realDirectory(path.join(root,'templates'),'skill_path_invalid')!==path.join(root,'templates'))
    reject('skill_path_invalid');
  ownedFile(root,'skills/cm-idea/SKILL.md','skill_path_invalid');
  ownedFile(root,'skills/cm-idea/references/idea-to-prd.md','skill_path_invalid');
  ownedFile(root,'runtime/project-context.md','skill_path_invalid');
  ownedFile(root,'scripts/cm-idea-entry.mjs','skill_path_invalid');
  return {root,skill,layout};
}

export function inspectCmIdeaAdmission(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1
    ||!Object.hasOwn(input,'skillDir'))reject('invalid_input');
  const {root,skill,layout}=workflowRoot(input.skillDir);
  return frozen({
    schemaVersion:1,workflow:'cm-idea',status:'ready',reason:null,operation:'interview',
    next:'load_interview',workflowRoot:root,skillDir:skill,runtimeLayout:layout,
    handoff:'cm-prd',saveRequiresConfirmation:true,executionAuthorized:false,writeAuthorized:false
  });
}

function parseCli(argv) {
  if(argv.length!==2||argv[0]!=='--skill-dir')reject('invalid_arguments');
  return {skillDir:argv[1]};
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
    const result=inspectCmIdeaAdmission(parseCli(process.argv.slice(2)));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-idea-entry.mjs'))
      reject('entry_path_invalid');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-idea',status:'error',
      reason:error?.code??'admission_failed',executionAuthorized:false,writeAuthorized:false})}\n`);
    process.exitCode=2;
  }
}
