// Asset inventory needs exact byte hashes, not decoded document contents.
// Keep memory bounded; document readers retain their separate size limits.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {need} from '../cm-ai/effect-contract.mjs';
const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs','nlink'].every(key=>a[key]===b[key]);
export function prdTreeFileDigest(file){
  const before=fs.lstatSync(file);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1,'prd_change_asset_invalid');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    need(same(before,fs.fstatSync(fd)),'prd_change_inputs_changed');
    const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let bytes=0,count;
    while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0){hash.update(buffer.subarray(0,count));bytes+=count;}
    need(bytes===before.size&&same(before,fs.fstatSync(fd))&&same(before,fs.lstatSync(file)),
      'prd_change_inputs_changed');
    return hash.digest('hex');
  }finally{fs.closeSync(fd);}
}
