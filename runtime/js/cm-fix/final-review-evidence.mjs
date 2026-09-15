// Projection from registered final invocation records, never from a bare verdict.
import path from 'node:path';
import {digest,need} from '../cm-ai/effect-contract.mjs';
import {publishImplementationReview} from '../cm-ai/host-review-file.mjs';
import {fixFinalReviewConfiguration,fixRevisionReviewConfiguration,inspectFixFinalRegistration,inspectFixFinalResult} from './final-review.mjs';

export function publishFixFinalEvidence({specsRoot,configuration,causeThread=null,registration,started,result,inspectOnly=false,reviewFeedback=null}){
  const config=reviewFeedback?fixRevisionReviewConfiguration(reviewFeedback,registration.request.identity):fixFinalReviewConfiguration(configuration,causeThread);
  const registered=inspectFixFinalRegistration(registration,config);
  const checked=inspectFixFinalResult(result,registered,config,started);
  need(checked.observationStatus==='completed','final_review_evidence_unavailable');
  const pkg=registered.request.payload.reviewPackage;
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(pkg.identity.taskId)?.[1];need(slug,'invalid_fix_slug');
  const feature=`fix-${slug}`,reviewsDir=path.join(specsRoot,'.reviews');
  return publishImplementationReview({reviewsDir,feature,
    handoffPath:path.join(reviewsDir,`${feature}-${pkg.identity.taskId}-a${pkg.identity.attempt}-handoff.json`),
    reviewPackage:pkg,result:checked.review,provider:checked.provider,
    reference:`Registered invocation: ${registered.request.invocationId}; registration: ${digest(registered)}; observation: ${checked.observationDigest}`,
    at:registered.registeredAt,inspectOnly});
}
