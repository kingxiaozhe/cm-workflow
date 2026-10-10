import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCmAiBatch,taskCommitArgs,memberRescheduleAllowed,memberRunHistory} from './cm-ai-batch-run.mjs';
import {batchFixture} from './cm-ai-batch-run-fixture.mjs';

for(const mode of ['continuous','qa-resume','failed-qa','cancel','learning','policy','executor'])
test(`real multi-task runner keeps QA and recovery authoritative: ${mode}`,()=>batchFixture(mode));

// Q24/Q25: a strict-batch parallel member that can still recover in its own run stops
// with the batch operation named; the batch forwards develop_redo to it and continues.
// Review round 1 (blocker): an unresolved unknown member of a strict batch is never
// rescheduled into a second generation; it stays in its run with an explicit stop.
// Round-2 review: the host projects a raw unknown whose redo budget is spent as
// blocked/develop_redo_limit with pendingAction none. The reschedule decision reads
// the raw journal, so that member stays in its original run.
test('reschedule needs a raw checkpointed blocked state, never a projection over a raw unknown',()=>{
  const projected={state:'blocked',code:'develop_redo_limit',pendingAction:'none'};
  assert.equal(memberRescheduleAllowed(projected,{state:{state:'unknown',code:'call_timeout'},pending:null}),false);
  assert.equal(memberRescheduleAllowed(projected,null),false);
  assert.equal(memberRescheduleAllowed({state:'blocked',code:'failed',pendingAction:'none'},{state:{state:'blocked',code:'failed'},pending:{id:'develop-1'}}),false);
  assert.equal(memberRescheduleAllowed({state:'blocked',code:'review_transport_timeout',pendingAction:'abandon_review',reviewRedispatchStopRequired:true},
    {state:{state:'blocked',code:'review_transport_timeout'},pending:null}),false);
  assert.equal(memberRescheduleAllowed({state:'unknown',code:'reconciliation_required',pendingAction:'reconcile'},{state:{state:'unknown'},pending:null}),false);
  assert.equal(memberRescheduleAllowed({state:'blocked',code:'failed',pendingAction:'none'},{state:{state:'blocked',code:'failed'},pending:null}),true);
  const missing=fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-history-'));
  try{assert.equal(memberRunHistory(missing,'no-such-run'),null);}finally{fs.rmSync(missing,{recursive:true,force:true});}
});

test('dirty batch entry lists files and creates no member worktrees',()=>batchFixture('parallel-dirty'));
test('a parallel member whose scope file already exists on HEAD is refused before any worktree',()=>batchFixture('parallel-existing'));

test('parallel groups reject transitive prerequisites, not just direct edges',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-transitive-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specs,feature),{recursive:true});fs.mkdirSync(code);
  fs.writeFileSync(path.join(code,'req.md'),'# r\n');
  // T-009 <- T-005 <- T-003 <- T-001; T-007 is unrelated.
  fs.writeFileSync(path.join(specs,feature,'tasks.md'),
    '- [ ] T-001: a\n- [ ] T-003: b\n- [ ] T-005: c\n- [ ] T-007: d\n- [ ] T-009: final\n\n'+
    '- T-003 依赖 T-001\n- T-005 依赖 T-003\n- T-009 依赖 T-005\n');
  const task=(taskId,scope)=>({feature,taskId,scope:[scope],requirements:['req.md']});
  const tasks=[task('T-001','a.js'),task('T-003','b.js'),task('T-005','c.js'),task('T-007','e.js'),task('T-009','d.js')];
  let batchId=0;
  const build=group=>createCmAiBatch({configuration:{version:1,repositoryId:'r',batchId:`transitive-${++batchId}`,
    specsDir:specs,codeProject:code,parallel:[group],tasks},executionFor:async()=>({}),logHome:path.join(root,'log')});
  for(const group of [[`${feature}/T-003`,`${feature}/T-001`],   // direct edge
                      [`${feature}/T-005`,`${feature}/T-001`],   // one hop away
                      [`${feature}/T-009`,`${feature}/T-001`]]){ // two hops away
    assert.throws(()=>build(group),error=>error.code==='parallel_dependency_conflict',group.join(' + '));
  }
  // An unrelated pair still forms a group.
  assert.ok(build([`${feature}/T-007`,`${feature}/T-001`]));
  fs.rmSync(root,{recursive:true,force:true});
});

test('task commit subjects are single-line and bounded while bodies preserve descriptions',()=>{
  const cases=[
    ['简短任务','T-001: 简短任务'],
    ['完成 `接口` **实现** ~15min；保留后续。\n完整正文','T-001: 完成 `接口` **实现**'],
    ['首句。后续 ~20min','T-001: 首句'],
    ['首行\n第二行 ~10min','T-001: 首行'],
    ['~20min 开头估算','T-001: 开头估算'],
    ['~20min','T-001: T-001'],
    ['ASCII task ~5min','T-001: ASCII task'],
    ['x'.repeat(65),'T-001: '+'x'.repeat(65)],
    ['x'.repeat(66),'T-001: '+'x'.repeat(63)+'…'],
    ['中文任务'.repeat(30)+' ~25min',null],
    ['A'.repeat(100)+' ~30min',null],
  ];
  for(const [description,expected] of cases){
    const args=taskCommitArgs('T-001',description);
    assert.equal(args.length,4);assert.equal(args[0],'-m');assert.equal(args[2],'-m');
    assert.doesNotMatch(args[1],/[\r\n\u2028\u2029]/u);
    assert(Array.from(args[1]).reduce((sum,char)=>sum+(char.codePointAt(0)<=127?1:2),0)<=72);
    assert.doesNotMatch(args[1],/~\d+min/u);assert.equal(args[3],description);
    if(expected!==null)assert.equal(args[1],expected);else assert(args[1].endsWith('…'));
    assert.deepEqual(taskCommitArgs('T-001',description,'failed'),['-m','WIP T-001: blocked (failed)','-m',description]);
  }
});
