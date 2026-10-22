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

// Diagnostic enums also name rejected CLI 2.1.x messages. They never extend the
// accepted stream grammar. Unknown strings, bodies and identifiers stay private.
const DIAGNOSTIC_TYPES = new Set(['system','assistant','user','result','rate_limit_event',
  'auth_status','keep_alive','stream_event','tool_progress','tool_use_summary']);
const DIAGNOSTIC_SUBTYPES = new Set(['init','dev_intent','ui_invalidate','thinking_tokens',
  'api_retry','hook_started','hook_response','commands_changed','compact_boundary','status',
  'task_started','task_progress','task_notification','files_persisted','hook_progress',
  'local_command_output','success','error_during_execution','error_max_turns',
  'error_max_budget_usd','error_max_structured_output_retries']);
const DIAGNOSTIC_ERRORS = new Set([...Object.keys(API_ERROR_CLASSES),'invalid_request',
  'invalid_request_error','api_error','overloaded_error','context_window_exceeded',
  'context_length_exceeded','prompt_too_long','authentication_error','permission_error',
  'not_found_error','rate_limit_error','request_too_large','unknown']);
const diagnosticEnum = (value, allowed) => typeof value !== 'string' ? 'absent'
  : allowed.has(value) ? value : 'other';
const diagnosticLength = value => typeof value === 'string' ? Math.min(value.length,1_000_001) : 0;
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function apiFailureDetail(message) {
  const detail={apiErrorClass:diagnosticEnum(message.error,DIAGNOSTIC_ERRORS),
    apiErrorClassLength:diagnosticLength(message.error),providerErrorClass:'absent',
    httpStatus:httpStatus(message.api_error_status)??httpStatus(message.error_status)??httpStatus(message.status_code),
    errorFlags:[],tokenBudget:null};
  // Inspect only the bounded synthetic API error envelope, extracting fixed
  // classifications and numeric token limits. Never return its original text.
  const content=message.message?.content;
  if(!Array.isArray(content)||content.length!==1||content[0]?.type!=='text'||typeof content[0].text!=='string')return detail;
  const text=content[0].text;
  const prefix=/^API Error: ([1-5][0-9]{2})(?:\s|$)/.exec(text.slice(0,32));
  if(prefix&&detail.httpStatus===null)detail.httpStatus=Number(prefix[1]);
  if(text.length>8192)return detail;
  let errorText=text;
  if(prefix){
    try{
      const body=JSON.parse(text.slice(prefix[0].length));
      detail.providerErrorClass=diagnosticEnum(body?.error?.type,DIAGNOSTIC_ERRORS);
      errorText=typeof body?.error?.message==='string'?body.error.message:'';
    }catch{} // Non-JSON API errors still permit fixed, body-free flags below.
  }
  if(/\bprompt(?: is)? too long\b|\bprompt_too_long\b/i.test(errorText))detail.errorFlags.push('prompt_too_long');
  if(/\bcontext_length_exceeded\b|\bcontext_window_exceeded\b/i.test(errorText))detail.errorFlags.push('context_length_exceeded');
  const budget=/^prompt(?: is)? too long:\s*([0-9]{1,9}) tokens? > ([0-9]{1,9}) maximum\b/i.exec(errorText);
  if(budget)detail.tokenBudget={inputTokens:Number(budget[1]),maximumTokens:Number(budget[2])};
  return detail;
}

export function createClaudeReviewStream(onEvent, onNotice = null, allowedTools = []) {
  const permitted=new Set(allowedTools);
  let session = null, stage = 'init', value, noticeCount = 0, thinkingCount = 0, progressCount = 0, rejectedAttempts = 0, current = null;
  const pendingTools = new Map(), toolIds = new Set();
  const reject = (code, detail = null, check = code) => {
    const failureDetail={version:1,check,stage,
      eventType:diagnosticEnum(current?.type,DIAGNOSTIC_TYPES),eventTypeLength:diagnosticLength(current?.type),
      eventSubtype:diagnosticEnum(current?.subtype,DIAGNOSTIC_SUBTYPES),eventSubtypeLength:diagnosticLength(current?.subtype),
      noticeCount,thinkingCount,progressCount,...(check==='api_error'?apiFailureDetail(current):{})};
    stage = 'failed'; throw Object.assign(new Error(code), {code, failureDetail, ...(detail ? {detail} : {})});
  };
  // Body-free summary of the message that broke the review boundary: which
  // check (k), message type (m), block type (b), tool name (t), is_error (e).
  // Never the text, input or result content.
  const summary = (k, m, block = null, tool = null, isError = null) => ({k, m,
    b: typeof block?.type === 'string' && /^[A-Za-z_]{1,32}$/.test(block.type) ? block.type : null,
    t: typeof tool === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(tool) ? tool : null,
    e: typeof isError === 'boolean' ? isError : null});
  const startupNotice = subtype => {
    if (noticeCount >= 32) reject('unexpected_event',null,'notice_limit');
    noticeCount++;
    if (subtype === 'dev_intent') reportClaudeDevIntentNotice(onNotice);
    else try { if (typeof onNotice === 'function') onNotice({kind:'claude_system_notice', subtype:'ui_invalidate'}); } catch {}
  };
  return Object.freeze({
    accept(message) {
      current=message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) reject('invalid_event');
      if (stage === 'done' || stage === 'failed') reject('unexpected_event',null,'terminal_stage');
      if (typeof message.session_id !== 'string' || !message.session_id.trim()
        || message.session_id.length > 256) reject('invalid_session');
      if (session !== null && session !== message.session_id) reject('session_mismatch');
      if (stage === 'init') {
        // CLI 2.1.289 emits UI invalidation before init. It has no review
        // result and never initializes a turn; retain only its fixed subtype.
        if (message.type === 'system' && ['dev_intent','ui_invalidate'].includes(message.subtype)) {
          session = message.session_id;
          startupNotice(message.subtype);
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
        if (noticeCount >= 32) reject('unexpected_event',null,'notice_limit');
        noticeCount++;
        reportClaudeRateLimitNotice(message.rate_limit_info, onNotice);
        return;
      }
      if (message.type === 'system') {
        if (['dev_intent','ui_invalidate'].includes(message.subtype)) {
          startupNotice(message.subtype);
          return;
        }
        if (message.subtype === 'thinking_tokens') {
          // Long reviews emit usage heartbeats; worker-claude also caps total output at 1 MB.
          if (thinkingCount >= 4096) reject('unexpected_event',null,'thinking_limit');
          thinkingCount++;
          return;
        }
        if (!['api_retry','hook_started','hook_response','commands_changed'].includes(message.subtype))
          reject('unexpected_event',null,'unknown_system_subtype');
        if (noticeCount >= 32) reject('unexpected_event',null,'notice_limit');
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
      if (message.type === 'tool_progress') {
        // A heartbeat belongs only to an already registered, permitted tool in
        // this top-level review turn. Its result must still arrive separately.
        if(stage!=='result')reject('unexpected_event',null,'tool_progress_stage');
        if(message.parent_tool_use_id!==null)reject('unexpected_event',null,'tool_progress_parent');
        if(typeof message.tool_use_id!=='string'||!pendingTools.has(message.tool_use_id))
          reject('unexpected_event',null,'tool_progress_identity');
        const name=pendingTools.get(message.tool_use_id);
        if(message.tool_name!==name||(name!=='StructuredOutput'&&!permitted.has(name)))
          reject('unexpected_event',null,'tool_progress_tool');
        if(!Number.isSafeInteger(message.elapsed_time_seconds)||message.elapsed_time_seconds<0)
          reject('unexpected_event',null,'tool_progress_elapsed');
        if(progressCount>=4096)reject('unexpected_event',null,'tool_progress_limit');
        progressCount++;
        return;
      }
      if (message.type === 'assistant') {
        // CLI 2.1.x reports an API failure as a synthetic assistant message with
        // a string error class, then an is_error result. Before any tool call it
        // carries no verdict: stop with the class so the user knows what to fix.
        if (typeof message.error === 'string' && message.parent_tool_use_id === null
          && message.message?.role === 'assistant' && toolIds.size === 0) {
          reject(Object.hasOwn(API_ERROR_CLASSES, message.error) ? API_ERROR_CLASSES[message.error] : 'reviewer_api_error',null,'api_error');
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
          if (noticeCount >= 32) reject('unexpected_event',null,'notice_limit');
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
          if (name !== 'StructuredOutput' && !permitted.has(name) && block.is_error !== true) {
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
      reject('unexpected_event',null,'unknown_message_type');
    },
    finish() {
      current=null;
      if (stage !== 'done') reject('incomplete_result');
      return {status:'succeeded', value};
    },
  });
}
