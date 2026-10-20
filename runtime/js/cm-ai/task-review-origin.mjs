// Explicit task-wide Git origin for one reviewed attempt-2 continuation.
// This material grants no authority, dispatches nothing and does not reset budgets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest,json,shape,hex,need,freeze} from './effect-contract.mjs';
import {readRuleAcceptance,assertAcceptedRuleFiles} from './rule-acceptance.mjs';
import {validateDeveloperScope} from './developer-adapter.mjs';
import {readReviewBaseline,readReviewPackage,readReviewScope,readReviewSourceRecords,readReviewFileBytes,compressedReviewSourceRecord,reviewScopeAdditions,REVIEW_MATERIAL_LIMITS} from './review-package.mjs';

const INVALID='task_review_origin_invalid',DRIFT='task_review_origin_changed',UNAVAILABLE='task_review_origin_git_unavailable';
const LIMIT=8*1024*1024;
const must=(value,code=INVALID)=>need(value,code);
const guarded=run=>{try{return run();}catch(error){if([INVALID,DRIFT,UNAVAILABLE].includes(error?.code)||String(error?.code).startsWith('rule_acceptance_'))throw error;
  throw Object.assign(new Error(INVALID),{code:INVALID});}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const equal=(a,b)=>digest(a)===digest(b);
const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
const canonicalRoot=root=>{
  must(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root&&!/[\x00-\x1f\x7f]/.test(root));
  must(fs.realpathSync(root)===root&&fs.lstatSync(root).isDirectory(),DRIFT);
  let p=path.parse(root).root;for(const part of root.slice(p.length).split(path.sep).filter(Boolean)){
    p=path.join(p,part);must(!fs.lstatSync(p).isSymbolicLink(),DRIFT);
  }return root;
};
const metadata=file=>file===null?null:Object.fromEntries(['path','type','mode','size','sha256'].map(k=>[k,file[k]]));
function selectedScope(original,scope,config){
  const b=readReviewBaseline(original);must(b.version===2&&!b.taskReviewOrigin);
  validateDeveloperScope(config.scope);validateDeveloperScope(scope);const selected=readReviewScope(scope);
  must(equal(selected,scope)&&config.scope.every(p=>selected.includes(p))&&selected.length>config.scope.length);
  must(config.scope.every(p=>b.scope.includes(p)));
  const additions=selected.filter(p=>!config.scope.includes(p));
  must(additions.length<=32);reviewScopeAdditions(b,[...new Set([...b.scope,...selected])].sort());
  const requirements=new Set(b.requirements.map(p=>p.toLowerCase()));
  must(additions.every(p=>!requirements.has(p.toLowerCase())));
  const existing=new Map(b.files.map(f=>[f.path.toLowerCase(),f.path]));
  must(selected.every(p=>!existing.has(p.toLowerCase())||existing.get(p.toLowerCase())===p));
  return {b,selected,additions};
}
function stateBinding(state,config,original){
  must(state?.attempt===2&&state.state==='blocked'&&state.code==='develop_package_too_large');
  must(!state.cancellationRequested&&!state.cancelAfterCommit&&!state.workflowError&&!state.taskCommit);
  const last=state.cache?.at(-1);must(last?.effect.kind==='develop'&&last.effect.identity.attempt===2
    &&last.result.state==='blocked'&&last.result.code===state.code);
  must(equal({...last.effect.identity,attempt:1},config.identity)&&equal(original.identity,config.identity));
  const pkg=readReviewPackage(state.reviewPackage);must(pkg.identity.attempt===1&&equal(pkg.identity,config.identity));
  const receipt=state.receipts?.findLast(r=>r.packageDigest===pkg.packageDigest&&r.identity?.attempt===1&&r.result?.verdict==='changes_requested');
  must(receipt&&equal(receipt.identity,config.identity)&&equal(receipt.result,state.priorReview));
  const {receiptDigest,...body}=receipt;hex(receiptDigest);must(digest(body)===receiptDigest);
  must(receipt.baseIdentity===pkg.baseIdentity&&pkg.baseIdentity===original.baselineDigest);
  must(!state.receipts.some(r=>r.identity?.attempt===2));
  must(!state.reviewInvocation||state.reviewInvocation.registration?.binding?.identity?.attempt!==2);
  return {priorPackageDigest:pkg.packageDigest,priorReceiptDigest:receiptDigest};
}
function authorizationValue(raw,commit,additions,currentFiles){
  const a=json(raw,LIMIT);shape(a,['version','commit','additions',...(Object.hasOwn(a,'ruleAcceptance')?['ruleAcceptance']:[])]);must(a.version===1&&a.commit===commit);
  must(Array.isArray(a.additions)&&a.additions.length===additions.length);
  must(equal(a.additions.map(f=>f.path),additions));
  const current=new Map(currentFiles.map(row=>[row.path,row.file]));
  for(const item of a.additions){shape(item,['path','source','sha256','size','mode']);hex(item.sha256);
    must(typeof item.source==='string'&&item.source.trim().length>0&&Buffer.byteLength(item.source)<=500&&!/[\r\n\0]/.test(item.source));
    const file=current.get(item.path);must(file!==null&&file!==undefined
      &&item.sha256===file.sha256&&item.size===file.size&&item.mode===file.mode,DRIFT);
  }return a;
}
function fileRows(raw,scope,{bodies=false}={}){
  const rows=json(raw,LIMIT);must(Array.isArray(rows)&&equal(rows.map(row=>row.path),scope));
  let total=0;
  for(const row of rows){shape(row,['path','file']);if(row.file===null)continue;
    const file=row.file;must(file.path===row.path);
    if(bodies){readReviewSourceRecords([file]);const bytes=readReviewFileBytes(file);
      must(Buffer.from(new TextDecoder('utf8',{fatal:true}).decode(bytes)).equals(bytes));
    }else{shape(file,['path','type','mode','size','sha256']);hex(file.sha256);
      must(file.type==='file'&&Number.isInteger(file.mode)&&file.mode>=0&&file.mode<=0o7777
        &&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=REVIEW_MATERIAL_LIMITS.file);}
    total+=file.size;must(total<=REVIEW_MATERIAL_LIMITS.total);
  }return rows;
}
function currentFiles(root,scope){
  let total=0;const rootStat=fs.lstatSync(root);
  const rows=scope.map(selected=>{
    let parent=root,missing=false;
    const parts=selected.split('/');
    for(let i=0;i<parts.length;i++){
      if(missing)break;
      const matches=fs.readdirSync(parent).filter(name=>name.toLowerCase()===parts[i].toLowerCase());
      must(matches.length<=1&&(!matches.length||matches[0]===parts[i]),DRIFT);
      const target=path.join(parent,parts[i]);let stat;
      try{stat=fs.lstatSync(target,{bigint:true});}catch(error){if(error.code==='ENOENT'){missing=true;break;}throw error;}
      must(!stat.isSymbolicLink(),DRIFT);
      if(i<parts.length-1){must(stat.isDirectory()&&fs.realpathSync(target)===target,DRIFT);parent=target;continue;}
      must(stat.isFile()&&stat.nlink===1n&&stat.size<=BigInt(REVIEW_MATERIAL_LIMITS.file),DRIFT);
      const key=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
      const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
      try{must(key(stat)===key(fs.fstatSync(fd,{bigint:true})),DRIFT);
        const buffer=Buffer.alloc(Number(stat.size)+1);let length=0;
        while(length<buffer.length){const n=fs.readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}
        bytes=buffer.subarray(0,length);
        must(length===Number(stat.size)&&key(stat)===key(fs.fstatSync(fd,{bigint:true}))&&key(stat)===key(fs.lstatSync(target,{bigint:true})),DRIFT);
      }finally{fs.closeSync(fd);}
      let checked=root;for(const part of parts.slice(0,-1)){checked=path.join(checked,part);
        must(fs.lstatSync(checked).isDirectory()&&!fs.lstatSync(checked).isSymbolicLink()&&fs.realpathSync(checked)===checked,DRIFT);}
      must(Buffer.from(new TextDecoder('utf8',{fatal:true}).decode(bytes)).equals(bytes),DRIFT);
      total+=bytes.length;must(total<=REVIEW_MATERIAL_LIMITS.total);
      return {path:selected,file:{path:selected,type:'file',mode:Number(stat.mode&0o7777n),size:bytes.length,sha256:sha(bytes)}};
    }
    must(missing,DRIFT);return {path:selected,file:null};
  });
  canonicalRoot(root);const end=fs.lstatSync(root);must(rootStat.dev===end.dev&&rootStat.ino===end.ino,DRIFT);return rows;
}
function gitOrigin(root,scope,commit,{head=false}={}){
  must(typeof commit==='string'&&/^[a-f0-9]{40}$/.test(commit));
  let boundary=root;for(let p=root;;p=path.dirname(p)){
    if(fs.existsSync(path.join(p,'.git'))){boundary=p;break;}if(path.dirname(p)===p)break;
  }
  let binary=null;
  for(const directory of (process.env.PATH??'').split(path.delimiter)){
    if(!directory||!path.isAbsolute(directory))continue;
    try{const candidate=fs.realpathSync(path.join(directory,process.platform==='win32'?'git.exe':'git'));
      if(!inside(boundary,candidate)&&fs.statSync(candidate).isFile()){fs.accessSync(candidate,fs.constants.X_OK);binary=candidate;break;}}
    catch{}
  }must(binary,UNAVAILABLE);
  const safePath=(process.env.PATH??'').split(path.delimiter).filter(directory=>{
    try{return path.isAbsolute(directory)&&!inside(boundary,fs.realpathSync(directory));}catch{return false;}
  }).join(path.delimiter);
  const env={PATH:safePath,HOME:os.tmpdir(),USERPROFILE:os.tmpdir(),TMPDIR:os.tmpdir(),TMP:os.tmpdir(),TEMP:os.tmpdir(),
    LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_SYSTEM:os.devNull,
    GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
    ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
  const command=args=>{
    const r=spawnSync(binary,['--no-optional-locks','-c','core.fsmonitor=false','-c',`core.hooksPath=${os.devNull}`,
      '-c',`core.attributesFile=${os.devNull}`,'-c','protocol.allow=never','-C',root,...args],{env,timeout:10000,maxBuffer:REVIEW_MATERIAL_LIMITS.total+65536});
    must(!r.error&&r.status===0,UNAVAILABLE);return r.stdout;
  };
  const top=command(['rev-parse','--show-toplevel']).toString('utf8').trim();
  must(path.isAbsolute(top)&&fs.realpathSync(top)===top&&inside(top,root),UNAVAILABLE);
  const prefix=path.relative(top,root).split(path.sep).join('/')+(top===root?'':'/');
  must(command(['rev-parse','--verify',`${commit}^{commit}`]).toString('utf8').trim()===commit,UNAVAILABLE);
  if(head)must(command(['rev-parse','--verify','HEAD']).toString('utf8').trim()===commit,DRIFT);
  const names=scope.map(p=>prefix+p),wanted=new Map(names.map((name,i)=>[name,scope[i]]));
  // ls-tree supports literal but not icase pathspec magic. Bounded subtree
  // metadata detects case aliases without reading any unrelated file bodies.
  const tree=command(['ls-tree','--full-tree','-r','-z',commit,...(prefix?['--',`:(literal)${prefix.slice(0,-1)}`]:[])]);
  const folded=new Map(names.map(name=>[name.toLowerCase(),name]));
  const objects=new Map();
  for(const entry of tree.toString('utf8').split('\0').filter(Boolean)){
    const match=/^([0-7]{6}) (?:blob|commit|tree) ([a-f0-9]{40})\t(.+)$/.exec(entry);must(match,UNAVAILABLE);
    if(!wanted.has(match[3])){must(!folded.has(match[3].toLowerCase()),UNAVAILABLE);continue;}
    must(['100644','100755'].includes(match[1])&&!objects.has(match[3]),UNAVAILABLE);
    objects.set(match[3],{mode:match[1]==='100755'?0o755:0o644,object:match[2]});
  }
  let total=0;
  const beforeFiles=scope.map((p,index)=>{
    const object=objects.get(names[index]);if(!object)return {path:p,file:null};
    const bytesSize=command(['cat-file','-s',object.object]).toString('utf8').trim();
    must(/^(0|[1-9][0-9]*)$/.test(bytesSize)&&Number(bytesSize)<=REVIEW_MATERIAL_LIMITS.file,UNAVAILABLE);
    const bytes=command(['cat-file','blob',object.object]);must(bytes.length===Number(bytesSize),UNAVAILABLE);
    total+=bytes.length;must(total<=REVIEW_MATERIAL_LIMITS.total,UNAVAILABLE);
    must(Buffer.from(new TextDecoder('utf8',{fatal:true}).decode(bytes)).equals(bytes),UNAVAILABLE);
    return {path:p,file:{path:p,type:'file',mode:object.mode,size:bytes.length,sha256:sha(bytes),contentBase64:bytes.toString('base64')}};
  });return {prefix,beforeFiles};
}
function acceptedRules(authorization,b,scope){
  if(!Object.hasOwn(authorization,'ruleAcceptance'))return null;
  const r=readRuleAcceptance(authorization.ruleAcceptance);
  must(r.sourceBaselineDigest===b.baselineDigest,'rule_acceptance_source_changed');
  const old=new Map(b.files.map(f=>[f.path,f]));
  for(const f of r.files)must(!scope.includes(f.path)&&!b.requirements.includes(f.path)
    &&old.get(f.path)?.sha256===f.creationSha256,'rule_acceptance_source_changed');
  return r;
}
export function verifyAcceptedTaskRules({root,continuation}){return guarded(()=>{
  const rules=continuation?.baseline?.taskReviewOrigin?.ruleAcceptance;
  if(!rules)return true;
  assertAcceptedRuleFiles(rules,currentFiles(canonicalRoot(root),rules.files.map(f=>f.path)).map(r=>r.file).filter(Boolean));
  return true;
});}
export function applyTaskReviewOrigin({original,scope,record,config,state}){return guarded(()=>{
  const {b,selected,additions}=selectedScope(original,scope,config),binding=stateBinding(state,config,b),r=json(record,LIMIT);
  shape(r,['version','commit','prefix','beforeFiles','currentFiles','sourceBaselineDigest','priorPackageDigest','priorReceiptDigest','authorization']);
  must(r.version===1&&typeof r.commit==='string'&&/^[a-f0-9]{40}$/.test(r.commit));
  must(typeof r.prefix==='string'&&(r.prefix===''||r.prefix.endsWith('/')&&readReviewScope([r.prefix.slice(0,-1)])[0]===r.prefix.slice(0,-1)));
  must(r.sourceBaselineDigest===b.baselineDigest&&r.priorPackageDigest===binding.priorPackageDigest&&r.priorReceiptDigest===binding.priorReceiptDigest);
  const rules=acceptedRules(r.authorization,b,selected);
  const reviewSelection=[...new Set([...selected,...(rules?.files.map(f=>f.path)??[])])].sort();
  const before=fileRows(r.beforeFiles,reviewSelection,{bodies:true}),current=fileRows(r.currentFiles,reviewSelection);
  if(rules)assertAcceptedRuleFiles(rules,current.map(r=>r.file).filter(Boolean));
  authorizationValue(r.authorization,r.commit,additions,current);
  const inventory=new Map(b.files.map(f=>[f.path,f]));
  for(const row of before){if(row.file===null)inventory.delete(row.path);else inventory.set(row.path,row.file);}
  if(rules)for(const [p,file]of inventory)if(Object.hasOwn(file,'contentBase64')||Object.hasOwn(file,'contentGzipBase64'))inventory.set(p,compressedReviewSourceRecord(file));
  const missingRequirements=b.requirements.filter(p=>!inventory.has(p)).sort();must(missingRequirements.every(p=>selected.includes(p)));
  const marker={version:1,commit:r.commit,sourceBaselineDigest:b.baselineDigest,originDigest:digest(r),missingRequirements,...(rules?{ruleAcceptance:rules}:{})};
  const {baselineDigest:discard,...old}=b;
  const data={...old,identity:{...b.identity,attempt:2},scope:[...new Set([...b.scope,...reviewSelection])].sort(),
    scopeRevisionPaths:[...new Set([...(b.scopeRevisionPaths??[]),...additions,...(rules?.files.map(f=>f.path)??[])])].sort(),
    files:[...inventory.values()].sort((a,b)=>a.path.localeCompare(b.path,'en')),taskReviewOrigin:marker};
  // Use bytewise canonical path ordering, as review-package's paths() does.
  data.files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const baseline=readReviewBaseline({...data,baselineDigest:digest(data)});
  return freeze({baseline,currentFiles:current,originDigest:digest(r)});
});}
export function captureTaskReviewOrigin({root,original,scope,commit,state,config,authorization}){return guarded(()=>{
  const real=canonicalRoot(root),{b,selected,additions}=selectedScope(original,scope,config);
  must(sha(Buffer.from(real))===b.rootDigest,DRIFT);
  const rules=acceptedRules(authorization,b,selected);
  const reviewSelection=[...new Set([...selected,...(rules?.files.map(f=>f.path)??[])])].sort();
  const binding=stateBinding(state,config,b),current=currentFiles(real,reviewSelection),git=gitOrigin(real,reviewSelection,commit);
  if(rules){
    assertAcceptedRuleFiles(rules,current.map(r=>r.file).filter(Boolean));
    const committed=gitOrigin(real,rules.files.map(f=>f.path),rules.candidateCommit,{head:true});
    assertAcceptedRuleFiles(rules,committed.beforeFiles.map(r=>r.file).filter(Boolean));
  }
  const a=authorizationValue(authorization,commit,additions,current);
  const record={version:1,commit,prefix:git.prefix,beforeFiles:rules?git.beforeFiles.map(row=>({...row,file:row.file?compressedReviewSourceRecord(row.file):null})):git.beforeFiles,currentFiles:current,
    sourceBaselineDigest:b.baselineDigest,...binding,authorization:a};
  applyTaskReviewOrigin({original:b,scope:selected,record,config,state});return freeze(record);
});}
export function verifyTaskReviewOrigin(binding,options){return guarded(()=>{
  const captured=captureTaskReviewOrigin({...options,commit:binding.commit,authorization:binding.authorization});
  must(equal(captured,binding),DRIFT);return freeze(captured);
});}

// The registration pins the execution start, independently of its Git review
// origin. Once a new intent exists, partial writes belong to the existing
// effect recovery contract and must not be mistaken for pre-start drift.
export function taskContinuationNeedsSnapshot(records){
  const at=records.findLastIndex(row=>row.payload.type==='scope-continued');
  return at>=0&&!records.slice(at+1).some(row=>row.payload.type==='effect-intent');
}
export function verifyTaskExecutionSnapshot({root,currentFiles:expected}){return guarded(()=>{
  const real=canonicalRoot(root),scope=expected.map(row=>row.path);
  must(equal(currentFiles(real,scope),expected),DRIFT);return true;
});}
