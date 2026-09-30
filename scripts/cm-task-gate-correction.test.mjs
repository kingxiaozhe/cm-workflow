import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkN4,checkN5,implementationSha256,prepareHumanCorrection,publishHumanCorrectionReview,
  prepareMarkDone,verifyMarkDonePlan} from './cm-task-gate.mjs';

const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-human-correction-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const reviewsDir=path.join(root,'.reviews');fs.mkdirSync(reviewsDir);
  fs.mkdirSync(path.join(root,'src'));const code=path.join(root,'src/example.ts');fs.writeFileSync(code,'old');
  const tasks=path.join(root,'tasks.md');fs.writeFileSync(tasks,'- [ ] T-001: fixture\n');
  const payload=attempt=>({schema_version:1,task_id:'T-001',attempt,status:'ready_for_review',changed_files:['src/example.ts'],
    implementation_sha256:implementationSha256(root,['src/example.ts']),
    verification:[{command:'fixture',status:'passed',evidence:'synthetic fixture'}],
    evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson'],blockers:[],scope_deviation:[]});
  const review=(file,handoff,attempt,verdict,correctionDigest=null)=>fs.writeFileSync(file,`---\nat: 2026-09-30T12:00:00Z\nreviewer: codex-subagent\nindependent: true\ntask: T-001\nattempt: ${attempt}\nround: ${attempt}\nverdict: ${verdict}\nblocking_findings: ${verdict==='approved'?0:1}\nhandoff: ${path.basename(handoff)}\nhandoff_sha256: ${sha(handoff)}\n${correctionDigest?`correction_sha256: ${correctionDigest}\n`:''}scope:\n  - src/example.ts\n---\n${verdict==='approved'?'Zero findings.':'Blocking fixture finding.'}\n`);
  const history=[];
  for(const [attempt,verdict] of [[1,'changes_requested'],[2,'blocked']]){
    const handoff=path.join(reviewsDir,`login-T-001-a${attempt}-handoff.json`),file=path.join(reviewsDir,`login-T-001-r${attempt}.md`);
    fs.writeFileSync(handoff,JSON.stringify(payload(attempt)));review(file,handoff,attempt,verdict);history.push(handoff,file);
  }
  const original=history.map(sha);fs.writeFileSync(code,'fixed');
  const draft=path.join(root,'draft.json');fs.writeFileSync(draft,JSON.stringify(payload(2)));
  const selectors={handoff:draft,reviewsDir,feature:'login',task:'T-001',projectRoot:root,
    humanAuthorized:true,reason:'Human approved exact selector correction after original blocked round 2.'};
  const prepare=()=>prepareHumanCorrection(selectors);
  const finish=(record,verdict='approved')=>{
    const selected={...selectors,...record,tasksPath:tasks};
    review(record.review,record.handoff,2,verdict,record.correction_sha256);
    publishHumanCorrectionReview(selected);return selected;
  };
  return {root,reviewsDir,code,tasks,draft,history,original,selectors,review,prepare,finish};
}

test('one-shot human correction retains blocked history and completes through the existing locked adapter',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  assert.equal(checkN4(selected).outcome,'ready_for_review');
  assert.throws(()=>checkN5(selected));
  const done=f.finish(record);assert.equal(checkN5(done).outcome,'approved');
  assert.throws(()=>checkN4(done),/already exists/);assert.throws(()=>f.prepare(),/already exists/);
  const plan=prepareMarkDone(done);assert.equal(plan.evidence.length,8);
  const args=['mark-done','--handoff',done.handoff,'--reviews-dir',f.reviewsDir,'--feature','login','--task','T-001',
    '--project-root',f.root,'--tasks',f.tasks,'--correction',done.correction];
  const result=spawnSync(process.env.CM_PYTHON_BIN||'python3',[fileURLToPath(new URL('./cm-task-gate.py',import.meta.url)),...args],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(fs.readFileSync(f.tasks,'utf8'),/\[x\]/);
  assert.deepEqual(f.history.map(sha),f.original);
  assert.throws(()=>checkN5({...done,handoff:f.history[2],correction:null}),/implementation content changed/);
});

test('correction authorization, original verdict, full scope, and mandatory Learning cannot be omitted',t=>{
  const f=fixture(t);
  assert.throws(()=>prepareHumanCorrection({...f.selectors,humanAuthorized:false}),/authorization/);
  assert.throws(()=>prepareHumanCorrection({...f.selectors,reason:''}),/reason/);
  const draft=JSON.parse(fs.readFileSync(f.draft));draft.evidence=['unbound application'];fs.writeFileSync(f.draft,JSON.stringify(draft));
  assert.throws(()=>prepareHumanCorrection({...f.selectors,allowLegacyUnbound:true}),/Learning/);
  assert.equal(fs.readdirSync(f.reviewsDir).length,4);
  draft.evidence=['learning: no_relevant_lesson','learning: retrospective no_new_lesson'];draft.changed_files=['src/new.ts'];
  fs.writeFileSync(path.join(f.root,'src/new.ts'),'new');draft.implementation_sha256=implementationSha256(f.root,draft.changed_files);
  fs.writeFileSync(f.draft,JSON.stringify(draft));assert.throws(()=>f.prepare(),/full original/);
  f.review(f.history[3],f.history[2],2,'approved');assert.throws(()=>f.prepare(),/blocked round 2/);
});

test('original evidence, correction handoff, implementation and authorization record drift invalidate approval',t=>{
  const f=fixture(t),record=f.prepare(),done=f.finish(record),plan=prepareMarkDone(done);
  for(const file of [...f.history,record.correction,record.handoff,record.review,done.receipt??path.join(f.reviewsDir,'login-T-001-human-correction-receipt.json'),f.code]){
    const bytes=fs.readFileSync(file);fs.appendFileSync(file,'\nchanged');
    assert.throws(()=>checkN5(done),undefined,file);assert.throws(()=>verifyMarkDonePlan(done,plan.planDigest),undefined,file);
    fs.writeFileSync(file,bytes);
  }
  assert.equal(checkN5(done).outcome,'approved');assert.match(fs.readFileSync(f.tasks,'utf8'),/\[ \]/);
});

test('blocked correction review is sealed once and cannot be replaced by a new approval',t=>{
  const f=fixture(t),record=f.prepare(),done=f.finish(record,'blocked');
  assert.throws(()=>checkN5(done),/remains blocked/);
  assert.throws(()=>publishHumanCorrectionReview(done),/already exists/);
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  assert.throws(()=>checkN5(done),/review or receipt changed/);
  assert.throws(()=>publishHumanCorrectionReview(done),/already exists/);
  assert.throws(()=>f.prepare(),/already exists/);
});

test('old review or self-degraded review cannot authorize a correction',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  f.review(record.review,record.handoff,2,'approved');
  assert.throws(()=>publishHumanCorrectionReview(selected),/fresh independent/);
  f.review(record.review,record.handoff,2,'approved',record.correction_sha256);
  fs.writeFileSync(record.review,fs.readFileSync(record.review,'utf8').replace('codex-subagent','self-degraded').replace('independent: true','independent: false').replace('scope:','degraded_reason: fixture\nscope:'));
  assert.throws(()=>publishHumanCorrectionReview(selected),/fresh independent/);
});

test('correction file identities reject symlinks, hardlinks, sibling selection and duplicate record fields',t=>{
  const f=fixture(t),record=f.prepare(),selected={...f.selectors,...record};
  assert.throws(()=>checkN4({...selected,correction:path.join(f.root,'other.json')}),/fixed evidence/);
  const bytes=fs.readFileSync(record.correction);
  fs.writeFileSync(record.correction,bytes.toString().replace('"version": 1','"version": 1, "version": 1'));
  assert.throws(()=>checkN4(selected),/duplicate key/);fs.writeFileSync(record.correction,bytes);
  const link=path.join(f.root,'alias');fs.linkSync(record.correction,link);
  assert.throws(()=>checkN4(selected),/hardlinked/);fs.unlinkSync(link);
  fs.renameSync(record.correction,link);fs.symlinkSync(link,record.correction);
  assert.throws(()=>checkN4(selected),/non-symlink/);
});

test('CLI human correction refuses missing human authorization and exposes the fixed review record',t=>{
  const f=fixture(t),script=fileURLToPath(new URL('./cm-task-gate.mjs',import.meta.url));
  const args=['prepare-human-correction','--handoff',f.draft,'--reviews-dir',f.reviewsDir,'--feature','login','--task','T-001','--project-root',f.root,'--reason','Explicit human correction'];
  const denied=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(denied.status,1);assert.match(denied.stderr,/authorization/);
  const result=spawnSync(process.execPath,[script,...args,'--human-authorized'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).attempt,2);
});
