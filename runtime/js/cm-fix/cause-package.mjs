// Root-cause evidence is not an implementation-review receipt or a completion grant.
import {readReviewSourceFiles,readReviewSourceRecords,readReviewPackage} from '../cm-ai/review-package.mjs';
import {digest,id,json,need,shape,text,validIdentity} from '../cm-ai/effect-contract.mjs';
import {inspectFixLearning} from './learning.mjs';
import {inspectFixInvestigation} from './investigation.mjs';
import {inspectVisualCarrier} from './visual.mjs';

export function createFixCausePackage({codeProject,defect,status}){
  need((status.stage==='cause_review_required'||status.stage==='observation_cause_review_correction_required'&&status.causeReviewCorrection)
    &&status.reproduction?.status==='reproduced'
    &&status.diagnosis!==null,'fix_cause_review_unavailable');
  const value=json({version:1,kind:'cm-fix-cause-review-package',identity:status.identity,defect,
    reproduction:status.reproduction,diagnosis:status.diagnosis,learning:status.learning,
    ...(status.causeReviewCorrection?{correction:status.causeReviewCorrection}:{}),
    files:readReviewSourceFiles(codeProject,status.diagnosis.affectedPaths)},4*1024*1024);
  return json({...value,packageDigest:digest(value)},4*1024*1024);
}

export function readFixCausePackage(raw){
  const value=json(raw,4*1024*1024);
  shape(value,['version','kind','identity','defect','reproduction','diagnosis','learning','files','packageDigest',
    ...(Object.hasOwn(value,'correction')?['correction']:[])]);
  if(value.correction){
    shape(value.correction,['reason','resumeDigest','historyDigest','resumeStage',
      ...(Object.hasOwn(value.correction,'repairPackage')?['repairPackage']:[]),
      ...(Object.hasOwn(value.correction,'handoffSha256')?['handoffSha256']:[]),
      ...(Object.hasOwn(value.correction,'finalReview')?['finalReview']:[])]);
    const reviewed=['completion_gate_required','post_review_regression_required','closeout_required'].includes(value.correction.resumeStage);
    need(reviewed===Object.hasOwn(value.correction,'finalReview'),'invalid_package');
    if(reviewed){
      const prior=value.correction.finalReview;shape(prior,['registrationDigest','observationDigest','providerThreadId']);id(prior.providerThreadId);
      need([prior.registrationDigest,prior.observationDigest].every(item=>typeof item==='string'&&/^[a-f0-9]{64}$/.test(item)),'invalid_package');
    }
    const handed=reviewed||value.correction.resumeStage==='final_review_required';
    need(handed===Object.hasOwn(value.correction,'handoffSha256'),'invalid_package');
    if(handed)need(typeof value.correction.handoffSha256==='string'&&/^[a-f0-9]{64}$/.test(value.correction.handoffSha256),'invalid_package');
    const afterRepair=reviewed||['regression_required','handoff_required','learning_writeback_required','handoff_ready','final_review_required'].includes(value.correction.resumeStage);
    need(afterRepair===Object.hasOwn(value.correction,'repairPackage'),'invalid_package');
    if(afterRepair)need(digest(readReviewPackage(value.correction.repairPackage).identity)===digest(value.identity),'invalid_package');
    need(value.correction.reason==='observation_cause_review_omitted'
      &&(reviewed||['red_test_required','baseline_required','repair_required','regression_required','handoff_required','learning_writeback_required','handoff_ready','final_review_required'].includes(value.correction.resumeStage))
      &&[value.correction.resumeDigest,value.correction.historyDigest].every(item=>typeof item==='string'&&/^[a-f0-9]{64}$/.test(item)),'invalid_package');
  }
  need(value.version===1&&value.kind==='cm-fix-cause-review-package','invalid_package');validIdentity(value.identity);text(value.defect);
  const {packageDigest,...body}=value;need(packageDigest===digest(body),'invalid_package');
  const files=readReviewSourceRecords(value.files),d=value.diagnosis,r=value.reproduction;
  shape(d,['status','rootCause','affectedPaths','plan','crossLayer','affectedModules',...(Object.hasOwn(d,'investigation')?['investigation']:[])]);
  need(['diagnosed','design_change'].includes(d.status)&&typeof d.crossLayer==='boolean','invalid_package');
  if(Object.hasOwn(d,'investigation'))inspectFixInvestigation(d.investigation,d.crossLayer);
  text(d.rootCause);text(d.plan);need(Array.isArray(d.affectedModules)&&d.affectedModules.length>0,'invalid_package');
  d.affectedModules.forEach(text);
  need(Array.isArray(d.affectedPaths)&&digest([...d.affectedPaths].sort())===digest(files.map(file=>file.path)),'invalid_package');
  shape(r,['status','next','observation']);need(r.status==='reproduced'&&r.next==='diagnose','invalid_package');
  const o=r.observation;
  if(o.kind==='visual'){
    shape(o,['kind','phase','carrier','environment','reason']);need(o.phase==='before','invalid_package');
    inspectVisualCarrier(o.carrier);text(o.reason);
  }else{
  shape(o,['id','command','outcome','exitCode','evidence','signatureMatched']);
  need(o.id==='reproduce'&&o.outcome==='failed'&&Number.isInteger(o.exitCode)&&o.exitCode>0&&o.exitCode<=255
    &&o.signatureMatched===true&&Array.isArray(o.command)&&o.command.length>0,'invalid_package');
  o.command.forEach(text);text(o.evidence);
  }
  if(value.learning!==null)inspectFixLearning(value.learning);
  return value;
}

export const causeReviewPaths=pkg=>pkg.files.map(file=>file.path);
