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
  if(stage==='cancelled')return {...result,current:'任务已取消',blocker:'cancelled',nextAction:'保留历史，不自动恢复。',requiresUser:true};
  if(status.executionActive===true)return {...result,current:'当前操作正在执行',nextAction:'等待当前操作结果，不重发或申请续审。'};
  const invocation=status.finalReviewInvocation;
  if(stage==='unknown'){
    const finalPending=!revision&&invocation&&(!review||review.observationStatus==='unknown');
    return {...result,current:finalPending?'独立审查结果未确认':'操作结果未确认',blocker:'result_unconfirmed',
      remaining:finalPending?['取得有效独立审查结果','保存审查证据','核对完成条件','审后回归',...(config.walkthrough?['走查']:[]),'完成收尾']:null,
      nextAction:finalPending&&invocation.providerThreadId
        ?'先确认原调用已停止；核对当前审查包并取得本次一次续审授权，再恢复原任务。'
        :'核对原操作与实际结果；不要重跑已完成步骤或推定成功。',requiresUser:true,
      ...(finalPending?{recovery:{invocationId:invocation.invocationId,packageDigest:invocation.packageDigest,
        completedRecoveryPreparations:status.finalReviewRecoveryCount??0,
        needsFreshInvocationBinding:(status.finalReviewRecoveryCount??0)>0,
        knownThread:Boolean(invocation.providerThreadId),authorizationGranted:false}}:{})};
  }
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
  return {...result,current:'当前流程受阻或需人工判断',blocker:stage,
    nextAction:'按现有阶段要求处理阻断；历史记录不代表当前条件已通过。',requiresUser:true};
}
