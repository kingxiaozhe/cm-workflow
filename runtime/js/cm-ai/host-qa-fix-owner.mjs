import {selectExternalModels} from './external-models.mjs';
import {readExecutionPolicy} from './execution-policy.mjs';
// Serial child host. Existing owners retain lifecycle and action authority.
import fs from 'node:fs';
import path from 'node:path';
import {openFixExecution} from '../cm-fix/execution.mjs';
import {createFixHost} from '../cm-fix/host.mjs';
import {bindQaFixDefinition} from './qa-fix-definition.mjs';
import {digest,id,json,need,shape,validIdentity,hex} from './effect-contract.mjs';

// Q23: the child's recovery operations, each with the original cm-fix flag the
// shared dispatcher (cm-fix/host.mjs) checks and the parent flag that grants it.
// The dispatcher stays the only validator; this table only names the missing flag.
const QA_FIX_ACTION_FLAGS=Object.freeze({rediagnose:'--allow-rediagnosis',rerun_blocked_step:'--allow-rerun-blocked-step',
  recover_final_review:'--allow-final-review-recovery',abandon_step:'--allow-abandon',abandon_review:'--allow-abandon-review',
  revision_test_check:'--allow-regression'});
const QA_FIX_REASONED=['abandon_step','abandon_review','rediagnose','rerun_blocked_step'];
export const QA_FIX_ACTIONS=Object.freeze(['red_test','baseline','author_tests','repair','regression','retrospective','learning_writeback',
  'handoff','final_review_package','final_review','publish_review','check_n5','post_review_regression',
  'publish_dossier','walkthrough','finish','prepare_revision','cause_review_package','cause_review','reconcile_review',
  ...Object.keys(QA_FIX_ACTION_FLAGS)]);
const parentFlag=flag=>flag.replace(/^--allow-/,'--allow-qa-fix-');
const actionRefusal=(fixOperation,code,reason)=>Object.freeze({outcome:'rejected',code,fixOperation,reason,
  guidance:Object.freeze({summary:'QA 修复子流程的这次操作被拒绝，子运行没有因此改变。',nextStep:reason,
    recoveryOperation:null,prerequisites:Object.freeze([]),authorizationGranted:false})});
export function createQaFixOwnerHost({parent,reopenParent,hostContextId,parentHostContextId,fix=null,template=null,allowStart=false,autoFix=false,fixExecution={},fixPermissions=[],fixAuthorities={},externalModels=null,executionPolicy=null,recoveryInvocationId=null}){
  id(hostContextId);id(parentHostContextId);
  if(recoveryInvocationId!==null)id(recoveryInvocationId);
  need((fix===null)!==(template===null),'invalid_fix_config');
  let definition=null;
  let fixedTemplate=template===null?null:json(template,64*1024);
  if(fixedTemplate){
    shape(fixedTemplate,['specsRoot','feature','identity','configuration']);validIdentity(fixedTemplate.identity);
    need(!Object.hasOwn(fixedTemplate.configuration,'qaSource'),'invalid_fix_template');
  }else{
    shape(fix,['specsRoot','identity','configuration']);definition=json(fix,64*1024);
    validIdentity(definition.identity);need(definition.configuration.qaSource,'qa_fix_source_required');
  }
  if(executionPolicy){
    const selected=readExecutionPolicy(executionPolicy),target=fixedTemplate??definition;
    if(!fixedTemplate&&!target.configuration.executionPolicy)need(false,'execution_policy_legacy_child_inheritance_forbidden');
    if(target.configuration.executionPolicy)need(digest(target.configuration.executionPolicy)===digest(selected),'execution_policy_child_conflict');
    const inherited={...target,configuration:{...target.configuration,executionPolicy:selected}};
    if(fixedTemplate)fixedTemplate=inherited;else definition=inherited;
  }
  if(externalModels){
    const target=fixedTemplate??definition,runtime=target.configuration.runtime??'codex';
    const selected=selectExternalModels(externalModels,[runtime]);
    if(!fixedTemplate&&!target.configuration.externalModels)need(false,'external_model_legacy_child_inheritance_forbidden');
    if(target.configuration.externalModels)need(digest(target.configuration.externalModels)===digest(selected),'external_model_pair_conflict');
    const inherited={...target,configuration:{...target.configuration,externalModels:selected}};
    if(fixedTemplate)fixedTemplate=inherited;else definition=inherited;
  }
  need(typeof allowStart==='boolean','invalid_input');
  need(typeof autoFix==='boolean'&&(!autoFix||(allowStart&&fixedTemplate!==null)),'qa_fix_auto_authorization_required');
  need(typeof reopenParent==='function','invalid_input');
  const permissions=json(fixPermissions);need(Array.isArray(permissions)&&permissions.every(value=>typeof value==='string'),'invalid_input');
  shape(fixAuthorities,['authority','finalAuthority'].filter(key=>Object.hasOwn(fixAuthorities,key)));
  let current=parent,busy=false,switching=false,closed=false,activeChild=null;
  const dispatch={
    async handle(request){
      need(!closed,'host_unavailable');
      if(busy){
        if(activeChild&&['status','cancel'].includes(request.operation)){
          const control=json(request);shape(control,['version','requestId','operation','identity']);
          need(control.version===1,'invalid_input');id(control.requestId);validIdentity(control.identity);
          need(digest(control.identity)===digest(definition.configuration.qaSource.identity),'qa_fix_source_mismatch');
          return {outcome:'reported',code:'qa_fix_active',fix:control.operation==='cancel'?activeChild.cancel():activeChild.status()};
        }
        if(['status','cancel'].includes(request.operation))return switching
          ?{outcome:'blocked',code:'qa_fix_owner_busy'}:current.host.handle(request);
        need(false,'host_busy');
      }
      need(current!==null,'host_unavailable');
      if(!['fix_status','fix_advance','fix_action','fix_run'].includes(request.operation)){
        busy=true;try{return await current.host.handle(request);}finally{busy=false;}
      }
      // recover_final_review binds the child's final review package; packageDigest
      // here is the parent QA package, so the child digest is reviewPackageDigest.
      const value=json(request);shape(value,['version','requestId','operation','identity','packageDigest','testRunId',
        ...(request.operation==='fix_action'?['fixOperation',...(request.fixOperation==='reconcile_review'?['invocationId']:[]),
          ...(QA_FIX_REASONED.includes(request.fixOperation)&&Object.hasOwn(request,'reason')?['reason']:[]),
          ...(request.fixOperation==='prepare_revision'&&Object.hasOwn(request,'tests')?['tests']:[]),
          ...(request.fixOperation==='recover_final_review'?['invocationId','reviewPackageDigest','previousInvocationStopped','reason']:[])]:[])]);
      need(value.version===1,'invalid_input');id(value.requestId);validIdentity(value.identity);hex(value.packageDigest);id(value.testRunId);
      if(fixedTemplate)definition=bindQaFixDefinition({template:fixedTemplate,identity:value.identity,
        packageDigest:value.packageDigest,testRunId:value.testRunId});
      const source=definition.configuration.qaSource;
      need(digest(source.identity)===digest(value.identity)&&source.packageDigest===value.packageDigest
        &&source.testRunId===value.testRunId,'qa_fix_source_mismatch');
      const running=value.operation==='fix_run';
      const advancing=value.operation==='fix_advance'||running;
      const acting=value.operation==='fix_action';
      if(acting)need(QA_FIX_ACTIONS.includes(value.fixOperation),'fix_operation_unavailable');
      need(!(advancing||acting)||allowStart,'qa_fix_start_authorization_required');
      // Refuse a recovery action whose flag this launch lacks before the parent is
      // closed, naming the parent flag; the cm-fix dispatcher still re-checks it.
      const actionFlag=acting?QA_FIX_ACTION_FLAGS[value.fixOperation]:undefined;
      if(actionFlag&&!permissions.includes(actionFlag))return actionRefusal(value.fixOperation,'qa_fix_action_authorization_required',
        `fix_action ${value.fixOperation} 需要父宿主启动参数 ${parentFlag(actionFlag)}（等同单独 cm-fix-host 的 ${actionFlag}）；关闭父宿主，带上该参数以 --mode resume 重开后再发 fix_action。`);
      busy=true;let child=null,released=false,result;
      try{
        const status=await current.host.handle({version:1,operation:'status',requestId:value.requestId,identity:value.identity});
        need(status.state==='fixture_completed'&&status.packageDigest===value.packageDigest
          &&digest(status.identity)===digest(value.identity),'qa_fix_parent_not_completed');
        switching=true;current.close();current=null;released=true;
        const existing=fs.existsSync(path.join(definition.specsRoot,'.reviews','.execution',definition.identity.runId));
        // Only a new store needs a creator check. Existing configuration is
        // immutable and checked against its own stored fingerprint by cm-fix.
        if(advancing&&!existing)need([hostContextId,parentHostContextId].includes(definition.configuration.hostContextId),'qa_fix_host_mismatch');
        child=openFixExecution({...definition,hostContextId,create:advancing&&!existing},advancing||acting?fixExecution:{});
        activeChild=child;
        let actionResult;
        if(advancing||acting){
          const host=createFixHost({owner:child,config:{...definition.configuration,specsRoot:definition.specsRoot,identity:definition.identity},
            runtime:definition.configuration.runtime??'codex',permissions:[...permissions,'--allow-reproduction'],...fixAuthorities,recoveryInvocationId});
          const action=advancing?{operation:'advance'}:{operation:value.fixOperation,
            ...(value.fixOperation==='reconcile_review'?{invocationId:value.invocationId}:{}),
            ...(QA_FIX_REASONED.includes(value.fixOperation)?{reason:value.reason}:{}),
            ...(value.fixOperation==='prepare_revision'&&Object.hasOwn(value,'tests')?{tests:value.tests}:{}),
            ...(value.fixOperation==='recover_final_review'?{invocationId:value.invocationId,packageDigest:value.reviewPackageDigest,
              previousInvocationStopped:value.previousInvocationStopped,reason:value.reason}:{})};
          try{actionResult=running?await host.run(value.requestId):await host.handle({requestId:value.requestId,...action});}
          catch(error){
            // A refused recovery action is the original cm-fix refusal, reported with
            // its code instead of an opaque host failure; the parent still reopens.
            if(!(acting&&actionFlag&&typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)))throw error;
            return actionRefusal(value.fixOperation,error.code,
              `cm-fix 拒绝了 ${value.fixOperation}（${error.code}）：子运行当前阶段不满足该操作的条件或参数不匹配；先用 fix_status 核对 fixStage 与 progress，再按 skills/cm-fix/references/js-host.md 的条件重发。`);
          }
        }
        // Original observation/escalation finish intentionally closes its owner. Preserve
        // that successful incomplete exit without reading a closed store.
        if(actionResult?.observationRunEnded===true||actionResult?.escalationRunEnded===true)
          return json({outcome:'blocked',code:'qa_fix_incomplete',fixStage:actionResult.stage,actionResult},12*1024*1024);
        const observed=child.status();
        result=observed.stage==='completed'&&observed.completionEligible===true
          ?json({outcome:'verified',code:'qa_fix_completed',evidence:child.completionEvidence()},12*1024*1024)
          :json({outcome:'blocked',code:'qa_fix_incomplete',fixStage:observed.stage,
            ...(acting?{actionResult}: {})},12*1024*1024);
      }finally{
        try{activeChild=null;child?.close();if(released)current=await reopenParent();}
        finally{busy=false;switching=false;}
      }
      // Evidence came from the original child owner, not from a caller receipt.
      // Read-only comparison alone does not clear a gate; accepting the original
      // completion evidence uses the existing parent journal contract.
      if(result.code==='qa_fix_completed'&&typeof current.inspectFixAssociation==='function'){
        try{
          const association=current.inspectFixAssociation(result.evidence.reviewPackage,result.evidence);
          const accepted=(running||(acting&&value.fixOperation==='finish'))&&typeof current.acceptCompletedFix==='function'
            ?current.acceptCompletedFix(result.evidence):null;
          return json({...result,association,...(accepted?{accepted}: {})},12*1024*1024);
        }
        catch(error){return json({...result,outcome:'blocked',code:'qa_fix_code_unmatched',
          reason:error.code??error.message},12*1024*1024);}
      }
      return result;
    },
    close(){need(!busy,'host_busy');if(!closed){closed=true;current?.close();current=null;}},
  };
  let advancing=false,cancellationEpoch=0;
  return Object.freeze({
    async handle(request){
      if(advancing){
        need(['status','cancel'].includes(request.operation),'host_busy');
        const result=await dispatch.handle(request);
        if(request.operation==='cancel'&&(result.outcome==='cancelled'||result.code==='qa_fix_active'))cancellationEpoch++;
        return result;
      }
      if(!autoFix||request.operation!=='advance')return dispatch.handle(request);
      request=json(request);
      advancing=true;const epoch=cancellationEpoch;
      try{
        for(let round=0;round<3;round++){
          const result=await dispatch.handle(request);
          if(result.code!=='qa_failed'||result.fixHandoff?.status!=='dispatch_required'||epoch!==cancellationEpoch)return result;
          need(round<2,'qa_round_invalid');
          const repaired=await dispatch.handle({version:1,requestId:request.requestId,operation:'fix_run',
            identity:result.identity,packageDigest:result.packageDigest,testRunId:result.fixHandoff.source.testRunId});
          if(repaired.code!=='qa_fix_completed'||!repaired.accepted||epoch!==cancellationEpoch)return repaired;
        }
        need(false,'qa_round_invalid');
      }finally{advancing=false;}
    },
    close(){need(!advancing,'host_busy');dispatch.close();},
  });
}
