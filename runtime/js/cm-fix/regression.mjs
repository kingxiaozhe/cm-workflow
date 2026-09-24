// Post-repair command checks. The durable owner must register before calling;
// these observations do not grant repair authority or satisfy independent review.
import {currentTestFiles,verifyExtensionFiles,extensionConfig} from './test-extension.mjs';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {createFixBaseline,inspectFixBaseline,fixBaselineFiles} from './baseline.mjs';
import {inspectFixRedTest,verifyFixRedEvidence} from './red-test.mjs';
import {digest,json,need,shape,validIdentity} from '../cm-ai/effect-contract.mjs';
import {inspectFixRepairReview} from './final-review.mjs';
import {inspectFixRegression,compareFixBaseline} from './regression-evidence.mjs';
export {inspectFixRegression,compareFixBaseline} from './regression-evidence.mjs';
import {isVisual,observeVisualAfter} from './visual.mjs';


export function createFixRegression(options,{specsRoot:protectedSpecsRoot=null,bridge=null}={}){
  shape(options,['identity','specsRoot','redTest','baseline','redEvidence','beforeBaseline',...(Object.hasOwn(options,'reviewFeedback')?['reviewFeedback']:[]),...(Object.hasOwn(options,'testExtension')?['testExtension']:[])]);
  const {identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline}=json(options);
  validIdentity(identity);
  const priorReview=Object.hasOwn(options,'reviewFeedback')?inspectFixRepairReview(options.reviewFeedback,identity):null;
  const redIdentity=priorReview&&redEvidence.output?.path===`.reviews/fix-${identity.taskId.slice(6)}-a1-red-output.md`?priorReview.identity:identity;
  const originalRed=inspectFixRedTest(redEvidence,redTest,redIdentity,redEvidence.testFiles);
  need(originalRed.status==='red_confirmed','red_test_not_confirmed');
  const originalBaseline=inspectFixBaseline(beforeBaseline,baseline,beforeBaseline.testFiles);
  const extension=options.testExtension,comparisonBaseline={...originalBaseline,testFiles:currentTestFiles(originalBaseline.testFiles,extension)};
  need(originalBaseline.status==='recorded','baseline_unavailable');
  need(redTest.cwd===baseline.cwd,'baseline_project_mismatch');
  const redCheck=isVisual(redTest)?null:createHostCheck({cwd:redTest.cwd,commands:[{id:'red-test',command:redTest.command}],timeoutMs:redTest.timeoutMs,specsRoot:protectedSpecsRoot});
  const baselineCheck=createFixBaseline(baseline,{specsRoot:protectedSpecsRoot});let used=false;
  return async(request,{authorized,signal})=>{
    need(authorized===true,'regression_authorization_required');need(!used,'regression_already_attempted');
    need(digest(request.identity)===digest(identity),'identity_mismatch');need(!signal.aborted,'cancelled');
    verifyExtensionFiles(redTest.cwd,extension);
    verifyFixRedEvidence(originalRed,redTest,specsRoot,currentTestFiles(originalRed.testFiles,extension));
    need(digest(fixBaselineFiles(baseline))===digest(comparisonBaseline.testFiles),'baseline_files_changed');
    used=true;
    const red=isVisual(redTest)?await observeVisualAfter(redTest,{bridge,signal,identity,specsRoot}):(await redCheck(request,{signal}))[0];
    // Collect the existing suites even if the target defect remains red.
    const after=await baselineCheck(request,{signal,authorized:true});
    verifyExtensionFiles(redTest.cwd,extension);
    verifyFixRedEvidence(originalRed,redTest,specsRoot,currentTestFiles(originalRed.testFiles,extension));
    const comparison=compareFixBaseline(comparisonBaseline,after,baseline);
    const testExtension=extension?await createFixBaseline(extensionConfig({redTest},extension.plan),{specsRoot:protectedSpecsRoot})(request,{signal,authorized:true}):null;
    verifyExtensionFiles(redTest.cwd,extension);
    const status=testExtension&&testExtension.observations[0].outcome!=='passed'?(testExtension.status==='blocked'?'blocked':'defect_remaining'):isVisual(redTest)?red.verdict==='BLOCKED'?'blocked':red.verdict==='FAIL'?'defect_remaining':comparison.status:
      red.outcome==='unavailable'?'blocked':red.outcome!=='passed'?'defect_remaining':comparison.status;
    return inspectFixRegression({status,red,baseline:after,comparison,...(extension?{testExtension}:{}),completionEligible:false},{redTest,baseline,beforeBaseline:originalBaseline,testExtension:extension});
  };
}
