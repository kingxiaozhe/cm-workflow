// Link material binds the directory entry itself. It never opens the referent.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need,shape,hex} from './effect-contract.mjs';

export const SYMLINK_BASELINE_VERSION=3;
export const reviewPackageVersion=baseline=>baseline.version===SYMLINK_BASELINE_VERSION?2:1;
const utf8=new TextDecoder('utf8',{fatal:true,ignoreBOM:true});
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const validTargetText=target=>typeof target==='string'&&target.length>0&&!target.includes('\0')
  &&utf8.decode(Buffer.from(target))===target;

export function symlinkRecord(file,target){
  need(validTargetText(target),'unsupported_file');
  return {path:file,type:'symlink',target,size:Buffer.byteLength(target),
    sha256:createHash('sha256').update('symlink\0').update(target).digest('hex')};
}

export function readSymlinkRecord(root,file){
  const absolute=path.join(root,file);
  const stat=()=>fs.lstatSync(absolute,{bigint:true});
  const key=s=>[s.dev,s.ino,s.mode,s.size,s.ctimeNs,s.mtimeNs].join(':');
  const before=stat();
  need(before.isSymbolicLink(),'snapshot_changed');
  const bytes=fs.readlinkSync(absolute,{encoding:'buffer'});
  need(key(before)===key(stat())&&BigInt(bytes.length)===before.size,'snapshot_changed');
  let target;
  try{target=utf8.decode(bytes);}catch{need(false,'unsupported_file');}
  return symlinkRecord(file,target);
}

export function validateSymlinkRecord(file){
  shape(file,['path','type','target','size','sha256']);
  const expected=symlinkRecord(file.path,file.target);
  need(file.type===expected.type&&file.size===expected.size&&file.sha256===expected.sha256);
}

export function lstatOrMissing(file){
  try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

// Root-to-leaf checks also see dangling links and stop before probing their children.
export function assertRealParents(root,file,stat=relative=>lstatOrMissing(path.join(root,relative))){
  const parts=file.split('/');
  need(parts.every(part=>part&&part!=='.'&&part!=='..'&&!/[\\\0]/.test(part)),'unsupported_path');
  let cursor='';
  for(const part of parts.slice(0,-1)){
    cursor=cursor?cursor+'/'+part:part;
    const info=stat(cursor);
    if(info===null)return;
    need(info.isDirectory(),'unsupported_path');
  }
}

const projectedFile=Object.freeze({isFile:()=>true,isDirectory:()=>false});
const projectedDirectory=Object.freeze({isFile:()=>false,isDirectory:()=>true});
const projectedLink=Object.freeze({isFile:()=>false,isDirectory:()=>false});

// Overlay known file states on the disk. A write also creates missing parents.
export function projectedPathStat(root,paths){
  const parents=new Set();
  for(const [file,type] of paths){
    if(type===null)continue;
    const parts=file.split('/');
    while(parts.length>1){parts.pop();parents.add(parts.join('/'));}
  }
  return file=>{
    if(paths.has(file)){
      const type=paths.get(file);
      return type===null?null:type==='symlink'?projectedLink:projectedFile;
    }
    return lstatOrMissing(path.join(root,file))??(parents.has(file)?projectedDirectory:null);
  };
}

// Two proposed file entries cannot also make one of them the other's parent.
export function assertDisjointEditPaths(files){
  const names=new Set(files.map(file=>file.toLowerCase()));
  for(const file of names){
    const parts=file.split('/');
    while(parts.length>1){
      parts.pop();
      need(!names.has(parts.join('/')),'unsupported_path');
    }
  }
}

export function validateSymlinkTargetText(target){
  need(validTargetText(target)&&Buffer.byteLength(target)<=1024&&!target.includes('\\')
    &&!path.posix.isAbsolute(target)&&!path.win32.isAbsolute(target)&&!/^[a-z]:/i.test(target),'invalid_symlink_target');
}

// Resolve POSIX link text one component at a time. Checking components before
// applying ".." prevents normalization from hiding a link or protected directory.
export function resolveSymlinkTarget(root,file,target,{specsRoot=null,stat=null}={}){
  const validateTarget=stat!==null;
  if(validateTarget)validateSymlinkTargetText(target);
  else need(validTargetText(target)&&!path.posix.isAbsolute(target)&&!path.win32.isAbsolute(target)
    &&!/^[a-z]:/i.test(target),'symlink_outside_root');
  const parts=file.split('/').slice(0,-1);
  const protectedSpecs=specsRoot?.toLowerCase();
  const checkLocation=relative=>{
    const absolute=path.join(root,relative);
    need(!parts.some(name=>['.git','.reviews'].includes(name.toLowerCase()))
      &&!(protectedSpecs&&inside(protectedSpecs,absolute.toLowerCase()))
      &&relative.toLowerCase()!==file.toLowerCase(),'invalid_symlink_target');
  };
  const segments=target.split('/');
  for(const [index,part] of segments.entries()){
    if(part==='..'){
      need(parts.length>0,validateTarget?'invalid_symlink_target':'symlink_outside_root');
      parts.pop();
    }else if(part&&part!=='.'){
      parts.push(part);
      if(validateTarget){
        const relative=parts.join('/');
        checkLocation(relative);
        const info=stat(relative);
        need(info&&(info.isDirectory()||info.isFile()),'invalid_symlink_target');
        if(!info.isDirectory())need(index===segments.length-1,'invalid_symlink_target');
      }
    }
  }
  const relative=parts.join('/');
  if(validateTarget){
    checkLocation(relative);
    const info=relative===''?fs.lstatSync(root):stat(relative);
    need(info&&(info.isDirectory()||info.isFile()),'invalid_symlink_target');
  }
  return path.join(root,relative);
}


export function validateProtectedEdit(edit,allowSymlinks=false){
  if(Object.hasOwn(edit,'symlink')){
    need(allowSymlinks,'protected_edit_invalid');
    shape(edit,['path','beforeSha256','symlink']);
    validateSymlinkTargetText(edit.symlink);
  }else{
    shape(edit,['path','beforeSha256','content',...(Object.hasOwn(edit,'mode')?['mode']:[])]);
    need(!Object.hasOwn(edit,'mode')||edit.content!==null&&['0644','0755'].includes(edit.mode),'protected_edit_invalid');
    need(edit.content===null||typeof edit.content==='string','protected_edit_invalid');
    need(edit.content===null||Buffer.byteLength(edit.content)<=1024*1024,'limit_exceeded');
    need(edit.content!==null||edit.beforeSha256!==null,'protected_edit_invalid');
  }
  if(edit.beforeSha256!==null)hex(edit.beforeSha256);
}

export function protectedEditDigest(edit){
  if(Object.hasOwn(edit,'symlink'))return symlinkRecord(edit.path,edit.symlink).sha256;
  return edit.content===null?null:createHash('sha256').update(edit.content).digest('hex');
}
