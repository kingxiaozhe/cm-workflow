// Trusted host decision -> existing V3 synchronous grant. No dispatch or durable
// authority database. The runner alone registers, consumes and replays grants.
import {randomUUID} from 'node:crypto';
import {digest,id,json,need,shape,validIdentity} from './effect-contract.mjs';

const denied=()=>({status:'denied',code:'permission_denied'});
export function createHostReviewAuthority({hostContextId,reviewerId,adapterId,decide,timeoutMs=60000}){
  [hostContextId,reviewerId,adapterId].forEach(id);
  need(typeof decide==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000);
  let approved=null;
  const hostDecisionProvider=Object.freeze({timeoutMs,async decide(binding,signal){
    approved=null;need(!signal.aborted,'cancelled');
    const decision=json(await decide(binding,signal));need(!signal.aborted,'cancelled');
    if(decision===null)return null;
    if(decision.status==='denied'){shape(decision,['status','code']);need(decision.code==='permission_denied');return denied();}
    shape(decision,['status']);need(decision.status==='approved');
    // The binding is supplied by the original entry, not by the returned text.
    validIdentity(binding.identity);
    approved={identity:json(binding.identity),packageDigest:binding.packageDigest,signal,
      decisionId:randomUUID(),decidedAt:Date.now()};
    return {status:'approved'};
  }});
  const authorize=(request,{authorizationAt})=>{
    const decision=approved;approved=null;
    if(!decision||decision.signal.aborted||request.role!=='reviewer'
      ||!Number.isSafeInteger(authorizationAt)||authorizationAt<decision.decidedAt||authorizationAt>=decision.decidedAt+60000
      ||digest(request.identity)!==digest(decision.identity)
      ||request.payload.reviewPackage.packageDigest!==decision.packageDigest)return denied();
    const body={version:1,kind:'cm-review-dispatch-grant',grantId:randomUUID(),adapterId,
      invocationId:request.invocationId,requestDigest:request.requestDigest,identity:json(request.identity),
      reviewerId,logicalContextId:request.contextId,packageDigest:decision.packageDigest,hostContextId,
      decisionId:decision.decisionId,decision:'approved',issuedAt:authorizationAt,expiresAt:decision.decidedAt+60000};
    return {...body,grantDigest:digest(body)};
  };
  return Object.freeze({hostDecisionProvider,authorize});
}
