#!/usr/bin/env node
// Read-only start check for a cm-ai single-task drive PLAN. It reports the blocks that
// are already knowable before create: protected scope, check budget, affected old UI tests
// left out of the checks, dirty scope files.
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
// validateRunDefinition (scripts/cm-ai-run.mjs) refuses more than this many scope paths.
// The test file guards that the literal is still there.
export const MAX_SCOPE_PATHS = 256;

class InputError extends Error {}

const usage = '用法: cm-start-check.mjs --plan PLAN.json [--json] [--strict]\n'
  + '只读体检，开工前跑一次。只支持普通单任务、当前会话模式的 PLAN；\n'
  + 'PLAN.permissions 含受保护模式、provider 开发或 bootstrap 参数时退出 2，不给出结论。\n'
  + '  1. scope 是否含受保护路径（AGENTS.md、tasks.md、.reviews、.cm-* 等）——error；\n'
  + '     scope 为空、重复、绝对路径、含 ..／反斜杠／冒号等创建必拒的写法——输入不合法，退出 2\n'
  + '  2. PLAN.checks 是否重复、是否重复跑全量测试、各检查超时之和是否超过整步 30 分钟——warn\n'
  + '     scope 改到代码根 TESTING.md「## 牵连测试」表里的路径，却没跑表里对应的旧界面测试——warn；\n'
  + '     只跑了部分界面测试（-only-testing）而项目没有这张表——info（没能核对）\n'
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
  if (scope.length > MAX_SCOPE_PATHS)
    throw new InputError(`scope 有 ${scope.length} 条路径，超过创建运行允许的 ${MAX_SCOPE_PATHS} 条；创建会被拒绝，先拆任务或收窄 scope`);
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
      message: `各检查超时之和 ${Math.round(totalMs / 60000)} 分钟，超过检查整步的 ${CHECK_CALL_LIMIT_MS / 60000} 分钟期限；这是最坏情况，实际可能更短。`
        + '按分层缩减（单元测试全跑，界面测试只跑本任务新写的和牵连的，其余留到功能末尾回归任务），或拆成多次运行'});
  return findings;
}

// The project's own record of which old UI tests a change reaches: a "## 牵连测试" table in
// TESTING.md (code root first, then docs/). After the header row, each row is
// | changed paths (a trailing / is a directory) | test identifiers as the check command names them |.
const AFFECTED_HEADING = /^##\s+牵连测试\s*$/;
const TESTING_FILES = ['TESTING.md', path.join('docs', 'TESTING.md')];
const cellItems = cell => {
  const quoted = [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim()).filter(Boolean);
  return quoted.length > 0 ? quoted : cell.split(/[、,，\s]+/).filter(Boolean);
};

export function readAffectedMap(root) {
  for (const name of TESTING_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(line => AFFECTED_HEADING.test(line.trim()));
    if (start === -1) continue;
    const rows = [];
    let header = true;
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,2}\s/.test(line)) break;
      const cells = line.trim().match(/^\|(.*)\|$/)?.[1].split('|').map(cell => cell.trim());
      if (!cells || cells.length < 2) continue;
      if (cells.every(cell => /^:?-+:?$/.test(cell))) { header = false; continue; }
      if (header) continue;
      const paths = cellItems(cells[0]).map(item => item.replace(/^\.\//, '')), tests = cellItems(cells[1]);
      if (paths.length > 0 && tests.length > 0) rows.push({paths, tests});
    }
    return {file: name, rows};
  }
  return null;
}

const ONLY = '-only-testing:', SKIP = '-skip-testing:';
const within = (id, target) => id === target || id.startsWith(`${target}/`);
// Whether one check command runs test `id`: an -only-testing naming it or an ancestor, an
// unnarrowed xcodebuild test, or (wrapper scripts, other runners) an argument containing it.
// An -skip-testing naming it or an ancestor wins over all of them.
function runsTest(tokens, id) {
  if (tokens.some(token => token.startsWith(SKIP) && within(id, token.slice(SKIP.length)))) return false;
  if (isXcodebuild(tokens) && isTestAction(tokens) && !tokens.some(token => token.startsWith('-only-testing'))) return true;
  return tokens.some(token => token.startsWith(ONLY) ? within(id, token.slice(ONLY.length))
    : !token.startsWith('-skip-testing') && token.includes(id));
}

function checkAffectedTests(plan, definition) {
  const commands = (Array.isArray(plan.checks) ? plan.checks : [])
    .map(item => item?.command).filter(tokens => Array.isArray(tokens) && tokens.every(token => typeof token === 'string'));
  const map = fs.existsSync(definition.codeProject) ? readAffectedMap(definition.codeProject) : null;
  if (map === null) {
    if (!commands.some(tokens => tokens.some(token => token.startsWith('-only-testing')))) return [];
    return [{level: 'info', code: 'affected_map_missing',
      message: '只跑了部分界面测试（-only-testing），但代码根 TESTING.md／docs/TESTING.md 没有「## 牵连测试」表，'
        + '没能核对本任务改动牵连的旧界面测试是否都跑了'}];
  }
  const touches = (scopePath, rowPath) => rowPath.endsWith('/') ? scopePath.startsWith(rowPath) : scopePath === rowPath;
  const missing = new Map();
  for (const row of map.rows) {
    const hit = definition.scope.filter(scopePath => row.paths.some(rowPath => touches(scopePath, rowPath)));
    if (hit.length === 0) continue;
    for (const id of row.tests) {
      if (commands.some(tokens => runsTest(tokens, id))) continue;
      missing.set(id, [...new Set([...(missing.get(id) ?? []), ...hit])]);
    }
  }
  if (missing.size === 0) return [];
  const tests = [...missing.keys()], paths = [...new Set([...missing.values()].flat())];
  return [{level: 'warn', code: 'affected_tests_not_run', file: map.file, tests: tests.slice(0, MAX_LISTED), paths: paths.slice(0, MAX_LISTED),
    message: `scope 改到 ${paths.slice(0, MAX_LISTED).join('、')}${paths.length > MAX_LISTED ? '…' : ''}，按 ${map.file} 的牵连测试表，`
      + `要在本任务当场跑 ${tests.slice(0, MAX_LISTED).join('、')}${tests.length > MAX_LISTED ? '…' : ''}，PLAN.checks 里没有跑它们的检查。`
      + '改了共用模块不能只跑新测试、留到功能末尾回归；补上这些测试，确实不牵连就改 TESTING.md 的表'}];
}

function hasGitMarker(root) {
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
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
  if (inside === null || inside.toString('utf8').trim() !== 'true') {
    // The reader folds every non-zero exit into null. A repository marker that exists while git
    // refuses it (damaged repo, unsafe owner) is a failed check, not a project without git.
    if (hasGitMarker(root)) return [{level: 'warn', code: 'git_refused',
      message: '代码根或其上级有 .git，但 Git 拒绝读取（仓库损坏或目录属主不同等），没能核对 scope 是否干净'}];
    return [{level: 'info', code: 'not_git', message: '代码根不是 Git 仓库，已跳过 scope 未提交改动核对'}];
  }
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
  return [...checkProtectedScope(definition.scope), ...checkChecks(plan), ...checkAffectedTests(plan, definition), ...checkDirtyScope(definition)];
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
    const note = skipped > 0 ? `（另有 ${skipped} 项核对被跳过，见上）` : '';
    if (errors + warns > 0) out.write(`体检结果：${errors} 个 error，${warns} 个 warn${note}\n`);
    else if (skipped > 0) out.write(`体检完成：已核对的项目没有发现阻塞，但有 ${skipped} 项核对被跳过，见上\n`);
    else out.write('体检通过：没有发现可提前识别的阻塞\n');
  }
  return errors > 0 || (argv.includes('--strict') && warns > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
