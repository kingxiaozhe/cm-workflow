// Immutable file projection shared by review publishers, not an approval issuer.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {need} from './effect-contract.mjs';

export function writeReviewEvidence({reviewsDir,name,bytes,validate=()=>{},inspectOnly=false,exclusive=false}){
  need(typeof name==='string'&&/^[A-Za-z0-9._-]+\.md$/.test(name),'unsupported_path');
  return writeImmutableWorkflowFile({reviewsDir,name,bytes,validate,inspectOnly,exclusive});
}

// Shared no-overwrite publication for fixed workflow Markdown/JSON artifacts.
export function writeImmutableWorkflowFile({reviewsDir,name,bytes,validate=()=>{},inspectOnly=false,exclusive=false}){
  need(path.isAbsolute(reviewsDir)&&fs.realpathSync(reviewsDir)===reviewsDir
    &&fs.lstatSync(reviewsDir).isDirectory(),'unsupported_path');
  need(typeof name==='string'&&/^[A-Za-z0-9._-]+\.(md|json)$/.test(name)&&Buffer.isBuffer(bytes),'unsupported_path');
  need(bytes.length<=256*1024,'limit_exceeded');
  const target=path.join(reviewsDir,name);
  const verify=()=>{
    const stat=fs.lstatSync(target);
    need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===bytes.length,'review_file_conflict');
    need(fs.readFileSync(target).equals(bytes),'review_file_conflict');validate(target);
  };
  if(inspectOnly){verify();return {outcome:'published',path:target};}
  const temp=path.join(reviewsDir,`.cm-review-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;validate(temp);
    try{fs.linkSync(temp,target);}catch(error){if(error.code!=='EEXIST')throw error;need(!exclusive,'review_file_conflict');verify();}
    fs.unlinkSync(temp);
    const dir=fs.openSync(reviewsDir,fs.constants.O_RDONLY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    return {outcome:'published',path:target};
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

// Move a workflow file aside without ever deleting its bytes: link into
// .superseded/ under a content-hash stamp, then unlink the original, so a crash
// between the two steps leaves both copies rather than neither. Callers decide
// *whether* a file may be superseded — this only knows how.
export function supersedeWorkflowFile(dir,name,existing){
  const source=path.join(dir,name),archive=path.join(dir,'.superseded');
  existing??=fs.readFileSync(source);
  fs.mkdirSync(archive,{recursive:true,mode:0o700});
  const stamp=createHash('sha256').update(existing).digest('hex').slice(0,16);
  const target=path.join(archive,`${name}.${stamp}`);
  try{fs.linkSync(source,target);}catch(error){if(error.code!=='EEXIST')throw error;}
  fs.unlinkSync(source);
  const fd=fs.openSync(archive,fs.constants.O_RDONLY);
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return target;
}
