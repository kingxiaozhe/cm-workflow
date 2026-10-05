// Historical experimental snapshots remain immutable and need their original executor.
import {digest,json,need,shape,validIdentity} from './effect-contract.mjs';
import {externalPair} from './external-models.mjs';
export function previewLegacyModelRun(raw){
  const value=json(raw,64*1024),{snapshotDigest,...body}=value;
  const experimental=value.schemaVersion===1&&value.kind==='cm-model-run-snapshot'&&value.population==='experimental-model-v1';
  const policy=value.version===2&&value.kind==='cm-model-policy-snapshot'&&value.resolverVersion==='model-policy-resolver-v1';
  need((experimental||policy)&&value.locked===true&&digest(body)===snapshotDigest,'legacy_model_snapshot_invalid');
  shape(value,experimental?['schemaVersion','kind','population','locked','definition','selection','snapshotDigest']:
    ['version','kind','resolverVersion','definition','selection','locked','snapshotDigest',...(Object.hasOwn(value,'modelPolicyFix')?['modelPolicyFix']:[])]);
  validIdentity(value.definition.identity);
  need(value.definition.version===2&&value.definition.population===(experimental?'experimental-model-v1':'model-policy-v2'),'legacy_model_snapshot_invalid');
  const {previewDigest,...selection}=value.selection;
  need(selection.schemaVersion===1&&selection.kind==='cm-model-preview'&&selection.executionAvailable===false
    &&digest(selection)===previewDigest,'legacy_model_preview_invalid');
  const stages=Object.fromEntries(Object.entries(selection.stages).map(([stage,choice])=>{
    need(['developer','reviewer','test_analysis'].includes(stage),'legacy_model_preview_invalid');
    const {provider,...pair}=choice.tuple;
    return [stage,{provider,...externalPair(provider,pair),mode:choice.mode,source:choice.source}];
  }));
  return {readOnly:true,validation:'snapshot and selection digest; not execution ownership',
    identity:value.definition.identity,population:value.definition.population,snapshotDigest,stages,
    effectiveModel:'unknown',providerConfirmed:false,resume:'original executor required; no migration'};
}
