// Installers and the skill-hints copy: the hook runs ~/.cm-workflow/skill-hints/,
// which only `enable` used to write, so an upgrade left enabled users on the old
// table (real case 2026-10-24, after PR #242). A reinstall must refresh that copy
// for users who turned hints on, and create nothing for those who did not.
// Every run uses a disposable HOME; the Codex run uses stub creator and CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const COPIED = ['cm-skill-hints.mjs', 'cm-skill-hints.json', 'cm-matt-skills.mjs', 'cm-config-lock.mjs'];
const STUB_CREATOR = `import json, pathlib, sys
args = sys.argv[1:]
path = pathlib.Path(args[args.index('--marketplace-path') + 1])
data = json.loads(path.read_text()) if path.exists() else {'name': 'personal', 'plugins': [{'name': 'cm-workflow'}]}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data) + '\\n')
`;

function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-skill-hints-install-')));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const codexHome = path.join(home, '.codex');
  const creator = path.join(codexHome, 'skills/.system/plugin-creator/scripts');
  fs.mkdirSync(creator, {recursive: true});
  fs.writeFileSync(path.join(creator, 'create_basic_plugin.py'), STUB_CREATOR);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const env = {...process.env, HOME: home, CLAUDE_HOME: path.join(home, '.claude'), CODEX_HOME: codexHome,
    PATH: `${bin}:${process.env.PATH}`,
    CM_WORKFLOW_HOME: path.join(home, 'workflow'), CM_WORKFLOW_LOG_HOME: path.join(home, 'logs')};
  delete env.CM_SKILL_HINTS;
  return {home, env, copy: path.join(home, 'workflow/skill-hints'),
    settings: path.join(home, '.claude/settings.json'), hooks: path.join(codexHome, 'hooks.json'),
    trust: path.join(codexHome, 'config.toml'), log: path.join(home, 'logs/skill-hints.jsonl')};
}

function install(script, env) {
  return spawnSync('/bin/bash', [path.join(source, script), '--yes'],
    {cwd: source, env, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, input: ''});
}

const output = result => result.stdout + result.stderr;
const bytesOf = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const wiredConfig = (box, host) => JSON.stringify({hooks: {UserPromptSubmit: [{hooks: [{type: 'command',
  command: `/usr/bin/node ${path.join(box.copy, 'cm-skill-hints.mjs')} hook --host ${host}`, timeout: 5}]}]}}, null, 2) + '\n';

// An enabled user mid-trial: an old copy, session state, a log and Codex trust.
function enabledUser(box, host) {
  fs.mkdirSync(path.join(box.copy, 'state'), {recursive: true});
  for (const name of COPIED) fs.writeFileSync(path.join(box.copy, name), '// old version\n');
  fs.writeFileSync(path.join(box.copy, 'state/0123456789abcdef.json'), '{"hinted":["cm-fix"],"pending":[]}');
  fs.mkdirSync(path.dirname(box.log), {recursive: true});
  fs.writeFileSync(box.log, '{"event":"hint"}\n');
  fs.writeFileSync(box.trust, '[hooks.state]\nx = "trusted"\n');
  const file = host === 'codex' ? box.hooks : box.settings;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, wiredConfig(box, host));
  return [path.join(box.copy, 'state/0123456789abcdef.json'), box.log, box.trust, file].map(bytesOf);
}

const KEPT = (box, host) => [path.join(box.copy, 'state/0123456789abcdef.json'), box.log, box.trust,
  host === 'codex' ? box.hooks : box.settings];

for (const [script, scripts, host] of [
  ['install.sh', box => path.join(box.home, '.claude/scripts'), 'claude'],
  ['install-codex.sh', box => path.join(box.home, 'plugins/cm-workflow/scripts'), 'codex'],
]) {
  test(`${script}: an enabled user's skill-hints copy is refreshed; configs, trust, state and logs are kept`,
    {skip: process.platform === 'win32', timeout: 600000}, t => {
      const box = sandbox(t);
      const before = enabledUser(box, host);
      const result = install(script, box.env);
      assert.equal(result.status, 0, output(result));
      for (const name of COPIED) {
        // A boolean, so a failure names the file instead of dumping both copies.
        assert.ok(fs.readFileSync(path.join(box.copy, name)).equals(fs.readFileSync(path.join(scripts(box), name))),
          `${name} not refreshed`);
      }
      assert.deepEqual(KEPT(box, host).map(bytesOf), before);
    });

  test(`${script}: a user who never enabled hints gets no copy and no hint hook`,
    {skip: process.platform === 'win32', timeout: 600000}, t => {
      const box = sandbox(t);
      const result = install(script, box.env);
      assert.equal(result.status, 0, output(result));
      assert.ok(!fs.existsSync(box.copy));
      for (const file of [box.settings, box.hooks]) assert.doesNotMatch(bytesOf(file) ?? '', /cm-skill-hints/);
    });
}

test('install.sh: a failed refresh only warns; the install still succeeds',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = sandbox(t);
    enabledUser(box, 'claude');
    fs.rmSync(path.join(box.copy, 'cm-config-lock.mjs'));
    fs.mkdirSync(path.join(box.copy, 'cm-config-lock.mjs/blocker'), {recursive: true});
    const result = install('install.sh', box.env);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /⚠.*技能提醒.*未刷新/);
    assert.equal(fs.readFileSync(path.join(box.copy, 'cm-skill-hints.mjs'), 'utf8'), '// old version\n');
  });
