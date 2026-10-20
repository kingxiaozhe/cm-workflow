// Native review material integrity only. No execution scope or visual acceptance.
import {inspectNativeTextEvidence,projectNativeTextEvidence,captureNativeTextEvidence,validateNativeTextEvidence} from './native-text-evidence.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,json,shape,need,hex,freeze,validIdentity} from './effect-contract.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {readModelJsonRecord} from './model-configuration-file.mjs';
import {binaryAssetPath,binaryAssetStoreRoot,readBinaryAssetBinding,validateBinaryAssetSource,
 captureBinaryAsset,readBinaryAssetBytes} from './binary-assets.mjs';
const LIMITS={manifest:64*1024,report:16*1024,images:10,image:16*1024*1024,total:32*1024*1024};
const EVIDENCE='Native material integrity only; not visual acceptance.';
const hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
function relative(p){
 need(typeof p==='string'&&p.length>0&&p.length<=1024&&p.normalize('NFC')===p
  &&!/[\\:\x00-\x1f\x7f-\x9f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'
   &&!['.git','.ssh','.aws','.gnupg','.env'].includes(s.toLowerCase())&&!/^\.env\./i.test(s)),'native_evidence_path');return p;
}
function directory(root,inspect=true){
 need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&!/[\\\x00-\x1f\x7f-\x9f]/.test(root),'native_evidence_path');
 if(inspect){let current=path.parse(root).root;
  for(const part of root.slice(current.length).split('/').filter(Boolean)){current=path.join(current,part);
   const st=fs.lstatSync(current);need(st.isDirectory()&&!st.isSymbolicLink(),'native_evidence_path');}
  need(fs.realpathSync(root)===root,'native_evidence_path');}
 return root;
}
function parents(root,p){relative(p);directory(path.dirname(path.join(root,p)));}
export function readNativeEvidenceProfile(raw,context,{inspectCurrent=context.inspectCurrent??true}={}){
 const v=json(raw,LIMITS.manifest);shape(v,['version','sourceRoot','manifest']);need(v.version===1,'native_evidence_profile');
 const code=directory(context.codeProject,inspectCurrent),specs=directory(context.specsDir,inspectCurrent);
 directory(v.sourceRoot,inspectCurrent);relative(v.manifest);need(v.manifest.endsWith('.json'),'native_evidence_profile');
 need(![code,specs].some(root=>inside(root,v.sourceRoot)||inside(v.sourceRoot,root)),'native_evidence_source');
 if(inspectCurrent)parents(v.sourceRoot,v.manifest);return freeze(v);
}
const key=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function currentSource(root,p){
 parents(root,p);const file=path.join(root,p),before=fs.lstatSync(file,{bigint:true});
 const bytes=readCmInitSource(root,p);need(bytes!==null&&key(before)===key(fs.lstatSync(file,{bigint:true})),'native_evidence_source_changed');
 return {path:p,sha256:hash(bytes)};
}
function sourceFiles(rows){
 need(Array.isArray(rows)&&rows.length>0&&rows.length<=256,'native_evidence_sources');
 for(const row of rows){shape(row,['path','sha256']);relative(row.path);hex(row.sha256);}
 const names=rows.map(r=>r.path);need(new Set(names.map(p=>p.toLowerCase())).size===names.length
  &&digest(names)===digest([...names].sort()),'native_evidence_sources');return names;
}
function report(value){need(typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=LIMITS.report,'native_evidence_report');}
function description(value){need(typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=1024,'native_evidence_image');}
function png(bytes){
 need(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  &&bytes.readUInt32BE(8)===13&&bytes.toString('ascii',12,16)==='IHDR'
  &&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0,'native_evidence_png');
 let offset=8,idat=false,ended=false;
 while(offset+12<=bytes.length){const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
  need(size<=bytes.length-offset-12&&/^[A-Za-z]{4}$/.test(type),'native_evidence_png');
  if(type==='IDAT')idat=true;offset+=size+12;
  if(type==='IEND'){need(size===0&&offset===bytes.length,'native_evidence_png');ended=true;break;}}
 need(ended&&idat,'native_evidence_png');
}
function imageList(images,read){
 need(Array.isArray(images)&&images.length>0&&images.length<=LIMITS.images,'native_evidence_images');let total=0;const names=new Set();
 for(const image of images){const name=binaryAssetPath(image.path);need(name.endsWith('.png')&&!names.has(name.toLowerCase()),'native_evidence_image');names.add(name.toLowerCase());
  description(image.description);hex(image.sha256);need(Number.isSafeInteger(image.size)&&image.size>0&&image.size<=LIMITS.image,'native_evidence_image');
  total+=image.size;need(total<=LIMITS.total,'native_evidence_images');read(image);}
}
function inspectNativeMaterial(profile,{codeProject,specsDir,identity,scope,sourceFiles:projected}){
 validIdentity(identity);const configured=readNativeEvidenceProfile(profile,{codeProject,specsDir});
 parents(configured.sourceRoot,configured.manifest);
 const manifest=readModelJsonRecord(path.join(configured.sourceRoot,configured.manifest)),v=json(manifest.value,LIMITS.manifest);
 shape(v,['version','report','sourceFiles','images',...(v.version===2?['textEvidence']:[])]);need([1,2].includes(v.version),'native_evidence_manifest');report(v.report);
 if(v.version===2)need(inspectNativeTextEvidence(v.textEvidence,{codeProject,specsDir}).ready,'native_text_not_ready');
 const names=sourceFiles(v.sourceFiles);need(Array.isArray(scope)&&scope.length>0&&scope.every(p=>relative(p))
  &&new Set(scope).size===scope.length&&digest(names)===digest([...scope].sort()),'native_evidence_scope');
 const hasProjection=projected!==undefined,candidate=hasProjection?json(projected,LIMITS.manifest):null;
 if(hasProjection)need(digest(sourceFiles(candidate))===digest(names),'native_evidence_scope');
 const readSources=()=>hasProjection?candidate:names.map(p=>currentSource(codeProject,p));
 const recheck=()=>need(digest(v.sourceFiles)===digest(readSources())
  &&readModelJsonRecord(path.join(configured.sourceRoot,configured.manifest)).sha256===manifest.sha256,'native_evidence_source_changed');
 need(digest(v.sourceFiles)===digest(readSources()),'native_evidence_source_changed');
 imageList(v.images,image=>{shape(image,['path','sha256','size','description']);
  png(validateBinaryAssetSource({sourceRoot:configured.sourceRoot,sourcePath:image.path,sha256:image.sha256,size:image.size}));});
 return {configured,manifest,v,recheck};
}
// A candidate hash projection is diagnostic only: no archived check, grant or
// visual acceptance is produced, and the owner still captures actual bytes.
export function inspectNativeReviewEvidence(profile,context){
 const {manifest,v,recheck}=inspectNativeMaterial(profile,context);recheck();
 return freeze({readOnly:true,integrityOnly:true,renderingUnknown:true,scope:[...context.scope],
  sourceFiles:v.sourceFiles,manifestDigest:manifest.sha256,
  material:{version:v.version,report:v.report,sourceFiles:v.sourceFiles,images:v.images,
   ...(v.version===2?{textEvidence:inspectNativeTextEvidence(v.textEvidence,context)}:{})}});
}
export function captureNativeReviewEvidence(profile,{codeProject,specsDir,identity,scope}){
 const {configured,manifest,v,recheck}=inspectNativeMaterial(profile,{codeProject,specsDir,identity,scope});
 const binding=readBinaryAssetBinding({version:1,paths:v.images.map(i=>i.path),storeRoot:binaryAssetStoreRoot({specsDir,identity})},identity);
 const images=v.images.map(image=>{const record=captureBinaryAsset({root:configured.sourceRoot,path:image.path,binding});
  need(record.sha256===image.sha256&&record.size===image.size,'native_evidence_image_changed');
  png(readBinaryAssetBytes({binding,record}));return {...record,description:image.description};});
 // Recheck product and manifest after publication. A concurrent edit never yields accepted material.
 recheck();
 const textEvidence=v.version===2?captureNativeTextEvidence(v.textEvidence,{codeProject,specsDir,identity}):null;
 recheck();
 return validateNativeEvidenceCheck(nativeMaterialCheck(v,manifest.sha256,binding,images,textEvidence),identity);
}
function nativeMaterialCheck(v,manifestDigest,binaryAssets,images,textEvidence){
 const material={version:v.version,report:v.report,sourceFiles:v.sourceFiles,binaryAssets,images,manifestDigest,...(textEvidence?{textEvidence}:{})};
 return {id:'native-evidence',kind:'native-evidence',outcome:'passed',exitCode:0,evidence:EVIDENCE,material,materialDigest:digest(material)};
}
// Predict exact future metadata from validated source bytes, without publication.
// The result is diagnostic only; validateNativeEvidenceCheck still requires archives.
export function projectNativeReviewEvidence(profile,context){
 const {configured,manifest,v,recheck}=inspectNativeMaterial(profile,context);
 const binding=readBinaryAssetBinding({version:1,paths:v.images.map(i=>i.path),storeRoot:binaryAssetStoreRoot(context)},context.identity);
 const images=v.images.map(image=>({path:image.path,type:'file',mode:fs.lstatSync(path.join(configured.sourceRoot,image.path)).mode&0o7777,size:image.size,sha256:image.sha256,contentBlob:image.sha256,description:image.description}));
 const text=v.version===2?projectNativeTextEvidence(v.textEvidence,context):null;recheck();
 return {check:nativeMaterialCheck(v,manifest.sha256,binding,images,text?.binding??null),textPresentation:text?.presentation??null};
}
export function validateNativeEvidenceCheck(raw,identity=null){
 const c=json(raw,LIMITS.manifest);if(identity!==null)validIdentity(identity);
 if(c.outcome==='unavailable'){
  shape(c,['id','kind','outcome','exitCode','evidence']);need(c.id==='native-evidence'&&c.kind==='native-evidence'&&c.exitCode===null
   &&typeof c.evidence==='string'&&c.evidence.trim().length>0&&Buffer.byteLength(c.evidence)<=1024,'native_evidence_check');return c;
 }
 shape(c,['id','kind','outcome','exitCode','evidence','material','materialDigest']);
 need(c.id==='native-evidence'&&c.kind==='native-evidence'&&c.outcome==='passed'&&c.exitCode===0&&c.evidence===EVIDENCE,'native_evidence_check');
 const m=c.material;shape(m,['version','report','sourceFiles','binaryAssets','images','manifestDigest',...(m.version===2?['textEvidence']:[])]);
 need([1,2].includes(m.version)&&c.materialDigest===digest(m),'native_evidence_material');
 if(m.version===2)validateNativeTextEvidence(m.textEvidence,identity);hex(m.manifestDigest);report(m.report);sourceFiles(m.sourceFiles);
 const binding=readBinaryAssetBinding(m.binaryAssets,identity);need(digest(binding.paths)===digest(m.images.map(i=>i.path)),'native_evidence_binding');
 imageList(m.images,image=>{const {description:label,...record}=image;description(label);png(readBinaryAssetBytes({binding,record}));});
 return c;
}
// Called by the package validator and worker; never imports package code.
export function nativeEvidenceImagePaths(pkg){
 const checks=pkg.checks.filter(c=>c.kind==='native-evidence');need(checks.length<=1,'native_evidence_check');
 if(pkg.evidenceContinuation)checks.push(pkg.evidenceContinuation.newEvidence);
 return checks.flatMap(raw=>{const c=validateNativeEvidenceCheck(raw,pkg.identity);if(c.outcome==='unavailable')return [];
  const names=sourceFiles(c.material.sourceFiles),scope=pkg.scope.filter(p=>p!=='AGENTS.md').sort();
  need(digest(names)===digest(scope),'native_evidence_scope');
  const current=new Map((pkg.unchangedScope??[]).map(r=>[r.path,r]));
  for(const change of pkg.changes)current.set(change.path,change.after);
  need(c.material.sourceFiles.every(row=>current.get(row.path)?.sha256===row.sha256),'native_evidence_source_binding');
  return c.material.images.map(i=>path.join(c.material.binaryAssets.storeRoot,i.contentBlob));});
}

// Readiness is an inventory of declared material gaps, never a passed check.
export function inspectNativeReviewReadiness(profile,context){
 const issues=[];let configured,v,textEvidence=null;
 const run=(code,fileId,fn)=>{try{return fn();}catch{issues.push({code,fileId});return null;}};
 configured=run('native_evidence_profile',null,()=>readNativeEvidenceProfile(profile,context));
 if(configured)v=run('native_evidence_manifest',null,()=>{
  const value=readModelJsonRecord(path.join(configured.sourceRoot,configured.manifest)).value;
  shape(value,['version','report','sourceFiles','images',...(value.version===2?['textEvidence']:[])]);
  need([1,2].includes(value.version));return value;
 });
 if(v){
  run('native_evidence_report',null,()=>report(v.report));
  const names=run('native_evidence_sources',null,()=>sourceFiles(v.sourceFiles));
  if(names){run('native_evidence_scope',null,()=>need(digest(names)===digest([...context.scope].sort())));
   for(const row of v.sourceFiles)run('native_evidence_source_changed',row.path,()=>{
    const current=context.sourceFiles?.find(f=>f.path===row.path)??currentSource(context.codeProject,row.path);
    need(current.sha256===row.sha256);
   });
  }
  run('native_evidence_images',null,()=>imageList(v.images,()=>{}));
  if(Array.isArray(v.images))for(const [i,image] of v.images.slice(0,LIMITS.images).entries())run('native_evidence_image_missing_changed_or_invalid',String(i),()=>{
   shape(image,['path','sha256','size','description']);imageList([image],row=>png(validateBinaryAssetSource({sourceRoot:configured.sourceRoot,sourcePath:row.path,sha256:row.sha256,size:row.size})));
  });
  if(v.version===2){textEvidence=inspectNativeTextEvidence(v.textEvidence,context);issues.push(...textEvidence.issues);}
 }
 return freeze({readOnly:true,integrityOnly:true,renderingUnknown:true,ready:issues.length===0,issues,textEvidence});
}
