import test from 'node:test';
import {batchFixture} from './cm-ai-batch-run-fixture.mjs';

for(const mode of ['parallel','parallel-retry','parallel-conflict','parallel-resume'])
test(`parallel batch runs real isolated members: ${mode}`,()=>batchFixture(mode));
test('A4 parallel member retries changed completion checks in its original run',()=>batchFixture('parallel-completion-retry'));
test('D1 parallel member retries failed develop checks before review',()=>batchFixture('parallel-develop-check-retry'));
