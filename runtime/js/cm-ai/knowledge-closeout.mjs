// Advisory read-only closeout over the original documentation inspection.
// A report is neither a Review receipt nor authority to change files or finish.
import {freeze,json,need,shape} from './effect-contract.mjs';

export const CLOSEOUT_VERSION=1;
export const CLOSEOUT_AREAS=Object.freeze(['code','runtime','documentation','rules','memory','residue']);
export function readCloseoutPolicy(raw){
  const value=json(raw);shape(value,['version','enabled']);
  need(value.version===CLOSEOUT_VERSION&&typeof value.enabled==='boolean','closeout_policy_unsupported');
  return freeze(value);
}
export function closeoutPolicyCandidates(execution,mode,snapshot=null){
  if(!execution?.documentationProvider&&!execution?.documentationResult)return [null];
  const workflow=execution.configuration.workflow?.configuration??execution.configuration.workflow;
  const explicit=workflow&&Object.hasOwn(workflow,'knowledgeCloseout');
  const requested=readCloseoutPolicy({version:CLOSEOUT_VERSION,enabled:explicit?workflow.knowledgeCloseout:true});
  if(mode==='create')return [requested];
  const init=snapshot?.records.find(row=>row.payload.type==='init');
  if(init){
    const saved=init.payload.config.knowledgeCloseout;
    if(saved===undefined){need(!explicit,'closeout_policy_changed');return [null];}
    const policy=readCloseoutPolicy(saved);
    need(!explicit||policy.enabled===requested.enabled,'closeout_policy_changed');
    return [policy];
  }
  // An interrupted empty initializer has no init record. Only an exact original
  // fingerprint may select one of these supported configurations; never guess.
  return explicit?[requested]:[requested,readCloseoutPolicy({version:CLOSEOUT_VERSION,enabled:false}),null];
}
export function readCloseoutReport(raw){
  const report=json(raw,16*1024);shape(report,['version','items']);
  need(report.version===CLOSEOUT_VERSION&&Array.isArray(report.items)
    &&report.items.length===CLOSEOUT_AREAS.length,'closeout_report_invalid');
  const seen=new Set();
  const string=(value,max)=>need(typeof value==='string'&&value.trim().length>0
    &&Buffer.byteLength(value,'utf8')<=max&&!/[\x00-\x1f\x7f]/.test(value),'closeout_report_invalid');
  for(const item of report.items){
    shape(item,['area','status','evidence','detail']);
    need(CLOSEOUT_AREAS.includes(item.area)&&!seen.has(item.area),'closeout_report_invalid');seen.add(item.area);
    need(['checked','issues','unverified','out_of_scope','not_applicable'].includes(item.status),'closeout_report_invalid');
    string(item.detail,1000);
    need(Array.isArray(item.evidence)&&item.evidence.length<=8,'closeout_report_invalid');
    item.evidence.forEach(value=>string(value,1000));
    need(!['checked','issues'].includes(item.status)||item.evidence.length>0,'closeout_report_invalid');
  }
  return freeze(report);
}
export function closeoutSummary(policy,documentation=null,reason='report_not_provided'){
  if(policy===null)return {};
  readCloseoutPolicy(policy);
  const report=policy.enabled&&documentation?.closeout?readCloseoutReport(documentation.closeout):null;
  return {knowledgeCloseout:{...policy,status:!policy.enabled?'disabled':report?'reported':'not_completed',
    reason:!policy.enabled?'explicitly_disabled':report?'advisory_only':reason,
    ...(documentation?{identity:documentation.identity,packageDigest:documentation.packageDigest,
      contextDigest:documentation.contextDigest,syncId:documentation.syncId}:{}),items:report?.items??[]}};
}
