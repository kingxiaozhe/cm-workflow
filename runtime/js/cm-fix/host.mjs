// Shared original cm-fix action dispatch for standalone and parent hosts.
import {inspectFixQaSource} from './qa-source.mjs';
import {startFixRun} from './start.mjs';
import {digest,need,shape} from '../cm-ai/effect-contract.mjs';
import {fixArchiveRoot} from './layout.mjs';
import {fixProgress} from './progress.mjs';

export function createFixHost({owner,config,runtime='codex',permissions=[],authority=null,finalAuthority=null,recoveryInvocationId=null}){
  const extra=new Set(permissions);
    const host={async handle(request){
      shape(request,['requestId','operation',...(request.operation==='resume'?['evidenceFiles']:[]),
        ...(request.operation==='recover_final_review'?['invocationId','packageDigest','previousInvocationStopped','reason']:[])]);
      if(config.qaSource&&!['status','cancel','completion_evidence'].includes(request.operation))
        inspectFixQaSource({specsRoot:config.specsRoot,identity:config.identity,configuration:config});
      if(request.operation==='resume'){need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');return owner.resume({authorized:true,evidenceFiles:request.evidenceFiles});}
      if(request.operation==='status'){
        const status=owner.status();
        const recoveryAllowed=!status.finalReviewRecovery||extra.has('--allow-final-review-recovery')
          &&(status.finalReviewRecoveryCount<=1&&recoveryInvocationId===null
            ||recoveryInvocationId===status.finalReviewRecovery.invocationId);
        return {...status,progress:fixProgress(status,config,{finalReviewAllowed:finalAuthority!==null
          &&extra.has('--allow-final-review')&&recoveryAllowed})};
      }
      if(request.operation==='recover_final_review')return owner.recoverFinalReview({
        authorized:extra.has('--allow-final-review-recovery'),recoveryInvocationId,invocationId:request.invocationId,
        packageDigest:request.packageDigest,previousInvocationStopped:request.previousInvocationStopped,reason:request.reason});
      if(request.operation==='completion_evidence')return owner.completionEvidence();
      if(request.operation==='finish')return owner.finish({authorized:extra.has('--allow-finish')});
      if(request.operation==='author_tests')return owner.authorTests({authorized:extra.has('--allow-test-author')});
      if(request.operation==='repair')return owner.repair({authorized:extra.has('--allow-repair')});
      if(request.operation==='regression')return owner.runRegression({authorized:extra.has('--allow-regression')});
      if(request.operation==='retrospective')return owner.retrospect();
      if(request.operation==='learning_writeback')return owner.writeLearning({authorized:extra.has('--allow-learning-writeback')});
      if(request.operation==='handoff')return owner.createHandoff();
      if(request.operation==='final_review_package')return owner.finalReviewPackage();
      if(request.operation==='publish_review')return owner.publishReview();
      if(request.operation==='prepare_revision')return owner.prepareRevision({authorized:extra.has('--allow-repair')});
      if(request.operation==='check_n5')return owner.checkCompletionGate();
      if(request.operation==='publish_dossier')return owner.publishDossier();
      if(request.operation==='walkthrough')return owner.runWalkthrough({authorized:extra.has('--allow-walkthrough')});
      if(request.operation==='post_review_regression')return owner.runRegression({authorized:extra.has('--allow-regression'),postReview:true});
      if(request.operation==='final_review'){
        if(!['final_review_required','revision_final_review_required'].includes(owner.status().stage))return owner.reviewFinal();
        if(owner.status().stage==='final_review_required'&&owner.status().finalReviewRecovery){
          need(extra.has('--allow-final-review-recovery'),'fix_review_recovery_authorization_required');
          if(owner.status().finalReviewRecoveryCount>1||recoveryInvocationId!==null)
            need(recoveryInvocationId===owner.status().finalReviewRecovery.invocationId,'fix_review_recovery_authorization_required');
        }
        need(finalAuthority!==null,'review_configuration_required');
        const pkg=owner.finalReviewPackage();
        await finalAuthority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
        return owner.reviewFinal();
      }
      if(request.operation==='red_test')return owner.runRedTest({authorized:extra.has('--allow-red-test')});
      if(request.operation==='baseline')return owner.captureBaseline({authorized:extra.has('--allow-baseline')});
      if(request.operation==='cause_review_package')return owner.causeReviewPackage();
      if(request.operation==='cause_review'){
        if(!['cause_review_required','observation_cause_review_correction_required'].includes(owner.status().stage))return owner.reviewCause();
        need(authority!==null,'review_configuration_required');
        const pkg=owner.causeReviewPackage();
        await authority.hostDecisionProvider.decide({identity:config.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
        return owner.reviewCause();
      }
      if(request.operation==='cancel')return owner.cancel();
      if(request.operation==='advance'){
        need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');
        if(['reproduce','diagnose'].includes(owner.status().stage))startFixRun({specsRoot:fixArchiveRoot(config.specsRoot,config.reproduction.cwd),
          identity:config.identity,configuration:{reproduction:config.reproduction,...(config.specsRoot==null?{archiveMode:'bare'}:{}),...(runtime==='claude'?{runtime}:{})}});
        return owner.advance({authorized:true});
      }
      need(false,'fix_operation_unavailable');
    }};
  // In-process sequencing only; every step still uses the original dispatcher
  // and its independently supplied permissions. Unknown/blocked stages stop.
  host.run=async requestId=>{
    need(extra.has('--allow-reproduction'),'fix_execution_authorization_required');
    if(config.qaSource)inspectFixQaSource({specsRoot:config.specsRoot,identity:config.identity,configuration:config});
    const actions={reproduce:'advance',diagnose:'advance',red_test_required:'red_test',
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
      if(result?.observationRunEnded===true)return result;
      const after=owner.status();
      if(digest(after)===digest(before))return after;
    }
    need(false,'fix_sequence_limit');
  };
  return Object.freeze(host);
}
