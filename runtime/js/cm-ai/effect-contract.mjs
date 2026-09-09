// Shared strict data boundary for S2b. No dispatch or approval authority.
import { digest } from './contracts.mjs';
export { digest };
export const need=(ok,code='invalid_input')=>{if(!ok){const e=new Error(code);e.code=code;throw e;}};
// Explicit host call budget, shared by live initialization and journal replay.
// This is not the short-lived authorization grant expiry.
export const validCallTimeout=value=>need(Number.isInteger(value)&&value>=1&&value<=3600000);
const failureCodes=new Set(['invalid_input','limit_exceeded','call_timeout','cancelled','terminal_mismatch','invalid_result',
  'review_package_mismatch','missing_material','contradictory_verdict','execution_mismatch','receipt_version',
  'unregistered_receipt','invalid_receipt','receipt_identity','receipt_package_mismatch','review_not_approved',
  'checks_not_passed','async_commit','commit_unknown','unsupported_path','unsupported_file','read_failed',
  'snapshot_changed','invalid_baseline','out_of_scope','empty_changes','invalid_package','package_mismatch']);
export function failureCode(error) {
  try {
    const d=Object.getOwnPropertyDescriptor(error,'code');
    return d && Object.hasOwn(d,'value') && failureCodes.has(d.value)?d.value:'execution_error';
  } catch {return 'execution_error';}
}
export function shape(value,names) {
  need(value!==null && typeof value==='object' && !Array.isArray(value)
    && [Object.prototype,null].includes(Object.getPrototypeOf(value)));
  need(Object.getOwnPropertySymbols(value).length===0);
  const ds=Object.getOwnPropertyDescriptors(value);
  need(Object.keys(ds).length===names.length && names.every(k=>Object.hasOwn(ds,k)
    && Object.hasOwn(ds[k],'value') && ds[k].enumerable));
}
export const id=v=>need(typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v));
export const text=v=>need(typeof v==='string' && v.trim().length>0);
export const hex=v=>need(typeof v==='string' && /^[a-f0-9]{64}$/.test(v));
export const freeze=v=>{if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function arrayItems(value) {
  need(Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype && Object.getOwnPropertySymbols(value).length===0);
  const ds=Object.getOwnPropertyDescriptors(value),names=Object.keys(ds).filter(k=>k!=='length');
  need(names.length===value.length && names.every((k,i)=>k===String(i) && Object.hasOwn(ds[k],'value') && ds[k].enumerable));
  return names.map(k=>ds[k].value);
}
export function json(value,limit=1024*1024) {
  const ancestors=new Set();
  function copy(v,depth=0) {
    need(depth<=40);
    if(v===null || ['string','boolean'].includes(typeof v))return v;
    if(typeof v==='number'){need(Number.isFinite(v));return v;}
    need(typeof v==='object' && !ancestors.has(v));
    const array=Array.isArray(v);
    need((array?[Array.prototype]:[Object.prototype,null]).includes(Object.getPrototypeOf(v))
      && Object.getOwnPropertySymbols(v).length===0);
    const ds=Object.getOwnPropertyDescriptors(v),names=Object.keys(ds).filter(k=>!array||k!=='length');
    if(array)need(names.length===v.length && names.every((k,i)=>k===String(i)));
    ancestors.add(v);
    const pairs=names.map(k=>{need(Object.hasOwn(ds[k],'value') && ds[k].enumerable);return [k,copy(ds[k].value,depth+1)];});
    ancestors.delete(v);return array?pairs.map(([,x])=>x):Object.fromEntries(pairs);
  }
  const result=copy(value);need(Buffer.byteLength(JSON.stringify(result))<=limit,'limit_exceeded');
  return freeze(result);
}
export function validIdentity(v) {
  shape(v,['repositoryId','runId','taskId','attempt']);
  [v.repositoryId,v.runId,v.taskId].forEach(id);need([1,2].includes(v.attempt));
}
export function validTaskLearningInput(value,identity,feature) {
  shape(value,['version','workflow','phase','feature','identity','learningDigest','learningFiles']);
  need(value.version===1&&value.workflow==='cm-ai'&&value.phase==='task_learning_input');text(value.feature);
  need(value.feature===feature,'identity_mismatch');
  validIdentity(value.identity);need(digest(value.identity)===digest(identity),'identity_mismatch');hex(value.learningDigest);
  const files=arrayItems(value.learningFiles),seen=new Set();
  for(const file of files){
    shape(file,['scope','path','sha256']);need(['project','specs'].includes(file.scope));text(file.path);hex(file.sha256);
    need(!file.path.startsWith('/')&&!file.path.includes('\\')&&!file.path.includes('\0')
      &&file.path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'invalid_input');
    need(file.scope==='specs'?file.path==='LESSONS.md':file.path.split('/').at(-1)==='AGENTS.md','invalid_input');
    const key=`${file.scope}:${file.path}`;need(!seen.has(key),'invalid_input');seen.add(key);
  }
  need(value.learningDigest===digest({version:1,feature:value.feature,identity:value.identity,files}),'invalid_input');
  return value;
}
export function requestFor({invocationId,identity,role,provider,requestedModel,contextId,payload}) {
  const data=json({version:1,invocationId,identity,role,provider,requestedModel,contextId,payload},10*1024*1024);
  return freeze({...data,requestDigest:digest(data)});
}
export function terminalFor(raw,request) {
  const v=json(raw);
  shape(v,['version','invocationId','contextId','provider','effectiveModel','status','accepted','result',
    ...(Object.hasOwn(v,'providerThreadId')?['providerThreadId']:[])]);
  if(Object.hasOwn(v,'providerThreadId')){need(request.role==='developer');id(v.providerThreadId);}
  need(v.version===1 && v.invocationId===request.invocationId && v.contextId===request.contextId
    && v.provider===request.provider,'terminal_mismatch');text(v.effectiveModel);
  if(v.status==='succeeded')need(v.accepted===true && v.result!==null);
  else if(['failed','unknown'].includes(v.status))need(v.accepted===true && v.result===null);
  else need(['unavailable','auth_required','permission_denied'].includes(v.status) && v.accepted===false && v.result===null);
  return v;
}

export function reviewExclusions(invocation,calls,developerContextId){
  return [...new Set([...invocation.excludedThreadIds,...calls
    .filter(call=>call.contextId===developerContextId&&Object.hasOwn(call,'providerThreadId'))
    .map(call=>call.providerThreadId)])];
}

// Host configuration allows 32 exclusions. FIX second-round review additionally
// excludes the cause reviewer, first implementation reviewer and logical context.
// Preserve that full union; ordinary two-author-attempt callers still fit.
export const MAX_REVIEW_EXCLUSIONS=35;
