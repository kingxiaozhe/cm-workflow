import {inspectReviewScope,assertReviewScope} from './review-scope-policy.mjs';
import {readExecutionPolicy} from './execution-policy.mjs';
import {reconciliationControl} from './review-reconciliation.mjs';
// Claude normalized review bridge, no process dispatch or authority of its own.
import {need} from './effect-contract.mjs';
import {buildReviewPrompt} from './codex-review-adapter.mjs';
export function buildClaudeReviewPrompt(raw){
  need(arguments.length===1,'review_request_invalid');
  return buildReviewPrompt(raw,'claude');
}
export function createClaudeReviewRun(worker,executionPolicy=null){
  if(executionPolicy)readExecutionPolicy(executionPolicy);
  need(arguments.length<=2&&typeof worker==='function','review_worker_invalid');
  return Object.freeze((request,control)=>{
    need(control&&typeof control==='object'&&typeof control.onEvent==='function'
      &&control.signal&&typeof control.signal.aborted==='boolean','review_control_invalid');
    const prompt=buildReviewPrompt(request,'claude',executionPolicy);
    if(control.reviewScopeAdmission)assertReviewScope(inspectReviewScope(prompt,request.payload.reviewPackage,control.reviewScopeAdmission.limits));
    return worker({prompt},
      reconciliationControl(control));
  });
}
