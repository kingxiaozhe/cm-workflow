// Read-only N1/N2 admission for the fixed cm-ai workflow. It never writes project state.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TASK=/^\s*-\s*\[([ xX])\]\s+(?:~~)?(T-[A-Za-z0-9][A-Za-z0-9._-]*)(?=[:\s])[:\s]*(.*)$/;
const DEPENDENCY=/^\s*-\s*(T-[A-Za-z0-9][A-Za-z0-9._-]*)\s+依赖\s+(.+)$/;
const TASK_ID=/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ACCEPTANCE=/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(?:\[(AC-\d{3,})\]|(AC-\d{3,}))(?=[:\s])/;
const FEATURE=/^(\d+)\.(.+)$/;
const TEST_CASE_VALIDATOR=fileURLToPath(new URL('../../../scripts/validate-test-cases.mjs',import.meta.url));

// Greenfield's T-001 scaffolds; its subsequent instruction task (normally
// T-002) owns init-equivalent rules. Use the existing parser and approval gate.
export function inspectCmAiBootstrapTask({specsDir,codeProject,taskId},inProgress=false) {
  const admission=admissionFor({specsDir,codeProject},inProgress?taskId:null);
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(!['ready','complete'].includes(admission.state))fail(admission.reason);
  const parsed=readFeature(admission.specsDir,'0.bootstrap');if(parsed.error)fail(parsed.error);
  const task=parsed.tasks.find(item=>item.id===taskId&&!item.dropped);
  const mode=task?.id==='T-001'&&/(?:脚手架|骨架|scaffold)/i.test(task.description)?'scaffold':'instructions';
  if(!task||mode==='instructions'&&(!/(?:cm-init|\.claude\/|AGENTS\.md)/i.test(task.description)
    ||!/(?:生成|规范|规则|instruction|rules|generate)/i.test(task.description)))fail('bootstrap_task_required');
  return frozen({task,mode,admission});
}

// Read N6 task counts with the original task parser, including later features.
export function inspectCmAiQaTaskContext({specsDir,codeProject,feature,taskId}) {
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(!['ready','complete'].includes(admission.state))fail(admission.reason);
  const discovered=discoverFeatures(admission.specsDir);if(discovered.error)fail(discovered.error);
  const completed=[];let selected=null;
  for(const name of discovered.names){
    const parsed=readFeature(admission.specsDir,name);if(parsed.error)fail(parsed.error);
    if(name===feature)selected=parsed.tasks;
    for(const task of parsed.tasks)if(task.completed&&!task.dropped)completed.push({feature:name,id:task.id});
  }
  if(!selected?.some(task=>task.id===taskId&&task.completed&&!task.dropped))fail('qa_not_ready');
  const pending=selected.filter(task=>!task.completed&&!task.dropped).length;
  return frozen({completed,pending,mergeEligible:pending===1&&admission.nextTask?.feature===feature});
}

// Admission's public feature summary stops at the selected feature. Count all
// approved features with the same parser before treating a task as the last one.
export function isFinalCmAiTask({specsDir,codeProject,feature,taskId}) {
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  if(admission.state!=='ready'||admission.nextTask.feature!==feature||admission.nextTask.id!==taskId)
    throw Object.assign(new Error('documentation_admission_required'),{code:'documentation_admission_required'});
  const discovered=discoverFeatures(admission.specsDir);
  if(discovered.error)throw Object.assign(new Error(discovered.error),{code:discovered.error});
  let pending=0;
  for(const name of discovered.names){
    const parsed=readFeature(admission.specsDir,name);
    if(parsed.error)throw Object.assign(new Error(parsed.error),{code:parsed.error});
    pending+=parsed.tasks.filter(task=>!task.completed&&!task.dropped).length;
  }
  return pending===1;
}

function frozen(value){
  if(value && typeof value==='object'){for(const item of Object.values(value))frozen(item);Object.freeze(value);}
  return value;
}

function result(base,state,reason,extra={}){
  return frozen({...base,state,reason,features:[],nextTask:null,warnings:[],...extra});
}

function directory(value){
  if(typeof value!=='string'||!value.trim())return null;
  const resolved=path.resolve(value);
  try{return fs.statSync(resolved).isDirectory()?resolved:null;}catch{return null;}
}

function approvalIntent(response,assumeYes){
  if(assumeYes===true)return 'explicit';
  if(response===undefined||response===null||response==='')return 'none';
  return typeof response==='string'&&response.trim()==='开始'?'explicit':'not_approval';
}

function readStatus(specsDir){
  const target=path.join(specsDir,'.cm-specs-status');
  if(!fs.existsSync(target))return {kind:'missing'};
  try{
    const specsRoot=fs.realpathSync(specsDir),realTarget=fs.realpathSync(target);
    if(!contained(specsRoot,realTarget))return {kind:'invalid'};
    const value=JSON.parse(fs.readFileSync(realTarget,'utf8'));
    if(value===null||typeof value!=='object'||Array.isArray(value)||!['approved','awaiting_review'].includes(value.status))
      return {kind:'invalid'};
    return {kind:'valid',value};
  }catch{return {kind:'invalid'};}
}

function contained(root,target){
  const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

function discoverFeatures(specsDir){
  const specsRoot=fs.realpathSync(specsDir);
  const names=fs.readdirSync(specsDir,{withFileTypes:true})
    .filter(entry=>entry.isDirectory()&&FEATURE.test(entry.name))
    .map(entry=>entry.name)
    .sort((a,b)=>{
      if(a==='0.bootstrap')return b==='0.bootstrap'?0:-1;
      if(b==='0.bootstrap')return 1;
      const an=Number(a.match(FEATURE)[1]),bn=Number(b.match(FEATURE)[1]);
      return an-bn||(a<b?-1:a>b?1:0);
    });
  if(!names.length)return {error:'features_missing'};
  const reviewKeys=names.flatMap(name=>[name,name.replace(/^\d+\./,'')]);
  if(new Set(reviewKeys).size!==reviewKeys.length)return {error:'feature_contract_invalid'};
  for(const name of names){
    const root=path.join(specsDir,name);
    let featureRoot;
    try{featureRoot=fs.realpathSync(root);}catch{return {error:'feature_contract_missing'};}
    if(!contained(specsRoot,featureRoot))return {error:'feature_contract_invalid'};
    for(const file of ['requirements.md','design.md','tasks.md']){
      try{
        const target=path.join(root,file);
        if(!fs.statSync(target).isFile())return {error:'feature_contract_missing'};
        if(!contained(featureRoot,fs.realpathSync(target)))return {error:'feature_contract_invalid'};
      }
      catch{return {error:'feature_contract_missing'};}
    }
  }
  return {names};
}

function approvedFeaturesProblem(status,names){
  if(!Array.isArray(status.features)||status.features.some(name=>typeof name!=='string'||!FEATURE.test(name)))
    return 'spec_status_invalid';
  const approved=new Set(status.features);
  if(approved.size!==status.features.length)return 'spec_status_invalid';
  if(approved.size!==names.length||names.some(name=>!approved.has(name)))return 'spec_features_changed';
  return null;
}

function validJson(bytes){
  try{JSON.parse(bytes.toString('utf8'));return true;}catch{return false;}
}

function validTestContract(target,featureName){
  const checked=spawnSync(process.execPath,[TEST_CASE_VALIDATOR,target],{stdio:'ignore'});
  if(checked.error||checked.status!==0)return false;
  let data;
  try{data=JSON.parse(fs.readFileSync(target,'utf8'));}catch{return false;}
  if(data.feature!==featureName)return false;
  const featureRoot=path.dirname(target);
  let sources;
  try{sources=['requirements.md','design.md','tasks.md'].map(file=>fs.readFileSync(path.join(featureRoot,file),'utf8'));}
  catch{return false;}
  const acIds=new Set(sources.flatMap(source=>source.split(/\r?\n/).map(line=>line.match(ACCEPTANCE)).filter(Boolean).map(match=>match[1]||match[2])));
  const taskIds=new Set(sources[2].split(/\r?\n/).map(line=>line.match(TASK)).filter(Boolean).map(match=>match[2]));
  return data.cases.every(item=>item.acIds.every(id=>acIds.has(id))&&item.taskIds.every(id=>taskIds.has(id)));
}

function validateTestCases(specsDir,status,names){
  if(Object.hasOwn(status,'testCases')){
    if(!Array.isArray(status.testCases))return 'spec_status_invalid';
    const expected=new Set(names.map(name=>path.resolve(specsDir,name,'test-cases.json')).filter(target=>fs.existsSync(target)));
    const recorded=new Set();
    for(const item of status.testCases){
      if(item===null||typeof item!=='object'||Array.isArray(item)||typeof item.path!=='string'||!item.path||
        path.isAbsolute(item.path)||typeof item.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(item.sha256))return 'spec_status_invalid';
      const target=path.resolve(specsDir,item.path);
      if(!target.startsWith(`${path.resolve(specsDir)}${path.sep}`)||recorded.has(target))return 'spec_status_invalid';
      recorded.add(target);
      if(!expected.has(target))return 'test_cases_changed';
      let bytes;
      try{
        const featureRoot=fs.realpathSync(path.dirname(target)),realTarget=fs.realpathSync(target);
        if(!contained(featureRoot,realTarget))return 'spec_status_invalid';
        bytes=fs.readFileSync(realTarget);
      }catch{return 'test_cases_changed';}
      const actual=createHash('sha256').update(bytes).digest('hex');
      if(actual!==item.sha256.toLowerCase())return 'test_cases_changed';
      if(!validJson(bytes))return 'test_cases_invalid';
      const featureName=path.basename(path.dirname(target)).replace(/^\d+\./,'');
      if(!validTestContract(target,featureName))return 'test_cases_invalid';
    }
    if(expected.size!==recorded.size||[...expected].some(target=>!recorded.has(target)))return 'test_cases_changed';
    return null;
  }
  for(const name of names){
    const target=path.join(specsDir,name,'test-cases.json');
    try{
      if(fs.existsSync(target)){
        const featureRoot=fs.realpathSync(path.join(specsDir,name)),realTarget=fs.realpathSync(target);
        if(!contained(featureRoot,realTarget)||!validJson(fs.readFileSync(realTarget))||
          !validTestContract(target,name.replace(/^\d+\./,'')))return 'test_cases_invalid';
      }
    }
    catch{return 'test_cases_invalid';}
  }
  return null;
}

function readFeature(specsDir,name){
  return parseFeatureTaskText(fs.readFileSync(path.join(specsDir,name,'tasks.md'),'utf8'));
}

export function declaredAcceptanceIds(source){
  return new Set(source.split(/\r?\n/).map(line=>line.match(ACCEPTANCE)).filter(Boolean).map(match=>match[1]||match[2]));
}

export function parseFeatureTaskText(source){
  const lines=source.split(/\r?\n/);
  const tasks=[];
  const taskIds=new Set();
  const dependencies=new Map();
  for(const line of lines){
    const task=line.match(TASK);
    if(task){
      if(taskIds.has(task[2]))return {error:'tasks_invalid'};
      taskIds.add(task[2]);
      const dropped=/\[DROPPED(?:\s[^\]]*)?\]/.test(task[3]);
      tasks.push({
        id:task[2],
        description:task[3].replace(/~~\s*\[DROPPED(?:\s[^\]]*)?\].*$/,'').trim(),
        completed:task[1].toLowerCase()==='x',
        dropped,
      });
      continue;
    }
    const dependency=line.match(DEPENDENCY);
    if(dependency){
      if(dependencies.has(dependency[1]))return {error:'dependencies_invalid'};
      const required=dependency[2].split(/[,，]/).map(value=>value.trim()).filter(Boolean);
      if(!required.length||required.some(id=>!TASK_ID.test(id)))return {error:'dependencies_invalid'};
      dependencies.set(dependency[1],required);
    }
  }
  if(!tasks.length)return {error:'tasks_invalid'};
  return {tasks,dependencies};
}

export function validDependencies(tasks,dependencies){
  const ids=new Set(tasks.map(task=>task.id));
  for(const [taskId,required] of dependencies){
    if(!ids.has(taskId)||required.some(id=>id===taskId||!ids.has(id)))return false;
  }
  const visiting=new Set(),visited=new Set();
  const visit=id=>{
    if(visiting.has(id))return false;
    if(visited.has(id))return true;
    visiting.add(id);
    for(const dependency of dependencies.get(id)||[])if(!visit(dependency))return false;
    visiting.delete(id);visited.add(id);return true;
  };
  return tasks.every(task=>visit(task.id));
}

function validateBootstrap(codeProject,specsDir,names){
  const empty=fs.readdirSync(codeProject).length===0;
  const hasBootstrap=names.includes('0.bootstrap');
  if(empty&&!hasBootstrap)return 'bootstrap_required';
  if(!empty&&hasBootstrap){
    const parsed=readFeature(specsDir,'0.bootstrap');
    if(parsed.error)return parsed.error;
    const bootstrapTask=parsed.tasks.find(task=>task.id==='T-001');
    if(bootstrapTask&&!bootstrapTask.completed&&!bootstrapTask.dropped)return 'bootstrap_conflict';
  }
  return null;
}

function reviewEvidenceNames(specsDir){
  const reviews=path.join(specsDir,'.reviews');
  try{
    const info=fs.lstatSync(reviews);
    if(info.isSymbolicLink()||!info.isDirectory())return {error:'review_evidence_invalid',names:[]};
    return {names:fs.readdirSync(reviews,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>entry.name)};
  }
  catch(error){return error&&error.code==='ENOENT'?{names:[]}:{error:'review_evidence_invalid',names:[]};}
}

function regexEscape(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

function missingReviewIds(featureName,tasks,evidenceNames){
  const featureKeys=[...new Set([featureName,featureName.replace(/^\d+\./,'')])].map(regexEscape);
  return tasks.filter(task=>task.completed&&!task.dropped).map(task=>task.id).filter(taskId=>{
    const escaped=regexEscape(taskId);
    return !evidenceNames.some(name=>featureKeys.some(feature=>new RegExp(`^${feature}-${escaped}-r\\d+\\.md$`).test(name)));
  });
}

function selectTask(specsDir,names){
  const features=[];
  const warnings=[];
  const evidence=reviewEvidenceNames(specsDir);
  if(evidence.error)return {error:evidence.error,features,warnings};
  const evidenceNames=evidence.names;
  for(const name of names){
    const parsed=readFeature(specsDir,name);
    if(parsed.error)return {error:parsed.error,features,warnings};
    if(!validDependencies(parsed.tasks,parsed.dependencies))return {error:'dependencies_invalid',features,warnings};
    const byId=new Map(parsed.tasks.map(task=>[task.id,task]));
    const pending=parsed.tasks.filter(task=>!task.completed&&!task.dropped);
    const missing=missingReviewIds(name,parsed.tasks,evidenceNames);
    if(missing.length)warnings.push(`⚠ 凭证缺失: ${missing.join(',')}（存量欠账,如实留档,恢复起严格执行）`);
    features.push({
      name,
      total:parsed.tasks.length,
      completed:parsed.tasks.filter(task=>task.completed).length,
      dropped:parsed.tasks.filter(task=>task.dropped).length,
      pending:pending.length,
    });
    if(!pending.length)continue;
    const eligible=pending.find(task=>(parsed.dependencies.get(task.id)||[]).every(id=>{
      const dependency=byId.get(id);
      return dependency&&(dependency.completed||dependency.dropped);
    }));
    if(!eligible)return {error:'dependencies_not_ready',features,warnings};
    return {features,warnings,nextTask:{feature:name,id:eligible.id,description:eligible.description}};
  }
  return {features,warnings,nextTask:null};
}

export function inspectCmAiAdmission(options){
  return admissionFor(options);
}

function admissionFor(options,inProgressBootstrap=null){
  const input=options&&typeof options==='object'&&!Array.isArray(options)?options:{};
  const specsDir=directory(input.specsDir),codeProject=directory(input.codeProject);
  const base={version:1,workflow:'cm-ai',phase:'admission',approvalIntent:approvalIntent(input.approvalResponse,input.assumeYes),specsDir,codeProject};
  if(!specsDir)return result(base,'blocked','specs_missing');
  if(!codeProject)return result(base,'blocked','code_project_missing');
  const discovered=discoverFeatures(specsDir);
  if(discovered.error)return result(base,'blocked',discovered.error);
  const status=readStatus(specsDir);
  if(status.kind==='invalid')return result(base,'blocked','spec_status_invalid');
  if(status.kind==='missing'||status.value.status==='awaiting_review'){
    const reason=base.approvalIntent==='explicit'?'approval_write_required':'spec_approval_required';
    return result(base,'awaiting_spec_approval',reason);
  }
  const featuresProblem=approvedFeaturesProblem(status.value,discovered.names);
  if(featuresProblem==='spec_features_changed')return result(base,'awaiting_spec_approval',featuresProblem);
  if(featuresProblem)return result(base,'blocked',featuresProblem);
  const testCasesProblem=validateTestCases(specsDir,status.value,discovered.names);
  if(testCasesProblem==='test_cases_changed')return result(base,'awaiting_spec_approval',testCasesProblem);
  if(testCasesProblem)return result(base,'blocked',testCasesProblem);
  const bootstrapProblem=validateBootstrap(codeProject,specsDir,discovered.names);
  if(bootstrapProblem&&!(bootstrapProblem==='bootstrap_conflict'&&inProgressBootstrap==='T-001'))
    return result(base,'blocked',bootstrapProblem);
  const selection=selectTask(specsDir,discovered.names);
  if(selection.error)return result(base,'blocked',selection.error,{features:selection.features,warnings:selection.warnings});
  if(!selection.nextTask)return result(base,'complete','all_tasks_terminal',{features:selection.features,warnings:selection.warnings});
  return result(base,'ready','task_selected',{features:selection.features,nextTask:selection.nextTask,warnings:selection.warnings});
}
