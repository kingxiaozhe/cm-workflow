#!/usr/bin/env node
// JavaScript authority for CM handoff, review, and read-only completion-plan gates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import childProcess from 'node:child_process';
import {fileURLToPath} from 'node:url';

const TASK_RE=/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVIEWERS=new Set(['codex-subagent','codex-cli','self-degraded']);
const VERDICTS=new Set(['approved','changes_requested','blocked']);
const PREPARATION_FILE_LIMIT=256*1024;
let preparationReadLimit=null;

export class GateError extends Error {
  constructor(message){super(message);this.name='GateError';}
}

function define(target,key,value){
  Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
}

function parseJsonStrict(text){
  let index=0;
  const whitespace=()=>{while(index<text.length&&/[ \t\r\n]/.test(text[index]))index++;};
  function value(depth=0){
    if(depth>256)throw new GateError('JSON nesting is too deep');
    whitespace();
    const start=index,character=text[index];
    if(character==='"'){
      index++;
      for(let escaped=false;index<text.length;index++){
        const current=text[index];
        if(escaped){escaped=false;continue;}
        if(current==='\\'){escaped=true;continue;}
        if(current==='"'){
          index++;
          try{return JSON.parse(text.slice(start,index));}
          catch(error){throw new GateError(`invalid JSON: ${error.message}`);}
        }
      }
      throw new GateError('invalid JSON: unterminated string');
    }
    if(character==='{'){
      index++;whitespace();
      const result={},keys=new Set();
      if(text[index]==='}'){index++;return result;}
      while(true){
        whitespace();
        if(text[index]!=='"')throw new GateError('invalid JSON: object key must be a string');
        const key=value(depth+1);
        if(keys.has(key))throw new GateError(`JSON contains duplicate key: ${key}`);
        keys.add(key);whitespace();
        if(text[index++]!==':')throw new GateError("invalid JSON: expected ':'");
        define(result,key,value(depth+1));whitespace();
        if(text[index]==='}'){index++;return result;}
        if(text[index++]!==',')throw new GateError("invalid JSON: expected ',' or '}'");
      }
    }
    if(character==='['){
      index++;whitespace();
      const result=[];
      if(text[index]===']'){index++;return result;}
      while(true){
        result.push(value(depth+1));whitespace();
        if(text[index]===']'){index++;return result;}
        if(text[index++]!==',')throw new GateError("invalid JSON: expected ',' or ']'");
      }
    }
    for(const [literal,parsed] of [['true',true],['false',false],['null',null]]){
      if(text.startsWith(literal,index)){index+=literal.length;return parsed;}
    }
    const number=text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if(number){
      index+=number[0].length;
      return /^-?(?:0|[1-9]\d*)$/.test(number[0])?BigInt(number[0]):Number(number[0]);
    }
    throw new GateError(`invalid JSON near byte ${index}`);
  }
  const parsed=value();whitespace();
  if(index!==text.length)throw new GateError(`invalid JSON near byte ${index}`);
  return parsed;
}

function readText(file,label){
  if(preparationReadLimit!==null){
    try{return new TextDecoder('utf-8',{fatal:true}).decode(fileRevision(file,preparationReadLimit).bytes);}
    catch(error){if(error instanceof GateError)throw error;throw new GateError(`cannot read ${label} ${file}: ${error.message}`);}
  }
  let info;
  try{info=fs.lstatSync(file);}catch(error){
    if(error?.code==='ENOENT')throw new GateError(`${label} not found: ${file}`);
    throw new GateError(`cannot read ${label} ${file}: ${error.message}`);
  }
  if(info.isSymbolicLink())throw new GateError(`${label} must not be a symlink: ${file}`);
  if(!info.isFile())throw new GateError(`${label} must be a regular file: ${file}`);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));}
  catch(error){throw new GateError(`cannot read ${label} ${file}: ${error.message}`);}
}

function loadSchemaContract(){
  const schemaPath=fileURLToPath(new URL('../runtime/task-handoff.schema.json',import.meta.url));
  try{
    const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'));
    const properties=schema.properties;
    const verification=properties.verification.items.properties;
    const requiredFields=new Set(schema.required),allowedFields=new Set(Object.keys(properties));
    if([...requiredFields].some(key=>!allowedFields.has(key)))throw new Error('required field has no property');
    return {
      requiredHandoffFields:requiredFields,
      allowedHandoffFields:allowedFields,
      verificationFields:new Set(Object.keys(verification)),
      verificationStatuses:new Set(verification.status.enum),
      handoffStatuses:new Set(properties.status.enum),
    };
  }catch(error){throw new Error(`invalid task handoff schema: ${schemaPath}: ${error.message}`);}
}

const SCHEMA=loadSchemaContract();

function requireTaskId(value,field='task_id'){
  if(typeof value!=='string'||!TASK_RE.test(value))throw new GateError(`${field} must match T-<id>`);
  return value;
}

function requireString(value,field){
  if(typeof value!=='string'||!value.trim())throw new GateError(`${field} must be a non-empty string`);
  return value;
}

function requireStringList(value,field,minimum=0){
  if(!Array.isArray(value)||value.length<minimum)
    throw new GateError(`${field} must be a list with at least ${minimum} item(s)`);
  const items=value.map((item,index)=>requireString(item,`${field}[${index}]`));
  if(new Set(items).size!==items.length)throw new GateError(`${field} must not contain duplicates`);
  return items;
}

function requireFeature(value){
  if(!value||value==='.'||value==='..'||[' ','.'].includes(value.at(-1)))
    throw new GateError('feature must be a safe filename slug');
  if([...value].some(character=>character.codePointAt(0)<32||'<>:"/\\|?*'.includes(character)))
    throw new GateError('feature must be a safe cross-platform filename slug');
  return value;
}

function requireRelativeFiles(value){
  const files=requireStringList(value,'changed_files');
  for(const item of files){
    if(item.startsWith('/')||item.startsWith('\\')||/^[A-Za-z]:[\\/]/.test(item)||item.includes('\\')
      ||item.split('/').includes('..')||item==='.'||item==='..')
      throw new GateError(`changed_files entry must be a safe relative path: ${item}`);
  }
  return files;
}

function resolveStrictFalse(target){
  let current=path.resolve(target);const missing=[];
  while(true){
    try{return path.join(fs.realpathSync(current),...missing.reverse());}
    catch(error){
      if(error?.code!=='ENOENT')throw error;
      const parent=path.dirname(current);
      if(parent===current)throw error;
      missing.push(path.basename(current));current=parent;
    }
  }
}

export function implementationSha256(projectRoot,changedFiles){
  requireString(projectRoot,'project root');
  const expanded=projectRoot==='~'?os.homedir()
    :projectRoot.startsWith(`~${path.sep}`)?path.join(os.homedir(),projectRoot.slice(2)):projectRoot;
  let root;
  try{
    root=fs.realpathSync(path.resolve(expanded));
    if(!fs.statSync(root).isDirectory())throw new GateError(`project root is not an existing directory: ${root}`);
  }catch(error){
    if(error instanceof GateError)throw error;
    throw new GateError(`project root is not an existing directory: ${path.resolve(expanded)}`);
  }
  const digest=createHash('sha256');digest.update('cm-implementation-v1\0');
  const files=[...requireRelativeFiles(changedFiles)].sort((left,right)=>Buffer.compare(Buffer.from(left),Buffer.from(right)));
  for(const relative of files){
    const unresolved=path.join(root,...relative.split('/'));
    try{if(fs.lstatSync(unresolved).isSymbolicLink())throw new GateError(`changed file must not be a symlink: ${relative}`);}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    let candidate;
    try{candidate=resolveStrictFalse(unresolved);}
    catch(error){throw new GateError(`cannot resolve changed file ${relative}: ${error.message}`);}
    const fromRoot=path.relative(root,candidate);
    if(fromRoot===''||fromRoot==='..'||fromRoot.startsWith(`..${path.sep}`)||path.isAbsolute(fromRoot))
      throw new GateError(`changed file resolves outside project root: ${relative}`);
    digest.update(relative);digest.update('\0');
    let info;
    try{info=fs.statSync(candidate);}catch(error){
      if(error?.code==='ENOENT'){digest.update('missing\0');continue;}
      throw new GateError(`cannot read changed file ${relative}: ${error.message}`);
    }
    if(!info.isFile())throw new GateError(`changed file must be a regular file or deletion: ${relative}`);
    let content;
    try{content=fs.readFileSync(candidate);}catch(error){throw new GateError(`cannot read changed file ${relative}: ${error.message}`);}
    digest.update('file\0');digest.update(String(content.length));digest.update('\0');digest.update(content);digest.update('\0');
  }
  return digest.digest('hex');
}

function verifyImplementationBinding(payload,{projectRoot=null,allowLegacyUnbound=false}={}){
  const expected=payload.implementation_sha256;
  if(expected===undefined){
    if(allowLegacyUnbound)return false;
    throw new GateError('handoff is not content-bound; legacy recovery requires --allow-legacy-unbound');
  }
  if(projectRoot===null||projectRoot===undefined)throw new GateError('content-bound handoff requires --project-root');
  if(implementationSha256(projectRoot,payload.changed_files)!==expected)
    throw new GateError('implementation content changed after handoff');
  return true;
}

function sameSet(actual,expected){
  return actual.size===expected.size&&[...actual].every(item=>expected.has(item));
}

export function loadHandoff(handoff,{task=null,attempt=null}={}){
  let payload;
  try{payload=parseJsonStrict(readText(handoff,'handoff'));}
  catch(error){
    if(error instanceof GateError)throw error;
    throw new GateError(`cannot read handoff ${handoff}: ${error.message}`);
  }
  if(payload===null||typeof payload!=='object'||Array.isArray(payload))
    throw new GateError('handoff root must be an object');
  const fields=new Set(Object.keys(payload));
  const missing=[...SCHEMA.requiredHandoffFields].filter(field=>!fields.has(field)).sort();
  const unknown=[...fields].filter(field=>!SCHEMA.allowedHandoffFields.has(field)).sort();
  if(missing.length)throw new GateError(`handoff missing fields: ${missing.join(', ')}`);
  if(unknown.length)throw new GateError(`handoff has unknown fields: ${unknown.join(', ')}`);
  if(payload.schema_version!==1n)
    throw new GateError('schema_version must be 1');
  const taskId=requireTaskId(payload.task_id);
  if(typeof payload.attempt!=='bigint'||![1n,2n].includes(payload.attempt))
    throw new GateError('attempt must be 1 or 2');
  payload.schema_version=1;
  payload.attempt=Number(payload.attempt);
  if(!SCHEMA.handoffStatuses.has(payload.status))
    throw new GateError('status must be ready_for_review or blocked');
  requireRelativeFiles(payload.changed_files);
  if(payload.implementation_sha256!==undefined&&
    (typeof payload.implementation_sha256!=='string'||!/^[0-9a-f]{64}$/.test(payload.implementation_sha256)))
    throw new GateError('implementation_sha256 must be a lowercase SHA-256 digest');
  requireStringList(payload.evidence,'evidence',1);
  const blockers=requireStringList(payload.blockers,'blockers');
  const scopeDeviation=requireStringList(payload.scope_deviation,'scope_deviation');
  if(!Array.isArray(payload.verification)||payload.verification.length===0)
    throw new GateError('verification must contain at least one result');
  const statuses=[];
  payload.verification.forEach((item,index)=>{
    if(item===null||typeof item!=='object'||Array.isArray(item))
      throw new GateError(`verification[${index}] must be an object`);
    if(!sameSet(new Set(Object.keys(item)),SCHEMA.verificationFields))
      throw new GateError(`verification[${index}] must contain command, status, and evidence only`);
    requireString(item.command,`verification[${index}].command`);
    requireString(item.evidence,`verification[${index}].evidence`);
    if(!SCHEMA.verificationStatuses.has(item.status))
      throw new GateError(`verification[${index}].status is invalid`);
    statuses.push(item.status);
  });
  if(payload.status==='ready_for_review'){
    if(blockers.length)throw new GateError('ready_for_review handoff must not contain blockers');
    if(scopeDeviation.length)throw new GateError('ready_for_review handoff must not contain scope_deviation');
    if(statuses.some(status=>status!=='passed'))
      throw new GateError('ready_for_review handoff requires every verification result to pass');
  }else if(blockers.length===0&&scopeDeviation.length===0){
    throw new GateError('blocked handoff must explain a blocker or scope deviation');
  }
  if(task!==null&&taskId!==task)throw new GateError(`handoff task ${taskId} does not match requested task ${task}`);
  if(attempt!==null&&payload.attempt!==attempt)
    throw new GateError(`handoff attempt ${payload.attempt} does not match requested attempt ${attempt}`);
  return payload;
}

function parseReview(review){
  const lines=readText(review,'review evidence').split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if(lines.length===0||lines[0].trim()!=='---')
    throw new GateError(`review evidence has no YAML header: ${review}`);
  const end=lines.findIndex((line,index)=>index>0&&line.trim()==='---');
  if(end<0)throw new GateError(`review evidence header is not closed: ${review}`);
  const scalars={},seen=new Set(),scope=[];
  let inScope=false,scopeSeen=false;
  for(const line of lines.slice(1,end)){
    if(line.trim()==='scope:'){
      if(scopeSeen||seen.has('scope'))throw new GateError('review header contains duplicate field: scope');
      scopeSeen=true;inScope=true;continue;
    }
    if(inScope&&/^[ \t]/.test(line)){
      const stripped=line.trim();
      if(stripped.startsWith('- ')&&stripped.slice(2).trim())scope.push(stripped.slice(2).trim());
      continue;
    }
    inScope=false;
    if(/^[ \t]/.test(line)||!line.includes(':'))continue;
    const colon=line.indexOf(':'),key=line.slice(0,colon).trim();
    if(seen.has(key)||(key==='scope'&&scopeSeen))throw new GateError(`review header contains duplicate field: ${key}`);
    seen.add(key);
    const raw=line.slice(colon+1).trim();
    if(raw)define(scalars,key,raw.replace(/^["']+|["']+$/g,''));
  }
  if(scope.length===0)throw new GateError(`review evidence scope must contain at least one entry: ${review}`);
  if(new Set(scope).size!==scope.length)throw new GateError(`review evidence scope must not contain duplicates: ${review}`);
  const body=lines.slice(end+1).join('\n').trim();
  if(!body)throw new GateError(`review evidence body must not be empty: ${review}`);
  return {header:scalars,scope,body};
}

function sha256(file){
  try{
    const bytes=preparationReadLimit===null?fs.readFileSync(file):fileRevision(file,preparationReadLimit).bytes;
    return createHash('sha256').update(bytes).digest('hex');
  }
  catch(error){throw new GateError(`cannot hash evidence ${file}: ${error.message}`);}
}

function integerHeader(value,label){
  if(typeof value!=='string'||!/^[+-]?\d+$/.test(value))throw new GateError(`${label} must be an integer`);
  return BigInt(value);
}

export function validateReview(review,{task,attempt,handoff,changedFiles}){
  const {header,scope,body}=parseReview(review);
  const required=['at','reviewer','independent','task','attempt','round','verdict','handoff','handoff_sha256','blocking_findings'];
  const missing=required.filter(field=>!Object.hasOwn(header,field)).sort();
  if(missing.length)throw new GateError(`review header missing fields: ${missing.join(', ')}`);
  if(header.task!==task)throw new GateError(`review task ${header.task} does not match ${task}`);
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(header.at)||Number.isNaN(Date.parse(header.at)))
    throw new GateError('review at must include a valid ISO-8601 timezone');
  const reviewAttempt=integerHeader(header.attempt,'review attempt and round');
  const reviewRound=integerHeader(header.round,'review attempt and round');
  if(reviewAttempt!==BigInt(attempt)||reviewRound!==BigInt(attempt))
    throw new GateError('review attempt and round must match the handoff attempt');
  if(!REVIEWERS.has(header.reviewer))throw new GateError(`unsupported reviewer channel: ${header.reviewer}`);
  const independent=header.independent.toLowerCase();
  if(!['true','false'].includes(independent))throw new GateError('review independent must be true or false');
  if(header.reviewer==='self-degraded'&&independent!=='false')
    throw new GateError('self-degraded review must declare independent: false');
  if(header.reviewer!=='self-degraded'&&independent!=='true')
    throw new GateError('independent review channel must declare independent: true');
  if(!VERDICTS.has(header.verdict))throw new GateError(`unsupported review verdict: ${header.verdict}`);
  const blocking=integerHeader(header.blocking_findings,'review blocking_findings');
  if(blocking<0n)throw new GateError('review blocking_findings must not be negative');
  if(header.verdict==='approved'&&blocking!==0n)
    throw new GateError('approved review must declare blocking_findings: 0');
  if(header.verdict!=='approved'&&blocking===0n)
    throw new GateError('non-approved review must declare at least one blocking finding');
  if(header.reviewer==='self-degraded'&&!header.degraded_reason?.trim())
    throw new GateError('self-degraded review must include degraded_reason');
  if(header.verdict==='approved'&&!/(零发现|无阻塞发现|未发现阻塞|zero findings|no findings|no blocking findings)/i.test(body))
    throw new GateError('approved review body must explicitly state zero blocking findings');
  if(attempt===2&&header.verdict==='changes_requested')
    throw new GateError('round 2 blocking findings must use verdict: blocked');
  if(header.handoff!==path.basename(handoff))
    throw new GateError('review handoff does not match the current implementation evidence');
  if(!/^[0-9a-f]{64}$/.test(header.handoff_sha256))
    throw new GateError('review handoff_sha256 must be a lowercase SHA-256 digest');
  if(header.handoff_sha256!==sha256(handoff))
    throw new GateError('review handoff digest does not match the current implementation evidence');
  const missingScope=[...new Set(changedFiles)].filter(file=>!scope.includes(file)).sort();
  if(missingScope.length)throw new GateError(`review scope does not cover changed files: ${missingScope.join(', ')}`);
  return header;
}

function expectedHandoff(reviewsDir,feature,task,attempt){
  requireFeature(feature);
  return path.join(reviewsDir,`${feature}-${task}-a${attempt}-handoff.json`);
}

function requireExpectedHandoff(handoff,{reviewsDir,feature,task,attempt}){
  const expected=expectedHandoff(reviewsDir,feature,task,attempt);
  let reviewsInfo;
  try{reviewsInfo=fs.lstatSync(reviewsDir);}catch(error){throw new GateError(`cannot read reviews directory ${reviewsDir}: ${error.message}`);}
  if(reviewsInfo.isSymbolicLink()||!reviewsInfo.isDirectory())
    throw new GateError(`reviews directory must be a real directory: ${reviewsDir}`);
  let handoffInfo;
  try{handoffInfo=fs.lstatSync(handoff);}catch(error){throw new GateError(`handoff evidence not found: ${handoff}: ${error.message}`);}
  if(handoffInfo.isSymbolicLink())throw new GateError(`handoff evidence must not be a symlink: ${handoff}`);
  if(fs.realpathSync(path.dirname(handoff))!==fs.realpathSync(reviewsDir)||path.basename(handoff)!==path.basename(expected))
    throw new GateError(`handoff must use the task evidence path: ${expected}`);
}

function reviewPath(reviewsDir,feature,task,attempt){
  requireFeature(feature);return path.join(reviewsDir,`${feature}-${task}-r${attempt}.md`);
}

function validateAttemptChain(reviewsDir,feature,task,attempt){
  if(attempt!==2)return;
  const priorHandoff=expectedHandoff(reviewsDir,feature,task,1);
  requireExpectedHandoff(priorHandoff,{reviewsDir,feature,task,attempt:1});
  const priorPayload=loadHandoff(priorHandoff,{task,attempt:1});
  if(priorPayload.status!=='ready_for_review')
    throw new GateError('attempt 2 requires a ready_for_review attempt 1 handoff');
  const prior=validateReview(reviewPath(reviewsDir,feature,task,1),{
    task,attempt:1,handoff:priorHandoff,changedFiles:priorPayload.changed_files,
  });
  if(prior.verdict!=='changes_requested')
    throw new GateError('attempt 2 requires round 1 verdict: changes_requested');
}

function verifyLearningRecord(payload,projectRoot){
  const applications=payload.evidence.filter(item=>item.startsWith('learning: applied ')||item==='learning: no_relevant_lesson');
  const outcomes=payload.evidence.filter(item=>item.startsWith('learning: retrospective '));
  if(applications.length!==1||outcomes.length!==1)
    throw new GateError('Learning requires exactly one application and one retrospective record');
  if(applications[0].startsWith('learning: applied ')&&!applications[0].slice(18).trim())
    throw new GateError('Learning applied record requires a concrete lesson and action');
  if(!['learning: retrospective no_new_lesson','learning: retrospective written AGENTS.md'].includes(outcomes[0]))
    throw new GateError('Learning retrospective must be complete; pending writeback cannot pass');
  if(outcomes[0]==='learning: retrospective written AGENTS.md'){
    if(!projectRoot||!payload.changed_files.includes('AGENTS.md'))
      throw new GateError('Learning writeback requires AGENTS.md in the reviewed implementation');
    const target=path.join(projectRoot,'AGENTS.md');
    const info=fs.lstatSync(target);
    if(!info.isFile()||info.isSymbolicLink())throw new GateError('Learning AGENTS.md must be a regular file');
  }
  if(!payload.implementation_sha256||!projectRoot)
    throw new GateError('Learning requires a content-bound handoff');
}

export function checkN4({handoff,reviewsDir,feature,task,projectRoot=null,allowLegacyUnbound=false,requireLearning=false}){
  requireTaskId(task,'task');
  const payload=loadHandoff(handoff,{task});
  if(payload.status!=='ready_for_review')throw new GateError('N4 requires a ready_for_review handoff');
  if(requireLearning)verifyLearningRecord(payload,projectRoot);
  const attempt=payload.attempt;
  requireExpectedHandoff(handoff,{reviewsDir,feature,task,attempt});
  validateAttemptChain(reviewsDir,feature,task,attempt);
  const contentBound=verifyImplementationBinding(payload,{projectRoot,allowLegacyUnbound});
  return {gate:'n4',task,attempt,outcome:'ready_for_review',handoff_sha256:sha256(handoff),content_bound:contentBound};
}

export function checkN5({handoff,reviewsDir,feature,task,projectRoot=null,allowLegacyUnbound=false,requireLearning=false}){
  requireTaskId(task,'task');
  const payload=loadHandoff(handoff,{task});
  if(payload.status!=='ready_for_review')throw new GateError('N5 requires a ready_for_review handoff');
  if(requireLearning)verifyLearningRecord(payload,projectRoot);
  const attempt=payload.attempt;
  requireExpectedHandoff(handoff,{reviewsDir,feature,task,attempt});
  validateAttemptChain(reviewsDir,feature,task,attempt);
  const contentBound=verifyImplementationBinding(payload,{projectRoot,allowLegacyUnbound});
  const review=reviewPath(reviewsDir,feature,task,attempt);
  const result=validateReview(review,{task,attempt,handoff,changedFiles:payload.changed_files});
  if(result.verdict!=='approved')throw new GateError(`N5 requires verdict: approved, got ${result.verdict}`);
  if(result.independent.toLowerCase()!=='true')
    throw new GateError('N5 requires independent: true; self-degraded evidence is diagnostic only');
  return {gate:'n5',task,attempt,outcome:'approved',review:fs.realpathSync(review),content_bound:contentBound};
}

function statIdentity(info){
  return [info.dev,info.ino,info.mode,info.nlink,info.size,info.mtimeNs,info.ctimeNs].map(String);
}

function sameRevision(left,right){
  return left.path===right.path&&left.stat.every((value,index)=>value===right.stat[index])&&left.bytes.equals(right.bytes);
}

function fileRevision(file,limit=null){
  let descriptor;
  try{
    const before=fs.lstatSync(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink())
      throw new GateError(`revision source must be a regular non-symlink file: ${file}`);
    if(limit!==null&&(before.size>BigInt(limit)||before.nlink!==1n))
      throw new GateError('preparation file exceeds bound or is hardlinked');
    descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const opened=fs.fstatSync(descriptor,{bigint:true});
    const capacity=Number(before.size)+(limit===null?0:1),buffer=Buffer.alloc(capacity);
    let size=0;
    while(size<buffer.length){
      const count=fs.readSync(descriptor,buffer,size,buffer.length-size,size);
      if(count===0)break;
      size+=count;
    }
    const after=fs.fstatSync(descriptor,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
    const identity=statIdentity(before);
    if(size!==Number(before.size)||![opened,after,current].every(info=>statIdentity(info).every((value,index)=>value===identity[index])))
      throw new GateError(`revision changed while reading: ${file}`);
    return {path:fs.realpathSync(file),stat:identity,bytes:buffer.subarray(0,size)};
  }catch(error){
    if(error instanceof GateError)throw error;
    throw new GateError(`cannot pin revision for ${file}: ${error.message}`);
  }finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}

function requireRevisions(revisions){
  for(const revision of revisions)if(!sameRevision(fileRevision(revision.path,preparationReadLimit),revision))
    throw new GateError(`revision changed; refusing stale task replacement: ${revision.path}`);
}

function pinApproval(selectors){
  const {handoff,reviewsDir,feature,task}=selectors;
  requireFeature(feature);requireTaskId(task,'task');
  const revisions=[fileRevision(handoff,preparationReadLimit)];
  const payload=loadHandoff(handoff,{task});
  requireRevisions(revisions);
  for(let attempt=1;attempt<=payload.attempt;attempt++){
    for(const file of [expectedHandoff(reviewsDir,feature,task,attempt),reviewPath(reviewsDir,feature,task,attempt)]){
      const pinned=fileRevision(file,preparationReadLimit);
      if(!revisions.some(revision=>revision.path===pinned.path))revisions.push(pinned);
    }
  }
  const approval={...checkN5(selectors)};
  requireRevisions(revisions);
  return {approval,revisions};
}

function selectedTasksPath({tasksPath,reviewsDir,feature,task}){
  requireFeature(feature);requireTaskId(task,'task');
  let reviewsParent,tasksReal;
  try{
    reviewsParent=path.dirname(fs.realpathSync(reviewsDir));
    tasksReal=fs.realpathSync(tasksPath);
  }catch(error){throw new GateError(`cannot resolve task authority: ${error.message}`);}
  const allowed=new Set();
  for(const candidate of [path.join(reviewsParent,'tasks.md'),path.join(reviewsParent,feature,'tasks.md')]){
    try{allowed.add(fs.realpathSync(candidate));}catch(error){if(error?.code!=='ENOENT')throw new GateError(`cannot resolve task authority: ${error.message}`);}
  }
  let entries;
  try{entries=fs.readdirSync(reviewsParent,{withFileTypes:true});}
  catch(error){throw new GateError(`cannot read specs root ${reviewsParent}: ${error.message}`);}
  const suffix=`.${feature}`;
  for(const entry of entries){
    if(!entry.name.endsWith(suffix)||!/^[0-9]+$/.test(entry.name.slice(0,-suffix.length)))continue;
    const directory=path.join(reviewsParent,entry.name);
    try{
      if(!fs.statSync(directory).isDirectory())continue;
      allowed.add(fs.realpathSync(path.join(directory,'tasks.md')));
    }catch(error){if(error?.code!=='ENOENT')throw new GateError(`cannot resolve task authority: ${error.message}`);}
  }
  if(!allowed.has(tasksReal))
    throw new GateError(`tasks file must be the specs-local authority: ${[...allowed].sort().join(' or ')}`);
  if(fs.lstatSync(tasksPath).isSymbolicLink())throw new GateError(`tasks file must not be a symlink: ${tasksPath}`);
  return tasksReal;
}

function splitLinesKeepEnds(text){
  const lines=[];let start=0;
  for(let index=0;index<text.length;index++){
    const character=text[index];
    if(character==='\r'){
      if(text[index+1]==='\n')index++;
      lines.push({start,text:text.slice(start,index+1)});start=index+1;
    }else if(/[\n\v\f\x1c-\x1e\x85\u2028\u2029]/.test(character)){
      lines.push({start,text:text.slice(start,index+1)});start=index+1;
    }
  }
  if(start<text.length)lines.push({start,text:text.slice(start)});
  return lines;
}

function withoutLineEnding(line){return line.replace(/(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/,'');}
function escapeRegExp(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

function parseTaskTarget(task,tasksPath,revision){
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(revision.bytes);}
  catch(error){throw new GateError(`cannot read tasks file ${tasksPath}: ${error.message}`);}
  const pattern=new RegExp(`^(\\s*-\\s*)\\[([ xX])\\](\\s+${escapeRegExp(task)}(?=[:\\s]|$).*)$`);
  const matches=[];
  for(const line of splitLinesKeepEnds(text)){
    const match=pattern.exec(withoutLineEnding(line.text));
    if(match)matches.push({line,match});
  }
  if(matches.length!==1)throw new GateError(`tasks file must contain exactly one checkbox for ${task}`);
  return {text,...matches[0]};
}

function taskAfterBytes(target,original){
  if(target.match[2].toLowerCase()==='x')return original;
  const characterOffset=target.line.start+target.match[1].length+1;
  const byteOffset=Buffer.byteLength(target.text.slice(0,characterOffset));
  if(original[byteOffset]!==32)throw new GateError('task checkbox byte offset mismatch');
  return Buffer.concat([original.subarray(0,byteOffset),Buffer.from('x'),original.subarray(byteOffset+1)]);
}

function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function canonicalDigest(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function opaqueRevision(revision){
  return canonicalDigest({path:revision.path,stat:revision.stat,sha256:createHash('sha256').update(revision.bytes).digest('hex')});
}

export function prepareMarkDone(selectors){
  if(preparationReadLimit!==null)throw new GateError('nested completion preparation is unsupported');
  preparationReadLimit=PREPARATION_FILE_LIMIT;
  try{
    const tasks=selectedTasksPath(selectors),revision=fileRevision(tasks,preparationReadLimit);
    const {approval,revisions}=pinApproval(selectors);
    requireRevisions([revision]);
    const target=parseTaskTarget(selectors.task,tasks,revision),after=taskAfterBytes(target,revision.bytes);
    const physical=new Map();
    for(const pinned of revisions){
      const existing=physical.get(pinned.path);
      if(existing&&!sameRevision(existing,pinned))throw new GateError('conflicting revisions for physical preparation evidence');
      physical.set(pinned.path,pinned);
    }
    if(physical.size>4)throw new GateError('preparation evidence count exceeds bound');
    const plan={
      version:1,protocol:'cm-mark-done-plan',feature:selectors.feature,taskId:selectors.task,
      attempt:approval.attempt,tasksPath:revision.path,mode:Number(BigInt(revision.stat[2])&0o7777n),
      beforeBase64:revision.bytes.toString('base64'),afterBase64:after.toString('base64'),
      beforeDigest:createHash('sha256').update(revision.bytes).digest('hex'),
      afterDigest:createHash('sha256').update(after).digest('hex'),taskRevision:opaqueRevision(revision),
      evidence:[...physical.values()].map(item=>({path:item.path,revision:opaqueRevision(item)})).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))),
    };
    plan.planDigest=canonicalDigest(plan);
    if(Buffer.byteLength(JSON.stringify(plan))>1024*1024)throw new GateError('preparation plan exceeds bound');
    requireRevisions(revisions);requireRevisions([revision]);
    return plan;
  }finally{preparationReadLimit=null;}
}

export function verifyMarkDonePlan(selectors,expectedPlanDigest){
  if(typeof expectedPlanDigest!=='string'||!/^[0-9a-f]{64}$/.test(expectedPlanDigest))
    throw new GateError('expected plan digest must be lowercase SHA256');
  const plan=prepareMarkDone(selectors);
  if(plan.planDigest!==expectedPlanDigest)throw new GateError('preparation plan changed; refusing stale proposal');
  return {outcome:'matched',planDigest:plan.planDigest};
}

function requireTaskLockAdapter(selectors,environment){
  const expected=process.platform==='win32'
    ?path.join(fs.realpathSync(selectors.reviewsDir),'.cm-task-write.lock')
    :path.join(fs.realpathSync(selectors.reviewsDir),'.execution','writer.sqlite');
  let supplied='';
  try{supplied=pathKey(fs.realpathSync.native(environment.CM_TASK_GATE_WRITER_LOCK));}catch{}
  if(environment.CM_TASK_GATE_LOCK_ADAPTER!=='1'||Number(environment.CM_TASK_GATE_LOCK_PARENT_PID)!==process.ppid
    ||supplied!==pathKey(fs.realpathSync.native(expected)))
    throw new GateError('mark-done requires the existing task ownership lock adapter');
}

export function markDoneLocked(selectors,expectedPlanDigest,environment=process.env){
  requireTaskLockAdapter(selectors,environment);
  const plan=prepareMarkDone(selectors);
  if(plan.planDigest!==expectedPlanDigest)throw new GateError('preparation plan changed; refusing stale proposal');
  const before=Buffer.from(plan.beforeBase64,'base64'),after=Buffer.from(plan.afterBase64,'base64');
  const approval=checkN5(selectors);
  if(before.equals(after)){
    verifyMarkDonePlan(selectors,plan.planDigest);
    return {...approval,outcome:'already_done',tasks:plan.tasksPath};
  }
  const parent=path.dirname(plan.tasksPath),temporary=path.join(parent,`.${path.basename(plan.tasksPath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor,renamed=false;
  try{
    descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(descriptor,after);fs.fsyncSync(descriptor);fs.fchmodSync(descriptor,plan.mode);
    const temporaryBytes=fs.readFileSync(temporary);
    if(!temporaryBytes.equals(after)||sha256(temporary)!==plan.afterDigest)throw new GateError('temporary task bytes changed');
    fs.closeSync(descriptor);descriptor=undefined;
    verifyMarkDonePlan(selectors,plan.planDigest);
    fs.renameSync(temporary,plan.tasksPath);renamed=true;
    if(process.platform!=='win32'){
      const directory=fs.openSync(parent,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    }
    return {...approval,outcome:'marked_done',tasks:plan.tasksPath};
  }catch(error){
    if(error instanceof GateError)throw error;
    throw new GateError(`cannot atomically update tasks file ${plan.tasksPath}: ${error.message}`);
  }finally{
    if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
    if(!renamed)try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

function runGit(directory,...arguments_){
  const result=childProcess.spawnSync('git',['-C',directory,...arguments_],{encoding:'utf8'});
  if(result.error||result.status!==0){
    const detail=result.stderr?.trim()||result.stdout?.trim()||result.error?.message||'git command failed';
    throw new GateError(`git -C ${directory} ${arguments_.join(' ')}: ${detail}`);
  }
  return result.stdout.trim();
}

function pathKey(value){
  const normalized=path.normalize(value);
  return process.platform==='win32'?normalized.toLowerCase():normalized;
}

function commonGitDir(directory){
  const raw=runGit(directory,'rev-parse','--git-common-dir');
  return pathKey(fs.realpathSync.native(path.resolve(directory,raw)));
}

function registeredWorktrees(repo){
  const entries=new Map(),lines=[...runGit(repo,'worktree','list','--porcelain').split(/\r?\n/),''];
  let current=null,branch='',detached=false;
  for(const line of lines){
    if(line.startsWith('worktree ')){
      if(current!==null)entries.set(current,{branch,detached});
      current=pathKey(fs.realpathSync.native(line.slice('worktree '.length)));branch='';detached=false;
    }else if(line.startsWith('branch ')){
      branch=line.startsWith('branch refs/heads/')?line.slice('branch refs/heads/'.length):line.slice('branch '.length);
    }else if(line==='detached')detached=true;
    else if(line===''&&current!==null){entries.set(current,{branch,detached});current=null;}
  }
  return entries;
}

function parseAssignment(raw){
  const separator=raw.indexOf('=');
  if(separator<0)throw new GateError('assignment must use T-xxx=/absolute/worktree/path');
  const task=raw.slice(0,separator),rawPath=raw.slice(separator+1);
  requireTaskId(task,'assignment task');requireString(rawPath,'assignment path');
  if(!path.isAbsolute(rawPath))throw new GateError('assignment path must be absolute');
  try{return {task,worktree:fs.realpathSync.native(rawPath)};}
  catch(error){throw new GateError(`cannot resolve assignment path ${rawPath}: ${error.message}`);}
}

export function checkParallelWrite({repo,assignment}){
  let repository;
  try{repository=fs.realpathSync.native(repo);}
  catch(error){throw new GateError(`cannot resolve repository ${repo}: ${error.message}`);}
  if(!Array.isArray(assignment)||assignment.length<2)
    throw new GateError('parallel write guard requires at least two assignments');
  const baseCommon=commonGitDir(repository),registered=registeredWorktrees(repository);
  const assignments=assignment.map(parseAssignment);
  if(new Set(assignments.map(item=>item.task)).size!==assignments.length)
    throw new GateError('parallel write assignments must use unique task ids');
  if(new Set(assignments.map(item=>pathKey(item.worktree))).size!==assignments.length)
    throw new GateError('parallel write assignments must use distinct worktree paths');
  const result=[];
  for(const item of assignments){
    const metadata=registered.get(pathKey(item.worktree));
    if(!metadata)throw new GateError(`${item.task} path is not a registered worktree: ${item.worktree}`);
    if(commonGitDir(item.worktree)!==baseCommon)
      throw new GateError(`${item.task} worktree belongs to a different repository`);
    const observed=runGit(item.worktree,'branch','--show-current');
    if(metadata.detached||!metadata.branch||!observed)
      throw new GateError(`${item.task} worktree must use a non-detached branch`);
    if(metadata.branch!==observed)throw new GateError(`${item.task} branch metadata does not match the worktree`);
    result.push({...item,branch:metadata.branch});
  }
  if(new Set(result.map(item=>item.branch)).size!==result.length)
    throw new GateError('parallel write assignments must use distinct branches');
  return {gate:'parallel-write',outcome:'isolated',assignments:result};
}

function usage(){return 'usage: cm-task-gate.mjs {validate-handoff|hash-implementation|check-n4|check-n5|prepare-mark-done|verify-mark-done-plan|check-parallel-write} [options]';}

function parseCli(argv){
  if(argv.length===0||argv.includes('--help')||argv.includes('-h'))return {help:true};
  const command=argv[0];
  if(!['validate-handoff','hash-implementation','check-n4','check-n5','prepare-mark-done','verify-mark-done-plan','mark-done-locked','check-parallel-write'].includes(command))
    throw new GateError('unsupported command');
  const allowed=command==='validate-handoff'?new Set(['--handoff','--task','--attempt'])
    :command==='hash-implementation'?new Set(['--project-root','--file'])
    :command==='check-parallel-write'?new Set(['--repo','--assignment'])
    :new Set(['--handoff','--reviews-dir','--feature','--task','--project-root','--allow-legacy-unbound','--require-learning',
      ...(['prepare-mark-done','verify-mark-done-plan','mark-done-locked'].includes(command)?['--tasks']:[]),
      ...(['verify-mark-done-plan','mark-done-locked'].includes(command)?['--expected-plan-digest']:[])]);
  const required=command==='validate-handoff'?new Set(['--handoff','--task','--attempt'])
    :command==='hash-implementation'?new Set(['--project-root','--file'])
    :command==='check-parallel-write'?new Set(['--repo','--assignment'])
    :new Set(['--handoff','--reviews-dir','--feature','--task',
      ...(['prepare-mark-done','verify-mark-done-plan','mark-done-locked'].includes(command)?['--tasks']:[]),
      ...(['verify-mark-done-plan','mark-done-locked'].includes(command)?['--expected-plan-digest']:[])]);
  const values={command};
  for(let index=1;index<argv.length;){
    const flag=argv[index];
    if(!allowed.has(flag))throw new GateError('invalid arguments');
    if(flag==='--allow-legacy-unbound'||flag==='--require-learning'){
      const key=flag==='--require-learning'?'requireLearning':'allowLegacyUnbound';
      if(Object.hasOwn(values,key))throw new GateError(`duplicate argument: ${flag}`);
      values[key]=true;index++;continue;
    }
    const value=argv[index+1];if(value===undefined)throw new GateError('invalid arguments');
    const key={'--handoff':'handoff','--reviews-dir':'reviewsDir','--feature':'feature','--task':'task','--attempt':'attempt',
      '--tasks':'tasksPath','--expected-plan-digest':'expectedPlanDigest','--repo':'repo','--assignment':'assignment',
      '--project-root':'projectRoot','--file':'file'}[flag];
    if(['assignment','file'].includes(key)){
      if(!Object.hasOwn(values,key))values[key]=[];
      values[key].push(value);
    }else{
      if(Object.hasOwn(values,key))throw new GateError(`duplicate argument: ${flag}`);
      values[key]=value;
    }
    index+=2;
  }
  for(const flag of required){
    const key={'--handoff':'handoff','--reviews-dir':'reviewsDir','--feature':'feature','--task':'task','--attempt':'attempt',
      '--tasks':'tasksPath','--expected-plan-digest':'expectedPlanDigest','--repo':'repo','--assignment':'assignment',
      '--project-root':'projectRoot','--file':'file'}[flag];
    if(!Object.hasOwn(values,key))throw new GateError(`missing argument: ${flag}`);
  }
  if(Object.hasOwn(values,'attempt')){
    if(!/^[+-]?\d+$/.test(values.attempt))throw new GateError('attempt must be an integer');
    values.attempt=Number(values.attempt);
  }
  return values;
}

export function main(argv=process.argv.slice(2),environment=process.env){
  let args,result;
  try{
    args=parseCli(argv);
    if(args.help){process.stdout.write(`${usage()}\n`);return 0;}
    if(args.command==='validate-handoff'){
      requireTaskId(args.task,'task');
      const payload=loadHandoff(args.handoff,{task:args.task,attempt:args.attempt});
      result={gate:'handoff',task:payload.task_id,attempt:payload.attempt,outcome:payload.status};
    }else if(args.command==='hash-implementation')result={gate:'implementation-hash',
      implementation_sha256:implementationSha256(args.projectRoot,args.file),changed_files:[...args.file].sort((left,right)=>Buffer.compare(Buffer.from(left),Buffer.from(right)))};
    else if(args.command==='check-n4')result=checkN4(args);
    else if(args.command==='check-n5')result=checkN5(args);
    else if(args.command==='prepare-mark-done')result=prepareMarkDone(args);
    else if(args.command==='verify-mark-done-plan')result=verifyMarkDonePlan(args,args.expectedPlanDigest);
    else if(args.command==='mark-done-locked')result=markDoneLocked(args,args.expectedPlanDigest,environment);
    else result=checkParallelWrite(args);
  }catch(error){
    process.stderr.write(`ERROR: ${error.message}\n`);return error instanceof GateError?1:2;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);return 0;
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}
  catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}

if(isMain(process.argv[1]))process.exitCode=main();
