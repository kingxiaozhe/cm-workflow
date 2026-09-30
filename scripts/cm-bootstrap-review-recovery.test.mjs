import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,open} from './fixtures/bootstrap-review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {runnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';

const FIXTURE_TIMEOUT_MS=Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000);
function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}

test('legacy unknown bootstrap checkpoint recovers its original package without redispatch',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=fixture(t);
  let run=open(f,'T-001');await run.effect('develop');await run.effect('review');await run.effect('complete');run.close();
  run=open(f,'T-002');assert.equal((await run.effect('develop')).state,'awaiting_review');
  const calls=[...f.calls],storePath=path.join(f.specsDir,'.reviews','.execution','run-T-002','state.json');
  const saved=run.store.snapshot(),rows=structuredClone(saved.records),originalPackage=rows.at(-1).payload.checkpoint.reviewPackage;
  assert(originalPackage);run.close();
  // Model the exact older checkpoint shape: the developer succeeded and the
  // host retained checks and Learning evidence, but package validation threw.
  const checkpoint=rows.at(-1).payload.checkpoint;
  checkpoint.state='unknown';checkpoint.code='execution_error';checkpoint.reason=null;checkpoint.reviewPackage=null;
  checkpoint.cache.at(-1).result=runnerStatus(checkpoint,rows[0].payload.config);
  rechain(rows);
  const {revision:oldRevision,...body}=saved,legacy={...body,records:rows};
  assert(oldRevision);
  fs.writeFileSync(storePath,JSON.stringify({...legacy,revision:digest(legacy)})+'\n');
  run=open(f,'T-002','resume');
  assert.equal(run.runner.status().state,'unknown');assert.equal(run.runner.status().bootstrapReviewRecovery,true);
  const entry=createCmAiConversationEntry({specsDir:f.specsDir,codeProject:f.codeProject,feature:'0.bootstrap',
    identity:run.definition.identity,runner:run.runner,allowBootstrapReviewRecovery:true});
  const recovery=await entry.handle({version:1,operation:'bootstrap_review_recover',requestId:'recover-bootstrap',
    identity:run.definition.identity,reason:'Original package validation rejected an unchanged rule'});
  assert.equal(recovery.outcome,'advanced',JSON.stringify(recovery));
  assert.equal(recovery.pendingAction,'decision');
  const result=run.runner.status();
  assert.equal(result.state,'awaiting_review',JSON.stringify(result));
  assert.equal(result.packageDigest,originalPackage.packageDigest);
  assert.equal(run.store.snapshot().records.at(-1).payload.type,'bootstrap-review-recovered');
  assert.deepEqual(f.calls,calls);run.close();
  run=open(f,'T-002','resume');assert.equal(run.runner.status().state,'awaiting_review');
  assert.equal((await run.effect('review')).state,'approved');
  const completed=await run.effect('complete');assert.equal(completed.state,'fixture_completed',JSON.stringify(completed));run.close();
});

test('instruction bootstrap review material limits never grant a developer redispatch',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=fixture(t);
  let run=open(f,'T-001');await run.effect('develop');await run.effect('review');await run.effect('complete');run.close();
  run=open(f,'T-002','create',{afterCheck:()=>{
    fs.mkdirSync(path.join(f.codeProject,'notes'),{recursive:true});
    fs.writeFileSync(path.join(f.codeProject,'notes','AGENTS.md'),'x'.repeat(2100*1024));
  }});
  const result=await run.effect('develop');
  assert.equal(result.state,'unknown',JSON.stringify(result));assert.equal(result.code,'limit_exceeded');
  assert.equal(run.runner.status().bootstrapReviewRecovery,undefined);
  const calls=[...f.calls];run.close();
  run=open(f,'T-002','resume');
  const retry=await run.effect('develop','-retry');
  assert.equal(retry.outcome,'rejected');assert.equal(retry.code,'stage_mismatch');
  assert.deepEqual(f.calls,calls);run.close();
});
