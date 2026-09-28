import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun,validateRunDefinition} from './cm-ai-run.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-selection-guard-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const value = 1;\n');
  const definition=(runId,taskId='T-001',taskSelection)=>validateRunDefinition({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'guard-fixture',runId,taskId,attempt:1},scope:['a.mjs'],requirements:[],
    ...(taskSelection?{taskSelection}: {})});
  const execution={configuration:{kind:'guard-fixture'},timeoutMs:1000,excludedContexts:['host'],hostDecision:null,
    qaLogHome:path.join(root,'logs'),
    developer:{provider:'codex',requestedModel:'fixture',contextId:'author',run:async()=>{throw Error('unexpected development');}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-one','review-two'],run:async()=>{throw Error('unexpected review');}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host'],authorize:()=>{throw Error('unexpected review');}},
    check:async()=>{throw Error('unexpected check');}};
  return {root,specsDir,codeProject,feature,definition,execution};
}

test('single task selection accepts only the same feature eligible task and resumes with its exact fingerprint',async t=>{
  const f=fixture(t),selected={version:1,taskId:'T-002'},definition=f.definition('selected-run','T-002',selected);
  assert.throws(()=>f.definition('invalid-selection-run','T-002',{version:1,taskId:'T-001'}),{code:'invalid_task_selection'});
  await assert.rejects(openControlRun(f.definition('legacy-refused','T-002'),'create',f.execution),{code:'task_selection_mismatch'});
  await assert.rejects(openControlRun(f.definition('dependent-refused','T-003',{version:1,taskId:'T-003'}),'create',f.execution),{code:'task_selection_mismatch'});
  const run=await openControlRun(definition,'create',f.execution);run.close();
  const statePath=path.join(f.specsDir,'.reviews','.execution','selected-run','state.json');
  const before=fs.readFileSync(statePath);
  const resumed=await openControlRun(definition,'resume',f.execution);resumed.close();
  assert.deepEqual(fs.readFileSync(statePath),before);
  await assert.rejects(openControlRun(f.definition('selected-run','T-002'),'resume',f.execution),{code:'fingerprint_mismatch'});
  assert.equal(JSON.parse(before).fingerprints.config,digest({definition,execution:f.execution.configuration}));
  let called=0;
  f.execution.developer.run=async()=>{called++;throw Error('fixture development stop');};
  const launched=await openControlRun(definition,'resume',f.execution);
  try{
    const result=await launched.host.handle({version:1,operation:'start',requestId:'selected-start',identity:definition.identity});
    assert.notEqual(result.code,'task_mismatch');
    assert.notEqual(result.code,'learning_context_invalid');
    assert.equal(called,1);
  }finally{launched.close();}
  const legacy=f.definition('legacy-run-0001');
  const oldRun=await openControlRun(legacy,'create',f.execution);oldRun.close();
  const legacyState=path.join(f.specsDir,'.reviews','.execution','legacy-run-0001','state.json');
  const legacyBytes=fs.readFileSync(legacyState);
  const oldResume=await openControlRun(legacy,'resume',f.execution);oldResume.close();
  assert.deepEqual(fs.readFileSync(legacyState),legacyBytes);
  assert.equal(JSON.parse(legacyBytes).fingerprints.config,digest({definition:legacy,execution:f.execution.configuration}));
});

test('attempt-2 reviewed handoff also refuses create before the store exists',async t=>{
  const f=fixture(t),reviews=path.join(f.specsDir,'.reviews');fs.mkdirSync(reviews);
  const name='work-T-001-a2-handoff.json';
  fs.writeFileSync(path.join(reviews,name),'{}\n');
  fs.writeFileSync(path.join(reviews,'work-T-001-r2.md'),`---\nhandoff: ${name}\n---\n`);
  await assert.rejects(openControlRun(f.definition('attempt-two-run'),'create',f.execution),{code:'handoff_exists'});
  assert.equal(fs.existsSync(path.join(reviews,'.execution','attempt-two-run')),false);
});

test('reviewed handoff collision refuses create before store and supersede authorization proceeds',async t=>{
  const f=fixture(t),old=f.definition('old-run-0001'),reviews=path.join(f.specsDir,'.reviews');
  const original=await openControlRun(old,'create',f.execution);
  const cancelled=await original.host.handle({version:1,operation:'cancel',requestId:'cancel',identity:old.identity});
  assert.equal(cancelled.state,'cancelled');original.close();
  const name='work-T-001-a1-handoff.json';
  fs.writeFileSync(path.join(reviews,name),'{}\n');
  fs.writeFileSync(path.join(reviews,'work-T-001-r1.md'),`---\nhandoff: ${name}\n---\n`);
  const newRun=f.definition('new-run-0002');
  await assert.rejects(openControlRun(newRun,'create',f.execution),error=>
    error.code==='handoff_exists'&&/--supersede-reviewed-evidence/.test(error.reason));
  assert.equal(fs.existsSync(path.join(reviews,'.execution','new-run-0002')),false);
  const restarted=await openControlRun(newRun,'create',f.execution,{supersedeReason:'Operator requested restart'});
  restarted.close();
  const state=JSON.parse(fs.readFileSync(path.join(reviews,'.execution','new-run-0002','state.json')));
  assert(state.records.some(row=>row.payload.type==='evidence-superseded'));
});

test('driver same-session resume without original context reaches the missing-store check without launching a host',t=>{
  const f=fixture(t),config=path.join(f.root,'run.json'),plan=path.join(f.root,'plan.json');
  fs.writeFileSync(config,JSON.stringify(f.definition('resume-run-0001')));
  fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'resume',hostContext:'same-session',permissions:[]}));
  const driver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[driver,'--plan',plan,'status'],{encoding:'utf8'});
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/恢复存档不存在/);
  assert.doesNotMatch(result.stderr,/originalHostContext/);
});
