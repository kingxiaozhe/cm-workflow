import {assertPrdBatchActive} from './inputs-replaced.mjs';
// Current host proposes a correction; only the owner writes reviewed spec paths.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {inspectPrdFindings,readPrdReviewAuthor} from './review-findings.mjs';
import {inspectPrdDispositionPlan} from './disposition-plan.mjs';
import {checkPrdDraftMechanics} from './self-check.mjs';
import {prdTaskScopeOptions} from './task-scope-record.mjs';
import {inspectPrdDesignDraft} from './draft.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
import {inspectPrdNarrowState,narrowPublicState,narrowNames,narrowCorrectionBytes,recordPrdNarrowReview,
  PRD_NARROW_MAX_ROUNDS} from './narrow-review.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archiveBytes=value=>Buffer.from('# Original review correction proposal\n\nNot review approval or completion. Private host-attested material.\n```json\n'
  +JSON.stringify(value)+'\n```\n');
function readCorrectionFile(specs,file){
  const bytes=readCmInitSource(specs,file);
  need(bytes!==null&&(fs.lstatSync(path.join(specs,file)).mode&0o777)===0o600,'prd_correction_file_invalid');return bytes;
}
function inspectProposal(specs,review,proposal){
  shape(proposal,['decisions','documents']);need(Array.isArray(proposal.documents),'prd_correction_documents_invalid');
  const after=proposal.documents.map(doc=>{
    shape(doc,['path','content']);need(typeof doc.content==='string'&&doc.content.trim(),'prd_correction_content_invalid');
    const bytes=Buffer.from(doc.content);need(bytes.toString('utf8')===doc.content,'prd_correction_encoding_invalid');
    return {path:doc.path,sha256:sha(bytes)};
  });
  const plan=inspectPrdDispositionPlan(review,proposal.decisions,after),feature=review.feature;
  const documents=proposal.documents.map(doc=>({path:doc.path.slice(feature.length+1),content:doc.content}));
  const name=feature.replace(/^\d+\./,'');
  if(review.stage==='design'&&documents.length===2){
    // Original Step 9.5 precedes tasks. Validate the exact design pair, not a fake triad.
    inspectPrdDesignDraft({status:'design',summary:'Original design correction',features:[{name,documents}]},
      {nextIndex:Number(feature.split('.')[0])});
  }else{
    const mechanics=checkPrdDraftMechanics({draftDigest:digest(after),features:[{directory:feature,name,documents}]},
      prdTaskScopeOptions(specs,feature));
    need(mechanics.status==='mechanical_subset_passed','prd_correction_mechanics_failed');
  }
  return {after,plan};
}

export function createPrdCorrectionOwner({correct}){
  need(typeof correct==='function','prd_correction_host_required');const attempts=new Set();
  return async({specs,stage,feature,writeEnabled},signal)=>{
    assertPrdBatchActive(specs,[feature]);
    need(writeEnabled===true&&!signal.aborted,'prd_correction_not_enabled');
    const review=inspectPrdFindings({specs,stage,feature});
    const evidenceHash=sha(readCmInitSource(specs,review.evidence));
    need(review.gate.outcome==='resume_disposition'&&review.verdict!=='blocked'&&review.findings.length>0,
      'prd_correction_not_ready');
    const archiveName=`prd-${feature.replace(/^\d+\./,'')}-${stage}-correction.md`;
    if(readCmInitSource(specs,`.reviews/${archiveName}`)!==null){
      // Design only: the saved original correction continues through recorded narrow review rounds.
      if(stage==='design'&&prdNarrowCorrectionFlow({specs,stage,feature}))
        return narrowCorrection({specs,feature,correct,attempts,signal});
      return json({status:'correction_recovery_required',
        archive:`.reviews/${archiveName}`,next:'inspect_original_correction_archive_without_regeneration',completionAuthorized:false});
    }
    const read=file=>readCorrectionFile(specs,file);
    const before=review.reviewedArtifacts.map(item=>{
      const bytes=read(item.path);need(sha(bytes)===item.sha256,'prd_correction_inputs_changed');
      return {...item,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    });
    const key=digest({specs,packageDigest:review.packageDigest});
    need(!attempts.has(key),'prd_correction_already_attempted');attempts.add(key);
    const proposal=json(await correct(json({review,documents:before,
      instructions:'Resolve only these original findings. Return {decisions:[{id,status:applied|escalated,evidence:[reason],changedPaths:[path]}],documents:[{path,content}]} with the complete unchanged path inventory. Escalate disagreement or unprovable changes; do not invent human approval. design may change design.md only. Do not write files, change task status, add/remove files, call another reviewer/provider or retry. Corrected split specs will go through the original self-check.'}),signal),256*1024);
    need(!signal.aborted,'cancelled');const {after,plan}=inspectProposal(specs,review,proposal);
    const current=()=>{
      const latest=inspectPrdFindings({specs,stage,feature});
      need(latest.packageDigest===review.packageDigest&&latest.gate.outcome==='resume_disposition'
        &&sha(readCmInitSource(specs,review.evidence))===evidenceHash,'prd_correction_review_changed');
      for(const item of before)need(sha(read(item.path))===item.sha256,'prd_correction_inputs_changed');
    };
    current();
    // design archives written by this version opt the run into narrow review rounds; older archives stay legacy
    const archive=archiveBytes({version:1,packageDigest:review.packageDigest,stage,feature,before,proposal,...(stage==='design'?{narrowReview:1}:{})});
    // Archive original bytes and per-finding decisions before replacing any spec.
    writeReviewEvidence({reviewsDir:path.join(specs,'.reviews'),name:archiveName,bytes:archive,
      validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_correction_archive_permissions')});
    return writeCorrection({specs,review,proposal,after,plan,before,current,archiveName},signal);
  };
}

function writeCorrection({specs,review,proposal,after,plan,before,current,archiveName},signal){
    const written=[];
    try{
      for(const doc of proposal.documents){
        if(!plan.changed.has(doc.path))continue;
        if(before.find(item=>item.path===doc.path).sha256===after.find(item=>item.path===doc.path).sha256)continue;
        need(!signal.aborted,'cancelled');current();
        replacePrdDocument({specs,relative:doc.path,content:doc.content,current});
        const item=before.find(item=>item.path===doc.path);item.sha256=sha(Buffer.from(doc.content));
        written.push(doc.path);
      }
      current();
      return json({status:'correction_saved',packageDigest:review.packageDigest,decisions:plan.decisions,artifacts:after,
        archive:`.reviews/${archiveName}`,next:review.gate.outcome==='completed'?'inspect_existing_disposition':
          'run_original_self_check_and_disposition',completionAuthorized:false});
    }catch{return json({status:'correction_save_unknown',archive:`.reviews/${archiveName}`,observedWritten:written,
      next:'inspect_original_correction_archive_without_regeneration',completionAuthorized:false});}
}

// Filesystem operation only. The calling owner must bind scope, versions and
// authorization in current(), and archive the original bytes before invoking.
export function replacePrdDocument({specs,relative,content,current}){
  need(typeof current==='function','prd_correction_validator_required');current();
  readCorrectionFile(specs,relative);
  const target=path.join(specs,relative),dir=path.dirname(target),temp=path.join(dir,`.cm-prd-correction-${randomUUID()}`);
  let fd;
  try{
    fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,content);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    current();fs.renameSync(temp,target);
    const directoryFd=fs.openSync(dir,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

function loadCorrection({specs,stage,feature,pendingSplit=null}){
  const review=inspectPrdFindings({specs,stage,feature,pendingSplit});
  need(review.verdict!=='blocked'&&['resume_disposition','completed'].includes(review.gate.outcome),'prd_correction_not_ready');
  const archiveName=`prd-${feature.replace(/^\d+\./,'')}-${stage}-correction.md`;
  const bytes=readCorrectionFile(specs,`.reviews/${archiveName}`);
  const match=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).match(/\n```json\n([^\n]+)\n```\n$/);
  need(match,'prd_correction_archive_invalid');const value=json(JSON.parse(match[1]),256*1024);
  shape(value,['version','packageDigest','stage','feature','before','proposal',...(Object.hasOwn(value,'narrowReview')?['narrowReview']:[])]);
  need(!Object.hasOwn(value,'narrowReview')||(value.narrowReview===1&&stage==='design'),'prd_correction_archive_invalid');
  need(value.version===1&&value.packageDigest===review.packageDigest&&value.stage===stage&&value.feature===feature
    &&archiveBytes(value).equals(bytes)&&Array.isArray(value.before),'prd_correction_archive_invalid');
  const originals=new Map(review.reviewedArtifacts.map(item=>[item.path,item.sha256])),seen=new Set();
  need(value.before.length===originals.size,'prd_correction_archive_inventory');
  for(const item of value.before){
    shape(item,['path','sha256','content']);
    need(originals.get(item.path)===item.sha256&&!seen.has(item.path)&&typeof item.content==='string'
      &&Buffer.from(item.content).toString('utf8')===item.content&&sha(Buffer.from(item.content))===item.sha256,
      'prd_correction_archive_original_mismatch');seen.add(item.path);
  }
  const {after,plan}=inspectProposal(specs,review,value.proposal),states=[];
  // V6 (O04): reconcile each reviewed file against the archive: the corrected
  // bytes continue, the original bytes are still to be written, anything else
  // is a conflict for a person (listed with all three digests, never overwritten).
  const before=value.before.map(item=>{
    const currentHash=sha(readCorrectionFile(specs,item.path)),next=after.find(row=>row.path===item.path).sha256;
    states.push({path:item.path,status:currentHash===next?'matches_correction':currentHash===item.sha256?'needs_correction':'conflict',
      ...(currentHash!==next&&currentHash!==item.sha256?{currentSha256:currentHash,originalSha256:item.sha256,correctedSha256:next}:{})});
    return {...item,sha256:currentHash};
  });
  return {specs,stage,feature,review,archiveName,archiveHash:sha(bytes),evidenceHash:sha(readCmInitSource(specs,review.evidence)),
    before,proposal:value.proposal,after,plan,states,narrowEnabled:value.narrowReview===1};
}

export function inspectPrdCorrectionRecovery(input){
  const value=loadCorrection(input),conflict=value.states.some(item=>item.status==='conflict');
  return json({status:conflict?'correction_recovery_conflict':'correction_recovery_inspected',archive:`.reviews/${value.archiveName}`,states:value.states,
    ...(conflict?{guidance:{summary:'修正存档里的文件既不是原文也不是修正稿（conflict），宿主不会覆盖。',
      nextStep:'逐个核对 conflict 文件的改动来源，保留用户改动；处理成原文或修正稿后再 inspect_correction，确认无冲突再 resume_correction。',authorizationGranted:false}}:{}),
    packageDigest:value.review.packageDigest,decisions:value.plan.decisions,artifacts:value.after,
    writeAuthorized:false,completionAuthorized:false});
}

export function resumePrdCorrection(input,signal){
  assertPrdBatchActive(input.specs,[input.feature]);
  need(input.writeEnabled===true&&!signal.aborted,'prd_correction_not_enabled');
  const value=loadCorrection(input),{specs,stage,feature}=input;
  need(!value.states.some(item=>item.status==='conflict'),'prd_correction_recovery_conflict');
  const current=()=>{
    need(!signal.aborted,'cancelled');const latest=inspectPrdFindings({specs,stage,feature});
    need(latest.packageDigest===value.review.packageDigest&&latest.gate.outcome===value.review.gate.outcome
      &&sha(readCmInitSource(specs,latest.evidence))===value.evidenceHash
      &&sha(readCorrectionFile(specs,`.reviews/${value.archiveName}`))===value.archiveHash,'prd_correction_review_changed');
    for(const item of value.before)need(sha(readCorrectionFile(specs,item.path))===item.sha256,'prd_correction_inputs_changed');
  };
  if(value.states.some(item=>item.status==='needs_correction'))need(value.review.gate.outcome==='resume_disposition','prd_correction_not_ready');
  return writeCorrection({...value,current},signal);
}

// ---- Design-stage narrow review rounds (see narrow-review.mjs) ----
const designPath=feature=>`${feature}/design.md`;
// After the design receipt is written the design is frozen at the receipt's bytes; a later saved split correction
// legitimately changes the file. Callers past that point pass the receipt's design sha (and the saved split plan).
function narrowFound({specs,feature,pendingSplit=null,designSha256=null}){
  need(typeof feature==='string'&&/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature),'prd_review_feature_invalid');
  if(readCmInitSource(specs,`.reviews/prd-${feature.replace(/^\d+\./,'')}-design-correction.md`)===null)return null;
  const value=loadCorrection({specs,stage:'design',feature,pendingSplit}),design=designPath(feature);
  if(!value.narrowEnabled)return null; // run started before narrow rounds: unchanged legacy flow
  const state=inspectPrdNarrowState({specs,feature,packageDigest:value.review.packageDigest,
    base:{designSha256:value.after.find(item=>item.path===design).sha256,archiveSha256:value.archiveHash,
      originalDesignSha256:value.review.reviewedArtifacts.find(item=>item.path===design).sha256,
      requirementsSha256:value.review.reviewedArtifacts.find(item=>item.path===`${feature}/requirements.md`).sha256,
      authorContextId:readPrdReviewAuthor({specs,stage:'design',feature})},
    currentDesignSha256:designSha256??sha(readCorrectionFile(specs,design))});
  return {value,state};
}
// True only when the original correction is fully saved (or a narrow round already exists),
// so an unfinished original write still goes through the original recovery.
export function prdNarrowCorrectionFlow({specs,stage,feature}){
  if(stage!=='design')return false;
  if(readCmInitSource(specs,`.reviews/${narrowNames(feature).review(1)}`)!==null)return true;
  const value=loadCorrection({specs,stage,feature});
  return value.narrowEnabled&&value.states.every(item=>item.status==='matches_correction');
}
export const prdNarrowChainStarted=({specs,feature})=>readCmInitSource(specs,`.reviews/${narrowNames(feature).review(1)}`)!==null;
// For drivers that pre-check a prd_correct answer: the review the answer must resolve, or null (use the original).
export function narrowCorrectionReview({specs,stage,feature}){
  if(stage!=='design'||!prdNarrowChainStarted({specs,feature}))return null;
  const found=narrowFound({specs,feature});
  if(found===null||found.state.phase.status!=='awaiting_correction')return null;
  return {stage,feature,findings:found.state.rounds.at(-1).review.findings,reviewedArtifacts:found.value.review.reviewedArtifacts.map(item=>
    ({path:item.path,sha256:sha(readCorrectionFile(specs,item.path))}))};
}
export function inspectPrdNarrowReview(input){
  const found=narrowFound(input);
  return found===null?json({status:'narrow_not_started',next:'correct_findings',completionAuthorized:false}):json(narrowPublicState(found.state));
}
export function recordPrdNarrowReviewHost({specs,feature,packageDigest,input,authorContextId,writeEnabled}){
  assertPrdBatchActive(specs,[feature]);
  const found=narrowFound({specs,feature});need(found,'prd_narrow_requires_original_correction');
  need(found.value.review.gate.outcome==='resume_disposition','prd_narrow_closed');
  need(packageDigest===found.value.review.packageDigest,'prd_narrow_package_changed');
  recordPrdNarrowReview({specs,feature,packageDigest,state:found.state,input,authorContextId,
    originalAuthorContextId:readPrdReviewAuthor({specs,stage:'design',feature}),writeEnabled});
  const after=narrowFound({specs,feature}),row=after.state.rounds.at(-1);
  const blocking=row.review.findings.filter(item=>item.severity!=='minor'||['security','dataLoss','silentFailure','violatesWrittenRule'].some(flag=>item[flag]));
  return json({...narrowPublicState(after.state),status:'narrow_review_recorded',round:row.round,verdict:row.review.verdict,
    reviewDigest:row.reviewDigest,degradedReview:row.review.reviewer==='self-degraded',backlog:row.review.findings.filter(item=>!blocking.includes(item)).map(item=>({id:item.id,message:item.message}))});
}
// Original disposition gate: once a narrow round exists the design must have been approved by it.
export function assertPrdNarrowDispositionReady({specs,feature,pendingSplit=null,designSha256=null}){
  if(readCmInitSource(specs,`.reviews/${narrowNames(feature).review(1)}`)===null)return {used:false};
  const found=narrowFound({specs,feature,pendingSplit,designSha256});need(found,'prd_narrow_requires_original_correction');
  const status=found.state.phase.status;
  need(status!=='awaiting_user_decision','prd_narrow_awaiting_user_decision');
  need(status==='approved','prd_narrow_review_pending');
  return {used:true,designPath:designPath(feature),originalDecisions:found.value.plan.decisions};
}

async function narrowCorrection({specs,feature,correct,attempts,signal}){
  const found=narrowFound({specs,feature}),{state,value}=found,phase=state.phase,names=narrowNames(feature);
  // A saved correction whose result was lost before the session commit: answer again from the archive, never regenerate.
  const lastRow=state.rounds.at(-1);
  const resumed=phase.status==='awaiting_review'&&lastRow?.correction&&phase.round===lastRow.round+1;
  need(phase.status!=='awaiting_review'||resumed,'prd_narrow_review_required');
  need(phase.status!=='approved','prd_narrow_already_approved');
  need(phase.status!=='awaiting_user_decision','prd_narrow_awaiting_user_decision');
  const round=resumed?lastRow.round:phase.round,archive=`.reviews/${names.correction(round)}`;
  const designRelative=designPath(feature),packageDigest=value.review.packageDigest;
  const current=()=>{
    need(!signal.aborted,'cancelled');const latest=narrowFound({specs,feature});
    need(latest.value.review.packageDigest===packageDigest&&latest.value.review.gate.outcome==='resume_disposition'
      &&['awaiting_correction','correction_incomplete'].includes(latest.state.phase.status)&&latest.state.phase.round===round,
      'prd_narrow_state_changed');
  };
  const finish=row=>{
    const doc=row.correction.proposal.documents.find(item=>item.path===designRelative);
    const written=[];
    try{
      if(row.correction.beforeSha256!==row.correction.afterSha256&&sha(readCorrectionFile(specs,designRelative))===row.correction.beforeSha256){
        current();replacePrdDocument({specs,relative:designRelative,content:doc.content,current});written.push(designRelative);
      }
      const after=narrowFound({specs,feature});
      need(after.state.phase.status==='awaiting_review'&&after.state.phase.round===round+1,'prd_narrow_state_changed');
      return json({...narrowPublicState(after.state),status:'correction_saved',narrow:true,round,packageDigest,
        decisions:row.correction.proposal.decisions,
        artifacts:row.correction.before.map(item=>({path:item.path,sha256:item.path===designRelative?row.correction.afterSha256:item.sha256})),
        archive});
    }catch{return json({status:'correction_save_unknown',archive,round,observedWritten:written,
      next:'rerun_correct_findings_to_resume_from_archive_without_regeneration',completionAuthorized:false});}
  };
  if(phase.status==='correction_incomplete'||resumed)return finish(state.rounds[round-1]);
  const narrow=state.rounds[round-1];
  const read=file=>readCorrectionFile(specs,file);
  const before=value.review.reviewedArtifacts.map(item=>{
    const bytes=read(item.path);
    return {path:item.path,sha256:sha(bytes),content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
  });
  // Requirements are frozen after the original review; a user edit must be undone before a narrow archive is written,
  // otherwise the saved archive could never be read back (nothing is written or asked until then).
  for(const item of value.review.reviewedArtifacts)
    if(item.path!==designRelative)need(before.find(row=>row.path===item.path)?.sha256===item.sha256,'prd_correction_inputs_changed');
  const key=digest({specs,packageDigest,round});need(!attempts.has(key),'prd_correction_already_attempted');attempts.add(key);
  const pseudo={stage:'design',feature,findings:narrow.review.findings,
    reviewedArtifacts:before.map(({path:file,sha256})=>({path:file,sha256}))};
  const proposal=json(await correct(json({review:{stage:'design',feature,packageDigest,narrowRound:round,
    maxNarrowRounds:PRD_NARROW_MAX_ROUNDS,verdict:narrow.review.verdict,findings:narrow.review.findings,
    summary:narrow.review.summary,narrowReviewDigest:narrow.reviewDigest},documents:before,
    instructions:'Resolve only the findings of this recorded narrow design review round. Return {decisions:[{id,status:applied|escalated,evidence:[reason],changedPaths:[path]}],documents:[{path,content}]} covering every finding id and the complete unchanged path inventory. Only design.md may change. Escalate disagreement or unprovable changes; do not invent human approval. Do not write files, change task status, call another reviewer/provider or retry. The corrected design needs another recorded narrow review (at most two rounds in total).'}),signal),256*1024);
  need(!signal.aborted,'cancelled');
  const {after,plan}=inspectProposal(specs,pseudo,proposal);
  current();for(const item of before)need(sha(read(item.path))===item.sha256,'prd_correction_inputs_changed');
  const afterDesign=after.find(item=>item.path===designRelative).sha256;
  const record={version:1,kind:'prd_design_narrow_correction',feature,packageDigest,round,narrowReviewDigest:narrow.reviewDigest,
    beforeSha256:state.tipDesignSha256,afterSha256:afterDesign,before,proposal:{decisions:plan.decisions,documents:proposal.documents}};
  // Archive the answered review's per-finding decisions and original bytes before any spec write.
  writeReviewEvidence({reviewsDir:path.join(specs,'.reviews'),name:names.correction(round),bytes:narrowCorrectionBytes(json(record,256*1024)),
    exclusive:true,validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_correction_archive_permissions')});
  return finish({correction:record});
}

// Receipt writers outside the host (cm-prd-review-gate record) get the same full chain validation as the host:
// any narrow review/correction file present means the chain must be valid, approved, and keep the original
// decision counts. Fails closed with fixed prd_narrow_* codes (never raw system errors or paths).
export function assertNarrowReceiptAllowed({specs,slug,findingCount,unresolvedCount}){
  const invalid=()=>Object.assign(new Error('prd_narrow_record_invalid'),{code:'prd_narrow_record_invalid'});
  if(typeof slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))return; // not a PRD feature slug: nothing narrow to check
  const names=narrowNames(`1.${slug}`);
  const present=[names.review(1),names.review(2),names.correction(1)].some(name=>{
    try{fs.lstatSync(path.join(specs,'.reviews',name));return true;}catch(error){if(error.code==='ENOENT')return false;return true;}
  });
  if(!present)return;
  try{
    const dirs=fs.readdirSync(specs).filter(name=>new RegExp(`^[1-9]\\d*\\.${slug}$`).test(name));
    need(dirs.length===1,'prd_narrow_record_invalid');
    const found=narrowFound({specs,feature:dirs[0]});need(found,'prd_narrow_requires_original_correction');
    need(found.state.phase.status==='approved','prd_narrow_review_pending');
    const decisions=found.value.plan.decisions;
    need(findingCount===decisions.length&&unresolvedCount===decisions.filter(item=>item.status==='escalated').length,
      'prd_narrow_disposition_decisions_changed');
  }catch(error){throw typeof error?.code==='string'&&error.code.startsWith('prd_narrow_')?error:invalid();}
}
