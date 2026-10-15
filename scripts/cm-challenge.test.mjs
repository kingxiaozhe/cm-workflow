// Source/distribution checks only; model behavior is exercised separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const entry = 'skills/cm-challenge/SKILL.md';

test('cm-challenge is discoverable through Pi, Codex and the thin Claude alias', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.pi.skills.filter(p => p === './skills/cm-challenge').length, 1);
  assert.ok(pkg.files.includes('skills') && pkg.files.includes('runtime') && pkg.files.includes('compat'));
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(plugin.skills, './skills/');
  const skill = read(entry);
  assert.match(skill, /^---\nname: cm-challenge\ndescription: [^\n]+\n---\n/);
  const alias = read('compat/claude-commands/cm-challenge.md');
  assert.ok(alias.trim().split('\n').length <= 8);
  assert.ok(alias.includes('skills/cm-challenge/SKILL.md'));
  assert.ok(alias.includes('$ARGUMENTS'));
});

test('cm-challenge references resolve from a relocated package without personal Skills', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-challenge-source-'));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  for (const file of [entry, 'skills/cm-challenge/references/examples.md', 'runtime/steelman-review.md']) {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, file), target);
  }
  const skill = fs.readFileSync(path.join(temp, entry), 'utf8');
  const refs = [...skill.matchAll(/`(\.\.\/[^`]+\.md)`|\]\((references\/[^)]+\.md)\)/g)]
    .map(match => match[1] ?? match[2]);
  assert.ok(refs.includes('../../runtime/steelman-review.md'), 'must reuse the shared reasoning contract');
  assert.ok(refs.includes('references/examples.md'));
  for (const ref of refs) {
    const resolved = path.resolve(temp, path.dirname(entry), ref);
    assert.ok(resolved.startsWith(`${temp}${path.sep}`));
    assert.ok(fs.statSync(resolved).isFile(), ref);
  }
  assert.equal(fs.existsSync(path.join(temp, 'runtime/js')), false);
});

test('registered entry sets and documented count stay aligned', () => {
  const pkg = JSON.parse(read('package.json'));
  const entries = pkg.pi.skills.map(p => p.split('/').at(-1));
  const validator = read('scripts/validate-public-repo.py').match(/CORE_SKILLS = \(([\s\S]*?)\n\)/)[1];
  const registered = [...validator.matchAll(/"(cm-[a-z-]+)"/g)].map(m => m[1]);
  assert.deepEqual([...registered].sort(), [...entries].sort());
  const checker = read('scripts/cm-check-runtime.sh').match(/for name in (cm-[^;]+); do/)[1].split(' ');
  assert.deepEqual([...checker].sort(), [...entries].sort());
  assert.ok(read('README.md').includes(`入口目录与计数：${entries.length} 个核心入口`));
  for (const name of entries) {
    assert.ok(fs.existsSync(path.join(root, `skills/${name}/SKILL.md`)));
    assert.ok(fs.existsSync(path.join(root, `compat/claude-commands/${name}.md`)));
  }
});
