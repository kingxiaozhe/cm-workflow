// Explicit QA-only configuration succession. No development state is replaced.
import {digest,json,shape,need,hex,id,text} from './effect-contract.mjs';
import {createHostQaExecutor} from './host-qa-executor.mjs';
import {validateHostWorkflowConfiguration} from './host-workflow-capabilities.mjs';
import {preQaConfigurations,readQaAttachment} from './qa-attachment.mjs';

const workflow=material=>material.execution?.workflow?.configuration??material.execution?.workflow;
export function qaConfigurationSlice(material){
  const qa=workflow(material)?.qa,executor=material.qaExecutor,c=executor?.configuration;
  need(qa&&c?.kind==='cm-host-qa-executor-v1','qa_revision_configuration_required');
  return json({qa,mode:executor.mode,caseCount:executor.caseCount,timeoutMs:executor.timeoutMs,
    executor:{commands:c.commands,environment:c.environment,timeoutMs:c.timeoutMs,
      commandsPlan:c.plan.commands,modes:c.plan.modes}});
}
function withQaConfiguration(material,slice){
  const result=structuredClone(json(material)),c=result.qaExecutor.configuration;
  workflow(result).qa=slice.qa;
  Object.assign(result.qaExecutor,{mode:slice.mode,caseCount:slice.caseCount,timeoutMs:slice.timeoutMs});
  Object.assign(c,{commands:slice.executor.commands,environment:slice.executor.environment,timeoutMs:slice.executor.timeoutMs});
  Object.assign(c.plan,{commands:slice.executor.commandsPlan,modes:slice.executor.modes});
  return result;
}
export function qaInvariantDigest(material){
  return digest(withQaConfiguration(material,{qa:null,mode:null,caseCount:null,timeoutMs:null,
    executor:{commands:null,environment:null,timeoutMs:null,commandsPlan:null,modes:null}}));
}
export function previousQaMaterial(material,previousWorkflow){
  qaConfigurationSlice(material);
  const prior=validateHostWorkflowConfiguration(previousWorkflow),current=workflow(material);
  need(prior.qa!==null,'qa_revision_configuration_required');
  need(digest({...prior,qa:null})===digest({...current,qa:null}),'fingerprint_mismatch');
  const result=structuredClone(json(material)),{kind,plan,capabilities,...configuration}=result.qaExecutor.configuration;
  need(kind==='cm-host-qa-executor-v1','qa_revision_configuration_required');
  // Rebuild the old plan using the same executor validator and unchanged project
  // policy. These callbacks are capability markers and are never dispatched.
  const executor=createHostQaExecutor({...configuration,commands:prior.qa.commands,environment:prior.qa.environment,
    ...(capabilities.logic?{logic:()=>{}}:{}),...(capabilities.browser?{browser:()=>{}}:{})});
  result.qaExecutor={version:1,mode:executor.mode,caseCount:executor.caseCount,timeoutMs:executor.timeoutMs,configuration:executor.configuration};
  workflow(result).qa=prior.qa;
  need(qaInvariantDigest(result)===qaInvariantDigest(material),'fingerprint_mismatch');
  return result;
}
export function readQaConfigRevision(raw){
  const r=json(raw);
  shape(r,['version','fromFingerprint','toFingerprint','invariantDigest','previousQaDigest','qaDigest','reason','hostContextId',
    'revisedAt','packageDigest','testRunId','qaRound','taskAttempt']);
  need(r.version===1,'qa_revision_invalid');
  for(const key of ['fromFingerprint','toFingerprint','invariantDigest','packageDigest','previousQaDigest','qaDigest'])hex(r[key]);
  need(r.fromFingerprint!==r.toFingerprint&&r.previousQaDigest!==r.qaDigest,'qa_revision_unchanged');
  id(r.hostContextId);id(r.testRunId);text(r.reason);
  need(r.reason.trim().length>0&&r.reason.length<=500&&!/[\r\n\0]/.test(r.reason),'qa_revision_authorization_required');
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.revisedAt)&&Number.isFinite(Date.parse(r.revisedAt)),'qa_revision_invalid');
  need([1,2].includes(r.taskAttempt),'qa_revision_invalid');
  need(Number.isInteger(r.qaRound)&&r.qaRound>=1&&r.qaRound<3,'qa_round_invalid');
  return r;
}
export function qaRevisionChain(snapshot){
  let fingerprint=snapshot.fingerprints.config,invariant=null,attached=false;const revisions=[];
  for(const row of snapshot.records){
    if(row.payload.type==='qa-attached'){
      need(!attached,'qa_attachment_duplicate');attached=true;
      need(revisions.length===0,'qa_revision_chain_invalid');fingerprint=readQaAttachment(row.payload.record).qaFingerprint;
    }
    if(row.payload.type!=='qa-config-revised')continue;
    const r=readQaConfigRevision(row.payload.record);
    need(r.fromFingerprint===fingerprint&&(invariant===null||r.invariantDigest===invariant)
      &&(!revisions.length||(r.previousQaDigest===revisions.at(-1).qaDigest
        &&r.qaRound>revisions.at(-1).qaRound)),'qa_revision_chain_invalid');
    fingerprint=r.toFingerprint;invariant=r.invariantDigest;revisions.push(r);
  }
  return {fingerprint,revisions};
}
export function verifyQaRevisionMaterial(snapshot,material,prior=null){
  const {fingerprint,revisions}=qaRevisionChain(snapshot);
  const candidate=prior??material;
  need(digest(candidate)===fingerprint,'fingerprint_mismatch');
  if(revisions.length){
    need(qaInvariantDigest(material)===revisions.at(-1).invariantDigest,'fingerprint_mismatch');
    need(digest(qaConfigurationSlice(candidate))===revisions.at(-1).qaDigest,'fingerprint_mismatch');
  }else{
    const attached=snapshot.records.some(row=>row.payload.type==='qa-attached');
    need((attached?preQaConfigurations(candidate):[candidate]).some(p=>digest(p)===snapshot.fingerprints.config),'fingerprint_mismatch');
  }
  return revisions;
}
