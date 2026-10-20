// One bounded, mechanical recovery of a completed planning refusal. No draft or review dispatch.
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
const keys=['sessionId','checkpointDigest','sourceDigest','configDigest','blockedReplyDigest','reason'];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validSession=value=>typeof value==='string'&&/^prd-[a-zA-Z0-9-]{1,80}$/.test(value);
const histories=state=>{
  const records=state.planningRecoveries??[];
  need(Array.isArray(records)&&records.length<=1,'prd_planning_recovery_binding');return records;
};
function eligible(state){
  const checkpoint=state.checkpoint,analysis=checkpoint?.analysis,last=analysis?.planning?.at(-1);
  need(state.active===null&&state.identity?.entry?.change===undefined&&checkpoint?.change===null
    &&checkpoint.started===true&&checkpoint.reviewState===null&&checkpoint.summaryState===null
    &&checkpoint.publishedSummary===false&&analysis?.stage==='blocked'&&analysis.result?.status==='analyzed'
    &&analysis.designPlanning===true&&last?.role==='assistant'&&last.result?.status==='blocked'
    &&typeof last.result.reason==='string'&&last.result.reason.trim()
    &&['draft','designDraft','acceptedDesign','designRiskSelection','designPromotion','contextCheck']
      .every(key=>analysis[key]===null)
    &&(analysis.selfCheckRevision??null)===null&&analysis.selfCheckRound===0
    &&Array.isArray(analysis.selfCheckHistory)&&analysis.selfCheckHistory.length===0,
  'prd_planning_recovery_not_ready');
  need(hash(analysis.sourceDigest)&&hash(analysis.configDigest),'prd_planning_recovery_binding');
  return {checkpoint,analysis,last};
}
export function inspectPrdPlanningRecovery(state,{sessionId}){
  need(validSession(sessionId),'prd_planning_recovery_binding');
  need(histories(state).length===0,'prd_planning_recovery_limit');
  const {checkpoint,analysis,last}=eligible(state);
  return {sessionId,checkpointDigest:digest(checkpoint),sourceDigest:analysis.sourceDigest,
    configDigest:analysis.configDigest,blockedReplyDigest:digest(last.result)};
}
export function readPrdPlanningRecoveryBinding(raw){
  const value=json(raw,8192);shape(value,keys);
  need(validSession(value.sessionId)&&keys.slice(1,-1).every(key=>hash(value[key])),'prd_planning_recovery_binding');
  need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason)<=1000
    &&!/\p{Cc}|[\u0085\u2028\u2029]/u.test(value.reason),'prd_planning_recovery_reason_required');
  return value;
}
function inspectRecord(record,state,sessionId){
  const {recordDigest,...body}=record;
  need(recordDigest===digest(body)&&body.from==='blocked'&&body.to==='analysis_ready','prd_planning_recovery_binding');
  const binding=readPrdPlanningRecoveryBinding(body.binding);
  const expected=inspectPrdPlanningRecovery({...state,active:null,checkpoint:body.originalCheckpoint,planningRecoveries:[]},{sessionId});
  need(digest({...expected,reason:binding.reason})===digest(binding),'prd_planning_recovery_binding');
  return record;
}
export function recoverPrdPlanningState(state,raw,{sessionId,validateCurrent}={}){
  const binding=readPrdPlanningRecoveryBinding(raw);
  need(binding.sessionId===sessionId,'prd_planning_recovery_binding');
  const records=histories(state);
  if(records.length){
    const existing=inspectRecord(records[0],state,sessionId);
    need(digest(existing.binding)===digest(binding),'prd_planning_recovery_conflict');
    need(state.active===null&&state.checkpoint?.analysis?.stage!=='cancelled','prd_planning_recovery_not_ready');
    validate(validateCurrent);
    return {state,record:json(existing,8*1024*1024),changed:false};
  }
  const expected=inspectPrdPlanningRecovery(state,{sessionId});
  need(digest({...expected,reason:binding.reason})===digest(binding),'prd_planning_recovery_binding');
  validate(validateCurrent);
  const originalCheckpoint=json(state.checkpoint,4*1024*1024);
  const body={binding,from:'blocked',to:'analysis_ready',originalCheckpoint},record={...body,recordDigest:digest(body)};
  const next=json({...state,checkpoint:{...state.checkpoint,analysis:{...state.checkpoint.analysis,stage:'analysis_ready'}},
    planningRecoveries:[record]},12*1024*1024);
  return {state:next,record,changed:true};
}
function validate(callback){
  need(typeof callback==='function','prd_planning_recovery_validation_required');
  const result=callback();need(!result||typeof result.then!=='function','prd_planning_recovery_validation_async');
}
