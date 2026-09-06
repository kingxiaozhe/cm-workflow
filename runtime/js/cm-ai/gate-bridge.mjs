// Pure S2b comparison only. This is not the Python gate and cannot write tasks.
import { digest,need,shape,id,json,validIdentity } from './effect-contract.mjs';
import { reviewResult } from './review-runner.mjs';
export function checkCompletion({receipt,registered,execution,reviewPackage,identity}) {
  const r=json(receipt);validIdentity(identity);
  shape(r,['version','kind','id','identity','packageDigest','baseIdentity','artifactDigest',
    'requirementsDigest','checksDigest','execution','route','result','receiptDigest']);
  need(r.version===1 && r.kind==='cm-review-receipt','receipt_version');
  need(registered!==undefined && digest(r)===digest(json(registered)),'unregistered_receipt');
  const {receiptDigest,...data}=r;need(digest(data)===receiptDigest,'invalid_receipt');
  need(digest(r.identity)===digest(identity) && digest(reviewPackage.identity)===digest(identity),'receipt_identity');
  for(const field of ['packageDigest','baseIdentity','artifactDigest','requirementsDigest','checksDigest'])
    need(r[field]===reviewPackage[field],'receipt_package_mismatch');
  const executionKeys=['invocationId','contextId','provider','requestedModel','effectiveModel','channel','started','terminal','requestDigest','resultDigest'];
  const hostAuthorized=r.execution?.channel==='host-authorized';
  shape(r.execution,[...executionKeys,...(hostAuthorized?['providerThreadId']:[])]);
  need(['fixture','host-authorized'].includes(r.execution.channel),'execution_mismatch');
  if(hostAuthorized)id(r.execution.providerThreadId);
  need(r.id===r.execution.invocationId && r.execution.started===true && r.execution.terminal==='succeeded'
    && digest(r.execution)===digest(json(execution)),'execution_mismatch');
  const result=reviewResult(r.result,reviewPackage);
  need(r.execution.resultDigest===digest(result) && result.verdict==='approved','review_not_approved');
  need(reviewPackage.checks.length>0 && reviewPackage.checks.every(c=>c.outcome==='passed' && c.exitCode===0),'checks_not_passed');
  return json({outcome:'eligible',receiptDigest});
}
