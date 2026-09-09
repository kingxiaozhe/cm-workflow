// Shared finding-to-artifact accounting for proposal and recorded disposition.
import {need,shape,json} from '../cm-ai/effect-contract.mjs';
export function inspectPrdDispositionPlan(review,rawDecisions,rawArtifacts){
  const decisions=json(rawDecisions,64*1024),artifacts=json(rawArtifacts,64*1024);
  need(Array.isArray(decisions)&&decisions.length===review.findings.length,'prd_disposition_coverage');
  const originals=new Map(review.reviewedArtifacts.map(item=>[item.path,item.sha256]));
  const ids=new Set(),changed=new Set();let unresolved=0;
  for(const decision of decisions){
    shape(decision,['id','status','evidence','changedPaths']);
    need(review.findings.some(item=>item.id===decision.id)&&!ids.has(decision.id)
      &&['applied','escalated'].includes(decision.status)&&Array.isArray(decision.evidence)
      &&decision.evidence.length>0&&decision.evidence.every(item=>typeof item==='string'&&item.trim())
      &&Array.isArray(decision.changedPaths)&&new Set(decision.changedPaths).size===decision.changedPaths.length,
      'prd_disposition_decision_invalid');ids.add(decision.id);
    if(decision.status==='escalated'){
      unresolved++;need(decision.changedPaths.length===0,'prd_disposition_escalated_changes');
    }else{
      need(decision.changedPaths.length>0,'prd_disposition_applied_without_changes');
      for(const file of decision.changedPaths){
        need(originals.has(file)&&(review.stage!=='design'||file===`${review.feature}/design.md`),'prd_disposition_scope_changed');changed.add(file);
      }
    }
  }
  need(Array.isArray(artifacts)&&artifacts.length===originals.size,'prd_disposition_artifact_inventory');
  const seen=new Set();
  for(const item of artifacts){
    shape(item,['path','sha256']);
    need(originals.has(item.path)&&!seen.has(item.path)&&typeof item.sha256==='string'
      &&/^[0-9a-f]{64}$/.test(item.sha256),'prd_disposition_artifact_inventory');seen.add(item.path);
    need((originals.get(item.path)!==item.sha256)===changed.has(item.path),'prd_disposition_unaccounted_change');
  }
  return {decisions,artifacts,changed,unresolved};
}
