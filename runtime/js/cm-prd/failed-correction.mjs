// Validate a failed, single correction check without re-entering the review gate.
import {createHash} from 'node:crypto';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {need,shape,digest,json} from '../cm-ai/effect-contract.mjs';
import {correctionCheckStore} from './correction-check.mjs';
import {inspectPrdDispositionPlan} from './disposition-plan.mjs';
import {checkPrdDraftMechanics,inspectPrdContextCheck} from './self-check.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function inspectPrdFailedCorrection({specs,receipt}){
  need(receipt.stage==='split','prd_failed_check_split_only');
  const proof=receipt.correction_check;
  need(proof&&typeof proof==='object','prd_failed_check_evidence_required');
  shape(proof,['input','resultDigest']);shape(proof.input,['draft','decisions','review']);
  const {draft,decisions,review}=proof.input,feature=review.feature;
  need(review.stage==='split'&&feature.replace(/^\d+\./,'')===receipt.feature
    &&review.gate.outcome==='resume_disposition','prd_failed_check_binding');
  const bytes=readCmInitSource(specs,`.reviews/${receipt.evidence}`);
  const line=bytes?.toString('utf8').match(/\n```json\n([^\n]+)\n```\n$/);
  need(line,'prd_failed_check_binding');
  const archive=JSON.parse(line[1]),pkg=archive.reviewPackage,result=archive.response?.result;
  need(archive.version===1&&pkg?.workflow==='cm-prd'&&pkg.stage==='split'&&pkg.feature===feature
    &&digest(pkg)===review.packageDigest&&review.gate.package_sha256===review.packageDigest
    &&pkg.draftDigest===review.draftDigest&&review.verdict!=='blocked'&&review.verdict===result?.verdict
    &&digest(pkg.artifacts)===digest(review.reviewedArtifacts)&&digest(result.findings)===digest(review.findings),
    'prd_failed_check_binding');
  const plan=inspectPrdDispositionPlan(review,decisions,receipt.artifacts);
  need(plan.changed.size>0&&receipt.finding_count===decisions.length&&receipt.unresolved_count===decisions.length,
    'prd_failed_check_binding');
  need(draft.draftDigest===digest(receipt.artifacts)&&draft.features.length===1
    &&draft.features[0].directory===feature&&draft.features[0].name===receipt.feature,'prd_failed_check_binding');
  const artifacts=draft.features[0].documents.map(doc=>({path:`${feature}/${doc.path}`,sha256:sha(Buffer.from(doc.content))}));
  need(digest(artifacts)===digest(receipt.artifacts),'prd_failed_check_binding');
  const mechanical=checkPrdDraftMechanics(draft);
  need(digest(mechanical)===digest(draft.mechanicalSelfCheck),'prd_failed_check_binding');
  const stored=correctionCheckStore({specs,feature,packageDigest:review.packageDigest,inputDigest:digest(proof.input)}).inspect();
  need(stored.status==='recorded','prd_failed_check_evidence_required');
  need(digest(stored.result)===proof.resultDigest,'prd_failed_check_result_changed');
  let failedChecks;
  if(stored.result.outcome==='mechanical_failed'){
    need(mechanical.status==='failed'&&digest(stored.result.result)===digest(mechanical),'prd_failed_check_not_failed');
    failedChecks=mechanical.findings;
  }else{
    need(mechanical.status==='mechanical_subset_passed','prd_failed_check_binding');
    const context=inspectPrdContextCheck(stored.result.result,draft);
    need(context.status==='failed','prd_failed_check_not_failed');
    failedChecks=context.features.flatMap(f=>f.checks.filter(c=>c.status==='failed').map(c=>({feature:f.directory,...c})));
  }
  return json({status:'failed',outcome:stored.result.outcome,failedChecks,decisions,
    independentReview:false,completionAuthorized:false});
}
