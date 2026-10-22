import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {gapFixture,gapExecution,definition,identity,records} from './cm-ai-answer-gap-fixture.mjs';
import {readRunnerHistory,projectedRunnerStatus,developRecheckCancellationBinding,controlledState,developBudget,completedEffectCount,effectSlotFree} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const cancelled=()=>Object.assign(new Error('cancelled'),{code:'cancelled'});
async function sameHost(f,execution,operations,mode='create'){
  const run=await openControlRun(definition(f),mode,execution);
  try{
    const result=[];
    for(const operation of operations)result.push(await (run.controlHost??run.host).handle({version:run.controlHost?2:1,
      operation,identity:identity(1),requestId:`check-${result.length}`}));
    return result;
  }finally{run.close();}
}
function signalChecks(f,options,legacy=false){
  const execution=gapExecution(f,options),check=execution.check;
  const signals=[];
  execution.check=(request,control)=>{
    if(control.signal.aborted||legacy&&signals[0]?.aborted)throw cancelled();
    signals.push(control.signal);return check(request,control);
  };
  return {execution,signals};
}
test('same live host rechecks a timed-out check with a fresh signal and no new developer',async t=>{
  const f=gapFixture(t,'same-host-check'),{execution,signals}=signalChecks(f,{developer:['delivered\n'],checks:['hang','ok']});
  const [missing,rechecked]=await sameHost(f,execution,['start','start']);
  assert.equal(missing.code,'check_answer_missing');
  assert.equal(rechecked.state,'awaiting_review',JSON.stringify(rechecked));
  assert.equal(f.calls.developer,1);assert.equal(f.calls.check,2);
  assert.notEqual(signals[0],signals[1]);assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
});
test('a real legacy check-cancelled recheck resumes only checks and preserves every old record',async t=>{
  const f=gapFixture(t,'legacy-check-cancelled'),{execution}=signalChecks(f,{developer:['delivered\n'],checks:['hang']},true);
  await sameHost(f,execution,['start','start']);
  const before=records(f),config=before[0].payload.config,history=readRunnerHistory(before,config,3);
  assert.deepEqual([history.state.state,history.state.code],['unknown','cancelled']);
  assert.equal(history.answerGaps.developRecheck,1);
  assert.equal(developBudget(history.state,history.developRecheckEffects).effects,0,'the proven failed recheck holds no effect slot');
  const projected=projectedRunnerStatus(history,config);
  assert.deepEqual([projected.state,projected.code],['blocked','check_answer_missing']);
  const [rechecked]=await sameHost(f,gapExecution(f,{checks:['ok']}),['start'],'resume');
  assert.equal(rechecked.state,'awaiting_review',JSON.stringify(rechecked));
  assert.equal(f.calls.developer,1);assert.deepEqual(records(f).slice(0,before.length),before);
  const after=readRunnerHistory(records(f),config,3);
  assert.equal(after.answerGaps.developRecheck,2);assert.equal(after.state.attempt,1);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'delivered\n');
  assert.equal(after.state.calls.length,1);assert.equal(after.state.receipts.length,0);
  assert.ok(history.developRecheckRecovery);
  for(const patch of [{state:'cancelled'},{cancellationRequested:true},{cancelAfterCommit:true},{workflowError:'workflow_error'},
    {reviewPackage:{}},{receipt:{}},{receipts:[{}]},{priorReview:{}},{reviewInvocation:{}},{taskCommit:{}},{learningResult:null},
    {attempt:2},{calls:[]}])assert.equal(developRecheckCancellationBinding(before,{...history.state,...patch},config),null);
  for(const patch of [{developer:{...config.developer,requestedModel:'provider-model'}},
    {controlPolicy:{version:2,development:'provider'}},{externalModels:{}},{executionPolicy:{}}])
    assert.equal(developRecheckCancellationBinding(before,history.state,{...config,...patch}),null);
  const noRecheck=before.filter(row=>row.payload.type!=='develop-recheck');
  assert.equal(developRecheckCancellationBinding(noRecheck,history.state,config),null);
  for(const mutate of [rows=>rows.find(row=>row.payload.type==='develop-recheck').payload.effectId='stale-effect',
    rows=>rows.find(row=>row.payload.type==='develop-recheck').payload.invocationId='stale-call',
    rows=>rows.at(-1).payload.checkpoint.learningResult=null,
    rows=>rows.at(-1).payload.checkpoint.calls.at(-1).resultDigest='0'.repeat(64)]){
    const rows=structuredClone(before);mutate(rows);
    for(let index=0;index<rows.length;index++){
      const {digest:discard,...body}=rows[index];body.previousDigest=index?rows[index-1].digest:null;
      rows[index]={...body,digest:digest(body)};
    }
    assert.throws(()=>readRunnerHistory(rows,config,3),'stale source or changed delivery identity cannot be recovered');
  }
  for(const event of ['cancel','late-cancel']){
    const rows=structuredClone(before),body={version:1,seq:rows.length+1,id:`runner.${String(rows.length+1).padStart(6,'0')}`,
      kind:'cancel',previousDigest:rows.at(-1).digest,payload:{version:3,protocol:'cm-task-runner',type:'control',event}};
    rows.push({...body,digest:digest(body)});
    assert.equal(developRecheckCancellationBinding(rows,history.state,config),null,'a cancel row cannot grant recovery');
    assert.throws(()=>readRunnerHistory(rows,config,3),{code:'runner_control'},'an idle cancel that changes no state is not a valid journal record');
  }
  for(const end of before.map((_,index)=>index+1).slice(0,-1)){
    const prefix=readRunnerHistory(before.slice(0,end),config,3);
    assert.equal(prefix.developRecheckRecovery,null,'no recovery proof before the final checkpoint');
  }
});
test('a fresh check signal still obeys a real in-flight user cancellation',async t=>{
  const f=gapFixture(t,'true-cancel'),{execution}=signalChecks(f,{developer:['delivered\n'],checks:['hang']});
  const check=execution.check;let entered,checking;
  const reached=new Promise(resolve=>entered=resolve);
  execution.check=(request,control)=>f.calls.check===1?new Promise((_,reject)=>{
    checking=control.signal;control.signal.addEventListener('abort',()=>reject(cancelled()),{once:true});entered();
  }):check(request,control);
  const run=await openControlRun(definition(f),'create',execution);
  try{
    assert.equal((await run.host.handle({version:1,operation:'start',requestId:'first',identity:identity(1)})).code,'check_answer_missing');
    const pending=run.host.handle({version:1,operation:'start',requestId:'recheck',identity:identity(1)});
    await reached;
    await run.host.handle({version:1,operation:'cancel',requestId:'cancel',identity:identity(1)});await pending;
    assert.equal(checking.aborted,true);
    const rows=records(f),history=readRunnerHistory(rows,rows[0].payload.config,3);
    assert.ok(rows.some(row=>row.payload.type==='control'&&row.payload.event==='cancel'));
    assert.equal(history.state.state,'cancelled');assert.equal(history.state.cancellationRequested,true);
    assert.equal(history.developRecheckRecovery,null);assert.equal(f.calls.developer,1);
  }finally{run.close();}
});
test('a cancelled recheck retains the original two-recheck budget',async t=>{
  const f=gapFixture(t,'cancelled-budget'),{execution}=signalChecks(f,{developer:['delivered\n'],checks:['hang']},true);
  await sameHost(f,execution,['start','start']);
  const [spent]=await sameHost(f,gapExecution(f,{checks:['hang']}),['start'],'resume');
  assert.equal(spent.code,'check_answer_retry_limit',JSON.stringify(spent));
  const rows=records(f),config=rows[0].payload.config,history=readRunnerHistory(rows,config,3);
  assert.equal(history.answerGaps.developRecheck,2);assert.equal(projectedRunnerStatus(history,config).code,'check_answer_retry_limit');
  const before=records(f);await sameHost(f,gapExecution(f,{checks:['ok']}),['start'],'resume');
  assert.deepEqual(records(f),before);assert.equal(f.calls.developer,1);
});
test('near the six-effect cap a recovered check reaches approved Review and completion without a new developer',async t=>{
  const f=gapFixture(t,'recheck-effect-cap'),execution=gapExecution(f,{developer:['one\n','two\n','three\n','four\n','five\n']});
  const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
  execution.configuration.controlPolicy=policy;
  let count=0,oldSignal;
  execution.check=(_request,control)=>{
    count++;
    if(count<=4)return [{id:'syntax',command:['fixture'],outcome:'failed',exitCode:1,evidence:'synthetic failed check'}];
    if(count===5){oldSignal=control.signal;return new Promise(()=>{});}
    assert.equal(oldSignal.aborted,true);throw cancelled();
  };
  const outcomes=await sameHost(f,execution,Array(6).fill('start'));
  assert.ok(outcomes.slice(0,4).every(result=>result.code==='develop_checks_not_passed'));
  assert.ok(outcomes.slice(4).every(result=>result.code==='check_answer_missing'));
  const before=records(f),config=before[0].payload.config;
  assert.equal(readRunnerHistory(before,config,3).state.code,'cancelled');assert.equal(f.calls.developer,5);
  const resumed=gapExecution(f,{checks:['ok','ok'],verdicts:['approved']});resumed.configuration.controlPolicy=policy;
  const [done]=await sameHost(f,resumed,['advance'],'resume');
  assert.equal(done.state,'fixture_completed',JSON.stringify(done));assert.equal(f.calls.developer,5);
  const rows=records(f),history=readRunnerHistory(rows,config,3);
  assert.equal(rows.findLast(row=>row.payload.type==='effect-checkpoint'&&row.payload.effectId==='review-1').payload.checkpoint.state,'approved');
  assert.deepEqual(rows.slice(0,before.length),before);assert.equal(history.answerGaps.developRecheck,2);
  assert.equal(history.state.receipts.length,1);assert.equal(history.state.attempt,1);
  assert.equal(completedEffectCount(history.state.cache,history.state.calls,history.developRecheckEffects),6);
  assert.equal(completedEffectCount(history.state.cache,history.state.calls),7,'the missing derived list reproduces the mismatch');
  assert.equal(effectSlotFree('develop',history.state.cache,history.state.calls,history.developRecheckEffects),false);
  assert.equal(effectSlotFree('review',history.state.cache,history.state.calls,history.developRecheckEffects),false);
  for(const key of ['developRecheckEffects','recheckEffects']){
    const altered=structuredClone(rows);altered.at(-1).payload.checkpoint[key]=history.state.cache.map(entry=>entry.effect.id);
    for(let index=0;index<altered.length;index++){
      const {digest:discard,...body}=altered[index];body.previousDigest=index?altered[index-1].digest:null;
      altered[index]={...body,digest:digest(body)};
    }
    assert.throws(()=>readRunnerHistory(altered,config,3),'a checkpoint cannot self-report budget exemptions');
  }
});
test('a completion check timeout also gets a fresh signal on its existing check-only recheck',async t=>{
  const f=gapFixture(t,'complete-signal'),{execution,signals}=signalChecks(f,{developer:['delivered\n'],checks:['ok','hang','ok'],verdicts:['approved']});
  const [missing,done]=await sameHost(f,execution,['advance','advance']);
  assert.equal(missing.code,'complete_recheck_failed');assert.equal(done.state,'fixture_completed',JSON.stringify(done));
  assert.equal(f.calls.developer,1);assert.notEqual(signals[1],signals[2]);
});
test('check-only cancellation excludes idle blocks and unrelated outstanding states',()=>{
  const original={state:'blocked',code:'check_answer_missing',cancellationRequested:false,cancelAfterCommit:false,workflowError:null};
  assert.deepEqual(controlledState(original,'cancel',false,3),original);
  for(const value of [{state:'blocked',code:'develop_checks_not_passed'},{state:'unknown',code:'cancelled'},
    {state:'cancelled',code:'cancelled'},{state:'fixture_completed',code:null}]){
    const state={...original,...value};assert.deepEqual(controlledState(state,'cancel',true,3),state);
  }
  for(const code of ['check_answer_missing','check_answer_invalid','develop_out_of_scope','complete_recheck_failed']){
    const state=controlledState({...original,code},'cancel',true,3);
    assert.equal(state.state,'cancelled');assert.equal(state.cancellationRequested,true);
  }
});
test('an arbitrary first-check cancelled answer has no recovery proof',async t=>{
  const f=gapFixture(t,'first-cancelled'),execution=gapExecution(f,{developer:['delivered\n']});
  execution.check=()=>{throw cancelled();};await sameHost(f,execution,['start']);
  const rows=records(f),config=rows[0].payload.config,history=readRunnerHistory(rows,config,3);
  assert.equal(history.state.code,'cancelled');assert.equal(history.developRecheckRecovery,null);
  assert.equal(projectedRunnerStatus(history,config).state,'unknown');assert.equal(history.answerGaps.developRecheck,0);
});
test('recovered checks retain specification and out-of-scope source gates',async t=>{
  for(const changed of ['specification','outside-scope']){
    const f=gapFixture(t,'changed-'+changed),{execution}=signalChecks(f,{developer:['delivered\n'],checks:['hang']},true);
    await sameHost(f,execution,['start','start']);const before=records(f);
    const target=changed==='specification'?path.join(f.specsDir,f.feature,'design.md'):path.join(f.codeProject,'foreign.mjs');
    fs.writeFileSync(target,'changed source\n');
    const [result]=await sameHost(f,gapExecution(f,{checks:['ok']}),['start'],'resume');
    assert.notEqual(result.state,'awaiting_review');assert.equal(f.calls.developer,1);
    const rows=records(f),history=readRunnerHistory(rows,rows[0].payload.config,3);
    assert.deepEqual(rows.slice(0,before.length),before);assert.equal(history.state.reviewPackage,null);
    assert.equal(changed==='specification'?result.code:rows.at(-1).payload.checkpoint.code,changed==='specification'?'spec_drift':'out_of_scope');
  }
});
test('real v2 CLI with admission task and feature selection emits a second check request in the same host',async t=>{
  const f=gapFixture(t,'cli-check-signal');
  const admission=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
  const printed=spawnSync(process.execPath,[admission,'--specs-dir',f.specsDir,'--code-project',f.codeProject,
    '--print-run-definition','--task','T-002','--feature',f.feature,'--scope','a.mjs','--requirements','requirements.md',
    '--repository-id','answer-gap','--run-id','answer-gap-run'],{encoding:'utf8'});
  assert.equal(printed.status,0,printed.stderr);const selected=JSON.parse(printed.stdout);
  assert.deepEqual(selected.taskSelection,{version:1,taskId:'T-002'});assert.deepEqual(selected.featureSelection,{version:1,feature:f.feature});
  const config=path.join(f.root,'run.json'),control=path.join(f.root,'control.json'),review=path.join(f.root,'review.json');
  fs.writeFileSync(config,printed.stdout);const original=fs.readFileSync(config);
  fs.writeFileSync(control,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'}));
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  // Run the actual product CLI and transport. Accelerate only its existing
  // 30-minute outer timer inside this disposable fixture process; no product flag.
  const host=new URL('./cm-ai-host.mjs',import.meta.url).href;
  const shim=`const timer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===1800000?1500:ms,...args);const {main}=await import(${JSON.stringify(host)});process.exitCode=await main(process.argv.slice(2));`;
  const child=spawn(process.execPath,['--input-type=module','-e',shim,fileURLToPath(import.meta.url),'serve','--config',config,'--mode','create',
    '--host-context','check-recheck-fixture','--control-config',control,'--runtime','codex','--review-config',review],
    {cwd:f.codeProject,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')},stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='',sessionId,checkRequests=0,developRequests=0;const replies=[];
  const send=row=>child.stdin.write(JSON.stringify(row)+'\n');
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('fixture CLI deadline: '+stderr));},30000);
    child.stderr.on('data',part=>stderr+=part);
    child.stdout.on('data',part=>{
      buffer+=part;let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const row=JSON.parse(buffer.slice(0,newline));buffer=buffer.slice(newline+1);
        if(row.type==='host_ready'){sessionId=row.sessionId;send({version:2,operation:'start',requestId:'first',identity:identity(1)});}
        if(row.type==='host_request'){
          let result;
          if(row.kind==='develop'){
            developRequests++;fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'delivered\n');
            result={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
              retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
          }else if(row.kind==='check'){
            checkRequests++;if(checkRequests===1)continue;
            result=[{id:'syntax',command:['fixture'],outcome:'passed',exitCode:0,evidence:'synthetic check'}];
          }else if(row.kind==='verification_precheck')result={satisfied:true,evidence:'synthetic verification'};
          else {clearTimeout(timer);child.kill('SIGKILL');reject(new Error('unexpected fixture request '+row.kind));return;}
          send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
        }
        if(row.requestId==='first'){replies.push(row.result);send({version:2,operation:'start',requestId:'second',identity:identity(1)});}
        if(row.requestId==='second'){replies.push(row.result);send({type:'host_close',sessionId});child.stdin.end();}
      }
    });
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('fixture CLI exit '+code+': '+stderr));});
  });
  assert.equal(replies[0].code,'check_answer_missing');assert.equal(replies[1].state,'awaiting_review',JSON.stringify(replies));
  assert.equal(checkRequests,2);assert.equal(developRequests,1);assert.ok(fs.readFileSync(config).equals(original));
  const rows=records(f),history=readRunnerHistory(rows,rows[0].payload.config,3);
  assert.equal(history.answerGaps.developRecheck,1);assert.equal(history.state.calls.length,1);assert.equal(history.state.attempt,1);
});
