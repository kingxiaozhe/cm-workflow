import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {captureReviewInventory} from '../runtime/js/cm-ai/review-package.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openControlRun,controlLaunchTarget} from './cm-ai-run.mjs';
import {gapFixture,gapExecution,definition,identity,records,learning} from './cm-ai-answer-gap-fixture.mjs';
import {readRunnerHistory,developBudget,applyDevelopmentRework,effectSlotFree,developBudgetExhausted,MAX_RUNNER_EFFECTS,controlledState,developmentReworkBinding} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'};
const selected=f=>({...definition(f),taskSelection:{version:1,taskId:identity(1).taskId},featureSelection:{version:1,feature:f.feature}});
const execution=(f,options)=>{
  const value=gapExecution(f,options);value.configuration.controlPolicy=policy;
  if(f.workflow){
    value.configuration.hostContextId='control';value.configuration.workflow=structuredClone(f.workflow);
    const nativeCheck=value.check;value.check=(request,control)=>nativeCheck({identity:request.identity},control);
    value.qaLogHome=path.join(f.root,'qa-logs');
    value.qaExecutor=createHostQaExecutor({codeProject:f.codeProject,specsDir:f.specsDir,feature:f.feature,
      requirements:['requirements.md'],runtime:'codex',...f.workflow.qa,timeoutMs:60000,logHome:value.qaLogHome});
  }return value;
};
async function session(f,mode,exec,actions,options={}){
  const run=await openControlRun(selected(f),mode,exec,options);
  try{return await actions(run.controlHost,run);}finally{run.close();}
}
let serial=0;
const send=(host,operation,attempt=1,extra={})=>host.handle({version:2,requestId:`rework-${++serial}`,operation,identity:identity(attempt),...extra});
const history=f=>{const rows=records(f);return readRunnerHistory(rows,rows[0].payload.config,3);};
async function limited(t,{qaRevision=false,cancelledRecheck=true}={}){
  const f=gapFixture(t,'development-rework');
  if(qaRevision){f.workflow={qa:{commands:[],environment:{kind:'web',carrier:'browser',target:'before',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]};
    fs.writeFileSync(path.join(f.codeProject,'pagination.test.mjs'),'unchanged test fixture\n');}
  const first=execution(f,{developer:['one\n','two\n','three\n']});let count=0,oldSignal;
  first.check=(_request,control)=>{
    count++;
    if(count<=2)return [{id:'syntax',command:['fixture'],outcome:'failed',exitCode:1,evidence:'synthetic failed check'}];
    if(count===3){oldSignal=control.signal;return new Promise(()=>{});}
    assert.equal(oldSignal.aborted,true);
    if(cancelledRecheck)throw Object.assign(new Error('cancelled'),{code:'cancelled'});
    return [{id:'syntax',command:['fixture'],outcome:'passed',exitCode:0,evidence:'successful check-only retry'}];
  };
  if(qaRevision){
    let target;
    await session(f,'create',first,async host=>{
      assert.equal((await send(host,'start')).code,'develop_checks_not_passed');target=(await send(host,'status')).controlTarget;
    });
    const previousWorkflow=structuredClone(f.workflow);f.workflow.qa.environment.target='after';
    const second=execution(f,{developer:['two\n','three\n']});second.check=first.check;
    await session(f,'resume',second,async()=>{}, {qaConfigRevision:{reason:'Revise the future QA environment before any QA round',previousWorkflow},expectedControl:target});
    const scopeTarget=launchTarget(f);
    await session(f,'resume',second,async()=>{}, {scopeRevision:{scope:['a.mjs','pagination.test.mjs'],reason:'Add an unchanged synthetic test'},expectedControl:scopeTarget});
    await session(f,'resume',second,async host=>{
      assert.equal((await send(host,'start')).code,'develop_checks_not_passed');
      for(let n=0;n<(cancelledRecheck?2:1);n++)assert.equal((await send(host,'start')).code,'check_answer_missing');
    });
  }else await session(f,'create',first,async host=>{
    for(let n=0;n<2;n++)assert.equal((await send(host,'start')).code,'develop_checks_not_passed');
    for(let n=0;n<(cancelledRecheck?2:1);n++)assert.equal((await send(host,'start')).code,'check_answer_missing');
  });
  await session(f,'resume',execution(f,{checks:['ok'],verdicts:['changes_requested']}),async host=>{
    const delivered=await send(host,'start');assert.equal(delivered.state,'awaiting_review',JSON.stringify(delivered));
    const status=await send(host,'status');assert.equal((await send(host,'decision',1,{packageDigest:status.packageDigest})).state,'changes_requested');
  });
  assert.deepEqual(developBudget(history(f).state,history(f).developRecheckEffects),{calls:3,effects:4});
  const fail=execution(f,{developer:['four\n']});
  fail.check=()=>[{id:'syntax',command:['fixture'],outcome:'failed',exitCode:1,evidence:'synthetic a2 failed check'}];
  await session(f,'resume',fail,async host=>{
    assert.equal((await send(host,'start',2)).code,'develop_retry_limit');
    assert.equal(history(f).state.cache.at(-1).result.code,'develop_checks_not_passed');
    assert.equal((await send(host,'start',2)).code,'develop_retry_limit');
  });
  assert.deepEqual(developBudget(history(f).state,history(f).developRecheckEffects),{calls:4,effects:5});return f;
}
test('one controlled a2 continuation preserves paid history and reaches fresh r2 and completion',async t=>{
  const f=await limited(t),before=records(f),oldPackage=history(f).state.reviewPackage.packageDigest;
  await grant(f);
  await session(f,'resume',execution(f,{developer:['five\n'],verdicts:['approved']}),async host=>{
    const delivered=await send(host,'start',2);assert.equal(delivered.state,'awaiting_review',JSON.stringify(delivered));
    assert.notEqual(delivered.packageDigest,oldPackage);
    assert.equal((await send(host,'decision',2,{packageDigest:delivered.packageDigest})).state,'approved');
    assert.equal((await send(host,'complete',2,{packageDigest:delivered.packageDigest})).state,'fixture_completed');
  });
  assert.deepEqual(records(f).slice(0,before.length),before);
  const h=history(f);assert.deepEqual(developBudget(h.state,h.developRecheckEffects),{calls:6,effects:7});
  assert.equal(f.calls.developer,5);assert.equal(h.state.receipts.length,2);
  assert.equal(h.state.receipts[0].result.verdict,'changes_requested');assert.equal(h.state.receipts[1].result.verdict,'approved');
  assert.equal(h.state.attempt,2);assert.equal(records(f).findLast(row=>row.payload.type==='review-invocation-registered').payload.effectId,'review-2');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'five\n');
});

function reseal(rows){
  for(let index=0;index<rows.length;index++){
    const {digest:discard,...body}=rows[index];body.previousDigest=index?rows[index-1].digest:null;
    rows[index]={...body,digest:digest(body)};
  }return rows;
}
const launchTarget=f=>controlLaunchTarget(JSON.parse(fs.readFileSync(f.store,'utf8')));
async function grant(f,options={}){
  const run=await openControlRun(selected(f),'resume',execution(f,{}),{
    expectedControl:launchTarget(f),developmentReworkReason:'One fixed a2 development and fresh independent review',...options});
  run.close();
  const record=records(f).at(-1).payload;
  assert.equal(record.type,'development-rework-authorized');
  assert.ok(Number.isFinite(Date.parse(record.at)));assert.ok(record.reason);
}
const authorize=async host=>{
  const target=(await send(host,'status',2)).controlTarget;
  return send(host,'development_rework',2,{expectedControl:target,reason:'Wire cannot grant elevated recovery'});
};
test('controlled launch refuses stale, missing, wrong identity, evidence placeholders and changed specifications',async t=>{
  const f=await limited(t),before=records(f),target=launchTarget(f);
  for(const expectedControl of [null,{...target,revision:'0'.repeat(64)},
    {...target,identity:{...identity(2),runId:'another-run'}},{...target,identity:identity(1)}]){
    await assert.rejects(grant(f,{expectedControl}));assert.deepEqual(records(f),before);
  }
  for(const name of ['work-T-002-r2.md','work-T-002-a2-handoff.json']){
    const file=path.join(f.specsDir,'.reviews',name);fs.writeFileSync(file,'placeholder\n');
    await assert.rejects(grant(f),{code:'development_rework_evidence_exists'});
    fs.unlinkSync(file);assert.deepEqual(records(f),before);
  }
  fs.appendFileSync(path.join(f.specsDir,f.feature,'design.md'),'changed\n');
  await assert.rejects(grant(f));assert.deepEqual(records(f),before);
});
test('authorization, developer intent and result crash prefixes consume exactly one developer permission',async t=>{
  const f=await limited(t),before=records(f);
  await grant(f);
  const authorized=records(f),config=authorized[0].payload.config;
  assert.equal(history(f).developmentRework.developerConsumed,false);
  // Closing directly after the authorization must preserve the same identity.
  await session(f,'resume',execution(f,{developer:['five\n']}),async host=>{
    const status=await send(host,'status',2),again=await send(host,'development_rework',2,{expectedControl:status.controlTarget,reason:'Another reason'});
    assert.equal(again.outcome,'rejected');assert.deepEqual(records(f),authorized);
    assert.equal((await send(host,'start',2)).state,'awaiting_review');
  });
  const delivered=records(f),intentIndex=delivered.findLastIndex(row=>row.payload.type==='effect-intent');
  const prefix=delivered.slice(0,intentIndex+1),pending=readRunnerHistory(prefix,config,3);
  assert.equal(pending.developmentRework.developerConsumed,true);assert.equal(pending.pending.kind,'develop');
  assert.equal(history(f).developmentRework.developerConsumed,true);
  for(const snapshot of [prefix,delivered]){
    const body={version:1,seq:snapshot.length+1,id:`runner.${String(snapshot.length+1).padStart(6,'0')}`,kind:'intent',
      previousDigest:snapshot.at(-1).digest,payload:{version:3,protocol:'cm-task-runner',type:'effect-intent',
        effect:{...delivered[intentIndex].payload.effect,id:'develop-2-retry-99'}}};
    assert.throws(()=>readRunnerHistory([...snapshot,{...body,digest:digest(body)}],config,3),'a second developer cannot reuse the credit');
  }
  await session(f,'resume',execution(f,{verdicts:['approved']}),async host=>{
    const status=await send(host,'status',2);assert.equal((await send(host,'decision',2,{packageDigest:status.packageDigest})).state,'approved');
    assert.equal((await send(host,'complete',2,{packageDigest:status.packageDigest})).state,'fixture_completed');
  });
  assert.deepEqual(records(f).slice(0,before.length),before);assert.equal(f.calls.developer,5);
  const finished=records(f),grantIndex=finished.findIndex(row=>row.payload.type==='development-rework-authorized');
  for(const [name,mutate] of [
    ['effect credit',rows=>rows[grantIndex].payload.effectCredit=2],
    ['failed checkpoint',rows=>rows[grantIndex].payload.failedCheckpointDigest='0'.repeat(64)],
    ['old limit',rows=>rows[grantIndex].payload.limitDigest='0'.repeat(64)],
    ['delivery source',rows=>rows[grantIndex].payload.deliveryDigest='0'.repeat(64)],
    ['scope',rows=>rows[grantIndex].payload.scopeDigest='0'.repeat(64)],
    ['original baseline',rows=>rows[grantIndex].payload.baselineDigest='0'.repeat(64)],
    ['old receipt',rows=>rows[grantIndex].payload.receiptDigest='0'.repeat(64)],
    ['config',rows=>rows[grantIndex].payload.configDigest='0'.repeat(64)],
    ['developer id',rows=>rows[grantIndex].payload.developerEffectId='develop-2-retry-99'],
    ['fresh review id',rows=>rows[grantIndex].payload.reviewEffectId='review-1'],
    ['previous prefix',rows=>rows[grantIndex].payload.fromDigest='0'.repeat(64)],
    ['self-reported checkpoint grant',rows=>rows.at(-1).payload.checkpoint.developmentRework={effectCredit:1}],
    ['copy run',rows=>rows[grantIndex].payload.identity={...identity(2),runId:'another-run'}],
    ['duplicate event',rows=>rows.splice(grantIndex+1,0,structuredClone(rows[grantIndex]))],
    ['move before limit',rows=>{const grant=rows.splice(grantIndex,1)[0];rows.splice(grantIndex-1,0,grant);}],
    ['remove grant',rows=>rows.splice(grantIndex,1)],
  ]){
    const rows=structuredClone(finished);mutate(rows);rows.forEach((row,index)=>{row.seq=index+1;row.id=`runner.${String(index+1).padStart(6,'0')}`;});
    assert.throws(()=>readRunnerHistory(reseal(rows),config,3),name);
  }
  const authorization=authorized.at(-1).payload,h=readRunnerHistory(before,config,3);
  for(const patch of [{attempt:1},{attempt:3},{receipt:h.state.receipts[0]},{receipts:[]},{currentChecks:[]},{learningResult:null},
    {cancellationRequested:true},{cancelAfterCommit:true},{workflowError:'workflow_error'},{taskCommit:{}},{priorReview:{verdict:'approved'}}])
    assert.throws(()=>applyDevelopmentRework(before,{...h.state,...patch},config,h.original,authorization,h.developRecheckEffects));
  for(const patch of [{controlPolicy:{...policy,development:'provider'}},{bootstrap:{}},{executionPolicy:{}},{externalModels:{}},
    {developer:{...config.developer,requestedModel:'provider-model'}}])
    assert.throws(()=>applyDevelopmentRework(before,h.state,{...config,...patch},h.original,grant,h.developRecheckEffects));
  assert.equal(effectSlotFree('review',h.state.cache,h.state.calls,h.developRecheckEffects),true);
  assert.equal(developBudgetExhausted({...h.state,state:'blocked',code:'develop_checks_not_passed'},h.developRecheckEffects),true);
  assert.equal(MAX_RUNNER_EFFECTS,6);
  const end=history(f);assert.equal(effectSlotFree('review',end.state.cache,end.state.calls,end.developRecheckEffects),false);
  const tooManyCalls=structuredClone(finished),checkpoint=tooManyCalls.at(-1).payload.checkpoint;
  checkpoint.calls.push(structuredClone(checkpoint.calls.at(-1)));checkpoint.sequence++;
  assert.throws(()=>readRunnerHistory(reseal(tooManyCalls),config,3),{code:'runner_calls'},'the credit never raises the six-call cap');
});
test('after approval source drift blocks dispatch; a failed granted developer never gets another permission',async t=>{
  const f=await limited(t);
  await grant(f);
  fs.appendFileSync(path.join(f.codeProject,'a.mjs'),'drift\n');
  const before=records(f);
  await session(f,'resume',execution(f,{developer:['five\n']}),async host=>{
    const result=await send(host,'start',2);assert.equal(result.code,'development_rework_source_changed');
  });
  assert.deepEqual(records(f),before);assert.equal(f.calls.developer,4);
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'four\n');
  const failed=execution(f,{developer:['five\n']});failed.check=()=>[{id:'syntax',command:['fixture'],outcome:'failed',exitCode:1,evidence:'real failed granted check'}];
  await session(f,'resume',failed,async host=>assert.equal((await send(host,'start',2)).code,'develop_retry_limit'));
  const spent=records(f);
  await session(f,'resume',execution(f,{developer:['six\n']}),async host=>{
    assert.equal((await authorize(host)).outcome,'rejected');assert.equal((await send(host,'start',2)).code,'develop_retry_limit');
  });
  assert.deepEqual(records(f),spent);assert.equal(f.calls.developer,5);
});
test('a real host process dying after the authorized intent cannot dispatch a second developer',async t=>{
  const f=await limited(t);
  await grant(f);
  const before=records(f);
  const code=`import {openControlRun,controlLaunchTarget} from ${JSON.stringify(new URL('./cm-ai-run.mjs',import.meta.url).href)};
import {gapExecution,definition,identity} from ${JSON.stringify(new URL('./cm-ai-answer-gap-fixture.mjs',import.meta.url).href)};
const f=${JSON.stringify(f)};const execution=gapExecution(f,{});execution.configuration.controlPolicy=${JSON.stringify(policy)};
execution.developer.run=()=>process.exit(17);
const selected={...definition(f),taskSelection:{version:1,taskId:identity(1).taskId},featureSelection:{version:1,feature:f.feature}};
const run=await openControlRun(selected,'resume',execution);
await run.controlHost.handle({version:2,operation:'start',requestId:'crash-after-intent',identity:identity(2)});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,17,child.stderr);
  const crashed=records(f),h=history(f);assert.equal(h.pending.kind,'develop');assert.equal(h.developmentRework.developerConsumed,true);
  assert.deepEqual(crashed.slice(0,before.length),before);
  await session(f,'resume',execution(f,{developer:['unauthorized\n']}),async host=>{
    await send(host,'start',2);assert.equal(f.calls.developer,4);
    const status=await send(host,'status',2);
    await send(host,'abandon_effect',2,{expectedControl:status.controlTarget,reason:'The synthetic host process has exited'});
    await send(host,'start',2);assert.equal(f.calls.developer,4);
    assert.equal((await authorize(host)).outcome,'rejected');
  });
  assert.deepEqual(records(f).slice(0,crashed.length),crashed);
});
test('real admission and driver CLI require launch recovery and retain an ineligible state',t=>{
  const f=gapFixture(t,'rework-driver'),root=f.root,answers=path.join(root,'answers'),bin=path.join(root,'bin');
  fs.mkdirSync(answers);fs.mkdirSync(bin);
  const admission=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url)),
    '--specs-dir',f.specsDir,'--code-project',f.codeProject,'--print-run-definition','--feature',f.feature,
    '--task',identity(1).taskId,'--scope','a.mjs','--requirements','requirements.md',
    '--run-id',identity(1).runId,'--repository-id',identity(1).repositoryId],{encoding:'utf8'});
  assert.equal(admission.status,0,admission.stderr);
  const run=JSON.parse(admission.stdout);assert.deepEqual(run.taskSelection,{version:1,taskId:identity(1).taskId});
  assert.deepEqual(run.featureSelection,{version:1,feature:f.feature});
  fs.writeFileSync(path.join(root,'run.json'),admission.stdout);fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(policy));
  fs.writeFileSync(path.join(root,'workflow.json'),JSON.stringify({qa:{commands:[{id:'local',caseIds:[],command:[process.execPath,'-e','0']}],environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(bin,'codex'),fs.readFileSync(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),{mode:0o700});
  fs.writeFileSync(path.join(answers,'new.txt'),'new\n');
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:learning,edits:{'a.mjs':'new.txt'}}));
  const drive=(operation,extra={})=>{
    const plan={config:'run.json',controlConfig:'control.json',mode:'resume',hostContext:'rework-driver-host',
      permissions:['--review-config','review.json','--workflow-config','workflow.json'],answers:'answers',checks:[{id:'synthetic',command:[process.execPath,'-e','process.exit(1)']}],...extra};
    fs.writeFileSync(path.join(root,'plan.json'),JSON.stringify(plan));
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url)),'--plan',path.join(root,'plan.json'),operation],
      {encoding:'utf8',timeout:30000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
    return child;
  };
  const success=(operation,extra={})=>{const child=drive(operation,extra);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout).result;};
  assert.equal(success('start',{mode:'create'}).code,'develop_checks_not_passed');
  const before=records(f),target=success('status').launchControlTarget;
  const wire=drive('development_rework',{expectedControl:target,reason:'An explicit fixed recovery request'});
  assert.equal(wire.status,2);assert.match(wire.stderr,/启动型恢复/);
  // A plan without controlConfig (legacy) is refused by the driver too, before any host starts.
  const legacyWire=drive('development_rework',{controlConfig:undefined,expectedControl:undefined,reason:'Legacy plans cannot ask for it either'});
  assert.equal(legacyWire.status,2);assert.match(legacyWire.stderr,/development_rework 只用于原 v2 单任务运行/);
  assert.deepEqual(records(f),before,'a refused legacy plan starts no host and writes nothing');
  const permissions=['--review-config','review.json','--workflow-config','workflow.json','--development-rework',
    '--development-rework-reason','One explicit continuation','--expected-control','launch.json'];
  for(const [preview,code] of [[target,'development_rework_unavailable'],[{...target,revision:'0'.repeat(64)},'snapshot_changed']]){
    fs.writeFileSync(path.join(root,'launch.json'),JSON.stringify(preview));
    const result=drive('status',{permissions});assert.equal(result.status,71,result.stderr);assert.match(result.stderr,new RegExp(code));
  }
  assert.deepEqual(records(f),before,'CLI parsing and targets do not make an ineligible state eligible');
});
test('a true in-flight cancel consumes the grant and remains cancelled on replay and resume',async t=>{
  const f=await limited(t),exec=execution(f,{developer:['five\n']});let reached;
  const checking=new Promise(resolve=>reached=resolve);
  exec.check=(_request,control)=>new Promise((_,reject)=>{
    control.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'})),{once:true});reached();
  });
  await grant(f);
  await session(f,'resume',exec,async host=>{
    const pending=send(host,'start',2);await checking;
    await send(host,'cancel',2);await pending;
  });
  const before=records(f),h=history(f);assert.equal(h.state.state,'cancelled');
  const idle={...h.state,state:'blocked',code:'develop_checks_not_passed',cancellationRequested:false};
  assert.deepEqual(controlledState(idle,'cancel',false,3),idle,'idle block remains outside cancel admission');
  assert.deepEqual(controlledState(idle,'cancel',true,3),idle,'an unproven pending writer gets no new replay exception');assert.equal(h.developmentRework.developerConsumed,true);
  assert.ok(before.some(row=>row.payload.type==='control'&&row.payload.event==='cancel'));
  await session(f,'resume',execution(f,{developer:['never\n']}),async host=>{
    assert.equal((await authorize(host)).outcome,'rejected');await send(host,'start',2);
  });
  assert.deepEqual(records(f),before);assert.equal(f.calls.developer,5);
});
test('a legitimate pre-QA configuration revision and scope append preserve a2 rework eligibility',async t=>{
  const f=await limited(t,{qaRevision:true}),before=records(f),h=history(f);
  const row=before.find(row=>row.payload.type==='qa-config-revised');assert.ok(row);
  assert.equal(row.payload.record.qaRound,0);assert.equal(row.payload.record.testRunId,null);
  assert.ok(before.some(row=>row.payload.type==='scope-revised'));assert.equal(h.scopeRevisions,1);
  const baseline=structuredClone(h.original),config=before[0].payload.config,effective={...config,scope:h.effectiveScope};
  for(const type of ['qa-attached','qa-fix-accepted','qa-execution-started','qa-result','qa-injected']){
    const altered=structuredClone(before);altered.find(row=>row.payload.type==='qa-config-revised').payload.type=type;
    assert.throws(()=>developmentReworkBinding(altered,h.state,effective,h.original,h.developRecheckEffects),{code:'development_rework_unavailable'},type+' cannot grant a continuation');
    assert.throws(()=>readRunnerHistory(reseal(altered),config,3),type+' is not an accepted configuration revision');
  }
  for(const patch of [{qaRound:1,testRunId:'qa-run',packageDigest:h.state.reviewPackage.packageDigest},
    {testRunId:'qa-run'},{qaRound:undefined},{reason:'invalid\nreason'}]){
    const altered=structuredClone(before),revision=altered.find(row=>row.payload.type==='qa-config-revised').payload.record;
    Object.assign(revision,patch);
    assert.throws(()=>developmentReworkBinding(altered,h.state,effective,h.original,h.developRecheckEffects));
    assert.throws(()=>readRunnerHistory(reseal(altered),config,3));
  }
  await grant(f);
  await session(f,'resume',execution(f,{developer:['five\n'],verdicts:['approved']}),async host=>{
    const delivered=await send(host,'start',2);assert.equal(delivered.state,'awaiting_review');
    assert.equal((await send(host,'decision',2,{packageDigest:delivered.packageDigest})).state,'approved');
    assert.equal((await send(host,'complete',2,{packageDigest:delivered.packageDigest})).state,'fixture_completed');
  });
  assert.deepEqual(records(f).slice(0,before.length),before);assert.deepEqual(history(f).original,baseline);
  assert.deepEqual(developBudget(history(f).state,history(f).developRecheckEffects),{calls:6,effects:7});
});
test('grant source includes file modes and a chmod-only drift refuses dispatch after resume',async t=>{
  const f=await limited(t),file=path.join(f.codeProject,'a.mjs');fs.chmodSync(file,0o644);
  const bytes=fs.readFileSync(file),original=history(f).original;
  await grant(f);
  const before=records(f),source=before.at(-1).payload.sourceDigest;
  const snapshot=captureReviewInventory(f.codeProject,original,{withMode:true});
  assert.equal(source,digest(snapshot));
  fs.chmodSync(file,0o744);assert.ok(fs.readFileSync(file).equals(bytes));
  await session(f,'resume',execution(f,{developer:['never dispatched\n']}),async host=>assert.equal((await send(host,'start',2)).code,'development_rework_source_changed'));
  assert.deepEqual(records(f),before);assert.equal(f.calls.developer,4);
  assert.deepEqual(snapshot.find(row=>row.path==='a.mjs'),{path:'a.mjs',type:'file',mode:0o644,sha256:digestBytes(bytes)});
  assert.deepEqual(captureReviewInventory(f.codeProject,original).find(row=>row.path==='a.mjs'),{path:'a.mjs',sha256:digestBytes(bytes)},'ordinary inventory remains content-only');
  fs.chmodSync(file,0o644);
  await session(f,'resume',execution(f,{developer:['never dispatched\n']}),async host=>{
    fs.chmodSync(file,0o744);
    assert.equal((await send(host,'start',2)).code,'development_rework_source_changed','live host also rejects mode drift');
    fs.chmodSync(file,0o644);fs.appendFileSync(file,'content-only drift\n');
    assert.equal((await send(host,'start',2)).code,'development_rework_source_changed');
    fs.writeFileSync(file,bytes);
    const saved=path.join(f.root,'saved-source');fs.renameSync(file,saved);fs.mkdirSync(file);
    assert.equal((await send(host,'start',2)).code,'development_rework_source_changed','a file becoming a directory changes the snapshot');
    fs.rmdirSync(file);fs.renameSync(saved,file);
    fs.renameSync(file,saved);fs.symlinkSync(saved,file);
    assert.equal((await send(host,'start',2)).outcome,'rejected','unsupported symlink remains fail-closed');
    fs.unlinkSync(file);fs.renameSync(saved,file);
  });
  assert.deepEqual(records(f),before);assert.equal(f.calls.developer,4);
  assert.equal(history(f).developmentRework.sourceDigest,source,'pure replay retains the exact new source binding');
  assert.equal(digest(captureReviewInventory(f.codeProject,original,{withMode:true})),source,'restored path/type/mode/content has the same binding');
});
const digestBytes=bytes=>createHash('sha256').update(bytes).digest('hex');

// Cross-review regressions: these must fail against the original landing diff.
test('ordinary resume cannot self-authorize either elevated recovery on the wire',async t=>{
  const f=await limited(t),before=records(f);
  await session(f,'resume',execution(f,{}),async host=>{
    const status=await send(host,'status',2);
    assert.equal((await send(host,'development_rework',2,{expectedControl:status.controlTarget,reason:'Session self approval'})).code,
      'development_rework_authorization_required');
    assert.deepEqual(records(f),before);
  });
  const g=gapFixture(t,'scope-wire');
  const exec=execution(g,{developer:['one\n']});exec.check=()=>[{id:'syntax',command:['fixture'],outcome:'failed',exitCode:1,evidence:'failure'}];
  await session(g,'create',exec,async host=>assert.equal((await send(host,'start')).code,'develop_checks_not_passed'));
  await session(g,'resume',execution(g,{}),async host=>{
    const target=(await send(host,'status')).controlTarget,before=records(g);
    assert.equal((await send(host,'revise_scope',1,{expectedControl:target,reason:'Session self approval',scope:['a.mjs','new.mjs']})).code,
      'scope_revision_authorization_required');
    assert.deepEqual(records(g),before);
  });
});
test('consumed rework allows check-only intents but never another developer',()=>{
  const grant={developerConsumed:true,reviewConsumed:false,developerEffectId:'develop-2-retry-3',reviewEffectId:'review-2'};
  assert.equal(effectSlotFree('develop',[],[],[],grant,'develop-2-retry-4',{state:'blocked',code:'check_answer_missing'}),true);
  assert.equal(effectSlotFree('develop',[],[],[],grant,'develop-2-retry-4',{state:'blocked',code:'develop_checks_not_passed'}),false);
});
test('granted developer check timeout can recheck successfully and reach fresh review without a new developer',async t=>{
  const f=await limited(t,{cancelledRecheck:false});
  await grant(f);
  await session(f,'resume',execution(f,{developer:['five\n'],checks:['hang']}),async host=>{
    assert.equal((await send(host,'start',2)).code,'check_answer_missing');
  });
  await session(f,'resume',execution(f,{checks:['ok'],verdicts:['approved']}),async host=>{
    const result=await send(host,'start',2);assert.equal(result.state,'awaiting_review',JSON.stringify(result));
    const h=history(f);
    for(const id of ['review-2','review-2-retry-1','review-2-resume-1','review-2-retry-1-resume-1'])
      assert.equal(effectSlotFree('review',h.state.cache,h.state.calls,h.developRecheckEffects,h.developmentRework,id,h.state),true,id);
    for(const id of ['review-1-retry-1','review-3','review-2-retry-0','review-2-retry-1-extra'])
      assert.equal(effectSlotFree('review',h.state.cache,h.state.calls,h.developRecheckEffects,h.developmentRework,id,h.state),false,id);
    assert.equal((await send(host,'decision',2,{packageDigest:result.packageDigest})).state,'approved');
    assert.equal((await send(host,'complete',2,{packageDigest:result.packageDigest})).state,'fixture_completed');
  });
  assert.equal(f.calls.developer,5);assert.deepEqual(developBudget(history(f).state,history(f).developRecheckEffects),{calls:5,effects:7});
});

test('granted a2 review transport retry keeps fresh bindings and the original redispatch bound',async t=>{
  const f=await limited(t,{cancelledRecheck:false});await grant(f);
  const exec=execution(f,{developer:['five\n'],verdicts:['approved']});
  const review=exec.reviewers[0].run;let dispatches=0;
  exec.reviewers[0].run=(request,control)=>{
    if(++dispatches!==1)return review(request,control);
    control.onEvent({event:'thread.started',provider_thread:`timeout-${request.invocationId}`});
    control.onEvent({event:'turn.started',item_type:null});
    control.onEvent({event:'process_closed',exit_code:143,signal:null,timed_out:true});
    return {status:'failed',code:'timeout'};
  };
  await session(f,'resume',exec,async host=>{
    const delivered=await send(host,'start',2);assert.equal(delivered.state,'awaiting_review');
    const retry=await send(host,'decision',2,{packageDigest:delivered.packageDigest});
    assert.equal(retry.state,'pending_review',JSON.stringify(retry));
    const approved=await send(host,'decision',2,{packageDigest:delivered.packageDigest});
    assert.equal(approved.state,'approved',JSON.stringify(approved));
    assert.equal((await send(host,'complete',2,{packageDigest:delivered.packageDigest})).state,'fixture_completed');
  });
  const h=history(f);assert.equal(dispatches,2);assert.equal(f.calls.developer,5);
  assert.deepEqual(h.state.cache.filter(x=>x.effect.kind==='review'&&x.effect.identity.attempt===2).map(x=>x.effect.id),
    ['review-2','review-2-retry-1']);
  assert.equal(h.state.receipts.length,2);assert.equal(h.state.receipts.at(-1).result.verdict,'approved');
});
