// Checklist coverage: a reminder, never a verdict.
//
// Four of the five development-stage rejections recorded on the reference
// project were not defects. The task text had enumerated a list — "confirm
// filter / search / edit / delete / clear-completed / clear-all do not
// regress", "record the empty, partial and complete states" — and the delivery
// simply left some entries out. A human reviewer found them, which costs a
// full review round.
//
// Counting entries is mechanical, so it does not need a reviewer. What is NOT
// mechanical is deciding whether an entry was covered under different wording
// ("列表为空" in the task, "空列表" in the evidence), which is why every result
// here is advisory: it says what to look at, never what to reject.

const MAX_LISTS = 16, MAX_ITEMS = 12, MAX_TEXT = 512 * 1024;

const suffixes = value => {
  const out = [];
  for (let i = 1; i <= value.length - 2; i += 1) out.push(value.slice(i));
  return out;
};
const prefixes = value => {
  const out = [];
  for (let i = value.length - 1; i >= 2; i -= 1) out.push(value.slice(0, i));
  return out;
};

// The first and last entry of a slash list absorb the surrounding sentence
// ("核对既有筛选", "清空全部不回归"), so they are matched by giving ground from
// the outside in. Interior entries stand alone and are matched verbatim.
function locate(item, text, position, length) {
  if (text.includes(item)) return item;
  const relaxed = position === 0 ? suffixes(item) : position === length - 1 ? prefixes(item) : [];
  return relaxed.find(candidate => text.includes(candidate)) ?? null;
}

export function extractChecklists(taskText) {
  if (typeof taskText !== 'string' || taskText.length === 0 || taskText.length > MAX_TEXT) return Object.freeze([]);
  const lists = [], seen = new Set();
  const add = (source, items) => {
    const entries = items.map(value => value.trim()).filter(value => value.length >= 2);
    if (entries.length < 3 || entries.length > MAX_ITEMS || lists.length >= MAX_LISTS) return;
    const key = entries.join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    lists.push(Object.freeze({ source, items: Object.freeze(entries) }));
  };
  // 核对既有筛选/搜索/编辑/删除/清理已完成/清空全部不回归
  for (const match of taskText.matchAll(/([\u4e00-\u9fa5]{2,8}(?:\/[\u4e00-\u9fa5]{2,8}){2,})/g))
    add(match[1], match[1].split('/'));
  // 分别记录**列表为空、有未完成、全部已完成**三种情形
  for (const match of taskText.matchAll(/\*\*([^*\n]{4,80})\*\*\s*(?:这)?(?:三|四|五|六|七|八)\s*(?:种|类|个|项)/g))
    add(match[1], match[1].split(/[、，,]/));
  return Object.freeze(lists);
}

// Returns only the lists that are missing at least one entry. An empty array
// means nothing was detected — not that the delivery is complete.
export function checklistGaps(taskText, evidenceText) {
  if (typeof evidenceText !== 'string' || evidenceText.length === 0) return Object.freeze([]);
  const text = evidenceText.length > MAX_TEXT ? evidenceText.slice(0, MAX_TEXT) : evidenceText;
  const gaps = [];
  for (const list of extractChecklists(taskText)) {
    const missing = list.items.filter((item, index) => locate(item, text, index, list.items.length) === null);
    if (missing.length > 0) gaps.push(Object.freeze({
      source: list.source, total: list.items.length, missing: Object.freeze(missing),
    }));
  }
  return Object.freeze(gaps);
}
