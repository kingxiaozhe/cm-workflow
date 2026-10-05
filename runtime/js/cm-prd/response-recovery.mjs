// Projection of an already recorded response. No dispatch, verdict edit or retry.
import {json,digest,need,shape,id} from '../cm-ai/effect-contract.mjs';
import {inspectPrdReviewResponse} from './review-publication.mjs';
import {normalizePrdReviewTimestamp} from './review-time.mjs';
export function readPrdRepairBinding(raw){
  const binding=json(raw,8192);shape(binding,['callId','requestDigest','resultDigest','packageDigest','reason']);
  id(binding.callId);for(const key of ['requestDigest','resultDigest','packageDigest'])
    need(typeof binding[key]==='string'&&/^[a-f0-9]{64}$/.test(binding[key]),'prd_recovery_binding');
  need(typeof binding.reason==='string'&&binding.reason.trim().length>0&&Buffer.byteLength(binding.reason,'utf8')<=1000
    &&!/[\x00-\x1f\u0085\u2028\u2029]/.test(binding.reason),'prd_recovery_evidence_required');
  return binding;
}
export function recoverPrdResponse({original,reviewPackage,packageDigest,authorContextId}){
  const response={...json(original,64*1024)},changes=[];
  if(response.reviewer!=='self-degraded'&&Object.hasOwn(response,'degradedReason')&&response.degradedReason===null){
    delete response.degradedReason;changes.push('omit-independent-null-degradedReason');
  }
  const at=normalizePrdReviewTimestamp(response.at);
  if(at!==response.at){response.at=at;changes.push('canonical-exact-timestamp');}
  inspectPrdReviewResponse({reviewPackage,packageDigest,authorContextId,response});
  need(digest(original.result)===digest(response.result),'prd_recovery_verdict_changed');
  return {response,changes};
}
