// #27 one tasks.md grammar for admission, cm-prd checks, N5 mark-done and the
// approval manifest; #28 one dependency rule for nextTask and --task.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectCmAiAdmission,approveCmAiSpecs,parseFeatureTaskText} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {captureSpecificationMaterial} from '../runtime/js/cm-ai/specification-material.mjs';
import {checkPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {parseTasks} from './cm-failover.mjs';

// N5 mark-done and admission may write run logs: keep them out of the invoking user's home.
const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-line-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));
const scripts=fileURLToPath(new URL('.',import.meta.url));
const gate=path.join(scripts,'cm-task-gate.py'),admissionCli=path.join(scripts,'cm-ai-admission.mjs');
const oracle=path.join(scripts,'fixtures','spec-manifest-python-oracle.py');
const python=process.env.CM_PYTHON_BIN||'python3';

function fixture(tasks,run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-line-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Requirements\n- [ ] [AC-001] login works\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),tasks);
  try{return run({root,specs,code,feature,tasksPath:path.join(feature,'tasks.md')});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
// The real N5 path: an approved legacy-unbound handoff/review pair, then the
// Python lock adapter's mark-done, which delegates the line edit to cm-task-gate.mjs.
function markDone({specs,tasksPath},task){
  const reviews=path.join(specs,'.reviews');fs.mkdirSync(reviews,{recursive:true});
  const handoff=path.join(reviews,`login-${task}-a1-handoff.json`);
  fs.writeFileSync(handoff,JSON.stringify({schema_version:1,task_id:task,attempt:1,status:'ready_for_review',
    changed_files:['src/login.ts'],verification:[{command:'npm test',status:'passed',evidence:'passed'}],
    evidence:['src/login.ts'],blockers:[],scope_deviation:[]},null,2)+'\n');
  const sha=createHash('sha256').update(fs.readFileSync(handoff)).digest('hex');
  fs.writeFileSync(path.join(reviews,`login-${task}-r1.md`),`---\nat: 2026-09-28T07:00:00-07:00\nreviewer: codex-subagent\n`
    +`independent: true\ntask: ${task}\nattempt: 1\nround: 1\nverdict: approved\nblocking_findings: 0\n`
    +`handoff: ${path.basename(handoff)}\nhandoff_sha256: ${sha}\nscope:\n  - src/login.ts\n---\n\nZero findings.\n`);
  return spawnSync(python,[gate,'mark-done','--handoff',handoff,'--reviews-dir',reviews,'--feature','login',
    '--task',task,'--tasks',tasksPath,'--allow-legacy-unbound'],{encoding:'utf8'});
}

for(const [label,line,description='实现登录'] of [
  ['no colon','- [ ] T-001 实现登录'],
  ['dash separator','- [ ] T-001 - 实现登录','- 实现登录'],
  ['nested four-space item','- 阶段一\n    - [ ] T-001: 实现登录'],
  ['full-width colon','- [ ] T-001：实现登录'],
])test(`${label}: a task admission selects stays approved after the real N5 mark-done`,()=>
  fixture(`# tasks\n${line}\n- [ ] T-002: 退出登录\n\n- T-002 依赖 T-001\n`,f=>{
    const approved=approveCmAiSpecs({specsDir:f.specs,codeProject:f.code,approvalResponse:'开始'});
    assert.equal(approved.approveRefused,undefined);
    const before=inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code});
    assert.equal(before.state,'ready');assert.equal(before.nextTask.id,'T-001');
    assert.equal(before.nextTask.description,description);
    const marked=markDone(f,'T-001');
    assert.equal(marked.status,0,marked.stderr);
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-001/);
    const after=inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code});
    assert.equal(after.reason,'task_selected',`admission after N5: ${after.state}/${after.reason}`);
    assert.equal(after.nextTask.id,'T-002');
    // The next task's material still binds the unchanged approval.
    assert.equal(captureSpecificationMaterial({specsRoot:f.specs,feature:'1.login',taskId:'T-002'}).task.id,'T-002');
  }));

test('a manifest approved by the pre-grammar rule keeps matching the same bytes',()=>
  fixture('- [x] T-001 已完成且无冒号\n- [ ] T-002 待做\n',f=>{
    // Legacy-shaped approval: the frozen pre-migration implementation wrote these rows.
    const legacy=spawnSync(python,[oracle,f.specs],{encoding:'utf8'});
    assert.equal(legacy.status,0,legacy.stderr);
    const specFiles=JSON.parse(legacy.stdout).specFiles;
    const tasksRow=row=>row.path==='1.login/tasks.md';
    assert.notEqual(specFiles.find(tasksRow).sha256,buildManifest(f.specs).find(tasksRow).sha256,
      'fixture must exercise a digest the new grammar computes differently');
    fs.writeFileSync(path.join(f.specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],specFiles}));
    const admission=inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code});
    assert.equal(admission.state,'ready');assert.equal(admission.nextTask.id,'T-002');
    const material=captureSpecificationMaterial({specsRoot:f.specs,feature:'1.login',taskId:'T-002'});
    assert.deepEqual(material.sources,specFiles,'material keeps the approved digests');
    const cli=spawnSync(process.execPath,[path.join(scripts,'cm-spec-manifest.mjs'),f.specs,'--status-file',
      path.join(f.specs,'.cm-specs-status')],{encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    // Real drift still fails closed.
    fs.appendFileSync(f.tasksPath,'- [ ] T-003 新增\n');
    assert.equal(inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code}).reason,'spec_drift');
  }));

test('fenced examples are never declarations for admission, cm-prd, failover or N5',()=>
  fixture('- [ ] T-001: real\n```md\n- [ ] T-001: example copy\n- [x] T-009: example\n```\n',f=>{
    const parsed=parseFeatureTaskText(fs.readFileSync(f.tasksPath,'utf8'));
    assert.deepEqual(parsed.tasks.map(task=>task.id),['T-001']);
    assert.deepEqual(parseTasks(fs.readFileSync(f.tasksPath,'utf8')).map(task=>task.id),['T-001']);
    approveCmAiSpecs({specsDir:f.specs,codeProject:f.code,approvalResponse:'开始'});
    const marked=markDone(f,'T-001');assert.equal(marked.status,0,marked.stderr);
    assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [x] T-001: real\n```md\n- [ ] T-001: example copy\n- [x] T-009: example\n```\n');
    assert.equal(inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code}).state,'complete');
  }));

test('cm-prd self-check reads the same declarations as admission',()=>{
  const contract={schemaVersion:'1.0',feature:'sample',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
    acIds:['AC-001'],taskIds:['T-001'],title:'Check',preconditions:[],steps:['Do'],expected:['Works'],cleanup:[]}]};
  for(const tasks of ['- [ ] T-001：全角冒号','- [ ] T-001 无冒号','- 父项\n    - [ ] T-001: 嵌套']){
    const report=checkPrdDraftMechanics({draftDigest:'a'.repeat(64),features:[{directory:'1.sample',name:'sample',documents:[
      {path:'requirements.md',content:'- [ ] [AC-001] Works.'},{path:'tasks.md',content:tasks},
      {path:'test-cases.json',content:JSON.stringify(contract)}]}]});
    assert.equal(report.status,'mechanical_subset_passed',`${tasks}: ${JSON.stringify(report.findings)}`);
    assert.deepEqual(parseFeatureTaskText(tasks).tasks.map(task=>task.id),['T-001']);
  }
});

test('#28 --task on a task whose prerequisite was DROPPED matches nextTask semantics',()=>
  fixture('- [x] T-001: a\n- [ ] ~~T-002: b~~ `[DROPPED v2]`\n- [ ] T-003: c\n- [ ] T-004: d\n\n- T-003 依赖 T-002\n- T-004 依赖 T-003\n',f=>{
    approveCmAiSpecs({specsDir:f.specs,codeProject:f.code,approvalResponse:'开始'});
    const admission=inspectCmAiAdmission({specsDir:f.specs,codeProject:f.code});
    assert.equal(admission.nextTask.id,'T-003');
    assert.deepEqual(admission.eligibleTasks.map(task=>task.id),['T-003']);
    const print=task=>spawnSync(process.execPath,[admissionCli,'--specs-dir',f.specs,'--code-project',f.code,
      '--print-run-definition','--scope','src/a.js','--task',task],{encoding:'utf8'});
    const selected=print('T-003');
    assert.equal(selected.status,0,selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout).taskSelection,{version:1,taskId:'T-003'});
    // A real mismatch names why instead of a bare code.
    for(const [task,reason] of [['T-004',/T-004 依赖的 T-003 尚未完成/],['T-001',/T-001 已勾选完成/],
      ['T-002',/T-002 已标记 DROPPED/],['T-404',/没有任务 T-404/]]){
      const refused=print(task);assert.equal(refused.status,1);
      const error=JSON.parse(refused.stderr).error;
      assert.equal(error.code,'task_selection_mismatch');assert.match(error.reason,reason);
    }
  }));
