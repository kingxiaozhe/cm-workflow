#!/usr/bin/env node
// JavaScript authority for CM log-event validation and state decisions.
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const IDENTIFIER=/^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const RESOURCE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SENSITIVE_KEY=/(api[_-]?key|authorization|cookie|password|passwd|private[_-]?key|recovery[_-]?code|secret|token)/i;
const RESERVED_FIELDS=new Set(['schema_version','event_id','run_id','at','workflow','event','phase','runtime','project','project_path','specs_path','detail']);
export const TERMINAL_EVENTS=new Set(['done','run_done']);
export const RESOURCE_GUARDED_EVENTS=new Set([...TERMINAL_EVENTS,'task_done']);
const RESOURCE_PHASES=new Set(['acquired','released','cleanup_failed']);

export class UsageError extends Error {
  constructor(message){super(message);this.name='UsageError';}
}

function validateIdentifier(label,value,{optional=false}={}){
  if((value===null||value===undefined)&&optional)return value;
  if(typeof value!=='string'||!IDENTIFIER.test(value))
    throw new UsageError(`${label} must match ${IDENTIFIER}; got ${JSON.stringify(value)}`);
  return value;
}

function validateDetail(detail){
  if(typeof detail!=='string'||!detail.trim())throw new UsageError('--detail cannot be empty');
  if([...detail].length>500)throw new UsageError('--detail cannot exceed 500 characters');
  if(/[\n\r\0]/.test(detail))throw new UsageError('--detail cannot contain control-line characters');
  return detail;
}

function rejectSensitiveKeys(value,location='data'){
  if(Array.isArray(value))value.forEach((child,index)=>rejectSensitiveKeys(child,`${location}[${index}]`));
  else if(value!==null&&typeof value==='object')for(const [key,child] of Object.entries(value)){
    if(SENSITIVE_KEY.test(key))throw new UsageError(`sensitive log field is forbidden: ${location}.${key}`);
    rejectSensitiveKeys(child,`${location}.${key}`);
  }
}

export function parseData(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)throw new UsageError('--data-json cannot exceed 8192 UTF-8 bytes');
  let value;
  try{value=JSON.parse(raw);}catch{throw new UsageError('--data-json must be a JSON object');}
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new UsageError('--data-json must be a JSON object');
  const overlap=Object.keys(value).filter(key=>RESERVED_FIELDS.has(key)).sort();
  if(overlap.length)throw new UsageError(`--data-json cannot override reserved fields: ${overlap.join(', ')}`);
  rejectSensitiveKeys(value);return value;
}

export function validateResourceEvent(event,phase,data){
  if(event!=='resource')return;
  if(!RESOURCE_PHASES.has(phase))throw new UsageError('resource events require phase acquired, released, or cleanup_failed');
  if(typeof data.resource_id!=='string'||!RESOURCE_ID.test(data.resource_id))
    throw new UsageError('resource events require a valid resource_id');
  if(typeof data.resource_kind!=='string'||!IDENTIFIER.test(data.resource_kind))
    throw new UsageError('resource events require a valid resource_kind');
  if(phase==='acquired'&&data.cleanup_required!==true)
    throw new UsageError('resource acquisition requires cleanup_required: true');
}

function localIsoSeconds(date){
  const pad=value=>String(value).padStart(2,'0'),offset=-date.getTimezoneOffset(),sign=offset>=0?'+':'-';
  const absolute=Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute/60))}:${pad(absolute%60)}`;
}

export function parseTimestamp(raw,now=new Date()){
  if(raw===null||raw===undefined)return {at:localIsoSeconds(now),parsedAt:new Date(now)};
  if(typeof raw!=='string'||!/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)||Number.isNaN(Date.parse(raw)))
    throw new UsageError('--at must be an ISO-8601 timestamp with a timezone offset');
  const match=raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
  if(!match)throw new UsageError('--at must be an ISO-8601 timestamp');
  const offset=match[4]==='Z'?'+00:00':match[4].replace(/^([+-]\d{2})(\d{2})$/,'$1:$2');
  return {at:`${match[1]}T${match[2]}:${match[3]??'00'}${offset}`,parsedAt:new Date(raw)};
}

export function generatedRunId(now=new Date(),uuid=randomUUID()){
  const stamp=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  return `${stamp}-${uuid.replaceAll('-','').slice(0,8)}`;
}

export function selectRunId({explicit,event,pointer,latestProjectRun,projectStates,now,uuid}){
  if(explicit!==null&&explicit!==undefined){
    if(typeof explicit!=='string'||!RUN_ID.test(explicit))throw new UsageError('invalid --run-id');
    return {runId:explicit,newRun:event==='run_start'};
  }
  if(pointer?.status==='running'&&projectStates[pointer.run_id]!=='done')return {runId:pointer.run_id,newRun:false};
  if(pointer?.status==='done'&&TERMINAL_EVENTS.has(event))return {runId:pointer.run_id,newRun:false};
  if(latestProjectRun&&projectStates[latestProjectRun]==='running')return {runId:latestProjectRun,newRun:false};
  if(latestProjectRun&&projectStates[latestProjectRun]==='done'&&TERMINAL_EVENTS.has(event))
    return {runId:latestProjectRun,newRun:false};
  return {runId:generatedRunId(now,uuid),newRun:true};
}

function canonical(value){
  if(value===null||['string','boolean','number'].includes(typeof value))return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function uuid5(name){
  const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
  const bytes=createHash('sha1').update(namespace).update(name).digest().subarray(0,16);
  bytes[6]=(bytes[6]&0x0f)|0x50;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function deterministicEventId(value){
  const identity={...value};delete identity.at;delete identity.event_id;
  return uuid5(canonical(identity));
}

export function applyResourceTransition(states,resourceId,resourceKind,phase){
  const previous=states.get(resourceId);
  if(previous===undefined){
    if(phase!=='acquired')throw new UsageError('resource terminal phase has no acquisition');
    states.set(resourceId,[phase,resourceKind]);return;
  }
  const [previousPhase,previousKind]=previous;
  if(previousKind!==resourceKind)throw new UsageError('resource_kind does not match its acquisition');
  if(phase==='acquired'){
    if(previousPhase!=='acquired')throw new UsageError('released resource_id cannot be reused; acquire a new resource_id');
    throw new UsageError('active resource_id already has an acquisition; acquire a new resource_id');
  }
  if(phase==='cleanup_failed'&&previousPhase==='released')throw new UsageError('released resource cannot fail cleanup');
  states.set(resourceId,[phase,resourceKind]);
}

export function unclosedResources(states){
  return [...states].filter(([,value])=>['acquired','cleanup_failed'].includes(value[0])).map(([key])=>key).sort();
}

export function buildEvent(input,state={}){
  const workflow=validateIdentifier('--workflow',input.workflow);
  const event=validateIdentifier('--event',input.event);
  const phase=validateIdentifier('--phase',input.phase??null,{optional:true});
  const runtime=validateIdentifier('--runtime',input.runtime);
  const detail=validateDetail(input.detail),data=parseData(input.dataJson??'{}');
  validateResourceEvent(event,phase,data);
  const {at,parsedAt}=parseTimestamp(input.at??null,state.now);
  const projectRoot=input.projectRoot?path.resolve(input.projectRoot):null;
  const specsDir=input.specsDir?path.resolve(input.specsDir):null;
  const project=input.project??(projectRoot?path.basename(projectRoot):'unscoped');
  if(typeof project!=='string'||[...project].length>120||/[\n\r\0]/.test(project))
    throw new UsageError('--project must be one line and at most 120 characters');
  const selection=selectRunId({explicit:input.runId??null,event,pointer:state.pointer??null,
    latestProjectRun:state.latestProjectRun??null,projectStates:state.projectStates??{},now:state.now,uuid:state.uuid});
  const value={schema_version:1,run_id:selection.runId,at,workflow,event,runtime,project,detail};
  if(phase)value.phase=phase;if(projectRoot)value.project_path=projectRoot;if(specsDir)value.specs_path=specsDir;
  Object.assign(value,data);value.event_id=deterministicEventId(value);
  return {event:value,parsedAt, ...selection};
}

function expandUser(value){
  if(value==='~')return os.homedir();
  if(value.startsWith('~/'))return path.join(os.homedir(),value.slice(2));
  return value;
}

function resolveDirectory(label,value){
  if(value===null||value===undefined)return null;
  let resolved;
  try{resolved=fs.realpathSync(expandUser(value));}
  catch{throw new UsageError(`${label} is not an existing directory: ${path.resolve(expandUser(value))}`);}
  if(!fs.statSync(resolved).isDirectory())throw new UsageError(`${label} is not an existing directory: ${resolved}`);
  return resolved;
}

function parseJsonLine(line){try{return JSON.parse(line);}catch{return null;}}

function loadPointer(file){
  if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile())return null;
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    return value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.run_id==='string'&&RUN_ID.test(value.run_id)?value:null;
  }catch{return null;}
}

function readJsonLines(file,{strict=false}={}){
  if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile())return [];
  const rows=[];
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line)continue;
    const value=parseJsonLine(line);
    if(value===null){if(strict)throw new UsageError('resource state log contains invalid JSON');continue;}
    rows.push(value);
  }
  return rows;
}

function loadProjectRunState(file){
  let latestProjectRun=null;const projectStates={};
  try{
    for(const value of readJsonLines(file)){
      if(!value||typeof value!=='object'||typeof value.run_id!=='string'||!RUN_ID.test(value.run_id)||typeof value.event!=='string')continue;
      latestProjectRun=value.run_id;
      if(value.event==='run_start')projectStates[value.run_id]='running';
      else if(TERMINAL_EVENTS.has(value.event))projectStates[value.run_id]='done';
      else if(!Object.hasOwn(projectStates,value.run_id))projectStates[value.run_id]='running';
    }
  }catch{return {latestProjectRun:null,projectStates:{}};}
  return {latestProjectRun,projectStates};
}

function findJsonlEvent(file,eventId){
  try{return readJsonLines(file).find(value=>value&&typeof value==='object'&&value.event_id===eventId)??null;}
  catch{return null;}
}

function loadResourceStates(file,runId){
  const states=new Map();
  for(const value of readJsonLines(file,{strict:true})){
    if(!value||typeof value!=='object'||value.run_id!==runId||value.event!=='resource')continue;
    if(typeof value.resource_id!=='string'||!RESOURCE_ID.test(value.resource_id)
      ||typeof value.resource_kind!=='string'||!IDENTIFIER.test(value.resource_kind)||!RESOURCE_PHASES.has(value.phase))
      throw new UsageError('resource state log contains a malformed event');
    if(value.phase==='acquired'&&value.cleanup_required!==true)
      throw new UsageError('resource acquisition is missing cleanup_required');
    applyResourceTransition(states,value.resource_id,value.resource_kind,value.phase);
  }
  return states;
}

function compactJson(value){return `${JSON.stringify(value)}\n`;}
function ensureDirectory(directory,mode){fs.mkdirSync(directory,{recursive:true,mode});if(process.platform!=='win32')fs.chmodSync(directory,mode);}
function appendLine(file,value,{privateFile=false}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const descriptor=fs.openSync(file,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY,privateFile?0o600:0o644);
  try{fs.writeFileSync(descriptor,compactJson(value));fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
  if(privateFile&&process.platform!=='win32')fs.chmodSync(file,0o600);
}

function writePointer(file,value){
  const temporary=path.join(path.dirname(file),`${path.basename(file)}.tmp.${process.pid}.${randomUUID().replaceAll('-','')}`);
  try{fs.writeFileSync(temporary,compactJson(value),{encoding:'utf8',mode:0o644});fs.renameSync(temporary,file);}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

function indexHasStatus(file,runId,status){
  try{return readJsonLines(file).some(value=>value&&typeof value==='object'&&value.run_id===runId&&value.status===status);}
  catch{return false;}
}

function pointerGlobalLog(pointer,globalHome,runId){
  if(!pointer||pointer.run_id!==runId||typeof pointer.global_log!=='string')return null;
  const candidate=path.resolve(expandUser(pointer.global_log)),relative=path.relative(globalHome,candidate),parts=relative.split(path.sep);
  if(relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||parts.length!==3||parts[0]!=='runs'
    ||!/^\d{4}-\d{2}$/.test(parts[1])||parts[2]!==`${runId}.jsonl`)return null;
  return candidate;
}

function selectGlobalLog({globalHome,runId,at,pointer}){
  const pointed=pointerGlobalLog(pointer,globalHome,runId);if(pointed)return pointed;
  const runs=path.join(globalHome,'runs'),matches=[];
  if(fs.existsSync(runs))for(const month of fs.readdirSync(runs)){
    const candidate=path.join(runs,month,`${runId}.jsonl`);
    if(fs.existsSync(candidate))matches.push(path.resolve(candidate));
  }
  matches.sort();
  if(matches.length>1)throw new UsageError(`multiple global log files found for run_id ${runId}; repair the local mirror before continuing`);
  return matches[0]??path.join(runs,at.slice(0,7),`${runId}.jsonl`);
}

function degradeEvent({runId,at,workflow,runtime,project,projectRoot,specsDir,phase,detail,errorType}){
  const value={schema_version:1,run_id:runId,at,workflow,event:'degrade',phase,runtime,project,detail,error_type:errorType};
  if(projectRoot)value.project_path=projectRoot;if(specsDir)value.specs_path=specsDir;
  value.event_id=deterministicEventId(value);return value;
}

function requireLockAdapter({specsDir,globalHome},environment){
  if(environment.CM_LOG_LOCK_ADAPTER!=='1'||Number(environment.CM_LOG_LOCK_PARENT_PID)!==process.ppid)
    throw new UsageError('cm-log-event writes require the platform lock adapter');
  if(specsDir&&environment.CM_LOG_PROJECT_LOCK!==path.join(specsDir,'.cm-run.lock'))
    throw new UsageError('project log lock is not held for this specs directory');
  if(environment.CM_LOG_GLOBAL_LOCKED==='1'&&environment.CM_LOG_GLOBAL_LOCK!==path.join(globalHome,'.cm-write.lock'))
    throw new UsageError('global log lock is not held for this log home');
}

function prepareInput(input){
  const projectRoot=resolveDirectory('--project-root',input.projectRoot??null);
  const specsDir=resolveDirectory('--specs-dir',input.specsDir??null);
  buildEvent({...input,projectRoot,specsDir},{now:new Date(),uuid:'00000000-0000-4000-8000-000000000000'});
  return {...input,projectRoot,specsDir};
}

export function writeLogEvent(rawInput,{environment=process.env,now=new Date(),uuid=randomUUID()}={}){
  const input=prepareInput(rawInput),globalHome=fs.realpathSync(path.resolve(expandUser(environment.CM_WORKFLOW_LOG_HOME??'~/.cm-workflow/logs')));
  requireLockAdapter({specsDir:input.specsDir,globalHome},environment);
  const pointerPath=input.specsDir?path.join(input.specsDir,'.cm-run.json'):null;
  const projectLog=input.specsDir?path.join(input.specsDir,'运行日志.jsonl'):null;
  const pointer=loadPointer(pointerPath),runState=loadProjectRunState(projectLog);
  let built=buildEvent(input,{pointer,...runState,now,uuid}),event=built.event,{at}=event;
  const terminal=TERMINAL_EVENTS.has(event.event),globalLocked=environment.CM_LOG_GLOBAL_LOCKED==='1';
  let globalLog=projectLog?null:selectGlobalLog({globalHome,runId:built.runId,at,pointer});
  const authoritativeLog=projectLog??globalLog;
  let existing=['resource',...RESOURCE_GUARDED_EVENTS].includes(event.event)?findJsonlEvent(authoritativeLog,event.event_id):null;
  let resourceStates=new Map();
  if(existing===null&&(event.event==='resource'||RESOURCE_GUARDED_EVENTS.has(event.event)))try{
    resourceStates=loadResourceStates(authoritativeLog,built.runId);
  }catch(error){throw new UsageError(`resource state cannot be verified: ${error.name}`);}
  if(existing===null&&RESOURCE_GUARDED_EVENTS.has(event.event)){
    const pending=unclosedResources(resourceStates);
    if(pending.length)throw new UsageError(`completion blocked by unclosed resources: ${pending.join(', ')}`);
  }
  if(existing===null&&event.event==='resource')applyResourceTransition(resourceStates,event.resource_id,event.resource_kind,event.phase);

  let projectDuplicate=false;
  if(projectLog){
    const projectExisting=findJsonlEvent(projectLog,event.event_id);projectDuplicate=projectExisting!==null;
    if(projectExisting){event=projectExisting;at=event.at;built={...built,parsedAt:parseTimestamp(at).parsedAt};}
    else appendLine(projectLog,event);
  }
  if(globalLog===null)globalLog=selectGlobalLog({globalHome,runId:built.runId,at,pointer});
  let globalWritten=false,degraded=false,globalDuplicate=false;
  try{
    if(!globalLocked){const error=new Error(environment.CM_LOG_GLOBAL_LOCK_ERROR??'global lock unavailable');error.name=environment.CM_LOG_GLOBAL_LOCK_ERROR_TYPE??'OSError';throw error;}
    ensureDirectory(globalHome,0o700);ensureDirectory(path.join(globalHome,'runs'),0o700);ensureDirectory(path.dirname(globalLog),0o700);
    globalDuplicate=findJsonlEvent(globalLog,event.event_id)!==null;
    if(!globalDuplicate)appendLine(globalLog,event,{privateFile:true});
    const index=path.join(globalHome,'index.jsonl');
    if(built.newRun&&!indexHasStatus(index,built.runId,'running'))appendLine(index,{schema_version:1,at,run_id:built.runId,status:'running',
      workflow:event.workflow,runtime:event.runtime,project:event.project,project_path:input.projectRoot??null,
      specs_path:input.specsDir??null,log_file:path.relative(globalHome,globalLog)},{privateFile:true});
    if(terminal&&!indexHasStatus(index,built.runId,'done'))appendLine(index,{schema_version:1,at,run_id:built.runId,status:'done',
      workflow:event.workflow,runtime:event.runtime,project:event.project,log_file:path.relative(globalHome,globalLog)},{privateFile:true});
    globalWritten=true;
  }catch(error){
    if(!projectLog)throw error;
    degraded=true;
    const degradation=degradeEvent({runId:built.runId,at,workflow:event.workflow,runtime:event.runtime,project:event.project,
      projectRoot:input.projectRoot,specsDir:input.specsDir,phase:'global_log',detail:'全局日志镜像写入失败，项目日志继续作为权威来源',errorType:error.name});
    if(!findJsonlEvent(projectLog,degradation.event_id))appendLine(projectLog,degradation);
    process.stderr.write('cm-log-event: global mirror unavailable; project log retained\n');
  }

  let pointerWritten=null;
  if(pointerPath){
    try{
      writePointer(pointerPath,{schema_version:1,run_id:built.runId,workflow:event.workflow,status:terminal?'done':'running',
        global_log:globalLog,global_written:globalWritten,updated_at:at});pointerWritten=true;
    }catch(error){
      pointerWritten=false;degraded=true;
      const degradation=degradeEvent({runId:built.runId,at,workflow:event.workflow,runtime:event.runtime,project:event.project,
        projectRoot:input.projectRoot,specsDir:input.specsDir,phase:'run_pointer',detail:'运行指针写入失败，将从权威项目日志恢复',errorType:error.name});
      if(!findJsonlEvent(projectLog,degradation.event_id))appendLine(projectLog,degradation);
      if(globalWritten)try{if(!findJsonlEvent(globalLog,degradation.event_id))appendLine(globalLog,degradation,{privateFile:true});}catch{}
      process.stderr.write('cm-log-event: active-run pointer unavailable; project log recovery retained\n');
    }
  }
  return {event_id:event.event_id,run_id:built.runId,project_log:projectLog,global_log:globalLog,global_written:globalWritten,
    pointer_written:pointerWritten,deduplicated:projectLog?projectDuplicate:globalDuplicate,degraded};
}

function parseCli(argv){
  if(argv.includes('--help')||argv.includes('-h'))return {help:true};
  const names=new Map([['--workflow','workflow'],['--event','event'],['--phase','phase'],['--runtime','runtime'],['--project','project'],
    ['--project-root','projectRoot'],['--specs-dir','specsDir'],['--run-id','runId'],['--at','at'],['--detail','detail'],['--data-json','dataJson']]);
  const result={dataJson:'{}'};
  for(let index=0;index<argv.length;index+=2){
    const key=names.get(argv[index]),value=argv[index+1];if(!key||value===undefined)throw new UsageError('invalid arguments');result[key]=value;
  }
  for(const key of ['workflow','event','runtime','detail'])if(!Object.hasOwn(result,key))throw new UsageError(`--${key.replace(/[A-Z]/g,c=>`-${c.toLowerCase()}`)} is required`);
  return result;
}

function asciiJson(value){return JSON.stringify(value).replace(/[\u007f-\uffff]/g,character=>`\\u${character.charCodeAt(0).toString(16).padStart(4,'0')}`);}
function usage(){return 'usage: cm-log-event.py --workflow NAME --event NAME --runtime NAME --detail TEXT [options]';}

export function main(argv=process.argv.slice(2),environment=process.env){
  try{
    const input=parseCli(argv);if(input.help){process.stdout.write(`${usage()}\n`);return 0;}
    if(environment.CM_LOG_PREFLIGHT==='1'){prepareInput(input);return 0;}
    const result=writeLogEvent(input,{environment});process.stdout.write(`${asciiJson(result)}\n`);return 0;
  }catch(error){process.stderr.write(`cm-log-event: ${error.message}\n`);return error instanceof UsageError?2:1;}
}

function isMain(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMain(process.argv[1]))process.exitCode=main();
