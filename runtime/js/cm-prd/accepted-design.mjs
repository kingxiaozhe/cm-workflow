// Read current design bytes through the original completed design receipt.
import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {inspectPrdFindings} from './review-findings.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {prdFeatureInventory} from './draft.mjs';
import {inspectPrdDesignRiskSelection,requireUnreviewedPrdDesign} from './design-risk.mjs';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function inspectAcceptedPrdDesign(specs,original,selection=null){
  if(selection!==null)inspectPrdDesignRiskSelection(specs,original,{draftDigest:selection.draftDigest,risks:selection.risks});
  const evidence=[],features=original.features.map(feature=>{
    const risk=selection?.risks.find(item=>item.feature===feature.directory);
    if(risk&&!Object.values(risk.signals).some(Boolean)){
      requireUnreviewedPrdDesign(specs,feature);
      for(const doc of feature.documents)need(readCmInitSource(specs,`${feature.directory}/${doc.path}`)
        ?.equals(Buffer.from(doc.content)),'prd_low_risk_design_changed');
      evidence.push({feature:feature.directory,disposition:'design_review_not_required',risk});
      return feature;
    }
    const review=inspectPrdFindings({specs,stage:'design',feature:feature.directory});
    need(review.gate.outcome==='completed'&&review.verdict!=='blocked'
      &&review.draftDigest===original.draftDigest,'prd_design_disposition_required');
    const receiptPath=review.evidence.replace(/-r1\.md$/,'-disposition.json');
    const receiptBytes=readCmInitSource(specs,receiptPath),receipt=JSON.parse(receiptBytes.toString('utf8'));
    need(receipt.artifacts.length===1&&receipt.artifacts[0].path===`${feature.directory}/design.md`,
      'prd_design_receipt_scope_invalid');
    need(review.reviewedArtifacts.length===2,'prd_design_review_scope_invalid');
    const documents=feature.documents.map(doc=>{
      const relative=`${feature.directory}/${doc.path}`,bytes=readCmInitSource(specs,relative);
      need(bytes!==null,'prd_design_file_missing');
      const prior=review.reviewedArtifacts.find(item=>item.path===relative);
      need(prior&&prior.sha256===sha(Buffer.from(doc.content)),'prd_design_original_changed');
      if(doc.path==='requirements.md')need(bytes.equals(Buffer.from(doc.content)),'prd_design_requirements_changed');
      else need(doc.path==='design.md'&&sha(bytes)===receipt.artifacts[0].sha256,'prd_design_receipt_changed');
      return {path:doc.path,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    });
    evidence.push({feature:feature.directory,reviewSha256:sha(readCmInitSource(specs,review.evidence)),
      receiptSha256:sha(receiptBytes),disposition:review.gate.disposition,findings:review.findings});
    return {...feature,documents};
  });
  const inventory=prdFeatureInventory(specs);
  for(const feature of features)need(inventory.includes(feature.directory)
    &&!inventory.some(name=>name!==feature.directory&&name.replace(/^\d+\./,'')===feature.name),'prd_design_inventory_invalid');
  const result={features,evidence,inventory,selection};return json({...result,bindingDigest:digest(result)});
}
