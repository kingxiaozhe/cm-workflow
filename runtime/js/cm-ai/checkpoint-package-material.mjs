import {evidenceRequest,validateEvidenceFindings} from './valid-review-evidence-continuation.mjs';
// Pure storage representation only. The runner still validates every restored
// checkpoint transition, package link, receipt and completion prerequisite.
import path from 'node:path';
import {digest,json,shape,need,hex,id,validIdentity,freeze,JOURNAL_PAYLOAD_LIMIT} from './effect-contract.mjs';

const INVALID='checkpoint_package_material_invalid',STATE_LIMIT=16*1024*1024;
const MARKER_ALLOWANCE=1024,REFERENCE_ALLOWANCE=512;
const must=condition=>need(condition,INVALID);
const guarded=run=>{try{return run();}catch(error){if(error?.code===INVALID)throw error;throw Object.assign(new Error(INVALID),{code:INVALID});}};
const size=value=>Buffer.byteLength(JSON.stringify(value));
const same=(left,right)=>digest(left)===digest(right);
const sameRun=(left,right)=>same({...left,attempt:right.attempt},right);
// Representation eligibility is derived from durable execution mode only.
// It is not scope authority, a recovery grant, or a requirement to revise scope.
export function packageMaterialEligible(rawConfig,version=3){
  try{const config=json(rawConfig,STATE_LIMIT),policy=config.controlPolicy;
    validIdentity(config.identity);shape(policy,['version','development','bootstrap','qa','qaFix']);
    must(['disabled','run'].includes(policy.qa)&&['disabled','manual','auto'].includes(policy.qaFix)
      &&(policy.qaFix==='disabled'||policy.qa==='run'));
    return version===3&&typeof config.root==='string'&&path.isAbsolute(config.root)
      &&path.resolve(config.root)===config.root&&!config.root.includes('\0')
      &&policy?.version===2&&policy.development==='conversation'&&policy.bootstrap==='disabled'
      &&['bootstrap','providerDevelopment','parallelSelection','parallelMember','batchWorkflowsDigest','codeProjectPaths','codeProjects']
        .every(key=>!Object.hasOwn(config,key));
  }catch{return false;}
}
const referenceTypes=['effect-checkpoint','review-invocation-reconciled'];
const reconciliationKeys=['invocationId','registeredDigest','startedDigest','resultDigest','receiptDigest'];
function bindingValue(type,raw={}){
  must(referenceTypes.includes(type));const binding=json(raw);
  shape(binding,type==='effect-checkpoint'?[]:reconciliationKeys);
  if(type==='review-invocation-reconciled'){
    id(binding.invocationId);for(const key of reconciliationKeys.slice(1)){
      if(key==='startedDigest'&&binding[key]===null)continue;hex(binding[key]);}
  }
  return binding;
}
function storageHeader(payload){
  const common=['effectId','checkpoint','version','protocol','type'];
  shape(payload,[...common,...(payload.type==='review-invocation-reconciled'?reconciliationKeys:[]),
    ...['packageMaterial','packageRef'].filter(key=>Object.hasOwn(payload,key))]);
  bindingValue(payload.type,Object.fromEntries(reconciliationKeys.filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]])));
}
function packageValue(raw,identity){
  const value=json(raw,STATE_LIMIT);validIdentity(identity);validIdentity(value?.identity);
  must(value.version===1&&value.kind==='cm-review-package'&&sameRun(value.identity,identity));hex(value.packageDigest);
  const {packageDigest,...body}=value;must(digest(body)===packageDigest);return value;
}
function history(raw,identity){
  validIdentity(identity);const records=json(raw,STATE_LIMIT);must(Array.isArray(records)&&records.length<=1024);
  let previous=null;
  for(const [index,record] of records.entries()){
    shape(record,['version','seq','id','kind','payload','previousDigest','digest']);hex(record.digest);
    const {digest:hash,...body}=record;
    must(record.version===1&&record.seq===index+1&&record.id===`runner.${String(index+1).padStart(6,'0')}`
      &&record.previousDigest===previous&&digest(body)===hash&&size(record.payload)<=JOURNAL_PAYLOAD_LIMIT);
    previous=hash;
  }
  if(records.length){const initial=records[0]?.payload?.config?.identity;validIdentity(initial);
    must(sameRun(initial,identity));}
  return records;
}
function checkpointValue(checkpoint,effectId,pkg,identity){
  must(checkpoint&&typeof checkpoint==='object'&&!Array.isArray(checkpoint)&&[1,2].includes(checkpoint.attempt));
  const current=checkpoint.cache?.at(-1);must(current?.effect?.id===effectId);
  validIdentity(current.effect.identity);validIdentity(current.result?.identity);
  must(sameRun(current.effect.identity,identity)&&sameRun(current.result.identity,identity)
    &&current.result.identity.attempt===checkpoint.attempt&&current.result.packageDigest===pkg.packageDigest);
  return current.effect;
}
function materialRecord(record,records,index,identity){
  const p=record.payload;must(record.kind==='result'&&p.version===3&&p.protocol==='cm-task-runner'&&p.type==='effect-checkpoint'
    &&p.packageMaterial===true&&!Object.hasOwn(p,'packageRef'));
  const pkg=packageValue(p.checkpoint?.reviewPackage,identity),effect=checkpointValue(p.checkpoint,p.effectId,pkg,identity);
  must(p.checkpoint.state==='awaiting_review'&&effect.kind==='develop'
    &&same(pkg.identity,identity)&&p.checkpoint.attempt===pkg.identity.attempt
    &&same(effect.identity,pkg.identity)&&same(p.checkpoint.cache.at(-1).result.identity,pkg.identity));
  const intent=records.slice(0,index).findLast(row=>row.payload.type==='effect-intent'&&row.payload.effect?.id===p.effectId);
  must(intent?.kind==='intent'&&same(intent.payload.effect,effect));
  return pkg;
}
// Evidence registration already passed the runner's source/owner/material
// validation. Storage still verifies its exact canonical binding independently.
function evidenceMaterialRecord(record,records,index,identity){
 const p=record.payload;must(record.kind==='result'&&p.version===3&&p.protocol==='cm-task-runner'&&p.type==='review-evidence-registered');
 shape(p,['version','protocol','type','fromDigest','source','request','requestDigest','retainedEvidence','reviewPackage','at']);
 must(index>0&&p.fromDigest===records[index-1].digest);
 const pkg=packageValue(p.reviewPackage,identity),c=pkg.evidenceContinuation,request=evidenceRequest(p.request);
 must(request.evidenceContinuation===true&&p.requestDigest===digest(request)&&c?.version===1
  &&same(c.source,p.source)&&same(request.source,p.source)&&same(p.source.identity,pkg.identity)
  &&same(c.findings,request.findings)&&c.newEvidence?.material?.manifestDigest===request.manifestDigest);
 const {evidenceContinuation,packageDigest,...old}=pkg,{receiptDigest,...receipt}=c.oldReceipt;
 must(digest(old)===p.source.oldPackageDigest&&receiptDigest===digest(receipt)&&receiptDigest===p.source.oldReceiptDigest
  &&receipt.packageDigest===p.source.oldPackageDigest&&receipt.result.verdict==='blocked');
 validateEvidenceFindings(c.findings,c.oldReceipt,c.newEvidence);return pkg;
}
const sourceIdentity=record=>record.payload.type==='review-evidence-registered'?record.payload.reviewPackage?.identity:record.payload.checkpoint?.reviewPackage?.identity;
const sourceMaterial=(record,records,index,identity)=>record.payload.type==='review-evidence-registered'
 ?evidenceMaterialRecord(record,records,index,identity):materialRecord(record,records,index,identity);
function referenceValue(raw){const ref=json(raw);shape(ref,['recordId','recordDigest','packageDigest']);
  must(typeof ref.recordId==='string'&&/^runner\.[0-9]{6}$/.test(ref.recordId));hex(ref.recordDigest);hex(ref.packageDigest);return ref;}
function findReference(records,pkg,identity){
  let found=null;
  for(const [index,record] of records.entries())if(Object.hasOwn(record.payload,'packageMaterial')||record.payload.type==='review-evidence-registered'){
    const who=sourceIdentity(record);validIdentity(who);
    must(sameRun(who,identity));
    const material=sourceMaterial(record,records,index,who);
    if(material.packageDigest===pkg.packageDigest){must(same(material,pkg));
      found={recordId:record.id,recordDigest:record.digest,packageDigest:material.packageDigest};}
  }
  return found;
}
export function packageMaterialReference(rawRecords,rawPackage,identity){return guarded(()=>{
  const records=history(rawRecords,identity),pkg=packageValue(rawPackage,identity);
  return freeze(findReference(records,pkg,identity));
});}

export function resolveCheckpointPackage(rawPayload,rawRecords,identity){return guarded(()=>{
  const payload=json(rawPayload,STATE_LIMIT),material=Object.hasOwn(payload,'packageMaterial'),referenced=Object.hasOwn(payload,'packageRef');
  must(!(material&&referenced));
  // Historic inline payloads retain their exact logical shape and old validator.
  if(!material&&!referenced)return json(payload.checkpoint,STATE_LIMIT);
  const records=history(rawRecords,identity);
  must(payload.version===3&&payload.protocol==='cm-task-runner'&&referenceTypes.includes(payload.type)
    &&size(payload)<=JOURNAL_PAYLOAD_LIMIT);storageHeader(payload);
  if(material){
    must(payload.type==='effect-checkpoint');
    const body={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,kind:'result',payload,
      previousDigest:records.at(-1)?.digest??null};
    materialRecord({...body,digest:digest(body)},records,records.length,identity);
    return json(payload.checkpoint,STATE_LIMIT);
  }
  const ref=referenceValue(payload.packageRef);
  must(payload.checkpoint?.reviewPackage===null);
  const index=records.findIndex(record=>record.id===ref.recordId);must(index>=0);
  const record=records[index];must(record.digest===ref.recordDigest);
  const who=sourceIdentity(record);validIdentity(who);must(sameRun(who,identity));
  const pkg=sourceMaterial(record,records,index,who);must(pkg.packageDigest===ref.packageDigest);
  const effect=checkpointValue(payload.checkpoint,payload.effectId,pkg,identity);
  if(payload.type==='review-invocation-reconciled')must(effect.kind==='review');
  return json({...payload.checkpoint,reviewPackage:pkg},STATE_LIMIT);
});}

// Conservative driver preflight. Real append validation additionally measures
// the exact payload/envelope; this does not change any journal or review limit.
export function checkpointPackageBudget({inlineBytes,packageBytes,reserve,enabled,referenced=false}){return guarded(()=>{
  must([inlineBytes,packageBytes,reserve].every(v=>Number.isSafeInteger(v)&&v>=0)
    &&packageBytes<=inlineBytes&&reserve<JOURNAL_PAYLOAD_LIMIT&&typeof enabled==='boolean'&&typeof referenced==='boolean');
  const budget=JOURNAL_PAYLOAD_LIMIT-reserve;
  if(!enabled||!referenced&&inlineBytes<=budget)return freeze({fits:inlineBytes<=budget,material:false,bytes:inlineBytes,budget});
  const bytes=inlineBytes-packageBytes+REFERENCE_ALLOWANCE,material=!referenced;
  return freeze({fits:bytes<=budget&&(!material||inlineBytes+MARKER_ALLOWANCE<=JOURNAL_PAYLOAD_LIMIT),material,bytes,budget});
});}
export function checkpointStoragePlan({records:rawRecords,effectId,checkpoint:rawCheckpoint,identity,enabled,reserve,type='effect-checkpoint',binding:rawBinding={}}){return guarded(()=>{
  must(typeof enabled==='boolean');const checkpoint=json(rawCheckpoint,STATE_LIMIT),records=history(rawRecords,identity);
  must(typeof effectId==='string'&&effectId.length>0);
  const binding=bindingValue(type,rawBinding);
  const payload={effectId,checkpoint,version:3,protocol:'cm-task-runner',type,...binding};
  // Invalid budgets are rejected even for legacy/small packages.
  checkpointPackageBudget({inlineBytes:size(payload),packageBytes:checkpoint.reviewPackage?size(checkpoint.reviewPackage):0,reserve,enabled});
  if(!enabled||checkpoint.reviewPackage===null)return freeze({checkpoint,payloadFields:{}});
  const pkg=packageValue(checkpoint.reviewPackage,identity),effect=checkpointValue(checkpoint,effectId,pkg,identity);
  const ref=findReference(records,pkg,identity);
  // Develop reserved the later checkpoints before accepting its inline package.
  // Those later records enforce their actual limit, not that future reserve again;
  // a review or completion cannot introduce a first material archive.
  if(!ref&&type==='effect-checkpoint'&&['review','complete'].includes(effect.kind)){
    must(size(payload)<=JOURNAL_PAYLOAD_LIMIT);return freeze({checkpoint,payloadFields:{}});
  }
  const budget=checkpointPackageBudget({inlineBytes:size(payload),packageBytes:size(pkg),reserve,enabled,referenced:ref!==null});
  must(budget.fits);
  if(ref){
    const stored={...checkpoint,reviewPackage:null},fields={packageRef:ref};
    const final={...payload,checkpoint:stored,...fields};must(size(final)<=JOURNAL_PAYLOAD_LIMIT);
    resolveCheckpointPackage(final,records,identity);return freeze({checkpoint:stored,payloadFields:fields});
  }
  if(!budget.material)return freeze({checkpoint,payloadFields:{}});
  const fields={packageMaterial:true},final={...payload,...fields};must(size(final)<=JOURNAL_PAYLOAD_LIMIT);
  resolveCheckpointPackage(final,records,identity);return freeze({checkpoint,payloadFields:fields});
});}
