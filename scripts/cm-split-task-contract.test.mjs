import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isTaskId,taskDeclarations,LEGACY_TASK_GRAMMAR} from '../runtime/js/spec-task-line.mjs';
import {parseFeatureTaskText,validDependencies} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {checkPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
import {inspectPrdDraft} from '../runtime/js/cm-prd/draft.mjs';
import {inspectPrdChangeProposal} from '../runtime/js/cm-prd/change.mjs';
import {validateTestCases} from './validate-test-cases.mjs';

const cases={schemaVersion:'1.0',feature:'sample',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:['AC-001'],taskIds:['T-004a','T-004b','T-004c'],title:'Existing acceptance',preconditions:[],
  steps:['Check the existing implementation'],expected:['Original assertions hold'],cleanup:[]}]};
const completed=['T-001','T-002','T-003'].map(id=>`- [x] ${id}: Completed`);
const children=['a','b','c'].map(suffix=>`- [ ] T-004${suffix}: [NEW v3] Review existing implementation`);
const pending=Array.from({length:9},(_,i)=>`- [ ] T-${String(i+5).padStart(3,'0')}: Existing task`);
const historical='- [ ] T-004: Original task [DROPPED v3: retain history]';
const tasks=[...completed,historical,...children,...pending,
  '- T-004a 依赖 T-001, T-002, T-003','- T-004b 依赖 T-004a','- T-004c 依赖 T-004a'].join('\n');
function rawDraft(source=tasks,contract=cases){
  return {status:'draft',summary:'Review-only split proposal',features:[{name:'sample',testCasesReason:null,documents:[
    {path:'requirements.md',content:'- [ ] [AC-001] Original acceptance'},
    {path:'design.md',content:'# Existing design'},
    {path:'tasks.md',content:source},{path:'test-cases.json',content:JSON.stringify(contract)}]}]};
}
function draft(source=tasks,contract=cases){return inspectPrdDraft(rawDraft(source,contract),{nextIndex:1,generateCases:true,userCasesProvided:true});}

test('split contract: one ID grammar accepts suffixes and existing named IDs, rejects malformed references',()=>{
  for(const id of ['T-001','T-004a','T-004b','T-004c','T-FIX-api','T-api.v1_beta-2']){
    assert.equal(isTaskId(id),true,id);
    assert.equal(taskDeclarations(`- [ ] ${id}: Item`)[0].id,id);
    const contract=structuredClone(cases);contract.cases[0].taskIds=[id];assert.deepEqual(validateTestCases(contract),[]);
  }
  for(const id of ['T-','T-004/a','T-004a!',' T-004a','T-004a\n','T-004a\r',null]){
    assert.equal(isTaskId(id),false,String(id));
    if(typeof id==='string'){
      const contract=structuredClone(cases);contract.cases[0].taskIds=[id];
      assert(validateTestCases(contract).some(reason=>reason.includes('taskIds has invalid id')));
    }
  }
});

test('split contract: malformed and duplicate new task declarations fail without changing old approval parsing',()=>{
  for(const line of ['- [ ] T-004/a: Invalid','- [ ] T-004a!: Invalid','- [DROPPED] T-004: Invalid checkbox']){
    const source=`- [ ] T-001: Valid\n${line}`;
    assert.equal(parseFeatureTaskText(source,{strictTaskIds:true}).error,'tasks_invalid');
    assert.equal(parseFeatureTaskText(source,{grammar:LEGACY_TASK_GRAMMAR}).error,undefined);
  }
  assert.equal(parseFeatureTaskText('- [ ] T-004a: First\n- [ ] T-004a: Duplicate',{strictTaskIds:true}).error,'tasks_invalid');
  const parsed=parseFeatureTaskText('- [ ] T-001: Valid\n```md\n- [ ] T-004/a: Example\n```',{strictTaskIds:true});
  assert.equal(parsed.error,undefined);assert.equal(parsed.tasks.length,1);
});

test('split contract: fifteen executable declarations plus history pass and sixteen still fail',()=>{
  const value=draft(),report=checkPrdDraftMechanics(value,{change:true});
  assert.equal(report.status,'mechanical_subset_passed');
  assert.deepEqual(report.features,[{directory:'1.sample',tasks:16,acceptanceCriteria:1,executionTasks:15,historicalTasks:1}]);
  assert.equal(value.features[0].documents.find(doc=>doc.path==='tasks.md').content,tasks);
  const tooMany=checkPrdDraftMechanics(draft(`${tasks}\n- [ ] T-014: One too many`),{change:true});
  assert(tooMany.findings.some(item=>item.code==='task_limit_exceeded'));
  const completedTooMany=checkPrdDraftMechanics(draft(`${tasks}\n- [x] T-014: Completed still counts`),{change:true});
  assert(completedTooMany.findings.some(item=>item.code==='task_limit_exceeded'));
});

test('split contract: new proposals refuse historical and malformed dependencies but old approvals retain semantics',()=>{
  const source=`${tasks}\n- T-005 依赖 T-004`,parsed=parseFeatureTaskText(source);
  assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
  assert.equal(validDependencies(parsed.tasks,parsed.dependencies,{rejectDropped:true}),false);
  assert(checkPrdDraftMechanics(draft(source),{change:true}).findings.some(item=>item.code==='dependencies_invalid'));
  for(const line of ['- T-004/a 依赖 T-001','- T-004a 依赖 T-004/a']){
    const value=draft(`- [ ] T-001: Valid\n- [ ] T-004a: Child\n${line}`);
    assert(checkPrdDraftMechanics(value,{change:true})
      .findings.some(item=>item.code==='dependencies_invalid'));
  }
});

test('split contract: exact change proposal preserves completed lines and user case semantics',()=>{
  const priorTasks=[...completed,'- [ ] T-004: Original task',...pending,'| date | v2 | Original |'].join('\n');
  const priorCases=structuredClone(cases);priorCases.cases[0].taskIds=['T-004'];
  const old=rawDraft(priorTasks,priorCases).features[0];
  const before={directories:['1.sample'],status:JSON.stringify({status:'approved',taskGrammar:2}),
    files:Object.fromEntries(old.documents.map(doc=>[`1.sample/${doc.path}`,doc.content]))};
  const next=rawDraft(`${tasks}\n| date | v2 | Original |\n| date | v3 | Split |`).features[0];
  const proposal=inspectPrdChangeProposal(before,{status:'draft',summary:'Split existing task',
    features:[{directory:'1.sample',documents:next.documents,testCasesReason:null}],removed:[]},['1.sample'],{policies:{generate_cases:true}});
  assert.equal(proposal.mechanicalSelfCheck.status,'mechanical_subset_passed');
  assert.equal(proposal.counts.preservedCompletedTasks,3);
  for(const line of completed)assert(proposal.files['1.sample/tasks.md'].split('\n').includes(line));
  const {taskIds:oldIds,...oldSemantics}=priorCases.cases[0];
  const {taskIds:newIds,...newSemantics}=JSON.parse(proposal.files['1.sample/test-cases.json']).cases[0];
  assert.deepEqual(newSemantics,oldSemantics);assert.deepEqual(newIds,['T-004a','T-004b','T-004c']);
  assert.equal(proposal.changedUserCases.length,1);
});

test('split contract: validator CLI accepts suffixed references and rejects invalid IDs with explicit diagnostics',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-split-case-contract-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'test-cases.json'),entry=fileURLToPath(new URL('./validate-test-cases.mjs',import.meta.url));
  fs.writeFileSync(file,JSON.stringify(cases));
  const accepted=spawnSync(process.execPath,[entry,file],{encoding:'utf8'});
  assert.equal(accepted.status,0,accepted.stderr);assert.match(accepted.stdout,/test-cases validation: PASSED/);
  const bad=structuredClone(cases);bad.cases[0].taskIds=['T-004/a'];fs.writeFileSync(file,JSON.stringify(bad));
  const rejected=spawnSync(process.execPath,[entry,file],{encoding:'utf8'});
  assert.equal(rejected.status,1);assert.match(rejected.stderr,/taskIds has invalid id: 'T-004\/a'/);
  assert.match(rejected.stderr,/test-cases validation: FAILED/);assert.equal(rejected.stdout,'');
});
