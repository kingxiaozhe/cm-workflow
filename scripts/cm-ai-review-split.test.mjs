import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {splitFixture} from './cm-ai-review-split-fixture.mjs';
import {prepareReviewOnlySplit,registerReviewOnlySplit,inspectReviewOnlySplit,reviewOnlyTask,assertOrdinaryRun} from '../runtime/js/cm-ai/review-only-split.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {assertSupportedResumeHistory,openControlRun} from './cm-ai-run.mjs';
import {matchesCmAiTaskSelection} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {main as splitMain} from './cm-ai-review-split.mjs';
import {main as failoverMain,inspectSpecs} from './cm-failover.mjs';
import {parseFeatureTaskText} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
const copy=v=>JSON.parse(JSON.stringify(v));
function withFixture(fn){const f=splitFixture();try{return fn(f);}finally{f.cleanup();}}
const saved=f=>readExecutionSnapshot({specsRoot:f.plan.specsDir,identity:{repositoryId:'fixture',runId:'parent'}});

test('isolated complete chain keeps original baseline, calls and prefix; three children stop before dispatch',()=>withFixture(f=>{
 const parsed=parseFeatureTaskText(f.newTasks,{strictTaskIds:true});assert.equal(parsed.error,undefined);
 assert.equal(parsed.tasks.length,16);assert.equal(parsed.tasks.filter(t=>!t.dropped).length,15);assert.equal(parsed.tasks.filter(t=>t.dropped).length,1);
 assert.equal(f.proposal.mechanicalSelfCheck.status,'mechanical_subset_passed');assert.equal(f.proposal.counts.preservedCompletedTasks,3);
 assert.deepEqual(f.proposal.mechanicalSelfCheck.features,[{directory:'4.app-warm-frost',tasks:16,acceptanceCriteria:1,executionTasks:15,historicalTasks:1}]);
 for(const line of f.completed)assert.ok(f.proposal.files['4.app-warm-frost/tasks.md'].split('\n').includes(line));
 const {taskIds:oldIds,...oldSemantics}=f.oldCases.cases[0],{taskIds:newIds,...newSemantics}=f.newCases.cases[0];
 assert.deepEqual(oldSemantics,newSemantics);assert.deepEqual(oldIds,['T-004']);assert.deepEqual(newIds,['T-004a','T-004b','T-004c']);
 const preparation=prepareReviewOnlySplit(f.plan);assert.deepEqual(preparation.blockers,[]);assert.equal(preparation.accepted,true);
 const original=copy(f.snapshot.records),result=registerReviewOnlySplit(f.plan);assert.equal(result.stage,'committed');assert.equal(result.parentRecords,4);assert.equal(result.callCount,18);assert.equal(result.newReviewCalls,0);assert.equal(result.newDevelopmentCalls,0);assert.equal(result.dispatchSupported,false);
 assert.deepEqual(saved(f).records.slice(0,2),original);assert.deepEqual(inspectReviewOnlySplit(f.plan).children.map(c=>c.stage),['bound','bound','bound']);
 const second=registerReviewOnlySplit(f.plan);assert.deepEqual(second,result);assert.equal(saved(f).records.length,4);
 for(const c of f.plan.children){const child=readExecutionSnapshot({specsRoot:f.plan.specsDir,identity:{repositoryId:'fixture',runId:c.runId}});assert.equal(child.records.length,1);assert.equal(child.records[0].payload.callAllocation,null);assert.throws(()=>assertOrdinaryRun(child),{code:'review_only_split_no_ordinary_run'});}
 assert.throws(()=>assertOrdinaryRun(saved(f)),{code:'review_only_split_no_ordinary_run'});
 assert.equal(reviewOnlyTask({specsDir:f.plan.specsDir,feature:f.plan.feature,taskId:'T-004a'}),true);
 assert.equal(reviewOnlyTask({specsDir:f.plan.specsDir,feature:f.plan.feature,taskId:'T-004'}),true);
 f.write('specs/4.app-warm-frost/tasks.md',f.newTasks);
 assert.equal(inspectSpecs(f.plan.specsDir).features[0].breakpoint.state,'review_only_split');
 assert.throws(()=>failoverMain(['handoff','--specs',f.plan.specsDir,'--to','codex']),/review_only_split/);
 assert.equal(matchesCmAiTaskSelection({state:'ready',specsDir:f.plan.specsDir,nextTask:{feature:f.plan.feature,id:'T-004a'}},f.plan.feature,'T-004a'),false);
 const file=f.write('plan.json',f.plan);assert.equal(splitMain(['inspect','--plan',file.path]).stage,'committed');
}));

test('pending parent intent resumes idempotently without rewriting earlier history',()=>withFixture(f=>{
 const p=f.plan,splitDigest=digest(p),payload={type:'review-only-split-intent',version:1,splitDigest,parent:p.parent,feature:p.feature,children:p.children.map(c=>({runId:c.runId,taskId:c.taskId})),plan:p};
 const store=openExecutionStore({specsRoot:p.specsDir,identity:{repositoryId:'fixture',runId:'parent'},fingerprints:p.parent.fingerprints,create:false});
 store.append({id:`split-${splitDigest.slice(0,40)}-intent`,kind:'intent',payload,expectedRevision:store.snapshot().revision});store.close();
 const one=p.children[0],two=p.children[1];
 for(const c of [one,two]){
  const child=openExecutionStore({specsRoot:p.specsDir,identity:{repositoryId:'fixture',runId:c.runId},fingerprints:{workflow:digest('cm-review-only-split-v1'),config:digest(p),inputs:digest(c)},create:true});
  if(c===one){const payload={type:'review-only-child',version:1,splitDigest,parent:p.parent,feature:p.feature,taskId:c.taskId,child:c,originalPackage:p.originalPackage,ownershipDigest:digest(p.ownership),manifests:p.manifests,proposal:p.proposal,callAllocation:null,dispatch:'unsupported_requires_separate_authorization_and_adapter'};
   child.append({id:`split-${splitDigest.slice(0,40)}-${c.taskId}`,kind:'result',payload,expectedRevision:child.snapshot().revision});}
  child.close();
 }
 assert.equal(inspectReviewOnlySplit(p).stage,'intent');assert.deepEqual(inspectReviewOnlySplit(p).children.map(c=>c.stage),['bound','initialized','absent']);assert.equal(registerReviewOnlySplit(p).stage,'committed');assert.deepEqual(saved(f).records.slice(0,2),f.snapshot.records);assert.equal(saved(f).records.length,4);
}));

test('stale revision, wrong identity, wrong source, final drift and missing frozen inputs reject without writes',()=>withFixture(f=>{
 for(const mutate of [p=>p.parent.revision='0'.repeat(64),p=>p.parent.taskId='T-999',p=>p.bindings.find(b=>b.role==='source-contract').file=f.plan.bindings.find(b=>b.role==='source-runner').file,
 p=>p.bindings=p.bindings.filter(b=>b.role!=='policy')]){const p=copy(f.plan);mutate(p);assert.equal(prepareReviewOnlySplit(p).accepted,false);assert.throws(()=>registerReviewOnlySplit(p),{code:'split_preflight_failed'});assert.equal(saved(f).records.length,2);}
 fs.appendFileSync(path.join(f.plan.codeProject,f.plan.children[0].paths[0]),'drift');assert.equal(prepareReviewOnlySplit(f.plan).accepted,false);assert.equal(saved(f).records.length,2);
}));

test('unconfirmed proposal and occupied writer reject; no lock or state replacement',()=>withFixture(f=>{
 const p=copy(f.plan),original=fs.readFileSync(p.proposal.file.path),prd=JSON.parse(original);prd.checkpoint.change.confirmation.approved=false;fs.writeFileSync(p.proposal.file.path,JSON.stringify(prd));p.proposal.file=f.ref(p.proposal.file.path);
 assert.equal(prepareReviewOnlySplit(p).accepted,false);
 fs.writeFileSync(p.proposal.file.path,original);
 const store=openExecutionStore({specsRoot:f.plan.specsDir,identity:{repositoryId:'fixture',runId:'parent'},fingerprints:f.plan.parent.fingerprints,create:false});
 try{const blocked=prepareReviewOnlySplit(f.plan);assert.equal(blocked.accepted,false);assert.ok(blocked.blockers.some(b=>b.code==='split_writer_active'));assert.throws(()=>registerReviewOnlySplit(f.plan),{code:'split_preflight_failed'});assert.equal(store.snapshot().records.length,2);}finally{store.close();}
}));

test('reserved child ordinary create is rejected before execution adapter or worker',async()=>{
 const f=splitFixture();try{await assert.rejects(openControlRun({specsDir:f.plan.specsDir,codeProject:f.plan.codeProject,feature:f.plan.feature,identity:{repositoryId:'fixture',runId:f.plan.children[0].runId,taskId:'T-004a',attempt:1}},'create'),{code:'review_only_split_no_ordinary_run'});}finally{f.cleanup();}
});

test('old grant history remains unsupported for ordinary resume',()=>withFixture(f=>{
 const store=openExecutionStore({specsRoot:f.plan.specsDir,identity:{repositoryId:'fixture',runId:'parent'},fingerprints:f.plan.parent.fingerprints,create:false});
 store.append({id:'old-grant',kind:'result',payload:{type:'review-invocation-registered',grant:{}},expectedRevision:store.snapshot().revision});store.close();
 assert.throws(()=>assertSupportedResumeHistory({specsDir:f.plan.specsDir,identity:{repositoryId:'fixture',runId:'parent'}}),{code:'runner_invocation'});
 assert.equal(prepareReviewOnlySplit(f.plan).accepted,false);
}));
