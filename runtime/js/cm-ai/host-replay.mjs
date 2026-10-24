// Host-run facts for a delivered task. The task's own check commands run in a
// private copy of the project at two extra points: as it was before development
// (baseline) and with only the declared test files delivered (red). The fully
// delivered run is the task's own checks, already run in the real project.
// Facts only: the host never blocks on them. The verification gate and the
// reviewer judge them; the real project is never written here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from './host-check.mjs';
import {need,json,validIdentity} from './effect-contract.mjs';

const FILE_LIMIT=1024*1024,ENTRY_LIMIT=200000,EVIDENCE_LIMIT=1500;
export const HOST_REPLAY_EVIDENCE_PREFIX='cm-host-replay-v1: ';

// Scope file state before development: {bytes,mode}, or null for a file that does
// not exist yet. Anything else (a link, a directory, an oversized file) makes the
// snapshot unavailable, never a partial one.
export function captureBeforeSnapshot(codeProject,scope){
  const files=new Map();
  for(const file of scope){
    const target=path.join(codeProject,file);let stat;
    try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'){files.set(file,null);continue;}return {unavailable:'snapshot_unreadable'};}
    if(!stat.isFile()||stat.size>FILE_LIMIT)return {unavailable:'snapshot_unsupported_file'};
    files.set(file,{bytes:fs.readFileSync(target),mode:stat.mode&0o777});
  }
  return {files};
}

const summarize=rows=>{
  const failed=rows.find(row=>row.outcome!=='passed');
  const evidence=rows.map(row=>`${row.id}: ${row.evidence}`).join('; ');
  return {outcome:failed?failed.outcome:rows.length?'passed':'unavailable',evidence:Buffer.byteLength(evidence)>EVIDENCE_LIMIT
    ?Buffer.from(evidence).subarray(0,EVIDENCE_LIMIT).toString('utf8').replace(/�$/,'')+'…':evidence};
};
const replayError=code=>Object.assign(new Error(code),{code});

// A path inside the project that the copy holds (not .git, not nested specs).
const copied=(codeProject,specsDir,target)=>{
  const inside=dir=>target===dir||target.startsWith(dir+path.sep);
  return inside(codeProject)&&!inside(specsDir)&&!inside(path.join(codeProject,'.git'));
};
// A fresh private copy for each run, so no run inherits another's writes. The
// directory is owned here until it is returned, so a failed copy is removed too.
// A link whose target resolves into the project is re-pointed into the copy, so
// a check reading through it reads the copy's state, never the real project's.
function copyProject(codeProject,specsDir){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-host-replay-')));
  try{
    const target=path.join(root,'project');let entries=0;const links=[];
    const skip=new Set([path.join(codeProject,'.git'),specsDir]);
    // Copy-on-write clones where the file system has them (APFS, btrfs); a plain copy otherwise.
    fs.cpSync(codeProject,target,{recursive:true,mode:fs.constants.COPYFILE_FICLONE,verbatimSymlinks:true,filter:source=>{
      if(skip.has(source))return false;
      if(++entries>ENTRY_LIMIT)throw replayError('replay_project_too_large');
      if(fs.lstatSync(source).isSymbolicLink()){
        const resolved=path.resolve(path.dirname(source),fs.readlinkSync(source));
        if(copied(codeProject,specsDir,resolved))links.push({at:path.relative(codeProject,source),to:path.relative(codeProject,resolved)});
      }
      return true;
    }});
    const project=fs.realpathSync(target);
    for(const link of links){
      const at=path.join(project,link.at);fs.unlinkSync(at);fs.symlinkSync(path.join(project,link.to),at);
    }
    return {root,project};
  }catch(error){removeCopy(root);throw error;}
}
// Command arguments naming a path inside the project name the copy's path instead.
function mapArgument(argument,codeProject,specsDir,project){
  if(argument===codeProject)return project;
  const prefix=codeProject+path.sep;let out='',from=0;
  for(let at=argument.indexOf(prefix);at!==-1;at=argument.indexOf(prefix,from)){
    const rest=argument.slice(at).split(/[\s=,:;'"]/)[0];
    out+=argument.slice(from,at)+(copied(codeProject,specsDir,rest)?project+path.sep:prefix);from=at+prefix.length;
  }
  return out+argument.slice(from);
}
function removeCopy(root){
  try{fs.rmSync(root,{recursive:true,force:true});}
  catch{try{process.stderr.write(JSON.stringify({diagnostic:'host_replay_cleanup_failed',path:root})+'\n');}catch{}}
}
// Writes only through real directories inside the copy: every ancestor and the
// target itself are checked without following links, before any byte is written.
function place(project,file,state){
  let current=project;
  for(const part of file.split('/').slice(0,-1)){
    current=path.join(current,part);let stat;
    try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;fs.mkdirSync(current);continue;}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw replayError('replay_scope_link');
  }
  const target=path.join(project,file);
  let existing=null;
  try{existing=fs.lstatSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing!==null){if(!existing.isFile())throw replayError('replay_scope_link');fs.unlinkSync(target);}
  if(state===null)return;
  const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,state.mode);
  try{fs.writeFileSync(fd,state.bytes);fs.fchmodSync(fd,state.mode);}finally{fs.closeSync(fd);}
}
const currentState=(codeProject,file)=>{
  const target=path.join(codeProject,file);let stat;
  try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.size>FILE_LIMIT)throw replayError('replay_scope_link');
  return {bytes:fs.readFileSync(target),mode:stat.mode&0o777};
};

// {version,status:'replayed',baseline,red,green} or {version,status:'not_replayed',reason,green}.
// red is {skipped:'no_test_files'} when tasks.md declares no test files.
export async function replayDelivery({codeProject,specsDir,snapshot,scope,tests,checkCommands,timeoutMs,identity,greenChecks,signal,makeCheck=createHostCheck}){
  const green=summarize(json(greenChecks));
  const skipped=reason=>notReplayed(reason,greenChecks);
  if(!snapshot)return skipped('no_before_snapshot');
  if(snapshot.unavailable)return skipped(snapshot.unavailable);
  // A path added to the scope after the snapshot has no known prior state.
  if(!scope.every(file=>snapshot.files.has(file)))return skipped('snapshot_scope_changed');
  if(!Array.isArray(checkCommands)||checkCommands.length===0)return skipped('no_host_checks');
  const testFiles=(tests??[]).filter(file=>scope.includes(file));
  const commands=checkCommands.map(({id,command})=>({id,command}));
  // Each run starts from its own copy of the real project and gets its scope states placed.
  const run=async states=>{
    need(!signal?.aborted,'cancelled');
    const copy=copyProject(codeProject,specsDir);
    try{
      for(const file of scope)place(copy.project,file,states(file));
      // The same sandbox as the task's own checks: the copy is the workspace, specs stay read-only.
      const mapped=commands.map(item=>({...item,command:item.command.map(argument=>mapArgument(argument,codeProject,specsDir,copy.project))}));
      return summarize(await makeCheck({cwd:copy.project,commands:mapped,timeoutMs,specsRoot:specsDir})({identity},{signal}));
    }finally{removeCopy(copy.root);}
  };
  try{
    const before=file=>snapshot.files.get(file);
    const baseline=await run(before);
    let red={skipped:'no_test_files'};
    if(testFiles.length){
      const delivered=new Map(testFiles.map(file=>[file,currentState(codeProject,file)]));
      red=await run(file=>delivered.has(file)?delivered.get(file):before(file));
    }
    return {version:1,status:'replayed',baseline,red,green};
  }catch(error){
    if(signal?.aborted)throw error;
    return skipped(error?.code==='replay_project_too_large'?'project_too_large'
      :error?.code==='replay_scope_link'?'scope_link':'replay_failed');
  }
}

// Without a replay: the reason, and the fully delivered run that did happen.
export const notReplayed=(reason,greenChecks)=>({version:1,status:'not_replayed',reason,green:summarize(json(greenChecks))});

// The facts as their own handoff evidence entry, beside the gate's requirement
// entry: a host-observed record, never the developer's report, with its own bound.
export function encodeHostReplayEvidence({identity,facts}){
  validIdentity(identity);
  return HOST_REPLAY_EVIDENCE_PREFIX+JSON.stringify({version:1,identity:{repositoryId:identity.repositoryId,
    runId:identity.runId,taskId:identity.taskId,attempt:identity.attempt},facts:json(facts,16*1024)});
}
