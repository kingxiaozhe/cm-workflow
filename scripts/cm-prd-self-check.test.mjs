import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checkPrdDraftMechanics,matchesPrdDraftMechanics,PRD_SELF_CHECK_RULES} from '../runtime/js/cm-prd/self-check.mjs';
import {inspectPrdSelfCheckRevision} from '../runtime/js/cm-prd/self-check-revision.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const contract={schemaVersion:'1.0',feature:'sample',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:['AC-001'],taskIds:['T-001'],title:'Check behavior',preconditions:[],steps:['Do it'],expected:['Works'],cleanup:[]}]};
function draft(tasks='- [ ] T-001: Implement behavior\n  - 范围: `README.md`',cases=contract){
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
  assert.ok(checkPrdDraftMechanics(draft('- [ ] T-001: A\n  - 范围: `README.md`\n- [ ] T-002: B\n  - 范围: `README.md`\n- T-001 依赖 T-002\n- T-002 依赖 T-001')).findings.some(x=>x.code==='dependencies_invalid'));
  assert.ok(checkPrdDraftMechanics(draft(Array.from({length:16},(_,i)=>`- [ ] T-${String(i+1).padStart(3,'0')}: Task`).join('\n'))).findings.some(x=>x.code==='task_limit_exceeded'));
  assert.ok(checkPrdDraftMechanics(draft('```md\n- [ ] T-001: Example only\n  - 范围: `README.md`\n```')).findings.some(x=>x.code==='tasks_invalid'));
  const wrong=structuredClone(contract);wrong.cases[0].acIds=['AC-002'];wrong.cases[0].taskIds=['T-999'];
  const codes=checkPrdDraftMechanics(draft(undefined,wrong)).findings.map(x=>x.code);
  assert.ok(codes.includes('test_reference_invalid'));assert.ok(codes.includes('acceptance_test_coverage_missing'));
});
test('malformed dependency finding names tasks.md and one-line comma format',()=>{
  const report=checkPrdDraftMechanics(draft('- [ ] T-001: A\n  - 范围: `README.md`\n- [ ] T-002: B\n  - 范围: `README.md`\n- T-002 依赖 T-001。T-003'));
  const finding=report.findings.find(item=>item.code==='dependencies_invalid');
  assert.equal(finding.reason.field,'1.sample/tasks.md');
  assert.match(finding.reason.expected,/- T-003 依赖 T-001, T-002/);
});

// Rule 2: lines the parser skips must not silently drop a task, and only what a
// change adds is held to the stricter rules. Rule 1 records stay verifiable.
const codesOf=report=>report.findings.map(item=>item.code);
const changeDraft=tasks=>draft(tasks);
const R2={rules:PRD_SELF_CHECK_RULES};
test('rule 2 rejects task and dependency lines the parser would silently skip',()=>{
  for(const line of ['- [ ] T-002/a: Hidden task','- [ ] T-002','- [~] T-002: Odd mark'])
    assert.ok(codesOf(checkPrdDraftMechanics(draft(`- [ ] T-001: Implement behavior\n${line}`),R2)).includes('tasks_invalid'),line);
  assert.ok(codesOf(checkPrdDraftMechanics(draft('- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- T-001/a 依赖 T-001'),R2)).includes('dependencies_invalid'));
  // A fenced example is not a declaration under either rule.
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n```md\n- [ ] T-002/a: Example\n```'),R2).status,'mechanical_subset_passed');
  // Rule 1 keeps the original subset.
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] T-002/a: Hidden task'),{rules:1}).status,'mechanical_subset_passed');
});
test('rule 2 change exempts approved malformed lines only up to their unfenced count',()=>{
  const odd='- [x] T-000/a: Historical note',base=`- [ ] T-001: Implement behavior\n${odd}`;
  const previous=text=>({'1.sample':text}),scopes={'1.sample':{exempt:['T-001']}};
  assert.equal(checkPrdDraftMechanics(changeDraft(base),{...R2,change:true,scopes,previous:previous(base)}).status,'mechanical_subset_passed');
  assert.ok(codesOf(checkPrdDraftMechanics(changeDraft(`${base}\n${odd}`),{...R2,change:true,scopes,previous:previous(base)})).includes('tasks_invalid'));
  const fencedOnly=`- [ ] T-001: Implement behavior\n\`\`\`md\n${odd}\n\`\`\``;
  assert.ok(codesOf(checkPrdDraftMechanics(changeDraft(base),{...R2,change:true,scopes,previous:previous(fencedOnly)})).includes('tasks_invalid'));
});
test('rule 2 change rejects a new or rewritten dependency on a dropped task, not an approved one',()=>{
  const dropped='- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] ~~T-002: Old~~ [DROPPED 不再需要]\n- [ ] T-003: Next\n  - 范围: `README.md`';
  const kept=`${dropped}\n- T-003 依赖 T-002`;
  const previous={'1.sample':'- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] T-002: Old\n  - 范围: `README.md`\n- [ ] T-003: Next\n  - 范围: `README.md`\n- T-003 依赖 T-002'};
  assert.equal(checkPrdDraftMechanics(changeDraft(kept),{...R2,change:true,previous}).status,'mechanical_subset_passed');
  assert.ok(codesOf(checkPrdDraftMechanics(changeDraft(`${dropped}\n- T-003 依赖 T-001, T-002`),{...R2,change:true,previous})).includes('dependencies_invalid'));
  assert.ok(codesOf(checkPrdDraftMechanics(changeDraft(kept),{...R2,change:true,previous:{'1.sample':dropped}})).includes('dependencies_invalid'));
  assert.equal(checkPrdDraftMechanics(changeDraft(kept),{change:true,previous:{'1.sample':dropped},rules:1}).status,'mechanical_subset_passed');
});
test('rule 2 task budget counts only tasks that are not dropped',()=>{
  const tasks=Array.from({length:17},(_,i)=>`- [ ] ${i<2?'~~':''}T-${String(i+1).padStart(3,'0')}: Task${i<2?'~~ [DROPPED 合并]':''}`).join('\n');
  assert.ok(!codesOf(checkPrdDraftMechanics(changeDraft(tasks),{...R2,change:true})).includes('task_limit_exceeded'));
  assert.ok(codesOf(checkPrdDraftMechanics(changeDraft(tasks),{change:true,rules:1})).includes('task_limit_exceeded'));
});
test('an ordinary draft gets the same report under both rules; records match only a known rule',()=>{
  assert.deepEqual(checkPrdDraftMechanics(draft(),R2),checkPrdDraftMechanics(draft(),{rules:1}));
  const odd=draft('- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] T-002/a: Hidden task');
  const legacy=checkPrdDraftMechanics(odd,{rules:1});
  assert.ok(matchesPrdDraftMechanics(odd,legacy));
  assert.ok(matchesPrdDraftMechanics(odd,checkPrdDraftMechanics(odd,R2)));
  assert.ok(!matchesPrdDraftMechanics(odd,{...legacy,status:'failed'}));
  assert.throws(()=>checkPrdDraftMechanics(odd,{rules:4}),{code:'prd_self_check_rules_invalid'});
});
test('a self-check revision recorded under rule 1 still verifies after rule 2',()=>{
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const documents=[{path:'requirements.md',content:'No acceptance criteria yet.'},{path:'design.md',content:'# Design\n'},
    {path:'tasks.md',content:'- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] T-002/a: Hidden task'}];
  const summary='Synthetic failed draft';
  const features=[{directory:'1.sample',name:'sample',documents}];
  const failedDraft={summary,features,draftDigest:digest({summary,features})};
  failedDraft.mechanicalSelfCheck=checkPrdDraftMechanics(failedDraft,{rules:1});
  assert.equal(failedDraft.mechanicalSelfCheck.status,'failed');
  assert.notDeepEqual(checkPrdDraftMechanics(failedDraft,R2),failedDraft.mechanicalSelfCheck,'rule 2 reports this draft differently');
  const failedSelfCheck={round:1,draftDigest:failedDraft.draftDigest,mechanical:failedDraft.mechanicalSelfCheck,contextCheck:null};
  const revised='- [ ] [AC-001] Behavior works.';
  const revision={version:1,designDraftDigest:'d'.repeat(64),acceptedDesignDigest:'e'.repeat(64),reason:'Add acceptance',round:2,
    failedDraft,failedSelfCheck,failedSelfCheckDigest:digest(failedSelfCheck),draftDigest:'f'.repeat(64),
    features:[{directory:'1.sample',documents:[
      {path:'requirements.md',content:revised,sha256:sha(revised),beforeSha256:sha(documents[0].content)},
      {path:'design.md',content:documents[1].content,sha256:sha(documents[1].content),beforeSha256:sha(documents[1].content)}],
      changedFiles:['requirements.md']}]};
  assert.equal(inspectPrdSelfCheckRevision(revision).round,2);
  const forged=structuredClone(revision);forged.failedSelfCheck.mechanical.findings=[];
  forged.failedDraft.mechanicalSelfCheck=forged.failedSelfCheck.mechanical;forged.failedSelfCheckDigest=digest(forged.failedSelfCheck);
  assert.throws(()=>inspectPrdSelfCheckRevision(forged),{code:'prd_self_check_revision_binding_changed'});
});
test('only a fresh draft round and a change proposal use rule 2; re-checks keep rule 1',()=>{
  const read=file=>fs.readFileSync(new URL(`../runtime/js/cm-prd/${file}`,import.meta.url),'utf8');
  assert.match(read('analysis.mjs'),/checkPrdDraftMechanics\(inspected,\{rules:selfCheckRules\(\)\}\)/);
  assert.match(read('change.mjs'),/checkPrdDraftMechanics\(draft,\{change:true,rules,/);
  const odd=draft('- [ ] T-001: Implement behavior\n  - 范围: `README.md`\n- [ ] T-002/a: Hidden task');
  assert.deepEqual(checkPrdDraftMechanics(odd),checkPrdDraftMechanics(odd,{rules:1}),'the default is rule 1');
  for(const file of ['review-disposition.mjs','review-correction.mjs','summary.mjs','failed-correction.mjs','self-check-revision.mjs'])
    assert.doesNotMatch(read(file),/PRD_SELF_CHECK_RULES|rules:\s*2/,file);
  // The driver's disposition re-check stays on rule 1 (plus the saved scope record, as the
  // host's disposition does); its change preflight follows the operation.
  const drive=fs.readFileSync(new URL('./cm-prd-drive.mjs',import.meta.url),'utf8');
  assert.match(drive,/draft\.mechanicalSelfCheck=checkPrdDraftMechanics\(draft,prdTaskScopeOptions\(specs,request\.feature\)\);/);
  assert.match(read('review-disposition.mjs'),/scopeOptions=prdTaskScopeOptions\(input\.specs,input\.feature\);[\s\S]*checkPrdDraftMechanics\(draft,scopeOptions\)/);
  assert.equal([...drive.matchAll(/PRD_SELF_CHECK_RULES/g)].length,2,'import plus the change preflight rule');
  assert.match(drive,/const rules=ctx\.operation==='resume'\?ctx\.state\.active\?\.selfCheckRules\?\?1:PRD_SELF_CHECK_RULES;/);
});
