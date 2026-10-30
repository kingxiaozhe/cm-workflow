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

// The configurations a v2 run with qa:"disabled" was created with, derived from
// the qa:"run" launch that turns QA on: the policy's qa value, the executor and
// at most the QA part of the workflow differ. Under qa:"disabled" the host kept a
// given workflow (its qa as given, or null) and the QA decision; without any
// workflow it kept the implicit decision (implicit-qa-decision.mjs), and runs
// older than that had no decision at all. Each still has to equal the saved digest.
export function preQaUpgradeConfigurations(material){
  if(material?.execution?.controlPolicy?.qa!=='run'||!material.qaExecutor||!material.qaDecisionProvider)return [];
  const base=structuredClone(json(material));base.execution.controlPolicy.qa='disabled';
  const kept=structuredClone(base);delete kept.qaExecutor;
  const nullQa=structuredClone(kept);
  const wrapped=Object.hasOwn(nullQa.execution.workflow??{},'configuration');
  const workflow=wrapped?nullQa.execution.workflow.configuration:nullQa.execution.workflow;
  if(!workflow?.qa)return [];
  workflow.qa=null;
  const candidates=preQaConfigurations(base);
  const decided=structuredClone(candidates[1]);
  decided.qaDecisionProvider=material.qaDecisionProvider;decided.qaTimeoutMs=material.qaTimeoutMs;
  const plain=structuredClone(decided);delete plain.applicableAgentFiles;
  return [kept,nullQa,...candidates,decided,plain];
}
