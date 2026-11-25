import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {recordPrdHostDisposition} from '../runtime/js/cm-prd/review-disposition.mjs';
import {createPrdCorrectionOwner,inspectPrdNarrowReview,recordPrdNarrowReviewHost} from '../runtime/js/cm-prd/review-correction.mjs';
import {claimPrdReview,recordPrdReview} from './cm-prd-review-gate.mjs';
import {narrowCorrectionBytes} from '../runtime/js/cm-prd/narrow-review.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';

const sha=content=>createHash('sha256').update(content).digest('hex');
const AUTHOR='author',FEATURE='1.guide',signal=()=>new AbortController().signal;
// Design-stage fixture: original r1 with finding R1, files saved with private permissions.
function fixture(t){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-narrow-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'.reviews'));
  const documents=[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
    {path:'design.md',content:'## 方案摘要\nDocumentation V1'}];
  const prepared=preparePrdReview({specs,stage:'design',feature:FEATURE,draft:{draftDigest:'a'.repeat(64),features:[{name:'guide',directory:FEATURE,documents}]}});
  claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
  publishPrdReview({specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:AUTHOR,
    response:{reviewer:'codex-subagent',contextId:'reviewer',independent:true,at:'2026-11-24T00:00:00.000Z',
      result:{verdict:'changes_requested',packageDigest:prepared.packageDigest,
        examinedPaths:documents.map(item=>`${FEATURE}/${item.path}`).sort(),
        findings:[{id:'R1',severity:'P2',path:`${FEATURE}/design.md`,message:'Clarify design',evidence:'Synthetic'}],summary:'Synthetic review'}}});
  fs.mkdirSync(path.join(specs,FEATURE));
  for(const item of documents)fs.writeFileSync(path.join(specs,FEATURE,item.path),item.content,{mode:0o600});
  return {specs,packageDigest:prepared.packageDigest,documents,designFile:path.join(specs,FEATURE,'design.md')};
}
const designSha=ctx=>sha(fs.readFileSync(ctx.designFile));
const finding=(id,{blocking=true}={})=>({id,severity:blocking?'major':'minor',security:false,dataLoss:false,silentFailure:false,
  violatesWrittenRule:false,scenario:blocking?'input X in state Y gives wrong Z':'',message:`Finding ${id}`});
// Original (single) correction: applies R1 to design.md, or escalates it with no change.
async function originalCorrection(ctx,{escalate=false}={}){
  const owner=createPrdCorrectionOwner({correct:async({documents})=>({
    documents:documents.map(doc=>({path:doc.path,content:doc.content+(!escalate&&doc.path.endsWith('design.md')?'\nV2':'')})),
    decisions:[{id:'R1',status:escalate?'escalated':'applied',evidence:['original'],changedPaths:escalate?[]:[`${FEATURE}/design.md`]}]})});
  const result=await owner({specs:ctx.specs,stage:'design',feature:FEATURE,writeEnabled:true},signal());
  assert.equal(result.status,'correction_saved');return result;
}
function narrowReview(ctx,round,{verdict,findings,session='narrow-reviewer',reviewer='codex-gpt-6.2-sol',independent=true,design=designSha(ctx),
  packageDigest=ctx.packageDigest,author=AUTHOR}){
  return recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest,authorContextId:author,writeEnabled:true,
    input:{round,designSha256:design,reviewer,sessionId:session,independent,at:'2026-11-24T01:00:00.000Z',verdict,summary:'Narrow review',findings}});
}
const changes=(ctx,round,ids=['N1'])=>narrowReview(ctx,round,{verdict:'changes_requested',findings:ids.map(id=>finding(id))});
const approved=(ctx,round)=>narrowReview(ctx,round,{verdict:'approved',findings:[finding('M1',{blocking:false})]});
let corrections=0;
// Narrow correction goes through the same owner/call path as the original one.
async function narrowCorrection(ctx,{ids=['N1'],suffix='V3'}={}){
  const owner=createPrdCorrectionOwner({correct:async({documents,review})=>{
    corrections++;assert.equal(review.narrowRound>=1,true);assert.deepEqual(review.findings.map(item=>item.id),ids);
    return {documents:documents.map(doc=>({path:doc.path,content:doc.content+(doc.path.endsWith('design.md')?`\n${suffix}`:'')})),
      decisions:ids.map(id=>({id,status:'applied',evidence:['narrow'],changedPaths:[`${FEATURE}/design.md`]}))};
  }});
  return owner({specs:ctx.specs,stage:'design',feature:FEATURE,writeEnabled:true},signal());
}
const disposition=(ctx,decisions=[{id:'R1',status:'applied',evidence:['original'],changedPaths:[`${FEATURE}/design.md`]}])=>recordPrdHostDisposition({
  specs:ctx.specs,stage:'design',feature:FEATURE,packageDigest:ctx.packageDigest,decisions,writeEnabled:true,
  artifacts:[{path:`${FEATURE}/requirements.md`,sha256:sha(fs.readFileSync(path.join(ctx.specs,FEATURE,'requirements.md')))},
    {path:`${FEATURE}/design.md`,sha256:designSha(ctx)}]});
const state=ctx=>inspectPrdNarrowReview({specs:ctx.specs,feature:FEATURE});

test('one narrow round: reviewed findings drive a correction that enters CM',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  const first=changes(ctx,1);assert.equal(first.phase.status,'awaiting_correction');assert.equal(first.next,'correct_findings');
  const saved=await narrowCorrection(ctx);
  assert.equal(saved.status,'correction_saved');assert.equal(saved.narrow,true);assert.equal(saved.round,1);
  assert.equal(saved.completionAuthorized,false);assert.equal(saved.phase.status,'awaiting_review');assert.equal(saved.phase.round,2);
  assert.match(fs.readFileSync(ctx.designFile,'utf8'),/V3/);
  const archive=fs.readFileSync(path.join(ctx.specs,saved.archive),'utf8');
  assert.match(archive,/narrowReviewDigest/);assert.match(archive,/"decisions"/);
  assert.equal(fs.lstatSync(path.join(ctx.specs,saved.archive)).mode&0o777,0o600);
  // Not reviewed yet: the original disposition must not accept the design.
  assert.throws(()=>disposition(ctx),/prd_narrow_review_pending/);
});

test('two rounds: N1 changes, correction, N2 approves, then the original disposition records',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  changes(ctx,1);await narrowCorrection(ctx);
  const second=approved(ctx,2);
  assert.equal(second.phase.status,'approved');assert.equal(second.verdict,'approved');
  assert.deepEqual(second.backlog.map(item=>item.id),['M1']);
  const recorded=disposition(ctx);assert.equal(recorded.status,'disposition_recorded');assert.equal(recorded.completionAuthorized,false);
  assert.equal(state(ctx).rounds.length,2);
});

test('a first narrow review that approves needs no correction',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);approved(ctx,1);
  assert.equal(disposition(ctx).status,'disposition_recorded');
});

test('third round is rejected: a correction after the second review, and a third review record',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  changes(ctx,1);await narrowCorrection(ctx);
  assert.throws(()=>narrowReview(ctx,3,{verdict:'approved',findings:[]}),/prd_narrow_round_limit/);
  changes(ctx,2,['N2']);
  assert.throws(()=>narrowReview(ctx,3,{verdict:'approved',findings:[]}),/prd_narrow_round_limit/);
  await assert.rejects(narrowCorrection(ctx,{ids:['N2']}),/prd_narrow_awaiting_user_decision/);
  assert.throws(()=>narrowReview(ctx,2,{verdict:'approved',findings:[]}),/prd_narrow_awaiting_user_decision/);
});

test('blocking findings after the second round stop for the user and never release automatically',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  changes(ctx,1);await narrowCorrection(ctx);
  const stopped=changes(ctx,2,['N2']);
  assert.equal(stopped.phase.status,'awaiting_user_decision');assert.equal(stopped.userDecisionRequired,true);
  assert.equal(stopped.autoReleaseAllowed,false);assert.equal(stopped.completionAuthorized,false);
  assert.equal(state(ctx).userDecisionRequired,true);
  assert.throws(()=>disposition(ctx),/prd_narrow_awaiting_user_decision/);
  assert.equal(fs.existsSync(path.join(ctx.specs,'.reviews/prd-guide-design-disposition.json')),false);
});

test('a correction without its review record is rejected, also a second one after a correction',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  const before=fs.readFileSync(ctx.designFile,'utf8');
  await assert.rejects(narrowCorrection(ctx),/prd_narrow_review_required/);
  assert.equal(fs.readFileSync(ctx.designFile,'utf8'),before);
  changes(ctx,1);await narrowCorrection(ctx);
  const corrected=fs.readFileSync(ctx.designFile,'utf8');
  // The corrected bytes have not been reviewed: asking again only replays the saved correction, never a new one.
  const calls=corrections,again=await narrowCorrection(ctx,{suffix:'V4'});
  assert.equal(again.status,'correction_saved');assert.equal(corrections,calls);
  assert.equal(fs.readFileSync(ctx.designFile,'utf8'),corrected);
  assert.equal(state(ctx).phase.status,'awaiting_review');
  const approvedCtx=fixture(t);await originalCorrection(approvedCtx);approved(approvedCtx,1);
  await assert.rejects(narrowCorrection(approvedCtx),/prd_narrow_already_approved/);
});

test('review records need independence, grading, scenario and the exact reviewed bytes',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  const args={verdict:'changes_requested',findings:[finding('N1')]};
  assert.throws(()=>narrowReview(ctx,1,{...args,session:AUTHOR}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,1,{...args,session:'resumed-host',author:'resumed-host'}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,1,{...args,reviewer:'self-degraded'}),/invalid_input|prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,1,{...args,independent:false}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,1,{...args,design:'b'.repeat(64)}),/prd_narrow_design_changed/);
  assert.throws(()=>narrowReview(ctx,1,{...args,packageDigest:'c'.repeat(64)}),/prd_narrow_package_changed/);
  assert.throws(()=>narrowReview(ctx,1,{verdict:'changes_requested',findings:[{...finding('N1'),scenario:' '}]}),/prd_narrow_blocking_scenario_required/);
  assert.throws(()=>narrowReview(ctx,1,{verdict:'approved',findings:[finding('N1')]}),/prd_narrow_verdict_findings_mismatch/);
  assert.throws(()=>narrowReview(ctx,1,{verdict:'changes_requested',findings:[finding('N1',{blocking:false})]}),/prd_narrow_verdict_findings_mismatch/);
  // Any yes on the four questions makes a minor finding blocking.
  assert.equal(narrowReview(ctx,1,{verdict:'changes_requested',findings:[{...finding('N1',{blocking:false}),dataLoss:true,scenario:'delete runs twice'}]}).phase.status,'awaiting_correction');
});

test('rounds cannot be skipped or repeated, and design drift is detected',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.throws(()=>changes(ctx,2),/prd_narrow_round_out_of_order/);
  changes(ctx,1);
  assert.throws(()=>changes(ctx,1),/prd_narrow_round_out_of_order/);
  assert.throws(()=>changes(ctx,2),/prd_narrow_round_out_of_order/);
  fs.appendFileSync(ctx.designFile,'\nUser edit');
  assert.throws(()=>state(ctx),/prd_narrow_design_changed/);
});

test('narrow review needs the saved original correction and the original package',async t=>{
  const ctx=fixture(t);
  assert.throws(()=>changes(ctx,1),/prd_narrow_requires_original_correction/);
  assert.equal(state(ctx).status,'narrow_not_started');
});

test('interrupted correction resumes from its archive without asking again',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);
  const saved=await narrowCorrection(ctx);const calls=corrections;
  const archive=JSON.parse(fs.readFileSync(path.join(ctx.specs,saved.archive),'utf8').match(/\n```json\n([^\n]+)\n```/)[1]);
  // Crash prefix: archive durable, design.md not yet replaced.
  fs.writeFileSync(ctx.designFile,archive.before.find(item=>item.path.endsWith('design.md')).content);
  assert.throws(()=>changes(ctx,2),/prd_narrow_round_out_of_order/);
  assert.equal(state(ctx).phase.status,'correction_incomplete');
  const resumed=await narrowCorrection(ctx);
  assert.equal(resumed.status,'correction_saved');assert.equal(corrections,calls);
  assert.match(fs.readFileSync(ctx.designFile,'utf8'),/V3/);
  assert.equal(state(ctx).phase.status,'awaiting_review');
});

test('an original correction that changed nothing still accepts the reviewed narrow changes',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx,{escalate:true});
  changes(ctx,1);await narrowCorrection(ctx);approved(ctx,2);
  const recorded=disposition(ctx,[{id:'R1',status:'escalated',evidence:['original'],changedPaths:[]}]);
  assert.equal(recorded.status,'disposition_recorded');
});

test('without any narrow round the original single-correction flow is unchanged',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.equal(disposition(ctx).status,'disposition_recorded');
});

test('narrow writes need the review-write switch',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.throws(()=>recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest:ctx.packageDigest,authorContextId:AUTHOR,
    writeEnabled:false,input:{round:1,designSha256:designSha(ctx),reviewer:'r',sessionId:'s',independent:true,at:'2026-11-24T01:00:00.000Z',
      verdict:'approved',summary:'x',findings:[]}}),/prd_narrow_not_enabled/);
});

test('original decisions cannot be flipped by unrelated narrow changes',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx,{escalate:true});
  changes(ctx,1);await narrowCorrection(ctx);approved(ctx,2);
  assert.throws(()=>disposition(ctx,[{id:'R1',status:'applied',evidence:['claimed'],changedPaths:[`${FEATURE}/design.md`]}]),/prd_narrow_disposition_decisions_changed/);
});
test('the original author context cannot sign a narrow review, and oversized records are refused',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.throws(()=>narrowReview(ctx,1,{verdict:'changes_requested',findings:[finding('N1')],session:AUTHOR,author:'other-host'}),/prd_narrow_reviewer_not_independent/);
  const big=Array.from({length:40},(_,i)=>({...finding(`N${i}`),message:'m'.repeat(1900),scenario:'s'.repeat(1900)}));
  assert.throws(()=>narrowReview(ctx,1,{verdict:'changes_requested',findings:big}),/prd_narrow_record_too_large/);
  assert.equal(state(ctx).phase.status,'awaiting_review');
});
test('a run whose original archive predates narrow rounds keeps the legacy flow',async t=>{
  const ctx=fixture(t);const saved=await originalCorrection(ctx);
  const file=path.join(ctx.specs,saved.archive),text=fs.readFileSync(file,'utf8');
  const legacy=text.replace(',"narrowReview":1}','}');assert.notEqual(legacy,text);
  fs.chmodSync(file,0o600);fs.writeFileSync(file,legacy,{mode:0o600});
  assert.throws(()=>changes(ctx,1),/prd_narrow_requires_original_correction/);
  const owner=createPrdCorrectionOwner({correct:async()=>{throw new Error('must not ask');}});
  assert.equal((await owner({specs:ctx.specs,stage:'design',feature:FEATURE,writeEnabled:true},signal())).status,'correction_recovery_required');
});

test('the legacy record entry cannot close a pending narrow round or rewrite the original decision counts',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx,{escalate:true});
  const args=(count,unresolved)=>({stage:'design',feature:'guide',evidence:path.join(ctx.specs,'.reviews/prd-guide-design-r1.md'),
    receipt:path.join(ctx.specs,'.reviews/prd-guide-design-disposition.json'),disposition:unresolved?'escalated':'applied',
    finding_count:count,unresolved_count:unresolved,artifact:[path.join(ctx.specs,FEATURE,'design.md')]});
  changes(ctx,1);
  assert.throws(()=>recordPrdReview(args(1,1)),/prd_narrow_review_pending|narrow_review_pending/);
  await narrowCorrection(ctx);approved(ctx,2);
  assert.throws(()=>recordPrdReview(args(1,0)),/prd_narrow_disposition_decisions_changed|decisions_changed/);
  assert.equal(fs.existsSync(args(1,1).receipt),false);
  assert.equal(recordPrdReview(args(1,1)).outcome,'recorded');
});
test('review_findings keeps its exact result shape for older sessions',async t=>{
  const ctx=fixture(t);assert.equal(Object.hasOwn(inspectPrdFindings({specs:ctx.specs,stage:'design',feature:FEATURE}),'authorContextId'),false);
});

test('the legacy record entry fails closed on missing, corrupt or unreadable narrow files',async t=>{
  const call=ctx=>recordPrdReview({stage:'design',feature:'guide',evidence:path.join(ctx.specs,'.reviews/prd-guide-design-r1.md'),
    receipt:path.join(ctx.specs,'.reviews/prd-guide-design-disposition.json'),disposition:'applied',finding_count:1,unresolved_count:0,
    artifact:[path.join(ctx.specs,FEATURE,'design.md')]});
  const refused=error=>/^prd_narrow_/.test(error.code)&&!error.message.includes(os.tmpdir());
  const reviews=ctx=>path.join(ctx.specs,'.reviews');
  // Only r2 remains (r1 lost), saying changes_requested.
  let ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);await narrowCorrection(ctx);changes(ctx,2,['N2']);
  fs.unlinkSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r1.json'));
  assert.throws(()=>call(ctx),error=>error.code==='prd_narrow_record_invalid');
  // Correction archive saved but r1 lost and r2 not yet written.
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);await narrowCorrection(ctx);
  fs.unlinkSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r1.json'));
  assert.throws(()=>call(ctx),error=>error.code==='prd_narrow_record_invalid');
  // r1 corrupt while r2 is a bare approved stub.
  ctx=fixture(t);await originalCorrection(ctx);
  fs.writeFileSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r1.json'),'{broken',{mode:0o600});
  fs.writeFileSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r2.json'),'{"verdict":"approved"}\n',{mode:0o600});
  assert.throws(()=>call(ctx),refused);
  // Valid r1 changes_requested, r2 only a bare approved stub.
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);
  fs.writeFileSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r2.json'),'{"verdict":"approved"}\n',{mode:0o600});
  assert.throws(()=>call(ctx),refused);
  // Corrupt original archive tail: fixed code, no raw SyntaxError or path.
  ctx=fixture(t);const saved=await originalCorrection(ctx);approved(ctx,1);
  const archive=path.join(ctx.specs,saved.archive);fs.writeFileSync(archive,fs.readFileSync(archive,'utf8').replace('"proposal":','"proposal":{'),{mode:0o600});
  assert.throws(()=>call(ctx),refused);
  // Unreadable record file.
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);
  fs.chmodSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r1.json'),0o000);
  assert.throws(()=>call(ctx),refused);
  fs.chmodSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r1.json'),0o600);
});

test('the chain validates archived narrow decisions and ignores nothing beyond its phase',async t=>{
  const call=ctx=>recordPrdReview({stage:'design',feature:'guide',evidence:path.join(ctx.specs,'.reviews/prd-guide-design-r1.md'),
    receipt:path.join(ctx.specs,'.reviews/prd-guide-design-disposition.json'),disposition:'applied',finding_count:1,unresolved_count:0,
    artifact:[path.join(ctx.specs,FEATURE,'design.md')]});
  // Tampered narrow correction decisions are caught by the host chain and the legacy entry alike.
  let ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);const saved=await narrowCorrection(ctx);
  const file=path.join(ctx.specs,saved.archive),value=JSON.parse(fs.readFileSync(file,'utf8').match(/\n```json\n([^\n]+)\n```/)[1]);
  value.proposal.decisions=[null];fs.writeFileSync(file,narrowCorrectionBytes(value),{mode:0o600});
  assert.throws(()=>approved(ctx,2),error=>error.code==='prd_narrow_record_invalid');
  assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_record_invalid');
  assert.throws(()=>call(ctx),error=>error.code==='prd_narrow_record_invalid');
  // A decision list that no longer covers the narrow finding ids is refused too.
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);const second=await narrowCorrection(ctx);
  const again=path.join(ctx.specs,second.archive),parsed=JSON.parse(fs.readFileSync(again,'utf8').match(/\n```json\n([^\n]+)\n```/)[1]);
  parsed.proposal.decisions[0].id='N9';fs.writeFileSync(again,narrowCorrectionBytes(parsed),{mode:0o600});
  assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_record_invalid');
  // r1 approved, r2 a dangling link: later rounds are never skipped.
  ctx=fixture(t);await originalCorrection(ctx);approved(ctx,1);
  fs.symlinkSync(path.join(ctx.specs,'missing'),path.join(ctx.specs,'.reviews/prd-guide-design-narrow-review-r2.json'));
  assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_record_invalid');
  assert.throws(()=>call(ctx),error=>error.code==='prd_narrow_record_invalid');
});

test('archived originals must match what the chain reviewed; later round names and dangling links are never ignored',async t=>{
  const reviews=ctx=>path.join(ctx.specs,'.reviews'),code=error=>error.code==='prd_narrow_record_invalid';
  const rewrite=(ctx,saved,edit)=>{const file=path.join(ctx.specs,saved.archive);
    const value=JSON.parse(fs.readFileSync(file,'utf8').match(/\n```json\n([^\n]+)\n```/)[1]);edit(value);
    fs.writeFileSync(file,narrowCorrectionBytes(value),{mode:0o600});};
  // before.design rewritten to the corrected bytes while the top-level hash still names the reviewed one.
  let ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);let saved=await narrowCorrection(ctx);
  rewrite(ctx,saved,value=>{const design=value.before.find(item=>item.path.endsWith('design.md')),after=value.proposal.documents.find(item=>item.path.endsWith('design.md'));
    design.content=after.content;design.sha256=value.afterSha256;value.proposal.decisions=[{id:'N1',status:'escalated',evidence:['claimed'],changedPaths:[]}];});
  assert.throws(()=>state(ctx),code);
  // requirements text inside the proposal changed.
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);saved=await narrowCorrection(ctx);
  rewrite(ctx,saved,value=>{value.proposal.documents.find(item=>item.path.endsWith('requirements.md')).content+='\nExtra requirement';});
  assert.throws(()=>state(ctx),code);
  // A third-round name beyond the limit, and a dangling correction link after an approved first round.
  ctx=fixture(t);await originalCorrection(ctx);approved(ctx,1);
  fs.symlinkSync(path.join(ctx.specs,'missing'),path.join(reviews(ctx),'prd-guide-design-narrow-review-r3.json'));
  assert.throws(()=>state(ctx),code);
  fs.unlinkSync(path.join(reviews(ctx),'prd-guide-design-narrow-review-r3.json'));
  fs.symlinkSync(path.join(ctx.specs,'missing'),path.join(reviews(ctx),'prd-guide-design-narrow-correction-r1.md'));
  assert.throws(()=>state(ctx),code);
  fs.unlinkSync(path.join(reviews(ctx),'prd-guide-design-narrow-correction-r1.md'));
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);await narrowCorrection(ctx);approved(ctx,2);
  fs.writeFileSync(path.join(reviews(ctx),'prd-guide-design-narrow-correction-r2.md'),'stray',{mode:0o600});
  assert.throws(()=>state(ctx),code);
});

test('a user edit of requirements.md blocks the narrow correction before anything is saved, and undoing it recovers',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);
  const requirements=path.join(ctx.specs,FEATURE,'requirements.md'),original=fs.readFileSync(requirements,'utf8'),calls=corrections;
  fs.writeFileSync(requirements,original+'\nUser edit',{mode:0o600});
  await assert.rejects(narrowCorrection(ctx),/prd_correction_inputs_changed/);
  assert.equal(corrections,calls);
  assert.equal(fs.existsSync(path.join(ctx.specs,'.reviews/prd-guide-design-narrow-correction-r1.md')),false);
  fs.writeFileSync(requirements,original,{mode:0o600});
  assert.equal((await narrowCorrection(ctx)).status,'correction_saved');
});

// Degraded round: the review model was unavailable and the author model reviewed. Evidence only, never releases.
const degradedReview=(ctx,round,{verdict,findings,reason='review model unavailable',session=AUTHOR,independent=false,design=designSha(ctx)})=>
  recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest:ctx.packageDigest,authorContextId:AUTHOR,writeEnabled:true,
    input:{round,designSha256:design,reviewer:'self-degraded',sessionId:session,independent,degradedReason:reason,at:'2026-11-24T03:00:00.000Z',
      verdict,summary:'Degraded narrow review',findings}});
test('a degraded approval is recorded but cannot release: it stops for the user',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  const recorded=degradedReview(ctx,1,{verdict:'approved',findings:[]});
  assert.equal(recorded.degradedReview,true);assert.equal(recorded.phase.status,'awaiting_user_decision');
  assert.equal(recorded.phase.reason,'degraded_review_only');assert.equal(recorded.userDecisionRequired,true);
  assert.equal(recorded.rounds[0].degraded,true);
  assert.throws(()=>disposition(ctx),/prd_narrow_awaiting_user_decision/);
  assert.throws(()=>recordPrdReview({stage:'design',feature:'guide',evidence:path.join(ctx.specs,'.reviews/prd-guide-design-r1.md'),
    receipt:path.join(ctx.specs,'.reviews/prd-guide-design-disposition.json'),disposition:'applied',finding_count:1,unresolved_count:0,
    artifact:[path.join(ctx.specs,FEATURE,'design.md')]}),/prd_narrow_review_pending/);
  assert.equal(recorded.independentFollowUpAllowed,true);
  await assert.rejects(narrowCorrection(ctx),/prd_narrow_awaiting_user_decision/);
});
test('a degraded round with findings still drives a correction, and an independent approval then releases',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.equal(degradedReview(ctx,1,{verdict:'changes_requested',findings:[finding('N1')]}).phase.status,'awaiting_correction');
  await narrowCorrection(ctx);
  assert.equal(approved(ctx,2).phase.status,'approved');
  assert.equal(disposition(ctx).status,'disposition_recorded');
  assert.equal(state(ctx).rounds[0].degraded,true);assert.equal(state(ctx).rounds[1].degraded,false);
});
test('degraded rounds count toward the two-round limit and need a reason, the author context and no independence claim',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  assert.throws(()=>degradedReview(ctx,1,{verdict:'approved',findings:[],reason:' '}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>degradedReview(ctx,1,{verdict:'approved',findings:[],session:'someone-else'}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>degradedReview(ctx,1,{verdict:'approved',findings:[],independent:true}),/prd_narrow_reviewer_not_independent/);
  // An independent claim cannot carry a degraded reason.
  assert.throws(()=>recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest:ctx.packageDigest,authorContextId:AUTHOR,
    writeEnabled:true,input:{round:1,designSha256:designSha(ctx),reviewer:'codex',sessionId:'r',independent:true,degradedReason:'x',
      at:'2026-11-24T03:00:00.000Z',verdict:'approved',summary:'s',findings:[]}}));
  degradedReview(ctx,1,{verdict:'changes_requested',findings:[finding('N1')]});await narrowCorrection(ctx);
  assert.equal(degradedReview(ctx,2,{verdict:'changes_requested',findings:[finding('N2')]}).phase.status,'awaiting_user_decision');
  assert.throws(()=>degradedReview(ctx,3,{verdict:'approved',findings:[]}),/prd_narrow_round_limit/);
});

test('a context that signed a degraded round cannot sign an independent one after a host change',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  // Another host (B) resumed and acted as the author for the degraded first round.
  recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest:ctx.packageDigest,authorContextId:'host-b',writeEnabled:true,
    input:{round:1,designSha256:designSha(ctx),reviewer:'self-degraded',sessionId:'host-b',independent:false,degradedReason:'review model unavailable',
      at:'2026-11-24T03:00:00.000Z',verdict:'changes_requested',summary:'Degraded',findings:[finding('N1')]}});
  await narrowCorrection(ctx);
  assert.throws(()=>narrowReview(ctx,2,{verdict:'approved',findings:[],session:'host-b',author:'host-c'}),/prd_narrow_reviewer_not_independent/);
  assert.equal(narrowReview(ctx,2,{verdict:'approved',findings:[],session:'real-reviewer',author:'host-c'}).phase.status,'approved');
});

test('after a degraded approval an independent follow-up on the same bytes can release',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);
  degradedReview(ctx,1,{verdict:'approved',findings:[]});
  assert.equal(state(ctx).next,'record_independent_narrow_review_r2');
  assert.throws(()=>degradedReview(ctx,2,{verdict:'approved',findings:[]}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,2,{verdict:'approved',findings:[],session:AUTHOR}),/prd_narrow_reviewer_not_independent/);
  assert.throws(()=>narrowReview(ctx,3,{verdict:'approved',findings:[]}),/prd_narrow_round_limit/);
  assert.throws(()=>narrowReview(ctx,1,{verdict:'approved',findings:[]}),/prd_narrow_round_out_of_order/);
  assert.equal(narrowReview(ctx,2,{verdict:'approved',findings:[]}).phase.status,'approved');
  assert.equal(disposition(ctx).status,'disposition_recorded');
  assert.equal(state(ctx).rounds[0].degraded,true);assert.equal(state(ctx).rounds[1].degraded,false);
});
test('an independent follow-up with blocking findings stops for the user, and a late degraded approval has no follow-up slot',async t=>{
  let ctx=fixture(t);await originalCorrection(ctx);
  degradedReview(ctx,1,{verdict:'approved',findings:[]});
  const stopped=narrowReview(ctx,2,{verdict:'changes_requested',findings:[finding('N2')]});
  assert.equal(stopped.phase.status,'awaiting_user_decision');assert.equal(stopped.independentFollowUpAllowed,false);
  assert.throws(()=>disposition(ctx),/prd_narrow_awaiting_user_decision/);
  ctx=fixture(t);await originalCorrection(ctx);changes(ctx,1);await narrowCorrection(ctx);
  const late=degradedReview(ctx,2,{verdict:'approved',findings:[]});
  assert.equal(late.independentFollowUpAllowed,false);
  assert.throws(()=>narrowReview(ctx,3,{verdict:'approved',findings:[]}),/prd_narrow_round_limit/);
  assert.throws(()=>disposition(ctx),/prd_narrow_awaiting_user_decision/);
});
test('the independent follow-up is chained to the degraded record',async t=>{
  const ctx=fixture(t);await originalCorrection(ctx);degradedReview(ctx,1,{verdict:'approved',findings:[]});narrowReview(ctx,2,{verdict:'approved',findings:[]});
  const file=path.join(ctx.specs,'.reviews/prd-guide-design-narrow-review-r1.json'),value=JSON.parse(fs.readFileSync(file,'utf8'));
  value.summary='Rewritten after the follow-up was signed';fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});
  assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_record_invalid');
});

test('read-back refuses an independent record that reuses a degraded or author context',async t=>{
  const tamper=(ctx,round,session)=>{const file=path.join(ctx.specs,`.reviews/prd-guide-design-narrow-review-r${round}.json`),value=JSON.parse(fs.readFileSync(file,'utf8'));
    value.sessionId=session;fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});};
  let ctx=fixture(t);await originalCorrection(ctx);degradedReview(ctx,1,{verdict:'approved',findings:[]});narrowReview(ctx,2,{verdict:'approved',findings:[]});
  tamper(ctx,2,AUTHOR);assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_reviewer_not_independent');
  assert.throws(()=>disposition(ctx));
  ctx=fixture(t);await originalCorrection(ctx);
  recordPrdNarrowReviewHost({specs:ctx.specs,feature:FEATURE,packageDigest:ctx.packageDigest,authorContextId:'host-b',writeEnabled:true,
    input:{round:1,designSha256:designSha(ctx),reviewer:'self-degraded',sessionId:'host-b',independent:false,degradedReason:'review model unavailable',
      at:'2026-11-24T03:00:00.000Z',verdict:'approved',summary:'Degraded',findings:[]}});
  narrowReview(ctx,2,{verdict:'approved',findings:[],session:'real-reviewer',author:'host-c'});
  tamper(ctx,2,'host-b');assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_reviewer_not_independent');
  // No degraded round at all: an independent record naming the original author is refused on read-back.
  ctx=fixture(t);await originalCorrection(ctx);approved(ctx,1);
  tamper(ctx,1,AUTHOR);assert.throws(()=>state(ctx),error=>error.code==='prd_narrow_reviewer_not_independent');
});
