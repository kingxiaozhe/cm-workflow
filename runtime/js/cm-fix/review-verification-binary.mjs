// Exact package-bound binary versions. Bytes stay in private copies, never prompts.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,need,shape} from '../cm-ai/effect-contract.mjs';
import {verificationPath} from './review-verification-path.mjs';
export const BINARY_FILE_LIMIT=128*1024*1024,BINARY_TOTAL_LIMIT=256*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const statKey=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeNs,s.ctimeNs].join(':');
export function binaryVerificationVersions(configuration,pkg){
 const allowed=configuration.binaryAssets?.paths??[],binding=pkg.binaryAssets;
 if(!binding){need(allowed.length===0,'review_verification_package_binding');return [];}
 shape(binding,['version','paths','storeRoot']);
 need(binding.version===1&&Array.isArray(binding.paths)&&new Set(binding.paths).size===binding.paths.length
  &&binding.paths.every(p=>{verificationPath(p);return true;})&&allowed.every(p=>binding.paths.includes(p)),'review_verification_package_binding');
 const versions=new Map();
 const add=(row,version,p=row?.path)=>{
  if(!row||!Object.hasOwn(row,'contentBlob'))return;
  need(allowed.includes(p)&&binding.paths.includes(p),'review_verification_package_binding');verificationPath(p);
  shape(row,['path','type','mode','size','sha256','contentBlob']);
  need(row.type==='file'&&HASH.test(row.sha256)&&row.contentBlob===row.sha256&&Number.isSafeInteger(row.size)
   &&row.size>=0&&row.size<=BINARY_FILE_LIMIT&&Number.isInteger(row.mode)&&row.mode>=0&&row.mode<=511,'review_verification_package_binding');
  const record={path:p,version,sha256:row.sha256,mode:row.mode,size:row.size,contentBlob:row.contentBlob},key=p+'\0'+version;
  need(!versions.has(key)||digest(versions.get(key))===digest(record),'review_verification_package_binding');versions.set(key,record);
 };
 for(const change of pkg.changes??[]){add(change.before,'before',change.path);add(change.after,'after',change.path);}
 for(const row of [...(pkg.files??[]),...(pkg.contextFiles??[]),...(pkg.unchangedScope??[]),...(pkg.requirements??[]),...(pkg.instructions??[])])add(row,'after');
 const compare=(a,b)=>a<b?-1:a>b?1:0;
 const result=[...versions.values()].sort((a,b)=>compare(a.path,b.path)||compare(a.version,b.version));
 need(allowed.every(p=>result.some(r=>r.path===p))&&result.reduce((sum,r)=>sum+r.size,0)<=BINARY_TOTAL_LIMIT,'review_verification_package_binding');
 return result;
}
export function safeBinaryRoot(root){
 need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root,'review_verification_path');
 let current=path.parse(root).root;
 for(const part of root.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const s=fs.lstatSync(current);need(s.isDirectory()&&!s.isSymbolicLink(),'review_verification_path');
 }
 need(fs.realpathSync(root)===root,'review_verification_path');return root;
}
// lstat/open/fstat/final-lstat bind the complete hash and optional range/copy to
// one inode; O_NOFOLLOW and nlink=1 reject alternate source identities.
export function readVerificationBinary(root,relative,{expected=null,offset=0,length=0,copyTo=null}={}){
 safeBinaryRoot(root);verificationPath(relative);let target=root;
 const parents=[{path:root,key:statKey(fs.lstatSync(root,{bigint:true}))}];
 const parts=relative.split('/');
 for(const [i,part] of parts.entries()){
  target=path.join(target,part);const st=fs.lstatSync(target,{bigint:true});need(!st.isSymbolicLink(),'review_verification_path');
  if(i<parts.length-1){need(st.isDirectory(),'review_verification_path');parents.push({path:target,key:statKey(st)});}
 }
 const before=fs.lstatSync(target,{bigint:true});
 need(before.isFile()&&before.nlink===1n&&before.size<=BigInt(BINARY_FILE_LIMIT),'review_verification_path');
 const size=Number(before.size);
 need(Number.isSafeInteger(offset)&&offset>=0&&offset<=size&&Number.isSafeInteger(length)&&length>=0&&length<=16384,'review_verification_offset');
 let fd,out;const chunks=[],hash=createHash('sha256');let read=0;
 try{
  fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  need(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true})),'review_verification_source_drift');
  if(copyTo!==null)out=fs.openSync(copyTo,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  const buf=Buffer.alloc(65536);
  for(;;){const count=fs.readSync(fd,buf,0,buf.length,null);if(!count)break;const bytes=buf.subarray(0,count);hash.update(bytes);
   if(out!==undefined)fs.writeFileSync(out,bytes);
   const start=Math.max(0,offset-read),end=Math.min(count,offset+length-read);if(end>start)chunks.push(Buffer.from(bytes.subarray(start,end)));
   read+=count;need(read<=BINARY_FILE_LIMIT,'review_verification_limit');
  }
  need(statKey(before)===statKey(fs.fstatSync(fd,{bigint:true}))&&statKey(before)===statKey(fs.lstatSync(target,{bigint:true}))&&read===size,'review_verification_source_drift');
  for(const parent of parents){const st=fs.lstatSync(parent.path,{bigint:true});need(st.isDirectory()&&!st.isSymbolicLink()
   &&statKey(st)===parent.key,'review_verification_source_drift');}
  const record={sha256:hash.digest('hex'),mode:Number(before.mode&511n),size};
  if(expected)need(record.sha256===expected.sha256&&record.size===expected.size&&(expected.mode===undefined||record.mode===expected.mode),'review_verification_package_binding');
  if(out!==undefined)fs.fsyncSync(out);
  return {...record,contentBase64:Buffer.concat(chunks).toString('base64')};
 }finally{if(fd!==undefined)fs.closeSync(fd);if(out!==undefined)fs.closeSync(out);}
}
