// Read-only compatibility. These historical defaults never select a new run.
import {digest,json,need,shape} from './effect-contract.mjs';
import {externalPair} from './external-models.mjs';
const defaults={codex:{general:'gpt-6-astra',code:'gpt-6.1-sol'},claude:{general:'claude-fable-5',code:'claude-opus-5-5'}};
const tuple=(provider,raw)=>{
  const value=json(raw);shape(value,['provider','model','effort']);need(value.provider===provider,'legacy_provider_conflict');
  return externalPair(provider,{model:value.model,effort:value.effort});
};
function choices(raw){
  const value=json(raw);shape(value,['schemaVersion','presetVersion','choices']);
  need([1,2].includes(value.schemaVersion)&&value.presetVersion==='two-tier-v1','legacy_schema_unsupported');
  const result={};
  for(const provider of ['codex','claude'])result[provider]={developer:{model:defaults[provider].code,effort:'high'},reviewer:{model:defaults[provider].code,effort:'high'}};
  if(value.schemaVersion===1){
    shape(value.choices,['codex','claude']);
    for(const provider of ['codex','claude']){
      shape(value.choices[provider],['general','code']);
      for(const entry of Object.values(value.choices[provider]))need(tuple(provider,entry).effort==='high','legacy_effort_invalid');
      result[provider]={developer:tuple(provider,value.choices[provider].code),reviewer:tuple(provider,value.choices[provider].code)};
    }
  }else{
    shape(value.choices,Object.keys(value.choices));
    for(const [provider,stages] of Object.entries(value.choices)){
      need(Object.hasOwn(defaults,provider),'invalid_external_provider');shape(stages,Object.keys(stages));
      for(const [stage,entry] of Object.entries(stages)){
        need(['general','developer','reviewer'].includes(stage),'legacy_stage_invalid');
        shape(entry,Object.keys(entry));need(Object.keys(entry).length>0&&Object.keys(entry).every(key=>['provider','model','effort'].includes(key)),'legacy_tuple_invalid');
        const selected=tuple(provider,{provider,model:defaults[provider][stage==='general'?'general':'code'],effort:'high',...entry});
        if(stage!=='general')result[provider][stage]=selected;
      }
    }
  }
  return result;
}
export function previewLegacyExternalModels({settings,task=null,project=null,global=null}){
  const base=choices(settings);
  for(const layer of [task,project,global])if(layer!==null){
    shape(layer,['schemaVersion','stages']);need(layer.schemaVersion===1,'legacy_schema_unsupported');
    shape(layer.stages,Object.keys(layer.stages));
    for(const [stage,row] of Object.entries(layer.stages)){
      need(['developer','reviewer','test_analysis'].includes(stage),'legacy_stage_invalid');
      need(['manual','recommended'].includes(row?.mode),'legacy_mode_invalid');
      shape(row,['mode',...(row.mode==='manual'?['provider','model','effort']:[])]);
      if(row.mode==='manual'){const {mode,...raw}=row;tuple(raw.provider,raw);}
    }
  }
  const selected=Object.fromEntries(['developer','reviewer'].map(stage=>{
    const row=[task,project,global].map(layer=>layer?.stages[stage]).find(value=>value!==undefined);
    if(row===undefined)return [stage,null];
    need(row.mode==='manual','legacy_recommendation_requires_explicit_choice');
    shape(row,['mode','provider','model','effort']);const {mode,...raw}=row;
    return [stage,{provider:raw.provider,pair:tuple(raw.provider,raw)}];
  }));
  return Object.fromEntries(Object.keys(base).map(provider=>{
    const effective=Object.fromEntries(['developer','reviewer'].map(stage=>[stage,selected[stage]?.provider===provider?selected[stage].pair:base[provider][stage]]));
    const conflict=digest(effective.developer)!==digest(effective.reviewer);
    return [provider,{...effective,conflict,pair:conflict?null:effective.developer}];
  }));
}
