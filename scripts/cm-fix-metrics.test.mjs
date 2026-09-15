import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {appendFixMetrics,fixMetricsRow} from '../runtime/js/cm-fix/metrics.mjs';
import {fixCompletionProjection} from '../runtime/js/cm-fix/finish.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

test('FIX metrics projects completed log evidence, preserves content, deduplicates and rejects conflicts',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-metrics-')));
  try{
    fs.mkdirSync(path.join(root,'fixes'));
    const dossierFile='20260907-value.md',body='Synthetic completed dossier, fixture only.\n';
    fs.writeFileSync(path.join(root,'fixes',dossierFile),body);
    const identity={repositoryId:'fixture',runId:'metrics-run',taskId:'T-FIX-value',attempt:1};
    const common={workflow:'cm-fix',node:'FIX',repository_id:identity.repositoryId,run_id:identity.runId,task:identity.taskId,attempt:1};
    const events=[{...common,event:'task_start',at:'2026-09-07T01:00:00Z',event_id:'start'},
      {...common,event:'review',phase:'complete',review_kind:'implementation',round:1,result:'approved',finding_count:0,package_digest:'a'.repeat(64),event_id:'review'},
      {...common,event:'task_done',at:'2026-09-07T01:01:00Z',event_id:'done',result:'completed',dossier_file:`fixes/${dossierFile}`,
        dossier_sha256:createHash('sha256').update(body).digest('hex'),package_digest:'a'.repeat(64),walkthrough_result:'passed'}];
    assert.throws(()=>fixMetricsRow({events:events.slice(0,-1),identity,dossierFile}),{code:'metrics_completion_required'});
    assert.throws(()=>fixMetricsRow({events:[events[0],{...events[1],attempt:2},events[2]],identity,dossierFile}),{code:'metrics_review_required'});
    const second=[events[0],{...events[1],result:'changes_requested',finding_count:2},
      {...events[0],attempt:2,event_id:'start-two',at:'2026-09-07T01:00:30Z'},
      {...events[1],attempt:2,round:2,event_id:'review-two'}, {...events[2],attempt:2}];
    assert.match(fixMetricsRow({events:second,identity:{...identity,attempt:2},dossierFile}).line,/\| 2 \| 2 \| PASS \|/);
    fs.writeFileSync(path.join(root,'运行日志.jsonl'),events.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const header='| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |';
    const existing=`User notes stay.\n\n${header}\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| T-other | other | a | b | 1 | 0 | — | 0 |\n`;
    fs.writeFileSync(path.join(root,'METRICS.md'),existing);let checks=0;
    const options={specsRoot:root,identity,dossierFile},control={assertOwned(){checks++;}};
    assert.throws(()=>appendFixMetrics(options,{async assertOwned(){throw new Error('async denial');}}),{code:'metrics_owner_required'});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(fs.readFileSync(path.join(root,'METRICS.md'),'utf8'),existing);
    const written=appendFixMetrics(options,control);assert.equal(written.deduplicated,false);
    const bytes=fs.readFileSync(written.path,'utf8');assert(bytes.startsWith(existing));assert.match(bytes,/未知:未记录完整人工介入/);assert(checks>=3);
    assert.equal(appendFixMetrics(options,control).deduplicated,true);assert.equal(fs.readFileSync(written.path,'utf8'),bytes);
    const status={stage:'closeout_required',completionEligible:false,handoffEvidenceCoverage:'defect_and_learning',
      walkthrough:{status:'passed'},diagnosis:{crossLayer:false,investigation:{}},retrospective:{content:{candidates:[]}},n5:{packageDigest:'a'.repeat(64)}};
    const observing={...common,event:'run_done',phase:'observation',result:'observing',event_id:'observing'};
    const completed={...common,event:'run_done',result:'completed',event_id:'completed',completion_event_id:'done',
      metrics_row_digest:digest(written.line),package_digest:'a'.repeat(64)};
    const project=rows=>{fs.writeFileSync(path.join(root,'运行日志.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');return fixCompletionProjection({specsRoot:root,identity,status});};
    assert.deepEqual(project([events[0],observing]),status); // observation alone is not completion history
    assert.equal(project([events[0],observing,...events.slice(1)]).stage,'closeout_incomplete');
    const projected=project([events[0],observing,...events.slice(1),completed]);
    assert.equal(projected.stage,'completed');assert.equal(projected.completionEligible,true);
    assert.deepEqual(projected.completionHistory.runDoneEventIds,['completed']);
    assert.equal(project([events[0],{...observing,result:'completed'},...events.slice(1),completed]).stage,'closeout_incomplete');
    assert.equal(project([events[0],{...observing,phase:'other'},...events.slice(1),completed]).stage,'closeout_incomplete');
    project(events);
    fs.appendFileSync(written.path,written.line+'\n');assert.throws(()=>appendFixMetrics(options,control),{code:'metrics_row_conflict'});
    fs.unlinkSync(written.path);const created=appendFixMetrics(options,control);assert(fs.readFileSync(created.path,'utf8').startsWith(header));
    fs.unlinkSync(written.path);fs.symlinkSync(path.join(root,'fixes',dossierFile),written.path);
    assert.throws(()=>appendFixMetrics(options,control));assert.equal(fs.readFileSync(path.join(root,'fixes',dossierFile),'utf8'),body);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
