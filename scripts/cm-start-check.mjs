#!/usr/bin/env node
// Read-only start check for a cm-ai single-task drive PLAN. It reports the blocks that
// are already knowable before create: protected scope, check budget, dirty scope files.
// It never writes a file, never starts a host and never runs a check command.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {protectedScopePaths, validateDeveloperScope} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {planCheckTimeout} from '../runtime/js/cm-ai/drive-core.mjs';
import {git as safeGit} from '../runtime/js/cm-security/scan.mjs';

// The whole check step of a current-session run is one host call with this deadline
// (runtime/js/cm-ai/host-conversation-execution.mjs, outerTimeoutMs). The test
// file guards that the literal is still there.
export const CHECK_CALL_LIMIT_MS = 1800000;
const MAX_LISTED = 20;

class InputError extends Error {}

const usage = '用法: cm-start-check.mjs --plan PLAN.json [--json] [--strict]\n'
  + '只读体检，开工前跑一次。只支持普通单任务、当前会话模式的 PLAN；\n'
  + 'PLAN.permissions 含受保护模式、provider 开发或 bootstrap 参数时退出 2，不给出结论。\n'
  + '  1. scope 是否含受保护路径（AGENTS.md、tasks.md、.reviews、.cm-* 等）——error；\n'
  + '     scope 为空、重复、绝对路径、含 ..／反斜杠／冒号等创建必拒的写法——输入不合法，退出 2\n'
  + '  2. PLAN.checks 是否重复、是否重复跑全量测试、各检查超时之和是否超过整步 30 分钟——warn\n'
  + '  3. scope 内文件在代码根是否已有未提交改动——warn（Git 不可用时是 warn，不是 Git 仓库时是 info）\n'
  + '退出码：0 无 error（warn 只提示）；1 有 error，或加 --strict 时有 warn；2 输入读不了或不支持。\n';

// Modes this check does not model: another check budget (provider), another scope rule
// (bootstrap may name protected rule files) or another check source (protected configs).
const UNSUPPORTED_MODE_FLAGS = new Map([
  ['--protected-config', '受保护模式'], ['--protected-conversation-config', '受保护的当前会话模式'],
  ['--allow-provider-development-attempt', 'provider 开发'],
  ['--bootstrap-config', 'bootstrap'], ['--allow-bootstrap-write', 'bootstrap']]);

function readJson(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new InputError(`读不了${label}: ${file}（${error.code ?? error.message}）`); }
  try { return JSON.parse(raw); }
  catch { throw new InputError(`${label}不是合法 JSON: ${file}`); }
}

export function loadStartInputs(planFile) {
  const planPath = path.resolve(planFile), base = path.dirname(planPath);
  const plan = readJson(planPath, 'PLAN');
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) throw new InputError('PLAN 必须是 JSON 对象');
  if (typeof plan.config !== 'string' || plan.config === '') throw new InputError('PLAN 缺少字段 config（已批准的运行定义路径）');
  if (plan.permissions !== undefined && (!Array.isArray(plan.permissions) || !plan.permissions.every(item => typeof item === 'string')))
    throw new InputError('PLAN.permissions 必须是字符串数组');
  for (const item of plan.permissions ?? []) {
    if (UNSUPPORTED_MODE_FLAGS.has(item))
      throw new InputError(`PLAN.permissions 含 ${item}（${UNSUPPORTED_MODE_FLAGS.get(item)}）：本体检只支持普通单任务、当前会话模式，不给出结论；请按 js-host.md 启动前第 8 项手工核对`);
  }
  const definition = readJson(path.resolve(base, plan.config), '运行定义');
  if (definition === null || typeof definition !== 'object' || !Array.isArray(definition.scope)
    || !definition.scope.every(item => typeof item === 'string'))
    throw new InputError('运行定义没有 scope 数组：本体检只支持单任务运行定义，批次请逐个任务检查');
  if (typeof definition.codeProject !== 'string' || !path.isAbsolute(definition.codeProject))
    throw new InputError('运行定义的 codeProject 必须是绝对路径');
  return {plan, definition};
}

function checkProtectedScope(scope) {
  const protectedPaths = protectedScopePaths(scope);
  const rest = scope.filter(item => !protectedPaths.includes(item));
  if (rest.length > 0 || protectedPaths.length === 0) {
    // Shape errors the runtime refuses at create (empty, duplicate, absolute, .., backslash, colon):
    // not a finding, because "passed" would be wrong for an input that cannot start.
    try { validateDeveloperScope(rest); }
    catch { throw new InputError('scope 不合法：为空、有重复项，或含绝对路径、..、反斜杠、冒号等写法；创建运行会被拒绝，先改 scope'); }
  }
  return protectedPaths.map(item => ({level: 'error', code: 'protected_scope', path: item,
    message: `scope 含受保护路径 ${item}：创建运行会被 protected_scope 拒绝。先走人工通道同步该文件，再把它从 scope 里去掉`}));
}

const isXcodebuild = tokens => tokens.some(token => path.basename(token) === 'xcodebuild');
const isTestAction = tokens => tokens.some(token => token === 'test' || token === 'test-without-building');
const optionValue = (tokens, name) => {
  const at = tokens.indexOf(name);
  return at === -1 ? '' : tokens[at + 1] ?? '';
};

function checkChecks(plan) {
  const findings = [];
  if (!Array.isArray(plan.checks)) return findings;
  const items = plan.checks.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item));
  let timeouts;
  try { timeouts = items.map(item => planCheckTimeout(plan, item)); }
  catch (error) { throw new InputError(error.message); }
  // sameExecutionAs entries reuse the previous execution: they neither repeat it nor add time.
  const own = items.map((item, index) => ({item, timeoutMs: timeouts[index]}))
    .filter(entry => !Object.hasOwn(entry.item, 'sameExecutionAs'));
  const byCommand = new Map();
  for (const entry of own) {
    const key = JSON.stringify(entry.item.command ?? null);
    byCommand.set(key, [...(byCommand.get(key) ?? []), entry]);
  }
  for (const group of byCommand.values()) {
    if (group.length < 2) continue;
    findings.push({level: 'warn', code: 'duplicate_check', ids: group.map(entry => entry.item.id),
      message: `检查 ${group.map(entry => entry.item.id).join('、')} 的命令完全相同，会白跑 ${group.length - 1} 遍。去掉重复项，或给后面的加 sameExecutionAs`});
  }
  const overlap = new Map();
  for (const group of byCommand.values()) {
    const tokens = group[0].item.command;
    if (!Array.isArray(tokens) || !tokens.every(token => typeof token === 'string')) continue;
    if (!isXcodebuild(tokens) || !isTestAction(tokens) || tokens.some(token => token.startsWith('-only-testing'))) continue;
    const key = ['-workspace', '-project', '-scheme', '-destination', '-testPlan'].map(name => optionValue(tokens, name)).join('\u0000');
    overlap.set(key, [...(overlap.get(key) ?? []), group[0]]);
  }
  for (const group of overlap.values()) {
    if (group.length < 2) continue;
    findings.push({level: 'warn', code: 'overlapping_full_test', ids: group.map(entry => entry.item.id),
      message: `检查 ${group.map(entry => entry.item.id).join('、')} 都是同一 scheme／目的地、没有 -only-testing 的 xcodebuild test，很可能各自跑了一遍全量。保留一个，或用 -only-testing 分开`});
  }
  const totalMs = own.reduce((sum, entry) => sum + entry.timeoutMs, 0);
  if (totalMs > CHECK_CALL_LIMIT_MS)
    findings.push({level: 'warn', code: 'check_budget_over_call_limit', totalMs, limitMs: CHECK_CALL_LIMIT_MS,
      message: `各检查超时之和 ${Math.round(totalMs / 60000)} 分钟，超过检查整步的 ${CHECK_CALL_LIMIT_MS / 60000} 分钟期限；这是最坏情况，实际可能更短。拆成多次运行，或缩减检查`});
  return findings;
}

function checkDirtyScope(definition) {
  if (!fs.existsSync(definition.codeProject)) return [{level: 'warn', code: 'code_project_missing',
    message: `代码根不存在：${definition.codeProject}，没能核对 scope 是否干净`}];
  // The reader keeps a PATH git that lives inside the project out of reach by comparing real
  // paths, so hand it the real path of the root (a symlinked temp dir otherwise defeats that).
  const root = fs.realpathSync(definition.codeProject);
  // safeGit is the scanner's reader: trusted git binary, no repository-configured fsmonitor or
  // clean/process/required filters, no user config. A failure to run it is a warn, never a pass.
  let inside;
  try { inside = safeGit(root, ['rev-parse', '--is-inside-work-tree'], true); }
  catch (error) {
    return [{level: 'warn', code: 'git_unavailable',
      message: `Git 不可用或被拒绝（${error.message}），没能核对 scope 是否干净`}];
  }
  if (inside === null || inside.toString('utf8').trim() !== 'true')
    return [{level: 'info', code: 'not_git', message: '代码根不是 Git 仓库（或 Git 拒绝读取，如目录属主不同），已跳过 scope 未提交改动核对'}];
  let output;
  try { output = safeGit(root, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...definition.scope]); }
  catch (error) {
    return [{level: 'warn', code: 'git_status_failed', message: `git status 失败（${error.message}），没能核对 scope 是否干净`}];
  }
  const dirty = [];
  const entries = output.toString('utf8').split('\0');
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    dirty.push({status: entry.slice(0, 2).trim() || '?', path: entry.slice(3)});
    if (/[RC]/.test(entry.slice(0, 2))) i += 1;
  }
  if (dirty.length === 0) return [];
  const shown = dirty.slice(0, MAX_LISTED).map(item => `${item.status} ${item.path}`);
  return [{level: 'warn', code: 'scope_dirty', count: dirty.length, paths: dirty.slice(0, MAX_LISTED).map(item => item.path),
    message: `scope 内 ${dirty.length} 个文件已有未提交改动（含新建）：${shown.join('；')}${dirty.length > MAX_LISTED ? '…' : ''}。`
      + '运行基线会把它们当起点，交审包里看不到这部分改动；若是上次的任务代码，先还原，确认是有意保留的再继续'}];
}

export function startCheck(planFile) {
  const {plan, definition} = loadStartInputs(planFile);
  return [...checkProtectedScope(definition.scope), ...checkChecks(plan), ...checkDirtyScope(definition)];
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const rest = argv.filter(arg => arg !== '--json' && arg !== '--strict');
  const at = rest.indexOf('--plan');
  if (argv.includes('--help') || argv.includes('-h')) { out.write(usage); return 0; }
  if (at === -1 || !rest[at + 1] || rest.length !== 2) { err.write(usage); return 2; }
  let findings;
  try { findings = startCheck(rest[at + 1]); }
  catch (error) {
    if (!(error instanceof InputError)) throw error;
    err.write(`${error.message}\n`);
    return 2;
  }
  const errors = findings.filter(item => item.level === 'error').length;
  const warns = findings.filter(item => item.level === 'warn').length;
  const skipped = findings.filter(item => item.level === 'info').length;
  if (argv.includes('--json')) out.write(`${JSON.stringify({errors, warns, skipped, findings})}\n`);
  else {
    for (const item of findings) out.write(`[${item.level}] ${item.code}: ${item.message}\n`);
    const note = skipped > 0 ? `（有 ${skipped} 项核对被跳过，见上）` : '';
    out.write(errors + warns === 0 ? `体检通过：没有发现可提前识别的阻塞${note}\n` : `体检结果：${errors} 个 error，${warns} 个 warn${note}\n`);
  }
  return errors > 0 || (argv.includes('--strict') && warns > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
