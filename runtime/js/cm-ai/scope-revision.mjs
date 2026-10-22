// Append-only scope evidence for one unreviewed conversation-owned delivery.
// A reason records the decision; it is not an authentication or grant mechanism.
import {digest,need} from './effect-contract.mjs';
import {validateDeveloperScope} from './developer-adapter.mjs';
import {readReviewScope,extendReviewBaseline} from './review-package.mjs';

export function revisedScope(value,current){
  validateDeveloperScope(value);
  const scope=readReviewScope(value);
  need(current.every(file=>scope.includes(file)),'scope_revision_shrink');
  need(scope.length>current.length,'scope_revision_no_additions');
  return scope;
}
export function scopeRevisionBinding(s,config,count=0){
  const entry=s.cache.at(-1);
  need(config.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'
    &&config.controlPolicy.bootstrap==='disabled'
    &&config.controlPolicy.qaFix==='disabled'&&config.bootstrap==null
    &&s.state==='blocked'&&s.code==='develop_checks_not_passed'&&s.attempt===1
    &&s.reviewPackage===null&&s.receipt===null&&s.receipts.length===0&&s.priorReview===null
    &&s.reviewInvocation===null&&s.taskCommit==null&&!s.cancellationRequested
    &&!s.cancelAfterCommit&&!s.workflowError&&count===0
    &&entry?.effect.kind==='develop'&&entry.effect.identity.attempt===s.attempt
    &&entry.result.state==='blocked'&&entry.result.code===s.code,'scope_revision_unavailable');
  return {effectId:entry.effect.id,failedCheckpointDigest:digest(entry),previousScopeDigest:digest(config.scope)};
}
export function applyScopeRevision(state,config,baseline,record,count=0){
  const expected=scopeRevisionBinding(state,config,count);
  for(const key of Object.keys(expected))need(record[key]===expected[key],'scope_revision_source_changed');
  need(record.baselineDigest===baseline.baselineDigest,'scope_revision_source_changed');
  const scope=revisedScope(record.scope,config.scope);
  need(digest(scope)===digest(record.scope),'invalid_input');
  need(typeof record.reason==='string'&&record.reason.trim().length>0
    &&Buffer.byteLength(record.reason,'utf8')<=500&&!/[\r\n\0]/.test(record.reason),'scope_revision_reason_required');
  need(typeof record.at==='string'&&Number.isFinite(Date.parse(record.at))
    &&new Date(record.at).toISOString()===record.at,'invalid_input');
  return {scope,baseline:extendReviewBaseline(baseline,scope,record.files)};
}
