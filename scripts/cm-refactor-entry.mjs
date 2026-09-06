// Read-only admission and route gate for the existing cm-refactor workflow.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const INTENTS=new Set(['defect','behavior-change','gradual-adoption','structure-only']);

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
  if(skill!==path.join(root,'skills','cm-refactor'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  if(realDirectory(path.join(root,'templates'),'skill_path_invalid')!==path.join(root,'templates'))
    reject('skill_path_invalid');
  for(const file of ['skills/cm-refactor/SKILL.md','templates/refactor/cm-refactor-denies.json',
    'runtime/project-context.md','runtime/orchestration.md','runtime/workflow-routing.md',
    'runtime/review.md','runtime/logging.md','runtime/project-learning.md',
    'scripts/cm-refactor-entry.mjs'])ownedFile(root,file,'skill_path_invalid');
  return {root,skill,layout};
}

function normalizeInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))reject('invalid_input');
  const keys=Object.keys(input),allowed=new Set(['skillDir','project','specs','targetPresent','intent']);
  if(!['skillDir','project','targetPresent','intent'].every(key=>keys.includes(key))
    ||keys.some(key=>!allowed.has(key))||typeof input.targetPresent!=='boolean'
    ||typeof input.intent!=='string'||!INTENTS.has(input.intent))reject('invalid_input');
  text(input.project,'invalid_input');
  if(Object.hasOwn(input,'specs'))text(input.specs,'invalid_input');
  return input;
}

export function inspectCmRefactorAdmission(raw) {
  const input=normalizeInput(raw);
  const {root,skill,layout}=workflowRoot(input.skillDir);
  const base={
    schemaVersion:1,workflow:'cm-refactor',workflowRoot:root,skillDir:skill,runtimeLayout:layout,
    intent:input.intent,executionAuthorized:false,writeAuthorized:false
  };
  if(!input.targetPresent)return frozen({...base,status:'blocked',reason:'target_required',
    next:'collect_refactor_target'});
  if(input.intent==='defect')return frozen({...base,status:'redirect',
    reason:'defect_flow_required',next:'cm-fix'});
  if(input.intent==='behavior-change')return frozen({...base,status:'redirect',
    reason:'behavior_change_flow_required',next:'cm-prd_change'});
  if(input.intent==='gradual-adoption')return frozen({...base,status:'redirect',
    reason:'gradual_adoption_not_refactor',next:'ordinary_change'});
  const project=realDirectory(input.project,'project_path_invalid');
  const specs=Object.hasOwn(input,'specs')?realDirectory(input.specs,'specs_path_invalid'):null;
  return frozen({...base,project,specs,mode:specs===null?'bare':'specs',status:'ready',
    reason:null,next:'g0_feasibility',
    behaviorMustRemainUnchanged:true,humanApprovalRequiredBeforeChange:true,
    requiredRoles:['coder','tester','reviewer'],roleResolution:'pending',logging:'pending',
    learning:'pending'});
}

function parseCli(argv) {
  const input={targetPresent:false},values=new Map([
    ['--skill-dir','skillDir'],['--project','project'],['--specs','specs'],['--intent','intent']
  ]);
  for(let index=0;index<argv.length;index+=1){
    const flag=argv[index];
    if(flag==='--target-present'){
      if(input.targetPresent)reject('invalid_arguments');
      input.targetPresent=true;continue;
    }
    const key=values.get(flag);
    if(!key||Object.hasOwn(input,key)||index+1>=argv.length
      ||values.has(argv[index+1])||argv[index+1]==='--target-present')reject('invalid_arguments');
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
    const result=inspectCmRefactorAdmission(parseCli(process.argv.slice(2)));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-refactor-entry.mjs'))
      reject('entry_path_invalid');
    const output=`${JSON.stringify(result)}\n`;
    if(result.status==='ready')process.stdout.write(output);
    else { process.stderr.write(output);process.exitCode=2; }
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-refactor',status:'error',
      reason:error?.code??'admission_failed',executionAuthorized:false,writeAuthorized:false})}\n`);
    process.exitCode=2;
  }
}
