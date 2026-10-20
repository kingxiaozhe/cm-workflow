// One explicitly authorized original-run review after a valid blocked verdict.
import {digest,need,shape,hex} from './effect-contract.mjs';
import {readReviewPackage} from './review-package.mjs';
import {readNativeEvidenceProfile,validateNativeEvidenceCheck} from './native-review-evidence.mjs';
export function nativeMaterialReviewBinding(s,config,original,correction){
 const entry=s.cache.at(-1),receipt=s.receipt;
 need(correction?.epoch===1&&correction.developConsumed&&correction.reviewConsumed
  &&correction.reviewRetry?.consumed&&correction.transportReviewRetry?.consumed&&!correction.materialReview
  &&s.state==='blocked'&&s.code==='review_blocked'&&s.attempt===2&&s.calls.length===10&&s.sequence===10
  &&entry?.effect.id===correction.transportReviewRetry.effectId&&entry.result.code==='review_blocked'
  &&receipt?.result.verdict==='blocked'&&s.receipts.length===3&&s.receipts.every(r=>r.result.verdict==='blocked')
  &&s.calls.at(-1)?.terminal==='succeeded'&&s.calls.at(-1).invocationId===receipt.id
  &&s.reviewInvocation?.result?.outcome==='observed'&&receipt.packageDigest===s.reviewPackage?.packageDigest
  &&config.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'
  &&config.controlPolicy.bootstrap==='disabled'&&config.controlPolicy.qaFix==='disabled'
  &&!config.bootstrap&&!config.parallelSelection&&!config.codeProjectPaths&&!config.binaryAssets
  &&!config.externalModels&&!config.executionPolicy&&config.developer.provider==='codex'
  &&config.developer.requestedModel==='current-session'&&config.reviewers.length===1&&config.reviewers[0].provider==='codex'
  &&!s.taskCommit&&!s.cancellationRequested&&!s.cancelAfterCommit&&!s.workflowError,'native_material_review_unavailable');
 return {effectId:entry.effect.id,checkpointDigest:digest(entry),packageDigest:s.reviewPackage.packageDigest,
  receiptDigest:receipt.receiptDigest,invocationId:receipt.id,correctionDigest:correction.recordDigest,
  technicalRetryDigest:correction.reviewRetry.recordDigest,transportRetryDigest:correction.transportReviewRetry.recordDigest,
  configDigest:digest(config),baselineDigest:original.baselineDigest,scopeDigest:digest(config.scope),callCount:10,
  reviewEffectId:'review-2-material-1-correction-1'};
}
export function supplementNativePackage(old,check){
 const prior=old.checks.filter(c=>c.kind==='native-evidence');
 need(prior.length===1&&prior[0].material?.version===1,'native_material_review_evidence');
 validateNativeEvidenceCheck(check,old.identity);need(check.material.version===2,'native_material_review_evidence');
 const {version,manifestDigest,textEvidence,...next}=check.material;
 const {version:oldVersion,manifestDigest:oldManifest,...before}=prior[0].material;
 need(digest(next)===digest(before),'native_material_review_evidence_changed');
 const checks=old.checks.map(c=>c===prior[0]?check:c),{packageDigest,...body}=old;
 return readReviewPackage({...body,checks,checksDigest:digest(checks),packageDigest:digest({...body,checks,checksDigest:digest(checks)})});
}
export function applyNativeMaterialReview(s,config,original,correction,record){
 const binding=nativeMaterialReviewBinding(s,config,original,correction);
 for(const key of Object.keys(binding))need(digest(record[key])===digest(binding[key]),'native_material_review_binding');
 need(typeof record.reason==='string'&&record.reason.trim()&&Buffer.byteLength(record.reason)<=500&&!/[\r\n\0]/.test(record.reason),'native_material_review_reason');
 need(typeof record.at==='string'&&new Date(record.at).toISOString()===record.at,'native_material_review_binding');
 readNativeEvidenceProfile(record.nativeEvidence,{codeProject:config.root,specsDir:config.completion.owner.specsRoot,inspectCurrent:false});
 need(Array.isArray(record.retainedEvidence)&&record.retainedEvidence.length===2,'native_material_review_evidence');
 for(const row of record.retainedEvidence){shape(row,['path','sha256']);hex(row.sha256);need(typeof row.path==='string','native_material_review_evidence');}
 const pkg=readReviewPackage(record.reviewPackage),checks=pkg.checks.filter(c=>c.kind==='native-evidence');
 need(checks.length===1,'native_material_review_evidence');
 need(digest(pkg)===digest(supplementNativePackage(s.reviewPackage,checks[0])),'native_material_review_package_changed');
 hex(record.sourceDigest);need(record.sourceDigest===digest(checks[0].material.textEvidence),'native_material_review_binding');
 return {...s,state:'awaiting_review',code:null,reason:null,currentChecks:pkg.checks,reviewPackage:pkg,
  priorReview:s.receipt.result,receipt:null,reviewInvocation:null};
}
