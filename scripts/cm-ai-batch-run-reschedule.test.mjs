import test from 'node:test';
import {batchFixture} from './cm-ai-batch-run-fixture.mjs';

test('ready member merges before blocked member preserves reason in log and WIP and falls back only once',async()=>{
  for(const withReason of [true,false])await batchFixture('parallel-recovery',{terminalAgain:true,withReason});
});
// Q25: an execution-policy (or external-model) batch used to leave a terminal
// parallel member waiting forever; it is now rescheduled serially like any batch.
test('Q25 an execution-policy batch reschedules a terminal parallel member serially instead of waiting forever',async()=>{
  await batchFixture('parallel-recovery',{executionPolicy:true});
});

test('serial fallback resumes from log and automatically commits its completed task',async()=>{
  for(const options of [{crashAt:'cleanup'},{crashAt:'serial'},
    {blockedIds:['T-001']},{blockedIds:['T-001','T-002']}])await batchFixture('parallel-recovery',options);
});
test('final serial task commits durably and commit information survives resume',()=>batchFixture('final-commit'));
