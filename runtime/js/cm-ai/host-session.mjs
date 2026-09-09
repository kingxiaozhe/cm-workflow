// JSONL transport only. The existing host/runner owns decisions and durable state.

const LIMIT=64*1024;
const operationNames=new Set(['recover_final_review','advance','start','plan_design','promote_design','select_design_reviews','status','fix_status','fix_advance','fix_action','fix_run','decision','complete','qa','qa_result','prepare_revision','prepare_save',
  'context_refresh','finish','completion_evidence','run_finalize','review_findings','review_disposition','save_draft','save_design','correct_findings','prepare_summary','publish_summary','inspect_correction','resume_correction','cancel','resume','cause_review_package','cause_review','red_test','baseline','author_tests','repair','regression','retrospective','learning_writeback','handoff','final_review_package','final_review','publish_review','check_n5','post_review_regression','publish_dossier','walkthrough']);

export async function serveCmAiHost({host,input,output,toolBridge=null,inputLimit=LIMIT}){
  if(!Number.isSafeInteger(inputLimit)||inputLimit<LIMIT||inputLimit>4*1024*1024)throw Error('input_limit_invalid');
  let pending=null,buffer=Buffer.alloc(0),failure=null,closeRequested=false;
  let writing=Promise.resolve();
  const controls=new Set();let queuedWrites=0;
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
  toolBridge?.attach(reply);
  async function dispatch(bytes){
    if(failure)throw failure;
    let request;
    try{
      request=JSON.parse(bytes.toString('utf8'));
      if(toolBridge!==null&&['host_result','host_close'].includes(request?.type)){
        const accepted=toolBridge.accept(request);closeRequested=accepted.closing===true;
        reply({type:'host_response',...accepted}).catch(error=>{failure=error;});return;
      }
      if(!request||typeof request!=='object'||Array.isArray(request)
        ||typeof request.requestId!=='string'||request.requestId.length>128
        ||!operationNames.has(request.operation))throw Error('invalid');
    }catch{reply({requestId:null,error:{code:'invalid_request'}}).catch(error=>{failure=error;});return;}
    const requestId=request.requestId;
    const invoke=async()=>{
      try{await reply({requestId,result:await host.handle(request)});}
      catch{await reply({requestId,error:{code:'host_request_failed'}});}
    };
    // Never queue cancel/status behind a long developer or reviewer call.
    if(request.operation==='status'||request.operation==='cancel'){
      // The input reader must not wait for a slow response consumer before it
      // can deliver the next control request (especially cancellation).
      const control=invoke().finally(()=>{controls.delete(control);});
      controls.add(control);control.catch(error=>{failure=error;});return;
    }
    if(pending){reply({requestId,error:{code:'host_busy'}}).catch(error=>{failure=error;});return;}
    pending=invoke().finally(()=>{pending=null;});
    pending.catch(error=>{failure=error;});
  }
  try{
    reading: for await(const chunk of input){
      if(failure)throw failure;
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      let start=0;
      for(let end=0;end<bytes.length;end++){
        if(bytes[end]!==10)continue;
        if(buffer.length+end-start>inputLimit)throw Error('request_too_large');
        const line=Buffer.concat([buffer,bytes.subarray(start,end)]);
        buffer=Buffer.alloc(0);start=end+1;
        if(line.length)await dispatch(line);
        if(closeRequested)break reading;
      }
      if(buffer.length+bytes.length-start>inputLimit)throw Error('request_too_large');
      buffer=Buffer.concat([buffer,bytes.subarray(start)]);
    }
    if(buffer.length&&!closeRequested)await dispatch(buffer);
  }finally{
    // With a duplex conversation, EOF means no more tool replies can arrive.
    // Reject that wait as disconnected, not as an explicit user cancellation.
    toolBridge?.close();
    // EOF is not a user cancellation. Finish the in-flight result before close.
    try{await Promise.allSettled([...(pending?[pending]:[]),...controls,writing]);}
    finally{
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
