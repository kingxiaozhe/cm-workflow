import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {splitFixture} from './cm-ai-review-split-fixture.mjs';
import {assertSavedSplitProposal} from '../runtime/js/cm-ai/review-split-proposal.mjs';
import {prepareReviewOnlySplit,registerReviewOnlySplit} from '../runtime/js/cm-ai/review-only-split.mjs';
import {parseFeatureTaskText} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
const fixture=(options,fn)=>{const f=splitFixture(options);try{return fn(f);}finally{f.cleanup();}};
const copy=v=>JSON.parse(JSON.stringify(v));

test('saved real owner confirm/save/session commit binds exact split, full task entries and responsibilities with no provider',()=>fixture({},f=>{
 assert.equal(f.saved.status,'awaiting_review');assert.equal(f.owner.status().stage,'awaiting_review');assert.equal(f.providerCalls,0);
 const result=assertSavedSplitProposal(f.plan);assert.equal(result.stage,'awaiting_review');assert.equal(result.preservedOriginalTasks,13);assert.equal(result.preservedCompletedTasks,3);
 assert.deepEqual(result.children,['T-004a','T-004b','T-004c']);assert.equal(result.proposalDigest,f.proposal.proposalDigest);
 assert.deepEqual(assertSavedSplitProposal(f.plan),result);
 for(const entry of f.completed)assert.ok(f.proposal.files['4.app-warm-frost/tasks.md'].includes(entry));
}));

test('an exactly confirmed and saved unrelated proposal cannot authorize three child tasks',()=>fixture({unrelated:true},f=>{
 assert.equal(f.saved.status,'awaiting_review');assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_parent_history'});
}));

test('confirmed but unsaved lifecycle is rejected before any registration binding',()=>fixture({unsaved:true},f=>{
 assert.equal(f.owner.status().stage,'confirmed');assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_saved_required'});
}));

test('child scope/test ownership must exactly match explicit confirmed task continuations',()=>fixture({},f=>{
 for(const edit of [p=>p.children[0].paths.pop(),p=>p.children[1].tests=[],p=>p.children[0].taskId='T-004x']){
  const plan=copy(f.plan);edit(plan);assert.throws(()=>assertSavedSplitProposal(plan),error=>/^split_proposal_(?:scope_mismatch|test_mismatch|children)$/.test(error.code));
 }
}));

test('missing review-only marker or ambiguous extra scope reference remains blocked after real owner save',()=>{
 fixture({tasksTransform:t=>t.replace('  - review-only\n','')},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_responsibility_required'}));
 fixture({tasksTransform:t=>t.replace('  - scope: ','  - scope: `unknown.tsx` ')},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_scope_ambiguous'}));
});

test('completed continuation and parent original continuation may not be changed by a saved proposal',()=>{
 fixture({tasksTransform:t=>t.replace('Keep original continuation for T-001','Changed completed continuation')},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_task_history'}));
 fixture({tasksTransform:t=>t.replace('Preserve original parent continuation','Changed parent continuation')},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_parent_history'}));
});

test('TC-001 semantics cannot change even when the real owner explicitly permits user-case changes',()=>fixture({casesTransform:c=>c.cases[0].expected=['Weakened assertion']},f=>{
 assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_case_semantics'});
}));

test('saved disk/status/archive drift and session SHA mismatch remain rejected',()=>{
 for(const edit of [f=>fs.appendFileSync(path.join(f.plan.specsDir,f.plan.feature,'tasks.md'),'\nChanged after save'),
  f=>{const file=path.join(f.plan.specsDir,'.cm-specs-status'),v=JSON.parse(fs.readFileSync(file));v.revisionDigest='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(v));},
  f=>fs.appendFileSync(path.join(f.plan.specsDir,f.saved.archive),' '),
  f=>fs.appendFileSync(f.plan.proposal.file.path,' ')]){
  fixture({},f=>{edit(f);assert.throws(()=>assertSavedSplitProposal(f.plan));});
 }
});


test('TC-010 only replaces the parent responsibility and all other cases remain unchanged',()=>{
 fixture({},f=>{assert.deepEqual(f.newCases.cases.find(c=>c.id==='TC-010').taskIds,['T-003','T-004a','T-004b','T-004c']);assertSavedSplitProposal(f.plan);});
 fixture({casesTransform:c=>c.cases.find(c=>c.id==='TC-010').taskIds=['T-004a']},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_case_responsibility'}));
 fixture({casesTransform:c=>c.cases.find(c=>c.id==='TC-002').steps=['Different requirement']},f=>assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_case_semantics'}));
});

test('unique short file references normalize to the original path without broad matching',()=>fixture({tasksTransform:t=>t.replaceAll('mobile/src/ui/','').replaceAll('mobile/src/__tests__/','')},f=>{
 assert.deepEqual(assertSavedSplitProposal(f.plan).children,['T-004a','T-004b','T-004c']);
}));


test('missing child responsibility fields have a stable blocked code',()=>fixture({},f=>{
 for(const edit of [p=>p.children[0]=null,p=>delete p.children[1].paths,p=>delete p.children[2].tests]){const plan=copy(f.plan);edit(plan);assert.throws(()=>assertSavedSplitProposal(plan),{code:'split_proposal_plan'});}
}));

test('historical children are rejected before preparation or registration writes',()=>{
 for(const ids of [['T-004a'],['T-004b'],['T-004c'],['T-004a','T-004b','T-004c']]){
  fixture({tasksTransform:text=>ids.reduce((value,id)=>value.replace(`${id}: [NEW v3]`,
   `${id}: [NEW v3] ${ids.length===1?'[DROPPED]':'[DROPPED v3: historical child]'}`),text)},f=>{
   assert.equal(f.saved.status,'awaiting_review');assert.equal(f.providerCalls,0);
   const parsed=parseFeatureTaskText(f.newTasks,{strictTaskIds:true});assert.equal(parsed.error,undefined);
   assert.deepEqual(parsed.tasks.filter(t=>ids.includes(t.id)).map(t=>({id:t.id,completed:t.completed,dropped:t.dropped})),
    ids.map(id=>({id,completed:false,dropped:true})));
   const execution=path.join(f.plan.specsDir,'.reviews','.execution');
   const parent=path.join(execution,f.plan.parent.runId,'state.json'),before=fs.readFileSync(parent),entries=fs.readdirSync(execution).sort();
   assert.throws(()=>assertSavedSplitProposal(f.plan),{code:'split_proposal_child_pending'});
   const preparation=prepareReviewOnlySplit(f.plan);assert.equal(preparation.accepted,false);
   assert.ok(preparation.blockers.some(b=>b.code==='split_proposal_child_pending'));
   assert.throws(()=>registerReviewOnlySplit(f.plan),{code:'split_preflight_failed'});
   assert.ok(fs.readFileSync(parent).equals(before));assert.deepEqual(fs.readdirSync(execution).sort(),entries);
   for(const child of f.plan.children)assert.equal(fs.existsSync(path.join(execution,child.runId)),false);
  });
 }
});
