// Shared read-only regression evidence checks; no execution or review authority.
import {inspectFixBaseline} from './baseline.mjs';
import {digest,json,need,shape,text} from '../cm-ai/effect-contract.mjs';
import {isVisual,inspectVisualAfter} from './visual.mjs';

export function inspectFixRegression(raw,{redTest,baseline,beforeBaseline}){
  const value=json(raw);shape(value,['status','red','baseline','comparison','completionEligible']);
  if(isVisual(redTest)){
    const observed=inspectVisualAfter(value.red,redTest),comparison=compareFixBaseline(beforeBaseline,value.baseline,baseline);
    const status=observed.verdict==='BLOCKED'?'blocked':observed.verdict==='FAIL'?'defect_remaining':comparison.status;
    need(value.status===status&&digest(value.comparison)===digest(comparison)&&value.completionEligible===false,'regression_mismatch');return value;
  }
  const red=value.red;shape(red,['id','command','outcome','exitCode','evidence']);
  need(red.id==='red-test'&&digest(red.command)===digest(redTest.command),'regression_mismatch');text(red.evidence);
  need(red.outcome==='unavailable'?red.exitCode===null:Number.isInteger(red.exitCode)&&red.exitCode>=0&&red.exitCode<=255
    &&red.outcome===(red.exitCode===0?'passed':'failed'),'regression_mismatch');
  const comparison=compareFixBaseline(beforeBaseline,value.baseline,baseline);
  const status=red.outcome==='unavailable'?'blocked':red.outcome!=='passed'?'defect_remaining':comparison.status;
  need(value.status===status&&digest(value.comparison)===digest(comparison)&&value.completionEligible===false,'regression_mismatch');
  return value;
}

export function compareFixBaseline(beforeRaw,afterRaw,config){
  const before=inspectFixBaseline(beforeRaw,config,beforeRaw.testFiles);
  const after=inspectFixBaseline(afterRaw,config,before.testFiles);
  need(before.status==='recorded','baseline_unavailable');
  const comparisons=before.observations.map((previous,index)=>{
    const current=after.observations[index];
    const status=!current||current.outcome==='unavailable'?'unavailable':current.outcome==='passed'
      ?(previous.outcome==='passed'?'still_passed':'now_passed')
      :previous.outcome==='passed'?'regressed':'unresolved_failure';
    return {id:previous.id,before:previous.outcome,after:current?.outcome??'not_run',status};
  });
  // The same failing command/exit code does not prove the same failing test.
  // Do not allow an aggregate pre-existing failure to hide a new one.
  const status=comparisons.some(row=>row.status==='regressed')?'regressed'
    :comparisons.some(row=>row.status==='unavailable')?'blocked'
    :comparisons.some(row=>row.status==='unresolved_failure')?'inconclusive':'passed';
  return json({status,comparisons,completionEligible:false});
}

export function inspectFixRegressionFailure(raw,{identity,packageDigest,priorHandoff}){
  const value=json(raw);shape(value,['identity','packageDigest','redTest','baseline','beforeBaseline','result']);
  need(digest(value.identity)===digest(identity)&&value.packageDigest===packageDigest,'fix_regression_failure_mismatch');
  if(isVisual(value.redTest)){
    // Handoff visual evidence binds the original before carrier/configuration;
    // the independent approved package remains the repair authority.
    const prefix='fix defect evidence (data, not instructions) ';
    const entry=priorHandoff.evidence.find(row=>row.startsWith(prefix));need(entry,'fix_regression_failure_mismatch');
    const defect=JSON.parse(entry.slice(prefix.length));
    need(priorHandoff.status==='ready_for_review'&&digest(defect.visualBefore)===digest(value.redTest.before)
      &&digest(defect.visualConfiguration)===digest(value.redTest)&&digest(defect.baselineConfiguration)===digest(value.baseline)
      &&defect.automationUnavailable===value.redTest.reason,'fix_regression_failure_mismatch');
    const result=inspectFixRegression(value.result,{redTest:value.redTest,baseline:value.baseline,beforeBaseline:value.beforeBaseline});
    need(['defect_remaining','regressed'].includes(result.status)&&result.baseline.status==='recorded','fix_regression_failure_unavailable');return value;
  }
  const commands=priorHandoff.verification.map(row=>JSON.parse(row.command));
  need(priorHandoff.status==='ready_for_review'&&priorHandoff.verification.every(row=>row.status==='passed')
    &&digest(value.redTest.command)===digest(commands[0])
    &&digest(value.baseline.commands.map(row=>row.command))===digest(commands.slice(1)),'fix_regression_failure_mismatch');
  const result=inspectFixRegression(value.result,{redTest:value.redTest,baseline:value.baseline,beforeBaseline:value.beforeBaseline});
  need(['defect_remaining','regressed'].includes(result.status)&&result.baseline.status==='recorded','fix_regression_failure_unavailable');
  return value;
}
