// Journal data grammar. Only the trusted serial host supplies original owner evidence.
import {digest,hex,id,json,need,shape,validIdentity} from './effect-contract.mjs';
import {qaFixIdentity} from '../cm-fix/qa-source.mjs';
import {composeFixCode} from './fix-code-association.mjs';

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
  const {files}=composeFixCode({baseline,parentPackage,fixPackages:[...previous.map(item=>item.evidence.reviewPackage),e.reviewPackage]});
  need(digest(a)===digest({version:1,kind:'cm-fix-code-association',parentPackageDigest:parentPackage.packageDigest,
    fixPackageDigest:e.reviewPackage.packageDigest,currentFilesDigest:digest(files)}),'fix_association_invalid');
  return json(record,12*1024*1024);
}
