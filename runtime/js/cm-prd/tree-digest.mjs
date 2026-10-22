// Asset inventory needs exact byte hashes, not decoded document contents.
// Keep memory bounded; document readers retain their separate size limits.
// Like readCmInitSource, the path is walked from the specs root: no segment
// may be a link, every parent must be a directory, the file a single-link file.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need} from '../cm-ai/effect-contract.mjs';
const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs','nlink'].every(key=>a[key]===b[key]);
function walk(root,relative){
  need(typeof relative==='string'&&relative.split('/').every(part=>part&&part!=='.'&&part!=='..')
    &&!relative.includes('\\')&&!relative.includes('\0'),'prd_change_asset_invalid');
  const segments=relative.split('/');let current=root,stat;
  for(let i=0;i<segments.length;i++){
    current=path.join(current,segments[i]);stat=fs.lstatSync(current);
    need(!stat.isSymbolicLink(),'prd_change_asset_invalid');
    if(i<segments.length-1)need(stat.isDirectory(),'prd_change_asset_invalid');
  }
  need(stat.isFile()&&stat.nlink===1,'prd_change_asset_invalid');
  return {file:current,stat};
}
export function prdTreeFileDigest(root,relative){
  const {file,stat:before}=walk(root,relative);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
  try{
    need(same(before,fs.fstatSync(fd)),'prd_change_inputs_changed');
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let bytes=0,count;
    while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){hash.update(buffer.subarray(0,count));bytes+=count;}
    // The same path, walked again, must still name the file that was read.
    need(bytes===before.size&&same(before,fs.fstatSync(fd))&&same(before,walk(root,relative).stat),
      'prd_change_inputs_changed');
    return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}
