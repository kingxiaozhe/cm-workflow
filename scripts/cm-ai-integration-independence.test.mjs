import test from 'node:test';
import assert from 'node:assert/strict';
import {integrationReviewIndependent} from '../runtime/js/cm-ai/reviewed-integration.mjs';

const base={reviewRunId:'run-review',targetRunId:'run-target',hostContextId:'ctx-1',authorContextId:'ctx-1',
  reviewerProvider:'claude',authorProvider:'codex',reviewerThreadId:'thread-r',
  previousThreads:['thread-old'],developerThreadId:'thread-dev'};

test('integration review independence: different tool passes', ()=>{
  assert.equal(integrationReviewIndependent(base),true);
});

test('integration review independence: same tool as author is rejected', ()=>{
  assert.equal(integrationReviewIndependent({...base,reviewerProvider:'codex'}),false);
  assert.equal(integrationReviewIndependent({...base,reviewerProvider:'claude',authorProvider:'claude'}),false);
});

test('integration review independence: reused run, context or threads are rejected', ()=>{
  assert.equal(integrationReviewIndependent({...base,reviewRunId:'run-target'}),false);
  assert.equal(integrationReviewIndependent({...base,hostContextId:'ctx-2'}),false);
  assert.equal(integrationReviewIndependent({...base,reviewerThreadId:'thread-old'}),false);
  assert.equal(integrationReviewIndependent({...base,reviewerThreadId:'thread-dev'}),false);
});
