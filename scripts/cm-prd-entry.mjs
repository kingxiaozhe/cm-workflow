// Read-only admission for the existing cm-prd workflow.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readCmInitSource} from '../runtime/js/cm-init/draft-inspection.mjs';

const FEATURE_SELECTOR=/^([1-9]\d*)(?:\.([^/\\]+))?$/;

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

function workflowRoot(skillDir,changeMode) {
  const skill=realDirectory(skillDir,'skill_path_invalid');
  const root=realDirectory(path.resolve(skill,'../..'),'skill_path_invalid');
  if(skill!==path.join(root,'skills','cm-prd'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  if(realDirectory(path.join(root,'templates'),'skill_path_invalid')!==path.join(root,'templates'))
    reject('skill_path_invalid');
  for(const file of ['skills/cm-prd/SKILL.md','runtime/project-context.md','runtime/review.md',
    'runtime/logging.md','scripts/cm-prd-entry.mjs'])ownedFile(root,file,'skill_path_invalid');
  if(changeMode)ownedFile(root,'skills/cm-prd/references/change-mode.md','skill_path_invalid');
  return {root,skill,layout};
}

function normalizeInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))reject('invalid_input');
  const keys=Object.keys(input),allowed=new Set(['skillDir','project','specs','change','cases']);
  if(!['skillDir','project','specs'].every(key=>keys.includes(key))||keys.some(key=>!allowed.has(key)))
    reject('invalid_input');
  return input;
}

function sourceInventory(specs) {
  const files=[];let entries=0;
  const visit=relative=>{
    const directory=path.join(specs,relative);
    if(fs.lstatSync(directory).isSymbolicLink()||realDirectory(directory,'source_path_invalid')!==directory)
      reject('source_path_invalid');
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>1000)reject('source_inventory_limit');
      if(item.name.startsWith('.'))continue;
      const file=`${relative}/${item.name}`;
      if(item.isSymbolicLink())reject('source_path_invalid');
      if(item.isDirectory())visit(file);
      else if(item.isFile())files.push(file);
      else reject('source_path_invalid');
    }
  };
  visit('docs');return files;
}

function requirementSources(specs) {
  try {
    const expected=path.join(specs,'docs');
    const docs=realDirectory(expected,'requirements_source_missing');
    if(docs!==expected)return {docs:null,count:0};
    const count=sourceInventory(specs).length;
    return {docs,count};
  } catch(error) {
    if(['source_path_invalid','source_inventory_limit'].includes(error.code))throw error;
    return {docs:null,count:0};
  }
}

function featureCandidates(specs,number) {
  const prefix=`${number}.`;
  return fs.readdirSync(specs,{withFileTypes:true})
    .filter(item=>item.isDirectory()&&item.name.startsWith(prefix))
    .map(item=>item.name).sort((left,right)=>left.localeCompare(right));
}

function validFeatureContract(specs,feature) {
  try {
    const featureRoot=path.join(specs,feature);
    if(realDirectory(featureRoot,'feature_contract_missing')!==featureRoot)return false;
    for(const file of ['requirements.md','design.md','tasks.md'])
      ownedFile(featureRoot,file,'feature_contract_missing');
    return true;
  } catch {
    return false;
  }
}

function resultBase(root,skill,layout,project,specs,cases,mode) {
  return {schemaVersion:1,workflow:'cm-prd',mode,workflowRoot:root,skillDir:skill,
    runtimeLayout:layout,project,specs,cases,requiredRoles:['analyst','planner'],
    roleResolution:'pending',logging:'pending',executionAuthorized:false,writeAuthorized:false};
}

export function inspectCmPrdAdmission(raw) {
  const input=normalizeInput(raw),changeMode=Object.hasOwn(input,'change');
  const {root,skill,layout}=workflowRoot(input.skillDir,changeMode);
  const project=realDirectory(input.project,'project_path_invalid');
  const specs=realDirectory(input.specs,'specs_path_invalid');
  const cases=Object.hasOwn(input,'cases')?realFile(input.cases,'cases_path_invalid'):null;
  const mode=changeMode?'change':'new',base=resultBase(root,skill,layout,project,specs,cases,mode);
  if(!changeMode){
    const {docs,count}=requirementSources(specs);
    if(count===0)return frozen({...base,status:'blocked',reason:'requirements_source_missing',
      next:'add_requirements_docs',docs,requirementsSourceCount:0,feature:null,features:[]});
    return frozen({...base,status:'ready',reason:null,next:'requirements_analysis',docs,
      requirementsSourceCount:count,feature:null,features:[]});
  }
  const selector=text(input.change,'change_selector_invalid').trim();
  const match=selector.match(FEATURE_SELECTOR);
  if(!match)reject('change_selector_invalid');
  const candidates=featureCandidates(specs,match[1]);
  let feature=null;
  if(match[2]){
    if(candidates.includes(selector))feature=selector;
  }else if(candidates.length===1)feature=candidates[0];
  else if(candidates.length>1)return frozen({...base,status:'selection_required',
    reason:'feature_required',next:'select_feature',feature:null,features:candidates});
  if(feature===null)return frozen({...base,status:'blocked',reason:'feature_missing',
    next:'select_existing_feature',feature:null,features:candidates});
  if(!validFeatureContract(specs,feature))return frozen({...base,status:'blocked',
    reason:'feature_contract_missing',next:'repair_feature_contract',feature,features:[feature]});
  return frozen({...base,status:'ready',reason:null,next:'change_analysis',feature,features:[feature],
    requirementsSourceCount:null});
}

// Source bytes are data, never instructions or proof of prototype interaction.
export function inspectCmPrdSources(input){
  const admission=inspectCmPrdAdmission(input);
  if(admission.status!=='ready')return admission;
  if(admission.mode!=='new')reject('source_inspection_new_only');
  const sources=[];let totalBytes=0;
  const readSource=(root,file,displayPath=file)=>{
      const bytes=readCmInitSource(root,file);
      if(bytes===null)reject('source_changed');
      totalBytes+=bytes.length;if(totalBytes>4*1024*1024)reject('source_content_limit');
      const extension=path.extname(file).toLowerCase();
      const format=['.md','.txt'].includes(extension)?'text':['.html','.htm'].includes(extension)?'html':extension==='.pdf'?'pdf':'unsupported';
      const source={path:displayPath,format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
        requiredAction:format==='text'?'analyze_text':format==='html'?'inspect_interactions_in_authorized_browser':format==='pdf'?'extract_pdf':'resolve_unsupported_source'};
      if(['text','html'].includes(format)){
        source.content=bytes.toString('utf8');
        if(!Buffer.from(source.content).equals(bytes))reject('source_text_encoding_invalid');
      }
      return source;
  };
  for(const file of sourceInventory(admission.specs))sources.push(readSource(admission.specs,file));
  const userCases=admission.cases===null?null:{...readSource(path.dirname(admission.cases),
    path.basename(admission.cases),admission.cases),origin:'user'};
  if(sources.length===0)reject('source_changed');
  return frozen({...admission,requirementsSourceCount:sources.length,sourceInspection:{sources,userCases,totalBytes,casesInspected:userCases!==null,completeAnalysis:false,
    prototypeInteractionVerified:false,writeAuthorized:false}});
}

function parseCli(argv) {
  const input={},values=new Map([
    ['--skill-dir','skillDir'],['--project','project'],['--specs','specs'],
    ['--change','change'],['--cases','cases']
  ]);
  for(let index=0;index<argv.length;index+=1){
    const key=values.get(argv[index]);
    if(!key||Object.hasOwn(input,key)||index+1>=argv.length||values.has(argv[index+1]))
      reject('invalid_arguments');
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
    const argv=process.argv.slice(2),sources=argv[0]==='--inspect-sources';
    const result=(sources?inspectCmPrdSources:inspectCmPrdAdmission)(parseCli(sources?argv.slice(1):argv));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-prd-entry.mjs'))
      reject('entry_path_invalid');
    const output=`${JSON.stringify(result)}\n`;
    if(result.status==='ready')process.stdout.write(output);
    else { process.stderr.write(output);process.exitCode=2; }
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-prd',status:'error',
      reason:error?.code??'admission_failed',executionAuthorized:false,writeAuthorized:false})}\n`);
    process.exitCode=2;
  }
}
