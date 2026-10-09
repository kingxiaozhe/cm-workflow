import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildReport, collectClaude, collectCodex, readSpecsLog, renderMarkdown, parseArgs, main, lines, UNATTRIBUTED} from './cm-token-report.mjs';

const script = fileURLToPath(new URL('./cm-token-report.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-report-home-'));
process.env.CM_WORKFLOW_HOME = path.join(home, 'home');
process.env.CM_WORKFLOW_LOG_HOME = path.join(home, 'logs');
after(() => fs.rmSync(home, {recursive: true, force: true}));

const CANARY = 'SECRET-CANARY-正文不该出现';
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function claudeLine({id, t, cwd, usage, model = 'claude-test-1', side = false, session = 's1', text = CANARY, type = 'assistant'}) {
  return {type, timestamp: t, cwd, sessionId: session, isSidechain: side, requestId: 'req_' + id,
    message: {id, model, role: 'assistant', content: [{type: 'text', text}, {type: 'tool_use', name: 'Bash', input: {command: CANARY}}], usage}};
}
const u = (input, cw, cr, out) => ({input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out});
const cmRow = (at, workflow, event, phase, run_id, extra = {}) => ({schema_version: 1, at, workflow, event, phase, run_id, ...extra});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-token-report-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = path.join(root, 'proj');
  const specs = path.join(project, 'specs');
  fs.mkdirSync(specs, {recursive: true});
  // CM 日志：develop 10:00-10:05；review 10:10-10:15；qa 10:20-10:25；同一运行事件间隔 <30 分钟所以外壳 10:00-10:25
  const run = 'feat-T-001';
  fs.writeFileSync(path.join(specs, '运行日志.jsonl'), jl([
    cmRow('2026-10-01T10:00:00+00:00', 'cm-ai', 'progress', 'start', run, {node: 'N3', phase_name: 'developing', operation_id: 'op-dev'}),
    // 时区写法不同：03:05-07:00 == 10:05Z
    cmRow('2026-10-01T03:05:00-07:00', 'cm-ai', 'progress', 'complete', run, {node: 'N3', phase_name: 'developing', operation_id: 'op-dev', outcome: 'returned'}),
    cmRow('2026-10-01T10:10:00+00:00', 'cm-ai', 'progress', 'start', run, {node: 'N4', phase_name: 'review_starting', operation_id: 'op-rev'}),
    cmRow('2026-10-01T10:15:00+00:00', 'cm-ai', 'progress', 'complete', run, {node: 'N4', phase_name: 'review_starting', operation_id: 'op-rev'}),
    cmRow('2026-10-01T10:20:00+00:00', 'cm-ai', 'test_run', 'start', run, {node: 'N6', operation_id: 'qa-1'}),
    cmRow('2026-10-01T10:25:00+00:00', 'cm-ai', 'test_run', 'complete', run, {node: 'N6', operation_id: 'qa-1'}),
    // 一个只有开始没有结束的 check（不确定窗口，只延伸到下一条事件 10:41）
    cmRow('2026-10-01T10:40:00+00:00', 'cm-ai', 'progress', 'start', run, {node: 'N3', phase_name: 'checking', operation_id: 'op-chk'}),
    cmRow('2026-10-01T10:41:00+00:00', 'cm-ai', 'decision', 'route', run, {node: 'N3'}),
  ].concat([
    cmRow('2026-10-01T12:00:00+00:00', 'cm-fix', 'run_start', '', 'fix-1', {node: 'FIX'}),
    cmRow('2026-10-01T12:10:00+00:00', 'cm-fix', 'run_done', '', 'fix-1', {node: 'FIX'}),
  ])));
  const enc = project.replace(/[^A-Za-z0-9]/g, '-');
  const claude = path.join(root, 'claude-projects');
  const dir = path.join(claude, enc);
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), {recursive: true});
  const T = (hm) => `2026-10-01T${hm}:00.000Z`;
  fs.writeFileSync(path.join(dir, 's1.jsonl'), jl([
    {type: 'user', timestamp: T('10:01'), cwd: project, message: {role: 'user', content: CANARY}},
    // develop 窗口内，同一 message.id 三行（流式分块），应只算一次（用量相同）
    claudeLine({id: 'm1', t: T('10:01'), cwd: project, usage: u(10, 100, 1000, 50)}),
    claudeLine({id: 'm1', t: T('10:01'), cwd: project, usage: u(10, 100, 1000, 50)}),
    claudeLine({id: 'm1', t: T('10:01'), cwd: project, usage: u(10, 100, 1000, 50)}),
    // review 窗口内
    claudeLine({id: 'm2', t: T('10:12'), cwd: project, usage: u(1, 0, 5000, 20)}),
    // qa 窗口内，子代理
    claudeLine({id: 'm3', t: T('10:22'), cwd: path.join(project, '.work', 'x'), usage: u(2, 10, 300, 5), side: true}),
    // 窗口之外：10:30 距上一事件(10:25)与下一事件(10:40)都在外壳内？外壳 10:00-10:41 连续，所以归 other
    claudeLine({id: 'm4', t: T('10:30'), cwd: project, usage: u(3, 0, 7, 1)}),
    // 完全未归属：当天 15:00
    claudeLine({id: 'm5', t: T('15:00'), cwd: project, usage: u(7, 7, 7, 7)}),
    // 合成消息、cwd 不在项目内、字段不全：都不计
    claudeLine({id: 'm6', t: T('10:02'), cwd: project, usage: u(99, 99, 99, 99), model: '<synthetic>'}),
    claudeLine({id: 'm7', t: T('10:02'), cwd: path.join(root, 'other'), usage: u(99, 99, 99, 99)}),
    claudeLine({id: 'm8', t: T('10:02'), cwd: project, usage: {input_tokens: 5}}),
    // fix 窗口
    claudeLine({id: 'm9', t: T('12:05'), cwd: project, usage: u(4, 4, 4, 4)}),
  ]));
  // 子代理转录：m10 在 develop 窗口；m1 在这里又出现一次（续跑复制），应跨文件去重
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-a.jsonl'), jl([
    claudeLine({id: 'm10', t: T('10:03'), cwd: project, usage: u(1, 2, 3, 4), side: true, session: 's1'}),
    claudeLine({id: 'm1', t: T('10:01'), cwd: project, usage: u(10, 100, 1000, 50), side: true}),
  ]));
  // Codex
  const codex = path.join(root, 'codex-sessions');
  const cdir = path.join(codex, '2026', '10', '01');
  fs.mkdirSync(cdir, {recursive: true});
  const tc = (t, total, last) => ({timestamp: t, type: 'event_msg', payload: {type: 'token_count', info: total === null ? null : {total_token_usage: {total_tokens: total}, last_token_usage: last}}});
  const cu = (inp, cached, out) => ({input_tokens: inp, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: 3, total_tokens: inp + out});
  fs.writeFileSync(path.join(cdir, 'rollout-a.jsonl'), jl([
    {timestamp: T('10:00'), type: 'session_meta', payload: {id: 'cx1', cwd: project, base_instructions: CANARY}},
    {timestamp: T('10:00'), type: 'turn_context', payload: {cwd: project, model: 'gpt-test'}},
    tc(T('10:01'), null),
    tc(T('10:02'), 1100, cu(1000, 800, 100)),
    tc(T('10:02'), 1100, cu(1000, 800, 100)), // 同一累计值重复事件
    tc(T('15:30'), 2300, cu(1100, 1000, 100)),
    {timestamp: T('10:03'), type: 'response_item', payload: {type: 'message', content: CANARY}},
  ]));
  fs.writeFileSync(path.join(cdir, 'rollout-b.jsonl'), jl([
    {timestamp: T('10:00'), type: 'session_meta', payload: {id: 'cx2', cwd: path.join(root, 'elsewhere')}},
    tc(T('10:02'), 500, cu(400, 0, 100)),
  ]));
  return {root, project, specs, claude, codex};
}

const get = (rep, wf, kind) => {
  const w = rep.by_workflow.find((x) => x.workflow === wf);
  if (!w) return null;
  return kind ? w.steps.find((s) => s.kind === kind) || null : w;
};

test('按时间窗口归属：innermost 步骤优先，其次运行外壳，窗口外=未归属；跨时区时间戳对齐', async (t) => {
  const f = fixture(t);
  const rep = await buildReport({project: f.project, specsDirs: [f.specs], claudeProjects: f.claude, codexSessions: f.codex});
  // develop 10:00-10:05：m1(10,100,1000,50)去重后一次 + m10(1,2,3,4) + codex 10:02 (未缓存 200,读 800,出 100)
  const dev = get(rep, 'cm-ai', 'develop');
  assert.deepEqual([dev.calls, dev.input, dev.cache_write, dev.cache_read, dev.output], [3, 10 + 1 + 200, 100 + 2, 1000 + 3 + 800, 50 + 4 + 100]);
  const rev = get(rep, 'cm-ai', 'review');
  assert.deepEqual([rev.calls, rev.input, rev.cache_read], [1, 1, 5000]);
  const qa = get(rep, 'cm-ai', 'qa');
  assert.deepEqual([qa.calls, qa.input, qa.cache_write], [1, 2, 10]);
  assert.equal(get(rep, 'cm-ai', 'other').calls, 1, '10:30 在步骤窗口外但在运行外壳内');
  assert.equal(get(rep, 'cm-fix', 'fix-diagnose').calls, 1);
  const un = get(rep, UNATTRIBUTED);
  // m5(15:00) + codex 15:30
  assert.equal(un.calls, 2);
  assert.equal(un.input, 7 + 100);
});

test('重复 message.id（流式分块、子代理转录复制）只计一次，统计里如实报告', async (t) => {
  const f = fixture(t);
  const c = await collectClaude(f.claude, f.project);
  const m1 = c.records.filter((r) => r.input === 10 && r.cache_read === 1000);
  assert.equal(m1.length, 1);
  assert.equal(c.stats.lines_with_usage, 13, '主转录 11 行 + 子代理转录 2 行（user 行不算）');
  assert.equal(c.stats.duplicates_removed, 3, 'm1 共 4 行（主转录 3 行流式分块 + 子代理转录 1 行），去掉 3 行');
});

test('合成消息、cwd 不在项目内、字段不全不计入，且不估算', async (t) => {
  const f = fixture(t);
  const c = await collectClaude(f.claude, f.project);
  assert.equal(c.stats.synthetic_skipped, 1);
  assert.equal(c.stats.outside_cwd, 1);
  assert.equal(c.stats.incomplete_usage, 1);
  assert.ok(!c.records.some((r) => r.input === 99 || r.input === 5));
  assert.equal(c.records.length, 7); // m1 m2 m3 m4 m5 m9 m10
});

test('Codex：input 拆成未缓存+缓存读，空 info 与重复累计值不计，其他 cwd 的会话跳过', async (t) => {
  const f = fixture(t);
  const x = await collectCodex(f.codex, f.project);
  assert.equal(x.records.length, 2);
  assert.equal(x.stats.null_info, 1);
  assert.equal(x.stats.duplicates_removed, 1);
  assert.equal(x.stats.sessions_matched, 1);
  const r = x.records[0];
  assert.deepEqual([r.input, r.cache_read, r.output, r.model], [200, 800, 100, 'gpt-test']);
});

test('--since 同时过滤用量与窗口', async (t) => {
  const f = fixture(t);
  const rep = await buildReport({project: f.project, specsDirs: [f.specs], sinceIso: '2026-10-01T14:00:00Z', claudeProjects: f.claude, codexSessions: f.codex});
  assert.equal(rep.total.calls, 2);
  assert.equal(get(rep, UNATTRIBUTED).calls, 2);
});

test('未配对的开始标不确定；窗口计数与不确定调用数如实给出', async (t) => {
  const f = fixture(t);
  const rep = await buildReport({project: f.project, specsDirs: [f.specs], claudeProjects: f.claude, codexSessions: f.codex});
  assert.equal(rep.windows.unpaired_start, 1);
  assert.equal(rep.windows.orphan_complete, 0);
});

test('最重调用榜按加权排序，只含元数据；输出里没有任何正文', async (t) => {
  const f = fixture(t);
  const rep = await buildReport({project: f.project, specsDirs: [f.specs], claudeProjects: f.claude, codexSessions: f.codex});
  // 加权最大的是 codex 10:02 那次（未缓存 200、读 800、出 100）
  assert.equal(rep.top_calls[0].src, 'codex');
  assert.equal(rep.top_calls[0].cache_read, 800);
  const weights = rep.weights;
  assert.equal(rep.top_calls[0].weighted, 200 * weights.input + 800 * weights.cache_read + 100 * weights.output);
  for (let i = 1; i < rep.top_calls.length; i++) assert.ok(rep.top_calls[i - 1].weighted >= rep.top_calls[i].weighted);
  const md = renderMarkdown(rep);
  assert.ok(!md.includes(CANARY) && !JSON.stringify(rep).includes(CANARY));
  assert.match(md, /加权合计的权重/);
  assert.match(md, new RegExp(UNATTRIBUTED.replace(/[（）]/g, '.')));
});

test('CLI：markdown 与 --json 输出，缺参数返回 2，不写任何文件', async (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.root).sort().join();
  const run = (args) => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', env: process.env});
  const ok = run(['--project', f.project, '--specs', f.specs, '--claude-projects', f.claude, '--codex-sessions', f.codex]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /# CM token 用量报告/);
  const js = run(['--project', f.project, '--specs', f.specs, '--claude-projects', f.claude, '--codex-sessions', f.codex, '--json', '--weights', 'in=1,cw=2,cr=0.5,out=4']);
  assert.equal(js.status, 0, js.stderr);
  const parsed = JSON.parse(js.stdout);
  assert.deepEqual(parsed.weights, {input: 1, cache_write: 2, cache_read: 0.5, output: 4});
  assert.ok(Array.isArray(parsed.top_calls));
  assert.equal(run(['--project', f.project]).status, 2);
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(fs.readdirSync(f.root).sort().join(), before);
  assert.throws(() => parseArgs(['--weights', 'in=x']), /--weights/);
  const io = {stdout: {write() {}}, stderr: {write() {}}};
  assert.equal(await main(['--project', f.project, '--specs', f.specs, '--since', 'not-a-date', '--claude-projects', f.claude, '--codex-sessions', f.codex], io), 1);
});

test('目录不存在或日志缺失：如实标注，不报错也不估算', async (t) => {
  const f = fixture(t);
  const rep = await buildReport({project: f.project, specsDirs: [path.join(f.root, 'nope')], claudeProjects: path.join(f.root, 'no-claude'), codexSessions: path.join(f.root, 'no-codex')});
  assert.equal(rep.total.calls, 0);
  assert.equal(rep.cm_logs[0].missing, true);
  assert.equal(rep.claude_stats.dir_missing, true);
  assert.equal(rep.codex_stats.dir_missing, true);
  assert.match(renderMarkdown(rep), /文件不存在/);
});

// ---------- 第一轮审查修复的回归测试 ----------
const run1 = (f, extra = {}) => buildReport({project: f.project, specsDirs: [f.specs], claudeProjects: f.claude, codexSessions: f.codex, ...extra});
const projDir = (f) => path.join(f.claude, f.project.replace(/[^A-Za-z0-9]/g, '-'));

test('隐私：model 是数组/对象/过长/带空格时不进入输出（只放行短的模型标识符）', async (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(projDir(f), 's1.jsonl'), jl([
    claudeLine({id: 'p1', t: '2026-10-01T10:03:00.000Z', cwd: f.project, usage: u(1, 1, 1, 1), model: ['BODY-CANARY']}),
    claudeLine({id: 'p2', t: '2026-10-01T10:03:00.000Z', cwd: f.project, usage: u(1, 1, 1, 1), model: {nested: 'BODY-CANARY'}}),
    claudeLine({id: 'p3', t: '2026-10-01T10:03:00.000Z', cwd: f.project, usage: u(1, 1, 1, 1), model: 'BODY CANARY with spaces'}),
    claudeLine({id: 'p4', t: '2026-10-01T10:03:00.000Z', cwd: f.project, usage: u(1, 1, 1, 1), model: 'x'.repeat(101)}),
    {...claudeLine({id: 'p5', t: '2026-10-01T10:03:00.000Z', cwd: f.project, usage: u(1, 1, 1, 1)}), sessionId: ['BODY-CANARY']},
  ]));
  const cdir = path.join(f.codex, '2026', '10', '01');
  fs.appendFileSync(path.join(cdir, 'rollout-a.jsonl'), jl([
    {timestamp: '2026-10-01T10:04:00.000Z', type: 'turn_context', payload: {cwd: f.project, model: ['BODY-CANARY']}},
    {timestamp: '2026-10-01T10:04:01.000Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {total_tokens: 9000}, last_token_usage: {input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1}}}},
  ]));
  const rep = await run1(f);
  const out = renderMarkdown(rep) + JSON.stringify(rep);
  assert.ok(!out.includes('BODY-CANARY') && !out.includes('BODY CANARY') && !out.includes('xxxxxxxxxx'));
  assert.equal(rep.by_model['未知'].calls, 4); // p1..p4；Codex 的非法 model 保留上一个合法值
});

test('安全：运行日志是指向 specs 之外的符号链接时不读取；转录目录里指向外部的链接跳过并计数', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.jsonl');
  fs.writeFileSync(outside, jl([cmRow('2026-10-01T10:00:00Z', 'cm-ai', 'run_start', '', 'evil-run')]));
  const spec2 = path.join(f.project, 'specs2');
  fs.mkdirSync(spec2);
  fs.symlinkSync(outside, path.join(spec2, '运行日志.jsonl'));
  const lg = await readSpecsLog(spec2);
  assert.equal(lg.unsafe, true);
  assert.equal(lg.rows.length, 0);
  const evil = path.join(f.root, 'evil-transcript.jsonl');
  fs.writeFileSync(evil, jl([claudeLine({id: 'evil', t: '2026-10-01T10:01:00.000Z', cwd: f.project, usage: u(777, 0, 0, 0)})]));
  fs.symlinkSync(evil, path.join(projDir(f), 'link.jsonl'));
  const c = await collectClaude(f.claude, f.project);
  assert.equal(c.stats.unsafe_links_skipped, 1);
  assert.ok(!c.records.some((r) => r.input === 777));
  fs.symlinkSync(evil, path.join(f.codex, '2026', '10', '01', 'link.jsonl'));
  assert.equal((await collectCodex(f.codex, f.project)).stats.unsafe_links_skipped, 1);
});

test('--since 按事件时间戳过滤 Codex，不按日期目录跳过', async (t) => {
  const f = fixture(t);
  const old = path.join(f.codex, '2020', '01', '01');
  fs.mkdirSync(old, {recursive: true});
  const ev = (t2, total) => ({timestamp: t2, type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {total_tokens: total}, last_token_usage: {input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1}}}});
  fs.writeFileSync(path.join(old, 'rollout-old-dir.jsonl'), jl([
    {timestamp: '2026-10-01T09:00:00Z', type: 'session_meta', payload: {id: 'cx9', cwd: f.project}},
    ev('2026-10-01T09:30:00Z', 11), ev('2026-10-01T10:30:00Z', 22),
  ]));
  const x = await collectCodex(f.codex, f.project, {sinceMs: Date.parse('2026-10-01T10:00:00Z')});
  assert.ok(x.records.some((r) => r.session === 'cx9' && r.t === Date.parse('2026-10-01T10:30:00Z')));
  assert.ok(!x.records.some((r) => r.session === 'cx9' && r.t === Date.parse('2026-10-01T09:30:00Z')));
});

test('缺失的缓存字段不补 0：缺 cached_input_tokens 的 Codex 记录整条排除并计数，缺 cache_write 记为未知', async (t) => {
  const f = fixture(t);
  const ev = (t2, total, last) => ({timestamp: t2, type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {total_tokens: total}, last_token_usage: last}}});
  fs.appendFileSync(path.join(f.codex, '2026', '10', '01', 'rollout-a.jsonl'), jl([
    ev('2026-10-01T10:05:00Z', 5000, {input_tokens: 900, output_tokens: 10}), // 缺 cached
    ev('2026-10-01T10:06:00Z', 5100, {input_tokens: 50, cached_input_tokens: 10, output_tokens: 1}), // 缺 cache_write
    ev('2026-10-01T10:07:00Z', 5200, {input_tokens: 5, cached_input_tokens: 10, output_tokens: 1}), // cached > input：不自洽
  ]));
  const x = await collectCodex(f.codex, f.project);
  assert.equal(x.stats.incomplete_usage, 2);
  assert.equal(x.stats.cache_write_unknown, 1);
  assert.ok(!x.records.some((r) => r.input === 900));
  const unknown = x.records.find((r) => r.cache_write === null);
  assert.deepEqual([unknown.input, unknown.cache_read], [40, 10]);
  const rep = await run1(f);
  assert.equal(rep.flags.cache_write_unknown_calls, 1);
});

test('读取提前结束或遇到超长行时：底层流被销毁，超长行被跳过并计数', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'long.jsonl');
  fs.writeFileSync(file, 'a\n' + 'x'.repeat(5000) + '\nb\n');
  const got = [];
  for await (const l of lines(file, 100)) got.push(typeof l === 'symbol' ? 'OVERLONG' : l);
  assert.deepEqual(got, ['a', 'OVERLONG', 'b']);
  const streams = [];
  const orig = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...a) => { const s = orig(...a); streams.push(s); return s; });
  for await (const l of lines(file)) { void l; break; }
  assert.equal(streams.length, 1);
  assert.equal(streams[0].destroyed, true);
});

test('非对象的合法 JSON 行（null、数组、字符串）不抛错，只计坏行；超长日志行被跳过', async (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.specs, '运行日志.jsonl'), 'null\n[1]\n"usage"\n' + JSON.stringify({at: '2026-10-01T10:00:00Z', run_id: 'big', pad: 'y'.repeat(1100000)}) + '\n');
  const lg = await readSpecsLog(f.specs);
  assert.equal(lg.bad, 3);
  assert.equal(lg.overlong, 1);
  fs.appendFileSync(path.join(projDir(f), 's1.jsonl'), 'null\n"usage"\n[{"usage":1}]\n{"type":"assistant","message":null,"usage":1}\n{"type":"assistant","message":{"usage":"x"}}\n');
  fs.appendFileSync(path.join(f.codex, '2026', '10', '01', 'rollout-a.jsonl'), 'null\n{"type":"event_msg","payload":"token_count"}\n[\"token_count\"]\n');
  const rep = await run1(f);
  assert.equal(rep.claude_stats.bad_lines, 2); // "usage" 与 [{"usage":1}]；null 行不含 usage 字样被预过滤
  assert.equal(rep.codex_stats.bad_lines, 1); // ["token_count"]；null 行不含 token_count 字样被预过滤
  assert.equal(rep.total.calls, 7 + 2);
});

test('十几万条记录时时间范围不抛 RangeError（增量求最值）', async (t) => {
  const f = fixture(t);
  const big = path.join(projDir(f), 'big.jsonl');
  const parts = [];
  for (let i = 0; i < 150000; i++) parts.push(`{"type":"assistant","timestamp":"2026-10-02T00:00:00.000Z","cwd":${JSON.stringify(f.project)},"message":{"id":"b${i}","model":"m","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}`);
  fs.writeFileSync(big, parts.join('\n') + '\n');
  const rep = await run1(f);
  assert.ok(rep.total.calls >= 150000);
  assert.ok(rep.span.to >= rep.span.from);
});
