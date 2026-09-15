import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {inspectPrdDesignDraft} from '../runtime/js/cm-prd/draft.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {savePrdDesign,savePrdDraft,savePrdPromotedDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {inspectPrdDraft} from '../runtime/js/cm-prd/draft.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {recordPrdHostDisposition} from '../runtime/js/cm-prd/review-disposition.mjs';
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
for(const mode of ['saved','rewrite','drift','late-risk','promote','saved-promote'])test(`actual CLI disposed design to tasks: ${mode}`, {timeout:15000},async t=>{
  const promotes=['promote','saved-promote'].includes(mode),succeeds=['saved','late-risk','promote','saved-promote'].includes(mode);
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
          const draft=message.payload.draft;
          result={draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
            checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic contextual check']}))}))};
        }
        else if(message.kind==='prd_correct'){
          result={decisions:[{id:'R1',status:'applied',evidence:['Clarified boundary'],changedPaths:['1.guide/design.md']}],
            documents:message.payload.documents.map(item=>({path:item.path,content:item.path==='1.guide/design.md'?
              '## 方案摘要\nCorrected architecture boundary':item.content}))};
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
          assert.equal(message.payload.package.stage,reviews===1?'design':'split');
          assert.equal(message.payload.package.artifacts.length,isDesign?2:3);
          result={reviewer:'codex-subagent',contextId:`independent-reviewer-${reviews}`,independent:true,at:'2026-09-08T00:00:00.000Z',
            result:{verdict:isDesign?'changes_requested':'approved',packageDigest:message.payload.package.packageDigest,
              examinedPaths:message.payload.examinedPaths,findings:isDesign?[{id:'R1',severity:'P2',message:'Clarify boundary',
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
        send({requestId:'split-findings',operation:'review_findings',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='split-findings'){
        assert.deepEqual(message.result.findings,[]);
        send({requestId:'split-dispose',operation:'review_disposition',stage:'split',feature:'1.guide',
          packageDigest:message.result.packageDigest,decisions:[],artifacts:message.result.reviewedArtifacts});
      }else if(message.requestId==='split-dispose'){
        assert.equal(message.result.gate.outcome,'completed');send({requestId:'summary',operation:'prepare_summary'});
      }else if(message.requestId==='summary'){
        assert.equal(message.result.readyForAwaitingReview,true);
        assert.deepEqual(message.result.blockers,[]);
        assert.equal(message.result.features[0].reviews.design.gate.outcome,'completed');
        assert.equal(message.result.features[0].reviews.split.gate.outcome,'completed');
        assert.ok(message.result.checklist.every(item=>item.checked===false));
        send({requestId:'publish',operation:'publish_summary',summaryDigest:message.result.summaryDigest});
      }else if(message.requestId==='publish'){
        assert.equal(message.result.status,'awaiting_review');assert.equal(message.result.completionAuthorized,false);
        send({type:'host_close',sessionId});
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
