// Private interview checkpoint; no PRD save, provider or task authority.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {replaceSessionFile} from '../cm-prd/session.mjs';

// V1 (O09/O10/O13/O14) and V7: a call whose answer was recorded and then refused
// on every replay (discard), or whose outcome is unknown (abandon), may be asked
// again under the same pending request with a fresh callId. The record is
// append-only (abandonedCalls), at most MAX_CALL_ABANDONS per kind in a session;
// writes (init_write) are never re-asked here. A confirmation is asked of the
// person again; an answer bound to an abandoned callId is never accepted.
export const MAX_CALL_ABANDONS=2;
export const DRAFT_REASKABLE=Object.freeze({'cm-init':['init_analyze','init_generate','init_verify','init_confirm','init_review'],
  'cm-idea':['idea_interview','idea_confirm_save']});
const ABANDON_KEYS=['kind','callId','requestDigest','operation','reason','resultDigest','evidence','at'];
function checkAbandoned(list,workflow){
  need(Array.isArray(list)&&list.length<=MAX_CALL_ABANDONS*DRAFT_REASKABLE[workflow].length,'idea_session_abandon_record_invalid');
  const ids=new Set();
  for(const item of list){
    need(item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===ABANDON_KEYS.length
      &&ABANDON_KEYS.every(key=>Object.hasOwn(item,key))&&DRAFT_REASKABLE[workflow].includes(item.kind)
      &&typeof item.callId==='string'&&!ids.has(item.callId)&&/^[a-f0-9]{64}$/.test(item.requestDigest)
      &&typeof item.operation==='string'&&['answer_rejected','answer_missing'].includes(item.reason)
      &&(item.reason==='answer_rejected'?/^[a-f0-9]{64}$/.test(item.resultDigest??''):item.resultDigest===null)
      &&item.evidence&&/^[a-f0-9]{64}$/.test(item.evidence.sha256??'')&&Number.isSafeInteger(item.evidence.length)
      &&item.evidence.length>0&&item.evidence.length<=2000&&typeof item.at==='string'&&Number.isFinite(Date.parse(item.at))
      &&list.filter(other=>other.kind===item.kind).length<=MAX_CALL_ABANDONS,'idea_session_abandon_record_invalid');
    ids.add(item.callId);
  }
  return ids;
}
export function openIdeaSession(file,binding){
  return openDraftSession(file,binding,'cm-idea');
}

// Same private single-call journal for init; workflow identity stays disjoint.
// legacyBindings: older bindings accepted as a controlled migration (see
// runtime/js/policy-binding-compat.mjs); a session opened under one keeps it.
export function openDraftSession(file,binding,workflow,{legacyBindings=[]}={}){
  need(['cm-idea','cm-init'].includes(workflow),'draft_session_workflow_invalid');
  need(typeof file==='string'&&path.isAbsolute(file)&&path.resolve(file)===file
    &&/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(path.basename(file)),'idea_session_path_invalid');
  const root=path.dirname(file),name=path.basename(file),lockName=name+'.lock';
  need(fs.realpathSync(root)===root&&fs.statSync(root).isDirectory(),'idea_session_path_invalid');
  const read=relative=>{
    need(fs.realpathSync(root)===root,'idea_session_path_changed');
    const bytes=readCmInitSource(root,relative);
    if(bytes!==null)need((fs.lstatSync(path.join(root,relative)).mode&0o777)===0o600,'idea_session_permissions');
    return bytes===null?null:new TextDecoder('utf8',{fatal:true}).decode(bytes);
  };
  const priorLock=read(lockName);
  if(priorLock!==null){
    const old=JSON.parse(priorLock);need(Number.isSafeInteger(old.pid)&&old.pid>0,'idea_session_lock_invalid');
    try{process.kill(old.pid,0);need(false,'idea_session_busy');}catch(e){if(e.code!=='ESRCH')throw e;}
    need(read(lockName)===priorLock,'idea_session_lock_changed');fs.unlinkSync(path.join(root,lockName));
  }
  const token=JSON.stringify({pid:process.pid,nonce:randomUUID()});
  const fd=fs.openSync(path.join(root,lockName),'wx',0o600);
  try{fs.writeFileSync(fd,token);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  let bytes,state;
  try{
    bytes=read(name);state=bytes===null?{version:1,workflow,binding,checkpoint:null,pending:null,cancelled:false}:JSON.parse(bytes);
    shape(state,['version','workflow','binding','checkpoint','pending','cancelled',...(Object.hasOwn(state,'abandonedCalls')?['abandonedCalls']:[])]);
    need(state.version===1&&state.workflow===workflow&&(digest(state.binding)===digest(binding)
      ||bytes!==null&&legacyBindings.some(item=>digest(item)===digest(state.binding))),'idea_session_binding_changed');
    // Older files have no abandonedCalls and replay unchanged; a present list is checked.
    if(Object.hasOwn(state,'abandonedCalls')){const ids=checkAbandoned(state.abandonedCalls,workflow);
      need(!ids.has(state.pending?.call?.callId),'idea_session_abandon_record_invalid');}
  }catch(e){fs.unlinkSync(path.join(root,lockName));throw e;}
  const write=next=>{
    next=json(next,1024*1024);const after=JSON.stringify(next);
    // abandonedCalls only grows: every earlier record stays, in order.
    const before=state.abandonedCalls??[],now=next.abandonedCalls??[];
    need(now.length>=before.length&&before.every((item,index)=>digest(item)===digest(now[index])),'idea_session_abandon_record_invalid');
    need(read(name)===bytes,'idea_session_changed');replaceSessionFile(root,name,bytes,after);
    bytes=after;state=next;
  };
  return {
    get state(){return json(state);},
    begin(request,checkpoint){need(!state.cancelled&&state.pending===null,'idea_session_resume_required');
      write({...state,checkpoint,pending:{request,call:null,writing:false}});},
    commit(checkpoint){write({...state,checkpoint,pending:null});},
    cancel(checkpoint){write({...state,checkpoint,cancelled:true});},
    // expected (idea saves only): path and content digest of the one host-owned
    // file, recorded before writing so recovery can compare the disk (V6).
    writing(expected){need(state.pending!==null&&!state.cancelled,'idea_session_not_active');
      write({...state,pending:{...state.pending,writing:true,...(expected?{expected}:{})}});},
    // V6: the disk shows no write happened, so the same approved request may write.
    writeAbsent(){need(state.pending?.writing===true&&state.pending.expected&&!state.cancelled,'idea_session_not_active');
      const {expected,...pending}=state.pending;write({...state,pending:{...pending,writing:false}});},
    get abandonedCalls(){return json(state.abandonedCalls??[]);},
    abandonCall(resolution){
      need(!state.cancelled,'cancelled');
      need(resolution!==null&&typeof resolution==='object'&&!Array.isArray(resolution)
        &&(resolution.discard===true)!==(resolution.abandon===true)&&!Object.hasOwn(resolution,'result')
        &&Object.keys(resolution).every(key=>['callId','requestDigest','discard','abandon','evidence'].includes(key)),'idea_session_receipt_mismatch');
      need(typeof resolution.evidence==='string'&&resolution.evidence.trim()&&resolution.evidence.length<=2000,'idea_session_abandon_evidence_required');
      need(state.pending!==null,'idea_session_no_pending_call');need(!state.pending.writing,'idea_save_outcome_unknown');
      const call=state.pending.call;
      need(call&&call.callId===resolution.callId&&call.requestDigest===resolution.requestDigest,'idea_session_receipt_mismatch');
      need(resolution.discard===true?Object.hasOwn(call,'result'):!Object.hasOwn(call,'result'),'idea_session_abandon_state');
      need(DRAFT_REASKABLE[workflow].includes(call.kind),workflow==='cm-init'&&call.kind==='init_write'?'init_write_recovery_required':'idea_session_abandon_kind');
      const list=state.abandonedCalls??[];
      need(list.filter(item=>item.kind===call.kind).length<MAX_CALL_ABANDONS,'idea_session_abandon_limit');
      const record={kind:call.kind,callId:call.callId,requestDigest:call.requestDigest,operation:state.pending.request.operation,
        reason:resolution.discard===true?'answer_rejected':'answer_missing',
        resultDigest:resolution.discard===true?digest(call.result):null,
        evidence:{sha256:digest(resolution.evidence),length:resolution.evidence.length},at:new Date().toISOString()};
      write({...state,abandonedCalls:[...list,record],pending:{...state.pending,call:null}});
      return {...record,remaining:MAX_CALL_ABANDONS-list.filter(item=>item.kind===call.kind).length-1};
    },
    resume(resolution){
      need(!state.cancelled,'cancelled');
      if(state.pending===null){need(resolution===null,'idea_session_no_pending_call');return null;}
      need(!state.pending.writing,'idea_save_outcome_unknown');
      if(resolution!==null){
        shape(resolution,['callId','requestDigest','result','evidence']);
        need(!(state.abandonedCalls??[]).some(item=>item.callId===resolution.callId),'idea_session_call_abandoned');
        const call=state.pending.call;
        need(call&&!Object.hasOwn(call,'result')&&call.callId===resolution.callId&&call.requestDigest===resolution.requestDigest
          &&typeof resolution.evidence==='string'&&resolution.evidence.trim(),'idea_session_receipt_mismatch');
        write({...state,pending:{...state.pending,call:{...call,result:json(resolution.result,64*1024),evidence:resolution.evidence}}});
      }
      need(state.pending.call===null||Object.hasOwn(state.pending.call,'result'),'idea_session_result_unknown');
      return state.pending.request;
    },
    async call(kind,payload,signal,perform){
      need(state.pending!==null&&!state.cancelled,'idea_session_not_active');const requestDigest=digest({kind,payload});
      let call=state.pending.call;
      if(call!==null){need(call.kind===kind&&call.requestDigest===requestDigest,'idea_session_request_changed');
        need(Object.hasOwn(call,'result'),'idea_session_result_unknown');return call.result;}
      call={kind,callId:randomUUID(),requestDigest};write({...state,pending:{...state.pending,call}});
      const result=json(await perform({...payload,recovery:{callId:call.callId,requestDigest}},signal),64*1024);
      need(!signal.aborted&&!state.cancelled,'cancelled');
      write({...state,pending:{...state.pending,call:{...call,result}}});return result;
    },
    close(){need(read(lockName)===token,'idea_session_lock_changed');fs.unlinkSync(path.join(root,lockName));},
  };
}
