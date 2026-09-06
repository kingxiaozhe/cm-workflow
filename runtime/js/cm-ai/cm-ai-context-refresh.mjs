// Read-only N7 context refresh. It rereads disk state and returns metadata, never file contents.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {inspectCmAiAdmission} from './cm-ai-admission.mjs';
import {arrayItems,digest,freeze,hex,json,need,shape,text,validIdentity,validTaskLearningInput} from './effect-contract.mjs';

const BASELINE_RULES=['coding-style.md','testing.md','security.md'];

const contained=(root,target)=>{const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};

function readContextFile(root,scope,relative,required=false) {
  const rootReal=fs.realpathSync(root),candidate=path.resolve(root,relative);
  need(contained(path.resolve(root),candidate),'context_invalid');
  if(!fs.existsSync(candidate)){need(!required,'context_invalid');return null;}
  try {
    const stat=fs.lstatSync(candidate),resolved=fs.realpathSync(candidate);
    need(stat.isFile()&&!stat.isSymbolicLink()&&contained(rootReal,resolved),'context_invalid');
    const bytes=fs.readFileSync(candidate);
    return {metadata:{scope,path:relative.split(path.sep).join('/'),
      sha256:createHash('sha256').update(bytes).digest('hex')},bytes};
  } catch(error) {
    if(error?.code==='context_invalid')throw error;
    need(false,'context_invalid');
  }
}

function projectFiles(codeProject,applicableAgentFiles) {
  const files=[];
  const agents=readContextFile(codeProject,'project','AGENTS.md');if(agents)files.push(agents);
  for(const relative of arrayItems(applicableAgentFiles)){
    text(relative);need(!path.isAbsolute(relative)&&!relative.includes('\\')&&!relative.includes('\0')
      &&path.posix.normalize(relative)===relative&&path.posix.basename(relative)==='AGENTS.md'
      &&!relative.split('/').includes('..'),'context_invalid');
    if(relative==='AGENTS.md')continue;
    files.push(readContextFile(codeProject,'project',relative,true));
  }
  const claude=readContextFile(codeProject,'project',path.join('.claude','CLAUDE.md'));if(claude)files.push(claude);
  const rules=new Set(BASELINE_RULES);
  if(claude){
    const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(claude.bytes);
    for(const match of source.matchAll(/@rules\/([A-Za-z0-9._/-]+\.md)\b/g))rules.add(match[1]);
  }
  for(const rule of [...rules].sort()){
    need(!path.isAbsolute(rule)&&!rule.split(/[\\/]/).includes('..'),'context_invalid');
    const file=readContextFile(codeProject,'project',path.join('.claude','rules',rule));
    if(file)files.push(file);
  }
  return files;
}

export function inspectCmAiContextRefresh(input) {
  shape(input,['specsDir','codeProject','feature','applicableAgentFiles']);
  text(input.specsDir);text(input.codeProject);text(input.feature);
  const admission=inspectCmAiAdmission({specsDir:input.specsDir,codeProject:input.codeProject});
  if(!['ready','complete'].includes(admission.state))return freeze({state:admission.state,reason:admission.reason,
    nextTask:null,contextDigest:null,contextFiles:[]});
  need(admission.features.some(item=>item.name===input.feature),'context_invalid');
  const featureNames=admission.state==='complete'?admission.features.map(item=>item.name):[input.feature];
  const files=featureNames.flatMap(feature=>['requirements.md','design.md','tasks.md'].map(name=>
    readContextFile(input.specsDir,'specs',path.join(feature,name),true)));
  const lessons=readContextFile(input.specsDir,'specs','LESSONS.md');if(lessons)files.push(lessons);
  files.push(...projectFiles(input.codeProject,input.applicableAgentFiles));
  const contextFiles=files.map(file=>file.metadata).sort((left,right)=>
    left.scope.localeCompare(right.scope)||left.path.localeCompare(right.path));
  return freeze({state:admission.state,reason:admission.reason,nextTask:admission.nextTask,
    contextDigest:digest({version:1,files:contextFiles}),contextFiles});
}

export function inspectCmAiTaskLearningInput(input) {
  shape(input,['specsDir','codeProject','feature','identity','applicableAgentFiles']);
  text(input.feature);const identity=json(input.identity);validIdentity(identity);
  const refresh=inspectCmAiContextRefresh({specsDir:input.specsDir,codeProject:input.codeProject,
    feature:input.feature,applicableAgentFiles:input.applicableAgentFiles});
  need(refresh.state==='ready'&&refresh.nextTask?.feature===input.feature
    &&refresh.nextTask.id===identity.taskId,'learning_context_invalid');
  const agentPaths=new Set(['AGENTS.md',...arrayItems(input.applicableAgentFiles)]);
  const selected=refresh.contextFiles.filter(file=>file.scope==='specs'?file.path==='LESSONS.md':
    file.scope==='project'&&agentPaths.has(file.path));
  const learningFiles=[...new Map(selected.map(file=>[`${file.scope}:${file.path}`,file])).values()];
  return freeze({version:1,workflow:'cm-ai',phase:'task_learning_input',feature:input.feature,identity,
    learningDigest:digest({version:1,feature:input.feature,identity,files:learningFiles}),learningFiles});
}

const oneLine=(value,max=240)=>{text(value);need(value.length<=max&&!/[\n\r\0\u2028\u2029]/u.test(value));return value;};
const evidencePath=value=>{oneLine(value,512);need(!value.startsWith('/')&&!/^[A-Za-z]:/.test(value)
  &&!value.includes('\\')&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'));return value;};

export function readCmAiTaskLearningApplication(raw) {
  const value=json(raw,4*1024);
  shape(value,['version','workflow','phase','feature','identity','learningDigest','status','note','applicationDigest']);
  need(value.version===1&&value.workflow==='cm-ai'&&value.phase==='task_learning_application');
  oneLine(value.feature,128);validIdentity(value.identity);hex(value.learningDigest);hex(value.applicationDigest);
  need(['applied','no_relevant_lesson'].includes(value.status));
  if(value.status==='applied')oneLine(value.note,512);else need(value.note===null);
  const identity={repositoryId:value.identity.repositoryId,runId:value.identity.runId,
    taskId:value.identity.taskId,attempt:value.identity.attempt};
  const body={version:1,workflow:'cm-ai',phase:'task_learning_application',feature:value.feature,
    identity,learningDigest:value.learningDigest,status:value.status,note:value.note};
  need(value.applicationDigest===digest(body));return freeze({...body,applicationDigest:value.applicationDigest});
}

export function createCmAiTaskLearningApplication(raw) {
  const input=json(raw,4*1024);shape(input,['feature','identity','learningDigest','status','note']);
  oneLine(input.feature,128);validIdentity(input.identity);hex(input.learningDigest);
  need(['applied','no_relevant_lesson'].includes(input.status));
  if(input.status==='applied')oneLine(input.note,512);else need(input.note===null);
  const body={version:1,workflow:'cm-ai',phase:'task_learning_application',feature:input.feature,
    identity:input.identity,learningDigest:input.learningDigest,status:input.status,note:input.note};
  return readCmAiTaskLearningApplication({...body,applicationDigest:digest(body)});
}

export function encodeCmAiTaskLearningApplicationEvidence(raw) {
  return `cm-learning-application-v1:${JSON.stringify(readCmAiTaskLearningApplication(raw))}`;
}

export function attachCmAiTaskLearningApplicationEvidence(raw) {
  const input=json(raw,256*1024);
  shape(input,['handoff','feature','identity','learningInput','application']);
  oneLine(input.feature,128);validIdentity(input.identity);
  validTaskLearningInput(input.learningInput,input.identity,input.feature);
  const application=readCmAiTaskLearningApplication(input.application);
  need(application.feature===input.feature&&digest(application.identity)===digest(input.identity)
    &&application.learningDigest===input.learningInput.learningDigest,'identity_mismatch');
  const handoff=input.handoff;need(handoff!==null&&typeof handoff==='object'&&!Array.isArray(handoff));
  need(handoff.task_id===input.identity.taskId&&handoff.attempt===input.identity.attempt,'identity_mismatch');
  const evidence=arrayItems(handoff.evidence);for(const item of evidence)text(item);
  const encoded=encodeCmAiTaskLearningApplicationEvidence(application);
  const existing=evidence.filter(item=>item.startsWith('cm-learning-application-v1:'));
  need(existing.length<=1&&existing.every(item=>item===encoded),'invalid_input');
  if(existing.length===1)return handoff;
  return freeze({...handoff,evidence:[...evidence,encoded]});
}

function learningCandidates(raw) {
  const candidates=arrayItems(raw);need(candidates.length<=3);
  const seen=new Set();
  for(const candidate of candidates){
    shape(candidate,['classification','trigger','action','evidence']);
    need(['structured','memory_only'].includes(candidate.classification));
    oneLine(candidate.trigger);oneLine(candidate.action);
    const evidence=arrayItems(candidate.evidence);need(evidence.length>=1&&evidence.length<=8);
    const paths=new Set();for(const item of evidence){evidencePath(item);need(!paths.has(item));paths.add(item);}
    const key=digest(candidate);need(!seen.has(key));seen.add(key);
  }
  return candidates.map(candidate=>freeze({classification:candidate.classification,trigger:candidate.trigger,
    action:candidate.action,evidence:[...candidate.evidence]}));
}

function readTaskLearningRetrospective(raw) {
  const value=json(raw,16*1024);
  shape(value,['version','workflow','phase','feature','identity','learningDigest','status','candidates','reason','retrospectiveDigest']);
  need(value.version===1&&value.workflow==='cm-ai'&&value.phase==='task_learning_retrospective');
  oneLine(value.feature,128);validIdentity(value.identity);hex(value.learningDigest);hex(value.retrospectiveDigest);
  const candidates=learningCandidates(value.candidates);
  need(['no_new_lesson','lesson_candidate','writeback_pending'].includes(value.status));
  if(value.status==='no_new_lesson')need(candidates.length===0&&value.reason===null);
  else if(value.status==='lesson_candidate')need(candidates.length>=1&&value.reason===null);
  else {need(candidates.length>=1);oneLine(value.reason);}
  const identity={repositoryId:value.identity.repositoryId,runId:value.identity.runId,
    taskId:value.identity.taskId,attempt:value.identity.attempt};
  const body={version:1,workflow:'cm-ai',phase:'task_learning_retrospective',feature:value.feature,
    identity,learningDigest:value.learningDigest,status:value.status,candidates,reason:value.reason};
  need(value.retrospectiveDigest===digest(body));return freeze({...body,retrospectiveDigest:value.retrospectiveDigest});
}

export function createCmAiTaskLearningRetrospective(raw) {
  const input=json(raw,16*1024);
  shape(input,['feature','identity','learningDigest','status','candidates','reason']);
  oneLine(input.feature,128);validIdentity(input.identity);hex(input.learningDigest);
  const candidates=learningCandidates(input.candidates);
  need(['no_new_lesson','lesson_candidate','writeback_pending'].includes(input.status));
  if(input.status==='no_new_lesson')need(candidates.length===0&&input.reason===null);
  else if(input.status==='lesson_candidate')need(candidates.length>=1&&input.reason===null);
  else {need(candidates.length>=1);oneLine(input.reason);}
  const body={version:1,workflow:'cm-ai',phase:'task_learning_retrospective',feature:input.feature,
    identity:input.identity,learningDigest:input.learningDigest,status:input.status,candidates,reason:input.reason};
  return readTaskLearningRetrospective({...body,retrospectiveDigest:digest(body)});
}

export function encodeCmAiTaskLearningEvidence(raw) {
  const retrospective=readTaskLearningRetrospective(raw);
  return `cm-learning-retrospective-v1:${JSON.stringify(retrospective)}`;
}

export function attachCmAiTaskLearningEvidence(raw) {
  const input=json(raw,256*1024);
  shape(input,['handoff','feature','identity','learningInput','retrospective']);
  text(input.feature);validIdentity(input.identity);
  validTaskLearningInput(input.learningInput,input.identity,input.feature);
  const retrospective=readTaskLearningRetrospective(input.retrospective);
  need(retrospective.feature===input.feature
    &&digest(retrospective.identity)===digest(input.identity),'identity_mismatch');
  need(retrospective.learningDigest===input.learningInput.learningDigest,'identity_mismatch');
  const handoff=input.handoff;
  need(handoff!==null&&typeof handoff==='object'&&!Array.isArray(handoff));
  need(handoff.task_id===input.identity.taskId&&handoff.attempt===input.identity.attempt,'identity_mismatch');
  const evidence=arrayItems(handoff.evidence);for(const item of evidence)text(item);
  const encoded=encodeCmAiTaskLearningEvidence(retrospective);
  const existing=evidence.filter(item=>item.startsWith('cm-learning-retrospective-v1:'));
  need(existing.length<=1&&existing.every(item=>item===encoded),'invalid_input');
  if(existing.length===1)return handoff;
  return freeze({...handoff,evidence:[...evidence,encoded]});
}
