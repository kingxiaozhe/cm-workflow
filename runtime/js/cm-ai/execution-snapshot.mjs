// Read-only evidence discovery. The writer must still independently reopen with
// reconstructed expected fingerprints and acquire its normal ownership lock.
import fs from 'node:fs';
import path from 'node:path';
import {digest,need,shape,id,hex,json} from './effect-contract.mjs';
export function readExecutionSnapshot({specsRoot,identity}){
  shape(identity,['repositoryId','runId']);Object.values(identity).forEach(id);
  need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot,'unsupported_path');
  let dir=specsRoot;
  for(const [index,part] of ['.reviews','.execution',identity.runId].entries()){
    dir=path.join(dir,part);const stat=fs.lstatSync(dir);
    need(stat.isDirectory()&&!stat.isSymbolicLink()&&(index===0||(stat.mode&0o077)===0),'unsupported_path');
  }
  const file=path.join(dir,'state.json'),before=fs.lstatSync(file);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o077)===0
    &&before.size<=16*1024*1024,'unsupported_file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let bytes;
  try{
    bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd),current=fs.lstatSync(file);
    need([after,current].every(s=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>s[k]===before[k]))
      &&bytes.length===before.size,'snapshot_changed');
  }finally{fs.closeSync(fd);}
  const raw=JSON.parse(bytes.toString('utf8')),v=json(raw,16*1024*1024);
  need(Buffer.from(JSON.stringify(raw)+'\n').equals(bytes),'store_corrupt');
  shape(v,['version','identity','fingerprints','records','revision']);
  need(v.version===1&&digest(v.identity)===digest(identity),'identity_mismatch');
  shape(v.fingerprints,['workflow','config','inputs']);Object.values(v.fingerprints).forEach(hex);
  need(Array.isArray(v.records)&&v.records.length<=1024,'limit_exceeded');
  let previous=null;const ids=new Set();
  for(const [index,r] of v.records.entries()){
    shape(r,['version','seq','id','kind','payload','previousDigest','digest']);id(r.id);hex(r.digest);
    json(r.payload,1024*1024);
    const {digest:checksum,...body}=r;
    need(r.version===1&&r.seq===index+1&&r.previousDigest===previous&&!ids.has(r.id)
      &&['intent','result','cancel','commit-intent','commit-result','finalized'].includes(r.kind)
      &&digest(body)===checksum,'store_corrupt');previous=checksum;ids.add(r.id);
  }
  const {revision,...body}=v;need(digest(body)===revision,'store_corrupt');return v;
}
