// JSONL transport only. The existing host/runner owns decisions and durable state.
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {executionDiagnostic,need} from './effect-contract.mjs';
import {diagnosticReason} from './diagnostic-reason.mjs';
import {withHostStageObserver} from './host-stage-observer.mjs';

const LIMIT=64*1024;
// One wording for every host that stops on an over-limit line.
export const inputLimitReason=limit=>`an input line exceeded --input-limit ${Number.isSafeInteger(limit)?limit:LIMIT} bytes `
  +`(default ${LIMIT}, maximum ${4*1024*1024}); restart the same run with --mode resume and a larger --input-limit`;
export function parseHostInputLimit(raw){
  if(raw===undefined)return LIMIT;
  const value=Number(raw);
  need(typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)&&Number.isSafeInteger(value)
    &&value>=LIMIT&&value<=4*1024*1024,'invalid_arguments');
  return value;
}
const operationNames=new Set(['prepare_diagnosis_module_correction','revision_test_check','prepare_test_type_correction','prepare_command_correction','prepare_verification_recovery','repair_review_response','reconcile_review','rediagnose','replace_inputs','read_batch','recover_final_review','abandon_step','abandon_review','rerun_blocked_step','abandon_effect','bootstrap_review_recover','completion_rework','development_rework','revise_scope','develop_redo','advance','start','plan_design','promote_design','select_design_reviews','status','fix_status','fix_advance','fix_action','fix_run','decision','complete','qa','qa_result','prepare_revision','prepare_save',
  'context_refresh','finish','completion_evidence','run_finalize','review_findings','review_disposition','save_draft','save_design','correct_findings','prepare_summary','publish_summary','inspect_correction','resume_correction','cancel','resume','prepare_judge_revision','cause_review_package','cause_review','red_test','baseline','author_tests','repair','regression','retrospective','learning_writeback','handoff','final_review_package','final_review','publish_review','check_n5','post_review_regression','publish_dossier','walkthrough']);

// Which contract codes may reach the peer is a deliberate boundary: the host
// exposes chosen ones as a blocked result with a reason and redacts the rest to
// host_request_failed. That boundary is kept exactly as is. What was missing is
// that the redacted ones vanished entirely, leaving the operator with no way to
// tell a missing field from a wrong one. The real code now goes to this
// process's own stderr and nowhere else: not to the peer, not to any log or
// state. Named fields only, never error.message.
function reportRequestFailure(errorOutput,operation,error){
  try{
    const detail=executionDiagnostic(error);
    const reason=diagnosticReason(error);
    errorOutput.write(JSON.stringify({diagnostic:'host_request_failed',operation,
      ...(detail??{detail:'unavailable'}),...(reason?{reason}:{})})+'\n');
  }catch{/* diagnostics never change the reply */}
}

// Optional idle notice (runtime/js/notify.mjs): counts from the reply of the
// last real operation while nothing is in flight. Any other session line
// (including one the host rejects) is the next step and ends the wait; a
// status/fix_status poll neither ends it nor restarts it, and while a poll is
// in flight the deadline is held, not reset. Cleared at session end. Loaded
// lazily; it only notifies and never writes logs, output or state.
const POLLS=new Set(['status','fix_status']);
const workflow=path.basename(process.argv[1]??'').replace(/-host\.mjs$/,'').replace(/\.mjs$/,'')||'cm';
function idleNotice(sessionKey,seq,row,since){
  let cancelled=false,cancel=null;
  import('../notify.mjs').then(({scheduleIdleNotice})=>{
    if(!cancelled)cancel=scheduleIdleNotice({workflow,project:process.cwd(),sessionKey,seq,row,since});
  }).catch(()=>{});
  return ()=>{cancelled=true;cancel?.();};
}

// A line above the transport limit ends the session. Carry a code and the
// limit so every host can name it instead of a generic launch failure.
const tooLarge=limit=>Object.assign(new Error('request_too_large'),{code:'request_too_large',limit});
export async function serveCmAiHost({host,input,output,toolBridge=null,inputLimit=LIMIT,errorOutput=process.stderr,heartbeat=process.env.CM_HOST_HEARTBEAT==='1'}){
  if(!Number.isSafeInteger(inputLimit)||inputLimit<LIMIT||inputLimit>4*1024*1024)throw Error('input_limit_invalid');
  let pending=null,buffer=Buffer.alloc(0),failure=null,closeRequested=false;
  let writing=Promise.resolve();
  const controls=new Set(),activeControls=new Map();let queuedWrites=0,activeOperation=null;
  let progressAt=Date.now(),heartbeatTimer=null,heartbeatWriting=false;
  const inFlight=()=>{
    const operation=activeOperation??activeControls.values().next().value??null;
    const call=toolBridge?.inFlight?.()??null;
    return operation?{...operation,stage:call?.kind??operation.nativeStage?.kind??operation.operation,call}:
      call?{requestId:null,operation:null,startedAt:call.startedAt,stage:call.kind,call}:null;
  };
  const sessionKey=randomUUID(),startedAt=Date.now();let idle=null,seq=0,ended=false,lastRow=undefined,idleSince=0;
  // Host registry (runtime/js/notify.mjs): serialised so a session that ends at
  // once still removes its own entry. Each step is best-effort and synchronous.
  let registry=Promise.resolve(),registered=false;
  const register=(row,operation)=>{if(ended)return;registry=registry.then(()=>import('../notify.mjs'))
    .then(m=>{if(m.writeHostRegistry({sessionKey,workflow,project:process.cwd(),startedAt,row,operation}))registered=true;}).catch(()=>{});};
  register(null,null);
  const clearIdle=()=>{idle?.();idle=null;};
  const nextStep=()=>{clearIdle();lastRow=undefined;};
  const rearm=()=>{
    clearIdle();
    if(lastRow!==undefined&&!failure&&!closeRequested&&!ended&&pending===null&&controls.size===0)idle=idleNotice(sessionKey,seq,lastRow,idleSince);
  };
  const finished=(row,operation)=>{if(!POLLS.has(operation)){lastRow=row;idleSince=Date.now();seq++;}rearm();};
  const outputError=error=>{failure=error;toolBridge?.close();input.destroy(error);};
  const inputError=error=>{if(!closeRequested)failure=error;toolBridge?.close();};
  input.on('error',inputError);
  output.on('error',outputError);
  const reply=value=>{
    if(queuedWrites>=64){
      const error=new Error('output_backlog_exceeded');
      outputError(error);output.destroy(error);return Promise.reject(error);
    }
    queuedWrites++;
    const bytes=JSON.stringify(value)+'\n';
    writing=writing.then(()=>new Promise((resolve,reject)=>{
      if(failure){reject(failure);return;}
      const done=error=>{output.off('error',done);error?reject(error):resolve();};
      output.once('error',done);
      try{output.write(bytes,done);}catch(error){done(error);}
    })).finally(()=>{queuedWrites--;});
    // A broken output must not become an unhandled rejection while work is pending.
    writing.catch(error=>{failure=error;});
    return writing;
  };
  toolBridge?.attach(reply,{heartbeat});
  // Opt-in transport telemetry: no runner reads, journal writes or fingerprint changes.
  // Keep at most one heartbeat queued so a slow peer cannot accumulate timer output.
  if(heartbeat&&toolBridge){
    const beat=()=>{
      if(ended||failure||closeRequested||heartbeatWriting||queuedWrites>0)return;
      heartbeatWriting=true;
      reply({type:'host_heartbeat',sessionId:toolBridge.sessionId,pid:process.pid,at:new Date().toISOString(),
        lastProgressAt:new Date(Math.max(progressAt,toolBridge.lastProgressAt?.()??0)).toISOString(),inFlight:inFlight()})
        .catch(error=>{failure=error;}).finally(()=>{heartbeatWriting=false;});
    };
    // ready is already queued; send the first beat immediately after that write.
    writing.then(beat).catch(()=>{});
    heartbeatTimer=setInterval(beat,5000);heartbeatTimer.unref?.();
  }
  async function dispatch(bytes){
    if(failure)throw failure;
    let request;
    try{
      request=JSON.parse(bytes.toString('utf8'));
      if(POLLS.has(request?.operation))clearIdle();else nextStep();
      if(toolBridge!==null&&['host_result','host_close'].includes(request?.type)){
        const accepted=toolBridge.accept(request,{inFlight:inFlight()});closeRequested=accepted.closing===true;
        reply({type:'host_response',...accepted}).catch(error=>{failure=error;});return;
      }
      if(!request||typeof request!=='object'||Array.isArray(request)
        ||typeof request.requestId!=='string'||request.requestId.length>128
        ||!operationNames.has(request.operation))throw Error('invalid');
    }catch{nextStep();reply({requestId:null,error:{code:'invalid_request'}}).catch(error=>{failure=error;});return;}
    const requestId=request.requestId;
    let row=null;
    let operationActive=false,metadata=null;
    const release=()=>{if(!operationActive)return;operationActive=false;
      if(activeOperation===metadata)activeOperation=null;
      activeControls.delete(request);if(!POLLS.has(request.operation))progressAt=Date.now();};
    const begin=control=>{operationActive=true;const at=Date.now();if(!POLLS.has(request.operation))progressAt=at;
      metadata={requestId,operation:request.operation,startedAt:new Date(at).toISOString(),nativeStage:null};
      if(control)activeControls.set(request,metadata);else activeOperation=metadata;};
    const invoke=async()=>{
      try{const result=await withHostStageObserver(stage=>{
          if(operationActive){metadata.nativeStage=stage;if(!POLLS.has(request.operation))progressAt=Date.now();}
        },()=>host.handle(request));row={result};release();await reply({requestId,result});}
      catch(error){
        reportRequestFailure(errorOutput,request.operation,error);
        row={error:{code:'host_request_failed'}};release();
        await reply({requestId,...row});
      }
      finally{if(!POLLS.has(request.operation))register(row,request.operation);}
    };
    // Never queue cancel/status behind a long developer or reviewer call.
    if(request.operation==='status'||request.operation==='cancel'){
      // The input reader must not wait for a slow response consumer before it
      // can deliver the next control request (especially cancellation).
      begin(true);
      const control=invoke().finally(()=>{controls.delete(control);finished(row,request.operation);});
      controls.add(control);control.catch(error=>{failure=error;});return;
    }
    if(pending){reply({requestId,error:{code:'host_busy',inFlight:inFlight(),message:'上一步仍在执行，请继续等待该请求的结果。'}}).catch(error=>{failure=error;});return;}
    begin(false);
    pending=invoke().finally(()=>{pending=null;finished(row,request.operation);});
    pending.catch(error=>{failure=error;});
  }
  try{
    reading: for await(const chunk of input){
      if(failure)throw failure;
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      let start=0;
      for(let end=0;end<bytes.length;end++){
        if(bytes[end]!==10)continue;
        if(buffer.length+end-start>inputLimit)throw tooLarge(inputLimit);
        const line=Buffer.concat([buffer,bytes.subarray(start,end)]);
        buffer=Buffer.alloc(0);start=end+1;
        if(line.length)await dispatch(line);
        if(closeRequested)break reading;
      }
      if(buffer.length+bytes.length-start>inputLimit)throw tooLarge(inputLimit);
      buffer=Buffer.concat([buffer,bytes.subarray(start)]);
    }
    if(buffer.length&&!closeRequested)await dispatch(buffer);
  }finally{
    // With a duplex conversation, EOF means no more tool replies can arrive.
    // Reject that wait as disconnected, not as an explicit user cancellation.
    toolBridge?.close();ended=true;clearInterval(heartbeatTimer);clearIdle();
    // EOF is not a user cancellation. Finish the in-flight result before close.
    try{await Promise.allSettled([...(pending?[pending]:[]),...controls,writing]);}
    finally{
      // Only now, after every in-flight reply has queued its last registry
      // write (and `ended` stops any later one), remove this session's entry.
      registry=registry.then(()=>import('../notify.mjs')).then(m=>{if(registered)m.removeHostRegistry(sessionKey);}).catch(()=>{});
      await registry;
      // destroy() emits error/close on a later tick; retain its error listener
      // until that lifecycle finishes rather than leaking an uncaught error.
      if(output.destroyed&&!output.closed)await new Promise(resolve=>output.once('close',resolve));
      if(input.destroyed&&!input.closed)await new Promise(resolve=>input.once('close',resolve));
      output.off('error',outputError);
      input.off('error',inputError);
    }
  }
  if(failure)throw failure;
}
