#!/usr/bin/env node
// External providers only. No role picker, model catalog or background discovery.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';
import {externalModelsPath,externalSettingsRecord,externalPair,readExternalModels,saveExternalModels,describeExternalModels} from '../runtime/js/cm-ai/external-models.mjs';
import {readModelJsonRecord} from '../runtime/js/cm-ai/model-configuration-file.mjs';
import {previewLegacyExternalModels} from '../runtime/js/cm-ai/legacy-model-settings.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
import {previewLegacyModelRun} from '../runtime/js/cm-ai/legacy-model-run-preview.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
const usage=`cm-model-setup.mjs show
cm-model-setup.mjs configure --provider codex|claude [--model ID] [--effort VALUE|default] [--yes]
cm-model-setup.mjs legacy-preview --input OLD_SETTINGS [--task OLD_TASK] [--project OLD_PROJECT] [--global OLD_GLOBAL]
cm-model-setup.mjs inspect-run --input RUN_JSON
cm-model-setup.mjs legacy-run-preview --input OLD_SNAPSHOT
cm-model-setup.mjs adopt-legacy --provider codex|claude --input OLD_SETTINGS [--task OLD_TASK] [--project OLD_PROJECT] [--global OLD_GLOBAL] [--yes]
Only external CLI requests are configured. Host work keeps the current session model.
No model is selected by default; optional effort keeps Codex high / Claude unsent.
Old choices and runs are never rewritten. Conflicting effective old tuples require configure.`;
export async function main(argv,{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  let rl;
  try{
    if(argv.length===0||argv[0]==='--help'){output.write(usage+'\n');return 0;}
    const [action,...rest]=argv,flags=new Map();
    for(let i=0;i<rest.length;i++){
      const flag=rest[i];need(!flags.has(flag),'invalid_arguments');
      need(['--provider','--model','--effort','--yes','--input','--task','--project','--global'].includes(flag),'invalid_arguments');
      if(flag==='--yes')flags.set(flag,true);
      else{need(typeof rest[i+1]==='string'&&!rest[i+1].startsWith('--'),'invalid_arguments');flags.set(flag,rest[++i]);}
    }
    if(['inspect-run','legacy-run-preview'].includes(action)){
      need(flags.size===1&&flags.has('--input'),'invalid_arguments');
      const raw=readModelJsonRecord(path.resolve(flags.get('--input'))).value;
      if(action==='legacy-run-preview'){output.write(JSON.stringify(previewLegacyModelRun(raw))+'\n');return 0;}
      const {readRunDefinition}=await import('./cm-ai-run.mjs');
      // Definition validation is the same as the runner, without acquiring a writer.
      const definition=readRunDefinition(path.resolve(flags.get('--input')));
      const snapshot=readExecutionSnapshot({specsRoot:definition.specsDir,identity:{repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});
      const init=snapshot.records[0].payload,history=readRunnerHistory(snapshot.records,init.config,init.version);
      output.write(JSON.stringify({readOnly:true,identity:{...init.config.identity,attempt:history.state.attempt},state:history.state.state,
        externalModels:init.config.externalModels??null,revision:snapshot.revision,
        attempts:snapshot.records.filter(row=>row.payload.type.startsWith('review-invocation-')).map(row=>row.payload),
        effectiveModel:'unknown',providerConfirmed:false})+'\n');return 0;
    }
    const file=externalModelsPath(),record=externalSettingsRecord(file);
    const value=record?readExternalModels(record.value):{schemaVersion:1,providers:{}};
    if(action==='show'){need(flags.size===0,'invalid_arguments');output.write(JSON.stringify(describeExternalModels(value))+'\n');return 0;}
    let legacy=null,guards=[];
    if(['legacy-preview','adopt-legacy'].includes(action)){
      need(flags.has('--input')&&!flags.has('--model')&&!flags.has('--effort'),'invalid_arguments');
      const read=flag=>{if(!flags.has(flag))return null;const name=path.resolve(flags.get(flag)),old=readModelJsonRecord(name);guards.push({file:name,sha256:old.sha256});return old.value;};
      legacy=previewLegacyExternalModels({settings:read('--input'),task:read('--task'),project:read('--project'),global:read('--global')});
      if(action==='legacy-preview'){need(!flags.has('--provider')&&!flags.has('--yes'),'invalid_arguments');output.write(JSON.stringify({readOnly:true,providers:legacy})+'\n');return 0;}
    }else need(action==='configure'&&![...flags.keys()].some(flag=>['--input','--task','--project','--global'].includes(flag)),'invalid_arguments');
    const provider=flags.get('--provider');need(['codex','claude'].includes(provider),'invalid_external_provider');
    const ask=async text=>{need(input.isTTY===true&&output.isTTY===true,'external_model_setup_required');rl??=readline.createInterface({input,output});return rl.question(text);};
    let pair;
    if(legacy){need(!legacy[provider].conflict,'legacy_external_model_conflict');
      need(guards.length===1&&path.dirname(guards[0].file)===path.dirname(file),'legacy_adoption_requires_explicit_choice');pair=legacy[provider].pair;}
    else{
      const model=flags.get('--model')??(await ask(`${provider} external model ID: `)).trim();
      let effort=flags.get('--effort');
      if(!flags.has('--model')&&effort===undefined)effort=(await ask('Effort (Enter = adapter default): ')).trim()||'default';
      pair=externalPair(provider,{model,...(effort===undefined||effort==='default'?{}:{effort})});
    }
    const next=readExternalModels({...value,providers:{...value.providers,[provider]:pair}});
    output.write(JSON.stringify({provider,pair,affects:'new external runs only',host:'current-session',file})+'\n');
    if(!flags.has('--yes')&&!/^(y|yes)$/i.test((await ask('Save this provider pair? [y/N] ')).trim())){output.write('cancelled; no write\n');return 0;}
    // Bind both target and each legacy source to the bytes shown before waiting.
    for(const guard of guards)need(readModelJsonRecord(guard.file).sha256===guard.sha256,'model_configuration_changed');
    saveExternalModels(next,{file,expectedSha256:record?.sha256??null,
      sourceGuard:guards.length===1?guards[0]:null});
    output.write('saved\n');return 0;
  }catch(cause){error.write(JSON.stringify({error:{code:cause.code??cause.message}})+'\n');return 1;}
  finally{if(rl){rl.close();input.pause();input.unref?.();}}
}
if(process.argv[1]===fileURLToPath(import.meta.url))process.exitCode=await main(process.argv.slice(2));
