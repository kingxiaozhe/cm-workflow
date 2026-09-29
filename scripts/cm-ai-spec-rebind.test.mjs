// #12 a spec change re-approved mid-task: status tells the truth, a change that
// leaves this task's material untouched is explicitly rebound, anything else
// fails closed naming what changed and keeps a working recovery chain.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {approveCmAiSpecs,inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {writeSpecsStatus,readSpecsStatus} from '../runtime/js/specs-status.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-spec-rebind-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-spec-rebind-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  const file=name=>path.join(specsDir,feature,name);
  fs.writeFileSync(file('requirements.md'),'# Requirements\n- [ ] [AC-001] a exports new\n');
  fs.writeFileSync(file('design.md'),'# Design\nsimple\n');
  fs.writeFileSync(file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b\n\n- T-002 依赖 T-001\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const identity=(runId='rebind-run-0001')=>({repositoryId:'rebind-fixture',runId,taskId:'T-001',attempt:1});
  const definition=(runId)=>({version:1,specsDir,codeProject,feature,identity:identity(runId),scope:['a.mjs'],requirements:['requirements.md']});
  return {root,codeProject,specsDir,feature,file,identity,definition};
}
// The cm-prd --change publication (awaiting_review) followed by the real CLI approve gate.
function reapprove(f){
  const prior=readSpecsStatus(f.specsDir).value,specFiles=buildManifest(f.specsDir);
  writeSpecsStatus(f.specsDir,{status:'awaiting_review',summaryDigest:'a'.repeat(64),at:new Date().toISOString(),
    features:prior.features,specFiles,testCases:[],approval:null});
  const approved=approveCmAiSpecs({specsDir:f.specsDir,codeProject:f.codeProject,approvalResponse:'开始'});
  assert.equal(approved.approveRefused,undefined);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).state,'ready');
}
function executionFor(f,{decision=null,onReview=()=>{},onDevelop=()=>{}}={}){
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(request,{onEvent})=>{
      onReview();
      onEvent({event:'thread.started',provider_thread:`thread-${request.identity.runId}`});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};
    }};
  return {configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({
      requestedModel:'fixture',worker:async()=>{fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'export const a=2;\n');onDevelop();
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
      }},hostDecision:decision,check:createHostCheck({cwd:f.codeProject,
      commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})};
}
async function withRun(f,mode,options,run,runId){
  const opened=await openControlRun(f.definition(runId),mode,executionFor(f,options),options);
  try{return await run(opened.host,f.identity(runId));}finally{opened.close();}
}
const ask=(host,identity,operation,extra={})=>host.handle({version:1,operation,requestId:operation,identity,...extra});
async function awaitingReview(f){
  return withRun(f,'create',{},async(host,identity)=>{
    const result=await ask(host,identity,'advance');
    assert.equal(result.state,'awaiting_review',JSON.stringify(result));assert.equal(result.code,'decision_required');
    return result.packageDigest;
  });
}
const stateFile=(f,runId='rebind-run-0001')=>path.join(f.specsDir,'.reviews','.execution',runId,'state.json');

test('another task changed and re-approved: status names spec_drift and the rebind; the rebind keeps the delivery',async t=>{
  const f=fixture(t),packageDigest=await awaitingReview(f);
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b（导出 3）\n\n- T-002 依赖 T-001\n');
  reapprove(f);
  await withRun(f,'resume',{decision:{status:'approved'}},async(host,identity)=>{
    const status=await ask(host,identity,'status');
    assert.equal(status.state,'awaiting_review');assert.equal(status.code,'spec_drift');
    assert.equal(status.pendingAction,'spec_rebind');
    assert.match(status.reason,/1\.work\/tasks\.md/);assert.match(status.reason,/--rebind-spec-material/);
    const decision=await ask(host,identity,'decision',{packageDigest});
    assert.equal(decision.outcome,'rejected');assert.equal(decision.code,'spec_drift');
    assert.equal(decision.pendingAction,'spec_rebind');
  });
  const before=JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records.length;
  await withRun(f,'resume',{decision:{status:'approved'},specRebindReason:'T-002 描述调整，不涉及 T-001'},async(host,identity)=>{
    const status=await ask(host,identity,'status');
    assert.equal(status.code,null);assert.equal(status.pendingAction,'decision');assert.equal(status.packageDigest,packageDigest);
    const done=await ask(host,identity,'advance');
    assert.equal(done.state,'fixture_completed',JSON.stringify(done));
  });
  const records=JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records;
  const rebound=records.filter(row=>row.payload.type==='specification-rebound');
  assert.equal(rebound.length,1);assert.equal(records.indexOf(rebound[0]),before);
  assert.deepEqual(rebound[0].payload.record.files,['1.work/tasks.md']);
  assert.equal(rebound[0].payload.record.reason,'T-002 描述调整，不涉及 T-001');
  assert.equal(readRunnerHistory(records,records[0].payload.config,3).state.state,'fixture_completed');
  assert.match(fs.readFileSync(f.file('tasks.md'),'utf8'),/\[x\] T-001/);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-002');
  // Idempotent relaunch with the same flag writes nothing new.
  await withRun(f,'resume',{specRebindReason:'again'},async()=>{});
  assert.equal(JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records.length,records.length);
});

test('a change to what the run saw fails closed, names it, and both recovery exits work end to end',async t=>{
  const f=fixture(t),packageDigest=await awaitingReview(f);
  fs.writeFileSync(f.file('design.md'),'# Design\nsimple, now with a cache\n');
  reapprove(f);
  await withRun(f,'resume',{},async(host,identity)=>{
    const status=await ask(host,identity,'status');
    assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none');
    assert.match(status.reason,/1\.work\/design\.md/);assert.match(status.reason,/设计摘录/);
    assert.match(status.reason,/不能换绑/);assert.match(status.reason,/--supersede-reviewed-evidence/);
  });
  await assert.rejects(withRun(f,'resume',{specRebindReason:'想继续'},async()=>{}),error=>{
    assert.equal(error.code,'spec_rebind_refused');assert.match(error.reason,/设计摘录/);return true;});
  assert.equal(JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records.some(row=>row.payload.type==='specification-rebound'),false);
  // Exit 1: revert the spec and re-approve; the same run continues.
  fs.writeFileSync(f.file('design.md'),'# Design\nsimple\n');reapprove(f);
  await withRun(f,'resume',{},async(host,identity)=>{
    const status=await ask(host,identity,'status');assert.equal(status.code,null);assert.equal(status.pendingAction,'decision');
    assert.equal(status.packageDigest,packageDigest);
  });
  // Exit 2: keep the new design; cancel, restore the run's code, supersede and redo.
  fs.writeFileSync(f.file('design.md'),'# Design\nsimple, now with a cache\n');reapprove(f);
  await withRun(f,'resume',{},async(host,identity)=>{assert.equal((await ask(host,identity,'cancel')).state,'cancelled');});
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'export const a=1;\n');
  const redone=await withRun(f,'create',{decision:{status:'approved'},supersedeReason:'设计变更后重做'},
    (host,identity)=>ask(host,identity,'advance'),'rebind-run-0002');
  assert.equal(redone.state,'fixture_completed',JSON.stringify(redone));
});

test('a rebind cannot carry changed content: a later content change still drifts',async t=>{
  const f=fixture(t);await awaitingReview(f);
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b 改\n\n- T-002 依赖 T-001\n');reapprove(f);
  await withRun(f,'resume',{specRebindReason:'只改了 T-002'},async()=>{});
  fs.appendFileSync(f.file('requirements.md'),'- [ ] [AC-002] b exports 3\n');reapprove(f);
  await withRun(f,'resume',{},async(host,identity)=>{
    const status=await ask(host,identity,'status');
    assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none');assert.match(status.reason,/验收标准/);
  });
});

// Whether a verdict survives a spec change during the review itself belongs to
// the review-drift handling (PR #164). Whatever that stops at, status must not
// advertise an action the run would refuse.
test('a spec change during review never leaves status advertising a refused action',async t=>{
  const f=fixture(t);
  await withRun(f,'create',{},async(host,identity)=>assert.equal((await ask(host,identity,'advance')).state,'awaiting_review'));
  const changeDuringReview=()=>{
    fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 审查期间改了\n\n- T-002 依赖 T-001\n');reapprove(f);};
  await withRun(f,'resume',{decision:{status:'approved'},onReview:changeDuringReview},async(host,identity)=>{
    await ask(host,identity,'advance');
    const status=await ask(host,identity,'status');
    assert.equal(status.code,'spec_drift');assert(['spec_rebind','none'].includes(status.pendingAction),status.pendingAction);
    assert.equal(typeof status.reason,'string');
    if(status.pendingAction==='none')assert.match(status.reason,/--supersede-reviewed-evidence/);
  });
});

test('host CLI accepts the rebind only on resume with a single-line reason',t=>{
  const f=fixture(t),config=path.join(f.root,'run.json'),review=path.join(f.root,'review.json');
  fs.writeFileSync(config,JSON.stringify(f.definition('rebind-cli-run')));
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{}}));
  const launch=(mode,extra)=>{
    const result=spawnSync(process.execPath,[cli,'serve','--config',config,'--mode',mode,'--host-context','cli-host',
      '--allow-development','--review-config',review,...extra],{encoding:'utf8',timeout:20000,input:'',
      env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs'),NODE_NO_WARNINGS:'1'}});
    return {...result,error:JSON.parse(result.stderr.split('\n').find(line=>line.startsWith('{"error"'))??'null')?.error??null};
  };
  for(const [mode,extra] of [['create',['--rebind-spec-material','--spec-rebind-reason','x']],
    ['resume',['--rebind-spec-material']],['resume',['--spec-rebind-reason','x']]]){
    const result=launch(mode,extra);
    assert.equal(result.status,1);assert.equal(result.error.code,'spec_rebind_unavailable');
    assert.match(result.error.reason,/--rebind-spec-material/);
  }
  assert.equal(launch('create',[]).status,0);
  const nothing=launch('resume',['--rebind-spec-material','--spec-rebind-reason','没有规格变化']);
  assert.equal(nothing.status,0,nothing.stderr);
  const records=JSON.parse(fs.readFileSync(stateFile(f,'rebind-cli-run'),'utf8')).records;
  assert.equal(records.some(row=>row.payload.type==='specification-rebound'),false,'no drift means no record');
});

test('a run rebound before its first delivery develops against the re-approved spec',async t=>{
  const f=fixture(t);
  await withRun(f,'create',{},async(host,identity)=>assert.equal((await ask(host,identity,'status')).state,'ready'));
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b 改\n\n- T-002 依赖 T-001\n');reapprove(f);
  await withRun(f,'resume',{},async(host,identity)=>{
    const status=await ask(host,identity,'status');
    assert.equal(status.state,'ready');assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'spec_rebind');
    assert.equal((await ask(host,identity,'advance')).code,'spec_drift');
  });
  await withRun(f,'resume',{specRebindReason:'只改了 T-002'},async(host,identity)=>{
    const result=await ask(host,identity,'advance');
    assert.equal(result.state,'awaiting_review',JSON.stringify(result));
  });
});

test('journal replay accepts a rebind only bound to this run material and before completion',async t=>{
  const f=fixture(t);await awaitingReview(f);
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b 改\n\n- T-002 依赖 T-001\n');reapprove(f);
  await withRun(f,'resume',{specRebindReason:'只改了 T-002'},async()=>{});
  const records=JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records,config=records[0].payload.config;
  const index=records.findIndex(row=>row.payload.type==='specification-rebound');
  const reseal=(list,at,payload)=>{
    const out=structuredClone(list.slice(0,at));const body={...list[at],payload,previousDigest:out.at(-1).digest};
    delete body.digest;out.push({...body,digest:digest(body)});return out;
  };
  assert.equal(readRunnerHistory(records,config,3).state.state,'awaiting_review');
  const forged={...records[index].payload,record:{...records[index].payload.record,boundDigest:'0'.repeat(64)}};
  assert.throws(()=>readRunnerHistory(reseal(records,index,forged),config,3),error=>error.code==='spec_rebind_invalid');
  // After completion no effect remains, so a rebind record is not valid history.
  await withRun(f,'resume',{decision:{status:'approved'}},async(host,identity)=>
    assert.equal((await ask(host,identity,'advance')).state,'fixture_completed'));
  const done=JSON.parse(fs.readFileSync(stateFile(f),'utf8')).records;
  const late={...records[index],seq:done.length+1,id:`runner.${String(done.length+1).padStart(6,'0')}`};
  assert.throws(()=>readRunnerHistory(reseal([...done,late],done.length,records[index].payload),config,3),
    error=>error.code==='spec_rebind_invalid');
});

test('a spec change while the developer works stops the run with its real exits',async t=>{
  const f=fixture(t);
  const changeDuringDevelop=()=>{fs.writeFileSync(f.file('design.md'),'# Design\nchanged mid-develop\n');reapprove(f);};
  await withRun(f,'create',{onDevelop:changeDuringDevelop},async(host,identity)=>{
    const result=await ask(host,identity,'advance');
    assert.equal(result.state,'blocked');assert.equal(result.code,'spec_drift');
    const status=await ask(host,identity,'status');
    assert.equal(status.pendingAction,'none');assert.match(status.reason,/--supersede-reviewed-evidence/);
  });
});

// Cross-review blocker: a requirement can span lines, and a task item can carry
// sub-bullets. Neither appears in the one-line material, so the rebind must not
// decide from the material alone.
async function multiLineRun(f){
  fs.writeFileSync(f.file('requirements.md'),'# Requirements\n- [ ] [AC-001] Store user data\n  必须静态加密\n- [ ] [AC-002] b exports 3\n');
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n  - 约束：保留旧接口\n- [ ] T-002: 新增 b\n  - 约束：导出 3\n\n## 验证要求\n- T-002: node --test b\n\n## 依赖关系\n- T-002 依赖 T-001\n');
  reapprove(f);
  return awaitingReview(f);
}
const statusOf=f=>withRun(f,'resume',{},(host,identity)=>ask(host,identity,'status'));
for(const [label,file,from,to,pattern] of [
  ['acceptance continuation line','requirements.md','  必须静态加密','  允许明文存储',/requirements\.md（整份核对/],
  ['requirements prose without an AC marker','requirements.md','# Requirements\n','# Requirements\n所有数据保留 7 天\n',/requirements\.md（整份核对/],
  ['this task sub-bullet','tasks.md','  - 约束：保留旧接口','  - 约束：删除旧接口',/本任务的条目/],
  ['shared tasks.md prose','tasks.md','# tasks\n','# tasks\n全部任务必须补日志\n',/本任务的条目/],
  ['a dependency of this task','tasks.md','- T-002 依赖 T-001\n','- T-002 依赖 T-001\n- T-001 依赖 T-000\n',/本任务的条目/],
  // Re-review blocker: a line naming this task belongs to its scope wherever it sits.
  ['another task sub-item naming this task','tasks.md','  - 约束：导出 3','  - 约束：导出 3\n  - T-001 must encrypt backups',/本任务的条目/],
  ['a new task depending on this one','tasks.md','  - 约束：导出 3','  - 约束：导出 3\n- [ ] T-003: [NEW] 新增 c\n- T-003 依赖 T-001',/本任务的条目/],
])test(`multi-line spec: a change to ${label} is refused, naming it`,async t=>{
  const f=fixture(t);await multiLineRun(f);
  fs.writeFileSync(f.file(file),fs.readFileSync(f.file(file),'utf8').replace(from,to));
  if(label==='a dependency of this task')fs.writeFileSync(f.file('tasks.md'),
    fs.readFileSync(f.file('tasks.md'),'utf8').replace('# tasks\n','# tasks\n- [x] T-000: 前置\n'));
  reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none',status.reason);
  assert.match(status.reason,pattern);assert.match(status.reason,/不能换绑/);
  await assert.rejects(withRun(f,'resume',{specRebindReason:'试图换绑'},async()=>{}),error=>error.code==='spec_rebind_refused');
});
test('multi-line spec: other tasks items, sub-bullets, verification and new tasks not naming this one stay rebindable',async t=>{
  const f=fixture(t),packageDigest=await multiLineRun(f);
  fs.writeFileSync(f.file('tasks.md'),fs.readFileSync(f.file('tasks.md'),'utf8')
    .replace('- [ ] T-002: 新增 b\n  - 约束：导出 3','- [ ] T-002: 新增 b（改）\n  - 约束：导出 4\n  - 新增子项\n- [ ] T-003: [NEW] 新增 c')
    .replace('- T-002: node --test b','- T-002: node --test b c')
    .replace('- T-002 依赖 T-001\n','- T-002 依赖 T-001\n- T-003 依赖 T-002\n'));
  reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.pendingAction,'spec_rebind',status.reason);assert.match(status.reason,/1\.work\/tasks\.md/);
  await withRun(f,'resume',{decision:{status:'approved'},specRebindReason:'只改了 T-002 并新增 T-003'},async(host,identity)=>{
    const current=await ask(host,identity,'status');
    assert.equal(current.code,null);assert.equal(current.packageDigest,packageDigest);
    assert.equal((await ask(host,identity,'advance')).state,'fixture_completed');
  });
});

test('a run bound before taskScopeDigest keeps verifying but is never rebindable',async t=>{
  const f=fixture(t);
  await withRun(f,'create',{},async(host,identity)=>assert.equal((await ask(host,identity,'status')).state,'ready'));
  // Legacy-shaped journal: the init baseline material without taskScopeDigest.
  const file=stateFile(f),state=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(state.records.length,1);
  const init=state.records[0],{baselineDigest,...baseline}=init.payload.baseline;
  assert.match(baseline.specification.taskScopeDigest,/^[a-f0-9]{64}$/);
  const {taskScopeDigest,...material}=baseline.specification;
  const legacyBaseline={...baseline,specification:material};
  const {digest:oldDigest,...body}=init;
  const record={...body,payload:{...init.payload,baseline:{...legacyBaseline,baselineDigest:digest(legacyBaseline)}}};
  const records=[{...record,digest:digest(record)}],{revision,...rest}=state,next={...rest,records};
  fs.writeFileSync(file,JSON.stringify({...next,revision:digest(next)})+'\n');
  await withRun(f,'resume',{},async(host,identity)=>{
    const status=await ask(host,identity,'status');assert.equal(status.state,'ready');assert.equal(status.code,null);
  });
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b 改\n\n- T-002 依赖 T-001\n');reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none');assert.match(status.reason,/旧版本创建/);
  await assert.rejects(withRun(f,'resume',{specRebindReason:'旧运行'},async()=>{}),error=>error.code==='spec_rebind_refused');
});

test('test cases: another task case may change, this task case may not',async t=>{
  const f=fixture(t);
  const testCase=(id,taskId,title)=>({id,origin:'user',kind:'logic',blocking:true,acIds:['AC-001'],taskIds:[taskId],
    title,preconditions:[],steps:['Run it'],expected:['Works'],cleanup:[]});
  const write=cases=>fs.writeFileSync(f.file('test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases}));
  write([testCase('TC-001','T-001','a exports new'),testCase('TC-002','T-002','b exports 3')]);reapprove(f);
  await awaitingReview(f);
  write([testCase('TC-001','T-001','a exports new'),testCase('TC-002','T-002','b exports 3 and 4')]);reapprove(f);
  assert.equal((await statusOf(f)).pendingAction,'spec_rebind');
  write([testCase('TC-001','T-001','a exports newer'),testCase('TC-002','T-002','b exports 3 and 4')]);reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.pendingAction,'none');assert.match(status.reason,/本任务测试用例/);
});

test('task scope keeps shared fenced text after another task item',async()=>{
  const {taskScopeText}=await import('../runtime/js/cm-ai/specification-material.mjs');
  const before='- [ ] T-001: a\n  - 子项\n- [ ] T-002: b\n  - b 子项\n```\n所有任务都要加密\n```\n## 验证要求\n- T-002: test b\n- T-001: test a\n- T-002 依赖 T-001\n';
  const scope=taskScopeText(before,'T-001');
  assert.match(scope,/子项/);assert.match(scope,/所有任务都要加密/);assert.match(scope,/- T-001: test a/);
  assert.match(scope,/- T-002 依赖 T-001/,'a line naming this task is in scope wherever it sits');
  assert.doesNotMatch(scope,/b 子项|T-002: b|test b/);
  assert.notEqual(taskScopeText(before.replace('所有任务都要加密','所有任务可明文'),'T-001'),scope);
  assert.equal(taskScopeText(before.replace('  - b 子项','  - b 子项改'),'T-001'),scope);
});

test('a line naming this task under another task item changes: refused',async t=>{
  const f=fixture(t);
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b\n  - T-001 must encrypt backups\n\n## 依赖关系\n- T-002 依赖 T-001\n');
  reapprove(f);await awaitingReview(f);
  fs.writeFileSync(f.file('tasks.md'),fs.readFileSync(f.file('tasks.md'),'utf8').replace('T-001 must encrypt backups','T-001 may store plaintext backups'));
  reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none');assert.match(status.reason,/本任务的条目/);
});

test('another task test case that names this task changes: refused',async t=>{
  const f=fixture(t);
  const testCase=(id,taskId,title,steps)=>({id,origin:'user',kind:'logic',blocking:true,acIds:['AC-001'],taskIds:[taskId],
    title,preconditions:[],steps,expected:['Works'],cleanup:[]});
  const write=steps=>fs.writeFileSync(f.file('test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:[testCase('TC-001','T-001','a exports new',['Run a']),testCase('TC-002','T-002','b exports 3',steps)]}));
  write(['Run b','Check T-001 backups are encrypted']);reapprove(f);await awaitingReview(f);
  write(['Run b','Check T-001 backups may be plaintext']);reapprove(f);
  const status=await statusOf(f);
  assert.equal(status.pendingAction,'none');assert.match(status.reason,/本任务的条目/);
});

// Re-review major: an approval recorded before the shared grammar keeps its
// original parse. Under the old parser `T-001：` is prose, not a duplicate task.
test('an approval recorded before the shared grammar keeps parsing with the old grammar end to end',async t=>{
  const f=fixture(t);
  const tasks='# tasks\n- [ ] T-001: 修改 a\n- [ ] T-001：示例写法（旧解析器视为说明）\n- [ ] T-002: 新增 b\n\n- T-002 依赖 T-001\n';
  fs.writeFileSync(f.file('tasks.md'),tasks);
  // Legacy-shaped approval: no taskGrammar field.
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[f.feature],specFiles:buildManifest(f.specsDir)}));
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-001');
  const done=await withRun(f,'create',{decision:{status:'approved'}},(host,identity)=>ask(host,identity,'advance'));
  assert.equal(done.state,'fixture_completed',JSON.stringify(done));
  const after=fs.readFileSync(f.file('tasks.md'),'utf8');
  assert.equal(after,tasks.replace('- [ ] T-001: 修改 a','- [x] T-001: 修改 a'),'the old mark-done flips only the real task');
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-002');
  // supersede reads the tick with the same old grammar: one task, already ticked.
  await assert.rejects(withRun(f,'create',{supersedeReason:'重跑'},async()=>{},'rebind-run-legacy-2'),
    error=>error.code==='supersede_unavailable'&&/已将任务标为完成/.test(error.reason));
  // A new approval would bind the shared grammar, under which the same bytes are a
  // duplicate: it is refused, naming the line, instead of stranding the approval.
  const refused=reapproveRaw(f);
  assert.equal(refused.approveRefused,'task_grammar_conflict');
  assert.match(refused.approveReason,/1\.work\/tasks\.md 第 3 行/);assert.match(refused.approveReason,/围栏/);
  assert.equal(readSpecsStatus(f.specsDir).value.taskGrammar,undefined);
  fs.writeFileSync(f.file('tasks.md'),fs.readFileSync(f.file('tasks.md'),'utf8')
    .replace('- [ ] T-001：示例写法（旧解析器视为说明）','```\n- [ ] T-001：示例写法（旧解析器视为说明）\n```'));
  assert.equal(reapproveRaw(f).approveRefused,undefined);
  assert.equal(readSpecsStatus(f.specsDir).value.taskGrammar,2);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-002');
});
function reapproveRaw(f){
  const prior=readSpecsStatus(f.specsDir).value,specFiles=buildManifest(f.specsDir);
  writeSpecsStatus(f.specsDir,{status:'awaiting_review',summaryDigest:'a'.repeat(64),at:new Date().toISOString(),
    features:prior.features,specFiles,testCases:[],approval:null});
  return approveCmAiSpecs({specsDir:f.specsDir,codeProject:f.codeProject,approvalResponse:'开始'});
}

test('re-approving another feature is refused while an untouched feature would change meaning',async t=>{
  const f=fixture(t);
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-001：旧示例\n');
  const other=path.join(f.specsDir,'2.other');fs.mkdirSync(other);
  for(const [name,body] of [['requirements.md','# R\n- [ ] [AC-001] other\n'],['design.md','# D\n'],['tasks.md','- [ ] T-001: other\n']])
    fs.writeFileSync(path.join(other,name),body);
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[f.feature,'2.other'],specFiles:buildManifest(f.specsDir)}));
  await awaitingReview(f);
  fs.writeFileSync(path.join(other,'design.md'),'# D\nchanged\n');
  const refused=reapproveRaw(f);
  assert.equal(refused.approveRefused,'task_grammar_conflict');assert.match(refused.approveReason,/1\.work\/tasks\.md 第 3 行/);
  assert.equal(readSpecsStatus(f.specsDir).value.status,'awaiting_review','nothing approved under the new grammar');
});

// Fourth review: a unique full-width example is not a duplicate, but it would
// silently become a pending task when the project moves to the shared grammar.
function legacyTwoFeatures(f,workTasks){
  fs.writeFileSync(f.file('tasks.md'),workTasks);
  const other=path.join(f.specsDir,'2.other');fs.mkdirSync(other);
  for(const [name,body] of [['requirements.md','# R\n- [ ] [AC-001] other\n'],['design.md','# D\n'],['tasks.md','- [ ] T-001: other\n']])
    fs.writeFileSync(path.join(other,name),body);
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[f.feature,'2.other'],specFiles:buildManifest(f.specsDir)}));
  return other;
}
test('moving to the shared grammar is refused when a unique example would become a task',async t=>{
  const f=fixture(t),other=legacyTwoFeatures(f,'# tasks\n- [x] T-001: 已完成\n- [ ] T-099：示例写法\n');
  assert.deepEqual(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).features.map(item=>item.total),[1,1]);
  fs.writeFileSync(path.join(other,'design.md'),'# D\nchanged\n');
  const refused=reapproveRaw(f);
  assert.equal(refused.approveRefused,'task_grammar_conflict');
  assert.match(refused.approveReason,/1\.work\/tasks\.md 在新任务行语法下任务集合会变化：第 3 行 - \[ \] T-099：示例写法/);
  assert.equal(readSpecsStatus(f.specsDir).value.status,'awaiting_review');
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [x] T-001: 已完成\n```\n- [ ] T-099：示例写法\n```\n');
  assert.equal(reapproveRaw(f).approveRefused,undefined);assert.equal(readSpecsStatus(f.specsDir).value.taskGrammar,2);
  // Once on the shared grammar, later approvals need no reconciliation: a real
  // full-width task written afterwards is a task.
  fs.appendFileSync(f.file('tasks.md'),'- [ ] T-002：新任务\n');
  const prior=readSpecsStatus(f.specsDir).value;
  writeSpecsStatus(f.specsDir,{status:'awaiting_review',summaryDigest:'a'.repeat(64),at:new Date().toISOString(),
    features:prior.features,specFiles:buildManifest(f.specsDir),testCases:[],approval:null,taskGrammar:2});
  assert.equal(approveCmAiSpecs({specsDir:f.specsDir,codeProject:f.codeProject,approvalResponse:'开始'}).approveRefused,undefined);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-002');
});
test('a first approval with no earlier status binds the shared grammar directly',t=>{
  const f=fixture(t);
  fs.rmSync(path.join(f.specsDir,'.cm-specs-status'));
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001：全角冒号任务\n');
  assert.equal(approveCmAiSpecs({specsDir:f.specsDir,codeProject:f.codeProject,approvalResponse:'开始'}).approveRefused,undefined);
  assert.equal(readSpecsStatus(f.specsDir).value.taskGrammar,2);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.id,'T-001');
});

test('a parallel batch member is offered only the spec revert exit',async()=>{
  const {batchMemberResult}=await import('./cm-ai-batch-run.mjs');
  const drift={state:'blocked',code:'spec_drift',pendingAction:'spec_rebind',reason:'变更文件：1.work/tasks.md；需要换绑'};
  const parallel=batchMemberResult(drift,{parallel:true}),serial=batchMemberResult(drift);
  assert.equal(parallel.pendingAction,'none');assert.match(parallel.reason,/还原这些规格改动/);
  assert.match(parallel.reason,/并行组成员没有单独重做的出口/);assert.doesNotMatch(parallel.reason,/--supersede-reviewed-evidence|取消本批次/);
  assert.match(serial.reason,/--supersede-reviewed-evidence/);
  const other={state:'awaiting_review',pendingAction:'none'};assert.equal(batchMemberResult(other,{parallel:true}),other);
});
// Batch members cannot take --rebind-spec-material (a single-task resume flag),
// so the batch never advertises spec_rebind; it names the exits that exist.
test('a batch member never advertises spec_rebind and names the real exits',async t=>{
  const f=fixture(t),{createCmAiBatch}=await import('./cm-ai-batch-run.mjs');
  const git=args=>assert.equal(spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'}).status,0);
  git(['init','-q','-b','main']);git(['config','user.name','F']);git(['config','user.email','f@example.invalid']);
  git(['add','-A']);git(['commit','-qm','base']);
  const batch=()=>createCmAiBatch({configuration:{version:1,repositoryId:'rebind-fixture',batchId:'rebind-batch-1',
    specsDir:f.specsDir,codeProject:f.codeProject,tasks:['T-001','T-002'].map(taskId=>({feature:f.feature,taskId,
      scope:[taskId==='T-001'?'a.mjs':'b.mjs'],requirements:['requirements.md']}))},
  executionFor:async()=>executionFor(f),logHome:path.join(f.root,'batch-logs')});
  const first=await batch().handle({operation:'advance',requestId:'batch-advance'});
  assert.equal(first.state,'awaiting_review',JSON.stringify(first));
  fs.writeFileSync(f.file('tasks.md'),'# tasks\n- [ ] T-001: 修改 a\n- [ ] T-002: 新增 b 改\n\n- T-002 依赖 T-001\n');reapprove(f);
  const status=await batch().handle({operation:'status',requestId:'batch-status'});
  assert.equal(status.code,'spec_drift');assert.equal(status.pendingAction,'none');
  assert.match(status.reason,/1\.work\/tasks\.md/);assert.match(status.reason,/批次成员不能换绑/);
  assert.match(status.reason,/--supersede-reviewed-evidence/);assert.doesNotMatch(status.reason,/--rebind-spec-material/);
});
