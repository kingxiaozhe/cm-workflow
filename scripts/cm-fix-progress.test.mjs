import test from 'node:test';
import assert from 'node:assert/strict';
import {fixProgress} from '../runtime/js/cm-fix/progress.mjs';

test('unconfirmed final review reports retained work and exact recovery binding without granting authority',()=>{
  const status={stage:'unknown',pending:'final_review',reproduction:{status:'reproduced'},diagnosis:{status:'diagnosed'},
    repair:{outcome:'repaired'},regression:{status:'passed'},handoff:{status:'ready_for_review'},
    retrospective:{content:{status:'no_new_lesson'}},
    finalReviewRecoveryCount:1,finalReviewInvocation:{invocationId:'latest-call',packageDigest:'a'.repeat(64),providerThreadId:'thread'},
    privateDiagnostic:'must-not-leak',completionEligible:false};
  const before=structuredClone(status),progress=fixProgress(status,{walkthrough:{}});
  assert.deepEqual(status,before);assert(progress.completed.includes('修后回归已通过'));
  assert.equal(progress.evidenceScope,'recorded_history_not_fresh_execution');
  assert.equal(progress.current,'独立审查结果未确认');assert.equal(progress.finished,false);
  assert(progress.completed.includes('经验复盘已记录'));
  assert.equal(progress.recovery.invocationId,'latest-call');assert.equal(progress.recovery.authorizationGranted,false);
  assert(progress.remaining.includes('走查'));assert.equal(progress.requiresUser,true);
  assert(!JSON.stringify(progress).includes('must-not-leak'));
});

test('approval, blocked state, cancellation and old completed history do not manufacture completion',()=>{
  const review={observationStatus:'completed',review:{verdict:'approved'}};
  assert.equal(fixProgress({stage:'completion_gate_required',finalReview:review}).finished,false);
  assert.equal(fixProgress({stage:'unknown',completionHistory:{status:'completed'}}).finished,false);
  assert.equal(fixProgress({stage:'cancelled'}).blocker,'cancelled');
  const drift=fixProgress({stage:'visual_evidence_required',regression:{status:'passed'}});
  assert.equal(drift.remaining,null);assert.equal(drift.requiresUser,true);assert.equal(drift.finished,false);
  assert.equal(fixProgress({stage:'completed',completionEligible:false}).finished,false);
  assert.deepEqual(fixProgress({stage:'completed',completionEligible:true}).remaining,[]);
  assert.equal(fixProgress({stage:'completed',completionEligible:true}).finished,true);
});

test('ready path is a projection, respects granted review permission and avoids old revision milestones',()=>{
  const running=fixProgress({stage:'unknown',pending:'final_review',executionActive:true});
  assert.equal(running.requiresUser,false);assert.equal(running.blocker,null);assert.equal(running.recovery,undefined);
  const stage={stage:'final_review_required'};
  assert.equal(fixProgress(stage).requiresUser,true);
  assert.equal(fixProgress(stage,{}, {finalReviewAllowed:true}).requiresUser,false);
  assert.equal(fixProgress(stage).nextAction,'final_review');
  const revision=fixProgress({stage:'revision_regression_required',revision:{},regression:{status:'passed'},
    finalReview:{observationStatus:'completed',review:{verdict:'approved'}}});
  assert(!revision.completed.includes('修后回归已通过'));assert(!revision.completed.includes('独立审查已批准'));
  assert.equal(fixProgress({stage:'closeout_required'}).nextAction,'finish');
  assert.equal(fixProgress({stage:'closeout_required'},{walkthrough:{}}).nextAction,'walkthrough');
});
