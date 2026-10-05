// Owner journal evidence only. Public requests supply invocationId, never receipts.
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
import {readReconciliationReceipt} from '../cm-ai/review-reconciliation.mjs';
import {inspectProviderReview,inspectProviderCauseReview,inspectProviderReviewReconciliation} from '../cm-ai/provider-review-observation.mjs';

export function inspectFixReconciledResult(value,expectation,cause=false){
  const receipt=readReconciliationReceipt(value.reconciliationReceipt);
  const original=value.observation;
  const checked=(cause?inspectProviderCauseReview:inspectProviderReview)(JSON.stringify(original),JSON.stringify(expectation));
  need(checked.observationStatus!=='completed'&&Array.isArray(receipt.events)
    &&receipt.events.length<=64&&receipt.events.length>=original.events.length,'review_reconciliation_evidence_required');
  need(digest(original.events)===digest(receipt.events.slice(0,original.events.length)),'review_reconciliation_binding');
  const observation={...original,events:receipt.events,result:receipt.result};
  const result=inspectProviderReviewReconciliation(JSON.stringify(observation),JSON.stringify(expectation),cause);
  // A failed original call has stopped, but cannot become an approving receipt.
  return result;
}

export function fixReviewLedger(records,configuration){
  const receipts=new Map(),applied=new Set(),overlays=new Map();
  for(const row of records){
    if(!/^fix-review-(receipt|reconciled)-[0-9a-f]{24}$/.test(row.id))continue;
    need((configuration.externalModels||configuration.executionPolicy)&&row.kind==='result','fix_history_invalid');
    const p=json(row.payload,1024*1024),isReceipt=row.id.startsWith('fix-review-receipt-');
    shape(p,['prefix','invocationId','registeredDigest','startedDigest','resultDigest',...(isReceipt?['receipt']:['receiptDigest'])]);
    need(/^fix-(?:cause(?:-(?:retry|rediagnosis))?|(?:revision-)?final(?:-(?:retry|recovery(?:-[1-9]\d*)?))?)$/.test(p.prefix),'review_reconciliation_binding');
    need(row.id===`fix-review-${isReceipt?'receipt':'reconciled'}-${digest(p.invocationId).slice(0,24)}`,'review_reconciliation_binding');
    const prior=records.filter(r=>r.seq<row.seq);
    const registration=prior.find(r=>r.id===p.prefix+'-registered'),started=prior.find(r=>r.id===p.prefix+'-started'),result=prior.find(r=>r.id===p.prefix+'-result');
    need(registration&&started&&result&&registration.seq<started.seq&&started.seq<result.seq
      &&registration.payload.request.invocationId===p.invocationId
      &&digest(registration)===p.registeredDigest&&digest(started)===p.startedDigest&&digest(result)===p.resultDigest,'review_reconciliation_binding');
    need(prior.filter(r=>r.seq>result.seq).every(r=>/^fix-host-joined-/.test(r.id)||/^fix-review-(?:receipt|reconciled)-/.test(r.id)),
      'review_reconciliation_unavailable');
    const binding={prefix:p.prefix,invocationId:p.invocationId,registeredDigest:p.registeredDigest,startedDigest:p.startedDigest,resultDigest:p.resultDigest};
    if(isReceipt){
      need(!receipts.has(p.invocationId),'review_reconciliation_duplicate');
      const request=registration.payload.request;
      const hosts=[configuration.hostContextId,...prior.filter(r=>/^fix-host-joined-/.test(r.id)).map(r=>r.payload.hostContextId)];
      const excluded=[...hosts,...configuration.causeReview.excludedThreadIds,request.contextId,
        ...prior.filter(r=>/-started$/.test(r.id)&&r.id!==started.id&&r.payload.providerThreadId).map(r=>r.payload.providerThreadId)];
      const inspection=inspectFixReconciledResult({...result.payload,reconciliationReceipt:p.receipt},
        {request,developerThreadId:hosts[0],excludedThreadIds:[...new Set(excluded)]},p.prefix.includes('cause'));
      need(inspection.providerThreadId===started.payload.providerThreadId,'review_reconciliation_binding');
      receipts.set(p.invocationId,{...binding,receipt:p.receipt,receiptDigest:digest(row),inspection,resultRecord:result});
    }else{
      const proof=receipts.get(p.invocationId);
      need(proof&&!applied.has(p.invocationId)&&proof.receiptDigest===p.receiptDigest
        &&digest(binding)===digest(Object.fromEntries(Object.keys(binding).map(k=>[k,proof[k]]))),'review_reconciliation_binding');
      applied.add(p.invocationId);
      if(proof.inspection.observationStatus==='completed')overlays.set(result.id,{...result.payload,reconciliationReceipt:proof.receipt});
    }
  }
  return {receipts,applied,overlays,pending:[...receipts.values()].filter(p=>!applied.has(p.invocationId))};
}
export function reconciledFixResultRecord(records,row){
  if(!row||row.payload.reconciliationReceipt)return row;
  const applied=records.find(r=>r.id.startsWith('fix-review-reconciled-')&&r.payload.prefix+'-result'===row.id);
  if(!applied)return row;
  const receipt=records.find(r=>digest(r)===applied.payload.receiptDigest);
  need(receipt&&digest(row)===applied.payload.resultDigest,'review_reconciliation_binding');
  return receipt.payload.receipt.result.status==='succeeded'
    ?{...row,payload:{...row.payload,reconciliationReceipt:receipt.payload.receipt}}:row;
}
