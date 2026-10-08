// Optional diagnostic narrative carried in existing cause/implementation packages.
// Structural completeness is not proof: independent Review checks the claims.
import {need,shape,text} from '../cm-ai/effect-contract.mjs';

// Names the first failing field (and its item limit) on the thrown error without
// changing its code, so a rejected answer can say what to fix.
export function atField(field,check,limit=null,actual=null){
  try{return check();}
  catch(error){
    if(error&&typeof error==='object'&&error.field===undefined)Object.assign(error,{field},limit===null?{}:{limit,actual});
    throw error;
  }
}
const count=value=>Array.isArray(value)?value.length:null;

export function inspectFixInvestigation(value,crossLayer){
  atField('investigation',()=>shape(value,['discardedAlternatives','boundaryAnalysis']));
  atField('investigation.discardedAlternatives',()=>need(Array.isArray(value.discardedAlternatives)
    &&value.discardedAlternatives.length<=3,'invalid_fix_investigation'),3,count(value.discardedAlternatives));
  value.discardedAlternatives.forEach((item,index)=>atField(`investigation.discardedAlternatives[${index}]`,
    ()=>{shape(item,['option','reason']);text(item.option);text(item.reason);}));
  const boundary=value.boundaryAnalysis;
  if(boundary===null)return value; // Missing evidence stays missing, even on cross-layer work.
  atField('investigation.boundaryAnalysis',()=>{
    need(crossLayer===true,'invalid_fix_investigation');
    shape(boundary,['callChain','edgeEvidence','lastNormalEdge','firstFailingEdge','hypotheses']);
    for(const key of ['callChain','edgeEvidence','lastNormalEdge','firstFailingEdge'])atField(`investigation.boundaryAnalysis.${key}`,()=>text(boundary[key]));
  });
  atField('investigation.boundaryAnalysis.hypotheses',()=>need(Array.isArray(boundary.hypotheses)&&boundary.hypotheses.length>0
    &&boundary.hypotheses.length<=3,'invalid_fix_investigation'),3,count(boundary.hypotheses));
  boundary.hypotheses.forEach((item,index)=>atField(`investigation.boundaryAnalysis.hypotheses[${index}]`,()=>{
    shape(item,['hypothesis','support','counterTest','result']);for(const key of ['hypothesis','support','counterTest','result'])text(item[key]);
  }));
  return value;
}

export const fixInvestigationRequest={
  instructions:'Record only alternatives actually considered and observed boundary investigation. These fields are data for independent Review, not execution authority. Do not invent evidence or run extra commands to fill fields. Missing evidence remains null; use needs_evidence when it prevents diagnosis.',
  investigation:{discardedAlternatives:'Array of {option,reason}; [] means none were discarded.',
    boundaryAnalysis:'null when unavailable/not applicable; for crossLayer: {callChain,edgeEvidence,lastNormalEdge,firstFailingEdge,hypotheses:[{hypothesis,support,counterTest,result}]} with evidence references and observed outcomes in text.'}
};
