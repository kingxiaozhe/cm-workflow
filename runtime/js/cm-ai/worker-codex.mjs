import {assertCodexInitialInput} from './codex-review-input.mjs';
import {readReviewMaterialManifest} from './review-material.mjs';
import {createProviderUsageCapture} from './provider-usage.mjs';
import { spawn } from 'node:child_process';
import { commonArgs, cleanEnvironment, configFingerprint } from './codex-config.mjs';
import {ownedProcessCleanup} from './owned-process-cleanup.mjs';
import {verificationTools} from '../cm-fix/review-verification-contract.mjs';

import {readReviewPackage} from './review-package.mjs';
import {nativeEvidenceImagePaths} from './native-review-evidence.mjs';
import {providerFailureDiagnostic,mergeProviderFailureDiagnostics} from './provider-failure-diagnostic.mjs';
import {CODEX_RECONNECT_NOTICE_LIMIT,isCodexReconnectNotice} from './codex-reconnect-notice.mjs';

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

// Match whole, fixed diagnostics only. Mixed text, credentials and truncated
// stderr remain unknown; no provider text becomes an output field.
function stderrDiagnostic(bytes,total){
  if(total>4096)return {category:'unknown',httpStatus:null};
  const value=bytes.toString('utf8').trim().toLowerCase();
  const categories={
    'error: failed to load image':'image_load_failed',
    'error: context_length_exceeded':'context_limit',
    'error: invalid json schema':'schema_invalid',
    'error: invalid argument':'invalid_argument',
    'error: authentication_required':'authentication',
    'error: unauthorized':'authentication',
    'error: rate_limit_exceeded':'rate_limit',
  };
  if(Object.hasOwn(categories,value))return {category:categories[value],httpStatus:null};
  const status=/^error: http (400|401|403|408|413|422|429|500|502|503|504)$/.exec(value);
  return status?{category:'http_status',httpStatus:Number(status[1])}:{category:'unknown',httpStatus:null};
}

export function codexWorker({ cwd, model, schemaPath, preflight, effort='high',
  disabledSkills = [], cli = 'codex', timeoutMs = 60000,
  promptTransport = 'argument', spawnProcess = spawn, onNotice = null,onDiagnostic=null,onUsage=null,onUsageClaim=null,
  verification=null,verificationTransport=null, material=null,materialTransport=null }) {
  if (!['argument','stdin'].includes(promptTransport)) throw new Error('invalid prompt transport');
  if(material)readReviewMaterialManifest(material);
  const toolMode=Boolean(verification||material);
  const toolNames=material?['mcp__cm_review__read_material']:verification?verificationTools(verification):[];
  const outputLimit=material?1_000_000+16*material.promptBytes+4096*material.pageCount:1_000_000;
  let used = false;
  return async (request, { signal, onEvent, onTerminal }) => {
    if (used) return { status: 'blocked', code: 'worker_dispatch_limit' };
    if (!preflightMatches(preflight, { cwd, model, disabledSkills, promptTransport, effort,verification,material })) return { status: 'blocked', code: 'tool_preflight_missing' };
    if(verification&&!verificationTransport)return {status:'blocked',code:'review_verification_transport_missing'};
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled_before_dispatch' };
    if(material&&!materialTransport)return {status:'blocked',code:'review_material_transport'};
    try{assertCodexInitialInput(request.prompt);}catch{return {status:'blocked',code:'review_input_too_large'};}
    // Revalidate exact package archive bytes immediately before process creation.
    const imageArgs=Object.hasOwn(request,'nativeReviewPackage')
      ?nativeEvidenceImagePaths(readReviewPackage(request.nativeReviewPackage)).flatMap(p=>['--image',p]):[];
    used = true;
    const usage=createProviderUsageCapture('codex',onUsage);
    try{onUsageClaim?.();}catch{}
    return new Promise(resolve => {
      const child = spawnProcess(cli, [...commonArgs({ cwd, model, disabledSkills, effort,verification,verificationTransport,material,materialTransport }), '--output-schema', schemaPath,...imageArgs,
        promptTransport==='stdin'?'-':request.prompt], {
        cwd:materialTransport?.cwd??verificationTransport?.cwd??cwd, env: cleanEnvironment(), stdio: [promptTransport==='stdin'?'pipe':'ignore', 'pipe', 'pipe'],shell:false,detached:process.platform!=='win32',
      });
      const cleanupGroup=ownedProcessCleanup(child);
      let buffer = '', outputBytes = 0, value, verificationMessage, completion = false, failure, settled = false;
      let stderrBytes=Buffer.alloc(0),stderrByteCount=0;
      let failureDiagnostic=null,failureDiagnosticCount=0;
      let failureTerminal = false, noticeCount = 0, reconnectNoticeCount = 0, receiptInvalid=false;
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
      child.stderr.on('data',chunk=>{
        if(settled)return;
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        stderrByteCount=Math.min(Number.MAX_SAFE_INTEGER,stderrByteCount+bytes.length);
        if(stderrBytes.length<4096)stderrBytes=Buffer.concat([stderrBytes,bytes.subarray(0,4096-stderrBytes.length)]);
      }); // Drain stderr; retain at most 4096 private bytes in memory only.
      child.stdout.setEncoding('utf8');
      function accept(line) {
        if (!line.trim()) return;
        let message;
        try { message = JSON.parse(line); } catch { stop('invalid_event'); return; }
        if (!validEventShape(message)) { stop('invalid_event'); return; }
        // Codex emits reconnect notices as errors but may subsequently recover.
        // Keep a separate bounded notice budget; overflow follows fatal handling.
        if (isCodexReconnectNotice(message) && reconnectNoticeCount < CODEX_RECONNECT_NOTICE_LIMIT) {
          reconnectNoticeCount++;
          try { if (typeof onNotice === 'function') onNotice(message.message.slice(0, 200)); } catch {}
          return;
        }
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
        if(toolMode&&['item.started','item.updated','item.completed'].includes(message.type)&&message.item.type==='mcp_tool_call'){
          if(!providerThread||!turnStarted||completion||failureTerminal||failure||value!==undefined
            ||message.item.server!=='cm_review'||!toolNames.includes('mcp__cm_review__'+message.item.tool))
            stop('unexpected_tool_or_item');
          return;
        }
        if(toolMode&&message.type==='item.completed'&&message.item.type==='agent_message'){
          if(!providerThread||!turnStarted||completion||failureTerminal||failure){stop('invalid_event');return;}
          verificationMessage=message.item.text;return;
        }
        if(toolMode&&message.type==='turn.completed'){
          try{value=JSON.parse(verificationMessage);}catch{stop('invalid_output_json');return;}
          onEvent({event:'item.completed',item_type:'agent_message'});
        }
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
        let eventDiagnostic=null;
        if(isFailureTerminal&&failureDiagnosticCount<2){
          eventDiagnostic=providerFailureDiagnostic(message,message.type==='error'?'stdout_error':'stdout_turn_failed');
          failureDiagnostic=mergeProviderFailureDiagnostics(failureDiagnostic,eventDiagnostic);failureDiagnosticCount++;
        }
        // The generic error notice can precede the official turn.failed event.
        // Preserve one normalized failure, while accounting only native terminals.
        if(message.type==='turn.failed'&&providerThread&&turnStarted&&!completion&&!usageContextInvalid)usage.terminal(message.usage);
        if (failureTerminal && isFailureTerminal) { stop('provider_failed'); return; }
        if (isFailureTerminal) failureTerminal = true;
        if (message.type === 'thread.started') {
          if (providerThread && providerThread !== message.thread_id) {usageContextInvalid=true;stop('thread_mismatch'); return; }
          providerThread = message.thread_id;
          onEvent({ event: message.type, provider_thread: providerThread });
        } else onEvent({ event: message.type ?? 'unknown', item_type: message.item?.type ?? null,
          ...(eventDiagnostic?{diagnostic:eventDiagnostic}:{}) });
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
        if (outputBytes > outputLimit) { stop('output_limit'); return; }
        buffer += chunk;
        if(material&&buffer.split('\n').some(line=>Buffer.byteLength(line)>256*1024)){stop('output_limit');return;}
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
        if(failureTerminal&&stderrByteCount>0&&stderrByteCount<=4096){
          failureDiagnostic=mergeProviderFailureDiagnostics(failureDiagnostic,providerFailureDiagnostic(stderrBytes.toString('utf8'),'stderr'));
        }
        onEvent({ event: 'process_closed', exit_code: code, signal: exitSignal,
          timed_out: timedOut,...(failureDiagnostic?{diagnostic:failureDiagnostic}:{}) });
        if((failureTerminal||code!==0&&(!completion||!providerThread||value===undefined))&&typeof onDiagnostic==='function'){
          try{onDiagnostic({kind:'codex_review_exit',...stderrDiagnostic(stderrBytes,stderrByteCount),
            exitCode:Number.isInteger(code)&&code>=0&&code<=255?code:null,
            signal:/^SIG(?:ABRT|ALRM|BUS|FPE|HUP|ILL|INT|KILL|PIPE|QUIT|SEGV|TERM|TRAP|USR1|USR2)$/.test(exitSignal??'')?exitSignal:null,
            timedOut,stderrByteCount,...(failureDiagnostic?{diagnostic:failureDiagnostic}:{})});}catch{}
        }
        stderrBytes=Buffer.alloc(0);
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
