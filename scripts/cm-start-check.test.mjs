import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {CHECK_CALL_LIMIT_MS} from './cm-start-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'cm-start-check.mjs');
const gitEnv = {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'};

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {cwd, env: gitEnv, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

// A code root (optionally a git repo with every file committed) plus a plan directory beside it.
function project(t, {scope = ['src/a.js'], files = {'src/a.js': 'a\n', 'src/b.js': 'b\n'}, repo = true, checks, plan = {}} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-start-check-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'code');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true});
    fs.writeFileSync(path.join(root, name), text);
  }
  fs.mkdirSync(root, {recursive: true});
  if (repo) { git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base'); }
  const planDir = path.join(dir, 'plan');
  fs.mkdirSync(planDir);
  fs.writeFileSync(path.join(planDir, 'run.json'), JSON.stringify({version: 1, codeProject: root, scope}));
  const planFile = path.join(planDir, 'PLAN.json');
  fs.writeFileSync(planFile, JSON.stringify({config: 'run.json', checks, ...plan}));
  return {dir, root, planDir, planFile};
}

const run = (...args) => {
  const result = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8'});
  return {status: result.status, out: result.stdout, err: result.stderr};
};
const check = (p, ...extra) => {
  const result = run('--plan', p.planFile, '--json', ...extra);
  return {...result, report: result.out ? JSON.parse(result.out) : null};
};
const checkWithEnv = (p, env) => {
  const result = spawnSync(process.execPath, [script, '--plan', p.planFile, '--json'], {encoding: 'utf8', env});
  return {status: result.status, out: result.stdout, err: result.stderr, report: result.stdout ? JSON.parse(result.stdout) : null};
};
const codes = report => report.findings.map(item => item.code);
const cmd = (id, command, timeoutMs) => ({id, command, ...(timeoutMs === undefined ? {} : {timeoutMs})});
const xcode = (id, ...extra) => cmd(id, ['xcodebuild', 'test', '-scheme', 'App', '-destination', 'id=U1', ...extra]);

function snapshot(dir) {
  const rows = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { rows.push(`d ${path.relative(dir, full)}`); walk(full); continue; }
      const stat = fs.statSync(full);
      rows.push(`f ${path.relative(dir, full)} ${stat.mtimeMs} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return rows.join('\n');
}

test('a clean scope with distinct checks passes with no finding', t => {
  const p = project(t, {checks: [cmd('unit', ['node', '--test']), cmd('lint', ['node', '--check', 'src/a.js'])]});
  const r = check(p);
  assert.equal(r.status, 0);
  assert.deepEqual(r.report, {errors: 0, warns: 0, skipped: 0, findings: []});
  const text = run('--plan', p.planFile);
  assert.equal(text.status, 0);
  assert.match(text.out, /体检通过/);
});

test('protected scope paths are errors and exit 1 (the create refusal known in advance)', t => {
  const p = project(t, {scope: ['AGENTS.md', 'src/a.js', 'docs/.cm-run.json', '.reviews/x.md', 'specs/tasks.md']});
  const r = check(p);
  assert.equal(r.status, 1);
  const errors = r.report.findings.filter(item => item.code === 'protected_scope').map(item => item.path).sort();
  assert.deepEqual(errors, ['.reviews/x.md', 'AGENTS.md', 'docs/.cm-run.json', 'specs/tasks.md']);
  assert.equal(r.report.findings.every(item => item.level === 'error' && /[一-鿿]/.test(item.message)), true);
});

test('identical checks warn; sameExecutionAs aliases are neither duplicates nor extra time', t => {
  const dup = project(t, {plan: {checkTimeoutMs: 300000}, checks: [cmd('a', ['npm', 'test']), cmd('b', ['npm', 'test']), cmd('c', ['npm', 'run', 'lint'])]});
  const r = check(dup);
  assert.equal(r.status, 0);
  assert.deepEqual(r.report.findings.map(item => [item.code, item.ids]), [['duplicate_check', ['a', 'b']]]);
  const alias = project(t, {checks: [cmd('a', ['npm', 'test'], 900000), {...cmd('b', ['npm', 'test'], 900000), sameExecutionAs: 'a'}]});
  assert.deepEqual(check(alias).report.findings, []);
});

test('two xcodebuild test checks on one scheme and destination warn unless one is narrowed or differs', t => {
  const overlap = check(project(t, {checks: [xcode('unit'), xcode('ui', '-resultBundlePath', 'x')]}));
  assert.deepEqual(overlap.report.findings.map(item => [item.code, item.ids]), [['overlapping_full_test', ['unit', 'ui']]]);
  assert.equal(overlap.status, 0);
  assert.deepEqual(check(project(t, {checks: [xcode('unit'), xcode('ui', '-only-testing:AppUITests')]})).report.findings, []);
  const other = cmd('ui', ['xcodebuild', 'test', '-scheme', 'Other', '-destination', 'id=U1']);
  assert.deepEqual(check(project(t, {checks: [xcode('unit'), other]})).report.findings, []);
  const build = cmd('build', ['xcodebuild', 'build', '-scheme', 'App', '-destination', 'id=U1']);
  assert.deepEqual(check(project(t, {checks: [xcode('unit'), build]})).report.findings, []);
});

test('the summed check timeouts warn only above the 30 minute call limit', t => {
  assert.equal(CHECK_CALL_LIMIT_MS, 1800000);
  const exact = project(t, {checks: [cmd('a', ['a']), cmd('b', ['b'])]});
  assert.deepEqual(check(exact).report.findings, []);
  const over = project(t, {checks: [cmd('a', ['a']), cmd('b', ['b']), cmd('c', ['c'])]});
  const r = check(over);
  assert.deepEqual(r.report.findings.map(item => [item.code, item.totalMs, item.limitMs]), [['check_budget_over_call_limit', 2700000, 1800000]]);
  const custom = project(t, {plan: {checkTimeoutMs: 600000}, checks: [cmd('a', ['a']), cmd('b', ['b']), cmd('c', ['c'])]});
  assert.deepEqual(check(custom).report.findings, []);
  const raised = project(t, {plan: {checkTimeoutMs: 1200000}, checks: [cmd('a', ['a']), cmd('b', ['b'])]});
  assert.deepEqual(codes(check(raised).report), ['check_budget_over_call_limit']);
  const tight = project(t, {checks: [cmd('a', ['a'], 1200000), cmd('b', ['b'], 1200000)]});
  assert.deepEqual(codes(check(tight).report), ['check_budget_over_call_limit']);
});

test('the call limit constant still matches the host source', () => {
  const source = fs.readFileSync(path.join(here, '..', 'runtime/js/cm-ai/host-conversation-execution.mjs'), 'utf8');
  assert.match(source, /const outerTimeoutMs=provider\?protection\.timeoutMs:1800000;/);
});

test('dirty scope files warn (tracked change and new file), files outside scope do not, --strict turns warns into exit 1', t => {
  const p = project(t, {scope: ['src/a.js', 'src/new.js'], checks: [cmd('unit', ['node', '--test'])]});
  fs.writeFileSync(path.join(p.root, 'src/b.js'), 'outside\n');
  assert.deepEqual(check(p).report.findings, []);
  fs.writeFileSync(path.join(p.root, 'src/a.js'), 'changed\n');
  fs.writeFileSync(path.join(p.root, 'src/new.js'), 'new\n');
  const r = check(p);
  assert.equal(r.status, 0);
  assert.equal(r.report.warns, 1);
  const [finding] = r.report.findings;
  assert.equal(finding.code, 'scope_dirty');
  assert.deepEqual(finding.paths.sort(), ['src/a.js', 'src/new.js']);
  assert.equal(check(p, '--strict').status, 1);
});

test('a deleted and a renamed scope file are reported as dirty too', t => {
  const p = project(t, {scope: ['src/a.js', 'src/b.js'], checks: [cmd('unit', ['x'])]});
  fs.rmSync(path.join(p.root, 'src/a.js'));
  git(p.root, 'mv', 'src/b.js', 'src/c.js');
  const finding = check(p).report.findings[0];
  assert.equal(finding.code, 'scope_dirty');
  assert.deepEqual(finding.paths.sort(), ['src/a.js', 'src/b.js']);
});

test('a code root that is not a git repository is reported as info and exits 0', t => {
  const p = project(t, {repo: false, checks: [cmd('unit', ['x'])]});
  const r = check(p);
  assert.equal(r.status, 0);
  assert.deepEqual(r.report.findings.map(item => [item.level, item.code]), [['info', 'not_git']]);
  assert.equal(r.report.skipped, 1);
  const text = run('--plan', p.planFile);
  assert.equal(text.status, 0);
  assert.match(text.out, /被跳过/);
});

test('git that cannot run is a warn, not a pass: --strict then fails (no git on PATH)', t => {
  const p = project(t, {checks: [cmd('unit', ['x'])]});
  const r = checkWithEnv(p, {PATH: ''});
  assert.equal(r.status, 0);
  assert.deepEqual(r.report.findings.map(item => [item.level, item.code]), [['warn', 'git_unavailable']]);
  assert.match(r.report.findings[0].message, /没能核对/);
  const strict = spawnSync(process.execPath, [script, '--plan', p.planFile, '--json', '--strict'], {encoding: 'utf8', env: {PATH: ''}});
  assert.equal(strict.status, 1);
});

test('unreadable or unsupported input exits 2 with a Chinese reason and no report', t => {
  const good = project(t, {checks: [cmd('unit', ['x'])]});
  const missing = run('--plan', path.join(good.dir, 'nope.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.err, /读不了PLAN/);
  const badJson = path.join(good.planDir, 'bad.json');
  fs.writeFileSync(badJson, '{');
  assert.match(run('--plan', badJson).err, /不是合法 JSON/);
  const noConfig = path.join(good.planDir, 'noconfig.json');
  fs.writeFileSync(noConfig, JSON.stringify({checks: []}));
  assert.match(run('--plan', noConfig).err, /缺少字段 config/);
  fs.writeFileSync(path.join(good.planDir, 'batch.json'), JSON.stringify({version: 1, workflows: []}));
  fs.writeFileSync(path.join(good.planDir, 'batchplan.json'), JSON.stringify({config: 'batch.json'}));
  assert.match(run('--plan', path.join(good.planDir, 'batchplan.json')).err, /没有 scope 数组/);
  const relative = project(t, {checks: [cmd('unit', ['x'])]});
  fs.writeFileSync(path.join(relative.planDir, 'run.json'), JSON.stringify({version: 1, codeProject: 'code', scope: ['a']}));
  assert.match(run('--plan', relative.planFile).err, /codeProject 必须是绝对路径/);
  const badTimeout = project(t, {checks: [cmd('unit', ['x'], 0)]});
  const r = run('--plan', badTimeout.planFile, '--json');
  assert.equal(r.status, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /timeoutMs/);
  assert.equal(run().status, 2);
  assert.equal(run('--plan').status, 2);
  assert.equal(run('--help').status, 0);
});

test('the check never writes: every file, mtime and the git index are unchanged, dirty tree included', t => {
  const p = project(t, {scope: ['src/a.js', 'AGENTS.md'], checks: [xcode('unit'), xcode('ui'), cmd('d', ['x']), cmd('e', ['x'])]});
  fs.writeFileSync(path.join(p.root, 'src/a.js'), 'dirty\n');
  fs.writeFileSync(path.join(p.root, 'src/untracked.js'), 'u\n');
  const before = snapshot(p.dir);
  const r = check(p);
  assert.equal(r.status, 1);
  assert.ok(r.report.findings.length >= 3);
  assert.equal(snapshot(p.dir), before);
});

test('modes the check does not model exit 2 instead of a verdict (protected, provider, bootstrap)', t => {
  const flags = ['--protected-config', '--protected-conversation-config', '--allow-provider-development-attempt', '--bootstrap-config', '--allow-bootstrap-write'];
  for (const flag of flags) {
    // A rule file in scope is legal for bootstrap; a 45 minute check is fine for a provider run.
    const p = project(t, {scope: ['AGENTS.md'], checks: [cmd('ui', ['x'], 2700000)],
      plan: {permissions: ['--allow-development', flag, ...(flag.endsWith('-write') ? [] : ['x.json'])]}});
    const r = run('--plan', p.planFile, '--json');
    assert.equal(r.status, 2, flag);
    assert.equal(r.out, '', flag);
    assert.match(r.err, new RegExp(`${flag}.*不给出结论`), flag);
  }
  const plain = project(t, {scope: ['src/a.js'], checks: [cmd('unit', ['x'])], plan: {permissions: ['--allow-development', '--review-config', 'review.json']}});
  assert.equal(check(plain).status, 0);
  const bad = project(t, {checks: [cmd('unit', ['x'])], plan: {permissions: 'nope'}});
  assert.match(run('--plan', bad.planFile).err, /permissions 必须是字符串数组/);
});

test('a scope the runtime refuses at create is an input error, not a pass', t => {
  const bads = [[], ['src/a.js', 'src/a.js'], ['src/../a.js'], ['/abs.js'], ['src\\a.js'], ['src:a.js'], ['./a.js'], ['']];
  for (const scope of bads) {
    const p = project(t, {scope, checks: [cmd('unit', ['x'])]});
    const r = run('--plan', p.planFile, '--json');
    assert.equal(r.status, 2, JSON.stringify(scope));
    assert.equal(r.out, '', JSON.stringify(scope));
    assert.match(r.err, /scope 不合法/, JSON.stringify(scope));
  }
  // A protected path next to a good one is still a finding (exit 1), and so is a protected-only scope.
  assert.equal(check(project(t, {scope: ['AGENTS.md', 'src/a.js'], checks: [cmd('unit', ['x'])]})).status, 1);
  assert.equal(check(project(t, {scope: ['AGENTS.md'], checks: [cmd('unit', ['x'])]})).status, 1);
  // A bad path next to a protected one is still an input error.
  assert.equal(run('--plan', project(t, {scope: ['AGENTS.md', '../x.js'], checks: [cmd('unit', ['x'])]}).planFile).status, 2);
});

test('repository config cannot run programs: fsmonitor, clean, process and required filters and a project-local git stay unexecuted', t => {
  const cases = {
    fsmonitor: (p, mark) => {
      const hook = path.join(p.dir, 'fsmonitor.sh');
      fs.writeFileSync(hook, `#!/bin/sh\ntouch '${mark}'\nprintf '\\0'\n`, {mode: 0o755});
      git(p.root, 'config', 'core.fsmonitor', hook);
    },
    clean: (p, mark) => {
      const filter = path.join(p.dir, 'clean.sh');
      fs.writeFileSync(filter, `#!/bin/sh\ntouch '${mark}'\ncat\n`, {mode: 0o755});
      git(p.root, 'config', 'filter.probe.clean', filter);
      git(p.root, 'config', 'filter.probe.required', 'true');
    },
    process: (p, mark) => {
      const filter = path.join(p.dir, 'process.sh');
      fs.writeFileSync(filter, `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, {mode: 0o755});
      git(p.root, 'config', 'filter.probe.process', filter);
      git(p.root, 'config', 'filter.probe.required', 'true');
    }};
  for (const [name, configure] of Object.entries(cases)) {
    const p = project(t, {checks: [cmd('unit', ['x'])]});
    const mark = path.join(p.dir, `ran-${name}`);
    configure(p, mark);
    fs.writeFileSync(path.join(p.root, '.gitattributes'), 'src/a.js filter=probe\n');
    // Same size as the committed 'a\n': git then has to read the content (running the filter) to tell it changed.
    fs.writeFileSync(path.join(p.root, 'src/a.js'), 'z\n');
    // Control: a plain git status in this repository does run the configured program.
    spawnSync('git', ['status', '--porcelain'], {cwd: p.root, env: gitEnv});
    assert.equal(fs.existsSync(mark), true, `control ${name}: the fixture must make plain git run the program`);
    fs.rmSync(mark);
    const r = check(p);
    assert.equal(fs.existsSync(mark), false, `${name} program ran during the check`);
    assert.deepEqual(r.report.findings.map(item => item.code), ['scope_dirty'], name);
  }
  const p = project(t, {checks: [cmd('unit', ['x'])]});
  const bin = path.join(p.root, 'bin');
  fs.mkdirSync(bin);
  const mark = path.join(p.dir, 'ran-local-git');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ntouch '${mark}'\nexit 1\n`, {mode: 0o755});
  const r = checkWithEnv(p, {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`});
  assert.equal(fs.existsSync(mark), false);
  assert.equal(r.status, 0);
});
