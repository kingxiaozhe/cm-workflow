import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {main as hostMain,withHandoffDiagnostic} from './cm-ai-host.mjs';
import {prepareReviewedEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';
import {readEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersession-record.mjs';
import {buildCodexDeveloperPrompt} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {buildCodexReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {readRunnerHistory,runnerPayloadV3} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {abandonEffectPlanError,buildCmAiDriveRequest,buildCmAiDriveHostArgs} from './cm-ai-drive.mjs';
import {spawn as spawnChild} from 'node:child_process';
import {readProcessStartTime} from '../runtime/js/cm-ai/worker-process-identity.mjs';

// Never write the real ~/.cm-workflow home or its global log from this suite.
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-supersede-home-'));
const savedHome={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>{
  for(const [key,value] of Object.entries(savedHome)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolatedHome,{recursive:true,force:true});
});

// Reuse the isolated handoff shape from cm-host-handoff.test.mjs. The old
// receipt deliberately consumes a different byte sequence at the same name.
test('reviewed handoff collision retains its code and explains both exits',()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-supersede-')));
  try{
    const root=path.join(temp,'code'),reviews=path.join(temp,'reviews');
    fs.mkdirSync(root);fs.mkdirSync(reviews);
    fs.writeFileSync(path.join(root,'a.mjs'),'old');
    fs.writeFileSync(path.join(root,'requirements.md'),'fixture');
    const handoffPath=path.join(reviews,'work-T-002-a1-handoff.json');
    const publish=content=>{
      fs.writeFileSync(path.join(root,'a.mjs'),'old');
      const baseline=captureReviewBaseline({root,
        identity:{repositoryId:'fixture',runId:'run-one',taskId:'T-002',attempt:1},
        scope:['a.mjs'],requirements:['requirements.md']});
      fs.writeFileSync(path.join(root,'a.mjs'),content);
      return createHostHandoff({root,baseline,handoffPath,
        checks:[{id:'unit',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'fixture'}]});
    };
    publish('run one');
    fs.writeFileSync(path.join(reviews,'work-T-002-r1.md'),
      '---\nverdict: approved\nhandoff: work-T-002-a1-handoff.json\n---\n');
    assert.throws(()=>publish('run two'),error=>{
      assert.equal(error.code,'handoff_exists');
      assert.match(error.reason,/--revise-qa-config/);
      assert.match(error.reason,/--rerun-blocked-qa/);
      assert.match(error.reason,/--supersede-reviewed-evidence/);
      return true;
    });
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

// V8 (A14/A25): the host died with only a develop intent. abandon_effect records
// effect-interrupted and the same run redoes the round under a new effect id;
// the half-written residue stays on disk and goes through checks and review.
test('interrupted first develop is recorded on resume and the same run redoes the round',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-develop-a1',identity=identityFor(runId);
    assert.equal((await start(f,runId,'written\n')).state,'blocked');
    const {stateFile,intent}=interruptAfterIntent(f,runId,'develop');
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'half\n');
    for(const name of fs.readdirSync(f.reviewsDir))if(name.startsWith('work-T-002-'))
      fs.rmSync(path.join(f.reviewsDir,name));
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'written\n'),{allowAbandonEffect:true});
    try{
      const status=await resumed.host.handle({version:1,operation:'status',requestId:'status',identity});
      assert.equal(status.pendingAction,'abandon_effect');
      const result=await resumed.host.handle(abandonRequest(identity));
      assert.equal(result.outcome,'recorded',JSON.stringify(result));assert.equal(result.state,'blocked');
      assert.equal(result.code,'develop_interrupted');assert.equal(result.pendingAction,'resume');
      assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'half\n','residue stays on disk');
      const advanced=await resumed.host.handle(requestFor(identity));
      assert.equal(advanced.code,'review_blocked',JSON.stringify(advanced));
    }finally{resumed.close();}
    const records=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
    const interrupted=records.find(row=>row.payload.type==='effect-interrupted');
    assert.equal(interrupted.payload.intentDigest,intent.digest);
    const history=readRunnerHistory(records,records[0].payload.config,3);
    assert.equal(history.pending,null);assert.equal(history.state.code,'review_blocked');
    const intents=records.filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='develop').map(row=>row.payload.effect.id);
    assert.deepEqual(intents,['develop-1','develop-1-resume-1']);
    // The interrupted call keeps its slot-free audit entry; the redo is the next call.
    assert.deepEqual(history.state.calls.slice(0,2).map(call=>call.terminal),['abandoned','succeeded']);
    // The review package is still built against the run's create-time baseline.
    const pkg=history.state.reviewPackage;
    assert.equal(pkg.changes.find(change=>change.path==='a.mjs').before.sha256,
      createHash('sha256').update('old\n').digest('hex'));
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \] T-002/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// #23: a run that dies at attempt 1 before any handoff/review evidence exists.
// The host died after the developer wrote a.mjs; the operator abandons the
// open develop intent (#161), leaving the edits and no evidence behind.
async function dieBeforeReview(f,runId,content){
  const identity=identityFor(runId);
  interruptAfterIntent(f,runId,'develop');
  for(const name of fs.readdirSync(f.reviewsDir))if(name.startsWith('work-T-002-'))
    fs.rmSync(path.join(f.reviewsDir,name));
  const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
    identity,scope:['a.mjs'],requirements:['requirements.md']};
  const resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
  try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'develop_interrupted');}
  finally{resumed.close();}
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),content);
}
test('a dead attempt-1 run: plain create refuses its unreviewed edits; supersede works with nothing to archive',async()=>{
  const f=runFixture();
  try{
    const runId='dead-first-0001';
    assert.equal((await start(f,runId,'written\n')).state,'blocked');
    await dieBeforeReview(f,runId,'written\n');
    const plainState=path.join(f.reviewsDir,'.execution','dead-first-plain','state.json');
    await assert.rejects(start(f,'dead-first-plain','next\n'),error=>{
      assert.equal(error.code,'supersede_code_drift');
      assert.match(error.reason,/dead-first-0001/);assert.match(error.reason,/a\.mjs/);
      assert.match(error.reason,/--supersede-reviewed-evidence/);assert.match(error.reason,/--accept-superseded-code-drift/);
      return true;
    });
    assert.equal(fs.existsSync(plainState),false,'a refused plain create leaves no run behind');
    await assert.rejects(start(f,'dead-first-next','next\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_code_drift'&&/--accept-superseded-code-drift/.test(error.reason));
    // The flag the message suggests now works: there is no evidence to archive.
    assert.equal((await start(f,'dead-first-next','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true})).state,'blocked');
    const records=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','dead-first-next','state.json'),'utf8')).records;
    const record=records[1].payload.record;
    assert.equal(records[1].payload.type,'evidence-superseded');assert.deepEqual(record.files,[]);
    assert.deepEqual(record.previousRunIds,[runId]);
    assert.deepEqual(record.acceptedCodeDrift.map(file=>[file.predecessorRunId,file.path]),[[runId,'a.mjs']]);
    assert.equal(readRunnerHistory(records,records[0].payload.config,3).supersession.files.length,0);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('plain create checks only prior runs that no later run superseded',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'chain-plain-0001','first\n')).state,'blocked');
    await dieBeforeReview(f,'chain-plain-0001','first\n');
    assert.equal((await start(f,'chain-plain-0002','second\n',{supersedeReason:'restart',acceptSupersededCodeDrift:true})).state,'blocked');
    await dieBeforeReview(f,'chain-plain-0002','second\n');
    // 0001 is superseded by 0002; only 0002's baseline ('first') is compared.
    await assert.rejects(start(f,'chain-plain-0003','third\n'),error=>error.code==='supersede_code_drift'
      &&/chain-plain-0002/.test(error.reason)&&!/chain-plain-0001/.test(error.reason));
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'first\n');
    assert.equal((await start(f,'chain-plain-0003','third\n')).state,'blocked',
      'restoring the files to the unsuperseded run baseline permits a plain create');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('interrupted second develop after changes requested is recorded, then may still be superseded',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-develop-a2',identity=identityFor(runId),content='written\n';
    const first=await start(f,runId,content,{},'changes_requested');
    assert.equal(first.code,'review_limit',JSON.stringify(first));
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    interruptAfterIntent(f,runId,'develop',2);
    await assert.rejects(start(f,'abandon-a2-new','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true}),
    error=>error.code==='supersede_unavailable'&&/已中断.*abandon_effect/.test(error.reason));
    const resumed=await openControlRun(definition,'resume',executionFor(f,content,'changes_requested'),
      {allowAbandonEffect:true});
    try{
      const result=await resumed.host.handle(abandonRequest({...identity,attempt:2}));
      assert.equal(result.state,'blocked',JSON.stringify(result));assert.equal(result.code,'develop_interrupted');
      assert.equal(result.identity.attempt,2);
    }finally{resumed.close();}
    await assert.rejects(start(f,'abandon-a2-new','next\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_code_drift');
    assert.equal((await start(f,'abandon-a2-new','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true})).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// V8 (A44): a completion interrupted before task-commit-intent returns to the
// approved state; the same run completes without a new review or develop.
test('interrupted complete checks are recorded and the same run completes',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-complete',identity=identityFor(runId),content='written\n';
    assert.equal((await start(f,runId,content,{},'approved')).state,'fixture_completed');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const {stateFile}=interruptAfterIntent(f,runId,'complete');
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    const resumed=await openControlRun(definition,'resume',executionFor(f,content,'approved'),
      {allowAbandonEffect:true});
    try{
      const result=await resumed.host.handle(abandonRequest(identity));
      assert.equal(result.state,'approved',JSON.stringify(result));assert.equal(result.code,null);
      assert.equal(result.outcome,'recorded');assert.equal(result.pendingAction,'complete');
      const completed=await resumed.host.handle({version:1,operation:'complete',requestId:'complete',identity,
        packageDigest:result.packageDigest});
      assert.equal(completed.state,'fixture_completed',JSON.stringify(completed));
    }finally{resumed.close();}
    const records=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
    assert(records.some(row=>row.payload.type==='effect-interrupted'));
    assert.deepEqual(records.filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='complete')
      .map(row=>row.payload.effect.id),['complete-1','complete-1-resume-1']);
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/i);
    assert.equal(readRunnerHistory(records,records[0].payload.config,3).state.state,'fixture_completed');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('abandon_effect refuses absent intent, records a pre-dispatch review, and requires flag and reason',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-refusals',identity=identityFor(runId),content='written\n';
    await start(f,runId,content);
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    let resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandon_no_pending');}
    finally{resumed.close();}
    interruptAfterIntent(f,runId,'review');
    await assert.rejects(start(f,'abandon-review-new','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true}),
    error=>error.code==='supersede_unavailable'&&/已中断.*abandon_effect/.test(error.reason));
    resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{const result=await resumed.host.handle(abandonRequest(identity));
      assert.equal(result.state,'awaiting_review',JSON.stringify(result));assert.equal(result.pendingAction,'decision');}
    finally{resumed.close();}
    interruptAfterIntent(f,runId,'develop');
    resumed=await openControlRun(definition,'resume',executionFor(f,content));
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandon_authorization_required');}
    finally{resumed.close();}
    resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{
      assert.equal((await resumed.host.handle({...abandonRequest(identity),reason:''})).code,'effect_abandon_reason_required');
      assert.equal((await resumed.host.handle({...abandonRequest(identity),reason:'two\nlines'})).code,'effect_abandon_reason_required');
      assert.equal((await resumed.host.handle(abandonRequest(identity))).state,'blocked');
    }finally{resumed.close();}
    resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandon_no_pending');}
    finally{resumed.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// V9: a provider develop interrupted by an older runtime has no journaled worker
// identity, so nothing proves its process gone. A45: after task-commit-intent the
// completion is never abandoned; complete follows the journaled commit plan.
test('abandon_effect refuses unrecorded provider workers and pending task commit; complete finishes the commit',async()=>{
  for(const kind of ['provider','commit']){
    const f=runFixture();
    try{
      const runId=`abandon-${kind}-guard`,identity=identityFor(runId),content='written\n';
      const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
        identity,scope:['a.mjs'],requirements:['requirements.md']};
      const execution=executionFor(f,content,'approved');
      if(kind==='provider')execution.configuration.providerDevelopment={model:'fixture'};
      const created=await openControlRun(definition,'create',execution);
      try{await created.host.handle(requestFor(identity));}finally{created.close();}
      const stateFile=path.join(f.reviewsDir,'.execution',runId,'state.json');
      if(kind==='provider'){
        interruptAfterIntent(f,runId,'develop');
        rewriteLast(stateFile,payload=>{assert.equal(payload.workerJournal,true);delete payload.workerJournal;});
      }else {
        const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
        const index=current.records.findIndex(row=>row.payload.type==='task-commit-intent');
        assert(index>=0);const {revision,...body}=current;body.records=current.records.slice(0,index+1);
        fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
      }
      const before=fs.readFileSync(stateFile);
      const resumed=await openControlRun(definition,'resume',execution,{allowAbandonEffect:true});
      try{
        const result=await resumed.host.handle(abandonRequest(identity));
        assert.equal(result.code,kind==='provider'?'effect_interrupt_worker_identity_unrecorded':'effect_abandon_commit_pending');
        assert.match(result.reason,kind==='provider'?/进程身份/:/tasks\.md.*complete.*提交计划/);
        assert.deepEqual(fs.readFileSync(stateFile),before);
        if(kind==='commit'){
          const status=await resumed.host.handle({version:1,operation:'status',requestId:'status',identity});
          assert.equal(status.code,'complete_commit_interrupted');assert.equal(status.pendingAction,'complete');
          // tasks.md already holds the planned bytes: only the result is journaled.
          const completed=await resumed.host.handle({version:1,operation:'complete',requestId:'complete',identity,
            packageDigest:status.packageDigest});
          assert.equal(completed.state,'fixture_completed',JSON.stringify(completed));
          const records=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
          assert.deepEqual(records.slice(-2).map(row=>row.payload.type),['task-commit-result','effect-checkpoint']);
        }
      }finally{resumed.close();}
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

// V9 (A19): the provider worker's identity is journaled around its spawn. A
// pending develop is retired only once the host proves that process group gone.
test('provider develop interruption waits for the journaled worker process group to be gone',async()=>{
  const f=runFixture();let child=null;
  try{
    const runId='provider-worker-gone',identity=identityFor(runId),content='written\n';
    await start(f,runId,content);
    const {stateFile,body}=interruptAfterIntent(f,runId,'develop');
    const intent=body.records.at(-1);assert.equal(intent.payload.workerJournal,true);
    const invocationId=`${body.records[0].payload.session}.${readRunnerHistory(body.records,body.records[0].payload.config,3).state.calls.length+1}`;
    child=spawnChild(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const abandon=async()=>{const run=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
      try{return await run.host.handle(abandonRequest(identity));}finally{run.close();}};
    appendRecord(stateFile,'develop-worker',{effectId:intent.payload.effect.id,invocationId,phase:'spawning'});
    let before=fs.readFileSync(stateFile);
    let result=await abandon();
    assert.equal(result.code,'effect_interrupt_worker_identity_incomplete',JSON.stringify(result));
    assert.deepEqual(fs.readFileSync(stateFile),before);
    const records=appendRecord(stateFile,'develop-worker',{effectId:intent.payload.effect.id,invocationId,phase:'started',
      pid:child.pid,startTime:readProcessStartTime(child.pid)});
    const started=records.at(-1);
    // Forged worker records are refused on replay.
    for(const change of [p=>{p.invocationId=`${body.records[0].payload.session}.99`;},p=>{p.pid=1;},p=>{p.startTime='x'.repeat(65);}]){
      const forged=structuredClone(records);change(forged.at(-1).payload);
      const {digest:old,...record}=forged.at(-1);forged[forged.length-1]={...record,digest:digest(record)};
      assert.throws(()=>readRunnerHistory(forged,records[0].payload.config,3),error=>error.code==='runner_worker');
    }
    before=fs.readFileSync(stateFile);
    result=await abandon();
    assert.equal(result.code,'effect_interrupt_worker_process_alive',JSON.stringify(result));
    assert.match(result.reason,new RegExp(String(child.pid)));
    assert.deepEqual(fs.readFileSync(stateFile),before);
    process.kill(-child.pid,'SIGKILL');
    const until=Date.now()+5000;
    while(Date.now()<until){try{process.kill(-child.pid,0);}catch(error){if(error.code==='ESRCH')break;}await new Promise(resolve=>setTimeout(resolve,25));}
    result=await abandon();
    assert.equal(result.code,'develop_interrupted',JSON.stringify(result));
    const saved=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
    assert.deepEqual(saved.at(-1).payload.worker,{recordDigest:started.digest,pid:child.pid,verdict:'gone'});
    // An interruption that omits the worker proof is refused on replay.
    const unproven=structuredClone(saved);delete unproven.at(-1).payload.worker;
    const {digest:old,...record}=unproven.at(-1);unproven[unproven.length-1]={...record,digest:digest(record)};
    assert.throws(()=>readRunnerHistory(unproven,saved[0].payload.config,3),error=>error.code==='runner_interrupt');
  }finally{try{if(child)process.kill(-child.pid,'SIGKILL');}catch{}fs.rmSync(f.root,{recursive:true,force:true});}
});

// V9 (A15/A16/A18): a provider develop that ended without a usable result is
// redone in the same run only after the host proves its journaled worker gone.
test('provider develop without a usable result is redone after its worker group is gone',async()=>{
  const f=runFixture();const children=[];
  try{
    const runId='provider-redo-gone',identity=identityFor(runId),content='written\n';
    const execution=()=>{const value=executionFor(f,content);
      value.developer.run=createCodexDeveloperRun({requestedModel:'fixture',worker:async({prompt},control)=>{
        if(children.length===0){
          control.onWorker({phase:'spawning'});
          const child=spawnChild(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
          child.unref();children.push(child);control.onWorker({phase:'started',pid:child.pid});
          fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'partial\n');
          return {status:'unknown',code:'incomplete_result'};
        }
        fs.writeFileSync(path.join(f.codeProject,'a.mjs'),content);
        return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
          retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}});
      return value;};
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    let run=await openControlRun(definition,'create',execution());
    try{
      const first=await run.host.handle(requestFor(identity));
      assert.equal(first.code,'develop_answer_missing',JSON.stringify(first));assert.equal(first.pendingAction,'develop_redo');
      assert.match(first.reason,/provider/);
    }finally{run.close();}
    const stateFile=path.join(f.reviewsDir,'.execution',runId,'state.json');
    const journaled=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
    assert.deepEqual(journaled.filter(row=>row.payload.type==='develop-worker').map(row=>row.payload.phase),['spawning','started']);
    const redo=async()=>{const value=await openControlRun(definition,'resume',execution(),{allowDevelopRedo:true});
      try{return await value.host.handle({version:1,operation:'develop_redo',requestId:'redo',identity,reason:'worker checked'});}
      finally{value.close();}};
    const before=fs.readFileSync(stateFile);
    const refused=await redo();
    assert.equal(refused.code,'develop_redo_worker_process_alive',JSON.stringify(refused));
    assert.deepEqual(fs.readFileSync(stateFile),before);
    process.kill(-children[0].pid,'SIGKILL');
    const until=Date.now()+5000;
    while(Date.now()<until){try{process.kill(-children[0].pid,0);}catch(error){if(error.code==='ESRCH')break;}await new Promise(resolve=>setTimeout(resolve,25));}
    const recorded=await redo();
    assert.equal(recorded.outcome,'recorded',JSON.stringify(recorded));assert.equal(recorded.code,'develop_answer_missing');
    const redoRecord=JSON.parse(fs.readFileSync(stateFile,'utf8')).records.at(-1);
    assert.equal(redoRecord.payload.type,'develop-answer-redo');assert.equal(redoRecord.payload.cause,'provider_unknown');
    assert.equal(redoRecord.payload.worker.pid,children[0].pid);
    run=await openControlRun(definition,'resume',execution());
    try{const last=await run.host.handle(requestFor(identity));assert.equal(last.code,'review_blocked',JSON.stringify(last));}finally{run.close();}
  }finally{for(const child of children)try{process.kill(-child.pid,'SIGKILL');}catch{}
    if(process.env.DEBUG_KEEP)fs.writeFileSync(process.env.DEBUG_KEEP,f.root);else fs.rmSync(f.root,{recursive:true,force:true});}
});

// A45: the host died after task-commit-intent and before the rename. complete
// finishes the journaled plan; a changed tasks.md is a conflict left in place.
test('interrupted task commit rolls forward from its journaled plan, or stops on a conflict',async()=>{
  for(const kind of ['finish','conflict']){
    const f=runFixture(),runId=`commit-${kind}`,identity=identityFor(runId),content='written\n';
    const rename=fs.renameSync;
    try{
      fs.renameSync=(from,to)=>{if(to===f.tasksPath)throw Object.assign(new Error('host died'),{code:'EIO'});return rename(from,to);};
      try{assert.equal((await start(f,runId,content,{},'approved')).state,'unknown');}finally{fs.renameSync=rename;}
      const stateFile=path.join(f.reviewsDir,'.execution',runId,'state.json');
      const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      const index=current.records.findIndex(row=>row.payload.type==='task-commit-intent');
      const {revision,...body}=current;body.records=current.records.slice(0,index+1);
      fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
      const leftover=path.join(path.dirname(f.tasksPath),body.records.at(-1).payload.commit.temporaryName);
      assert(fs.existsSync(leftover));assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \] T-002/);
      if(kind==='conflict')fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture edited\n');
      const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
        identity,scope:['a.mjs'],requirements:['requirements.md']};
      const resumed=await openControlRun(definition,'resume',executionFor(f,content,'approved'));
      try{
        const status=await resumed.host.handle({version:1,operation:'status',requestId:'status',identity});
        assert.equal(status.code,'complete_commit_interrupted');assert.equal(status.pendingAction,'complete');
        const before=fs.readFileSync(stateFile);
        const result=await resumed.host.handle({version:1,operation:'complete',requestId:'complete',identity,packageDigest:status.packageDigest});
        if(kind==='conflict'){
          assert.equal(result.code,'commit_recovery_conflict',JSON.stringify(result));assert.match(result.reason,/tasks\.md/);
          assert.deepEqual(fs.readFileSync(stateFile),before);
          assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-002: fixture edited\n');
        }else{
          assert.equal(result.state,'fixture_completed',JSON.stringify(result));
          assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/i);assert.equal(fs.existsSync(leftover),false);
          const records=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
          assert.deepEqual(records.slice(-2).map(row=>row.payload.type),['task-commit-result','effect-checkpoint']);
          assert.equal(readRunnerHistory(records,records[0].payload.config,3).state.taskCommit.outcome,'fixture_committed');
        }
      }finally{resumed.close();}
    }finally{fs.renameSync=rename;fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

test('effect-interrupted replay binds intent and last record; forged and duplicate records are refused',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-replay',identity=identityFor(runId),content='written\n';
    await start(f,runId,content);
    const oldRecords=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution',runId,'state.json'),'utf8')).records;
    assert.equal(readRunnerHistory(oldRecords,oldRecords[0].payload.config,3).state.state,'blocked');
    const {body}=interruptAfterIntent(f,runId,'develop');
    const config=body.records[0].payload.config;
    assert.equal(readRunnerHistory(body.records,config,3).state.code,'reconciliation_required');
    // An older runtime's effect-abandoned record still replays as a terminal void.
    const legacyBody={version:1,seq:3,id:'runner.000003',kind:'result',payload:runnerPayloadV3('effect-abandoned',
      {effectId:body.records[1].payload.effect.id,effectKind:'develop',intentDigest:body.records[1].digest,
        reason:'legacy void',at:'2026-09-28T00:00:00.000Z'}),previousDigest:body.records[1].digest};
    assert.equal(readRunnerHistory([...body.records,{...legacyBody,digest:digest(legacyBody)}],config,3).state.code,'effect_abandoned');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'develop_interrupted');}
    finally{resumed.close();}
    const saved=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution',runId,'state.json'),'utf8'));
    assert.equal(readRunnerHistory(saved.records,config,3).state.code,'develop_interrupted');
    for(const [key,value] of [['intentDigest','0'.repeat(64)],['lastRecordDigest','0'.repeat(64)],['effectKind','complete'],
      ['basis','baseline'],['worker',{recordDigest:'0'.repeat(64),pid:2,verdict:'gone'}],['reason','two\nlines']]){
      const altered=structuredClone(saved.records);altered.at(-1).payload[key]=value;
      const {digest:old,...record}=altered.at(-1);altered[altered.length-1]={...record,digest:digest(record)};
      assert.throws(()=>readRunnerHistory(altered,config,3),error=>error.code==='runner_interrupt',key);
    }
    const orphan=structuredClone(saved.records);orphan.splice(1,1);
    orphan[1]={...orphan[1],seq:2,id:'runner.000002',previousDigest:orphan[0].digest};
    const {digest:unused,...orphanBody}=orphan[1];orphan[1]={...orphanBody,digest:digest(orphanBody)};
    assert.throws(()=>readRunnerHistory(orphan,config,3),error=>error.code==='runner_interrupt');
    // A workflow-error control between intent and record makes the step non-interruptible.
    const intent=saved.records[1];
    const controlBody={version:1,seq:3,id:'runner.000003',kind:'cancel',
      payload:runnerPayloadV3('control',{event:'workflow-error'}),previousDigest:intent.digest};
    const control={...controlBody,digest:digest(controlBody)};
    const separatedBody={...saved.records[2],seq:4,id:'runner.000004',previousDigest:control.digest,
      payload:{...saved.records[2].payload,lastRecordDigest:control.digest}};
    delete separatedBody.digest;
    assert.throws(()=>readRunnerHistory([saved.records[0],intent,control,
      {...separatedBody,digest:digest(separatedBody)}],config,3),error=>error.code==='runner_interrupt');
    const prior=saved.records.at(-1),duplicateBody={...prior,seq:prior.seq+1,id:'runner.000004',previousDigest:prior.digest};
    delete duplicateBody.digest;
    assert.throws(()=>readRunnerHistory([...saved.records,{...duplicateBody,digest:digest(duplicateBody)}],config,3),
      error=>error.code==='runner_interrupt');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

function runFixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-supersede-run-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,tasksPath:path.join(specsDir,feature,'tasks.md'),
    reviewsDir:path.join(specsDir,'.reviews')};
}
const identityFor=runId=>({repositoryId:'supersede-fixture',runId,taskId:'T-002',attempt:1});
const requestFor=identity=>({version:1,operation:'advance',requestId:'advance',identity});
const abandonRequest=identity=>({version:1,operation:'abandon_effect',requestId:'abandon-effect',identity,
  reason:'Operator confirmed the old host and its check process exited'});
test('driver maps abandon_effect reason and flag only for resume',()=>{
  const plan={mode:'resume',hostContext:'live',runtime:'claude',reason:'old host exited'};
  assert.equal(abandonEffectPlanError('abandon_effect',plan,['--allow-abandon-effect']),null);
  for(const candidate of [{...plan,mode:'create'},{...plan,reason:'x\ny'},{...plan,reason:'x'.repeat(501)}])
    assert.match(abandonEffectPlanError('abandon_effect',candidate,['--allow-abandon-effect']),/abandon_effect/);
  assert.match(abandonEffectPlanError('abandon_effect',plan,[]),/--allow-abandon-effect/);
  assert.equal(buildCmAiDriveRequest('abandon_effect',plan,{identity:identityFor('driver-mapping')}).reason,plan.reason);
  assert(buildCmAiDriveHostArgs(plan,['--allow-abandon-effect'],'run.json').includes('--allow-abandon-effect'));
});
function interruptAfterIntent(f,runId,kind,attempt=1){
  const stateFile=path.join(f.reviewsDir,'.execution',runId,'state.json');
  const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const index=current.records.findIndex(row=>row.payload.type==='effect-intent'
    &&row.payload.effect.kind===kind&&row.payload.effect.identity.attempt===attempt);
  assert(index>=0,`missing ${kind} attempt ${attempt} intent`);
  const {revision,...body}=current;
  body.records=current.records.slice(0,index+1);
  fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
  assert.equal(readRunnerHistory(body.records,body.records[0].payload.config,3).state.state,'unknown');
  return {stateFile,intent:body.records.at(-1),body};
}
// Rewrites the journal's last record (and its digest) in place, like an older runtime wrote it.
function rewriteLast(stateFile,change){
  const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const {revision,...body}=current,last=structuredClone(body.records.at(-1));change(last.payload);
  const {digest:old,...record}=last;body.records[body.records.length-1]={...record,digest:digest(record)};
  fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
  return body.records;
}
function appendRecord(stateFile,type,fields,kind='result'){
  const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const {revision,...body}=current,seq=body.records.length+1;
  const record={version:1,seq,id:`runner.${String(seq).padStart(6,'0')}`,kind,
    payload:runnerPayloadV3(type,fields),previousDigest:body.records.at(-1).digest};
  body.records.push({...record,digest:digest(record)});
  fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
  return body.records;
}
function executionFor(f,content,verdict='blocked',qaResult=null){
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(request,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:`thread-${request.identity.runId}`});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict,packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),
        findings:verdict==='changes_requested'?[{id:'F1',severity:'P2',path:'a.mjs',message:'Repair needed',evidence:'fixture'}]:[],
        summary:'Synthetic review'}};
    }};
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({
      // Attempt 2 must change the rejected bytes (develop_unchanged_after_review).
      requestedModel:'fixture',worker:async({prompt})=>{fs.writeFileSync(path.join(f.codeProject,'a.mjs'),
        JSON.parse(prompt.split('<cm-developer-data-json>\n')[1]).identity.attempt===1?content:content+'revised\n');
        return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
          retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[reviewer],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],
      authorize:(request,{authorizationAt})=>{
        const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.identity.runId}`,
          adapterId:'codex-review-adapter',invocationId:request.invocationId,requestDigest:request.requestDigest,
          identity:request.identity,reviewerId:'reviewer',logicalContextId:request.contextId,
          packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'control',decisionId:'approved',
          decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
        return {...body,grantDigest:digest(body)};
      }},hostDecision:{status:'approved'},check:createHostCheck({cwd:f.codeProject,
      commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})};
  if(qaResult){
    execution.qaDecisionProvider={timeoutMs:1000,decide:async binding=>({decisionId:'qa-decision',
      identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',
      reason:'fixture qa',score:null,at:'2026-09-24T00:00:00Z'})};
    execution.qaExecutor={mode:'commands',caseCount:1,timeoutMs:2000,run:async binding=>{
      const report=path.join(f.reviewsDir,`${binding.testRunId}-execution.md`);
      fs.writeFileSync(report,`# Fixture ${qaResult} QA\n`);
      return {result:qaResult,passed:qaResult==='PASS'?1:0,failed:qaResult==='FAIL'?1:0,blocked:qaResult==='BLOCKED'?1:0,report};
    }};
  }
  return execution;
}
async function start(f,runId,content,options={},verdict='blocked',qaResult=null){
  const identity=identityFor(runId),definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,
    feature:f.feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const run=await openControlRun(definition,'create',executionFor(f,content,verdict,qaResult),options);
  try{return await run.host.handle(requestFor(identity));}finally{run.close();}
}

async function expectCodeDrift(f,runId,paths){
  const stateFile=path.join(f.reviewsDir,'.execution',runId,'state.json');
  await assert.rejects(start(f,runId,'next\n',{supersedeReason:'restart'}),error=>{
    assert.equal(error.code,'supersede_code_drift');
    for(const name of paths)assert.match(error.reason,new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.match(error.reason,/手动还原这些文件后重建运行/);
    assert.match(error.reason,/--accept-superseded-code-drift/);
    return true;
  });
  assert.equal(fs.existsSync(stateFile),false);
}

test('supersession refuses code left by an old run and proceeds after manual restoration',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-drift-old-0001','written\n')).state,'blocked');
    await expectCodeDrift(f,'run-drift-new-0002',['a.mjs']);
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    assert.equal((await start(f,'run-drift-new-0002','next\n',{supersedeReason:'restart'})).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('chained supersession checks only the immediate predecessor baseline',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'chain-one-0001','first\n')).state,'blocked');
    assert.equal((await start(f,'chain-two-0002','second\n',
      {supersedeReason:'keep first',acceptSupersededCodeDrift:true})).state,'blocked');
    await expectCodeDrift(f,'chain-three-0003',['a.mjs']);
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'first\n');
    assert.equal((await start(f,'chain-three-0003','third\n',{supersedeReason:'next'})).state,'blocked');
    const state=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','chain-three-0003','state.json')));
    const record=state.records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert.deepEqual(record.previousRunIds,['chain-one-0001','chain-two-0002']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('explicit drift acknowledgement records current hashes and deleted paths',async()=>{
  const f=runFixture();
  try{
    fs.writeFileSync(path.join(f.codeProject,'deleted.mjs'),'before\n');
    assert.equal((await start(f,'accept-one-0001','first\n')).state,'blocked');
    fs.rmSync(path.join(f.codeProject,'deleted.mjs'));
    fs.writeFileSync(path.join(f.codeProject,'added.mjs'),'current\n');
    await expectCodeDrift(f,'accept-two-0002',['a.mjs','deleted.mjs','added.mjs']);
    assert.equal((await start(f,'accept-two-0002','second\n',
      {supersedeReason:'keep existing changes',acceptSupersededCodeDrift:true})).state,'blocked');
    const state=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','accept-two-0002','state.json')));
    const record=state.records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    const current=content=>createHash('sha256').update(content).digest('hex');
    assert.deepEqual(record.acceptedCodeDrift,[
      {predecessorRunId:'accept-one-0001',path:'a.mjs',sha256:current('first\n')},
      {predecessorRunId:'accept-one-0001',path:'added.mjs',sha256:current('current\n')},
      {predecessorRunId:'accept-one-0001',path:'deleted.mjs',sha256:null}]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersession refuses deleted, unselected, and newly added code paths',async()=>{
  for(const [name,change] of [
    ['deleted.mjs',f=>fs.rmSync(path.join(f.codeProject,'deleted.mjs'))],
    ['unselected.mjs',f=>fs.writeFileSync(path.join(f.codeProject,'unselected.mjs'),'changed\n')],
    ['added.mjs',f=>fs.writeFileSync(path.join(f.codeProject,'added.mjs'),'added\n')]]){
    const f=runFixture();
    try{
      if(name!=='added.mjs')fs.writeFileSync(path.join(f.codeProject,name),'before\n');
      const prior=await start(f,'run-path-old-0001','written\n');assert.equal(prior.state,'blocked',JSON.stringify(prior));
      fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
      change(f);
      await expectCodeDrift(f,'run-path-new-0002',[name]);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

test('supersession of an untouched code tree proceeds',async()=>{
  const f=runFixture();
  try{
    const prior=await start(f,'run-clean-old-0001','written\n');assert.equal(prior.state,'blocked',JSON.stringify(prior));
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    assert.equal((await start(f,'run-clean-new-0002','new\n',{supersedeReason:'restart'})).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersession drift reason lists only the first 20 of 21 paths',async()=>{
  const f=runFixture();
  try{
    for(let i=0;i<21;i++)fs.writeFileSync(path.join(f.codeProject,`file-${String(i).padStart(2,'0')}.mjs`),'before\n');
    const prior=await start(f,'run-many-old-0001','written\n');assert.equal(prior.state,'blocked',JSON.stringify(prior));
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    for(let i=0;i<21;i++)fs.writeFileSync(path.join(f.codeProject,`file-${String(i).padStart(2,'0')}.mjs`),'after\n');
    await assert.rejects(start(f,'run-many-new-0002','new\n',{supersedeReason:'restart'}),error=>{
      assert.equal(error.code,'supersede_code_drift');
      for(let i=0;i<20;i++)assert.match(error.reason,new RegExp(`file-${String(i).padStart(2,'0')}\\.mjs`));
      assert.doesNotMatch(error.reason,/file-20\.mjs/);
      assert.match(error.reason,/等 1 个/);
      return true;
    });
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersession refuses a symlink without reading its target outside the code root',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-link-old-0001','written\n')).state,'blocked');
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const outside=path.join(f.root,'outside.mjs');
    fs.writeFileSync(outside,'private fixture\n');
    fs.symlinkSync(outside,path.join(f.codeProject,'link.mjs'));
    for(const acceptSupersededCodeDrift of [false,true])
      await assert.rejects(start(f,'run-link-new-0002','new\n',
        {supersedeReason:'restart',acceptSupersededCodeDrift}),error=>
        error.code==='supersede_code_drift'&&/无法安全核对代码树/.test(error.reason));
    assert.equal(fs.readFileSync(outside,'utf8'),'private fixture\n');
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.execution','run-link-new-0002')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('host launch prints supersede code drift reason and stderr hint',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-host-old-0001','written\n')).state,'blocked');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity:identityFor('run-host-new-0002'),scope:['a.mjs'],requirements:['requirements.md']};
    const config=path.join(f.root,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
    const review=path.join(f.root,'review.json');fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{}}));
    const output=new PassThrough(),error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
    assert.equal(await hostMain(['serve','--config',config,'--mode','create','--host-context','fixture-host',
      '--allow-development','--runtime','claude','--review-config',review,'--supersede-reviewed-evidence','--supersede-reason','restart'],
    {input:new PassThrough(),output,error}),1);
    assert.match(stderr,/\[host\].*a\.mjs/);
    const response=JSON.parse(stderr.trim().split('\n').at(-1));
    assert.equal(response.error.code,'supersede_code_drift');
    assert.match(response.error.reason,/a\.mjs/);
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.execution','run-host-new-0002')),false);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('explicit restart archives reviewed bytes and records a new-run authorization',async()=>{
  const f=runFixture();
  try{
    const first=await start(f,'run-one-0001','first\n');
    assert.equal(first.state,'blocked');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-a2-handoff.json'),'{}\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-correction-r1.md'),'# Old correction evidence\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-qa-extra.json'),'{}\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-r2.md'),'# Old second review\n');
    const oldNames=['work-T-002-a1-handoff.json','work-T-002-a2-handoff.json',
      'work-T-002-correction-r1.md','work-T-002-qa-extra.json','work-T-002-r1.md','work-T-002-r2.md'];
    const old=new Map(oldNames.map(name=>[name,fs.readFileSync(path.join(f.reviewsDir,name))]));
    const priorJournal=fs.readFileSync(path.join(f.reviewsDir,'.execution','run-one-0001','state.json'));
    await assert.rejects(start(f,'run-two-0002','second\n'),error=>{
      assert.equal(error.code,'handoff_exists');
      assert.match(error.reason,/--supersede-reviewed-evidence/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.execution','run-two-0002')),false);
    for(const [name,bytes] of old)assert.deepEqual(fs.readFileSync(path.join(f.reviewsDir,name)),bytes);
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.superseded')),false);
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const second=await start(f,'run-three-0003','third\n',{supersedeReason:'Operator confirmed genuine restart'});
    assert.equal(second.state,'blocked');
    const archive=path.join(f.reviewsDir,'.superseded');
    for(const [name,bytes] of old){
      const sha=createHash('sha256').update(bytes).digest('hex');
      assert.deepEqual(fs.readFileSync(path.join(archive,`${name}.${sha.slice(0,16)}`)),bytes);
    }
    const state=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-three-0003','state.json')));
    const record=state.records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.deepEqual(record.previousRunIds,['run-one-0001']);
    assert.deepEqual(record.files.map(file=>file.name),oldNames);
    for(const file of record.files)assert.equal(file.sha256,
      createHash('sha256').update(old.get(file.name)).digest('hex'));
    assert.equal(record.reason,'Operator confirmed genuine restart');
    assert.deepEqual(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-one-0001','state.json')),priorJournal);
    assert(fs.existsSync(path.join(f.reviewsDir,'work-T-002-r1.md')));
    const newStateFile=path.join(f.reviewsDir,'.execution','run-three-0003','state.json');
    const beforeResume=fs.readFileSync(newStateFile);
    const identity=identityFor('run-three-0003');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'third\n'));
    resumed.close();assert.deepEqual(fs.readFileSync(newStateFile),beforeResume);
    const events=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.event==='supersede'&&row.run_id==='run-three-0003');
    assert.equal(events.length,1);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('reviewed run with BLOCKED QA reproduces the collision after the task is reopened',async()=>{
  const f=runFixture();
  try{
    const first=await start(f,'run-qa-one-0001','first\n',{},'approved','BLOCKED');
    assert.equal(first.code,'qa_result_blocked');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/);
    await assert.rejects(start(f,'run-qa-refused-0002','second\n',{supersedeReason:'restart'}),error=>
      error.code==='supersede_unavailable'&&/先将该任务改回 - \[ \]/.test(error.reason)
        &&/--supersede-reviewed-evidence/.test(error.reason)&&/--supersede-reason/.test(error.reason));
    const oldEvidence=new Map(fs.readdirSync(f.reviewsDir,{withFileTypes:true})
      .filter(entry=>entry.isFile()).map(entry=>[entry.name,fs.readFileSync(path.join(f.reviewsDir,entry.name))]));
    const priorJournal=fs.readFileSync(path.join(f.reviewsDir,'.execution','run-qa-one-0001','state.json'));
    // N5 checked the task before N6. The explicit restart rule requires an
    // operator to reopen it; this test keeps that precondition visible.
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    await assert.rejects(start(f,'run-qa-two-0002','second\n'),error=>{
      assert.equal(error.code,'handoff_exists');
      assert.match(error.reason,/--rerun-blocked-qa/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.execution','run-qa-two-0002')),false);
    assert.deepEqual(fs.readdirSync(f.reviewsDir,{withFileTypes:true})
      .filter(entry=>entry.isFile()).map(entry=>entry.name).sort(),[...oldEvidence.keys()].sort());
    for(const [name,bytes] of oldEvidence)assert.deepEqual(fs.readFileSync(path.join(f.reviewsDir,name)),bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-qa-one-0001','state.json')),priorJournal);
    assert.equal(fs.existsSync(path.join(f.reviewsDir,'.superseded')),false);
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const restarted=await start(f,'run-qa-three-0003','third\n',{supersedeReason:'Reopen after blocked QA'});
    assert.equal(restarted.state,'blocked');
    const record=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-qa-three-0003','state.json')))
      .records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.deepEqual(record.previousRunIds,['run-qa-one-0001']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a normally completed previous task cannot be superseded',async()=>{
  const f=runFixture();
  try{
    const completed=await start(f,'run-complete-0001','done\n',{},'approved');
    assert.equal(completed.state,'fixture_completed');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/);
    await assert.rejects(start(f,'run-refused-0002','again\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/已将任务标为完成/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a completed journal with passed QA still refuses supersession after the task is reopened',async()=>{
  const f=runFixture();
  try{
    const completed=await start(f,'run-complete-reopened-0001','done\n',{},'approved','PASS');
    assert.equal(completed.state,'fixture_completed');
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(rows.some(row=>row.run_id==='run-complete-reopened-0001'&&row.event==='test_run'
      &&row.phase==='complete'&&row.result==='PASS'));
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    await assert.rejects(start(f,'run-refused-reopened-0002','again\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/的 QA 已通过/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('#15 a reopened task whose QA failed is refused with the QA-fix route, not a claim that it passed',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-failed-qa-0001','done\n',{},'approved','FAIL')).code,'qa_failed');
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    await assert.rejects(start(f,'run-refused-failed-0002','again\n',{supersedeReason:'restart'}),error=>{
      assert.equal(error.code,'supersede_unavailable');
      assert.doesNotMatch(error.reason,/已完成|已通过/);
      assert.match(error.reason,/run-failed-qa-0001 的最新 QA 结果为 FAIL/);assert.match(error.reason,/abandon_review/);
      return true;
    });
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersession recognizes the optional task strikethrough used by admission',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-struck-0001','first\n')).state,'blocked');
    fs.writeFileSync(f.tasksPath,'- [ ] ~~T-002: fixture\n');
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const record=prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,
      feature:f.feature,identity:identityFor('run-struck-0002'),reason:'restart',tasksPath:f.tasksPath});
    assert.deepEqual(record.previousRunIds,['run-struck-0001']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('lsof warnings do not hide a closed writer, but other diagnostics fail closed',async()=>{
  const {oldWriterOpen}=await import('../runtime/js/cm-ai/reviewed-evidence-supersede.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-lsof-')));
  try{
    const tool=path.join(root,'lsof');
    const write=(warning,code,stdout='')=>{fs.writeFileSync(tool,`#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(warning)});process.stdout.write(${JSON.stringify(stdout)});process.exit(${code});\n`);fs.chmodSync(tool,0o755);};
    write("lsof: WARNING: can't stat() fuse file system\n",1);
    assert.equal(oldWriterOpen(root,'old-run',{lsofPath:tool}),false);
    write("lsof: WARNING: can't stat() network file system\n",0,'p123\n');
    assert.equal(oldWriterOpen(root,'old-run',{lsofPath:tool}),true);
    write('lsof: unexpected error\n',1);
    assert.throws(()=>oldWriterOpen(root,'old-run',{lsofPath:tool}),
      error=>error.code==='supersede_unavailable'&&/无法核对/.test(error.reason));
    fs.chmodSync(tool,0o644);
    assert.throws(()=>oldWriterOpen(root,'old-run',{lsofPath:tool}),
      error=>error.code==='supersede_unavailable'&&/无法核对/.test(error.reason));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a terminal journal is not supersedable while its old writer is still open',async()=>{
  const f=runFixture();
  try{
    const identity=identityFor('run-held-0001');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const held=await openControlRun(definition,'create',executionFor(f,'first\n'));
    try{
      assert.equal((await held.host.handle(requestFor(identity))).state,'blocked');
      await assert.rejects(start(f,'run-refused-0002','second\n',{supersedeReason:'restart'}),
        error=>error.code==='supersede_unavailable'&&/writer 仍被进程持有/.test(error.reason));
    }finally{held.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersede refuses missing reason, no prior evidence, an active run, and a checked task',async()=>{
  const f=runFixture();
  try{
    await assert.rejects(start(f,'run-empty-0001','new\n',{supersedeReason:'restart'}),{code:'supersede_unavailable'});
    const identity=identityFor('run-active-0002');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const active=await openControlRun(definition,'create',executionFor(f,'first\n'));
    try{
      await assert.rejects(start(f,'run-refused-0003','second\n',{supersedeReason:'restart'}),
        error=>error.code==='supersede_unavailable'&&/仍可继续/.test(error.reason));
    }finally{active.close();}
    const first=await start(f,'run-blocked-0004','first\n');assert.equal(first.state,'blocked');
    await assert.rejects(start(f,'run-refused-0005','second\n',{supersedeReason:''}),
      error=>error.code==='supersede_unavailable'&&/500 字节/.test(error.reason));
    await assert.rejects(start(f,'run-refused-0007','second\n',{supersedeReason:'汉'.repeat(167)}),
      error=>error.code==='supersede_unavailable'&&/500 字节/.test(error.reason));
    fs.writeFileSync(f.tasksPath,'- [x] T-002: fixture\n');
    await assert.rejects(start(f,'run-refused-0006','second\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/已将任务标为完成/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('CLI requires both create-time supersession flags before opening a run',async()=>{
  const output=new PassThrough(),error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
  const base=['serve','--config','/missing/run.json','--mode','create','--host-context','fixture','--allow-development'];
  assert.equal(await hostMain([...base,'--supersede-reviewed-evidence'],
    {input:new PassThrough(),output,error}),1);
  assert.match(stderr,/supersede_unavailable/);
  stderr='';
  assert.equal(await hostMain([...base,'--supersede-reason','restart'],
    {input:new PassThrough(),output,error}),1);
  assert.match(stderr,/supersede_unavailable/);
  stderr='';
  assert.equal(await hostMain([...base,'--accept-superseded-code-drift'],
    {input:new PassThrough(),output,error}),1);
  assert.match(stderr,/supersede_unavailable/);
});

test('host stderr carries the handoff recovery hint while the result keeps its code',async()=>{
  const error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
  const host=withHandoffDiagnostic({handle:async()=>({outcome:'blocked',code:'handoff_exists'})},error);
  assert.equal((await host.handle({operation:'advance'})).code,'handoff_exists');
  assert.match(stderr,/\[host\].*--revise-qa-config.*--rerun-blocked-qa.*--supersede-reviewed-evidence/);
});

test('resume completes an interrupted archive from the durable new-run record',async()=>{
  const f=runFixture();
  try{
    await start(f,'run-first-0001','first\n');
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const identity=identityFor('run-next-0002');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const originalLink=fs.linkSync;
    fs.linkSync=function(source,target){
      if(source.endsWith('work-T-002-r1.md'))throw Object.assign(new Error('injected archival crash'),{code:'EIO'});
      return originalLink.call(fs,source,target);
    };
    try{await assert.rejects(openControlRun(definition,'create',executionFor(f,'second\n'),
      {supersedeReason:'restart after blocked review'}),/injected archival crash/);}
    finally{fs.linkSync=originalLink;}
    const stateFile=path.join(f.reviewsDir,'.execution',identity.runId,'state.json');
    const before=fs.readFileSync(stateFile);
    const record=JSON.parse(before).records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.equal(record.files.length,2);
    assert.equal(record.carriedReview.previousRunId,'run-first-0001');
    const seen={develop:[],review:[]};
    const resumed=await openControlRun(definition,'resume',capturing(executionFor(f,'second\n'),seen));
    try{
      assert.deepEqual(fs.readFileSync(stateFile),before);
      assert(record.files.every(file=>fs.existsSync(path.join(f.reviewsDir,'.superseded',
        `${file.name}.${file.sha256.slice(0,16)}`))));
      assert(record.files.every(file=>!fs.existsSync(path.join(f.reviewsDir,file.name))));
      const result=await resumed.host.handle(requestFor(identity));
      assert.equal(result.state,'blocked');assert(fs.existsSync(path.join(f.reviewsDir,'work-T-002-r1.md')));
      // Context restored from the journal reaches the first develop after a resume.
      assert.deepEqual(seen.develop[0].payload.supersededReview,record.carriedReview);
    }finally{resumed.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// #22: the superseded run's last review travels as read-only, journal-bound context.
function capturing(execution,seen){
  const developer=execution.developer,reviewer=execution.reviewers[0];
  return {...execution,developer:{...developer,run:(request,control)=>{seen.develop.push(request);return developer.run(request,control);}},
    reviewers:[{...reviewer,run:(request,control)=>{seen.review.push(request);return reviewer.run(request,control);}}]};
}
function rechain(records){
  return records.reduce((out,row,index)=>{
    const {digest:unused,...body}=row,next={...body,previousDigest:index?out[index-1].digest:null};
    return [...out,{...next,digest:digest(next)}];
  },[]);
}
async function startCapturing(f,runId,content,options,verdict,seen){
  const identity=identityFor(runId),definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,
    feature:f.feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const run=await openControlRun(definition,'create',capturing(executionFor(f,content,verdict),seen),options);
  try{return await run.host.handle(requestFor(identity));}finally{run.close();}
}
test('#22 supersede carries the previous review_limit findings into the first develop and review as context',async()=>{
  const f=runFixture();
  try{
    const first=await start(f,'carry-one-0001','first\n',{},'changes_requested');
    assert.equal(first.code,'review_limit',JSON.stringify(first));
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const seen={develop:[],review:[]};
    const second=await startCapturing(f,'carry-two-0002','second\n',{supersedeReason:'restart after review limit'},
      'changes_requested',seen);
    // Context never counts as a verdict: the new run still spends both of its own rounds.
    assert.equal(second.code,'review_limit',JSON.stringify(second));
    assert.deepEqual(seen.develop.map(r=>r.identity.attempt),[1,2]);
    assert.deepEqual(seen.review.map(r=>r.identity.attempt),[1,2]);
    const expected={previousRunId:'carry-one-0001',verdict:'changes_requested',summary:'Synthetic review',
      findings:[{id:'F1',severity:'P2',path:'a.mjs',message:'Repair needed',evidence:'fixture'}]};
    assert.deepEqual(seen.develop[0].payload.supersededReview,expected);
    assert.equal(seen.develop[0].payload.priorReview,null);
    assert.deepEqual(seen.review[0].payload.supersededReview,expected);
    assert.equal(seen.review[0].payload.priorReview,null);
    for(const request of [seen.develop[1],seen.review[1]])assert.equal(Object.hasOwn(request.payload,'supersededReview'),false);
    const developPrompt=buildCodexDeveloperPrompt(seen.develop[0]);
    assert.match(developPrompt,/supersededReview exists, it is read-only context/);
    assert.match(developPrompt,/"supersededReview":\{"previousRunId":"carry-one-0001".*"Repair needed"/);
    const reviewPrompt=buildCodexReviewPrompt(seen.review[0]);
    assert.match(reviewPrompt,/previous run's findings \(context, not a verdict\)/);
    assert.match(reviewPrompt,/"supersededReview":\{"previousRunId":"carry-one-0001".*"Repair needed"/);
    assert.doesNotMatch(buildCodexReviewPrompt(seen.review[1]),/"supersededReview":/);
    const stateFile=path.join(f.reviewsDir,'.execution','carry-two-0002','state.json');
    const saved=JSON.parse(fs.readFileSync(stateFile,'utf8')),config=saved.records[0].payload.config;
    const index=saved.records.findIndex(row=>row.payload.type==='evidence-superseded');
    assert.equal(index,1);assert.deepEqual(saved.records[index].payload.record.carriedReview,expected);
    assert.equal(readRunnerHistory(saved.records,config,3).state.code,'review_limit');
    // The journal binds the context: swapping or dropping it breaks request replay.
    const swapped=structuredClone(saved.records);swapped[index].payload.record.carriedReview.findings[0].message='Other';
    assert.throws(()=>readRunnerHistory(rechain(swapped),config,3),error=>error.code==='runner_request');
    const dropped=structuredClone(saved.records);delete dropped[index].payload.record.carriedReview;
    assert.throws(()=>readRunnerHistory(rechain(dropped),config,3),error=>error.code==='runner_request');
    const before=fs.readFileSync(stateFile);
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity:identityFor('carry-two-0002'),scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'second\n','changes_requested'));
    resumed.close();assert.deepEqual(fs.readFileSync(stateFile),before);
    // A third run chains from the direct predecessor's own last review.
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const third=prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity:identityFor('carry-three-0003'),reason:'again',tasksPath:f.tasksPath});
    assert.equal(third.carriedReview.previousRunId,'carry-two-0002');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('#22 a supersede record without carried review keeps the legacy request shape',async()=>{
  const f=runFixture();
  try{
    const runId='carry-legacy-0001',identity=identityFor(runId);
    await start(f,runId,'written\n');
    interruptAfterIntent(f,runId,'develop');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'written\n'),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'develop_interrupted');}
    finally{resumed.close();}
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    const seen={develop:[],review:[]};
    assert.equal((await startCapturing(f,'carry-legacy-0002','next\n',{supersedeReason:'restart'},'blocked',seen)).code,'review_blocked');
    const saved=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','carry-legacy-0002','state.json'),'utf8'));
    const record=saved.records.find(row=>row.payload.type==='evidence-superseded').payload.record;
    assert.equal(Object.hasOwn(record,'carriedReview'),false);
    for(const request of [...seen.develop,...seen.review])assert.equal(Object.hasOwn(request.payload,'supersededReview'),false);
    assert.equal(readRunnerHistory(saved.records,saved.records[0].payload.config,3).state.code,'review_blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('#22 carried review grammar is strict and bound to a previous run',()=>{
  const base={version:1,feature:'1.work',taskId:'T-002',newRunId:'new-run',previousRunIds:['old-run'],reason:'restart',
    files:[{name:'work-T-002-r1.md',sha256:'a'.repeat(64)}],authorizedAt:'2026-09-29T00:00:00.000Z'};
  const carried={previousRunId:'old-run',verdict:'blocked',summary:'s',findings:[]};
  assert.deepEqual(readEvidenceSupersession(base),base);
  assert.deepEqual(readEvidenceSupersession({...base,carriedReview:carried}).carriedReview,carried);
  for(const bad of [{...carried,previousRunId:'other-run'},{...carried,extra:1},{...carried,verdict:'maybe'},
    {...carried,summary:'x'.repeat(13*1024)},{...carried,findings:[{id:'F1',severity:'P9',path:'a',message:'m',evidence:'e'}]}])
    assert.throws(()=>readEvidenceSupersession({...base,carriedReview:bad}),error=>error.code==='supersede_record_invalid');
});
