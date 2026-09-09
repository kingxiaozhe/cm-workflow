#!/usr/bin/env node
// Fixed PRD single-review recovery contract. No provider dispatch or task writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {fileURLToPath} from 'node:url';

const fail=message=>{throw new Error(message);};
const need=(ok,message)=>{if(!ok)fail(message);};
const read=p=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(fs.readFileSync(p));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const stat=p=>{try{return fs.statSync(p);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}};
const link=p=>{try{return fs.lstatSync(p).isSymbolicLink();}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const keys=(v,names)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...names].sort().join('|');
const dispositions=['applied','escalated','no_findings'];
// Python str.strip/re \s exclude BOM and include these Unicode whitespace chars.
const whitespace='[\\x09-\\x0d\\x1c-\\x20\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const strip=value=>value.replace(new RegExp(`^${whitespace}+|${whitespace}+$`,'g'),'');
function resolve(p,depth=0){
  need(depth<64,'path resolution limit');
  p=p==='~'?os.homedir():p.startsWith('~/')?os.homedir()+'/'+p.slice(2):p;
  try{return fs.realpathSync.native(p);}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;}
  if(link(p)){
    const target=fs.readlinkSync(p);
    return resolve(path.isAbsolute(target)?target:path.dirname(p)+'/'+target,depth+1);
  }
  const parent=path.dirname(p);need(parent!==p,'cannot resolve path');
  return path.resolve(resolve(parent,depth+1),path.basename(p));
}
function within(root,p){const rel=path.relative(root,p);return rel!==''&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);}
function counts(disposition,total,unresolved){
  need(dispositions.includes(disposition),'invalid disposition');
  need(Number.isSafeInteger(total)&&Number.isSafeInteger(unresolved)&&total>=0&&unresolved>=0,'finding counts must be non-negative integers');
  need(unresolved<=total,'unresolved_count cannot exceed finding_count');
  need(!['applied','no_findings'].includes(disposition)||unresolved===0,'completed disposition cannot retain unresolved findings');
  need(disposition!=='no_findings'||total===0,'no_findings disposition requires finding_count 0');
  need(disposition!=='escalated'||unresolved>0,'escalated disposition requires unresolved findings');
}
function timestamp(value){
  if(typeof value==='string')value=value.replaceAll('Z','+00:00');
  // Match the repository's Python 3.9 datetime.fromisoformat grammar; Date.parse
  // alone accepts non-ISO prose and silently rolls invalid calendar dates over.
  const m=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})[\s\S](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(?:\d{3}|\d{6}))?)?)?(?:Z|[+-](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}|\d{6}))?)?)$(?![\s\S])/.exec(value);
  need(m,'PRD review timestamp must be ISO-8601 with a timezone');
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  need(year>=1&&month>=1&&month<=12&&day>=1&&day<=days[month-1]
    &&Number(m[4])<24&&Number(m[5]??0)<60&&Number(m[6]??0)<60
    &&Number(m[7]??0)*3600+Number(m[8]??0)*60+Number(m[9]??0)+Number('0.'+(m[10]??'0'))<86400,
    'PRD review timestamp is invalid');
}
function paths(args){
  need(typeof args.feature==='string'&&args.feature.length>0&&!/[<>:"/\\|?*\x00-\x1f]/.test(args.feature)
    &&!['.','..'].includes(args.feature)&&!/[ .]$/.test(args.feature),'feature must be a safe filename slug');
  need(['design','split'].includes(args.stage),'invalid stage');
  const evidence=resolve(args.evidence),receipt=resolve(args.receipt),prefix=`prd-${args.feature}-${args.stage}`;
  need(path.basename(evidence)===prefix+'-r1.md',`evidence must use ${prefix}-r1.md`);
  need(path.basename(receipt)===prefix+'-disposition.json'&&path.dirname(receipt)===path.dirname(evidence),
    `receipt must be adjacent and use ${prefix}-disposition.json`);
  need(!link(path.dirname(evidence)),'review directory must not be a symlink');
  need(!stat(path.join(path.dirname(evidence),prefix+'-r2.md')),'single-attempt PRD review forbids r2 evidence');
  return {evidence,receipt};
}
function evidenceHeader(file){
  need(!link(file),'PRD review evidence must not be a symlink');
  const lines=read(file).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  need(strip(lines[0]??'')==='---','PRD review evidence must start with a YAML header');
  const end=lines.findIndex((line,i)=>i>0&&strip(line)==='---');need(end>0,'PRD review evidence header is not closed');
  const fields=new Map(),scope=[];let inScope=false;
  for(const line of lines.slice(1,end)){
    const field=new RegExp(`^([A-Za-z_][A-Za-z0-9_-]*):${whitespace}*(.*)$`).exec(line);
    if(field){need(!fields.has(field[1]),`PRD review evidence duplicates ${field[1]}`);
      fields.set(field[1],strip(field[2]));inScope=field[1]==='scope';continue;}
    const item=new RegExp(`^${whitespace}+-${whitespace}+(.+)$`).exec(line);
    if(inScope&&item){scope.push(strip(item[1]));continue;}
    need(!strip(line),'PRD review evidence header contains invalid YAML');
  }
  for(const key of ['at','reviewer','independent','scope'])need(fields.has(key),`PRD review evidence is missing ${key}`);
  const reviewer=fields.get('reviewer');
  need(['codex-subagent','codex-cli','self-degraded'].includes(reviewer),'PRD review evidence reviewer is not a supported channel');
  need(reviewer==='self-degraded'?fields.get('independent')==='false'&&Boolean(fields.get('degraded_reason'))
    :fields.get('independent')==='true','PRD review independence evidence invalid');
  need(!fields.get('scope')&&scope.length>0&&scope.every(Boolean),'PRD review evidence scope must be a non-empty list');
  timestamp(fields.get('at'));need(strip(lines.slice(end+1).join('\n')),'PRD review evidence body must not be empty');
}
function loadReceipt(file,args,evidence){
  need(!link(file),'PRD review receipt must not be a symlink');
  const value=JSON.parse(read(file));
  need(keys(value,['schema_version','stage','feature','status','disposition','finding_count','unresolved_count',
    'evidence','evidence_sha256','artifacts','at']),'PRD review receipt fields do not match the contract');
  need(value.schema_version===1&&value.stage===args.stage&&value.feature===args.feature&&value.status==='completed'
    &&value.evidence===path.basename(evidence)&&value.evidence_sha256===hash(evidence),'PRD review receipt does not match current evidence');
  counts(value.disposition,value.finding_count,value.unresolved_count);timestamp(value.at);
  need(Array.isArray(value.artifacts)&&value.artifacts.length>0,'PRD review receipt must contain artifact hashes');
  const root=resolve(path.dirname(path.dirname(file))),seen=new Set();
  for(const item of value.artifacts){
    need(keys(item,['path','sha256'])&&typeof item.path==='string'&&typeof item.sha256==='string'
      &&/^[0-9a-f]{64}$/.test(item.sha256),'PRD review receipt contains an invalid artifact');
    need(!item.path.startsWith('/')&&!item.path.includes('\\')&&!item.path.split('/').includes('..')&&!seen.has(item.path),
      'PRD review receipt contains an unsafe artifact path');seen.add(item.path);
    const raw=path.join(root,item.path);need(!link(raw),'PRD review artifact is missing or unsafe');
    const artifact=resolve(raw);need(within(root,artifact),'PRD review artifact escapes the specs directory');
    need(stat(artifact)?.isFile(),'PRD review artifact is missing or unsafe');
    need(hash(artifact)===item.sha256,'PRD review artifact changed after disposition');
  }
  return value;
}
function dispatchFile(evidence){return evidence.replace(/-r1\.md$/,'-dispatch.json');}
function loadDispatch(file,args){
  let info;try{info=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  need(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=4096&&resolve(file)===file,'unsafe PRD dispatch record');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let value;
  try{
    const opened=fs.fstatSync(fd),bytes=Buffer.alloc(4097),count=fs.readSync(fd,bytes,0,bytes.length,0);
    need(opened.isFile()&&opened.nlink===1&&count===opened.size&&count<=4096,'invalid PRD dispatch record');
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
  }finally{fs.closeSync(fd);}
  need(keys(value,['schema_version','stage','feature','package_sha256','status','at'])
    &&value.schema_version===1&&value.stage===args.stage&&value.feature===args.feature&&value.status==='started'
    &&typeof value.package_sha256==='string'&&/^[0-9a-f]{64}$/.test(value.package_sha256),'invalid PRD dispatch record');
  timestamp(value.at);return value;
}
export function claimPrdReview(args){
  const {evidence,receipt}=paths(args),directory=path.dirname(evidence),file=dispatchFile(evidence);
  need(path.resolve(args.evidence)===evidence&&path.resolve(args.receipt)===receipt
    &&fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink(),'unsafe PRD dispatch directory');
  need(typeof args.package_sha256==='string'&&/^[0-9a-f]{64}$/.test(args.package_sha256),'invalid package digest');
  need(inspectPrdReview(args).outcome==='dispatch_once','PRD review attempt already consumed');
  const value={schema_version:1,stage:args.stage,feature:args.feature,package_sha256:args.package_sha256,
    status:'started',at:new Date().toISOString()};
  // Exclusive creation arbitrates competing callers. Partial/uncertain records
  // deliberately remain blocking; there is no delete/reset/retry operation.
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(process.platform!=='win32'){
    const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
  }
  paths(args);need(!stat(evidence)&&!stat(receipt),'PRD evidence appeared during claim; do not dispatch');
  loadDispatch(file,args);
  return {stage:args.stage,feature:args.feature,outcome:'dispatch_claimed',dispatch_record:file,
    package_sha256:args.package_sha256,providerAuthorized:false,completionAuthorized:false};
}
export function inspectPrdReview(args){
  const {evidence,receipt}=paths(args);
  const dispatch=loadDispatch(dispatchFile(evidence),args);
  const base={stage:args.stage,feature:args.feature,...(dispatch?{package_sha256:dispatch.package_sha256}:{})};
  need(!stat(receipt)||stat(evidence)?.isFile(),'PRD review receipt exists without its r1 evidence');
  if(!stat(evidence))return dispatch?{...base,outcome:'dispatch_unknown',package_sha256:dispatch.package_sha256}:
    {...base,outcome:'dispatch_once'};
  evidenceHeader(evidence);if(!stat(receipt))return {...base,outcome:'resume_disposition'};
  const value=loadReceipt(receipt,args,evidence);return {...base,outcome:'completed',disposition:value.disposition};
}
export function recordPrdReview(args){
  counts(args.disposition,args.finding_count,args.unresolved_count);
  const {evidence,receipt}=paths(args),base={stage:args.stage,feature:args.feature};evidenceHeader(evidence);
  if(stat(receipt)){loadReceipt(receipt,args,evidence);return {...base,outcome:'already_recorded'};}
  const root=resolve(path.dirname(path.dirname(receipt))),seen=new Set();
  need(Array.isArray(args.artifact)&&args.artifact.length>0,'artifact required');
  const artifacts=args.artifact.map(raw=>{
    const file=resolve(raw);need(stat(file)?.isFile()&&!link(file),'artifact must be a regular non-symlink file');
    need(within(root,file),'artifact must stay inside the specs directory');
    const relative=path.relative(root,file).split(path.sep).join('/');need(!seen.has(relative),'artifact must not be duplicated');
    seen.add(relative);return {path:relative,sha256:hash(file)};
  });
  const value={schema_version:1,...base,status:'completed',disposition:args.disposition,finding_count:args.finding_count,
    unresolved_count:args.unresolved_count,evidence:path.basename(evidence),evidence_sha256:hash(evidence),artifacts,
    at:new Date().toISOString().replace(/\.\d{3}Z$/,'+00:00')};
  const temp=path.join(path.dirname(receipt),`.${path.basename(receipt)}.${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,receipt);
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return {...base,outcome:'recorded'};
}
export function main(argv=process.argv.slice(2)){
  try{
    const [command,...flags]=argv;need(['inspect','record','claim'].includes(command),'expected inspect, record or claim');
    const args={},allowed=['stage','feature','evidence','receipt',...(command==='record'?['artifact','disposition','finding-count','unresolved-count']:command==='claim'?['package-sha256']:[])];
    for(let i=0;i<flags.length;i++){
      const flag=flags[i],equal=flag.indexOf('='),key=flag.slice(2,equal<0?undefined:equal);
      need(flag.startsWith('--')&&allowed.includes(key),'invalid arguments');
      const value=equal<0?flags[++i]:flag.slice(equal+1);need(value!==undefined,'missing argument');
      if(key==='artifact')(args.artifact??=[]).push(value);else args[key.replaceAll('-','_')]=value;
    }
    for(const key of allowed)need(Object.hasOwn(args,key.replaceAll('-','_')),'missing required argument');
    for(const key of ['finding_count','unresolved_count'])if(Object.hasOwn(args,key)){
      need(/^[+-]?\d+$/.test(args[key]),'invalid finding count');args[key]=Number(args[key]);}
    const result=command==='inspect'?inspectPrdReview(args):command==='claim'?claimPrdReview(args):recordPrdReview(args);
    process.stdout.write(JSON.stringify(result)+'\n');return 0;
  }catch(error){process.stderr.write(`cm-prd-review-gate: ${error.message}\n`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
