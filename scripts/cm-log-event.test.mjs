import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {applyResourceTransition,buildEvent,parseData,selectRunId,unclosedResources,UsageError} from './cm-log-event.mjs';

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

test('regression: run_start of another workflow opens a new run instead of joining a stale running one',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-log-cross-')));
  try{
    const project=path.join(root,'project'),specs=path.join(root,'specs');fs.mkdirSync(project);fs.mkdirSync(specs);
    const env={...process.env,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
    const write=(workflow,event)=>{
      const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonWriter,'--workflow',workflow,'--event',event,'--runtime','codex',
        '--project-root',project,'--specs-dir',specs,'--detail',event],{encoding:'utf8',env});
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).run_id;
    };
    const stale=write('cm-ai','run_start'); // 9 月遗留：cm-ai 开了运行但没写 run_done
    assert.equal(write('cm-ai','run_start'),stale,'same-workflow run_start still continues the running run');
    const fix=write('cm-fix','run_start');
    assert.notEqual(fix,stale);
    assert.equal(write('cm-fix','progress'),fix);
    assert.equal(write('cm-fix','run_done'),fix);
    const pointer=JSON.parse(fs.readFileSync(path.join(specs,'.cm-run.json'),'utf8'));
    assert.equal(pointer.run_id,fix);assert.equal(pointer.workflow,'cm-fix');
    const rows=fs.readFileSync(path.join(specs,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual([...new Set(rows.filter(row=>row.run_id===stale).map(row=>row.workflow))],['cm-ai']);
    // 指针丢失时从项目日志重建，同样不把新工作流接到别人的运行上。
    fs.rmSync(specs,{recursive:true});fs.mkdirSync(specs);
    const orphan=write('cm-ai','run_start');fs.rmSync(path.join(specs,'.cm-run.json'));
    assert.equal(write('cm-ai','progress'),orphan,'same workflow still reconstructs its running run');
    fs.rmSync(path.join(specs,'.cm-run.json'));
    assert.notEqual(write('cm-test','run_start'),orphan);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('regression: run_start falls back to the pointer workflow when history rows lack one',()=>{
  const base={event:'run_start',workflow:'cm-fix',latestProjectRun:'old-ai-run',projectStates:{'old-ai-run':'running'},projectWorkflows:{},
    now:new Date('2026-10-21T00:00:00Z'),uuid:'00000000-0000-4000-8000-000000000000'};
  const pointer={run_id:'old-ai-run',status:'running',workflow:'cm-ai'};
  assert.notEqual(selectRunId({...base,pointer}).runId,'old-ai-run');
  // 指针指向别的运行时，不能借用它的工作流；双方都不知道所属工作流时仍按原行为沿用。
  assert.equal(selectRunId({...base,pointer:{...pointer,run_id:'other-run',status:'done'}}).runId,'old-ai-run');
  assert.equal(selectRunId({...base,pointer:null}).runId,'old-ai-run');
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

// The project log is shared by every run in a specs root. A final record without
// LF (a truncated write, a hand-made recovery) must not be glued to the next one.
function seededLog(tail){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-log-tail-')));
  const project=path.join(root,'project'),specs=path.join(root,'specs'),globalHome=path.join(root,'logs');
  fs.mkdirSync(project);fs.mkdirSync(specs);
  const log=path.join(specs,'运行日志.jsonl');
  const earlier=JSON.stringify({schema_version:1,at:'2026-07-29T09:00:00-07:00',workflow:'cm-prd',event:'run_done',run_id:'prd-earlier',status:'done'});
  fs.writeFileSync(log,Buffer.concat([Buffer.from(earlier+'\n'),Buffer.isBuffer(tail)?tail:Buffer.from(tail)]));
  const write=()=>spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonWriter,'--workflow','cm-ai','--event','run_start','--phase','start',
    '--runtime','codex','--project-root',project,'--specs-dir',specs,'--run-id','20260729T160000Z-active02','--detail','开始执行',
    '--at','2026-07-29T09:10:00-07:00','--data-json','{"feature":"1.login"}'],{encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:globalHome}});
  return {root,log,earlier,write};
}
test('appending after a complete final record without LF closes that record first',()=>{
  const tail=JSON.stringify({schema_version:1,at:'2026-07-29T09:05:00-07:00',workflow:'cm-ai',event:'progress',run_id:'other-run',detail:'no newline'});
  const f=seededLog(tail);
  try{
    const result=f.write();assert.equal(result.status,0,result.stderr);
    const text=fs.readFileSync(f.log,'utf8');
    assert(text.endsWith('\n'));
    const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows.length,3);
    assert.equal(JSON.stringify(rows[0]),f.earlier);assert.equal(JSON.stringify(rows[1]),tail);
    assert.equal(rows[2].run_id,'20260729T160000Z-active02');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a half-written final record is refused and the log keeps its exact bytes',()=>{
  const f=seededLog('{"schema_version":1,"workflow":"cm-ai","run_id":"half');
  try{
    const before=fs.readFileSync(f.log);
    const result=f.write();
    assert.notEqual(result.status,0);assert.match(result.stderr,/log_tail_incomplete/);
    assert.deepEqual(fs.readFileSync(f.log),before);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a whitespace-only tail is padding the next record starts after, not an incomplete record',()=>{
  const f=seededLog(' \t\r ');
  try{
    const result=f.write();assert.equal(result.status,0,result.stderr);
    const lines=fs.readFileSync(f.log,'utf8').trimEnd().split('\n');
    assert.equal(lines.length,2);assert.equal(lines[0],f.earlier);
    assert.equal(JSON.parse(lines[1]).run_id,'20260729T160000Z-active02');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a closed final record holding invalid UTF-8 is refused like a half-written one',()=>{
  const f=seededLog(Buffer.concat([Buffer.from('{"schema_version":1,"run_id":"bad","detail":"'),Buffer.from([0xff,0xfe]),Buffer.from('"}')]));
  try{
    const before=fs.readFileSync(f.log);
    const result=f.write();
    assert.notEqual(result.status,0);assert.match(result.stderr,/log_tail_incomplete/);
    assert.deepEqual(fs.readFileSync(f.log),before);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a final record past the 4 MiB tail bound is refused even when an earlier LF exists',()=>{
  const f=seededLog(JSON.stringify({schema_version:1,run_id:'huge',detail:'x'.repeat(4*1024*1024)}));
  try{
    const before=fs.statSync(f.log).size;
    const result=f.write();
    assert.notEqual(result.status,0);assert.match(result.stderr,/log_tail_incomplete/);
    assert.equal(fs.statSync(f.log).size,before);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
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
