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
export function openRefactorRecords(directory){
  need(canonicalFuture(directory)===directory,'refactor_archive_changed');
  const target=path.join(directory,'execution.jsonl'),lock=path.join(directory,'.writer.json');
  let events=[],last=null,locked=false;const effects=new Map();
  if(fs.existsSync(target)){
    const stat=fs.lstatSync(target);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=32*1024*1024,'refactor_journal_invalid');
    const source=fs.readFileSync(target,'utf8');need(source.endsWith('\n'),'refactor_journal_incomplete');
    events=source.trimEnd().split('\n').map(line=>JSON.parse(line));
    for(const row of events){const {hash,...body}=row;need(hash===digest(body)&&body.previous===last,'refactor_journal_invalid');last=hash;
      if(row.type==='intent'){need(!effects.has(row.key),'refactor_journal_invalid');effects.set(row.key,{input:row.input,kind:row.kind});}
      if(row.type==='result'){const entry=effects.get(row.key);need(entry&&!Object.hasOwn(entry,'result'),'refactor_journal_invalid');entry.result=row.result;}
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
    async effect(key,kind,input,perform,recover){
      input=json(input,4*1024*1024);
      const old=effects.get(key);
      if(old){need(old.kind===kind&&digest(old.input)===digest(input),'refactor_replay_mismatch');
        if(Object.hasOwn(old,'result'))return json(old.result,4*1024*1024);
        need(typeof recover==='function','refactor_unknown_effect');
        const result=json(await recover(old,perform),4*1024*1024);append({type:'result',key,result});old.result=result;return json(result,4*1024*1024);
      }
      if(['host','command'].includes(kind))need(![...effects.values()].some(entry=>['host','command'].includes(entry.kind)
        &&!Object.hasOwn(entry,'result')),'refactor_unknown_effect');
      append({type:'intent',key,kind,input});const entry={kind,input};effects.set(key,entry);
      const result=json(await perform(),4*1024*1024);append({type:'result',key,result});entry.result=result;return json(result,4*1024*1024);
    },
    async write(key,target,before,after,mode){
      const input={target,before,after,mode};
      const perform=()=>{const current=readText(target);need(current===before||current===after,'refactor_write_conflict');
        if(current!==after)replaceText(target,before,after,mode);return {written:true};};
      return this.effect(key,'write',input,perform,perform);
    }
  };
}
