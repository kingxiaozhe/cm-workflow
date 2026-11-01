// Standing "run to the end" authorization (scripts/cm-autonomy.mjs). It is written
// only from the person's own words and changes two things: a driver stop waits
// waitMinutes instead of paging at once (the session usually carries on), and
// cm-ai admission may approve a change proposal that touches no requirement and
// no user case. Fatal stops page at once through cm-autonomy.mjs notify.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const AUTONOMY_FILE='autonomy.json',AUTONOMY_OFF_FILE='autonomy.off.json',AUTO_REOPEN_LIMIT=2;
// Same directory as notify.json (notify.mjs notifyHome); kept here so notify.mjs can import this module.
export const autonomyHome=(env=process.env)=>path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));

// {on:true,value} only for a regular, well-formed file; anything else is off.
export function readAutonomy(env=process.env){
  const file=path.join(autonomyHome(env),AUTONOMY_FILE);
  let raw;
  try{if(!fs.lstatSync(file).isFile())return {on:false,reason:'invalid'};raw=fs.readFileSync(file,'utf8');}
  catch(error){return {on:false,reason:error.code==='ENOENT'?'missing':'invalid'};}
  try{
    const value=JSON.parse(raw);
    if(value?.version!==1||value.mode!=='until_fatal'||typeof value.response!=='string'||!value.response.trim()||!iso(value.at))
      return {on:false,reason:'invalid'};
    return {on:true,value:{version:1,mode:'until_fatal',response:value.response,at:value.at}};
  }catch{return {on:false,reason:'invalid'};}
}

export function writeAutonomy(response,{env=process.env,now=Date.now()}={}){
  if(typeof response!=='string'||!response.trim()||Array.from(response).length>500)throw new Error('autonomy_response_invalid');
  const home=autonomyHome(env),value={version:1,mode:'until_fatal',response,at:new Date(now).toISOString()};
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const target=path.join(home,AUTONOMY_FILE),temporary=path.join(home,`.${AUTONOMY_FILE}-${randomUUID()}`);
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,target);}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return value;
}

// Turning it off keeps the record (renamed) so the last grant stays auditable.
export function clearAutonomy({env=process.env}={}){
  const home=autonomyHome(env);
  try{fs.renameSync(path.join(home,AUTONOMY_FILE),path.join(home,AUTONOMY_OFF_FILE));return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}

// Whether a saved change proposal may be approved under the standing authorization:
// it may change design, tasks and generated cases, never a requirement, a feature
// list or a user case. Returns null when it may, else the reason in plain words.
export function standingChangeProblem(archive,digest){
  const before=archive?.before,proposal=archive?.proposal;
  if(!before||!proposal||proposal.proposalDigest!==digest||typeof proposal.files!=='object'||typeof before.files!=='object')
    return '找不到这份提案的归档';
  if(!Array.isArray(proposal.changedUserCases)||proposal.changedUserCases.length)return '提案删除或减弱了用户用例';
  if(!Array.isArray(proposal.removed)||proposal.removed.length)return '提案删除了功能';
  for(const file of Object.keys(proposal.files)){
    if(!Array.isArray(before.directories)||!before.directories.includes(file.split('/')[0]))return '提案新增了功能';
    if(file.endsWith('/requirements.md')&&proposal.files[file]!==before.files[file])return '提案改了需求';
  }
  return null;
}
