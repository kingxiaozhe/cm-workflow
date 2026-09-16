import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compareVersions, updateInstallation} from './cm-check-update.mjs';

function fixture(t, runtime = 'codex') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-update-test-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const root = path.join(home, runtime === 'codex' ? 'plugins/cm-workflow' : '.claude');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
  const versionFile = runtime === 'codex' ? 'VERSION' : 'templates/cm-VERSION';
  write(path.join(root, versionFile), '0.10.6\n');
  write(path.join(root, 'skills/cm-check/SKILL.md'), '# cm-check');
  write(path.join(root, 'scripts/cm-check-host.mjs'), '// host');
  if (runtime === 'codex') write(path.join(home, '.agents/plugins/marketplace.json'), '{"name":"personal"}');
  const calls = [];
  const state = {home, root, write, calls, latest: '0.11.0', installerStatus: 0, writeVersion: true};
  state.options = {env: {HOME: home, npm_config_registry: 'https://invalid.example'}, platform: 'darwin',
    query: async () => state.latest,
    run: (command, args, options) => {
      calls.push({command, args, options});
      if (command === 'npm') {
        const source = path.join(options.cwd, 'node_modules/@aibyzero/cm-workflow');
        write(path.join(source, 'package.json'), JSON.stringify({name: '@aibyzero/cm-workflow', version: state.latest}));
        write(path.join(source, 'VERSION'), state.latest);
        write(path.join(source, runtime === 'codex' ? 'install-codex.sh' : 'install.sh'), '# installer');
        return {status: 0};
      }
      if (state.writeVersion) write(path.join(root, versionFile), state.latest);
      return {status: state.installerStatus};
    }};
  state.input = {skillDir: path.join(root, 'skills/cm-check'), runtime};
  return state;
}

test('stable version ordering is numeric and rejects tags, prereleases and shell input', () => {
  assert.equal(compareVersions('0.11.0', '0.9.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.11.0', '1.0.0'), -1);
  for (const version of ['latest', '01.2.3', '1.0.0-beta', '1.0.0;touch nope', '1.0.0\n']) {
    assert.throws(() => compareVersions(version, '1.0.0'));
  }
});

for (const runtime of ['codex', 'claude']) test(`${runtime}: default upgrade uses pinned npm and existing installer, then verifies disk`, async t => {
  const f = fixture(t, runtime);
  const report = await updateInstallation(f.input, f.options);
  assert.equal(report.status, 'updated');
  assert.equal(report.installed, '0.11.0');
  assert.equal(report.workflowRoot, f.root);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].args.includes('@aibyzero/cm-workflow@0.11.0'));
  assert.ok(f.calls[0].args.includes('--ignore-scripts'));
  assert.ok(f.calls[0].args.includes('--@aibyzero:registry=https://registry.npmjs.org/'));
  assert.equal(f.calls[0].options.env.npm_config_registry, undefined);
  assert.equal(f.calls[1].args[1], '--yes');
  assert.equal(f.calls[1].options.stdio[0], 'ignore');
  assert.equal(fs.existsSync(f.calls[0].options.cwd), false);
  assert.equal(fs.existsSync(`${f.root}.cm-check-update.lock`), false);
});

for (const latest of ['0.10.6', '0.9.0']) test(`no download when latest ${latest} is equal or older`, async t => {
  const f = fixture(t); f.latest = latest;
  assert.equal((await updateInstallation(f.input, f.options)).status, latest === '0.10.6' ? 'current' : 'ahead');
  assert.equal(f.calls.length, 0);
});

test('offline or invalid registry metadata permits local checks but never claims current', async t => {
  const f = fixture(t);
  for (const query of [async () => {throw new Error('network');}, async () => '1.0.0-beta']) {
    const report = await updateInstallation(f.input, {...f.options, query});
    assert.equal(report.status, 'offline');
    assert.equal(report.workflowRoot, f.root);
  }
  assert.equal(f.calls.length, 0);
});

test('source checkout and unknown package managers are never overwritten', async t => {
  const f = fixture(t);
  f.write(path.join(f.root, '.git'), 'gitdir: elsewhere');
  assert.equal((await updateInstallation(f.input, f.options)).status, 'unmanaged');
  fs.unlinkSync(path.join(f.root, '.git'));
  const moved = path.join(f.home, 'source'); fs.renameSync(f.root, moved);
  assert.equal((await updateInstallation({...f.input, skillDir: path.join(moved, 'skills/cm-check')}, f.options)).status, 'unmanaged');
  assert.equal(f.calls.length, 0);
});

test('old active cache checks newer managed installation without reinstalling or downgrading', async t => {
  const f = fixture(t);
  const cache = path.join(f.home, '.codex/plugins/cache/personal/cm-workflow/old');
  f.write(path.join(cache, 'VERSION'), '0.10.6');
  f.write(path.join(cache, 'skills/cm-check/SKILL.md'), '# old');
  f.write(path.join(f.root, 'VERSION'), '0.11.0');
  const input = {...f.input, skillDir: path.join(cache, 'skills/cm-check')};
  const report = await updateInstallation(input, f.options);
  assert.equal(report.status, 'current'); assert.equal(report.workflowRoot, f.root);
  assert.equal(report.installed, '0.11.0'); assert.equal(f.calls.length, 0);
  f.write(path.join(cache, 'VERSION'), '0.12.0');
  assert.equal((await updateInstallation(input, f.options)).status, 'blocked');
});

test('another upgrade completed before locking cannot be downgraded by stale registry data', async t => {
  const f = fixture(t), mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, options) => {
    if (dir === `${f.root}.cm-check-update.lock`) fs.writeFileSync(path.join(f.root, 'VERSION'), '0.12.0');
    return mkdir(dir, options);
  });
  const report = await updateInstallation(f.input, f.options);
  assert.equal(report.status, 'ahead'); assert.equal(report.installed, '0.12.0');
  assert.equal(f.calls.length, 0);
});

test('an external installer changing the version during download blocks the stale installer', async t => {
  const f = fixture(t), run = f.options.run;
  f.options.run = (...args) => {
    const result = run(...args);
    f.write(path.join(f.root, 'VERSION'), '0.12.0');
    return result;
  };
  assert.equal((await updateInstallation(f.input, f.options)).status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'VERSION'), 'utf8'), '0.12.0');
});

for (const [runtime, key] of [['codex', 'HOME'], ['codex', 'CODEX_HOME'], ['claude', 'CLAUDE_HOME']]) {
  test(`relative ${key} cannot redirect installation when cwd changes`, async t => {
    const f = fixture(t, runtime); f.options.env[key] = '.';
    const report = await updateInstallation(f.input, f.options);
    assert.equal(report.status, 'blocked'); assert.match(report.reason, /absolute path/);
    assert.equal(f.calls.length, 0);
  });
}

test('redirected marketplace ancestor is rejected even before its JSON file exists', async t => {
  const f = fixture(t), outside = path.join(f.home, 'redirected');
  fs.rmSync(path.join(f.home, '.agents'), {recursive: true}); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.home, '.agents'), 'dir');
  const report = await updateInstallation(f.input, f.options);
  assert.equal(report.status, 'blocked'); assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('marketplace symlink introduced during download cannot redirect the installer', async t => {
  const f = fixture(t), run = f.options.run;
  f.options.run = (...args) => {
    const result = run(...args), file = path.join(f.home, '.agents/plugins/marketplace.json');
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.home, 'not-created.json'), file);
    return result;
  };
  assert.equal((await updateInstallation(f.input, f.options)).status, 'blocked');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.home, 'not-created.json')), false);
});

for (const mode of ['failure', 'false-success', 'download-failure', 'wrong-package', 'lock', 'unsupported', 'symlink']) {
  test(`upgrade ${mode} is blocked without claiming success`, async t => {
    const f = fixture(t);
    if (mode === 'failure') { f.installerStatus = 1; f.writeVersion = false; }
    if (mode === 'false-success') f.writeVersion = false;
    if (mode === 'download-failure') f.options.run = () => ({status: 1});
    if (mode === 'wrong-package') {
      const run = f.options.run;
      f.options.run = (...args) => {
        const result = run(...args);
        f.write(path.join(args[2].cwd, 'node_modules/@aibyzero/cm-workflow/package.json'), '{"name":"other","version":"0.11.0"}');
        return result;
      };
    }
    if (mode === 'lock') fs.mkdirSync(`${f.root}.cm-check-update.lock`);
    if (mode === 'unsupported') f.options.platform = 'win32';
    if (mode === 'symlink') {
      const destination = path.join(f.home, 'redirected'); fs.renameSync(f.root, destination);
      fs.symlinkSync(destination, f.root, 'dir');
      // A canonical root outside the managed path is explicitly unmanaged.
      assert.equal((await updateInstallation(f.input, f.options)).status, 'unmanaged');
      assert.equal(f.calls.length, 0); return;
    }
    const report = await updateInstallation(f.input, f.options);
    assert.equal(report.status, 'blocked');
    assert.equal(fs.readFileSync(path.join(f.root, 'VERSION'), 'utf8').trim(), '0.10.6');
    if (mode === 'lock') assert.equal(fs.existsSync(`${f.root}.cm-check-update.lock`), true);
    else assert.equal(fs.existsSync(`${f.root}.cm-check-update.lock`), false);
  });
}
