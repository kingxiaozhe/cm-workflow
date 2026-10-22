// 审查凭证里「批准且零阻塞」的正文说法：任务门禁与 cm-refactor 驾驶员共用这一份。
// 「阻断」是 CM 严重度分级的用词，审查方常写「零阻塞发现」「无阻断发现」，一并接受；
// 原有说法全部保留。改动这里即改动两处门禁，文档列表见 runtime/review.md「Evidence file」。
export const ZERO_BLOCKING_PHRASES=Object.freeze(['零发现','零阻塞发现','零阻断发现','无阻塞发现','无阻断发现',
  '未发现阻塞','未发现阻断','zero findings','no findings','no blocking findings']);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export const ZERO_BLOCKING_FINDINGS=new RegExp(`(${ZERO_BLOCKING_PHRASES.map(escape).join('|')})`,'i');
export const REVIEWER_SOURCES=Object.freeze(['codex-subagent','codex-cli','claude-cli','self-degraded']);
