// Add operator guidance to existing fail-closed codes without changing the gate.
import {need,json} from '../cm-ai/effect-contract.mjs';
import {tagDiagnosticReason} from '../cm-ai/diagnostic-reason.mjs';

export function needPrd(ok,code,reason){
  try{need(ok,code);}catch(error){throw tagDiagnosticReason(error,reason);}
}

export function prdDraftJson(raw){
  try{return json(raw,64*1024);}catch(error){
    if(error.code==='limit_exceeded'){
      // The input is a parsed host reply. Do not include its contents in diagnostics.
      let actualBytes=null;
      try{actualBytes=Buffer.byteLength(JSON.stringify(raw));}catch{/* original error wins */}
      tagDiagnosticReason(error,{field:'draft',expected:'one submission must be <= 65536 bytes (64 KiB)',
        limitBytes:65536,actualBytes});
    }
    throw error;
  }
}
