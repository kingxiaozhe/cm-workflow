// One explicit request per external provider; the host session is client-owned.
import os from 'node:os';
import path from 'node:path';
import {json,need,shape} from './effect-contract.mjs';
import {readModelJsonRecord,writeModelJson} from './model-configuration-file.mjs';

export const EXTERNAL_MODEL_SCHEMA=1;
export const EXTERNAL_EFFORTS=Object.freeze({
  codex:Object.freeze(['none','minimal','low','medium','high','xhigh']),
  claude:Object.freeze(['low','medium','high','xhigh','max']),
});
export function externalEffort(provider,effort=undefined){
  need(Object.hasOwn(EXTERNAL_EFFORTS,provider),'invalid_external_provider');
  const value=effort===undefined?(provider==='codex'?'high':null):effort;
  need(provider==='claude'&&value===null||EXTERNAL_EFFORTS[provider].includes(value),'unsupported_external_effort');
  return value;
}
export function externalPair(provider,raw){
  const value=json(raw);shape(value,['model',...(Object.hasOwn(value,'effort')?['effort']:[])]);
  need(typeof value.model==='string'&&value.model.length<=128&&/^[a-zA-Z0-9._-]+$/.test(value.model)
    &&value.model!=='current-session','external_model_required');
  return {model:value.model,effort:externalEffort(provider,value.effort)};
}
export function readExternalModels(raw){
  const value=json(raw,64*1024);shape(value,['schemaVersion','providers']);
  need(value.schemaVersion===EXTERNAL_MODEL_SCHEMA,'external_schema_unsupported');
  shape(value.providers,Object.keys(value.providers));
  return {schemaVersion:EXTERNAL_MODEL_SCHEMA,providers:Object.fromEntries(Object.entries(value.providers)
    .map(([provider,pair])=>[provider,externalPair(provider,pair)]))};
}
export const externalModelsPath=()=>path.join(path.resolve(process.env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow')),'external-models-v1.json');
export function loadExternalModels(file=externalModelsPath()){
  try{return readExternalModels(readModelJsonRecord(file).value);}
  catch(error){if(error.code==='ENOENT')throw Object.assign(new Error('external_model_setup_required'),{code:'external_model_setup_required'});throw error;}
}
export function selectExternalModels(raw,providers){
  const value=readExternalModels(raw);
  return {schemaVersion:EXTERNAL_MODEL_SCHEMA,providers:Object.fromEntries([...new Set(providers)].map(provider=>{
    need(Object.hasOwn(value.providers,provider),'external_model_setup_required');return [provider,value.providers[provider]];
  }))};
}
export function externalSettingsRecord(file=externalModelsPath()){
  try{return readModelJsonRecord(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function saveExternalModels(value,{file=externalModelsPath(),expectedSha256,sourceGuard=null}={}){
  writeModelJson(file,readExternalModels(value),{expectedSha256,sourceGuard,createParents:true});
}
// This is a requested tuple and adapter capability, never provider confirmation.
export function describeExternalModels(raw){
  return {host:'current-session (controlled by client)',external:readExternalModels(raw),
    capabilityEvidence:'adapter argument contract',effectiveModel:'unknown',providerConfirmed:false};
}
