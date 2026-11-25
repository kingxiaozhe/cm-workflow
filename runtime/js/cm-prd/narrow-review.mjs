// Design-stage narrow review rounds after the single original correction.
// Evidence only: it never dispatches a reviewer, approves a spec or completes a gate.
// Chain per original package: original correction archive -> N1 -> (C1) -> N2.
// Every correction needs the recorded review it answers; a correction is never the
// last step, so no unreviewed bytes reach the original disposition (2026-11-24: the
// third design version after a narrow review could not enter CM).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {writeImmutableWorkflowFile} from '../cm-ai/review-evidence-file.mjs';
import {need,json,shape,digest,id} from '../cm-ai/effect-contract.mjs';
import {inspectPrdDispositionPlan} from './disposition-plan.mjs';

export const PRD_NARROW_MAX_ROUNDS=2;
const PRD_NARROW_SCAN_ROUNDS=8; // stray files of any later round name are refused, not ignored
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const FLAGS=['security','dataLoss','silentFailure','violatesWrittenRule'];
const SEVERITIES=['blocker','major','minor'];
const FINDING_KEYS=['id','severity',...FLAGS,'scenario','message'];
const REVIEW_KEYS=['version','kind','feature','packageDigest','round','priorDigest','designSha256','reviewer','sessionId',
  'independent','at','verdict','summary','findings'];
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function narrowNames(feature){
  const name=feature.replace(/^\d+\./,'');
  return {review:round=>`prd-${name}-design-narrow-review-r${round}.json`,
    correction:round=>`prd-${name}-design-narrow-correction-r${round}.md`};
}
// Reviewer's grade plus four yes/no answers decide blocking; the author cannot reclassify.
export const isBlockingNarrowFinding=item=>item.severity!=='minor'||FLAGS.some(flag=>item[flag]===true);

const permissions=file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_narrow_file_permissions');
function readFileBytes(specs,name){
  const bytes=readCmInitSource(specs,`.reviews/${name}`);
  if(bytes===null)return null;permissions(path.join(specs,'.reviews',name));return bytes;
}
// Any unexpected read failure (dangling link, unreadable file) becomes the fixed invalid-record code.
const guarded=read=>(...args)=>{try{return read(...args);}catch(error){
  throw typeof error?.code==='string'&&error.code.startsWith('prd_narrow_')?error:Object.assign(new Error('prd_narrow_record_invalid'),{code:'prd_narrow_record_invalid'});}};
const readReview=guarded(function readReview(specs,name){
  const bytes=readFileBytes(specs,name);if(bytes===null)return null;
  const value=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)),128*1024);
  need(Buffer.from(JSON.stringify(value)+'\n').equals(bytes),'prd_narrow_record_invalid');return value;
});

export function narrowCorrectionBytes(value){
  return Buffer.from('# Narrow design review correction\n\nNot review approval or completion. Private host-attested material.\n```json\n'
    +JSON.stringify(value)+'\n```\n');
}
const readCorrection=guarded(function readCorrection(specs,name){
  const bytes=readFileBytes(specs,name);if(bytes===null)return null;
  const match=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).match(/\n```json\n([^\n]+)\n```\n$/);
  need(match,'prd_narrow_record_invalid');
  const value=json(JSON.parse(match[1]),256*1024);need(narrowCorrectionBytes(value).equals(bytes),'prd_narrow_record_invalid');
  return {value,bytes};
});

function validateFindings(findings){
  need(Array.isArray(findings)&&findings.length<=60,'prd_narrow_findings_invalid');const ids=new Set();
  for(const item of findings){
    shape(item,FINDING_KEYS);
    need(typeof item.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(item.id)&&!ids.has(item.id),'prd_narrow_findings_invalid');ids.add(item.id);
    need(SEVERITIES.includes(item.severity)&&FLAGS.every(flag=>typeof item[flag]==='boolean'),'prd_narrow_findings_invalid');
    need(typeof item.message==='string'&&item.message.trim()&&item.message.length<=2000&&typeof item.scenario==='string'
      &&item.scenario.length<=2000,'prd_narrow_findings_invalid');
    // A blocking finding must name the concrete trigger; without one it is a suggestion.
    need(!isBlockingNarrowFinding(item)||item.scenario.trim(),'prd_narrow_blocking_scenario_required');
  }
  return findings;
}

function validateReviewRecord(value,{feature,packageDigest,round,priorDigest,designSha}){
  const degraded=value?.reviewer==='self-degraded';
  shape(value,degraded?[...REVIEW_KEYS,'degradedReason']:REVIEW_KEYS);
  need(value.version===1&&value.kind==='prd_design_narrow_review'&&value.feature===feature&&value.packageDigest===packageDigest
    &&value.round===round&&value.priorDigest===priorDigest&&value.designSha256===designSha,'prd_narrow_record_invalid');
  // A degraded round (the review model was unavailable, the author model reviewed) is evidence only: it declares
  // itself, carries the reason, and can never be the approving round (see inspectPrdNarrowState).
  need(typeof value.reviewer==='string'&&value.reviewer.trim()&&(degraded?value.independent===false
    &&typeof value.degradedReason==='string'&&value.degradedReason.trim()&&value.degradedReason.length<=1000:value.independent===true),
    'prd_narrow_reviewer_not_independent');
  id(value.sessionId);
  need(typeof value.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.at)&&!Number.isNaN(Date.parse(value.at)),'prd_narrow_record_invalid');
  need(typeof value.summary==='string'&&value.summary.trim()&&value.summary.length<=4000,'prd_narrow_record_invalid');
  validateFindings(value.findings);
  const blocking=value.findings.filter(isBlockingNarrowFinding).length;
  need(value.verdict==='approved'?blocking===0:value.verdict==='changes_requested'&&blocking>0,'prd_narrow_verdict_findings_mismatch');
  return value;
}

// base: {designSha256 (design.md after the original correction), originalDesignSha256, archiveSha256}.
export function inspectPrdNarrowState({specs,feature,packageDigest,base,currentDesignSha256}){
  need(hex(packageDigest)&&hex(base.designSha256)&&hex(base.archiveSha256)&&hex(base.requirementsSha256)&&hex(currentDesignSha256),'prd_narrow_binding_invalid');
  const names=narrowNames(feature),rounds=[];let tip=base.designSha256,prior=base.archiveSha256,phase=null,last=null;
  for(let round=1;round<=PRD_NARROW_MAX_ROUNDS;round++){
    const review=readReview(specs,names.review(round)),correction=readCorrection(specs,names.correction(round));
    if(review===null){need(correction===null,'prd_narrow_record_invalid');phase={status:'awaiting_review',round};break;}
    validateReviewRecord(review,{feature,packageDigest,round,priorDigest:prior,designSha:tip});
    const row={round,review,reviewDigest:digest(review),correction:null};rounds.push(row);
    if(review.verdict==='approved'){
      need(correction===null,'prd_narrow_record_invalid');
      // Only an independent approval releases the design; a degraded one stops for the user.
      phase=review.reviewer==='self-degraded'?{status:'awaiting_user_decision',round,reason:'degraded_review_only'}:{status:'approved',round};break;
    }
    if(round===PRD_NARROW_MAX_ROUNDS){
      need(correction===null,'prd_narrow_record_invalid');phase={status:'awaiting_user_decision',round};break;
    }
    if(correction===null){phase={status:'awaiting_correction',round};break;}
    const value=correction.value;
    shape(value,['version','kind','feature','packageDigest','round','narrowReviewDigest','beforeSha256','afterSha256','before','proposal']);
    need(value.version===1&&value.kind==='prd_design_narrow_correction'&&value.feature===feature&&value.packageDigest===packageDigest
      &&value.round===round&&value.narrowReviewDigest===row.reviewDigest&&value.beforeSha256===tip&&hex(value.afterSha256)
      &&Array.isArray(value.before),'prd_narrow_record_invalid');
    // The archived per-finding decisions must still satisfy the same plan rules as when they were saved.
    const design=`${feature}/design.md`;
    try{
      const proposed=value.proposal;shape(proposed,['decisions','documents']);need(Array.isArray(proposed.documents),'x');
      const requirements=`${feature}/requirements.md`,after=proposed.documents.find(item=>item.path===design);
      // The archived originals must be exactly what the chain reviewed: this round's design tip and the unchanged requirements.
      need(value.before.length===2&&proposed.documents.length===2,'x');
      const beforeDesign=value.before.find(item=>item.path===design),beforeRequirements=value.before.find(item=>item.path===requirements);
      need(beforeDesign&&beforeRequirements&&beforeDesign.sha256===tip&&sha(Buffer.from(beforeDesign.content))===tip
        &&beforeRequirements.sha256===base.requirementsSha256&&sha(Buffer.from(beforeRequirements.content))===base.requirementsSha256,'x');
      const requirementsAfter=proposed.documents.find(item=>item.path===requirements);
      need(requirementsAfter&&sha(Buffer.from(requirementsAfter.content))===base.requirementsSha256,'x');
      const doc=after;need(doc&&sha(Buffer.from(doc.content))===value.afterSha256,'x');
      inspectPrdDispositionPlan({stage:'design',feature,findings:review.findings,
        reviewedArtifacts:value.before.map(item=>({path:item.path,sha256:item.sha256}))},proposed.decisions,
        value.before.map(item=>({path:item.path,sha256:item.path===design?value.afterSha256:item.sha256})));
    }catch{need(false,'prd_narrow_record_invalid');}
    row.correction=value;last=value;tip=value.afterSha256;prior=sha(correction.bytes);
  }
  // Nothing may exist beyond the chain's current phase (a dangling or stray later round is never ignored).
  const exists=name=>{try{fs.lstatSync(path.join(specs,'.reviews',name));return true;}catch(error){if(error.code==='ENOENT')return false;return true;}};
  for(let round=1;round<=PRD_NARROW_SCAN_ROUNDS;round++){
    need(round<=rounds.length||!exists(names.review(round)),'prd_narrow_record_invalid');
    need(rounds[round-1]?.correction||!exists(names.correction(round)),'prd_narrow_record_invalid');
  }
  if(currentDesignSha256!==tip){
    // Only a crash between the durable archive and the design write may differ, and
    // only before the next review exists.
    if(phase.status==='awaiting_review'&&last!==null&&phase.round===last.round+1&&currentDesignSha256===last.beforeSha256)
      phase={status:'correction_incomplete',round:last.round};
    else need(false,rounds.length===0&&currentDesignSha256===base.originalDesignSha256&&base.originalDesignSha256!==base.designSha256
      ?'prd_narrow_original_correction_incomplete':'prd_narrow_design_changed');
  }
  return {feature,packageDigest,phase,rounds,tipDesignSha256:tip,priorDigest:prior,currentDesignSha256};
}

export function narrowPublicState(state){
  const nextByPhase={awaiting_review:`record_narrow_review_r${state.phase.round}`,awaiting_correction:'correct_findings',
    correction_incomplete:'correct_findings',approved:'review_disposition',awaiting_user_decision:'user_decision_required'};
  return {status:'narrow_state',feature:state.feature,packageDigest:state.packageDigest,maxRounds:PRD_NARROW_MAX_ROUNDS,
    phase:state.phase,designSha256:state.currentDesignSha256,
    rounds:state.rounds.map(({round,review,reviewDigest,correction})=>({round,verdict:review.verdict,reviewer:review.reviewer,
      sessionId:review.sessionId,reviewDigest,findingCount:review.findings.length,
      blockingCount:review.findings.filter(isBlockingNarrowFinding).length,corrected:correction!==null,
      degraded:review.reviewer==='self-degraded'})),
    next:nextByPhase[state.phase.status],userDecisionRequired:state.phase.status==='awaiting_user_decision',
    autoReleaseAllowed:false,completionAuthorized:false};
}

// The caller (review-correction) supplies the original-correction base and the
// current design bytes; this writes exactly one new round record, never overwrites.
export function recordPrdNarrowReview({specs,feature,packageDigest,state,input,authorContextId,originalAuthorContextId,writeEnabled}){
  need(writeEnabled===true,'prd_narrow_not_enabled');
  need(typeof authorContextId==='string','prd_review_host_context_required');
  const degraded=input?.reviewer==='self-degraded';
  shape(input,['round','designSha256','reviewer','sessionId','independent','at','verdict','summary','findings',...(degraded?['degradedReason']:[])]);
  need(Number.isInteger(input.round)&&input.round>=1,'prd_narrow_round_invalid');
  need(input.round<=PRD_NARROW_MAX_ROUNDS,'prd_narrow_round_limit');
  const status=state.phase.status;
  need(status!=='awaiting_user_decision','prd_narrow_awaiting_user_decision');
  need(status!=='approved','prd_narrow_already_approved');
  need(status==='awaiting_review'&&state.phase.round===input.round,'prd_narrow_round_out_of_order');
  need(input.designSha256===state.currentDesignSha256,'prd_narrow_design_changed');
  // Degraded: the author context itself reviews, so it must declare exactly that context.
  need(degraded?input.sessionId===authorContextId:input.sessionId!==authorContextId&&input.sessionId!==originalAuthorContextId,'prd_narrow_reviewer_not_independent');
  // A context that already signed a degraded (author-model) round can never later sign an independent one, whatever host resumed.
  need(degraded||!state.rounds.some(row=>row.review.reviewer==='self-degraded'&&row.review.sessionId===input.sessionId),
    'prd_narrow_reviewer_not_independent');
  const value=validateReviewRecord({version:1,kind:'prd_design_narrow_review',feature,packageDigest,round:input.round,
    priorDigest:state.priorDigest,designSha256:input.designSha256,reviewer:input.reviewer,sessionId:input.sessionId,
    independent:input.independent,...(degraded?{degradedReason:input.degradedReason}:{}),at:input.at,verdict:input.verdict,summary:input.summary,findings:input.findings},
    {feature,packageDigest,round:input.round,priorDigest:state.priorDigest,designSha:state.currentDesignSha256});
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  // The reader accepts at most 128 KiB; never write a record the host cannot read back.
  need(bytes.length<=96*1024,'prd_narrow_record_too_large');
  writeImmutableWorkflowFile({reviewsDir:path.join(specs,'.reviews'),name:narrowNames(feature).review(input.round),
    bytes,validate:permissions,exclusive:true});
  return value;
}
