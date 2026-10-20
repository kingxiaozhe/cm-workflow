// Claude-compatible installer: a reinstall must stop on files hand-edited since
// the last install, even with --yes (real incident: another session's
// `./install.sh --yes` silently overwrote an approved edit to
// ~/.claude/scripts/cm-ai-host.mjs). Every run uses a disposable HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
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

test('install manifest: first install records hashes, unchanged reinstall passes, --yes cannot overwrite a hand edit, --overwrite-local-edits can',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
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
    fs.writeFileSync(edited, handEdit);
    const manifestBefore = fs.readFileSync(manifest, 'utf8');

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
