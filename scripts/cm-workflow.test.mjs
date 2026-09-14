import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from './cm-workflow.mjs';

function invoke(args, overrides = {}) {
  const calls = [], messages = [];
  const status = main(args, { platform: 'darwin', nodeVersion: '24.14.0',
    run: (...call) => { calls.push(call); return { status: 0 }; },
    out: text => messages.push(text), error: text => messages.push(text), ...overrides });
  return { status, calls, messages };
}

test('help and invalid arguments never start installation', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    assert.equal(invoke(args).status, 0);
    assert.equal(invoke(args).calls.length, 0);
  }
  for (const args of [['--yes'], ['update'], ['install', '--unknown'], ['install', '--yes', 'extra']]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.calls.length, 0);
  }
});

test('install preserves prompts, forwards only explicit yes, and uses package-relative script', () => {
  for (const args of [['install'], ['install', '--yes']]) {
    const { status, calls } = invoke(args);
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/bin/bash');
    assert.match(calls[0][1][0], /\/install-codex\.sh$/);
    assert.deepEqual(calls[0][1].slice(1), args.slice(1));
    assert.deepEqual(calls[0][2], { stdio: 'inherit' });
  }
});

test('unsupported platforms and old Node stop before filesystem installation', () => {
  for (const overrides of [{ platform: 'win32' }, { platform: 'linux' },
    { nodeVersion: '18.20.0' }, { nodeVersion: '24.13.0' }]) {
    const result = invoke(['install'], overrides);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 0);
  }
});

test('installer failure and interruption never report success', () => {
  for (const result of [{ status: 7 }, { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('spawn failed') }]) {
    assert.equal(invoke(['install'], { run: () => result }).status, result.status ?? 1);
  }
});
