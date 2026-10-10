// Refactor-local replay of recorded effects. Task/review authority stays in N4/N5.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {need,digest,json} from '../cm-ai/effect-contract.mjs';
import {canonicalFuture} from '../cm-test/source-snapshot.mjs';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export function readText(target){
  need(canonicalFuture(target)===target,'refactor_path_changed');
  let stat;try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024*1024,'refactor_file_invalid');
  const bytes=fs.readFileSync(target);return new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
export function replaceText(target,before,after,mode=0o644){
  need(readText(target)===before,'refactor_write_conflict');
  if(after===before)return;
  if(after===null){fs.unlinkSync(target);return;}
  need(typeof after==='string'&&Buffer.byteLength(after)<=1024*1024,'refactor_file_limit');
  const dir=path.dirname(target);need(canonicalFuture(dir)===dir,'refactor_path_changed');fs.mkdirSync(dir,{recursive:true});
  const tmp=path.join(dir,`.cm-refactor-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(tmp,'wx',mode);fs.fchmodSync(fd,mode);fs.writeFileSync(fd,after);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    need(readText(target)===before,'refactor_write_conflict');
    if(before===null){fs.linkSync(tmp,target);fs.unlinkSync(tmp);}else fs.renameSync(tmp,target);
    const d=fs.openSync(dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
// V1 (O18/O19/O21): a host answer that was recorded and then refused on every
// replay, or whose outcome nobody can tell, may be discarded by an explicit,
// append-only `discard` row and asked again under the same key. Only the most
// recent intent, only a `host` effect whose call kind the workflow lists as
// re-askable, at most MAX_DISCARDS_PER_KIND per call kind in a run. A kind with
// external side effects also needs an operator release record. Replay enforces
// the same rules, so a forged, duplicated or over-limit row is refused.
export const MAX_DISCARDS_PER_KIND=2;
const DISCARD_REASONS=['answer_rejected','answer_missing'];
// A re-asked call has its own identity: the intent after N discards of a key
// carries attempt N+1, and its request digest binds that attempt. A receipt for
// a discarded attempt therefore never matches the new one. A first attempt keeps
// the original digest of its input, so older journals replay unchanged.
export const effectDigest=entry=>(entry.attempt??1)>1?digest({input:entry.input,attempt:entry.attempt}):digest(entry.input);
export function discardSummary(effects,discards,lastIntent){
  const last=lastIntent!==null&&effects.has(lastIntent)?[lastIntent,effects.get(lastIntent)]:null;
  return {discards:discards.map(({key,kind,reason,attempt,at})=>({key,kind,reason,attempt,at})),
    lastAnswer:last&&last[1].kind==='host'&&Object.hasOwn(last[1],'result')?{key:last[0],kind:last[1].input?.kind??null,
      attempt:last[1].attempt??1,requestDigest:effectDigest(last[1]),resultDigest:digest(last[1].result)}:null,
    unknown:[...effects].filter(([,entry])=>!Object.hasOwn(entry,'result'))
      .map(([key,entry])=>({key,kind:entry.kind,callKind:entry.kind==='host'?entry.input?.kind??null:null,
        attempt:entry.attempt??1,requestDigest:effectDigest(entry)}))};
}
const DISCARD_KEYS=['type','key','kind','reason','attempt','requestDigest','resultDigest','evidence','released','at','previous'];
function checkDiscard(row,entry,lastIntent,discards,policy){
  const allowed=policy?.(row.kind)??null;
  need(allowed&&entry&&entry.kind==='host'&&entry.input?.kind===row.kind&&lastIntent===row.key
    &&Object.keys(row).every(name=>DISCARD_KEYS.includes(name)||name==='hash')
    &&DISCARD_REASONS.includes(row.reason)&&discards.filter(item=>item.kind===row.kind).length<MAX_DISCARDS_PER_KIND
    &&row.attempt===(entry.attempt??1)&&row.requestDigest===effectDigest(entry)
    &&row.evidence&&typeof row.evidence==='object'&&/^[a-f0-9]{64}$/.test(row.evidence.sha256??'')
    &&Number.isSafeInteger(row.evidence.length)&&row.evidence.length>0&&row.evidence.length<=2000
    &&typeof row.at==='string'&&Number.isFinite(Date.parse(row.at))
    &&(row.reason==='answer_rejected'?Object.hasOwn(entry,'result')&&row.resultDigest===digest(entry.result)
      :!Object.hasOwn(entry,'result')&&row.resultDigest===null)
    &&(allowed.release?row.released?.source==='operator_confirmed'&&/^[a-f0-9]{64}$/.test(row.released.evidence??''):row.released===null),
  'refactor_journal_invalid');
}
export function openRefactorRecords(directory,{discardable=null}={}){
  need(canonicalFuture(directory)===directory,'refactor_archive_changed');
  const target=path.join(directory,'execution.jsonl'),lock=path.join(directory,'.writer.json');
  let events=[],last=null,locked=false,lastIntent=null;const effects=new Map(),discards=[];
  const nextAttempt=key=>discards.filter(item=>item.key===key).length+1;
  if(fs.existsSync(target)){
    const stat=fs.lstatSync(target);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=32*1024*1024,'refactor_journal_invalid');
    const source=fs.readFileSync(target,'utf8');need(source.endsWith('\n'),'refactor_journal_incomplete');
    events=source.trimEnd().split('\n').map(line=>JSON.parse(line));
    for(const row of events){const {hash,...body}=row;need(hash===digest(body)&&body.previous===last,'refactor_journal_invalid');last=hash;
      if(row.type==='intent'){need(!effects.has(row.key),'refactor_journal_invalid');
        // A key asked again after a discard must carry exactly the next attempt.
        const attempt=nextAttempt(row.key);
        need(attempt===1?!Object.hasOwn(row,'attempt'):row.attempt===attempt,'refactor_journal_invalid');
        effects.set(row.key,{input:row.input,kind:row.kind,...(attempt>1?{attempt}:{})});lastIntent=row.key;}
      if(row.type==='result'){const entry=effects.get(row.key);need(entry&&!Object.hasOwn(entry,'result'),'refactor_journal_invalid');entry.result=row.result;}
      if(row.type==='discard'){checkDiscard(row,effects.get(row.key),lastIntent,discards,discardable);
        discards.push(row);effects.delete(row.key);lastIntent=null;}
    }
  }
  function append(body){
    need(locked,'refactor_lock_required');const row={...json(body,4*1024*1024),previous:last},hash=digest(row);
    const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try{need(fs.fstatSync(fd).nlink===1,'refactor_journal_invalid');fs.writeFileSync(fd,JSON.stringify({...row,hash})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    events.push({...row,hash});last=hash;
  }
  return {
    get context(){return events.find(row=>row.type==='context')?.value??null;},
    get discards(){return discards.map(row=>({...row}));},
    get recovery(){return discardSummary(effects,discards,lastIntent);},
    // True when key/requestDigest name an attempt that was discarded: its late
    // receipt must never be adopted for the attempt asked afterwards.
    discarded(key,requestDigest){return discards.some(item=>item.key===key&&item.requestDigest===requestDigest);},
    // The caller binds key/requestDigest from status and supplies the reason;
    // the row is checked with the replay rules before it is appended.
    discard({key,requestDigest,evidence,released=null}){
      need(typeof evidence==='string'&&evidence.trim()&&evidence.length<=2000,'refactor_discard_evidence_required');
      const entry=effects.get(key);
      need(entry&&entry.kind==='host'&&effectDigest(entry)===requestDigest,'refactor_discard_binding');
      need(lastIntent===key,'refactor_discard_not_last');
      const kind=entry.input.kind,allowed=discardable?.(kind)??null;need(allowed,'refactor_discard_kind');
      need(discards.filter(item=>item.kind===kind).length<MAX_DISCARDS_PER_KIND,'refactor_discard_limit');
      need(!allowed.release||typeof released==='string'&&released.trim()&&released.length<=2000,'refactor_discard_release_required');
      const row={type:'discard',key,kind,reason:Object.hasOwn(entry,'result')?'answer_rejected':'answer_missing',
        attempt:entry.attempt??1,requestDigest:effectDigest(entry),
        resultDigest:Object.hasOwn(entry,'result')?digest(entry.result):null,
        evidence:{sha256:digest(evidence),length:evidence.length},
        released:allowed.release?{source:'operator_confirmed',evidence:digest(released)}:null,at:new Date().toISOString()};
      checkDiscard(row,entry,lastIntent,discards,discardable);
      append(row);discards.push({...row});effects.delete(key);lastIntent=null;
      return {key,kind,reason:row.reason,attempt:row.attempt,remaining:MAX_DISCARDS_PER_KIND-discards.filter(item=>item.kind===kind).length};
    },
    get progress(){return events.findLast(row=>row.type==='progress')?.value??null;},
    effects,
    acquire(){
      need(!locked,'refactor_busy');fs.mkdirSync(directory,{recursive:true,mode:0o700});
      if(fs.existsSync(lock)){
        const old=JSON.parse(readText(lock));need(Number.isSafeInteger(old.pid)&&old.pid>0,'refactor_lock_invalid');
        try{process.kill(old.pid,0);need(false,'refactor_busy');}catch(error){if(error.code!=='ESRCH')throw error;}
        need(readText(lock)===JSON.stringify(old),'refactor_lock_changed');fs.unlinkSync(lock);
      }
      const fd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));}finally{fs.closeSync(fd);}locked=true;
      // Another process may have advanced the journal between construction and lock.
      if(fs.existsSync(target)){const lines=fs.readFileSync(target,'utf8').trimEnd().split('\n');
        need(lines.length===events.length&&JSON.parse(lines.at(-1)).hash===last,'refactor_reopen_required');}
    },
    release(){if(locked){fs.unlinkSync(lock);locked=false;}},
    initialize(value){need(!this.context,'refactor_already_started');append({type:'context',value});},
    progressWrite(value){append({type:'progress',value});},
    // perform/recover receive {key,attempt}. reask(old) lets a caller ask a lost
    // answer again under a new attempt (V7): the lost attempt is discarded by an
    // ordinary, counted discard row with the given evidence, then asked anew.
    async effect(key,kind,input,perform,recover,{reask=null}={}){
      input=json(input,4*1024*1024);
      const old=effects.get(key);
      if(old){need(old.kind===kind&&digest(old.input)===digest(input),'refactor_replay_mismatch');
        if(Object.hasOwn(old,'result'))return json(old.result,4*1024*1024);
        const evidence=reask?.(old)??null;
        if(evidence)this.discard({key,requestDigest:effectDigest(old),evidence});
        else{
          need(typeof recover==='function','refactor_unknown_effect');
          const result=json(await recover(old,perform),4*1024*1024);append({type:'result',key,result});old.result=result;return json(result,4*1024*1024);
        }
      }
      if(['host','command'].includes(kind))need(![...effects.values()].some(entry=>['host','command'].includes(entry.kind)
        &&!Object.hasOwn(entry,'result')),'refactor_unknown_effect');
      const attempt=nextAttempt(key);
      append({type:'intent',key,kind,input,...(attempt>1?{attempt}:{})});const entry={kind,input,...(attempt>1?{attempt}:{})};effects.set(key,entry);lastIntent=key;
      const result=json(await perform({key,attempt}),4*1024*1024);append({type:'result',key,result});entry.result=result;return json(result,4*1024*1024);
    },
    async write(key,target,before,after,mode){
      const input={target,before,after,mode};
      const perform=()=>{const current=readText(target);need(current===before||current===after,'refactor_write_conflict');
        if(current!==after)replaceText(target,before,after,mode);return {written:true};};
      return this.effect(key,'write',input,perform,perform);
    }
  };
}
