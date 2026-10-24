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
import {need,json} from './effect-contract.mjs';

const FILE_LIMIT=1024*1024,ENTRY_LIMIT=200000,EVIDENCE_LIMIT=1500;

// Scope file bytes before development: Buffer, or null for a file that does not
// exist yet. Anything else (a link, a directory, an oversized file) makes the
// snapshot unavailable, never a partial one.
export function captureBeforeSnapshot(codeProject,scope){
  const files=new Map();
  for(const file of scope){
    const target=path.join(codeProject,file);let stat;
    try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'){files.set(file,null);continue;}return {unavailable:'snapshot_unreadable'};}
    if(!stat.isFile()||stat.size>FILE_LIMIT)return {unavailable:'snapshot_unsupported_file'};
    files.set(file,fs.readFileSync(target));
  }
  return {files};
}

const summarize=rows=>{
  const failed=rows.find(row=>row.outcome!=='passed');
  const evidence=rows.map(row=>`${row.id}: ${row.evidence}`).join('; ');
  return {outcome:failed?failed.outcome:'passed',evidence:Buffer.byteLength(evidence)>EVIDENCE_LIMIT
    ?Buffer.from(evidence).subarray(0,EVIDENCE_LIMIT).toString('utf8').replace(/�$/,'')+'…':evidence};
};

function copyProject(codeProject,specsDir){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-host-replay-')));
  const target=path.join(root,'project');let entries=0;
  const skip=new Set([path.join(codeProject,'.git'),specsDir]);
  // Copy-on-write clones where the file system has them (APFS, btrfs); a plain copy otherwise.
  fs.cpSync(codeProject,target,{recursive:true,mode:fs.constants.COPYFILE_FICLONE,verbatimSymlinks:true,filter:source=>{
    if(skip.has(source))return false;
    need(++entries<=ENTRY_LIMIT,'replay_project_too_large');return true;
  }});
  return {root,project:fs.realpathSync(target)};
}
function place(project,file,bytes){
  const target=path.join(project,file);
  if(bytes===null){fs.rmSync(target,{force:true});return;}
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
}

// {version,status:'replayed',baseline,red,green} or {version,status:'not_replayed',reason,green}.
// red is {skipped:'no_test_files'} when tasks.md declares no test files.
export async function replayDelivery({codeProject,specsDir,snapshot,scope,tests,checkCommands,timeoutMs,identity,greenChecks,signal,makeCheck=createHostCheck}){
  const green=summarize(json(greenChecks));
  const skipped=reason=>notReplayed(reason,greenChecks);
  if(!snapshot)return skipped('no_before_snapshot');
  if(snapshot.unavailable)return skipped(snapshot.unavailable);
  if(!Array.isArray(checkCommands)||checkCommands.length===0)return skipped('no_host_checks');
  const testFiles=(tests??[]).filter(file=>scope.includes(file));
  const commands=checkCommands.map(({id,command})=>({id,command}));
  let copy=null;
  try{
    copy=copyProject(codeProject,specsDir);
    // The same sandbox as the task's own checks: the copy is the workspace, specs stay read-only.
    const run=async()=>summarize(await makeCheck({cwd:copy.project,commands,timeoutMs,specsRoot:specsDir})({identity},{signal}));
    for(const file of scope)place(copy.project,file,snapshot.files.has(file)?snapshot.files.get(file):null);
    const baseline=await run();
    let red={skipped:'no_test_files'};
    if(testFiles.length){
      for(const file of testFiles){
        const target=path.join(codeProject,file);
        place(copy.project,file,fs.existsSync(target)?fs.readFileSync(target):null);
      }
      red=await run();
    }
    return {version:1,status:'replayed',baseline,red,green};
  }catch(error){
    if(signal?.aborted)throw error;
    return skipped(error?.code==='replay_project_too_large'?'project_too_large':'replay_failed');
  }finally{if(copy)fs.rmSync(copy.root,{recursive:true,force:true});}
}

// Without a replay: the reason, and the fully delivered run that did happen.
export const notReplayed=(reason,greenChecks)=>({version:1,status:'not_replayed',reason,green:summarize(json(greenChecks))});

// The facts as one gate item the handoff carries: a host-observed record, never
// a judgement, so it is "satisfied" as a record. One item keeps the gate's
// 64-item bound for the developer's own report.
export function replayFactItem(facts){
  const line=run=>`${run.outcome}; ${run.evidence}`;
  const lines=facts.status!=='replayed'?[`未实跑：${facts.reason}`,`全部放入（任务检查）：${line(facts.green)}`]
    :[`改代码前（基线）：${line(facts.baseline)}`,
      `只放入测试文件：${facts.red.skipped?'跳过（tasks.md 未写测试文件）':line(facts.red)}`,
      `全部放入（任务检查）：${line(facts.green)}`];
  let evidence=lines.join('\n');
  if(Buffer.byteLength(evidence)>2000)evidence=Buffer.from(evidence).subarray(0,1996).toString('utf8').replace(/\uFFFD$/,'')+'…';
  return {requirement:'宿主实跑记录（宿主核实的事实，不是开发自报）',satisfied:true,evidence};
}
