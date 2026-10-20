// Commander phase 2: every job the commander sends out (a driver step, a check
// command, a Codex review, a wait) is registered with a deadline before it
// starts and marked done when its result is read. The ledger reports anything
// past its deadline, so a job that hangs is found on the next commander step
// instead of hours later. This registry is the commander's own record: it is
// kept under the CM home, never in specs (which would drift the approved
// manifest), and it grants nothing to the job it describes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const REGISTRY_VERSION=1;
const MAX_DEADLINE_MINUTES=24*60;
const LINE_LIMIT=16*1024,FILE_LIMIT=8*1024*1024;
const RESOURCE=/^device:[A-Za-z0-9-]{1,64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const home=()=>process.env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow');

export function registryDir(specsDir){
  const key=createHash('sha256').update(fs.realpathSync(specsDir)).digest('hex').slice(0,16);
  return path.join(home(),'commander',key);
}
const fileOf=specsDir=>path.join(registryDir(specsDir),'dispatch.jsonl');

// Device ids are compared in one form everywhere.
export const normalizeResource=resource=>resource.startsWith('device:')?`device:${resource.slice(7).toUpperCase()}`:resource;

// Rows are read back strictly: a bad line is counted and never guessed at, and
// a done row only closes an id that was added.
function parseRegistry(text){
  const jobs=new Map();let invalid=0;
  for(const line of text.split('\n')){
    if(!line)continue;
    let row;try{row=JSON.parse(line);}catch{invalid++;continue;}
    if(row?.v!==REGISTRY_VERSION||typeof row.id!=='string'||!Number.isFinite(Date.parse(row.at))){invalid++;continue;}
    if(row.op==='add'&&!jobs.has(row.id)&&typeof row.label==='string'&&Number.isFinite(Date.parse(row.deadline)))
      jobs.set(row.id,{id:row.id,label:row.label,startedAt:row.at,deadline:row.deadline,runId:row.runId??null,
        resources:Array.isArray(row.resources)?row.resources.filter(r=>typeof r==='string'&&RESOURCE.test(r)).map(normalizeResource):[],
        doneAt:null,outcome:null});
    else if(row.op==='done'&&jobs.get(row.id)?.doneAt===null){const job=jobs.get(row.id);job.doneAt=row.at;job.outcome=row.outcome??null;}
    else invalid++;
  }
  return {jobs,invalid,torn:text.length>0&&!text.endsWith('\n')};
}

// An unreadable file, bad rows or a torn tail are reported to the caller,
// which must not read them as "no jobs".
export function readRegistry(specsDir){
  const file=fileOf(specsDir);
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>FILE_LIMIT)return {jobs:new Map(),invalid:0,torn:false,error:'registry_unreadable'};
    return {...parseRegistry(fs.readFileSync(file,'utf8')),error:null};}
  catch(error){return {jobs:new Map(),invalid:0,torn:false,error:error.code==='ENOENT'?null:(error.code??'registry_unreadable')};}
}

// The registry's own health in one word, or null when it is sound.
export const registryProblem=registry=>registry.error??(registry.torn?'registry_torn':registry.invalid?`registry_invalid_rows:${registry.invalid}`:null);

// One writer at a time: an exclusive lock file around the whole read-check-
// append, released in finally. A stale lock is reported, never broken. Inside
// the lock the file must end on a line boundary: a torn tail would swallow the
// next row, so the append is refused and the bytes are left for inspection.
function withLock(specsDir,write){
  const dir=registryDir(specsDir);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,'dispatch.lock'),file=path.join(dir,'dispatch.jsonl');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('registry_locked');throw error;}
  try{
    let text='';try{text=fs.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(text&&!text.endsWith('\n'))fail('registry_torn');
    const registry=parseRegistry(text);
    const row=write(registry),line=JSON.stringify(row)+'\n';
    if(Buffer.byteLength(line)>LINE_LIMIT)fail('registry_row_too_large');
    fs.appendFileSync(file,line,{mode:0o600});
    return row;
  }finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}
}

export function addDispatch(specsDir,{label,deadlineMinutes,runId=null,resources=[],now=new Date().toISOString(),id=randomUUID()}){
  if(typeof label!=='string'||!label.trim()||label.length>200||/[\r\n\0]/.test(label))fail('invalid_label');
  if(!Number.isInteger(deadlineMinutes)||deadlineMinutes<1||deadlineMinutes>MAX_DEADLINE_MINUTES)fail('invalid_deadline');
  if(runId!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId))fail('invalid_run_id');
  if(!Array.isArray(resources)||!resources.every(r=>typeof r==='string'&&RESOURCE.test(r)))fail('invalid_resource');
  const start=Date.parse(now);if(!Number.isFinite(start))fail('invalid_now');
  const deadline=new Date(start+deadlineMinutes*60000).toISOString();
  withLock(specsDir,registry=>{
    if(registry.jobs.has(id))fail('dispatch_exists');
    return {v:REGISTRY_VERSION,op:'add',id,at:new Date(start).toISOString(),label:label.trim(),deadline,runId,resources:resources.map(normalizeResource)};
  });
  return {id,deadline};
}

// The eligibility check and the done row share one lock, so two finishers
// cannot both report success.
export function finishDispatch(specsDir,{id,outcome='done',now=new Date().toISOString()}){
  if(!['done','failed','abandoned'].includes(outcome))fail('invalid_outcome');
  const at=Date.parse(now);if(!Number.isFinite(at))fail('invalid_now');
  withLock(specsDir,registry=>{
    const job=registry.jobs.get(id);
    if(!job)fail('unknown_dispatch');if(job.doneAt!==null)fail('dispatch_already_done');
    return {v:REGISTRY_VERSION,op:'done',id,at:new Date(at).toISOString(),outcome};
  });
}

// Open jobs, each marked overdue once its deadline has passed.
export function openDispatches(registry,now){
  const nowMs=Date.parse(now);
  return [...registry.jobs.values()].filter(job=>job.doneAt===null)
    .map(job=>({...job,overdueMinutes:Math.max(0,Math.floor((nowMs-Date.parse(job.deadline))/60000)),
      overdue:nowMs>Date.parse(job.deadline)}));
}
