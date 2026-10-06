// Synthetic control-flow fixtures, not proof of a model's semantic judgement
// or production token/time savings. No classifier or provider is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {checkPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
import {savePrdDesign,savePrdDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {claimPrdReview,recordPrdReview} from './cm-prd-review-gate.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {loadConfig,resolveRole,runtimePreset} from './cm-workflow-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceCases={schemaVersion:'1.0',feature:'list',cases:['Render list','Confirm deletion','Style feedback'].map((title,i)=>({
  id:`TC-00${i+1}`,origin:'user',kind:'logic',blocking:true,acIds:[`AC-00${i+1}`],taskIds:['T-001'],
  title,preconditions:['Local fixture'],steps:[title],expected:[`${title} works`],cleanup:['Restore fixture']}))};
const documents=()=>[
  {path:'requirements.md',content:'## 功能需求\n1. [F-001] Reversible list feedback\n'+sourceCases.cases.map(c=>`- [ ] [${c.acIds[0]}] ${c.expected[0]}`).join('\n')},
  {path:'design.md',content:'## 方案摘要\nLocal list component, one reversible objective.\n## 接口契约\nListView remains unchanged.'}];
const draft=(tasks='- [ ] T-001: List feedback ~15min',mapping=['T-001','T-001','T-001'])=>({
  status:'draft',summary:'Synthetic task boundaries',features:[{name:'list',testCasesReason:null,
    documents:[...documents(),{path:'tasks.md',content:tasks},{path:'test-cases.json',content:JSON.stringify({
      ...sourceCases,cases:sourceCases.cases.map((c,i)=>({...c,taskIds:[mapping[i]]}))})}]}]});
function checked(payload,failed=null){
  return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
    checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:id===failed?'failed':'passed',
      evidence:[id===failed?'Synthetic boundary finding: authentication and local list changes have independent rollback.':'Synthetic context reference']}))}))};
}
function fixture(t,text='Local list feedback, one verifiable reversible objective.'){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-task-grouping-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),text);
  const cases=path.join(dir,'user-cases.md');fs.writeFileSync(cases,JSON.stringify(sourceCases));
  const config=path.join(dir,'.cm-workflow.json');fs.writeFileSync(config,JSON.stringify({
    version:1,...runtimePreset('claude-codes'),policies:{generate_cases:false}}));
  const configBytes=fs.readFileSync(config),caseBytes=fs.readFileSync(cases);
  const input={skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir,cases};
  const calls=[];
  const make=({generate,checkContext=async payload=>checked(payload),restored=null}={})=>createCmPrdAnalysis({
    input,runtime:'codex',restored,record:async()=>{},
    analyze:async payload=>{calls.push('analyze');assert.deepEqual(payload.sources.userCases.content,caseBytes.toString());
      return {status:'analyzed',summary:text,sourcePaths:['docs/input.md',cases],openQuestions:[]};},
    generate:async payload=>{calls.push('generate');assert.deepEqual(payload.role,resolveRole(loadConfig({projectRoot:dir}),'planner','codex'));
      assert.equal(payload.userCases.content,caseBytes.toString());assert.equal(payload.generateCases,false);return generate(payload);},
    checkContext:async payload=>{calls.push('self-check');return checkContext(payload);}});
  const unchanged=()=>{assert.deepEqual(fs.readFileSync(config),configBytes);assert.deepEqual(fs.readFileSync(cases),caseBytes);};
  return {dir,input,calls,make,unchanged};
}
async function review(f,host,inspect){
  savePrdDraft({specs:f.dir,writeEnabled:true,getDraft:()=>host.currentDraftForSave()});
  const prepare=()=>host.prepareReview('split','1.list');
  const original=prepare();
  const result=await runPrdHostReview({specs:f.dir,prepared:original,authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:prepare,signal:new AbortController().signal,review:async payload=>{
      f.calls.push('review');inspect?.(payload);
      return {reviewer:'codex-subagent',contextId:'fresh-reviewer',independent:true,at:'2026-10-06T00:00:00.000Z',
        result:{verdict:'approved',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic scope review'}};
    }});
  assert.equal(result.status,'review_recorded');
  // The durable gate, rather than the supplied synthetic verdict, controls repeats.
  assert.equal((await runPrdHostReview({specs:f.dir,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:prepare,signal:new AbortController().signal,review:async()=>assert.fail('second review')})).status,'review_existing');
  assert.equal(prepare().packageDigest,original.packageDigest);return original;
}

test('first full plan reaches planner and one split review; grouped task retains every user case and AC',async t=>{
  const f=fixture(t);const host=f.make({generate:async payload=>{
    assert.equal(payload.phase,'full_draft');assert.equal(payload.revision,null);
    assert.match(payload.instructions,/FIRST task planning only/);
    assert.match(payload.instructions,/independently verifiable and reversible objective/);return draft();
  }});
  await host.advance('Analyze');assert.equal((await host.plan('First plan')).stage,'draft_ready');
  const planned=host.status().draft;
  assert.deepEqual(planned.mechanicalSelfCheck.features,[{directory:'1.list',tasks:1,acceptanceCriteria:3}]);
  const cases=JSON.parse(planned.features[0].documents.find(d=>d.path==='test-cases.json').content);
  assert.deepEqual(cases,sourceCases);assert.equal(planned.mechanicalSelfCheck.completeSelfCheck,false);
  await host.verify();
  await review(f,host,payload=>{
    assert.match(payload.instructions,/assess submitted task boundaries/);
    assert.match(payload.instructions,/high or unknown risk/);
    assert.match(payload.instructions,/every AC, original test and verification prerequisite retained/);
    assert.equal(payload.authorContextId,'author');assert.equal(payload.mode,'independent');
    assert.deepEqual(payload.package.artifacts.map(a=>a.path).sort(),planned.features[0].documents.map(d=>'1.list/'+d.path).sort());
  });
  assert.deepEqual(f.calls,['analyze','generate','self-check','review']);f.unchanged();
  assert.equal(host.status().completionAuthorized,false);
  assert(!fs.existsSync(path.join(f.dir,'.cm-specs-status')));
});

test('first tasks after accepted design receive the same rules without another design/classifier call',async t=>{
  const f=fixture(t);let generations=0;
  const host=f.make({generate:async payload=>{
    if(++generations===1){assert.equal(payload.phase,'design');assert.doesNotMatch(payload.instructions,/FIRST task planning only/);
      return {status:'design',summary:'Local design',features:[{name:'list',documents:documents()}]};}
    assert.equal(payload.phase,'tasks_after_design');assert.match(payload.instructions,/FIRST task planning only/);
    assert.deepEqual(payload.acceptedDesign.features[0].documents,documents());return draft();
  }});
  await host.advance('Analyze');await host.plan('Design',{designOnly:true});
  const ready=host.status().designDraft;
  host.selectDesignReviews({draftDigest:ready.draftDigest,risks:[{feature:'1.list',signals:{greenfieldAdr:false,
    architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},
    evidence:['Local component; no design-risk trigger']} ]});
  savePrdDesign({specs:f.dir,writeEnabled:true,getDraft:()=>host.currentDesignForSave()});
  await host.plan('First tasks');await host.verify();await review(f,host);
  assert.deepEqual(f.calls,['analyze','generate','generate','self-check','review']);f.unchanged();
});

test('high/unknown-risk boundary rules reach the planner; existing semantic finding blocks review readiness',async t=>{
  const f=fixture(t,'Local list and authentication; another module risk is unknown.');
  const host=f.make({generate:async payload=>{
    assert.match(payload.instructions,/Keep high-risk work, unknown-risk work/);
    assert.match(payload.instructions,/not keyword risk classification or another model call/);
    assert.match(payload.analysis.summary,/authentication.*unknown/);return draft();
  },checkContext:async payload=>checked(payload,'task_boundary_and_existing_asset_overlap')});
  await host.advance('Analyze');await host.plan('Plan with actual boundaries');
  assert.equal(host.status().draft.mechanicalSelfCheck.status,'mechanical_subset_passed');
  assert.equal((await host.verify()).stage,'self_check_failed');
  assert.throws(()=>host.prepareReview('split','1.list'),/prd_review_not_ready/);
  assert.deepEqual(f.calls,['analyze','generate','self-check']);f.unchanged();
});

test('explicit user split reaches planner unchanged; same-component independent tasks and cases remain intact',async t=>{
  const request='Keep rendering and deletion confirmation as independent tasks for different owners.';
  const f=fixture(t,request),tasks='- [ ] T-001: Render and style list\n- [ ] T-002: Confirm deletion';
  const host=f.make({generate:async payload=>{
    assert(payload.userAnswers.some(m=>m.text===request));assert(payload.messages.some(m=>m.text===request));
    assert.match(payload.instructions,/explicit user requests for independent tasks/);return draft(tasks,['T-001','T-002','T-001']);
  }});
  await host.advance(request);await host.plan(request);await host.verify();
  const planned=host.status().draft;assert.equal(planned.mechanicalSelfCheck.features[0].tasks,2);
  assert.equal(planned.features[0].documents.find(d=>d.path==='tasks.md').content,tasks);
  const cases=JSON.parse(planned.features[0].documents.find(d=>d.path==='test-cases.json').content);
  cases.cases.forEach((c,i)=>{const {taskIds,...semantics}=c,{taskIds:old,...original}=sourceCases.cases[i];assert.deepEqual(semantics,original);});
  await review(f,host,payload=>assert.match(payload.instructions,/explicit user independence/));f.unchanged();
});

test('contract-first DAG remains separate; cycles, task cap and lost AC coverage still fail mechanically',async t=>{
  const f=fixture(t),tasks='- [ ] T-001: Freeze interface and throwing placeholder\n- [ ] T-002: Implement interface\n- [ ] T-003: Call interface\n- T-002 依赖 T-001\n- T-003 依赖 T-001';
  const host=f.make({generate:async payload=>{
    assert.match(payload.instructions,/preserve legitimate contract-first tasks and real dependencies/);
    return draft(tasks,['T-001','T-002','T-003']);
  }});
  await host.advance('Analyze');await host.plan('Contract before implementation');
  const planned=host.status().draft;assert.equal(planned.mechanicalSelfCheck.features[0].tasks,3);
  assert.equal(planned.features[0].documents.find(d=>d.path==='tasks.md').content,tasks);
  const changed=structuredClone(planned),task=changed.features[0].documents.find(d=>d.path==='tasks.md');
  task.content+='\n- T-001 依赖 T-002';assert(checkPrdDraftMechanics(changed).findings.some(f=>f.code==='dependencies_invalid'));
  task.content=Array.from({length:16},(_,i)=>`- [ ] T-${String(i+1).padStart(3,'0')}: Independent`).join('\n');
  assert(checkPrdDraftMechanics(changed).findings.some(f=>f.code==='task_limit_exceeded'));
  task.content=tasks;const cases=JSON.parse(changed.features[0].documents.find(d=>d.path==='test-cases.json').content);
  cases.cases.pop();changed.features[0].documents.find(d=>d.path==='test-cases.json').content=JSON.stringify(cases);
  assert(checkPrdDraftMechanics(changed).findings.some(f=>f.code==='acceptance_test_coverage_missing'));f.unchanged();
});

test('existing failed draft and restored revision receive no first-plan regrouping; IDs and bytes survive',async t=>{
  const f=fixture(t);let generations=0;
  const host=f.make({generate:async()=>{generations++;return draft('- [ ] T-001: Existing first\n- [ ] T-002: Existing second',['T-001','T-002','T-001']);},
    checkContext:async payload=>checked(payload,'acceptance_verifiability')});
  await host.advance('Analyze');await host.plan('Original plan');await host.verify();
  const checkpoint=host.checkpoint(),bytes=JSON.stringify(checkpoint);
  const restored=f.make({restored:checkpoint,generate:async payload=>{
    assert.doesNotMatch(payload.instructions,/FIRST task planning only/);assert.equal(payload.revision.round,2);
    assert.equal(JSON.stringify(payload.revision.draft),JSON.stringify(checkpoint.draft));return draft('- [ ] T-001: Existing first\n- [ ] T-002: Existing second',['T-001','T-002','T-001']);
  }});
  assert.equal(JSON.stringify(restored.checkpoint()),bytes);
  await restored.plan('Correct only the finding');
  assert.equal(restored.status().draft.draftDigest,checkpoint.draft.draftDigest);
  assert.equal(JSON.stringify(checkpoint),bytes);assert.equal(generations,1);f.unchanged();
});

test('approved task boundary drift remains blocked and does not rewrite approval or repartition tasks',async t=>{
  const f=fixture(t),feature=path.join(f.dir,'1.list');fs.mkdirSync(feature);
  for(const d of draft().features[0].documents)fs.writeFileSync(path.join(feature,d.path),d.content);
  const file=path.join(f.dir,'.cm-specs-status');fs.writeFileSync(file,JSON.stringify({status:'approved',features:['1.list'],specFiles:buildManifest(f.dir)}));
  const approval=fs.readFileSync(file),options={specsDir:f.dir,codeProject:f.dir};
  assert.equal(inspectCmAiAdmission(options).state,'ready');
  const task=path.join(feature,'tasks.md');fs.appendFileSync(task,'\n- [ ] T-002: Expanded objective');
  const changed=fs.readFileSync(task),blocked=inspectCmAiAdmission(options);
  assert.equal(blocked.state,'blocked');assert.equal(blocked.reason,'spec_drift');
  assert.deepEqual(fs.readFileSync(file),approval);assert.deepEqual(fs.readFileSync(task),changed);f.unchanged();
});

test('old split package instructions/digest survive claimed, r1 and completed gates with zero reviewer calls',async t=>{
  for(const state of ['claimed','r1','completed']){
    const f=fixture(t),raw=draft(),inspected={draftDigest:'a'.repeat(64),features:[{...raw.features[0],directory:'1.list'}]};
    const prepare=()=>preparePrdReview({specs:f.dir,draft:inspected,stage:'split',feature:'1.list'}),ready=prepare();
    assert.equal(ready.reviewPackage.instructions,'Apply original Step 10.6 to the functional requirements, complete task list and selected design sections. Respect prior design review and do not repeat it. No second attempt.');
    fs.mkdirSync(path.join(f.dir,'.reviews'));claimPrdReview({...ready.paths,package_sha256:ready.packageDigest});
    if(state!=='claimed'){
      fs.mkdirSync(path.join(f.dir,'1.list'));for(const doc of raw.features[0].documents)fs.writeFileSync(path.join(f.dir,'1.list',doc.path),doc.content);
      fs.writeFileSync(ready.paths.evidence,'---\nat: 2026-10-06T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.list/tasks.md\n---\nOriginal review');
      if(state==='completed')recordPrdReview({...ready.paths,disposition:'no_findings',finding_count:0,unresolved_count:0,
        artifact:raw.features[0].documents.map(doc=>path.join(f.dir,'1.list',doc.path))});
    }
    assert.equal(prepare().packageDigest,ready.packageDigest);const before=JSON.stringify(prepare());
    const result=await runPrdHostReview({specs:f.dir,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
      revalidate:prepare,signal:new AbortController().signal,review:async()=>assert.fail('old attempt redispatched')});
    assert.equal(result.status,'review_existing');assert.equal(JSON.stringify(prepare()),before);f.unchanged();
  }
});
