// Q13/Q26: a QA command resource recorded cleanup_failed (whole-round timeout,
// cancel, or a cleanup the checker could not confirm) keeps the run open: the
// log writer refuses abandonment, timed-out supersession, run_done and the
// batch handoff while it is unclosed. The host may close it only with proof:
// the cleanup_failed row names the command's process group (pid and start
// time, written by current executors) and that group is gone now. The released
// row carries the proof; rows without a recorded pid, or a group that is alive
// or cannot be checked (Windows, permission, unreadable start time), stay open.
// QA browser cases hold no resource rows: their device or browser state is the
// session's own report (cleanup), so there is no device lock to release here.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scanRows} from './log-rows.mjs';
import {inspectWorkerGroup,validWorkerPid,validStartTime} from './worker-process-identity.mjs';
import {need} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));

export function inspectOpenQaResources({specsDir,runId}){
  const last=new Map();
  scanRows(path.join(specsDir,'运行日志.jsonl'),row=>{
    if(row?.workflow==='cm-ai'&&row.event==='resource'&&row.run_id===runId&&typeof row.resource_id==='string')
      last.set(row.resource_id,row);
  });
  return [...last.values()].filter(row=>['acquired','cleanup_failed'].includes(row.phase));
}

export function releaseVerifiedQaResources({specsDir,codeProject,runId,runtime='codex',logHome=null,inspect=inspectWorkerGroup}){
  const released=[],open=[];
  for(const row of inspectOpenQaResources({specsDir,runId})){
    const proof=row.phase==='cleanup_failed'&&row.resource_kind==='qa_command'&&validWorkerPid(row.pid)
      &&validStartTime(row.process_start_time??null)?inspect({pid:row.pid,startTime:row.process_start_time??null}):null;
    if(proof!=='gone'){open.push({resourceId:row.resource_id,phase:row.phase,verdict:proof??'unrecorded'});continue;}
    const data={...(row.node?{node:row.node}:{}),...(row.feature?{feature:row.feature}:{}),...(row.task?{task:row.task}:{}),
      resource_id:row.resource_id,resource_kind:row.resource_kind,released_by:'host_verified',
      verification:'process_group_gone',pid:row.pid,process_start_time:row.process_start_time??null};
    const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event','resource','--phase','released',
      '--runtime',runtime,'--project-root',codeProject,'--specs-dir',specsDir,'--run-id',runId,
      '--detail','宿主核对 QA 命令进程组已退出，补记资源释放','--data-json',JSON.stringify(data)],
    {timeout:10000,maxBuffer:1024*1024,...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});
    need(!result.error&&result.status===0,'qa_resource_release_failed');
    released.push(row.resource_id);
  }
  return {released,open};
}
