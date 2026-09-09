// Projection of a registered completed cause invocation; never an N4 implementation receipt.
import path from 'node:path';
import {digest,need} from '../cm-ai/effect-contract.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {inspectCauseRegistration,inspectCauseResult} from './cause-invocation.mjs';

export function publishCauseEvidence({specsRoot,configuration,registration,started,result,inspectOnly=false}){
  const bound=inspectCauseRegistration(registration,configuration);
  const checked=inspectCauseResult(result,bound,configuration,started);
  need(checked.observationStatus==='completed','cause_evidence_unavailable');
  const pkg=bound.request.payload.reviewPackage;
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(pkg.identity.taskId)?.[1];
  need(slug,'invalid_fix_slug');
  const bytes=Buffer.from(['---',`at: ${new Date(bound.registeredAt).toISOString()}`,
    `reviewer: ${checked.provider}-cli`,'independent: true',`task: ${pkg.identity.taskId}`,
    'phase: cause','round: 1',`verdict: ${checked.review.verdict}`,`package_sha256: ${pkg.packageDigest}`,
    `request_sha256: ${bound.request.requestDigest}`,'scope:',...pkg.files.map(file=>`  - ${JSON.stringify(file.path)}`),
    '---','','Root-cause review only. This is not N4 implementation approval.',
    ...(pkg.correction?['Late observation cause review (data; not evidence of an earlier review):',JSON.stringify(pkg.correction)]:[]),
    `Registered invocation: ${bound.request.invocationId}`,`Registration digest: ${digest(bound)}`,
    `Observation digest: ${checked.observationDigest}`,`Provider thread: ${checked.providerThreadId}`,
    'Reviewer result (JSON data):',JSON.stringify(checked.review),''].join('\n'));
  return writeReviewEvidence({reviewsDir:path.join(specsRoot,'.reviews'),name:`fix-${slug}-cause-r1.md`,bytes,inspectOnly});
}
