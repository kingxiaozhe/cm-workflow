import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {recordPrdHostDisposition,createPrdDispositionOwner} from '../runtime/js/cm-prd/review-disposition.mjs';
import {createPrdCorrectionOwner,inspectPrdCorrectionRecovery,resumePrdCorrection} from '../runtime/js/cm-prd/review-correction.mjs';
import {createPrdSummaryOwner,publishPrdAwaitingReview} from '../runtime/js/cm-prd/summary.mjs';
import {claimPrdReview} from './cm-prd-review-gate.mjs';
const sha=content=>createHash('sha256').update(content).digest('hex');
function fixture(t,{stage='design',finding=false,blocked=false,twoFindings=false}={}){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-disposition-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'.reviews'));
  const feature='1.guide',documents=[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
    {path:'design.md',content:'## 方案摘要\nDocumentation'}, {path:'tasks.md',content:'- [ ] T-001: Guide'}];
  const prepared=preparePrdReview({specs,stage,feature,draft:{draftDigest:'a'.repeat(64),features:[{name:'guide',directory:feature,documents}]}});
  claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
  const findings=finding?[{id:'R1',severity:'P2',path:'1.guide/design.md',message:'Clarify design',evidence:'Synthetic'}]:[];
  if(twoFindings)findings.push({...findings[0],id:'R2',message:'Clarify another decision'});
  publishPrdReview({specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',
    response:{reviewer:'codex-subagent',contextId:'reviewer',independent:true,at:'2026-09-08T00:00:00.000Z',
      result:{verdict:blocked?'blocked':finding?'changes_requested':'approved',packageDigest:prepared.packageDigest,
        examinedPaths:(stage==='design'?documents.slice(0,2):documents).map(item=>`${feature}/${item.path}`).sort(),findings,summary:'Synthetic review'}}});
  const args={specs,stage,feature,packageDigest:prepared.packageDigest,decisions:[],
    artifacts:documents.map(item=>({path:`${feature}/${item.path}`,sha256:sha(item.content)})),writeEnabled:true};
  const save=()=>{fs.mkdirSync(path.join(specs,feature));for(const item of documents)fs.writeFileSync(path.join(specs,feature,item.path),item.content,{mode:0o600});};
  return {args,save,receipt:prepared.paths.receipt};
}
test('no-findings requires saved original artifacts and records only original receipt',t=>{
  const {args,save,receipt}=fixture(t);assert.throws(()=>recordPrdHostDisposition(args),/not_saved/);
  save();const out=recordPrdHostDisposition(args);assert.equal(out.gate.disposition,'no_findings');
  assert.equal(out.completionAuthorized,false);assert.equal(fs.existsSync(path.join(args.specs,'.cm-specs-status')),false);
  const before=fs.readFileSync(receipt);assert.equal(recordPrdHostDisposition(args).outcome,'already_recorded');
  assert.deepEqual(fs.readFileSync(receipt),before);
});
test('applied design maps exact finding and changed artifact to the original r1',t=>{
  const {args,save}=fixture(t,{finding:true});save();
  args.decisions=[{id:'R1',status:'applied',evidence:['Clarified original ambiguity'],changedPaths:['1.guide/design.md']}];
  assert.throws(()=>recordPrdHostDisposition(args),/unaccounted_change/);
  const content='## 方案摘要\nClarified documentation';fs.writeFileSync(path.join(args.specs,'1.guide/design.md'),content);
  args.artifacts.find(item=>item.path==='1.guide/design.md').sha256=sha(content);
  assert.equal(recordPrdHostDisposition(args).gate.disposition,'applied');
});
test('escalated findings remain visible for human decision; blocked and missing coverage cannot record',t=>{
  const {args,save}=fixture(t,{finding:true});save();assert.throws(()=>recordPrdHostDisposition(args),/coverage/);
  args.decisions=[{id:'R1',status:'escalated',evidence:['Requires human decision'],changedPaths:[]}];
  const result=recordPrdHostDisposition(args);assert.equal(result.unresolvedFindings.length,1);
  assert.equal(result.next,'include_unresolved_in_human_summary');
  const blocked=fixture(t,{blocked:true});blocked.save();assert.throws(()=>recordPrdHostDisposition(blocked.args),/review_blocked/);
});
test('write enable and original package identity are required',t=>{
  const {args,save,receipt}=fixture(t);save();
  assert.throws(()=>recordPrdHostDisposition({...args,writeEnabled:false}),/not_enabled/);
  assert.throws(()=>recordPrdHostDisposition({...args,packageDigest:'b'.repeat(64)}),/package_changed/);
  assert.equal(fs.existsSync(receipt),false);
});

test('split no-findings binds all artifacts; applied split waits for the original self-check',t=>{
  const clean=fixture(t,{stage:'split'});clean.save();
  assert.equal(recordPrdHostDisposition(clean.args).gate.disposition,'no_findings');
  assert.equal(JSON.parse(fs.readFileSync(clean.receipt)).artifacts.length,3);
  const {args,save,receipt}=fixture(t,{stage:'split',finding:true});save();
  const content='## 方案摘要\nCorrected design';fs.writeFileSync(path.join(args.specs,'1.guide/design.md'),content);
  args.artifacts.find(item=>item.path==='1.guide/design.md').sha256=sha(content);
  args.decisions=[{id:'R1',status:'applied',evidence:['Synthetic correction'],changedPaths:['1.guide/design.md']}];
  assert.throws(()=>recordPrdHostDisposition(args),/split_self_check_required/);
  assert.equal(fs.existsSync(receipt),false);
});

test('aggregate receipt cannot authenticate swapped per-finding dispositions',t=>{
  const {args,save,receipt}=fixture(t,{finding:true,twoFindings:true});save();
  const content='## 方案摘要\nCorrected documentation';fs.writeFileSync(path.join(args.specs,'1.guide/design.md'),content);
  args.artifacts.find(item=>item.path==='1.guide/design.md').sha256=sha(content);
  args.decisions=[{id:'R1',status:'applied',evidence:['Corrected'],changedPaths:['1.guide/design.md']},
    {id:'R2',status:'escalated',evidence:['Human decision'],changedPaths:[]}];
  assert.equal(recordPrdHostDisposition(args).unresolvedFindings[0].id,'R2');
  const before=fs.readFileSync(receipt);
  args.decisions[0].id='R2';args.decisions[1].id='R1';
  const result=recordPrdHostDisposition(args);
  assert.equal(result.status,'disposition_details_need_verification');
  assert.equal(result.unresolvedFindings,undefined);assert.equal(result.decisions,undefined);
  assert.deepEqual(fs.readFileSync(receipt),before);
});

for(const mode of ['passed','failed','drift','cancelled'])test(`split correction owner: ${mode}`,async t=>{
  const {args,save,receipt}=fixture(t,{stage:'split',finding:true});save();
  const content='## 方案摘要\nCorrected documentation';fs.writeFileSync(path.join(args.specs,'1.guide/design.md'),content);
  args.artifacts.find(item=>item.path==='1.guide/design.md').sha256=sha(content);
  args.decisions=[{id:'R1',status:'applied',evidence:['Synthetic correction'],changedPaths:['1.guide/design.md']}];
  let calls=0;const controller=new AbortController();
  const owner=createPrdDispositionOwner({checkContext:async({draft})=>{
    calls++;
    if(mode==='drift')fs.appendFileSync(path.join(args.specs,'1.guide/tasks.md'),'\nConcurrent edit');
    if(mode==='cancelled')controller.abort();
    return {draftDigest:draft.draftDigest,features:[{directory:'1.guide',checks:draft.mechanicalSelfCheck.pending
      .map(id=>({id,status:mode==='failed'?'failed':'passed',evidence:['Synthetic context check']}))}]};
  }});
  if(['drift','cancelled'].includes(mode))await assert.rejects(owner(args,controller.signal),/not_saved|cancelled/);
  else{
    const result=await owner(args,controller.signal);
    assert.equal(result.status,mode==='passed'?'disposition_recorded':'disposition_self_check_failed');
    assert.equal(result.completionAuthorized,false);
  }
  assert.equal(calls,1);assert.equal(fs.existsSync(receipt),mode==='passed');
  if(mode==='failed')assert.equal((await owner(args,controller.signal)).status,'disposition_self_check_failed');
  assert.equal(calls,1);
  if(mode!=='drift'){
    // Reconstruct crash after durable result but before the original receipt.
    if(mode==='passed')fs.unlinkSync(receipt);
    const moduleUrl=new URL('../runtime/js/cm-prd/review-disposition.mjs',import.meta.url).href;
    const fresh=spawnSync(process.execPath,['--input-type=module','-e',
      `import {createPrdDispositionOwner} from ${JSON.stringify(moduleUrl)}; const owner=createPrdDispositionOwner({checkContext:async()=>{throw Error('must_not_redispatch')}}); process.stdout.write(JSON.stringify(await owner(${JSON.stringify(args)},new AbortController().signal)));`],
      {encoding:'utf8',timeout:5000});
    assert.equal(fresh.status,0,fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).status,mode==='passed'?'disposition_recorded':mode==='failed'?'disposition_self_check_failed':'disposition_self_check_unknown');
  }
});

test('invalid UTF-8 cannot become replacement text in correction self-check',async t=>{
  const {args,save,receipt}=fixture(t,{stage:'split',finding:true});save();
  const bytes=Buffer.from([0xff,0xfe]);fs.writeFileSync(path.join(args.specs,'1.guide/design.md'),bytes);
  args.artifacts.find(item=>item.path==='1.guide/design.md').sha256=sha(bytes);
  args.decisions=[{id:'R1',status:'applied',evidence:['Claimed correction'],changedPaths:['1.guide/design.md']}];
  let calls=0;const owner=createPrdDispositionOwner({checkContext:async()=>{calls++;}});
  await assert.rejects(owner(args,new AbortController().signal),/encoded data was not valid/);
  assert.equal(calls,0);assert.equal(fs.existsSync(receipt),false);
});

for(const mode of ['saved','partial','drift','outside','completed-task','cancelled'])test(`host correction applies original findings: ${mode}`,async t=>{
  const {args,save,receipt}=fixture(t,{stage:'split',finding:true});save();
  const controller=new AbortController();let calls=0;
  const owner=createPrdCorrectionOwner({correct:async({documents})=>{
    calls++;if(mode==='drift')fs.appendFileSync(path.join(args.specs,'1.guide/tasks.md'),'\nUser edit');
    if(mode==='cancelled')controller.abort();
    const output=documents.map(item=>({path:item.path,content:item.content+(item.path.endsWith('design.md')?'\nClarified':'')}));
    if(mode==='partial')output.find(item=>item.path.endsWith('tasks.md')).content+='\nClarified task detail';
    if(mode==='outside')output[0].path='../outside.md';
    if(mode==='completed-task')output.find(item=>item.path.endsWith('tasks.md')).content='- [x] T-001: Guide';
    return {documents:output,decisions:[{id:'R1',status:'applied',evidence:['Clarified'],
      changedPaths:['1.guide/design.md',...(['completed-task','partial'].includes(mode)?['1.guide/tasks.md']:[])]}]};
  }});
  const run=()=>owner({specs:args.specs,stage:'split',feature:'1.guide',writeEnabled:true},controller.signal);
  if(!['saved','partial'].includes(mode))await assert.rejects(run);
  else{
    const result=await run();assert.equal(result.status,'correction_saved');assert.equal(result.completionAuthorized,false);
    assert.match(fs.readFileSync(path.join(args.specs,'1.guide/design.md'),'utf8'),/Clarified/);
    const archive=fs.readFileSync(path.join(args.specs,result.archive),'utf8');assert.match(archive,/"before"/);assert.match(archive,/"decisions"/);
    assert.equal((await run()).status,'correction_recovery_required');assert.equal(calls,1);
    const input={specs:args.specs,stage:'split',feature:'1.guide'};
    assert.equal(inspectPrdCorrectionRecovery(input).states.every(item=>item.status==='matches_correction'),true);
    const original=JSON.parse(archive.match(/\n```json\n([^\n]+)\n```/)[1]);
    const design=original.before.find(item=>item.path==='1.guide/design.md');
    // Reconstruct a crash prefix: archive durable, original design not replaced.
    fs.writeFileSync(path.join(args.specs,design.path),design.content);
    assert.equal(inspectPrdCorrectionRecovery(input).states.some(item=>item.status==='needs_correction'),true);
    assert.throws(()=>resumePrdCorrection({...input,writeEnabled:false},new AbortController().signal),/not_enabled/);
    const moduleUrl=new URL('../runtime/js/cm-prd/review-correction.mjs',import.meta.url).href;
    const fresh=spawnSync(process.execPath,['--input-type=module','-e',
      `import {resumePrdCorrection} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(resumePrdCorrection(${JSON.stringify({...input,writeEnabled:true})},new AbortController().signal)));`],
      {encoding:'utf8',timeout:5000});
    assert.equal(fresh.status,0,fresh.stderr);assert.equal(JSON.parse(fresh.stdout).status,'correction_saved');
    assert.equal(calls,1);assert.match(fs.readFileSync(path.join(args.specs,design.path),'utf8'),/Clarified/);
    fs.appendFileSync(path.join(args.specs,design.path),'\nUser edit');
    assert.throws(()=>inspectPrdCorrectionRecovery(input),/recovery_conflict/);
  }
  assert.equal(fs.existsSync(receipt),false);
});

for(const mode of ['ready','design-required','missing-review','drift'])test(`human summary and awaiting-review boundary: ${mode}`,async t=>{
  const {args,save}=fixture(t,{stage:'split'});save();
  if(mode!=='missing-review')recordPrdHostDisposition(args);
  const owner=createPrdSummaryOwner({summarize:async({evidenceDigest})=>{
    if(mode==='drift')fs.appendFileSync(path.join(args.specs,'1.guide/tasks.md'),'\nUser change');
    return {evidenceDigest,deliveryForm:'Documentation',estimatedTime:'Unknown',openQuestions:'None in fixture',risks:'Synthetic',
      contextScope:'Targeted',platformReadiness:'Not applicable',uiBaseline:'None',designRisk:[{feature:'1.guide',
        signals:{greenfieldAdr:false,architectureOrDataFlow:mode==='design-required',newRuntimeDependencyOrToolchain:false,
          publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},evidence:['Synthetic fixture']}]};
  }});
  if(mode==='drift'){await assert.rejects(owner(args.specs,new AbortController().signal));return;}
  const summary=await owner(args.specs,new AbortController().signal);
  assert.equal(summary.readyForAwaitingReview,mode==='ready');
  const publish=()=>publishPrdAwaitingReview({specs:args.specs,summary,writeEnabled:true});
  if(mode!=='ready')assert.throws(publish,/not_ready/);
  else{
    assert.equal(summary.totals.tasks,1);assert.equal(summary.checklist.every(item=>!item.checked),true);
    assert.throws(()=>publishPrdAwaitingReview({specs:args.specs,summary,writeEnabled:false}),/not_enabled/);
    assert.equal(publish().status,'awaiting_review');
    const status=JSON.parse(fs.readFileSync(path.join(args.specs,'.cm-specs-status')));
    assert.equal(status.status,'awaiting_review');assert.equal(status.specFiles.length,3);
    assert.throws(publish,/inputs_changed/);
  }
});
