// One METRICS.md table shape, shared by the fix and refactor closeouts.
// The 「Codex拦截」 column was renamed to 「独立审查拦截」 as a semantic upgrade of the
// same column — N4-review.md says exactly that: keep the original column order, upgrade
// what the old 「Codex拦截」 means. Matching the header as one exact string turned that
// rename into a hard wall instead: every METRICS.md written before it is refused with
// metrics_table_invalid / refactor_metrics_format, both closeouts stop, and there is no
// migration path. Accept every name this table has ever used, keep writing the current
// one for new files, and never rewrite the header inside a file the user owns.
export const METRICS_HEADER='| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |';
export const METRICS_SEPARATOR='| --- | --- | --- | --- | --- | --- | --- | --- |';

// Column order and count are identical across the rename, so a row written today lines
// up under either header. Only these exact lines count: an arbitrary table is still not
// this table, and is still refused by the callers.
const ACCEPTED_HEADERS=Object.freeze([METRICS_HEADER,
  '| 任务 | Feature | 开始 | 结束 | 审查轮次 | Codex拦截 | QA | 人工介入(次:原因) |']);

export function hasMetricsHeader(content) {
  if(typeof content!=='string')return false;
  const lines=content.split(/\r?\n/);
  return ACCEPTED_HEADERS.some(candidate=>lines.includes(candidate));
}
