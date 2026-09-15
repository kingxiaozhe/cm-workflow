import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
const contract={schemaVersion:'1.0',feature:'sample',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:['AC-001'],taskIds:['T-001'],title:'Check behavior',preconditions:[],steps:['Do it'],expected:['Works'],cleanup:[]}]};
function draft(tasks='- [ ] T-001: Implement behavior',cases=contract){
  return {draftDigest:'a'.repeat(64),features:[{directory:'1.sample',name:'sample',documents:[
    {path:'requirements.md',content:'- [ ] [AC-001] Behavior works.'},{path:'tasks.md',content:tasks},
    {path:'test-cases.json',content:JSON.stringify(cases)}]}]};
}
test('mechanical check reuses task parser and case validator without claiming full self-check',()=>{
  const report=checkPrdDraftMechanics(draft());assert.equal(report.status,'mechanical_subset_passed');
  assert.equal(report.completeSelfCheck,false);assert.equal(report.independentReview,false);
  assert.ok(report.pending.includes('user_case_semantics'));
});
test('cycles, task budget, false declarations and missing AC/task references fail',()=>{
  assert.ok(checkPrdDraftMechanics(draft('- [ ] T-001: A\n- [ ] T-002: B\n- T-001 依赖 T-002\n- T-002 依赖 T-001')).findings.some(x=>x.code==='dependencies_invalid'));
  assert.ok(checkPrdDraftMechanics(draft(Array.from({length:16},(_,i)=>`- [ ] T-${String(i+1).padStart(3,'0')}: Task`).join('\n'))).findings.some(x=>x.code==='task_limit_exceeded'));
  assert.ok(checkPrdDraftMechanics(draft('```md\n- [ ] T-001: Example only\n```')).findings.some(x=>x.code==='tasks_invalid'));
  const wrong=structuredClone(contract);wrong.cases[0].acIds=['AC-002'];wrong.cases[0].taskIds=['T-999'];
  const codes=checkPrdDraftMechanics(draft(undefined,wrong)).findings.map(x=>x.code);
  assert.ok(codes.includes('test_reference_invalid'));assert.ok(codes.includes('acceptance_test_coverage_missing'));
});
