// A batch's member worktrees and branches. New batches derive their segment from
// the full batchId and record it in batch_start; a batch that started without it
// keeps the old 8-character prefix so a resume finds what it created.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BATCH_SEGMENT_FIELD,batchSegment,batchSegments,batchMemberWorktree,batchMemberBranch} from '../runtime/js/cm-ai/batch-location.mjs';

function specs(t,rows=[]){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-location-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs');fs.mkdirSync(specsDir);
  if(rows.length)fs.writeFileSync(path.join(specsDir,'运行日志.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  return {root,specsDir,codeProject:path.join(root,'app')};
}
const start=(batchId,extra={})=>({schema_version:1,workflow:'cm-ai',event:'decision',phase:'batch_start',run_id:batchId,...extra});

test('two batches sharing an 8-character prefix get different worktrees and branches',t=>{
  const f=specs(t);
  const a=batchSegments({specsDir:f.specsDir,batchId:'batch-20261022-A'}),b=batchSegments({specsDir:f.specsDir,batchId:'batch-20261022-B'});
  assert.notEqual(a.dir,b.dir);assert.notEqual(a.ref,b.ref);
  const where=segments=>[batchMemberWorktree({codeProject:f.codeProject,segments,taskId:'T-001'}),
    batchMemberBranch({segments,feature:'1.work',taskId:'T-001'})];
  assert.notDeepEqual(where(a),where(b));
  assert.equal(where(a)[0],path.join(f.root,'.cm-worktrees',batchSegment('batch-20261022-A'),'T-001'));
  assert.equal(where(a)[1],`cm/${batchSegment('batch-20261022-A')}/work/T-001`);
});

test('a batch that already started without a recorded segment keeps the old prefix',t=>{
  const f=specs(t,[start('v1.2.3-batch')]);
  const segments=batchSegments({specsDir:f.specsDir,batchId:'v1.2.3-batch'});
  assert.equal(segments.legacy,true);
  assert.equal(batchMemberWorktree({codeProject:f.codeProject,segments,taskId:'T-002'}),path.join(f.root,'.cm-worktrees','v1.2.3-b','T-002'));
  assert.equal(batchMemberBranch({segments,feature:'2.search',taskId:'T-002'}),'cm/v1-2-3-b/search/T-002');
});

test('a recorded segment is used only when it is the one the full id derives',t=>{
  const good=specs(t,[start('batch-ok',{[BATCH_SEGMENT_FIELD]:batchSegment('batch-ok')})]);
  assert.deepEqual(batchSegments({specsDir:good.specsDir,batchId:'batch-ok'}),{dir:batchSegment('batch-ok'),ref:batchSegment('batch-ok'),legacy:false});
  for(const forged of ['../../etc','batch-ok',batchSegment('other-batch'),null]){
    const f=specs(t,[start('batch-ok',{[BATCH_SEGMENT_FIELD]:forged})]);
    assert.throws(()=>batchSegments({specsDir:f.specsDir,batchId:'batch-ok'}),{code:'batch_history_invalid'},String(forged));
  }
});

test('rows of other batches and other workflows do not decide the segment',t=>{
  const f=specs(t,[start('another-batch'),{schema_version:1,workflow:'cm-prd',event:'run_done',run_id:'mine-1234'},
    {schema_version:1,workflow:'cm-ai',event:'progress',run_id:'mine-1234'}]);
  assert.equal(batchSegments({specsDir:f.specsDir,batchId:'mine-1234'}).dir,batchSegment('mine-1234'));
});

test('the segment is a safe single path component and ref component',()=>{
  for(const id of ['a','a.b.c.d.e.f.g.h','....----','batch_2026.10.23-x'])
    assert.match(batchSegment(id),/^[A-Za-z0-9_-]{1,8}-[a-f0-9]{12}$/,id);
});
