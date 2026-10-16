// One append-only continuation for a failed isolated verification; not a review verdict.
import {digest,json,need,shape,hex} from '../cm-ai/effect-contract.mjs';
import {readReviewVerification,bindVerificationFiles} from './review-verification-contract.mjs';
export const VERIFICATION_RECOVERY='fix-verification-recovery';
export const recoveryPreparation=records=>records.find(r=>r.id===`${VERIFICATION_RECOVERY}-prepared`)??null;
export function recoveryFor(records,phase){
 const row=recoveryPreparation(records);if(row?.payload.target.phase!==phase)return null;
 if(phase==='cause_review'&&records.some(r=>r.id==='fix-rediagnosis-intent'&&r.seq>row.seq))return null;
 return row;
}
export function verificationRecoveryTarget({records,configuration,stage,phase,registration,started,result,baseline}){
 need(stage==='unknown'&&configuration.reviewVerification&&configuration.causeReview?.provider==='claude','fix_verification_recovery_unavailable');
 need(!configuration.externalModels&&!configuration.executionPolicy,'external_review_reconciliation_required');
 need(registration&&started&&result,'fix_verification_recovery_unavailable');
 // Observation correction binds a distinct historical package. Never prepare a
 // continuation that cannot preserve that original correction contract.
 need(!Object.hasOwn(registration.payload.request.payload.reviewPackage,'correction'),'fix_verification_recovery_unavailable');
 const observation=result.payload.observation;
 // Do not infer eligibility from a generic unknown/transport error or a valid rejection.
 need(observation?.result?.status==='failed'&&observation.result.code==='review_verification_evidence', 'fix_verification_recovery_unavailable');
 need(observation.events.some(e=>e.event==='process_closed'&&e.exit_code===0&&e.timed_out===false&&e.signal===null),'fix_verification_recovery_process_unconfirmed');
 need(['cause_review','final_review','revision_final_review'].includes(phase),'fix_verification_recovery_unavailable');
 const threads=[...new Set(records.filter(r=>r.id.endsWith('-started')&&r.payload.providerThreadId).map(r=>r.payload.providerThreadId))];
 const target={phase,invocationId:registration.payload.request.invocationId,packageDigest:registration.payload.request.payload.reviewPackage.packageDigest,
  configurationDigest:digest(configuration),historyDigest:digest(records),registrationDigest:digest(registration),startedDigest:digest(started),resultDigest:digest(result),
  providerThreadIds:threads,files:baseline.files,snapshotDigest:baseline.snapshotDigest};
 inspectRecoveryBaseline(baseline,configuration.reviewVerification,registration.payload.request.payload.reviewPackage);
 return json(target,128*1024);
}
export function inspectRecoveryBaseline(baseline,configuration,pkg){
 const c=readReviewVerification(configuration),{files,snapshotDigest,checks}=baseline;
 need(Array.isArray(files)&&files.length===c.files.length&&digest(files.map(f=>f.path).sort())===digest([...c.files].sort())&&snapshotDigest===digest(files),'fix_verification_recovery_binding');
 for(const f of files){shape(f,['path','sha256','mode']);if(f.sha256===null)need(f.mode===null,'fix_verification_recovery_binding');else{hex(f.sha256);need(Number.isInteger(f.mode)&&f.mode>=0&&f.mode<=511,'fix_verification_recovery_binding');}}
 bindVerificationFiles(files,pkg);
 need(Array.isArray(checks)&&checks.length===c.checks.length,'fix_verification_recovery_baseline');
 for(const [i,r] of checks.entries())need(r.id===c.checks[i].id&&r.commandDigest===digest(c.checks[i].command)&&r.exitCode===0,'fix_verification_recovery_baseline');
}
export function inspectRecoveryPreparation(value,context){
 shape(value,['target','checks','reason','previousInvocationStopped']);
 need(value.previousInvocationStopped===true&&typeof value.reason==='string'&&value.reason.trim()&&Buffer.byteLength(value.reason)<=1000&&!/[\r\n\0\u0085\u2028\u2029]/.test(value.reason),'fix_verification_recovery_confirmation');
 const baseline={files:value.target.files,snapshotDigest:value.target.snapshotDigest,checks:value.checks};
 const expected=verificationRecoveryTarget({...context,baseline});
 need(digest(expected)===digest(value.target),'fix_verification_recovery_binding');return value;
}
