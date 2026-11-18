import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseCallTimeoutMinutes,callTimeoutFrom,DEFAULT_CALL_TIMEOUT_MS} from '../runtime/js/cm-ai/call-timeout.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {sameRunnerConfig} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

test('--call-timeout-minutes 只收 30–60 的整数分钟；缺省为 null（沿用 30 分钟）', () => {
  assert.equal(parseCallTimeoutMinutes(undefined), null);
  assert.equal(parseCallTimeoutMinutes('30'), 1800000);
  assert.equal(parseCallTimeoutMinutes('60'), 3600000);
  for (const bad of ['29', '61', '45.5', '045', '', 'x', '600'])
    assert.throws(() => parseCallTimeoutMinutes(bad), {code: 'invalid_arguments'}, bad);
  assert.equal(callTimeoutFrom(['--feature', 'f', '--call-timeout-minutes', '55']), 3300000);
  assert.equal(callTimeoutFrom(['--feature', 'f']), null);
  assert.throws(() => callTimeoutFrom(['--call-timeout-minutes']), {code: 'invalid_arguments'});
});

test('当前会话运行的调用期限：默认 30 分钟，传入 callTimeoutMs 时用它；范围外拒绝', () => {
  const definition = {codeProject: here, specsDir: here, feature: '1.f', identity: {repositoryId: 'r', runId: 'x', taskId: 'T-001', attempt: 1},
    scope: ['a.js'], requirements: []};
  const bridge = {call: () => assert.fail('unexpected host call')};
  assert.equal(createConversationExecution(definition, 'h', bridge).timeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  assert.equal(createConversationExecution(definition, 'h', bridge, null, null, null, false, 'codex', {callTimeoutMs: 3600000}).timeoutMs, 3600000);
  for (const bad of [1799999, 3600001, 2000000.5])
    assert.throws(() => createConversationExecution(definition, 'h', bridge, null, null, null, false, 'codex', {callTimeoutMs: bad}), undefined, String(bad));
});

test('宿主与驱动都接上了这个参数（静态核对，防止只改一处）', () => {
  const host = fs.readFileSync(path.join(here, 'cm-ai-host.mjs'), 'utf8');
  assert.match(host, /'--call-timeout-minutes'/);
  assert.match(host, /callTimeoutMs/);
  const drive = fs.readFileSync(path.join(here, 'cm-ai-drive.mjs'), 'utf8');
  assert.match(drive, /'--call-timeout-minutes'/);
});

test('落盘回放只对当前会话运行放宽期限比对；其余字段与受保护／外部模型运行仍逐字节比对', () => {
  const base = {root: '/r', timeoutMs: 1800000, developer: {provider: 'claude', requestedModel: 'current-session', contextId: 'c'}};
  assert.doesNotThrow(() => sameRunnerConfig(base, {...base, timeoutMs: 3600000}));
  assert.throws(() => sameRunnerConfig({...base, timeoutMs: 3600000}, base), {code: 'invalid_arguments'});
  assert.throws(() => sameRunnerConfig(base, {...base, root: '/other', timeoutMs: 3600000}), {code: 'runner_history_mismatch'});
  assert.throws(() => sameRunnerConfig(base, {...base, timeoutMs: 3600001}), {code: 'runner_history_mismatch'});
  const provider = {...base, developer: {...base.developer, requestedModel: 'gpt-x'}};
  assert.throws(() => sameRunnerConfig(provider, {...provider, timeoutMs: 3600000}), {code: 'runner_history_mismatch'});
  assert.throws(() => sameRunnerConfig(base, {...provider, timeoutMs: 1800000}), {code: 'runner_history_mismatch'});
});

test('期限不进执行配置：同一运行定义下 30 与 60 分钟的配置字节相同', () => {
  const definition = {codeProject: here, specsDir: here, feature: '1.f', identity: {repositoryId: 'r', runId: 'x', taskId: 'T-001', attempt: 1},
    scope: ['a.js'], requirements: []};
  const bridge = {call: () => assert.fail('unexpected host call')};
  const a = createConversationExecution(definition, 'h', bridge), b = createConversationExecution(definition, 'h', bridge, null, null, null, false, 'codex', {callTimeoutMs: 3600000});
  assert.deepEqual(b.configuration, a.configuration);
});

test('受保护会话与外部模型运行不接受期限放宽：构造入口拒绝，回放不忽略外部模型运行的期限差异；重复参数非法', () => {
  const definition = {codeProject: here, specsDir: here, feature: '1.f', identity: {repositoryId: 'r', runId: 'x', taskId: 'T-001', attempt: 1},
    scope: ['a.js'], requirements: []};
  const bridge = {call: () => assert.fail('unexpected host call')};
  assert.throws(() => createConversationExecution(definition, 'h', bridge, null, null, null, false, 'codex', {callTimeoutMs: 3600000, protection: {checkCommands: [], timeoutMs: 600000}}),
    {code: 'invalid_input'});
  const external = {root: '/r', timeoutMs: 1800000, externalModels: {version: 1},
    developer: {provider: 'claude', requestedModel: 'current-session', contextId: 'c'}};
  assert.throws(() => sameRunnerConfig(external, {...external, timeoutMs: 3600000}), {code: 'runner_history_mismatch'});
  assert.throws(() => callTimeoutFrom(['--call-timeout-minutes', '60', '--call-timeout-minutes', '90']), {code: 'invalid_arguments'});
  assert.throws(() => callTimeoutFrom(['--call-timeout-minutes', '60', '--call-timeout-minutes', '60']), {code: 'invalid_arguments'});
});

test('宿主在加载外部模型快照与受保护会话配置之后拒绝期限放宽（静态核对顺序）', () => {
  const host = fs.readFileSync(path.join(here, 'cm-ai-host.mjs'), 'utf8');
  const load = host.indexOf('const externalModels=readLaunchExternalModels('), guard = host.indexOf("refuse(callTimeoutMs===null||!externalModels||argv[4]==='resume'");
  assert.ok(load > 0 && guard > load);
  assert.match(host, /refuse\(callTimeoutMs===null\|\|!protection,/);
});

test('恢复只可保持或放宽期限：缩短（含漏传）按参数名拒绝，不悄悄变短', () => {
  const base = {root: '/r', timeoutMs: 3600000, developer: {provider: 'claude', requestedModel: 'current-session', contextId: 'c'}};
  assert.doesNotThrow(() => sameRunnerConfig(base, base));
  assert.throws(() => sameRunnerConfig(base, {...base, timeoutMs: 1800000}),
    error => error.code === 'invalid_arguments' && /此运行已用 60 分钟，本次为 30 分钟/.test(error.reason));
});
