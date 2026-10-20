export const CODEX_RECONNECT_NOTICE_LIMIT=32;

export function isCodexReconnectNotice(event){
  return event.type==='error'&&typeof event.message==='string'
    &&/^Reconnecting\.\.\. \d+\/\d+/.test(event.message);
}
