// Repeating this projection on resume repairs a crash after the journal append.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,need} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
export function recordReviewAbandonment({specsDir,codeProject,feature,identity,record,logHome,runtime='codex'}){
  const p=record.payload;
  const data={node:'N4',feature,task:identity.taskId,effect_id:p.effectId,
    invocation_id:p.invocationId,registered_digest:p.registeredDigest,
    started_digest:p.startedDigest,record_digest:record.digest,reason:p.reason};
  const args=[writer,'--workflow','cm-ai','--event','review_abandoned','--runtime',runtime,
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,
    '--at',p.at,'--detail','显式放弃无结果的独立审查调用','--data-json',JSON.stringify(data)];
  const result=spawnSync('python3',args,{timeout:10000,maxBuffer:1024*1024,
    ...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});
  need(!result.error&&result.status===0,'review_abandon_log_failed');
  return digest(data);
}
