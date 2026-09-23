// Read requirements/design through the original baseline or bound split disposition.
import {readPrdSelfCheckRevision} from './self-check-revision.mjs';
import {inspectPrdSplitDesign} from './split-design.mjs';
import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {inspectPrdFindings} from './review-findings.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {prdFeatureInventory} from './draft.mjs';
import {inspectPrdDesignRiskSelection,requireUnreviewedPrdDesign} from './design-risk.mjs';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function inspectAcceptedPrdDesign(specs,original,selection=null,{draftDigest,pendingSplit=null,selfCheckRevision=null,pendingSelfCheckSave=false}={}){
  if(selection!==null)inspectPrdDesignRiskSelection(specs,original,{draftDigest:selection.draftDigest,risks:selection.risks});
  const evidence=[],features=original.features.map(feature=>{
    const risk=selection?.risks.find(item=>item.feature===feature.directory);
    const requirements=feature.documents.find(doc=>doc.path==='requirements.md');
    const requirementsSha=sha(Buffer.from(requirements.content));
    const revision=readPrdSelfCheckRevision(specs,feature.directory,{designDraftDigest:original.draftDigest});
    need(revision===null||draftDigest===undefined||revision.draftDigest===draftDigest,'prd_self_check_revision_binding_changed');
    const revised=revision?.features.find(f=>f.directory===feature.directory);
    const pending=pendingSelfCheckSave&&selfCheckRevision?.features.find(f=>f.directory===feature.directory);
    const acceptedDocument=(doc,originalSha,designSha,error)=>{
      const bytes=readCmInitSource(specs,`${feature.directory}/${doc.path}`);
      need(bytes!==null,'prd_design_file_missing');
      const completed=readCmInitSource(specs,`.reviews/prd-${feature.name}-split-disposition.json`)!==null;
      const revisedDoc=revised?.documents.find(d=>d.path===doc.path);
      need(!revisedDoc||revisedDoc.beforeSha256===originalSha,'prd_self_check_revision_binding_changed');
      const acceptedSha=revisedDoc?.sha256??originalSha;
      need((!completed&&(sha(bytes)===acceptedSha||(pending&&sha(bytes)===originalSha)))||sha(bytes)===inspectPrdSplitDesign({
        specs,feature:feature.directory,originalSha:designSha,requirementsSha,draftDigest,pendingSplit,document:doc.path}),error);
      return {path:doc.path,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    };
    if(risk&&!Object.values(risk.signals).some(Boolean)){
      requireUnreviewedPrdDesign(specs,feature);
      const designSha=sha(Buffer.from(feature.documents.find(doc=>doc.path==='design.md').content));
      const documents=feature.documents.map(doc=>acceptedDocument(doc,sha(Buffer.from(doc.content)),designSha,
        doc.path==='requirements.md'?'prd_design_requirements_changed':'prd_low_risk_design_changed'));
      evidence.push({feature:feature.directory,disposition:'design_review_not_required',risk});
      return {...feature,documents};
    }
    const review=inspectPrdFindings({specs,stage:'design',feature:feature.directory,pendingSplit});
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
      return acceptedDocument(doc,doc.path==='requirements.md'?requirementsSha:receipt.artifacts[0].sha256,
        receipt.artifacts[0].sha256,doc.path==='requirements.md'?'prd_design_requirements_changed':'prd_design_receipt_changed');
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
