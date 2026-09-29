#!/usr/bin/env node
// Fixed PRD single-review recovery contract. No provider dispatch or task writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {fileURLToPath} from 'node:url';
import {acceptsPrdSplitDesign} from '../runtime/js/cm-prd/split-design.mjs';
import {inspectPrdFailedCorrection} from '../runtime/js/cm-prd/failed-correction.mjs';
import {normalizeRuntimeMarks} from './cm-spec-manifest.mjs';
import {tagDiagnosticReason} from '../runtime/js/cm-ai/diagnostic-reason.mjs';

// Messages stay byte-identical for the CLI and its Python oracle. Hosts get a stable
// code, plus an operator reason made of named fields only: review file names and
// specs-relative artifact paths, never file contents or absolute paths.
const fail=(message,code,reason=null)=>{
  const error=new Error(message);error.code=code;
  throw reason===null?error:tagDiagnosticReason(error,reason);
};
const need=(ok,message,code,reason=null)=>{
  // Checked on every call, not only on refusal, so a call site without a code fails its own tests.
  if(typeof code!=='string'||!/^prd_[a-z0-9_]+$/.test(code))fail('PRD review gate refusal has no stable code','prd_review_code_missing');
  if(!ok)fail(message,code,typeof reason==='function'?reason():reason);
};
const reviewFile=p=>`${path.basename(path.dirname(p))}/${path.basename(p)}`;
// JSON.parse raises a code-less SyntaxError; keep its message, add the stable code.
const parseJson=(text,code,reason)=>{
  try{return JSON.parse(text);}
  catch(error){if(typeof error?.code!=='string')error.code=code;throw tagDiagnosticReason(error,reason);}
};
// Invalid UTF-8 keeps the decoder's message (CLI parity) but refuses with the caller's code and file name.
const decode=(bytes,code,reason,options={})=>{
  try{return new TextDecoder('utf-8',{fatal:true,...options}).decode(bytes);}
  catch(error){fail(error.message,code,reason);}
};
// Filesystem errors (EACCES, EISDIR, ...) carry the absolute path as a property that host
// diagnostics would print. Refuse with the caller's code and a specs-relative name instead;
// the message stays the system's own for CLI parity.
const bytesOf=(p,code,reason)=>{try{return fs.readFileSync(p);}catch(error){fail(error.message,code,reason);}};
const read=(p,code,reason)=>decode(bytesOf(p,code,reason),code,reason,{ignoreBOM:true});
const hash=(p,code,reason)=>createHash('sha256').update(bytesOf(p,code,reason)).digest('hex');
const stat=p=>{try{return fs.statSync(p);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;
  fail(e.message,'prd_review_path_invalid',{file:reviewFile(p)});}};
const link=p=>{try{return fs.lstatSync(p).isSymbolicLink();}catch(e){if(e.code==='ENOENT')return false;
  fail(e.message,'prd_review_path_invalid',{file:reviewFile(p)});}};
const keys=(v,names)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...names].sort().join('|');
const dispositions=['applied','escalated','no_findings','self_check_failed'];
// Python str.strip/re \s exclude BOM and include these Unicode whitespace chars.
const whitespace='[\\x09-\\x0d\\x1c-\\x20\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const strip=value=>value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`,'g'),'');
function resolve(p,depth=0){
  need(depth<64,'path resolution limit','prd_review_path_invalid');
  p=p==='~'?os.homedir():p.startsWith('~/')?os.homedir()+'/'+p.slice(2):p;
  try{return fs.realpathSync.native(p);}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
  if(link(p)){
    const target=fs.readlinkSync(p);
    return resolve(path.isAbsolute(target)?target:path.dirname(p)+'/'+target,depth+1);
  }
  const parent=path.dirname(p);need(parent!==p,'cannot resolve path','prd_review_path_invalid');
  return path.resolve(resolve(parent,depth+1),path.basename(p));
}
function within(root,p){const rel=path.relative(root,p);return rel!==''&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}
// `receipt` names the receipt (specs-relative) the counts belong to; every refusal names its field.
function counts(disposition,total,unresolved,receipt=null){
  const field=name=>()=>({...(receipt?{receipt}:{}),field:name});
  need(dispositions.includes(disposition),'invalid disposition','prd_review_disposition_invalid',field('disposition'));
  need(Number.isSafeInteger(total)&&total>=0,'finding counts must be non-negative integers','prd_review_counts_invalid',field('finding_count'));
  need(Number.isSafeInteger(unresolved)&&unresolved>=0,'finding counts must be non-negative integers','prd_review_counts_invalid',field('unresolved_count'));
  need(unresolved<=total,'unresolved_count cannot exceed finding_count','prd_review_counts_invalid',field('unresolved_count'));
  need(!['applied','no_findings'].includes(disposition)||unresolved===0,'completed disposition cannot retain unresolved findings','prd_review_counts_invalid',field('unresolved_count'));
  need(disposition!=='no_findings'||total===0,'no_findings disposition requires finding_count 0','prd_review_counts_invalid',field('finding_count'));
  need(disposition!=='self_check_failed'||total>0&&unresolved===total,'failed check requires all findings pending human ruling','prd_review_counts_invalid',field('unresolved_count'));
  need(disposition!=='escalated'||unresolved>0,'escalated disposition requires unresolved findings','prd_review_counts_invalid',field('unresolved_count'));
}
function timestamp(value,file){
  if(typeof value==='string')value=value.replaceAll('Z','+00:00');
  // Match the repository's Python 3.9 datetime.fromisoformat grammar; Date.parse
  // alone accepts non-ISO prose and silently rolls invalid calendar dates over.
  const m=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})[\s\S](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(?:\d{3}|\d{6}))?)?)?(?:Z|[+-](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)$(?![\s\S])/.exec(value);
  need(m,'PRD review timestamp must be ISO-8601 with a timezone','prd_review_record_timestamp_invalid',()=>({file:reviewFile(file),field:'at'}));
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  need(year>=1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]
    &&Number(m[4])<24&&Number(m[5]??0)<60&&Number(m[6]??0)<60
    &&Number(m[7]??0)*3600+Number(m[8]??0)*60+Number(m[9]??0)+Number('0.'+(m[10]??'0'))<86400,
    'PRD review timestamp is invalid','prd_review_record_timestamp_invalid',()=>({file:reviewFile(file),field:'at'}));
}
function paths(args){
  need(typeof args.feature==='string'&&args.feature.length>0&&!/[<>:"/\\|?*\x00-\x1f]/.test(args.feature)
    &&!['.','..'].includes(args.feature)&&!/[ .]$/.test(args.feature),'feature must be a safe filename slug','prd_review_feature_invalid');
  need(['design','split'].includes(args.stage),'invalid stage','prd_review_stage_invalid');
  const evidence=resolve(args.evidence),receipt=resolve(args.receipt),prefix=`prd-${args.feature}-${args.stage}`;
  need(path.basename(evidence)===prefix+'-r1.md',`evidence must use ${prefix}-r1.md`,'prd_review_path_invalid');
  need(path.basename(receipt)===prefix+'-disposition.json'&&path.dirname(receipt)===path.dirname(evidence),
    `receipt must be adjacent and use ${prefix}-disposition.json`,'prd_review_path_invalid');
  need(!link(path.dirname(evidence)),'review directory must not be a symlink','prd_review_path_invalid');
  need(!stat(path.join(path.dirname(evidence),prefix+'-r2.md')),'single-attempt PRD review forbids r2 evidence','prd_review_r2_forbidden',
    ()=>({evidence:reviewFile(path.join(path.dirname(evidence),prefix+'-r2.md'))}));
  return {evidence,receipt};
}
function evidenceHeader(file){
  const where=field=>()=>({evidence:reviewFile(file),...(field?{field}:{})});
  need(!link(file),'PRD review evidence must not be a symlink','prd_review_evidence_invalid',where());
  const lines=read(file,'prd_review_evidence_invalid',where()()).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  need(strip(lines[0]??'')==='---','PRD review evidence must start with a YAML header','prd_review_evidence_invalid',where());
  const end=lines.findIndex((line,i)=>i>0&&strip(line)==='---');need(end>0,'PRD review evidence header is not closed','prd_review_evidence_invalid',where());
  const fields=new Map(),scope=[];let inScope=false;
  for(const line of lines.slice(1,end)){
    const field=new RegExp(`^([A-Za-z_][A-Za-z0-9_-]*):${whitespace}*(.*)$`).exec(line);
    if(field){need(!fields.has(field[1]),`PRD review evidence duplicates ${field[1]}`,'prd_review_evidence_invalid',where());
      fields.set(field[1],strip(field[2]));inScope=field[1]==='scope';continue;}
    const item=new RegExp(`^${whitespace}+-${whitespace}+(.+)$`).exec(line);
    if(inScope&&item){scope.push(strip(item[1]));continue;}
    need(!strip(line),'PRD review evidence header contains invalid YAML','prd_review_evidence_invalid',where());
  }
  for(const key of ['at','reviewer','independent','scope'])need(fields.has(key),`PRD review evidence is missing ${key}`,'prd_review_evidence_invalid',where(key));
  const reviewer=fields.get('reviewer');
  need(['codex-subagent','codex-cli','self-degraded'].includes(reviewer),'PRD review evidence reviewer is not a supported channel','prd_review_evidence_invalid',where('reviewer'));
  need(reviewer==='self-degraded'?fields.get('independent')==='false'&&Boolean(fields.get('degraded_reason'))
    :fields.get('independent')==='true','PRD review independence evidence invalid','prd_review_evidence_invalid',where('independent'));
  need(!fields.get('scope')&&scope.length>0&&scope.every(Boolean),'PRD review evidence scope must be a non-empty list','prd_review_evidence_invalid',where('scope'));
  timestamp(fields.get('at'),file);need(strip(lines.slice(end+1).join('\n')),'PRD review evidence body must not be empty','prd_review_evidence_invalid',where());
}
function loadReceipt(file,args,evidence){
  const receipt=reviewFile(file),where=()=>({receipt});
  need(!link(file),'PRD review receipt must not be a symlink','prd_review_receipt_invalid',where);
  const value=parseJson(read(file,'prd_review_receipt_invalid',where()),'prd_review_receipt_invalid',where());
  need(keys(value,['schema_version','stage','feature','status','disposition','finding_count','unresolved_count',
    'evidence','evidence_sha256','artifacts','at',...(value?.disposition==='self_check_failed'?['correction_check']:[])]),'PRD review receipt fields do not match the contract','prd_review_receipt_invalid',where);
  need(value.schema_version===1&&value.stage===args.stage&&value.feature===args.feature&&value.status==='completed'
    &&value.evidence===path.basename(evidence)&&value.evidence_sha256===hash(evidence,'prd_review_evidence_invalid',{evidence:reviewFile(evidence)}),'PRD review receipt does not match current evidence',
    'prd_review_receipt_evidence_mismatch',()=>({receipt,evidence:reviewFile(evidence)}));
  counts(value.disposition,value.finding_count,value.unresolved_count,receipt);timestamp(value.at,file);
  if(value.disposition==='self_check_failed')need(value.stage==='split','prd_failed_check_split_only','prd_failed_check_split_only',where);
  need(Array.isArray(value.artifacts)&&value.artifacts.length>0,'PRD review receipt must contain artifact hashes','prd_review_receipt_invalid',where);
  const root=resolve(path.dirname(path.dirname(file))),seen=new Set();
  for(const item of value.artifacts){
    need(keys(item,['path','sha256'])&&typeof item.path==='string'&&typeof item.sha256==='string'
      &&/^[0-9a-f]{64}$/.test(item.sha256),'PRD review receipt contains an invalid artifact','prd_review_receipt_invalid',where);
    // The raw path is untrusted until checked: the refusal names only the receipt.
    need(!item.path.startsWith('/')&&!item.path.includes('\\')&&!item.path.split('/').includes('..')&&!seen.has(item.path),
      'PRD review receipt contains an unsafe artifact path','prd_review_artifact_unsafe',where);seen.add(item.path);
    const named=()=>({receipt,artifact:item.path});
    const raw=path.join(root,item.path);need(!link(raw),'PRD review artifact is missing or unsafe','prd_review_artifact_unsafe',named);
    const artifact=resolve(raw);need(within(root,artifact),'PRD review artifact escapes the specs directory','prd_review_artifact_unsafe',named);
    need(stat(artifact)?.isFile(),'PRD review artifact is missing or unsafe','prd_review_artifact_unsafe',named);
    const bytes=bytesOf(artifact,'prd_review_artifact_unsafe',named());
    const currentSha=createHash('sha256').update(bytes).digest('hex');
    const completedSplit=value.stage==='design'&&item.path.endsWith('/design.md')
      &&stat(path.join(path.dirname(file),`prd-${value.feature}-split-disposition.json`));
    if(currentSha!==item.sha256||completedSplit){
      const accepted=acceptsPrdSplitDesign({specs:root,evidence:path.relative(root,evidence).split(path.sep).join('/'),
        receipt:value,item,currentSha,pendingSplit:args.pendingSplit??null});
      if(accepted===true)continue;
      if(completedSplit&&accepted!==null)need(false,'prd_design_receipt_changed','prd_design_receipt_changed',named);
      if(currentSha===item.sha256)continue;
      const text=bytes.toString('utf8');
      need(path.extname(artifact)==='.md'&&Buffer.from(text,'utf8').equals(bytes)
        &&[false,true].some(legacy=>createHash('sha256').update(normalizeRuntimeMarks(text,path.basename(artifact),{legacy})).digest('hex')===item.sha256),
        'PRD review artifact changed after disposition','prd_review_artifact_changed',
        ()=>({receipt,artifact:item.path,recordedSha256:item.sha256,currentSha256:currentSha}));
      value.runtimeMarksNormalized=true;
    }
  }
  if(value.disposition==='self_check_failed')inspectPrdFailedCorrection({specs:root,receipt:value});
  return value;
}
function dispatchFile(evidence){return evidence.replace(/-r1\.md$/,'-dispatch.json');}
function loadDispatch(file,args){
  const where=()=>({dispatch:reviewFile(file)});
  let info;try{info=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;fail(error.message,'prd_review_dispatch_invalid',where());}
  need(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=4096&&resolve(file)===file,'unsafe PRD dispatch record','prd_review_dispatch_invalid',where);
  let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error){fail(error.message,'prd_review_dispatch_invalid',where());}
  let value;
  try{
    let opened,bytes=Buffer.alloc(4097),count;
    try{opened=fs.fstatSync(fd);count=fs.readSync(fd,bytes,0,bytes.length,0);}catch(error){fail(error.message,'prd_review_dispatch_invalid',where());}
    need(opened.isFile()&&opened.nlink===1&&count===opened.size&&count<=4096,'invalid PRD dispatch record','prd_review_dispatch_invalid',where);
    value=parseJson(decode(bytes.subarray(0,count),'prd_review_dispatch_invalid',where()),'prd_review_dispatch_invalid',where());
  }finally{fs.closeSync(fd);}
  need(keys(value,['schema_version','stage','feature','package_sha256','status','at'])
    &&value.schema_version===1&&value.stage===args.stage&&value.feature===args.feature&&value.status==='started'
    &&typeof value.package_sha256==='string'&&/^[0-9a-f]{64}$/.test(value.package_sha256),'invalid PRD dispatch record','prd_review_dispatch_invalid',where);
  timestamp(value.at,file);return value;
}
export function claimPrdReview(args){
  const {evidence,receipt}=paths(args),directory=path.dirname(evidence),file=dispatchFile(evidence);
  need(path.resolve(args.evidence)===evidence&&path.resolve(args.receipt)===receipt
    &&fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),'unsafe PRD dispatch directory','prd_review_dispatch_invalid',
    ()=>({dispatch:reviewFile(file)}));
  need(typeof args.package_sha256==='string'&&/^[0-9a-f]{64}$/.test(args.package_sha256),'invalid package digest','prd_review_package_digest_invalid');
  need(inspectPrdReview(args).outcome==='dispatch_once','PRD review attempt already consumed','prd_review_attempt_consumed',()=>({dispatch:reviewFile(file)}));
  const value={schema_version:1,stage:args.stage,feature:args.feature,package_sha256:args.package_sha256,
    status:'started',at:new Date().toISOString()};
  // Exclusive creation arbitrates competing callers. Partial/uncertain records
  // deliberately remain blocking; there is no delete/reset/retry operation.
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(process.platform!=='win32'){
    const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
  }
  paths(args);need(!stat(evidence)&&!stat(receipt),'PRD evidence appeared during claim; do not dispatch','prd_review_claim_conflict',
    ()=>({evidence:reviewFile(evidence),receipt:reviewFile(receipt)}));
  loadDispatch(file,args);
  return {stage:args.stage,feature:args.feature,outcome:'dispatch_claimed',dispatch_record:file,
    package_sha256:args.package_sha256,providerAuthorized:false,completionAuthorized:false};
}
export function inspectPrdReview(args){
  const {evidence,receipt}=paths(args);
  const dispatch=loadDispatch(dispatchFile(evidence),args);
  const base={stage:args.stage,feature:args.feature,...(dispatch?{package_sha256:dispatch.package_sha256}:{})};
  need(!stat(receipt)||stat(evidence)?.isFile(),'PRD review receipt exists without its r1 evidence','prd_review_evidence_missing',
    ()=>({receipt:reviewFile(receipt),evidence:reviewFile(evidence)}));
  if(!stat(evidence))return dispatch?{...base,outcome:'dispatch_unknown',package_sha256:dispatch.package_sha256}:
    {...base,outcome:'dispatch_once'};
  evidenceHeader(evidence);if(!stat(receipt))return {...base,outcome:'resume_disposition'};
  const value=loadReceipt(receipt,args,evidence);return {...base,outcome:'completed',disposition:value.disposition,
    ...(value.runtimeMarksNormalized?{runtimeMarksNormalized:true}:{})};
}
export function recordPrdReview(args){
  counts(args.disposition,args.finding_count,args.unresolved_count,typeof args.receipt==='string'?reviewFile(args.receipt):null);
  if(args.disposition==='self_check_failed'){
    need(args.stage==='split','prd_failed_check_split_only','prd_failed_check_split_only');
    need(args.correction_check,'prd_failed_check_evidence_required','prd_failed_check_evidence_required');
  }
  const {evidence,receipt}=paths(args),base={stage:args.stage,feature:args.feature};evidenceHeader(evidence);
  if(stat(receipt)){loadReceipt(receipt,args,evidence);return {...base,outcome:'already_recorded'};}
  const root=resolve(path.dirname(path.dirname(receipt))),seen=new Set();
  need(Array.isArray(args.artifact)&&args.artifact.length>0,'artifact required','prd_review_artifact_required');
  const artifacts=args.artifact.map(raw=>{
    const file=resolve(raw);need(stat(file)?.isFile()&&!link(file),'artifact must be a regular non-symlink file','prd_review_artifact_unsafe');
    need(within(root,file),'artifact must stay inside the specs directory','prd_review_artifact_unsafe');
    const relative=path.relative(root,file).split(path.sep).join('/');need(!seen.has(relative),'artifact must not be duplicated','prd_review_artifact_duplicate',()=>({artifact:relative}));
    seen.add(relative);return {path:relative,sha256:hash(file,'prd_review_artifact_unsafe',{artifact:relative})};
  });
  const value={schema_version:1,...base,status:'completed',disposition:args.disposition,finding_count:args.finding_count,
    unresolved_count:args.unresolved_count,evidence:path.basename(evidence),evidence_sha256:hash(evidence,'prd_review_evidence_invalid',{evidence:reviewFile(evidence)}),artifacts,
    at:new Date().toISOString().replace(/\.\d{3}Z$/,'+00:00'),
    ...(args.disposition==='self_check_failed'?{correction_check:args.correction_check}:{})};
  if(value.disposition==='self_check_failed')inspectPrdFailedCorrection({specs:root,receipt:value});
  const temp=path.join(path.dirname(receipt),`.${path.basename(receipt)}.${randomUUID()}`);let fd;
  try{
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temp,receipt);}
    catch(error){fail(error.message,'prd_review_receipt_write_failed',{receipt:reviewFile(receipt)});}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {...base,outcome:'recorded'};
}
export function main(argv=process.argv.slice(2)){
  try{
    const [command,...flags]=argv;need(['inspect','record','claim'].includes(command),'expected inspect, record or claim','prd_review_arguments_invalid');
    const args={},allowed=['stage','feature','evidence','receipt',...(command==='record'?['artifact','disposition','finding-count','unresolved-count']:command==='claim'?['package-sha256']:[])];
    for(let i=0;i<flags.length;i++){
      const flag=flags[i],equal=flag.indexOf('='),key=flag.slice(2,equal<0?undefined:equal);
      need(flag.startsWith('--')&&allowed.includes(key),'invalid arguments','prd_review_arguments_invalid');
      const value=equal<0?flags[++i]:flag.slice(equal+1);need(value!==undefined,'missing argument','prd_review_arguments_invalid');
      if(key==='artifact')(args.artifact??=[]).push(value);else args[key.replaceAll('-','_')]=value;
    }
    for(const key of allowed)need(Object.hasOwn(args,key.replaceAll('-','_')),'missing required argument','prd_review_arguments_invalid');
    for(const key of ['finding_count','unresolved_count'])if(Object.hasOwn(args,key)){
      need(/^[+-]?\d+$/.test(args[key]),'invalid finding count','prd_review_arguments_invalid');args[key]=Number(args[key]);}
    const result=command==='inspect'?inspectPrdReview(args):command==='claim'?claimPrdReview(args):recordPrdReview(args);
    process.stdout.write(JSON.stringify(result)+'\n');return 0;
  }catch(error){process.stderr.write(`cm-prd-review-gate: ${error.message}\n`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
