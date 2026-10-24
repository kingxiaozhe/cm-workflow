// Requirement evidence from the verification precheck, carried into the host
// handoff so the independent reviewer sees what the developer reported for each
// written requirement. It is the developer's own record, never host-verified fact.
import {need,shape,json,validIdentity,arrayItems} from './effect-contract.mjs';

export const REQUIREMENT_EVIDENCE_PREFIX='cm-requirement-evidence-v1: ';
export const REQUIREMENT_ITEM_LIMIT=64;
export const REQUIREMENT_TEXT_LIMIT=2000;
// The whole serialized item list. The handoff itself is capped at 256 KiB and
// also carries checks and Learning evidence, so the requirement record keeps a
// bound well below it instead of failing the package at publication time.
export const REQUIREMENT_EVIDENCE_LIMIT=64*1024;

const freeze=value=>Object.freeze(value);
const boundedText=(value,code)=>need(typeof value==='string'&&value.trim().length>0
  &&Buffer.byteLength(value,'utf8')<=REQUIREMENT_TEXT_LIMIT&&!/[\x00-\x08\x0b-\x1f]/.test(value),code);

// Validates the precheck answer items: [{requirement,satisfied,evidence}].
export function readRequirementItems(raw,code='verification_precheck_invalid'){
  need(Array.isArray(raw)&&raw.length>0&&raw.length<=REQUIREMENT_ITEM_LIMIT,code);
  const items=raw.map(item=>{
    need(item!==null&&typeof item==='object'&&!Array.isArray(item),code);
    try{shape(item,['requirement','satisfied','evidence']);}catch{need(false,code);}
    need(typeof item.satisfied==='boolean',code);
    boundedText(item.requirement,code);boundedText(item.evidence,code);
    return freeze({requirement:item.requirement,satisfied:item.satisfied,evidence:item.evidence});
  });
  need(Buffer.byteLength(JSON.stringify(items),'utf8')<=REQUIREMENT_EVIDENCE_LIMIT,code);
  return freeze(items);
}

// One handoff evidence entry, bound to the task identity and attempt it answers.
export function encodeRequirementEvidence({identity,items}){
  validIdentity(identity);
  const checked=readRequirementItems(items,'invalid_result');
  need(checked.every(item=>item.satisfied===true),'invalid_result');
  return REQUIREMENT_EVIDENCE_PREFIX+JSON.stringify({version:1,identity:{repositoryId:identity.repositoryId,
    runId:identity.runId,taskId:identity.taskId,attempt:identity.attempt},
    items:checked.map(item=>({requirement:item.requirement,evidence:item.evidence}))});
}

export function readRequirementEvidence(entry){
  need(typeof entry==='string'&&entry.startsWith(REQUIREMENT_EVIDENCE_PREFIX),'invalid_input');
  const body=entry.slice(REQUIREMENT_EVIDENCE_PREFIX.length);
  need(Buffer.byteLength(body,'utf8')<=REQUIREMENT_EVIDENCE_LIMIT+4096,'invalid_input');
  let parsed;
  try{parsed=JSON.parse(body);}catch{need(false,'invalid_input');}
  const value=json(parsed);
  shape(value,['version','identity','items']);need(value.version===1,'invalid_input');
  validIdentity(value.identity);
  const items=arrayItems(value.items).map(item=>{shape(item,['requirement','evidence']);return {...item,satisfied:true};});
  readRequirementItems(items,'invalid_input');
  return value;
}

// The developer's own per-requirement report travels beside, never inside, the
// journaled developer value, whose contract stays unchanged. {value, items}:
// items is the validated list, null when absent or empty, or 'invalid'.
export function splitRequirementReport(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'requirements'))return {value,items:null};
  const {requirements,...rest}=value;
  if(requirements===null||Array.isArray(requirements)&&requirements.length===0)return {value:rest,items:null};
  try{return {value:rest,items:readRequirementItems(requirements,'invalid_result')};}
  catch{return {value:rest,items:'invalid'};}
}
