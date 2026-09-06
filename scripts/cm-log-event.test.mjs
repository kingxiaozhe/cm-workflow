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
