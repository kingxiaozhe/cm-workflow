// A one-time extension of a completed run, never a replacement store identity.
import {json,shape,need,hex,id} from './effect-contract.mjs';

export function readQaAttachment(raw){
  const record=json(raw);
  shape(record,['version','qaFingerprint','attachedAt','hostContextId']);
  need(record.version===1,'qa_attachment_invalid');hex(record.qaFingerprint);id(record.hostContextId);
  need(typeof record.attachedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.attachedAt)
    &&Number.isFinite(Date.parse(record.attachedAt)),'qa_attachment_invalid');
  return record;
}

// Reconstruct only supported pre-QA configurations. All unrelated fields remain
// byte-for-byte digest inputs, including definition, host, protection and review.
export function preQaConfigurations(material){
  if(!material?.execution)return [];
  const wrapped=Object.hasOwn(material.execution.workflow??{},'configuration');
  const workflow=wrapped?material.execution.workflow.configuration:material.execution.workflow;
  if(!workflow?.qa||!material.qaExecutor||!material.qaDecisionProvider)return [];
  const withoutQa=structuredClone(json(material));
  delete withoutQa.qaExecutor;delete withoutQa.qaDecisionProvider;delete withoutQa.qaTimeoutMs;
  const priorWorkflow=wrapped?withoutQa.execution.workflow.configuration:withoutQa.execution.workflow;
  priorWorkflow.qa=null;
  const withoutWorkflow=structuredClone(withoutQa);
  delete withoutWorkflow.execution.workflow;
  delete withoutWorkflow.documentationProvider;delete withoutWorkflow.documentationSync;
  if(withoutWorkflow.execution.kind==='cm-current-conversation-v1')withoutWorkflow.applicableAgentFiles=[];
  else delete withoutWorkflow.applicableAgentFiles;
  return [withoutQa,withoutWorkflow];
}
