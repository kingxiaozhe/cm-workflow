import test from 'node:test';
import assert from 'node:assert/strict';
import {operatorGuidance,guidanceText} from '../runtime/js/cm-ai/operator-guidance.mjs';
import {batchMemberResult} from './cm-ai-batch-run.mjs';

const identity={repositoryId:'fixture',runId:'guidance-run',taskId:'T-001',attempt:1};
const result=(state,code,pendingAction,extra={})=>({workflow:'cm-ai',identity,state,code,pendingAction,outcome:'reported',...extra});
const explain=(...args)=>operatorGuidance(result(...args));

test('only native resume paths advertise same-run development and never grant permission',()=>{
  for(const code of ['develop_checks_not_passed','develop_package_too_large','developer_result_invalid',
    'verification_precheck_failed','check_output_out_of_scope','develop_empty_changes','develop_unchanged_after_review',
    'develop_requirement_missing','bootstrap_verification_failed']){
    const input=result('blocked',code,'resume',{reason:'technical detail'}),before=JSON.stringify(input);
    const guidance=operatorGuidance(input);
    assert.equal(guidance.recoveryOperation,'advance',code);assert.equal(guidance.authorizationGranted,false);
    assert.match(guidance.nextStep,/本轮交付和检查/);assert.match(guidance.prerequisites.join(' '),/原配置、runId/);
    assert.equal(JSON.stringify(input),before,'guidance cannot mutate authority');
    assert.equal(explain('blocked',code,'none').recoveryOperation,null,'no action when native recovery unavailable');
    assert.equal(explain('unknown',code,'reconcile').recoveryOperation,null,'same code is not retry permission');
  }
  assert.match(explain('blocked','develop_package_too_large','resume').nextStep,/先走规格变更/);
  assert.match(explain('blocked','develop_checks_not_passed','resume').summary,/尚未进入独立审查/);
});
test('bootstrap recovery restores the package without redispatching developer',()=>{
  const g=explain('blocked','bootstrap_review_mismatch','bootstrap_review_recover');
  assert.equal(g.recoveryOperation,'bootstrap_review_recover');assert.match(g.nextStep,/不重新派发开发/);
  assert.match(g.prerequisites.join(' '),/--allow-bootstrap-review-recovery/);
  assert.equal(explain('blocked','bootstrap_review_mismatch','none').recoveryOperation,null);
});
test('spec drift and rejection precede otherwise retryable package or development actions',()=>{
  assert.equal(explain('blocked','spec_drift','bootstrap_review_recover').recoveryOperation,null);
  assert.equal(explain('blocked','spec_drift','spec_rebind').recoveryOperation,null);
  for(const outcome of ['rejected','denied']){
    const g=explain('blocked','develop_checks_not_passed','resume',{outcome});
    assert.equal(g.recoveryOperation,null);assert.match(g.summary,/拒绝/);
  }
});
test('unknown must be audited; abandonment is conditional and never an advance instruction',()=>{
  for(const action of ['abandon_effect','abandon_review']){
    const g=explain('unknown','execution_error',action);
    assert.equal(g.recoveryOperation,action);assert.match(g.nextStep,/子进程已退出/);
    assert.match(g.nextStep,/不代表成功/);assert.equal(g.authorizationGranted,false);
  }
  assert.equal(explain('unknown','limit_exceeded','reconcile').recoveryOperation,null);
  assert.match(explain('unknown','execution_error','reconcile').nextStep,/只读核对/);
});
test('active operation suppresses recovery and completion is kept separate from development',()=>{
  const g=operatorGuidance(result('unknown','execution_error','abandon_effect'),{executionActive:true});
  assert.equal(g.recoveryOperation,null);assert.match(g.nextStep,/不重复派发/);
  assert.equal(explain('blocked','completion_package_changed','complete').recoveryOperation,'complete');
  assert.match(explain('blocked','completion_checks_changed','complete').nextStep,/不重新开发/);
  assert.equal(explain('blocked','checks_not_passed','none').recoveryOperation,null);
  assert.match(explain('blocked','checks_not_passed','none').summary,/旧完成阶段/);
  assert.equal(explain('fixture_completed','correction_review_required','none').recoveryOperation,null);
});
test('unrecognized and successful states do not invent a recovery contract',()=>{
  assert.equal(explain('blocked','unrecognized_code','none').recoveryOperation,null);
  for(const code of ['constructor','__proto__','toString'])assert.equal(explain('blocked',code,'resume').recoveryOperation,null);
  assert.equal(explain('blocked','bootstrap_instruction_conflict','none').recoveryOperation,null);
  for(const state of ['ready','awaiting_review','approved','fixture_completed','run_done'])assert.equal(explain(state,null,'none'),null);
  assert.equal(operatorGuidance(null),null);assert.equal(operatorGuidance({workflow:'cm-fix',state:'blocked',identity}),null);
});
test('review redispatch keeps package and fresh authorization prerequisites',()=>{
  const g=explain('pending_review','review_transport_timeout','resume');
  assert.equal(g.recoveryOperation,'advance');assert.match(g.prerequisites.join(' '),/审查包绑定不变/);
  assert.match(g.nextStep,/本轮绑定/);
});
test('rendering never uses raw reason and malformed foreign guidance is ignored',()=>{
  const value=result('unknown','execution_error','reconcile',{reason:'private raw provider message'});
  value.guidance=operatorGuidance(value);const rendered=guidanceText(value);
  assert(!rendered.includes(value.reason));assert.match(rendered,/只读核对/);
  assert.equal(guidanceText({...value,workflow:'cm-fix'}),null);
  for(const change of [{authorizationGranted:true},{summary:'control\nline'},{prerequisites:null},{nextStep:'x'.repeat(2001)}])
    assert.equal(guidanceText({...value,guidance:{...value.guidance,...change}}),null);
});

test('batch guidance matches its narrower control surface and never advertises single-host flags',()=>{
  const member=(...args)=>{const value=result(...args);return {...value,guidance:operatorGuidance(value)};};
  const blocked=member('blocked','develop_checks_not_passed','resume');
  const wrapped=batchMemberResult(blocked);
  assert.equal(wrapped.pendingAction,blocked.pendingAction);assert.equal(wrapped.guidance.recoveryOperation,'advance');
  assert.match(guidanceText(wrapped),/原批次入口/);assert.doesNotMatch(guidanceText(wrapped),/--mode/);
  assert.match(guidanceText(batchMemberResult(member('blocked','completion_checks_changed','complete'))),/成员宿主继续完成复核/);
  for(const [state,code,action] of [['unknown','execution_error','abandon_effect'],
    ['unknown','execution_error','abandon_review'],['blocked','bootstrap_review_mismatch','bootstrap_review_recover']]){
    const output=batchMemberResult(member(state,code,action));
    assert.equal(output.guidance.recoveryOperation,null);assert.doesNotMatch(guidanceText(output),/--allow-/);
    assert.match(guidanceText(output),/批次入口不支持/);
  }
  const rebound=batchMemberResult(member('blocked','spec_drift','spec_rebind'));
  assert.equal(rebound.pendingAction,'none');assert.match(rebound.guidance.nextStep,/不能换绑/);
  assert.equal(rebound.guidance.recoveryOperation,null);
});
