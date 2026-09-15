// Private interview checkpoint; no PRD save, provider or task authority.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {replaceSessionFile} from '../cm-prd/session.mjs';

export function openIdeaSession(file,binding){
  return openDraftSession(file,binding,'cm-idea');
}

// Same private single-call journal for init; workflow identity stays disjoint.
export function openDraftSession(file,binding,workflow){
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
    shape(state,['version','workflow','binding','checkpoint','pending','cancelled']);
    need(state.version===1&&state.workflow===workflow&&digest(state.binding)===digest(binding),'idea_session_binding_changed');
  }catch(e){fs.unlinkSync(path.join(root,lockName));throw e;}
  const write=next=>{
    next=json(next,1024*1024);const after=JSON.stringify(next);
    need(read(name)===bytes,'idea_session_changed');replaceSessionFile(root,name,bytes,after);
    bytes=after;state=next;
  };
  return {
    get state(){return json(state);},
    begin(request,checkpoint){need(!state.cancelled&&state.pending===null,'idea_session_resume_required');
      write({...state,checkpoint,pending:{request,call:null,writing:false}});},
    commit(checkpoint){write({...state,checkpoint,pending:null});},
    cancel(checkpoint){write({...state,checkpoint,cancelled:true});},
    writing(){need(state.pending!==null&&!state.cancelled,'idea_session_not_active');write({...state,pending:{...state.pending,writing:true}});},
    resume(resolution){
      need(!state.cancelled,'cancelled');
      if(state.pending===null){need(resolution===null,'idea_session_no_pending_call');return null;}
      need(!state.pending.writing,'idea_save_outcome_unknown');
      if(resolution!==null){
        shape(resolution,['callId','requestDigest','result','evidence']);
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
