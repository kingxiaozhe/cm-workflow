import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {appendFixMetrics,appendFixMetricsSteps} from '../runtime/js/cm-fix/metrics.mjs';
import {runStepsSync,runStepsCooperatively} from '../runtime/js/cm-fix/cooperative.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {finishFixSteps} from '../runtime/js/cm-fix/finish.mjs';

function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cooperative-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'fixes'));const dossierFile='20261015-value.md',body='Fixture dossier\n';
 fs.writeFileSync(path.join(root,'fixes',dossierFile),body);
 const identity={repositoryId:'fixture',runId:'cooperative-run',taskId:'T-FIX-value',attempt:1};
 const common={workflow:'cm-fix',node:'FIX',repository_id:identity.repositoryId,run_id:identity.runId,task:identity.taskId,attempt:1};
 const events=[{...common,event:'task_start',at:'2026-10-15T01:00:00Z',event_id:'start'},
  {...common,event:'review',phase:'complete',review_kind:'implementation',round:1,result:'approved',finding_count:0,package_digest:'a'.repeat(64),event_id:'review'},
  {...common,event:'task_done',at:'2026-10-15T01:01:00Z',event_id:'done',result:'completed',dossier_file:`fixes/${dossierFile}`,dossier_sha256:createHash('sha256').update(body).digest('hex'),package_digest:'a'.repeat(64),walkthrough_result:'passed'}];
 fs.writeFileSync(path.join(root,'运行日志.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const initial='User notes stay.\n\n| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
 const metrics=path.join(root,'METRICS.md'),source=path.join(root,'reviewed-source'),gate=path.join(root,'reviewed-n5');
 fs.writeFileSync(metrics,initial);fs.writeFileSync(source,'reviewed');fs.writeFileSync(gate,'approved');
 const guard=()=>{assert.equal(fs.readFileSync(source,'utf8'),'reviewed');assert.equal(fs.readFileSync(gate,'utf8'),'approved');};
 return {root,options:{specsRoot:root,identity,dossierFile},initial,metrics,source,gate,guard};
}

test('cooperative metrics yields before every fresh owner check; sync API returns the same evidence',async t=>{
 const f=fixture(t);let pulses=0,checks=0;
 setImmediate(()=>{pulses++;});
 const written=await runStepsCooperatively(appendFixMetricsSteps(f.options,{assertOwned(){
  f.guard();checks++;assert.equal(pulses,checks,'each guard observes separately scheduled event-loop work');setImmediate(()=>{pulses++;});
 }}));
 assert.equal(checks,3);assert.equal(written.deduplicated,false);const bytes=fs.readFileSync(f.metrics);
 const sync=appendFixMetrics(f.options,{assertOwned:f.guard});assert.equal(sync.deduplicated,true);assert.equal(sync.line,written.line);assert.deepEqual(fs.readFileSync(f.metrics),bytes);
 const cooperative=await runStepsCooperatively(appendFixMetricsSteps(f.options,{assertOwned:f.guard}));assert.deepEqual(cooperative,sync);
});

test('a source or N5 change during a metrics checkpoint is rejected before append',async t=>{
 for(const field of ['source','gate']){
  const f=fixture(t),steps=appendFixMetricsSteps(f.options,{assertOwned:f.guard});
  assert.equal(steps.next().done,false);assert.equal(steps.next().done,false);
  fs.writeFileSync(f[field],'changed between checkpoints');assert.throws(()=>steps.next());
  assert.equal(fs.readFileSync(f.metrics,'utf8'),f.initial);
 }
});

test('metrics changes across a checkpoint are rejected, including same-size changes and dedupe',t=>{
 for(const mode of ['append','same-size','dedupe','after-write']){
  const f=fixture(t);if(mode==='dedupe')appendFixMetrics(f.options,{assertOwned:f.guard});
  const steps=appendFixMetricsSteps(f.options,{assertOwned:f.guard});steps.next();steps.next();
  if(mode==='after-write')steps.next();
  const before=fs.readFileSync(f.metrics,'utf8'),changed=mode==='append'?before+'user edit\n':before.replace('User notes stay.','User notes edit.');
  fs.writeFileSync(f.metrics,changed);
  assert.throws(()=>steps.next(),{code:'metrics_file_changed'});assert.equal(fs.readFileSync(f.metrics,'utf8'),changed);
 }
});

test('synchronous and cooperative runners reject Promise owner guards and close abandoned generators',async t=>{
 const f=fixture(t);
 assert.throws(()=>appendFixMetrics(f.options,{async assertOwned(){}}),{code:'metrics_owner_required'});
 await assert.rejects(runStepsCooperatively(appendFixMetricsSteps(f.options,{async assertOwned(){}})),{code:'metrics_owner_required'});
 assert.equal(fs.readFileSync(f.metrics,'utf8'),f.initial);
 for(const run of [runStepsSync,runStepsCooperatively]){
  let finalized=false;function* fail(){try{yield;throw Error('fixture failure');}finally{finalized=true;}}
  if(run===runStepsSync)assert.throws(()=>run(fail()),/fixture failure/);else await assert.rejects(run(fail()),/fixture failure/);
  assert.equal(finalized,true);
 }
});

test('host finish selects cooperative execution while retaining the original finish authority',async()=>{
 for(const authorized of [false,true]){
  let calls=0;const host=createFixHost({config:{},permissions:authorized?['--allow-finish']:[],owner:{finish(options){calls++;assert.deepEqual(options,{authorized,cooperative:true});return {stage:'closeout_required'};}}});
  assert.equal((await host.handle({requestId:'finish',operation:'finish'})).stage,'closeout_required');assert.equal(calls,1);
 }
});

test('real finish generator yields before its first guard and still rejects asynchronous ownership',async t=>{
 const f=fixture(t),status={stage:'closeout_required',completionEligible:false,handoffEvidenceCoverage:'defect_and_learning',walkthrough:{status:'passed'},diagnosis:{crossLayer:false,investigation:{}},retrospective:{content:{candidates:[]}}};
 const options={...f.options,configuration:{reproduction:{cwd:f.root}},status,registeredAt:1};let checks=0;
 const steps=finishFixSteps(options,{assertOwned(){checks++;}});
 assert.equal(steps.next().done,false);assert.equal(checks,0);steps.return();
 assert.throws(()=>runStepsSync(finishFixSteps(options,{async assertOwned(){}})),{code:'fix_owner_required'});
 await assert.rejects(runStepsCooperatively(finishFixSteps(options,{async assertOwned(){}})),{code:'fix_owner_required'});
 assert.equal(fs.readFileSync(f.metrics,'utf8'),f.initial);
});
