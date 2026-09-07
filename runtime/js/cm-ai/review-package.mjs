// S2a offline content binding only. No reviewer authentication or task writes.
// Trusted fixture hosts only: callers own authorization and a quiescent root.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from './contracts.mjs';

const FILE_LIMIT=1024*1024, SNAPSHOT_LIMIT=2*1024*1024, FILE_COUNT=256;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error=new Error(code); error.code=code; throw error; };
const need = (condition,code='invalid_input') => { if(!condition) fail(code); };
const record = v => v!==null && typeof v==='object' && !Array.isArray(v);
const keys = (v,expected) => need(record(v) && Object.keys(v).sort().join('|')===[...expected].sort().join('|'));
const id = v => need(typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v));

// Inspect descriptors before reading values; never execute input accessors.
function plain(value, ancestors=new Set(), depth=0) {
  need(depth<=40);
  if(value===null || ['string','boolean'].includes(typeof value)) return value;
  if(typeof value==='number') { need(Number.isFinite(value)); return value; }
  need(typeof value==='object' && !ancestors.has(value));
  need((Array.isArray(value) ? [Array.prototype] : [Object.prototype,null]).includes(Object.getPrototypeOf(value)));
  need(Object.getOwnPropertySymbols(value).length===0);
  const descriptors=Object.getOwnPropertyDescriptors(value), array=Array.isArray(value);
  const names=Object.keys(descriptors).filter(k=>!array || k!=='length');
  if(array) need(names.length===value.length && names.every((k,i)=>k===String(i)));
  ancestors.add(value);
  const pairs=names.map(k=>{
    const d=descriptors[k]; need(Object.hasOwn(d,'value') && d.enumerable);
    return [k,plain(d.value,ancestors,depth+1)];
  });
  ancestors.delete(value);
  return array ? pairs.map(([,v])=>v) : Object.fromEntries(pairs);
}
function freeze(value) {
  if(value && typeof value==='object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function identityCheck(v) {
  keys(v,['repositoryId','runId','taskId','attempt']);
  [v.repositoryId,v.runId,v.taskId].forEach(id); need([1,2].includes(v.attempt));
}
function filePath(p) {
  need(typeof p==='string' && p.length>0 && !/[\\:\x00-\x1f\x7f-\x9f]/.test(p)
    && p.normalize('NFC')===p,'unsupported_path');
  const parts=p.split('/');
  need(parts.every(s=>s && s!=='.' && s!=='..'),'unsupported_path');
  need(parts.every(s=>!['.git','.ssh','.aws','.gnupg'].includes(s.toLowerCase())
    && !/^\.env(?:\.|$)/i.test(s)),'unsupported_path');
  return p;
}
function paths(input) {
  need(Array.isArray(input) && input.length>0 && input.length<=FILE_COUNT);
  const result=input.map(filePath).sort();
  need(new Set(result.map(p=>p.toLowerCase())).size===result.length,'unsupported_path');
  return result;
}
function rootPath(root) {
  need(typeof root==='string' && path.isAbsolute(root),'unsupported_path');
  try { const real=fs.realpathSync(root); need(fs.statSync(real).isDirectory(),'unsupported_file'); return real; }
  catch(error) { if(error.code==='unsupported_file')throw error; fail('read_failed'); }
}
const statKey = s => [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function readFile(root,p) {
  let fd;
  try {
    const abs=path.join(root,p),before=fs.lstatSync(abs,{bigint:true});
    need(before.isFile() && before.nlink===1n,'unsupported_file');
    need(before.size<=BigInt(FILE_LIMIT),'limit_exceeded');
    fd=fs.openSync(abs,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd,{bigint:true});
    need(statKey(before)===statKey(opened),'snapshot_changed');
    const buf=Buffer.alloc(Number(before.size)+1); let offset=0;
    while(offset<buf.length) {
      const count=fs.readSync(fd,buf,offset,buf.length-offset,null); if(!count)break; offset+=count;
    }
    const after=fs.fstatSync(fd,{bigint:true}),last=fs.lstatSync(abs,{bigint:true});
    need(statKey(before)===statKey(after) && statKey(before)===statKey(last)
      && offset===Number(before.size),'snapshot_changed');
    const bytes=buf.subarray(0,offset);
    return {path:p,type:'file',mode:Number(before.mode & 0o7777n),size:offset,
      sha256:sha(bytes),contentBase64:bytes.toString('base64')};
  } catch(error) {
    if(['unsupported_file','limit_exceeded','snapshot_changed'].includes(error.code))throw error;
    fail('read_failed');
  } finally { if(fd!==undefined) fs.closeSync(fd); }
}
function snapshot(root) {
  const files=[],seen=new Set(); let total=0;
  function walk(rel='',depth=0) {
    need(depth<=32,'limit_exceeded');
    let names;
    try { names=fs.readdirSync(path.join(root,rel)).sort(); } catch { fail('read_failed'); }
    for(const name of names) {
      const p=rel ? rel+'/'+name : name;
      let s; try { s=fs.lstatSync(path.join(root,p)); } catch { fail('read_failed'); }
      if(p==='.git' && s.isDirectory() && !s.isSymbolicLink()) continue;
      filePath(p);
      const alias=p.toLowerCase(); need(!seen.has(alias),'unsupported_path'); seen.add(alias);
      if(s.isDirectory()) walk(p,depth+1);
      else {
        need(s.isFile() && !s.isSymbolicLink() && s.nlink===1,'unsupported_file');
        need(files.length<FILE_COUNT && total+s.size<=SNAPSHOT_LIMIT,'limit_exceeded');
        const f=readFile(root,p); total+=f.size; files.push(f);
      }
    }
  }
  walk(); return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
const sealed = (data,key) => {
  const result={...data,[key]:digest(data)};
  need(Buffer.byteLength(JSON.stringify(result))<=8*1024*1024,'limit_exceeded');
  return freeze(result);
};
export function captureReviewBaseline(options) {
  const v=plain(options); keys(v,['root','identity','scope','requirements']); identityCheck(v.identity);
  const scope=paths(v.scope), requirements=paths(v.requirements),root=rootPath(v.root),files=snapshot(root);
  need(requirements.every(p=>files.some(f=>f.path===p)),'read_failed');
  for(const p of scope) {
    const absolute=path.join(root,p);
    if(fs.existsSync(absolute)) need(fs.lstatSync(absolute).isFile(),'unsupported_file');
  }
  return sealed({version:1,kind:'cm-review-baseline',identity:v.identity,rootDigest:sha(root),
    scope,requirements,files},'baselineDigest');
}
const hex = v => need(typeof v==='string' && /^[a-f0-9]{64}$/.test(v));
function fileRecord(f) {
  keys(f,['path','type','mode','size','sha256','contentBase64']); filePath(f.path);
  need(f.type==='file' && Number.isInteger(f.mode) && f.mode>=0 && f.mode<=0o7777);
  need(Number.isInteger(f.size) && f.size>=0 && f.size<=FILE_LIMIT);
  hex(f.sha256); need(typeof f.contentBase64==='string' && f.contentBase64.length<=Math.ceil(FILE_LIMIT/3)*4);
  const bytes=Buffer.from(f.contentBase64,'base64');
  need(bytes.toString('base64')===f.contentBase64 && bytes.length===f.size && sha(bytes)===f.sha256);
}
function fileList(files) {
  need(Array.isArray(files) && files.length>0 && files.length<=FILE_COUNT);
  files.forEach(fileRecord);
  const names=files.map(f=>f.path); need(digest(names)===digest(paths(names)));
  need(files.reduce((sum,f)=>sum+f.size,0)<=SNAPSHOT_LIMIT,'limit_exceeded');
}
function validBaseline(b) {
  try {
    keys(b,['version','kind','identity','rootDigest','scope','requirements','files','baselineDigest']);
    need(b.version===1 && b.kind==='cm-review-baseline'); identityCheck(b.identity); hex(b.rootDigest);
    need(digest(b.scope)===digest(paths(b.scope)) && digest(b.requirements)===digest(paths(b.requirements)));
    fileList(b.files); need(b.requirements.every(p=>b.files.some(f=>f.path===p)));
    const {baselineDigest,...data}=b; hex(baselineDigest); need(digest(data)===baselineDigest);
  } catch { fail('invalid_baseline'); }
}
function validChecks(checks) {
  need(Array.isArray(checks) && checks.length>0);
  need(Buffer.byteLength(JSON.stringify(checks))<=64*1024,'limit_exceeded');
  const ids=new Set();
  for(const c of checks) {
    keys(c,['id','command','outcome','exitCode','evidence']); id(c.id); need(!ids.has(c.id)); ids.add(c.id);
    need(Array.isArray(c.command) && c.command.length>0 && c.command.every(a=>typeof a==='string' && a.length>0));
    need(typeof c.evidence==='string' && c.evidence.trim().length>0);
    need(c.outcome==='passed' && c.exitCode===0
      || c.outcome==='failed' && Number.isSafeInteger(c.exitCode) && c.exitCode!==0
      || c.outcome==='unavailable' && c.exitCode===null);
  }
}
export function createReviewPackage(options) {
  const v=plain(options); keys(v,['root','baseline','checks']); const b=v.baseline;
  validBaseline(b); validChecks(v.checks);
  const root=rootPath(v.root); need(sha(root)===b.rootDigest,'invalid_baseline');
  const files=snapshot(root),before=new Map(b.files.map(f=>[f.path,f])),after=new Map(files.map(f=>[f.path,f]));
  const changes=[];
  for(const p of [...new Set([...before.keys(),...after.keys()])].sort()) {
    const old=before.get(p)??null,current=after.get(p)??null;
    if(digest(old)===digest(current))continue;
    need(b.scope.includes(p),'out_of_scope'); changes.push({path:p,before:old,after:current});
  }
  need(changes.length>0,'empty_changes');
  const requirements=b.requirements.map(p=>{ need(after.has(p),'read_failed'); return after.get(p); });
  const pkg=sealed({version:1,kind:'cm-review-package',identity:b.identity,rootDigest:b.rootDigest,
    baseIdentity:b.baselineDigest,scope:b.scope,changes,requirements,checks:v.checks,
    artifactDigest:digest(changes),requirementsDigest:digest(requirements),checksDigest:digest(v.checks)},'packageDigest');
  need(Buffer.byteLength(JSON.stringify(pkg))<=8*1024*1024,'limit_exceeded');
  return pkg;
}
function validPackage(p) {
  try {
    keys(p,['version','kind','identity','rootDigest','baseIdentity','scope','changes','requirements',
      'checks','artifactDigest','requirementsDigest','checksDigest','packageDigest']);
    need(p.version===1 && p.kind==='cm-review-package'); identityCheck(p.identity);
    [p.rootDigest,p.baseIdentity,p.artifactDigest,p.requirementsDigest,p.checksDigest,p.packageDigest].forEach(hex);
    need(digest(p.scope)===digest(paths(p.scope)));
    need(Array.isArray(p.changes) && p.changes.length>0 && p.changes.length<=FILE_COUNT);
    const names=[];
    for(const change of p.changes) {
      keys(change,['path','before','after']); filePath(change.path); need(p.scope.includes(change.path));
      names.push(change.path); need(change.before!==null || change.after!==null);
      for(const f of [change.before,change.after]) if(f!==null) { fileRecord(f); need(f.path===change.path); }
      need(digest(change.before)!==digest(change.after));
    }
    need(digest(names)===digest(paths(names))); fileList(p.requirements); validChecks(p.checks);
    need(digest(p.changes)===p.artifactDigest && digest(p.requirements)===p.requirementsDigest
      && digest(p.checks)===p.checksDigest);
    const {packageDigest,...data}=p; need(digest(data)===packageDigest);
    need(Buffer.byteLength(JSON.stringify(p))<=8*1024*1024);
  } catch { fail('invalid_package'); }
}
export function verifyReviewPackage(options) {
  const v=plain(options); keys(v,['root','baseline','checks','reviewPackage','expectedDigest']);
  hex(v.expectedDigest); validBaseline(v.baseline); validPackage(v.reviewPackage);
  need(v.reviewPackage.packageDigest===v.expectedDigest,'package_mismatch');
  const current=createReviewPackage({root:v.root,baseline:v.baseline,checks:v.checks});
  need(current.packageDigest===v.expectedDigest,'package_mismatch');
  return freeze({outcome:'matched',packageDigest:current.packageDigest});
}

// Offline readers deliberately do not sample the current (possibly modified) tree.
export function readReviewBaseline(raw) {
  const value=plain(raw);validBaseline(value);return freeze(value);
}
export function readReviewPackage(raw) {
  const value=plain(raw);validPackage(value);return freeze(value);
}
