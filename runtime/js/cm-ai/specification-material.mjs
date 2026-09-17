// Host-owned approved specification data. Never a write scope or authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildManifest,verifyManifest,normalizeRuntimeMarks} from '../../../scripts/cm-spec-manifest.mjs';
import {parseFeatureTaskText,declaredAcceptanceIds} from './cm-ai-admission.mjs';
import {readReviewSourceFiles,readReviewSourceExcerpt} from './review-package.mjs';
import {json,need,shape,hex,freeze,digest} from './effect-contract.mjs';

const DESIGN_LIMIT=64*1024;
const filenames=['requirements.md','design.md','tasks.md','test-cases.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const featureName=value=>need(typeof value==='string'&&/^\d+\.[^/\\\x00-\x1f]+$/.test(value));

export function readSpecificationMaterial(raw,taskId){
  const v=json(raw,2*1024*1024);
  shape(v,['feature','task','acceptanceCriteria','designExcerpt','testCases','sources',
    ...(Object.hasOwn(v,'truncated')?['truncated']:[])]);
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
    const manifest=buildManifest(specsRoot);verifyManifest(manifest,statusPath);
    need(JSON.stringify([...status.features].sort())===JSON.stringify([...new Set(manifest.map(row=>row.path.split('/')[0]))].sort()));
    const sources=manifest.filter(row=>row.path.startsWith(feature+'/'));
    const designPath=feature+'/design.md';
    const records=readReviewSourceFiles(specsRoot,sources.map(row=>row.path).filter(p=>p!==designPath)),texts={};
    const design=readReviewSourceExcerpt(specsRoot,designPath,DESIGN_LIMIT);
    need(design.sha256===sources.find(row=>row.path===designPath)?.sha256);
    for(const record of records){
      const name=path.basename(record.path),bytes=Buffer.from(record.contentBase64,'base64');
      // Hash the very bytes that supply the material, using the existing runtime-mark contract.
      const normalized=Buffer.from(normalizeRuntimeMarks(bytes.toString('latin1'),name),'latin1');
      need(hash(normalized)===sources.find(row=>row.path===record.path)?.sha256);
      texts[name]=normalizeRuntimeMarks(bytes.toString('utf8'),name);
    }
    need(readReviewSourceFiles(specsRoot,['.cm-specs-status'])[0].sha256===statusRecord.sha256);
    verifyManifest(buildManifest(specsRoot),statusPath);
    const parsed=parseFeatureTaskText(texts['tasks.md'],{allowDependencyPunctuation:true});
    need(!parsed.error);
    const selected=parsed.tasks.find(task=>task.id===taskId&&!task.dropped);need(selected);
    const verification=verificationFor(texts['tasks.md'],taskId);
    const task={id:taskId,description:selected.description,...(verification?{verification}:{})};
    const acceptanceCriteria=texts['requirements.md'].split(/\r?\n/).flatMap(line=>
      [...declaredAcceptanceIds(line)].map(id=>({id,text:line.trim()})));
    const cases=texts['test-cases.json']===undefined?[]:JSON.parse(texts['test-cases.json']).cases;
    need(Array.isArray(cases)&&cases.every(item=>item&&Array.isArray(item.taskIds)));
    return readSpecificationMaterial({feature,task,acceptanceCriteria,designExcerpt:design.excerpt,
      ...(design.truncated?{truncated:true}:{}),testCases:cases.filter(item=>item.taskIds.includes(taskId)),sources},taskId);
  }catch{throw Object.assign(new Error('spec_drift'),{code:'spec_drift'});}
}

export function verifySpecificationMaterial(baseline){
  const current=captureSpecificationMaterial({specsRoot:baseline.specificationRoot,
    feature:baseline.specification.feature,taskId:baseline.identity.taskId});
  need(digest(current)===digest(baseline.specification),'spec_drift');
  return baseline.specification;
}
