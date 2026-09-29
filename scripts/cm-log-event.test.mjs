import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyResourceTransition,buildEvent,parseData,unclosedResources,UsageError} from './cm-log-event.mjs';

const pythonWriter=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));

test('JS log decision core builds a stable event and reuses the active run',()=>{
  const input={workflow:'cm-ai',event:'progress',phase:'execute',runtime:'codex',project:'示例',detail:'任务执行中',
    at:'2026-07-29T09:10:00-07:00',dataJson:'{"feature":"1.login"}'};
  const state={pointer:{run_id:'20260729T160000Z-active01',status:'running'},projectStates:{},now:new Date('2026-07-29T16:10:00Z')};
  const first=buildEvent(input,state),second=buildEvent({...input,at:'2026-07-29T09:11:00-07:00'},state);
  assert.equal(first.runId,'20260729T160000Z-active01');assert.equal(first.newRun,false);
  assert.equal(first.event.feature,'1.login');assert.equal(first.event.at,'2026-07-29T09:10:00-07:00');
  assert.equal(first.event.event_id,'85b8ed7a-364d-5a22-ae19-9e60fae968e6');
  assert.equal(first.event.event_id,second.event.event_id);
});

test('resume restores the original run from the authoritative log and duplicate old events do not change its state',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-log-resume-')));
  try{
    const project=path.join(root,'project'),specs=path.join(root,'specs');fs.mkdirSync(project);fs.mkdirSync(specs);
    const runId='fixture-resume-run',env={...process.env,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
    const write=(event,explicit=true)=>{
      const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonWriter,'--workflow','cm-fix','--event',event,'--runtime','codex',
        '--project-root',project,'--specs-dir',specs,...(explicit?['--run-id',runId]:[]),'--detail',event],{encoding:'utf8',env});
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
    };
    write('run_start');write('run_done');write('resume');
    assert.equal(JSON.parse(fs.readFileSync(path.join(specs,'.cm-run.json'))).status,'running');
    write('run_done'); // duplicate old terminal event, not a new exit
    assert.equal(JSON.parse(fs.readFileSync(path.join(specs,'.cm-run.json'))).status,'running');
    fs.renameSync(path.join(specs,'.cm-run.json'),path.join(root,'saved-pointer.json'));
    assert.equal(write('progress',false).run_id,runId);
    const log=fs.readFileSync(path.join(specs,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.map(row=>row.event),['run_start','run_done','resume','progress']);
    write('done');write('resume'); // duplicate old resume must not reopen a later completed run
    assert.equal(JSON.parse(fs.readFileSync(path.join(specs,'.cm-run.json'))).status,'done');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('JS log decision core rejects secrets and blocks completion with live resources',()=>{
  assert.throws(()=>parseData('{"nested":{"api_token":"secret"}}'),UsageError);
  const states=new Map();applyResourceTransition(states,'profile-1','test_profile','acquired');
  assert.deepEqual(unclosedResources(states),['profile-1']);
  assert.throws(()=>applyResourceTransition(states,'profile-1','test_profile','acquired'),UsageError);
});

test('JS log persistence writes project authority, mirrors globally, and deduplicates',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-log-js-')));
  try{
    const project=path.join(root,'project'),specs=path.join(root,'specs'),globalHome=path.join(root,'logs');
    fs.mkdirSync(project);fs.mkdirSync(specs);
    const args=[pythonWriter,'--workflow','cm-ai','--event','run_start','--phase','start','--runtime','codex',
      '--project-root',project,'--specs-dir',specs,'--run-id','20260729T160000Z-active01','--detail','开始执行',
      '--at','2026-07-29T09:10:00-07:00','--data-json','{"feature":"1.login"}'];
    const env={...process.env,CM_WORKFLOW_LOG_HOME:globalHome};
    const first=spawnSync(process.env.CM_PYTHON_BIN||'python3',args,{encoding:'utf8',env});
    assert.equal(first.status,0,first.stderr);const result=JSON.parse(first.stdout);
    assert.equal(result.global_written,true);assert.equal(result.deduplicated,false);
    assert.equal(fs.readFileSync(result.project_log,'utf8'),fs.readFileSync(result.global_log,'utf8'));
    const second=spawnSync(process.env.CM_PYTHON_BIN||'python3',args,{encoding:'utf8',env});
    assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).deduplicated,true);
    assert.equal(fs.readFileSync(result.project_log,'utf8').trim().split('\n').length,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('QA environment-failure supersession needs the matching completed FAIL, both case lists and a single-line reason',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-log-env-failure-')));
  try{
    const project=path.join(root,'project'),specs=path.join(root,'specs'),runId='env-failure-run';
    fs.mkdirSync(project);fs.mkdirSync(specs);
    const env={...process.env,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
    const bound={node:'N6',repository_id:'fixture',feature:'1.work',task:'T-001',package_digest:'a'.repeat(64),
      qa_decision_id:'qa-decision',operation_id:'qa-round-1',attempt:1,mode:'commands',case_count:2};
    const write=(phase,data)=>spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonWriter,'--workflow','cm-ai','--event','test_run',
      '--phase',phase,'--runtime','codex','--project-root',project,'--specs-dir',specs,'--run-id',runId,'--detail',`QA ${phase}`,
      '--data-json',JSON.stringify({...bound,...data})],{encoding:'utf8',env});
    assert.equal(write('start',{}).status,0);
    assert.equal(write('complete',{result:'FAIL',passed:0,failed:1,blocked:1,report:'r.md'}).status,0);
    const valid={previous_test_run_id:'qa-round-1',reason:'declared_environment_failure',failed_cases:['probe'],
      blocked_cases:['TC-001'],expected_environment:null,environment_failure_reason:'simulator runtime was missing'};
    for(const invalid of [{failed_cases:[]},{blocked_cases:[]},{failed_cases:['probe','probe']},{environment_failure_reason:' '},
      {environment_failure_reason:'two\nlines'},{previous_test_run_id:'other'},{reason:'host_evidence_problem'}]){
      const result=write('superseded',{...valid,...invalid});
      assert.notEqual(result.status,0,JSON.stringify(invalid));
    }
    const accepted=write('superseded',valid);assert.equal(accepted.status,0,accepted.stderr);
    // A BLOCKED invocation (no failures) cannot carry an environment-failure declaration.
    const blockedRun={...bound,operation_id:'qa-round-2',attempt:2};
    assert.equal(write('start',{...blockedRun,previous_test_run_id:'qa-round-1'}).status,0);
    assert.equal(write('complete',{...blockedRun,result:'BLOCKED',passed:1,failed:0,blocked:1,report:'r.md'}).status,0);
    assert.notEqual(write('superseded',{...blockedRun,...valid,previous_test_run_id:'qa-round-2',failed_cases:[]}).status,0);
    assert.equal(write('superseded',{...blockedRun,previous_test_run_id:'qa-round-2',reason:'host_evidence_problem',
      blocked_cases:['TC-001'],expected_environment:null}).status,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
