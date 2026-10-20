// A task-local executor extension. The original policy and store fingerprints
// remain authoritative; this record neither runs QA nor changes its decision.
import {json,shape,need,hex,id,validIdentity,arrayItems} from './effect-contract.mjs';

export function validateQaExecutorAttachmentReason(reason){
  need(typeof reason==='string'&&reason.trim().length>0&&Buffer.byteLength(reason,'utf8')<=500
    &&!/[\x00-\x1f\x7f\u2028\u2029]/.test(reason),'qa_executor_attachment_authorization_required');
  return reason;
}

export function readQaExecutorAttachment(raw){
  const record=json(raw);
  shape(record,['version','fromFingerprint','toFingerprint','executorDigest','sourceRevision','packageDigest',
    'taskCommitDigest','decisionId','decisionDigest','taskAttempt','reason','hostContextId','attachedAt']);
  need(record.version===1,'qa_executor_attachment_invalid');
  for(const key of ['fromFingerprint','toFingerprint','executorDigest','sourceRevision','packageDigest',
    'taskCommitDigest','decisionDigest'])hex(record[key]);
  need(record.fromFingerprint!==record.toFingerprint,'qa_executor_attachment_invalid');
  id(record.decisionId);id(record.hostContextId);
  need([1,2].includes(record.taskAttempt),'qa_executor_attachment_invalid');
  validateQaExecutorAttachmentReason(record.reason);
  need(typeof record.attachedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.attachedAt)
    &&Number.isFinite(Date.parse(record.attachedAt))
    &&new Date(record.attachedAt).toISOString()===record.attachedAt.replace('Z','.000Z'),'qa_executor_attachment_invalid');
  return record;
}

// The owner and journal replay share these target checks. Decision identity and
// executor material are checked by the caller against their authoritative data.
export function validateQaExecutorAttachment(raw,{fingerprints,identity,packageDigest,taskCommitDigest,
  state,code,pending,previous,sourceRevision,controlPolicy}){
  const record=readQaExecutorAttachment(raw);
  need(state==='fixture_completed'&&code===null&&pending===null&&previous===null,
    'qa_executor_attachment_unavailable');
  const policy=json(controlPolicy);
  shape(policy,['version','development','bootstrap','qa','qaFix']);
  need(policy.version===2&&policy.development==='conversation'&&policy.bootstrap==='disabled'
    &&policy.qa==='disabled'&&policy.qaFix==='disabled','qa_executor_attachment_unavailable');
  validIdentity(identity);
  hex(fingerprints?.config);hex(packageDigest);hex(taskCommitDigest);hex(sourceRevision);
  need(record.fromFingerprint===fingerprints.config&&record.packageDigest===packageDigest
    &&record.taskCommitDigest===taskCommitDigest&&record.taskAttempt===identity.attempt
    &&record.sourceRevision===sourceRevision,'qa_executor_attachment_mismatch');
  return record;
}

// This lookup checks only the attachment schema and chain exclusivity. Full
// target validation still belongs to the owner/replay transition, never lookup.
export function qaExecutorAttachmentIn(snapshot){
  let attachment=null,legacy=false;
  for(const row of arrayItems(snapshot.records)){
    const type=row.payload?.type;
    if(type==='qa-attached'||type==='qa-config-revised')legacy=true;
    if(type!=='qa-executor-attached')continue;
    need(attachment===null,'qa_executor_attachment_conflict');
    attachment=readQaExecutorAttachment(row.payload.record);
  }
  need(attachment===null||!legacy,'qa_executor_attachment_conflict');
  return attachment;
}
