// Duplex transport for a trusted current conversation. This has no task,
// permission, dispatch-grant or completion authority and persists no state.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {digest,json,need,shape} from './effect-contract.mjs';

// Optional notice (runtime/js/notify.mjs) when one call waits too long for the
// session. Loaded lazily; it only notifies and never answers or cancels a call.
function waitNotice(kind,callId){
  let cancelled=false,cancel=null;
  const workflow=path.basename(process.argv[1]??'').replace(/-host\.mjs$/,'').replace(/\.mjs$/,'')||'cm';
  import('../notify.mjs').then(({scheduleWaitNotice})=>{
    if(!cancelled)cancel=scheduleWaitNotice({kind,callId,workflow,project:process.cwd()});
  }).catch(()=>{});
  return ()=>{cancelled=true;cancel?.();};
}

// Every call has a deadline (R0). A call without its own timeoutMs waits at most
// the host answer limit: CM_HOST_ANSWER_TIMEOUT_MINUTES (integer 1-60, default 30).
// It is read when the host starts and is never journaled, so it changes no run
// fingerprint and a resumed run may use another value. Hosts whose calls already
// run under their own budget (cm-ai, cm-ai batch, cm-fix: at most 60 minutes)
// pass HOST_ANSWER_BACKSTOP_MS, which never fires before that budget.
export const HOST_ANSWER_TIMEOUT_DEFAULT_MS=30*60000;
export const HOST_ANSWER_TIMEOUT_MAX_MS=60*60000;
export const HOST_ANSWER_BACKSTOP_MS=HOST_ANSWER_TIMEOUT_MAX_MS+60000;
export function hostAnswerTimeoutMs(env=process.env){
  const raw=env.CM_HOST_ANSWER_TIMEOUT_MINUTES;
  if(raw===undefined||raw==='')return HOST_ANSWER_TIMEOUT_DEFAULT_MS;
  need(/^[1-9][0-9]?$/.test(raw)&&Number(raw)<=60,'host_answer_timeout_invalid');
  return Number(raw)*60000;
}
// qa_assess carries runner-proven changedFiles and project criticalPaths. Its
// consumer validates only {confirmed:true}; scores/semantic risk flags are not
// part of this kind's business contract. The bridge remains transport-only.
// Every kind a workflow host may ask the session. A kind missing here makes
// that step throw host_operation_invalid on every attempt (O20: the second-round
// refactor judge revision, refactor_revise_tests, was missing).
export const HOST_CALL_KINDS=Object.freeze(['develop','check','verification_precheck','check_runtime','check_semantic','qa_assess','qa_logic','qa_browser','change_impact','test_cases','refactor_analyze','refactor_confirm','refactor_apply','refactor_review','refactor_batch','refactor_prepare_tests','refactor_revise_tests','refactor_retrospective','refactor_recover','documentation_sync','documentation_inspect','fix_diagnose','fix_learning','fix_test_author','fix_repair','fix_retrospective','init_analyze','init_generate','init_verify','init_confirm','init_review','init_write','idea_interview','idea_confirm_save','prd_analyze','prd_materials','prd_generate','prd_self_check','prd_review','prd_correct','prd_summary']);
// Answers that first run the project's own commands (test suites, builds,
// devices) normally take tens of minutes; they always get the 60-minute maximum.
const COMMAND_KINDS=new Set(['check','verification_precheck','init_verify','check_runtime','qa_logic','qa_browser']);
// A late answer (its call already stopped by the deadline or a cancel) is refused
// with one diagnostic line; it never reaches the step that stopped waiting.
const LATE_CALLS=32;
const lateDiagnostic=fields=>{try{process.stderr.write(JSON.stringify({diagnostic:'host_response_late',...fields})+'\n');}catch{}};

export function createHostToolBridge({responseLimit=64*1024,answerTimeoutMs=hostAnswerTimeoutMs()}={}){
  need(Number.isSafeInteger(responseLimit)&&responseLimit>=64*1024&&responseLimit<=4*1024*1024,'host_response_limit_invalid');
  need(Number.isSafeInteger(answerTimeoutMs)&&answerTimeoutMs>=1000&&answerTimeoutMs<=HOST_ANSWER_BACKSTOP_MS,'host_answer_timeout_invalid');
  const sessionId=randomUUID();let send=null,pending=null,closed=false,lastProgressAt=Date.now();
  // Metadata only: never expose the request payload or answer through liveness.
  const inFlight=()=>pending?{callId:pending.request.callId,kind:pending.request.kind,
    startedAt:new Date(pending.startedAt).toISOString(),deadlineMs:pending.deadlineMs}:null;
  const stopped=new Map();
  const stop=(code,call=pending)=>{
    if(!call||pending!==call)return;pending=null;lastProgressAt=Date.now();clearTimeout(call.timer);call.notice?.();
    call.signal.removeEventListener('abort',call.abort);
    if(code!=='host_disconnected'){stopped.set(call.request.callId,{kind:call.request.kind,stoppedBy:code});
      if(stopped.size>LATE_CALLS)stopped.delete(stopped.keys().next().value);}
    call.reject(Object.assign(new Error(code),{code}));
  };
  return Object.freeze({
    sessionId,
    inFlight,
    lastProgressAt:()=>lastProgressAt,
    attach(sender,{heartbeat=false}={}){
      need(send===null&&typeof sender==='function'&&!closed,'host_bridge_unavailable');send=sender;
      Promise.resolve(send({type:'host_ready',sessionId,...(heartbeat?{heartbeat:{intervalMs:5000,timeoutMs:30000}}:{})})).catch(()=>{closed=true;stop('host_disconnected');});
    },
    call(kind,payload,signal,{timeoutMs=null}={}){
      need(send!==null&&!closed,'host_bridge_unavailable');need(pending===null,'host_bridge_busy');
      need(HOST_CALL_KINDS.includes(kind),'host_operation_invalid');need(!signal.aborted,'cancelled');
      const data=json({kind,payload},12*1024*1024);
      const request={type:'host_request',sessionId,callId:randomUUID(),requestDigest:digest(data),...data};
      need(timeoutMs===null||Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=3600000,'host_request_timeout_invalid');
      return new Promise((resolve,reject)=>{
        const abort=()=>{
          stop('cancelled',call);
          Promise.resolve(send({type:'host_call_cancelled',sessionId,callId:request.callId})).catch(()=>{});
        };
        const startedAt=Date.now(),duration=timeoutMs??(COMMAND_KINDS.has(kind)?Math.max(answerTimeoutMs,HOST_ANSWER_TIMEOUT_MAX_MS):answerTimeoutMs);
        const call={request,signal,abort,resolve,reject,startedAt,deadlineMs:startedAt+duration,timer:null,notice:waitNotice(kind,request.callId)};
        pending=call;lastProgressAt=startedAt;
        if(timeoutMs!==null)call.timer=setTimeout(()=>stop('host_request_timeout',call),timeoutMs);
        // The default deadline never keeps an otherwise finished process alive.
        else {call.timer=setTimeout(()=>stop('host_request_timeout',call),
          COMMAND_KINDS.has(kind)?Math.max(answerTimeoutMs,HOST_ANSWER_TIMEOUT_MAX_MS):answerTimeoutMs);call.timer.unref?.();}
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        Promise.resolve().then(()=>{
          if(pending?.request===request&&!closed&&!signal.aborted)return send(request);
        }).catch(()=>stop('host_disconnected',call));
      });
    },
    accept(raw,{inFlight:operation=null}={}){
      let reply;
      try{
        if(raw?.type==='host_close'){
          shape(raw,['type','sessionId',...(Object.hasOwn(raw,'force')?['force']:[])]);need(raw.sessionId===sessionId&&!closed,'host_response_mismatch');
          need(raw.force===undefined||typeof raw.force==='boolean','host_response_mismatch');
          const active=operation??(pending?{requestId:null,operation:null,startedAt:inFlight().startedAt,stage:pending.request.kind,call:inFlight()}:null);
          if(active&&raw.force!==true)return {accepted:false,code:'host_close_busy',inFlight:active,
            message:'上一步仍在执行，请继续等待其结果；只有明确放弃本次在途工作时才传 force:true。'};
          closed=true;stop('host_disconnected');return {accepted:true,closing:true,...(active?{
            warning:'已强制关闭在途工作，原运行可能进入 unknown；请核对原运行状态后恢复。',inFlight:active}:{})};
        }
        reply=json(raw,responseLimit);shape(reply,['type','sessionId','callId','requestDigest','result']);
        const late=reply.type==='host_result'&&reply.sessionId===sessionId&&pending?.request.callId!==reply.callId
          ?stopped.get(reply.callId):undefined;
        if(late){lateDiagnostic({kind:late.kind,callId:reply.callId,stoppedBy:late.stoppedBy});
          return {accepted:false,code:'host_response_late'};}
        need(reply.type==='host_result'&&pending!==null&&!closed,'host_response_mismatch');
        for(const key of ['sessionId','callId','requestDigest'])need(reply[key]===pending.request[key],'host_response_mismatch');
      }catch(error){return {accepted:false,code:error?.code==='limit_exceeded'?'host_response_too_large':'host_response_mismatch'};}
      const call=pending;pending=null;lastProgressAt=Date.now();clearTimeout(call.timer);call.notice?.();call.signal.removeEventListener('abort',call.abort);
      call.resolve(reply.result);return {accepted:true,callId:reply.callId};
    },
    close(){closed=true;stop('host_disconnected');},
  });
}
