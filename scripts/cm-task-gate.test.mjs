import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  GateError,checkN4,checkN5,implementationSha256,loadHandoff,prepareMarkDone,verifyMarkDonePlan,validateReview,
  checkParallelWrite,markDoneLocked,
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

test('Skill Learning gate rejects missing or pending records and binds reviewed writeback',()=>fixture(root=>{
  const reviews=path.join(root,'.reviews');fs.mkdirSync(reviews);
  fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/example.ts'),'fixture');
  const handoff=path.join(reviews,'login-T-001-a1-handoff.json'),review=path.join(reviews,'login-T-001-r1.md');
  const tasks=path.join(root,'tasks.md');fs.writeFileSync(tasks,'- [ ] T-001: fixture\n');
  writeHandoff(handoff,{implementation:implementationSha256(root,['src/example.ts'])});
  const options={handoff,reviewsDir:reviews,feature:'login',task:'T-001',projectRoot:root,requireLearning:true,allowLegacyUnbound:true};
  assert.throws(()=>checkN4(options),/Learning/);
  const payload=JSON.parse(fs.readFileSync(handoff));
  const save=()=>{fs.writeFileSync(handoff,JSON.stringify(payload));writeReview(review,{handoff});};
  payload.evidence=['learning: no_relevant_lesson','learning: retrospective writeback_pending'];save();
  assert.throws(()=>checkN5(options),/Learning/);
  payload.evidence[1]='learning: retrospective no_new_lesson';save();
  assert.equal(checkN4(options).outcome,'ready_for_review');
  assert.equal(checkN5(options).outcome,'approved');
  payload.evidence[1]='learning: retrospective written AGENTS.md';save();
  assert.throws(()=>checkN5(options),/AGENTS/);
  fs.writeFileSync(path.join(root,'AGENTS.md'),'# A reviewed lesson\n');payload.changed_files.push('AGENTS.md');
  payload.implementation_sha256=implementationSha256(root,payload.changed_files);save();
  fs.writeFileSync(review,fs.readFileSync(review,'utf8').replace('  - src/example.ts','  - src/example.ts\n  - AGENTS.md'));
  assert.equal(checkN5(options).outcome,'approved');
  fs.appendFileSync(path.join(root,'AGENTS.md'),'unreviewed');
  assert.throws(()=>checkN5(options),/content changed/);
  payload.evidence=['learning: no_relevant_lesson','learning: retrospective no_new_lesson'];
  payload.changed_files=['src/example.ts'];payload.implementation_sha256=implementationSha256(root,payload.changed_files);save();
  const args=['mark-done','--allow-legacy-unbound','--require-learning','--handoff',handoff,'--reviews-dir',reviews,'--feature','login','--task','T-001','--tasks',tasks,'--project-root',root];
  payload.evidence=['synthetic implementation check passed'];save();
  assert.equal(checkN5({...options,requireLearning:false}).outcome,'approved');
  const blocked=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,...args],{encoding:'utf8'});
  assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/Learning/);
  assert.match(fs.readFileSync(tasks,'utf8'),/\[ \]/);
  // Exercise the locked JS entry independently of Python's earlier prepare rejection.
  const selectors={...options,tasksPath:tasks},legacyPlan=prepareMarkDone({...selectors,requireLearning:false});
  const lock=process.platform==='win32'?path.join(reviews,'.cm-task-write.lock'):path.join(reviews,'.execution','writer.sqlite');
  fs.mkdirSync(path.dirname(lock),{recursive:true,mode:0o700});const madeLock=!fs.existsSync(lock);
  if(madeLock)fs.writeFileSync(lock,'');
  try{assert.throws(()=>markDoneLocked(selectors,legacyPlan.planDigest,{
    CM_TASK_GATE_LOCK_ADAPTER:'1',CM_TASK_GATE_LOCK_PARENT_PID:String(process.ppid),CM_TASK_GATE_WRITER_LOCK:lock}),/Learning/);
  }finally{if(madeLock)fs.unlinkSync(lock);}
  assert.match(fs.readFileSync(tasks,'utf8'),/\[ \]/);
  payload.evidence=['learning: no_relevant_lesson','learning: retrospective no_new_lesson'];save();
  const done=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,...args],{encoding:'utf8'});
  assert.equal(done.status,0,done.stderr);assert.match(fs.readFileSync(tasks,'utf8'),/\[x\]/);
}));

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
  const selectors={handoff,reviewsDir:reviews,feature:'bound',task:'T-001',projectRoot:project,allowLegacyUnbound:true};
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


test('approved body needs a standalone zero-blocking conclusion line; older evidence keeps the legacy reading',()=>fixture(root=>{
  const handoff=path.join(root,'handoff.json'),review=path.join(root,'review.md');
  writeHandoff(handoff);writeReview(review,{handoff});
  const legacy=fs.readFileSync(review,'utf8'),selected={task:'T-001',attempt:1,handoff,changedFiles:['src/example.ts']};
  const strict=legacy.replace('at: 2026-09-06T07:00:00-07:00','at: 2026-10-21T08:00:00Z');
  const accepts=(base,body)=>{fs.writeFileSync(review,base.replace('Zero findings.',body));return validateReview(review,selected).verdict==='approved';};
  const rejects=(base,body)=>{fs.writeFileSync(review,base.replace('Zero findings.',body));
    assert.throws(()=>validateReview(review,selected),error=>error instanceof GateError&&/explicitly state zero blocking findings/.test(error.message),body);};
  for(const phrase of ['零发现','零阻塞发现','零阻断发现','无阻塞发现','无阻断发现','未发现阻塞','未发现阻断','Zero findings','no findings','No blocking findings'])
    assert.ok(accepts(strict,`审查了全部范围。\n\n结论：${phrase}。`),phrase);
  for(const body of ['Zero findings.','No blocking findings.','- **结论：** 零阻断发现。','**结论：零阻塞发现。**','Conclusion: no blocking findings','说明。\r\n\r\n结论：零阻塞发现。'])
    assert.ok(accepts(strict,body),body);
  for(const body of ['未发现阻断问题以外的问题。','零阻断发现？','零阻断发现 ？','不能说零阻塞发现。','零阻断发现，并不成立。仍有一个阻断问题。',
    '不能宣称 e.g. no blocking findings，因为仍有阻断问题。','结论：approved，零 findings。No blocking findings. 已核对 handoff。',
    '> 其他审查：零阻断发现\n\n本次仍存在一个阻断问题。','> 结论：零阻塞发现。\n\n本次仍存在一个阻断问题。','{"conclusion":"> Zero findings."}','```\nZero findings.\n```','~~~\n~~~javascript\nZero findings.',
    '{"conclusion":"> 旧结果。No blocking findings."}','{"conclusion":"~~~\\n说明。Zero findings.\\n~~~"}','["e.g. No blocking findings."]',
    '{"summary":"x"}\n','blocker、major、minor 都是 0。'])
    rejects(strict,body);
  // 启用前的凭证按原判定：原有说法出现在任意位置即可，新增说法不回溯放宽。
  assert.ok(accepts(legacy,'结论：approved，零 findings。No blocking findings. 已核对 handoff。'));
  rejects(legacy,'结论：零阻断发现。');
  fs.writeFileSync(review,strict.replace('Zero findings.','blocker、major、minor 都是 0。'));
  assert.throws(()=>validateReview(review,selected),error=>error instanceof GateError
    &&/standalone conclusion line/.test(error.message)&&/零阻塞发现/.test(error.message)&&/regenerate/.test(error.message));
  fs.writeFileSync(review,strict.replace('reviewer: codex-subagent','reviewer: codex-cli (gpt-6.1-sol, reasoning high, read-only)'));
  assert.throws(()=>validateReview(review,selected),error=>error instanceof GateError
    &&/unsupported reviewer source declaration/.test(error.message)&&/codex-subagent, codex-cli, claude-cli, self-degraded/.test(error.message));
}));

test('reviewer and independent fields validate declaration format and consistency',()=>fixture(root=>{
  const handoff=path.join(root,'handoff.json'),review=path.join(root,'review.md');
  writeHandoff(handoff);writeReview(review,{handoff});
  const original=fs.readFileSync(review,'utf8'),selected={task:'T-001',attempt:1,handoff,changedFiles:['src/example.ts']};
  assert.equal(validateReview(review,selected).reviewer,'codex-subagent');
  for(const [before,after] of [
    ['reviewer: codex-subagent','reviewer: unknown-source'],
    ['independent: true','independent: yes'],
    ['independent: true','independent: false'],
    ['reviewer: codex-subagent','reviewer: self-degraded'],
  ]){
    fs.writeFileSync(review,original.replace(before,after));
    assert.throws(()=>validateReview(review,selected),undefined,after);
  }
  fs.writeFileSync(review,original.replace('reviewer: codex-subagent','reviewer: self-degraded')
    .replace('independent: true','independent: false').replace('scope:','degraded_reason: Declared fallback source\nscope:'));
  assert.equal(validateReview(review,selected).reviewer,'self-degraded');
}));

// Compatibility inventory fixtures use the public CLI before any source edit.
function inventoryFixture(root,{nested=false}={}){
  const reviewsDir=path.join(root,nested?'specs/.reviews':'.reviews');fs.mkdirSync(reviewsDir,{recursive:true});
  fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/example.ts'),'before');
  const selectors={projectRoot:root,reviewsDir,feature:'inventory',task:'T-001',
    handoff:path.join(reviewsDir,'inventory-T-001-a1-handoff.json')};
  const capture=()=>spawnSync(process.execPath,[jsGate,'capture-baseline','--project-root',root,
    '--reviews-dir',reviewsDir,'--feature','inventory','--task','T-001'],{encoding:'utf8'});
  const deliver=(files=['src/example.ts'],attempt=1)=>{
    selectors.handoff=path.join(reviewsDir,`inventory-T-001-a${attempt}-handoff.json`);
    writeHandoff(selectors.handoff,{attempt,implementation:implementationSha256(root,files)});
    const payload=JSON.parse(fs.readFileSync(selectors.handoff));payload.changed_files=files;
    fs.writeFileSync(selectors.handoff,JSON.stringify(payload));
    const review=path.join(reviewsDir,`inventory-T-001-r${attempt}.md`);
    writeReview(review,{handoff:selectors.handoff,attempt});
    fs.writeFileSync(review,fs.readFileSync(review,'utf8').replace('  - src/example.ts',files.map(p=>`  - ${p}`).join('\n')));
  };
  return {selectors,capture,deliver,baseline:path.join(reviewsDir,'inventory-T-001-baseline.json')};
}

test('Python mark-done emits UTF-8 JSON and errors under cp1252',()=>fixture(root=>{
  const f=inventoryFixture(root,{nested:true});f.deliver();
  const tasksPath=path.join(root,'specs/tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const args=['mark-done','--allow-legacy-unbound','--handoff',f.selectors.handoff,
    '--reviews-dir',f.selectors.reviewsDir,'--feature','inventory','--task','T-001',
    '--tasks',tasksPath,'--project-root',root];
  const run=()=>spawnSync(process.env.CM_PYTHON_BIN||'python3',[pythonGate,...args],
    {env:{...process.env,PYTHONIOENCODING:'cp1252'}});
  const done=run();
  assert.equal(done.status,0,done.stderr.toString('utf8'));
  const stdout=done.stdout.toString('utf8');assert.deepEqual(Buffer.from(stdout,'utf8'),done.stdout);
  const result=JSON.parse(stdout);
  assert.equal(result.inventory,'unverified');
  assert.equal(result.inventory_note,'未捕获编辑前基线，不保证清单完整，只保证已列文件的内容绑定');
  assert.match(fs.readFileSync(tasksPath,'utf8'),/\[x\]/);

  fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');assert.equal(f.capture().status,0);
  fs.writeFileSync(path.join(root,'src/example.ts'),'after');fs.writeFileSync(path.join(root,'extra.ts'),'omitted');
  f.deliver();
  const blocked=run(),stderr=blocked.stderr.toString('utf8');
  assert.equal(blocked.status,1);assert.equal(blocked.stdout.length,0);
  assert.deepEqual(Buffer.from(stderr,'utf8'),blocked.stderr);
  assert.match(stderr,/ERROR:.*改了但没列: extra.ts/);assert.doesNotMatch(stderr,/Traceback|UnicodeEncodeError/);
  assert.match(fs.readFileSync(tasksPath,'utf8'),/\[ \]/);
}));

test('library default N4 and N5 preserve exact results without an editing baseline',()=>fixture(root=>{
  const f=inventoryFixture(root);f.deliver();
  const n4={gate:'n4',task:'T-001',attempt:1,outcome:'ready_for_review',
    handoff_sha256:createHash('sha256').update(fs.readFileSync(f.selectors.handoff)).digest('hex'),content_bound:true};
  const n5={gate:'n5',task:'T-001',attempt:1,outcome:'approved',
    review:path.join(f.selectors.reviewsDir,'inventory-T-001-r1.md'),content_bound:true};
  assert.equal(JSON.stringify(checkN5(f.selectors)),JSON.stringify(n5));
  assert.equal(JSON.stringify(checkN4(f.selectors)),JSON.stringify(n4));
  // Even an invalid CLI baseline must not change a library caller's contract.
  fs.writeFileSync(f.baseline,'invalid baseline');
  assert.equal(JSON.stringify(checkN5(f.selectors)),JSON.stringify(n5));
  fs.writeFileSync(path.join(root,'src/example.ts'),'drift');
  for(const check of [checkN4,checkN5])assert.throws(()=>check(f.selectors),
    {name:'GateError',message:'implementation content changed after handoff'});
}));

test('library default prepare and verify mark done succeed without an editing baseline',()=>fixture(root=>{
  const f=inventoryFixture(root,{nested:true});f.deliver();
  const tasksPath=path.join(root,'specs/tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const selectors={...f.selectors,tasksPath},plan=prepareMarkDone(selectors);
  assert.equal(plan.protocol,'cm-mark-done-plan');assert.equal(plan.evidence.length,2);
  assert.equal(Buffer.from(plan.afterBase64,'base64').toString(),'- [x] T-001: fixture\n');
  assert(!Object.keys(plan).some(key=>key.startsWith('inventory')));
  assert.equal(JSON.stringify(verifyMarkDonePlan(selectors,plan.planDigest)),
    JSON.stringify({outcome:'matched',planDigest:plan.planDigest}));
  assert.throws(()=>verifyMarkDonePlan(selectors,'0'.repeat(64)),
    {name:'GateError',message:'preparation plan changed; refusing stale proposal'});
}));

for(const command of ['check-n4','check-n5','prepare-mark-done','verify-mark-done-plan','mark-done-locked']){
  test(`CLI ${command} requires an editing baseline`,()=>fixture(root=>{
    const f=inventoryFixture(root,{nested:true});f.deliver();
    const tasksPath=path.join(root,'specs/tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
    const args=[command,'--handoff',f.selectors.handoff,'--reviews-dir',f.selectors.reviewsDir,
      '--feature','inventory','--task','T-001','--project-root',root];
    if(command.includes('mark-done'))args.push('--tasks',tasksPath);
    if(['verify-mark-done-plan','mark-done-locked'].includes(command))args.push('--expected-plan-digest','0'.repeat(64));
    const lock=process.platform==='win32'?path.join(f.selectors.reviewsDir,'.cm-task-write.lock')
      :path.join(f.selectors.reviewsDir,'.execution/writer.sqlite');
    if(command==='mark-done-locked'){fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,'');}
    const result=spawnSync(process.execPath,[jsGate,...args],{encoding:'utf8',env:{...process.env,
      CM_TASK_GATE_LOCK_ADAPTER:'1',CM_TASK_GATE_LOCK_PARENT_PID:String(process.pid),CM_TASK_GATE_WRITER_LOCK:lock}});
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/missing editing baseline/);
    assert.equal(result.stdout,'');assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [ ] T-001: fixture\n');
  }));
}

test('inventory baseline capture seals metadata only and refuses overwrite',()=>fixture(root=>{
  const f=inventoryFixture(root);fs.writeFileSync(path.join(root,'AGENTS.md'),'x'.repeat(1024*1024+1));
  const result=f.capture();assert.equal(result.status,0,result.stderr);
  const b=JSON.parse(fs.readFileSync(f.baseline));
  assert.equal(b.kind,'cm-task-inventory-baseline');assert.deepEqual(b.identity,{feature:'inventory',task:'T-001'});
  assert.match(b.rootDigest,/^[a-f0-9]{64}$/);assert.match(b.baselineDigest,/^[a-f0-9]{64}$/);
  assert.equal(b.ignorePolicy.version,2);assert(!b.files.some(file=>'contentBase64' in file));
  assert.deepEqual(b.files.map(file=>file.path),['AGENTS.md','src/example.ts']);
  const original=fs.readFileSync(f.baseline);assert.notEqual(f.capture().status,0);assert.deepEqual(fs.readFileSync(f.baseline),original);
}));

test('inventory missing baseline refuses N4 and N5 unless legacy flag is explicit',()=>fixture(root=>{
  const f=inventoryFixture(root);f.deliver();
  for(const check of [checkN4,checkN5]){
    assert.throws(()=>check({...f.selectors,inventory:'required'}),/baseline/);
    const result=check({...f.selectors,inventory:'required',allowLegacyUnbound:true});assert.equal(result.inventory,'unverified');
    assert.equal(result.inventory_note,'未捕获编辑前基线，不保证清单完整，只保证已列文件的内容绑定');
    assert.equal(result.content_bound,true);
  }
}));

test('inventory exact set catches omitted additions and falsely listed unchanged files',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  fs.writeFileSync(path.join(root,'extra.ts'),'extra');f.deliver();
  for(const check of [checkN4,checkN5])assert.throws(()=>check({...f.selectors,inventory:'required'}),error=>
    error instanceof GateError&&/改了但没列.*extra.ts/.test(error.message)&&/列了但没改.*src\/example.ts/.test(error.message));
  f.deliver(['extra.ts']);assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:1,modified:0,deleted:0});
}));

test('inventory deletion must be listed and keeps missing-file content binding',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  fs.unlinkSync(path.join(root,'src/example.ts'));f.deliver([]);
  for(const check of [checkN4,checkN5])assert.throws(()=>check({...f.selectors,inventory:'required'}),/改了但没列.*src\/example.ts/);
  f.deliver();assert.equal(checkN4({...f.selectors,inventory:'required'}).inventory,'verified');
  assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:0,modified:0,deleted:1});
  fs.writeFileSync(path.join(root,'src/example.ts'),'recreated');assert.throws(()=>checkN5({...f.selectors,inventory:'required'}),/content changed/);
}));

test('inventory excludes root reviews and nested specs evidence throughout N4 and N5',()=>fixture(root=>{
  const f=inventoryFixture(root,{nested:true});assert.equal(f.capture().status,0);
  fs.mkdirSync(path.join(root,'.reviews'));fs.writeFileSync(path.join(root,'.reviews','unrelated-review.md'),'audit');
  for(const p of ['specs/运行日志.jsonl','specs/.cm-status.json','specs/tasks.md'])fs.writeFileSync(path.join(root,p),'runtime');
  fs.writeFileSync(path.join(root,'src/example.ts'),'after');f.deliver();
  assert.equal(checkN4({...f.selectors,inventory:'required'}).inventory,'verified');
  assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:0,modified:1,deleted:0});
}));

// Only the code root's own .reviews and the specs subtree are evidence; a
// nested directory that merely shares the name is ordinary code.
test('inventory counts a nested directory named .reviews as code',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  fs.mkdirSync(path.join(root,'src/.reviews'));fs.writeFileSync(path.join(root,'src/.reviews/data.md'),'code');
  fs.writeFileSync(path.join(root,'.reviews','unrelated-review.md'),'audit');
  fs.writeFileSync(path.join(root,'src/example.ts'),'after');f.deliver();
  assert.throws(()=>checkN4({...f.selectors,inventory:'required'}),/改了但没列: src\/\.reviews\/data\.md/);
  f.deliver(['src/example.ts','src/.reviews/data.md']);
  assert.equal(checkN4({...f.selectors,inventory:'required'}).inventory,'verified');
  assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:1,modified:1,deleted:0});
}));

test('inventory includes executable-only changes and cumulative attempt two edits',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  if(process.platform==='win32')fs.writeFileSync(path.join(root,'src/example.ts'),'after');
  else fs.chmodSync(path.join(root,'src/example.ts'),0o755);
  f.deliver();
  assert.deepEqual(checkN4({...f.selectors,inventory:'required'}).inventory_counts,{added:0,modified:1,deleted:0});
  writeReview(path.join(f.selectors.reviewsDir,'inventory-T-001-r1.md'),{handoff:f.selectors.handoff,verdict:'changes_requested'});
  fs.writeFileSync(path.join(root,'next.ts'),'second edit');f.deliver(['src/example.ts','next.ts'],2);
  assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:1,modified:1,deleted:0});
}));

test('inventory limit_exceeded identifies file and never writes a partial baseline',()=>fixture(root=>{
  const f=inventoryFixture(root),large=path.join(root,'too-large.bin');fs.writeFileSync(large,'');fs.truncateSync(large,1024*1024*1024+1);
  const result=f.capture();assert.notEqual(result.status,0);assert.match(result.stderr,/limit_exceeded.*too-large.bin/);
  assert(!fs.existsSync(f.baseline));
}));

test('inventory baseline tampering or root mismatch cannot degrade through legacy flag',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  fs.writeFileSync(path.join(root,'src/example.ts'),'after');f.deliver();
  const original=fs.readFileSync(f.baseline),b=JSON.parse(original);b.files[0].sha256='0'.repeat(64);
  fs.writeFileSync(f.baseline,JSON.stringify(b));assert.throws(()=>checkN4({...f.selectors,inventory:'required',allowLegacyUnbound:true}),/baseline/);
  fs.writeFileSync(f.baseline,original);const other=path.join(root,'other');fs.mkdirSync(path.join(other,'src'),{recursive:true});
  fs.writeFileSync(path.join(other,'src/example.ts'),'after');
  assert.throws(()=>checkN4({...f.selectors,inventory:'required',projectRoot:other}),/baseline/);
}));

test('inventory stable policy unions old and current decisions on both sides while retaining AGENTS',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(spawnSync('git',['init','-q',root]).status,0);
  fs.writeFileSync(path.join(root,'.gitignore'),'old-cache/\n');
  fs.mkdirSync(path.join(root,'old-cache'));fs.writeFileSync(path.join(root,'old-cache/value'),'ignored before');
  fs.mkdirSync(path.join(root,'new-cache'));fs.writeFileSync(path.join(root,'new-cache/value'),'present before');
  fs.mkdirSync(path.join(root,'node_modules'));fs.symlinkSync('/nonexistent/fixture',path.join(root,'node_modules/link'));
  assert.equal(f.capture().status,0);
  const ignoreMode=JSON.parse(fs.readFileSync(f.baseline)).ignorePolicy.mode;
  if(process.platform!=='win32')assert.equal(ignoreMode,'git');
  fs.writeFileSync(path.join(root,'.gitignore'),'new-cache/\n');
  fs.writeFileSync(path.join(root,'old-cache/value'),'ignored by baseline');
  fs.writeFileSync(path.join(root,'new-cache/value'),'ignored now');
  fs.writeFileSync(path.join(root,'new-cache/AGENTS.md'),'must be reviewed');
  f.deliver(['.gitignore']);assert.throws(()=>checkN4({...f.selectors,inventory:'required'}),/改了但没列.*new-cache\/AGENTS.md/);
  f.deliver(['.gitignore','new-cache/AGENTS.md']);
  if(process.platform==='win32'&&ignoreMode!=='git'){
    for(const check of [checkN4,checkN5])assert.throws(()=>check({...f.selectors,inventory:'required'}),error=>
      error instanceof GateError&&/改了但没列:.*new-cache\/value/.test(error.message)
      &&/改了但没列:.*old-cache\/value/.test(error.message));
  }else assert.deepEqual(checkN5({...f.selectors,inventory:'required'}).inventory_counts,{added:1,modified:1,deleted:0});
}));

test('inventory count budget refuses the triggering file and bounds both mismatch lists',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  for(let i=0;i<23;i++)fs.writeFileSync(path.join(root,`added-${String(i).padStart(2,'0')}.ts`),'new');
  const extras=Array.from({length:22},(_,i)=>`missing-${String(i).padStart(2,'0')}.ts`);f.deliver(extras);
  assert.throws(()=>checkN4({...f.selectors,inventory:'required'}),error=>/改了但没列:.*\(\+3 more\); 列了但没改:.*\(\+2 more\)/.test(error.message)
    &&!error.message.includes('added-20.ts')&&!error.message.includes('missing-20.ts'));
  fs.unlinkSync(f.baseline);
  const empty=path.join(root,'empty');fs.mkdirSync(empty);
  for(let i=0;i<10000;i++)fs.writeFileSync(path.join(empty,`f-${String(i).padStart(5,'0')}`),'');
  const result=f.capture();assert.notEqual(result.status,0);assert.match(result.stderr,/limit_exceeded: empty\/f-09977.*file count > 10000/);
  assert(!fs.existsSync(f.baseline));
}));

test('inventory baseline and evidence symlinks refuse instead of legacy degradation',()=>fixture(root=>{
  const f=inventoryFixture(root);assert.equal(f.capture().status,0);
  fs.writeFileSync(path.join(root,'src/example.ts'),'after');f.deliver();
  const bytes=fs.readFileSync(f.baseline);fs.unlinkSync(f.baseline);
  const target=path.join(f.selectors.reviewsDir,'other-baseline.json');fs.writeFileSync(target,bytes);fs.symlinkSync(target,f.baseline);
  assert.throws(()=>checkN4({...f.selectors,inventory:'required',allowLegacyUnbound:true}),/baseline/);
  fs.unlinkSync(f.baseline);fs.writeFileSync(f.baseline,bytes);
  // A nested entry merely named .reviews is ordinary code: a symlink there is
  // refused like any other symlink in the inventory, never treated as evidence.
  fs.mkdirSync(path.join(root,'linked'));fs.symlinkSync(f.selectors.reviewsDir,path.join(root,'linked/.reviews'));
  assert.throws(()=>checkN4({...f.selectors,inventory:'required'}),/unsupported_file: linked\/\.reviews/);
}));
