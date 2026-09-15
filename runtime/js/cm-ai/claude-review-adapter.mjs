// Claude normalized review bridge, no process dispatch or authority of its own.
import {need} from './effect-contract.mjs';
import {buildReviewPrompt} from './codex-review-adapter.mjs';
export function buildClaudeReviewPrompt(raw){
  need(arguments.length===1,'review_request_invalid');
  return buildReviewPrompt(raw,'claude');
}
export function createClaudeReviewRun(worker){
  need(arguments.length===1&&typeof worker==='function','review_worker_invalid');
  return Object.freeze((request,control)=>{
    need(control&&typeof control==='object'&&typeof control.onEvent==='function'
      &&control.signal&&typeof control.signal.aborted==='boolean','review_control_invalid');
    return worker({prompt:buildClaudeReviewPrompt(request)},
      {signal:control.signal,onEvent:control.onEvent});
  });
}
