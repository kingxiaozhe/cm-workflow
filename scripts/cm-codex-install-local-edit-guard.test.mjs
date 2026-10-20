// Codex installer: replacing ~/plugins/cm-workflow must stop on files
// hand-edited since the last install, even with --yes. Runs in a disposable
// HOME/CODEX_HOME with a stub plugin creator and a stub `codex` CLI, so it
// never touches the real ~/plugins, ~/.agents or ~/.codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = '.cm-install-manifest.sha256';
const EDITED = 'skills/cm-check/SKILL.md';

const STUB_CREATOR = `import json, pathlib, sys
args = sys.argv[1:]
path = pathlib.Path(args[args.index('--marketplace-path') + 1])
if not path.exists():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'name': 'personal', 'plugins': [{'name': 'cm-workflow'}]}) + '\\n')
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
    CM_WORKFLOW_HOME: path.join(home, 'workflow'), CM_WORKFLOW_LOG_HOME: path.join(home, 'logs')};
  return {plugin: path.join(home, 'plugins/cm-workflow'), env};
}

function install(env, args) {
  return spawnSync('/bin/bash', [path.join(source, 'install-codex.sh'), ...args],
    {cwd: source, env, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, input: ''});
}

const output = result => result.stdout + result.stderr;

test('codex install manifest: first install records hashes, unchanged reinstall passes, --yes cannot overwrite a hand edit, --overwrite-local-edits can',
  {skip: process.platform === 'win32', timeout: 900000}, t => {
    const {plugin, env} = sandbox(t);
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
    fs.writeFileSync(edited, handEdit);
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
  });
