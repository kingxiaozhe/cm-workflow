import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {completionSummary,completionLines,taskCompletion} from '../runtime/js/cm-ai/completion-summary.mjs';
import {cmAiSessionBoundary} from '../runtime/js/session-boundary.mjs';
import {handoffText} from '../runtime/js/session-handoff.mjs';

const identity={repositoryId:'completion-fixture',runId:'current',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
function project(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-completion-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [feature,tasks] of [['1.first','- [x] T-001: done\n- [ ] T-002: open\n'],['2.next','- [ ] T-003: open\n']]){
    fs.mkdirSync(path.join(root,feature));
    for(const [name,body] of [['tasks.md',tasks],['requirements.md','# R\n'],['design.md','# D\n']])
      fs.writeFileSync(path.join(root,feature,name),body);
  }
  const approve=()=>fs.writeFileSync(path.join(root,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.first','2.next'],
    taskGrammar:2,specFiles:buildManifest(root)}));
  approve();
  const receipt={kind:'cm-review-receipt',identity,packageDigest,result:{verdict:'approved'}};
  const source={identity,packageDigest,state:'fixture_completed',code:null,receipt:{...receipt,receiptDigest:digest(receipt)}};
  const result={workflow:'cm-ai',...source,completion:{task:taskCompletion(source)}};
  const log=path.join(root,'运行日志.jsonl');
  const qa=(status,more={})=>({schema_version:1,workflow:'cm-ai',event:'qa',node:'N6',event_id:'qa-event',feature:'1.first',
    repository_id:identity.repositoryId,run_id:identity.runId,task:identity.taskId,attempt:1,package_digest:packageDigest,
    decision_id:'qa-current',status,reason:'feature_complete',score:null,at:'2026-11-01T00:00:00Z',...more});
  const writeRows=rows=>fs.writeFileSync(log,rows.map(row=>JSON.stringify(row)+'\n').join(''));
  const summary=()=>completionSummary({specsDir:root,feature:'1.first',result});
  return {root,approve,source,result,log,qa,writeRows,summary};
}

test('a reported task completion without durable owner evidence cannot complete its feature or project',t=>{
  const p=project(t);fs.writeFileSync(path.join(p.root,'.cm-status.json'),JSON.stringify({state:'run_done'}));
  const value=p.summary();
  assert.equal(taskCompletion(p.source).status,'completed');
  assert.equal(value.task.status,'unknown');assert.equal(value.task.historicalCompleted,true);assert.equal(value.task.review.status,'passed');
  assert.deepEqual(value.project.scope,['1.first','2.next']);assert.equal(value.project.pendingTasks,2);
  assert.equal(value.feature.tasks.completed,1);assert.equal(value.feature.tasks.total,2);
  assert.equal(value.feature.status,'unknown');assert.equal(value.feature.qa.status,'unknown');
  assert.equal(value.project.status,'unknown');assert.equal(value.run.status,'unknown');
  assert.equal(value.productAcceptance.status,'unknown');assert.equal(value.deployment.status,'unknown');
});

for(const [decision,expected] of [['skipped','skipped'],['blocked','blocked'],['triggered','unknown']]){
  test(`terminal task list keeps QA ${decision} distinct from PASS`,t=>{
    const p=project(t);fs.writeFileSync(path.join(p.root,'1.first','tasks.md'),'- [x] T-001: done\n');p.approve();
    p.writeRows([p.qa(decision)]);const value=p.summary();
    assert.equal(value.feature.qa.status,expected);assert.notEqual(value.feature.status,'passed');
    assert.notEqual(value.project.status,'completed');
    if(decision==='skipped')assert.equal(value.feature.qa.reason,'terminal_feature_qa_required');
  });
}

test('a row claiming old QA PASS is not accepted without the strict owner evidence, and a different current candidate is blocked',t=>{
  const p=project(t);p.writeRows([p.qa('triggered'),{...p.qa('triggered'),event:'test_run',phase:'start',operation_id:'qa-1'},
    {...p.qa('triggered'),event:'test_run',phase:'complete',operation_id:'qa-1',result:'PASS'}]);
  assert.notEqual(p.summary().feature.qa.status,'passed');
  p.writeRows([p.qa('triggered',{package_digest:'b'.repeat(64)})]);
  const value=p.summary();assert.equal(value.feature.qa.status,'blocked');assert.equal(value.feature.qa.reason,'qa_candidate_changed');
  p.writeRows([p.qa('triggered',{run_id:'older-run'})]);
  const older=p.summary();assert.equal(older.feature.qa.status,'blocked');assert.equal(older.feature.qa.reason,'qa_candidate_changed');
});

test('historical task completion survives correction while current eligibility remains blocked',t=>{
  const p=project(t);const source={...p.source,code:'correction_review_required'};
  const value=completionSummary({specsDir:p.root,feature:'1.first',result:{...p.result,code:source.code,completion:{task:taskCompletion(source)}}});
  assert.equal(value.task.historicalCompleted,true);assert.equal(value.task.status,'blocked');
  assert.equal(value.task.review.status,'passed');assert.equal(value.project.status,'blocked');
  assert.equal(value.feature.status,'blocked');assert.equal(value.run.status,'blocked');
});

test('a wider QA or closeout block does not undo the task completion gate',t=>{
  const p=project(t),source={...p.source,code:'project_qa_not_passed'};
  const value=completionSummary({specsDir:p.root,feature:'1.first',result:{...p.result,code:source.code,completion:{task:taskCompletion(source)}}});
  assert.equal(taskCompletion(source).status,'completed');assert.equal(value.task.historicalCompleted,true);
  assert.equal(value.task.status,'unknown','this fixture has no durable completion owner');assert.equal(value.run.status,'blocked');
  assert.equal(value.project.status,'unknown');
});

test('old durable baselines are explicitly reported as unprotected and are never rewritten',t=>{
  const p=project(t),directory=path.join(p.root,'.reviews','.execution',identity.runId);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const body={version:1,seq:1,id:'runner.000001',kind:'result',payload:{type:'init',baseline:{}},previousDigest:null};
  const state={version:1,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:'1'.repeat(64),config:'2'.repeat(64),inputs:'3'.repeat(64)},records:[{...body,digest:digest(body)}]};
  const file=path.join(directory,'state.json'),bytes=JSON.stringify({...state,revision:digest(state)})+'\n';
  fs.writeFileSync(file,bytes,{mode:0o600});const before=fs.statSync(file).mtimeMs;
  const value=p.summary();assert.equal(value.task.acceptanceProtection,'legacy_unprotected');
  assert(completionLines(value)[0].includes('未受新合同保护'));
  assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.equal(fs.statSync(file).mtimeMs,before);
});

test('run_done proves only its recorded scope, without completing pending project tasks or proving external acceptance',t=>{
  const p=project(t);p.writeRows([{schema_version:1,workflow:'cm-ai',event:'run_done',node:'N8',event_id:'done-current',
    repository_id:identity.repositoryId,run_id:identity.runId,task:identity.taskId,feature:'1.first',package_digest:packageDigest,
    context_digest:'c'.repeat(64),documentation_sync_id:'docs-current',scope_features:['1.first']}]);
  const value=p.summary();assert.equal(value.run.historicalFinalized,true);assert.equal(value.run.status,'unknown');
  assert.deepEqual(value.run.scope,['1.first']);
  assert.equal(value.project.status,'unknown');assert.equal(value.project.historicalFinalized,false);
  assert.equal(value.productAcceptance.status,'unknown');assert.equal(value.deployment.status,'unknown');
});

test('legacy run_done without repository binding remains historical evidence with UNKNOWN current eligibility',t=>{
  const p=project(t);p.writeRows([{schema_version:1,workflow:'cm-ai',event:'run_done',node:'N8',event_id:'legacy-done',
    run_id:identity.runId,task:identity.taskId,feature:'1.first',package_digest:packageDigest,
    context_digest:'c'.repeat(64),documentation_sync_id:'legacy-docs'}]);
  const value=p.summary();assert.equal(value.run.status,'unknown');assert.equal(value.run.historicalFinalized,true);
  assert.equal(value.run.reason,'legacy_closeout_binding_unknown');assert(value.run.evidence.includes('运行日志.jsonl#legacy-done'));
});

test('missing approval or source drift stays UNKNOWN instead of synthesizing completion',t=>{
  const p=project(t);fs.writeFileSync(path.join(p.root,'2.next','tasks.md'),'- [x] T-003: silently weakened\n');
  const value=p.summary();assert.equal(value.project.status,'unknown');assert.equal(value.feature.status,'unknown');
  fs.writeFileSync(path.join(p.root,'.cm-specs-status'),'{}');assert.equal(p.summary().project.status,'unknown');
});

test('a change during QA inspection invalidates the composed snapshot',t=>{
  const p=project(t);p.writeRows([p.qa('skipped')]);
  const original=fs.existsSync;let changed=false;
  fs.existsSync=function(file){
    if(file===p.log&&!changed){changed=true;fs.appendFileSync(path.join(p.root,'1.first','tasks.md'),'- [ ] T-004: new\n');}
    return original.apply(this,arguments);
  };
  let value;try{value=p.summary();}finally{fs.existsSync=original;}
  assert(changed);assert.equal(value.project.status,'unknown');assert.equal(value.feature.status,'unknown');
});

test('summary reads write no files; the same structured result supplies boundary and handoff text',t=>{
  const p=project(t),snapshot=()=>{
    const files=[...fs.readdirSync(p.root,{recursive:true})].filter(name=>fs.statSync(path.join(p.root,name)).isFile()).sort();
    return files.map(name=>{const file=path.join(p.root,name);return [name,fs.readFileSync(file,'utf8'),fs.statSync(file).mtimeMs];});
  };
  const before=snapshot(),completion=p.summary();assert.deepEqual(snapshot(),before);
  const boundary=cmAiSessionBoundary({workflow:'cm-ai',state:'run_done',completion},{specsDir:p.root,feature:'1.first'});
  const handoff=handoffText({workflow:'cm-ai',at:'2026-11-01T00:00:00Z',runId:'current',done:[],todo:[],next:'next',completion});
  for(const line of completionLines(completion)){assert(boundary.includes(line));assert(handoff.includes(line));}
  assert.deepEqual(snapshot(),before,'formatting without an explicit handoff writer stays read-only');
});

test('R1 G7 admission without a current identity leaves prior QA unknown rather than candidate-blocked',t=>{
  const p=project(t);p.writeRows([p.qa('triggered')]);
  const value=completionSummary({specsDir:p.root,feature:'1.first',result:{state:'blocked',code:'specs_unapproved'}});
  assert.equal(value.feature.qa.status,'unknown');assert.equal(value.feature.qa.reason,'current_candidate_unavailable');
});

test('R1 G10 completion refuses oversized logs before scanning them',t=>{
  const p=project(t),row=JSON.stringify({workflow:'other',padding:'x'.repeat(2048)})+'\n';
  fs.writeFileSync(p.log,row.repeat(Math.ceil(33*1024*1024/Buffer.byteLength(row))));
  const value=p.summary();assert.equal(value.project.status,'unknown');assert.equal(value.project.reason,'completion_log_invalid');
});
