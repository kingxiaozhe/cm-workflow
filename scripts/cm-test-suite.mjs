#!/usr/bin/env node
// One native sandbox inventory for CI exclusions, local runs and release smoke.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assignShards, readWeights} from './ci-test-shards.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const nativeTests = Object.freeze([
  'scripts/cm-ai-batch-host.test.mjs',
  'scripts/cm-ai-bootstrap.test.mjs',
  'scripts/cm-ai-host.test.mjs',
  'scripts/cm-ai-host-cli-workflow.test.mjs',
  'scripts/cm-ai-host-protected.test.mjs',
  'scripts/cm-ai-multi-root.test.mjs',
  'scripts/cm-ai-nested-execution.test.mjs',
  'scripts/cm-fix-protected-edits.test.mjs',
  'scripts/cm-host-check.test.mjs',
].sort());

export function inventory(repo = root) {
  const discover = dir => fs.readdirSync(path.join(repo, dir), {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => `${dir}/${entry.name}`).sort();
  const all = discover('scripts');
  const native = [...nativeTests];
  if (native.length !== 9 || new Set(native).size !== 9) throw new Error('native inventory must contain exactly nine unique tests');
  for (const file of native) if (!all.includes(file)) throw new Error(`missing native test: ${file}`);
  const ordinary = all.filter(file => !native.includes(file));
  const combined = [...ordinary, ...native];
  if (new Set(combined).size !== all.length || combined.length !== all.length ||
      combined.some(file => !all.includes(file))) throw new Error('test groups must cover scripts tests exactly once');
  const history = discover('experiments/js-orchestration');
  return {ordinary, native, history};
}

export function selectTests(groups, group, {shards, index} = {}) {
  if (!Object.hasOwn(groups, group)) throw new Error('group must be ordinary, native or history');
  const files = groups[group];
  if (shards === undefined && index === undefined) return files;
  if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(index) || index < 0 || index >= shards)
    throw new Error('--shards and --index must specify a positive count and an index in [0, shards)');
  return assignShards(files, shards, readWeights())[index].files;
}

async function runTests(files, concurrency) {
  if (files.length === 0) throw new Error('selected test group or shard is empty');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-suite-'));
  const workflowHome = path.join(temp, 'workflow'), logHome = path.join(temp, 'logs');
  fs.mkdirSync(workflowHome); fs.mkdirSync(logHome);
  const args = ['--test', ...(concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`]), ...files];
  let child, requestedSignal;
  const handlers = new Map();
  try {
    child = spawn(process.execPath, args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
      env: {...process.env, CM_WORKFLOW_HOME: workflowHome, CM_WORKFLOW_LOG_HOME: logHome}});
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        requestedSignal ??= signal;
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    });
    return {code: result.code ?? 1, signal: requestedSignal ?? result.signal};
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!['check', 'list', 'run'].includes(command)) throw new Error('usage: cm-test-suite.mjs check | list|run ordinary|native|history [--shards N --index I] [--concurrency N]');
  if (command === 'check') {
    if (rest.length) throw new Error('check takes no arguments');
    const groups = inventory();
    for (const [group, files] of Object.entries(groups)) process.stdout.write(`${group}: ${files.length} files\n`);
    return;
  }
  const group = rest.shift(), options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--shards', '--index', '--concurrency'].includes(key) || Object.hasOwn(options, key.slice(2)))
      throw new Error(`unknown or repeated option: ${key}`);
    if (!/^\d+$/.test(rest[i + 1] ?? '')) throw new Error(`invalid value for ${key}`);
    options[key.slice(2)] = Number(rest[i + 1]);
  }
  if (options.concurrency !== undefined && (command !== 'run' || !Number.isSafeInteger(options.concurrency) || options.concurrency < 1))
    throw new Error('--concurrency must be a positive integer for run');
  const files = selectTests(inventory(), group, options);
  if (command === 'list') { for (const file of files) process.stdout.write(`${file}\n`); return; }
  const result = await runTests(files, options.concurrency);
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`cm-test-suite: ${error.message}\n`); process.exitCode = 1; });
}
