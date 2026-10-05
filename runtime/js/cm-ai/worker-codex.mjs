import {createProviderUsageCapture} from './provider-usage.mjs';
import { spawn } from 'node:child_process';
import { commonArgs, cleanEnvironment, configFingerprint } from './codex-config.mjs';
import {ownedProcessCleanup} from './owned-process-cleanup.mjs';

// A preflight receipt is diagnostic evidence, not a human approval token.
export function preflightMatches(receipt, options) {
  const promptTransport=options.promptTransport??'argument';
  const transportMatches=promptTransport==='argument'
    ? receipt?.prompt_transport===undefined||receipt?.prompt_transport==='argument'
    : receipt?.prompt_transport===promptTransport;
  return receipt?.passed === true && receipt.cli_model === options.model
    && receipt.config_fingerprint === configFingerprint(options) && transportMatches;
}

// Check consumed fields before dereferencing or publishing provider events.
// Valid JSON such as null/[] is not a valid event; unrelated metadata is allowed.
function validEventShape(message) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
  if (!record(message) || !nonemptyString(message.type)) return false;
  if (message.type === 'thread.started' && !nonemptyString(message.thread_id)) return false;
  if (message.type.startsWith('item.') || Object.hasOwn(message, 'item')) {
    if (!record(message.item) || !nonemptyString(message.item.type)) return false;
    if (message.type === 'item.completed' && message.item.type === 'agent_message'
      && typeof message.item.text !== 'string') return false;
  }
  return true;
}

export function codexWorker({ cwd, model, schemaPath, preflight, effort='high',
  disabledSkills = [], cli = 'codex', timeoutMs = 60000,
  promptTransport = 'argument', spawnProcess = spawn, onNotice = null,onUsage=null,onUsageClaim=null }) {
  if (!['argument','stdin'].includes(promptTransport)) throw new Error('invalid prompt transport');
  let used = false;
  return async (request, { signal, onEvent, onTerminal }) => {
    if (used) return { status: 'blocked', code: 'worker_dispatch_limit' };
    if (!preflightMatches(preflight, { cwd, model, disabledSkills, promptTransport, effort })) return { status: 'blocked', code: 'tool_preflight_missing' };
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled_before_dispatch' };
    used = true;
    const usage=createProviderUsageCapture('codex',onUsage);
    try{onUsageClaim?.();}catch{}
    return new Promise(resolve => {
      const child = spawnProcess(cli, [...commonArgs({ cwd, model, disabledSkills, effort }), '--output-schema', schemaPath,
        promptTransport==='stdin'?'-':request.prompt], {
        cwd, env: cleanEnvironment(), stdio: [promptTransport==='stdin'?'pipe':'ignore', 'pipe', 'pipe'],shell:false,detached:process.platform!=='win32',
      });
      const cleanupGroup=ownedProcessCleanup(child);
      let buffer = '', outputBytes = 0, value, completion = false, failure, settled = false;
      let failureTerminal = false, noticeCount = 0, receiptInvalid=false;
      let providerThread, turnStarted = false, usageContextInvalid=false, timedOut = false, closeTimer, closing=false, terminationRequested=false;
      const cleanup=()=>process.platform==='win32'&&!terminationRequested?Promise.resolve():
        cleanupGroup().catch(()=>{failure='process_cleanup_unknown';});
      const stop = code => {
        if(!['cancelled','timeout','provider_failed'].includes(code))receiptInvalid=true;
        terminationRequested=true;
        failure ??= code;
        cleanup();
        if(!closing)closeTimer??=setTimeout(()=>{
          if(settled)return;settled=true;clean();child.stdin?.destroy();child.stdout.destroy();child.stderr.destroy();child.unref?.();
          usage.complete();resolve({status:'failed',code:'process_cleanup_unknown'});
        },1500);
      };
      const onAbort = () => stop('cancelled');
      const timer = setTimeout(() => { timedOut = true; stop('timeout'); }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      // Close the race between the initial signal check and handler registration.
      if (signal.aborted) onAbort();
      child.stderr.resume(); // Never publish provider headers, auth, or raw diagnostics.
      child.stdout.setEncoding('utf8');
      function accept(line) {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch { stop('invalid_event'); return; }
        if (!validEventShape(message)) { stop('invalid_event'); return; }
        // Notices stay outside the observer protocol and result contract.
        if (message.type === 'item.completed' && message.item.type === 'error') {
          if (typeof message.item.message !== 'string' || !providerThread
            || completion || failureTerminal || failure || noticeCount >= 8) { stop('invalid_event'); return; }
          noticeCount++;
          try { if (typeof onNotice === 'function') onNotice(message.item.message.slice(0, 200)); } catch {}
          return;
        }
        // Normalize known non-result progress at the provider boundary. The
        // shared observer still requires one final message and one terminal.
        const progress = ['item.started', 'item.updated', 'item.completed'].includes(message.type)
          && (message.item.type === 'reasoning'
            || message.item.type === 'agent_message' && message.type !== 'item.completed');
        if (progress) {
          if (!providerThread || !turnStarted || completion || failureTerminal || failure || value !== undefined)
            stop('invalid_event');
          return;
        }
        if (message.type === 'turn.started') {if(!providerThread)usageContextInvalid=true;turnStarted = true;}
        const isFailureTerminal = message.type === 'turn.failed' || message.type === 'error';
        // The generic error notice can precede the official turn.failed event.
        // Preserve one normalized failure, while accounting only native terminals.
        if(message.type==='turn.failed'&&providerThread&&turnStarted&&!completion&&!usageContextInvalid)usage.terminal(message.usage);
        if (failureTerminal && isFailureTerminal) { stop('provider_failed'); return; }
        if (isFailureTerminal) failureTerminal = true;
        if (message.type === 'thread.started') {
          if (providerThread && providerThread !== message.thread_id) {usageContextInvalid=true;stop('thread_mismatch'); return; }
          providerThread = message.thread_id;
          onEvent({ event: message.type, provider_thread: providerThread });
        } else onEvent({ event: message.type ?? 'unknown', item_type: message.item?.type ?? null });
        if (message.item?.type === 'error') {
          stop('cli_diagnostic'); return;
        }
        if (message.item && !['agent_message', 'reasoning'].includes(message.item.type)) {
          stop('unexpected_tool_or_item'); return;
        }
        if (message.type === 'item.completed' && message.item?.type === 'agent_message') {
          try { value = JSON.parse(message.item.text); } catch { stop('invalid_output_json'); }
        }
        if (message.type === 'turn.completed') {completion = true;if(providerThread&&turnStarted&&!failureTerminal&&!usageContextInvalid)usage.terminal(message.usage);}
        if (isFailureTerminal) stop('provider_failed');
      }
      child.stdout.on('data', chunk => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk, 'utf8');
        if (outputBytes > 1_000_000) { stop('output_limit'); return; }
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          accept(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        }
      });
      const clean = () => {
        clearTimeout(timer); clearTimeout(closeTimer); signal.removeEventListener('abort', onAbort);
      };
      child.once('error', async () => {
        if(settled)return;settled=true;closing=true;clean();await cleanup();
        usage.complete();resolve({status:'failed',code:failure==='process_cleanup_unknown'?failure:'spawn_failed'});
      });
      child.once('close', async (code, exitSignal) => {
        if (settled) return;
        closing=true;clean();
        if (buffer.trim()) accept(buffer);
        settled = true;
        await cleanup();
        usage.complete();
        onEvent({ event: 'process_closed', exit_code: code, signal: exitSignal,
          timed_out: timedOut });
        // A local abort must not erase an already received provider terminal.
        // Windows/direct-child exit and uncertain cleanup cannot issue this receipt.
        if(process.platform!=='win32'&&failure!=='process_cleanup_unknown'&&!receiptInvalid&&typeof onTerminal==='function'){
          if(completion&&providerThread&&value!==undefined)onTerminal({status:'succeeded',value});
          else if(failureTerminal&&providerThread)onTerminal({status:'failed',code:'provider_failed'});
        }
        if(failure==='process_cleanup_unknown')resolve({status:'failed',code:failure});
        else if (signal.aborted) resolve({ status: 'cancelled', code: 'cancelled' });
        else if (failure || code !== 0 || !completion || !providerThread || value === undefined) {
          resolve({ status: 'failed', code: failure ?? 'incomplete_result' });
        } else resolve({ status: 'succeeded', value });
      });
      if(promptTransport==='stdin'){
        if(!child.stdin||typeof child.stdin.end!=='function')stop('prompt_write_failed');
        else {
          child.stdin.on('error',()=>{if(!settled)stop('prompt_write_failed');});
          try{child.stdin.end(request.prompt);}catch{stop('prompt_write_failed');}
        }
      }
    });
  };
}
