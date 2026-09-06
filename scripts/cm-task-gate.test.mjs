import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  GateError,checkN4,checkN5,implementationSha256,loadHandoff,prepareMarkDone,verifyMarkDonePlan,
  checkParallelWrite,
} from './cm-task-gate.mjs';

const scriptsRoot=fileURLToPath(new URL('.',import.meta.url));
const jsGate=path.join(scriptsRoot,'cm-task-gate.mjs');
const pythonGate=path.join(scriptsRoot,'cm-task-gate.py');

async function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-gate-js-')));
  try{return await run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}
}

function writeHandoff(file,{attempt=1,status='ready_for_review',task='T-001',implementation=null}={}){
  const payload={
    schema_version:1,
    task_id:task,
    attempt,
    status,
    changed_files:['src/example.ts'],
    verification:[{command:'npm test -- example',status:'passed',evidence:'tests passed'}],
    evidence:['src/example.ts','tests passed'],
    blockers:status==='blocked'?['needs input']:[],
    scope_deviation:[],
  };
  if(implementation!==null)payload.implementation_sha256=implementation;
  fs.writeFileSync(file,`${JSON.stringify(payload,null,2)}\n`);
}

function writeReview(file,{handoff,attempt=1,verdict='approved',task='T-001'}={}){
  const digest=createHash('sha256').update(fs.readFileSync(handoff)).digest('hex');
  const blocking=verdict==='approved'?0:1;
  const body=verdict==='approved'?'Zero findings.':'Changes are required.';
  fs.writeFileSync(file,`---
at: 2026-09-06T07:00:00-07:00
reviewer: codex-subagent
independent: true
task: ${task}
attempt: ${attempt}
round: ${attempt}
verdict: ${verdict}
blocking_findings: ${blocking}
handoff: ${path.basename(handoff)}
handoff_sha256: ${digest}
scope:
  - src/example.ts
---

${body}
`);
}

test('JS read-only task gate handles the full attempt-2 N4/N5 chain',()=>fixture(root=>{
  const reviews=path.join(root,'.reviews');fs.mkdirSync(reviews);
  const handoff1=path.join(reviews,'login-T-001-a1-handoff.json');
  const review1=path.join(reviews,'login-T-001-r1.md');
  const handoff2=path.join(reviews,'login-T-001-a2-handoff.json');
  const review2=path.join(reviews,'login-T-001-r2.md');
  writeHandoff(handoff1);writeReview(review1,{handoff:handoff1,verdict:'changes_requested'});
  writeHandoff(handoff2,{attempt:2});writeReview(review2,{handoff:handoff2,attempt:2});
  const tasks=path.join(root,'tasks.md');fs.writeFileSync(tasks,'标题\r\n- [ ] T-001: 中文任务\r- [ ] T-010: unrelated\n');

  assert.equal(checkN4({handoff:handoff2,reviewsDir:reviews,feature:'login',task:'T-001',allowLegacyUnbound:true}).outcome,'ready_for_review');
  assert.equal(checkN5({handoff:handoff2,reviewsDir:reviews,feature:'login',task:'T-001',allowLegacyUnbound:true}).outcome,'approved');

  const args=['check-n5','--handoff',handoff2,'--reviews-dir',reviews,'--feature','login','--task','T-001','--allow-legacy-unbound'];
  const js=spawnSync(process.execPath,[jsGate,...args],{encoding:'utf8'});
  const py=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,...args],{encoding:'utf8'});
  assert.equal(js.status,0);assert.equal(py.status,0);
  assert.deepEqual(JSON.parse(js.stdout),JSON.parse(py.stdout));

  const selectors={handoff:handoff2,reviewsDir:reviews,feature:'login',task:'T-001',tasksPath:tasks,allowLegacyUnbound:true};
  const plan=prepareMarkDone(selectors);
  assert.equal(Buffer.from(plan.afterBase64,'base64').toString(),'标题\r\n- [x] T-001: 中文任务\r- [ ] T-010: unrelated\n');
  assert.deepEqual(verifyMarkDonePlan(selectors,plan.planDigest),{outcome:'matched',planDigest:plan.planDigest});
  const planArgs=['prepare-mark-done',...args.slice(1),'--tasks',tasks];
  const jsPlan=spawnSync(process.execPath,[jsGate,...planArgs],{encoding:'utf8'});
  const pyPlan=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,...planArgs],{encoding:'utf8'});
  assert.equal(jsPlan.status,0);assert.equal(pyPlan.status,0);
  assert.deepEqual(JSON.parse(jsPlan.stdout),JSON.parse(pyPlan.stdout));
  fs.appendFileSync(tasks,'changed\n');
  assert.throws(()=>verifyMarkDonePlan(selectors,plan.planDigest),GateError);
  fs.writeFileSync(tasks,'标题\r\n- [ ] T-001: 中文任务\r- [ ] T-010: unrelated\n');
  const marked=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,'mark-done',...args.slice(1),'--tasks',tasks],{encoding:'utf8'});
  assert.equal(marked.status,0,marked.stderr);assert.equal(JSON.parse(marked.stdout).outcome,'marked_done');
  assert.match(fs.readFileSync(tasks,'utf8'),/- \[x\] T-001/);
}));

test('JS read-only task gate rejects malformed handoff and non-approved N5 evidence',()=>fixture(root=>{
  const reviews=path.join(root,'.reviews');fs.mkdirSync(reviews);
  const duplicate=path.join(reviews,'login-T-001-a1-handoff.json');
  fs.writeFileSync(duplicate,'{"schema_version":1,"schema_version":1}\n');
  assert.throws(()=>loadHandoff(duplicate,{task:'T-001',attempt:1}),GateError);
  fs.writeFileSync(duplicate,'{"schema_version":1.0,"task_id":"T-001","attempt":1,"status":"ready_for_review","changed_files":[],"verification":[{"command":"test","status":"passed","evidence":"passed"}],"evidence":["passed"],"blockers":[],"scope_deviation":[]}\n');
  assert.throws(()=>loadHandoff(duplicate,{task:'T-001',attempt:1}),GateError);

  writeHandoff(duplicate);
  writeReview(path.join(reviews,'login-T-001-r1.md'),{handoff:duplicate,verdict:'changes_requested'});
  assert.throws(()=>checkN5({handoff:duplicate,reviewsDir:reviews,feature:'login',task:'T-001',allowLegacyUnbound:true}),GateError);
}));

test('JS task gate binds N4/N5 to current implementation bytes and rejects drift',()=>fixture(root=>{
  const project=path.join(root,'project'),reviews=path.join(root,'.reviews');
  fs.mkdirSync(path.join(project,'src'),{recursive:true});fs.mkdirSync(reviews);
  const source=path.join(project,'src','example.ts');fs.writeFileSync(source,'export const value = 1;\n');
  const digest=implementationSha256(project,['src/example.ts']);
  const handoff=path.join(reviews,'bound-T-001-a1-handoff.json');
  writeHandoff(handoff,{implementation:digest});writeReview(path.join(reviews,'bound-T-001-r1.md'),{handoff});
  const selectors={handoff,reviewsDir:reviews,feature:'bound',task:'T-001',projectRoot:project};
  assert.equal(checkN4(selectors).content_bound,true);assert.equal(checkN5(selectors).content_bound,true);
  const cli=spawnSync(process.execPath,[jsGate,'hash-implementation','--project-root',project,'--file','src/example.ts'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).implementation_sha256,digest);
  fs.writeFileSync(source,'export const value = 2;\n');
  assert.throws(()=>checkN5(selectors),/implementation content changed after handoff/);
}));

test('JS parallel-write gate accepts isolated worktrees and rejects duplicate assignments',()=>fixture(root=>{
  const repo=path.join(root,'repo'),worktree=path.join(root,'worker');fs.mkdirSync(repo);
  const git=(directory,...args)=>{
    const result=spawnSync('git',['-C',directory,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  git(repo,'init','-b','main');git(repo,'config','user.name','CM Fixture');git(repo,'config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'fixture.txt'),'fixture\n');git(repo,'add','fixture.txt');git(repo,'commit','-m','fixture');
  git(repo,'worktree','add','-b','worker',worktree);
  const assignments=[`T-001=${repo}`,`T-002=${worktree}`];
  assert.equal(checkParallelWrite({repo,assignment:assignments}).outcome,'isolated');
  assert.throws(()=>checkParallelWrite({repo,assignment:[assignments[0],`T-001=${worktree}`]}),GateError);
}));

test('Windows lock serializes two task completions without losing either checkbox',{skip:process.platform!=='win32'},()=>fixture(async root=>{
  const reviews=path.join(root,'.reviews');fs.mkdirSync(reviews);
  const tasks=path.join(root,'tasks.md');fs.writeFileSync(tasks,'- [ ] T-001: first\r\n- [ ] T-002: second\r\n');
  const launch=task=>{
    const handoff=path.join(reviews,`login-${task}-a1-handoff.json`);
    writeHandoff(handoff,{task});writeReview(path.join(reviews,`login-${task}-r1.md`),{handoff,task});
    const child=spawn(process.env.CM_PYTHON_BIN||'python3',[pythonGate,'mark-done','--handoff',handoff,
      '--reviews-dir',reviews,'--feature','login','--task',task,'--tasks',tasks,'--allow-legacy-unbound'],{stdio:['ignore','pipe','pipe']});
    return new Promise((resolve,reject)=>{
      let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));
    });
  };
  const results=await Promise.all([launch('T-001'),launch('T-002')]);
  for(const result of results)assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(tasks,'utf8'),'- [x] T-001: first\r\n- [x] T-002: second\r\n');
}));
