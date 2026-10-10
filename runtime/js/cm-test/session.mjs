// Local test replay reuses the existing effect journal; task/log authority stays
// in the original cm-test flow. Unknown actions are never dispatched twice.
import fs from 'node:fs';
import path from 'node:path';
import {openRefactorRecords,effectDigest} from '../cm-refactor/records.mjs';
import {need,digest,json,shape} from '../cm-ai/effect-contract.mjs';
import {inside,canonicalFuture,sourceChanges} from './source-snapshot.mjs';

// V1 (O21): change_impact/test_cases are read-only answers and may be discarded
// and asked again. V4: qa_logic/qa_browser act on devices or browsers, so a
// discard also needs cleanup:'completed' (session receipt or operator check that
// resources are released), recorded as a release in the same row.
export const CM_TEST_REASKABLE=Object.freeze({change_impact:{release:false},test_cases:{release:false},
  qa_logic:{release:true},qa_browser:{release:true}});
export const cmTestDiscardable=kind=>CM_TEST_REASKABLE[kind]??null;
const discardCode=code=>({refactor_discard_binding:'cm_test_discard_binding',refactor_discard_not_last:'cm_test_discard_not_last',
  refactor_discard_kind:'cm_test_discard_kind',refactor_discard_limit:'cm_test_discard_limit',
  refactor_discard_evidence_required:'cm_test_discard_evidence_required',
  refactor_discard_release_required:'cm_test_resource_release_required'})[code]??code;
export function cmTestRecoveryGuidance(recovery){
  if(!recovery)return null;
  const unknown=recovery.unknown[0],last=recovery.lastAnswer;
  if(unknown&&(unknown.kind!=='host'||!CM_TEST_REASKABLE[unknown.callKind]))return {summary:`原${unknown.kind==='command'?'命令':'记录'}结果未知（${unknown.key}），不能重做。`,
    nextStep:'只用原执行回执 {key,requestDigest,result,evidence,cleanup:"completed"} 恢复；没有回执就人工核对后另起新运行。',authorizationGranted:false};
  const target=unknown??last;
  if(!target)return null;
  const kind=unknown?unknown.callKind:last.kind,release=CM_TEST_REASKABLE[kind]?.release;
  if(!CM_TEST_REASKABLE[kind])return null;
  return {summary:unknown?`${kind} 的应答没有拿到（超时、断开或宿主退出），会话也没有原回执。`:`已记录的 ${kind} 应答被宿主拒收，每次 resume 都会原样失败。`,
    nextStep:`resume 带 resolution {key:"${target.key}",requestDigest:"${target.requestDigest}",discard:true,evidence:"原因"${release?',cleanup:"completed"':''}} 作废后重问；`
      +(release?'它会操作浏览器或设备，只有会话确认清理完成或你核实资源已释放（设备可能仍在使用）后才能带 cleanup:"completed"；':'')+'每种最多 2 次。',
    authorizationGranted:false};
}
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
  const records=openRefactorRecords(directory,{discardable:cmTestDiscardable});records.acquire();
  let sequence=0,resolution=null;
  const unknown=()=>[...records.effects].find(([,entry])=>!Object.hasOwn(entry,'result'));
  return {
    get context(){return records.context;},
    get progress(){return records.progress;},
    get logFile(){return [...records.effects.values()].filter(entry=>entry.result?.value?.logFile).at(-1)?.result.value.logFile??null;},
    get pending(){const entry=unknown();return entry?{key:entry[0],kind:entry[1].kind,requestDigest:effectDigest(entry[1])}:null;},
    get recovery(){return records.recovery;},
    initialize(context){records.initialize({...context,workflow:'cm-test',configDigest:digest(config)});},
    // legacy: older bindings accepted as a controlled migration (policy-binding-compat.mjs).
    validate(binding,legacy=[]){need(records.context?.workflow==='cm-test'&&records.context.configDigest===digest(config)
      &&[binding,...legacy].some(item=>digest(records.context.binding)===digest(item)),'cm_test_session_binding_changed');},
    begin(current,receipt){
      need(!records.progress?.cancelled,'cancelled');
      const last=[...records.effects.values()].filter(entry=>Object.hasOwn(entry,'result')).at(-1)?.result.source??records.context.source;
      need(sourceChanges(last,current).length===0,'cm_test_resume_source_changed');
      const logged=[...records.effects.values()].filter(entry=>entry.result?.value?.logDigest).at(-1)?.result.value;
      if(logged)need(fs.realpathSync(logged.logFile)===logged.logFile&&fs.lstatSync(logged.logFile).isFile()
        &&digest(fs.readFileSync(logged.logFile,'utf8'))===logged.logDigest,'cm_test_resume_log_changed');
      if(receipt?.discard===true){
        shape(receipt,['key','requestDigest','discard','evidence',...(Object.hasOwn(receipt,'cleanup')?['cleanup']:[])]);
        need(!Object.hasOwn(receipt,'cleanup')||['completed'].includes(receipt.cleanup),'cm_test_resolution_invalid');
        const entry=records.effects.get(receipt.key),kind=entry?.kind==='host'?entry.input.kind:null;
        need(!CM_TEST_REASKABLE[kind]?.release||receipt.cleanup==='completed','cm_test_resource_release_required');
        try{records.discard({key:receipt.key,requestDigest:receipt.requestDigest,evidence:receipt.evidence,
          released:CM_TEST_REASKABLE[kind]?.release?`cleanup completed: ${receipt.evidence}`:null});}
        catch(error){throw Object.assign(new Error(discardCode(error.code)),{code:discardCode(error.code)});}
        receipt=null;
      }
      if(receipt!==null){
        shape(receipt,['key','requestDigest','result','evidence','cleanup']);const pending=this.pending;
        // A late receipt of a discarded attempt never becomes the result of the attempt asked afterwards.
        need(!records.discarded(receipt.key,receipt.requestDigest),'cm_test_resolution_abandoned');
        need(pending&&['host','command'].includes(pending.kind)&&receipt.key===pending.key&&receipt.requestDigest===pending.requestDigest
          &&typeof receipt.evidence==='string'&&receipt.evidence.trim()&&receipt.cleanup==='completed','cm_test_resolution_invalid');
      }
      resolution=receipt;sequence=0;
    },
    async effect(kind,input,perform,snapshot){
      const key=String(++sequence);
      return (await records.effect(key,kind,input,async()=>({value:await perform(),source:snapshot()}),async old=>{
        if(['snapshot','evaluation'].includes(old.kind))return {value:await perform(),source:snapshot()};
        need(resolution&&resolution.key===key&&resolution.requestDigest===effectDigest(old),'cm_test_outcome_unknown');
        const {result,...provenance}=resolution,value=json(result,4*1024*1024);
        resolution=null;return {value,source:snapshot(),reconciliation:{source:'trusted_host_original_result',...provenance}};
      })).value;
    },
    save(value){records.progressWrite(value);},
    close(){records.release();}
  };
}
