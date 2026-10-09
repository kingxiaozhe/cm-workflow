#!/usr/bin/env node
// 只读 token 用量报告：把 Claude Code / Codex CLI 会话里的 token 记录，按 CM 运行日志的时间窗口归到 工作流 -> 步骤。
// 隐私：只读取 时间戳/模型/用量数字/cwd/会话 id/是否子代理 这些元数据字段，不读取、不输出、不保存任何消息正文、工具入参或工具结果。
// 只读：不写任何文件（除非调用方自己把标准输出重定向）。不估算缺失的数字。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';

export const UNATTRIBUTED = '未归属（会话闲聊/人工操作）';
export const STEP_KINDS = ['develop', 'review', 'qa', 'check', 'prd-analysis', 'fix-diagnose', 'other'];
export const DEFAULT_WEIGHTS = {input: 1, cache_write: 1.25, cache_read: 0.1, output: 5};
const DEFAULT_GAP_MIN = 30;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const ms = (s) => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const encodeDir = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const within = (cwd, root) => typeof cwd === 'string' && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/'));

async function* lines(file) {
  const rl = readline.createInterface({input: fs.createReadStream(file), crlfDelay: Infinity});
  try { for await (const l of rl) yield l; } finally { rl.close(); }
}

function walkJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ---------- CM 运行日志 -> 时间窗口 ----------
const PRD_KIND = {
  requirements_analysis: 'prd-analysis', design_generation: 'prd-analysis', task_split: 'prd-analysis',
  design_review: 'review', spec_review: 'review', spec_validation: 'check', context_load: 'other',
};
const AI_PHASE_KIND = {developing: 'develop', checking: 'check', review_starting: 'review'};
const AI_NODE_KIND = {N3: 'develop', N4: 'review', N6: 'qa'};

function stepKind(row) {
  if (row.workflow === 'cm-prd') return PRD_KIND[row.phase_name] || 'other';
  if (row.workflow === 'cm-fix') return 'fix-diagnose';
  return AI_PHASE_KIND[row.phase_name] || AI_NODE_KIND[row.node] || 'other';
}

export function readSpecsLog(specsDir) {
  const file = path.join(specsDir, '运行日志.jsonl');
  const rows = [];
  let bad = 0;
  if (!fs.existsSync(file)) return {rows, bad, missing: true, file};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { bad++; continue; }
    const t = ms(o.at);
    if (t === null || !o.run_id) { bad++; continue; }
    // 只取元数据字段
    rows.push({t, workflow: String(o.workflow || ''), event: String(o.event || ''), phase: o.phase || '', run_id: String(o.run_id),
      node: o.node || '', phase_name: o.phase_name || '', operation_id: o.operation_id || '', specs: path.basename(specsDir)});
  }
  rows.sort((a, b) => a.t - b.t);
  return {rows, bad, missing: false, file};
}

// level 0 = 具体步骤窗口；level 1 = 运行外壳（相邻事件间隔不超过 gap 才连在一起）
export function buildWindows(rows, {gapMs = DEFAULT_GAP_MIN * 60000} = {}) {
  const windows = [];
  const stats = {unpaired_start: 0, orphan_complete: 0};
  const byRun = new Map();
  for (const r of rows) {
    const k = `${r.specs}|${r.workflow}|${r.run_id}`;
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k).push(r);
  }
  for (const [runKey, evs] of byRun) {
    const workflow = evs[0].workflow;
    const specs = evs[0].specs;
    const open = new Map();
    const mk = (kind, start, end, level, uncertain, label) => windows.push({runKey, workflow, specs, kind, start, end, level, uncertain, label, run_id: evs[0].run_id});
    evs.forEach((r, i) => {
      const isStep = r.event === 'progress' || r.event === 'test_run';
      if (isStep && r.phase === 'start') open.set(`${r.event}|${r.operation_id}`, {r, i});
      else if (isStep && (r.phase === 'complete' || (r.event === 'test_run' && r.phase === 'superseded'))) {
        const key = `${r.event}|${r.operation_id}`;
        const s = open.get(key);
        if (!s) { if (r.phase === 'complete') stats.orphan_complete++; return; }
        open.delete(key);
        const kind = r.event === 'test_run' ? 'qa' : stepKind(s.r);
        mk(kind, s.r.t, Math.max(r.t, s.r.t), 0, false, r.event === 'test_run' ? 'qa' : (s.r.phase_name || s.r.node));
      }
    });
    // 没配对的 start：窗口只到该 run 下一条事件，标不确定
    for (const {r, i} of open.values()) {
      stats.unpaired_start++;
      const next = evs.slice(i + 1).find((e) => e.t > r.t);
      mk(r.event === 'test_run' ? 'qa' : stepKind(r), r.t, next ? next.t : r.t, 0, true, r.phase_name || r.node);
    }
    // 运行外壳
    let segStart = evs[0].t, prev = evs[0].t;
    const shellKind = workflow === 'cm-fix' ? 'fix-diagnose' : 'other';
    for (let i = 1; i < evs.length; i++) {
      if (evs[i].t - prev > gapMs) { mk(shellKind, segStart, prev, 1, false, 'run'); segStart = evs[i].t; }
      prev = evs[i].t;
    }
    mk(shellKind, segStart, prev, 1, false, 'run');
  }
  return {windows, stats};
}

export function attribute(t, windows) {
  // 返回 {window|null, ambiguous}
  let best = null, level0runs = new Set(), allRuns = new Set();
  for (const w of windows) {
    if (w.start > t) continue;
    if (w.end < t) continue;
    allRuns.add(w.runKey);
    if (w.level === 0) level0runs.add(w.runKey);
    if (!best || w.level < best.level || (w.level === best.level && (w.end - w.start) < (best.end - best.start))) best = w;
  }
  return {window: best, ambiguous: (best && best.level === 0 ? level0runs : allRuns).size > 1};
}

// ---------- 用量采集 ----------
export async function collectClaude(projectsDir, project, {sinceMs = null} = {}) {
  const enc = encodeDir(project);
  const stats = {files: 0, lines_with_usage: 0, unique: 0, duplicates_removed: 0, synthetic_skipped: 0, incomplete: 0, outside_cwd: 0, no_cwd: 0, no_timestamp: 0, dir_missing: false};
  const byId = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, {withFileTypes: true}).filter((d) => d.isDirectory() && d.name.includes(enc)); } catch { stats.dir_missing = true; }
  for (const d of dirs) {
    for (const file of walkJsonl(path.join(projectsDir, d.name))) {
      stats.files++;
      let lastCwd = null;
      for await (const l of lines(file)) {
        if (!l.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
        stats.lines_with_usage++;
        const m = o.message, u = m.usage;
        if (m.model === '<synthetic>') { stats.synthetic_skipped++; continue; }
        const cwd = typeof o.cwd === 'string' ? (lastCwd = o.cwd) : lastCwd;
        if (!cwd) { stats.no_cwd++; continue; }
        if (!within(cwd, project)) { stats.outside_cwd++; continue; }
        const t = ms(o.timestamp);
        const input = num(u.input_tokens), cw = num(u.cache_creation_input_tokens), cr = num(u.cache_read_input_tokens), out = num(u.output_tokens);
        if (input === null || cw === null || cr === null || out === null) { stats.incomplete++; continue; }
        const rec = {src: 'claude', t, model: m.model || '未知', cwd, session: o.sessionId || null, side: o.isSidechain === true, input, cache_write: cw, cache_read: cr, output: out};
        const id = m.id || o.requestId || o.uuid;
        if (!id) { byId.set(Symbol('noid'), rec); continue; }
        const old = byId.get(id);
        const total = (r) => r.input + r.cache_write + r.cache_read + r.output;
        if (!old) byId.set(id, rec);
        else {
          stats.duplicates_removed++;
          // 保留更大的用量；相同则保留更早的时间戳
          if (total(rec) > total(old) || (total(rec) === total(old) && rec.t !== null && (old.t === null || rec.t < old.t))) byId.set(id, rec);
        }
      }
    }
  }
  const recs = [...byId.values()];
  for (const r of recs) if (r.t === null) stats.no_timestamp++;
  stats.unique = recs.length;
  return {records: recs.filter((r) => sinceMs === null || r.t === null || r.t >= sinceMs), stats};
}

export async function collectCodex(sessionsDir, project, {sinceMs = null} = {}) {
  const stats = {files: 0, files_scanned: 0, sessions_matched: 0, token_events: 0, duplicates_removed: 0, null_info: 0, no_timestamp: 0, dir_missing: false, matched_without_token_events: 0};
  const records = [];
  if (!fs.existsSync(sessionsDir)) { stats.dir_missing = true; return {records, stats}; }
  const files = walkJsonl(sessionsDir);
  stats.files = files.length;
  for (const file of files) {
    // 日期目录早于 since 一天以上的文件直接跳过
    if (sinceMs !== null) {
      const m = file.match(/(\d{4})[\/\\](\d{2})[\/\\](\d{2})[\/\\][^\/\\]+$/);
      if (m && Date.UTC(+m[1], +m[2] - 1, +m[3]) + 2 * 86400000 < sinceMs) continue;
    }
    stats.files_scanned++;
    let first = true, metaCwd = null, cwd = null, model = '未知', sessionId = null, matched = false, maxTotal = -1, events = 0;
    for await (const l of lines(file)) {
      if (first) {
        first = false;
        let o;
        try { o = JSON.parse(l); } catch { break; }
        const p = o && o.payload;
        metaCwd = p && typeof p.cwd === 'string' ? p.cwd : null;
        sessionId = p && (p.id || p.session_id) || null;
        if (!within(metaCwd, project)) break;
        cwd = metaCwd; matched = true; stats.sessions_matched++;
        continue;
      }
      if (l.includes('"turn_context"')) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'turn_context' && o.payload) {
          if (typeof o.payload.model === 'string') model = o.payload.model;
          if (typeof o.payload.cwd === 'string') cwd = o.payload.cwd;
        }
        continue;
      }
      if (!l.includes('"token_count"')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const p = o.payload;
      if (o.type !== 'event_msg' || !p || p.type !== 'token_count') continue;
      stats.token_events++; events++;
      const info = p.info;
      if (!info || !info.last_token_usage || !info.total_token_usage) { stats.null_info++; continue; }
      const tot = num(info.total_token_usage.total_tokens);
      if (tot !== null) {
        if (tot <= maxTotal) { stats.duplicates_removed++; continue; }
        maxTotal = tot;
      }
      const u = info.last_token_usage;
      const inp = num(u.input_tokens), cached = num(u.cached_input_tokens), out = num(u.output_tokens);
      if (inp === null || out === null) { stats.null_info++; continue; }
      const cw = num(u.cache_write_input_tokens) || 0, cr = cached || 0;
      if (!within(cwd, project)) continue;
      const t = ms(o.timestamp);
      if (t === null) stats.no_timestamp++;
      // Codex 的 input_tokens 含缓存命中部分，这里拆成 未缓存输入 + 缓存读；output 已含推理 token，不再另加
      records.push({src: 'codex', t, model, cwd, session: sessionId, side: false, input: Math.max(0, inp - cr), cache_write: cw, cache_read: cr, output: out});
    }
    if (matched && events === 0) stats.matched_without_token_events++;
  }
  return {records: records.filter((r) => sinceMs === null || r.t === null || r.t >= sinceMs), stats};
}

// ---------- 汇总 ----------
const blank = () => ({calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0});
const addTo = (a, r) => { a.calls++; a.input += r.input; a.cache_write += r.cache_write; a.cache_read += r.cache_read; a.output += r.output; };
export const weighted = (a, w) => a.input * w.input + a.cache_write * w.cache_write + a.cache_read * w.cache_read + a.output * w.output;
const cwdClass = (cwd, project) => (cwd === project ? '项目根目录' : /[\/\\]\.work[\/\\]/.test(cwd) ? '.work 工作树（CM 派出的会话）' : '项目子目录');

export function summarize({records, windows, project, weights = DEFAULT_WEIGHTS, topN = 10}) {
  const tree = new Map(); // workflow -> kind -> sums
  const total = blank(), bySrc = {}, byModel = {}, byCwd = {}, byDir = {}, bySession = {};
  const top = [];
  const flags = {ambiguous_calls: 0, no_timestamp_calls: 0, uncertain_window_calls: 0};
  const sorted = windows.slice().sort((a, b) => a.start - b.start);
  for (const r of records) {
    let wf = UNATTRIBUTED, kind = '-', win = null;
    if (r.t === null) flags.no_timestamp_calls++;
    else {
      const a = attribute(r.t, sorted);
      if (a.window) { win = a.window; wf = win.workflow; kind = win.kind; if (a.ambiguous) flags.ambiguous_calls++; if (win.uncertain) flags.uncertain_window_calls++; }
    }
    const cell = ((tree.get(wf) || tree.set(wf, new Map()).get(wf)).get(kind) || (tree.get(wf).set(kind, blank()), tree.get(wf).get(kind)));
    addTo(cell, r); addTo(total, r);
    addTo(bySrc[r.src] || (bySrc[r.src] = blank()), r);
    addTo(byModel[r.model] || (byModel[r.model] = blank()), r);
    addTo(byCwd[cwdClass(r.cwd, project)] || (byCwd[cwdClass(r.cwd, project)] = blank()), r);
    const rel = r.cwd === project ? '.' : r.cwd.slice(project.length + 1);
    addTo(byDir[rel] || (byDir[rel] = blank()), r);
    const sk = `${r.src}:${r.session ? String(r.session).slice(0, 8) : '未知'}`;
    addTo(bySession[sk] || (bySession[sk] = {...blank(), dir: rel, unattributed: 0}), r);
    if (wf === UNATTRIBUTED) bySession[sk].unattributed++;
    const w = r.input * weights.input + r.cache_write * weights.cache_write + r.cache_read * weights.cache_read + r.output * weights.output;
    top.push({t: r.t, src: r.src, model: r.model, workflow: wf, step: kind, run_id: win ? win.run_id : null, input: r.input, cache_write: r.cache_write, cache_read: r.cache_read, output: r.output, weighted: w, side: r.side});
    if (top.length > topN * 4) { top.sort((x, y) => y.weighted - x.weighted); top.length = topN; }
  }
  top.sort((x, y) => y.weighted - x.weighted);
  const rows = [];
  for (const [wf, kinds] of tree) {
    const sum = blank();
    for (const c of kinds.values()) { sum.calls += c.calls; sum.input += c.input; sum.cache_write += c.cache_write; sum.cache_read += c.cache_read; sum.output += c.output; }
    rows.push({workflow: wf, ...sum, weighted: weighted(sum, weights), steps: [...kinds.entries()]
      .sort((a, b) => (STEP_KINDS.indexOf(a[0]) + 100 * (a[0] === '-')) - (STEP_KINDS.indexOf(b[0]) + 100 * (b[0] === '-')))
      .map(([kind, c]) => ({kind, ...c, weighted: weighted(c, weights)}))});
  }
  rows.sort((a, b) => (a.workflow === UNATTRIBUTED) - (b.workflow === UNATTRIBUTED) || b.weighted - a.weighted);
  const wrap = (o) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, {...c, weighted: weighted(c, weights)}]));
  return {total: {...total, weighted: weighted(total, weights)}, by_workflow: rows, by_source: wrap(bySrc), by_model: wrap(byModel), by_cwd_class: wrap(byCwd),
    by_dir_top: Object.entries(wrap(byDir)).sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 15).map(([dir, c]) => ({dir, ...c})),
    by_session_top: Object.entries(wrap(bySession)).sort((a, b) => b[1].weighted - a[1].weighted).slice(0, 10).map(([session, c]) => ({session, ...c})), top_calls: top.slice(0, topN), flags};
}

export async function buildReport({project, specsDirs = [], sinceIso = null, claudeProjects, codexSessions, weights = DEFAULT_WEIGHTS, gapMin = DEFAULT_GAP_MIN}) {
  const sinceMs = sinceIso ? ms(sinceIso) : null;
  if (sinceIso && sinceMs === null) throw new Error(`--since 不是有效的 ISO 时间: ${sinceIso}`);
  let rows = [], logInfo = [];
  for (const d of specsDirs) {
    const lg = readSpecsLog(d);
    logInfo.push({specs: d, rows: lg.rows.length, bad_rows: lg.bad, missing: lg.missing});
    rows = rows.concat(lg.rows);
  }
  const {windows: allWindows, stats: winStats} = buildWindows(rows, {gapMs: gapMin * 60000});
  const windows = sinceMs === null ? allWindows : allWindows.filter((w) => w.end >= sinceMs);
  const claude = await collectClaude(claudeProjects, project, {sinceMs});
  const codex = await collectCodex(codexSessions, project, {sinceMs});
  const records = claude.records.concat(codex.records);
  const times = records.map((r) => r.t).filter((t) => t !== null);
  const s = summarize({records, windows, project, weights});
  return {
    project, since: sinceIso, weights, gap_min: gapMin,
    span: times.length ? {from: iso(Math.min(...times)), to: iso(Math.max(...times))} : null,
    cm_logs: logInfo, windows: {count: windows.length, step_level: windows.filter((w) => w.level === 0).length, ...winStats},
    claude_stats: claude.stats, codex_stats: codex.stats, ...s,
  };
}

// ---------- 输出 ----------
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
const tableRow = (cols) => '| ' + cols.join(' | ') + ' |';

export function renderMarkdown(rep) {
  const L = [];
  const w = rep.weights;
  const hdr = ['调用次数', '输入(未缓存)', '缓存写入', '缓存读取', '输出', '加权合计', '平均上下文/次'];
  const cells = (c) => [fmt(c.calls), fmt(c.input), fmt(c.cache_write), fmt(c.cache_read), fmt(c.output), fmt(c.weighted), fmt((c.input + c.cache_write + c.cache_read) / (c.calls || 1))];
  L.push('# CM token 用量报告（只读）', '');
  L.push(`- 项目：${rep.project}`);
  L.push(`- 用量时间范围：${rep.span ? rep.span.from + ' ~ ' + rep.span.to : '无记录'}${rep.since ? `（--since ${rep.since}）` : ''}`);
  L.push(`- 总调用 ${fmt(rep.total.calls)} 次；输入(未缓存) ${fmt(rep.total.input)}，缓存写入 ${fmt(rep.total.cache_write)}，缓存读取 ${fmt(rep.total.cache_read)}，输出 ${fmt(rep.total.output)}`);
  L.push(`- 占比（按原始 token 数）：缓存读取 ${pct(rep.total.cache_read, rep.total.input + rep.total.cache_write + rep.total.cache_read + rep.total.output)}，缓存写入 ${pct(rep.total.cache_write, rep.total.input + rep.total.cache_write + rep.total.cache_read + rep.total.output)}，未缓存输入 ${pct(rep.total.input, rep.total.input + rep.total.cache_write + rep.total.cache_read + rep.total.output)}，输出 ${pct(rep.total.output, rep.total.input + rep.total.cache_write + rep.total.cache_read + rep.total.output)}`);
  L.push(`- 加权合计的权重（相对未缓存输入 1 的假定比例，不是价格）：输入 ${w.input}，缓存写入 ${w.cache_write}，缓存读取 ${w.cache_read}，输出 ${w.output}。缓存写入不区分 5 分钟/1 小时档位，Codex 与 Claude 用同一组权重，模型之间的单价差异未折算。`);
  L.push('', '## 按工作流 -> 步骤', '');
  L.push(tableRow(['工作流 / 步骤', ...hdr]), tableRow(['---', ...hdr.map(() => '---:')]));
  for (const wf of rep.by_workflow) {
    L.push(tableRow([`**${wf.workflow}**`, ...cells(wf)]));
    if (wf.workflow === UNATTRIBUTED) continue;
    for (const st of wf.steps) L.push(tableRow([`&nbsp;&nbsp;${st.kind}`, ...cells(st)]));
  }
  L.push(tableRow(['**合计**', ...cells(rep.total)]));
  L.push('', '步骤归类：cm-ai 的 N3 developing=develop、N3 checking=check、N4=review、N6 测试=qa；cm-prd 的 需求/设计/拆任务=prd-analysis、设计/规格审查=review、规格校验=check、context_load=other；cm-fix 整段=fix-diagnose；步骤窗口之外但在同一运行的相邻事件之间（间隔不超过 ' + rep.gap_min + ' 分钟）=other。');
  const section = (title, obj) => {
    L.push('', `## ${title}`, '', tableRow(['类别', ...hdr]), tableRow(['---', ...hdr.map(() => '---:')]));
    for (const [k, c] of Object.entries(obj).sort((a, b) => b[1].weighted - a[1].weighted)) L.push(tableRow([k, ...cells(c)]));
  };
  section('按来源', rep.by_source);
  section('按模型', rep.by_model);
  section('按会话工作目录类型', rep.by_cwd_class);
  L.push('', '## 按会话工作目录（相对项目，前 15）', '', tableRow(['目录', ...hdr]), tableRow(['---', ...hdr.map(() => '---:')]));
  for (const d of rep.by_dir_top) L.push(tableRow([d.dir, ...cells(d)]));
  L.push('', '## 最重的 10 个会话（来源:会话 id 前 8 位）', '', tableRow(['会话', '首个工作目录（会话中途可能换目录）', '其中未归属调用', ...hdr]), tableRow(['---', '---', '---:', ...hdr.map(() => '---:')]));
  for (const d of rep.by_session_top) L.push(tableRow([d.session, d.dir, fmt(d.unattributed), ...cells(d)]));
  L.push('', '## 单次最重的 10 次调用（按加权合计）', '');
  L.push(tableRow(['时间(UTC)', '来源', '模型', '工作流/步骤', '子代理', '输入', '缓存写入', '缓存读取', '输出', '加权']), tableRow(['---', '---', '---', '---', '---', '---:', '---:', '---:', '---:', '---:']));
  for (const c of rep.top_calls) L.push(tableRow([c.t === null ? '时间缺失' : iso(c.t), c.src, c.model, c.step === '-' ? c.workflow : `${c.workflow}/${c.step}`, c.side ? '是' : '否', fmt(c.input), fmt(c.cache_write), fmt(c.cache_read), fmt(c.output), fmt(c.weighted)]));
  L.push('', '## 数据质量与不确定项', '');
  const cs = rep.claude_stats, xs = rep.codex_stats;
  L.push(`- Claude 转录：扫描 ${cs.files} 个文件；含用量的行 ${fmt(cs.lines_with_usage)}，按 message.id 去重后 ${fmt(cs.unique)} 条，去掉重复 ${fmt(cs.duplicates_removed)} 行；跳过合成消息 ${cs.synthetic_skipped}、cwd 不在项目内 ${cs.outside_cwd}、cwd 缺失 ${cs.no_cwd}、用量字段不全 ${cs.incomplete}（不估算，直接不计）、时间缺失 ${cs.no_timestamp}${cs.dir_missing ? '；转录目录不存在' : ''}。`);
  L.push(`- Codex 会话：共 ${xs.files} 个文件，实际扫描 ${xs.files_scanned} 个，首行 cwd 匹配项目的 ${xs.sessions_matched} 个；用量事件 ${fmt(xs.token_events)} 个，按累计值去重 ${fmt(xs.duplicates_removed)}，info 为空/字段不全 ${xs.null_info}，匹配但没有任何用量事件的会话 ${xs.matched_without_token_events}${xs.dir_missing ? '；Codex 会话目录不存在' : ''}。只按会话首行 cwd 判断是否属于本项目，先在别处启动、后来才切进项目的会话会漏掉。`);
  for (const l of rep.cm_logs) L.push(`- CM 运行日志 ${l.specs}：${l.missing ? '文件不存在' : `${l.rows} 行可用，${l.bad_rows} 行无法解析/缺时间被忽略`}。`);
  L.push(`- 时间窗口 ${rep.windows.count} 个（步骤级 ${rep.windows.step_level}）；没有结束事件的开始 ${rep.windows.unpaired_start}（窗口只延伸到下一条事件，标为不确定）；没有开始的结束 ${rep.windows.orphan_complete}（忽略）。`);
  L.push(`- 归属方式是按时间窗口，不是按会话：同一时间多个运行并行、或人在别的会话里干活，都会被算进窗口。落在多个不同运行的窗口里的调用 ${fmt(rep.flags.ambiguous_calls)} 次（已按最内层步骤归属，视为不确定）；落在不确定窗口里的 ${fmt(rep.flags.uncertain_window_calls)} 次；时间缺失无法归属 ${fmt(rep.flags.no_timestamp_calls)} 次。`);
  return L.join('\n') + '\n';
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const a = {specs: [], json: false, since: null, project: null, claudeProjects: path.join(os.homedir(), '.claude', 'projects'),
    codexSessions: path.join(os.homedir(), '.codex', 'sessions'), weights: {...DEFAULT_WEIGHTS}, gapMin: DEFAULT_GAP_MIN, help: false};
  const need = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} 缺少参数值`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--project') a.project = need(i++, k);
    else if (k === '--specs') a.specs.push(...need(i++, k).split(',').filter(Boolean));
    else if (k === '--since') a.since = need(i++, k);
    else if (k === '--json') a.json = true;
    else if (k === '--claude-projects') a.claudeProjects = need(i++, k);
    else if (k === '--codex-sessions') a.codexSessions = need(i++, k);
    else if (k === '--gap-min') { a.gapMin = Number(need(i++, k)); if (!(a.gapMin > 0)) throw new Error('--gap-min 必须是正数'); }
    else if (k === '--weights') {
      for (const part of need(i++, k).split(',')) {
        const [name, val] = part.split('=');
        const map = {in: 'input', cw: 'cache_write', cr: 'cache_read', out: 'output'};
        if (!map[name] || !(Number(val) >= 0) || val === '') throw new Error(`--weights 格式应为 in=1,cw=1.25,cr=0.1,out=5，收到 ${part}`);
        a.weights[map[name]] = Number(val);
      }
    } else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`未知参数 ${k}`);
  }
  return a;
}

const USAGE = '用法: node scripts/cm-token-report.mjs --project <项目根目录> --specs <specs 目录>[,<更多 specs 目录>] [--since ISO] [--json] [--weights in=1,cw=1.25,cr=0.1,out=5] [--gap-min 30]\n  只读；--claude-projects / --codex-sessions 可改用量目录（默认 ~/.claude/projects 与 ~/.codex/sessions）。';

export async function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  let a;
  try { a = parseArgs(argv); } catch (e) { io.stderr.write(`错误: ${e.message}\n${USAGE}\n`); return 2; }
  if (a.help) { io.stdout.write(USAGE + '\n'); return 0; }
  if (!a.project || !a.specs.length) { io.stderr.write(`错误: 需要 --project 和 --specs\n${USAGE}\n`); return 2; }
  try {
    const rep = await buildReport({project: path.resolve(a.project), specsDirs: a.specs.map((s) => path.resolve(s)), sinceIso: a.since,
      claudeProjects: a.claudeProjects, codexSessions: a.codexSessions, weights: a.weights, gapMin: a.gapMin});
    io.stdout.write(a.json ? JSON.stringify(rep, null, 2) + '\n' : renderMarkdown(rep));
    return 0;
  } catch (e) { io.stderr.write(`错误: ${e.message}\n`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
