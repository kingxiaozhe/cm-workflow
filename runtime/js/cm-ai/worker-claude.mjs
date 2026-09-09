import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createClaudeReviewStream} from './claude-review-stream.mjs';

export function claudeReviewArgs(model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid_model');
  return ['--print','--input-format','text','--output-format','stream-json','--verbose',
    '--model',model,'--safe-mode','--setting-sources','','--tools','',
    '--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--permission-mode','dontAsk','--no-chrome','--no-session-persistence',
    '--prompt-suggestions','false'];
}
export function claudeReviewFingerprint({cwd,model,cli='claude'}) {
  return createHash('sha256').update(JSON.stringify({cwd,cli,args:claudeReviewArgs(model),
    environmentPolicy:1,promptTransport:'stdin'})).digest('hex');
}
function environment() {
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
export function claudeWorker({cwd,model,preflight,cli='claude',timeoutMs=60000,spawnProcess=spawn,
  killProcess=(pid,signal)=>process.kill(pid,signal)}) {
  const args=claudeReviewArgs(model);
  if (!Number.isSafeInteger(timeoutMs)||timeoutMs<1) throw new Error('invalid_timeout');
  let used=false;
  return async (request,{signal,onEvent})=>{
    if (process.platform==='win32') return {status:'blocked',code:'unsupported_process_cleanup'};
    if (used) return {status:'blocked',code:'worker_dispatch_limit'};
    if (!claudePreflightMatches(preflight,{cwd,model,cli})) {
      return {status:'blocked',code:'tool_preflight_missing'};
    }
    if (signal.aborted) return {status:'cancelled',code:'cancelled_before_dispatch'};
    if (typeof request?.prompt!=='string') return {status:'failed',code:'invalid_prompt'};
    used=true;
    return new Promise(resolve=>{
      let child;
      try { child=spawnProcess(cli,args,{cwd,env:environment(),stdio:['pipe','pipe','pipe'],detached:true}); }
      catch { resolve({status:'failed',code:'spawn_failed'});return; }
      let buffer='', bytes=0, failure=null, settled=false, timedOut=false, killTimer, pendingClose;
      const stream=createClaudeReviewStream(onEvent);
      const stop=code=>{
        failure??=code;
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
        if (failure || !line.trim()) return;
        try { stream.accept(JSON.parse(line)); }
        catch (error) {stop(error instanceof SyntaxError?'invalid_event':error.code??'invalid_event');}
      };
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
      child.stderr.resume(); // Do not persist provider diagnostics or authentication material.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if (settled || failure) return;
        bytes+=Buffer.byteLength(chunk,'utf8');
        if (bytes>1_000_000) {stop('output_limit');return;}
        buffer+=chunk;
        let index;
        while ((index=buffer.indexOf('\n'))!==-1) {
          accept(buffer.slice(0,index));buffer=buffer.slice(index+1);
        }
      });
      child.once('error',()=>{if(!settled){settled=true;clean();resolve({status:'failed',code:'spawn_failed'});}});
      child.once('close',(code,exitSignal)=>{
        if (settled) return;
        if (buffer.trim()) accept(buffer);
        pendingClose=()=>{
        settled=true;clean();
        onEvent({event:'process_closed',exit_code:code,signal:exitSignal,timed_out:timedOut});
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
