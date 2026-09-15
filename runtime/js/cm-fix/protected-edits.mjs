// Fixed text-file edits for the existing fix invocation, not a new task engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {validateDeveloperScope} from '../cm-ai/developer-adapter.mjs';
import {json,need,shape} from '../cm-ai/effect-contract.mjs';

function snapshot(cwd,file){
  let cursor=cwd;
  for(const part of file.split('/')){
    cursor=path.join(cursor,part);
    try{need(!fs.lstatSync(cursor).isSymbolicLink(),'unsupported_path');}
    catch(error){if(error.code==='ENOENT')break;throw error;}
  }
  const target=path.join(cwd,file);
  try{
    const stat=fs.lstatSync(target);need(stat.isFile()&&stat.nlink===1&&stat.size<=1024*1024,'protected_edit_invalid');
    return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export function applyProtectedEdits({cwd,scope,edits}){
  validateDeveloperScope(scope);need(fs.realpathSync(cwd)===cwd,'unsupported_path');
  need(Array.isArray(edits)&&edits.length>0&&edits.length<=scope.length,'protected_edit_invalid');
  const seen=new Set();
  for(const edit of edits){
    shape(edit,['path','beforeSha256','content']);
    need(scope.includes(edit.path)&&!seen.has(edit.path),'out_of_scope');seen.add(edit.path);
    need(edit.content===null||typeof edit.content==='string','protected_edit_invalid');
    need(edit.content===null||Buffer.byteLength(edit.content)<=1024*1024,'limit_exceeded');
    need(edit.beforeSha256===snapshot(cwd,edit.path),'protected_edit_stale');
    need(edit.content!==null||edit.beforeSha256!==null,'protected_edit_invalid');
  }
  for(const edit of edits){
    need(edit.beforeSha256===snapshot(cwd,edit.path),'protected_edit_stale');
    const target=path.join(cwd,edit.path);
    if(edit.content===null)fs.unlinkSync(target);
    else{
      fs.mkdirSync(path.dirname(target),{recursive:true});
      // O_NOFOLLOW avoids silently replacing a last-moment link target.
      const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,edit.content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
  }
}

export function captureProtectedEdits(cwd,scope){
  validateDeveloperScope(scope);
  return Object.fromEntries(scope.map(file=>[file,snapshot(cwd,file)]));
}

export async function commitProtectedEdits({cwd,specsRoot,scope,edits,expected,identity,timeoutMs,signal}){
  need(Array.isArray(edits),'protected_edit_invalid');
  for(const edit of edits)need(Object.hasOwn(expected,edit.path)&&edit.beforeSha256===expected[edit.path],'protected_edit_stale');
  need(!signal.aborted,'cancelled');
  if(edits.length===0)return;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-edits-')),file=path.join(dir,'edits.json');
  try{
    fs.writeFileSync(file,JSON.stringify({cwd,scope,edits}),{mode:0o600,flag:'wx'});
    const check=createHostCheck({cwd,specsRoot,timeoutMs,commands:[{id:'protected-edits',
      command:[process.execPath,fileURLToPath(import.meta.url),file]}]});
    const [observed]=await check({identity},{signal});
    need(observed.outcome==='passed','protected_edit_failed');
  }finally{if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);}
}

export function protectedFixBridge({bridge,cwd,specsRoot,timeoutMs}){
  return {async call(kind,payload,signal){
    need(!signal.aborted,'cancelled');
    if(!['fix_test_author','fix_repair'].includes(kind))return bridge.call(kind,payload,signal);
    need(payload.codeProject===cwd,'execution_root_mismatch');validateDeveloperScope(payload.scope);
    const expected=captureProtectedEdits(cwd,payload.scope);
    const result=json(await bridge.call(kind,{...payload,
      instructions:payload.instructions+' Protected mode: do not write files. Return {outcome,edits:[{path,beforeSha256,content}]}; '
        +'content is complete UTF-8 replacement text, null deletes an existing file. Use only supplied scope and exact expected hashes. '
        +'Return blocked with edits:[] when unavailable. The fixed sandbox applies edits; do not run commands.',
      editMode:'protected-text-v1',expected},signal));
    shape(result,['outcome','edits']);
    need(['blocked',kind==='fix_repair'?'repaired':'authored'].includes(result.outcome),'protected_edit_invalid');
    need(Array.isArray(result.edits),'protected_edit_invalid');
    if(result.outcome==='blocked'){need(result.edits.length===0,'protected_edit_invalid');return {outcome:'blocked'};}
    need(result.edits.length>0,'protected_edit_invalid');
    await commitProtectedEdits({cwd,specsRoot,scope:payload.scope,edits:result.edits,expected,
      identity:payload.identity,timeoutMs,signal});
    return {outcome:result.outcome};
  }};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{applyProtectedEdits(json(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));}
  catch{process.exitCode=1;}
}
