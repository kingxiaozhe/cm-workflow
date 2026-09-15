// Actual before/after image/video carriers, using the existing qa_browser host.
// The host owns visual judgement; hashes bind the observed files, never a fake command.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,json,need,shape,text,validCallTimeout} from '../cm-ai/effect-contract.mjs';

export const isVisual=config=>config?.kind==='visual';
export function visualConfiguration(config){
  shape(config,['kind','cwd','timeoutMs','before','reason','environment','steps','expected',...(Object.hasOwn(config,'testFiles')?['testFiles']:[])]);
  need(isVisual(config),'fix_visual_configuration_required');text(config.reason);validCallTimeout(config.timeoutMs);
  need(path.isAbsolute(config.cwd)&&fs.realpathSync(config.cwd)===config.cwd,'unsupported_path');
  if(config.testFiles)need(Array.isArray(config.testFiles)&&config.testFiles.length===0,'fix_visual_test_files_invalid');
  shape(config.environment,['scope','kind','carrier','target']);
  need(['local','test'].includes(config.environment.scope)&&({web:['browser'],app:['ios-simulator','android-emulator','device'],
    miniprogram:['wechat-devtools','device']})[config.environment.kind]?.includes(config.environment.carrier),'fix_visual_environment_required');text(config.environment.target);
  for(const list of [config.steps,config.expected]){need(Array.isArray(list)&&list.length>0&&list.length<=32,'fix_visual_steps_required');list.forEach(text);}
  need(config.expected.every(value=>!value.includes('[需确认]')),'fix_visual_expectation_unconfirmed');
  inspectVisualCarrier(config.before);return config;
}
export function inspectVisualCarrier(raw){
  shape(raw,['path','sha256','kind','description']);text(raw.description);
  need(path.isAbsolute(raw.path)&&path.resolve(raw.path)===raw.path
    &&/^[a-f0-9]{64}$/.test(raw.sha256)&&['screenshot','video'].includes(raw.kind),'fix_visual_carrier_invalid');
  return raw;
}
export function verifyVisualCarrier(raw){
  inspectVisualCarrier(raw);const stat=fs.lstatSync(raw.path);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&fs.realpathSync(raw.path)===raw.path
    &&stat.size>0&&stat.size<=16*1024*1024,'fix_visual_carrier_invalid');
  const bytes=fs.readFileSync(raw.path);
  const image=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    ||bytes[0]===255&&bytes[1]===216&&bytes[2]===255
    ||['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())
    ||bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  const video=bytes.subarray(4,8).toString()==='ftyp'||bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  need(raw.kind==='screenshot'?image:video,'fix_visual_carrier_invalid');
  need(createHash('sha256').update(bytes).digest('hex')===raw.sha256,'fix_visual_carrier_changed');return json(raw);
}
export function inspectVisualBefore(raw,config){
  visualConfiguration(config);shape(raw,['kind','phase','carrier','environment','reason']);
  need(raw.kind==='visual'&&raw.phase==='before'&&digest(raw.carrier)===digest(config.before)
    &&digest(raw.environment)===digest(config.environment)&&raw.reason===config.reason,'fix_visual_evidence_mismatch');return json(raw);
}
export const visualBefore=config=>{visualConfiguration(config);verifyVisualCarrier(config.before);
  return {kind:'visual',phase:'before',carrier:config.before,environment:config.environment,reason:config.reason};};
export function inspectVisualAfter(raw,config){
  shape(raw,['kind','phase','before','after','environment','verdict','cleanup','explanation']);
  need(raw.kind==='visual'&&raw.phase==='after'&&digest(raw.before)===digest(config.before)
    &&digest(raw.environment)===digest(config.environment)&&['PASS','FAIL','BLOCKED'].includes(raw.verdict)
    &&['completed','not_needed','failed'].includes(raw.cleanup),'fix_visual_evidence_mismatch');text(raw.explanation);
  if(raw.verdict!=='BLOCKED'){
    inspectVisualCarrier(raw.after);need(raw.after.path!==raw.before.path
      &&raw.cleanup!=='failed','fix_visual_evidence_mismatch');
  }else need(raw.after===null,'fix_visual_evidence_mismatch');return json(raw);
}
export async function observeVisualAfter(config,{bridge,signal,identity,specsRoot}){
  verifyVisualCarrier(config.before);need(bridge&&typeof bridge.call==='function','fix_visual_host_required');
  const controller=new AbortController();let rejectWait;
  const interrupted=new Promise((resolve,reject)=>{rejectWait=reject;});interrupted.catch(()=>{});
  const cancel=()=>{controller.abort();rejectWait(Object.assign(Error('cancelled'),{code:'cancelled'}));};
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  const timer=setTimeout(()=>{controller.abort();rejectWait(Object.assign(Error('fix_visual_timeout'),{code:'fix_visual_timeout'}));},config.timeoutMs);
  try{
  const result=json(await Promise.race([interrupted,Promise.resolve().then(()=>{need(!controller.signal.aborted,'cancelled');return bridge.call('qa_browser',{identity,environment:config.environment,steps:config.steps,expected:config.expected,
    before:config.before,evidenceRoot:path.join(specsRoot,'.reviews'),instructions:'Inspect the actual repaired visual behavior with current-host authorized browser/device tools (Codex web: built-in browser only). Return {verdict:PASS|FAIL|BLOCKED,after:{path,sha256,kind:screenshot|video,description}|null,environment,cleanup:completed|not_needed|failed,explanation}. Save the new actual screenshot/video inside evidenceRoot. No commands, installs, provider, production, source writes or Git. Missing carrier or failed cleanup means BLOCKED with after:null. Compare against the original before carrier; no static or synthetic PASS.'},controller.signal);})]));
  need(!signal.aborted,'cancelled');shape(result,['verdict','after','environment','cleanup','explanation']);
  const observed=inspectVisualAfter({kind:'visual',phase:'after',before:config.before,...result},config);
  if(observed.after){const root=path.join(specsRoot,'.reviews');need(observed.after.path.startsWith(root+path.sep),'fix_visual_carrier_invalid');verifyVisualCarrier(observed.after);}
  verifyVisualCarrier(config.before);return observed;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.abort();}
}
