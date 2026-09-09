// Deterministic projection of the runner's already-registered receipt, not a grant.
// Only the owning runner calls this after its durable review checkpoint exists.
import fs from 'node:fs';
import path from 'node:path';
import {writeReviewEvidence} from './review-evidence-file.mjs';
import {digest,need,id,text} from './effect-contract.mjs';
import {readReviewPackage} from './review-package.mjs';
import {reviewResult} from './review-runner.mjs';
import {validateReview} from '../../../scripts/cm-task-gate.mjs';

export function publishHostReview({reviewsDir,feature,handoffPath,reviewPackage,receipt,registered,at,inspectOnly=false}) {
  id(feature);
  const pkg=readReviewPackage(reviewPackage),r=receipt;
  need(r&&registered&&digest(r)===digest(registered),'unregistered_review');
  const {receiptDigest,...body}=r;
  need(receiptDigest===digest(body)&&r.packageDigest===pkg.packageDigest
    &&digest(r.identity)===digest(pkg.identity),'review_package_mismatch');
  need(r.execution.channel==='host-authorized'&&r.execution.started===true
    &&r.execution.terminal==='succeeded'&&['codex','claude'].includes(r.execution.provider),'execution_mismatch');
  id(r.execution.providerThreadId);
  const result=reviewResult(r.result,pkg);
  need(r.execution.resultDigest===digest(result),'execution_mismatch');
  return publishImplementationReview({reviewsDir,feature,handoffPath,reviewPackage:pkg,result,provider:r.execution.provider,
    reference:`Registered receipt: ${r.receiptDigest}`,at,inspectOnly});
}

// Shared deterministic file projection. Owning callers validate their durable
// invocation/receipt before entering here; this function grants no authority.
export function publishImplementationReview({reviewsDir,feature,handoffPath,reviewPackage,result:rawResult,provider,reference,at,inspectOnly=false}){
  id(feature);need(['codex','claude'].includes(provider),'execution_mismatch');text(reference);
  need(!/[\r\n\0]/.test(reference),'invalid_review_reference');
  const pkg=readReviewPackage(reviewPackage),result=reviewResult(rawResult,pkg);
  need(Number.isSafeInteger(at)&&at>=0,'clock_invalid');
  const {taskId,attempt}=pkg.identity;id(taskId);
  const handoff=pkg.handoff;need(handoff,'missing_material');
  need(path.isAbsolute(reviewsDir)&&fs.realpathSync(reviewsDir)===reviewsDir,'unsupported_path');
  need(handoffPath===path.join(reviewsDir,`${feature}-${taskId}-a${attempt}-handoff.json`)
    &&handoff.path===path.basename(handoffPath),'unsupported_path');
  const target=path.join(reviewsDir,`${feature}-${taskId}-r${attempt}.md`);
  const verdict=result.verdict==='changes_requested'&&attempt===2?'blocked':result.verdict;
  const blocking=result.findings.filter(f=>f.severity!=='P3').length;
  // A blocked review may be blocked by missing evidence rather than a code finding.
  const count=verdict==='approved'?0:Math.max(1,blocking);
  const scope=pkg.changes.map(c=>c.path);
  need(scope.every(p=>p.trim()===p),'unsupported_path');
  const bytes=Buffer.from(['---',`at: ${new Date(at).toISOString()}`,`reviewer: ${provider}-cli`,'independent: true',
    `task: ${taskId}`,`attempt: ${attempt}`,`round: ${attempt}`,`verdict: ${verdict}`,
    `handoff: ${handoff.path}`,`handoff_sha256: ${handoff.sha256}`,`blocking_findings: ${count}`,
    'scope:',...scope.map(p=>`  - ${p}`),'---','',
    verdict==='approved'?'No blocking findings.':'Review is not approved.',
    reference,
    'Reviewer result (JSON data):',JSON.stringify(result),'' ].join('\n'));
  need(bytes.length<=256*1024,'limit_exceeded');
  return writeReviewEvidence({reviewsDir,name:path.basename(target),bytes,inspectOnly,
    validate:file=>validateReview(file,{task:taskId,attempt,handoff:handoffPath,changedFiles:scope})});
}
