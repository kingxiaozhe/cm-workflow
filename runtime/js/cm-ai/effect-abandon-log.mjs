// Repeating this projection on resume repairs a crash after the journal append.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,need} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
export function recordEffectAbandonment({specsDir,codeProject,feature,identity,record,logHome,runtime='codex'}){
  const p=record.payload;
  const data={node:p.effectKind==='complete'?'N5':p.effectKind==='review'?'N4':'N3',feature,task:identity.taskId,
    effect_id:p.effectId,effect_kind:p.effectKind,intent_digest:p.intentDigest,
    record_digest:record.digest,reason:p.reason};
  const args=[writer,'--workflow','cm-ai','--event','effect_abandoned','--runtime',runtime,
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,
    '--at',p.at,'--detail','显式放弃中断且无检查点的任务 effect','--data-json',JSON.stringify(data)];
  const result=spawnSync('python3',args,{timeout:10000,maxBuffer:1024*1024,
    ...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});
  need(!result.error&&result.status===0,'effect_abandon_log_failed');
  return digest(data);
}
