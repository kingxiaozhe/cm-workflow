// Serial child host. Existing owners retain lifecycle and action authority.
import fs from 'node:fs';
import path from 'node:path';
import {openFixExecution} from '../cm-fix/execution.mjs';
import {createFixHost} from '../cm-fix/host.mjs';
import {bindQaFixDefinition} from './qa-fix-definition.mjs';
import {digest,id,json,need,shape,validIdentity,hex} from './effect-contract.mjs';

export function createQaFixOwnerHost({parent,reopenParent,fix=null,template=null,allowStart=false,autoFix=false,fixExecution={},fixPermissions=[],fixAuthorities={}}){
  need((fix===null)!==(template===null),'invalid_fix_config');
  let definition=null;
  const fixedTemplate=template===null?null:json(template,64*1024);
  if(fixedTemplate){
    shape(fixedTemplate,['specsRoot','feature','identity','configuration']);validIdentity(fixedTemplate.identity);
    need(!Object.hasOwn(fixedTemplate.configuration,'qaSource'),'invalid_fix_template');
  }else{
    shape(fix,['specsRoot','identity','configuration']);definition=json(fix,64*1024);
    validIdentity(definition.identity);need(definition.configuration.qaSource,'qa_fix_source_required');
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
      const value=json(request);shape(value,['version','requestId','operation','identity','packageDigest','testRunId',
        ...(request.operation==='fix_action'?['fixOperation']:[])]);
      need(value.version===1,'invalid_input');id(value.requestId);validIdentity(value.identity);hex(value.packageDigest);id(value.testRunId);
      if(fixedTemplate)definition=bindQaFixDefinition({template:fixedTemplate,identity:value.identity,
        packageDigest:value.packageDigest,testRunId:value.testRunId});
      const source=definition.configuration.qaSource;
      need(digest(source.identity)===digest(value.identity)&&source.packageDigest===value.packageDigest
        &&source.testRunId===value.testRunId,'qa_fix_source_mismatch');
      const running=value.operation==='fix_run';
      const advancing=value.operation==='fix_advance'||running;
      const acting=value.operation==='fix_action';
      if(acting)need(['red_test','baseline','author_tests','repair','regression','retrospective','learning_writeback',
        'handoff','final_review_package','final_review','publish_review','check_n5','post_review_regression',
        'publish_dossier','walkthrough','finish','prepare_revision','cause_review_package','cause_review'].includes(value.fixOperation),'fix_operation_unavailable');
      need(!(advancing||acting)||allowStart,'qa_fix_start_authorization_required');
      busy=true;let child=null,released=false,result;
      try{
        const status=await current.host.handle({version:1,operation:'status',requestId:value.requestId,identity:value.identity});
        need(status.state==='fixture_completed'&&status.packageDigest===value.packageDigest
          &&digest(status.identity)===digest(value.identity),'qa_fix_parent_not_completed');
        switching=true;current.close();current=null;released=true;
        const existing=fs.existsSync(path.join(definition.specsRoot,'.reviews','.execution',definition.identity.runId));
        child=openFixExecution({...definition,create:advancing&&!existing},advancing||acting?fixExecution:{});
        activeChild=child;
        let actionResult;
        if(advancing||acting){
          const host=createFixHost({owner:child,config:{...definition.configuration,specsRoot:definition.specsRoot,identity:definition.identity},
            runtime:definition.configuration.runtime??'codex',permissions:[...permissions,'--allow-reproduction'],...fixAuthorities});
          actionResult=running?await host.run(value.requestId)
            :await host.handle({requestId:value.requestId,operation:advancing?'advance':value.fixOperation});
        }
        // Original observing finish intentionally closes its owner. Preserve
        // that successful incomplete exit without reading a closed store.
        if(acting&&value.fixOperation==='finish'&&actionResult?.observationRunEnded===true)
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
          const association=current.inspectFixAssociation(result.evidence.reviewPackage);
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
