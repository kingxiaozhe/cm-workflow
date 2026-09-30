// Current-session execution transport. The host owns evidence semantics;
// this responder only binds a fresh reply to its original live request.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const KINDS=new Set(['qa_logic','qa_browser','verification_precheck','prd_materials']);
const fail=code=>{throw Error(code);};
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
function resolvedFutureRoot(file){
  let existing=path.resolve(file);const tail=[];
  while(!fs.existsSync(existing)){
    const parent=path.dirname(existing);if(parent===existing)break;
    tail.unshift(path.basename(existing));existing=parent;
  }
  return path.join(fs.realpathSync(existing),...tail);
}
function ordinaryAncestors(file){
  let current=path.parse(file).root;
  for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{const stat=fs.lstatSync(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('live_evidence_unsafe_directory');
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
export function createLiveEvidence(config,{base,protectedRoots=[],notify=()=>{},maxBytes=65536,allowedKinds=[...KINDS]}={}){
  if(config===undefined)return {has:()=>false,answer:async()=>null};
  if(!config||typeof config!=='object'||Array.isArray(config)
    ||Object.keys(config).some(key=>!['directory','kinds','timeoutMs'].includes(key))
    ||typeof config.directory!=='string'||!config.directory.trim()
    ||!Array.isArray(config.kinds)||!config.kinds.length
    ||new Set(config.kinds).size!==config.kinds.length
    ||!config.kinds.every(kind=>KINDS.has(kind)&&allowedKinds.includes(kind)))fail('live_evidence_invalid_config');
  const timeout=config.timeoutMs??900000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)fail('live_evidence_invalid_limit');
  const directory=path.resolve(base??process.cwd(),config.directory);
  const validateDirectory=()=>{
    ordinaryAncestors(directory);
    for(const root of protectedRoots.filter(Boolean)){
      const resolved=resolvedFutureRoot(root),lexical=path.resolve(root);
      if([resolved,lexical].some(value=>inside(value,directory)||inside(directory,value)))fail('live_evidence_protected_directory');
    }
    if(fs.existsSync(directory)){
      const stat=fs.lstatSync(directory);
      if((stat.mode&0o077)!==0||typeof process.getuid==='function'&&stat.uid!==process.getuid())
        fail('live_evidence_directory_not_private');
    }
  };
  validateDirectory();
  const kinds=new Set(config.kinds),seen=new Set();let exchange=null;
  return {has:kind=>kinds.has(kind),async answer(row,{signal}={}){
    if(!kinds.has(row.kind))return null;
    if(signal?.aborted)fail('live_evidence_cancelled');
    if(row.type!=='host_request'||!row.sessionId||!row.callId
      ||typeof row.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(row.requestDigest))fail('live_evidence_invalid_request');
    const key=JSON.stringify([row.sessionId,row.callId]);
    if(seen.has(key))fail('live_evidence_duplicate_call');
    seen.add(key);validateDirectory();
    if(exchange===null){
      fs.mkdirSync(directory,{recursive:true,mode:0o700});validateDirectory();
      exchange=path.join(directory,randomUUID());fs.mkdirSync(exchange,{mode:0o700});
    }
    // File names never contain caller-controlled identifiers.
    const stem=path.join(exchange,randomUUID()),requestFile=stem+'.request.json',resultFile=stem+'.result.json';
    fs.writeFileSync(requestFile,JSON.stringify(row)+'\n',{flag:'wx',mode:0o600});
    notify(requestFile);const end=Date.now()+timeout;
    while(true){
      if(signal?.aborted)fail('live_evidence_cancelled');
      let fd;
      try{
        fd=fs.openSync(resultFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const before=fs.fstatSync(fd);
        if(!before.isFile()||before.nlink!==1||before.size>maxBytes)fail('live_evidence_unsafe_result');
        const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
        if(bytes.length>maxBytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('live_evidence_result_changed');
        let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('live_evidence_invalid_json');}
        if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='callId,requestDigest,result,sessionId,type'
          ||value.type!=='host_result'||value.sessionId!==row.sessionId||value.callId!==row.callId
          ||value.requestDigest!==row.requestDigest)fail('live_evidence_binding_mismatch');
        return value.result;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      finally{if(fd!==undefined)fs.closeSync(fd);}
      if(Date.now()>=end)fail('live_evidence_timeout');
      try{await delay(Math.min(100,end-Date.now()),undefined,{signal});}
      catch(error){if(error.name==='AbortError')fail('live_evidence_cancelled');throw error;}
    }
  }};
}

export function driverLiveEvidence(plan,options){
  return createLiveEvidence(plan.liveEvidence,{...options,notify:file=>process.stderr.write(
    `[drive] live_evidence_request: ${file}\n[drive] Read the live request, execute its task, then atomically write the matching .result.json host_result.\n`)});
}
