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
// Batch 4 review round 1: a member whose review was registered but never dispatched
// (pending_review/grant_expired, call not_dispatched) is not an unresolved stop with
// unusable exits: no reviewer ran, so the next advance redispatches it in its own run.
test('an ordinary-batch parallel member whose review grant expired before dispatch redispatches it in its original run',async()=>{
  await batchFixture('parallel-grant-expired');
});
// An unresolved stop names only exits that accept the raw state: a raw pending_review
// (review authorization denied) has no supersede, reconcile or abandon exit.
test('an unresolved member at raw pending_review is not pointed at supersede, reconcile_review or abandon operations',async()=>{
  await batchFixture('parallel-denied');
});
// Q26: the batch handoff check closes a cleanup_failed QA command resource whose
// process group the host proves gone; one it cannot prove stops the batch with
// batch_resources_open naming the resource and the exit (not a bare code).
test('Q26 batch handoff releases a proven-gone QA resource and names one it cannot prove',
  {skip:process.platform==='win32'},()=>batchFixture('resources-open'));

test('a batch member whose reviewer failed without a verdict resumes its one review retry',()=>batchFixture('review-provider-retry'));
test('a parallel member whose reviewer failed without a verdict resumes its one review retry',()=>batchFixture('parallel-review-provider-retry'));
