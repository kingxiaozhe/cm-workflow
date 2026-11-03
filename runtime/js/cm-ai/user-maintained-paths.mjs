// A code project may declare files its user maintains by hand, outside any task
// (AI潮: Baseline/glass-verdicts.json, edited only by the user). Only the plain
// completed-run delivery chain tolerates their differences, like the root CM
// config; QA-fix chains and integration acceptance stay strict. Exact relative
// files only, under the review inventory's own path contract: no directories,
// globs, agent instructions, CM config or this declaration itself, compared
// case-insensitively. A malformed declaration tolerates nothing and fails closed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseModelJson} from './model-configuration-file.mjs';
import {CONFIG_FILENAMES} from '../../../scripts/cm-workflow-config.mjs';

export const USER_MAINTAINED_FILE='.cm-user-maintained.json';
const MAX_BYTES=16*1024,MAX_PATHS=64,MAX_PATH=512;
const INSTRUCTIONS=new Set(['agents.md','claude.md']);
const RESERVED=new Set([...CONFIG_FILENAMES,USER_MAINTAINED_FILE].map(name=>name.toLowerCase()));
const SECRET_SEGMENTS=new Set(['.git','.ssh','.aws','.gnupg']);

export function userMaintainedInvalid(detail){
  return Object.assign(new Error(`user_maintained_invalid: ${detail}`),{code:'user_maintained_invalid',detail});
}
// review-package.mjs filePath, plus the declaration's own refusals.
function readPath(root,value){
  if(typeof value!=='string'||value.length===0||value.length>MAX_PATH||/[\\:*?[\]{}\x00-\x1f\x7f-\x9f]/.test(value)
    ||value.startsWith('/')||value.normalize('NFC')!==value)
    throw userMaintainedInvalid('路径必须是代码根下的相对文件路径（NFC，无控制字符、反斜杠、冒号或通配符）');
  const parts=value.split('/');
  if(parts.some(part=>part===''||part==='.'||part==='..'))throw userMaintainedInvalid(`路径不规范：${value}`);
  if(parts.some(part=>SECRET_SEGMENTS.has(part.toLowerCase())||/^\.env(?:\.|$)/i.test(part))
    ||INSTRUCTIONS.has(parts.at(-1).toLowerCase())||RESERVED.has(value.toLowerCase()))
    throw userMaintainedInvalid(`不能声明：${value}`);
  let stat=null;
  try{stat=fs.lstatSync(path.join(root,value));}catch(error){if(error.code!=='ENOENT')throw userMaintainedInvalid(`无法检查：${value}`);}
  if(stat&&!stat.isFile())throw userMaintainedInvalid(`只能声明普通文件：${value}`);
  return value;
}

// {paths, sha256}: the declared paths and the exact declaration bytes' digest
// (null when the code root has no declaration). The caller binds sha256 to the
// inventory it compares, so a declaration replaced mid-check is refused.
export function readUserMaintainedPaths(root){
  const file=path.join(root,USER_MAINTAINED_FILE);
  let before;
  try{before=fs.lstatSync(file);}
  catch(error){if(error.code==='ENOENT')return {paths:[],sha256:null};throw userMaintainedInvalid('无法读取');}
  if(!before.isFile()||before.nlink!==1||before.size>MAX_BYTES)throw userMaintainedInvalid('必须是普通单链接文件且不超过 16 KiB');
  let bytes;
  try{
    const descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      bytes=fs.readFileSync(descriptor);const after=fs.fstatSync(descriptor);
      if(!['dev','ino','size','mtimeMs','ctimeMs'].every(key=>after[key]===before[key])||bytes.length!==before.size)
        throw userMaintainedInvalid('读取期间被修改');
    }finally{fs.closeSync(descriptor);}
  }catch(error){throw error.code==='user_maintained_invalid'?error:userMaintainedInvalid('无法读取');}
  let value;
  try{value=parseModelJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw userMaintainedInvalid('不是严格的 UTF-8 JSON（含重复键）');}
  if(value===null||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).sort().join(',')!=='paths,version'||value.version!==1)
    throw userMaintainedInvalid('格式必须是 {"version":1,"paths":[...]}');
  if(!Array.isArray(value.paths)||value.paths.length===0||value.paths.length>MAX_PATHS)
    throw userMaintainedInvalid(`paths 必须有 1 到 ${MAX_PATHS} 项`);
  const paths=value.paths.map(item=>readPath(root,item));
  if(new Set(paths.map(item=>item.toLowerCase())).size!==paths.length)throw userMaintainedInvalid('paths 有重复项（不区分大小写）');
  return {paths,sha256:createHash('sha256').update(bytes).digest('hex')};
}
