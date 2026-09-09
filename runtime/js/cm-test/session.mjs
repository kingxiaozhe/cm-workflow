// Local test replay reuses the existing effect journal; task/log authority stays
// in the original cm-test flow. Unknown actions are never dispatched twice.
import fs from 'node:fs';
import path from 'node:path';
import {openRefactorRecords} from '../cm-refactor/records.mjs';
import {need,digest,json,shape} from '../cm-ai/effect-contract.mjs';
import {inside,canonicalFuture,sourceChanges} from './source-snapshot.mjs';

export function openTestSession(directory,config){
  need(path.isAbsolute(directory)&&canonicalFuture(directory)===directory,'cm_test_session_path_invalid');
  for(const root of [config.project,config.arguments.specs,config.arguments.reportDir].filter(Boolean)){
    const resolved=canonicalFuture(root);
    need(!inside(resolved,directory)&&!inside(directory,resolved),'cm_test_session_path_invalid');
  }
  for(const name of ['execution.jsonl','.writer.json']){
    const file=path.join(directory,name);
    if(fs.existsSync(file))need((fs.lstatSync(file).mode&0o777)===0o600,'cm_test_session_permissions');
  }
  const records=openRefactorRecords(directory);records.acquire();
  let sequence=0,resolution=null;
  const unknown=()=>[...records.effects].find(([,entry])=>!Object.hasOwn(entry,'result'));
  return {
    get context(){return records.context;},
    get progress(){return records.progress;},
    get logFile(){return [...records.effects.values()].filter(entry=>entry.result?.value?.logFile).at(-1)?.result.value.logFile??null;},
    get pending(){const entry=unknown();return entry?{key:entry[0],kind:entry[1].kind,requestDigest:digest(entry[1].input)}:null;},
    initialize(context){records.initialize({...context,workflow:'cm-test',configDigest:digest(config)});},
    validate(binding){need(records.context?.workflow==='cm-test'&&records.context.configDigest===digest(config)
      &&digest(records.context.binding)===digest(binding),'cm_test_session_binding_changed');},
    begin(current,receipt){
      need(!records.progress?.cancelled,'cancelled');
      const last=[...records.effects.values()].filter(entry=>Object.hasOwn(entry,'result')).at(-1)?.result.source??records.context.source;
      need(sourceChanges(last,current).length===0,'cm_test_resume_source_changed');
      const logged=[...records.effects.values()].filter(entry=>entry.result?.value?.logDigest).at(-1)?.result.value;
      if(logged)need(fs.realpathSync(logged.logFile)===logged.logFile&&fs.lstatSync(logged.logFile).isFile()
        &&digest(fs.readFileSync(logged.logFile,'utf8'))===logged.logDigest,'cm_test_resume_log_changed');
      if(receipt!==null){
        shape(receipt,['key','requestDigest','result','evidence','cleanup']);const pending=this.pending;
        need(pending&&['host','command'].includes(pending.kind)&&receipt.key===pending.key&&receipt.requestDigest===pending.requestDigest
          &&typeof receipt.evidence==='string'&&receipt.evidence.trim()&&receipt.cleanup==='completed','cm_test_resolution_invalid');
      }
      resolution=receipt;sequence=0;
    },
    async effect(kind,input,perform,snapshot){
      const key=String(++sequence);
      return (await records.effect(key,kind,input,async()=>({value:await perform(),source:snapshot()}),async old=>{
        if(['snapshot','evaluation'].includes(old.kind))return {value:await perform(),source:snapshot()};
        need(resolution&&resolution.key===key&&resolution.requestDigest===digest(old.input),'cm_test_outcome_unknown');
        const {result,...provenance}=resolution,value=json(result,4*1024*1024);
        resolution=null;return {value,source:snapshot(),reconciliation:{source:'trusted_host_original_result',...provenance}};
      })).value;
    },
    save(value){records.progressWrite(value);},
    close(){records.release();}
  };
}
