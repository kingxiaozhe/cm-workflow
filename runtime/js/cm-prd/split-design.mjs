// A split may supersede only the requirements/design bytes it actually reviewed. The original
// design receipt and review package remain immutable; no second review or grant.
import {prdSelfCheckRevisionBaseline} from './self-check-revision.mjs';
import {createHash} from 'node:crypto';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {inspectPrdFindings} from './review-findings.mjs';
import {inspectPrdDispositionPlan} from './disposition-plan.mjs';
import {need,digest} from '../cm-ai/effect-contract.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function inspectPrdSplitDesign({specs,feature,originalSha,requirementsSha,draftDigest,pendingSplit=null,document='design.md'}){
  need(['requirements.md','design.md'].includes(document),'prd_split_document_invalid');
  const targetPath=`${feature}/${document}`;
  const changedError=document==='requirements.md'?'prd_design_requirements_changed':'prd_design_receipt_changed';
  const prefix=`.reviews/prd-${feature.replace(/^\d+\./,'')}-split`;
  if(readCmInitSource(specs,prefix+'-r1.md')===null)return null;
  const review=inspectPrdFindings({specs,stage:'split',feature});
  const designPath=`${feature}/design.md`,requirementsPath=`${feature}/requirements.md`;
  const baseline=prdSelfCheckRevisionBaseline(specs,feature,{originalSha,requirementsSha,draftDigest});
  need(draftDigest===undefined||draftDigest===baseline.draftDigest,'prd_split_design_binding_changed');
  ({originalSha,requirementsSha,draftDigest}=baseline);
  need(review.verdict!=='blocked'
    &&(draftDigest===undefined||review.draftDigest===draftDigest)
    &&review.reviewedArtifacts.find(item=>item.path===designPath)?.sha256===originalSha
    &&review.reviewedArtifacts.find(item=>item.path===requirementsPath)?.sha256===requirementsSha,
    'prd_split_design_binding_changed');
  let artifacts;
  if(review.gate.outcome==='completed'){
    artifacts=JSON.parse(readCmInitSource(specs,prefix+'-disposition.json').toString('utf8')).artifacts;
    need(digest(artifacts.map(item=>item.path).sort())===digest(review.reviewedArtifacts.map(item=>item.path).sort()),
      'prd_split_design_receipt_scope_invalid');
  }else{
    if(pendingSplit===null)return null;
    need(review.gate.outcome==='resume_disposition'&&pendingSplit.stage==='split'&&pendingSplit.feature===feature
      &&pendingSplit.packageDigest===review.packageDigest,'prd_split_design_pending_binding_changed');
    const plan=inspectPrdDispositionPlan(review,pendingSplit.decisions,pendingSplit.artifacts);
    need(plan.changed.has(targetPath),changedError);artifacts=plan.artifacts;
    for(const item of artifacts){
      const bytes=readCmInitSource(specs,item.path);
      need(bytes!==null&&sha(bytes)===item.sha256,'prd_disposition_artifacts_not_saved');
    }
  }
  return artifacts.find(item=>item.path===targetPath)?.sha256??null;
}

// Used by the shared receipt gate, including summary, publication and revision.
// Legacy receipts without a host archive retain their original strict behavior.
export function acceptsPrdSplitDesign({specs,evidence,receipt,item,currentSha,pendingSplit=null}){
  if(receipt.stage!=='design'||!item.path.endsWith('/design.md'))return null;
  const bytes=readCmInitSource(specs,evidence);
  const line=bytes?.toString('utf8').match(/\n```json\n([^\n]+)\n```\n$/);
  if(!line)return null;
  const archive=JSON.parse(line[1]),pkg=archive.reviewPackage;
  need(archive.version===1&&pkg?.workflow==='cm-prd'&&pkg.stage==='design'
    &&pkg.feature===item.path.slice(0,-'/design.md'.length)
    &&pkg.feature.replace(/^\d+\./,'')===receipt.feature,'prd_split_design_binding_changed');
  const requirementsSha=pkg.artifacts.find(row=>row.path===`${pkg.feature}/requirements.md`)?.sha256;
  need(typeof requirementsSha==='string','prd_split_design_binding_changed');
  // The split gate checks its artifacts, preserving the existing task/AC mark
  // normalization for historical consumers. Active analysis requires the exact
  // accepted requirements/design bytes; pending plans require exact saved hashes.
  const baseline=prdSelfCheckRevisionBaseline(specs,pkg.feature,{designDraftDigest:pkg.draftDigest,originalSha:item.sha256,requirementsSha});
  const splitSha=inspectPrdSplitDesign({specs,feature:pkg.feature,originalSha:item.sha256,requirementsSha,
    pendingSplit:currentSha===baseline.originalSha?null:pendingSplit});
  const completed=readCmInitSource(specs,`.reviews/prd-${receipt.feature}-split-disposition.json`)!==null;
  return (completed||splitSha!==null?splitSha:baseline.originalSha)===currentSha;
}
