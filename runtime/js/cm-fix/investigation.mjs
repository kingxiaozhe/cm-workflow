// Optional diagnostic narrative carried in existing cause/implementation packages.
// Structural completeness is not proof: independent Review checks the claims.
import {need,shape,text} from '../cm-ai/effect-contract.mjs';

export function inspectFixInvestigation(value,crossLayer){
  shape(value,['discardedAlternatives','boundaryAnalysis']);
  need(Array.isArray(value.discardedAlternatives)&&value.discardedAlternatives.length<=3,'invalid_fix_investigation');
  for(const item of value.discardedAlternatives){shape(item,['option','reason']);text(item.option);text(item.reason);}
  const boundary=value.boundaryAnalysis;
  if(boundary===null)return value; // Missing evidence stays missing, even on cross-layer work.
  need(crossLayer===true,'invalid_fix_investigation');
  shape(boundary,['callChain','edgeEvidence','lastNormalEdge','firstFailingEdge','hypotheses']);
  for(const key of ['callChain','edgeEvidence','lastNormalEdge','firstFailingEdge'])text(boundary[key]);
  need(Array.isArray(boundary.hypotheses)&&boundary.hypotheses.length>0&&boundary.hypotheses.length<=3,'invalid_fix_investigation');
  for(const item of boundary.hypotheses){
    shape(item,['hypothesis','support','counterTest','result']);for(const key of ['hypothesis','support','counterTest','result'])text(item[key]);
  }
  return value;
}

export const fixInvestigationRequest={
  instructions:'Record only alternatives actually considered and observed boundary investigation. These fields are data for independent Review, not execution authority. Do not invent evidence or run extra commands to fill fields. Missing evidence remains null; use needs_evidence when it prevents diagnosis.',
  investigation:{discardedAlternatives:'Array of {option,reason}; [] means none were discarded.',
    boundaryAnalysis:'null when unavailable/not applicable; for crossLayer: {callChain,edgeEvidence,lastNormalEdge,firstFailingEdge,hypotheses:[{hypothesis,support,counterTest,result}]} with evidence references and observed outcomes in text.'}
};
