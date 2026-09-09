// Current host proposes a correction; only the owner writes reviewed spec paths.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {inspectPrdFindings} from './review-findings.mjs';
import {inspectPrdDispositionPlan} from './disposition-plan.mjs';
import {checkPrdDraftMechanics} from './self-check.mjs';
import {inspectPrdDesignDraft} from './draft.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archiveBytes=value=>Buffer.from('# Original review correction proposal\n\nNot review approval or completion. Private host-attested material.\n```json\n'
  +JSON.stringify(value)+'\n```\n');
function readCorrectionFile(specs,file){
  const bytes=readCmInitSource(specs,file);
  need(bytes!==null&&(fs.lstatSync(path.join(specs,file)).mode&0o777)===0o600,'prd_correction_file_invalid');return bytes;
}
function inspectProposal(review,proposal){
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
    const mechanics=checkPrdDraftMechanics({draftDigest:digest(after),features:[{directory:feature,name,documents}]});
    need(mechanics.status==='mechanical_subset_passed','prd_correction_mechanics_failed');
  }
  return {after,plan};
}

export function createPrdCorrectionOwner({correct}){
  need(typeof correct==='function','prd_correction_host_required');const attempts=new Set();
  return async({specs,stage,feature,writeEnabled},signal)=>{
    need(writeEnabled===true&&!signal.aborted,'prd_correction_not_enabled');
    const review=inspectPrdFindings({specs,stage,feature});
    const evidenceHash=sha(readCmInitSource(specs,review.evidence));
    need(review.gate.outcome==='resume_disposition'&&review.verdict!=='blocked'&&review.findings.length>0,
      'prd_correction_not_ready');
    const archiveName=`prd-${feature.replace(/^\d+\./,'')}-${stage}-correction.md`;
    if(readCmInitSource(specs,`.reviews/${archiveName}`)!==null)return json({status:'correction_recovery_required',
      archive:`.reviews/${archiveName}`,next:'inspect_original_correction_archive_without_regeneration',completionAuthorized:false});
    const read=file=>readCorrectionFile(specs,file);
    const before=review.reviewedArtifacts.map(item=>{
      const bytes=read(item.path);need(sha(bytes)===item.sha256,'prd_correction_inputs_changed');
      return {...item,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    });
    const key=digest({specs,packageDigest:review.packageDigest});
    need(!attempts.has(key),'prd_correction_already_attempted');attempts.add(key);
    const proposal=json(await correct(json({review,documents:before,
      instructions:'Resolve only these original findings. Return {decisions:[{id,status:applied|escalated,evidence:[reason],changedPaths:[path]}],documents:[{path,content}]} with the complete unchanged path inventory. Escalate disagreement or unprovable changes; do not invent human approval. design may change design.md only. Do not write files, change task status, add/remove files, call another reviewer/provider or retry. Corrected split specs will go through the original self-check.'}),signal),256*1024);
    need(!signal.aborted,'cancelled');const {after,plan}=inspectProposal(review,proposal);
    const current=()=>{
      const latest=inspectPrdFindings({specs,stage,feature});
      need(latest.packageDigest===review.packageDigest&&latest.gate.outcome==='resume_disposition'
        &&sha(readCmInitSource(specs,review.evidence))===evidenceHash,'prd_correction_review_changed');
      for(const item of before)need(sha(read(item.path))===item.sha256,'prd_correction_inputs_changed');
    };
    current();
    const archive=archiveBytes({version:1,packageDigest:review.packageDigest,stage,feature,before,proposal});
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

function loadCorrection({specs,stage,feature}){
  const review=inspectPrdFindings({specs,stage,feature});
  need(review.verdict!=='blocked'&&['resume_disposition','completed'].includes(review.gate.outcome),'prd_correction_not_ready');
  const archiveName=`prd-${feature.replace(/^\d+\./,'')}-${stage}-correction.md`;
  const bytes=readCorrectionFile(specs,`.reviews/${archiveName}`);
  const match=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).match(/\n```json\n([^\n]+)\n```\n$/);
  need(match,'prd_correction_archive_invalid');const value=json(JSON.parse(match[1]),256*1024);
  shape(value,['version','packageDigest','stage','feature','before','proposal']);
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
  const {after,plan}=inspectProposal(review,value.proposal),states=[];
  const before=value.before.map(item=>{
    const currentHash=sha(readCorrectionFile(specs,item.path)),next=after.find(row=>row.path===item.path).sha256;
    need([item.sha256,next].includes(currentHash),'prd_correction_recovery_conflict');
    states.push({path:item.path,status:currentHash===next?'matches_correction':'needs_correction'});
    return {...item,sha256:currentHash};
  });
  return {specs,stage,feature,review,archiveName,archiveHash:sha(bytes),evidenceHash:sha(readCmInitSource(specs,review.evidence)),
    before,proposal:value.proposal,after,plan,states};
}

export function inspectPrdCorrectionRecovery(input){
  const value=loadCorrection(input);
  return json({status:'correction_recovery_inspected',archive:`.reviews/${value.archiveName}`,states:value.states,
    packageDigest:value.review.packageDigest,decisions:value.plan.decisions,artifacts:value.after,
    writeAuthorized:false,completionAuthorized:false});
}

export function resumePrdCorrection(input,signal){
  need(input.writeEnabled===true&&!signal.aborted,'prd_correction_not_enabled');
  const value=loadCorrection(input),{specs,stage,feature}=input;
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
