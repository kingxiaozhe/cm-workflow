import test from 'node:test';
import {batchFixture} from './cm-ai-batch-run-fixture.mjs';

test('a strict-batch parallel member left unknown stays in its original run and is not rescheduled',async()=>{
  await batchFixture('parallel-unknown',{executionPolicy:true});
});
test('Q24 a strict-batch parallel member stopped at develop_redo recovers through the batch entry and merges',async()=>{
  await batchFixture('parallel-redo',{executionPolicy:true});
});
// Ordinary (non-strict) batches follow the same rules: an unconfirmed member stays in
// its original run with an explicit code and a member that can recover in its own run
// is not rescheduled past its stop confirmation (both used to get a new gen-2 runId).
test('an ordinary-batch parallel member left unknown stays in its original run and is not rescheduled',async()=>{
  await batchFixture('parallel-unknown');
});
test('Q24 an ordinary-batch parallel member stopped at develop_redo recovers through the batch entry and merges',async()=>{
  await batchFixture('parallel-redo');
});
// Q26: the batch handoff check closes a cleanup_failed QA command resource whose
// process group the host proves gone; one it cannot prove stops the batch with
// batch_resources_open naming the resource and the exit (not a bare code).
test('Q26 batch handoff releases a proven-gone QA resource and names one it cannot prove',
  {skip:process.platform==='win32'},()=>batchFixture('resources-open'));

test('a batch member whose reviewer failed without a verdict resumes its one review retry',()=>batchFixture('review-provider-retry'));
test('a parallel member whose reviewer failed without a verdict resumes its one review retry',()=>batchFixture('parallel-review-provider-retry'));

// A driver's timed rate-limit retry (retry_review) redispatches only the frozen member
// review: serial, one-member worktree group and multi-member group; stale targets and a
// round's second failure dispatch nothing more.
test('retry_review redispatches only the frozen rate-limited review of a serial member',()=>batchFixture('bound-review-provider-retry'));
test('retry_review redispatches only the frozen review of a one-member worktree group',()=>batchFixture('worktree-each-bound-review-provider-retry'));
test('retry_review redispatches only the frozen review of a multi-member group member',()=>batchFixture('parallel-bound-review-provider-retry'));
test('retry_review is stale once another driver moved the batch on',()=>batchFixture('bound-review-provider-retry',{staleByAdvance:true}));
test('retry_review stops at the round\'s second rate limit without another dispatch',()=>batchFixture('bound-review-provider-retry',{reviewFailures:2}));
