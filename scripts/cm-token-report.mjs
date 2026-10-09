#!/usr/bin/env node
// 只读 token 用量报告：把 Claude Code / Codex CLI 会话里的 token 记录，按 CM 运行日志的时间窗口归到 工作流 -> 步骤。
// 隐私：只读取 时间戳/模型/用量数字/cwd/会话 id/是否子代理 这些元数据字段，不读取、不输出、不保存任何消息正文、工具入参或工具结果。
// 只读：不写任何文件（除非调用方自己把标准输出重定向）。不估算缺失的数字。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const UNATTRIBUTED = '未归属（会话闲聊/人工操作）';
export const STEP_KINDS = ['develop', 'review', 'qa', 'check', 'prd-analysis', 'fix-diagnose', 'other'];
export const DEFAULT_WEIGHTS = {input: 1, cache_write: 1.25, cache_read: 0.1, output: 5};
const DEFAULT_GAP_MIN = 30;

const MAX_LINE = 64 * 1024 * 1024; // 会话转录/Codex 单行上限；超过的行跳过并计数
const MAX_LOG_LINE = 1024 * 1024; // CM 运行日志单行上限
const OVERLONG = Symbol('overlong');

// 只接受非负安全整数；其余（字符串、小数、负数、数组、对象）一律视为缺失
const cnt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const ms = (s) => {
  if (typeof s !== 'string' || s.length > 64) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
// 只允许出现在报告里的字符串标量：必须是短字符串且符合标识符样式，否则当作缺失
const safeStr = (v, re, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && re.test(v) ? v : null);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const safeModel = (v) => safeStr(v, MODEL_RE, 100);
const safeId = (v, max = 128) => safeStr(v, ID_RE, max);
const safeCwd = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v) ? v : null);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const encodeDir = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const within = (cwd, root) => typeof cwd === 'string' && (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/'));
const insideReal = (real, rootReal) => real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);

// 解析一行：根必须是对象，否则返回 null（调用方计入坏行）
function parseObj(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  return isObj(o) ? o : null;
}

// 自己切行：单行超过 maxLine 时丢弃该行并产出 OVERLONG，不会把超长行读进内存；结束或提前退出都销毁底层流
export async function* lines(file, maxLine = MAX_LINE) {
  const stream = fs.createReadStream(file);
  try {
    let parts = [], size = 0, over = false;
    for await (const chunk of stream) {
      let pos = 0;
      while (pos < chunk.length) {
        const nl = chunk.indexOf(10, pos);
        const end = nl === -1 ? chunk.length : nl;
        if (!over) {
          size += end - pos;
          if (size > maxLine) { over = true; parts = []; } else parts.push(chunk.subarray(pos, end));
        }
        if (nl === -1) break;
        if (over) yield OVERLONG;
        else if (size > 0) yield Buffer.concat(parts).toString('utf8');
        parts = []; size = 0; over = false;
        pos = nl + 1;
      }
    }
    if (over) yield OVERLONG;
    else if (size > 0) yield Buffer.concat(parts).toString('utf8');
  } finally {
    stream.destroy();
  }
}

// 列出 root 下的 .jsonl：不跟随目录符号链接；文件符号链接只有解析后仍在 root 内且是普通文件才用；其余跳过并计数
function walkJsonl(root) {
  const out = [], skipped = {unsafe_links: 0};
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { return {files: out, skipped, rootMissing: true}; }
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (!e.name.endsWith('.jsonl')) { skipped.unsafe_links++; continue; }
        const f = safeRegularFile(p, rootReal);
        if (f) out.push(f); else skipped.unsafe_links++;
      } else if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return {files: out, skipped, rootMissing: false};
}

// 解析真实路径并要求落在 rootReal 内、且是普通文件；不满足返回 null
function safeRegularFile(file, rootReal) {
  try {
    const real = fs.realpathSync(file);
    if (!insideReal(real, rootReal)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
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

export async function readSpecsLog(specsDir) {
  const file = path.join(specsDir, '运行日志.jsonl');
  const rows = [];
  const info = {rows, bad: 0, overlong: 0, missing: false, unsafe: false, file};
  let specsReal;
  try { specsReal = fs.realpathSync(specsDir); } catch { info.missing = true; return info; }
  if (!fs.existsSync(file)) { info.missing = true; return info; }
  const real = safeRegularFile(file, specsReal); // 符号链接指到 specs 目录之外、或不是普通文件，都不读
  if (!real) { info.unsafe = true; return info; }
  const specs = path.basename(specsDir);
  for await (const l of lines(real, MAX_LOG_LINE)) {
    if (l === OVERLONG) { info.overlong++; continue; }
    if (!l.trim()) continue;
    const o = parseObj(l);
    const t = o ? ms(o.at) : null;
    const run_id = o ? safeId(o.run_id) : null;
    if (t === null || !run_id) { info.bad++; continue; }
    // 只取白名单标量字段，且都必须符合标识符样式
    rows.push({t, run_id, specs, workflow: safeId(o.workflow, 64) || '未知', event: safeId(o.event, 64) || '', phase: safeId(o.phase, 64) || '',
      node: safeId(o.node, 64) || '', phase_name: safeId(o.phase_name, 64) || '', operation_id: safeId(o.operation_id, 200) || ''});
  }
  rows.sort((a, b) => a.t - b.t);
  return info;
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
// 用量四项里 input/cache_read/output 缺失或不是非负整数 -> 整条记为 incomplete_usage 并排除；cache_write 缺失 -> 记为未知（null），不补 0
const usageTotal = (r) => r.input + (r.cache_write ?? 0) + r.cache_read + r.output;

export async function collectClaude(projectsDir, project, {sinceMs = null} = {}) {
  const enc = encodeDir(project);
  const stats = {files: 0, lines_with_usage: 0, unique: 0, duplicates_removed: 0, synthetic_skipped: 0, incomplete_usage: 0, cache_write_unknown: 0,
    outside_cwd: 0, no_cwd: 0, no_timestamp: 0, bad_lines: 0, overlong_lines: 0, unsafe_links_skipped: 0, read_errors: 0, dir_missing: false};
  const byId = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, {withFileTypes: true}).filter((d) => d.isDirectory() && d.name.includes(enc)); } catch { stats.dir_missing = true; }
  for (const d of dirs) {
    const w = walkJsonl(path.join(projectsDir, d.name));
    stats.unsafe_links_skipped += w.skipped.unsafe_links;
    for (const file of w.files) {
      stats.files++;
      let lastCwd = null;
      try {
        for await (const l of lines(file)) {
          if (l === OVERLONG) { stats.overlong_lines++; continue; }
          if (!l.includes('"usage"')) continue;
          const o = parseObj(l);
          if (!o) { stats.bad_lines++; continue; }
          const m = o.message;
          if (o.type !== 'assistant' || !isObj(m) || !isObj(m.usage)) continue;
          stats.lines_with_usage++;
          const u = m.usage;
          if (m.model === '<synthetic>') { stats.synthetic_skipped++; continue; }
          const c = safeCwd(o.cwd);
          const cwd = c ? (lastCwd = c) : lastCwd;
          if (!cwd) { stats.no_cwd++; continue; }
          if (!within(cwd, project)) { stats.outside_cwd++; continue; }
          const t = ms(o.timestamp);
          const input = cnt(u.input_tokens), cw = cnt(u.cache_creation_input_tokens), cr = cnt(u.cache_read_input_tokens), out = cnt(u.output_tokens);
          if (input === null || cr === null || out === null) { stats.incomplete_usage++; continue; }
          const rec = {src: 'claude', t, model: safeModel(m.model) || '未知', cwd, session: safeId(o.sessionId), side: o.isSidechain === true, input, cache_write: cw, cache_read: cr, output: out};
          const id = safeId(m.id, 200) || safeId(o.requestId, 200) || safeId(o.uuid, 200);
          if (!id) { byId.set(Symbol('noid'), rec); continue; }
          const old = byId.get(id);
          if (!old) byId.set(id, rec);
          else {
            stats.duplicates_removed++;
            // 保留更大的用量；相同则保留更早的时间戳
            if (usageTotal(rec) > usageTotal(old) || (usageTotal(rec) === usageTotal(old) && rec.t !== null && (old.t === null || rec.t < old.t))) byId.set(id, rec);
          }
        }
      } catch { stats.read_errors++; }
    }
  }
  const recs = [...byId.values()];
  for (const r of recs) { if (r.t === null) stats.no_timestamp++; if (r.cache_write === null) stats.cache_write_unknown++; }
  stats.unique = recs.length;
  return {records: recs.filter((r) => sinceMs === null || r.t === null || r.t >= sinceMs), stats};
}

export async function collectCodex(sessionsDir, project, {sinceMs = null} = {}) {
  const stats = {files: 0, files_scanned: 0, sessions_matched: 0, token_events: 0, duplicates_removed: 0, null_info: 0, incomplete_usage: 0, cache_write_unknown: 0,
    no_timestamp: 0, bad_lines: 0, overlong_lines: 0, unsafe_links_skipped: 0, read_errors: 0, dir_missing: false, matched_without_token_events: 0};
  const records = [];
  const w = walkJsonl(sessionsDir);
  if (w.rootMissing) { stats.dir_missing = true; return {records, stats}; }
  stats.unsafe_links_skipped = w.skipped.unsafe_links;
  stats.files = w.files.length;
  for (const file of w.files) {
    // --since 只按事件时间戳过滤：文件修改时间不能保证晚于其中的事件。
    stats.files_scanned++;
    let first = true, cwd = null, model = '未知', sessionId = null, matched = false, maxTotal = -1, events = 0;
    try {
      for await (const l of lines(file)) {
        if (l === OVERLONG) { if (first) break; stats.overlong_lines++; continue; }
        if (first) {
          first = false;
          const o = parseObj(l);
          const p = o && isObj(o.payload) ? o.payload : null;
          const metaCwd = p ? safeCwd(p.cwd) : null;
          if (!p) { stats.bad_lines++; break; }
          sessionId = safeId(p.id) || safeId(p.session_id);
          if (!within(metaCwd, project)) break;
          cwd = metaCwd; matched = true; stats.sessions_matched++;
          continue;
        }
        if (l.includes('"turn_context"')) {
          const o = parseObj(l);
          if (!o) { stats.bad_lines++; continue; }
          if (o.type === 'turn_context' && isObj(o.payload)) {
            model = safeModel(o.payload.model) || model;
            cwd = safeCwd(o.payload.cwd) || cwd;
          }
          continue;
        }
        if (!l.includes('"token_count"')) continue;
        const o = parseObj(l);
        if (!o) { stats.bad_lines++; continue; }
        const p = o.payload;
        if (o.type !== 'event_msg' || !isObj(p) || p.type !== 'token_count') continue;
        stats.token_events++; events++;
        const info = p.info;
        if (!isObj(info) || !isObj(info.last_token_usage) || !isObj(info.total_token_usage)) { stats.null_info++; continue; }
        const tot = cnt(info.total_token_usage.total_tokens);
        if (tot !== null) {
          if (tot <= maxTotal) { stats.duplicates_removed++; continue; }
          maxTotal = tot;
        }
        const u = info.last_token_usage;
        const inp = cnt(u.input_tokens), cached = cnt(u.cached_input_tokens), out = cnt(u.output_tokens), cw = cnt(u.cache_write_input_tokens);
        // 缺少缓存命中字段就无法把输入拆成「未缓存/缓存读」，不能当 0：整条排除并计数
        if (inp === null || cached === null || out === null || cached > inp) { stats.incomplete_usage++; continue; }
        if (!within(cwd, project)) continue;
        const t = ms(o.timestamp);
        if (t === null) stats.no_timestamp++;
        if (cw === null) stats.cache_write_unknown++;
        // Codex 的 input_tokens 含缓存命中部分，这里拆成 未缓存输入 + 缓存读；output 已含推理 token，不再另加
        records.push({src: 'codex', t, model, cwd, session: sessionId, side: false, input: inp - cached, cache_write: cw, cache_read: cached, output: out});
      }
    } catch { stats.read_errors++; }
    if (matched && events === 0) stats.matched_without_token_events++;
  }
  return {records: records.filter((r) => sinceMs === null || r.t === null || r.t >= sinceMs), stats};
}

// ---------- 汇总 ----------
const blank = () => ({calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0});
const addTo = (a, r) => { a.calls++; a.input += r.input; a.cache_write += r.cache_write ?? 0; a.cache_read += r.cache_read; a.output += r.output; };
export const weighted = (a, w) => a.input * w.input + a.cache_write * w.cache_write + a.cache_read * w.cache_read + a.output * w.output;
const cwdClass = (cwd, project) => (cwd === project ? '项目根目录' : /[\/\\]\.work[\/\\]/.test(cwd) ? '.work 工作树（CM 派出的会话）' : '项目子目录');

export function summarize({records, windows, project, weights = DEFAULT_WEIGHTS, topN = 10}) {
  const tree = new Map(); // workflow -> kind -> sums
  // 无原型字典：目录名或模型名是 constructor 之类时不会命中继承属性。
  const dict = () => Object.create(null);
  const total = blank(), bySrc = dict(), byModel = dict(), byCwd = dict(), byDir = dict(), bySession = dict();
  const top = [];
  const flags = {ambiguous_calls: 0, no_timestamp_calls: 0, uncertain_window_calls: 0, cache_write_unknown_calls: 0};
  const sorted = windows.slice().sort((a, b) => a.start - b.start);
  for (const r of records) {
    let wf = UNATTRIBUTED, kind = '-', win = null;
    if (r.t === null) flags.no_timestamp_calls++;
    else {
      const a = attribute(r.t, sorted);
      if (a.window) { win = a.window; wf = win.workflow; kind = win.kind; if (a.ambiguous) flags.ambiguous_calls++; if (win.uncertain) flags.uncertain_window_calls++; }
    }
    if (r.cache_write === null) flags.cache_write_unknown_calls++;
    const cell = ((tree.get(wf) || tree.set(wf, new Map()).get(wf)).get(kind) || (tree.get(wf).set(kind, blank()), tree.get(wf).get(kind)));
    addTo(cell, r); addTo(total, r);
    addTo(bySrc[r.src] || (bySrc[r.src] = blank()), r);
    addTo(byModel[r.model] || (byModel[r.model] = blank()), r);
    addTo(byCwd[cwdClass(r.cwd, project)] || (byCwd[cwdClass(r.cwd, project)] = blank()), r);
    const rel = r.cwd === project ? '.' : r.cwd.slice(project.length + 1);
    addTo(byDir[rel] || (byDir[rel] = blank()), r);
    // 按完整会话 ID 分组，只在展示时截断。
    const sk = `${r.src}:${r.session ? String(r.session) : '未知'}`;
    addTo(bySession[sk] || (bySession[sk] = {...blank(), dir: rel, unattributed: 0}), r);
    if (wf === UNATTRIBUTED) bySession[sk].unattributed++;
    const w = r.input * weights.input + (r.cache_write ?? 0) * weights.cache_write + r.cache_read * weights.cache_read + r.output * weights.output;
    top.push({t: r.t, src: r.src, model: r.model, workflow: wf, step: kind, run_id: win ? win.run_id : null, input: r.input, cache_write: r.cache_write ?? 0, cache_write_unknown: r.cache_write === null, cache_read: r.cache_read, output: r.output, weighted: w, side: r.side});
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
    const lg = await readSpecsLog(d);
    logInfo.push({specs: d, rows: lg.rows.length, bad_rows: lg.bad, overlong_lines: lg.overlong, missing: lg.missing, unsafe: lg.unsafe});
    rows = rows.concat(lg.rows);
  }
  const {windows: allWindows, stats: winStats} = buildWindows(rows, {gapMs: gapMin * 60000});
  const windows = sinceMs === null ? allWindows : allWindows.filter((w) => w.end >= sinceMs);
  const claude = await collectClaude(claudeProjects, project, {sinceMs});
  const codex = await collectCodex(codexSessions, project, {sinceMs});
  const records = claude.records.concat(codex.records);
  let tMin = null, tMax = null;
  for (const r of records) if (r.t !== null) { if (tMin === null || r.t < tMin) tMin = r.t; if (tMax === null || r.t > tMax) tMax = r.t; }
  const s = summarize({records, windows, project, weights});
  return {
    project, since: sinceIso, weights, gap_min: gapMin,
    span: tMin !== null ? {from: iso(tMin), to: iso(tMax)} : null,
    cm_logs: logInfo, windows: {count: windows.length, step_level: windows.filter((w) => w.level === 0).length, ...winStats},
    claude_stats: claude.stats, codex_stats: codex.stats, ...s,
  };
}

// ---------- 输出 ----------
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
const tableRow = (cols) => '| ' + cols.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |';

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
  // 展示时才截断会话 ID：来源前缀 + ID 前 8 位。
  const shortSession = (k) => { const i = k.indexOf(':'); return i < 0 ? k.slice(0, 16) : `${k.slice(0, i)}:${k.slice(i + 1, i + 9)}`; };
  for (const d of rep.by_session_top) L.push(tableRow([shortSession(d.session), d.dir, fmt(d.unattributed), ...cells(d)]));
  L.push('', '## 单次最重的 10 次调用（按加权合计）', '');
  L.push(tableRow(['时间(UTC)', '来源', '模型', '工作流/步骤', '子代理', '输入', '缓存写入', '缓存读取', '输出', '加权']), tableRow(['---', '---', '---', '---', '---', '---:', '---:', '---:', '---:', '---:']));
  for (const c of rep.top_calls) L.push(tableRow([c.t === null ? '时间缺失' : iso(c.t), c.src, c.model, c.step === '-' ? c.workflow : `${c.workflow}/${c.step}`, c.side ? '是' : '否', fmt(c.input), fmt(c.cache_write), fmt(c.cache_read), fmt(c.output), fmt(c.weighted)]));
  L.push('', '## 数据质量与不确定项', '');
  const cs = rep.claude_stats, xs = rep.codex_stats;
  L.push(`- Claude 转录：扫描 ${cs.files} 个文件；含用量的行 ${fmt(cs.lines_with_usage)}，按 message.id 去重后 ${fmt(cs.unique)} 条，去掉重复 ${fmt(cs.duplicates_removed)} 行；跳过合成消息 ${cs.synthetic_skipped}、cwd 不在项目内 ${cs.outside_cwd}、cwd 缺失 ${cs.no_cwd}、用量字段缺失或不合法 ${cs.incomplete_usage}（整条排除，不估算）、时间缺失 ${cs.no_timestamp}${cs.dir_missing ? '；转录目录不存在' : ''}。`);
  L.push(`- Claude 转录读取问题：无法解析的行 ${cs.bad_lines}、超长被跳过的行 ${cs.overlong_lines}、指向根目录之外或非普通文件而被跳过的符号链接 ${cs.unsafe_links_skipped}、读文件出错 ${cs.read_errors}；缓存写入字段缺失 ${cs.cache_write_unknown} 条（未知，未计入缓存写入，不是 0）。`);
  L.push(`- Codex 会话：共 ${xs.files} 个文件，实际扫描 ${xs.files_scanned} 个，首行 cwd 匹配项目的 ${xs.sessions_matched} 个；用量事件 ${fmt(xs.token_events)} 个，按累计值去重 ${fmt(xs.duplicates_removed)}，info 为空 ${xs.null_info}，缓存命中等字段缺失或不合法 ${xs.incomplete_usage}（整条排除，不当 0），匹配但没有任何用量事件的会话 ${xs.matched_without_token_events}${xs.dir_missing ? '；Codex 会话目录不存在' : ''}。只按会话首行 cwd 判断是否属于本项目，先在别处启动、后来才切进项目的会话会漏掉。`);
  L.push(`- Codex 读取问题：无法解析的行 ${xs.bad_lines}、超长被跳过的行 ${xs.overlong_lines}、被跳过的不安全符号链接 ${xs.unsafe_links_skipped}、读文件出错 ${xs.read_errors}；缓存写入字段缺失 ${xs.cache_write_unknown} 条（未知，未计入）。`);
  for (const l of rep.cm_logs) L.push(`- CM 运行日志 ${l.specs}：${l.unsafe ? '符号链接指到 specs 目录之外或不是普通文件，未读取' : l.missing ? '文件不存在' : `${l.rows} 行可用，${l.bad_rows} 行无法解析/不是对象/缺时间被忽略，${l.overlong_lines} 行超长被跳过`}。`);
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
