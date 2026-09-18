// Shared specs approval storage. Reading legacy data never upgrades its authority.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const fields=['status','summaryDigest','at','features','specFiles','testCases','approval'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hex=value=>typeof value==='string'&&/^[a-fA-F0-9]{64}$/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const need=condition=>{if(!condition)throw new Error('spec_status_invalid');};

export function readSpecsStatus(specsDir){
  const target=path.join(specsDir,'.cm-specs-status');
  try{
    // lstat distinguishes a missing file from a dangling, invalid symlink.
    fs.lstatSync(target);
  }catch(error){return {kind:error.code==='ENOENT'?'missing':'invalid'};}
  try{
    const root=fs.realpathSync(specsDir),real=fs.realpathSync(target),relative=path.relative(root,real);
    need(relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative));
    const source=JSON.parse(fs.readFileSync(real,'utf8'));
    need(record(source)&&['approved','awaiting_review'].includes(source.status));
    // Keep optional fields absent: admission distinguishes legacy omissions.
    const value=Object.fromEntries(fields.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]));
    if(record(value.approval))value.approval=Object.fromEntries(['response','at']
      .filter(key=>Object.hasOwn(value.approval,key)).map(key=>[key,value.approval[key]]));
    return {kind:'valid',value};
  }catch{return {kind:'invalid'};}
}

export function writeSpecsStatus(specsDir,value,{beforeRename=()=>{}}={}){
  need(record(value)&&['approved','awaiting_review'].includes(value.status));
  const summaryDigest=value.summaryDigest===undefined?null:value.summaryDigest;
  need(summaryDigest===null||hex(summaryDigest));
  need(iso(value.at)&&Array.isArray(value.features)&&value.features.length>0
    &&value.features.every(name=>typeof name==='string'&&/^\d+\.[^/\\]+$/.test(name))
    &&new Set(value.features).size===value.features.length);
  const manifest=rows=>{
    need(Array.isArray(rows));const seen=new Set();
    return rows.map(item=>{
      need(record(item)&&typeof item.path==='string'&&item.path!==''&&!path.isAbsolute(item.path)
        &&!item.path.includes('\\')&&!item.path.split('/').some(part=>['','..','.'].includes(part))
        &&!seen.has(item.path)&&hex(item.sha256));
      seen.add(item.path);return {path:item.path,sha256:item.sha256};
    });
  };
  const approval=value.approval??null;
  need(approval===null||(value.status==='approved'&&record(approval)
    &&typeof approval.response==='string'&&approval.response.trim()!==''&&iso(approval.at)));
  const canonical={status:value.status,summaryDigest,at:value.at,features:[...value.features],
    specFiles:manifest(value.specFiles),testCases:manifest(value.testCases),
    approval:approval===null?null:{response:approval.response,at:approval.at}};
  const bytes=Buffer.from(JSON.stringify(canonical)+'\n'),target=path.join(specsDir,'.cm-specs-status');
  const temporary=path.join(specsDir,`.cm-specs-status-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    beforeRename();
    fs.renameSync(temporary,target);
    const dir=fs.openSync(specsDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    need(fs.readFileSync(target).equals(bytes));
    return canonical;
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
