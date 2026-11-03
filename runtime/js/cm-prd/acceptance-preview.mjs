// Read-only preview of the exact contract a new run would freeze. Not approval.
import fs from 'node:fs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {buildManifest,normalizeRuntimeMarks,verifyApprovedManifest} from '../../../scripts/cm-spec-manifest.mjs';
import {buildTaskAcceptanceContract} from '../cm-ai/specification-material.mjs';
import {parseFeatureTaskText,inspectTaskGrammarTransition} from '../cm-ai/cm-ai-admission.mjs';
import {TASK_GRAMMAR,SHARED_TASK_GRAMMAR,LEGACY_TASK_GRAMMAR,recordedTaskGrammar,taskLines} from '../spec-task-line.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {digest,freeze,json,need} from '../cm-ai/effect-contract.mjs';

const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const code=error=>/^[a-z][a-z0-9_]{0,95}$/.test(error?.code??'')?error.code:'acceptance_preview_invalid';
const filenames=['requirements.md','design.md','tasks.md','test-cases.json'];
const featureName=value=>typeof value==='string'&&/^\d+\.[^/\\\x00-\x1f]+$/.test(value);
const sourceId=item=>item.id.replace(/:[a-f0-9]{16}:\d+$/,'');
const unique=values=>[...new Set(values)];
const sha=value=>createHash('sha256').update(value).digest('hex');

export function previewTaskGrammar(statusBytes,fallback=TASK_GRAMMAR){
  need([1,2,TASK_GRAMMAR].includes(fallback),'acceptance_preview_grammar_invalid');
  if(statusBytes===null)return fallback;
  const status=JSON.parse(decode(statusBytes));
  need(status&&['approved','awaiting_review'].includes(status.status),'acceptance_preview_status_invalid');
  need(!Object.hasOwn(status,'taskGrammar')||[2,TASK_GRAMMAR].includes(status.taskGrammar),'acceptance_preview_grammar_invalid');
  return recordedTaskGrammar(status.taskGrammar);
}

function sourceLocations(feature,texts,contract){
  const lines=Object.fromEntries(['tasks.md','requirements.md'].map(file=>[file,
    normalizeRuntimeMarks(texts[file],file).split(/\r?\n/)]));
  const cases=texts['test-cases.json']===undefined?[]:JSON.parse(texts['test-cases.json']).cases;
  return Object.fromEntries(contract.obligations.map(item=>{
    const source=sourceId(item),file=source.startsWith('task:')?'tasks.md':'requirements.md';
    let locations=[];
    if(source.startsWith('TC-')){
      const [id,field]=source.split(':');
      cases.forEach((entry,index)=>{
        if(entry.id!==id)return;
        if(field)(entry[field]??[]).forEach((text,part)=>{
          if(`${field}: ${text}`===item.requirement)locations.push({path:`${feature}/test-cases.json`,pointer:`/cases/${index}/${field}/${part}`});
        });
        else locations.push({path:`${feature}/test-cases.json`,pointer:`/cases/${index}/title`});
      });
    }else lines[file].forEach((line,index)=>{
      if(line.trim()===item.requirement)locations.push({path:`${feature}/${file}`,line:index+1});
    });
    return [item.id,locations];
  }));
}

function taskPreview(feature,texts,task,grammar){
  const taskLocation={path:`${feature}/tasks.md`,line:taskLines(texts['tasks.md'],{grammar})
    .find(line=>line.declaration?.id===task.id).index+1};
  try{
    const contract=buildTaskAcceptanceContract({texts,taskId:task.id,grammar});
    if(contract===null)return {taskId:task.id,description:task.description,status:'ready',protection:'legacy_unprotected',location:taskLocation,
      contract:null,contractDigest:null,locations:{},issues:[],acceptanceCriteria:[],testCases:[],humanReviewIds:[]};
    const locations=sourceLocations(feature,texts,contract);
    const issues=contract.unresolved.map(message=>{
      const reference=/^(AC-\d+|TC-\d+):/.exec(message)?.[1];
      const related=contract.obligations.filter(item=>message.startsWith(`${sourceId(item)}:`)
        ||reference&&item.requirement.includes(reference));
      const at=related.flatMap(item=>locations[item.id]);
      return {message,locations:at.length?at:[taskLocation,{path:`${feature}/requirements.md`}],
        locationKind:at.length?'matching_source':'related_source'};
    });
    return {taskId:task.id,description:task.description,status:issues.length?'needs_clarification':'ready',
      location:taskLocation,contract,contractDigest:digest(contract),locations,issues,
      acceptanceCriteria:unique(contract.obligations.map(sourceId).filter(id=>/^AC-\d+$/.test(id))),
      testCases:unique(contract.obligations.map(sourceId).filter(id=>/^TC-/.test(id)).map(id=>id.split(':')[0])),
      humanReviewIds:contract.obligations.filter(item=>['review','browser','device'].includes(item.evidenceType)).map(item=>item.id)};
  }catch(error){return {taskId:task.id,description:task.description,status:'needs_clarification',location:taskLocation,
    contract:null,issues:[{message:code(error),locations:[taskLocation],locationKind:'related_source'}]};}
}

// Documents are the actual saved bytes or the immutable draft snapshot supplied
// by the PRD owner. No model response is used to construct the preview.
export function buildAcceptancePreview({features,taskGrammar=TASK_GRAMMAR,taskId=null,
  featureInventory=features?.map(feature=>feature.directory),approvalTransition=false}){
  need(Array.isArray(features)&&features.length>0&&features.length<=100,'acceptance_preview_scope_invalid');
  need([1,2,TASK_GRAMMAR].includes(taskGrammar),'acceptance_preview_grammar_invalid');
  need(typeof approvalTransition==='boolean'&&Array.isArray(featureInventory)&&featureInventory.length<=100
    &&featureInventory.every(featureName)&&new Set(featureInventory).size===featureInventory.length
    &&features.every(feature=>featureInventory.includes(feature.directory)),'acceptance_preview_scope_invalid');
  need(taskId===null||/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)&&features.length===1,'acceptance_preview_task_invalid');
  const seen=new Set();
  const result=features.map(feature=>{
    need(featureName(feature.directory)&&!seen.has(feature.directory),'acceptance_preview_scope_invalid');seen.add(feature.directory);
    need(Array.isArray(feature.documents),'acceptance_preview_documents_invalid');
    const texts=Object.fromEntries(feature.documents.map(doc=>[doc.path,doc.content]));
    need(Object.keys(texts).length===feature.documents.length&&Object.keys(texts).every(name=>filenames.includes(name))
      &&filenames.slice(0,3).every(name=>typeof texts[name]==='string'),'acceptance_preview_documents_invalid');
    const parsed=parseFeatureTaskText(texts['tasks.md'],{allowDependencyPunctuation:true,grammar:taskGrammar});
    if(parsed.error)return {feature:feature.directory,status:'needs_clarification',tasks:[],issues:[{
      message:parsed.error,locations:[{path:`${feature.directory}/tasks.md`,line:parsed.detail?.line??1}],locationKind:'matching_source'}]};
    const selected=parsed.tasks.filter(task=>!task.dropped&&(taskId===null||task.id===taskId));
    need(taskId===null||selected.length===1,'acceptance_preview_task_missing');
    const tasks=selected.map(task=>taskPreview(feature.directory,texts,task,taskGrammar));
    const issues=tasks.length?[]:[{message:'acceptance_preview_no_active_tasks',locations:[{path:`${feature.directory}/tasks.md`}],locationKind:'related_source'}];
    if(approvalTransition&&taskGrammar===LEGACY_TASK_GRAMMAR){
      const transition=inspectTaskGrammarTransition(texts['tasks.md'],{grammar:SHARED_TASK_GRAMMAR,fromLegacy:true});
      if(transition.parsed.error||transition.differing.length)issues.push({message:'task_grammar_conflict',
        locations:(transition.parsed.error?[transition.parsed.detail]:transition.differing).map(item=>({
          path:`${feature.directory}/tasks.md`,line:item.line})),locationKind:'matching_source',
        detail:'Explicit approval would change the task declaration set; resolve the original task lines before approval.'});
    }
    return {feature:feature.directory,status:issues.length||tasks.some(task=>task.status!=='ready')?'needs_clarification':'ready',tasks,issues};
  });
  return freeze(json({version:1,status:result.every(feature=>feature.status==='ready')?'ready':'needs_clarification',
    taskGrammar,approvalTransition,featureInventory:[...featureInventory].sort(),
    sourceDigest:digest({features,taskGrammar,featureInventory:[...featureInventory].sort(),approvalTransition}),
    sourceFiles:features.flatMap(feature=>feature.documents.map(doc=>({
      path:`${feature.directory}/${doc.path}`,sha256:sha(doc.content)}))),
    scope:{features:features.map(feature=>feature.directory),taskId},features:result,
    approvalAuthorized:false,executionAuthorized:false,meaning:'Captured source snapshot, requirement mapping only; no tests executed, no approval granted.'},2*1024*1024));
}

// A saved summary remains historical. The status response separately projects
// whether its preview still matches disk; it never rewrites the saved digest.
export function currentAcceptancePreview({specs,preview}){
  if(!preview||preview.status==='unavailable')return preview??null;
  try{
    need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'acceptance_preview_root_invalid');
    need(Array.isArray(preview.featureInventory),'acceptance_preview_inventory_missing');
    const inventory=unique(buildManifest(specs).map(row=>row.path.split('/')[0])).sort();
    const expected=new Map(preview.sourceFiles.map(row=>[row.path,row.sha256]));
    const current=()=>preview.scope.features.flatMap(feature=>filenames.flatMap(file=>{
      const name=`${feature}/${file}`,bytes=readCmInitSource(specs,name);
      return bytes===null?[]:[{path:name,sha256:sha(bytes)}];
    }));
    const rows=current(),same=rows.length===expected.size&&rows.every(row=>expected.get(row.path)===row.sha256);
    const statusBytes=readCmInitSource(specs,'.cm-specs-status');
    const grammar=previewTaskGrammar(statusBytes,preview.taskGrammar);
    need(digest(current())===digest(rows)
      &&digest(unique(buildManifest(specs).map(row=>row.path.split('/')[0])).sort())===digest(inventory)
      &&(readCmInitSource(specs,'.cm-specs-status')?.toString('base64')??null)===(statusBytes?.toString('base64')??null),
      'acceptance_preview_sources_changed');
    if(!same||grammar!==preview.taskGrammar||digest(inventory)!==digest(preview.featureInventory))return freeze({version:1,status:'stale',reason:'acceptance_preview_sources_changed',
      sourceDigest:preview.sourceDigest,scope:preview.scope,approvalAuthorized:false,executionAuthorized:false,
      next:'Rebuild the preview from current specifications; the saved summary is historical.'});
    return preview;
  }catch(error){return {version:1,status:'unavailable',reason:code(error),approvalAuthorized:false,executionAuthorized:false};}
}

// Presentation failures stay visible without changing old summary/publication
// contracts or blocking replay of already prepared historical summaries.
export function summaryAcceptancePreview({documents,currentFeatures,statusBytes,taskGrammar}){
  try{
    const preview=buildAcceptancePreview({features:documents.filter(feature=>currentFeatures===undefined||currentFeatures.includes(feature.directory)),
      taskGrammar:previewTaskGrammar(statusBytes,taskGrammar),featureInventory:documents.map(feature=>feature.directory),approvalTransition:true});
    need(Buffer.byteLength(JSON.stringify(preview))<=256*1024,'acceptance_preview_limit');return preview;
  }catch(error){return {version:1,status:'unavailable',reason:code(error),approvalAuthorized:false,executionAuthorized:false,
    next:'Run the read-only acceptance preview for one feature/task; original approval and execution gates remain required.'};}
}

export function inspectAcceptancePreview({specs,feature=null,taskId=null,taskGrammar=TASK_GRAMMAR}){
  need(typeof specs==='string'&&path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'acceptance_preview_root_invalid');
  const statusBytes=readCmInitSource(specs,'.cm-specs-status'),grammar=previewTaskGrammar(statusBytes,taskGrammar);
  const manifest=buildManifest(specs),names=unique(manifest.map(item=>item.path.split('/')[0]));
  need(names.length<=100,'acceptance_preview_scope_invalid');
  need(feature===null||names.includes(feature),'acceptance_preview_feature_missing');
  const sourceStatus=statusBytes===null?'draft':JSON.parse(decode(statusBytes)).status;
  if(sourceStatus==='approved'){
    try{
      const status=JSON.parse(decode(statusBytes));
      need(Array.isArray(status.features)&&digest([...status.features].sort())===digest([...names].sort()));
      verifyApprovedManifest(specs,path.join(specs,'.cm-specs-status'));
    }
    catch{need(false,'acceptance_preview_approved_sources_changed');}
  }
  let sourceBytes=0;
  const snapshots=new Map(),features=names.filter(name=>feature===null||name===feature).map(directory=>({directory,
    documents:manifest.filter(item=>item.path.startsWith(directory+'/')).map(item=>{
      const bytes=readCmInitSource(specs,item.path);need(bytes!==null,'acceptance_preview_source_missing');
      sourceBytes+=bytes.length;need(sourceBytes<=8*1024*1024,'acceptance_preview_limit');snapshots.set(item.path,bytes);
      return {path:item.path.slice(directory.length+1),content:decode(bytes)};
    })}));
  const result=buildAcceptancePreview({features,taskGrammar:grammar,taskId,featureInventory:names,
    approvalTransition:sourceStatus==='awaiting_review'});
  need([...snapshots].every(([file,bytes])=>readCmInitSource(specs,file)?.equals(bytes))
    &&(readCmInitSource(specs,'.cm-specs-status')?.toString('base64')??null)===(statusBytes?.toString('base64')??null)
    &&digest(buildManifest(specs))===digest(manifest),'acceptance_preview_sources_changed');
  return freeze({...result,sourceStatus});
}

const at=location=>`${location.path}${location.line?`:${location.line}`:location.pointer?`#${location.pointer}`:''}`;
export function acceptancePreviewLines(preview){
  const lines=[`验收预览：${preview.status}；只检查要求映射，未执行测试，未授予批准。`];
  for(const feature of preview.features??[]){
    lines.push(`功能 ${feature.feature}：${feature.status}`);
    for(const issue of feature.issues)lines.push(`  待澄清：${issue.message}（${issue.locations.map(at).join('、')}）`);
    for(const task of feature.tasks){
      lines.push(`  ${task.taskId}：${task.status}（${at(task.location)}）`);
      for(const item of task.contract?.obligations??[])lines.push(`    ${item.id} [${item.evidenceType}/${item.environment}${item.run?`/${item.run}`:''}] ${item.requirement}（${task.locations[item.id].map(at).join('、')}）`);
      for(const test of task.contract?.requiredTests??[])lines.push(`    必跑测试：${test}`);
      for(const command of task.contract?.requiredCommands??[])lines.push(`    必跑命令 argv：${JSON.stringify(command)}`);
      for(const issue of task.issues)lines.push(`    待澄清：${issue.message}（${issue.locations.map(at).join('、')}）`);
    }
  }
  return lines;
}
