// Host-reported original Step 9.5 signals, not approval or semantic verification.
import path from 'node:path';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';
export const prdDesignRiskSignals=Object.freeze(['greenfieldAdr','architectureOrDataFlow',
  'newRuntimeDependencyOrToolchain','publicContractDataOrSecurity','fiveOrMoreFunctions']);
export function requireUnreviewedPrdDesign(specs,feature){
  const prefix=`.reviews/prd-${feature.name}-design`;
  for(const suffix of ['-r1.md','-r2.md','-disposition.json','-dispatch.json'])
    need(readCmInitSource(specs,prefix+suffix)===null,'prd_low_risk_existing_review');
  need(inspectPrdReview({stage:'design',feature:feature.name,evidence:path.join(specs,prefix+'-r1.md'),
    receipt:path.join(specs,prefix+'-disposition.json')}).outcome==='dispatch_once','prd_low_risk_existing_review');
}
export function inspectPrdDesignRiskSelection(specs,draft,raw){
  const value=json(raw,64*1024);shape(value,['draftDigest','risks']);
  need(value.draftDigest===draft.draftDigest&&Array.isArray(value.risks)
    &&value.risks.length===draft.features.length,'prd_design_risk_binding');
  const seen=new Set();
  for(const risk of value.risks){
    shape(risk,['feature','signals','evidence']);shape(risk.signals,prdDesignRiskSignals);
    const feature=draft.features.find(item=>item.directory===risk.feature);
    need(feature&&!seen.has(risk.feature)&&prdDesignRiskSignals.every(key=>typeof risk.signals[key]==='boolean')
      &&Array.isArray(risk.evidence)&&risk.evidence.length>0
      &&risk.evidence.every(item=>typeof item==='string'&&item.trim()),'prd_design_risk_invalid');
    seen.add(risk.feature);
    if(!Object.values(risk.signals).some(Boolean))requireUnreviewedPrdDesign(specs,feature);
  }
  return json({...value,selectionDigest:digest(value),source:'current_host_risk_attestation'});
}
