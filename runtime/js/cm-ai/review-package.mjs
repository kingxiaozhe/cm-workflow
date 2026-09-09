// S2a offline content binding only. No reviewer authentication or task writes.
// Trusted fixture hosts only: callers own authorization and a quiescent root.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from './contracts.mjs';
import {resolveCodeProjects,validateCodeProjectPaths,
  codeProjectInstructionPaths,assertCodeProjectSelections} from './code-projects.mjs';

const FILE_LIMIT=1024*1024, SNAPSHOT_LIMIT=2*1024*1024, FILE_COUNT=256;
// Fixed dependency/cache directories, not caller-controlled business exclusions.
// Keep this narrower than the discovery scanner: dist/build may be authored files.
const dependencyDirectories=new Set(['.venv','node_modules','__pycache__','.pytest_cache','.ruff_cache']);
const inDependencyDirectory=p=>p.split('/').slice(0,-1).some(part=>dependencyDirectories.has(part.toLowerCase()));
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
// The only excluded business subtree is the host-owned specs root, not an
// arbitrary ignore list. Pure path mapping is shared with journal validation.
export function reviewSpecsPath(root,specsRoot) {
  for(const p of [root,specsRoot])need(typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p&&!p.includes('\0'),'unsupported_path');
  need(root!==specsRoot&&!root.startsWith(specsRoot+path.sep),'overlapping_roots');
  return specsRoot.startsWith(root+path.sep)?filePath(path.relative(root,specsRoot).split(path.sep).join('/')):null;
}
function snapshot(root,specsPath=null,projectPaths=null,retainedPaths=[]) {
  if(specsPath!==null){
    const target=path.join(root,specsPath);
    need(fs.realpathSync(target)===target&&fs.lstatSync(target).isDirectory(),'unsupported_path');
  }
  const files=[],seen=new Set(); let total=0;
  function add(p,s){
    need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'unsupported_file');
    need(files.length<FILE_COUNT&&total+s.size<=SNAPSHOT_LIMIT,'limit_exceeded');
    const f=readFile(root,p);total+=f.size;files.push(f);
  }
  function walk(rel='',depth=0,codeRoot='') {
    need(depth<=32,'limit_exceeded');
    let names;
    try { names=fs.readdirSync(path.join(root,rel)).sort(); } catch { fail('read_failed'); }
    for(const name of names) {
      const p=rel ? rel+'/'+name : name;
      let s; try { s=fs.lstatSync(path.join(root,p)); } catch { fail('read_failed'); }
      // Linked worktrees use a regular .git pointer file instead of a directory.
      // Treat both as Git metadata, never read/follow the pointer or traverse it.
      // Scope and requirement paths still cannot select any .git entry.
      if(p===(codeRoot?codeRoot+'/.git':'.git') && !s.isSymbolicLink()
        && (s.isDirectory() || (s.isFile() && s.nlink===1))) continue;
      filePath(p);
      const alias=p.toLowerCase(); need(!seen.has(alias),'unsupported_path'); seen.add(alias);
      if(p===specsPath){need(s.isDirectory()&&!s.isSymbolicLink(),'unsupported_path');continue;}
      // Never follow a dependency-root symlink. Old baselines that captured
      // these files still verify their original material instead of dropping it.
      if(s.isDirectory()&&dependencyDirectories.has(name)
        &&!retainedPaths.some(file=>file.startsWith(p+'/')))continue;
      if(s.isDirectory()) walk(p,depth+1,codeRoot);
      else add(p,s);
    }
  }
  if(projectPaths===null)walk();
  else{
    const roots=projectPaths.map(prefix=>path.join(root,prefix));
    resolveCodeProjects(root,roots);
    for(const prefix of projectPaths)walk(prefix,0,prefix);
    for(const p of codeProjectInstructionPaths(projectPaths)){
      if(projectPaths.some(prefix=>p.startsWith(prefix+'/')))continue;
      let stat;try{stat=fs.lstatSync(path.join(root,p));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      need(!seen.has(p.toLowerCase()),'unsupported_path');seen.add(p.toLowerCase());add(p,stat);
    }
    resolveCodeProjects(root,roots);
  }
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
const sealed = (data,key) => {
  const result={...data,[key]:digest(data)};
  need(Buffer.byteLength(JSON.stringify(result))<=8*1024*1024,'limit_exceeded');
  return freeze(result);
};
export function captureReviewBaseline(options) {
  const v=plain(options); keys(v,['root','identity','scope','requirements',
    ...['specsRoot','codeProjectPaths','bootstrapRequirements'].filter(key=>Object.hasOwn(v,key))]); identityCheck(v.identity);
  const bootstrap=Object.hasOwn(v,'bootstrapRequirements')?v.bootstrapRequirements:null;
  if(bootstrap!==null){
    validBootstrapRequirements(bootstrap);
    need(Object.hasOwn(v,'specsRoot')&&bootstrap.specsRoot===v.specsRoot,'bootstrap_requirements_mismatch');
    currentBootstrapRequirements(bootstrap);
  }
  const scope=paths(v.scope), requirements=requirementPaths(v.requirements,bootstrap!==null),root=rootPath(v.root);
  need(![...scope,...requirements].some(inDependencyDirectory),'excluded_snapshot_path');
  const projectPaths=Object.hasOwn(v,'codeProjectPaths')?validateCodeProjectPaths(v.codeProjectPaths):null;
  if(projectPaths!==null)resolveCodeProjects(v.root,projectPaths.map(prefix=>path.join(root,prefix)));
  const specsPath=Object.hasOwn(v,'specsRoot')?reviewSpecsPath(root,v.specsRoot):null;
  if(specsPath!==null)validateSpecsSelection(specsPath,[...scope,...requirements]);
  if(projectPaths!==null){
    if(specsPath!==null)validateProjectSpecs(specsPath,projectPaths);
    assertCodeProjectSelections(projectPaths,[...scope,...requirements],{allowInstructions:true});
  }
  const files=snapshot(root,specsPath,projectPaths);
  need(requirements.every(p=>files.some(f=>f.path===p)),'read_failed');
  for(const p of scope) {
    const absolute=path.join(root,p);
    if(fs.existsSync(absolute)) need(fs.lstatSync(absolute).isFile(),'unsupported_file');
  }
  return sealed({version:1,kind:'cm-review-baseline',identity:v.identity,rootDigest:sha(root),
    scope,requirements,files,...(specsPath===null?{}:{specsPath}),
    ...(projectPaths===null?{}:{codeProjectPaths:projectPaths}),
    ...(bootstrap===null?{}:{bootstrapRequirements:bootstrap})},'baselineDigest');
}

// Bounded selected-file material for pre-implementation reviews; no whole-tree scan.
export function readReviewSourceFiles(root,selected){
  let total=0;
  const real=rootPath(root),files=paths(selected).map(p=>{
    const parts=p.split('/');let parent=real;
    for(const part of parts.slice(0,-1)){
      parent=path.join(parent,part);
      const stat=fs.lstatSync(parent);
      need(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(parent)===parent,'unsupported_path');
    }
    const file=readFile(real,p);total+=file.size;need(total<=SNAPSHOT_LIMIT,'limit_exceeded');return file;
  });
  return freeze(files);
}
function validateSpecsSelection(specsPath,selections) {
  filePath(specsPath);
  const boundary=specsPath.toLowerCase();
  need(selections.every(p=>{const name=p.toLowerCase();return name!==boundary
    &&!name.startsWith(boundary+'/')&&!boundary.startsWith(name+'/');}),'protected_specs');
}
function validateProjectSpecs(specsPath,projectPaths){
  const boundary=specsPath.toLowerCase();
  need(projectPaths.every(prefix=>prefix.toLowerCase()!==boundary
    &&!prefix.toLowerCase().startsWith(boundary+'/')),'protected_specs');
}
function requirementPaths(value,bootstrap){
  return bootstrap&&Array.isArray(value)&&value.length===0?[]:paths(value);
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
const bootstrapPaths=['0.bootstrap/design.md','0.bootstrap/requirements.md'];
function validBootstrapRequirements(value,published=false){
  keys(value,['feature','files',published?'rootDigest':'specsRoot']);
  need(value.feature==='0.bootstrap','bootstrap_requirements_invalid');
  if(published)hex(value.rootDigest);
  else need(typeof value.specsRoot==='string'&&path.isAbsolute(value.specsRoot)
    &&path.resolve(value.specsRoot)===value.specsRoot&&!value.specsRoot.includes('\0'),'unsupported_path');
  fileList(value.files);
  need(digest(value.files.map(file=>file.path))===digest(bootstrapPaths)
    &&value.files.every(file=>file.size>0),'bootstrap_requirements_invalid');
}
function currentBootstrapRequirements(value){
  need(fs.realpathSync(value.specsRoot)===value.specsRoot,'unsupported_path');
  const files=readReviewSourceFiles(value.specsRoot,bootstrapPaths);
  need(digest(files)===digest(value.files),'bootstrap_requirements_changed');
  return {feature:value.feature,files:value.files,rootDigest:sha(value.specsRoot)};
}
export function readReviewSourceRecords(raw){
  const files=plain(raw);fileList(files);return freeze(files);
}
function validBaseline(b) {
  try {
    keys(b,['version','kind','identity','rootDigest','scope','requirements','files','baselineDigest',
      ...['specsPath','codeProjectPaths','bootstrapRequirements'].filter(key=>Object.hasOwn(b,key))]);
    need(b.version===1 && b.kind==='cm-review-baseline'); identityCheck(b.identity); hex(b.rootDigest);
    const bootstrap=Object.hasOwn(b,'bootstrapRequirements');if(bootstrap)validBootstrapRequirements(b.bootstrapRequirements);
    need(digest(b.scope)===digest(paths(b.scope)) && digest(b.requirements)===digest(requirementPaths(b.requirements,bootstrap)));
    if(!bootstrap||b.files.length)fileList(b.files);else need(Array.isArray(b.files));
    need(b.requirements.every(p=>b.files.some(f=>f.path===p)));
    if(Object.hasOwn(b,'specsPath'))validateSpecsSelection(b.specsPath,[...b.scope,...b.requirements,...b.files.map(f=>f.path)]);
    if(Object.hasOwn(b,'codeProjectPaths')){
      need(digest(b.codeProjectPaths)===digest(validateCodeProjectPaths(b.codeProjectPaths)));
      assertCodeProjectSelections(b.codeProjectPaths,[...b.scope,...b.requirements,...b.files.map(f=>f.path)],{allowInstructions:true});
      if(Object.hasOwn(b,'specsPath'))validateProjectSpecs(b.specsPath,b.codeProjectPaths);
    }
    const {baselineDigest,...data}=b; hex(baselineDigest); need(digest(data)===baselineDigest);
  } catch { fail('invalid_baseline'); }
}
function validChecks(checks) {
  need(Array.isArray(checks) && checks.length>0);
  need(Buffer.byteLength(JSON.stringify(checks))<=64*1024,'limit_exceeded');
  const ids=new Set();
  for(const c of checks) {
    if(c.kind==='visual'){
      keys(c,['id','kind','outcome','evidence','before','after']);id(c.id);need(!ids.has(c.id));ids.add(c.id);
      need(['passed','failed','unavailable'].includes(c.outcome));
      need(typeof c.evidence==='string'&&c.evidence.trim().length>0);
      const carrier=value=>{
        keys(value,['path','sha256','kind','description']);hex(value.sha256);
        need(typeof value.path==='string'&&path.isAbsolute(value.path)&&path.resolve(value.path)===value.path
          &&!/[\x00-\x1f\x7f-\x9f]/.test(value.path));
        need(['screenshot','video'].includes(value.kind));
        need(typeof value.description==='string'&&value.description.trim().length>0);
      };
      carrier(c.before);need((c.after===null)===(c.outcome==='unavailable'));
      if(c.after!==null)carrier(c.after);
      continue;
    }
    keys(c,['id','command','outcome','exitCode','evidence']); id(c.id); need(!ids.has(c.id)); ids.add(c.id);
    need(Array.isArray(c.command) && c.command.length>0 && c.command.every(a=>typeof a==='string' && a.length>0));
    need(typeof c.evidence==='string' && c.evidence.trim().length>0);
    need(c.outcome==='passed' && c.exitCode===0
      || c.outcome==='failed' && Number.isSafeInteger(c.exitCode) && c.exitCode!==0
      || c.outcome==='unavailable' && c.exitCode===null);
  }
}
export function createReviewPackage(options) {
  const v=plain(options); keys(v,['root','baseline','checks',...(Object.hasOwn(v,'handoffPath')?['handoffPath']:[])]); const b=v.baseline;
  validBaseline(b); validChecks(v.checks);
  const root=rootPath(v.root); need(sha(root)===b.rootDigest,'invalid_baseline');
  const bootstrap=Object.hasOwn(b,'bootstrapRequirements')?currentBootstrapRequirements(b.bootstrapRequirements):null;
  if(bootstrap!==null)need(reviewSpecsPath(root,b.bootstrapRequirements.specsRoot)===(b.specsPath??null),'bootstrap_requirements_mismatch');
  const files=snapshot(root,b.specsPath??null,b.codeProjectPaths??null,b.files.map(f=>f.path)),before=new Map(b.files.map(f=>[f.path,f])),after=new Map(files.map(f=>[f.path,f]));
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
    ...(Object.hasOwn(b,'codeProjectPaths')?{codeProjectPaths:b.codeProjectPaths,
      instructions:files.filter(file=>file.path.split('/').at(-1)==='AGENTS.md')}:{}),
    ...(bootstrap===null?{}:{bootstrapRequirements:bootstrap}),
    ...(Object.hasOwn(v,'handoffPath')?{handoff:readHandoffSnapshot(v.handoffPath)}:{}),
    artifactDigest:digest(changes),requirementsDigest:digest(requirements),checksDigest:digest(v.checks)},'packageDigest');
  need(Buffer.byteLength(JSON.stringify(pkg))<=8*1024*1024,'limit_exceeded');
  return pkg;
}
function validPackage(p) {
  try {
    keys(p,['version','kind','identity','rootDigest','baseIdentity','scope','changes','requirements',
      'checks','artifactDigest','requirementsDigest','checksDigest','packageDigest',
      ...(Object.hasOwn(p,'handoff')?['handoff']:[]),
      ...(Object.hasOwn(p,'codeProjectPaths')?['codeProjectPaths','instructions']:[]),
      ...(Object.hasOwn(p,'bootstrapRequirements')?['bootstrapRequirements']:[])]);
    if(Object.hasOwn(p,'handoff')) {
      fileRecord(p.handoff);need(!p.handoff.path.includes('/')&&p.handoff.size<=256*1024);
    }
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
    need(digest(names)===digest(paths(names)));
    if(Object.hasOwn(p,'bootstrapRequirements')){
      validBootstrapRequirements(p.bootstrapRequirements,true);
      if(p.requirements.length)fileList(p.requirements);else need(Array.isArray(p.requirements));
    }else fileList(p.requirements);
    validChecks(p.checks);
    if(Object.hasOwn(p,'codeProjectPaths')){
      need(digest(p.codeProjectPaths)===digest(validateCodeProjectPaths(p.codeProjectPaths)));
      need(Array.isArray(p.instructions));if(p.instructions.length)fileList(p.instructions);
      need(p.instructions.every(file=>file.path.split('/').at(-1)==='AGENTS.md'));
      assertCodeProjectSelections(p.codeProjectPaths,[...p.scope,...p.requirements.map(f=>f.path),...p.instructions.map(f=>f.path)],{allowInstructions:true});
      for(const file of p.instructions){
        const change=p.changes.find(item=>item.path===file.path),requirement=p.requirements.find(item=>item.path===file.path);
        if(change)need(digest(file)===digest(change.after));
        if(requirement)need(digest(file)===digest(requirement));
      }
    }
    need(digest(p.changes)===p.artifactDigest && digest(p.requirements)===p.requirementsDigest
      && digest(p.checks)===p.checksDigest);
    const {packageDigest,...data}=p; need(digest(data)===packageDigest);
    need(Buffer.byteLength(JSON.stringify(p))<=8*1024*1024);
  } catch { fail('invalid_package'); }
}
export function verifyReviewPackage(options) {
  const v=plain(options); keys(v,['root','baseline','checks','reviewPackage','expectedDigest',
    ...(Object.hasOwn(v,'handoffPath')?['handoffPath']:[])]);
  hex(v.expectedDigest); validBaseline(v.baseline); validPackage(v.reviewPackage);
  need(v.reviewPackage.packageDigest===v.expectedDigest,'package_mismatch');
  need(Object.hasOwn(v.reviewPackage,'handoff')===Object.hasOwn(v,'handoffPath'),'package_mismatch');
  const current=createReviewPackage({root:v.root,baseline:v.baseline,checks:v.checks,
    ...(Object.hasOwn(v,'handoffPath')?{handoffPath:v.handoffPath}:{})});
  need(current.packageDigest===v.expectedDigest,'package_mismatch');
  return freeze({outcome:'matched',packageDigest:current.packageDigest});
}

// The host supplies this separate specs-root file; workers never select it.
// Reuse the bounded no-follow snapshot reader and store bytes, not a live path.
function readHandoffSnapshot(p) {
  need(typeof p==='string'&&path.isAbsolute(p)&&path.resolve(p)===p,'unsupported_path');
  const parent=path.dirname(p),name=filePath(path.basename(p));
  need(fs.realpathSync(parent)===parent,'unsupported_path');
  const file=readFile(parent,name);need(file.size<=256*1024,'limit_exceeded');return file;
}

// Offline readers deliberately do not sample the current (possibly modified) tree.
export function readReviewBaseline(raw) {
  const value=plain(raw);validBaseline(value);return freeze(value);
}
export function readReviewPackage(raw) {
  const value=plain(raw);validPackage(value);return freeze(value);
}
