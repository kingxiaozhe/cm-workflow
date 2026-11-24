// Fixed text-file edits for the existing fix invocation, not a new task engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {validateDeveloperScope} from '../cm-ai/developer-adapter.mjs';
import {json,need,shape} from '../cm-ai/effect-contract.mjs';
import {assertDisjointEditPaths,assertRealParents,lstatOrMissing,readSymlinkRecord,resolveSymlinkTarget,validateProtectedEdit} from '../cm-ai/symlink-material.mjs';

function snapshot(cwd,file,allowSymlinks){
  assertRealParents(cwd,file);
  const target=path.join(cwd,file),stat=lstatOrMissing(target);
  if(stat===null)return null;
  if(stat.isSymbolicLink()){
    need(allowSymlinks,'unsupported_path');
    return readSymlinkRecord(cwd,file);
  }
  need(stat.isFile()&&stat.nlink===1&&stat.size<=1024*1024,'protected_edit_invalid');
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const opened=fs.fstatSync(fd);
    need(stat.dev===opened.dev&&stat.ino===opened.ino&&opened.nlink===1,'protected_edit_stale');
    return {type:'file',sha256:createHash('sha256').update(fs.readFileSync(fd)).digest('hex')};
  }finally{fs.closeSync(fd);}
}

// Optional mode sets the permission bits of a written file (never of a deletion).
const EDIT_MODES=new Map([['0644',0o644],['0755',0o755]]);
export function checkProtectedEdits({cwd,scope,edits,allowSymlinks=false,specsRoot=null}){
  validateDeveloperScope(scope);need(fs.realpathSync(cwd)===cwd,'unsupported_path');
  need(Array.isArray(edits)&&edits.length>0&&edits.length<=scope.length,'protected_edit_invalid');
  const seen=new Set(),removed=new Set(edits.filter(edit=>edit.content===null||Object.hasOwn(edit,'symlink')).map(edit=>edit.path));
  const check=edit=>{
    const before=snapshot(cwd,edit.path,allowSymlinks),link=Object.hasOwn(edit,'symlink');
    need(before?.type!=='symlink'||link||edit.content===null,'unsupported_path');
    need(edit.beforeSha256===(before?.sha256??null),'protected_edit_stale');
    if(link)resolveSymlinkTarget(cwd,edit.path,edit.symlink,{specsRoot,
      stat:file=>removed.has(file)?null:lstatOrMissing(path.join(cwd,file))});
  };
  for(const edit of edits){
    validateProtectedEdit(edit,allowSymlinks);
    need(scope.includes(edit.path)&&!seen.has(edit.path),'out_of_scope');seen.add(edit.path);
    check(edit);
  }
  if(allowSymlinks)assertDisjointEditPaths([...seen]);
  return check;
}

export function applyProtectedEdits(options){
  const {cwd,edits}=options,check=checkProtectedEdits(options);
  for(const edit of edits){
    check(edit);
    const target=path.join(cwd,edit.path);
    if(edit.content===null){fs.unlinkSync(target);continue;}
    fs.mkdirSync(path.dirname(target),{recursive:true});
    check(edit);
    if(Object.hasOwn(edit,'symlink')){
      if(edit.beforeSha256===null){fs.symlinkSync(edit.symlink,target);continue;}
      const temporary=path.join(path.dirname(target),'.cm-link-'+randomUUID());
      fs.symlinkSync(edit.symlink,temporary);
      try{check(edit);fs.renameSync(temporary,target);}
      finally{if(lstatOrMissing(temporary))fs.unlinkSync(temporary);}
      continue;
    }
    const created=edit.beforeSha256===null;
    const flags=fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW
      |(created?fs.constants.O_CREAT|fs.constants.O_EXCL:fs.constants.O_TRUNC);
    const fd=fs.openSync(target,flags,0o644);
    try{
      fs.writeFileSync(fd,edit.content);
      if(created||Object.hasOwn(edit,'mode'))fs.fchmodSync(fd,EDIT_MODES.get(edit.mode)??0o644);
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
  }
}

export function captureProtectedEdits(cwd,scope,{allowSymlinks=false}={}){
  validateDeveloperScope(scope);
  return Object.fromEntries(scope.map(file=>[file,snapshot(cwd,file,allowSymlinks)?.sha256??null]));
}

// onApply (cm-ai protected development) journals the applying subprocess:
// apply_spawning before the spawn, apply_started with its pid right after. A
// journal failure kills the new group and fails the apply.
export async function commitProtectedEdits({cwd,specsRoot,scope,edits,expected,identity,timeoutMs,signal,onApply=null,allowSymlinks=false}){
  need(Array.isArray(edits),'protected_edit_invalid');
  for(const edit of edits)need(Object.hasOwn(expected,edit.path)&&edit.beforeSha256===expected[edit.path],'protected_edit_stale');
  need(!signal.aborted,'cancelled');
  if(edits.length===0)return;
  if(allowSymlinks)checkProtectedEdits({cwd,scope,edits,allowSymlinks,specsRoot});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-edits-')),file=path.join(dir,'edits.json');
  try{
    fs.writeFileSync(file,JSON.stringify({cwd,scope,edits,allowSymlinks,specsRoot}),{mode:0o600,flag:'wx'});
    let journalFailed=false;
    onApply?.({phase:'apply_spawning'});
    const check=createHostCheck({cwd,specsRoot,timeoutMs,commands:[{id:'protected-edits',
      command:[process.execPath,fileURLToPath(import.meta.url),file]}],
      ...(onApply?{onSpawn:({pid})=>{try{onApply({phase:'apply_started',pid});}
        catch{journalFailed=true;try{process.kill(-pid,'SIGKILL');}catch{}}}}:{})});
    const [observed]=await check({identity},{signal});
    need(!journalFailed&&observed.outcome==='passed','protected_edit_failed');
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
    // cm-fix keeps its original text-only proposal shape; mode is a cm-ai develop field.
    for(const edit of result.edits)shape(edit,['path','beforeSha256','content']);
    if(result.outcome==='blocked'){need(result.edits.length===0,'protected_edit_invalid');return {outcome:'blocked'};}
    need(result.edits.length>0||kind==='fix_repair'&&payload.allowUnchanged===true,'protected_edit_invalid');
    await commitProtectedEdits({cwd,specsRoot,scope:payload.scope,edits:result.edits,expected,
      identity:payload.identity,timeoutMs,signal});
    return {outcome:result.outcome};
  }};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{applyProtectedEdits(json(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))));}
  catch{process.exitCode=1;}
}
