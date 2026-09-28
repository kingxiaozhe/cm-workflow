// Journal data grammar. Only the trusted serial host supplies original owner evidence.
import {digest,hex,id,json,need,shape,validIdentity} from './effect-contract.mjs';
import {qaFixIdentity} from '../cm-fix/qa-source.mjs';
import {associationRecord,composeFixCode} from './fix-code-association.mjs';

export function validateAcceptedFix({record,previous,baseline,parentPackage,feature}){
  shape(record,['evidence','association','qaRound']);
  const {evidence:e,association:a,qaRound}=record;
  shape(e,['version','kind','identity','qaSource','checkpointRevision','reviewPackage','reviewRegistrationDigest',
    'reviewObservationDigest','handoffSha256','completionHistory']);
  need(e.version===1&&e.kind==='cm-fix-completion-evidence','fix_evidence_invalid');validIdentity(e.identity);
  const child=qaFixIdentity(e.qaSource);
  need(digest({...e.identity,attempt:1})===digest(child)&&[1,2].includes(e.identity.attempt),'fix_evidence_invalid');
  need(digest(e.qaSource.identity)===digest(parentPackage.identity)&&e.qaSource.packageDigest===parentPackage.packageDigest
    &&e.qaSource.feature===feature,'fix_parent_binding_mismatch');
  for(const key of ['checkpointRevision','reviewRegistrationDigest','reviewObservationDigest','handoffSha256'])hex(e[key]);
  need(digest(e.reviewPackage.identity)===digest(e.identity)&&e.reviewPackage.handoff?.sha256===e.handoffSha256,'fix_evidence_invalid');
  shape(e.completionHistory,['taskDoneEventIds','runDoneEventIds']);
  for(const rows of Object.values(e.completionHistory)){
    need(Array.isArray(rows)&&rows.length>0,'fix_evidence_invalid');rows.forEach(id);
  }
  need(qaRound===previous.length+1&&qaRound<=2,'fix_chain_invalid');
  need(!previous.some(item=>item.evidence.qaSource.testRunId===e.qaSource.testRunId),'fix_chain_invalid');
  // Version 1: strict chain. Version 2 keeps the previous record's interleaved
  // deliveries as an exact prefix and may add only steps preceding this fix.
  const steps=a?.version===2?a.laterDeliveries:[],prior=previous.at(-1)?.association.laterDeliveries??[];
  need(Array.isArray(steps)&&(a?.version!==2||steps.length>0)&&steps.length>=prior.length
    &&digest(steps.slice(0,prior.length))===digest(prior)
    &&steps.slice(prior.length).every(step=>step?.beforeFix===previous.length),'fix_association_invalid');
  const composed=composeFixCode({baseline,parentPackage,fixPackages:[...previous.map(item=>item.evidence.reviewPackage),e.reviewPackage],steps});
  need(digest(a)===digest(associationRecord({...composed,steps})),'fix_association_invalid');
  return json(record,12*1024*1024);
}
