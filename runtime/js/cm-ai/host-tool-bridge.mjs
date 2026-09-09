// Duplex transport for a trusted current conversation. This has no task,
// permission, dispatch-grant or completion authority and persists no state.
import {randomUUID} from 'node:crypto';
import {digest,json,need,shape} from './effect-contract.mjs';

export function createHostToolBridge({responseLimit=64*1024}={}){
  need(Number.isSafeInteger(responseLimit)&&responseLimit>=64*1024&&responseLimit<=4*1024*1024,'host_response_limit_invalid');
  const sessionId=randomUUID();let send=null,pending=null,closed=false;
  const stop=code=>{
    const call=pending;if(!call)return;pending=null;
    call.signal.removeEventListener('abort',call.abort);
    call.reject(Object.assign(new Error(code),{code}));
  };
  return Object.freeze({
    attach(sender){
      need(send===null&&typeof sender==='function'&&!closed,'host_bridge_unavailable');send=sender;
      Promise.resolve(send({type:'host_ready',sessionId})).catch(()=>{closed=true;stop('host_disconnected');});
    },
    call(kind,payload,signal){
      need(send!==null&&!closed,'host_bridge_unavailable');need(pending===null,'host_bridge_busy');
      need(['develop','check','check_runtime','check_semantic','qa_assess','qa_logic','qa_browser','test_cases','refactor_analyze','refactor_confirm','refactor_apply','refactor_review','refactor_batch','refactor_prepare_tests','refactor_retrospective','refactor_recover','documentation_sync','documentation_inspect','fix_diagnose','fix_learning','fix_test_author','fix_repair','fix_retrospective','init_analyze','init_generate','init_verify','init_confirm','init_review','init_write','idea_interview','idea_confirm_save','prd_analyze','prd_materials','prd_generate','prd_self_check','prd_review','prd_correct','prd_summary']
        .includes(kind),'host_operation_invalid');need(!signal.aborted,'cancelled');
      const data=json({kind,payload},12*1024*1024);
      const request={type:'host_request',sessionId,callId:randomUUID(),requestDigest:digest(data),...data};
      return new Promise((resolve,reject)=>{
        const abort=()=>{
          stop('cancelled');
          Promise.resolve(send({type:'host_call_cancelled',sessionId,callId:request.callId})).catch(()=>{});
        };
        pending={request,signal,abort,resolve,reject};signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        Promise.resolve().then(()=>{
          if(pending?.request===request&&!closed&&!signal.aborted)return send(request);
        }).catch(()=>stop('host_disconnected'));
      });
    },
    accept(raw){
      let reply;
      try{
        if(raw?.type==='host_close'){
          shape(raw,['type','sessionId']);need(raw.sessionId===sessionId&&!closed,'host_response_mismatch');
          closed=true;stop('host_disconnected');return {accepted:true,closing:true};
        }
        reply=json(raw,responseLimit);shape(reply,['type','sessionId','callId','requestDigest','result']);
        need(reply.type==='host_result'&&pending!==null&&!closed,'host_response_mismatch');
        for(const key of ['sessionId','callId','requestDigest'])need(reply[key]===pending.request[key],'host_response_mismatch');
      }catch{return {accepted:false,code:'host_response_mismatch'};}
      const call=pending;pending=null;call.signal.removeEventListener('abort',call.abort);
      call.resolve(reply.result);return {accepted:true,callId:reply.callId};
    },
    close(){closed=true;stop('host_disconnected');},
  });
}
