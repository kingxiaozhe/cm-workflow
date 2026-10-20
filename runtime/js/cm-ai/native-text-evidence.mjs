import {validateLosslessJsonEvidence} from './native-json-carrier.mjs';
// Explicit, bounded, read-only review data. No script execution or review authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {digest,json,shape,need,id,hex,freeze,validIdentity} from './effect-contract.mjs';
export const NATIVE_TEXT_LIMITS=Object.freeze({count:32,file:1024*1024,total:4*1024*1024,manifest:64*1024,requirements:128});
const hash=b=>createHash('sha256').update(b).digest('hex');
const sameStat=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const types={'application/json':['.json'],'text/x-python':['.py'],'text/markdown':['.md'],'text/plain':['.txt'],'text/html':['.html'],'application/x-cm-lossless-json-evidence':['.json']};
const inside=(r,p)=>p===r||p.startsWith(r+path.sep);
function relative(p){
 need(typeof p==='string'&&p.length>0&&p.length<=1024&&p.normalize('NFC')===p&&!/[\\:\x00-\x1f\x7f-\x9f]/.test(p)
  &&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!s.startsWith('.')&&!['node_modules','agents.md','claude.md'].includes(s.toLowerCase())),'native_text_path');return p;
}
function directory(root,create=false){
 need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&!/[\\\x00-\x1f\x7f-\x9f]/.test(root),'native_text_path');
 let current=path.parse(root).root;
 for(const part of root.slice(current.length).split('/').filter(Boolean)){
  current=path.join(current,part);let st;
  try{st=fs.lstatSync(current);}catch(e){if(e.code!=='ENOENT'||!create)throw e;fs.mkdirSync(current,{mode:0o700});st=fs.lstatSync(current);}
  need(st.isDirectory()&&!st.isSymbolicLink(),'native_text_path');
 }
 need(fs.realpathSync(root)===root,'native_text_path');return root;
}
function stableBytes(root,p,privateFile=false,links=1n){
 directory(root);relative(p);directory(path.dirname(path.join(root,p)));
 const target=path.join(root,p),before=fs.lstatSync(target,{bigint:true});
 need(before.isFile()&&before.nlink===links&&before.size>0n&&before.size<=BigInt(NATIVE_TEXT_LIMITS.file),'native_text_file');
 if(privateFile)need((before.mode&0o777n)===0o600n,'native_text_permissions');
 const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  need(sameStat(before)===sameStat(fs.fstatSync(fd,{bigint:true})),'native_text_changed');
  const bytes=Buffer.alloc(Number(before.size)+1);let used=0;
  while(used<bytes.length){const n=fs.readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}
  need(used===Number(before.size)&&sameStat(before)===sameStat(fs.fstatSync(fd,{bigint:true}))
   &&sameStat(before)===sameStat(fs.lstatSync(target,{bigint:true})),'native_text_changed');
  const out=bytes.subarray(0,used),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(out);
  need(Buffer.from(text).equals(out)&&!text.includes('\0'),'native_text_encoding');return out;
 }finally{fs.closeSync(fd);}
}
const carrierType='application/x-cm-lossless-json-evidence';
const jsonType=f=>['application/json',carrierType].includes(f.mediaType);
function budgetBytes(bytes,file=null){
 if(file?.mediaType===carrierType)return validateLosslessJsonEvidence(bytes).originalSize;
 // Content-addressed archive entries retain bytes rather than an index. A
 // declared carrier identifies itself, so cumulative budgets count originals.
 if(file===null){let v;try{v=JSON.parse(bytes.toString('utf8'));}catch{return bytes.length;}
  if(v?.kind==='cm-lossless-json-evidence')return validateLosslessJsonEvidence(bytes).originalSize;}
 return bytes.length;
}
function row(raw,archived=false){
 shape(raw,['id','path','mediaType','sha256','size','description',...(archived?['contentBlob']:[])]);id(raw.id);relative(raw.path);hex(raw.sha256);
 need(Object.hasOwn(types,raw.mediaType)&&types[raw.mediaType].includes(path.extname(raw.path)),'native_text_type');
 need(Number.isSafeInteger(raw.size)&&raw.size>0&&raw.size<=NATIVE_TEXT_LIMITS.file,'native_text_limit');
 need(typeof raw.description==='string'&&raw.description.trim().length>0&&Buffer.byteLength(raw.description)<=512,'native_text_description');
 if(archived)need(raw.contentBlob===raw.sha256,'native_text_binding');return raw;
}
function pointer(document,p){
 need(typeof p==='string'&&p.length<=1024&&(p===''||p.startsWith('/'))&&!/~(?![01])/.test(p),'native_text_pointer');
 let value=document;if(p==='')return true;
 for(const segment of p.slice(1).split('/').map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))){
  if(value===null||typeof value!=='object'||!Object.hasOwn(value,segment))return false;
  if(Array.isArray(value)&&(!/^(0|[1-9][0-9]*)$/.test(segment)||!Number.isSafeInteger(Number(segment))||Number(segment)>=value.length))return false;
  value=value[segment];
 }return true;
}
function requirements(raw,files){
 need(Array.isArray(raw)&&raw.length>0&&raw.length<=NATIVE_TEXT_LIMITS.requirements,'native_text_requirements');const ids=new Set();
 for(const r of raw){shape(r,['id','fileId','pointers']);id(r.id);id(r.fileId);need(!ids.has(r.id),'native_text_requirements');ids.add(r.id);
  need(files.some(f=>f.id===r.fileId)&&Array.isArray(r.pointers)&&r.pointers.length<=32,'native_text_requirements');
  r.pointers.forEach(p=>pointer({},p));need(new Set(r.pointers).size===r.pointers.length,'native_text_requirements');
  need(r.pointers.length===0||jsonType(files.find(f=>f.id===r.fileId)),'native_text_requirements');
 }
}
// Collect all independently detectable declared-file/field problems. Metadata only.
function inspect(raw,context){
 const issues=[],files=[],data=new Map();let value,total=0;
 const check=(name,fileId,fn)=>{try{return fn();}catch{issues.push({code:name,fileId});return null;}};
 value=check('native_text_manifest',null,()=>{const v=json(raw,NATIVE_TEXT_LIMITS.manifest);shape(v,['version','sourceRoot','files','requirements']);
  need(v.version===1&&Array.isArray(v.files)&&v.files.length>0&&v.files.length<=NATIVE_TEXT_LIMITS.count,'native_text_manifest');return v;});
 if(!value)return {issues,files,data};
 const root=check('native_text_source',null,()=>{directory(value.sourceRoot);
  for(const p of [context.codeProject,context.specsDir]){directory(p);need(!inside(p,value.sourceRoot)&&!inside(value.sourceRoot,p),'native_text_source');}return value.sourceRoot;});
 const names=new Set(),ids=new Set();
 for(const [i,rawFile] of value.files.entries()){
  const label=String(i),f=check('native_text_file_metadata',label,()=>row(rawFile));if(!f)continue;
  check('native_text_duplicate',f.id,()=>{need(!ids.has(f.id)&&!names.has(f.path.toLowerCase()));ids.add(f.id);names.add(f.path.toLowerCase());return true;});
  files.push(f);total+=f.size;
  if(root){const bytes=check('native_text_file_missing_changed_or_invalid',f.id,()=>{
    const b=stableBytes(root,f.path);need(b.length===f.size&&hash(b)===f.sha256);if(jsonType(f))JSON.parse(b.toString('utf8'));budgetBytes(b,f);return b;});if(bytes){data.set(f.id,bytes);total+=budgetBytes(bytes,f)-f.size;}}
 }
 check('native_text_total_limit',null,()=>need(total<=NATIVE_TEXT_LIMITS.total));
 check('native_text_requirements',null,()=>requirements(value.requirements,files));
 if(Array.isArray(value.requirements))for(const r of value.requirements.slice(0,NATIVE_TEXT_LIMITS.requirements)){
  if(!r||!Array.isArray(r.pointers)||!data.has(r.fileId))continue;
  for(const p of r.pointers.slice(0,32))check('native_text_required_pointer_missing',r.id,()=>need(pointer(JSON.parse(data.get(r.fileId).toString('utf8')),p)));
 }
 return {value,files,data,total,issues};
}
export function inspectNativeTextEvidence(raw,context){
 const r=inspect(raw,context);return freeze({readOnly:true,integrityOnly:true,visualAcceptance:'unknown',ready:r.issues.length===0,
  issues:r.issues,totalBytes:r.total??0,files:r.files,manifestDigest:r.value?digest(r.value):null});
}
function inspected(raw,context){const r=inspect(raw,context);need(r.issues.length===0,'native_text_not_ready');return r;}
function archiveRoot(specsDir,identity){directory(specsDir);validIdentity(identity);
 return path.join(specsDir,'.reviews','.native-text-assets',identity.repositoryId,identity.runId,digest(identity));}
function binding(raw,identity=null){
 const m=json(raw,NATIVE_TEXT_LIMITS.manifest);shape(m,['version','identity','storeRoot','manifestDigest','files','requirements']);
 need(m.version===1,'native_text_binding');validIdentity(m.identity);hex(m.manifestDigest);
 if(identity)need(digest(m.identity)===digest(identity),'native_text_binding');
 const parts=m.storeRoot?.split('/'),at=parts?.lastIndexOf('.native-text-assets');
 need(at>1&&parts[at-1]==='.reviews'&&parts.length===at+4&&parts[at+1]===m.identity.repositoryId
  &&parts[at+2]===m.identity.runId&&parts[at+3]===digest(m.identity),'native_text_binding');
 need(Array.isArray(m.files)&&m.files.length>0&&m.files.length<=NATIVE_TEXT_LIMITS.count,'native_text_binding');
 const names=new Set(),ids=new Set();let total=0;
 for(const f of m.files){row(f,true);need(!ids.has(f.id)&&!names.has(f.path.toLowerCase()),'native_text_binding');ids.add(f.id);names.add(f.path.toLowerCase());total+=f.size;}
 need(total<=NATIVE_TEXT_LIMITS.total,'native_text_limit');requirements(m.requirements,m.files);return m;
}
function privateRoot(root,create=false){
 directory(root,create);let p=root;
 for(let n=0;n<4;n++,p=path.dirname(p))need((fs.lstatSync(p).mode&0o077)===0,'native_text_permissions');
}
function stored(m,f){privateRoot(m.storeRoot);const bytes=stableBytes(m.storeRoot,f.contentBlob,true);
 need(bytes.length===f.size&&hash(bytes)===f.sha256,'native_text_changed');if(jsonType(f))JSON.parse(bytes.toString('utf8'));budgetBytes(bytes,f);return bytes;}
export function validateNativeTextEvidence(raw,identity=null){
 const m=binding(raw,identity),data=new Map(m.files.map(f=>[f.id,stored(m,f)]));
 need(m.files.reduce((n,f)=>n+budgetBytes(data.get(f.id),f),0)<=NATIVE_TEXT_LIMITS.total,'native_text_limit');
 for(const r of m.requirements)for(const p of r.pointers)need(pointer(JSON.parse(data.get(r.fileId).toString('utf8')),p),'native_text_required_pointer_missing');return freeze(m);
}
// Only explicit owner capture may finish one exact interrupted publication.
function recoverStage(root,f,bytes){
 const prefix=`stage-${f.sha256}-`,names=fs.readdirSync(root).filter(n=>n.startsWith(prefix));
 need(names.length<=1,'native_text_publication_conflict');if(!names.length)return;
 const name=names[0];need(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name.slice(prefix.length)),'native_text_publication_conflict');
 const staged=path.join(root,name),target=path.join(root,f.sha256),st=fs.lstatSync(staged,{bigint:true});
 need([1n,2n].includes(st.nlink)&&stableBytes(root,name,true,st.nlink).equals(bytes),'native_text_publication_conflict');
 let current=null;try{current=fs.lstatSync(target,{bigint:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!current){need(st.nlink===1n,'native_text_publication_conflict');fs.linkSync(staged,target);current=fs.lstatSync(target,{bigint:true});}
 need(current.dev===st.dev&&current.ino===st.ino&&current.nlink===2n&&fs.lstatSync(staged,{bigint:true}).nlink===2n,'native_text_publication_conflict');
 need(stableBytes(root,f.sha256,true,2n).equals(bytes),'native_text_publication_conflict');fs.unlinkSync(staged);
 const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function textBinding(r,context){return {version:1,identity:context.identity,storeRoot:archiveRoot(context.specsDir,context.identity),manifestDigest:digest(r.value),files:r.files.map(f=>({...f,contentBlob:f.sha256})),requirements:r.value.requirements};}
export function projectNativeTextEvidence(raw,context){
 const r=inspected(raw,context),m=textBinding(r,context);
 return {binding:m,presentation:{manifestDigest:m.manifestDigest,identity:m.identity,requirements:m.requirements,files:r.files.map(f=>({...f,contentBase64:r.data.get(f.id).toString('base64')}))}};
}
export function captureNativeTextEvidence(raw,context){
 const r=inspected(raw,context),storeRoot=archiveRoot(context.specsDir,context.identity);privateRoot(storeRoot,true);
 const inventory=new Map(),pending=fs.readdirSync(storeRoot);need(pending.length<=160,'native_text_limit');
 for(const name of pending){
  const match=/^stage-([a-f0-9]{64})-[a-f0-9-]{36}$/.exec(name),sha=match?match[1]:name;hex(sha);
  if(match)need(r.files.some(f=>f.sha256===sha),'native_text_publication_conflict');
  const links=fs.lstatSync(path.join(storeRoot,name),{bigint:true}).nlink;need([1n,2n].includes(links),'native_text_publication_conflict');
  const bytes=stableBytes(storeRoot,name,true,links);need(hash(bytes)===sha,'native_text_changed');inventory.set(sha,budgetBytes(bytes));
 }
 for(const f of r.files)inventory.set(f.sha256,budgetBytes(r.data.get(f.id),f));
 need(inventory.size<=128&&[...inventory.values()].reduce((a,b)=>a+b,0)<=NATIVE_TEXT_LIMITS.total,'native_text_limit');
 for(const f of r.files)recoverStage(storeRoot,f,r.data.get(f.id));
 const names=fs.readdirSync(storeRoot);need(names.length<=128,'native_text_limit');let storedBytes=0;
 for(const name of names){hex(name);storedBytes+=budgetBytes(stableBytes(storeRoot,name,true));}
 const fresh=new Map(r.files.filter(f=>!names.includes(f.sha256)).map(f=>[f.sha256,budgetBytes(r.data.get(f.id),f)]));
 need(names.length+fresh.size<=128&&storedBytes+[...fresh.values()].reduce((a,b)=>a+b,0)<=NATIVE_TEXT_LIMITS.total,'native_text_limit');
 for(const f of r.files){
  const bytes=r.data.get(f.id),target=path.join(storeRoot,f.sha256);let present=false;
  try{fs.lstatSync(target);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!present){
   const temporary=path.join(storeRoot,`stage-${f.sha256}-${randomUUID()}`);let fd;
   try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temporary,target);fs.unlinkSync(temporary);
    const dir=fs.openSync(storeRoot,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
   }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  need(stableBytes(storeRoot,f.sha256,true).equals(bytes),'native_text_changed');
 }
 const after=inspected(raw,context);need(digest(after.value)===digest(r.value),'native_text_changed');
 const m=textBinding(r,context);
 return validateNativeTextEvidence(m,context.identity);
}
// Full text, not a local path or a summary. The adapter treats it only as data.
export function nativeTextEvidencePresentation(pkg){
 return [...pkg.checks,...(pkg.evidenceContinuation?[pkg.evidenceContinuation.newEvidence]:[])].filter(c=>c.kind==='native-evidence'&&c.material?.textEvidence).map(c=>{
  const m=validateNativeTextEvidence(c.material.textEvidence,pkg.identity);
  return {manifestDigest:m.manifestDigest,identity:m.identity,requirements:m.requirements,
   files:m.files.map(f=>{const {contentBlob,...metadata}=f;return {...metadata,contentBase64:stored(m,f).toString('base64')};})};
 });
}
// Unarchived read-only preview: only for input diagnostics, never a package/check.
export function previewNativeTextEvidence(raw,context){
 const r=inspected(raw,context);return {unarchivedPreview:true,manifestDigest:digest(r.value),requirements:r.value.requirements,
  files:r.files.map(f=>({...f,contentBase64:r.data.get(f.id).toString('base64')}))};
}
