// PRD-local checkpoint and call journal. It never owns review/task approval.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {need,json,digest,shape} from '../cm-ai/effect-contract.mjs';
import {readExecutionPolicy} from '../cm-ai/execution-policy.mjs';
import {recoverPrdResponse,readPrdRepairBinding} from './response-recovery.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';

export function readPrdSessionFile(root,relative){
  if(!['state.json','inputs-replaced.json'].includes(relative))return readCmInitSource(root,relative)?.toString('utf8')??null;
  const file=path.join(root,relative);let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16*1024*1024&&(stat.mode&0o777)===0o600,'prd_session_file_invalid');
  return new TextDecoder('utf8',{fatal:true}).decode(fs.readFileSync(file));
}

export function replaceSessionFile(root,relative,before,after){
  need(readPrdSessionFile(root,relative)===before,'prd_write_conflict');
  need(typeof after==='string'&&Buffer.byteLength(after)<=16*1024*1024&&Buffer.from(after).toString('utf8')===after,'prd_write_limit');
  const target=path.join(root,relative),dir=path.dirname(target);
  need(fs.realpathSync(dir)===dir,'prd_write_path_invalid');
  const tmp=path.join(dir,`.prd-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,after);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    need(readPrdSessionFile(root,relative)===before,'prd_write_conflict');
    if(before===null)fs.linkSync(tmp,target);else fs.renameSync(tmp,target);
    const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export function openPrdSession({specs,sessionId,identity,executionPolicy=null}){
  need(/^prd-[a-zA-Z0-9-]{1,80}$/.test(sessionId),'prd_session_id_invalid');
  for(const relative of ['.reviews','.reviews/prd-sessions',`.reviews/prd-sessions/${sessionId}`]){
    const dir=path.join(specs,relative);try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    need(fs.realpathSync(dir)===dir&&fs.lstatSync(dir).isDirectory(),'prd_session_path_invalid');
  }
  const directory=path.join(specs,'.reviews/prd-sessions',sessionId),lock=path.join(directory,'writer.json');
  const read=()=>readPrdSessionFile(directory,'state.json');
  if(fs.existsSync(lock)){
    const bytes=readCmInitSource(directory,'writer.json'),old=JSON.parse(bytes);
    need(Number.isSafeInteger(old.pid)&&old.pid>0,'prd_session_lock_invalid');
    try{process.kill(old.pid,0);need(false,'prd_session_busy');}catch(e){if(e.code!=='ESRCH')throw e;}
    need(readCmInitSource(directory,'writer.json')?.equals(bytes),'prd_session_lock_changed');fs.unlinkSync(lock);
  }
  const lockBytes=JSON.stringify({pid:process.pid,nonce:randomUUID()});
  const fd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(fd,lockBytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  let bytes=read(),state=bytes===null?{version:executionPolicy===null?1:2,identity,checkpoint:null,active:null,segments:{},
    ...(executionPolicy===null?{}:{executionPolicy:readExecutionPolicy(executionPolicy),responseRepairs:[]})}:JSON.parse(bytes);
  try{need([1,2].includes(state.version)&&digest(state.identity)===digest(identity),'prd_session_identity_changed');
    if(state.version===2){readExecutionPolicy(state.executionPolicy);need(Array.isArray(state.responseRepairs),'prd_recovery_binding');}
    else need(executionPolicy===null,'execution_policy_legacy_run');}
  catch(e){fs.unlinkSync(lock);throw e;}
  let cursor=0;
  const save=()=>{const next=JSON.stringify(state);replaceSessionFile(directory,'state.json',bytes,next);bytes=next;};
  const projected=call=>{
    if(!call.responseRepair)return call.result;
    need(state.version===2&&call.kind==='prd_review'&&digest({kind:call.kind,payload:call.payload})===call.requestDigest,'prd_recovery_binding');
    const record=call.responseRepair;
    shape(record,['version','callId','requestDigest','originalDigest','originalBase64','response','changes','reason']);
    need(record.version===1&&record.callId===call.callId&&record.requestDigest===call.requestDigest
      &&record.originalDigest===digest(call.result)&&record.originalBase64===Buffer.from(JSON.stringify(call.result)).toString('base64'),'prd_recovery_binding');
    const {packageDigest,...reviewPackage}=call.payload.package;
    const expected=recoverPrdResponse({original:call.result,reviewPackage,packageDigest,authorContextId:call.payload.authorContextId});
    need(digest(expected.response)===digest(record.response)&&digest(expected.changes)===digest(record.changes),'prd_recovery_binding');
    return expected.response;
  };
  return {
    get state(){return json(state,12*1024*1024);},
    reviewResponse(call){return projected(call);},
    repairReviewResponse(binding){
      need(state.version===2&&state.executionPolicy.responseRecovery==='mechanical-v1','execution_policy_required');
      binding=readPrdRepairBinding(binding);
      const saved=state.responseRepairs.find(item=>item.originalCall.callId===binding.callId);
      if(saved){
        need(saved.originalOperation.operation==='final_review'&&/^[a-f0-9]{64}$/.test(saved.originalStateSha256),'prd_recovery_binding');
        need(saved.originalCall.requestDigest===binding.requestDigest&&digest(saved.originalCall.result)===binding.resultDigest
          &&saved.originalCall.payload.package.packageDigest===binding.packageDigest,'prd_recovery_binding');
        const response=projected({...saved.originalCall,responseRepair:saved.repair});
        need(saved.originalOperation.mode==='self-degraded'?response.reviewer==='self-degraded':response.reviewer!=='self-degraded','prd_review_mode_changed');
        return json(saved.repair);
      }
      const active=state.active,call=active?.calls.find(c=>c.callId===binding.callId);
      need(active?.request.operation==='final_review'&&active.calls.length===1&&call?.kind==='prd_review'
        &&Object.hasOwn(call,'result')&&call.requestDigest===binding.requestDigest
        &&digest(call.result)===binding.resultDigest&&call.payload.package.packageDigest===binding.packageDigest,'prd_recovery_binding');
      if(call.responseRepair){projected(call);return json(call.responseRepair);}
      const {packageDigest,...reviewPackage}=call.payload.package;
      const recovered=recoverPrdResponse({original:call.result,reviewPackage,packageDigest,authorContextId:call.payload.authorContextId});
      need(active.request.mode==='self-degraded'?recovered.response.reviewer==='self-degraded':recovered.response.reviewer!=='self-degraded','prd_review_mode_changed');
      need(recovered.changes.length>0,'prd_response_already_canonical');
      const originalCall=json(call,1024*1024);
      call.responseRepair={version:1,callId:call.callId,requestDigest:call.requestDigest,originalDigest:digest(call.result),
        originalBase64:Buffer.from(JSON.stringify(call.result)).toString('base64'),...recovered,reason:binding.reason};
      need(state.responseRepairs.length<64,'prd_write_limit');
      state.responseRepairs.push({originalCall,originalOperation:active.request,
        originalStateSha256:createHash('sha256').update(bytes).digest('hex'),repair:call.responseRepair});
      save();return json(call.responseRepair);
    },
    begin(request,before){need(state.active===null,'prd_operation_recovery_required');state.active={request,before,calls:[]};cursor=0;save();},
    replay(){need(state.active!==null,'prd_nothing_to_resume');cursor=0;return json(state.active,12*1024*1024);},
    commit(checkpoint){state.checkpoint=checkpoint;state.active=null;save();},
    checkpoint(checkpoint){state.checkpoint=checkpoint;save();},
    abandon(resolution){
      need(resolution!==null&&typeof resolution==='object'&&!Array.isArray(resolution)
        &&resolution.abandon===true&&!Object.hasOwn(resolution,'result')
        &&Object.keys(resolution).every(key=>['callId','requestDigest','abandon','evidence'].includes(key)),'prd_recovery_binding');
      need(typeof resolution.evidence==='string'&&resolution.evidence.trim(),'prd_recovery_evidence_required');
      const active=state.active,call=active?.calls.find(item=>item.callId===resolution.callId);
      need(call&&call.requestDigest===resolution.requestDigest&&!Object.hasOwn(call,'result'),'prd_recovery_binding');
      need(!active.calls.some(item=>item.kind==='prd_review'),'prd_review_recovery_required');
      const decision={operation:active.request.operation,kind:call.kind,callId:call.callId,
        evidence:{sha256:digest(resolution.evidence),length:resolution.evidence.length}};
      state.checkpoint=active.before;state.active=null;cursor=0;save();return decision;
    },
    async call(kind,payload,signal,perform){
      need(state.active!==null,'prd_operation_required');const index=cursor++,input=json({kind,payload},12*1024*1024);
      const active=state.active;
      const previous=state.active.calls[index];
      if(previous){need(previous.requestDigest===digest(input),'prd_replay_inputs_changed');
        need(Object.hasOwn(previous,'result'),'prd_host_result_unknown');return projected(previous);}
      need(!state.active.calls.some(call=>!Object.hasOwn(call,'result')),'prd_host_result_unknown');
      const call={callId:randomUUID(),requestDigest:digest(input),...input};state.active.calls.push(call);save();
      const response=await perform({...payload,recovery:{sessionId,callId:call.callId,requestDigest:call.requestDigest}},signal);
      need(!signal.aborted&&state.active===active,'cancelled');
      const result=json(response,1024*1024);
      call.result=result;save();return result;
    },
    resolve(resolution){
      need(resolution!==null&&typeof resolution==='object'&&!Object.hasOwn(resolution,'abandon'),'prd_recovery_binding');
      const {callId,requestDigest,result,evidence}=resolution;
      need(typeof evidence==='string'&&evidence.trim(),'prd_recovery_evidence_required');
      const call=state.active?.calls.find(item=>item.callId===callId);
      need(call&&call.requestDigest===requestDigest&&!Object.hasOwn(call,'result'),'prd_recovery_binding');
      call.result=json(result,1024*1024);call.recoveryEvidence=evidence;save();
    },
    segment(phase){const segment=(state.segments[phase]??0)+1;state.segments[phase]=segment;save();return segment;},
    close(){need(readCmInitSource(directory,'writer.json')?.toString('utf8')===lockBytes,'prd_session_lock_changed');fs.unlinkSync(lock);},
  };
}
