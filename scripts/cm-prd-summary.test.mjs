import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {claimPrdReview} from './cm-prd-review-gate.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {recordPrdHostDisposition,createPrdDispositionOwner} from '../runtime/js/cm-prd/review-disposition.mjs';
import {inspectPrdSummaryEvidence,createPrdSummaryOwner,publishPrdAwaitingReview} from '../runtime/js/cm-prd/summary.mjs';
const sha=content=>createHash('sha256').update(content).digest('hex');
function fixture(t,{pendingCorrection=false}={}){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-summary-marks-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'.reviews'));
  const inputs=[];
  for(const feature of ['1.guide','2.appendix']){
    const findings=pendingCorrection&&feature==='1.guide'?[{id:'R1',severity:'P2',path:`${feature}/tasks.md`,
      message:'Clarify task split',evidence:'Synthetic finding'}]:[];
    const documents=[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Read guide'},
      {path:'design.md',content:'## 方案摘要\nDocumentation'}, {path:'tasks.md',content:'- [ ] T-001: Guide'}];
    const prepared=preparePrdReview({specs,stage:'split',feature,draft:{draftDigest:'a'.repeat(64),features:[{name:feature.split('.')[1],directory:feature,documents}]}});
    claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
    publishPrdReview({specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',
      response:{reviewer:'codex-subagent',contextId:'reviewer',independent:true,at:'2026-09-08T00:00:00.000Z',
        result:{verdict:findings.length?'changes_requested':'approved',packageDigest:prepared.packageDigest,examinedPaths:documents.map(item=>`${feature}/${item.path}`).sort(),findings,summary:'Synthetic review'}}});
    fs.mkdirSync(path.join(specs,feature));for(const doc of documents)fs.writeFileSync(path.join(specs,feature,doc.path),doc.content,{mode:0o600});
    const args={specs,stage:'split',feature,packageDigest:prepared.packageDigest,decisions:[],writeEnabled:true,
      artifacts:documents.map(item=>({path:`${feature}/${item.path}`,sha256:sha(item.content)}))};
    if(!findings.length)recordPrdHostDisposition(args);inputs.push(args);
  }
  const mark=()=>{for(const name of ['requirements.md','tasks.md']){
    const file=path.join(specs,'1.guide',name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('[ ]','[x]'));
  }};
  return {specs,mark,inputs};
}
test('summary includes completed historical feature and exact new feature with runtime metadata',async t=>{
  const {specs,mark}=fixture(t),before=inspectPrdSummaryEvidence(specs);mark();
  const evidence=inspectPrdSummaryEvidence(specs);
  assert.equal(evidence.features.length,2);assert.deepEqual(evidence.specFiles,before.specFiles);
  assert.equal(evidence.features[0].reviews.split.gate.runtimeMarksNormalized,true);
  assert.equal(evidence.features[0].reviews.split.gate.outcome,'completed');
  assert.equal(evidence.features[1].reviews.split.gate.runtimeMarksNormalized,undefined);
  assert.equal(evidence.features[1].reviews.split.gate.outcome,'completed');
  assert.notDeepEqual(evidence.evidenceFiles,before.evidenceFiles,'publication still binds raw source bytes');
  const owner=createPrdSummaryOwner({summarize:async({evidence,evidenceDigest})=>({evidenceDigest,
    deliveryForm:'Documentation',estimatedTime:'Unknown',openQuestions:'None in fixture',risks:'Synthetic',
    contextScope:'Targeted',platformReadiness:'Not applicable',uiBaseline:'None',designRisk:evidence.features.map(item=>({feature:item.directory,
      signals:{greenfieldAdr:false,architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},
      evidence:['Synthetic documentation fixture']}))})});
  const summary=await owner(specs,new AbortController().signal);
  assert.equal(summary.status,'human_summary_prepared');
  assert.equal(summary.readyForAwaitingReview,false);
  assert.deepEqual(summary.blockers,['mechanical_self_check_failed']);
  assert.deepEqual(summary.mechanicalSelfCheck.findings,[{feature:'1.guide',code:'new_task_not_pending'}]);
  assert.equal(summary.features[0].reviews.split.gate.runtimeMarksNormalized,true);
  fs.appendFileSync(path.join(specs,'2.appendix/tasks.md'),'\nUser edit');
  assert.throws(()=>inspectPrdSummaryEvidence(specs),/changed after disposition/);
});
test('current draft disposition still requires original raw artifacts, even for completion marks',t=>{
  const {specs,inputs}=fixture(t),file=path.join(specs,'2.appendix/tasks.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('[ ]','[x]'));
  assert.throws(()=>recordPrdHostDisposition(inputs[1]),/prd_disposition_artifacts_not_saved/);
});
test('summary publication refuses runtime mark changes after its exact input snapshot',async t=>{
  const {specs,mark}=fixture(t);
  const evidence=inspectPrdSummaryEvidence(specs);mark();
  // A stale publication remains invalid even when the old receipt can now be read.
  assert.throws(()=>publishPrdAwaitingReview({specs,writeEnabled:true,summary:{status:'human_summary_prepared',
    readyForAwaitingReview:true,blockers:[],evidenceDigest:digest(evidence)}}),/prd_summary_inputs_changed/);
});

function summaryOwner(){
  return createPrdSummaryOwner({summarize:async({evidence,evidenceDigest})=>({evidenceDigest,
    deliveryForm:'Documentation',estimatedTime:'Unknown',openQuestions:'None in fixture',risks:'Synthetic',
    contextScope:'Targeted',platformReadiness:'Not applicable',uiBaseline:'None',
    designRisk:evidence.features.filter(item=>!item.historical).map(item=>({feature:item.directory,
      signals:{greenfieldAdr:false,architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,
        publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},evidence:['Synthetic documentation fixture']}))})});
}
function legacy(specs){
  const prefix=path.join(specs,'.reviews/prd-guide-split');
  for(const suffix of ['-disposition.json','-dispatch.json'])fs.unlinkSync(prefix+suffix);
  const file=prefix+'-r1.md';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\n```json\n[^\n]+\n```\n$/,''));
}
const currentScope={currentFeatures:['2.appendix']};
test('legacy completed history registers notes; current summary publishes the full manifest and recovers',async t=>{
  const {specs,mark}=fixture(t);mark();legacy(specs);
  const evidence=inspectPrdSummaryEvidence(specs,currentScope);
  assert.deepEqual(evidence.features.map(f=>f.historical),[true,false]);
  assert.equal(evidence.documents.length,2);assert.equal(evidence.specFiles.length,6);
  assert.equal(evidence.features[0].reviews.split.archive,'legacy_format');
  assert.equal(evidence.features[0].reviews.split.gate.outcome,'resume_disposition');
  assert.deepEqual(evidence.mechanical.features.map(f=>f.directory),['2.appendix']);
  const summary=await summaryOwner()(specs,currentScope);
  assert.equal(summary.status,'human_summary_prepared');assert.equal(summary.readyForAwaitingReview,true);
  assert.deepEqual(summary.blockers,[]);assert.deepEqual(summary.currentFeatures,['2.appendix']);
  assert.match(summary.notes.join('\n'),/历史 feature 1.guide.*旧版归档.*无处置回执.*已登记未重审/);
  assert.equal(summary.historicalSummary,'历史 feature：1 个已登记，1 个含旧版归档说明');
  assert.equal(summary.totals.tasks,1);
  const result=publishPrdAwaitingReview({specs,summary,writeEnabled:true});
  assert.equal(result.status,'awaiting_review');
  const status=JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-status'),'utf8'));
  assert.deepEqual(status.features,['1.guide','2.appendix']);assert.deepEqual(status.specFiles,evidence.specFiles);
  assert.equal(publishPrdAwaitingReview({specs,summary,writeEnabled:true,recover:true}).status,'awaiting_review');
});
test('current missing disposition remains a blocker',async t=>{
  const {specs}=fixture(t);fs.unlinkSync(path.join(specs,'.reviews/prd-appendix-split-disposition.json'));
  const summary=await summaryOwner()(specs,currentScope);
  assert.equal(summary.readyForAwaitingReview,false);
  assert.deepEqual(summary.blockers,['2.appendix: split_review_disposition_required']);
});
test('current completed task still fails new draft mechanics',async t=>{
  const {specs}=fixture(t),file=path.join(specs,'2.appendix/tasks.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('[ ]','[x]'));
  const summary=await summaryOwner()(specs,currentScope);
  assert.equal(summary.readyForAwaitingReview,false);
  assert.deepEqual(summary.mechanicalSelfCheck.findings,[{feature:'2.appendix',code:'new_task_not_pending'}]);
});
test('unscoped calls and current legacy archives retain strict failure',t=>{
  const {specs,mark}=fixture(t);mark();legacy(specs);
  assert.throws(()=>inspectPrdSummaryEvidence(specs),/prd_review_archive_unavailable/);
  assert.throws(()=>inspectPrdSummaryEvidence(specs,{currentFeatures:undefined}),/prd_review_archive_unavailable/);
  assert.throws(()=>inspectPrdSummaryEvidence(specs,{currentFeatures:['1.guide']}),/prd_review_archive_unavailable/);
});
test('historical receipt coverage is a note; current coverage remains strict',async t=>{
  const {specs}=fixture(t),file=path.join(specs,'.reviews/prd-guide-split-disposition.json');
  const receipt=JSON.parse(fs.readFileSync(file,'utf8'));receipt.artifacts.pop();fs.writeFileSync(file,JSON.stringify(receipt));
  const summary=await summaryOwner()(specs,currentScope);
  assert.equal(summary.readyForAwaitingReview,true);assert.match(summary.notes.join('\n'),/prd_summary_receipt_coverage/);
  assert.equal(summary.features[0].reviews.split.archive,'unavailable');
  assert.throws(()=>inspectPrdSummaryEvidence(specs,{currentFeatures:['1.guide']}),/prd_summary_receipt_coverage/);
});
test('historical readable review missing receipt is registered without blocking',async t=>{
  const {specs}=fixture(t);fs.unlinkSync(path.join(specs,'.reviews/prd-guide-split-disposition.json'));
  const summary=await summaryOwner()(specs,currentScope);
  assert.equal(summary.readyForAwaitingReview,true);assert.equal(summary.features[0].reviews.split.archive,'receipt_missing');
});
test('scoped publication still rejects historical changes after preparation',async t=>{
  const {specs}=fixture(t);legacy(specs);const summary=await summaryOwner()(specs,currentScope);
  fs.appendFileSync(path.join(specs,'1.guide/design.md'),'\nHistorical edit');
  assert.throws(()=>publishPrdAwaitingReview({specs,summary,writeEnabled:true}),/prd_summary_inputs_changed/);
});
test('explicit unknown, empty and duplicate scopes fail closed',t=>{
  const {specs}=fixture(t);
  for(const currentFeatures of [[],['3.missing'],['2.appendix','2.appendix'],null,'2.appendix'])
    assert.throws(()=>inspectPrdSummaryEvidence(specs,{currentFeatures}),/prd_summary_scope_unknown/);
});


for(const extra of ['none','same-feature','other-feature'])test(`failed-check mechanical coverage: ${extra}`,async t=>{
  const {specs,inputs}=fixture(t,{pendingCorrection:true}),args=inputs[0];
  const taskFile=path.join(specs,'1.guide/tasks.md');
  const corrected=Array.from({length:16},(_,i)=>`- [ ] T-${String(i+1).padStart(3,'0')}: Guide step ${i+1}`).join('\n');
  fs.writeFileSync(taskFile,corrected);
  args.artifacts.find(item=>item.path==='1.guide/tasks.md').sha256=sha(corrected);
  args.decisions=[{id:'R1',status:'applied',evidence:['Saved synthetic split correction'],changedPaths:['1.guide/tasks.md']}];
  const disposed=await createPrdDispositionOwner({checkContext:async()=>{assert.fail('mechanical failure must not dispatch a context check');}})(args,new AbortController().signal);
  assert.equal(disposed.gate.disposition,'self_check_failed');
  const recorded=[{feature:'1.guide',code:'task_limit_exceeded'}];
  assert.deepEqual(disposed.mechanicalSelfCheck.findings,recorded);
  const prefix=path.join(specs,'.reviews/prd-guide-split');
  const evidenceFiles=['-disposition.json','-correction-check-start.json','-correction-check-result.json'].map(suffix=>prefix+suffix);
  const before=evidenceFiles.map(file=>fs.readFileSync(file));
  const extraFeature=extra==='same-feature'?'1.guide':'2.appendix';
  if(extra!=='none'){
    // Runtime checkbox normalization keeps the original receipt valid, while
    // the summary's current-draft mechanics must detect this additional failure.
    const file=path.join(specs,extraFeature,'tasks.md');
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('[ ]','[x]'));
  }
  const summary=await summaryOwner()(specs);
  assert.equal(summary.features.every(feature=>feature.reviews.split.gate.outcome==='completed'),true);
  assert.equal(summary.features[1].reviews.split.gate.disposition,'no_findings');
  assert.equal(summary.mechanicalSelfCheck.status,'failed');
  assert.deepEqual(summary.mechanicalSelfCheck.findings,[...recorded,
    ...(extra==='none'?[]:[{feature:extraFeature,code:'new_task_not_pending'}])]);
  assert.deepEqual(summary.riskCard,[{feature:'1.guide',disposition:'self_check_failed',status:'awaiting_human_ruling',failedChecks:recorded}]);
  assert.match(summary.details.risks,/自检失败.*待人工裁决.*task_limit_exceeded/);
  if(extra!=='none')assert.equal(summary.features.find(feature=>feature.directory===extraFeature).reviews.split.gate.runtimeMarksNormalized,true);
  assert.deepEqual(summary.blockers,extra==='none'?[]:['mechanical_self_check_failed']);
  assert.equal(summary.readyForAwaitingReview,extra==='none');
  const publish=()=>publishPrdAwaitingReview({specs,summary,writeEnabled:true});
  if(extra==='none')assert.equal(publish().status,'awaiting_review');
  else{
    assert.throws(publish,/^Error: prd_summary_not_ready$/);
    assert.equal(fs.existsSync(path.join(specs,'.cm-specs-status')),false);
  }
  evidenceFiles.forEach((file,i)=>assert.deepEqual(fs.readFileSync(file),before[i]));
});
