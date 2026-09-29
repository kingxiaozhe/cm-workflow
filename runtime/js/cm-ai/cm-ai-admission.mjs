// N1/N2 inspection is read-only; explicit approval uses the shared status writer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {readSpecsStatus,writeSpecsStatus} from '../specs-status.mjs';
import {identifyApprovedBootstrapFeature} from './bootstrap-feature.mjs';
import {buildManifest,verifyApprovedManifest} from '../../../scripts/cm-spec-manifest.mjs';
import {outstandingFeatureQa,describeOutstandingQa} from './project-qa-gate.mjs';
import {taskLines,taskDeclarations,approvedTaskGrammar,TASK_GRAMMAR,LEGACY_TASK_GRAMMAR} from '../spec-task-line.mjs';
export {identifyApprovedBootstrapFeature} from './bootstrap-feature.mjs';

export const DEPENDENCY=/^\s*-\s*(T-[A-Za-z0-9][A-Za-z0-9._-]*)\s+依赖\s+(.+)$/;
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
  const feature=identifyApprovedBootstrapFeature(readSpecsStatus(admission.specsDir).value.features);
  if(feature===null)fail('bootstrap_task_required');
  const parsed=readFeature(admission.specsDir,feature);if(parsed.error)fail(parsed.error);
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
  const completed=[],pendingFeatures=[];let selected=null;
  for(const name of discovered.names){
    const parsed=readFeature(admission.specsDir,name);if(parsed.error)fail(parsed.error);
    if(name===feature)selected=parsed.tasks;
    if(parsed.tasks.some(task=>!task.completed&&!task.dropped))pendingFeatures.push(name);
    for(const task of parsed.tasks)if(task.completed&&!task.dropped)completed.push({feature:name,id:task.id});
  }
  // Plan construction happens before task completion; decisions still bind a completed task.
  if(!selected||(taskId!==undefined&&!selected.some(task=>task.id===taskId&&task.completed&&!task.dropped)))fail('qa_not_ready');
  const pending=selected.filter(task=>!task.completed&&!task.dropped).length;
  return frozen({completed,pendingFeatures,pending,mergeEligible:pending===1&&admission.nextTask?.feature===feature});
}

// Admission's public feature summary stops at the selected feature. Count all
// approved features with the same parser before treating a task as the last one.
export function isFinalCmAiTask({specsDir,codeProject,feature,taskId,parallelSelection=null}) {
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  if(!matchesCmAiTaskSelection(admission,feature,taskId,parallelSelection))
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
  return frozen({...base,state,reason,features:[],nextTask:null,eligibleTasks:[],warnings:[],...extra});
}

function directory(value){
  if(typeof value!=='string'||!value.trim())return null;
  const resolved=path.resolve(value);
  try{return fs.statSync(resolved).isDirectory()?resolved:null;}catch{return null;}
}

function approvalIntent(response,assumeYes){
  if(assumeYes===true)return 'explicit';
  if(response===undefined||response===null||response==='')return 'none';
  if(typeof response!=='string')return 'not_approval';
  const normalized=response.trim().replace(/[。！!.～~\s]+$/gu,'');
  return new Set(['开始','开始吧','可以开始','确认开始','开始执行','现在开始']).has(normalized)?'explicit':'not_approval';
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
      if(/^\d+\.bootstrap$/.test(a))return /^\d+\.bootstrap$/.test(b)?0:-1;
      if(/^\d+\.bootstrap$/.test(b))return 1;
      const an=Number(a.match(FEATURE)[1]),bn=Number(b.match(FEATURE)[1]);
      return an-bn||(a<b?-1:a>b?1:0);
    });
  if(!names.length)return {error:'features_missing'};
  try{identifyApprovedBootstrapFeature(names);}catch(error){return {error:error.code};}
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
  const taskIds=new Set(taskDeclarations(sources[2],{grammar:approvedTaskGrammar(path.dirname(featureRoot))}).map(task=>task.id));
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
  const parsed=parseFeatureTaskText(fs.readFileSync(path.join(specsDir,name,'tasks.md'),'utf8'),
    {allowDependencyPunctuation:true,grammar:approvedTaskGrammar(specsDir)});
  if(parsed.error)parsed.detail={feature:name,...parsed.detail};
  return parsed;
}

export function declaredAcceptanceIds(source){
  return new Set(source.split(/\r?\n/).map(line=>line.match(ACCEPTANCE)).filter(Boolean).map(match=>match[1]||match[2]));
}

// Shared declaration grammar (spec-task-line.mjs), versioned by the approval.
export function parseFeatureTaskText(source,{allowDependencyPunctuation=false,grammar=TASK_GRAMMAR}={}){
  const lines=taskLines(source,{grammar});
  const tasks=[];
  const taskIds=new Set();
  const dependencies=new Map();
  const dependencyLocations=new Map();
  const location=index=>({line:index+1,text:lines[index].body.slice(0,120)});
  const invalid=(error,index)=>({error,detail:location(index)});
  for(const {index,body:line,fenced,declaration:task} of lines){
    if(fenced)continue;
    if(task){
      if(taskIds.has(task.id))return invalid('tasks_invalid',index);
      taskIds.add(task.id);
      const rest=task.description;
      const dropped=/\[DROPPED(?:\s[^\]]*)?\]/.test(rest);
      tasks.push({
        id:task.id,
        description:rest.replace(/~~\s*\[DROPPED(?:\s[^\]]*)?\].*$/,'').trim(),
        completed:task.completed,
        dropped,
      });
      continue;
    }
    const dependency=line.match(DEPENDENCY);
    if(dependency){
      if(dependencies.has(dependency[1]))return invalid('dependencies_invalid',index);
      // Only cm-ai admission opts in; cm-prd self-check retains strict parsing.
      const required=dependency[2].split(/[,，]/).map(value=>value.trim()).filter(Boolean)
        .map(value=>allowDependencyPunctuation?value.replace(/[。．.；;、\s]+$/u,''):value);
      if(!required.length||required.some(id=>!TASK_ID.test(id)))return invalid('dependencies_invalid',index);
      dependencies.set(dependency[1],required);
      dependencyLocations.set(dependency[1],location(index));
    }
  }
  if(!tasks.length)return invalid('tasks_invalid',Math.max(0,lines.findIndex(line=>line.body.trim())));
  return {tasks,dependencies,dependencyLocations};
}

export function validDependencies(tasks,dependencies){
  return invalidDependency(tasks,dependencies)===null;
}

function invalidDependency(tasks,dependencies){
  const ids=new Set(tasks.map(task=>task.id));
  for(const [taskId,required] of dependencies){
    if(!ids.has(taskId)||required.some(id=>id===taskId||!ids.has(id)))return taskId;
  }
  const visiting=new Set(),visited=new Set();
  let cycleTask=null;
  const visit=id=>{
    if(visiting.has(id)){cycleTask=id;return false;}
    if(visited.has(id))return true;
    visiting.add(id);
    for(const dependency of dependencies.get(id)||[])if(!visit(dependency))return false;
    visiting.delete(id);visited.add(id);return true;
  };
  tasks.every(task=>visit(task.id));
  return cycleTask;
}

function validateBootstrap(codeProject,specsDir,names){
  const empty=fs.readdirSync(codeProject).length===0;
  const bootstrap=identifyApprovedBootstrapFeature(names);
  if(empty&&!bootstrap)return 'bootstrap_required';
  if(!empty&&bootstrap){
    const parsed=readFeature(specsDir,bootstrap);
    if(parsed.error)return null; // Let selection retain the parser's location and feature summaries.
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

function dependenciesSatisfied(task,parsed,byId){
  return (parsed.dependencies.get(task.id)||[]).every(id=>{
    const dependency=byId.get(id);
    return dependency&&(dependency.completed||dependency.dropped);
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
    if(parsed.error)return {error:parsed.error,detail:parsed.detail,features,warnings};
    const invalidId=invalidDependency(parsed.tasks,parsed.dependencies);
    if(invalidId!==null)return {error:'dependencies_invalid',
      detail:{feature:name,...parsed.dependencyLocations.get(invalidId)},features,warnings};
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
    // One dependency rule for nextTask and --task/parallel eligibility: a
    // prerequisite is satisfied once it is completed or DROPPED.
    const ready=task=>dependenciesSatisfied(task,parsed,byId);
    const eligible=pending.find(ready);
    if(!eligible)return {error:'dependencies_not_ready',features,warnings};
    return {features,warnings,nextTask:{feature:name,id:eligible.id,description:eligible.description},
      eligibleTasks:pending.filter(ready).map(task=>({feature:name,id:task.id}))};
  }
  return {features,warnings,nextTask:null};
}

// Selection stays tasks.md-driven; an earlier feature's unfinished QA is surfaced
// here and enforced at N8 (finish/run_finalize), never by reordering tasks.
function featureQaWarnings(specsDir,features){
  try{
    return outstandingFeatureQa({specsDir,features:features.map(({name,pending})=>({name,pending}))}).map(item=>
      `⚠ QA 未通过: ${describeOutstandingQa(item)}；它通过之前项目不能收尾（run_done）`);
  }catch{return ['⚠ QA 日志无法读取，未能确认各 feature 的最新 QA 是否通过'];}
}

export function inspectCmAiAdmission(options){
  return admissionFor(options);
}

// The CLI supplies every code project so no project can be skipped before writing.
export function approveCmAiSpecs(options){
  const projects=options.codeProjects??[options.codeProject];
  const inspect=()=>projects.map(codeProject=>inspectCmAiAdmission({...options,codeProject}));
  const projectResults=inspect();
  const refuse=(approveRefused,approveReason=null)=>({projectResults,approveRefused,...(approveReason?{approveReason}:{})});
  if(options.assumeYes)return refuse('assume_yes_not_allowed');
  if(typeof options.approvalResponse!=='string'||!options.approvalResponse.trim())
    return refuse('approval_response_required');
  const allowed=new Set(['approval_write_required','spec_features_changed','test_cases_changed']);
  const rejected=projectResults.find(item=>item.state!=='awaiting_spec_approval'
    ||item.approvalIntent!=='explicit'||!allowed.has(item.reason));
  if(rejected)return refuse(rejected.approvalIntent!=='explicit'?'explicit_approval_required':rejected.reason);
  const specsDir=projectResults[0].specsDir,status=readSpecsStatus(specsDir);
  if(status.kind==='invalid')return refuse('spec_status_invalid');
  try{
    const discovered=discoverFeatures(specsDir);
    if(discovered.error)return refuse(discovered.error);
    // An approval binds grammar 2 to every feature, including ones this change
    // did not touch. Refuse rather than silently re-reading bytes that an older
    // approval parsed differently (e.g. an unfenced `- [ ] T-001：例` becoming a
    // duplicate of the real T-001), and rather than keeping grammar 1, which
    // would leave newly drafted full-width task lines silently not tasks.
    // Moving from the pre-grammar parse must not change which lines are tasks
    // either (e.g. a unique `- [ ] T-099：示例` would become a pending task). The
    // status carries the last approval's grammar through cm-prd publication;
    // once a project is on grammar 2 there is nothing to reconcile.
    // No status at all means nothing was approved before: no earlier meaning to keep.
    const fromLegacy=status.kind==='valid'&&status.value.taskGrammar!==TASK_GRAMMAR;
    for(const name of discovered.names){
      const source=fs.readFileSync(path.join(specsDir,name,'tasks.md'),'utf8');
      const parsed=parseFeatureTaskText(source,{allowDependencyPunctuation:true,grammar:TASK_GRAMMAR});
      if(parsed.error)return refuse('task_grammar_conflict',`${name}/tasks.md 第 ${parsed.detail.line} 行在新任务行语法下无效（${parsed.error}）：`
        +`${parsed.detail.text}。此前的批准把它当作说明文字；把这类示例放进 \`\`\` 围栏或删去后再批准。`);
      if(!fromLegacy)continue;
      const view=grammar=>taskDeclarations(source,{grammar}).map(item=>({line:item.index+1,key:`${item.id}\0${item.completed}\0${item.body.trim()}`,text:item.body.trim()}));
      const legacy=view(LEGACY_TASK_GRAMMAR),current=view(TASK_GRAMMAR);
      const legacyKeys=new Set(legacy.map(item=>item.key)),currentKeys=new Set(current.map(item=>item.key));
      const differing=[...current.filter(item=>!legacyKeys.has(item.key)),...legacy.filter(item=>!currentKeys.has(item.key))]
        .sort((a,b)=>a.line-b.line);
      if(differing.length)return refuse('task_grammar_conflict',`${name}/tasks.md 在新任务行语法下任务集合会变化：`
        +differing.slice(0,5).map(item=>`第 ${item.line} 行 ${item.text}`).join('；')+`${differing.length>5?` 等 ${differing.length} 行`:''}`
        +'。此前的批准不把这些行当任务（或反之）；是示例就放进 ``` 围栏或删去，是任务就改用英文冒号「:」写法后再批准。');
    }
    const specFiles=buildManifest(specsDir),at=new Date().toISOString();
    writeSpecsStatus(specsDir,{status:'approved',summaryDigest:status.value?.summaryDigest??null,at,
      features:discovered.names,specFiles,testCases:specFiles.filter(item=>item.path.endsWith('/test-cases.json')),
      approval:{response:options.approvalResponse,at},taskGrammar:TASK_GRAMMAR,
      ...(status.value&&Object.hasOwn(status.value,'revisionDigest')?{revisionDigest:status.value.revisionDigest}:{})});
  }catch(error){return refuse(error.code??error.message);}
  return {projectResults:inspect()};
}

function admissionFor(options,inProgressBootstrap=null){
  const input=options&&typeof options==='object'&&!Array.isArray(options)?options:{};
  const specsDir=directory(input.specsDir),codeProject=directory(input.codeProject);
  const base={version:1,workflow:'cm-ai',phase:'admission',approvalIntent:approvalIntent(input.approvalResponse,input.assumeYes),specsDir,codeProject};
  if(!specsDir)return result(base,'blocked','specs_missing');
  if(!codeProject)return result(base,'blocked','code_project_missing');
  const discovered=discoverFeatures(specsDir);
  if(discovered.error)return result(base,'blocked',discovered.error);
  const status=readSpecsStatus(specsDir);
  if(status.kind==='invalid')return result(base,'blocked','spec_status_invalid');
  if(status.kind==='missing'||status.value.status==='awaiting_review'){
    const reason=base.approvalIntent==='explicit'?'approval_write_required':'spec_approval_required';
    return result(base,'awaiting_spec_approval',reason);
  }
  const featuresProblem=approvedFeaturesProblem(status.value,discovered.names);
  if(featuresProblem==='spec_features_changed')return result(base,'awaiting_spec_approval',featuresProblem);
  if(featuresProblem)return result(base,'blocked',featuresProblem);
  if(Object.hasOwn(status.value,'specFiles')){
    try{verifyApprovedManifest(specsDir,path.join(specsDir,'.cm-specs-status'));}
    catch{return result(base,'blocked','spec_drift');}
  }
  const testCasesProblem=validateTestCases(specsDir,status.value,discovered.names);
  if(testCasesProblem==='test_cases_changed')return result(base,'awaiting_spec_approval',testCasesProblem);
  if(testCasesProblem)return result(base,'blocked',testCasesProblem);
  const bootstrapProblem=validateBootstrap(codeProject,specsDir,discovered.names);
  if(bootstrapProblem&&!(bootstrapProblem==='bootstrap_conflict'&&inProgressBootstrap==='T-001'))
    return result(base,'blocked',bootstrapProblem);
  const selection=selectTask(specsDir,discovered.names);
  if(selection.error)return result(base,'blocked',selection.error,{features:selection.features,warnings:selection.warnings,
    ...(selection.detail?{detail:selection.detail}:{})});
  const warnings=[...selection.warnings,...featureQaWarnings(specsDir,selection.features)];
  if(!selection.nextTask)return result(base,'complete','all_tasks_terminal',{features:selection.features,warnings});
  return result(base,'ready','task_selected',{features:selection.features,nextTask:selection.nextTask,eligibleTasks:selection.eligibleTasks,warnings});
}

// Diagnostic only: why an explicit --task selection is not eligible. Never used
// to grant a selection; matchesCmAiTaskSelection remains the sole gate.
export function explainCmAiTaskSelection(admission,{feature,taskId,selection=null}){
  if(admission.state!=='ready')return `当前准入状态为 ${admission.state}/${admission.reason}，不能选择任务`;
  const next=admission.nextTask;
  if(next&&next.feature!==feature)return `--task 只能选择当前 feature ${next.feature} 的任务（运行定义为 ${feature}）`;
  if(!admission.specsDir)return `${taskId} 不在可选任务中`;
  let parsed;
  try{parsed=readFeature(admission.specsDir,feature);}catch{return `无法读取 ${feature}/tasks.md`;}
  if(parsed.error)return `${feature}/tasks.md 无法解析（${parsed.error}）`;
  const byId=new Map(parsed.tasks.map(task=>[task.id,task]));
  const task=byId.get(taskId);
  if(!task)return `${feature}/tasks.md 中没有任务 ${taskId}`;
  if(task.dropped)return `${taskId} 已标记 DROPPED`;
  if(task.completed)return `${taskId} 已勾选完成`;
  const waiting=(parsed.dependencies.get(taskId)||[]).filter(id=>{const item=byId.get(id);return !item||!item.completed&&!item.dropped;});
  if(waiting.length)return `${taskId} 依赖的 ${waiting.join('、')} 尚未完成`;
  const eligible=(admission.eligibleTasks??[]).filter(item=>item.feature===feature).map(item=>item.id);
  if(selection===null&&next&&next.id!==taskId&&eligible.includes(taskId))
    return `运行定义未写 taskSelection，只能运行 nextTask ${next.id}；改选 ${taskId} 请用 cm-ai-admission.mjs --print-run-definition --task ${taskId} 重新生成运行定义`;
  return `${taskId} 不在可选任务中；当前可选：${eligible.join('、')||'无'}`;
}

// Trusted caller selection is data bound by openControlRun, never message authority.
export function matchesCmAiTaskSelection(admission,feature,taskId,parallelSelection=null){
  if(parallelSelection===null)return admission.state==='ready'
    &&admission.nextTask?.feature===feature&&admission.nextTask.id===taskId;
  const value=parallelSelection;
  if(value?.version===1&&Object.keys(value).sort().join(',')==='taskId,version')
    return value.taskId===taskId&&admission.state==='ready'
      &&admission.eligibleTasks?.some(task=>task.feature===feature&&task.id===taskId)===true;
  return admission.state==='ready'&&value?.version===1
    &&Object.keys(value).sort().join(',')==='group,version'&&Array.isArray(value.group)
    &&value.group.length>=2&&new Set(value.group).size===value.group.length
    &&value.group.every(id=>typeof id==='string'&&TASK_ID.test(id))&&value.group.includes(taskId)
    &&admission.eligibleTasks?.some(task=>task.feature===feature&&task.id===taskId)===true;
}
