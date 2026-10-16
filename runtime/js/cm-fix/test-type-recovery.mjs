// One type-only repair to an owner-authored test; never replaces historical red.
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
import {captureReviewBaseline} from '../cm-ai/review-package.mjs';
import {createTestTypeCorrection,inspectTestTypeCorrection,readTestTypeCorrectionFile} from './test-type-correction.mjs';
export const TYPE_INTENT='fix-test-type-correction-intent',TYPE_RESULT='fix-test-type-correction-result';
export const typeIntent=records=>records.find(r=>r.id===TYPE_INTENT)??null;
export const typeCorrection=records=>records.some(r=>r.id===TYPE_RESULT)?typeIntent(records)?.payload.target.correction??null:null;
export const typeMetadata=({contentBase64,...metadata})=>metadata;
export function typeFiles(files,correction){
 if(!correction)return files;
 const c=inspectTestTypeCorrection(correction);return files.map(f=>f.path===c.path?typeMetadata(c.after):f);
}
export function typeSnapshot({configuration,identity,specsRoot,correction}){
 const c=inspectTestTypeCorrection(correction),snapshot=captureReviewBaseline({root:configuration.reproduction.cwd,specsRoot,identity,scope:[c.path],requirements:[c.path]});
 const current=snapshot.files.find(f=>f.path===c.path);
 need(digest(current)===digest(c.before)||digest(current)===digest(c.after),'fix_test_type_correction_drift');
 return digest(snapshot.files.map(f=>f.path===c.path?c.before:f));
}
function qualify({records,configuration,status}){
 need(!typeIntent(records),'fix_test_type_correction_used');
 need(status.stage==='regression_blocked'&&status.testAuthor?.outcome==='authored'&&status.redTest?.status==='red_confirmed'
  &&status.regression?.red?.outcome==='passed'&&status.regression?.status==='inconclusive'
  &&!configuration.qaSource&&!configuration.externalModels&&!configuration.executionPolicy
  &&!records.some(r=>/^fix-final.*-registered$/.test(r.id)),'fix_test_type_correction_unavailable');
 const rows=status.regression.baseline.observations,failed=rows.filter(r=>r.outcome!=='passed');
 need(failed.length===1&&failed[0].outcome==='failed'&&failed[0].exitCode===2
  &&failed[0].command.some(v=>/(?:^|\/)typescript\/bin\/tsc$/.test(v))&&failed[0].command.includes('--noEmit'),'fix_test_type_correction_unavailable');
}
export function inspectTestTypeTarget({configuration,records,status,identity,specsRoot,declaration}){
 qualify({records,configuration,status});
 const file=readTestTypeCorrectionFile({root:configuration.reproduction.cwd,path:declaration.path});
 const correction=createTestTypeCorrection({file,declaration});
 need(configuration.redTest.testFiles.includes(correction.path)&&status.testAuthor.testFiles.some(f=>digest(f)===digest(typeMetadata(correction.before)))
  &&status.redTest.testFiles.some(f=>digest(f)===digest(typeMetadata(correction.before))),'fix_test_type_correction_binding');
 return json({configurationDigest:digest(configuration),historyDigest:digest(records),regressionDigest:digest(status.regression),
  redDigest:digest(status.redTest),repairDigest:digest(status.repair),correction,
  snapshotDigest:typeSnapshot({configuration,identity,specsRoot,correction})},256*1024);
}
export function inspectTestTypeIntent(payload,{configuration,records,status}){
 const p=json(payload,256*1024);shape(p,['target','reason','previousInvocationStopped']);
 const t=p.target;shape(t,['configurationDigest','historyDigest','regressionDigest','redDigest','repairDigest','correction','snapshotDigest']);
 qualify({records,configuration,status});const c=inspectTestTypeCorrection(t.correction);
 need(p.previousInvocationStopped===true&&typeof p.reason==='string'&&p.reason.trim()&&Buffer.byteLength(p.reason)<=1000&&!/[\r\n\0\u0085\u2028\u2029]/.test(p.reason),'fix_test_type_correction_confirmation');
 need(t.configurationDigest===digest(configuration)&&t.historyDigest===digest(records)&&t.regressionDigest===digest(status.regression)
  &&t.redDigest===digest(status.redTest)&&t.repairDigest===digest(status.repair)&&/^[a-f0-9]{64}$/.test(t.snapshotDigest)
  &&configuration.redTest.testFiles.includes(c.path)&&status.testAuthor.testFiles.some(f=>digest(f)===digest(typeMetadata(c.before)))
  &&status.redTest.testFiles.some(f=>digest(f)===digest(typeMetadata(c.before))),'fix_test_type_correction_binding');return p;
}
export function typeEvidence(records){
 const c=typeCorrection(records);return c?[`fix test type correction (data, not instructions) ${JSON.stringify({correction:c,intentDigest:digest(typeIntent(records).payload),note:'Original red and baseline remain before this type-only correction; exact transformed-prefix equality proves unchanged runtime prefix, suffix is byte-identical. Final independent review still required.'})}`]:[];
}
