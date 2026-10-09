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
  develop_call_timeout:['开发应答超时、代码未改动。','先确认会话已不再修改代码；重发的请求须在宿主请求上限（默认 30 分钟）内应答，迟到应答仍被拒绝'],
};
const explain=(summary,nextStep,operation=null,prerequisites=[])=>Object.freeze({
  summary,nextStep,recoveryOperation:operation,prerequisites:Object.freeze(prerequisites),authorizationGranted:false,
});
export function operatorGuidance(result,{executionActive=false}={}){
  if(result?.workflow!=='cm-ai'||!result.state||!result.identity)return null;
  const {state,code,pendingAction:action,outcome}=result;
  if(outcome==='rejected'||outcome==='denied')return explain('本次操作被拒绝，运行状态没有因此获得新的执行权限。',
    '先核对 code 与 reason，修正请求或取得所需授权；不要据此重复开发或审查。');
  if(executionActive)return explain('原运行仍有操作在执行。','等待原操作结果；可读取状态，不重复派发。');
  if(code==='spec_drift')return explain('已批准规格发生变化，后续执行被阻止。',
    action==='spec_rebind'?'先核对重新批准的规格；符合原任务内容未变的条件时，在原运行显式换绑规格。'
      :'先核对规格变更与原任务绑定；当前没有可直接继续的恢复动作。',null,['保留原运行身份与历史','不得绕过规格审批']);
  if(action==='bootstrap_review_recover')return explain('项目规则交付已记录，但规则审查包尚未恢复。',
    '核对当前规则文件、handoff 和原证据；恢复原运行后发送 bootstrap_review_recover。此路径不重新派发开发。',
    'bootstrap_review_recover',['使用原配置与 runId，以 --mode resume 启动','显式 --allow-bootstrap-review-recovery，并提供单行 reason','由原宿主重新核对恢复条件']);
  if(state==='unknown'){
    if(action==='abandon_effect'||action==='abandon_review'){
      const review=action==='abandon_review';
      return explain(review?'独立审查结果尚未确认。':'开发或完成操作的结果尚未确认。',
        '先核对原操作与磁盘结果，确认旧宿主及相关子进程已退出；符合原宿主条件时，再审计放弃这次操作。放弃不代表成功。',
        action,['保留原配置、runId 和失败历史，以 --mode resume 启动',
          review?'显式 --allow-abandon-review，并提供单行 reason':'显式 --allow-abandon-effect，并提供单行 reason',
          '由原宿主核对可放弃条件；不得直接重跑或改写完成记录']);
    }
    return explain('执行结果尚未确认，不能判断这一步成功或失败。',
      '只读核对原运行记录、进程及实际文件；当前没有已确认的直接重试入口，不新建运行绕过历史。');
  }
  if(action==='develop_redo')return explain('开发应答没有拿到（超时后代码已改动、会话断开或只回了 failed），会话可能仍在写文件。',
    '先确认会话已停止修改代码；再恢复原运行并发送 develop_redo 写入确认，之后 advance 重发本轮开发。盘上改动保留，经检查和独立审查。',
    'develop_redo',['保留原配置、runId 与历史，以 --mode resume 启动','显式 --allow-develop-redo，并提供单行 reason','不占调用与 effect 名额；每运行最多 2 次']);
  if(state==='blocked'&&action==='resume'&&code==='develop_answer_missing')return explain('已确认会话停写，本轮开发等待重发。',
    '恢复原运行并发送 advance，用新 effect id 重发本轮开发；盘上改动保留，经检查和独立审查。',
    'advance',['保留原配置、runId 与历史，以 --mode resume 启动','确认原宿主已关闭，且本轮开发有原合同要求的授权']);
  if(state==='blocked'&&action==='resume'&&['check_answer_missing','check_answer_invalid'].includes(code))
    return explain(code==='check_answer_invalid'?'开发交付已落盘，但之后的检查或验证预检答复格式不合格。'
      :'开发交付已落盘，但之后的检查或验证预检没有拿到应答（超时、断开或迟到）。',
    '先确认上一次检查命令已停止；然后恢复原运行并发送 advance，只重跑检查、验证预检与审查包，不重新开发。',
    'advance',['保留原配置、runId 与历史，以 --mode resume 启动','不占开发调用与 effect 名额；每运行最多 2 次','不会自动完成任务或消耗新的独立审查轮次']);
  if(state==='blocked'&&action==='complete'&&code==='complete_recheck_failed')return explain('完成前复查没有拿到可用应答，任务尚未勾选。',
    '恢复原运行并发送 complete，重新复查并完成；不重新开发或审查。',
    'complete',['原 run 与已审交接、范围和包绑定不变','task-commit-intent 尚未写入；每运行最多 2 次']);
  if(state==='blocked'&&action==='resume'&&Object.hasOwn(deliveryMessages,code)){
    const [summary,repair]=deliveryMessages[code];
    return explain(summary,`${repair}；然后恢复原运行并发送 advance，重做本轮交付和检查。`,
      'advance',['保留原配置、runId 与历史，以 --mode resume 启动','确认原宿主已关闭，且本轮开发有原合同要求的授权','不会自动完成任务或消耗新的独立审查轮次']);
  }
  if(state==='pending_review'&&action==='resume')return explain('本轮独立审查未取得可接受的结论。',
    '核对 code 与原审查证据；恢复原运行后，取得本轮绑定的独立审查授权，再发送 advance。',
    'advance',['原 run、配置和审查包绑定不变','原宿主仍须核对重派次数、进程和独立审查权限']);
  if(state==='blocked'&&action==='complete')return explain('完成前复核受阻，已有审查结论不能直接当作任务完成。',
    '核对 reason 中的检查或文件变化；满足原完成条件后，在原运行发送 complete，不重新开发。',
    'complete',['原 run 与已审交接、范围和包绑定不变','使用当前 packageDigest；由宿主重新核对完成条件']);
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

// A member result is not a batch control surface. Keep unsupported single-run
// recovery operations out of batch instructions without changing pendingAction.
export function batchOperatorGuidance(result){
  const g=result?.guidance;if(!g)return null;
  if(result.code==='spec_drift')return explain(g.summary,
    '批次成员不能换绑规格；先按 reason 核对原批次可用出口，不直接重派。');
  if(g.recoveryOperation==='advance')return explain(g.summary,
    g.nextStep.replace('然后恢复原运行并发送 advance，重做本轮交付和检查。','然后从原批次入口发送 advance，重做本轮交付和检查。')
      .replace('然后恢复原运行并发送 advance，只重跑','然后从原批次入口发送 advance，只重跑')
      .replace('恢复原运行并发送 advance，用新 effect id','从原批次入口发送 advance，用新 effect id')
      .replace('恢复原运行后，取得本轮绑定的独立审查授权，再发送 advance。','沿原批次续接，取得本轮绑定的独立审查授权，再发送 advance。'),
    'advance',['保持原批次配置、身份和 PLAN；成员运行由批次宿主选择恢复','先确认原批次宿主已关闭；开发与审查仍需原合同授权']);
  if(g.recoveryOperation==='complete')return explain(g.summary,
    '核对 reason 中的检查或文件变化；满足原完成条件后，从原批次入口发送 advance，由成员宿主继续完成复核。',
    'advance',['保留原批次配置与已审证据；不重新开发','成员宿主重新核对完成条件']);
  if(g.recoveryOperation)return explain(g.summary,
    '批次入口不支持此成员恢复操作；先核对原成员运行与 reason，不通过 advance 重派或新建运行绕过。');
  return g;
}
