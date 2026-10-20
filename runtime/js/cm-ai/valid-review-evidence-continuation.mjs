// One evidence-only continuation of a valid blocked native correction.
// Registration is data; only a separate owner authorization grants one intent.
import {digest,need,shape,id,hex,validIdentity,JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve} from './effect-contract.mjs';
import {readNativeEvidenceProfile,validateNativeEvidenceCheck} from './native-review-evidence.mjs';
export const EVIDENCE_REVIEW_EFFECT='review-evidence-continuation-1';
export function evidenceRequest(value){
 const review=value.evidenceReview===true,flag=review?'evidenceReview':'evidenceContinuation';
 shape(value,['version','reason',flag,'source',...(!review?['nativeEvidence','manifestDigest','findings']:[])]);
 need(value.version===1&&value[flag]===true,'evidence_continuation_request');
 need(typeof value.reason==='string'&&value.reason.trim()&&Buffer.byteLength(value.reason)<=500&&!/[\r\n\0]/.test(value.reason),'evidence_continuation_reason');
 if(!review)hex(value.manifestDigest);readEvidenceSource(value.source);return value;
}
export function readEvidenceSource(s){
 shape(s,['identity','hostContextId','revision','oldReceiptDigest','oldPackageDigest','configDigest','baselineDigest','candidateDigest','fingerprints']);
 validIdentity(s.identity);id(s.hostContextId);
 for(const k of ['revision','oldReceiptDigest','oldPackageDigest','configDigest','baselineDigest','candidateDigest'])hex(s[k]);
 shape(s.fingerprints,['workflow','config','inputs']);Object.values(s.fingerprints).forEach(hex);return s;
}
const candidate=p=>digest({baseIdentity:p.baseIdentity,scope:p.scope,changes:p.changes,unchangedScope:p.unchangedScope??null,
 requirements:p.requirements,specification:p.specification??null,handoff:p.handoff??null});
export function evidenceContinuationSource(records,s,config,baseline,correction,existing=null){
 const receipt=s.receipt,entry=s.cache.at(-1),call=s.calls.at(-1),pkg=s.reviewPackage;
 need(!existing&&correction?.epoch===1&&correction.developConsumed&&correction.reviewConsumed
  &&s.state==='blocked'&&s.code==='review_blocked'&&s.attempt===2&&receipt?.result.verdict==='blocked'
  &&receipt.packageDigest===pkg?.packageDigest&&s.receipts.at(-1)?.receiptDigest===receipt.receiptDigest
  &&receipt.result.findings.some(f=>f.severity!=='P3')&&entry?.effect.kind==='review'&&entry.result.code==='review_blocked'
  &&call?.terminal==='succeeded'&&call.invocationId===receipt.id&&s.reviewInvocation?.result?.outcome==='observed'
  &&s.reviewInvocation.registration.binding.invocationId===receipt.id
  &&config.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'
  &&config.controlPolicy.bootstrap==='disabled'&&config.controlPolicy.qaFix==='disabled'
  &&!config.bootstrap&&!config.parallelSelection&&!config.codeProjectPaths&&!config.binaryAssets&&!config.externalModels&&!config.executionPolicy
  &&config.developer.provider==='codex'&&config.developer.requestedModel==='current-session'
  &&config.reviewers.length===1&&config.reviewers[0].provider==='codex'&&pkg.checks.some(c=>c.kind==='native-evidence')
  &&!s.taskCommit&&!s.cancellationRequested&&!s.cancelAfterCommit&&!s.workflowError,'evidence_continuation_unavailable');
 const fingerprints=config.completion.fingerprints;
 return readEvidenceSource({identity:pkg.identity,hostContextId:s.reviewInvocation.registration.binding.hostContextId,
  revision:digest({version:1,identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId},fingerprints,records}),
  oldReceiptDigest:receipt.receiptDigest,oldPackageDigest:pkg.packageDigest,configDigest:digest(config),baselineDigest:baseline.baselineDigest,
  candidateDigest:candidate(pkg),fingerprints});
}
export function validateEvidenceSupplement(pkg){
 const c=pkg.evidenceContinuation;
 shape(c,['version','source','oldReceipt','findings','newEvidence']);need(c.version===1,'evidence_continuation_package');
 readEvidenceSource(c.source);need(digest(c.source.identity)===digest(pkg.identity),'evidence_continuation_package');
 const {receiptDigest,...receipt}=c.oldReceipt;
 need(receiptDigest===digest(receipt)&&receiptDigest===c.source.oldReceiptDigest&&receipt.result.verdict==='blocked'
  &&receipt.packageDigest===c.source.oldPackageDigest&&digest(receipt.identity)===digest(pkg.identity),'evidence_continuation_receipt');
 const {evidenceContinuation,packageDigest,...old}=pkg;
 need(digest(old)===c.source.oldPackageDigest&&candidate(pkg)===c.source.candidateDigest,'evidence_continuation_code_changed');
 validateNativeEvidenceCheck(c.newEvidence,pkg.identity);
 need(c.newEvidence.outcome==='passed','evidence_continuation_evidence');
 validateEvidenceFindings(c.findings,c.oldReceipt,c.newEvidence);
 return c;
}
export function validateEvidenceFindings(findings,oldReceipt,newEvidence){
 const prior=oldReceipt.result.findings.filter(f=>f.severity!=='P3'),ids=new Set();
 need(Array.isArray(findings)&&findings.length===prior.length,'evidence_continuation_findings');
 const materials=new Set([...newEvidence.material.images.map(i=>i.path),...(newEvidence.material.textEvidence?.files??[]).map(f=>f.id)]);
 for(const f of findings){shape(f,['id','disposition','evidenceIds']);id(f.id);
  need(!ids.has(f.id)&&prior.some(p=>p.id===f.id)&&typeof f.disposition==='string'&&f.disposition.trim()&&Buffer.byteLength(f.disposition)<=1024
   &&Array.isArray(f.evidenceIds)&&f.evidenceIds.length>0&&f.evidenceIds.length<=32&&new Set(f.evidenceIds).size===f.evidenceIds.length
   &&f.evidenceIds.every(e=>materials.has(e)),'evidence_continuation_findings');ids.add(f.id);}
}
export function assembleEvidenceContinuationPackage(old,source,check,findings,receipt){
 const {packageDigest,...body}=old,evidenceContinuation={version:1,source,oldReceipt:receipt,findings,newEvidence:check};
 return {...body,evidenceContinuation,packageDigest:digest({...body,evidenceContinuation})};
}
export function supplementedEvidencePackage(...args){const next=assembleEvidenceContinuationPackage(...args);validateEvidenceSupplement(next);return next;}
export function evidenceAuthorizationSource(records,s,config,baseline,registered){
 need(registered&&!registered.authorization&&!registered.consumed&&s.state==='blocked'&&s.code==='review_blocked'
  &&s.receipt?.receiptDigest===registered.source.oldReceiptDigest&&s.reviewPackage?.packageDigest===registered.source.oldPackageDigest
  &&!s.cancellationRequested&&!s.cancelAfterCommit&&!s.workflowError,'evidence_review_unavailable');
 need(digest(config)===registered.source.configDigest&&baseline.baselineDigest===registered.source.baselineDigest,'evidence_continuation_binding');
 const fingerprints=config.completion.fingerprints;
 return {...registered.source,revision:digest({version:1,identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId},fingerprints,records}),
  candidateDigest:registered.reviewPackage.packageDigest};
}
export function applyEvidenceRegistration(records,s,config,baseline,correction,record,existing){
 const source=evidenceContinuationSource(records,s,config,baseline,correction,existing);
 need(digest(source)===digest(record.source),'evidence_continuation_binding');
 readNativeEvidenceProfile(record.request.nativeEvidence,{codeProject:config.root,specsDir:config.completion.owner.specsRoot,inspectCurrent:false});
 need(Array.isArray(record.retainedEvidence)&&record.retainedEvidence.length===2,'evidence_continuation_retained');
 for(const item of record.retainedEvidence){shape(item,['path','sha256']);hex(item.sha256);need(typeof item.path==='string','evidence_continuation_retained');}
 const request=evidenceRequest(record.request);need(request.evidenceContinuation===true&&digest(request)===record.requestDigest
  &&digest(request.source)===digest(source),'evidence_continuation_binding');
 need(record.fromDigest===records.at(-1).digest&&typeof record.at==='string'&&new Date(record.at).toISOString()===record.at,'evidence_continuation_binding');
 validateEvidenceSupplement(record.reviewPackage);
 need(digest(record.reviewPackage.evidenceContinuation.oldReceipt)===digest(s.receipt)
  &&digest(record.reviewPackage.evidenceContinuation.findings)===digest(request.findings)
  &&record.reviewPackage.evidenceContinuation.newEvidence.material.manifestDigest===request.manifestDigest
  &&digest(record.reviewPackage.evidenceContinuation.source)===digest(source),'evidence_continuation_binding');
 return {source,retainedEvidence:record.retainedEvidence,requestDigest:record.requestDigest,reviewPackage:record.reviewPackage,request,authorization:null,consumed:false,
  callsAtRegistration:s.calls.length,effectsAtRegistration:s.cache.filter(c=>c.effect.kind!=='complete').length,receiptsAtRegistration:s.receipts.length};
}
export function applyEvidenceAuthorization(records,s,config,baseline,registered,record){
 const expected=evidenceAuthorizationSource(records,s,config,baseline,registered),request=evidenceRequest(record.request);
 need(request.evidenceReview===true&&digest(request)===record.requestDigest&&digest(request.source)===digest(expected)
  &&record.registrationDigest===registered.recordDigest&&record.reviewEffectId===EVIDENCE_REVIEW_EFFECT
  &&record.fromDigest===records.at(-1).digest&&typeof record.at==='string'&&new Date(record.at).toISOString()===record.at,'evidence_review_binding');
 return {...s,state:'awaiting_review',code:null,reason:null,receipt:null,priorReview:s.receipt.result,reviewInvocation:null,
  reviewPackage:registered.reviewPackage,currentChecks:registered.reviewPackage.checks};
}

// The package is stored in registration once; later checkpoints use its exact
// packageRef. Reuse the existing bounded-result/completion reserve, not a cap increase.
export function evidenceCheckpointBudget(state,reviewPackage){
 const size=v=>Buffer.byteLength(JSON.stringify(v??null)),paths=[...new Set([...reviewPackage.changes.map(c=>c.path),...reviewPackage.requirements.map(c=>c.path),...(reviewPackage.unchangedScope??[]).map(c=>c.path)])].sort();
 const referenceFrame={...state,reviewPackage:null};
 const reserve=developCheckpointReserve({examinedPathsBytes:size(paths),receiptsBytes:size(state.receipts),callsBytes:size(state.calls),writebackBytes:size(state.learningResult?.writeback)});
 const futureCheckpointMaxBytes=size(referenceFrame)+reserve;
 need(futureCheckpointMaxBytes<=JOURNAL_PAYLOAD_LIMIT,'evidence_checkpoint_capacity');
 return {referenceSource:'review-evidence-registered',newPackageBytes:size(reviewPackage),futureCheckpointMaxBytes,payloadLimit:JOURNAL_PAYLOAD_LIMIT,existingReserve:reserve};
}
