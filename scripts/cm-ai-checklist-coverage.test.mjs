import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {checklistGaps, extractChecklists} from '../runtime/js/cm-ai/checklist-coverage.mjs';
import {deliveredText} from '../runtime/js/cm-ai/host-conversation-execution.mjs';

// The task line that produced the real rejection on the reference project.
const realTask = '- [x] T-003: 按 `test-cases.json` 的 browser 用例在本地 `npm start` 页面走查：'
  + '3 条未完成时点击后全部变为已完成且 `剩余 0 项`、空列表与全部已完成时按钮 disabled、'
  + '删除一条后点击本按钮撤销仍可用；并核对既有筛选/搜索/编辑/删除/清理已完成/清空全部不回归\n'
  + '- T-003: 浏览器证据必须逐用例标注输入方式（鼠标/键盘/脚本）与起始存储；'
  + '按钮状态类用例必须分别记录**列表为空、有未完成、全部已完成**三种情形下 `#mark-all-done` 的 `disabled` 值。';

// Exactly the rows the independent reviewer quoted from the rejected round.
const rejectedEvidence = '## 已有功能不回归\n单条添加 删除 撤销删除 筛选「已完成」 搜索「王」 计数 剩余 N 项\n'
  + '本文档不涉及需要打桩的确认对话框。';

// This is the case the whole module exists for. A human reviewer spent a full
// round finding it; the entries are countable, so it should not have cost one.
test('the entries the real review rejected over are reported before dispatch', () => {
  const gaps = checklistGaps(realTask, rejectedEvidence);
  const regression = gaps.find(gap => gap.total === 6);
  assert.notEqual(regression, undefined, '六项回归清单未被识别');
  assert.deepEqual([...regression.missing], ['编辑', '清理已完成', '清空全部不回归']);
});

test('a delivery covering every entry reports no gap for that list', () => {
  const complete = '筛选 搜索 编辑 删除 清理已完成 清空全部 都走查过了';
  assert.equal(checklistGaps('核对既有筛选/搜索/编辑/删除/清理已完成/清空全部不回归', complete).length, 0);
});

// The first and last entry absorb the surrounding sentence, so verbatim
// matching alone would report a gap for a delivery that actually covered them.
test('the first and last entry match without their absorbed sentence context', () => {
  const task = '核对既有筛选/搜索/清空全部不回归';
  assert.equal(checklistGaps(task, '筛选 搜索 清空全部').length, 0);
  assert.deepEqual([...checklistGaps(task, '筛选 清空全部')[0].missing], ['搜索']);
});

test('both enumeration forms are extracted and nothing else is invented', () => {
  const lists = extractChecklists(realTask);
  const sizes = lists.map(list => list.items.length).sort();
  assert.deepEqual(sizes, [3, 3, 6], `抽出来的清单不对: ${JSON.stringify(lists)}`);
  // A two-entry pair is a phrase, not a checklist.
  assert.deepEqual([...extractChecklists('核对新增/删除两条路径')], []);
  assert.deepEqual([...extractChecklists('')], []);
  assert.deepEqual([...extractChecklists(null)], []);
});

test('results are frozen so a caller cannot edit the report into a pass', () => {
  const gaps = checklistGaps('核对既有筛选/搜索/编辑不回归', '筛选');
  assert.throws(() => { gaps.push({}); }, TypeError);
  assert.throws(() => { gaps[0].missing.length = 0; }, TypeError);
});

// Advisory means advisory. Wording differs legitimately between the task and
// the evidence, and this module must never be read as a verdict.
test('a synonym the module cannot see is reported as a gap, which is why it only advises', () => {
  const gaps = checklistGaps('分别记录**列表为空、有未完成、全部已完成**三种情形', '空列表 有未完成 全部已完成');
  assert.deepEqual([...gaps[0].missing], ['列表为空'],
    '这是已知的误报：同义不同字。它只提醒，不判定。');
});

test('oversized or non-string input yields no report instead of throwing', () => {
  assert.deepEqual([...checklistGaps('核对既有筛选/搜索/编辑不回归', '')], []);
  assert.deepEqual([...checklistGaps('核对既有筛选/搜索/编辑不回归', null)], []);
  assert.deepEqual([...extractChecklists('核'.repeat(512 * 1024 + 1))], []);
  // An evidence body past the cap is truncated, not rejected.
  const padded = 'x'.repeat(512 * 1024) + '编辑';
  assert.deepEqual([...checklistGaps('核对既有筛选/搜索/编辑不回归', padded)[0].missing],
    ['核对既有筛选', '搜索', '编辑不回归']);
});

function fixture(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-checklist-')));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// The evidence usually lives in a scope file, not in the gate answers, so the
// reminder is worthless if it cannot read the delivery.
test('scope files are read, and unreadable entries contribute nothing rather than failing', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'qa.md'), '编辑 清理已完成');
  fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(256 * 1024 + 1));
  fs.writeFileSync(path.join(root, 'binary.md'), Buffer.from([0x61, 0x00, 0x62]));
  fs.symlinkSync('qa.md', path.join(root, 'link.md'));
  fs.mkdirSync(path.join(root, 'dir.md'));

  assert.match(deliveredText(root, ['qa.md']), /清理已完成/);
  for (const entry of ['big.md', 'binary.md', 'link.md', 'dir.md', 'missing.md', '', 42])
    assert.equal(deliveredText(root, [entry]), '', `${entry} 不该被读进来`);
  assert.equal(deliveredText(root, 'not-an-array'), '');
  assert.equal(deliveredText(null, ['qa.md']), '');
  // A readable file still counts when it sits beside unreadable ones.
  assert.match(deliveredText(root, ['missing.md', 'qa.md', 'big.md']), /编辑/);
}));

// The gate's verdict is the gate's. This module reports alongside it.
test('the gate emits the reminder without letting it change the verdict', async () => {
  const source = fs.readFileSync(new URL('../runtime/js/cm-ai/host-conversation-execution.mjs',
    import.meta.url), 'utf8');
  const gate = /const verificationGate=options\.verificationPrecheck===true\?([\s\S]*?)\n  \}:null;/.exec(source);
  assert.notEqual(gate, null, 'verificationGate not found');
  assert.match(gate[1], /checklistGaps\(/);
  assert.match(gate[1], /diagnostic:'checklist_coverage'/);
  assert.match(gate[1], /advisory:true/);
  // The returned verdict must still be the gate's own, unqualified by coverage.
  assert.match(gate[1], /return \{satisfied:verdict\.satisfied\};/);
  assert.equal(/satisfied:verdict\.satisfied&&/.test(gate[1]), false,
    'coverage was folded into the verdict; it must stay advisory');
  // Any throw inside the reminder must not reach the caller.
  const reminder = /\/\/ Advisory only\.[\s\S]*?\}catch\{[^}]*\}/.exec(gate[1]);
  assert.notEqual(reminder, null, 'the reminder is not wrapped in its own try/catch');
});
