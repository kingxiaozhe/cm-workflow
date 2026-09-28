import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {readConversationReviewConfiguration,formatClaudeModelHint} from './cm-ai-host.mjs';
import {createConversationExecution,resolveReviewTimeout} from '../runtime/js/cm-ai/host-conversation-execution.mjs';

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

test('review config remains valid without a budget for legacy runs', () => {
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

test('explicit protected budget stays effective when review config omits one', () => {
  assert.deepEqual(resolveReviewTimeout({model:'fixture'},{timeoutMs:90000}),{timeoutMs:90000});
});

test('no budget anywhere uses the review default', () => {
  assert.deepEqual(resolveReviewTimeout(null,null),{timeoutMs:900000});
  assert.deepEqual(resolveReviewTimeout({model:'fixture'},null),{timeoutMs:900000});
});

test('unrecognized Claude model hint names the rejected id and a family alias',()=>{
  const hint=formatClaudeModelHint({model:'claude-opus-5-1',preflight:{request_checks:[
    {model_recognized:false,reported_model:'claude-opus-5-1'}]}},'2.1.274 (Claude Code)');
  assert.match(hint,/claude-opus-5-1/);assert.match(hint,/2\.1\.274/);
  assert.match(hint,/claude-opus-5/);assert.match(hint,/installed Claude CLI/);
  assert.equal(formatClaudeModelHint({preflight:{request_checks:[]}},null),null);
});

test('review timeout changes do not alter the authorized execution configuration',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-fingerprint-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(specsDir);
  const definition={codeProject,specsDir,feature:'1.work',identity:{repositoryId:'fixture',runId:'run',taskId:'T-001',attempt:1},
    scope:['code.js'],requirements:[]};
  const bridge={call:()=>assert.fail('no host call expected')};
  const review={model:'fixture',disabledSkills:[],preflight};
  const earlier=createConversationExecution(definition,'host-fixture',bridge,{...review,timeoutMs:60000});
  const later=createConversationExecution(definition,'host-fixture',bridge,{...review,timeoutMs:900000});
  assert.deepEqual(earlier.configuration,later.configuration);
});
