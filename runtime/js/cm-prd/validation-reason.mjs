// Add operator guidance to existing fail-closed codes without changing the gate.
import {need,json} from '../cm-ai/effect-contract.mjs';
import {tagDiagnosticReason} from '../cm-ai/diagnostic-reason.mjs';

export function needPrd(ok,code,reason){
  try{need(ok,code);}catch(error){throw tagDiagnosticReason(error,reason);}
}

export const PRD_DRAFT_LIMIT=64*1024;
// limit: an assembled tasks_after_design draft also carries the accepted
// requirements/design the reply left out; only the reply itself is 64 KiB.
export function prdDraftJson(raw,limit=PRD_DRAFT_LIMIT){
  try{return json(raw,limit);}catch(error){
    if(error.code==='limit_exceeded'){
      // The input is a parsed host reply. Do not include its contents in diagnostics.
      let actualBytes=null;
      try{actualBytes=Buffer.byteLength(JSON.stringify(raw));}catch{/* original error wins */}
      tagDiagnosticReason(error,{field:'draft',expected:limit===PRD_DRAFT_LIMIT?'one submission must be <= 65536 bytes (64 KiB)'
        :`the assembled draft must be <= ${limit} bytes (64 KiB plus the accepted requirements/design)`,
        limitBytes:limit,actualBytes});
    }
    throw error;
  }
}
