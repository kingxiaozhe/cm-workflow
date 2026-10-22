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
