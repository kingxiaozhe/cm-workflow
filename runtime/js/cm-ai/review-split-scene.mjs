// Read-only scene material contract. This module cannot register or dispatch work.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {digest,need} from './effect-contract.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const tasks=['T-004a','T-004b','T-004c'];
const same=(a,b,code)=>need(isDeepStrictEqual(a,b),code);
const unique=v=>Array.isArray(v)&&new Set(v).size===v.length;
const imageKey=v=>v.origin+':'+v.path;
const textKey=v=>v.origin+':'+v.fileId;
const testKey=v=>`${v.path}:${v.start}-${v.end}`;
export const SCENE_CLOSURE_RULE='No scene can close a cross-scene finding or acceptance criterion alone. Require every assigned scene conclusion and all original blocking checks; missing evidence, unsupported reuse or unavailable formal admission remains BLOCKED. Preparation makes no pass/closure finding.';

function owners(row,{visible=true,all=false}={}){
  need(unique(row.owners)&&row.owners.length>0&&row.owners.every(t=>tasks.includes(t)),'split_scene_owners');
  if(all)same(row.owners,tasks,'split_scene_owners');
  if(visible)same(row.visibleIn,tasks,'split_scene_visibility');
}
function rows(actual,expected,key,code,check){
  need(Array.isArray(actual)&&actual.length===expected.length&&unique(actual.map(key)),code);
  const byKey=new Map(expected.map(x=>[key(x),x]));need(byKey.size===expected.length,code);
  for(const row of actual){const original=byKey.get(key(row));need(original!==undefined,code);check(row,original);}
}
function pointer(value,p){
  need(typeof p==='string'&&(p===''||p.startsWith('/')),'split_scene_pointer');
  return p===''?value:p.slice(1).split('/').reduce((v,k)=>{
    k=k.replace(/~1/g,'/').replace(/~0/g,'~');return v&&typeof v==='object'&&Object.hasOwn(v,k)?v[k]:undefined;
  },value);
}
function utf8(b){const t=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(b);need(Buffer.from(t).equals(b),'split_material_encoding');return t;}
function originalText(manifest,metadata){
  const root=manifest.textEvidence.storeRoot;
  need(path.isAbsolute(root)&&fs.realpathSync(root)===root&&metadata.contentBlob===metadata.sha256
    &&/^[a-f0-9]{64}$/.test(metadata.sha256),'split_scene_text_source');
  const file=path.join(root,metadata.contentBlob),s=fs.lstatSync(file);
  need(s.isFile()&&!s.isSymbolicLink()&&s.size===metadata.size&&s.size<=1024*1024,'split_scene_text_source');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const b=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(file);
    need([after,current].every(v=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>v[k]===s[k]))
      &&sha(b)===metadata.sha256,'split_scene_text_source');return utf8(b);
  }finally{fs.closeSync(fd);}
}
function decoded(value){
  if(Array.isArray(value))return value.map(decoded);
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'contentBase64')||Object.hasOwn(value,'contentGzipBase64')){
    need(Number.isSafeInteger(value.size)&&value.size>=0&&value.size<=16*1024*1024,'split_scene_source');
    const encoded=value.contentGzipBase64??value.contentBase64,b=Buffer.from(encoded,'base64');
    need(b.toString('base64')===encoded,'split_scene_source');
    const raw=Object.hasOwn(value,'contentGzipBase64')?gunzipSync(b,{maxOutputLength:value.size+1}):b;
    need(raw.length===value.size&&sha(raw)===value.sha256,'split_scene_source');
    const {contentBase64,contentGzipBase64,...metadata}=value;return {...metadata,text:utf8(raw)};
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decoded(v)]));
}

// The material's claimed original context is checked against the bound package,
// not merely against hashes supplied in that same material.
export function assertSceneSourceCoverage(report,pkg,last){
  const data=report.sceneData,m=data?.mapping?.responsibilityMapping;
  need(data&&m,'split_scene_source');
  const {changes,...context}=decoded(pkg);same(data.originalContext,context,'split_scene_original_context');
  same(m.sourceIdentity,pkg.identity,'split_scene_source');
  need(m.originalPackageDigest===pkg.packageDigest&&m.originalBaseIdentity===pkg.baseIdentity
    &&m.originalArtifactDigest===pkg.artifactDigest,'split_scene_source');
  rows(m.changedPaths,pkg.changes,x=>x.id??x.path,'split_scene_changes',(row,c)=>{
    owners(row,{all:true});need(row.originalRecordCanonicalSha256===digest(c)&&row.combination==='AND','split_scene_changes');
  });
  rows(data.changes,changes,x=>x.path,'split_scene_changes',(selected,original)=>{
    // The enclosing split contract verifies the complete package-lock delta.
    // Ordinary source files must already carry their exact before/after text.
    if(selected.kind!=='verified-json-delta')same(selected,original,'split_scene_changes');
    else need(selected.path.endsWith('/package-lock.json')&&selected.before?.sha256===original.before?.sha256
      &&selected.after?.sha256===original.after?.sha256,'split_scene_changes');
  });
  const scope=[...(pkg.unchangedScope??[]).map(original=>({id:original.path,original})),
    ...(pkg.specification?.sources??[]).map(original=>({id:'specification:'+original.path,original}))];
  rows(m.otherOriginalScope,scope,x=>x.id,'split_scene_scope',(row,s)=>{
    owners(row,{all:true});same(row.original,s.original,'split_scene_scope');need(row.changed===false,'split_scene_scope');
  });
  rows(m.testGroups,data.originalTestGroups,x=>x.id??testKey(x),'split_scene_tests',(row,t)=>{
    owners(row);need(row.combination===(row.owners.length===1?'sole_scene_required':'AND'),'split_scene_tests');same(row.original,t,'split_scene_tests');
    const change=changes.find(c=>c.path===t.path);
    need(change&&Number.isInteger(t.start)&&Number.isInteger(t.end)&&t.start>0&&t.end>=t.start,'split_scene_tests');
    const text=change.after.text.split(/(?<=\n)/).slice(t.start-1,t.end).join('');
    need(row.fileAfterSha256===change.after.sha256&&row.originalText===text&&row.originalTextUtf8Sha256===sha(text)
      &&row.originalInventoryEntryCanonicalSha256===digest(t),'split_scene_tests');
  });
  same(data.oldReceipts,last.receipts,'split_scene_receipts');
  rows(m.historicalReceipts,last.receipts,x=>x.id,'split_scene_receipts',(row,r)=>{
    owners(row,{all:true});same(row.original,r,'split_scene_receipts');
    need(row.originalCanonicalSha256===digest(r)&&row.currentApproval===false&&row.originalVerdict===r.result.verdict,'split_scene_receipts');
  });
  const findings=last.receipts.flatMap(r=>r.result.findings.map(original=>({id:r.id+':'+original.id,receipt:r,original})));
  rows(m.findings,findings,x=>x.id,'split_scene_findings',(row,f)=>{
    owners(row);need(row.combination===(row.owners.length===1?'sole_scene_required':'AND'),'split_scene_findings');same(row.original,f.original,'split_scene_findings');
    need(row.originalReceiptId===f.receipt.id&&row.originalReceiptDigest===f.receipt.receiptDigest
      &&row.originalCanonicalSha256===digest(f.original)&&row.messageUtf8Sha256===sha(f.original.message)
      &&row.evidenceUtf8Sha256===sha(f.original.evidence)&&row.disposition==='open'&&row.closedByPreparation===false,'split_scene_findings');
  });
  rows(m.acceptanceCriteria,pkg.specification?.acceptanceCriteria??[],x=>x.id,'split_scene_acceptance',(row,ac)=>{
    owners(row,{all:true});need(row.originalText===ac.text&&row.originalTextUtf8Sha256===sha(ac.text)
      &&row.featureAcAcceptedByThisPreparation===false&&row.combination==='AND_for_original_T004_contribution','split_scene_acceptance');
  });
  rows(m.originalBlockingCases,pkg.specification?.testCases??[],x=>x.id,'split_scene_cases',(row,c)=>{
    owners(row,{all:true});same(row.original,c,'split_scene_cases');same(row.originalTaskIdsRetained,c.taskIds,'split_scene_cases');
    need(row.originalCanonicalSha256===digest(c)&&row.semanticsChanged===false&&row.combination==='AND','split_scene_cases');
  });
  rows(m.historicalCheckBindings,pkg.checks,x=>x.id,'split_scene_checks',(row,c)=>{
    owners(row,{all:true});need(row.originalCanonicalSha256===digest(c)&&row.originalOutcome===c.outcome
      &&row.originalExitCode===c.exitCode&&row.executedNow===false,'split_scene_checks');
  });
}

export function verifySceneMaterial(v,{fileSha256,expectedSource,expectedCoverageDigest,expand,pages}){
  need(v.version===1&&v.kind==='cm-offline-scene-material'&&tasks.includes(v.taskId),'split_material_invalid');
  if(expectedSource)same(v.source,expectedSource,'split_material_source');
  if(expectedCoverageDigest)need(v.coverageDigest===expectedCoverageDigest,'split_material_coverage');
  const request=v.request;
  need(request?.version===1&&request.kind==='cm-offline-scene-candidate-request'&&request.status==='offline-preparation-only'
    &&request.proposedTaskId===v.taskId&&request.providerAccepted===false&&request.dispatchAuthorized===false,'split_material_invalid');
  need(sha(JSON.stringify(request))===v.requestSha256,'split_material_digest');
  const marker='<cm-offline-scene-data-json>\n',at=request.prompt?.indexOf(marker);
  need(at>=0,'split_material_invalid');const data=expand(JSON.parse(request.prompt.slice(at+marker.length)));
  need(sha(JSON.stringify(data))===v.expandedDataSha256,'split_material_digest');
  need(data.kind==='cm-offline-scene-candidate-data'&&data.status==='offline-preparation-only'&&data.proposedTaskId===v.taskId,'split_material_invalid');
  same(data.source,v.source,'split_material_source');
  need(data.coverageDigest===v.coverageDigest&&digest(data.mapping)===v.coverageDigest
    &&data.originalContext.packageDigest===v.source.originalPackageDigest,'split_material_coverage');
  const {sceneDefinitions:scenes,responsibilityMapping:m,textMapping:tm,closureRule}=data.mapping;
  same(scenes.map(s=>s.taskId),tasks,'split_scene_definitions');
  need(closureRule===SCENE_CLOSURE_RULE,'split_scene_closure');
  same(data.scene,scenes.find(s=>s.taskId===v.taskId),'split_scene_definitions');
  const originals=[['native',data.originalContext.checks.find(c=>c.kind==='native-evidence')?.material],
    ['continuation',data.originalContext.evidenceContinuation?.newEvidence?.material]];
  need(originals.every(([,x])=>x?.textEvidence&&Array.isArray(x.images)),'split_scene_manifest');
  same(data.sourceManifests,originals.map(([origin,x])=>({origin,...x})),'split_scene_manifest');
  const images=originals.flatMap(([origin,x])=>x.images.map(i=>({origin,...i})));
  rows(tm.images,images,imageKey,'split_scene_images',(row,image)=>{
    owners(row,{visible:false});need(row.owners.length===1&&row.sha256===image.sha256&&row.size===image.size
      &&row.originalDescription===image.description&&row.representation==='complete-original-image-bytes','split_scene_images');
  });
  rows(m.imageAssignments,images,imageKey,'split_scene_images',(row,image)=>{
    const mapped=tm.images.find(i=>imageKey(i)===imageKey(image));same(row.owners,mapped.owners,'split_scene_images');
    same(row.visibleIn,row.owners,'split_scene_images');need(row.id===imageKey(image)&&row.sha256===image.sha256&&row.bytes===image.size
      &&row.originalDescription===image.description&&row.descriptionUtf8Sha256===sha(image.description),'split_scene_images');
  });
  rows(m.scenes,scenes,s=>s.id??s.taskId,'split_scene_definitions',(row,scene)=>{
    const assigned=tm.images.filter(i=>i.owners.includes(scene.taskId));
    need(typeof scene.scene==='string'&&scene.scene.trim()&&typeof scene.bounds==='string'&&scene.bounds.trim()
      &&scene.imageCount===assigned.length&&scene.imageCount<=10&&row.imageCount===scene.imageCount
      &&row.mustNotSubstituteForOtherScenes===true,'split_scene_definitions');
    same(scene.imagePaths,assigned.map(i=>i.path),'split_scene_definitions');same(row.imageIds,assigned.map(imageKey),'split_scene_definitions');
  });
  const sources=originals.flatMap(([origin,manifest])=>manifest.textEvidence.files.map(metadata=>({origin,fileId:metadata.id,metadata,manifest,
    requirements:manifest.textEvidence.requirements.filter(r=>r.fileId===metadata.id)})));
  rows(tm.textSources,sources,textKey,'split_scene_text_mapping',(row,s)=>{
    owners(row,{visible:false});need(row.path===s.metadata.path&&row.sha256===s.metadata.sha256&&row.size===s.metadata.size
      &&row.contentBlob===s.metadata.contentBlob&&row.storeRoot===s.manifest.textEvidence.storeRoot&&row.mediaType===s.metadata.mediaType,'split_scene_text_mapping');
    same(row.requirements,s.requirements,'split_scene_text_mapping');
  });
  // This table describes visibility in the original shared context; scene text
  // ownership comes from tm.textSources, and the full document is mandatory.
  rows(m.sharedTextSourceBindings,sources,s=>s.id??textKey(s),'split_scene_text_mapping',(row,s)=>{
    owners(row,{visible:false,all:true});need(row.sha256===s.metadata.sha256&&row.bytes===s.metadata.size&&row.path===s.metadata.path,'split_scene_text_mapping');
  });
  const assigned=tm.textSources.filter(s=>s.owners.includes(v.taskId));
  rows(data.materials,assigned,s=>s.metadata?s.origin+':'+s.metadata.id:textKey(s),'split_scene_text_coverage',(row,entry)=>{
    const s=sources.find(x=>textKey(x)===textKey(entry));same(row.metadata,s.metadata,'split_scene_text_content');
    same(row.requirements,s.requirements,'split_scene_text_content');const original=originalText(s.manifest,s.metadata);
    const json=['application/json','application/x-cm-lossless-json-evidence'].includes(s.metadata.mediaType);
    let document;
    if(json){
      const parsed=JSON.parse(original);
      if(row.representation==='complete-original-json-text'){same(row.data,original,'split_scene_text_content');document=JSON.parse(row.data);}
      else{need(row.representation==='complete-original-json-values','split_scene_text_content');same(row.data,parsed,'split_scene_text_content');document=row.data;}
    }else{need(row.representation==='complete-original-text','split_scene_text_content');same(row.data,original,'split_scene_text_content');document=row.data;}
    for(const requirement of row.requirements)for(const p of requirement.pointers)need(pointer(document,p)!==undefined,'split_scene_pointer');
  });
  const requiredImages=images.filter(i=>tm.images.find(x=>imageKey(x)===imageKey(i)).owners.includes(v.taskId));
  same(data.images,requiredImages,'split_scene_images');
  need(Array.isArray(request.images)&&request.images.length===requiredImages.length,'split_scene_images');let imageBytes=0;
  for(const [i,image]of request.images.entries()){
    const {contentBase64,...metadata}=image;same(metadata,requiredImages[i],'split_scene_images');
    need(typeof contentBase64==='string','split_scene_images');const raw=Buffer.from(contentBase64,'base64');
    need(raw.toString('base64')===contentBase64&&raw.length===image.size&&sha(raw)===image.sha256,'split_scene_images');imageBytes+=raw.length;
  }
  const paging=pages(request.prompt),counts={...paging,images:request.images.length,imageBytes,textPlusImageBytes:paging.promptBytes+imageBytes,
    serializedRequestBytes:Buffer.byteLength(JSON.stringify(request)),wireBytes:null,
    wireBoundary:'No request sent. Serialized UTF-8 JSON includes base64 images, but excludes provider/RPC envelope.'};
  same(v.counts,counts,'split_material_counts');
  const capacityBlockers=[...(paging.pageCount>128?['text_page_target_exceeded']:[]),...(request.images.length>10?['image_target_exceeded']:[])];
  same(v.capacityBlockers,capacityBlockers,'split_material_counts');
  need(v.capacityPassed===(capacityBlockers.length===0)&&v.formalProviderAccepted===false&&v.reviewReady===false,'split_material_invalid');
  same(v.coverage,{codeChanges:data.changes.length,testGroups:data.originalTestGroups.length,
    acceptanceCriteria:data.originalContext.specification?.acceptanceCriteria?.length??0,receipts:data.oldReceipts.length,
    oldFindingOccurrences:data.oldReceipts.flatMap(r=>r.result.findings).length,textSourcesIncluded:data.materials.length,
    textSourcesMapped:sources.length,originalImagesMapped:images.length},'split_material_coverage');
  const coverage={changes:m.changedPaths.flatMap(c=>c.owners.map(owner=>({path:c.id,owner,beforeSha256:c.before?.sha256??null,afterSha256:c.after?.sha256??null}))),
    tests:m.testGroups.map(t=>({...t.original,owners:t.owners})),
    findings:m.findings.map(f=>({receiptId:f.originalReceiptId,receiptDigest:f.originalReceiptDigest,finding:f.original,owners:f.owners})),
    materials:sources.map(s=>({origin:s.origin,fileId:s.fileId,sha256:s.metadata.sha256,size:s.metadata.size,requirements:s.requirements,
      owners:tm.textSources.find(t=>textKey(t)===textKey(s)).owners})),images:tm.images.map(i=>({...i,representation:'complete-original-bytes'}))};
  const report={integrityVerified:true,accepted:false,budgetEligible:capacityBlockers.length===0,formalProviderAccepted:false,taskId:v.taskId,
    source:v.source,originalPackageDigest:v.source.originalPackageDigest,coverageDigest:v.coverageDigest,fileSha256,requestSha256:v.requestSha256,counts,
    sceneCoverage:{version:1,coverageDigest:v.coverageDigest,sceneDefinitions:scenes,closureRule},scene:data.scene,coverage,
    readableImages:data.images,sourceManifests:data.sourceManifests,oldReceipts:data.oldReceipts,selectedChanges:data.changes,
    capacityPassed:capacityBlockers.length===0,materialBlockers:capacityBlockers,blockers:[...capacityBlockers,'formal_split_admission_required']};
  // Keep the bound context available to the full contract without copying all
  // readable documents again into CLI JSON summaries.
  Object.defineProperty(report,'sceneData',{value:data});return report;
}
