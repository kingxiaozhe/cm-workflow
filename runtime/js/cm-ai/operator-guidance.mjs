// Presentation only. Native pendingAction decides the available path; guidance
// never grants permission, changes retryability, or writes execution history.
const deliveryMessages={
  develop_checks_not_passed:['开发检查未通过，尚未进入独立审查。','根据 reason 中的检查编号和证据修复代码或环境'],
  develop_package_too_large:['审查材料或运行存档记录超过大小限制，交付暂时受阻。','缩小 reason 指出的文件或材料；若要改变任务范围，先走规格变更'],
  developer_result_invalid:['开发答复不符合交付合同。','修正开发答复格式及 Learning 记录'],
  verification_precheck_failed:['交付未满足任务的验证要求。','根据验证证据补齐交付'],
  check_output_out_of_scope:['检查产生了任务范围外的改动。','核对并处理检查产物；保留用户改动，不擅自扩大范围'],
  develop_empty_changes:['交付没有产生可审查的实际改动。','核对任务要求并提供实际修改'],
  develop_unchanged_after_review:['交付没有处理上一轮审查要求。','处理原审查 findings 后提供本轮修改'],
  develop_requirement_missing:['交付后缺少要求保留的文件。','恢复 reason 指出的必要文件'],
  bootstrap_verification_failed:['项目规则验证未通过。','根据规则验证证据修正草稿或检查环境'],
  develop_answer_invalid:['开发应答未通过交付合同校验（如 application.note 过长），代码已保留、尚未进入审查。','按 reason 中的字段上限重新应答'],
  develop_dispatch_failed:['开发请求在派发给会话之前失败（宿主自己的运行日志或角色配置出错），代码未改动。','修好 reason 指出的宿主环境'],
  develop_interrupted:['宿主在本轮开发中途退出，中断已登记，盘上改动保留、尚未进入审查。','确认会话或 provider 进程已停止修改代码'],
  develop_call_timeout:['开发应答超时、代码未改动。','先确认会话已不再修改代码；重发的请求须在宿主请求上限（默认 30 分钟）内应答，迟到应答仍被拒绝'],
};
// Q16/Q17: documentation_sync of the final task, after develop already answered.
const documentationMessages={
  documentation_sync_answer_missing:['文档同步没有拿到应答（超时、断开或迟到）。开发应答已记录，不需要重新开发。','重发的文档同步须在宿主请求上限内应答，迟到应答仍被拒绝；'],
  documentation_sync_answer_invalid:['文档同步的应答格式不合格。开发应答已记录，不需要重新开发。','只按合同应答 {"status":"completed"} 或 {"status":"blocked"}；'],
  documentation_sync_answer_blocked:['文档同步答复 blocked，文档没有同步完。开发应答已记录，不需要重新开发。','先按会话说明补齐或修正文档、解决阻碍；'],
  documentation_sync_out_of_scope:['文档同步改了文档路径以外的文件（reason 列出路径），尚未进入审查。','先把这些文件还原到文档同步开始时的内容（宿主按存档摘要核对，没还原就拒绝；确需修改先走规格变更）；'],
  documentation_sync_interrupted:['宿主在文档同步中途退出，中断已登记。开发应答已记录，不需要重新开发。',''],
};
const explain=(summary,nextStep,operation=null,prerequisites=[])=>Object.freeze({
  summary,nextStep,recoveryOperation:operation,prerequisites:Object.freeze(prerequisites),authorizationGranted:false,
});
// Rendering context is private and ephemeral; it never enters results or journals.
const guidanceContext=new WeakMap();
export function operatorGuidance(result,options={}){
  const guidance=renderOperatorGuidance(result,options);
  if(guidance)guidanceContext.set(guidance,{executionActive:options.executionActive===true,protocol:options.protocol??'legacy'});
  return guidance;
}
export function projectOperatorGuidance(result,options={}){
  if(!result?.guidance)return result;
  const context=guidanceContext.get(result.guidance);
  if(!context)return result;
  const guidance=operatorGuidance(result,{...context,...options});
  return guidance?{...result,guidance}:result;
}
const fixedTarget='先只读 status，展示并核对 controlTarget 与恢复动作，按当前对话的具体决定完整固定为 expectedControl；发送 version:2 和单行 reason；snapshot_changed 时停止，不自动刷新目标重试';
function renderOperatorGuidance(result,{executionActive=false,protocol='legacy',surface='single'}={}){
  const v2=protocol==='v2',batch=surface==='batch';
  const resume=batch?'从原批次入口发送 advance':'恢复原运行并发送 advance';
  const permission=flag=>v2?fixedTarget:`显式 ${flag}，并提供单行 reason`;
  const supersede=v2?'当前 v2 没有作废旧证据并新建运行的出口；保留原运行、文件与证据，核对 reason 后交由维护者处理，不改走旧入口。'
    :'修好后按 reason 用 --supersede-reviewed-evidence 新建运行重做。';
  const supersedePrerequisites=v2?['原运行记录与现有文件保留，不改写','不改变协议、身份或恢复预算']
    :['原运行记录保留，不改写','本运行留在盘上的改动需还原，或加 --accept-superseded-code-drift'];
  if(result?.workflow!=='cm-ai'||!result.state||!result.identity)return null;
  const {state,code,pendingAction:action,outcome}=result;
  if(outcome==='rejected'||outcome==='denied')return explain('本次操作被拒绝，运行状态没有因此获得新的执行权限。',
    '先核对 code 与 reason，修正请求或取得所需授权；不要据此重复开发或审查。');
  if(executionActive)return explain('原运行仍有操作在执行。','等待原操作结果；可读取状态，不重复派发。');
  if(code==='spec_drift')return explain('已批准规格发生变化，后续执行被阻止。',
    action==='spec_rebind'?(v2?'先核对重新批准的规格；符合原条件时，只读 status 并展示 launchControlTarget，将完整固定副本写入文件，以原策略和配置带 --expected-control FILE、--rebind-spec-material 与单行 --spec-rebind-reason 恢复；snapshot_changed 时停止，不自动刷新。':'先核对重新批准的规格；符合原任务内容未变的条件时，在原运行显式换绑规格。')
      :'先核对规格变更与原任务绑定；当前没有可直接继续的恢复动作。',null,['保留原运行身份与历史','不得绕过规格审批']);
  if(action==='bootstrap_review_recover')return explain('项目规则交付已记录，但规则审查包尚未恢复。',
    '核对当前规则文件、handoff 和原证据；恢复原运行后发送 bootstrap_review_recover。此路径不重新派发开发。',
    'bootstrap_review_recover',['使用原配置与 runId，以 --mode resume 启动',permission('--allow-bootstrap-review-recovery'),'由原宿主重新核对恢复条件']);
  if(state==='unknown'){
    if(action==='abandon_effect'||action==='abandon_review'){
      const review=action==='abandon_review';
      return explain(review?'独立审查结果尚未确认。':'宿主在开发、审查或完成中途退出，这一步只登记了意图、没有结果。',
        review?'先核对原操作与磁盘结果，确认旧宿主及相关子进程已退出；符合原宿主条件时，再审计放弃这次操作。放弃不代表成功。'
          :result.documentationSyncPending===true
            ?'先确认旧宿主及相关子进程已退出、会话已停止修改文档（宿主按存档核对文档路径以外的文件与此刻的文档）；再发送 abandon_effect 登记中断，运行转为 documentation_sync_interrupted，之后只重发文档同步、不重新开发，计入文档同步重发的 2 次上限。盘上改动保留并经检查与独立审查；登记中断不代表成功。'
          :'先确认旧宿主及相关子进程已退出、会话已停止写入（provider 开发由宿主按存档记下的进程身份核对）；再发送 abandon_effect 登记中断，运行从这一步的可重试阻断继续：开发重发本轮、未登记的审查重新派发、未写提交意图的完成重新复查。盘上改动保留并经检查与独立审查；登记中断不代表成功。',
        action,['保留原配置、runId 和失败历史，以 --mode resume 启动',
          review?permission('--allow-abandon-review'):permission('--allow-abandon-effect'),
          '由原宿主核对可放弃条件；不得直接重跑或改写完成记录']);
    }
    // V5 (A33/A36): a no-verdict review end the host cannot prove safe to redispatch.
    if(['review_process_unverified','review_observation_invalid','review_boundary_unverified','review_abandon_budget_exhausted'].includes(result.reviewAbandonRefusal))
      return explain('独立审查没有结论，且宿主不能证明再派一次是安全的（reason 写明原因）。',
        `按 reason 手工核对旧审查进程与原审查证据；本运行不再重派审查。${supersede}`,
        null,supersedePrerequisites);
    return explain('执行结果尚未确认，不能判断这一步成功或失败。',
      '只读核对原运行记录、进程及实际文件；当前没有已确认的直接重试入口，不新建运行绕过历史。');
  }
  if(state==='blocked'&&action==='abandon_review')return explain('本轮独立审查第二次没有结论，本轮还剩 1 次无结论重派，但宿主不能证明原审查进程已停止。',
    '先确认原审查进程（含子进程）已退出；再恢复原运行并发送 abandon_review 登记确认，之后 advance 重派。不算审查轮次。',
    'abandon_review',['保留原配置、runId 与历史，以 --mode resume 启动',permission('--allow-abandon-review'),'用满 2 次后为 review_redispatch_limit']);
  // Q16/Q17: the final task's documentation_sync failed after develop answered.
  // R3: whatever the failure, the host cannot see whether the session still writes.
  if(action==='develop_redo'&&Object.hasOwn(documentationMessages,code))return explain(`${documentationMessages[code][0]}宿主无法证明会话已停止修改文档。`,
    `先确认会话已停止修改文档，${documentationMessages[code][1]}再恢复原运行并发送 develop_redo 写入确认，之后 advance 只重发文档同步。盘上的开发与文档改动保留，经检查和独立审查。`,
    'develop_redo',['保留原配置、runId 与历史，以 --mode resume 启动',permission('--allow-develop-redo'),'只重发文档同步，不重发开发；每运行最多 2 次']);
  if(state==='blocked'&&action==='resume'&&Object.hasOwn(documentationMessages,code)){
    const [summary,repair]=documentationMessages[code];
    return explain(summary,`${repair}然后${resume}，只重发文档同步，复用已记录的开发应答，不重新开发。`,
      'advance',['保留原配置、runId 与历史，以 --mode resume 启动','文档路径以外的文件须与文档同步开始时一致、文档须与确认停写时一致，否则拒绝','不占调用与 effect 名额；每运行最多 2 次，用满为 documentation_sync_retry_limit']);
  }
  if(code==='documentation_sync_retry_limit')return explain('文档同步重发已在本运行用满 2 次，不再重发。',
    `先查清会话为何一直不应答、答复 blocked 或越界写文件；${supersede}`,
    null,supersedePrerequisites);
  if(action==='develop_redo')return explain('开发应答没有拿到（超时后代码已改动、会话断开或只回了 failed），会话可能仍在写文件。',
    '先确认会话已停止修改代码；再恢复原运行并发送 develop_redo 写入确认，之后 advance 重发本轮开发。盘上改动保留，经检查和独立审查。',
    'develop_redo',['保留原配置、runId 与历史，以 --mode resume 启动',permission('--allow-develop-redo'),'不占调用与 effect 名额；每运行最多 2 次']);
  if(state==='blocked'&&action==='resume'&&code==='develop_answer_missing')return explain('已确认会话停写，本轮开发等待重发。',
    `${resume}，用新 effect id 重发本轮开发；盘上改动保留，经检查和独立审查。`,
    'advance',['保留原配置、runId 与历史，以 --mode resume 启动','确认原宿主已关闭，且本轮开发有原合同要求的授权']);
  if(state==='blocked'&&action==='resume'&&code==='develop_out_of_scope')return explain('开发交付已落盘，但改动超出了任务 scope（reason 列出路径），尚未进入审查。',
    `核对这些路径：会话越界写的就还原，你自己的改动就移出代码根，确需改动先走规格变更扩大 scope；然后${resume}，只重跑检查、验证预检与审查包，不重新开发。`,
    'advance',['保留原配置、runId 与历史，以 --mode resume 启动','不占开发调用与 effect 名额；每运行最多 2 次','不擅自删除用户改动']);
  if(state==='blocked'&&action==='resume'&&['check_answer_missing','check_answer_invalid'].includes(code))
    return explain(code==='check_answer_invalid'?'开发交付已落盘，但之后的检查或验证预检答复格式不合格。'
      :'开发交付已落盘，但之后的检查或验证预检没有拿到应答（超时、断开或迟到）。',
    `先确认上一次检查命令已停止；然后${resume}，只重跑检查、验证预检与审查包，不重新开发。`,
    'advance',['保留原配置、runId 与历史，以 --mode resume 启动','不占开发调用与 effect 名额；每运行最多 2 次','不会自动完成任务或消耗新的独立审查轮次']);
  if(state==='blocked'&&action==='complete'&&code==='complete_commit_interrupted')return explain('宿主在写入任务完成提交意图后退出，tasks.md 可能已勾选也可能未勾选。',
    '恢复原运行并发送 complete；宿主只按存档里的提交计划核对并收尾，不重新复查、不重新开发。tasks.md 或证据被改动时会拒绝并保留现场。',
    'complete',['保留原配置、runId 与历史，以 --mode resume 启动','不能 abandon_effect，也不能新建运行替代']);
  if(state==='blocked'&&action==='complete'&&code==='complete_recheck_failed')return explain('完成前复查没有正常结束（应答缺失或宿主在提交前出错），任务尚未勾选。',
    '恢复原运行并发送 complete，重新复查并完成；不重新开发或审查。',
    'complete',['原 run 与已审交接、范围和包绑定不变','task-commit-intent 尚未写入；每运行最多 2 次']);
  if(state==='blocked'&&action==='resume'&&Object.hasOwn(deliveryMessages,code)){
    const [summary,repair]=deliveryMessages[code];
    return explain(summary,`${repair}；然后${resume}，重做本轮交付和检查。`,
      'advance',['保留原配置、runId 与历史，以 --mode resume 启动','确认原宿主已关闭，且本轮开发有原合同要求的授权','不会自动完成任务或消耗新的独立审查轮次']);
  }
  if(state==='pending_review'&&action==='resume')return explain('本轮独立审查未取得可接受的结论。',
    `核对 code 与原审查证据；取得本轮绑定的独立审查授权，再${resume}。`,
    'advance',['原 run、配置和审查包绑定不变','原宿主仍须核对重派次数、进程和独立审查权限']);
  if(state==='blocked'&&action==='complete')return explain('完成前复核受阻，已有审查结论不能直接当作任务完成。',
    '核对 reason 中的检查或文件变化；满足原完成条件后，在原运行发送 complete，不重新开发。',
    'complete',['原 run 与已审交接、范围和包绑定不变','使用当前 packageDigest；由宿主重新核对完成条件']);
  if(code==='review_redispatch_limit')return explain('本轮独立审查已无结论重派 2 次，不再重派；这不计为审查轮次。',
    `先查清审查进程为何一直没有结论（登录、额度、网络或审查答复格式）；${supersede}`,
    null,supersedePrerequisites);
  if(['check_answer_retry_limit','complete_recheck_limit','develop_redo_limit'].includes(code))
    return explain('这一步的自动恢复已在本运行用满 2 次，不再重做。',
      `先查清会话为何一直不应答或答复不合格（或宿主环境为何失败）；${supersede}`,
      null,supersedePrerequisites);
  // Q06/Q07/Q11: a QA call that stopped as a whole.
  if(state==='fixture_completed'&&code==='qa_execution_unknown')return explain('本轮 QA 没有正常结束（整轮超时、宿主中途退出、答复格式不合格，或浏览器请求超时后设备可能仍被会话占用）。',
    v2?(batch?'先确认上一轮会话与设备已空闲；批次 v2 没有启动型 QA 重跑出口，保留批次与 QA 证据并核对 reason，不新建运行绕过。':'先确认上一轮的会话、浏览器或模拟器已停止、设备已空闲；只读 status，展示并核对 launchControlTarget 后完整固定到文件。以原策略与配置 --mode resume、--expected-control FILE 和 --rerun-unknown-qa 启动；snapshot_changed 时停止，不自动刷新目标。宿主拒绝时保留原运行与 QA 证据，不改走旧入口。')
      :'先确认上一轮的会话、浏览器或模拟器已停止、设备已空闲；再用原配置 --mode resume 加 --rerun-unknown-qa 重跑本轮。宿主拒绝时按拒绝码处理：含原始 FAIL、未解决的 [需确认] 或无法归因的旧记录的轮次不能替代，改用 --supersede-reviewed-evidence 新建运行。',
    null,['保留原运行与 QA 日志，只追加不改写','因宿主或应答原因替代的轮次不占三轮预算']);
  // Q15: the read-only documentation check answered blocked.
  if(state==='fixture_completed'&&code==='documentation_sync_blocked')return explain('文档核对判定文档尚未同步（reason 写明缺什么）。',
    '按 reason 补齐 README 或功能文档；文档核对只读、可重复，用原配置 --mode resume 重启宿主后再发 finish 重新核对（同一宿主进程内结论已缓存）。',
    null,['不改写运行记录','补文档不需要重新开发或审查']);
  if(code==='protected_scope')return explain('任务 scope 含项目规则或工作流文件，开发在派发前被拒绝，未写入任何文件。',
    '本运行到此结束，原记录保留。从 scope 移除 reason 列出的路径，按原门禁用新 runId 新建运行；规则文件改动走 docs/js-workflow-control.md「项目规则文件的修改通道」。',
    null,['不放宽受保护路径，开发者不能写这些文件','不改写原运行记录']);
  if(code==='bootstrap_instruction_conflict')return explain('已有项目规则与本次允许的写入基准冲突，规则生成被阻止。',
    '核对前序规则任务、提交基准和当前文件；当前没有可直接重派的动作，不覆盖已有规则。');
  if(code==='checks_not_passed')return explain('旧完成阶段的检查未通过，当前不是可重做开发的阻塞。',
    '保留原检查与审查证据，核对原完成恢复合同；不要使用开发重试或新建运行绕过。');
  if(state==='blocked'||code==='correction_review_required'||code==='review_package_changed')return explain('当前流程受阻，尚未确认可执行的恢复步骤。',
    '核对 code、reason 和原运行证据；保留已有文件与历史，不把通用阻塞当作重试许可。');
  return null;
}
// Only bounded static guidance is rendered, never raw provider output.
export function guidanceText(result){
  if(result?.workflow!=='cm-ai')return null;
  const guidance=result?.guidance;
  const bounded=value=>typeof value==='string'&&Buffer.byteLength(value,'utf8')<=2000&&!/[\r\n\0]/.test(value);
  if(!guidance||guidance.authorizationGranted!==false||!bounded(guidance.summary)||!bounded(guidance.nextStep)
    ||!Array.isArray(guidance.prerequisites)||guidance.prerequisites.length>8||!guidance.prerequisites.every(bounded))return null;
  return `${guidance.summary} ${guidance.nextStep} ${guidance.prerequisites.join('；')}`.trim();
}

// Q24: in-run recovery operations the batch entry forwards to the stopped member
// (scripts/cm-ai-batch-run.mjs BATCH_MEMBER_ACTIONS), with what to confirm first.
const BATCH_RECOVERY={
  develop_redo:['--allow-develop-redo','先确认会话已停止修改代码'],
  abandon_effect:['--allow-abandon-effect','先确认旧宿主及相关子进程已退出、会话已停止写入'],
  abandon_review:['--allow-abandon-review','先确认旧宿主与审查进程已退出'],
  bootstrap_review_recover:['--allow-bootstrap-review-recovery','先核对当前规则文件、handoff 和原证据'],
};
// A member result is not a batch control surface. Keep unsupported single-run
// recovery operations out of batch instructions without changing pendingAction.
export function batchOperatorGuidance(result,{taskKey=null,protocol='legacy'}={}){
  const context=guidanceContext.get(result?.guidance);
  const g=context?operatorGuidance(result,{...context,protocol,surface:'batch'}):result?.guidance;
  if(!g)return null;
  if(Object.hasOwn(BATCH_RECOVERY,g.recoveryOperation)){
    const [flag,defaultConfirm]=BATCH_RECOVERY[g.recoveryOperation],target=taskKey??'FEATURE/TASK';
    const confirm=g.recoveryOperation==='develop_redo'&&Object.hasOwn(documentationMessages,result.code)
      ?'先确认会话已停止修改文档':defaultConfirm;
    if(protocol==='v2')return explain(g.summary,
      `${confirm}；用原策略与配置从批次入口只读 status，展示并核对完整批次 controlTarget（batchId、taskKey、member、batchDigest），按当前对话的具体决定固定为 expectedControl；发送 version:2 的批次操作 ${g.recoveryOperation}（taskKey ${target}、单行 reason），之后 advance 继续本批次。`,
      g.recoveryOperation,['保留原批次、成员身份与历史；不跨成员','snapshot_changed 时停止，不自动刷新目标重试；批次 cancel 后不能再恢复']);
    return explain(g.summary,`${confirm}；关闭批次宿主，带 ${flag} ${target} 用同一批次配置重新启动，发送批次操作 ${g.recoveryOperation}（taskKey ${target}、单行 reason），之后 advance 继续本批次。`,
      g.recoveryOperation,['保持原批次配置；批次只用这一项权限打开该成员运行，不跨成员','授权用一次即失效；批次 cancel 后不能再恢复']);
  }
  if(result.code==='spec_drift')return explain(g.summary,
    '批次成员不能换绑规格；先按 reason 核对原批次可用出口，不直接重派。');
  if(g.recoveryOperation==='advance')return explain(g.summary,g.nextStep,
    'advance',['保持原批次配置、身份和 PLAN；成员运行由批次宿主选择恢复','先确认原批次宿主已关闭；开发与审查仍需原合同授权']);
  if(g.recoveryOperation==='complete')return explain(g.summary,
    '核对 reason 中的检查或文件变化；满足原完成条件后，从原批次入口发送 advance，由成员宿主继续完成复核。',
    'advance',['保留原批次配置与已审证据；不重新开发','成员宿主重新核对完成条件']);
  if(g.recoveryOperation)return explain(g.summary,
    '批次入口不支持此成员恢复操作；先核对原成员运行与 reason，不通过 advance 重派或新建运行绕过。');
  return g;
}
