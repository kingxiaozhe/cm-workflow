import test from 'node:test';
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
import {readRunnerHistory,runnerPayloadV3} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {abandonEffectPlanError,buildCmAiDriveRequest,buildCmAiDriveHostArgs} from './cm-ai-drive.mjs';

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

test('interrupted first develop can be abandoned on resume and a plain run can start',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-develop-a1',identity=identityFor(runId);
    assert.equal((await start(f,runId,'written\n')).state,'blocked');
    const {stateFile}=interruptAfterIntent(f,runId,'develop');
    fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
    for(const name of fs.readdirSync(f.reviewsDir))if(name.startsWith('work-T-002-'))
      fs.rmSync(path.join(f.reviewsDir,name));
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'written\n'),{allowAbandonEffect:true});
    try{
      const status=await resumed.host.handle({version:1,operation:'status',requestId:'status',identity});
      assert.equal(status.pendingAction,'abandon_effect');
      const result=await resumed.host.handle(abandonRequest(identity));
      assert.equal(result.outcome,'abandoned');assert.equal(result.state,'cancelled');
      assert.equal(result.code,'effect_abandoned');
    }finally{resumed.close();}
    const records=JSON.parse(fs.readFileSync(stateFile,'utf8')).records;
    assert.deepEqual(records.slice(-2).map(row=>row.payload.type),['effect-intent','effect-abandoned']);
    assert.equal(readRunnerHistory(records,records[0].payload.config,3).pending,null);
    assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'old\n');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \] T-002/);
    assert.equal((await start(f,'abandon-develop-new','next\n')).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('interrupted second develop after changes requested can be abandoned before supersede',async()=>{
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
      assert.equal(result.state,'cancelled',JSON.stringify(result));assert.equal(result.code,'effect_abandoned');
    }finally{resumed.close();}
    await assert.rejects(start(f,'abandon-a2-new','next\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_code_drift');
    assert.equal((await start(f,'abandon-a2-new','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true})).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('interrupted complete checks can be abandoned; task commit intent is refused',async()=>{
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
      assert.equal(result.state,'cancelled',JSON.stringify(result));assert.equal(result.code,'effect_abandoned');
    }finally{resumed.close();}
    assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).records.at(-1).payload.type,'effect-abandoned');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \] T-002/);
    await assert.rejects(start(f,'abandon-complete-next','next\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_code_drift');
    assert.equal((await start(f,'abandon-complete-next','next\n',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true})).state,'blocked');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('abandon_effect refuses absent intent, accepts pre-dispatch review, and requires flag and reason',async()=>{
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
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandoned');}
    finally{resumed.close();}
    interruptAfterIntent(f,runId,'develop');
    resumed=await openControlRun(definition,'resume',executionFor(f,content));
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandon_authorization_required');}
    finally{resumed.close();}
    resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{
      assert.equal((await resumed.host.handle({...abandonRequest(identity),reason:''})).code,'effect_abandon_reason_required');
      assert.equal((await resumed.host.handle({...abandonRequest(identity),reason:'two\nlines'})).code,'effect_abandon_reason_required');
      assert.equal((await resumed.host.handle(abandonRequest(identity))).state,'cancelled');
    }finally{resumed.close();}
    resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandon_no_pending');}
    finally{resumed.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('abandon_effect refuses provider development and pending task commit',async()=>{
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
      if(kind==='provider')interruptAfterIntent(f,runId,'develop');
      else {
        const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
        const index=current.records.findIndex(row=>row.payload.type==='task-commit-intent');
        assert(index>=0);const {revision,...body}=current;body.records=current.records.slice(0,index+1);
        fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
      }
      const before=fs.readFileSync(stateFile);
      const resumed=await openControlRun(definition,'resume',execution,{allowAbandonEffect:true});
      try{
        const result=await resumed.host.handle(abandonRequest(identity));
        assert.equal(result.code,kind==='provider'?'effect_abandon_provider_development':'effect_abandon_commit_pending');
        if(kind==='commit')assert.match(result.reason,/tasks\.md.*提交回执.*旧进程/);
      }finally{resumed.close();}
      assert.deepEqual(fs.readFileSync(stateFile),before);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
});

test('effect-abandoned replay binds the adjacent intent and remains terminal',async()=>{
  const f=runFixture();
  try{
    const runId='abandon-replay',identity=identityFor(runId),content='written\n';
    await start(f,runId,content);
    const oldRecords=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution',runId,'state.json'),'utf8')).records;
    assert.equal(readRunnerHistory(oldRecords,oldRecords[0].payload.config,3).state.state,'blocked');
    const {body}=interruptAfterIntent(f,runId,'develop');
    const config=body.records[0].payload.config;
    assert.equal(readRunnerHistory(body.records,config,3).state.code,'reconciliation_required');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,content),{allowAbandonEffect:true});
    try{assert.equal((await resumed.host.handle(abandonRequest(identity))).code,'effect_abandoned');}
    finally{resumed.close();}
    const saved=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution',runId,'state.json'),'utf8'));
    assert.equal(readRunnerHistory(saved.records,config,3).state.code,'effect_abandoned');
    const altered=structuredClone(saved.records);altered.at(-1).payload.intentDigest='0'.repeat(64);
    const {digest:old,...record}=altered.at(-1);altered[altered.length-1]={...record,digest:digest(record)};
    assert.throws(()=>readRunnerHistory(altered,config,3),error=>error.code==='runner_abandon');
    const orphan=structuredClone(saved.records);orphan.splice(1,1);
    orphan[1]={...orphan[1],seq:2,id:'runner.000002',previousDigest:orphan[0].digest};
    const {digest:unused,...orphanBody}=orphan[1];orphan[1]={...orphanBody,digest:digest(orphanBody)};
    assert.throws(()=>readRunnerHistory(orphan,config,3),error=>error.code==='runner_abandon');
    const intent=saved.records[1];
    const controlBody={version:1,seq:3,id:'runner.000003',kind:'cancel',
      payload:runnerPayloadV3('control',{event:'workflow-error'}),previousDigest:intent.digest};
    const control={...controlBody,digest:digest(controlBody)};
    const separatedBody={...saved.records[2],seq:4,id:'runner.000004',previousDigest:control.digest};
    delete separatedBody.digest;
    assert.throws(()=>readRunnerHistory([saved.records[0],intent,control,
      {...separatedBody,digest:digest(separatedBody)}],config,3),error=>error.code==='runner_abandon');
    const prior=saved.records.at(-1),duplicateBody={...prior,seq:prior.seq+1,id:'runner.000004',previousDigest:prior.digest};
    delete duplicateBody.digest;
    assert.throws(()=>readRunnerHistory([...saved.records,{...duplicateBody,digest:digest(duplicateBody)}],config,3),
      error=>error.code==='runner_abandon');
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
      return {result:qaResult,passed:qaResult==='PASS'?1:0,failed:0,blocked:qaResult==='BLOCKED'?1:0,report};
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
    const output=new PassThrough(),error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
    assert.equal(await hostMain(['serve','--config',config,'--mode','create','--host-context','fixture-host',
      '--allow-development','--runtime','claude','--supersede-reviewed-evidence','--supersede-reason','restart'],
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
      error=>error.code==='supersede_unavailable'&&/已完成或 QA 已通过/.test(error.reason));
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
    const resumed=await openControlRun(definition,'resume',executionFor(f,'second\n'));
    try{
      assert.deepEqual(fs.readFileSync(stateFile),before);
      assert(record.files.every(file=>fs.existsSync(path.join(f.reviewsDir,'.superseded',
        `${file.name}.${file.sha256.slice(0,16)}`))));
      assert(record.files.every(file=>!fs.existsSync(path.join(f.reviewsDir,file.name))));
      const result=await resumed.host.handle(requestFor(identity));
      assert.equal(result.state,'blocked');assert(fs.existsSync(path.join(f.reviewsDir,'work-T-002-r1.md')));
    }finally{resumed.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
