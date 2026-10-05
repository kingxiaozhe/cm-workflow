import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {loadExternalModels,readExternalModels,selectExternalModels} from './external-models.mjs';
import {need} from './effect-contract.mjs';
export function readLaunchExternalModels({definition,mode,enabled=false,inputFile,providers}){
  need(['create','resume'].includes(mode),'invalid_mode');
  if(mode==='resume'){
    need(inputFile===undefined,'external_model_resume_selection_forbidden');
    let snapshot;
    try{snapshot=readExecutionSnapshot({specsRoot:definition.specsDir,
      identity:{repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      need(!enabled,'external_model_resume_selection_forbidden');
      // Let the original owner report store_missing, without changing legacy resume diagnostics.
      return null;
    }
    const saved=snapshot.records.find(row=>row.payload.type==='init')?.payload.config.externalModels??null;
    need(!enabled||saved!==null,'external_model_resume_selection_forbidden');
    return saved===null?null:readExternalModels(saved);
  }
  need(inputFile===undefined||enabled,'external_model_feature_required');
  return enabled?selectExternalModels(loadExternalModels(inputFile),providers):null;
}
