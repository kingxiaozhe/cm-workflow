// Conservative print/stream-json decoder. No dispatch, grant or completion authority.
// Process ownership must append process_closed and reject unsuccessful exits.
export function reportClaudeRateLimitNotice(raw, onNotice) {
  if (typeof onNotice !== 'function') return;
  const info = Object.fromEntries(Object.entries(
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {},
  ).filter(([, value]) => value === null || typeof value === 'string'
    || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
  // Diagnostics must not change the provider result or leak nested provider payloads.
  try { onNotice({kind:'rate_limit', info}); } catch {}
}

export function reportClaudeDevIntentNotice(onNotice) {
  if (typeof onNotice !== 'function') return;
  try { onNotice({kind:'claude_system_notice', subtype:'dev_intent'}); } catch {}
}

// Error classes observed from Claude CLI 2.1.274; anything else is reviewer_api_error.
const API_ERROR_CLASSES = Object.freeze({authentication_failed:'reviewer_auth_failed',
  billing_error:'reviewer_billing_error', rate_limit:'reviewer_rate_limited',
  server_error:'reviewer_server_error', model_not_found:'reviewer_model_not_found'});

export function createClaudeReviewStream(onEvent, onNotice = null) {
  let session = null, stage = 'init', value, noticeCount = 0, thinkingCount = 0, rejectedAttempts = 0;
  const pendingTools = new Map(), toolIds = new Set();
  const reject = (code, detail = null) => {
    stage = 'failed'; throw Object.assign(new Error(code), {code, ...(detail ? {detail} : {})});
  };
  // Body-free summary of the message that broke the review boundary: which
  // check (k), message type (m), block type (b), tool name (t), is_error (e).
  // Never the text, input or result content.
  const summary = (k, m, block = null, tool = null, isError = null) => ({k, m,
    b: typeof block?.type === 'string' && /^[A-Za-z_]{1,32}$/.test(block.type) ? block.type : null,
    t: typeof tool === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(tool) ? tool : null,
    e: typeof isError === 'boolean' ? isError : null});
  return Object.freeze({
    accept(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) reject('invalid_event');
      if (stage === 'done' || stage === 'failed') reject('unexpected_event');
      if (typeof message.session_id !== 'string' || !message.session_id.trim()
        || message.session_id.length > 256) reject('invalid_session');
      if (session !== null && session !== message.session_id) reject('session_mismatch');
      if (stage === 'init') {
        if (message.type === 'system' && message.subtype === 'dev_intent') {
          if (noticeCount >= 32) reject('unexpected_event');
          noticeCount++;
          session = message.session_id;
          reportClaudeDevIntentNotice(onNotice);
          return;
        }
        if (message.type !== 'system' || message.subtype !== 'init') reject('missing_init');
        session = message.session_id;
        stage = 'assistant';
        onEvent({event:'thread.started', provider_thread:session});
        onEvent({event:'turn.started', item_type:null});
        return;
      }
      if (message.type === 'rate_limit_event') {
        if (noticeCount >= 32) reject('unexpected_event');
        noticeCount++;
        reportClaudeRateLimitNotice(message.rate_limit_info, onNotice);
        return;
      }
      if (message.type === 'system') {
        if (message.subtype === 'dev_intent') {
          if (noticeCount >= 32) reject('unexpected_event');
          noticeCount++;
          reportClaudeDevIntentNotice(onNotice);
          return;
        }
        if (message.subtype === 'thinking_tokens') {
          // Long reviews emit usage heartbeats; worker-claude also caps total output at 1 MB.
          if (thinkingCount >= 4096) reject('unexpected_event');
          thinkingCount++;
          return;
        }
        if (!['api_retry','hook_started','hook_response','commands_changed'].includes(message.subtype)
          || noticeCount >= 32) reject('unexpected_event');
        noticeCount++;
        // CLI notifications carry no verdict; never forward hook output or command bodies.
        const notice = {kind:'claude_system_notice', subtype:message.subtype};
        for (const key of ['attempt','max_retries','error_status']) {
          if (typeof message[key] === 'number' && Number.isFinite(message[key])) notice[key] = message[key];
        }
        if (typeof message.hook_name === 'string') notice.hook_name = message.hook_name;
        try { if (typeof onNotice === 'function') onNotice(notice); } catch {}
        return;
      }
      if (message.type === 'assistant') {
        // CLI 2.1.x reports an API failure as a synthetic assistant message with
        // a string error class, then an is_error result. Before any tool call it
        // carries no verdict: stop with the class so the user knows what to fix.
        if (typeof message.error === 'string' && message.parent_tool_use_id === null
          && message.message?.role === 'assistant' && toolIds.size === 0) {
          reject(Object.hasOwn(API_ERROR_CLASSES, message.error) ? API_ERROR_CLASSES[message.error] : 'reviewer_api_error');
        }
        if (message.parent_tool_use_id !== null || message.error != null
          || message.message?.role !== 'assistant') reject('unexpected_assistant');
        const content = message.message.content;
        if (!Array.isArray(content) || content.length === 0) {
          reject('unexpected_tool_or_content', summary('empty_content', 'assistant'));
        }
        let substantive = false;
        for (const block of content) {
          if (['thinking','redacted_thinking'].includes(block?.type)) continue;
          substantive = true;
          if (block?.type === 'text' && typeof block.text === 'string') continue;
          if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id.trim()
            || typeof block.name !== 'string' || !block.name.trim()) {
            reject('unexpected_tool_or_content', summary('block_type', 'assistant', block, block?.name));
          }
          if (toolIds.has(block.id)) reject('unexpected_tool_or_content', summary('duplicate_tool_id', 'assistant', block, block.name));
          if (block.name !== 'StructuredOutput' && ++rejectedAttempts > 16) {
            reject('unexpected_tool_or_content', summary('tool_attempt_limit', 'assistant', block, block.name));
          }
          toolIds.add(block.id);
          pendingTools.set(block.id, block.name);
        }
        // Result is authoritative for structured output; assistant prose is never a verdict.
        if (substantive) stage = 'result';
        return;
      }
      if (message.type === 'user') {
        const content = message.message?.content;
        // CLI 2.1.x injects its own user-role reminders (isSynthetic: true, one
        // short text block; e.g. that StructuredOutput must be called, or that
        // the previous response had no visible output). The model cannot author
        // user messages. Such a reminder carries no verdict and runs nothing:
        // count it as a notice and ignore its body. Anything else from the user
        // role must be a tool_result; with a tool still pending nothing may be
        // injected between call and result.
        if (message.isSynthetic === true) {
          if (message.parent_tool_use_id !== null || message.message?.role !== 'user'
            || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
            || typeof content[0].text !== 'string' || Buffer.byteLength(content[0].text, 'utf8') > 1024
            || pendingTools.size !== 0) {
            reject('unexpected_tool_or_content', summary('user_content', 'user', content?.[0]));
          }
          if (noticeCount >= 32) reject('unexpected_event');
          noticeCount++;
          try { if (typeof onNotice === 'function') onNotice({kind:'claude_system_notice', subtype:'synthetic_user'}); } catch {}
          return;
        }
        if (message.message?.role !== 'user' || !Array.isArray(content) || content.length === 0) {
          reject('unexpected_tool_or_content', summary('user_content', 'user'));
        }
        for (const block of content) {
          if (block?.type !== 'tool_result') reject('unexpected_tool_or_content', summary('user_content', 'user', block));
          if (!pendingTools.has(block.tool_use_id)) reject('unexpected_tool_or_content', summary('unknown_tool_result', 'user', block));
          const name = pendingTools.get(block.tool_use_id);
          if (name !== 'StructuredOutput' && block.is_error !== true) {
            // A successful non-StructuredOutput tool is a real boundary break.
            reject('unexpected_tool_or_content', summary('tool_result_not_error', 'user', block, name, block.is_error));
          }
          pendingTools.delete(block.tool_use_id);
        }
        return;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error !== false) reject('provider_failed');
        if (stage !== 'result' || pendingTools.size !== 0 || !Number.isInteger(message.num_turns)
          || message.num_turns < 1 || message.num_turns > 20) reject('unexpected_result');
        // The verdict is only ever the CLI's structured_output object. Prose in
        // `result` is never parsed as one: a reviewer that answered in text after
        // a reminder has not answered.
        value = message.structured_output;
        if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_output_json');
        stage = 'done';
        onEvent({event:'item.completed', item_type:'agent_message'});
        onEvent({event:'turn.completed', item_type:null});
        return;
      }
      reject('unexpected_event');
    },
    finish() {
      if (stage !== 'done') reject('incomplete_result');
      return {status:'succeeded', value};
    },
  });
}
