import {setImmediate as yieldHost} from 'node:timers/promises';
// Shared original cm-fix action dispatch for standalone and parent hosts.
import {inspectFixQaSource} from './qa-source.mjs';
import {startFixRun} from './start.mjs';
import {digest,need,shape} from '../cm-ai/effect-contract.mjs';
import {fixArchiveRoot} from './layout.mjs';
import {fixProgress} from './progress.mjs';

export function createFixHost({owner,config,runtime='codex',reviewRuntime,permissions=[],authority=null,finalAuthority=null,recoveryInvocationId=null,verificationRecoveryAuthorization=null}){
  const extra=new Set(permissions);
    const host={async handle(request){
      shape(request,['requestId','operation',...(request.operation==='resume'?['evidenceFiles']:[]),
        ...(['abandon_step','abandon_review','rediagnose','rerun_blocked_step'].includes(request.operation)&&Object.hasOwn(request,'reason')?['reason']:[]),
        ...(request.operation==='prepare_revision'&&Object.hasOwn(request,'tests')?['tests']:[]),
        ...(request.operation==='prepare_test_type_correction'?['expected','testTypeCorrection','previousInvocationStopped','reason']:[]),
        ...(request.operation==='prepare_command_correction'?['expected','commandCorrection','previousInvocationStopped','reason']:[]),
        ...(request.operation==='prepare_verification_recovery'?['expected','previousInvocationStopped','reason',...(Object.hasOwn(request,'sourceCorrection')?['sourceCorrection']:[])]:[]),
        ...(request.operation==='reconcile_review'?['invocationId']:[]),
        ...(request.operation==='recover_final_review'?['invocationId','packageDigest','previousInvocationStopped','reason']:[])]);
      if(config.qaSource&&!['status','cancel','completion_evidence'].includes(request.operation))
        inspectFixQaSource({specsRoot:config.specsRoot,identity:config.identity,configuration:config});
      if(request.operation==='resume'){need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');return owner.resume({authorized:true,evidenceFiles:request.evidenceFiles});}
      if(request.operation==='status'){
        const status=owner.status();
        const recoveryAllowed=!status.finalReviewRecovery||extra.has('--allow-final-review-recovery')
          &&(status.finalReviewRecoveryCount<=1&&recoveryInvocationId===null
            ||recoveryInvocationId===status.finalReviewRecovery.invocationId);
        const bounded=status.verificationRecovery,phase=bounded?.target.phase;
        const boundedWaiting=bounded&&!bounded.used&&status.stage===`${phase}_required`;
        const boundedFailed=bounded?.used&&status.stage==='unknown'&&(
          phase==='cause_review'&&status.causeReview?.observationStatus!=='completed'
          ||phase==='final_review'&&status.finalReview?.observationStatus!=='completed'
          ||phase==='revision_final_review'&&status.revisionFinalReview?.observationStatus!=='completed');
        const progress=fixProgress(status,config,{finalReviewAllowed:finalAuthority!==null
          &&extra.has('--allow-final-review')&&recoveryAllowed&&(!boundedWaiting||verificationRecoveryAuthorization===bounded.authorizationDigest)});
        if(boundedFailed)Object.assign(progress,{blocker:'fix_verification_recovery_used',requiresUser:true,
          nextAction:'本次有界验证续审已消耗；保留失败历史，不再放弃、续审或重建运行绕过。'});
        if(boundedWaiting&&verificationRecoveryAuthorization!==bounded.authorizationDigest)Object.assign(progress,{blocker:'fix_verification_recovery_authorization_required',requiresUser:true,
          nextAction:'重新启动原 run，显式传入 --verification-recovery-authorization 和本次准备记录摘要，并保留原审查权限；准备操作不授权派发。'});
        return {...status,progress};
      }
      if(request.operation==='prepare_test_type_correction')return owner.prepareTestTypeCorrection({authorized:extra.has('--allow-test-type-correction'),expected:request.expected,declaration:request.testTypeCorrection,previousInvocationStopped:request.previousInvocationStopped,reason:request.reason});
      if(request.operation==='prepare_command_correction')return owner.prepareCommandCorrection({authorized:extra.has('--allow-command-correction'),expected:request.expected,declaration:request.commandCorrection,previousInvocationStopped:request.previousInvocationStopped,reason:request.reason});
      if(request.operation==='prepare_verification_recovery')return owner.prepareVerificationRecovery({authorized:extra.has('--allow-verification-recovery'),sourceCorrectionAuthorized:extra.has('--allow-source-correction'),expected:request.expected,...(Object.hasOwn(request,'sourceCorrection')?{sourceCorrection:request.sourceCorrection}:{}),previousInvocationStopped:request.previousInvocationStopped,reason:request.reason});
      if(request.operation==='reconcile_review')return owner.reconcileReview({invocationId:request.invocationId});
      if(request.operation==='recover_final_review')return owner.recoverFinalReview({
        authorized:extra.has('--allow-final-review-recovery'),recoveryInvocationId,invocationId:request.invocationId,
        packageDigest:request.packageDigest,previousInvocationStopped:request.previousInvocationStopped,reason:request.reason});
      if(request.operation==='abandon_step')return owner.abandonStep({authorized:extra.has('--allow-abandon'),reason:request.reason});
      if(request.operation==='rerun_blocked_step')return owner.rerunBlockedStep({authorized:extra.has('--allow-rerun-blocked-step'),reason:request.reason});
      // Reviewer-invocation authority stays separate from local step abandonment.
      if(request.operation==='abandon_review')return owner.abandonReview({authorized:extra.has('--allow-abandon-review'),reason:request.reason});
      if(request.operation==='rediagnose')return owner.rediagnose({authorized:extra.has('--allow-rediagnosis'),reason:request.reason});
      if(request.operation==='completion_evidence')return owner.completionEvidence();
      if(request.operation==='finish')return owner.finish({authorized:extra.has('--allow-finish'),cooperative:true});
      if(request.operation==='author_tests')return owner.authorTests({authorized:extra.has('--allow-test-author')});
      if(request.operation==='repair')return owner.repair({authorized:extra.has('--allow-repair')});
      if(request.operation==='revision_test_check')return owner.runRevisionTests({authorized:extra.has('--allow-regression')});
      if(request.operation==='regression')return owner.runRegression({authorized:extra.has('--allow-regression')});
      if(request.operation==='retrospective')return owner.retrospect();
      if(request.operation==='learning_writeback')return owner.writeLearning({authorized:extra.has('--allow-learning-writeback')});
      if(request.operation==='handoff')return owner.createHandoff();
      if(request.operation==='final_review_package')return owner.finalReviewPackage();
      if(request.operation==='publish_review')return owner.publishReview();
      if(request.operation==='prepare_revision')return owner.prepareRevision({authorized:extra.has('--allow-repair'),...(Object.hasOwn(request,'tests')?{tests:request.tests}:{})});
      if(request.operation==='check_n5')return owner.checkCompletionGate();
      if(request.operation==='publish_dossier')return owner.publishDossier();
      if(request.operation==='walkthrough')return owner.runWalkthrough({authorized:extra.has('--allow-walkthrough')});
      if(request.operation==='post_review_regression')return owner.runRegression({authorized:extra.has('--allow-regression'),postReview:true});
      if(request.operation==='final_review'){
        const current=owner.status();
        if(!['final_review_required','revision_final_review_required'].includes(current.stage))return owner.reviewFinal({verificationRecoveryAuthorization});
        if(current.stage==='final_review_required'&&current.finalReviewRecovery){
          need(extra.has('--allow-final-review-recovery'),'fix_review_recovery_authorization_required');
          if(current.finalReviewRecoveryCount>1||recoveryInvocationId!==null)
            need(recoveryInvocationId===current.finalReviewRecovery.invocationId,'fix_review_recovery_authorization_required');
        }
        need(finalAuthority!==null,'review_configuration_required');
        const pkg=owner.finalReviewPackage();
        // Run transport timers before signing; reviewFinal rechecks the live package.
        await yieldHost();
        await finalAuthority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
        return owner.reviewFinal({verificationRecoveryAuthorization});
      }
      if(request.operation==='red_test')return owner.runRedTest({authorized:extra.has('--allow-red-test')});
      if(request.operation==='baseline')return owner.captureBaseline({authorized:extra.has('--allow-baseline')});
      if(request.operation==='cause_review_package')return owner.causeReviewPackage();
      if(request.operation==='cause_review'){
        if(!['cause_review_required','observation_cause_review_correction_required'].includes(owner.status().stage))return owner.reviewCause({verificationRecoveryAuthorization});
        need(authority!==null,'review_configuration_required');
        const pkg=owner.causeReviewPackage();
        await authority.hostDecisionProvider.decide({identity:config.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
        return owner.reviewCause({verificationRecoveryAuthorization});
      }
      if(request.operation==='cancel')return owner.cancel();
      if(request.operation==='advance'){
        need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');
        if(['reproduce','diagnose'].includes(owner.status().stage))startFixRun({specsRoot:fixArchiveRoot(config.specsRoot,config.reproduction.cwd),
          identity:config.identity,configuration:{reproduction:config.reproduction,...(config.specsRoot==null?{archiveMode:'bare'}:{}),...(runtime==='claude'?{runtime}:{}),...(reviewRuntime!==undefined?{reviewRuntime}:{})}});
        return owner.advance({authorized:true});
      }
      need(false,'fix_operation_unavailable');
    }};
  // In-process sequencing only; every step still uses the original dispatcher
  // and its independently supplied permissions. Unknown/blocked stages stop.
  host.run=async requestId=>{
    need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');
    if(config.qaSource)inspectFixQaSource({specsRoot:config.specsRoot,identity:config.identity,configuration:config});
    const actions={reproduce:'advance',diagnose:'advance',red_test_required:'red_test',design_change_required:'red_test',escalation_required:'finish',
      test_author_required:'author_tests',baseline_required:'baseline',repair_required:'repair',
      regression_required:'regression',handoff_required:'retrospective',learning_writeback_required:'learning_writeback',
      handoff_ready:'handoff',final_review_required:'final_review',final_review_evidence_required:'publish_review',
      completion_gate_required:'check_n5',post_review_regression_required:'post_review_regression',cause_review_required:'cause_review'};
    for(let step=0;step<32;step++){
      const before=owner.status();
      const operation=before.stage==='closeout_required'
        ?(config.walkthrough&&before.walkthrough?.status!=='passed'?'walkthrough':'finish'):actions[before.stage];
      if(!operation)return before;
      const result=await host.handle({requestId,operation});
      if(result?.observationRunEnded===true||result?.escalationRunEnded===true)return result;
      const after=owner.status();
      if(digest(after)===digest(before))return after;
    }
    need(false,'fix_sequence_limit');
  };
  return Object.freeze(host);
}
