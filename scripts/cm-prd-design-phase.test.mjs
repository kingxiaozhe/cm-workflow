import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {inspectPrdDesignDraft} from '../runtime/js/cm-prd/draft.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {savePrdDesign,savePrdDraft,savePrdPromotedDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {inspectPrdDraft} from '../runtime/js/cm-prd/draft.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {inspectPrdSplitDesign} from '../runtime/js/cm-prd/split-design.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {inspectAcceptedPrdDesign} from '../runtime/js/cm-prd/accepted-design.mjs';
import {createPrdSummaryOwner,inspectPrdSummaryEvidence,publishPrdAwaitingReview} from '../runtime/js/cm-prd/summary.mjs';
import {assertPrdReviewsSettled} from '../runtime/js/cm-prd/change.mjs';
import {recordPrdHostDisposition,createPrdDispositionOwner} from '../runtime/js/cm-prd/review-disposition.mjs';
const FIXTURE_TIMEOUT_MS=Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000);
const riskSignals=high=>({greenfieldAdr:false,architectureOrDataFlow:high,newRuntimeDependencyOrToolchain:false,
  publicContractDataOrSecurity:false,fiveOrMoreFunctions:false});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const design=()=>({status:'design',summary:'Synthetic design before tasks',features:[{name:'guide',documents:[
  {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
  {path:'design.md',content:'## 方案摘要\nSynthetic new architecture'}]}]});
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-design-phase-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic architecture requirement');return dir;
}
test('design phase accepts only requirements and design, not premature tasks or unsafe bytes',()=>{
  assert.equal(inspectPrdDesignDraft(design(),{nextIndex:2}).features[0].directory,'2.guide');
  for(const mode of ['tasks','missing','duplicate','surrogate']){
    const raw=design(),docs=raw.features[0].documents;
    if(mode==='tasks')docs.push({path:'tasks.md',content:'Premature task'});
    if(mode==='missing')docs.pop();
    if(mode==='duplicate')raw.features.push(raw.features[0]);
    if(mode==='surrogate')docs[0].content='bad\ud800';
    assert.throws(()=>inspectPrdDesignDraft(raw,{nextIndex:1}));
  }
});
test('design clarification cannot switch to full draft or save before review disposition',async t=>{
  const dir=fixture(t);let calls=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},
    runtime:'codex',record:async()=>{},analyze:async()=>({status:'analyzed',summary:'Architecture',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async payload=>{assert.equal(payload.phase,'design');calls++;
      return calls===1?{status:'question',question:'Choose boundary?'}:design();}});
  await host.advance('Analyze');await host.plan('Design first',{designOnly:true});
  assert.equal(host.status().stage,'awaiting_design_user');
  await assert.rejects(host.plan('Skip to tasks'),/prd_design_phase_required/);
  await host.plan('One boundary',{designOnly:true});
  assert.equal(host.status().stage,'design_ready');assert.equal(host.status().selfCheckRound,0);
  assert.equal(host.status().draft,null);assert.equal(calls,2);
  assert.throws(()=>host.currentDraftForSave());assert.throws(()=>host.prepareReview('split','1.guide'));
  assert.equal(host.prepareReview('design','1.guide').reviewPackage.artifacts.length,2);
  await assert.rejects(host.plan('Tasks before receipt'));
  assert.deepEqual(fs.readdirSync(dir),['docs']);
});
test('promotion rejects conflicting saved files, prior review and exhausted rounds without changing history',async t=>{
  for(const mode of ['saved','review','limit']){
    const dir=fixture(t);
    const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},runtime:'codex',
      record:async()=>{},analyze:async()=>({status:'analyzed',summary:'Fixture',sourcePaths:['docs/input.md'],openQuestions:[]}),
      generate:async()=>({status:'draft',summary:'Original',features:[{...design().features[0],testCasesReason:'no_observable_behavior',
        documents:[...design().features[0].documents,{path:'tasks.md',content:'- [x] T-001: Invalid completed task'}]}]})});
    await host.advance('Analyze');await host.plan('Draft');
    if(mode==='saved'){fs.mkdirSync(path.join(dir,'1.guide'));fs.writeFileSync(path.join(dir,'1.guide/tasks.md'),'Existing user tasks');}
    if(mode==='review'){fs.mkdirSync(path.join(dir,'.reviews'));fs.writeFileSync(path.join(dir,'.reviews/prd-guide-split-dispatch.json'),'Existing attempt');}
    if(mode==='limit')await host.plan('Revise');
    const before=host.status();
    assert.throws(()=>host.promoteDesign({draftDigest:before.draft.draftDigest,reason:'Risk discovered'}));
    assert.deepEqual(host.status(),before);
  }
});
test('saved promotion archives both versions, resumes identically and preserves user conflicts',t=>{
  const dir=fixture(t);fs.mkdirSync(path.join(dir,'.reviews'));
  const make=task=>inspectPrdDraft({status:'draft',summary:'Fixture',features:[{...design().features[0],
    testCasesReason:'no_observable_behavior',documents:[...design().features[0].documents,{path:'tasks.md',content:task}]}]},
  {nextIndex:1,generateCases:true,userCasesProvided:false});
  const original=make('- [ ] T-001: Original'),draft=make('- [ ] T-001: Revised');
  savePrdDraft({specs:dir,writeEnabled:true,getDraft:()=>original});
  const input={specs:dir,writeEnabled:true,getDraft:()=>draft,getOriginal:()=>original};
  assert.throws(()=>savePrdPromotedDraft({...input,writeEnabled:false}));
  assert.equal(savePrdPromotedDraft(input).status,'draft_saved');
  assert.equal(savePrdPromotedDraft(input).status,'draft_saved');
  const task=path.join(dir,'1.guide/tasks.md');fs.writeFileSync(task,'User third version');
  assert.throws(()=>savePrdPromotedDraft(input),/prd_promoted_save_conflict/);
  assert.equal(fs.readFileSync(task,'utf8'),'User third version');
  const archive=fs.readFileSync(path.join(dir,`.reviews/prd-task-revision-${original.draftDigest}.md`),'utf8');
  assert.ok(archive.includes('Original'));assert.ok(archive.includes('Revised'));
});
test('design save uses original conflict and permission checks without accepting task files',t=>{
  const dir=fixture(t),draft=inspectPrdDesignDraft(design(),{nextIndex:1});
  const input={specs:dir,writeEnabled:true,getDraft:()=>draft};
  assert.throws(()=>savePrdDesign({...input,writeEnabled:false}));
  assert.throws(()=>savePrdDraft(input));
  assert.equal(fs.existsSync(path.join(dir,'1.guide')),false);
  assert.equal(savePrdDesign(input).status,'design_saved');
  assert.equal(savePrdDesign(input).status,'design_saved');
  assert.deepEqual(fs.readdirSync(path.join(dir,'1.guide')).sort(),['design.md','requirements.md']);
  const file=path.join(dir,'1.guide/design.md');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  fs.chmodSync(file,0o644);assert.throws(()=>savePrdDesign(input));fs.chmodSync(file,0o600);
  fs.writeFileSync(file,'User change');assert.throws(()=>savePrdDesign(input),/prd_spec_save_conflict/);
  assert.equal(fs.readFileSync(file,'utf8'),'User change');
});
test('late design response cannot erase an existing draft or reset self-check rounds',async t=>{
  const dir=fixture(t);let calls=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},runtime:'codex',
    record:async()=>{},analyze:async()=>({status:'analyzed',summary:'Fixture',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async()=>{
      if(++calls>1)return design();
      return {status:'draft',summary:'Existing failed draft',features:[{...design().features[0],testCasesReason:'no_observable_behavior',
        documents:[...design().features[0].documents,{path:'tasks.md',content:'- [x] T-001: Incorrectly completed task'}]}]};
    }});
  await host.advance('Analyze');await host.plan('Draft');
  assert.equal(host.status().stage,'draft_self_check_failed');const original=host.status().draft;
  await assert.rejects(host.plan('Revise'),/prd_late_design_transition_not_ready/);
  assert.equal(host.status().selfCheckRound,1);assert.deepEqual(host.status().draft,original);
  assert.equal(host.status().designDraft,null);
});
for(const mode of ['saved','rewrite','drift','late-risk','promote','saved-promote','split-correct','split-manual','split-requirements'])test(`actual CLI disposed design to tasks: ${mode}`, {timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const promotes=['promote','saved-promote'].includes(mode),succeeds=['saved','late-risk','promote','saved-promote','split-correct','split-manual','split-requirements'].includes(mode);
  const revisesSplit=mode.startsWith('split-');let splitPackage,pendingSplit,checks=0;
  let originalDigest;
  const dir=fixture(t);fs.mkdirSync(path.join(dir,'mirror'));
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve',
    '--skill-dir',path.join(root,'skills/cm-prd'),'--project',dir,'--specs',dir,'--runtime','codex',
    '--allow-log-write','--allow-spec-write','--allow-review-write','--allow-disposition-write','--host-context','author'],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});let sessionId,stderr='',reviews=0;
  child.stderr.on('data',chunk=>{stderr+=chunk;});const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.requestId==='tasks'&&!succeeds){
        assert.ok(message.error);send({type:'host_close',sessionId});continue;
      }
      assert.equal(message.error,undefined,JSON.stringify(message));
      if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'start',operation:'start',text:'Analyze'});}
      else if(message.type==='host_request'){
        let result;
        if(message.kind==='prd_analyze')result={status:'analyzed',summary:'Architecture',sourcePaths:['docs/input.md'],openQuestions:[]};
        else if(message.kind==='prd_generate'){
          if(message.payload.phase==='design'||message.payload.phase==='full_draft'){
            assert.equal(message.payload.phase,mode==='late-risk'||promotes?'full_draft':'design');
            assert.ok(message.payload.riskDiscovery);result=design();
            if(promotes)result={status:'draft',summary:'Original full draft',features:[{...design().features[0],
              testCasesReason:'no_observable_behavior',documents:[...design().features[0].documents,
                {path:'tasks.md',content:'- [ ] T-001: Original task before risk discovery'}]}]};
          }
          else{
            assert.equal(message.payload.phase,'tasks_after_design');
            assert.equal(message.payload.acceptedDesign.features[0].directory,'1.guide');
            assert.ok(message.payload.acceptedDesign.features[0].documents[1].content.includes('Corrected architecture'));
            result={status:'draft',summary:'Tasks from disposed design',features:message.payload.acceptedDesign.features.map(feature=>({
              name:feature.name,testCasesReason:'no_observable_behavior',documents:[...feature.documents,{path:'tasks.md',content:'- [ ] T-001: Update guide'}]}))};
            if(mode==='rewrite')result.features[0].documents.find(doc=>doc.path==='design.md').content+=' Rewritten';
            if(mode==='drift')fs.writeFileSync(path.join(dir,'1.guide/design.md'),'User changed design');
          }
        }else if(message.kind==='prd_self_check'){
          checks++;const draft=message.payload.draft;
          result={draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
            checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic contextual check']}))}))};
        }
        else if(message.kind==='prd_correct'){
          const correctionPath=mode==='split-requirements'&&message.payload.review.stage==='split'?'1.guide/requirements.md':'1.guide/design.md';
          result={decisions:[{id:'R1',status:'applied',evidence:['Clarified boundary'],changedPaths:[correctionPath]}],
            documents:message.payload.documents.map(item=>({path:item.path,content:item.path===correctionPath?
              (correctionPath.endsWith('/requirements.md')?item.content+'\nFailure scenario: explain invalid setup.':`## 方案摘要\nCorrected architecture boundary${message.payload.review.stage==='split'?' after split':''}`):item.content}))};
        }else if(message.kind==='prd_summary'){
          result={evidenceDigest:message.payload.evidenceDigest,deliveryForm:'Synthetic architecture documentation',
            estimatedTime:'Needs human review',openQuestions:'None in fixture',risks:'Synthetic host responses only',
            contextScope:'One feature',platformReadiness:'Not live verified',uiBaseline:'Not applicable',
            designRisk:[{feature:'1.guide',signals:{greenfieldAdr:false,architectureOrDataFlow:true,
              newRuntimeDependencyOrToolchain:false,publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},
              evidence:['Synthetic new architecture requirement']}]};
        }else{
          assert.equal(message.kind,'prd_review');reviews++;
          const isDesign=message.payload.package.stage==='design';
          if(!isDesign)splitPackage=message.payload.package;
          assert.equal(message.payload.package.stage,reviews===1?'design':'split');
          assert.equal(message.payload.package.artifacts.length,isDesign?2:3);
          result={reviewer:'codex-subagent',contextId:`independent-reviewer-${reviews}`,independent:true,at:'2026-09-08T00:00:00.000Z',
            result:{verdict:isDesign||revisesSplit?'changes_requested':'approved',packageDigest:message.payload.package.packageDigest,
              examinedPaths:message.payload.examinedPaths,findings:isDesign||revisesSplit?[{id:'R1',severity:'P2',message:'Clarify boundary',
                evidence:'Synthetic boundary needs clarification',path:'1.guide/design.md'}]:[],summary:'Synthetic stage review'}};
        }
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
      }else if(message.requestId==='start')send({requestId:'design',operation:mode==='late-risk'||promotes?'advance':'plan_design',text:'Prepare specification'});
      else if(message.requestId==='design'&&promotes){
        assert.equal(message.result.stage,'draft_ready');
        originalDigest=message.result.draft.draftDigest;
        if(mode==='saved-promote')send({requestId:'precheck',operation:'advance',text:'Check original draft'});
        else send({requestId:'promoted',operation:'promote_design',draftDigest:originalDigest,reason:'Discovered architecture boundary'});
      }else if(message.requestId==='precheck'){
        assert.equal(message.result.stage,'self_check_reported_passed');send({requestId:'presave',operation:'save_draft'});
      }else if(message.requestId==='presave'){
        assert.equal(message.result.status,'draft_saved');
        send({requestId:'promoted',operation:'promote_design',draftDigest:originalDigest,reason:'Discovered architecture boundary'});
      }else if(['design','promoted'].includes(message.requestId)){
        assert.equal(message.result.stage,'design_ready');
        if(promotes)assert.equal(message.result.draft.summary,'Original full draft');else assert.equal(message.result.draft,null);
        assert.equal(message.result.selfCheckRound,promotes?1:0);
        send({requestId:'select',operation:'select_design_reviews',draftDigest:message.result.designDraft.draftDigest,
          risks:[{feature:'1.guide',signals:riskSignals(true),evidence:['Synthetic architecture scope']}]});
      }else if(message.requestId==='select'){
        assert.equal(message.result.designRiskSelection.risks.length,1);
        send({requestId:'save',operation:'save_design'});
      }else if(message.requestId==='save'){
        assert.equal(message.result.status,'design_saved');
        assert.equal(message.result.artifacts.length,2);
        send({requestId:'review',operation:'final_review',stage:'design',feature:'1.guide',mode:'independent'});
      }else if(message.requestId==='review'){
        assert.equal(message.result.reviewState.status,'review_recorded');
        send({requestId:'correct',operation:'correct_findings',stage:'design',feature:'1.guide'});
      }else if(message.requestId==='correct'){
        assert.equal(message.result.status,'correction_saved');
        send({requestId:'dispose',operation:'review_disposition',stage:'design',feature:'1.guide',
          packageDigest:message.result.packageDigest,decisions:message.result.decisions,artifacts:message.result.artifacts});
      }else if(message.requestId==='dispose'){
        assert.equal(message.result.status,'disposition_recorded');assert.equal(message.result.gate.outcome,'completed');
        send({requestId:'tasks',operation:'advance',text:'Generate tasks from disposed design'});
      }else if(message.requestId==='tasks'){
        if(promotes){
          assert.equal(message.result.selfCheckRound,2);assert.equal(message.result.selfCheckHistory.length,1);
        }
        assert.equal(message.result.stage,'draft_ready');send({requestId:'check',operation:'advance',text:'Check tasks'});
      }else if(message.requestId==='check'){
        assert.equal(message.result.stage,'self_check_reported_passed');send({requestId:'save-tasks',operation:'save_draft'});
      }else if(message.requestId==='save-tasks'){
        assert.equal(message.result.status,'draft_saved');
        send({requestId:'split',operation:'final_review',stage:'split',feature:'1.guide',mode:'independent'});
      }else if(message.requestId==='split'){
        assert.equal(message.result.reviewState.status,'review_recorded');
        if(mode==='split-manual'){
          const content='## 方案摘要\nManual split architecture correction';fs.writeFileSync(path.join(dir,'1.guide/design.md'),content);
          pendingSplit={packageDigest:splitPackage.packageDigest,decisions:[{id:'R1',status:'applied',evidence:['Manual saved correction'],changedPaths:['1.guide/design.md']}],
            artifacts:splitPackage.artifacts.map(a=>a.path==='1.guide/design.md'?{...a,sha256:sha(content)}:a)};
        }
        send({requestId:'split-findings',operation:'review_findings',stage:'split',feature:'1.guide',...(pendingSplit??{})});
      }else if(message.requestId==='split-findings'){
        if(mode==='split-correct'||mode==='split-requirements'){
          send({requestId:'split-corrected',operation:'correct_findings',stage:'split',feature:'1.guide'});continue;
        }
        if(!revisesSplit)assert.deepEqual(message.result.findings,[]);
        send({requestId:'split-dispose',operation:'review_disposition',stage:'split',feature:'1.guide',
          packageDigest:message.result.packageDigest,decisions:[],artifacts:message.result.reviewedArtifacts,...(pendingSplit??{})});
      }else if(message.requestId==='split-corrected'){
        assert.equal(message.result.status,'correction_saved');pendingSplit={packageDigest:message.result.packageDigest,decisions:message.result.decisions,artifacts:message.result.artifacts};
        send({requestId:'split-reread',operation:'review_findings',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='split-reread'){
        assert.equal(message.result.status,'review_findings_ready');
        send({requestId:'split-dispose',operation:'review_disposition',stage:'split',feature:'1.guide',...pendingSplit});
      }else if(message.requestId==='split-dispose'){
        assert.equal(message.result.gate.outcome,'completed');
        send(revisesSplit?{requestId:'split-resaved',operation:'save_draft'}:{requestId:'summary',operation:'prepare_summary'});
      }else if(message.requestId==='split-resaved'){
        assert.equal(message.result.status,'draft_saved');assert.equal(checks,2);
        send({requestId:'summary',operation:'prepare_summary'});
      }else if(message.requestId==='summary'){
        assert.equal(message.result.readyForAwaitingReview,true);
        assert.deepEqual(message.result.blockers,[]);
        assert.equal(message.result.features[0].reviews.design.gate.outcome,'completed');
        assert.equal(message.result.features[0].reviews.split.gate.outcome,'completed');
        assert.ok(message.result.checklist.every(item=>item.checked===false));
        send({requestId:'publish',operation:'publish_summary',summaryDigest:message.result.summaryDigest});
      }else if(message.requestId==='publish'){
        assert.equal(message.result.status,'awaiting_review');assert.equal(message.result.completionAuthorized,false);
        if(revisesSplit)send({requestId:'revision-ready',operation:'prepare_revision',reason:'Explicit next revision'});else send({type:'host_close',sessionId});
      }else if(message.requestId==='revision-ready'){
        assert.equal(message.result.mode,'change');assert.equal(message.result.stage,'ready');send({type:'host_close',sessionId});
      }
    }
    const [code]=await closed;assert.equal(code,0,stderr);assert.equal(reviews,succeeds?2:1);
    assert.ok(fs.existsSync(path.join(dir,'.reviews/prd-guide-design-r1.md')));
    assert.deepEqual(fs.readdirSync(path.join(dir,'1.guide')).sort(),succeeds?
      ['design.md','requirements.md','tasks.md']:['design.md','requirements.md']);
    assert.equal(fs.existsSync(path.join(dir,'.cm-specs-status')),succeeds);
    if(succeeds){
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.cm-specs-status'),'utf8')).status,'awaiting_review');
      assert.equal(fs.readFileSync(path.join(dir,'1.guide/tasks.md'),'utf8'),'- [ ] T-001: Update guide');
      if(mode==='saved-promote'){
        const archived=fs.readFileSync(path.join(dir,`.reviews/prd-task-revision-${originalDigest}.md`),'utf8');
        assert.ok(archived.includes('Original task before risk discovery'));assert.ok(archived.includes('Update guide'));
      }
    }
  }finally{lines.close();if(child.exitCode===null)child.kill();await closed;}
});
test('mixed-risk features keep one batch and dispatch design only for high risk',async t=>{
  const dir=fixture(t);let generation=0,reviews=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},runtime:'codex',
    record:async()=>{},analyze:async()=>({status:'analyzed',summary:'Mixed needs',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async payload=>{
      generation++;
      if(generation===1){const raw=design();raw.features.push({...design().features[0],name:'copy'});return raw;}
      assert.equal(payload.acceptedDesign.features.length,2);
      return {status:'draft',summary:'Mixed tasks',features:payload.acceptedDesign.features.map(feature=>({name:feature.name,
        testCasesReason:'no_observable_behavior',documents:[...feature.documents,{path:'tasks.md',content:'- [ ] T-001: Update guide'}]}))};
    }});
  await host.advance('Analyze');await host.plan('Design',{designOnly:true});
  const value={draftDigest:host.status().designDraft.draftDigest,risks:[
    {feature:'1.guide',signals:riskSignals(true),evidence:['New architecture']},
    {feature:'2.copy',signals:riskSignals(false),evidence:['Existing text-only module']}]};
  assert.throws(()=>host.selectDesignReviews({...value,risks:value.risks.slice(0,1)}));
  host.selectDesignReviews(value);assert.throws(()=>host.selectDesignReviews(value));
  assert.throws(()=>host.prepareReview('design','2.copy'),/prd_low_risk_design_review_not_required/);
  savePrdDesign({specs:dir,writeEnabled:true,getDraft:()=>host.currentDesignForSave()});
  await assert.rejects(host.plan('Tasks before high risk disposition'));
  const prepare=()=>host.prepareReview('design','1.guide');
  await runPrdHostReview({specs:dir,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:prepare,signal:new AbortController().signal,review:async payload=>{reviews++;
      return {reviewer:'codex-subagent',contextId:'reviewer',independent:true,at:'2026-09-08T00:00:00.000Z',
        result:{verdict:'approved',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic'}};}});
  const review=inspectPrdFindings({specs:dir,stage:'design',feature:'1.guide'});
  recordPrdHostDisposition({specs:dir,stage:'design',feature:'1.guide',packageDigest:review.packageDigest,
    decisions:[],artifacts:review.reviewedArtifacts,writeEnabled:true});
  assert.equal((await host.plan('Tasks now')).stage,'draft_ready');assert.equal(reviews,1);
  assert.deepEqual(host.status().draft.features.map(feature=>feature.directory),['1.guide','2.copy']);
  assert.equal(fs.existsSync(path.join(dir,'.reviews/prd-copy-design-dispatch.json')),false);
  assert.equal(fs.existsSync(path.join(dir,'.reviews/prd-copy-design-r1.md')),false);
});

// Real design receipt -> full draft -> split finding, unlike split-only fixtures.
const sha=content=>createHash('sha256').update(content).digest('hex');
const checked=({draft})=>({draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
  checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic context check']}))}))});
async function splitDesignFixture(t,{split=true,featureName='guide',document='design.md',batch=false,lowRisk=false}={}){
  const specs=fixture(t),input={skillDir:path.join(root,'skills/cm-prd'),project:specs,specs};
  const options={input,runtime:'codex',record:async()=>{},checkContext:async payload=>checked(payload),
    analyze:async()=>({status:'analyzed',summary:'Fixture',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async payload=>payload.phase==='design'?{...design(),features:[{...design().features[0],name:featureName},...(batch?[{...design().features[0],name:'second'}]:[])]}:
      {status:'draft',summary:'Accepted tasks',features:payload.acceptedDesign.features.map(f=>({name:f.name,
        testCasesReason:'no_observable_behavior',documents:[...f.documents,{path:'tasks.md',content:'- [ ] T-001: Update guide'}]}))}};
  let host=createCmPrdAnalysis(options);const feature=`1.${featureName}`;
  const review=async(stage,target=feature)=>{
    const prepare=()=>host.prepareReview(stage,target);
    await runPrdHostReview({specs,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
      revalidate:prepare,signal:new AbortController().signal,review:async payload=>({reviewer:'codex-subagent',
        contextId:'reviewer',independent:true,at:'2026-09-08T00:00:00.000Z',result:{verdict:stage==='split'?'changes_requested':'approved',
          packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,summary:'Synthetic review',
          findings:stage==='split'?[{id:'R1',severity:'P2',path:`${target}/${document}`,message:'Clarify specification',evidence:'Synthetic boundary'}]:[]}})});
    return inspectPrdFindings({specs,stage,feature:target});
  };
  await host.advance('Analyze');await host.plan('Design',{designOnly:true});
  savePrdDesign({specs,writeEnabled:true,getDraft:()=>host.currentDesignForSave()});
  if(lowRisk)host.selectDesignReviews({draftDigest:host.status().designDraft.draftDigest,risks:host.status().designDraft.features.map(f=>({feature:f.directory,signals:riskSignals(f.directory!==feature),evidence:['Fixture risk basis']}))});
  for(const f of host.status().designDraft.features){
    if(lowRisk&&f.directory===feature)continue;
    const designReview=await review('design',f.directory);
    recordPrdHostDisposition({specs,stage:'design',feature:f.directory,packageDigest:designReview.packageDigest,
      decisions:[],artifacts:designReview.reviewedArtifacts,writeEnabled:true});
  }
  await host.plan('Tasks');await host.verify();
  savePrdDraft({specs,writeEnabled:true,getDraft:()=>host.currentDraftForSave()});
  const baseline=host.checkpoint();const findings=split?await review('split'):null;
  const content=document==='design.md'?'## 方案摘要\nSplit correction of architecture':design().features[0].documents[0].content+'\nFailure scenario: explain invalid setup.';
  const args=findings?{specs,stage:'split',feature,packageDigest:findings.packageDigest,writeEnabled:true,
    decisions:[{id:'R1',status:'applied',evidence:['Corrected original split finding'],changedPaths:[`${feature}/${document}`]}],
    artifacts:findings.reviewedArtifacts.map(item=>item.path===`${feature}/${document}`?{...item,sha256:sha(content)}:{...item})}:null;
  return {specs,host,baseline,args,content,feature,review,edit:()=>fs.writeFileSync(path.join(specs,feature,document),content),
    restore:()=>createCmPrdAnalysis({...options,restored:baseline})};
}
test('split design correction recovers an already edited run and reaches save summary publication and revision',async t=>{
  const f=await splitDesignFixture(t);f.edit();
  // Existing checkpoint predates the manual edit; no new state migration or regeneration.
  const host=f.restore();
  assert.throws(()=>host.currentDraftForSave(),/prd_design_receipt_changed|PRD review artifact changed after disposition/);
  assert.throws(()=>recordPrdHostDisposition(f.args),/prd_disposition_split_self_check_required/);
  let checks=0;
  const dispose=createPrdDispositionOwner({checkContext:async payload=>{checks++;return checked(payload);}});
  assert.equal((await dispose(f.args,new AbortController().signal)).status,'disposition_recorded');assert.equal(checks,1);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.specs,'.reviews/prd-guide-split-disposition.json')));
  assert.equal(receipt.artifacts.find(a=>a.path.endsWith('/design.md')).sha256,sha(f.content));
  assert.equal(savePrdDraft({specs:f.specs,writeEnabled:true,getDraft:()=>host.currentDraftForSave()}).status,'draft_saved');
  assert.doesNotThrow(()=>inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft));
  assert.equal(host.prepareReview('split',f.feature).packageDigest,f.args.packageDigest);
  assert.deepEqual(host.checkpoint(),f.baseline);
  assert.doesNotThrow(()=>inspectPrdFindings({specs:f.specs,stage:'design',feature:f.feature}));
  const owner=createPrdSummaryOwner({summarize:async({evidenceDigest})=>({evidenceDigest,deliveryForm:'Guide',estimatedTime:'Unknown',
    openQuestions:'None',risks:'Synthetic',contextScope:'One feature',platformReadiness:'Fixture',uiBaseline:'None',
    designRisk:[{feature:f.feature,signals:riskSignals(true),evidence:['Architecture']} ]})});
  const summary=await owner(f.specs,{currentFeatures:[f.feature]},new AbortController().signal);
  assert.equal(summary.readyForAwaitingReview,true);
  assert.equal(publishPrdAwaitingReview({specs:f.specs,summary,writeEnabled:true}).status,'awaiting_review');
  assert.doesNotThrow(()=>assertPrdReviewsSettled(f.specs,[f.feature],{requireSplit:true}));
  // Even reverting to the old design receipt is drift after the split receipt.
  fs.writeFileSync(path.join(f.specs,f.feature,'design.md'),f.baseline.acceptedDesign.features[0].documents[1].content);
  assert.throws(()=>host.currentDraftForSave());
  fs.writeFileSync(path.join(f.specs,f.feature,'design.md'),f.content+'\nUnrecorded change');
  assert.throws(()=>host.currentDraftForSave());assert.throws(()=>inspectPrdSummaryEvidence(f.specs));
  assert.throws(()=>assertPrdReviewsSettled(f.specs,[f.feature],{requireSplit:true}));
});
test('split plan rejects undeclared design and incorrect hashes before checking or recording',async t=>{
  for(const mode of ['undeclared','wrong-sha']){
    const f=await splitDesignFixture(t);f.edit();let checks=0;
    if(mode==='undeclared'){f.args.decisions[0].status='escalated';f.args.decisions[0].changedPaths=[];
      f.args.artifacts.find(a=>a.path.endsWith('/design.md')).sha256=sha(f.baseline.acceptedDesign.features[0].documents[1].content);}
    if(mode==='wrong-sha')f.args.artifacts.find(a=>a.path.endsWith('/design.md')).sha256='0'.repeat(64);
    const owner=createPrdDispositionOwner({checkContext:async payload=>{checks++;return checked(payload);}});
    await assert.rejects(owner(f.args,new AbortController().signal),/prd_disposition_artifacts_not_saved/);
    assert.equal(checks,0);assert.equal(fs.existsSync(path.join(f.specs,'.reviews/prd-guide-split-disposition.json')),false);
  }
});
test('design drift before split remains refused and unchanged binding and receipts stay byte identical',async t=>{
  const f=await splitDesignFixture(t,{split:false});
  const file=path.join(f.specs,'.reviews/prd-guide-design-disposition.json'),before=fs.readFileSync(file);
  assert.deepEqual(inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft),f.baseline.acceptedDesign);
  assert.deepEqual(f.restore().checkpoint(),f.baseline);
  assert.equal(savePrdDraft({specs:f.specs,writeEnabled:true,getDraft:()=>f.host.currentDraftForSave()}).status,'draft_saved');
  assert.deepEqual(fs.readFileSync(file),before);
  f.edit();assert.throws(()=>f.host.currentDraftForSave(),/prd_design_receipt_changed|PRD review artifact changed after disposition/);
  assert.throws(()=>f.host.prepareReview('split',f.feature));
});
test('another feature split receipt cannot authorize design bytes',async t=>{
  const f=await splitDesignFixture(t),other=await splitDesignFixture(t,{featureName:'other'});
  other.edit();await createPrdDispositionOwner({checkContext:async payload=>checked(payload)})(other.args,new AbortController().signal);
  f.edit();
  for(const suffix of ['-r1.md','-dispatch.json','-disposition.json'])fs.copyFileSync(
    path.join(other.specs,`.reviews/prd-other-split${suffix}`),path.join(f.specs,`.reviews/prd-guide-split${suffix}`));
  assert.throws(()=>inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft));
  assert.throws(()=>f.host.currentDraftForSave());assert.throws(()=>inspectPrdSummaryEvidence(f.specs));
});

test('pending split tolerance is limited to the exact declared saved plan and original draft',async t=>{
  const f=await splitDesignFixture(t);f.edit();
  assert.doesNotThrow(()=>f.host.validateCurrent(f.args));
  assert.throws(()=>f.host.validateCurrent(),/changed/);
  assert.throws(()=>f.host.prepareReview('split',f.feature),/changed/);
  assert.throws(()=>inspectPrdSummaryEvidence(f.specs),/changed/);
  for(const mode of ['undeclared','missing','sha','package','feature']){
    const pending=structuredClone(f.args);
    if(mode==='undeclared'){pending.decisions[0].changedPaths=[];pending.decisions[0].status='escalated';
      pending.artifacts.find(a=>a.path.endsWith('/design.md')).sha256=sha(f.baseline.acceptedDesign.features[0].documents[1].content);}
    if(mode==='missing')pending.artifacts=pending.artifacts.filter(a=>!a.path.endsWith('/design.md'));
    if(mode==='sha')pending.artifacts.find(a=>a.path.endsWith('/design.md')).sha256='0'.repeat(64);
    if(mode==='package')pending.packageDigest='0'.repeat(64);
    if(mode==='feature')pending.feature='2.guide';
    assert.throws(()=>f.host.validateCurrent(pending),undefined,mode);
  }
  assert.throws(()=>inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft,null,{draftDigest:'0'.repeat(64),pendingSplit:f.args}),
    /prd_split_design_binding_changed/);
  fs.appendFileSync(path.join(f.specs,f.feature,'design.md'),'\nUnplanned edit');
  assert.throws(()=>f.host.validateCurrent(f.args),/prd_disposition_artifacts_not_saved/);
});
for(const mode of ['failed','drift'])test(`disposed-design split self-check cannot be bypassed: ${mode}`,async t=>{
  const f=await splitDesignFixture(t);f.edit();let checks=0;
  const owner=createPrdDispositionOwner({validateCurrent:input=>f.host.validateCurrent(input),checkContext:async payload=>{
    checks++;const result=checked(payload);
    if(mode==='failed')result.features[0].checks[0].status='failed';
    else fs.appendFileSync(path.join(f.specs,f.feature,'design.md'),'\nConcurrent change');
    return result;
  }});
  if(mode==='drift')await assert.rejects(owner(f.args,new AbortController().signal),/prd_disposition_artifacts_not_saved/);
  else assert.equal((await owner(f.args,new AbortController().signal)).status,'disposition_self_check_failed');
  assert.equal(checks,1);assert.equal(fs.existsSync(path.join(f.specs,'.reviews/prd-guide-split-disposition.json')),false);
});
test('unchanged split disposition preserves legacy accepted binding and both receipt bytes',async t=>{
  const f=await splitDesignFixture(t),args=structuredClone(f.args);
  args.decisions[0].status='escalated';args.decisions[0].changedPaths=[];
  args.artifacts.find(a=>a.path.endsWith('/design.md')).sha256=sha(f.baseline.acceptedDesign.features[0].documents[1].content);
  recordPrdHostDisposition(args);
  const paths=['design','split'].map(stage=>path.join(f.specs,`.reviews/prd-guide-${stage}-disposition.json`));
  const before=paths.map(p=>fs.readFileSync(p));
  assert.deepEqual(inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft),f.baseline.acceptedDesign);
  assert.deepEqual(f.host.currentDraftForSave(),f.baseline.draft);
  assert.deepEqual(f.restore().checkpoint(),f.baseline);
  assert.equal(recordPrdHostDisposition(args).status,'disposition_details_need_verification');
  paths.forEach((p,i)=>assert.deepEqual(fs.readFileSync(p),before[i]));
  const requirements=path.join(f.specs,f.feature,'requirements.md');
  fs.writeFileSync(requirements,fs.readFileSync(requirements,'utf8').replace('[ ] [AC-001]','[x] [AC-001]'));
  // Historical summary keeps its original runtime-mark normalization; active
  // design ownership still rejects requirements bytes absent from the receipt.
  assert.equal(inspectPrdSummaryEvidence(f.specs).features[0].reviews.split.gate.runtimeMarksNormalized,true);
  assert.throws(()=>f.host.currentDraftForSave(),/prd_design_requirements_changed/);
});

for(const [label,options] of [
  ['single requirements',{document:'requirements.md'}],
  ['batch requirements',{document:'requirements.md',batch:true}],
  ['mixed-risk low requirements',{document:'requirements.md',batch:true,lowRisk:true}],
  ['mixed-risk low design',{document:'design.md',batch:true,lowRisk:true}],
])test(`split document correction continues ${label}`,async t=>{
  const f=await splitDesignFixture(t,options);f.edit();
  // A saved correction and the original checkpoint also model an already stuck run.
  let checks=0;
  const dispose=createPrdDispositionOwner({checkContext:async payload=>{checks++;return checked(payload);}});
  assert.equal((await dispose(f.args,new AbortController().signal)).status,'disposition_recorded');
  assert.equal(checks,1);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.specs,`.reviews/prd-${f.feature.replace(/^\d+\./,'')}-split-disposition.json`)));
  assert.equal(receipt.artifacts.find(a=>a.path===`${f.feature}/${options.document}`).sha256,sha(f.content));
  if(options.batch){
    // F1: current main disposes A, then this preparation fails for B.
    const second=await f.review('split','2.second');
    recordPrdHostDisposition({specs:f.specs,stage:'split',feature:'2.second',packageDigest:second.packageDigest,
      decisions:[{id:'R1',status:'escalated',changedPaths:[],evidence:['Retain for human decision']}],
      artifacts:second.reviewedArtifacts,writeEnabled:true});
  }
  assert.equal(savePrdDraft({specs:f.specs,writeEnabled:true,getDraft:()=>f.restore().currentDraftForSave()}).status,'draft_saved');
  assert.equal(f.host.prepareReview('split',f.feature).packageDigest,f.args.packageDigest);
  assert.deepEqual(f.host.checkpoint(),f.baseline);
  if(!options.lowRisk)assert.equal(preparePrdReview({specs:f.specs,draft:f.baseline.designDraft,stage:'design',feature:f.feature}).gate.outcome,'completed');
  const features=f.baseline.draft.features.map(f=>f.directory);
  const summary=await createPrdSummaryOwner({summarize:async({evidenceDigest})=>({evidenceDigest,deliveryForm:'Guide',
    estimatedTime:'Unknown',openQuestions:'See retained finding',risks:'Fixture',contextScope:'Whole batch',
    platformReadiness:'Fixture',uiBaseline:'None',designRisk:features.map(feature=>({feature,
      signals:riskSignals(!(options.lowRisk&&feature===f.feature)),evidence:['Fixture risk basis']}))})})(f.specs,{currentFeatures:features},new AbortController().signal);
  assert.equal(summary.readyForAwaitingReview,true);
  assert.equal(publishPrdAwaitingReview({specs:f.specs,summary,writeEnabled:true}).status,'awaiting_review');
  assert.doesNotThrow(()=>assertPrdReviewsSettled(f.specs,features,{requireSplit:true}));
  if(options.lowRisk)assert.equal(fs.existsSync(path.join(f.specs,'.reviews/prd-guide-design-r1.md')),false);
  const correctedFile=path.join(f.specs,f.feature,options.document);
  fs.writeFileSync(correctedFile,f.baseline.acceptedDesign.features[0].documents.find(doc=>doc.path===options.document).content);
  assert.throws(()=>f.host.currentDraftForSave());
  fs.writeFileSync(correctedFile,f.content+'\nUnrecorded change');
  assert.throws(()=>f.host.currentDraftForSave());
  assert.throws(()=>inspectPrdSummaryEvidence(f.specs));
});
for(const lowRisk of [false,true])test(`requirements pending tolerance and refusals (low risk ${lowRisk})`,async t=>{
  const f=await splitDesignFixture(t,{document:'requirements.md',batch:lowRisk,lowRisk});f.edit();
  assert.doesNotThrow(()=>f.host.validateCurrent(f.args));
  assert.throws(()=>f.host.validateCurrent(),/prd_design_requirements_changed/);
  assert.throws(()=>f.host.currentDraftForSave());assert.throws(()=>f.host.prepareReview('split',f.feature));
  for(const mode of ['undeclared','sha','package','feature']){
    const pending=structuredClone(f.args);
    if(mode==='undeclared'){pending.decisions[0].status='escalated';pending.decisions[0].changedPaths=[];
      pending.artifacts.find(a=>a.path.endsWith('/requirements.md')).sha256=sha(design().features[0].documents[0].content);}
    if(mode==='sha')pending.artifacts.find(a=>a.path.endsWith('/requirements.md')).sha256='0'.repeat(64);
    if(mode==='package')pending.packageDigest='0'.repeat(64);
    if(mode==='feature')pending.feature='2.second';
    assert.throws(()=>f.host.validateCurrent(pending),undefined,mode);
  }
  assert.throws(()=>recordPrdHostDisposition(f.args),/prd_disposition_split_self_check_required/);
  const failed=await createPrdDispositionOwner({validateCurrent:input=>f.host.validateCurrent(input),checkContext:async payload=>{
    const result=checked(payload);result.features[0].checks[0].status='failed';return result;
  }})(f.args,new AbortController().signal);
  assert.equal(failed.status,'disposition_self_check_failed');
  assert.equal(fs.existsSync(path.join(f.specs,'.reviews/prd-guide-split-disposition.json')),false);
  const before=await splitDesignFixture(t,{split:false,document:'requirements.md',batch:lowRisk,lowRisk});before.edit();
  assert.throws(()=>before.host.currentDraftForSave(),/prd_design_requirements_changed/);
  assert.throws(()=>before.host.prepareReview('split',before.feature));
});
test('another feature split receipt cannot authorize requirements bytes',async t=>{
  const f=await splitDesignFixture(t,{document:'requirements.md'}),other=await splitDesignFixture(t,{featureName:'other',document:'requirements.md'});
  other.edit();await createPrdDispositionOwner({checkContext:async payload=>checked(payload)})(other.args,new AbortController().signal);
  f.edit();
  for(const suffix of ['-r1.md','-dispatch.json','-disposition.json'])fs.copyFileSync(
    path.join(other.specs,`.reviews/prd-other-split${suffix}`),path.join(f.specs,`.reviews/prd-guide-split${suffix}`));
  assert.throws(()=>inspectPrdSplitDesign({specs:f.specs,feature:f.feature,document:'requirements.md',
    originalSha:sha(f.baseline.acceptedDesign.features[0].documents.find(doc=>doc.path==='design.md').content),
    requirementsSha:sha(design().features[0].documents[0].content),draftDigest:f.baseline.draft.draftDigest}));
  assert.throws(()=>f.host.currentDraftForSave());
  assert.throws(()=>inspectAcceptedPrdDesign(f.specs,f.baseline.designDraft));
  assert.throws(()=>inspectPrdSummaryEvidence(f.specs));
});

for(const state of ['completed','pending'])for(const document of ['design.md','requirements.md'])
  test(`same-feature split baseline binding rejects ${document} in ${state} disposition`,async t=>{
    const f=await splitDesignFixture(t,{document});f.edit();
    if(state==='completed')assert.equal((await createPrdDispositionOwner({checkContext:async payload=>checked(payload)})(
      f.args,new AbortController().signal)).status,'disposition_recorded');
    const accepted=f.baseline.acceptedDesign.features[0].documents;
    const input={specs:f.specs,feature:f.feature,document,draftDigest:f.baseline.draft.draftDigest,
      originalSha:sha(accepted.find(doc=>doc.path==='design.md').content),
      requirementsSha:sha(accepted.find(doc=>doc.path==='requirements.md').content),
      pendingSplit:state==='pending'?f.args:null};
    assert.equal(inspectPrdSplitDesign(input),sha(f.content));
    assert.doesNotThrow(()=>f.host.validateCurrent(input.pendingSplit));

    // Only this temporary fixture's split record is rebound to earlier document
    // bytes. Keep feature and draft identity equal, and recompute package/evidence
    // hashes so neither a foreign-feature guard nor a corrupt archive masks the
    // specific reviewed-bytes-to-accepted-baseline check under test.
    const prefix=path.join(f.specs,'.reviews/prd-guide-split');
    const evidence=fs.readFileSync(prefix+'-r1.md','utf8');
    const archive=JSON.parse(evidence.match(/\n```json\n([^\n]+)\n```\n$/)[1]);
    const oldContent=accepted.find(doc=>doc.path===document).content+'\nEarlier run specification.';
    archive.reviewPackage.artifacts.find(item=>item.path===`${f.feature}/${document}`).sha256=sha(oldContent);
    archive.reviewPackage.content[document==='design.md'?'designSummary':'requirementsFunctions']=oldContent;
    const packageDigest=digest(archive.reviewPackage);
    archive.response.result.packageDigest=packageDigest;
    const rebound=evidence.replace(/^package_sha256: .*$/m,`package_sha256: ${packageDigest}`)
      .replace(/\n```json\n[^\n]+\n```\n$/,()=>`\n\`\`\`json\n${JSON.stringify(archive)}\n\`\`\`\n`);
    fs.writeFileSync(prefix+'-r1.md',rebound);
    const dispatch=JSON.parse(fs.readFileSync(prefix+'-dispatch.json','utf8'));
    dispatch.package_sha256=packageDigest;fs.writeFileSync(prefix+'-dispatch.json',JSON.stringify(dispatch)+'\n');
    if(state==='completed'){
      const receipt=JSON.parse(fs.readFileSync(prefix+'-disposition.json','utf8'));
      receipt.evidence_sha256=sha(rebound);fs.writeFileSync(prefix+'-disposition.json',JSON.stringify(receipt)+'\n');
    }
    const pending={...f.args,packageDigest};
    input.pendingSplit=state==='pending'?pending:null;
    const review=inspectPrdFindings({specs:f.specs,stage:'split',feature:f.feature});
    assert.equal(review.gate.outcome,state==='completed'?'completed':'resume_disposition');
    assert.equal(review.packageDigest,packageDigest);assert.equal(review.draftDigest,input.draftDigest);
    for(const doc of accepted)assert.equal(review.reviewedArtifacts.find(item=>item.path===`${f.feature}/${doc.path}`).sha256,
      doc.path===document?sha(oldContent):sha(doc.content));
    assert.notEqual(sha(oldContent),document==='design.md'?input.originalSha:input.requirementsSha);

    const files=[...fs.readdirSync(path.join(f.specs,f.feature)).map(file=>path.join(f.specs,f.feature,file)),
      ...fs.readdirSync(path.join(f.specs,'.reviews')).map(file=>path.join(f.specs,'.reviews',file))];
    const before=files.map(file=>fs.readFileSync(file));
    const mismatch={code:'prd_split_design_binding_changed'};
    assert.throws(()=>inspectPrdSplitDesign(input),mismatch);
    assert.throws(()=>f.host.validateCurrent(input.pendingSplit),mismatch);
    assert.throws(()=>savePrdDraft({specs:f.specs,writeEnabled:true,getDraft:()=>f.host.currentDraftForSave()}),mismatch);
    let checks=0;
    await assert.rejects(createPrdDispositionOwner({validateCurrent:plan=>f.host.validateCurrent(plan),
      checkContext:async payload=>{checks++;return checked(payload);}})(pending,new AbortController().signal),mismatch);
    assert.equal(checks,0);assert.equal(fs.existsSync(prefix+'-disposition.json'),state==='completed');
    assert.equal(fs.existsSync(path.join(f.specs,'.cm-specs-status')),false);
    assert.deepEqual(f.host.checkpoint(),f.baseline);
    files.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),before[index]));
    assert.deepEqual(fs.readdirSync(path.join(f.specs,'.reviews')).sort(),
      files.filter(file=>path.dirname(file)===path.join(f.specs,'.reviews')).map(file=>path.basename(file)).sort());
  });
