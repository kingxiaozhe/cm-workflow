import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {inspectPrdDraft} from '../runtime/js/cm-prd/draft.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const draft=()=>({status:'draft',summary:'Documentation draft',features:[{name:'guide',
  documents:['requirements.md','design.md','tasks.md'].map(file=>({path:file,
    content:file==='requirements.md'?'- [ ] [AC-001] The guide describes setup.':file==='tasks.md'?'- [ ] T-001: Update guide':'# Synthetic design'})),
  testCasesReason:'no_observable_behavior'}]});
test('draft structure refuses missing triad, unsafe path and dropped user cases',()=>{
  const options={nextIndex:3,generateCases:true,userCasesProvided:false};
  assert.equal(inspectPrdDraft(draft(),options).features[0].directory,'3.guide');
  const missing=draft();missing.features[0].documents.pop();assert.throws(()=>inspectPrdDraft(missing,options));
  const unsafe=draft();unsafe.features[0].documents[0].path='../AGENTS.md';assert.throws(()=>inspectPrdDraft(unsafe,options));
  assert.throws(()=>inspectPrdDraft(draft(),{...options,userCasesProvided:true}));
});
test('analysis -> planner clarification -> draft preserves scope and does not write',async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-draft-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'docs'));fs.mkdirSync(path.join(dir,'2.existing'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Documentation need');
  const events=[];let plans=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},
    runtime:'codex',record:async event=>events.push(event),analyze:async()=>({status:'analyzed',summary:'Documentation',
      sourcePaths:['docs/input.md'],openQuestions:[]}),generate:async payload=>{
      plans++;assert.equal(payload.nextIndex,3);assert.equal(payload.analysis.summary,'Documentation');
      assert.equal(payload.role.role,'planner');
      return plans===1?{status:'question',question:'Should the guide include examples?'}:draft();
    }});
  await host.advance('Analyze');assert.equal((await host.plan('Prepare draft')).stage,'awaiting_planning_user');
  const result=await host.plan('Yes');assert.equal(result.stage,'draft_ready');
  assert.equal(result.draft.features[0].directory,'3.guide');assert.equal(result.draft.checks,'structure_only');
  assert.deepEqual(events.map(event=>event.data.role),['analyst','planner','planner']);
  assert.deepEqual(fs.readdirSync(dir).sort(),['2.existing','docs']);
});
