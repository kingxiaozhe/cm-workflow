// Event-based operator feedback. Failure here never changes a runner verdict.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {need} from './effect-contract.mjs';
import {readStatusProjection,writeStatusProjection} from './status-projection.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const phases={developing:['N3','正在开发'],checking:['N3','正在执行检查'],
  verifying:['N3','正在核对交付要求'],review_starting:['N4','正在启动独立审查'],reviewing:['N4','正在独立审查']};
const diagnostic=()=>{try{process.stderr.write('{"diagnostic":"progress_projection_failed"}\n');}catch{}};
function logProgress({definition,identity,runtime,operationId,stage,phase,outcome}){
  const [node,detail]=phases[stage];
  const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event','progress','--phase',phase,
    '--runtime',runtime,'--project-root',definition.codeProject,'--specs-dir',definition.specsDir,
    '--run-id',identity.runId,'--detail',detail+(phase==='complete'?'：调用已结束':''),'--data-json',JSON.stringify({node,
      feature:definition.feature,task:identity.taskId,attempt:identity.attempt,operation_id:operationId,
      phase_name:stage,...(outcome?{outcome}:{})})],
  {timeout:10000,maxBuffer:64*1024,env:{...process.env,
    CM_WORKFLOW_LOG_HOME:path.join(definition.specsDir,'.reviews','host-log-mirror')}});
  need(!result.error&&result.status===0&&result.signal===null,'progress_log_failed');
}
export function startHostProgress({definition,identity,runtime='codex',stage,signal}){
  need(phases[stage]&&!signal.aborted,'cancelled');
  const operationId=randomUUID();let token=null,closed=false,observedReview=false;
  const record=(phase,outcome)=>{
    try{logProgress({definition,identity,runtime,operationId,stage,phase,outcome});}catch{diagnostic();}
  };
  const project=(selected,claim)=>{
    try{
      const receipt=writeStatusProjection({specsDir:definition.specsDir,feature:definition.feature,identity,
        node:phases[selected][0],state:selected,detail:phases[selected][1],claim,expectedToken:claim?null:token});
      token=receipt.written?receipt.token:null;
    }catch{token=null;diagnostic();}
  };
  record('start');project(stage,true);
  return Object.freeze({
    reviewStarted(){
      if(closed||signal.aborted||observedReview)return;observedReview=true;
      if(token!==null)project('reviewing',false);
    },
    complete(outcome){
      if(closed)return;closed=true;
      record('complete',signal.aborted?'aborted':outcome);
    },
  });
}
export async function withHostProgress(options,run){
  const progress=startHostProgress(options);
  try{const result=await run(progress);progress.complete('returned');return result;}
  catch(error){progress.complete('failed');throw error;}
}

const states={awaiting_review:['N4','检查已结束，等待独立审查'],pending_review:['N4','独立审查等待处理'],
  changes_requested:['N4','审查要求修改'],approved:['N5','审查已通过，等待完成检查'],
  fixture_completed:['N5','开发完成检查已通过，等待 QA／收尾'],
  blocked:['N3','运行受阻'],unknown:['N3','执行结果待核对'],cancelled:['N3','运行已取消']};
export function projectHostResult({specsDir,feature,result,current}){
  if(!result?.operation||result.operation==='status'||!result.state||!result.identity)return;
  // A late control response is not the runner's current state. Derived QA and
  // documentation summaries have their own existing projections.
  if(current.state!==result.state||current.identity.runId!==result.identity.runId
    ||current.identity.taskId!==result.identity.taskId||current.identity.attempt!==result.identity.attempt)return;
  const selected=states[result.state];if(!selected)return;
  try{
    const previous=readStatusProjection(specsDir);
    if(previous===null)return;
    // QA and finalization must never be replaced by an earlier N3/N4 response.
    if(['N6','N7','N8'].includes(previous.node))return;
    const node=['blocked','unknown','cancelled'].includes(result.state)?previous.node:selected[0];
    writeStatusProjection({specsDir,feature,identity:result.identity,node,state:result.state,
      detail:(result.guidance?.summary??selected[1])+(result.code?`（${result.code}）`:''),code:result.code,
      ...(result.state==='changes_requested'&&result.identity.attempt>1?{previousAttempt:result.identity.attempt-1}:{}),
      expectedToken:previous.progress_id??null});
  }catch{diagnostic();}
}
