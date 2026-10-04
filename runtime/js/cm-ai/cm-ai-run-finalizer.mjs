// Thin N8 adapter for the JS run_done authority through its platform lock adapter and status file.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';
import {validRunId} from '../../../scripts/cm-log-event.mjs';
import {statusTarget,writeStatusProjection} from './status-projection.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const MiB=1024*1024;

// Existing status file is only the current log projection, not a task store.
export function writeCmAiQaStatus({specsDir,feature,identity,caseId,phase,result}) {
  validIdentity(identity);text(feature);
  need(['case_start','case_complete','case_blocked','complete','configuration_revised'].includes(phase));
  if(phase!=='complete'&&phase!=='configuration_revised')id(caseId);
  if(phase==='complete')need(['PASS','FAIL','BLOCKED'].includes(result?.result),'qa_result_invalid');
  writeStatusProjection({specsDir,feature,identity,node:'N6',claim:['case_start','configuration_revised'].includes(phase),
    ...(phase==='complete'?{allowedNodes:['N3','N5','N6']}:{}),
    ...(phase==='case_complete'||phase==='case_blocked'?{caseId,allowedNodes:['N6']}:{}),
    ...(phase==='case_start'?{caseId}:{}),
    detail:phase==='configuration_revised'?'QA 配置已修订，旧结果仅作历史，等待下一轮':phase==='complete'?`QA 结果 ${result.result}（通过 ${result.passed} / 失败 ${result.failed} / 阻断 ${result.blocked}）`:`QA ${caseId}: ${phase}`,
    state:phase==='configuration_revised'?'qa_pending':phase==='complete'?{PASS:'qa_passed',FAIL:'qa_failed',BLOCKED:'qa_blocked'}[result.result]:'qa_running',
  });
}

function readResult(stdout,identity,specsDir) {
  try {
    const result=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout)),MiB);
    shape(result,['event_id','run_id','project_log','global_log','global_written','pointer_written','deduplicated','degraded']);
    id(result.event_id);need(result.run_id===identity.runId);text(result.project_log);text(result.global_log);
    need(path.resolve(result.project_log)===path.join(fs.realpathSync(specsDir),'运行日志.jsonl'));
    need(typeof result.global_written==='boolean'&&(typeof result.pointer_written==='boolean'||result.pointer_written===null)
      &&typeof result.deduplicated==='boolean'&&typeof result.degraded==='boolean');
    return result;
  } catch {need(false,'run_log_failed');}
}

export function recordCmAiRunDone(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','contextDigest','documentationSyncId'];
  if(input&&Object.hasOwn(input,'logHome'))keys.push('logHome');
  shape(input,keys);text(input.specsDir);text(input.codeProject);text(input.feature);validIdentity(input.identity);
  hex(input.packageDigest);hex(input.contextDigest);id(input.documentationSyncId);
  need(validRunId(input.identity.runId),'invalid_run_id');
  statusTarget(input.specsDir);
  const data={node:'N8',feature:input.feature,task:input.identity.taskId,package_digest:input.packageDigest,
    context_digest:input.contextDigest,documentation_sync_id:input.documentationSyncId};
  const args=[writer,'--workflow','cm-ai','--event','run_done','--runtime','codex',
    '--project-root',input.codeProject,'--specs-dir',input.specsDir,'--run-id',input.identity.runId,
    '--detail','全部任务和文档同步已完成','--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  let result;
  try{result=childProcess.spawnSync('python3',args,options);}
  catch{need(false,'run_log_failed');}
  if(result.error||result.status!==0||result.signal!==null||!Buffer.isBuffer(result.stdout)
    ||result.stdout.length>MiB)need(false,'run_log_failed');
  let receipt;
  try{receipt=readResult(result.stdout,input.identity,input.specsDir);}
  catch{need(false,'run_finalize_unknown');}
  try {
    writeStatusProjection({specsDir:input.specsDir,feature:input.feature,identity:input.identity,node:'N8',
      state:'run_done',detail:'全部任务和文档同步已完成'});
  }catch{need(false,'run_finalize_unknown');}
  return Object.freeze({eventId:receipt.event_id,runId:receipt.run_id,
    deduplicated:receipt.deduplicated,degraded:receipt.degraded});
}
