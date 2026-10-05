// Trusted adapter-side capture, separate from the host's sealed observation.
// No timers, files, provider queries or dispatch authority live here.
import {json,need,shape} from './effect-contract.mjs';
export function reconciliationControl(control) {
  if(typeof control.onReconciliation!=='function')return {signal:control.signal,onEvent:control.onEvent};
  const events=[];let invalid=false,closed=false;
  return {signal:control.signal,onEvent:event=>{
    try{need(!closed&&events.length<64);events.push(json(event,64*1024));}catch{invalid=true;}
    return control.onEvent(event);
  },onTerminal:result=>{
    if(closed)return;closed=true;
    if(invalid)return;
    try{control.onReconciliation(json({events,result,cleanup:'owned_process_group_closed'},512*1024));}catch{}
  }};
}
export function readReconciliationReceipt(raw){
  const value=json(raw,512*1024);shape(value,['events','result','cleanup']);
  need(value.cleanup==='owned_process_group_closed','review_reconciliation_evidence_required');
  return value;
}
