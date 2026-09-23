import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {savePrdDesign,savePrdDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {recordPrdHostDisposition,createPrdDispositionOwner} from '../runtime/js/cm-prd/review-disposition.mjs';
import {inspectPrdSplitDesign} from '../runtime/js/cm-prd/split-design.mjs';
import {inspectAcceptedPrdDesign} from '../runtime/js/cm-prd/accepted-design.mjs';
import {createPrdSummaryOwner,publishPrdAwaitingReview,inspectPrdSummaryEvidence} from '../runtime/js/cm-prd/summary.mjs';
import {readPrdSelfCheckRevision} from '../runtime/js/cm-prd/self-check-revision.mjs';
import {checkPrdDraftMechanics,inspectPrdContextCheck} from '../runtime/js/cm-prd/self-check.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {inspectPrdReview} from './cm-prd-review-gate.mjs';
import {assertPrdReviewsSettled,createPrdChange} from '../runtime/js/cm-prd/change.mjs';
import {inspectCmPrdAdmission} from './cm-prd-entry.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const signals=high=>({greenfieldAdr:false,architectureOrDataFlow:high,newRuntimeDependencyOrToolchain:false,
  publicContractDataOrSecurity:false,fiveOrMoreFunctions:false});
const reason='AC-001 cannot be verified: specify the setup command and observable result.';
const checked=({draft},failed=false)=>({draftDigest:draft.draftDigest,features:draft.features.map(f=>({directory:f.directory,
  checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:failed&&id==='acceptance_verifiability'?'failed':'passed',evidence:[failed?reason:'Synthetic code/context inspection']}))}))});
async function fixture(t,{fail=true,lowRisk=false,mechanical=false,allLowRisk=false}={}){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-self-revision-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'docs'));
  fs.writeFileSync(path.join(specs,'docs/input.md'),'Synthetic setup guide');
  const input={skillDir:path.join(root,'skills/cm-prd'),project:specs,specs};
  let transform=value=>value,checkFails=fail,host;
  const options={input,runtime:'codex',record:async()=>{},
    analyze:async()=>({status:'analyzed',summary:'Guide',sourcePaths:['docs/input.md'],openQuestions:[]}),
    checkContext:async payload=>checked(payload,checkFails),generate:async payload=>{
      if(payload.phase==='design')return {status:'design',summary:'Guide design',features:['guide','second'].map(name=>({name,documents:[
        {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
        {path:'design.md',content:'## 方案摘要\nGuide architecture'}]}))};
      return transform({status:'draft',summary:'Tasks',features:payload.acceptedDesign.features.map(f=>({name:f.name,
        testCasesReason:'no_observable_behavior',documents:[...structuredClone(f.documents),{path:'tasks.md',content:mechanical&&payload.revision===null?
          '- [x] T-001: Invalid completed task':'- [ ] T-001: Update guide'}]}))},payload);
    }};
  const review=async(stage,feature='1.guide',finding=false)=>{
    const prepare=()=>host.prepareReview(stage,feature);
    await runPrdHostReview({specs,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
      revalidate:prepare,signal:new AbortController().signal,review:async payload=>({reviewer:'codex-subagent',
        contextId:'reviewer',independent:true,at:'2026-09-08T00:00:00.000Z',result:{verdict:finding?'changes_requested':'approved',
          packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,summary:'Synthetic review',
          findings:finding?[{id:'R1',severity:'P2',path:`${feature}/design.md`,message:'Clarify boundary',evidence:'Fixture'}]:[]}})});
    return inspectPrdFindings({specs,stage,feature});
  };
  const dispose=r=>recordPrdHostDisposition({specs,stage:r.stage,feature:r.feature,packageDigest:r.packageDigest,
    decisions:[],artifacts:r.reviewedArtifacts,writeEnabled:true});
  host=createCmPrdAnalysis(options);await host.advance('Analyze');await host.plan('Design',{designOnly:true});
  savePrdDesign({specs,writeEnabled:true,getDraft:()=>host.currentDesignForSave()});
  host.selectDesignReviews({draftDigest:host.status().designDraft.draftDigest,risks:['1.guide','2.second'].map(feature=>({feature,
    signals:signals(!allLowRisk&&(!lowRisk||feature==='2.second')),evidence:['Synthetic risk assessment']}))});
  for(const feature of ['1.guide','2.second'])if(!allLowRisk&&(!lowRisk||feature==='2.second'))dispose(await review('design',feature));
  const designCheckpoint=host.checkpoint();await host.plan('Tasks');
  if(!mechanical)await host.verify();
  const failed=host.checkpoint();
  return {specs,input,options,review,dispose,designCheckpoint,failed,get host(){return host;},
    transform:fn=>{transform=fn;},pass:()=>{checkFails=false;},restore:(state=host.checkpoint())=>{host=createCmPrdAnalysis({...options,restored:state});return host;},
    save:()=>savePrdDraft({specs,writeEnabled:true,getDraft:()=>host.currentDraftForSave({selfCheckRevisionSave:true}),
      getSelfCheckRevision:()=>host.checkpoint().selfCheckRevision??null,onSelfCheckRevisionSaved:()=>host.acceptSelfCheckRevisionSave()})};
}
function revise(f,files=['requirements.md','design.md'],withReason=true){
  f.transform(raw=>{for(const doc of raw.features[0].documents)if(files.includes(doc.path))doc.content+='\nSpecify setup command and expected output.';
    if(withReason)raw.selfCheckRevisionReason=reason;return raw;});
}
async function regenerate(f){revise(f);await f.host.plan('Repair unverifiable AC');f.pass();await f.host.verify();return f;}
async function finish(f,{correct=false}={}){
  f.save();
  for(const feature of ['1.guide','2.second']){
    const prepared=f.host.prepareReview('split',feature);
    if(feature==='1.guide'&&f.host.checkpoint().selfCheckRevision){
      assert.equal(prepared.reviewPackage.selfCheckRevision.reason,reason);
      for(const doc of prepared.reviewPackage.selfCheckRevision.documents)assert.equal(sha(doc.content),
        prepared.reviewPackage.artifacts.find(a=>a.path===`${feature}/${doc.path}`).sha256);
    }
    const r=await f.review('split',feature,correct&&feature==='1.guide');
    if(correct&&feature==='1.guide'){
      const file=path.join(f.specs,feature,'design.md');fs.appendFileSync(file,'\nSplit correction');
      const args={specs:f.specs,stage:'split',feature,packageDigest:r.packageDigest,writeEnabled:true,
        decisions:[{id:'R1',status:'applied',evidence:['Boundary corrected'],changedPaths:[`${feature}/design.md`]}],
        artifacts:r.reviewedArtifacts.map(a=>a.path===`${feature}/design.md`?{...a,sha256:sha(fs.readFileSync(file))}:a)};
      const owner=createPrdDispositionOwner({validateCurrent:value=>f.host.validateCurrent(value),checkContext:async payload=>checked(payload)});
      assert.equal((await owner(args,new AbortController().signal)).status,'disposition_recorded');
    }else f.dispose(r);
  }
}
test('F3 deadlock chain: failed AC can regenerate before split or prepare_revision',async t=>{
  const f=await fixture(t);assert.equal(f.host.status().stage,'self_check_failed');
  assert.throws(()=>f.host.prepareReview('split','1.guide'),/prd_review_not_ready/);
  assert.throws(()=>assertPrdReviewsSettled(f.specs,['1.guide','2.second'],{requireSplit:true}),/prd_revision_original_split_required/);
  // Main refused this repair with prd_accepted_design_rewritten (before the reason field existed).
  revise(f,['requirements.md']);
  assert.equal((await f.host.plan(reason)).stage,'draft_ready');
});
for(const [label,files,lowRisk,mechanical] of [
  ['requirements',['requirements.md'],false,false],['design',['design.md'],false,false],
  ['both',['requirements.md','design.md'],false,false],['low-risk',['requirements.md','design.md'],true,false],
  ['mechanical',['requirements.md'],false,true],
])test(`self-check revision end to end: ${label}`,async t=>{
  const f=await fixture(t,{lowRisk,mechanical});revise(f,files);
  const oldReceipts=['guide','second'].flatMap(name=>{const file=path.join(f.specs,`.reviews/prd-${name}-design-disposition.json`);
    return fs.existsSync(file)?[[file,fs.readFileSync(file)]]:[];});
  const oldFailure={round:1,draftDigest:f.failed.draft.draftDigest,mechanical:f.failed.draft.mechanicalSelfCheck,contextCheck:f.failed.contextCheck};
  await f.host.plan('Repair the failed self-check');
  const checkpoint=f.host.checkpoint(),revision=checkpoint.selfCheckRevision;
  assert.equal(revision.reason,reason);assert.equal(revision.round,2);
  assert.deepEqual(revision.failedSelfCheck,oldFailure);assert.equal(revision.failedSelfCheckDigest,digest(oldFailure));
  assert.deepEqual(checkpoint.selfCheckHistory,[oldFailure]);assert.equal(checkpoint.selfCheckRound,2);
  assert.deepEqual(revision.features[0].changedFiles,files);
  for(const doc of revision.features[0].documents)assert.equal(doc.sha256,sha(doc.content));
  assert.deepEqual(f.restore(checkpoint).checkpoint(),checkpoint);f.pass();await f.host.verify();
  assert.throws(()=>f.host.prepareReview('split','1.guide'),/prd_self_check_revision_save_required/);
  assert.equal(f.save().status,'draft_saved');assert.equal(f.save().status,'draft_saved');
  for(const doc of f.host.status().draft.features[0].documents)assert.equal(fs.readFileSync(path.join(f.specs,'1.guide',doc.path),'utf8'),doc.content);
  await finish(f,{correct:true});assert.equal(f.save().status,'draft_saved');
  assert.throws(()=>inspectPrdSplitDesign({specs:f.specs,feature:'1.guide',draftDigest:'0'.repeat(64),
    originalSha:sha(f.failed.acceptedDesign.features[0].documents[1].content),
    requirementsSha:sha(f.failed.acceptedDesign.features[0].documents[0].content)}),/prd_split_design_binding_changed/);
  assert.doesNotThrow(()=>f.host.validateCurrent());assert.doesNotThrow(()=>f.restore().validateCurrent());
  const summary=await createPrdSummaryOwner({summarize:async({evidenceDigest})=>({evidenceDigest,deliveryForm:'Guide',estimatedTime:'Unknown',
    openQuestions:'None',risks:'Synthetic risk',contextScope:'Two features',platformReadiness:'Fixture',uiBaseline:'None',
    designRisk:['1.guide','2.second'].map(feature=>({feature,signals:signals(!lowRisk||feature==='2.second'),evidence:['Fixture']}))})})(f.specs,{currentFeatures:['1.guide','2.second']});
  assert.equal(summary.readyForAwaitingReview,true);
  assert.match(summary.details.risks,/1\.guide.*整稿自检失败.*设计审查后/);
  assert.ok(summary.details.risks.includes(reason));for(const file of files)assert.ok(summary.details.risks.includes(file));
  assert.match(summary.details.risks,/拆分审查.*未另做设计审查/);assert.doesNotMatch(summary.details.risks,/2\.second.*整稿自检失败/);
  assert.equal(publishPrdAwaitingReview({specs:f.specs,summary,writeEnabled:true}).status,'awaiting_review');
  f.host.validateCurrent();assertPrdReviewsSettled(f.specs,['1.guide','2.second'],{requireSplit:true});
  assert.doesNotThrow(()=>createPrdChange({admission:inspectCmPrdAdmission(f.input),runtime:'codex',call:async()=>{},
    selected:['1.guide','2.second'],reason:'Human requested revision'}));
  for(const [file,bytes] of oldReceipts)assert.deepEqual(fs.readFileSync(file),bytes);
});
test('self-check revision requires actual failure and a nonempty reason',async t=>{
  const first=await fixture(t);first.restore(first.designCheckpoint);revise(first);
  await assert.rejects(first.host.plan('Tasks with unauthorized changes'),/prd_accepted_design_rewritten/);
  for(const value of [undefined,'','   ']){
    const f=await fixture(t);revise(f,['requirements.md'],false);
    const edit=raw=>{raw.features[0].documents[0].content+='\nVerifiable command';if(value!==undefined)raw.selfCheckRevisionReason=value;return raw;};f.transform(edit);
    await assert.rejects(f.host.plan('Repair'),/prd_self_check_revision_reason_required/);
  }
});
for(const mode of ['add-feature','remove-feature','add-file','remove-file'])test(`self-check revision refuses scope change: ${mode}`,async t=>{
  const f=await fixture(t);f.transform(raw=>{
    raw.selfCheckRevisionReason=reason;raw.features[0].documents[0].content+='\nVerifiable command';
    if(mode==='add-feature')raw.features.push({...raw.features[1],name:'third'});
    if(mode==='remove-feature')raw.features.pop();
    if(mode==='add-file')raw.features[0].documents.push({path:'extra.md',content:'Extra'});
    if(mode==='remove-file')raw.features[0].documents.pop();return raw;
  });await assert.rejects(f.host.plan('Repair'),/prd_accepted_design_scope_changed/);
});
test('self-check revision refuses disk drift and rollback beyond recorded shas',async t=>{
  const f=await regenerate(await fixture(t));f.save();
  for(const file of ['requirements.md','design.md']){
    const target=path.join(f.specs,'1.guide',file),good=fs.readFileSync(target);
    for(const content of [good+'\nUnrecorded',f.failed.acceptedDesign.features[0].documents.find(d=>d.path===file).content]){
      fs.writeFileSync(target,content);assert.throws(()=>f.host.validateCurrent());assert.throws(()=>f.host.prepareReview('split','1.guide'));assert.throws(()=>f.save());
    }fs.writeFileSync(target,good);
  }assert.doesNotThrow(()=>f.host.validateCurrent());
});
test('split reviewed pre-revision baseline cannot authorize a self-check revision',async t=>{
  const f=await regenerate(await fixture(t));f.save();
  // A valid independent review archive, but of the wrong requirements/design.
  const revised=f.host.checkpoint(),stale=structuredClone(revised);
  stale.draft.features[0].documents=stale.draft.features[0].documents.map(d=>f.failed.acceptedDesign.features[0].documents.find(old=>old.path===d.path)??d);
  // Preserve the current draft digest to isolate the requirements/design binding.
  const {preparePrdReview}=await import('../runtime/js/cm-prd/review-preparation.mjs');
  const prepared=preparePrdReview({specs:f.specs,draft:stale.draft,stage:'split',feature:'1.guide'});
  await runPrdHostReview({specs:f.specs,prepared,authorContextId:'author',writeEnabled:true,mode:'independent',revalidate:()=>prepared,
    signal:new AbortController().signal,review:async payload=>({reviewer:'codex-subagent',contextId:'reviewer',independent:true,
      at:'2026-09-08T00:00:00.000Z',result:{verdict:'approved',packageDigest:payload.package.packageDigest,
        examinedPaths:payload.examinedPaths,findings:[],summary:'Stale fixture review'}})});
  const review=inspectPrdFindings({specs:f.specs,stage:'split',feature:'1.guide'});
  assert.throws(()=>f.dispose(review),/prd_disposition_artifacts_not_saved|prd_split_design_binding_changed/);
  assert.throws(()=>inspectPrdSplitDesign({specs:f.specs,feature:'1.guide',draftDigest:revised.draft.draftDigest,
    originalSha:sha(f.failed.acceptedDesign.features[0].documents[1].content),requirementsSha:sha(f.failed.acceptedDesign.features[0].documents[0].content)}),/prd_split_design_binding_changed/);
});
test('self-check revision retains the existing two-round limit',async t=>{
  const f=await fixture(t);revise(f);await f.host.plan('Repair');await f.host.verify();
  assert.equal(f.host.status().stage,'self_check_needs_human');assert.equal(f.host.status().selfCheckRound,2);
  const before=f.host.checkpoint();await assert.rejects(f.host.plan('Try a third round'),/prd_planning_not_ready|prd_self_check_round_limit/);
  assert.deepEqual(f.host.checkpoint(),before);
});
test('old checkpoints and unchanged runs preserve exact JSON and receipt bytes',async t=>{
  const f=await fixture(t,{fail:false}),checkpoint=f.host.checkpoint();
  assert.equal(Object.hasOwn(checkpoint,'selfCheckRevision'),false);
  assert.equal(JSON.stringify(f.restore(checkpoint).checkpoint()),JSON.stringify(checkpoint));
  assert.equal(JSON.stringify(inspectAcceptedPrdDesign(f.specs,checkpoint.designDraft,checkpoint.designRiskSelection)),JSON.stringify(checkpoint.acceptedDesign));
  await finish(f);const bytes=fs.readdirSync(path.join(f.specs,'.reviews')).filter(p=>p.endsWith('-disposition.json')).map(p=>[p,fs.readFileSync(path.join(f.specs,'.reviews',p))]);
  f.save();f.host.validateCurrent();assert.equal(JSON.stringify(f.host.checkpoint()),JSON.stringify(checkpoint));
  for(const [file,content] of bytes)assert.deepEqual(fs.readFileSync(path.join(f.specs,'.reviews',file)),content);
  assert.equal(fs.readdirSync(path.join(f.specs,'.reviews')).some(name=>name.includes('self-check-revision')),false);
});

test('self-check revision partial save resumes only the recorded versions',async t=>{
  const f=await regenerate(await fixture(t)),checkpoint=f.host.checkpoint();
  // A crash after the immutable revision archive and one replacement.
  const revision=checkpoint.selfCheckRevision;
  fs.writeFileSync(path.join(f.specs,'.reviews/prd-guide-self-check-revision.json'),JSON.stringify(revision)+'\n',{mode:0o600});
  const first=revision.features[0].documents[0];fs.writeFileSync(path.join(f.specs,'1.guide',first.path),first.content);
  f.restore(checkpoint);assert.throws(()=>f.host.validateCurrent());
  assert.equal(f.save().status,'draft_saved');assert.equal(f.host.checkpoint().selfCheckRevisionSaved,true);
  assert.doesNotThrow(()=>f.restore().validateCurrent());
  // Once saved, deletion cannot turn the old baseline back into authority.
  fs.unlinkSync(path.join(f.specs,'.reviews/prd-guide-self-check-revision.json'));
  assert.throws(()=>f.host.validateCurrent(),/prd_self_check_revision_binding_changed/);
});
test('self-check revision evidence is bound to failure, round, baseline and exact bytes',async t=>{
  const f=await regenerate(await fixture(t)),checkpoint=f.host.checkpoint();f.save();
  const archive=path.join(f.specs,'.reviews/prd-guide-self-check-revision.json'),good=fs.readFileSync(archive);
  for(const field of ['reason','round','failedSelfCheckDigest','acceptedDesignDigest','designDraftDigest','draftDigest']){
    const bad=structuredClone(checkpoint.selfCheckRevision);bad[field]=field==='round'?3:'Changed';
    fs.writeFileSync(archive,JSON.stringify(bad));assert.throws(()=>f.host.validateCurrent(),undefined,field);
  }fs.writeFileSync(archive,good);assert.doesNotThrow(()=>f.host.validateCurrent());
  const saved=f.host.checkpoint();
  for(const alter of [state=>{state.selfCheckHistory=[];},state=>{state.selfCheckRound=1;},
    state=>{delete state.selfCheckRevision;delete state.selfCheckRevisionSaved;}]){
    const bad=structuredClone(saved);alter(bad);f.restore(bad);assert.throws(()=>f.host.validateCurrent());
  }
});

// Read the archive directly through its consumers, without the live analysis
// checkpoint's independent binding checks masking a missing archive guard.
async function assertCraftedRevisionRefused(t,craft,code){
  const f=await regenerate(await fixture(t));await finish(f);
  const checkpoint=f.host.checkpoint(),feature='1.guide';
  const archive=path.join(f.specs,'.reviews/prd-guide-self-check-revision.json'),good=fs.readFileSync(archive);
  const revision=JSON.parse(good),documents=revision.features[0].documents;
  const consumers={
    archive:()=>readPrdSelfCheckRevision(f.specs,feature),
    acceptedDesign:()=>inspectAcceptedPrdDesign(f.specs,checkpoint.designDraft,checkpoint.designRiskSelection,
      {draftDigest:checkpoint.draft.draftDigest}),
    splitBinding:()=>inspectPrdSplitDesign({specs:f.specs,feature,draftDigest:checkpoint.draft.draftDigest,
      originalSha:documents.find(d=>d.path==='design.md').beforeSha256,
      requirementsSha:documents.find(d=>d.path==='requirements.md').beforeSha256}),
    splitPreparation:()=>preparePrdReview({specs:f.specs,draft:checkpoint.draft,stage:'split',feature}),
    summary:()=>inspectPrdSummaryEvidence(f.specs,{currentFeatures:['1.guide','2.second']}),
    gate:()=>inspectPrdReview({stage:'design',feature:'guide',
      evidence:path.join(f.specs,'.reviews/prd-guide-design-r1.md'),
      receipt:path.join(f.specs,'.reviews/prd-guide-design-disposition.json')}),
  };
  for(const [name,consume] of Object.entries(consumers))assert.doesNotThrow(consume,name);
  for(const doc of documents){
    assert.notEqual(doc.sha256,doc.beforeSha256);
    assert.equal(consumers.acceptedDesign().features[0].documents.find(d=>d.path===doc.path).content,doc.content);
  }
  craft(revision);
  // Keep the surrounding digest consistent so that only the targeted guard
  // can refuse this otherwise valid archive and its already reviewed bytes.
  revision.failedSelfCheckDigest=digest(revision.failedSelfCheck);
  fs.writeFileSync(archive,JSON.stringify(revision)+'\n');
  for(const [name,consume] of Object.entries(consumers))assert.throws(consume,{code},name);
  for(const doc of documents)assert.equal(fs.readFileSync(path.join(f.specs,feature,doc.path),'utf8'),doc.content);
  fs.writeFileSync(archive,good);
  for(const [name,consume] of Object.entries(consumers))assert.doesNotThrow(consume,name);
}
test('crafted revision archive with passing self-check is refused by every consumer',async t=>{
  await assertCraftedRevisionRefused(t,revision=>{
    const mechanical=checkPrdDraftMechanics(revision.failedDraft);
    assert.equal(mechanical.status,'mechanical_subset_passed');
    revision.failedDraft.mechanicalSelfCheck=mechanical;
    revision.failedSelfCheck.mechanical=mechanical;
    revision.failedSelfCheck.contextCheck=inspectPrdContextCheck(checked({draft:revision.failedDraft}),revision.failedDraft);
    assert.equal(revision.failedSelfCheck.contextCheck.status,'host_reported_passed');
    assert.ok(revision.failedSelfCheck.contextCheck.features.every(f=>f.checks.every(c=>c.status==='passed')));
  },'prd_self_check_revision_failure_required');
});
for(const [round,failedRound] of [[1,2],[1,1],[2,2],[3,1]])
  test(`crafted revision archive with wrong rounds ${round}/${failedRound} is refused by every consumer`,async t=>{
    await assertCraftedRevisionRefused(t,revision=>{
      assert.equal(revision.failedSelfCheck.contextCheck.status,'failed');
      revision.round=round;revision.failedSelfCheck.round=failedRound;
    },'prd_self_check_revision_invalid');
  });

test('all-low-risk accepted batch can save revisions without a design review directory',async t=>{
  const f=await regenerate(await fixture(t,{allLowRisk:true}));
  assert.equal(fs.existsSync(path.join(f.specs,'.reviews')),false);
  assert.equal(f.save().status,'draft_saved');await finish(f);assert.doesNotThrow(()=>f.host.validateCurrent());
  assert.equal(fs.existsSync(path.join(f.specs,'.reviews/prd-guide-design-r1.md')),false);
});
test('multiple revised features continue after the first completed split correction',async t=>{
  const f=await fixture(t);f.transform(raw=>{
    raw.selfCheckRevisionReason=reason;
    for(const feature of raw.features)for(const doc of feature.documents)if(doc.path!=='tasks.md')doc.content+='\nExact command and result.';
    return raw;
  });await f.host.plan('Repair batch ACs');f.pass();await f.host.verify();await finish(f,{correct:true});
  assert.equal(f.save().status,'draft_saved');assert.doesNotThrow(()=>f.restore().validateCurrent());
  for(const name of ['guide','second'])assert.equal(fs.existsSync(path.join(f.specs,`.reviews/prd-${name}-self-check-revision.json`)),true);
});

test('saving after an unchanged feature split preserves pending revised features',async t=>{
  const f=await regenerate(await fixture(t));f.save();f.dispose(await f.review('split','2.second'));
  assert.equal(f.save().status,'draft_saved');await finish(f);assert.doesNotThrow(()=>f.host.validateCurrent());
});
