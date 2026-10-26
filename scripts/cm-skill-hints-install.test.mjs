// Installers and the skill-hints copy: the hook runs ~/.cm-workflow/skill-hints/,
// which only `enable` used to write, so an upgrade left enabled users on the old
// table (real case 2026-10-24, after PR #242). A reinstall must refresh that copy
// for users who turned hints on. Since 2026-10-25 a first install also wires the hook
// for its own host, unless the user opted out or removed the hook earlier.
// Every run uses a disposable HOME; the Codex run uses stub creator and CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const COPIED = ['cm-skill-hints.mjs', 'cm-skill-hints.json', 'cm-matt-skills.mjs', 'cm-config-lock.mjs', 'cm-skill-judge.mjs'];
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
  delete env.CM_SKILL_HINTS_INSTALL;
  delete env.TYPESAFE_API_KEY;
  return {home, env, copy: path.join(home, 'workflow/skill-hints'),
    settings: path.join(home, '.claude/settings.json'), hooks: path.join(codexHome, 'hooks.json'),
    trust: path.join(codexHome, 'config.toml'), log: path.join(home, 'logs/skill-hints.jsonl')};
}

function install(script, env, args = ['--yes']) {
  return spawnSync('/bin/bash', [path.join(source, script), ...args],
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

  test(`${script}: a first install wires the hint hook for its own host only and says how to turn it off`,
    {skip: process.platform === 'win32', timeout: 600000}, t => {
      const box = sandbox(t);
      const result = install(script, box.env);
      assert.equal(result.status, 0, output(result));
      const own = host === 'codex' ? box.hooks : box.settings;
      const other = host === 'codex' ? box.settings : box.hooks;
      assert.match(bytesOf(own) ?? '', new RegExp(`skill-hints/cm-skill-hints\\.mjs hook --host ${host}`));
      assert.doesNotMatch(bytesOf(other) ?? '', /cm-skill-hints/);
      assert.ok(fs.existsSync(path.join(box.copy, 'cm-skill-hints.mjs')));
      assert.match(output(result), /已给 (Claude|Codex) 挂上技能提醒钩子.*--no-skill-hints.*TypeSafe/);
      if (host === 'codex') assert.match(output(result), /确认信任/);
      assert.ok(!fs.existsSync(box.trust) || !/cm-skill-hints/.test(bytesOf(box.trust)), 'CM never trusts the hook for the user');
    });
}

test('install.sh --no-skill-hints wires nothing and makes no copy',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = sandbox(t);
    const result = install('install.sh', box.env, ['--yes', '--no-skill-hints']);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /没给 Claude 挂钩子.*只管这一次/);
    assert.ok(!fs.existsSync(box.copy));
    assert.doesNotMatch(bytesOf(box.settings) ?? '', /cm-skill-hints/);
  });

test('install-codex.sh with CM_SKILL_HINTS_INSTALL=off wires nothing; --no-skill-hints is accepted',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = sandbox(t);
    const result = install('install-codex.sh', {...box.env, CM_SKILL_HINTS_INSTALL: 'off'});
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /CM_SKILL_HINTS_INSTALL=off/);
    assert.ok(!fs.existsSync(box.copy));
    assert.doesNotMatch(bytesOf(box.hooks) ?? '', /cm-skill-hints/);
    const flagged = install('install-codex.sh', box.env, ['--yes', '--no-skill-hints']);
    assert.equal(flagged.status, 0, output(flagged));
    assert.doesNotMatch(bytesOf(box.hooks) ?? '', /cm-skill-hints/);
  });

test('install.sh does not add back a hook the user removed',
  {skip: process.platform === 'win32', timeout: 600000}, t => {
    const box = sandbox(t);
    // Wired once by an earlier install, then taken out by the user.
    fs.mkdirSync(box.copy, {recursive: true});
    fs.writeFileSync(path.join(box.home, 'workflow/skill-hints.auto.json'), '{"version":1,"hosts":["claude"]}\n');
    fs.mkdirSync(path.dirname(box.settings), {recursive: true});
    fs.writeFileSync(box.settings, '{"hooks":{"UserPromptSubmit":[]}}\n');
    const result = install('install.sh', box.env);
    assert.equal(result.status, 0, output(result));
    assert.equal(bytesOf(box.settings), '{"hooks":{"UserPromptSubmit":[]}}\n');
    assert.match(output(result), /之前挂过后被移除/);
  });

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
test('install.ps1 wires the Claude hook by default and not with -NoSkillHints',
  {skip: !pwsh && 'pwsh not available', timeout: 600000}, t => {
    for (const [args, wired] of [[['-NoSkillHints'], false], [[], true]]) {
      const box = sandbox(t);
      const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(source, 'install.ps1'), '-Yes', ...args],
        {cwd: source, env: {...box.env, USERPROFILE: box.home}, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, input: ''});
      assert.equal(result.status, 0, output(result));
      assert.equal(/skill-hints\/cm-skill-hints\.mjs hook --host claude/.test(bytesOf(box.settings) ?? ''), wired, output(result));
      assert.equal(fs.existsSync(box.copy), wired);
    }
  });

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
