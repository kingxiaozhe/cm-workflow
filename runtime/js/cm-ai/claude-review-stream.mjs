// Conservative print/stream-json decoder. No dispatch, grant or completion authority.
// Process ownership must append process_closed and reject unsuccessful exits.
export function createClaudeReviewStream(onEvent) {
  let session = null, stage = 'init', value;
  const reject = code => { stage = 'failed'; throw Object.assign(new Error(code), {code}); };
  return Object.freeze({
    accept(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) reject('invalid_event');
      if (stage === 'done' || stage === 'failed') reject('unexpected_event');
      if (typeof message.session_id !== 'string' || !message.session_id.trim()
        || message.session_id.length > 256) reject('invalid_session');
      if (session !== null && session !== message.session_id) reject('session_mismatch');
      if (stage === 'init') {
        if (message.type !== 'system' || message.subtype !== 'init') reject('missing_init');
        session = message.session_id;
        stage = 'assistant';
        onEvent({event:'thread.started', provider_thread:session});
        onEvent({event:'turn.started', item_type:null});
        return;
      }
      if (message.type === 'assistant' && stage === 'assistant') {
        if (message.parent_tool_use_id !== null || message.error != null
          || message.message?.role !== 'assistant') reject('unexpected_assistant');
        const content = message.message.content;
        if (!Array.isArray(content) || content.length === 0
          || content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) {
          reject('unexpected_tool_or_content');
        }
        // Result is authoritative for structured output; assistant prose is never a verdict.
        stage = 'result';
        return;
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error !== false) reject('provider_failed');
        if (stage !== 'result' || message.num_turns !== 1) reject('unexpected_result');
        if (message.structured_output !== undefined) value = message.structured_output;
        else {
          try { value = JSON.parse(message.result); } catch { reject('invalid_output_json'); }
        }
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
