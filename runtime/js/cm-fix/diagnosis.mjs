// One fix_diagnose validator for journal replay, live answers and the driver
// preflight. Replay keeps its historical error codes; a live answer that fails
// becomes invalid_diagnosis with the failing field, so the caller can resubmit.
import path from 'node:path';
import {json,need,shape,text} from '../cm-ai/effect-contract.mjs';
import {tagDiagnosticReason} from '../cm-ai/diagnostic-reason.mjs';
import {atField,inspectFixInvestigation} from './investigation.mjs';

export function inspectFixDiagnosis(raw){
  const value=atField('(answer)',()=>json(raw,32*1024));
  atField('(answer)',()=>shape(value,['status','rootCause','affectedPaths','plan','crossLayer','affectedModules',...(Object.hasOwn(value,'investigation')?['investigation']:[])]));
  atField('status',()=>need(['diagnosed','needs_evidence','design_change'].includes(value.status),'invalid_diagnosis'));
  for(const key of ['rootCause','plan'])atField(key,()=>text(value[key]));
  atField('crossLayer',()=>need(typeof value.crossLayer==='boolean','invalid_diagnosis'));
  if(Object.hasOwn(value,'investigation'))inspectFixInvestigation(value.investigation,value.crossLayer);
  for(const key of ['affectedPaths','affectedModules']){
    atField(key,()=>need(Array.isArray(value[key])&&value[key].length>0&&value[key].length<=32,'invalid_diagnosis'),32,
      Array.isArray(value[key])?value[key].length:null);
    value[key].forEach((item,index)=>atField(`${key}[${index}]`,()=>{
      text(item);need(!path.isAbsolute(item)&&item===path.posix.normalize(item)
        &&item!=='.'&&!item.startsWith('../')&&!/[\\\0]/.test(item),'invalid_diagnosis');
    }));
    atField(key,()=>need(new Set(value[key]).size===value[key].length,'invalid_diagnosis'));
  }
  return value;
}

export function describeFixDiagnosisError(error){
  const field=typeof error?.field==='string'?error.field:'(answer)';
  const limit=Number.isSafeInteger(error?.limit)?`：最多 ${error.limit} 项${Number.isSafeInteger(error.actual)?`，实际 ${error.actual} 项`:''}`:'';
  return `诊断答案字段 ${field} 不合法${limit}（${error?.code??'invalid_input'}）`;
}

// Live answer: never an interruption. The step stays pending and the same
// request may be answered again; nothing about the rejected answer is recorded.
export function fixDiagnosisAnswer(raw){
  try{return inspectFixDiagnosis(raw);}
  catch(error){
    const failure=Object.assign(new Error('invalid_diagnosis'),{code:'invalid_diagnosis'});
    throw tagDiagnosticReason(failure,describeFixDiagnosisError(error));
  }
}
export const isInvalidFixDiagnosis=error=>error?.code==='invalid_diagnosis'&&typeof error.reason==='string';
