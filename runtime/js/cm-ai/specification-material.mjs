// Host-owned approved specification data. Never a write scope or authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyApprovedManifest,normalizeRuntimeMarks,normalizeRuntimeMarkBytes} from '../../../scripts/cm-spec-manifest.mjs';
import {parseFeatureTaskText,declaredAcceptanceIds,DEPENDENCY} from './cm-ai-admission.mjs';
import {taskLines,TASK_GRAMMAR,LEGACY_TASK_GRAMMAR} from '../spec-task-line.mjs';
import {readReviewSourceFiles,readReviewSourceExcerpt} from './review-package.mjs';
import {json,need,shape,hex,id,freeze,digest} from './effect-contract.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';

const DESIGN_LIMIT=64*1024;
const filenames=['requirements.md','design.md','tasks.md','test-cases.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const featureName=value=>need(typeof value==='string'&&/^\d+\.[^/\\\x00-\x1f]+$/.test(value));

export function readSpecificationMaterial(raw,taskId){
  const v=json(raw,2*1024*1024);
  shape(v,['feature','task','acceptanceCriteria','designExcerpt','testCases','sources',
    ...['truncated','taskScopeDigest'].filter(key=>Object.hasOwn(v,key))]);
  if(Object.hasOwn(v,'taskScopeDigest'))hex(v.taskScopeDigest);
  featureName(v.feature);
  shape(v.task,['id','description',...(Object.hasOwn(v.task,'verification')?['verification']:[])]);
  need(v.task.id===taskId&&/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId));
  need(typeof v.task.description==='string'&&v.task.description.trim().length>0);
  if(Object.hasOwn(v.task,'verification'))need(typeof v.task.verification==='string'&&v.task.verification.length>0);
  need(Array.isArray(v.acceptanceCriteria));
  const ids=new Set();
  for(const ac of v.acceptanceCriteria){
    shape(ac,['id','text']);need(/^AC-\d{3,}$/.test(ac.id)&&!ids.has(ac.id));ids.add(ac.id);
    need(typeof ac.text==='string'&&ac.text.length>0);
  }
  need(typeof v.designExcerpt==='string'&&Buffer.byteLength(v.designExcerpt)<=DESIGN_LIMIT);
  if(Object.hasOwn(v,'truncated'))need(v.truncated===true);
  need(Array.isArray(v.testCases)&&v.testCases.every(item=>item&&Array.isArray(item.taskIds)&&item.taskIds.includes(taskId)));
  need(Array.isArray(v.sources)&&[3,4].includes(v.sources.length));
  const expected=filenames.slice(0,v.sources.length).map(name=>`${v.feature}/${name}`).sort();
  need(JSON.stringify(v.sources.map(item=>item.path))===JSON.stringify(expected));
  for(const item of v.sources){shape(item,['path','sha256']);hex(item.sha256);}
  if(v.sources.length===3)need(v.testCases.length===0);
  return freeze(v);
}

// Everything in tasks.md and test-cases.json that can belong to this task:
// every line that names it wherever it sits (another task's sub-item, a
// dependency line, a note), its whole list item (continuation lines and
// sub-bullets included), and shared text naming no task. Left out are only
// lines naming other tasks alone: other tasks' items and their sub-lines,
// their dependency lines, and their test cases that do not name this task.
// Recorded for new runs so an explicit rebind can prove the re-approved change
// did not touch this task.
const TASK_ID_TOKEN=/(?<![A-Za-z0-9])T-[A-Za-z0-9][A-Za-z0-9._-]*/g;
const indentOf=line=>/^[ \t]*/.exec(line)[0].length;
const MENTIONS_TASK=/(?<![A-Za-z0-9])T-[A-Za-z0-9]/;
const namesTask=(text,taskId)=>(text.match(TASK_ID_TOKEN)??[]).some(id=>id.replace(/[._-]+$/,'')===taskId);
export function taskScopeText(tasks,taskId,grammar=TASK_GRAMMAR){
  const kept=[];let owner=null,ownerIndent=0;
  for(const {body,fenced,declaration} of taskLines(tasks,{grammar})){
    if(!body.trim())continue;
    if(declaration){owner=declaration.id;ownerIndent=indentOf(body);}
    // Only lines indented under an item belong to it; a fence or heading at
    // its level ends it, leaving the rest to the shared/named rules below.
    else if(owner!==null&&!(indentOf(body)>ownerIndent&&!/^\s*#/.test(body)))owner=null;
    const dependency=fenced||declaration?null:body.match(DEPENDENCY);
    const belongs=declaration?declaration.id:owner??dependency?.[1]??null;
    if(namesTask(body,taskId)||belongs===taskId||belongs===null&&!MENTIONS_TASK.test(body))kept.push(body);
  }
  return kept.join('\n');
}
function taskScopeDigest(texts,taskId,grammar){
  let cases=null;
  if(texts['test-cases.json']!==undefined){
    const {cases:all,...contract}=JSON.parse(texts['test-cases.json']);
    cases={...contract,cases:all.filter(item=>item.taskIds.includes(taskId)||namesTask(JSON.stringify(item),taskId))};
  }
  return digest({tasks:taskScopeText(texts['tasks.md'],taskId,grammar),testCases:cases});
}

function verificationFor(source,taskId){
  let level=null;const lines=[];
  for(const line of source.split(/\r?\n/)){
    const heading=/^\s*(#{1,6})\s+(.+)$/.exec(line);
    if(heading){
      if(level!==null&&heading[1].length<=level)level=null;
      if(heading[2].includes('验证要求'))level=heading[1].length;
      continue;
    }
    if(level!==null&&line.split(/[^A-Za-z0-9._-]+/).includes(taskId))lines.push(line.trim());
  }
  return lines.join('\n');
}

export function captureSpecificationMaterial({specsRoot,feature,taskId}){
  try{
    featureName(feature);
    need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot);
    const statusPath=path.join(specsRoot,'.cm-specs-status');
    const statusRecord=readReviewSourceFiles(specsRoot,['.cm-specs-status'])[0];
    const status=JSON.parse(Buffer.from(statusRecord.contentBase64,'base64').toString('utf8'));
    need(status.status==='approved'&&Array.isArray(status.features)&&status.features.includes(feature));
    // Sources are the approved rows themselves. A legacy approval therefore keeps
    // its recorded digests, and material captured before the shared task grammar
    // compares equal to material captured after it.
    const manifest=verifyApprovedManifest(specsRoot,statusPath);
    need(JSON.stringify([...status.features].sort())===JSON.stringify([...new Set(manifest.map(row=>row.path.split('/')[0]))].sort()));
    const sources=manifest.filter(row=>row.path.startsWith(feature+'/'));
    const designPath=feature+'/design.md';
    const records=readReviewSourceFiles(specsRoot,sources.map(row=>row.path).filter(p=>p!==designPath)),texts={};
    const design=readReviewSourceExcerpt(specsRoot,designPath,DESIGN_LIMIT);
    need(design.sha256===sources.find(row=>row.path===designPath)?.sha256);
    for(const record of records){
      const name=path.basename(record.path),bytes=Buffer.from(record.contentBase64,'base64');
      // Hash the very bytes that supply the material, using the runtime-mark contract
      // that approved them (current grammar, or the legacy rule for old approvals).
      const approved=sources.find(row=>row.path===record.path)?.sha256;
      need([false,true].some(legacy=>hash(normalizeRuntimeMarkBytes(bytes,name,{legacy}))===approved));
      texts[name]=normalizeRuntimeMarks(bytes.toString('utf8'),name);
    }
    need(readReviewSourceFiles(specsRoot,['.cm-specs-status'])[0].sha256===statusRecord.sha256);
    verifyApprovedManifest(specsRoot,statusPath);
    // The approval binds the grammar its bytes were approved with (spec-task-line.mjs).
    const grammar=status.taskGrammar===TASK_GRAMMAR?TASK_GRAMMAR:LEGACY_TASK_GRAMMAR;
    const parsed=parseFeatureTaskText(texts['tasks.md'],{allowDependencyPunctuation:true,grammar});
    need(!parsed.error);
    const selected=parsed.tasks.find(task=>task.id===taskId&&!task.dropped);need(selected);
    const verification=verificationFor(texts['tasks.md'],taskId);
    const task={id:taskId,description:selected.description,...(verification?{verification}:{})};
    const acceptanceCriteria=texts['requirements.md'].split(/\r?\n/).flatMap(line=>
      [...declaredAcceptanceIds(line)].map(id=>({id,text:line.trim()})));
    const cases=texts['test-cases.json']===undefined?[]:JSON.parse(texts['test-cases.json']).cases;
    need(Array.isArray(cases)&&cases.every(item=>item&&Array.isArray(item.taskIds)));
    return readSpecificationMaterial({feature,task,acceptanceCriteria,designExcerpt:design.excerpt,
      ...(design.truncated?{truncated:true}:{}),testCases:cases.filter(item=>item.taskIds.includes(taskId)),sources,
      taskScopeDigest:taskScopeDigest(texts,taskId,grammar)},taskId);
  }catch{throw Object.assign(new Error('spec_drift'),{code:'spec_drift'});}
}

// Material captured by older versions has no taskScopeDigest; compare a fresh
// capture in the bound representation so their runs keep verifying.
const asBound=(bound,current)=>{
  if(Object.hasOwn(bound,'taskScopeDigest'))return current;
  const {taskScopeDigest:unused,...legacy}=current;return legacy;
};
// Rebind eligibility, deliberately conservative: requirements.md and design.md
// must be unchanged as whole files (acceptance items may span lines, and prose
// can state requirements); in tasks.md and test-cases.json only other tasks'
// items, dependency lines and cases may differ (taskScopeDigest). A run bound
// before taskScopeDigest existed cannot prove that and is never rebindable.
const CONTENT_FIELDS=['feature','task','acceptanceCriteria','designExcerpt','truncated','testCases','taskScopeDigest'];
const FIELD_NAMES={feature:'feature',task:'本任务描述/验证要求',acceptanceCriteria:'验收标准',
  designExcerpt:'设计摘录',truncated:'设计摘录',testCases:'本任务测试用例',
  taskScopeDigest:'tasks.md／test-cases.json 中本任务的条目、续行、依赖、用例或共用说明'};
const WHOLE_FILES={'requirements.md':'requirements.md（整份核对，含验收标准续行与说明）','design.md':'design.md（整份核对）'};

// Explicit, journaled rebind (task-runner rebindSpecification). It can only ever
// replace `sources`: the accepted material is the bound material with the
// approved hashes of the re-approved files, never different content.
export function readSpecificationRebind(raw,expected=null){
  const record=json(raw,64*1024);
  shape(record,['version','taskId','boundDigest','sources','files','reason','reboundAt']);
  need(record.version===1,'spec_rebind_invalid');id(record.taskId);hex(record.boundDigest);
  need(Array.isArray(record.sources)&&[3,4].includes(record.sources.length),'spec_rebind_invalid');
  for(const row of record.sources){shape(row,['path','sha256']);need(typeof row.path==='string','spec_rebind_invalid');hex(row.sha256);}
  need(Array.isArray(record.files)&&record.files.length>0&&record.files.length<=filenames.length
    &&new Set(record.files).size===record.files.length
    &&record.files.every(file=>typeof file==='string'&&filenames.includes(file.split('/').at(-1))),'spec_rebind_invalid');
  need(typeof record.reason==='string'&&record.reason.trim().length>0&&Buffer.byteLength(record.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(record.reason),'spec_rebind_reason_required');
  need(typeof record.reboundAt==='string'&&Number.isFinite(Date.parse(record.reboundAt))
    &&new Date(record.reboundAt).toISOString()===record.reboundAt,'spec_rebind_invalid');
  if(expected)need(record.taskId===expected.taskId&&record.boundDigest===expected.boundDigest,'spec_rebind_invalid');
  return freeze(record);
}

// The run's own journal is the only authority for a rebind; any read or
// validation problem means no rebind, so verification fails closed.
function acceptedRebindMaterial(baseline){
  try{
    const snapshot=readExecutionSnapshot({specsRoot:baseline.specificationRoot,
      identity:{repositoryId:baseline.identity.repositoryId,runId:baseline.identity.runId}});
    const row=snapshot.records.findLast(item=>item.payload?.version===3&&item.payload.type==='specification-rebound');
    if(!row)return null;
    const record=readSpecificationRebind(row.payload.record,{taskId:baseline.identity.taskId,
      boundDigest:digest(baseline.specification)});
    return readSpecificationMaterial({...baseline.specification,sources:record.sources},baseline.identity.taskId);
  }catch{return null;}
}
const accepted=(baseline,captured)=>{
  const current=asBound(baseline.specification,captured);
  if(digest(current)===digest(baseline.specification))return true;
  const rebound=acceptedRebindMaterial(baseline);
  return rebound!==null&&digest(current)===digest(rebound);
};

export function verifySpecificationMaterial(baseline){
  const current=captureSpecificationMaterial({specsRoot:baseline.specificationRoot,
    feature:baseline.specification.feature,taskId:baseline.identity.taskId});
  need(accepted(baseline,current),'spec_drift');
  return baseline.specification;
}

// A freshly captured material equal to the bound (or explicitly rebound) one is
// represented by the bound material, so reviewed baselines and packages keep
// their digests. Anything else is spec_drift.
export function boundSpecificationMaterial(baseline,captured){
  need(accepted(baseline,captured),'spec_drift');
  return baseline.specification;
}

// Diagnostic for status and rebind: null when the bound material (or an
// explicit rebind) still verifies; otherwise what changed and whether an
// explicit rebind is allowed. Never grants anything itself.
export function inspectSpecificationDrift(baseline){
  let current;
  try{current=captureSpecificationMaterial({specsRoot:baseline.specificationRoot,
    feature:baseline.specification.feature,taskId:baseline.identity.taskId});}
  catch{return freeze({approved:false,files:[],fields:[],rebindable:false});}
  if(accepted(baseline,current))return null;
  const bound=baseline.specification,before=new Map(bound.sources.map(row=>[row.path,row.sha256]));
  const after=new Map(current.sources.map(row=>[row.path,row.sha256]));
  const files=[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).sort();
  const fields=[...new Set([
    ...files.map(file=>WHOLE_FILES[file.split('/').at(-1)]).filter(Boolean),
    ...(before.size!==after.size?['test-cases.json 的有无']:[]),
    ...(Object.hasOwn(bound,'taskScopeDigest')?[]:['本运行由旧版本创建，未记录本任务段落摘要，无法证明其未变']),
    ...CONTENT_FIELDS.filter(field=>Object.hasOwn(bound,'taskScopeDigest')||field!=='taskScopeDigest')
      .filter(field=>digest(current[field]??null)!==digest(bound[field]??null)).map(field=>FIELD_NAMES[field])])];
  return freeze({approved:true,files,fields,rebindable:fields.length===0,sources:current.sources});
}

export function describeSpecificationDrift(drift){
  if(!drift.approved)return '规格当前未处于已批准且与批准清单一致的状态（cm-prd 变更尚未重新批准，或规格文件被直接修改）；'
    +'先完成 cm-prd --change 并重新批准，之后按 status 提示继续。';
  const files=drift.files.join('、');
  if(drift.rebindable)return `规格已重新批准，变更文件：${files}；只有其他任务的条目、依赖或用例变了，requirements.md、design.md 与本任务相关内容均未变。`
    +'用 --mode resume --rebind-spec-material --spec-rebind-reason 原因 重开本运行即可显式换绑，已有开发与审查结论保留。';
  return `规格已变更：${files}；以下与本任务相关的内容已变或无法证明未变：${drift.fields.join('、')}，不能换绑。`
    +'出口：还原这些规格改动并重新批准后本运行可继续；或 cancel 本运行，还原本运行改动的代码后用 '
    +'--supersede-reviewed-evidence --supersede-reason 原因 新建运行重做。';
}
