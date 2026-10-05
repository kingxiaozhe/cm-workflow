import {createProviderUsageCapture} from './provider-usage.mjs';
import {externalEffort} from './external-models.mjs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createClaudeReviewStream} from './claude-review-stream.mjs';
import {ownedProcessCleanup} from './owned-process-cleanup.mjs';

export function claudeBaseArgs(model,effort=null) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid_model');
  effort=externalEffort('claude',effort);
  return [...(effort===null?[]:['--effort',effort]),'--print','--input-format','text','--output-format','stream-json','--verbose',
    '--model',model,'--safe-mode','--setting-sources','','--tools','',
    '--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--permission-mode','dontAsk','--no-chrome','--no-session-persistence',
    '--prompt-suggestions','false'];
}
export function claudeReviewArgs(model,effort=null) {
  const args=claudeBaseArgs(model,effort);
  const schema=JSON.parse(readFileSync(new URL('./review-result.schema.json',import.meta.url),'utf8'));
  // Claude's schema engine does not accept the draft-2020-12 metadata.
  delete schema.$schema;delete schema.$id;
  return [...args,'--json-schema',JSON.stringify(schema)];
}
export function claudeReviewFingerprint({cwd,model,cli='claude',effort=null}) {
  return createHash('sha256').update(JSON.stringify({cwd,cli,args:claudeReviewArgs(model,effort),
    environmentPolicy:1,promptTransport:'stdin'})).digest('hex');
}
export function claudeEnvironment() {
  const allowed=['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','ANTHROPIC_API_KEY'];
  return {...Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.includes(key))),
    CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_RETRY_WATCHDOG:'0'};
}
export function claudePreflightMatches(receipt,options) {
  return receipt?.passed===true && receipt.provider==='claude'
    && receipt.config_fingerprint===claudeReviewFingerprint(options) && receipt.prompt_transport==='stdin';
}

// Diagnostic receipt is NOT authorization. Only the original V3 owner may dispatch this worker.
// A matching diagnostic receipt remains required separately from the V3 grant.
export function claudeWorker({cwd,model,preflight,cli='claude',timeoutMs=60000,spawnProcess=spawn,effort=null,
  killProcess=(pid,signal)=>process.kill(pid,signal),onNotice=null,onUsage=null,onUsageClaim=null}) {
  const args=claudeReviewArgs(model,effort);
  if (!Number.isSafeInteger(timeoutMs)||timeoutMs<1) throw new Error('invalid_timeout');
  let used=false;
  return async (request,{signal,onEvent,onTerminal})=>{
    if (process.platform==='win32') return {status:'blocked',code:'unsupported_process_cleanup'};
    if (used) return {status:'blocked',code:'worker_dispatch_limit'};
    if (!claudePreflightMatches(preflight,{cwd,model,cli,effort})) {
      return {status:'blocked',code:'tool_preflight_missing'};
    }
    if (signal.aborted) return {status:'cancelled',code:'cancelled_before_dispatch'};
    if (typeof request?.prompt!=='string') return {status:'failed',code:'invalid_prompt'};
    used=true;
    const usage=createProviderUsageCapture('claude',onUsage);
    try{onUsageClaim?.();}catch{}
    return new Promise(resolve=>{
      let child;
      try { child=spawnProcess(cli,args,{cwd,env:claudeEnvironment(),stdio:['pipe','pipe','pipe'],detached:true}); }
      catch { usage.complete();resolve({status:'failed',code:'spawn_failed'});return; }
      let buffer='', bytes=0, failure=null, settled=false, timedOut=false, killTimer, pendingClose;
      let providerThread=null,providerTerminal=false,failedTerminal=false,receiptInvalid=false;
      const cleanupGroup=ownedProcessCleanup(child,{killProcess});
      const providerFailure=()=>['provider_failed','reviewer_auth_failed','reviewer_billing_error',
        'reviewer_rate_limited','reviewer_server_error','reviewer_model_not_found','reviewer_api_error'].includes(failure);
      const mayRead=()=>failure===null||['cancelled','timeout'].includes(failure)
        ||typeof onTerminal==='function'&&providerFailure();
      const stream=createClaudeReviewStream(event=>{
        if(event.event==='thread.started')providerThread=event.provider_thread;
        if(event.event==='turn.completed')providerTerminal=true;
        onEvent(event);
      },onNotice);
      const stop=code=>{
        if(!['cancelled','timeout','provider_failed','reviewer_auth_failed','reviewer_billing_error',
          'reviewer_rate_limited','reviewer_server_error','reviewer_model_not_found','reviewer_api_error'].includes(code))receiptInvalid=true;
        if(failure===null||['cancelled','timeout'].includes(failure))failure=code;
        if (code==='unexpected_tool_or_content') {
          // A successful non-StructuredOutput tool breaks the review boundary: kill now.
          try {killProcess(-child.pid,'SIGKILL');} catch {}
          return;
        }
        try { killProcess(-child.pid,'SIGTERM'); } catch { /* close remains the authority */ }
        killTimer??=setTimeout(()=>{
          try {killProcess(-child.pid,'SIGKILL');} catch {}
          killTimer=null;pendingClose?.();
        },1000);
      };
      const abort=()=>stop('cancelled');
      const timer=setTimeout(()=>{timedOut=true;stop('timeout');},timeoutMs);
      const clean=()=>{clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',abort);};
      const accept=line=>{
        if (!mayRead() || !line.trim()) return;
        try {
          const message=JSON.parse(line);
          if(failedTerminal){stop('unexpected_event');return;}
          // A synthetic assistant error is not a provider terminal. Only the
          // original session's actual CLI result can attest a failed turn.
          if((typeof onTerminal==='function'||typeof onUsage==='function')&&!providerTerminal&&!failedTerminal&&providerThread!==null
            &&message?.type==='result'&&message.session_id===providerThread&&message.is_error===true
            &&['success','error_during_execution','error_max_turns','error_max_budget_usd','error_max_structured_output_retries'].includes(message.subtype)
            &&Number.isInteger(message.num_turns)&&message.num_turns>=0&&message.num_turns<=20){
            failedTerminal=true;usage.terminal(message.usage);
            // This branch is enabled only for receipt collection. The actual
            // session result attests failure both before and after transport abort.
            onEvent({event:'turn.failed',item_type:null});
            stop('provider_failed');return;
          }
          if(providerFailure()){receiptInvalid=true;return;} // only the original session's terminal may follow an API failure
          if(message.type==='result'&&message.session_id===providerThread&&message.subtype==='success'&&message.is_error===false
            &&Number.isInteger(message.num_turns)&&message.num_turns>=1&&message.num_turns<=20)usage.terminal(message.usage);
          stream.accept(message);
        }
        catch (error) {stop(error instanceof SyntaxError?'invalid_event':error.code??'invalid_event');}
      };
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
      child.stderr.resume(); // Do not persist provider diagnostics or authentication material.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if (settled || !mayRead()) return;
        bytes+=Buffer.byteLength(chunk,'utf8');
        if (bytes>1_000_000) {stop('output_limit');return;}
        buffer+=chunk;
        let index;
        while ((index=buffer.indexOf('\n'))!==-1) {
          accept(buffer.slice(0,index));buffer=buffer.slice(index+1);
        }
      });
      child.once('error',()=>{if(!settled){settled=true;clean();usage.complete();resolve({status:'failed',code:'spawn_failed'});}});
      child.once('close',(code,exitSignal)=>{
        if (settled) return;
        if (buffer.trim()) accept(buffer);
        pendingClose=async()=>{
        settled=true;clean();
        if(typeof onTerminal==='function')try{await cleanupGroup();}catch{failure='process_cleanup_unknown';}
        usage.complete();
        onEvent({event:'process_closed',exit_code:code,signal:exitSignal,timed_out:timedOut});
        if(failure==='process_cleanup_unknown'){resolve({status:'failed',code:failure});return;}
        if(!receiptInvalid&&typeof onTerminal==='function'&&(failure===null||['cancelled','timeout'].includes(failure))){
          try{onTerminal(stream.finish());}catch{}
        }
        else if(!receiptInvalid&&typeof onTerminal==='function'&&failedTerminal&&providerFailure())onTerminal({status:'failed',code:'provider_failed'});
        if (signal.aborted) {resolve({status:'cancelled',code:'cancelled'});return;}
        if (failure || code!==0 || exitSignal!==null) {
          resolve({status:'failed',code:failure??'incomplete_result'});return;
        }
        try {resolve(stream.finish());}
        catch(error){resolve({status:'failed',code:error.code??'incomplete_result'});}
        };
        // Leader close does not prove group cleanup: redirected descendant pipes may close early.
        if (!killTimer) pendingClose();
      });
      if (!child.stdin?.end) stop('prompt_write_failed');
      else {
        child.stdin.on('error',()=>{if(!settled)stop('prompt_write_failed');});
        if (!signal.aborted) try {child.stdin.end(request.prompt);} catch {stop('prompt_write_failed');}
        else child.stdin.end();
      }
    });
  };
}
