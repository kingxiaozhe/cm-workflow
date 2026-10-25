import test from 'node:test';
import {batchFixture} from './cm-ai-batch-run-fixture.mjs';

for(const mode of ['parallel','parallel-retry','parallel-conflict','parallel-resume','parallel-old-merge'])
test(`parallel batch runs real isolated members: ${mode}`,()=>batchFixture(mode));
test('A4 parallel member retries changed completion checks in its original run',()=>batchFixture('parallel-completion-retry'));
test('D1 parallel member retries failed develop checks before review',()=>batchFixture('parallel-develop-check-retry'));
// Worktree for every task: a chain that cannot pair still develops each task before the
// last alone in its own worktree, merges it back in order and removes worktree and branch.
test('one-member groups develop in their own worktree, merge back in order and clean up',()=>batchFixture('worktree-each'));
