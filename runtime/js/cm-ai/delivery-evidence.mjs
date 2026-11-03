// Local declarations, not an authentication service or a deployment executor.
// Original execution/review evidence remains authoritative for task completion.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {digest,need,shape,hex,id,validIdentity,json,freeze} from './effect-contract.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory,attemptBaseline} from './durable-runner-state.mjs';
import {readReviewSourceFiles,verifyReviewPackage} from './review-package.mjs';
import {verifyApprovedManifest} from '../../../scripts/cm-spec-manifest.mjs';

const directory='.reviews/.delivery',MAX_RECORDS=1000;
const environmentKey=value=>value.trim().toLowerCase();
const key=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const line=value=>need(typeof value==='string'&&value.trim().length>0&&value.length<=240
  &&!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value),'delivery_invalid_text');
function rootDirectory(specsDir,create=false){
  need(typeof specsDir==='string'&&path.isAbsolute(specsDir)&&fs.realpathSync(specsDir)===specsDir,'delivery_invalid_root');
  let current=specsDir;
  for(const part of directory.split('/')){
    current=path.join(current,part);
    if(create)try{fs.mkdirSync(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    try{const stat=fs.lstatSync(current);need(stat.isDirectory()&&!stat.isSymbolicLink(),'delivery_invalid_directory');}
    catch(error){if(!create&&error.code==='ENOENT')return null;throw error;}
  }
  return current;
}
// Bounded streaming hash also supports build files larger than review text.
export function deliveryFile(file,{maxBytes=1024*1024*1024}={}){
  need(typeof file==='string'&&path.isAbsolute(file)&&fs.realpathSync(file)===file,'delivery_invalid_file');
  const before=fs.lstatSync(file,{bigint:true});
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>0n&&before.size<=1024n*1024n*1024n,'delivery_invalid_file');
  need(before.size<=BigInt(maxBytes),'delivery_evidence_budget_exceeded');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256');
  let size=0;
  try{
    need(key(fs.fstatSync(fd,{bigint:true}))===key(before),'delivery_file_changed');
    const buffer=Buffer.alloc(64*1024);
    while(true){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;
      size+=n;need(BigInt(size)<=before.size,'delivery_file_changed');hash.update(buffer.subarray(0,n));}
    need(BigInt(size)===before.size&&key(fs.fstatSync(fd,{bigint:true}))===key(before)
      &&key(fs.lstatSync(file,{bigint:true}))===key(before),'delivery_file_changed');
  }finally{fs.closeSync(fd);}
  return {path:file,sha256:hash.digest('hex'),size};
}
function validFile(file){shape(file,['path','sha256','size']);need(typeof file.path==='string'&&path.isAbsolute(file.path),'delivery_invalid_file');
  hex(file.sha256);need(Number.isSafeInteger(file.size)&&file.size>0&&file.size<=1024*1024*1024,'delivery_invalid_file');}
function validCandidate(c){
  shape(c,['version','feature','identity','packageDigest','specificationDigest','artifact','runnerRevision']);
  need(c.version===1,'delivery_invalid_candidate');line(c.feature);need(!/[\\/]/.test(c.feature)&&!['.','..'].includes(c.feature),'delivery_invalid_candidate');
  validIdentity(c.identity);[c.packageDigest,c.specificationDigest,c.runnerRevision].forEach(hex);validFile(c.artifact);
}
function validStatement(kind,s){
  shape(s,kind==='acceptance'?['actor','environment','outcome','note']:['actor','environment','execution','verification','note']);
  [s.actor,s.environment,s.note].forEach(line);
  if(kind==='acceptance')need(['accepted','rejected','revoked'].includes(s.outcome),'delivery_invalid_statement');
  else {need(['succeeded','failed'].includes(s.execution)&&['passed','failed','unknown'].includes(s.verification),'delivery_invalid_statement');
    need(s.execution==='succeeded'||s.verification!=='passed','delivery_invalid_statement');}
}
function validRecord(record,sequence,previousDigest){
  const r=json(record,32*1024);shape(r,['version','sequence','previousDigest','at','kind','candidate','statement','evidence','provenance','recordDigest']);
  need(r.version===1&&r.sequence===sequence&&r.previousDigest===previousDigest&&['acceptance','deployment'].includes(r.kind),'delivery_record_invalid');
  need(typeof r.at==='string'&&new Date(r.at).toISOString()===r.at&&r.provenance==='interactive-terminal-declaration','delivery_record_invalid');
  validCandidate(r.candidate);validStatement(r.kind,r.statement);
  shape(r.evidence,['report','verificationReport']);validFile(r.evidence.report);
  if(r.evidence.verificationReport!==null)validFile(r.evidence.verificationReport);
  need(r.kind==='deployment'&&r.statement.verification!=='unknown'?r.evidence.verificationReport!==null:r.evidence.verificationReport===null,'delivery_verification_report_required');
  const {recordDigest,...body}=r;need(digest(body)===recordDigest,'delivery_record_invalid');return r;
}
export function readDeliveryRecords(specsDir){
  const dir=rootDirectory(specsDir);if(dir===null)return freeze([]);
  const before=fs.lstatSync(dir,{bigint:true}),entries=fs.readdirSync(dir);
  need(entries.length<=MAX_RECORDS*2,'delivery_record_limit');
  const names=entries.filter(name=>!name.startsWith('.pending-')&&name!=='.DS_Store').sort();
  need(names.length<=MAX_RECORDS,'delivery_record_limit');const records=[],watched=[];
  for(const [index,name] of names.entries()){
    need(name===String(index+1).padStart(6,'0'),'delivery_record_invalid');
    const entry=path.join(dir,name),entryStat=fs.lstatSync(entry,{bigint:true});
    need(entryStat.isDirectory()&&!entryStat.isSymbolicLink()&&JSON.stringify(fs.readdirSync(entry))===JSON.stringify(['record.json']),'delivery_record_invalid');
    const location=path.join(entry,'record.json'),stat=key(fs.lstatSync(location,{bigint:true}));
    const file=readReviewSourceFiles(specsDir,[`${directory}/${name}/record.json`])[0];watched.push([entry,key(entryStat)],[location,stat]);
    records.push(validRecord(JSON.parse(Buffer.from(file.contentBase64,'base64').toString('utf8')),index+1,records.at(-1)?.recordDigest??null));
  }
  need(key(before)===key(fs.lstatSync(dir,{bigint:true}))&&watched.every(([file,stat])=>key(fs.lstatSync(file,{bigint:true}))===stat),'delivery_snapshot_changed');return freeze(records);
}
function currentDeliveryOwner({specsDir,repositoryId,runId,feature}){
  [repositoryId,runId].forEach(id);line(feature);
  const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId,runId}}),init=snapshot.records[0]?.payload;
  const history=readRunnerHistory(snapshot.records,init.config,init.version),state=history.state;
  need(history.pending===null&&state.state==='fixture_completed'&&state.receipt?.result?.verdict==='approved','delivery_candidate_incomplete');
  const pkg=state.reviewPackage,baseline=attemptBaseline(history.original,state.attempt);
  need(baseline.specification?.feature===feature&&init.config.completion?.owner?.specsRoot===specsDir,'delivery_candidate_mismatch');
  verifyReviewPackage({root:init.config.root,baseline,checks:pkg.checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest,
    ...(pkg.handoff?{handoffPath:init.config.completion.handoffs[state.attempt-1]}:{})});
  const manifest=verifyApprovedManifest(specsDir,path.join(specsDir,'.cm-specs-status'));
  return {version:1,feature,identity:pkg.identity,packageDigest:pkg.packageDigest,specificationDigest:digest(manifest),runnerRevision:snapshot.revision};
}
export function deliveryCandidate(options){
  const candidate={...currentDeliveryOwner(options),artifact:deliveryFile(options.artifact)};
  validCandidate(candidate);return freeze(candidate);
}
export function previewDelivery({specsDir,repositoryId,runId,feature,artifact,kind,statement,report,verificationReport=null}){
  need(['acceptance','deployment'].includes(kind),'delivery_invalid_kind');validStatement(kind,statement);
  const candidate=deliveryCandidate({specsDir,repositoryId,runId,feature,artifact}),records=readDeliveryRecords(specsDir);
  need(records.length<MAX_RECORDS,'delivery_record_limit');
  const body={version:1,sequence:records.length+1,previousDigest:records.at(-1)?.recordDigest??null,
    kind,candidate,statement:json({...statement,environment:environmentKey(statement.environment)}),evidence:{report:deliveryFile(report),verificationReport:verificationReport===null?null:deliveryFile(verificationReport)}};
  // Same shape check as persisted records, before asking a human anything.
  const probe={...body,at:new Date().toISOString(),provenance:'interactive-terminal-declaration'};
  validRecord({...probe,recordDigest:digest(probe)},body.sequence,body.previousDigest);
  return freeze({...body,previewDigest:digest(body)});
}
export function deliveryConfirmation(preview){return `RECORD ${preview.kind} ${preview.previewDigest}`;}
// Confirmation is provided by a trusted host callback, never by parsed model JSON.
// The bundled CLI supplies a real interactive terminal callback; no --yes exists.
export async function recordDelivery(options,{confirm}={}){
  need(typeof confirm==='function','delivery_confirmation_required');
  const preview=previewDelivery(options),answer=await confirm(preview,deliveryConfirmation(preview));
  need(answer===deliveryConfirmation(preview),'delivery_confirmation_refused');
  need(digest(previewDelivery(options))===digest(preview),'delivery_preview_changed');
  const {previewDigest,...body}=preview,recordBody={...body,at:new Date().toISOString(),provenance:'interactive-terminal-declaration'};
  const record=freeze({...recordBody,recordDigest:digest(recordBody)}),dir=rootDirectory(options.specsDir,true);
  const temp=path.join(dir,`.pending-${randomUUID()}`),target=path.join(dir,String(record.sequence).padStart(6,'0'));
  // Publish a nonempty directory by atomic rename. Unlike hard-link publication,
  // a crash cannot leave the committed record with a second link. Existing valid
  // nonempty directories cannot be replaced. Unpublished stages remain evidence.
  fs.mkdirSync(temp,{mode:0o700});
  const fd=fs.openSync(path.join(temp,'record.json'),'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(record)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{
    try{fs.lstatSync(target);need(false,'delivery_concurrent_write');}catch(error){if(error.code!=='ENOENT')throw error;}
    fs.renameSync(temp,target);
  }catch(error){if(['EEXIST','ENOTEMPTY'].includes(error.code))need(false,'delivery_concurrent_write');throw error;}
  return record;
}
const unknown=reason=>({status:'unknown',reason,evidence:[],environments:[]});
export function deliveryProjection({specsDir,feature,identity,packageDigest,specificationDigest,current=true,artifactSha256=null,maxEvidenceBytes=1024*1024*1024*3}){
  const result={productAcceptance:unknown('external_owner_acceptance_not_recorded'),deployment:unknown('deployment_evidence_not_recorded')};
  try{
    const records=readDeliveryRecords(specsDir);let owner,remaining=maxEvidenceBytes;
    need(Number.isSafeInteger(remaining)&&remaining>=0,'delivery_evidence_budget_exceeded');
    const checkedFiles=new Map();
    const checkFile=file=>{
      const prior=checkedFiles.get(file.path);if(prior!==undefined){need(digest(prior)===digest(file),'delivery_evidence_changed');return;}
      const checked=deliveryFile(file.path,{maxBytes:remaining});remaining-=checked.size;
      need(digest(checked)===digest(file),'delivery_evidence_changed');checkedFiles.set(file.path,checked);
    };
    const ownerMatches=()=>{
      if(owner===undefined)try{const inspected=currentDeliveryOwner({specsDir,repositoryId:identity.repositoryId,runId:identity.runId,feature});
        owner=digest(inspected.identity)===digest(identity)&&inspected.packageDigest===packageDigest&&inspected.specificationDigest===specificationDigest;
      }catch{owner=false;}
      return owner;
    };
    for(const [kind,field] of [['acceptance','productAcceptance'],['deployment','deployment']]){
      const selected=new Map();for(const record of records)if(record.kind===kind&&record.candidate.feature===feature)selected.set(environmentKey(record.statement.environment),record);
      if(!selected.size)continue;
      const environments=[...selected].map(([environment,r])=>{
        let reason=null;
        if(!current||(artifactSha256!==null&&artifactSha256!==r.candidate.artifact.sha256)||digest(r.candidate.identity)!==digest(identity)||r.candidate.packageDigest!==packageDigest||r.candidate.specificationDigest!==specificationDigest)reason='delivery_candidate_changed';
        else if(!ownerMatches())reason='delivery_candidate_changed';
        else try{for(const file of [r.candidate.artifact,r.evidence.report,r.evidence.verificationReport].filter(Boolean))
          checkFile(file);}
        catch(error){reason=error.code==='delivery_evidence_budget_exceeded'?error.code:'delivery_evidence_changed';}
        return {environment,status:reason==='delivery_evidence_budget_exceeded'?'unknown':reason?'stale':'recorded',reason,statement:r.statement,artifactSha256:r.candidate.artifact.sha256,
          at:r.at,provenance:r.provenance,evidence:[`${directory}/${String(r.sequence).padStart(6,'0')}/record.json#sha256=${r.recordDigest}`]};
      });
      result[field]={status:environments.some(e=>e.status==='unknown')?'unknown':environments.every(e=>e.status==='recorded')?'recorded':'stale',reason:null,environments,
        evidence:environments.flatMap(e=>e.evidence)};
    }
  }catch{result.productAcceptance=unknown('delivery_records_unavailable');result.deployment=unknown('delivery_records_unavailable');}
  return freeze(result);
}
export {deliveryLines} from './operator-guidance.mjs';
