// Read-only UI projection of the existing owner. Never an execution decision,
// permission grant, current-source test result, or a second task-state store.
const flow=[
  ['reproduce','复现问题','advance'],['diagnose','定位原因','advance'],
  ['cause_review_required','原因审查','cause_review'],['test_author_required','准备回归用例','author_tests'],
  ['red_test_required','确认修复前失败','red_test'],['baseline_required','记录存量测试','baseline'],
  ['repair_required','修复代码','repair'],['regression_required','验证修复','regression'],
  ['handoff_required','复盘经验','retrospective'],['learning_writeback_required','写回已核验教训','learning_writeback'],
  ['handoff_ready','整理交接证据','handoff'],['final_review_required','独立审查','final_review'],
  ['final_review_evidence_required','保存审查证据','publish_review'],['completion_gate_required','核对完成条件','check_n5'],
  ['post_review_regression_required','审后回归','post_review_regression'],['closeout_required','走查与收尾','walkthrough'],
];

export function fixProgress(status,config={},authorization={}){
  const revision=Boolean(status.revision),stage=status.stage;
  const currentStage=revision?stage.replace(/^revision_/,''):stage;
  const selected=key=>revision?status[`revision${key[0].toUpperCase()}${key.slice(1)}`]:status[key];
  const completed=[];
  if(!revision&&status.reproduction?.status==='reproduced')completed.push('问题已复现');
  if(!revision&&status.diagnosis?.status==='diagnosed')completed.push('原因已定位');
  if(!revision&&status.redTest?.status==='red_confirmed')completed.push('修复前失败已确认');
  if(!revision&&status.baseline?.status==='recorded')completed.push('存量测试基线已记录');
  if(selected('repair')?.outcome==='repaired')completed.push('代码修复已记录');
  if(selected('regression')?.status==='passed')completed.push('修后回归已通过');
  if(['no_new_lesson','lesson_candidate','writeback_pending'].includes(selected('retrospective')?.content?.status))completed.push('经验复盘已记录');
  if(selected('handoff')?.status==='ready_for_review')completed.push('交接证据已生成');
  const review=selected('finalReview');
  if(review?.observationStatus==='completed')completed.push(review.review?.verdict==='approved'?'独立审查已批准':'独立审查已有结论');
  if(selected('postReviewRegression')?.status==='passed'||revision&&status.revisionPostRegression?.status==='passed')completed.push('审后回归已通过');
  if(selected('walkthrough')?.status==='passed')completed.push('走查已通过');
  const done=stage==='completed'&&status.completionEligible===true;
  const result={completed,current:done?'任务已完成':'需核对当前阶段',remaining:null,
    blocker:null,nextAction:null,requiresUser:false,finished:done,
    evidenceScope:'recorded_history_not_fresh_execution',remainingScope:'current_path_not_future_revisions'};
  if(done){result.remaining=[];return result;}
  if(stage==='rediagnosis_required')return {...result,current:'根因审查要求重新诊断',blocker:stage,
    nextAction:'原 run 使用 rediagnose（--allow-rediagnosis、reason）；处理原 findings 后重新独立审查，保留 cause-r1。',requiresUser:true};
  if(stage==='rediagnosis_review_limit_reached')return {...result,current:'第二次根因审查仍未通过',blocker:stage,
    nextAction:'保留两次审查和诊断；交用户判断，不继续重派或重建身份。',requiresUser:true};
  if(stage==='escalated')return {...result,current:'已升级立项，修复未完成',remaining:[],nextAction:null};
  if(stage==='cancelled')return {...result,current:'任务已取消',blocker:'cancelled',nextAction:'保留历史，不自动恢复。',requiresUser:true};
  if(status.executionActive===true)return {...result,current:'当前操作正在执行',nextAction:'等待当前操作结果，不重发或申请续审。'};
  if(status.diagnosis?.status==='design_change'){
    const actions={cause_review_required:['原因审查','cause_review'],test_author_required:['准备失败测试','author_tests'],design_change_required:['确认设计缺陷的失败测试','red_test'],
      escalation_required:['保存升级档案并退出','finish']};
    if(actions[stage]){
      const [current,nextAction]=actions[stage];
      return {...result,current,nextAction,remaining:[current,...(stage==='cause_review_required'&&config.testAuthor?['准备失败测试']:[]),
        ...(['cause_review_required','test_author_required'].includes(stage)&&config.redTest?['确认设计缺陷的失败测试']:[]),
        ...(stage!=='escalation_required'?['保存升级档案并退出']:[])]};
    }
  }
  const invocation=status.finalReviewInvocation;
  if(stage==='unknown'&&status.pending==='rediagnosis')return {...result,current:'重新诊断已登记但还没有有效结论',blocker:'rediagnosis_answer_required',
    nextAction:'原 run 再次使用 rediagnose（--allow-rediagnosis、reason）提交合法诊断答案；沿用已登记的这一次重新诊断，不另占次数，之后进入第二轮根因审查。',requiresUser:true};
  if(stage==='unknown'){
    const finalPending=!revision&&invocation&&(!review||review.observationStatus==='unknown');
    return {...result,current:finalPending?'独立审查结果未确认':'操作结果未确认',blocker:'result_unconfirmed',
      remaining:finalPending?['取得有效独立审查结果','保存审查证据','核对完成条件','审后回归',...(config.walkthrough?['走查']:[]),'完成收尾']:null,
      nextAction:finalPending&&invocation.providerThreadId
        ?'先确认原调用已停止；核对当前审查包并取得本次一次续审授权，再恢复原任务。'
        :status.reviewAbandonable?'审查没有结论：先确认原审查进程已停止，再用 abandon_review（--allow-abandon-review，每轮原因审查与第二轮最终审查各一次）放弃这次调用，然后重新审查。'
        :'核对原操作与实际结果；不要重跑已完成步骤或推定成功。',requiresUser:true,
      ...(finalPending?{recovery:{invocationId:invocation.invocationId,packageDigest:invocation.packageDigest,
        completedRecoveryPreparations:status.finalReviewRecoveryCount??0,
        needsFreshInvocationBinding:(status.finalReviewRecoveryCount??0)>0,
        knownThread:Boolean(invocation.providerThreadId),authorizationGranted:false}}:{})};
  }
  if(revision&&['revision_test_author_required','revision_test_check_required','revision_prepared'].includes(stage))
    return {...result,current:stage==='revision_test_author_required'?'补充审查要求的测试':stage==='revision_test_check_required'?'记录覆盖补充实跑结果':'准备第二轮修复',
      nextAction:stage==='revision_test_author_required'?'author_tests':stage==='revision_test_check_required'?'revision_test_check':'repair'};
  const steps=flow.filter(([key])=>(key!=='cause_review_required'||config.causeReview||status.causeReview)
    &&(key!=='test_author_required'||config.testAuthor)
    &&(key!=='learning_writeback_required'||['learning_writeback_required','learning_writeback_blocked'].includes(currentStage)));
  const index=steps.findIndex(([key])=>key===currentStage);
  if(index>=0){
    const [,label,operation]=steps[index];
    return {...result,current:label,remaining:[...steps.slice(index).map(([,name])=>name),'完成收尾'],
      nextAction:currentStage==='closeout_required'&&(!config.walkthrough||selected('walkthrough')?.status==='passed')?'finish':operation,
      requiresUser:currentStage==='final_review_required'&&authorization.finalReviewAllowed!==true,
      ...(currentStage==='final_review_required'?{notice:'按现有启动权限执行；恢复派发仍需本次绑定授权。'}:{})};
  }
  // V10: a legitimate blocked verdict of a local step can be rerun with a reason.
  if(status.blockedRerun)return {...result,current:'步骤给出合法的阻断结论',blocker:stage,
    nextAction:status.blockedRerun.used<status.blockedRerun.limit
      ?`先处理阻断原因（环境、证据或答复），再在原 run 用 rerun_blocked_step（--allow-rerun-blocked-step、单行 reason）重跑 ${status.blockedRerun.pending}；已用 ${status.blockedRerun.used}/${status.blockedRerun.limit} 次，阻断结果保留为历史。`
      :`本步骤带理由重跑已用满 ${status.blockedRerun.limit} 次；保留历史，交用户判断。`,requiresUser:true};
  return {...result,current:'当前流程受阻或需人工判断',blocker:stage,
    nextAction:'按现有阶段要求处理阻断；历史记录不代表当前条件已通过。',requiresUser:true};
}
