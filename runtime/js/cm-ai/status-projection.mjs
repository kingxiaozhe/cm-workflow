// Advisory display only. The existing log lock serializes ownership checks and
// replacement across processes; neither this file nor its token grants work.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {json,need,shape,text,validIdentity} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const LIMIT=64*1024;
export function statusTarget(specsDir){
  need(typeof specsDir==='string'&&path.isAbsolute(specsDir),'status_invalid');
  const specs=fs.realpathSync(specsDir),target=path.join(specs,'.cm-status.json');
  need(fs.lstatSync(specs).isDirectory(),'status_invalid');
  try{
    const stat=fs.lstatSync(target);
    need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=LIMIT,'status_invalid');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  return {specs,target};
}
export function readStatusProjection(specsDir){
  const {target}=statusTarget(specsDir);
  try{
    const value=json(JSON.parse(fs.readFileSync(target,'utf8')),LIMIT);
    need(value&&typeof value==='object'&&!Array.isArray(value),'status_invalid');return value;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function readInput(raw){
  const value=json(raw,LIMIT);
  shape(value,['feature','identity','node','state','detail','claim','expectedToken',
    ...['code','caseId','allowedNodes','previousAttempt'].filter(key=>Object.hasOwn(value,key))]);
  validIdentity(value.identity);
  for(const key of ['feature','node','state','detail']){
    text(value[key]);need(Buffer.byteLength(value[key])<=2000&&!/[\r\n\0]/.test(value[key]),'status_invalid');
  }
  need(typeof value.claim==='boolean'&&(value.expectedToken===null||typeof value.expectedToken==='string'),'status_invalid');
  need(!Object.hasOwn(value,'code')||value.code===null||/^[a-z][a-z0-9_]{0,63}$/.test(value.code),'status_invalid');
  need(!Object.hasOwn(value,'caseId')||typeof value.caseId==='string','status_invalid');
  need(!Object.hasOwn(value,'allowedNodes')||Array.isArray(value.allowedNodes)
    &&value.allowedNodes.length<=8&&value.allowedNodes.every(node=>typeof node==='string'),'status_invalid');
  need(!Object.hasOwn(value,'previousAttempt')||value.state==='changes_requested'
    &&Number.isSafeInteger(value.previousAttempt)&&value.previousAttempt>0
    &&value.previousAttempt===value.identity.attempt-1,'status_invalid');
  return value;
}
const owns=(previous,value)=>previous.feature===value.feature&&previous.task===value.identity.taskId
  &&(previous.run_id===undefined||previous.run_id===value.identity.runId)
  &&(previous.attempt===undefined||previous.attempt===value.identity.attempt||previous.attempt===value.previousAttempt);

// Invoked only by cm-log-event under its Python platform lock. Validation and
// rename are deliberately in the SAME critical section, not two lock calls.
export function statusProjectionCommand(argv,environment){
  need(argv.length===5&&argv[0]==='--status-only'&&argv[1]==='--specs-dir'
    &&argv[3]==='--status-json','status_invalid');
  const {specs,target}=statusTarget(argv[2]),value=readInput(JSON.parse(argv[4]));
  if(environment.CM_LOG_PREFLIGHT==='1')return null;
  need(environment.CM_LOG_LOCK_ADAPTER==='1'&&Number(environment.CM_LOG_LOCK_PARENT_PID)===process.ppid
    &&environment.CM_LOG_PROJECT_LOCK===path.join(specs,'.cm-run.lock'),'status_lock_required');
  const previous=readStatusProjection(specs);
  if(!value.claim&&previous&&(!owns(previous,value)
    ||value.allowedNodes&&!value.allowedNodes.includes(previous.node)
    ||value.caseId&&previous.case_id&&previous.case_id!==value.caseId))return {written:false,token:null};
  if(value.expectedToken!==null&&previous?.progress_id!==value.expectedToken)return {written:false,token:null};
  const token=randomUUID(),projection={node:value.node,feature:value.feature,task:value.identity.taskId,
    run_id:value.identity.runId,attempt:value.identity.attempt,state:value.state,detail:value.detail,
    at:new Date().toTimeString().slice(0,8),progress_id:token,
    ...(value.code?{code:value.code}:{}),...(value.caseId?{case_id:value.caseId}:{})};
  const temporary=path.join(specs,`.cm-status.json.tmp.${process.pid}.${token}`);
  let descriptor;
  try{
    descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o644);
    fs.writeFileSync(descriptor,JSON.stringify(projection)+'\n');fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
    fs.renameSync(temporary,target);
    if(process.platform!=='win32'){
      const directory=fs.openSync(specs,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    }
  }finally{
    if(descriptor!==undefined)fs.closeSync(descriptor);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {written:true,token};
}
export function writeStatusProjection({specsDir,...raw}){
  const {specs}=statusTarget(specsDir),value=readInput({claim:false,expectedToken:null,...raw});
  const result=spawnSync('python3',[writer,'--status-only','--specs-dir',specs,'--status-json',JSON.stringify(value)],
    {timeout:12000,maxBuffer:LIMIT,encoding:'utf8'});
  need(!result.error&&result.status===0&&result.signal===null,'status_write_failed');
  const receipt=JSON.parse(result.stdout);shape(receipt,['written','token']);
  need(typeof receipt.written==='boolean'&&(receipt.token===null||typeof receipt.token==='string'),'status_write_failed');
  return receipt;
}
