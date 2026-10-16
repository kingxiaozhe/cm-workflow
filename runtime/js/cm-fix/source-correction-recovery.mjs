// A single, explicit source transition inside the existing verification recovery budget.
// The original configuration and review result remain immutable.
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
import {readFixCausePackage} from './cause-package.mjs';
import {inspectFixReproduction} from './reproduce.mjs';
import {createTypeImportCorrection,inspectTypeImportCorrection,applyTypeImportCorrection} from './type-import-correction.mjs';
import {readReviewBaseline} from '../cm-ai/review-package.mjs';
import {verificationRecoveryTarget,inspectRecoveryBaseline,VERIFICATION_RECOVERY} from './review-verification-recovery.mjs';
import {createReviewVerificationSession,verifyReviewVerificationBaseline} from './review-verification.mjs';
export const SOURCE_INTENT=`${VERIFICATION_RECOVERY}-source-intent`;
export const SOURCE_RESULT=`${VERIFICATION_RECOVERY}-source-result`;
export const sourceIntent=records=>records.find(r=>r.id===SOURCE_INTENT)??null;
export const sourceResult=records=>records.find(r=>r.id===SOURCE_RESULT)??null;
export const sourceRevision=(target)=>({previousPackageDigest:target.packageDigest,correctionDigest:digest(target.sourceCorrection),
 path:target.sourceCorrection.path,beforeSha256:target.sourceCorrection.before.sha256,afterSha256:target.sourceCorrection.after.sha256});
export function sourceRecoveryTarget(context,correction){
 const pkg=readFixCausePackage(context.registration.payload.request.payload.reviewPackage),c=inspectTypeImportCorrection(correction),config=context.configuration;
 need(context.phase==='cause_review'&&pkg.identity.attempt===1&&!config.qaSource&&!config.testAuthor?.visual
  &&!context.records.some(r=>/^(?:fix-(?:test-author|red-test|repair|rediagnosis|observation)|fix-verification-recovery-source)/.test(r.id)), 'fix_source_correction_unavailable');
 need(config.reproduction.command&&!pkg.correction&&!pkg.rediagnosis&&!pkg.sourceRevision,'fix_source_correction_unavailable');
 const checked=createTypeImportCorrection({file:c.before,declaration:{kind:c.kind,path:c.path,beforeSha256:c.before.sha256,typeNames:c.typeNames},scope:config.repair.scope,verification:config.reviewVerification,reviewPackage:pkg});
 need(digest(c)===digest(checked),'fix_source_correction_binding');
 const files=context.baseline.files,checks=config.reviewVerification.checks.map(c=>({id:c.id,commandDigest:digest(c.command),exitCode:0}));
 const target=verificationRecoveryTarget({...context,baseline:{files,snapshotDigest:digest(files),checks}});
 return json({...target,sourceCorrection:c},128*1024);
}
export function inspectSourceIntent(value,context){
 shape(value,['target','reason','previousInvocationStopped']);
 need(value.previousInvocationStopped===true&&typeof value.reason==='string'&&value.reason.trim()&&Buffer.byteLength(value.reason)<=1000&&!/[\r\n\0\u0085\u2028\u2029]/.test(value.reason),'fix_verification_recovery_confirmation');
 const expected=sourceRecoveryTarget({...context,baseline:{files:value.target.files}},value.target.sourceCorrection);
 need(digest(expected)===digest(value.target),'fix_source_correction_binding');return value;
}
export function successorPackage(original,target,reproduction){
 const {packageDigest,...body}=readFixCausePackage(original),c=inspectTypeImportCorrection(target.sourceCorrection);
 need(packageDigest===target.packageDigest,'fix_source_correction_binding');
 body.files=body.files.map(f=>f.path===c.path?c.after:f);body.reproduction=reproduction;body.sourceRevision=sourceRevision(target);
 return readFixCausePackage({...body,packageDigest:digest(body)});
}
export function inspectSourceResult(value,intent,configuration,original){
 shape(value,['intentDigest','reproduction','baseline','package']);
 need(value.intentDigest===digest(intent),'fix_source_correction_binding');
 inspectFixReproduction(value.reproduction,configuration.reproduction,{requireAttempts:true});
 need(value.reproduction.status==='reproduced','fix_source_correction_reproduction_changed');
 const pkg=successorPackage(original,intent.target,value.reproduction);
 need(digest(value.package)===digest(pkg),'fix_source_correction_binding');
 inspectRecoveryBaseline(value.baseline,configuration.reviewVerification,pkg);
 const expected=intent.target.files.map(f=>f.path===intent.target.sourceCorrection.path?{path:f.path,sha256:intent.target.sourceCorrection.after.sha256,mode:intent.target.sourceCorrection.after.mode}:f);
 need(digest(expected)===value.baseline.snapshotDigest,'fix_source_correction_drift');return value;
}
export async function previewSourceCorrection({codeProject,configuration,original,target}){
 // Reuse the existing private-copy and fixed-command sandbox. No provider or owner writes.
 const session=createReviewVerificationSession({codeProject,configuration,request:{requestDigest:digest(target),payload:{reviewPackage:original}}});
 try{
  applyTypeImportCorrection({root:session.cwd,correction:target.sourceCorrection});
  const pkg=successorPackage(original,target,original.reproduction);
  return await verifyReviewVerificationBaseline({codeProject:session.cwd,configuration,reviewPackage:pkg});
 }finally{await session.close();}
}
export function sourceCorrectionReviewBaseline(raw,correction){
 const c=inspectTypeImportCorrection(correction),{baselineDigest,...body}=readReviewBaseline(raw);
 const before=body.files.find(f=>f.path===c.path),metadata=f=>{const {contentBase64,...rest}=f;return rest;};
 need(body.scope.includes(c.path)&&before&&digest(metadata(before))===digest(metadata(c.after)),'fix_source_correction_baseline');
 body.files=body.files.map(f=>f.path===c.path?c.before:f);
 return readReviewBaseline({...body,baselineDigest:digest(body)});
}
