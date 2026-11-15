import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parseCallTimeoutMinutes,callTimeoutFrom,DEFAULT_CALL_TIMEOUT_MS} from '../runtime/js/cm-ai/call-timeout.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';

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
