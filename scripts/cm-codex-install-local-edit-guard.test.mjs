// Codex installer: replacing ~/plugins/cm-workflow must stop on files
// hand-edited since the last install, even with --yes. Runs in a disposable
// HOME/CODEX_HOME with a stub plugin creator and a stub `codex` CLI, so it
// never touches the real ~/plugins, ~/.agents or ~/.codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = '.cm-install-manifest.sha256';
const EDITED = 'skills/cm-check/SKILL.md';

const STUB_CREATOR = `import json, pathlib, sys
args = sys.argv[1:]
path = pathlib.Path(args[args.index('--marketplace-path') + 1])
# Every run changes the file, so a later rollback has something to undo.
data = json.loads(path.read_text()) if path.exists() else {'name': 'personal', 'plugins': [{'name': 'cm-workflow'}]}
data['stubWrites'] = data.get('stubWrites', 0) + 1
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data) + '\\n')
`;

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codex-install-guard-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const codexHome = path.join(home, '.codex');
  const creator = path.join(codexHome, 'skills/.system/plugin-creator/scripts');
  fs.mkdirSync(creator, {recursive: true});
  fs.writeFileSync(path.join(creator, 'create_basic_plugin.py'), STUB_CREATOR);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const env = {...process.env, HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH}`,
    CM_WORKFLOW_HOME: path.join(home, 'workflow'), CM_WORKFLOW_LOG_HOME: path.join(home, 'logs'), CM_MATT_SKILLS_INSTALL: 'off'};
  return {home, bin, plugin: path.join(home, 'plugins/cm-workflow'), marketplace: path.join(home, '.agents/plugins/marketplace.json'), env};
}

function install(env, args) {
  return spawnSync('/bin/bash', [path.join(source, 'install-codex.sh'), ...args],
    {cwd: source, env, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, input: ''});
}

const output = result => result.stdout + result.stderr;
const lockOf = target => path.join(path.dirname(target), `.${path.basename(target)}.cm-install.lock`);

// Run an interactive install, call onPrompt() once the replace prompt is
// reached, then answer "y" (simulates another session editing meanwhile).
function installAtPrompt(env, onPrompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(source, 'install-codex.sh')], {cwd: source, env});
    let stdout = '', stderr = '', answered = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    const check = () => {
      if (answered || !/Replace the existing Codex plugin/.test(stdout)) return;
      answered = true;
      onPrompt();
      child.stdin.end('y\n');
    };
    child.stdout.on('data', chunk => { stdout += chunk; check(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({status, stdout, stderr, answered}); });
  });
}

test('codex install manifest: first install records hashes, unchanged reinstall passes, --yes cannot overwrite a hand edit, --overwrite-local-edits can',
  {skip: process.platform === 'win32', timeout: 900000}, async t => {
    const {plugin, marketplace, env} = sandbox(t);
    const manifest = path.join(plugin, MANIFEST);

    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    assert.match(first.stdout, /No previous install manifest found/);
    const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n');
    assert.equal(lines[0], '# cm-workflow install manifest v1');
    const recorded = new Map(lines.slice(1).map(line => [line.slice(66), line.slice(0, 64)]));
    assert.match(recorded.get(EDITED) ?? '', /^[0-9a-f]{64}$/);
    // The cache-version stamp happens before hashing, so the installed manifest is recorded as installed.
    assert.ok(recorded.has('.codex-plugin/plugin.json'));
    assert.equal(recorded.has(MANIFEST), false, 'the manifest must not record itself');

    const unchanged = install(env, ['--yes']);
    assert.equal(unchanged.status, 0, output(unchanged));
    assert.doesNotMatch(output(unchanged), /changed since the last install/);

    const edited = path.join(plugin, EDITED);
    const handEdit = fs.readFileSync(edited, 'utf8') + '\n<!-- approved local edit -->\n';

    // Regression: edited by another session while this one waits at the replace prompt.
    const marketplaceBefore = fs.readFileSync(marketplace, 'utf8');
    const raced = await installAtPrompt(env, () => fs.writeFileSync(edited, handEdit));
    assert.equal(raced.answered, true, output(raced));
    assert.equal(raced.status, 3, output(raced));
    assert.match(raced.stderr, /skills\/cm-check\/SKILL\.md/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'an edit made while waiting at the prompt must survive "y"');
    assert.equal(fs.readFileSync(marketplace, 'utf8'), marketplaceBefore);
    // A file the installer never recorded is not judged.
    fs.writeFileSync(path.join(plugin, 'scripts/my-own-tool.sh'), 'echo mine\n');

    const refused = install(env, ['--yes']);
    assert.equal(refused.status, 3, output(refused));
    assert.match(refused.stderr, /changed since the last install/);
    assert.match(refused.stderr, /skills\/cm-check\/SKILL\.md/);
    assert.doesNotMatch(refused.stderr, /my-own-tool/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'the hand edit must survive a refused --yes reinstall');

    const overwritten = install(env, ['--overwrite-local-edits', '--yes']);
    assert.equal(overwritten.status, 0, output(overwritten));
    assert.match(overwritten.stdout, /these edits will be replaced/);
    assert.equal(fs.readFileSync(edited, 'utf8'), fs.readFileSync(path.join(source, EDITED), 'utf8'));
    assert.equal(fs.existsSync(lockOf(plugin)), false,
      'every finished install releases its lock');
  });

test('codex install manifest: a manifest path that is a directory is a corrupt manifest, not a missing one',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {plugin, env} = sandbox(t);
    fs.mkdirSync(path.join(plugin, MANIFEST), {recursive: true});
    fs.mkdirSync(path.join(plugin, 'skills/cm-check'), {recursive: true});
    fs.writeFileSync(path.join(plugin, EDITED), 'hand edit\n');
    const refused = install(env, ['--yes']);
    assert.equal(refused.status, 3, output(refused));
    assert.match(refused.stderr, /Unrecognized install manifest/);
    assert.doesNotMatch(refused.stdout, /No previous install manifest found/);
    assert.equal(fs.readFileSync(path.join(plugin, EDITED), 'utf8'), 'hand edit\n');
  });

test('codex install lock: a held lock refuses the install without writing; a stale one is reported, never taken over',
  {skip: process.platform === 'win32', timeout: 120000}, async t => {
    const {plugin, marketplace, env} = sandbox(t);
    const lock = lockOf(plugin);
    fs.mkdirSync(lock, {recursive: true});
    const holder = spawn('/bin/sleep', ['60']);
    t.after(() => holder.kill('SIGKILL'));
    const owner = pid => `pid=${pid}\nstarted=2026-10-20T00:00:00Z\ntarget=${plugin}\n`;
    fs.writeFileSync(path.join(lock, 'owner'), owner(holder.pid));

    const busy = install(env, ['--yes']);
    assert.equal(busy.status, 4, output(busy));
    assert.match(busy.stderr, /Another CM install is writing the same target/);
    assert.match(busy.stderr, new RegExp(`Holder pid: ${holder.pid}`));
    assert.match(busy.stderr, /still running/);
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(fs.existsSync(marketplace), false);
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), owner(holder.pid));

    const exited = new Promise(resolve => holder.on('close', resolve));
    holder.kill('SIGKILL');
    await exited;
    const stale = install(env, ['--yes']);
    assert.equal(stale.status, 4, output(stale));
    assert.match(stale.stderr, /no longer running/);
    assert.ok(stale.stderr.includes(`rm -rf ${lock}`), stale.stderr);
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), owner(holder.pid));
  });

function writeHook(dir, lines) {
  const hook = path.join(dir, 'hook.sh');
  fs.writeFileSync(hook, ['#!/bin/sh', ...lines, 'exit 0', ''].join('\n'), {mode: 0o755});
  return hook;
}

test('codex fault: a signal between taking the install lock and registering it still releases the lock',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {plugin, marketplace, env} = sandbox(t);
    const hook = writeHook(path.dirname(path.dirname(plugin)), ['[ "$1" = lock-acquired ] || exit 0', 'kill -TERM "$PPID"']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.equal(fs.existsSync(lockOf(plugin)), false);
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(fs.existsSync(marketplace), false);
  });

test('codex fault: a signal right after the new plugin is renamed into place restores the previous plugin',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const {plugin, marketplace, env} = sandbox(t);
    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    const pluginJson = path.join(plugin, '.codex-plugin/plugin.json');
    const before = {json: fs.readFileSync(pluginJson), manifest: fs.readFileSync(path.join(plugin, MANIFEST)),
      marketplace: fs.readFileSync(marketplace)};
    const hook = writeHook(path.dirname(path.dirname(plugin)), ['[ "$1" = after-stage-moved ] || exit 0', 'kill -TERM "$PPID"']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.deepEqual(fs.readFileSync(pluginJson), before.json, 'the previous plugin (its cache-version stamp) is back');
    assert.deepEqual(fs.readFileSync(path.join(plugin, MANIFEST)), before.manifest);
    assert.deepEqual(fs.readFileSync(marketplace), before.marketplace);
    assert.equal(fs.existsSync(lockOf(plugin)), false);
    assert.deepEqual(fs.readdirSync(path.dirname(plugin)).filter(name => name !== 'cm-workflow'), []);
  });

test('codex access: a plugins directory that becomes unsearchable after the rename reports an incomplete rollback and keeps the lock and backup',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 600000}, t => {
    const {plugin, marketplace, env} = sandbox(t);
    const first = install(env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    const pluginJson = path.join(plugin, '.codex-plugin/plugin.json');
    const before = {json: fs.readFileSync(pluginJson), marketplace: fs.readFileSync(marketplace)};
    const plugins = path.dirname(plugin);
    t.after(() => { try { fs.chmodSync(plugins, 0o755); } catch {} });
    const hook = writeHook(path.dirname(plugins), ['[ "$1" = after-stage-moved ] || exit 0',
      `chmod 000 '${plugins}'`, 'kill -TERM "$PPID"']);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.match(result.stderr, /rollback is incomplete/, 'the skipped restore must be reported');
    assert.match(result.stderr, /plugins directory cannot be accessed/);
    assert.doesNotMatch(result.stderr, /was replaced during the install/, 'unsearchable is not "replaced"');
    fs.chmodSync(plugins, 0o755);
    const lock = lockOf(plugin);
    assert.equal(fs.existsSync(lock), true, 'the lock is left for a person, not removed blind');
    assert.match(result.stderr, new RegExp(path.basename(lock).replace(/\./g, '\\.')));
    const kept = fs.readdirSync(plugins).filter(name => name.startsWith('.cm-workflow.backup.'));
    assert.equal(kept.length, 1, 'the previous plugin must be kept');
    assert.deepEqual(fs.readFileSync(path.join(plugins, kept[0], '.codex-plugin/plugin.json')), before.json);
    assert.match(result.stderr, new RegExp(kept[0].replace(/\./g, '\\.')), 'its location is printed');
  });

test('codex path safety: a symlinked marketplace or plugins root is refused before anything is written',
  {skip: process.platform === 'win32', timeout: 120000}, t => {
    const {plugin, marketplace, env} = sandbox(t);
    const home = path.dirname(path.dirname(plugin));
    const outside = path.join(home, 'outside-marketplace.json');
    fs.writeFileSync(outside, '{"name":"someone-else","plugins":[]}\n');
    fs.mkdirSync(path.dirname(marketplace), {recursive: true});
    fs.symlinkSync(outside, marketplace);
    const linkedMarketplace = install(env, ['--yes']);
    assert.equal(linkedMarketplace.status, 2, output(linkedMarketplace));
    assert.match(linkedMarketplace.stderr, /Refusing a symlinked or wrong-type install path/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '{"name":"someone-else","plugins":[]}\n');
    assert.equal(fs.existsSync(plugin), false);
    fs.unlinkSync(marketplace);

    const realPlugins = path.join(home, 'real-plugins');
    fs.mkdirSync(realPlugins);
    fs.symlinkSync(realPlugins, path.dirname(plugin));
    const linkedRoot = install(env, ['--yes']);
    assert.equal(linkedRoot.status, 2, output(linkedRoot));
    assert.match(linkedRoot.stderr, /Refusing a symlinked install path/);
    assert.deepEqual(fs.readdirSync(realPlugins), []);
    assert.equal(fs.existsSync(marketplace), false);
  });

// ---- Fault injection on a copy of one real install --------------------------
let codexTemplate;
function installedCodexClone(t) {
  if (!codexTemplate) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codex-install-template-')));
    process.on('exit', () => fs.rmSync(home, {recursive: true, force: true}));
    const box = sandbox({after: () => {}});
    const first = install(box.env, ['--yes']);
    assert.equal(first.status, 0, output(first));
    for (const dir of ['plugins', '.agents']) {
      assert.equal(spawnSync('cp', ['-Rp', path.join(box.home, dir), path.join(home, dir)]).status, 0);
    }
    fs.rmSync(box.home, {recursive: true, force: true});
    codexTemplate = home;
  }
  const box = sandbox(t);
  for (const dir of ['plugins', '.agents']) {
    assert.equal(spawnSync('cp', ['-Rp', path.join(codexTemplate, dir), path.join(box.home, dir)]).status, 0);
  }
  const pluginJson = path.join(box.plugin, '.codex-plugin/plugin.json');
  box.before = {json: fs.readFileSync(pluginJson), manifest: fs.readFileSync(path.join(box.plugin, MANIFEST)),
    marketplace: fs.readFileSync(box.marketplace)};
  box.pluginJson = pluginJson;
  return box;
}

const realTool = name => spawnSync('/bin/sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).stdout.trim();
function fakeTool(bin, name, body) {
  fs.writeFileSync(path.join(bin, name), ['#!/bin/sh', ...body, ''].join('\n'), {mode: 0o755});
}
const pluginsLeftovers = plugin => fs.readdirSync(path.dirname(plugin)).filter(name => name !== 'cm-workflow');

test('codex fault: a rename that completes but is then killed by a group signal still restores the previous plugin',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const mv = realTool('mv');
    // Real side effect first, then the signal reaches both the installer and this command.
    fakeTool(box.bin, 'mv', [`${mv} "$@"; rc=$?`,
      'case "$1" in *"/.cm-workflow.stage."*) kill -TERM "$PPID"; kill -TERM $$ ;; esac', 'exit $rc']);
    const result = install(box.env, ['--yes']);
    assert.equal(result.status, 143, output(result));
    assert.deepEqual(fs.readFileSync(box.pluginJson), box.before.json, 'the previous plugin is back');
    assert.deepEqual(fs.readFileSync(path.join(box.plugin, MANIFEST)), box.before.manifest);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace);
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
    assert.deepEqual(pluginsLeftovers(box.plugin), []);
  });

test('codex fault: a failing rollback step still restores the marketplace, unlocks and keeps the previous plugin',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const mv = realTool('mv');
    fakeTool(box.bin, 'codex', ['exit 17']);
    fakeTool(box.bin, 'mv', ['case "$2" in *"/.cm-workflow.failed."*) exit 1 ;; esac', `exec ${mv} "$@"`]);
    const result = install(box.env, ['--yes']);
    assert.equal(result.status, 17, output(result));
    assert.match(result.stderr, /rollback is incomplete/);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace, 'later restores still run');
    assert.equal(fs.existsSync(lockOf(box.plugin)), false, 'the lock is released even when the rollback is incomplete');
    const kept = pluginsLeftovers(box.plugin).filter(name => name.startsWith('.cm-workflow.backup.'));
    assert.equal(kept.length, 1, 'the previous plugin must be kept');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(box.plugin), kept[0], '.codex-plugin/plugin.json')), box.before.json);
    assert.match(result.stderr, new RegExp(kept[0].replace(/\./g, '\\.')));
  });

test('codex fault: an edit landing right before the old plugin is renamed aside is caught there and the plugin is put back',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const edited = path.join(box.plugin, EDITED);
    const handEdit = fs.readFileSync(edited, 'utf8') + '\n<!-- edited during the install -->\n';
    const hook = writeHook(box.home, ['[ "$1" = before-plugin-rename ] || exit 0',
      `printf '\\n<!-- edited during the install -->\\n' >> '${edited}'`]);
    const result = install({...box.env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 3, output(result));
    assert.match(result.stderr, /changed during the install/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit);
    assert.deepEqual(fs.readFileSync(path.join(box.plugin, MANIFEST)), box.before.manifest);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace);
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
    assert.deepEqual(pluginsLeftovers(box.plugin), []);
  });

test('codex path safety: a marketplace parent swapped for a symlink before the marketplace is written is refused',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const elsewhere = path.join(box.home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'marketplace.json'), '{"name":"someone-else","plugins":[]}\n');
    const parent = path.dirname(box.marketplace);
    const hook = writeHook(box.home, ['[ "$1" = before-marketplace-check ] || exit 0',
      `mv '${parent}' '${parent}.moved'`, `ln -s '${elsewhere}' '${parent}'`]);
    const result = install({...box.env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /symlinked or wrong-type install path/);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'marketplace.json'), 'utf8'), '{"name":"someone-else","plugins":[]}\n');
    assert.deepEqual(fs.readFileSync(path.join(`${parent}.moved`, 'marketplace.json')), box.before.marketplace);
    assert.deepEqual(fs.readFileSync(box.pluginJson), box.before.json);
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
    assert.deepEqual(pluginsLeftovers(box.plugin), []);
  });

test('codex fault: a marketplace that became a directory is not "restored" into it; the backup is kept and reported',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    fakeTool(box.bin, 'codex', [`rm -f '${box.marketplace}'`, `mkdir '${box.marketplace}'`, 'exit 17']);
    const result = install(box.env, ['--yes']);
    assert.equal(result.status, 17, output(result));
    assert.match(result.stderr, /rollback is incomplete/);
    assert.ok(fs.statSync(box.marketplace).isDirectory());
    assert.deepEqual(fs.readdirSync(box.marketplace), [], 'nothing may be copied into the directory');
    const kept = pluginsLeftovers(box.plugin).filter(name => name.startsWith('.cm-workflow.marketplace.backup.'));
    assert.equal(kept.length, 1, 'the marketplace backup must be kept');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(box.plugin), kept[0])), box.before.marketplace);
    assert.deepEqual(fs.readFileSync(box.pluginJson), box.before.json, 'the previous plugin is still restored');
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
  });

test('codex path safety: a plugins directory replaced by a symlink during the install stops at the next check',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const plugins = path.dirname(box.plugin);
    const elsewhere = path.join(box.home, 'elsewhere-plugins');
    fs.mkdirSync(elsewhere);
    const hook = writeHook(box.home, ['[ "$1" = before-marketplace-check ] || exit 0',
      `mv '${plugins}' '${plugins}.moved'`, `ln -s '${elsewhere}' '${plugins}'`]);
    const result = install({...box.env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /no longer the one checked at start/);
    assert.match(result.stderr, /lock location cannot be confirmed/);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing may be written through the replaced directory');
    const moved = path.join(`${plugins}.moved`, 'cm-workflow');
    assert.deepEqual(fs.readFileSync(path.join(moved, '.codex-plugin/plugin.json')), box.before.json);
    assert.deepEqual(fs.readFileSync(path.join(moved, MANIFEST)), box.before.manifest);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace);
  });

test('codex path safety: ~/.agents replaced by a symlink before the marketplace directory is created is refused there',
  {skip: process.platform === 'win32', timeout: 300000}, t => {
    const {home, plugin, env} = sandbox(t);
    const elsewhere = path.join(home, 'elsewhere-agents');
    const hook = writeHook(home, ['[ "$1" = before-marketplace-check ] || exit 0',
      `mkdir '${elsewhere}'`, `ln -s '${elsewhere}' '${path.join(home, '.agents')}'`]);
    const result = install({...env, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /symlinked or wrong-type install path/);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'no directory may be created through the symlink');
    assert.equal(fs.existsSync(plugin), false);
    assert.equal(fs.existsSync(lockOf(plugin)), false);
  });

test('codex fault: an unreadable scan file during the last check stops the install instead of reporting no edits',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const tmp = path.join(box.home, 'tmp');
    fs.mkdirSync(tmp);
    const edited = path.join(box.plugin, EDITED);
    const handEdit = fs.readFileSync(edited, 'utf8') + '\n<!-- edited during the install -->\n';
    // Right before the last scan: a hand edit lands, and the scan's own list becomes write-only.
    const hook = writeHook(box.home, ['[ "$1" = before-plugin-rename ] || exit 0',
      `printf '\\n<!-- edited during the install -->\\n' >> '${edited}'`,
      `for work in '${tmp}'/cm-install-guard.*; do : > "$work/recorded-paths"; chmod 0200 "$work/recorded-paths"; done`]);
    const result = install({...box.env, TMPDIR: tmp, CM_INSTALL_TEST_HOOK: hook}, ['--yes']);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /changed during the install/);
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'the hand edit must not be replaced');
    assert.deepEqual(fs.readFileSync(path.join(box.plugin, MANIFEST)), box.before.manifest);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace);
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
    assert.deepEqual(pluginsLeftovers(box.plugin), []);
  });

test('codex access: a hand-edited file under a directory that cannot be searched stops the install',
  {skip: process.platform === 'win32' || process.getuid?.() === 0, timeout: 600000}, t => {
    const box = installedCodexClone(t);
    const edited = path.join(box.plugin, EDITED);
    const handEdit = fs.readFileSync(edited, 'utf8') + '\n<!-- hand edit -->\n';
    fs.writeFileSync(edited, handEdit);
    const hidden = path.dirname(edited);
    fs.chmodSync(hidden, 0o644);
    t.after(() => { if (fs.existsSync(hidden)) fs.chmodSync(hidden, 0o755); });
    const result = install(box.env, ['--yes']);
    fs.chmodSync(hidden, 0o755);
    assert.equal(result.status, 2, output(result));
    assert.equal(fs.readFileSync(edited, 'utf8'), handEdit, 'the hand edit must not be replaced');
    assert.deepEqual(fs.readFileSync(path.join(box.plugin, MANIFEST)), box.before.manifest);
    assert.deepEqual(fs.readFileSync(box.marketplace), box.before.marketplace);
    assert.equal(fs.existsSync(lockOf(box.plugin)), false);
    assert.deepEqual(pluginsLeftovers(box.plugin), []);
  });
