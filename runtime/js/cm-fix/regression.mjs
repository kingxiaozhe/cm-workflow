// Post-repair command checks. The durable owner must register before calling;
// these observations do not grant repair authority or satisfy independent review.
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {createFixBaseline,inspectFixBaseline,fixBaselineFiles} from './baseline.mjs';
import {inspectFixRedTest,verifyFixRedEvidence} from './red-test.mjs';
import {digest,json,need,shape,validIdentity} from '../cm-ai/effect-contract.mjs';
import {inspectFixRepairReview} from './final-review.mjs';
import {inspectFixRegression,compareFixBaseline} from './regression-evidence.mjs';
export {inspectFixRegression,compareFixBaseline} from './regression-evidence.mjs';
import {isVisual,observeVisualAfter} from './visual.mjs';


export function createFixRegression(options,{specsRoot:protectedSpecsRoot=null,bridge=null}={}){
  shape(options,['identity','specsRoot','redTest','baseline','redEvidence','beforeBaseline',...(Object.hasOwn(options,'reviewFeedback')?['reviewFeedback']:[])]);
  const {identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline}=json(options);
  validIdentity(identity);
  const priorReview=Object.hasOwn(options,'reviewFeedback')?inspectFixRepairReview(options.reviewFeedback,identity):null;
  const redIdentity=priorReview&&redEvidence.output?.path===`.reviews/fix-${identity.taskId.slice(6)}-a1-red-output.md`?priorReview.identity:identity;
  const originalRed=inspectFixRedTest(redEvidence,redTest,redIdentity,redEvidence.testFiles);
  need(originalRed.status==='red_confirmed','red_test_not_confirmed');
  const originalBaseline=inspectFixBaseline(beforeBaseline,baseline,beforeBaseline.testFiles);
  need(originalBaseline.status==='recorded','baseline_unavailable');
  need(redTest.cwd===baseline.cwd,'baseline_project_mismatch');
  const redCheck=isVisual(redTest)?null:createHostCheck({cwd:redTest.cwd,commands:[{id:'red-test',command:redTest.command}],timeoutMs:redTest.timeoutMs,specsRoot:protectedSpecsRoot});
  const baselineCheck=createFixBaseline(baseline,{specsRoot:protectedSpecsRoot});let used=false;
  return async(request,{authorized,signal})=>{
    need(authorized===true,'regression_authorization_required');need(!used,'regression_already_attempted');
    need(digest(request.identity)===digest(identity),'identity_mismatch');need(!signal.aborted,'cancelled');
    verifyFixRedEvidence(originalRed,redTest,specsRoot);
    need(digest(fixBaselineFiles(baseline))===digest(originalBaseline.testFiles),'baseline_files_changed');
    used=true;
    const red=isVisual(redTest)?await observeVisualAfter(redTest,{bridge,signal,identity,specsRoot}):(await redCheck(request,{signal}))[0];
    // Collect the existing suites even if the target defect remains red.
    const after=await baselineCheck(request,{signal,authorized:true});
    verifyFixRedEvidence(originalRed,redTest,specsRoot);
    const comparison=compareFixBaseline(originalBaseline,after,baseline);
    const status=isVisual(redTest)?red.verdict==='BLOCKED'?'blocked':red.verdict==='FAIL'?'defect_remaining':comparison.status:
      red.outcome==='unavailable'?'blocked':red.outcome!=='passed'?'defect_remaining':comparison.status;
    return inspectFixRegression({status,red,baseline:after,comparison,completionEligible:false},{redTest,baseline,beforeBaseline:originalBaseline});
  };
}
