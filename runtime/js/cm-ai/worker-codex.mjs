import { spawn } from 'node:child_process';
import { commonArgs, cleanEnvironment, configFingerprint } from './codex-config.mjs';

// CLI 0.153.4 emits this notice even with Code Mode explicitly disabled.
// commonArgs keeps its host disabled; the offline sink confirmed tools remain
// empty and the turn continues. Match only this exact, pre-turn notice once.
const disabledCodeModeNotice = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';

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

export function codexWorker({ cwd, model, schemaPath, preflight,
  disabledSkills = [], cli = 'codex', timeoutMs = 60000,
  promptTransport = 'argument', spawnProcess = spawn }) {
  if (!['argument','stdin'].includes(promptTransport)) throw new Error('invalid prompt transport');
  let used = false;
  return async (request, { signal, onEvent }) => {
    if (used) return { status: 'blocked', code: 'worker_dispatch_limit' };
    if (!preflightMatches(preflight, { cwd, model, disabledSkills, promptTransport })) return { status: 'blocked', code: 'tool_preflight_missing' };
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled_before_dispatch' };
    used = true;
    return new Promise(resolve => {
      const child = spawnProcess(cli, [...commonArgs({ cwd, model, disabledSkills }), '--output-schema', schemaPath,
        promptTransport==='stdin'?'-':request.prompt], {
        cwd, env: cleanEnvironment(), stdio: [promptTransport==='stdin'?'pipe':'ignore', 'pipe', 'pipe'],
      });
      let buffer = '', outputBytes = 0, value, completion = false, failure, settled = false;
      let failureTerminal = false, startupNoticeSeen = false;
      let providerThread, turnStarted = false, timedOut = false, killTimer;
      const stop = code => {
        failure ??= code;
        if (!child.killed) child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
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
        if (message.type === 'item.completed' && message.item.type === 'error'
          && message.item.message === disabledCodeModeNotice
          && providerThread && !turnStarted && !startupNoticeSeen
          && !completion && !failureTerminal && !failure && value === undefined) {
          startupNoticeSeen = true;
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
        if (message.type === 'turn.started') turnStarted = true;
        const isFailureTerminal = message.type === 'turn.failed' || message.type === 'error';
        if (failureTerminal && isFailureTerminal) { stop('provider_failed'); return; }
        if (isFailureTerminal) failureTerminal = true;
        if (message.type === 'thread.started') {
          if (providerThread && providerThread !== message.thread_id) { stop('thread_mismatch'); return; }
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
        if (message.type === 'turn.completed') completion = true;
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
        clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', onAbort);
      };
      child.once('error', () => { settled = true; clean(); resolve({ status: 'failed', code: 'spawn_failed' }); });
      child.once('close', (code, exitSignal) => {
        if (settled) return;
        clean();
        if (buffer.trim()) accept(buffer);
        clearTimeout(killTimer);
        settled = true;
        onEvent({ event: 'process_closed', exit_code: code, signal: exitSignal,
          timed_out: timedOut });
        if (signal.aborted) resolve({ status: 'cancelled', code: 'cancelled' });
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
