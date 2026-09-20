import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {readConversationReviewConfiguration} from './cm-ai-host.mjs';
import {resolveReviewTimeout} from '../runtime/js/cm-ai/host-conversation-execution.mjs';

const preflight={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:'x'};

function configFile(value){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-timeout-'));
  const file=path.join(root,'review.json');
  fs.writeFileSync(file,JSON.stringify(value));
  return file;
}

test('review config accepts an explicit reviewer transport budget', () => {
  const config=readConversationReviewConfiguration(configFile({model:'fixture',preflight,timeoutMs:600000}));
  assert.equal(config.timeoutMs,600000);
});

test('review config stays valid without a budget', () => {
  const config=readConversationReviewConfiguration(configFile({model:'fixture',preflight}));
  assert.equal(Object.hasOwn(config,'timeoutMs'),false);
});

test('review config rejects budgets outside the shared call-timeout range', () => {
  for(const timeoutMs of [0,-1,3600001,1.5,'600000',null]){
    assert.throws(()=>readConversationReviewConfiguration(configFile({model:'fixture',preflight,timeoutMs})),
      error=>error.code==='invalid_review_config',`expected rejection for ${String(timeoutMs)}`);
  }
});

test('review config accepts both range boundaries', () => {
  for(const timeoutMs of [1,3600000]){
    assert.equal(readConversationReviewConfiguration(configFile({model:'fixture',preflight,timeoutMs})).timeoutMs,timeoutMs);
  }
});

test('an explicit reviewer budget wins over the protected-mode budget', () => {
  assert.deepEqual(resolveReviewTimeout({timeoutMs:600000},{timeoutMs:90000}),{timeoutMs:600000});
});

test('protected mode still supplies the budget when review config omits one', () => {
  assert.deepEqual(resolveReviewTimeout({model:'fixture'},{timeoutMs:90000}),{timeoutMs:90000});
});

test('no budget anywhere leaves the worker default untouched', () => {
  assert.deepEqual(resolveReviewTimeout(null,null),{});
  assert.deepEqual(resolveReviewTimeout({model:'fixture'},null),{});
});
