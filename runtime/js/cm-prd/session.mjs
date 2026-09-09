// PRD-local checkpoint and call journal. It never owns review/task approval.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';

function readState(root,relative){
  if(relative!=='state.json')return readCmInitSource(root,relative)?.toString('utf8')??null;
  const file=path.join(root,relative);let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16*1024*1024&&(stat.mode&0o777)===0o600,'prd_session_file_invalid');
  return new TextDecoder('utf8',{fatal:true}).decode(fs.readFileSync(file));
}

export function replaceSessionFile(root,relative,before,after){
  need(readState(root,relative)===before,'prd_write_conflict');
  need(typeof after==='string'&&Buffer.byteLength(after)<=16*1024*1024&&Buffer.from(after).toString('utf8')===after,'prd_write_limit');
  const target=path.join(root,relative),dir=path.dirname(target);
  need(fs.realpathSync(dir)===dir,'prd_write_path_invalid');
  const tmp=path.join(dir,`.prd-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,after);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    need(readState(root,relative)===before,'prd_write_conflict');
    if(before===null)fs.linkSync(tmp,target);else fs.renameSync(tmp,target);
    const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export function openPrdSession({specs,sessionId,identity}){
  need(/^prd-[a-zA-Z0-9-]{1,80}$/.test(sessionId),'prd_session_id_invalid');
  for(const relative of ['.reviews','.reviews/prd-sessions',`.reviews/prd-sessions/${sessionId}`]){
    const dir=path.join(specs,relative);try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    need(fs.realpathSync(dir)===dir&&fs.lstatSync(dir).isDirectory(),'prd_session_path_invalid');
  }
  const directory=path.join(specs,'.reviews/prd-sessions',sessionId),lock=path.join(directory,'writer.json');
  const read=()=>readState(directory,'state.json');
  if(fs.existsSync(lock)){
    const bytes=readCmInitSource(directory,'writer.json'),old=JSON.parse(bytes);
    need(Number.isSafeInteger(old.pid)&&old.pid>0,'prd_session_lock_invalid');
    try{process.kill(old.pid,0);need(false,'prd_session_busy');}catch(e){if(e.code!=='ESRCH')throw e;}
    need(readCmInitSource(directory,'writer.json')?.equals(bytes),'prd_session_lock_changed');fs.unlinkSync(lock);
  }
  const lockBytes=JSON.stringify({pid:process.pid,nonce:randomUUID()});
  const fd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(fd,lockBytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  let bytes=read(),state=bytes===null?{version:1,identity,checkpoint:null,active:null,segments:{}}:JSON.parse(bytes);
  try{need(state.version===1&&digest(state.identity)===digest(identity),'prd_session_identity_changed');}
  catch(e){fs.unlinkSync(lock);throw e;}
  let cursor=0;
  const save=()=>{const next=JSON.stringify(state);replaceSessionFile(directory,'state.json',bytes,next);bytes=next;};
  return {
    get state(){return json(state,12*1024*1024);},
    begin(request,before){need(state.active===null,'prd_operation_recovery_required');state.active={request,before,calls:[]};cursor=0;save();},
    replay(){need(state.active!==null,'prd_nothing_to_resume');cursor=0;return json(state.active,12*1024*1024);},
    commit(checkpoint){state.checkpoint=checkpoint;state.active=null;save();},
    checkpoint(checkpoint){state.checkpoint=checkpoint;save();},
    async call(kind,payload,signal,perform){
      need(state.active!==null,'prd_operation_required');const index=cursor++,input=json({kind,payload},12*1024*1024);
      const previous=state.active.calls[index];
      if(previous){need(previous.requestDigest===digest(input),'prd_replay_inputs_changed');
        need(Object.hasOwn(previous,'result'),'prd_host_result_unknown');return previous.result;}
      need(!state.active.calls.some(call=>!Object.hasOwn(call,'result')),'prd_host_result_unknown');
      const call={callId:randomUUID(),requestDigest:digest(input),...input};state.active.calls.push(call);save();
      const result=json(await perform({...payload,recovery:{sessionId,callId:call.callId,requestDigest:call.requestDigest}},signal),1024*1024);
      call.result=result;save();return result;
    },
    resolve({callId,requestDigest,result,evidence}){
      need(typeof evidence==='string'&&evidence.trim(),'prd_recovery_evidence_required');
      const call=state.active?.calls.find(item=>item.callId===callId);
      need(call&&call.requestDigest===requestDigest&&!Object.hasOwn(call,'result'),'prd_recovery_binding');
      call.result=json(result,1024*1024);call.recoveryEvidence=evidence;save();
    },
    segment(phase){const segment=(state.segments[phase]??0)+1;state.segments[phase]=segment;save();return segment;},
    close(){need(readCmInitSource(directory,'writer.json')?.toString('utf8')===lockBytes,'prd_session_lock_changed');fs.unlinkSync(lock);},
  };
}
