// Read-only admission for the existing cm-test workflow.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FEATURE=/^(\d+)\.(.+)$/;
const OPTIONAL=new Set(['description','specs','feature','cases','reportDir','generateCases',
  'logic','commands','browser','all','explore']);

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

function boolean(value,code) {
  if(typeof value!=='boolean')reject(code);
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

function inside(root,target) {
  const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

function workflowRoot(skillDir) {
  const skill=realDirectory(skillDir,'skill_path_invalid');
  const root=realDirectory(path.resolve(skill,'../..'),'skill_path_invalid');
  if(skill!==path.join(root,'skills','cm-test'))reject('skill_path_invalid');
  let layout;
  if(fs.existsSync(path.join(root,'VERSION'))){
    ownedFile(root,'VERSION','skill_path_invalid');layout='plugin';
  }else if(fs.existsSync(path.join(root,'templates','cm-VERSION'))){
    ownedFile(root,'templates/cm-VERSION','skill_path_invalid');layout='claude-compat';
  }else reject('skill_path_invalid');
  ownedFile(root,'skills/cm-test/SKILL.md','skill_path_invalid');
  ownedFile(root,'runtime/test-contract.md','skill_path_invalid');
  ownedFile(root,'scripts/cm-test-entry.mjs','skill_path_invalid');
  realDirectory(path.join(root,'templates'),'skill_path_invalid');
  return {root,skill,layout};
}

function featureNames(specs) {
  return fs.readdirSync(specs,{withFileTypes:true})
    .filter(item=>item.isDirectory()&&FEATURE.test(item.name))
    .map(item=>item.name)
    .sort((left,right)=>Number(left.match(FEATURE)[1])-Number(right.match(FEATURE)[1])
      ||left.localeCompare(right));
}

function validFeature(specs,name,strict) {
  try {
    const featureRoot=path.join(specs,name);
    if(fs.realpathSync(featureRoot)!==featureRoot)reject('feature_contract_invalid');
    for(const file of ['requirements.md','design.md','tasks.md'])ownedFile(featureRoot,file,'feature_contract_missing');
    return true;
  } catch(error) {
    if(strict)throw error;
    return false;
  }
}

function normalizeInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))reject('invalid_input');
  const keys=Object.keys(input);
  if(!keys.includes('skillDir')||!keys.includes('project')
    ||keys.some(key=>!['skillDir','project'].includes(key)&&!OPTIONAL.has(key)))reject('invalid_input');
  for(const key of ['generateCases','logic','commands','browser','all'])
    if(Object.hasOwn(input,key))boolean(input[key],'invalid_input');
  return input;
}

export function inspectCmTestAdmission(raw) {
  const input=normalizeInput(raw);
  const {root,skill,layout}=workflowRoot(input.skillDir);
  const project=realDirectory(input.project,'project_path_invalid');
  const flags={
    generateCases:input.generateCases===true,
    logic:input.logic===true,
    commands:input.commands===true,
    browser:input.browser===true,
    all:input.all===true
  };
  const hasCases=Object.hasOwn(input,'cases'),hasExplore=Object.hasOwn(input,'explore');
  const explicitExecution=flags.logic||flags.commands||flags.browser||flags.all;
  if(flags.generateCases&&(hasCases||explicitExecution||hasExplore))reject('generate_cases_conflict');
  if(hasExplore&&(hasCases||explicitExecution))reject('explore_conflict');
  if(Object.hasOwn(input,'feature')&&!Object.hasOwn(input,'specs'))reject('feature_without_specs');
  const description=Object.hasOwn(input,'description')?text(input.description,'description_invalid'):null;
  const explore=Object.hasOwn(input,'explore')?text(input.explore,'explore_invalid'):null;
  const requestedReportDir=Object.hasOwn(input,'reportDir')
    ?path.resolve(text(input.reportDir,'report_dir_invalid')):null;
  const cases=hasCases?realFile(input.cases,'cases_path_invalid'):null;
  let specs=null,features=[],feature=null;
  if(Object.hasOwn(input,'specs')){
    specs=realDirectory(input.specs,'specs_path_invalid');
    if(inside(project,specs)&&specs!==path.join(project,'specs'))reject('specs_location_invalid');
    const discovered=featureNames(specs);
    if(discovered.length===0)reject('features_missing');
    if(Object.hasOwn(input,'feature')){
      feature=text(input.feature,'feature_invalid');
      if(!FEATURE.test(feature)||!discovered.includes(feature))reject('feature_invalid');
      validFeature(specs,feature,true);features=[feature];
    }else{
      features=discovered.filter(name=>validFeature(specs,name,false));
      if(features.length===0)reject('feature_contract_missing');
      if(features.length===1)feature=features[0];
    }
  }
  if(specs&&feature===null)return frozen({
    schemaVersion:1,workflow:'cm-test',status:'selection_required',reason:'feature_required',
    workflowRoot:root,skillDir:skill,runtimeLayout:layout,project,specs,features,
    executionAuthorized:false,writeAuthorized:false
  });
  let operation,modes,hardStopAfterGeneration=false;
  if(flags.generateCases){
    if(description===null&&feature===null)reject('generation_target_required');
    operation='generate_cases';modes=[];hardStopAfterGeneration=true;
  }else if(explore){
    operation='explore';modes=['browser'];
  }else{
    if(description===null&&specs===null&&cases===null)reject('test_target_required');
    operation='execute';
    modes=flags.all||!explicitExecution?['logic','commands','browser']:
      ['logic','commands','browser'].filter(mode=>flags[mode]);
  }
  const requiredRoles=[];
  if(modes.includes('logic')||modes.includes('commands'))requiredRoles.push('tester');
  if(modes.includes('browser'))requiredRoles.push('browser_qa');
  return frozen({
    schemaVersion:1,workflow:'cm-test',status:'ready',reason:null,operation,modes,requiredRoles,
    workflowRoot:root,skillDir:skill,runtimeLayout:layout,project,specs,feature,features,cases,requestedReportDir,
    reportDirBoundary:'pending',hardStopAfterGeneration,executionAuthorized:false,writeAuthorized:false
  });
}

function parseCli(argv) {
  const input={};
  const values=new Map([
    ['--skill-dir','skillDir'],['--project','project'],['--description','description'],['--specs','specs'],
    ['--feature','feature'],['--cases','cases'],['--report-dir','reportDir'],['--explore','explore']
  ]);
  const switches=new Map([
    ['--generate-cases','generateCases'],['--logic','logic'],['--commands','commands'],
    ['--browser','browser'],['--all','all']
  ]);
  const known=new Set([...values.keys(),...switches.keys()]);
  for(let index=0;index<argv.length;index+=1){
    const flag=argv[index];
    const valueKey=values.get(flag),switchKey=switches.get(flag);
    if(valueKey){
      if(Object.hasOwn(input,valueKey)||index+1>=argv.length||known.has(argv[index+1]))reject('invalid_arguments');
      input[valueKey]=argv[index+1];index+=1;
    }else if(switchKey){
      if(Object.hasOwn(input,switchKey))reject('invalid_arguments');
      input[switchKey]=true;
    }else reject('invalid_arguments');
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
    const result=inspectCmTestAdmission(parseCli(process.argv.slice(2)));
    if(fileURLToPath(import.meta.url)!==path.join(result.workflowRoot,'scripts','cm-test-entry.mjs'))
      reject('entry_path_invalid');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch(error) {
    process.stderr.write(`${JSON.stringify({schemaVersion:1,workflow:'cm-test',status:'blocked',
      reason:error?.code??'admission_failed'})}\n`);
    process.exitCode=2;
  }
}
