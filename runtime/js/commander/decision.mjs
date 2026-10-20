// Commander phase 2: one decision per run that needs attention, with its reason.
// It reads only what the journal recorded (state, code, pending). The real
// recovery exit depends on live status (pendingAction, budgets, verdicts,
// whether an old process has exited), so the table commits only where the
// record alone settles it; everywhere else it says "read status" and lists the
// exits that status may offer, marking those that need the user's approval.
// Every decision's first step is reading the run's own status.
import {REVIEW_RETRY_CODES} from '../cm-ai/durable-runner-state.mjs';

const STATUS='先用原 PLAN 读 status，以返回的 pendingAction 为准';
const APPROVAL='（需用户批准）';
const EXHAUSTED=/(_retry_limit|_redispatch_limit|_recheck_limit|_redo_limit|effect_interrupt_limit|review_abandon_budget_exhausted)$/;
const DEFECT=new Set(['execution_error','workflow_error','store_failure','runner_store_changed','checkpoint_package_material_invalid']);
const DEVELOP_RETRY=new Set(['develop_call_timeout','develop_checks_not_passed','develop_empty_changes','develop_package_too_large',
  'develop_requirement_missing','develop_unchanged_after_review','check_answer_missing','check_answer_invalid',
  'check_output_out_of_scope','developer_result_invalid','documentation_sync_answer_missing']);

export const DECISIONS=Object.freeze(['wait','spec_change','human_sync','escalate','read_status']);

// Any listed exit that needs approval makes the whole decision need it.
const decide=(decision,needsApproval,why,steps,candidates=[])=>({decision,
  needsApproval:needsApproval||candidates.some(candidate=>candidate.includes(APPROVAL)),why,steps:[STATUS,...steps],candidates});

export function decideRecovery({state=null,code=null,pending=null,verified=true}={}){
  if(!verified)return decide('read_status',false,'本版本回放不了这条运行的记录，状态未校验',[]);
  if(pending)return decide('wait',false,`记录里有未结的 ${pending}，可能仍在执行`,['确认执行它的宿主或会话是否还在；还在就等，不重派']);
  if(code==='spec_drift')return decide('spec_change',true,'已批准规格被改动，运行被挡住',['规格改动需用户确认：还原，或重新批准后按 status 给出的换绑出口处理']);
  if(code==='protected_scope')return decide('human_sync',true,'scope 含受保护路径，开发不能写它',['由用户走人工通道同步受保护文件，再把它移出 scope']);
  if(DEFECT.has(code)||state==='unknown')return decide('escalate',true,`${code??state} 不是靠重试能解决的，可能是工作流缺陷`,
    ['保留原运行与记录，交维护者排查；不重派、不改写历史']);
  // From here the record does not settle the exit; status does.
  if(REVIEW_RETRY_CODES.includes(code))return decide('read_status',true,`审查没拿到结论（${code}），能否重派取决于额度和旧进程是否已退出`,[],
    ['宿主自动重派（status 给 resume 时）','abandon_review：确认旧审查进程已退出后授权'+APPROVAL,'额度用尽时 supersede 重开'+APPROVAL]);
  if(DEVELOP_RETRY.has(code))return decide('read_status',false,`${code} 通常在本运行内还有重试或重做出口`,[],
    ['宿主自动继续（status 给 resume / advance 时）','develop_redo：先确认会话已停写，固定原状态目标'+APPROVAL,'名额用尽时 supersede 重开'+APPROVAL]);
  if(code==='review_package_changed')return decide('read_status',false,'审查包与记录不符，能否继续取决于已记录的审查结论',[],
    ['按 status 继续','还原改动后继续','supersede 重开'+APPROVAL]);
  if(code==='review_blocked'||code==='review_not_approved')return decide('read_status',true,`审查对交付本身给了结论（${code}）`,[],
    ['status 给出的返工出口','supersede 重开'+APPROVAL]);
  if(typeof code==='string'&&EXHAUSTED.test(code))return decide('read_status',true,`本运行的名额已用尽（${code}）`,[],
    ['development_rework：严格绑定的情形下原运行仍可返工'+APPROVAL,'supersede 重开：先 inspect-history 取 supersedeTarget'+APPROVAL]);
  if(state==='cancelled')return decide('read_status',true,'运行已取消',[],['supersede 重开'+APPROVAL,'把任务标 DROPPED'+APPROVAL]);
  return decide('read_status',false,`决策表没有收录 ${code??state}`,[]);
}
