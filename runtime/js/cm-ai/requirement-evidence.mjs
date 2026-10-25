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

// Validates the precheck answer items: [{requirement,satisfied,evidence}], each
// optionally tagged with the host run it states (run "red": a test failed before
// the implementation; run "baseline" with result "passed"|"failed": the run before
// development). A null tag means none; the tag never reaches the handoff text.
// result means something only on a baseline item. Elsewhere it is dropped, not an
// error: the first real run wrote result "failed" on its red item, which is just
// what a red run is, and that one field must not void the whole report.
const RUNS=new Set(['red','baseline']),RESULTS=new Set(['passed','failed']);
export function readRequirementItems(raw,code='verification_precheck_invalid'){
  need(Array.isArray(raw)&&raw.length>0&&raw.length<=REQUIREMENT_ITEM_LIMIT,code);
  const items=raw.map(item=>{
    need(item!==null&&typeof item==='object'&&!Array.isArray(item),code);
    try{shape(item,['requirement','satisfied','evidence',...['run','result'].filter(key=>Object.hasOwn(item,key))]);}catch{need(false,code);}
    need(typeof item.satisfied==='boolean',code);
    boundedText(item.requirement,code);boundedText(item.evidence,code);
    const run=item.run??null,result=item.result??null;
    need(run===null||RUNS.has(run),code);need(result===null||RESULTS.has(result),code);
    return freeze({requirement:item.requirement,satisfied:item.satisfied,evidence:item.evidence,
      ...(run===null?{}:{run}),...(result===null||run!=='baseline'?{}:{result})});
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

// The first rule a report breaks, naming only positions, fixed field names and
// rules, never the reported text, so the operator can act on an invalid report.
export function requirementReportProblem(raw){
  if(!Array.isArray(raw))return 'not a list';
  if(raw.length>REQUIREMENT_ITEM_LIMIT)return `more than ${REQUIREMENT_ITEM_LIMIT} items`;
  const known=['requirement','satisfied','evidence','run','result'];
  for(const [index,item] of raw.entries()){
    const at=`item ${index+1}`;
    if(item===null||typeof item!=='object'||Array.isArray(item))return `${at}: not an object`;
    const extra=Object.keys(item).filter(key=>!known.includes(key));
    if(extra.length)return `${at}: ${extra.length} unknown field(s)`;
    for(const key of ['requirement','satisfied','evidence'])if(!Object.hasOwn(item,key))return `${at}: missing ${key}`;
    if(typeof item.satisfied!=='boolean')return `${at}: satisfied is not a boolean`;
    for(const key of ['requirement','evidence']){
      const text=item[key];
      if(typeof text!=='string'||!text.trim())return `${at}: ${key} is empty or not text`;
      if(Buffer.byteLength(text,'utf8')>REQUIREMENT_TEXT_LIMIT)return `${at}: ${key} over ${REQUIREMENT_TEXT_LIMIT} bytes`;
      if(/[\x00-\x08\x0b-\x1f]/.test(text))return `${at}: ${key} has a control character`;
    }
    const run=item.run??null,result=item.result??null;
    if(run!==null&&!RUNS.has(run))return `${at}: run is not red, baseline or null`;
    if(result!==null&&!RESULTS.has(result))return `${at}: result is not passed, failed or null`;
  }
  return Buffer.byteLength(JSON.stringify(raw),'utf8')>REQUIREMENT_EVIDENCE_LIMIT?'report over the byte limit':'unknown';
}

// The developer's own per-requirement report travels beside, never inside, the
// journaled developer value, whose contract stays unchanged. {value, items}:
// items is the validated list, null when absent or empty, or 'invalid' (with the
// first broken rule as problem).
export function splitRequirementReport(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'requirements'))return {value,items:null};
  const {requirements,...rest}=value;
  if(requirements===null||Array.isArray(requirements)&&requirements.length===0)return {value:rest,items:null};
  try{return {value:rest,items:readRequirementItems(requirements,'invalid_result')};}
  catch{return {value:rest,items:'invalid',problem:requirementReportProblem(requirements)};}
}
