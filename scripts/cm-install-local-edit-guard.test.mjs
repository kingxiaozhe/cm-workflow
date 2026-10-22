// Claude-compatible installer: a reinstall must stop on files hand-edited since
// the last install, even with --yes (real incident: another session's
// `./install.sh --yes` silently overwrote an approved edit to
// ~/.claude/scripts/cm-ai-host.mjs). Every run uses a disposable HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = 'cm-workflow/install-manifest.sha256';
const EDITED = 'scripts/cm-ai-host.mjs';

function sandbox(t, prefix) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const target = path.join(home, '.claude');
  const env = {...process.env, HOME: home, CLAUDE_HOME: target,
    CM_WORKFLOW_HOME: path.join(home, 'workflow'), CM_WORKFLOW_LOG_HOME: path.join(home, 'logs')};
  return {home, target, env};
}

function install(env, args, extra = {}) {
  return spawnSync('/bin/bash', [path.join(source, 'install.sh'), ...args],
    {cwd: source, env, encoding: 'utf8', timeout: 150000, maxBuffer: 8 * 1024 * 1024, input: '', ...extra});
}

const output = result => result.stdout + result.stderr;

// Run an interactive install, call onPrompt() once the overwrite prompt is
// reached, then answer "y" (simulates another session editing meanwhile).
function installAtPrompt(env, args, promptPattern, onPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(source, 'install.sh'), ...args], {cwd: source, env});
    let stdout = '', stderr = '', answered = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    const check = () => {
      if (answered || !promptPattern.test(stdout + stderr)) return;
      answered = true;
      onPrompt();
      child.stdin.end('y\n');
    };
    child.stdout.on('data', chunk => { stdout += chunk; check(); });
    child.stderr.on('data', chunk => { stderr += chunk; check(); });
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr, answered}); });
  });
}

function runHelper(script, cwd) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail; . "$1"; cm_manifest_select_hasher; ${script}`,
    'helper', path.join(source, 'scripts/cm-install-manifest.sh')], {cwd, encoding: 'utf8', timeout: 60000});
}

const HEADER = '# cm-workflow install manifest v1';
const lockOf = target => path.join(path.dirname(target), `.${path.basename(target)}.cm-install.lock`);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function deadPid() {
  const child = spawnSync('/bin/sh', ['-c', 'echo $$'], {encoding: 'utf8'});
  return Number(child.stdout.trim());
}

test('install manifest: first install records hashes, unchanged reinstall passes, --yes cannot overwrite a hand edit, --overwrite-local-edits can',
  {skip: process.platform === 'win32', timeout: 600000}, async t => {
    const {target, env} = sandbox(t, 'cm-install-guard-');
    const manifest = path.join(target, MANIFEST);

    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    assert.match(first.stdout, /未找到上次的安装清单/);
    const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n');
    assert.equal(lines[0], '# cm-workflow install manifest v1');
    const recorded = new Map(lines.slice(1).map(line => [line.slice(66), line.slice(0, 64)]));
    assert.match(recorded.get(EDITED) ?? '', /^[0-9a-f]{64}$/);
    assert.ok(recorded.has('templates/cm-VERSION'));
    assert.equal(recorded.has(MANIFEST), false, 'the manifest must not record itself');

    const unchanged = install(env, ['--yes']);
    assert.equal(unchanged.status, 0, output(unchanged));
    assert.doesNotMatch(output(unchanged), /被改动过/);

    const edited = path.join(target, EDITED);
    const handEdit = fs.readFileSync(edited, 'utf8') + '\n// approved local edit\n';
    const manifestBefore = fs.readFileSync(manifest, 'utf8');

    // Regression: edited by another session while this one waits at the overwrite prompt.
    const raced = await installAtPrompt(env, [], /以下 CM 文件已存在/, () => fs.writeFileSync(edited, handEdit));
    assert.equal(raced.answered, true, output(raced));
    assert.equal(raced.status, 3, output(raced));
    assert.match(raced.stderr, /scripts\/cm-ai-host\.mjs/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'an edit made while waiting at the prompt must survive "y"');
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestBefore);

    const refused = install(env, ['--yes']);
    assert.equal(refused.status, 3, output(refused));
    assert.match(refused.stderr, /被改动过/);
    assert.match(refused.stderr, /scripts\/cm-ai-host\.mjs/);
    assert.match(refused.stderr, /--overwrite-local-edits/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'the hand edit must survive a refused --yes reinstall');
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestBefore);

    // Answering "y" to every prompt (as the auto-updater does) is no bypass either.
    const answered = install(env, [], {input: 'y\ny\ny\ny\n'});
    assert.equal(answered.status, 3, output(answered));
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit);

    const overwritten = install(env, ['--yes', '--overwrite-local-edits']);
    assert.equal(overwritten.status, 0, output(overwritten));
    assert.match(overwritten.stdout, /将覆盖以上改动/);
    assert.equal(fs.readFileSync(edited, 'utf8'), fs.readFileSync(path.join(source, EDITED), 'utf8'));

    const afterOverwrite = install(env, ['--yes']);
    assert.equal(afterOverwrite.status, 0, output(afterOverwrite));
    assert.equal(fs.existsSync(lockOf(target)), false, 'every finished install releases its lock');
  });

test('install manifest: files outside the manifest are not judged and a malformed manifest stops the install',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {target, env} = sandbox(t, 'cm-install-guard-extra-');
    const manifest = path.join(target, MANIFEST);
    // An older installation without a manifest: a pre-existing CM file is not a hand edit.
    fs.mkdirSync(path.join(target, 'scripts'), {recursive: true});
    fs.writeFileSync(path.join(target, EDITED), '// installed by an older version\n');
    const legacy = install(env, ['--yes']);
    assert.equal(legacy.status, 0, output(legacy));
    assert.match(legacy.stdout, /未找到上次的安装清单/);

    const userFile = path.join(target, 'scripts', 'my-own-tool.sh');
    fs.writeFileSync(userFile, 'echo mine\n');
    const lines = fs.readFileSync(manifest, 'utf8').split('\n');
    const index = lines.findIndex(line => line.endsWith(`  ${EDITED}`));
    lines[index] = `not-a-hash  ${EDITED}`;
    fs.writeFileSync(manifest, lines.join('\n'));
    const malformed = install(env, ['--yes']);
    assert.equal(malformed.status, 3, output(malformed));
    assert.match(malformed.stderr, /安装清单格式无法识别/);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'echo mine\n');
  });

test('install manifest: a missing sha256 tool stops before any write instead of skipping the check',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, target, env} = sandbox(t, 'cm-install-guard-nohash-');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const dir of ['/usr/bin', '/bin', path.dirname(process.execPath)]) {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'shasum' || name === 'sha256sum' || fs.existsSync(path.join(bin, name))) continue;
        fs.symlinkSync(path.join(dir, name), path.join(bin, name));
      }
    }
    const result = install({...env, PATH: bin}, ['--yes']);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /未找到 shasum 或 sha256sum/);
    assert.equal(fs.existsSync(target), false, 'nothing may be written without the check');
  });

test('manifest helper: a large manifest full of malformed records is rejected, not skipped by SIGPIPE',
  {skip: process.platform === 'win32'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'root'));
    const bad = Array.from({length: 20000}, (_, i) => `bad  missing/file-${i}.md`);
    fs.writeFileSync(path.join(dir, 'manifest'), [HEADER, ...bad, ''].join('\n'));
    const result = runHelper('if cm_manifest_find_edits root manifest edits .; then echo status=0; else echo status=$?; fi', dir);
    assert.equal(result.stdout.trim(), 'status=3', result.stdout + result.stderr);
  });

test('manifest helper: a `..` record at the front of a large manifest is rejected',
  {skip: process.platform === 'win32'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'root/a'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'root/a/f'), 'same\n');
    const hash = '0'.repeat(64);
    const records = [`${hash}  ../outside`, ...Array.from({length: 20000}, () => `${hash}  a/f`)];
    fs.writeFileSync(path.join(dir, 'manifest'), [HEADER, ...records, ''].join('\n'));
    const result = runHelper('if cm_manifest_find_edits root manifest edits .; then echo status=0; else echo status=$?; fi', dir);
    assert.equal(result.stdout.trim(), 'status=3', result.stdout + result.stderr);
  });

test('manifest helper: a symlinked parent directory counts as an edit and is never hashed through',
  {skip: process.platform === 'win32'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'root'));
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.writeFileSync(path.join(dir, 'outside/SKILL.md'), 'outside\n');
    fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'root/skill'));
    // The recorded hash equals the outside file, so following the link would report no edit.
    fs.mkdirSync(path.join(dir, 'recorded/skill'), {recursive: true});
    fs.copyFileSync(path.join(dir, 'outside/SKILL.md'), path.join(dir, 'recorded/skill/SKILL.md'));
    fs.writeFileSync(path.join(dir, 'list'), 'skill/SKILL.md\n');
    const written = runHelper('cm_manifest_write recorded list manifest', dir);
    assert.equal(written.status, 0, written.stdout + written.stderr);
    const result = runHelper('cm_manifest_find_edits root manifest edits . && cat edits', dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, 'skill/SKILL.md\n');
  });

test('install lock: a concurrent install of the same target is refused without writing, and a later install succeeds',
  {skip: process.platform === 'win32', timeout: 600000}, async t => {
    const {target, env} = sandbox(t, 'cm-install-guard-lock-');
    const lock = lockOf(target);
    const first = spawn('/bin/bash', [path.join(source, 'install.sh'), '--yes'], {cwd: source, env, stdio: ['ignore', 'pipe', 'pipe']});
    let firstOut = '';
    first.stdout.on('data', chunk => { firstOut += chunk; });
    first.stderr.on('data', chunk => { firstOut += chunk; });
    const firstDone = new Promise(resolve => first.on('close', resolve));
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(lock, 'owner')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(lock, 'owner')), firstOut);

    const second = install(env, ['--yes']);
    assert.equal(second.status, 4, output(second));
    assert.match(second.stderr, /另一个 CM 安装正在写同一目标/);
    assert.match(second.stderr, new RegExp(`持有进程: ${first.pid}`));
    assert.match(second.stderr, /该进程仍在运行/);
    assert.doesNotMatch(output(second), /未找到上次的安装清单|安装清单已写入/);
    assert.ok(fs.existsSync(lock), 'a refused install must not release or take over the holder\'s lock');

    assert.equal(await firstDone, 0, firstOut);
    assert.equal(fs.existsSync(lock), false);
    const later = install(env, ['--yes']);
    assert.equal(later.status, 0, output(later));
  });

test('install lock: a stale lock is reported with a correctly quoted manual cleanup command and never taken over',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, env} = sandbox(t, 'cm-install-guard-stale-');
    // A quote and a command substitution in the path must survive copy-paste.
    const parent = path.join(home, "it's $(touch pwned)");
    fs.mkdirSync(parent);
    const target = path.join(parent, '.claude');
    const lock = lockOf(target);
    fs.mkdirSync(lock);
    const owner = `pid=${deadPid()}\nstarted=2026-10-20T00:00:00Z\ntarget=${target}\n`;
    fs.writeFileSync(path.join(lock, 'owner'), owner);
    const refused = install({...env, CLAUDE_HOME: target}, ['--yes']);
    assert.equal(refused.status, 4, output(refused));
    assert.match(refused.stderr, /该进程已不在运行/);
    const command = refused.stderr.split('\n').find(line => line.trim().startsWith('rm -rf '));
    assert.ok(command, refused.stderr);
    const parsed = spawnSync('/bin/bash', ['-c', `set -- ${command.trim().slice('rm -rf '.length)}; printf '%s|%s' "$#" "$1"`],
      {cwd: home, encoding: 'utf8'});
    assert.equal(parsed.stdout, `1|${lock}`, 'the printed command must name exactly the lock directory');
    assert.equal(fs.existsSync(path.join(home, 'pwned')), false);
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), owner);
    assert.equal(fs.existsSync(target), false, 'nothing may be written while the lock is held');
  });

test('per-file check: a file edited mid-copy stops the install with 3 and rolls back the files already written',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = sandbox(t, 'cm-install-guard-midcopy-');
    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    // Simulate an older installed version of an early file, recorded in the manifest.
    const early = 'agents/cm-backend-agent.md';
    const olderContent = '# older installed version\n';
    fs.writeFileSync(path.join(target, early), olderContent);
    const manifest = path.join(target, MANIFEST);
    const lines = fs.readFileSync(manifest, 'utf8').split('\n')
      .map(line => line.endsWith(`  ${early}`) ? `${sha256(olderContent)}  ${early}` : line);
    fs.writeFileSync(manifest, lines.join('\n'));
    const manifestBefore = fs.readFileSync(manifest, 'utf8');
    const late = path.join(target, EDITED);
    const handEdit = fs.readFileSync(late, 'utf8') + '\n// edited while the install was copying\n';
    const hook = path.join(home, 'hook.sh');
    // Appends to a later file only when the first file is about to be copied.
    fs.writeFileSync(hook, ['#!/bin/sh', `[ "$2" = "${early}" ] || exit 0`,
      `printf '\\n// edited while the install was copying\\n' >> '${late}'`, ''].join('\n'), {mode: 0o755});

    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 3, output(result));
    assert.match(result.stderr, /安装过程中 scripts\/cm-ai-host\.mjs 被改动/);
    assert.match(result.stderr, /已回滚本次写入/);
    assert.equal(fs.readFileSync(late, 'utf8'), handEdit, 'the file edited mid-copy must stay untouched');
    assert.equal(fs.readFileSync(path.join(target, early), 'utf8'), olderContent, 'files already written must be rolled back');
    assert.equal(fs.readFileSync(manifest, 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false, 'a failed install releases its lock');
  });

// ---- Fault injection (CM_INSTALL_TEST_HOOK) -----------------------------------
// One real install is shared as a template; each fault test copies it.
let template;
function installedClone(t, prefix) {
  if (!template) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-template-')));
    process.on('exit', () => fs.rmSync(home, {recursive: true, force: true}));
    const target = path.join(home, '.claude');
    const env = {...process.env, HOME: home, CLAUDE_HOME: target,
      CM_WORKFLOW_HOME: path.join(home, 'workflow'), CM_WORKFLOW_LOG_HOME: path.join(home, 'logs')};
    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    template = target;
  }
  const box = sandbox(t, prefix);
  const copied = spawnSync('cp', ['-Rp', template, box.target]);
  assert.equal(copied.status, 0, String(copied.stderr));
  return box;
}

function writeHook(home, lines) {
  const hook = path.join(home, 'hook.sh');
  fs.writeFileSync(hook, ['#!/bin/sh', ...lines, 'exit 0', ''].join('\n'), {mode: 0o755});
  return hook;
}

// Make an early managed file look like an older installed version recorded in
// the manifest, so a rollback is observable byte for byte.
function olderVersion(target, relative, content) {
  fs.writeFileSync(path.join(target, relative), content);
  const manifest = path.join(target, MANIFEST);
  const lines = fs.readFileSync(manifest, 'utf8').split('\n')
    .map(line => line.endsWith(`  ${relative}`) ? `${sha256(content)}  ${relative}` : line);
  fs.writeFileSync(manifest, lines.join('\n'));
}

const leftovers = home => fs.readdirSync(home).filter(name => /^\.cm-claude\.(stage|backup)\./.test(name));
const EARLY = 'agents/cm-backend-agent.md';
const SECOND = 'agents/cm-contract-agent.md';

test('fault: a signal between taking the install lock and registering it still releases the lock',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, target, env} = sandbox(t, 'cm-install-fault-lock-');
    const hook = writeHook(home, ['[ "$1" = lock-acquired ] || exit 0', 'kill -TERM "$PPID"']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.equal(fs.existsSync(lockOf(target)), false, 'the lock taken just before the signal must be released');
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(leftovers(home), []);
  });

test('fault: a copy failing midway rolls back the written files, keeps the old manifest and unlocks',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-copy-');
    olderVersion(target, EARLY, '# older early file\n');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const lateBefore = fs.readFileSync(path.join(target, EDITED), 'utf8');
    const hook = writeHook(home, [`[ "$1" = before-copy ] && [ "$2" = "${EDITED}" ] && exit 7`]);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 7, output(result));
    assert.match(result.stderr, /安装失败，已回滚本次写入/);
    assert.equal(fs.readFileSync(path.join(target, EARLY), 'utf8'), '# older early file\n');
    assert.equal(fs.readFileSync(path.join(target, EDITED), 'utf8'), lateBefore);
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false);
    assert.deepEqual(leftovers(home), []);
  });

test('fault: a failure right after the new manifest is published restores the old manifest and the files',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-publish-');
    olderVersion(target, EARLY, '# older early file\n');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const hook = writeHook(home, ['[ "$1" = after-manifest-publish ] && exit 9']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 9, output(result));
    assert.equal(fs.readFileSync(path.join(target, EARLY), 'utf8'), '# older early file\n');
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.readdirSync(path.join(target, 'cm-workflow')).some(name => name.startsWith('.install-manifest.')), false);
    assert.equal(fs.existsSync(lockOf(target)), false);
    assert.deepEqual(leftovers(home), []);
  });

test('fault: a failing rollback step does not stop the rest of the rollback or the unlock, and keeps the recovery copies',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-rollback-');
    olderVersion(target, EARLY, '# older early file\n');
    olderVersion(target, SECOND, '# older second file\n');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    // After both early files are written, make the first one unrestorable, then fail.
    const hook = writeHook(home, [`[ "$1" = before-copy ] && [ "$2" = "${EDITED}" ] || exit 0`,
      `chmod 0444 '${path.join(target, EARLY)}'`, 'exit 7']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 7, output(result));
    assert.match(result.stderr, /回滚不完整/);
    assert.match(result.stderr, /恢复失败: .*agents\/cm-backend-agent\.md/);
    assert.equal(fs.readFileSync(path.join(target, SECOND), 'utf8'), '# older second file\n', 'later restores still run');
    assert.equal(fs.readFileSync(path.join(target, EARLY), 'utf8'), fs.readFileSync(path.join(source, EARLY), 'utf8'));
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false, 'the lock is released even when the rollback is incomplete');
    const kept = leftovers(home).filter(name => name.startsWith('.cm-claude.backup.'));
    assert.equal(kept.length, 1, 'the recovery copy must be kept');
    assert.equal(fs.readFileSync(path.join(home, kept[0], EARLY), 'utf8'), '# older early file\n');
    assert.match(result.stderr, new RegExp(`恢复材料保留在: .*${kept[0].replace(/\./g, '\\.')}`));
  });

test('fault: a later file replaced by a symlink before its turn is never written through',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-symlink-');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const outside = path.join(home, 'outside.mjs');
    // Same bytes as the recorded file, so a content-only check would pass.
    fs.copyFileSync(path.join(target, EDITED), outside);
    const outsideBefore = fs.readFileSync(outside);
    const late = path.join(target, EDITED);
    const hook = writeHook(home, [`[ "$1" = before-copy ] && [ "$2" = "${EARLY}" ] || exit 0`,
      `rm -f '${late}'`, `ln -s '${outside}' '${late}'`]);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 3, output(result));
    assert.match(result.stderr, /路径类型发生变化/);
    assert.ok(fs.lstatSync(late).isSymbolicLink());
    assert.deepEqual(fs.readFileSync(outside), outsideBefore, 'the file outside the install root must not be written');
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false);
  });

test('lock identity: other spellings of the same target and the Codex installer aimed at it share one lock',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, target, env} = sandbox(t, 'cm-install-lock-identity-');
    const holder = spawn('/bin/sleep', ['60']);
    t.after(() => holder.kill('SIGKILL'));
    const hold = dir => {
      const lock = lockOf(dir);
      fs.mkdirSync(lock, {recursive: true});
      fs.writeFileSync(path.join(lock, 'owner'), `pid=${holder.pid}\nstarted=2026-10-20T00:00:00Z\ntarget=${dir}\n`);
      return lock;
    };
    const lock = hold(target);
    fs.symlinkSync(home, path.join(home, 'alias'));
    for (const spelling of [`${target}/.`, `${target}/`, path.join(home, 'alias', '.claude')]) {
      const refused = install({...env, CLAUDE_HOME: spelling}, ['--yes']);
      assert.equal(refused.status, 4, `${spelling}\n${output(refused)}`);
      assert.match(refused.stderr, new RegExp(`持有进程: ${holder.pid}`));
    }
    assert.equal(fs.existsSync(target), false);
    assert.ok(fs.existsSync(lock));
    // The Codex plugin directory is guarded by the same rule.
    const codexTarget = path.join(home, 'plugins', 'cm-workflow');
    hold(codexTarget);
    const cross = install({...env, CLAUDE_HOME: codexTarget}, ['--yes']);
    assert.equal(cross.status, 4, output(cross));
    assert.equal(fs.existsSync(codexTarget), false);
  });

test('path safety: an install root reached through a symlink spelling is refused without writing',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, env} = sandbox(t, 'cm-install-root-link-');
    const real = path.join(home, 'real-claude');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(home, 'link-claude'));
    for (const spelling of [path.join(home, 'link-claude'), `${path.join(home, 'link-claude')}/.`]) {
      const refused = install({...env, CLAUDE_HOME: spelling}, ['--yes']);
      assert.equal(refused.status, 2, `${spelling}\n${output(refused)}`);
      assert.match(refused.stderr, /安装目录不能是符号链接/);
    }
    assert.deepEqual(fs.readdirSync(real), []);
  });

test('manifest helper: a name containing a backslash is refused instead of writing a manifest that cannot round-trip',
  {skip: process.platform === 'win32'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'root'));
    fs.writeFileSync(path.join(dir, 'root', 'a\\b.md'), 'x\n');
    fs.writeFileSync(path.join(dir, 'list'), 'a\\b.md\n');
    const result = runHelper('if cm_manifest_write root list manifest; then echo status=0; else echo status=$?; fi', dir);
    assert.equal(result.stdout.trim(), 'status=1', result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(dir, 'manifest')), false);
  });

const realTool = name => spawnSync('/bin/sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim();
function fakeBin(home, name, body) {
  const bin = path.join(home, 'fake-bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, name), ['#!/bin/sh', ...body, ''].join('\n'), {mode: 0o755});
  return bin;
}

test('fault: a lock mkdir that succeeds but is then killed by a group signal still releases the lock',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {home, target, env} = sandbox(t, 'cm-install-fault-mkdir-');
    const mkdir = realTool('mkdir');
    // Real side effect first, then the signal reaches both the installer and this command.
    const bin = fakeBin(home, 'mkdir', [`${mkdir} "$@"; rc=$?`,
      'case "$*" in *.cm-install.lock) kill -TERM "$PPID"; kill -TERM $$ ;; esac', 'exit $rc']);
    const result = install({...env, PATH: `${bin}:${env.PATH}`}, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.equal(fs.existsSync(lockOf(target)), false, 'the lock this run created must be released');
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(leftovers(home), []);
  });

test('fault: a file copy that fails half-written is rolled back with the files before it',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-halfcopy-');
    olderVersion(target, EARLY, '# older early file\n');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const late = path.join(target, EDITED);
    const lateBefore = fs.readFileSync(late);
    const marker = path.join(home, 'cp-failed-once');
    const bin = fakeBin(home, 'cp', [
      `if [ "$#" -eq 3 ] && [ "$3" = '${late}' ] && [ ! -e '${marker}' ]; then`,
      `  : > '${marker}'; head -c 64 "$2" > "$3"; exit 1`,
      'fi', `exec ${realTool('cp')} "$@"`]);
    const result = install({...env, PATH: `${bin}:${env.PATH}`}, ['--yes']);
    assert.equal(result.status, 1, output(result));
    assert.ok(fs.existsSync(marker), 'the half-written copy must have happened');
    assert.deepEqual(fs.readFileSync(late), lateBefore, 'the half-written file is restored');
    assert.equal(fs.readFileSync(path.join(target, EARLY), 'utf8'), '# older early file\n');
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false);
    assert.deepEqual(leftovers(home), []);
  });

test('fault: an unreadable rollback list is reported as an incomplete rollback and the backup is kept',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-list-');
    olderVersion(target, EARLY, '# older early file\n');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const tmp = path.join(home, 'tmp');
    fs.mkdirSync(tmp);
    const hook = writeHook(home, [`[ "$1" = before-copy ] && [ "$2" = "${EDITED}" ] || exit 0`,
      `chmod 000 '${tmp}'/cm-install-guard.*/written-files`, 'exit 7']);
    const result = install({...env, TMPDIR: tmp, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 7, output(result));
    assert.match(result.stderr, /回滚清单不可读/);
    assert.match(result.stderr, /回滚不完整/);
    assert.doesNotMatch(result.stderr, /已回滚本次写入/);
    const kept = leftovers(home).filter(name => name.startsWith('.cm-claude.backup.'));
    assert.equal(kept.length, 1, 'the backup must be kept');
    assert.equal(fs.readFileSync(path.join(home, kept[0], EARLY), 'utf8'), '# older early file\n');
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false, 'the lock is still released');
  });

test('fault: a failure after the temporary manifest is created removes only that file and keeps the old manifest',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-tmpmanifest-');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST), 'utf8');
    const unrelated = path.join(target, 'cm-workflow', 'install-manifest.sha256.tmp.notmine');
    fs.writeFileSync(unrelated, 'not created by this install\n');
    const hook = writeHook(home, ['[ "$1" = before-manifest-publish ] && exit 9']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 9, output(result));
    const names = fs.readdirSync(path.join(target, 'cm-workflow'));
    assert.equal(names.some(name => name.startsWith('.install-manifest.')), false, 'the temporary manifest is removed');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'not created by this install\n');
    assert.equal(fs.readFileSync(path.join(target, MANIFEST), 'utf8'), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false);
  });

test('manifest helper: a missing or unreadable scan list is a check failure, never an empty list',
  {skip: process.platform === 'win32' || process.getuid?.() === 0}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'root/a'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'root/a/f'), 'edited\n');
    fs.writeFileSync(path.join(dir, 'empty'), '');
    const status = script => runHelper(`if ${script}; then echo status=0; else echo status=$?; fi`, dir).stdout.trim();
    assert.equal(status('cm_manifest_hash_list root empty out'), 'status=0', 'a readable empty list is fine');
    assert.equal(status('cm_manifest_hash_list root missing out'), 'status=1');
    fs.writeFileSync(path.join(dir, 'unreadable'), 'a/f\n', {mode: 0o200});
    assert.equal(status('cm_manifest_hash_list root unreadable out'), 'status=1');
    // A write-only scan file can be written but not read back: that must not mean "no edits".
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(path.join(dir, 'work/recorded-paths'), '', {mode: 0o200});
    fs.writeFileSync(path.join(dir, 'manifest'), `${HEADER}\n${'0'.repeat(64)}  a/f\n`);
    assert.equal(status('cm_manifest_find_edits root manifest edits work'), 'status=1');
  });

test('fault: a cut-short rollback record is reported and never used to delete or restore a file',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, target, env} = installedClone(t, 'cm-install-fault-partial-');
    olderVersion(target, EARLY, '# older early file\n');
    // A user's own file whose name is a prefix of a managed path.
    const userFile = path.join(target, 'scripts', 'cm-ai-host');
    fs.writeFileSync(userFile, 'my own file\n');
    const tmp = path.join(home, 'tmp');
    fs.mkdirSync(tmp);
    // Simulate a write that stopped after "scripts/cm-ai-host" of the next record.
    const hook = writeHook(home, [`[ "$1" = before-copy ] && [ "$2" = "${EDITED}" ] || exit 0`,
      `for work in '${tmp}'/cm-install-guard.*; do printf '%s' 'scripts/cm-ai-host' >> "$work/written-files"; done`, 'exit 7']);
    const result = install({...env, TMPDIR: tmp, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 7, output(result));
    assert.match(result.stderr, /回滚清单记录不完整，未使用: scripts\/cm-ai-host/);
    assert.match(result.stderr, /回滚不完整/);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'my own file\n', 'the user file must not be deleted');
    assert.equal(fs.readFileSync(path.join(target, EARLY), 'utf8'), '# older early file\n', 'complete records are still restored');
    const kept = leftovers(home).filter(name => name.startsWith('.cm-claude.backup.'));
    assert.equal(kept.length, 1, 'the backup is kept');
    assert.equal(fs.existsSync(lockOf(target)), false);
  });

test('access: an install directory that cannot be searched stops the install instead of looking like "no manifest"',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 300000}, t => {
    const {target, env} = installedClone(t, 'cm-install-noaccess-');
    const manifestDir = path.join(target, 'cm-workflow');
    const manifestBefore = fs.readFileSync(path.join(target, MANIFEST));
    fs.chmodSync(manifestDir, 0o600);
    t.after(() => { if (fs.existsSync(manifestDir)) fs.chmodSync(manifestDir, 0o755); });
    const result = install(env, ['--yes']);
    fs.chmodSync(manifestDir, 0o755);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /安装目录无法访问，无法判断上次的安装清单是否存在/);
    assert.doesNotMatch(result.stdout, /未找到上次的安装清单/);
    assert.deepEqual(fs.readFileSync(path.join(target, MANIFEST)), manifestBefore);
    assert.equal(fs.existsSync(lockOf(target)), false);
  });

test('manifest helper: a recorded file under a directory that cannot be searched is a check failure, not "deleted"',
  {skip: process.platform === 'win32' || process.getuid?.() === 0}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-guard-helper-'));
    t.after(() => { fs.chmodSync(path.join(dir, 'root/a'), 0o755); fs.rmSync(dir, {recursive: true, force: true}); });
    fs.mkdirSync(path.join(dir, 'root/a'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'root/a/f'), 'edited\n');
    fs.mkdirSync(path.join(dir, 'work'));
    fs.writeFileSync(path.join(dir, 'manifest'), `${HEADER}\n${'0'.repeat(64)}  a/f\n`);
    fs.chmodSync(path.join(dir, 'root/a'), 0o644);
    const status = script => runHelper(`if ${script}; then echo status=0; else echo status=$?; fi`, dir).stdout.trim();
    assert.equal(status('cm_manifest_parent_is_safe root a/f'), 'status=2');
    assert.equal(status('cm_manifest_find_edits root manifest edits work'), 'status=1');
  });
