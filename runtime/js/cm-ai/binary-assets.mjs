// Explicit owner-bound binary assets. Bytes never enter the text journal budget.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {json,shape,need,hex,id,freeze} from './effect-contract.mjs';

export const BINARY_ASSET_LIMITS=Object.freeze({file:128*1024*1024,total:256*1024*1024,count:32});
const extensions=new Set(['.ttf','.otf','.woff','.woff2','.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.heic','.mp3','.m4a','.wav','.ogg','.mp4','.mov','.webm']);
const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
const statKey=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
export function binaryAssetPath(p){
  need(typeof p==='string'&&p.length>0&&p.length<=1024&&p.normalize('NFC')===p
    &&!/[\\:\x00-\x1f\x7f-\x9f]/.test(p),'binary_asset_path');
  const parts=p.split('/');need(parts.every(part=>part&&part!=='.'&&part!=='..'&&!part.startsWith('.')
    &&!['node_modules','agents.md','claude.md'].includes(part.toLowerCase()))&&extensions.has(path.extname(p).toLowerCase()),'binary_asset_path');return p;
}
function canonicalDirectory(root,create=false){
  need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&!root.includes('\0'),'binary_asset_path');
  let current=path.parse(root).root;
  for(const part of root.slice(current.length).split('/').filter(Boolean)){
    current=path.join(current,part);
    try{const s=fs.lstatSync(current);need(s.isDirectory()&&!s.isSymbolicLink(),'binary_asset_path');}
    catch(error){if(error.code!=='ENOENT'||!create)throw error;fs.mkdirSync(current,{mode:0o700});}
  }
  need(fs.realpathSync(root)===root,'binary_asset_path');return root;
}
export function binaryAssetStoreRoot({specsDir,identity}){
  canonicalDirectory(specsDir);id(identity.repositoryId);id(identity.runId);
  return path.join(specsDir,'.reviews','.binary-assets',identity.repositoryId,identity.runId);
}
export function readBinaryAssetBinding(raw,identity=null){
  const v=json(raw,64*1024);shape(v,['version','paths','storeRoot']);need(v.version===1,'binary_asset_configuration');
  need(Array.isArray(v.paths)&&v.paths.length>0&&v.paths.length<=BINARY_ASSET_LIMITS.count,'binary_asset_configuration');
  v.paths.forEach(binaryAssetPath);need(new Set(v.paths.map(p=>p.toLowerCase())).size===v.paths.length,'binary_asset_configuration');
  need(typeof v.storeRoot==='string'&&path.isAbsolute(v.storeRoot)&&path.resolve(v.storeRoot)===v.storeRoot
    &&!/[\x00-\x1f]/.test(v.storeRoot),'binary_asset_path');
  const segments=v.storeRoot.split('/'),index=segments.lastIndexOf('.binary-assets');
  need(index>1&&segments[index-1]==='.reviews'&&segments.length===index+3,'binary_asset_path');
  id(segments[index+1]);id(segments[index+2]);
  if(identity!==null)need(segments[index+1]===identity.repositoryId&&segments[index+2]===identity.runId,'binary_asset_binding');
  return freeze(v);
}
export function readBinaryAssetConfiguration(raw,{scope,requirements=[],codeProject,specsDir,identity}){
  const v=json(raw,64*1024);shape(v,['version','paths','sourceRoot']);
  canonicalDirectory(codeProject);canonicalDirectory(specsDir);canonicalDirectory(v.sourceRoot);
  need(!inside(codeProject,v.sourceRoot)&&!inside(specsDir,v.sourceRoot)
    &&!inside(v.sourceRoot,codeProject)&&!inside(v.sourceRoot,specsDir),'binary_asset_source');
  const binding=readBinaryAssetBinding({version:v.version,paths:v.paths,storeRoot:binaryAssetStoreRoot({specsDir,identity})});
  need(binding.paths.every(p=>scope.includes(p)&&!requirements.includes(p)),'binary_asset_configuration');
  return freeze({...binding,sourceRoot:v.sourceRoot});
}
function readBytes(root,relative,limit=BINARY_ASSET_LIMITS.file,links=1n){
  canonicalDirectory(root);need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')
    &&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),'binary_asset_path');
  let current=root;for(const part of relative.split('/').slice(0,-1)){current=path.join(current,part);canonicalDirectory(current);}
  const target=path.join(root,relative),before=fs.lstatSync(target,{bigint:true});
  need(before.isFile()&&before.nlink===links&&before.size<=BigInt(limit),'binary_asset_file');
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let data;
  try{need(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true})),'binary_asset_changed');
    const bounded=Buffer.alloc(Number(before.size)+1);let offset=0;
    while(offset<bounded.length){const count=fs.readSync(fd,bounded,offset,bounded.length-offset,null);if(count===0)break;offset+=count;}
    data=bounded.subarray(0,offset);
    need(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true}))&&statKey(before)===statKey(fs.lstatSync(target,{bigint:true}))
      &&data.length===Number(before.size),'binary_asset_changed');
  }finally{fs.closeSync(fd);}
  return {data,mode:Number(before.mode&0o7777n),sha256:createHash('sha256').update(data).digest('hex'),size:data.length};
}
function storeDirectory(binding,create=false){
  const b=readBinaryAssetBinding(binding);canonicalDirectory(b.storeRoot,create);
  const assetRoot=path.dirname(path.dirname(b.storeRoot));
  for(const dir of [assetRoot,path.dirname(b.storeRoot),b.storeRoot])
    need((fs.lstatSync(dir).mode&0o077)===0,'binary_asset_permissions');return b.storeRoot;
}
// A readonly snapshot never repairs. Only explicit owner publication finishes
// one unambiguous, byte-exact staging link from this run and desired SHA.
function recoverPublication(root,hash,data){
  const parent=path.dirname(root),runId=path.basename(root),prefix=`.binary-${runId}-${hash}-`;
  const names=fs.readdirSync(parent).filter(name=>name.startsWith(prefix));
  need(names.length<=1,'binary_asset_publish_conflict');if(names.length===0)return;
  const name=names[0];need(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name.slice(prefix.length)),'binary_asset_publish_conflict');
  const staged=path.join(parent,name),stageStat=fs.lstatSync(staged,{bigint:true});
  need(stageStat.isFile()&&[1n,2n].includes(stageStat.nlink)&&(stageStat.mode&0o777n)===0o600n,'binary_asset_publish_conflict');
  const row=readBytes(parent,name,BINARY_ASSET_LIMITS.file,stageStat.nlink);
  need(row.sha256===hash&&row.data.equals(data),'binary_asset_publish_conflict');
  const target=path.join(root,hash);let current=null;
  try{current=fs.lstatSync(target,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  let total=0;const stored=fs.readdirSync(root);need(stored.length<=128,'binary_asset_limit');
  for(const entry of stored){need(/^[a-f0-9]{64}$/.test(entry),'binary_asset_store');
    const links=entry===hash&&stageStat.nlink===2n?2n:1n,existing=readBytes(root,entry,BINARY_ASSET_LIMITS.file,links);
    need(existing.sha256===entry&&(existing.mode&0o777)===0o600,'binary_asset_store');total+=existing.size;}
  need(total+(current===null?data.length:0)<=BINARY_ASSET_LIMITS.total,'binary_asset_limit');
  if(current===null){need(stageStat.nlink===1n&&stored.length<128,'binary_asset_publish_conflict');fs.linkSync(staged,target);}
  else need(current.isFile()&&current.dev===stageStat.dev&&current.ino===stageStat.ino
    &&current.nlink===2n&&stageStat.nlink===2n,'binary_asset_publish_conflict');
  const finalStage=fs.lstatSync(staged,{bigint:true}),finalTarget=fs.lstatSync(target,{bigint:true});
  need(finalStage.dev===stageStat.dev&&finalStage.ino===stageStat.ino&&finalTarget.dev===stageStat.dev
    &&finalTarget.ino===stageStat.ino&&finalStage.nlink===2n&&finalTarget.nlink===2n,'binary_asset_publish_conflict');
  fs.unlinkSync(staged);for(const directory of [root,parent]){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
}
function storeBytes(binding,data){
  const root=storeDirectory(binding,true),hash=createHash('sha256').update(data).digest('hex');let total=0;
  recoverPublication(root,hash,data);
  const names=fs.readdirSync(root);need(names.length<=128,'binary_asset_limit');
  for(const name of names){
    need(/^[a-f0-9]{64}$/.test(name),'binary_asset_store');const row=readBytes(root,name);
    need(row.sha256===name&&(fs.lstatSync(path.join(root,name)).mode&0o777)===0o600,'binary_asset_store');total+=row.size;
  }
  need(total<=BINARY_ASSET_LIMITS.total,'binary_asset_limit');
  const target=path.join(root,hash);
  try{fs.lstatSync(target);const existing=readBytes(root,hash);need(existing.sha256===hash&&existing.data.equals(data),'binary_asset_store');return hash;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  need(names.length<128&&total+data.length<=BINARY_ASSET_LIMITS.total,'binary_asset_limit');
  const temp=path.join(path.dirname(root),`.binary-${path.basename(root)}-${hash}-${randomUUID()}`);let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.linkSync(temp,target);fs.unlinkSync(temp);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return hash;
}
// Read-only diagnostics validate the same stable bytes without publishing a blob.
export function inspectBinaryAssetSource({sourceRoot,sourcePath}){
  binaryAssetPath(sourcePath);
  const {sha256,size,mode}=readBytes(sourceRoot,sourcePath);
  return freeze({sha256,size,mode});
}
export function validateBinaryAssetSource({sourceRoot,sourcePath,sha256,size}){
  binaryAssetPath(sourcePath);hex(sha256);need(Number.isSafeInteger(size)&&size>=0&&size<=BINARY_ASSET_LIMITS.file,'binary_asset_limit');
  const row=readBytes(sourceRoot,sourcePath);need(row.sha256===sha256&&row.size===size,'binary_asset_changed');return row.data;
}
export function importBinaryAsset({binding,sourceRoot,sourcePath,sha256,size}){
  const data=validateBinaryAssetSource({sourceRoot,sourcePath,sha256,size});
  return freeze({sha256,size,contentBlob:storeBytes(binding,data)});
}
export function captureBinaryAsset({root,path:p,binding}){
  const b=readBinaryAssetBinding(binding);need(b.paths.includes(binaryAssetPath(p)),'binary_asset_path');
  const row=readBytes(root,p),contentBlob=storeBytes(b,row.data);
  return freeze({path:p,type:'file',mode:row.mode,size:row.size,sha256:row.sha256,contentBlob});
}
export function readBinaryAssetBytes({binding,record}){
  const b=readBinaryAssetBinding(binding);shape(record,['path','type','mode','size','sha256','contentBlob']);
  need(b.paths.includes(binaryAssetPath(record.path))&&record.type==='file'&&Number.isInteger(record.mode)
    &&record.mode>=0&&record.mode<=0o7777,'binary_asset_record');hex(record.sha256);
  need(record.contentBlob===record.sha256&&Number.isSafeInteger(record.size)&&record.size>=0
    &&record.size<=BINARY_ASSET_LIMITS.file,'binary_asset_record');
  const root=storeDirectory(b),row=readBytes(root,record.contentBlob);
  need((fs.lstatSync(path.join(root,record.contentBlob)).mode&0o777)===0o600,'binary_asset_permissions');
  need(row.sha256===record.sha256&&row.size===record.size,'binary_asset_changed');return row.data;
}
export function binaryAssetRecord(record,binding){readBinaryAssetBytes({binding,record});return record;}
