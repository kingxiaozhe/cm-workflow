import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {captureBaseline,checkN4,checkN5,implementationSha256,prepareControlledCorrection,publishControlledCorrectionReview,
  prepareHumanCorrection,publishHumanCorrectionReview,prepareMarkDone,verifyMarkDonePlan} from './cm-task-gate.mjs';

const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jsGate=fileURLToPath(new URL('./cm-task-gate.mjs',import.meta.url));
const pyGate=fileURLToPath(new URL('./cm-task-gate.py',import.meta.url));
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-controlled-correction-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const reviewsDir=path.join(root,'specs','.reviews');fs.mkdirSync(reviewsDir,{recursive:true});
  const tasks=path.join(root,'specs','tasks.md');fs.writeFileSync(tasks,'- [ ] T-001: fixture\n');
  // Inventory baseline precedes every in-scope edit; both scope files are new after it.
  captureBaseline({projectRoot:root,reviewsDir,feature:'login',task:'T-001'});
  fs.mkdirSync(path.join(root,'src'));
  const code=path.join(root,'src/example.ts');fs.writeFileSync(code,'original implementation');
  fs.writeFileSync(path.join(root,'src/unchanged.ts'),'retained original scope');
  const files=['src/example.ts','src/unchanged.ts'];
  const payload=attempt=>({schema_version:1,task_id:'T-001',attempt,status:'ready_for_review',changed_files:files,
    implementation_sha256:implementationSha256(root,files),
    verification:[{command:'fixture',status:'passed',evidence:'synthetic fixture passed'}],
    evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson'],blockers:[],scope_deviation:[]});
  const review=(file,handoff,attempt,verdict,correctionDigest=null)=>{
    const body=file.endsWith('-controlled-correction.md')?JSON.stringify({
      conclusion:verdict==='approved'?'Zero findings.':'Blocking findings.',
      findings:verdict==='approved'?[]:[{id:'r2-P2-1',priority:'P2',evidence:'Original issue remains unresolved.'}],
      resolved_findings:[],
    },null,2):verdict==='approved'?'Zero findings.':'P2 original blocking finding; retain its disposition as historical rejected evidence.';
    fs.writeFileSync(file,`---\nat: ${new Date().toISOString()}\nreviewer: codex-subagent\nindependent: true\ntask: T-001\nattempt: ${attempt}\nround: ${attempt}\nverdict: ${verdict}\nblocking_findings: ${verdict==='approved'?0:1}\nhandoff: ${path.basename(handoff)}\nhandoff_sha256: ${sha(handoff)}\n${correctionDigest?`correction_sha256: ${correctionDigest}\n`:''}scope:\n${files.map(item=>`  - ${item}\n`).join('')}---\n${body}\n`);
  };
  const history=[];
  for(const [attempt,verdict] of [[1,'changes_requested'],[2,'blocked']]){
    const handoff=path.join(reviewsDir,`login-T-001-a${attempt}-handoff.json`),file=path.join(reviewsDir,`login-T-001-r${attempt}.md`);
    fs.writeFileSync(handoff,JSON.stringify(payload(attempt)));review(file,handoff,attempt,verdict);history.push(handoff,file);
  }
  const original=history.map(sha);fs.writeFileSync(code,'corrected implementation');
  const draft=path.join(root,'specs','draft.json');fs.writeFileSync(draft,JSON.stringify(payload(2)));
  const selectors={handoff:draft,reviewsDir,feature:'login',task:'T-001',projectRoot:root,
    decisionSource:'model',reason:'Revise the exact implementation to resolve the original P2 finding.'};
  const prepare=()=>prepareControlledCorrection(selectors);
  const finish=(record,verdict='approved')=>{
    const selected={...selectors,...record,tasksPath:tasks};
    review(record.review,record.handoff,2,verdict,record.correction_sha256);
    publishControlledCorrectionReview(selected);return selected;
  };
  return {root,specs:path.join(root,'specs'),reviewsDir,code,tasks,draft,files,payload,history,original,selectors,review,prepare,finish};
}
function cliArgs(command,f,selected=f.selectors){
  return [command,'--handoff',selected.handoff,'--reviews-dir',f.reviewsDir,'--feature','login','--task','T-001','--project-root',f.root,
    ...(selected.correction?['--correction',selected.correction]:[])];
}
function draftChange(f,change){
  const payload=JSON.parse(fs.readFileSync(f.draft));change(payload);
  fs.writeFileSync(f.draft,JSON.stringify(payload));
}
function reviewBody(file,body){
  const text=fs.readFileSync(file,'utf8'),end=text.indexOf('\n---\n',4);
  assert.notEqual(end,-1);fs.writeFileSync(file,text.slice(0,end+5)+body+'\n');
}

test('controlled model continuation is honest provenance and preserves every original rejected byte',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const value=JSON.parse(fs.readFileSync(record.correction));
  assert.equal(value.version,2);assert.equal(value.protocol,'cm-controlled-correction');
  assert.equal(value.decision_source,'model');assert.equal(value.source_semantics,'provenance-only');
  assert.equal(value.continuation,1);assert.equal(value.attempt,2);
  assert.equal(Object.hasOwn(value,'authorization'),false);
  assert.equal(checkN4(selected).outcome,'ready_for_review');assert.throws(()=>checkN5(selected));
  assert.equal(fs.existsSync(record.review),false);assert.equal(fs.existsSync(path.join(f.reviewsDir,'login-T-001-controlled-correction-receipt.json')),false);
  assert.deepEqual(f.history.map(sha),f.original);
  assert.match(fs.readFileSync(f.history[3],'utf8'),/verdict: blocked/);
  assert.match(fs.readFileSync(f.history[3],'utf8'),/P2 original blocking finding/);
  assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
});

test('fresh independent approval for an actual revision reaches the existing locked completion adapter',t=>{
  const f=fixture(t),record=f.prepare(),done=f.finish(record);
  assert.equal(checkN5(done).outcome,'approved');
  const plan=prepareMarkDone(done);assert.equal(plan.evidence.length,8);
  assert.equal(verifyMarkDonePlan(done,plan.planDigest).outcome,'matched');
  const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,done),'--tasks',f.tasks],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[x\]/);
  assert.deepEqual(f.history.map(sha),f.original);
  assert.throws(()=>f.prepare(),/already exists/);
});

test('operator provenance uses the same gates and never writes a human authorization field',t=>{
  const f=fixture(t),record=prepareControlledCorrection({...f.selectors,decisionSource:'operator'});
  const value=JSON.parse(fs.readFileSync(record.correction));assert.equal(value.decision_source,'operator');
  assert.equal(JSON.stringify(value).includes('explicit-human-confirmation'),false);
  assert.equal(checkN5(f.finish(record)).outcome,'approved');
});

test('JS-owned or retained execution evidence refuses preparation before any correction artifact is created',t=>{
  for(const name of ['js-run','writer.sqlite-journal','unknown.json']){
    const f=fixture(t),execution=path.join(f.reviewsDir,'.execution');fs.mkdirSync(execution,{mode:0o700});
    if(name==='js-run')fs.mkdirSync(path.join(execution,name));else fs.writeFileSync(path.join(execution,name),'retained');
    assert.throws(()=>f.prepare(),/retained journal, JS run or unknown evidence/);
    assert.deepEqual(fs.readdirSync(f.reviewsDir).sort(),[...f.history.map(file=>path.basename(file)),'login-T-001-baseline.json','.execution'].sort());
    assert.deepEqual(f.history.map(sha),f.original);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
  }
});

test('incomplete or inconsistent compatibility writer evidence refuses preparation before any correction artifact',t=>{
  const ready=digest=>JSON.stringify({version:1,protocol:'cm-writer-ready',databaseDigest:digest})+'\n';
  const bytes=Buffer.from('sqlite bytes'),digest=createHash('sha256').update(bytes).digest('hex');
  const cases={
    'empty database without readiness':e=>fs.writeFileSync(path.join(e,'writer.sqlite'),'',{mode:0o600}),
    'empty database with matching readiness':e=>{fs.writeFileSync(path.join(e,'writer.sqlite'),'',{mode:0o600});fs.writeFileSync(path.join(e,'writer-ready.json'),ready(createHash('sha256').update('').digest('hex')),{mode:0o600});},
    'orphan readiness without database':e=>fs.writeFileSync(path.join(e,'writer-ready.json'),ready(digest),{mode:0o600}),
    'database without readiness':e=>fs.writeFileSync(path.join(e,'writer.sqlite'),bytes,{mode:0o600}),
    'readiness digest mismatch':e=>{fs.writeFileSync(path.join(e,'writer.sqlite'),bytes,{mode:0o600});fs.writeFileSync(path.join(e,'writer-ready.json'),ready('0'.repeat(64)),{mode:0o600});},
    'readiness with extra whitespace':e=>{fs.writeFileSync(path.join(e,'writer.sqlite'),bytes,{mode:0o600});fs.writeFileSync(path.join(e,'writer-ready.json'),ready(digest)+'\n',{mode:0o600});},
  };
  for(const [name,arrange] of Object.entries(cases)){
    const f=fixture(t),execution=path.join(f.reviewsDir,'.execution');fs.mkdirSync(execution,{mode:0o700});arrange(execution);
    const before=fs.readdirSync(f.reviewsDir).sort();
    assert.throws(()=>f.prepare(),/writer/,name);
    assert.deepEqual(fs.readdirSync(f.reviewsDir).sort(),before,name);assert.deepEqual(f.history.map(sha),f.original);
  }
  const f=fixture(t),execution=path.join(f.reviewsDir,'.execution');fs.mkdirSync(execution,{mode:0o700});
  fs.writeFileSync(path.join(execution,'writer.sqlite'),bytes,{mode:0o600});
  fs.writeFileSync(path.join(execution,'writer-ready.json'),ready(digest),{mode:0o600});
  assert.equal(f.prepare().outcome,'ready_for_correction_review');
});

test('library callers never require an editing baseline while CLI entries do',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record,tasksPath:f.tasks};
  fs.rmSync(path.join(f.reviewsDir,'login-T-001-baseline.json'));
  assert.equal(checkN4(selected).outcome,'ready_for_review');
  const cli=spawnSync(process.execPath,[jsGate,...cliArgs('check-n4',f,selected)],{encoding:'utf8'});
  assert.equal(cli.status,1);assert.match(cli.stderr,/missing editing baseline/);
  f.finish(record);
  assert.equal(checkN5(selected).outcome,'approved');assert.equal(prepareMarkDone(selected).evidence.length,8);
  for(const command of ['check-n5','prepare-mark-done']){
    const refused=spawnSync(process.execPath,[jsGate,...cliArgs(command,f,selected),...(command==='prepare-mark-done'?['--tasks',f.tasks]:[])],{encoding:'utf8'});
    assert.equal(refused.status,1,command);assert.match(refused.stderr,/missing editing baseline/,command);
  }
  assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
});

test('feature-local task owner cannot hide its specs-wide retained JS run from preparation',t=>{
  const f=fixture(t),featureRoot=path.join(f.specs,'login');fs.mkdirSync(featureRoot);
  const local=path.join(featureRoot,'.reviews');fs.renameSync(f.reviewsDir,local);
  fs.writeFileSync(path.join(local,'.cm-task-owner.json'),JSON.stringify({version:1,tasksPath:path.join(featureRoot,'tasks.md'),specsRoot:f.specs})+'\n',{mode:0o600});
  fs.mkdirSync(path.join(f.reviewsDir,'.execution','js-run'),{recursive:true});
  const before=fs.readdirSync(local).sort();
  assert.throws(()=>prepareControlledCorrection({...f.selectors,reviewsDir:local}),/retained journal, JS run or unknown evidence/);
  assert.deepEqual(fs.readdirSync(local).sort(),before);
});

test('JS ownership appearing after preparation or publication closes every correction consumer without changing evidence',t=>{
  for(const published of [false,true]){
    const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record,tasksPath:f.tasks};
    if(published)f.finish(record);else f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
    const files=fs.readdirSync(f.reviewsDir).sort(),bytes=files.map(name=>fs.readFileSync(path.join(f.reviewsDir,name)));
    fs.mkdirSync(path.join(f.reviewsDir,'.execution','js-run'),{recursive:true});
    for(const consume of [checkN4,publishControlledCorrectionReview,checkN5])
      assert.throws(()=>consume(selected),/retained journal, JS run or unknown evidence/);
    assert.throws(()=>prepareMarkDone(selected),published?/retained journal, JS run or unknown evidence/:/receipt/);
    const done=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,selected),'--tasks',f.tasks],{encoding:'utf8'});
    assert.equal(done.status,1);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
    assert.deepEqual(fs.readdirSync(f.reviewsDir).filter(name=>name!=='.execution').sort(),files);
    assert.deepEqual(files.map(name=>fs.readFileSync(path.join(f.reviewsDir,name))),bytes);
    assert.deepEqual(f.history.map(sha),f.original);
  }
});

test('copied history in a noncanonical review directory cannot bypass the original JS owner',t=>{
  const f=fixture(t),alias=path.join(f.root,'fake-reviews');fs.mkdirSync(alias);
  for(const file of f.history)fs.copyFileSync(file,path.join(alias,path.basename(file)));
  fs.mkdirSync(path.join(f.reviewsDir,'.execution','js-run'),{recursive:true});
  const before=fs.readdirSync(alias).sort();
  assert.throws(()=>prepareControlledCorrection({...f.selectors,reviewsDir:alias}),/canonical.*\.reviews/);
  assert.deepEqual(fs.readdirSync(alias).sort(),before);assert.deepEqual(f.history.map(sha),f.original);
});

test('feature-local preparation rejects a symlinked specs-wide review root even when it appears empty',t=>{
  const f=fixture(t),featureRoot=path.join(f.specs,'login');fs.mkdirSync(featureRoot);
  const local=path.join(featureRoot,'.reviews');fs.renameSync(f.reviewsDir,local);
  fs.writeFileSync(path.join(local,'.cm-task-owner.json'),JSON.stringify({version:1,tasksPath:path.join(featureRoot,'tasks.md'),specsRoot:f.specs})+'\n',{mode:0o600});
  const empty=path.join(f.root,'empty');fs.mkdirSync(empty);fs.symlinkSync(empty,f.reviewsDir);
  const before=fs.readdirSync(local).sort();
  assert.throws(()=>prepareControlledCorrection({...f.selectors,reviewsDir:local}),/canonical real non-symlink/);
  assert.deepEqual(fs.readdirSync(local).sort(),before);assert.deepEqual(fs.readdirSync(empty),[]);
});

test('missing reason, invalid provenance, reduced scope and incomplete Learning cannot create a record',t=>{
  const f=fixture(t);
  for(const reason of [undefined,'',' '.repeat(8),'x'.repeat(2001)])
    assert.throws(()=>prepareControlledCorrection({...f.selectors,reason}),/reason/);
  for(const decisionSource of [undefined,'human','approved'])
    assert.throws(()=>prepareControlledCorrection({...f.selectors,decisionSource}),/decision source/);
  draftChange(f,p=>{p.changed_files=['src/example.ts'];p.implementation_sha256=implementationSha256(f.root,p.changed_files);});
  assert.throws(()=>f.prepare(),/full original/);
  fs.writeFileSync(f.draft,JSON.stringify(f.payload(2)));draftChange(f,p=>{p.evidence=['learning: no_relevant_lesson'];});
  assert.throws(()=>f.prepare(),/Learning/);
  assert.equal(fs.readdirSync(f.reviewsDir).length,5);
});

test('changing handoff evidence alone cannot masquerade as an implementation revision',t=>{
  const f=fixture(t);fs.writeFileSync(f.code,'original implementation');
  draftChange(f,p=>{p.implementation_sha256=implementationSha256(f.root,p.changed_files);p.evidence.push('claimed correction without code change');});
  assert.throws(()=>f.prepare(),/actual implementation revision/);
  assert.equal(fs.readdirSync(f.reviewsDir).length,5);
});

test('failed checks, remaining blockers and scope deviations keep controlled correction closed',t=>{
  const f=fixture(t),valid=fs.readFileSync(f.draft);
  for(const change of [p=>{p.verification[0].status='failed';},p=>{p.blockers=['unresolved P2'];},p=>{p.scope_deviation=['omitted required work'];}]){
    draftChange(f,change);assert.throws(()=>f.prepare(),/verification|blockers|scope_deviation/);
    fs.writeFileSync(f.draft,valid);
  }
  const record=f.prepare(),done=f.finish(record);
  const bytes=fs.readFileSync(record.handoff);
  const value=JSON.parse(bytes);value.verification[0].status='failed';fs.writeFileSync(record.handoff,JSON.stringify(value));
  assert.throws(()=>checkN5(done),/verification/);
});

test('only the original independent blocked r2 can enter the continuation',t=>{
  const f=fixture(t),original=fs.readFileSync(f.history[3]);
  f.review(f.history[3],f.history[2],2,'approved');assert.throws(()=>f.prepare(),/blocked round 2 declaring independent/);
  fs.writeFileSync(f.history[3],original.toString().replace('codex-subagent','self-degraded').replace('independent: true','independent: false').replace('scope:','degraded_reason: fixture\nscope:'));
  assert.throws(()=>f.prepare(),/blocked round 2 declaring independent/);
  fs.writeFileSync(f.history[3],original);
  f.review(f.history[1],f.history[0],1,'blocked');assert.throws(()=>f.prepare(),/changes_requested/);
});

test('sealed blocked correction cannot become approved or acquire another continuation',t=>{
  const f=fixture(t),record=f.prepare(),done=f.finish(record,'blocked');
  assert.throws(()=>checkN5(done),/remains blocked/);assert.throws(()=>prepareMarkDone(done),/remains blocked/);
  assert.throws(()=>publishControlledCorrectionReview(done),/already exists/);
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  assert.throws(()=>checkN5(done),/review or receipt changed/);
  assert.throws(()=>f.prepare(),/already exists/);
  assert.throws(()=>prepareHumanCorrection(f.selectors),/another continuation is forbidden/);
  const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,done),'--tasks',f.tasks],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
});

test('fresh review must bind correction and full handoff and declare zero blocking findings',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const write=()=>f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  f.review(record.review,record.handoff,2,'approved');assert.throws(()=>publishControlledCorrectionReview(selected),/fresh independent/);
  write();fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace('blocking_findings: 0','blocking_findings: 1'));
  assert.throws(()=>publishControlledCorrectionReview(selected),/blocking_findings: 0/);
  write();fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace('  - src/unchanged.ts\n',''));
  assert.throws(()=>publishControlledCorrectionReview(selected),/scope does not cover/);
  write();fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace('Zero findings.','P2 remains unresolved.'));
  assert.throws(()=>publishControlledCorrectionReview(selected),/zero blocking findings/);
  write();fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace(/at: [^\n]+/,'at: 2020-01-01T00:00:00Z'));
  assert.throws(()=>publishControlledCorrectionReview(selected),/fresh independent/);
  write();fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace('codex-subagent','self-degraded').replace('independent: true','independent: false').replace('scope:','degraded_reason: fixture\nscope:'));
  assert.throws(()=>publishControlledCorrectionReview(selected),/fresh independent/);
});

test('mixed zero-findings prose and unresolved P2 cannot publish or complete even with a matching forged receipt',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record,tasksPath:f.tasks};
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  reviewBody(record.review,'Zero findings.\nP2 remains unresolved and must be fixed before completion.');
  assert.throws(()=>publishControlledCorrectionReview(selected),/structured findings/);
  const receipt=path.join(f.reviewsDir,'login-T-001-controlled-correction-receipt.json');
  assert.equal(fs.existsSync(receipt),false);
  fs.writeFileSync(receipt,JSON.stringify({version:2,protocol:'cm-controlled-correction-review',
    correction_sha256:record.correction_sha256,review_sha256:sha(record.review),verdict:'approved'}));
  assert.throws(()=>checkN5(selected),/structured findings/);
  const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,selected),'--tasks',f.tasks],{encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/structured findings/);
  assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
});

test('active structured P1/P2 findings override an approved header and zero conclusion',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  for(const priority of ['P1','P2']){
    f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
    reviewBody(record.review,JSON.stringify({conclusion:'Zero findings.',
      findings:[{id:`active-${priority}`,priority,evidence:'Issue remains unresolved.'}],resolved_findings:[]}));
    assert.throws(()=>publishControlledCorrectionReview(selected),/active findings|finding count/);
  }
});

test('resolved historical P2 is explicit structured evidence and may pass without active findings',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record,tasksPath:f.tasks};
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  reviewBody(record.review,JSON.stringify({conclusion:'Zero findings.',findings:[],
    resolved_findings:[{id:'r2-P2-1',priority:'P2',evidence:'The revised implementation and regression resolve the historical P2 finding.'}]}));
  assert.equal(publishControlledCorrectionReview(selected).outcome,'approved');
  assert.equal(checkN5(selected).outcome,'approved');assert.equal(prepareMarkDone(selected).evidence.length,8);
  assert.deepEqual(f.history.map(sha),f.original);
});

test('structured review rejects missing fields, extra prose, duplicate keys, invalid arrays and contradictory conclusions',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const valid={conclusion:'Zero findings.',findings:[],resolved_findings:[]};
  const malformed=[
    {conclusion:'Zero findings.',resolved_findings:[]},
    {...valid,extra:'P2 remains unresolved.'},
    {...valid,conclusion:'Zero findings. P2 remains unresolved.'},
    {...valid,findings:null},
    {...valid,resolved_findings:'P2 was fixed'},
    {...valid,findings:[{}]},
    {...valid,resolved_findings:[{id:'old-P2',priority:'P2'}]},
    {...valid,resolved_findings:[{id:'old-P2',priority:'P9',evidence:'fixed'}]},
    {...valid,resolved_findings:[{id:'old-P2',priority:'P2',evidence:'fixed'},{id:'old-P2',priority:'P2',evidence:'duplicate'}]},
    JSON.stringify(valid)+'\nP2 remains unresolved.',
    'Zero findings.\n'+JSON.stringify(valid),
    '{"conclusion":"Zero findings.","findings":[],"findings":[],"resolved_findings":[]}',
  ];
  for(const body of malformed){
    f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
    reviewBody(record.review,typeof body==='string'?body:JSON.stringify(body));
    assert.throws(()=>publishControlledCorrectionReview(selected),/controlled correction/);
  }
  f.review(record.review,record.handoff,2,'blocked',record.correction_sha256);
  reviewBody(record.review,JSON.stringify({conclusion:'Blocking findings.',
    findings:[{id:'P1-1',priority:'P1',evidence:'one'},{id:'P2-2',priority:'P2',evidence:'two'}],resolved_findings:[]}));
  assert.throws(()=>publishControlledCorrectionReview(selected),/finding count/);
});

test('history, implementation, finalized handoff, record, review and receipt tampering invalidate completion',t=>{
  const f=fixture(t),record=f.prepare(),done=f.finish(record),plan=prepareMarkDone(done);
  const receipt=path.join(f.reviewsDir,'login-T-001-controlled-correction-receipt.json');
  for(const file of [...f.history,record.correction,record.handoff,record.review,receipt,f.code]){
    const bytes=fs.readFileSync(file);fs.appendFileSync(file,'\nchanged');
    assert.throws(()=>checkN5(done),undefined,file);assert.throws(()=>verifyMarkDonePlan(done,plan.planDigest),undefined,file);
    fs.writeFileSync(file,bytes);
  }
  assert.equal(checkN5(done).outcome,'approved');
});

test('fixed paths and strict versioning prevent mixing human and controlled protocols',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const bytes=fs.readFileSync(record.correction),value=JSON.parse(bytes);
  value.protocol='cm-human-correction';value.version=1;fs.writeFileSync(record.correction,JSON.stringify(value));
  assert.throws(()=>checkN4(selected),/provenance record/);fs.writeFileSync(record.correction,bytes);
  assert.throws(()=>publishHumanCorrectionReview(selected),/fixed evidence/);
  assert.throws(()=>checkN4({...selected,correction:path.join(f.root,'record.json')}),/fixed evidence/);
  fs.writeFileSync(record.correction,bytes.toString().replace('"version": 2','"version": 2, "version": 2'));
  assert.throws(()=>checkN4(selected),/duplicate key/);
});

test('controlled evidence rejects hardlinks and symlinks',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const alias=path.join(f.root,'alias');fs.linkSync(record.correction,alias);
  assert.throws(()=>checkN4(selected),/hardlinked/);fs.unlinkSync(alias);
  fs.renameSync(record.correction,alias);fs.symlinkSync(alias,record.correction);
  assert.throws(()=>checkN4(selected),/non-symlink/);
});

test('strict record and receipt fields reject missing reasons and cross-protocol receipt tampering',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  const recordBytes=fs.readFileSync(record.correction);
  for(const change of [p=>{delete p.reason;},p=>{p.continuation=2;},p=>{p.authorization='model-approved';},p=>{p.decision_source='authenticated';}]){
    const value=JSON.parse(recordBytes);change(value);fs.writeFileSync(record.correction,JSON.stringify(value));
    assert.throws(()=>checkN4(selected),/controlled correction/);fs.writeFileSync(record.correction,recordBytes);
  }
  const done=f.finish(record),receipt=path.join(f.reviewsDir,'login-T-001-controlled-correction-receipt.json');
  const receiptBytes=fs.readFileSync(receipt);
  for(const change of [p=>{p.protocol='cm-human-correction-review';p.version=1;},p=>{p.correction_sha256='0'.repeat(64);},p=>{p.verdict='blocked';}]){
    const value=JSON.parse(receiptBytes);change(value);fs.writeFileSync(receipt,JSON.stringify(value));
    assert.throws(()=>checkN5(done),/review or receipt changed/);fs.writeFileSync(receipt,receiptBytes);
  }
});

test('interleaved legacy and controlled preparation seals at most one continuation',t=>{
  const f=fixture(t),humanHandoff=path.join(f.reviewsDir,'login-T-001-human-correction-handoff.json');
  const originalWrite=fs.writeFileSync;let denied=false,human;
  try{
    fs.writeFileSync=function(file,...args){
      // Contend while the human preparation owns the shared protocol lock.
      if(file===humanHandoff&&!denied){
        denied=true;assert.throws(()=>f.prepare(),/blocked: correction preparation lock/);
      }
      return originalWrite.call(this,file,...args);
    };
    human=prepareHumanCorrection(f.selectors);
  }finally{fs.writeFileSync=originalWrite;}
  assert.equal(denied,true);assert.equal(checkN4({...f.selectors,...human}).outcome,'ready_for_review');
  assert.equal(fs.existsSync(path.join(f.reviewsDir,'login-T-001-controlled-correction.json')),false);
  assert.throws(()=>f.prepare(),/another continuation is forbidden/);
});

for(const first of ['controlled','human'])test(`dual unsealed orphan handoffs recover safely with ${first} preparation first`,t=>{
  const f=fixture(t),humanHandoff=path.join(f.reviewsDir,'login-T-001-human-correction-handoff.json');
  const controlledHandoff=path.join(f.reviewsDir,'login-T-001-controlled-correction-handoff.json');
  fs.copyFileSync(f.draft,humanHandoff);fs.copyFileSync(f.draft,controlledHandoff);
  const originalOrphans=[sha(humanHandoff),sha(controlledHandoff)];
  const record=first==='controlled'?f.prepare():prepareHumanCorrection(f.selectors);
  assert.deepEqual([sha(humanHandoff),sha(controlledHandoff)],originalOrphans);
  let selected;
  if(first==='controlled'){
    selected=f.finish(record);assert.throws(()=>prepareHumanCorrection(f.selectors),/another continuation is forbidden/);
  }else{
    selected={...f.selectors,...record,tasksPath:f.tasks};
    f.review(record.review,record.handoff,2,'approved',record.correction_sha256);publishHumanCorrectionReview(selected);
    assert.throws(()=>f.prepare(),/another continuation is forbidden/);
  }
  assert.equal(checkN5(selected).outcome,'approved');assert.equal(prepareMarkDone(selected).evidence.length,8);
  assert.equal(fs.existsSync(path.join(f.reviewsDir,'login-T-001-correction-prepare.lock')),false);
  assert.deepEqual(f.history.map(sha),f.original);
});

test('retained preparation lock blocks both protocols without clearing unknown ownership or evidence',t=>{
  const f=fixture(t),lock=path.join(f.reviewsDir,'login-T-001-correction-prepare.lock');
  const retained=JSON.stringify({version:1,protocol:'cm-correction-prepare-lock',pid:process.pid,at:new Date().toISOString()});
  fs.writeFileSync(lock,retained);
  assert.throws(()=>f.prepare(),/blocked: correction preparation lock/);
  assert.throws(()=>prepareHumanCorrection(f.selectors),/blocked: correction preparation lock/);
  assert.equal(fs.readFileSync(lock,'utf8'),retained);assert.deepEqual(f.history.map(sha),f.original);
});

test('failed preparation releases its lock and preserves identical orphan recovery',t=>{
  const f=fixture(t),lock=path.join(f.reviewsDir,'login-T-001-correction-prepare.lock');
  draftChange(f,p=>{p.evidence=['learning: no_relevant_lesson'];});assert.throws(()=>f.prepare(),/Learning/);
  assert.equal(fs.existsSync(lock),false);fs.writeFileSync(f.draft,JSON.stringify(f.payload(2)));
  assert.equal(f.prepare().outcome,'ready_for_correction_review');assert.equal(fs.existsSync(lock),false);
});

test('legacy human record remains version 1 and model continuation cannot follow it',t=>{
  const f=fixture(t),record=prepareHumanCorrection(f.selectors);
  const value=JSON.parse(fs.readFileSync(record.correction));
  assert.equal(value.version,1);assert.equal(value.protocol,'cm-human-correction');
  assert.equal(value.authorization,'explicit-human-confirmation');assert.equal(Object.hasOwn(value,'decision_source'),false);
  const selected={...f.selectors,...record,tasksPath:f.tasks};
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);publishHumanCorrectionReview(selected);
  assert.equal(checkN5(selected).outcome,'approved');assert.equal(prepareMarkDone(selected).evidence.length,8);
  assert.throws(()=>f.prepare(),/another continuation is forbidden/);assert.deepEqual(f.history.map(sha),f.original);
});

test('new CLI and Python forwarder prepare, check, publish and complete; --human-authorized is rejected',t=>{
  const f=fixture(t),args=[...cliArgs('prepare-controlled-correction',f),'--decision-source','model','--reason',f.selectors.reason];
  const invalid=spawnSync(process.execPath,[jsGate,...args,'--human-authorized'],{encoding:'utf8'});
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/invalid arguments/);
  const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...args],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const record=JSON.parse(result.stdout),selected={...f.selectors,...record};
  const ready=spawnSync(process.execPath,[jsGate,...cliArgs('check-n4',f,selected)],{encoding:'utf8'});
  assert.equal(ready.status,0,ready.stderr);assert.equal(JSON.parse(ready.stdout).inventory,'verified');
  // CLI entries verify the edit inventory on the controlled path too: an unlisted edit blocks N4/N5.
  const stray=path.join(f.root,'src/stray.ts');fs.writeFileSync(stray,'unlisted edit');
  const mismatch=spawnSync(process.execPath,[jsGate,...cliArgs('check-n4',f,selected)],{encoding:'utf8'});
  assert.equal(mismatch.status,1);assert.match(mismatch.stderr,/inventory mismatch/);
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  const published=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('publish-controlled-correction-review',f,selected)],{encoding:'utf8'});
  assert.equal(published.status,0,published.stderr);
  const blocked=spawnSync(process.execPath,[jsGate,...cliArgs('check-n5',f,selected)],{encoding:'utf8'});
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/inventory mismatch/);
  const refused=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,selected),'--tasks',f.tasks],{encoding:'utf8'});
  assert.equal(refused.status,1);assert.match(refused.stderr,/inventory mismatch/);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
  fs.rmSync(stray);
  const approved=spawnSync(process.execPath,[jsGate,...cliArgs('check-n5',f,selected)],{encoding:'utf8'});
  assert.equal(approved.status,0,approved.stderr);assert.equal(JSON.parse(approved.stdout).inventory,'verified');
  const done=spawnSync(process.env.CM_PYTHON_BIN||'python3',[pyGate,...cliArgs('mark-done',f,selected),'--tasks',f.tasks],{encoding:'utf8'});
  assert.equal(done.status,0,done.stderr);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[x\]/);
});

test('only an identical orphan handoff can recover before the one-time record was created',t=>{
  const f=fixture(t),orphan=path.join(f.reviewsDir,'login-T-001-controlled-correction-handoff.json');
  fs.copyFileSync(f.draft,orphan);fs.appendFileSync(orphan,' ');
  assert.throws(()=>f.prepare(),/already exists/);
  fs.copyFileSync(f.draft,orphan);assert.equal(f.prepare().outcome,'ready_for_correction_review');
  assert.throws(()=>f.prepare(),/already exists/);
});
