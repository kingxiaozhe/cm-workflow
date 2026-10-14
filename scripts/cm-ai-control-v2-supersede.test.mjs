import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun,controlLaunchTarget,inspectRunHistory} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {oldWriterOpen,prepareReviewedEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';

// Never write the real ~/.cm-workflow home or its global log mirror from this suite;
// spawned CLIs inherit these variables as well.
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-v2-supersede-home-'));
const savedHome={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>{
  for(const [key,value] of Object.entries(savedHome)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolatedHome,{recursive:true,force:true});
});

// V2 restart of a stopped task: the operator previews the predecessor's launch
// target read-only, and create compares it before any archive or new journal.
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const drive=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-v2-supersede-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture');
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),'# fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement a\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),
    JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definitionFor=runId=>({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'supersede-fixture',runId,taskId:'T-001',attempt:1},scope:['a.mjs'],requirements:['requirements.md']});
  const execution=({legacy=false}={})=>({configuration:{kind:'synthetic-supersede-v1',hostContextId:'main',
    ...(legacy?{}:{controlPolicy:policy})},
    timeoutMs:1000,excludedContexts:['main'],developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',
      run:()=>{throw new Error('must not execute');}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-1','review-2'],run:()=>{throw new Error('must not review');}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['main']},
    check:createHostCheck({cwd:codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})});
  const snapshotOf=runId=>readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:'supersede-fixture',runId}});
  const store=runId=>path.join(specsDir,'.reviews','.execution',runId);
  return {root,codeProject,specsDir,feature,definitionFor,execution,snapshotOf,store};
}

// The predecessor stops through its own host so its journal ends in a terminal state.
async function stoppedPredecessor(f,runId='old-run-0001'){
  const definition=f.definitionFor(runId);
  let run=await openControlRun(definition,'create',f.execution());run.close();
  run=await openControlRun(definition,'resume',f.execution());
  try{
    const result=await run.host.handle({version:1,operation:'cancel',requestId:'stop',identity:definition.identity});
    assert.equal(result.state,'cancelled');
  }finally{run.close();}
  return {definition,target:controlLaunchTarget(f.snapshotOf(runId))};
}

const reason='旧运行开发额度用完，按批准重开新一轮';

test('v2 create keeps refusing supersede without the previewed predecessor target',async t=>{
  const f=fixture(t);await stoppedPredecessor(f);
  await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason}),
    {code:'invalid_input'});
  assert.equal(fs.existsSync(f.store('new-run-0001')),false);
});

test('v2 create refuses a target whose predecessor moved after the preview',async t=>{
  const f=fixture(t);const {target}=await stoppedPredecessor(f);
  for(const drift of [{revision:'0'.repeat(64)},{state:'blocked'},{code:'develop_retry_limit'}]){
    await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),
      {supersedeReason:reason,supersedeTarget:{...target,...drift}}),{code:'snapshot_changed'});
    assert.equal(fs.existsSync(f.store('new-run-0001')),false);
  }
  await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),
    {supersedeReason:reason,supersedeTarget:{...target,identity:{...target.identity,runId:'other-run-0001'}}}),
  {code:'snapshot_changed'});
  assert.equal(fs.existsSync(f.store('new-run-0001')),false);
});

test('v2 create with the exact predecessor target records the supersession and starts attempt 1',async t=>{
  const f=fixture(t);const {target}=await stoppedPredecessor(f);
  const before=fs.readFileSync(path.join(f.store('old-run-0001'),'state.json'));
  const run=await openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:target});
  run.close();
  const records=f.snapshotOf('new-run-0001').records.map(row=>row.payload.type);
  assert.deepEqual(records.slice(0,2),['init','evidence-superseded']);
  const supersession=f.snapshotOf('new-run-0001').records[1].payload.record;
  assert.deepEqual(supersession.previousRunIds,['old-run-0001']);
  assert.equal(supersession.reason,reason);
  // The predecessor's journal is evidence, never rewritten by the restart.
  assert.deepEqual(fs.readFileSync(path.join(f.store('old-run-0001'),'state.json')),before);
});

test('a second v2 restart must name the newest live predecessor, not an already superseded one',async t=>{
  const f=fixture(t);const first=await stoppedPredecessor(f);
  let run=await openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:first.target});
  run.close();
  run=await openControlRun(f.definitionFor('new-run-0001'),'resume',f.execution());
  try{await run.host.handle({version:1,operation:'cancel',requestId:'stop',identity:f.definitionFor('new-run-0001').identity});}
  finally{run.close();}
  await assert.rejects(openControlRun(f.definitionFor('new-run-0002'),'create',f.execution(),
    {supersedeReason:reason,supersedeTarget:first.target}),{code:'snapshot_changed'});
  const second=controlLaunchTarget(f.snapshotOf('new-run-0001'));
  run=await openControlRun(f.definitionFor('new-run-0002'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:second});
  run.close();
  assert.deepEqual(f.snapshotOf('new-run-0002').records[1].payload.record.previousRunIds,['new-run-0001','old-run-0001']);
});

test('the read-only history exposes the same target and legacy launches refuse it',async t=>{
  const f=fixture(t);const {definition,target}=await stoppedPredecessor(f);
  assert.deepEqual(inspectRunHistory(definition).supersedeTarget,target);
  await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution({legacy:true}),
    {supersedeReason:reason,supersedeTarget:target}),{code:'invalid_arguments'});
  assert.equal(fs.existsSync(f.store('new-run-0001')),false);
});

test('host CLI requires --supersede-target for v2 restart and rejects it everywhere else',t=>{
  const f=fixture(t);
  const config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json'),target=path.join(f.root,'target.json');
  fs.writeFileSync(config,JSON.stringify(f.definitionFor('new-run-0001')));fs.writeFileSync(control,JSON.stringify(policy));
  fs.writeFileSync(target,'{}');
  const run=extra=>spawnSync(process.execPath,[cli,'serve','--config',config,'--mode','create','--host-context','main',
    '--control-config',control,...extra],{encoding:'utf8'});
  const flags=['--supersede-reviewed-evidence','--supersede-reason','fixture'];
  let result=run(flags);assert.equal(result.status,1);assert.match(result.stderr,/supersede_unavailable/);
  result=run(['--supersede-target',target]);assert.equal(result.status,1);assert.match(result.stderr,/invalid_input/);
  const legacy=spawnSync(process.execPath,[cli,'serve','--config',config,'--mode','create','--host-context','main',
    '--allow-development',...flags,'--supersede-target',target],{encoding:'utf8'});
  assert.equal(legacy.status,1);assert.match(legacy.stderr,/invalid_arguments/);
  assert.equal(fs.existsSync(f.store('new-run-0001')),false);
});

test('driver demands a v2 supersede target file and forbids it on legacy plans',t=>{
  const f=fixture(t);
  const config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json'),target=path.join(f.root,'target.json');
  fs.writeFileSync(config,JSON.stringify(f.definitionFor('new-run-0001')));fs.writeFileSync(control,JSON.stringify(policy));
  fs.writeFileSync(target,'{}');
  const plan=(extra,permissions)=>{const file=path.join(f.root,'plan.json');
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'main',permissions,...extra}));return file;};
  const flags=['--supersede-reviewed-evidence','--supersede-reason','fixture'];
  let result=spawnSync(process.execPath,[drive,'--plan',plan({controlConfig:'control.json'},flags),'advance'],{encoding:'utf8'});
  assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/supersede-target/);
  result=spawnSync(process.execPath,[drive,'--plan',plan({},[...flags,'--supersede-target','target.json']),'advance'],{encoding:'utf8'});
  assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/supersede-target/);
  assert.equal(fs.existsSync(f.store('new-run-0001')),false);
});

test('a predecessor whose writer is held elsewhere cannot be restarted, and the refusal leaves nothing behind',async t=>{
  const f=fixture(t);const {definition,target}=await stoppedPredecessor(f);
  // A concurrent resume of the old run owns its writer while the approval is checked.
  const resumed=await openControlRun(definition,'resume',f.execution());
  try{
    await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),
      {supersedeReason:reason,supersedeTarget:target}),{code:'supersede_unavailable'});
    assert.equal(fs.existsSync(f.store('new-run-0001')),false);
    assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.superseded')),false);
  }finally{resumed.close();}
  // Once the other owner is gone the same approval still works: nothing was consumed.
  const run=await openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:target});
  run.close();
  assert.equal(f.snapshotOf('new-run-0001').records[1].payload.type,'evidence-superseded');
});

test('the predecessor writer lock is released after both a refused and a successful restart',async t=>{
  const f=fixture(t);const {definition,target}=await stoppedPredecessor(f);
  await assert.rejects(openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),
    {supersedeReason:reason,supersedeTarget:{...target,revision:'0'.repeat(64)}}),{code:'snapshot_changed'});
  // A leaked hold would make this resume fail with store_busy.
  let run=await openControlRun(definition,'resume',f.execution());run.close();
  run=await openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:target});
  run.close();
  run=await openControlRun(definition,'resume',f.execution());run.close();
});

test('after the target is verified the predecessor writer stays locked until the caller releases it',async t=>{
  const f=fixture(t);const {definition,target}=await stoppedPredecessor(f);
  const holds=[];
  const record=prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    identity:f.definitionFor('new-run-0001').identity,reason,tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),
    expectedPredecessor:target,predecessorTarget:controlLaunchTarget,holds});
  assert.deepEqual(record.previousRunIds,['old-run-0001']);
  assert.equal(holds.length,1);
  // Between verification and journaling no other process may resume the old run.
  await assert.rejects(openControlRun(definition,'resume',f.execution()),{code:'store_busy'});
  for(const held of holds)held.close();
  const run=await openControlRun(definition,'resume',f.execution());run.close();
  // The helper never verifies a v2 target without somewhere to hand the lock back.
  assert.throws(()=>prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    identity:f.definitionFor('new-run-0001').identity,reason,tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),
    expectedPredecessor:target,predecessorTarget:controlLaunchTarget}),{code:'supersede_unavailable'});
});

// Cross-process race: restart B scans the single predecessor, then stops on a file
// barrier before taking its lock. Restart A completes in that gap. B must not proceed.
const raceChild=fileURLToPath(new URL('./cm-ai-control-v2-supersede-race.mjs',import.meta.url));
async function raceSecondRestart(f,target,{between}){
  const barrier=path.join(f.root,'barrier');fs.mkdirSync(barrier);
  const child=spawn(process.execPath,[raceChild,JSON.stringify({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    repositoryId:'supersede-fixture',runId:'new-run-0002',taskId:'T-001',reason,target,barrier})]);
  let out='';child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',()=>{});
  const exited=new Promise(resolve=>child.on('close',code=>resolve(code)));
  // Bounded wait whose timer is always cleared, so it never keeps the test process alive.
  const within=async(promise,ms,message)=>{
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}
    finally{clearTimeout(timer);}
  };
  try{
    for(let i=0;i<200&&!fs.existsSync(path.join(barrier,'scanned'));i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(fs.existsSync(path.join(barrier,'scanned')),true,'child never reached the barrier');
    // Whatever happens while B is paused after its scan (the callback owns and releases its own handles), then B is released.
    await between();
    fs.writeFileSync(path.join(barrier,'go'),'');
    await within(exited,30000,'child did not exit');
    return JSON.parse(out.trim().split('\n').at(-1));
  }finally{
    child.kill();
    try{await within(exited,5000,'child did not stop');}catch{}
  }
}

test('a second restart that scanned the same predecessor before the first finished is refused under the lock',async t=>{
  for(const cancelFirst of [false,true]){
    const f=fixture(t);const {target}=await stoppedPredecessor(f);
    const outcome=await raceSecondRestart(f,target,{between:async()=>{
      // Restart A runs to completion (and optionally stops) while B is paused after its scan.
      const first=await openControlRun(f.definitionFor('new-run-0001'),'create',f.execution(),{supersedeReason:reason,supersedeTarget:target});
      // The first restart is over (its writer released) before B is let go, even when a step below fails.
      try{
        if(cancelFirst){
          const result=await first.host.handle({version:1,operation:'cancel',requestId:'stop-a',identity:f.definitionFor('new-run-0001').identity});
          assert.equal(result.state,'cancelled');
        }
      }finally{first.close();}
      return null;
    }});
    assert.equal(outcome.ok,false,JSON.stringify(outcome));
    // The first restart left a live or stopped successor: either way B must not become a second one.
    assert.equal(outcome.code,cancelFirst?'snapshot_changed':'supersede_unavailable',JSON.stringify(outcome));
    assert.equal(fs.existsSync(f.store('new-run-0002')),false);
  }
});

test('a restart that failed before its first journal record leaves a directory the paused restart must not ignore',async t=>{
  const f=fixture(t);const {target}=await stoppedPredecessor(f);
  const outcome=await raceSecondRestart(f,target,{between:async()=>{
    // Restart A takes the predecessor, creates its (still empty) journal, then fails before 'init'.
    const store=openExecutionStore({specsRoot:f.specsDir,identity:{repositoryId:'supersede-fixture',runId:'new-run-0001'},
      fingerprints:f.snapshotOf('old-run-0001').fingerprints,create:true});
    store.close();
    assert.equal(fs.existsSync(path.join(f.store('new-run-0001'),'state.json')),true);
    return null;
  }});
  assert.equal(outcome.ok,false,JSON.stringify(outcome));
  assert.equal(outcome.code,'snapshot_changed',JSON.stringify(outcome));
  assert.equal(fs.existsSync(f.store('new-run-0002')),false);
});

test('a paused restart that is never released fails instead of continuing out of order',async t=>{
  const f=fixture(t);const {target}=await stoppedPredecessor(f);
  const barrier=path.join(f.root,'barrier-timeout');fs.mkdirSync(barrier);
  // No release signal is ever written: the child reports the timeout itself.
  const child=spawn(process.execPath,[raceChild,JSON.stringify({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    repositoryId:'supersede-fixture',runId:'new-run-0002',taskId:'T-001',reason,target,barrier})]);
  let out='';child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',()=>{});
  await new Promise(resolve=>child.on('close',resolve));
  assert.equal(JSON.parse(out.trim().split('\n').at(-1)).code,'barrier_timeout');
  assert.equal(fs.existsSync(f.store('new-run-0002')),false);
});

// The prior-writer guard (execution optimizations) and the supersede checks both ask
// "is this writer open?". The lock this call took itself must not read as foreign.
test('the open-writer check exempts only a lock this process registered for its own restart',async t=>{
  const f=fixture(t);const {target}=await stoppedPredecessor(f);
  const execution=path.join(f.specsDir,'.reviews','.execution');
  assert.equal(oldWriterOpen(execution,'old-run-0001'),false);
  // A plain lock taken by this same process without registering it still counts as open.
  const fingerprints=f.snapshotOf('old-run-0001').fingerprints;
  const plain=openExecutionStore({specsRoot:f.specsDir,identity:{repositoryId:'supersede-fixture',runId:'old-run-0001'},fingerprints,create:false});
  assert.equal(oldWriterOpen(execution,'old-run-0001'),true);
  plain.close();
  // A lock taken through the restart path is exempt while held, and only while held.
  const holds=[];
  prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    identity:f.definitionFor('new-run-0001').identity,reason,tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),
    expectedPredecessor:target,predecessorTarget:controlLaunchTarget,holds});
  assert.equal(oldWriterOpen(execution,'old-run-0001'),false);
  // ...but not when another process also has the same writer file open.
  const writerFile=path.join(execution,'old-run-0001','writer.sqlite');
  const reader=spawn(process.execPath,['-e',`const fs=require('fs');fs.openSync(${JSON.stringify(writerFile)},'r');process.stdout.write('open\\n');setTimeout(()=>{},15000);`]);
  t.after(()=>reader.kill());
  await new Promise((resolve,reject)=>{reader.stdout.once('data',resolve);reader.on('error',reject);reader.stderr.on('data',()=>{});});
  assert.equal(oldWriterOpen(execution,'old-run-0001'),true);
  reader.kill();await new Promise(resolve=>reader.on('close',resolve));
  assert.equal(oldWriterOpen(execution,'old-run-0001'),false);
  for(const held of holds)held.close();
  assert.equal(oldWriterOpen(execution,'old-run-0001'),false);
  // Another process holding the writer is never exempt.
  const holder=spawn(process.execPath,['--input-type=module','-e',`
    import {openExecutionStore} from ${JSON.stringify(new URL('../runtime/js/cm-ai/execution-store.mjs',import.meta.url).href)};
    const s=openExecutionStore({specsRoot:${JSON.stringify(f.specsDir)},identity:{repositoryId:'supersede-fixture',runId:'old-run-0001'},
      fingerprints:${JSON.stringify(fingerprints)},create:false});
    process.stdout.write('held\\n');setTimeout(()=>{s.close();},15000);`]);
  t.after(()=>holder.kill());
  await new Promise((resolve,reject)=>{holder.stdout.once('data',resolve);holder.on('error',reject);holder.stderr.on('data',()=>{});});
  assert.equal(oldWriterOpen(execution,'old-run-0001'),true);
});
