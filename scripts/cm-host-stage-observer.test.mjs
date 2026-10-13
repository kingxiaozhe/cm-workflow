import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withHostStageObserver,beginHostStage} from '../runtime/js/cm-ai/host-stage-observer.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';

test('nested native stage preserves outer deadline and restores its identity',async()=>{
  const rows=[];
  await withHostStageObserver(row=>rows.push(row),async()=>{
    const outer=beginHostStage('develop',1000),parent=rows.at(-1);
    const inner=beginHostStage('check',5000),child=rows.at(-1);
    assert.equal(child.kind,'check');assert.notEqual(child.id,parent.id);assert.equal(child.deadlineMs,parent.deadlineMs);
    inner();assert.deepEqual(rows.at(-1),parent);outer();assert.equal(rows.at(-1),null);
  });
});
test('overlapping operations and late stages cannot replace another operation telemetry',async()=>{
  const a=[],b=[];let wake,late;
  const waiting=new Promise(resolve=>{wake=resolve;});
  const first=withHostStageObserver(row=>a.push(row),async()=>{late=beginHostStage('review',1000);await waiting;});
  await withHostStageObserver(row=>b.push(row),async()=>{const end=beginHostStage('check',2000);assert.equal(a.at(-1).kind,'review');end();});
  const before=b.length;wake();await first;late();assert.equal(b.length,before);assert.equal(a.at(-1),null);
});
test('observer failures and absent observers never alter original result or error',async()=>{
  beginHostStage('check',1)();
  assert.equal(await withHostStageObserver(()=>{throw Error('observer');},async()=>{beginHostStage('check',1)();return 7;}),7);
  const failure=Error('original');
  await assert.rejects(withHostStageObserver(()=>{throw Error('observer');},async()=>{beginHostStage('review',1);throw failure;}),error=>error===failure);
});
test('real native checks publish a distinct configured deadline per command without changing checks',async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-stage-')));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));const rows=[];
  const check=createHostCheck({cwd,timeoutMs:2500,commands:['first','second'].map(id=>({id,command:[process.execPath,'-e','0']}))});
  const result=await withHostStageObserver(row=>rows.push(row),()=>check({identity:{repositoryId:'stage-fixture',runId:'stage-fixture-run',taskId:'T-001',attempt:1}},{signal:new AbortController().signal}));
  assert.deepEqual(result.map(row=>row.outcome),['passed','passed']);
  const stages=rows.filter(Boolean);assert.equal(stages.length,2);
  assert.equal(new Set(stages.map(row=>row.id)).size,2);
  for(const row of stages){assert.equal(row.kind,'check');assert.equal(row.deadlineMs-Date.parse(row.startedAt),2500);assert.deepEqual(Object.keys(row).sort(),['deadlineMs','id','kind','startedAt']);}
  assert.equal(rows.at(-1),null);
});
