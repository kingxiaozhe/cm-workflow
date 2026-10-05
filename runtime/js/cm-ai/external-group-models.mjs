// Existing batch/fix owners keep the same provider parser and immutable selection.
import fs from 'node:fs';
import path from 'node:path';
import {digest,need,id,shape} from './effect-contract.mjs';
import {loadExternalModels,readExternalModels,selectExternalModels} from './external-models.mjs';
import {openExecutionStore} from './execution-store.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {fixArchiveRoot} from '../cm-fix/layout.mjs';

export function batchModelsFile(batch){
  id(batch.batchId);return path.join(batch.specsDir,'.cm-external-models-v1','.reviews','.execution','batch-models-'+digest(batch.batchId).slice(0,32),'state.json');
}
export function readBatchExternalModels({batch,started,enabled=false,inputFile,providers}){
  const file=batchModelsFile(batch);
  if(fs.existsSync(file)){
    need(inputFile===undefined,'external_model_resume_selection_forbidden');
    const snapshot=readExecutionSnapshot({specsRoot:path.join(batch.specsDir,'.cm-external-models-v1'),identity:{repositoryId:batch.repositoryId,runId:path.basename(path.dirname(file))}});
    need(snapshot.records.length===1&&snapshot.records[0].id==='batch-models'&&snapshot.records[0].kind==='result','external_model_batch_binding');
    const record=snapshot.records[0].payload;
    shape(record,['kind','batchId','planDigest','externalModels']);
    need(record.kind==='cm-external-batch-models-v1'&&record.batchId===batch.batchId
      &&record.planDigest===digest(batch),'external_model_batch_binding');
    return readExternalModels(record.externalModels);
  }
  need(!started||!enabled,'external_model_resume_selection_forbidden');
  need(inputFile===undefined||enabled&&!started,'external_model_feature_required');
  return enabled&&!started?selectExternalModels(loadExternalModels(inputFile),providers):null;
}
export function freezeBatchExternalModels(batch,externalModels){
  if(!externalModels)return;
  const value={kind:'cm-external-batch-models-v1',batchId:batch.batchId,planDigest:digest(batch),externalModels:readExternalModels(externalModels)};
  const file=batchModelsFile(batch);
  if(fs.existsSync(file)){need(digest(readBatchExternalModels({batch,started:true,providers:Object.keys(externalModels.providers)}))===digest(externalModels),'external_model_batch_binding');return;}
  const specsRoot=path.join(batch.specsDir,'.cm-external-models-v1');
  try{fs.mkdirSync(specsRoot,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(specsRoot)===specsRoot,'external_model_batch_binding');
  const fingerprint=digest('cm-external-batch-models-v1');
  const store=openExecutionStore({specsRoot,identity:{repositoryId:batch.repositoryId,runId:path.basename(path.dirname(file))},create:true,
    fingerprints:{workflow:fingerprint,config:digest(batch),inputs:digest(value)}});
  try{store.append({id:'batch-models',kind:'result',payload:value,expectedRevision:store.snapshot().revision});}finally{store.close();}
}
export function readFixExternalModels({config,mode,enabled=false,inputFile,runtime='codex'}){
  if(mode==='resume'){
    need(inputFile===undefined,'external_model_resume_selection_forbidden');
    const specsRoot=fixArchiveRoot(config.specsRoot,config.reproduction.cwd);
    const saved=readExecutionSnapshot({specsRoot,identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId}})
      .records[0]?.payload.configuration?.externalModels??null;
    need(!enabled||saved!==null,'external_model_resume_selection_forbidden');
    return saved===null?null:readExternalModels(saved);
  }
  need(inputFile===undefined||enabled,'external_model_feature_required');
  return enabled?selectExternalModels(loadExternalModels(inputFile),[runtime]):null;
}
