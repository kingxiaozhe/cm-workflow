// Local bounded declarative JSON. No global state, secrets, or store migrations.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {need,digest} from './effect-contract.mjs';
const LIMIT=64*1024;
const RUN_DIRECTORIES=new Set(['.reviews','.cm-model-runtime-v1','.cm-model-reviews-v1','.cm-model-runtime-v2','.cm-model-reviews-v2','.cm-model-fix-runtime-v1','.cm-external-models-v1']);
const RUN_FILES=new Set(['.cm-task-owner.json','.cm-model-code-owner-v1.json','.cm-model-project-owner-v2.json','.cm-model-snapshot-v1.json','.cm-model-fix-owner-v1.json']);
export function parseModelJson(text){
  need(typeof text==='string'&&Buffer.byteLength(text)<=LIMIT,'model_configuration_too_large');
  let value;try{value=JSON.parse(text);}catch{need(false,'invalid_model_json');}
  const tokens=text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)??[];let index=0;
  const walk=depth=>{
    need(depth<=32,'model_configuration_too_deep');const token=tokens[index++];
    if(token==='{'){
      const keys=new Set();if(tokens[index]==='}'){index++;return;}
      for(;;){const key=JSON.parse(tokens[index++]);need(!keys.has(key),'duplicate_model_json_key');keys.add(key);index++;walk(depth+1);
        if(tokens[index++]==='}')return;}
    }
    if(token==='['){if(tokens[index]===']'){index++;return;}for(;;){walk(depth+1);if(tokens[index++]===']')return;}}
  };
  walk(0);return value;
}
const match=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs','nlink'].every(k=>a[k]===b[k]);
export function readModelJsonRecord(file){
  const before=fs.lstatSync(file);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=LIMIT,'invalid_model_configuration_file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    need(match(before,fs.fstatSync(fd)),'model_configuration_changed');const bytes=fs.readFileSync(fd);const text=bytes.toString('utf8');
    need(bytes.equals(Buffer.from(text))&&match(before,fs.fstatSync(fd))&&match(before,fs.lstatSync(file)),'model_configuration_changed');
    return {value:parseModelJson(text),sha256:createHash('sha256').update(bytes).digest('hex')};
  }finally{fs.closeSync(fd);}
}
export const readModelJson=file=>readModelJsonRecord(file).value;
export function assertModelOutputPath(file){
  const target=path.resolve(file);
  need(!target.split(path.sep).some(segment=>RUN_DIRECTORIES.has(segment.toLowerCase()))
    &&!RUN_FILES.has(path.basename(target).toLowerCase()),'model_output_run_path_forbidden');
  return target;
}
export function writeModelJson(file,value,{expectedDigest,expectedSha256,replace=true,createParents=false,sourceGuard=null}={}){
  const target=assertModelOutputPath(file);
  need(path.basename(target).toLowerCase()!=='.cm-model-config.lock','model_output_run_path_forbidden');
  // No downgrade to a path-based writer if the platform/helper is unavailable.
  need(process.platform!=='win32'&&fs.existsSync('/usr/bin/python3'),'model_secure_write_unavailable');
  let before=null;
  try{const info=fs.lstatSync(target);need(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1,'invalid_model_configuration_file');
    need(replace,'model_configuration_exists');before=readModelJsonRecord(target);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  if(expectedDigest!==undefined)need(expectedDigest===null?before===null:before!==null&&digest(before.value)===expectedDigest,'model_configuration_changed');
  if(expectedSha256!==undefined)need((before?.sha256??null)===expectedSha256,'model_configuration_changed');
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');need(bytes.length<=LIMIT,'model_configuration_too_large');
  const request={target,bytes:bytes.toString('base64'),expectedSha256:before?.sha256??null,replace,createParents,sourceGuard};
  const helper=fileURLToPath(new URL('./model_configuration_write.py',import.meta.url));
  const result=spawnSync('/usr/bin/python3',['-I','-B',helper],{input:JSON.stringify(request),encoding:'utf8',
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:10000,maxBuffer:4096,shell:false});
  // A started helper may already have published before timeout/response loss.
  if(result.error||result.signal)need(false,result.error?.code==='ENOENT'?'model_secure_write_unavailable':'model_configuration_write_unknown');
  let response;try{response=JSON.parse(result.stdout);}catch{need(false,'model_configuration_write_unknown');}
  need(response?.ok===true&&result.status===0,response?.ok===false&&/^model_|^invalid_model_|^unsupported_model_/.test(response.code)?response.code:'model_configuration_write_unknown');
}
