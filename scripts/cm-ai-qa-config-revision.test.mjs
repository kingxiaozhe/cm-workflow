import {buildManifest} from './cm-spec-manifest.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {previousQaMaterial,qaRevisionChain} from '../runtime/js/cm-ai/qa-config-revision.mjs';
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-revision-home-'));
const savedEnvironment={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'config');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>{
  for(const [key,value] of Object.entries(savedEnvironment)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  fs.rmSync(isolatedHome,{recursive:true,force:true});
});
const identity={repositoryId:'control-fixture',runId:'control-run',taskId:'T-001',attempt:1};
const request=operation=>({version:1,operation,requestId:operation,identity});
async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-control-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.login';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject,{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.js'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.js'],requirements:['requirements.md']};
  const config=path.join(root,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
  try{await fn({root,specsDir,codeProject,definition,config});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}


async function completed(f,{attach=false,twoAttempts=false}={}){
  const built=buildExecution(f,{twoAttempts}),{execution,configure,qa,counts}=built,provider=execution.qaDecisionProvider;
  if(attach){execution.configuration.workflow.qa=null;delete execution.qaExecutor;delete execution.qaDecisionProvider;}
  let run=await openControlRun(f.definition,'create',execution);
  let result=await run.host.handle(request('advance'));run.close();
  if(attach){
    assert.equal(result.code,'qa_decision_required');configure(qa);execution.qaDecisionProvider=provider;
    run=await openControlRun(f.definition,'resume',execution);result=await run.host.handle(request('advance'));run.close();
  }
  assert.equal(result.code,'qa_result_blocked',JSON.stringify(result));
  assert.equal(result.state,'fixture_completed');
  assert.deepEqual(counts(),{calls:twoAttempts?2:1,reviews:twoAttempts?2:1});
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.login','tasks.md'),'utf8'),/\[x\]/);
  return {execution,configure,qa,counts};
}

function buildExecution(f,{twoAttempts=false}={}){
  let calls=0,reviews=0;
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['main'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async({prompt})=>{
      // Attempt 2 must change the rejected bytes (develop_unchanged_after_review).
      calls++;fs.writeFileSync(path.join(f.codeProject,'a.js'),JSON.parse(prompt.split('<cm-developer-data-json>\n')[1]).identity.attempt===1?'new\n':'new 2\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
    }})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
      allowed:true,available:true,contexts:['review-1','review-2'],run:(request,{onEvent})=>{
        reviews++;
        onEvent({event:'thread.started',provider_thread:`actual-review-${request.identity.attempt}`});
        onEvent({event:'turn.started',item_type:null});
        onEvent({event:'item.completed',item_type:'agent_message'});
        onEvent({event:'turn.completed',item_type:null});
        onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
        const verdict=twoAttempts&&request.identity.attempt===1?'changes_requested':'approved';
        return {status:'succeeded',value:{verdict,packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:verdict==='approved'?[]:
            [{id:'F1',severity:'P2',path:'a.js',message:'Review again',evidence:'Synthetic first attempt'}],summary:'Synthetic review'}};
      }}],
    reviewInvocation:{developerThreadId:'host-author',excludedThreadIds:['main'],
      authorize:(request,{authorizationAt})=>{
        const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.identity.attempt}`,adapterId:'codex-review-adapter',
          invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,
          reviewerId:'reviewer',logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
          hostContextId:'main',decisionId:`decision-${request.identity.attempt}`,decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
        return {...body,grantDigest:digest(body)};
      }},
    hostDecision:{status:'approved'},
    check:createHostCheck({cwd:f.codeProject,commands:[{id:'content',command:[process.execPath,'-e',
      "require('node:assert/strict').match(require('node:fs').readFileSync('a.js','utf8'),/^new( 2)?\\n$/)"]}]})};

  const qa={commands:[],environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}};
  execution.configuration={kind:'synthetic-host-v1',hostContextId:'main',workflow:{qa,documentationPaths:[],applicableAgentFiles:[]}};
  execution.qaLogHome=path.join(f.root,'logs');
  execution.qaDecisionProvider={timeoutMs:1000,decide:async binding=>({decisionId:'host-qa',identity:binding.identity,
    packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-07T20:00:00Z'})};
  const configure=qa=>{
    execution.configuration.workflow.qa=qa;
    execution.qaExecutor=createHostQaExecutor({codeProject:f.codeProject,specsDir:f.specsDir,feature:'1.login',
      requirements:['requirements.md'],runtime:'codex',...qa,timeoutMs:60000,logHome:execution.qaLogHome});
  };
  configure(qa);
  return {execution,configure,qa,counts:()=>({calls,reviews})};
}

test('F7 probe: completed N5 plus commands-unavailable has no existing resume exit',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f);
  const state=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')));
  const reports=fs.readdirSync(path.join(f.specsDir,'.reviews')).filter(p=>p.endsWith('-execution.md'));
  assert.equal(reports.length,1);assert.match(fs.readFileSync(path.join(f.specsDir,'.reviews',reports[0]),'utf8'),/commands-unavailable/);
  let run=await openControlRun(f.definition,'resume',execution,{rerunBlockedQa:true});
  const blocked=await run.host.handle(request('advance'));run.close();
  assert.equal(blocked.code,'qa_rerun_not_blocked_by_evidence');
  configure({...qa,commands:[{id:'syntax',command:[process.execPath,'--check','a.js'],caseIds:[]}]});
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'fingerprint_mismatch'});
  await assert.rejects(openControlRun(f.definition,'resume',execution,{rerunBlockedQa:true}),{code:'fingerprint_mismatch'});
  run=await openControlRun({...f.definition,identity:{...identity,runId:'replacement'}},'create',execution);
  assert.equal(run.blocked.state,'complete');run.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json'))),state);
  console.log('F7 probe: commands-unavailable -> qa_rerun_not_blocked_by_evidence; fixed config -> fingerprint_mismatch; new run -> admission complete');
}));

const statePath=f=>path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
const snapshot=f=>JSON.parse(fs.readFileSync(statePath(f)));
const fixedQa=qa=>({...qa,commands:[{id:'version',command:[process.execPath,'--version'],caseIds:[]}]});
const revision=qa=>({qaConfigRevision:{previousWorkflow:{qa,documentationPaths:[],applicableAgentFiles:[]},reason:'Correct missing project QA command'}});

for(const missingMirror of [false,true])test(`progress R1: resume/status preserves a newer task card while replaying QA revision; missingMirror=${missingMirror}`,()=>fixture(async f=>{
  const {writeStatusProjection}=await import('../runtime/js/cm-ai/status-projection.mjs');
  const {execution,configure,qa,counts}=await completed(f);configure(fixedQa(qa));
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  const log=path.join(f.specsDir,'运行日志.jsonl');
  if(missingMirror)fs.writeFileSync(log,fs.readFileSync(log,'utf8').split('\n')
    .filter(line=>!line||JSON.parse(line).reason!=='qa_configuration_revision').join('\n'));
  writeStatusProjection({specsDir:f.specsDir,feature:'2.newer',identity:{...identity,runId:'newer-run',taskId:'T-002'},
    node:'N3',state:'checking',detail:'newer task checking',claim:true});
  const statusPath=path.join(f.specsDir,'.cm-status.json'),before=fs.readFileSync(statusPath),journal=fs.readFileSync(statePath(f));
  run=await openControlRun(f.definition,'resume',execution);
  try{
    assert.deepEqual(fs.readFileSync(statusPath),before,'opening the old owner must not claim the newer card');
    assert.equal((await run.host.handle(request('status'))).state,'fixture_completed');
    assert.deepEqual(fs.readFileSync(statusPath),before);
  }finally{run.close();}
  assert.deepEqual(fs.readFileSync(statePath(f)),journal);assert.deepEqual(counts(),{calls:1,reviews:1});
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
    .filter(row=>row.reason==='qa_configuration_revision').length,1,'missing history still recovers exactly once');
}));

test('F7 revision resumes N6, preserves N5 and history, replays without authorization flag',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=await completed(f),before=snapshot(f);
  const review=path.join(f.specsDir,'.reviews','login-T-001-r1.md'),receipt=fs.readFileSync(review);
  const log=path.join(f.specsDir,'运行日志.jsonl'),logBefore=fs.readFileSync(log,'utf8');
  configure(fixedQa(qa));
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));
  let result=await run.host.handle(request('advance'));run.close();
  assert.notEqual(result.code,'qa_result_blocked');
  const after=snapshot(f),records=after.records.filter(r=>r.payload.type==='qa-config-revised');
  assert.equal(records.length,1);assert.deepEqual(after.fingerprints,before.fingerprints);
  assert.deepEqual(after.records.slice(0,before.records.length),before.records);
  assert(fs.readFileSync(review).equals(receipt));assert.deepEqual(counts(),{calls:1,reviews:1});
  assert(fs.readFileSync(log,'utf8').startsWith(logBefore));
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.event==='test_run');
  assert.deepEqual(rows.filter(r=>r.phase==='start').map(r=>r.attempt),[1,2]);
  assert.equal(rows.filter(r=>r.phase==='superseded'&&r.reason==='qa_configuration_revision').length,1);
  assert.equal(rows.filter(r=>r.phase==='complete').at(-1).result,'PASS');
  run=await openControlRun(f.definition,'resume',execution);await run.host.handle(request('advance'));run.close();
  assert.deepEqual(snapshot(f),after);
  configure(qa);await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'fingerprint_mismatch'});
}));

test('F7 revision rejects create, missing reason, unrelated drift and exhausted QA budget',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f);configure(fixedQa(qa));
  await assert.rejects(openControlRun(f.definition,'create',execution,revision(qa)),{code:'qa_revision_authorization_required'});
  await assert.rejects(openControlRun(f.definition,'resume',execution,{qaConfigRevision:{...revision(qa).qaConfigRevision,reason:' '}}),{code:'qa_revision_authorization_required'});
  execution.configuration.unrelated='drift';
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'fingerprint_mismatch'});
  delete execution.configuration.unrelated;
  execution.configuration.workflow.documentationPaths=['a.js'];
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'fingerprint_mismatch'});
  execution.configuration.workflow.documentationPaths=[];
  await assert.rejects(openControlRun({...f.definition,scope:['a.js','unrelated.mjs']},'resume',execution,revision(qa)),{code:'fingerprint_mismatch'});
  let prior=qa;
  for(let round=2;round<=3;round++){
    const next={...prior,environment:{...prior.environment,target:`fixture-${round}`}};configure(next);
    const run=await openControlRun(f.definition,'resume',execution,revision(prior));
    assert.equal((await run.host.handle(request('advance'))).code,'qa_result_blocked');run.close();prior=next;
  }
  configure(fixedQa(prior));const before=snapshot(f);
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(prior)),{code:'qa_round_invalid'});
  assert.deepEqual(snapshot(f),before);
}));

test('F7 revision repairs journal-only crash, repeated authorization is idempotent, stale QA is rejected',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f);configure(fixedQa(qa));
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.specsDir,'.cm-status.json'))).state,'qa_pending');
  const saved=snapshot(f),record=saved.records.at(-1).payload.record;
  const log=path.join(f.specsDir,'运行日志.jsonl');
  const {inspectCmAiQaResult}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const binding={specsDir:f.specsDir,feature:'1.login',identity,packageDigest:record.packageDigest,testRunId:record.testRunId};
  assert.throws(()=>inspectCmAiQaResult(binding),{code:'qa_result_superseded'});
  const before=fs.readFileSync(log,'utf8');
  // Actual crash prefix: journal durable, mirror append not yet written.
  fs.writeFileSync(log,before.split('\n').filter(line=>!line||JSON.parse(line).reason!=='qa_configuration_revision').join('\n'));
  run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  assert.deepEqual(snapshot(f),saved);
  assert.throws(()=>inspectCmAiQaResult(binding),{code:'qa_result_superseded'});
  run=await openControlRun(f.definition,'resume',execution);await run.host.handle(request('advance'));run.close();
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(r=>r.reason==='qa_configuration_revision').length,1);
  assert.deepEqual(rows.filter(r=>r.event==='test_run'&&r.phase==='start').map(r=>r.attempt),[1,2]);
}));

test('F7 revision chain rejects forged predecessor, record package and unrecorded config drift',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f);configure(fixedQa(qa));
  const run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  const saved=snapshot(f),{readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const rechain=records=>records.map((r,index)=>{
    const {digest:ignored,...body}=r;body.previousDigest=index?records[index-1].digest:null;
    const next={...body,digest:digest(body)};records[index]=next;return next;
  });
  for(const [field,value,code] of [['fromFingerprint','b'.repeat(64),'qa_revision_chain_invalid'],['packageDigest','b'.repeat(64),'package_mismatch']]){
    const records=structuredClone(saved.records);records.at(-1).payload.record[field]=value;
    assert.throws(()=>readRunnerHistory(rechain(records),saved.records[0].payload.config,3),{code});
  }
  configure({...fixedQa(qa),environment:{...qa.environment,target:'unrecorded'}});
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'fingerprint_mismatch'});
  assert.deepEqual(snapshot(f),saved);
}));

test('F7 CLI requires resume, QA permission, old config and a reason before opening a run',()=>fixture(async f=>{
  const host=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
  const args=['serve','--config',f.config,'--mode','resume','--host-context','main','--allow-development'];
  for(const extra of [['--revise-qa-config','missing.json'],['--qa-config-revision-reason','fix'],
    ['--allow-qa','--revise-qa-config','missing.json'],
    ['--allow-qa','--revise-qa-config','missing.json','--qa-config-revision-reason','fix','--rerun-blocked-qa']]){
    const result=spawnSync(process.execPath,[host,...args,...extra],{encoding:'utf8',input:'',timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/qa_revision_authorization_required/);
  }
}));

test('F7 revision follows qa-attached and can supersede a completed PASS without renewing N5',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=await completed(f,{attach:true});
  const before=snapshot(f),fixed=fixedQa(qa);configure(fixed);
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'fingerprint_mismatch'});
  assert.deepEqual(snapshot(f),before);
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  const changed={...fixed,environment:{...fixed.environment,target:'corrected-environment'},timeoutMs:3000};configure(changed);
  run=await openControlRun(f.definition,'resume',execution,revision(fixed));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  run=await openControlRun(f.definition,'resume',execution);run.close();
  const after=snapshot(f);assert.deepEqual(after.records.slice(0,before.records.length),before.records);
  assert.equal(after.records.filter(r=>r.payload.type==='qa-attached').length,1);
  assert.equal(after.records.filter(r=>r.payload.type==='qa-config-revised').length,2);
  assert.deepEqual(counts(),{calls:1,reviews:1});
}));

test('F7 revision cannot authorize source drift or an unknown QA invocation',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f);configure(fixedQa(qa));
  const before=snapshot(f),source=path.join(f.codeProject,'a.js');
  fs.writeFileSync(source,'drift\n');
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'qa_revision_not_completed'});
  fs.writeFileSync(source,'new\n');
  const log=path.join(f.specsDir,'运行日志.jsonl');
  const lines=fs.readFileSync(log,'utf8').trim().split('\n');
  const last=lines.findLastIndex(line=>{const r=JSON.parse(line);return r.event==='test_run'&&r.phase==='complete';});
  fs.writeFileSync(log,lines.slice(0,last).join('\n')+'\n');
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'qa_result_incomplete'});
  assert.deepEqual(snapshot(f),before);
}));

test('F7 revision binds the completed development attempt independently of the QA round',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=await completed(f,{twoAttempts:true});configure(fixedQa(qa));
  const before=snapshot(f);let run=await openControlRun(f.definition,'resume',execution,revision(qa));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  run=await openControlRun(f.definition,'resume',execution);run.close();
  assert.deepEqual(snapshot(f).records.slice(0,before.records.length),before.records);
  assert.deepEqual(counts(),{calls:2,reviews:2});
}));

test('F7 review R1: QA revision refuses non-QA workflow changes at reconstruction and resume',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f),before=snapshot(f);
  configure(fixedQa(qa));
  execution.configuration.workflow.documentationPaths=['a.js'];
  const options=revision(qa);
  await assert.rejects(async()=>{
    const run=await openControlRun(f.definition,'resume',execution,options);run.close();
  },{code:'fingerprint_mismatch'});
  assert.deepEqual(snapshot(f),before);
  // The original store fingerprint also rejects this resume. Exercise the
  // reconstruction boundary independently so that fallback cannot mask its loss.
  const executor=execution.qaExecutor;
  const material={definition:f.definition,execution:execution.configuration,
    qaDecisionProvider:'host-v1',qaTimeoutMs:execution.qaDecisionProvider.timeoutMs,
    qaExecutor:{version:1,mode:executor.mode,caseCount:executor.caseCount,
      timeoutMs:executor.timeoutMs,configuration:executor.configuration}};
  assert.throws(()=>previousQaMaterial(material,options.qaConfigRevision.previousWorkflow),{code:'fingerprint_mismatch'});
}));

test('F7 review R2: two revisions require strictly increasing QA rounds in both chain readers',()=>fixture(async f=>{
  const {execution,configure,qa}=await completed(f),fixed=fixedQa(qa);
  configure(fixed);
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  configure({...fixed,environment:{...fixed.environment,target:'second-revision'}});
  run=await openControlRun(f.definition,'resume',execution,revision(fixed));run.close();
  const saved=snapshot(f),revisions=saved.records.filter(r=>r.payload.type==='qa-config-revised');
  assert.deepEqual(revisions.map(r=>r.payload.record.qaRound),[1,2]);
  assert(revisions[1].payload.record.qaRound>revisions[0].payload.record.qaRound);
  const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.find(r=>r.event==='test_run'&&r.phase==='complete'&&r.attempt===2)?.result,'PASS');
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  assert.doesNotThrow(()=>qaRevisionChain(saved));
  assert.doesNotThrow(()=>readRunnerHistory(saved.records,saved.records[0].payload.config,3));
  for(const [first,second] of [[1,1],[2,1]]){
    // Mutate only a synthetic in-memory journal. Re-seal it so hash validation
    // does not hide a missing semantic round-order check. Both rounds stay valid.
    const forged=structuredClone(saved),changed=forged.records.filter(r=>r.payload.type==='qa-config-revised');
    changed[0].payload.record.qaRound=first;changed[1].payload.record.qaRound=second;
    for(let i=0;i<forged.records.length;i++){
      const {digest:ignored,...body}=forged.records[i];
      body.previousDigest=i?forged.records[i-1].digest:null;
      forged.records[i]={...body,digest:digest(body)};
    }
    const {revision:ignored,...body}=forged;forged.revision=digest(body);
    assert.throws(()=>qaRevisionChain(forged),{code:'qa_revision_chain_invalid'},`chain rounds ${first} -> ${second}`);
    assert.throws(()=>readRunnerHistory(forged.records,forged.records[0].payload.config,3),
      {code:'qa_revision_chain_invalid'},`replay rounds ${first} -> ${second}`);
  }
  assert.deepEqual(snapshot(f),saved);
}));

test('F7 review R3: normal resume rejects QA and non-QA drift from the recorded chain end',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=await completed(f),fixed=fixedQa(qa);
  configure(fixed);
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  const saved=snapshot(f),log=path.join(f.specsDir,'运行日志.jsonl'),logBefore=fs.readFileSync(log);
  run=await openControlRun(f.definition,'resume',execution);run.close();
  for(const drift of ['qa','non-qa']){
    configure(drift==='qa'?{...fixed,environment:{...fixed.environment,target:'not-the-chain-end'}}:fixed);
    execution.configuration.workflow.documentationPaths=drift==='non-qa'?['a.js']:[];
    await assert.rejects(async()=>{
      const opened=await openControlRun(f.definition,'resume',execution);opened.close();
    },{code:'fingerprint_mismatch'},`${drift} drift must not inherit the recorded revision`);
    assert.deepEqual(snapshot(f),saved);assert(fs.readFileSync(log).equals(logBefore));
  }
  configure(fixed);execution.configuration.workflow.documentationPaths=[];
  run=await openControlRun(f.definition,'resume',execution);run.close();
  assert.deepEqual(counts(),{calls:1,reviews:1});
}));

// #26: a wrong QA configuration found before any QA round ran. The round-0
// revision supersedes nothing, consumes no round and is mirrored once in the log.
const logRows=f=>{const log=path.join(f.specsDir,'运行日志.jsonl');
  return fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse):[];};
const revisedRecords=f=>snapshot(f).records.filter(r=>r.payload.type==='qa-config-revised').map(r=>r.payload.record);
async function stepToFixtureCompleted(f,execution,{qa=true}={}){
  const run=await openControlRun(f.definition,'create',execution);
  const started=await run.host.handle(request('start'));assert.equal(started.state,'awaiting_review',JSON.stringify(started));
  const packageDigest=started.packageDigest;
  assert.equal((await run.host.handle({...request('decision'),packageDigest})).state,'approved');
  assert.equal((await run.host.handle({...request('complete'),packageDigest})).state,'fixture_completed');
  if(qa)assert.equal((await run.host.handle({...request('qa'),packageDigest})).code,'qa_triggered');
  run.close();return packageDigest;
}

test('#26 pre-round revision: run still ready (no package) reaches QA round 1 with the corrected config',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=buildExecution(f);
  let run=await openControlRun(f.definition,'create',execution);run.close();
  // Several corrections may precede the first round; each is a round-0 record.
  const first={...qa,environment:{...qa.environment,target:'first-correction'}};configure(first);
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'fingerprint_mismatch'});
  run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  configure(fixedQa(first));
  run=await openControlRun(f.definition,'resume',execution,revision(first));
  const result=await run.host.handle(request('advance'));run.close();
  assert.equal(result.code,'qa_passed',JSON.stringify(result));
  const records=revisedRecords(f),[record]=records;
  assert.deepEqual(records.map(r=>[r.qaRound,r.testRunId,r.packageDigest]),[[0,null,null],[0,null,null]]);
  assert.equal(record.qaRound,0);assert.equal(record.testRunId,null);assert.equal(record.packageDigest,null);
  const rows=logRows(f),starts=rows.filter(r=>r.event==='test_run'&&r.phase==='start');
  assert.deepEqual(starts.map(r=>[r.attempt,r.previous_test_run_id]),[[1,undefined]]);
  assert.equal(rows.filter(r=>r.phase==='qa_config_revise').length,2);
  assert.deepEqual(counts(),{calls:1,reviews:1});
}));

test('#26 pre-round revision after N5 and a triggered decision keeps round 1; a later revision still consumes one',()=>fixture(async f=>{
  const {execution,configure,qa,counts}=buildExecution(f);
  const packageDigest=await stepToFixtureCompleted(f,execution);
  assert.equal(logRows(f).filter(r=>r.event==='test_run').length,0);
  // Nothing to rerun yet and no recovered timeout decision: the flag is still refused.
  const logBefore=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'));
  let refused=await openControlRun(f.definition,'resume',execution,{rerunBlockedQa:true});
  assert.equal((await refused.host.handle(request('advance'))).code,'qa_rerun_not_blocked_by_evidence');refused.close();
  assert.deepEqual(fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl')),logBefore);
  const fixed=fixedQa(qa);configure(fixed);
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  assert.deepEqual(revisedRecords(f).map(r=>[r.qaRound,r.testRunId,r.packageDigest]),[[0,null,packageDigest]]);
  const moved={...fixed,environment:{...fixed.environment,target:'second-revision'}};configure(moved);
  run=await openControlRun(f.definition,'resume',execution,revision(fixed));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  assert.deepEqual(revisedRecords(f).map(r=>r.qaRound),[0,1]);
  const rows=logRows(f);
  assert.deepEqual(rows.filter(r=>r.event==='test_run'&&r.phase==='start').map(r=>r.attempt),[1,2]);
  assert.deepEqual(rows.filter(r=>r.phase==='superseded').map(r=>[r.reason,r.recovery_rule]),[['qa_configuration_revision',undefined]]);
  run=await openControlRun(f.definition,'resume',execution);run.close();
  assert.deepEqual(counts(),{calls:1,reviews:1});
}));

test('#26 pre-round revision refuses completed code that drifted from its review',()=>fixture(async f=>{
  const {execution,configure,qa}=buildExecution(f);
  await stepToFixtureCompleted(f,execution,{qa:false});
  const before=snapshot(f);configure(fixedQa(qa));
  fs.writeFileSync(path.join(f.codeProject,'a.js'),'drift\n');
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'qa_revision_not_completed'});
  assert.deepEqual(snapshot(f),before);
}));

test('#26 pre-round revision refuses a cancelled run, also at journal replay',()=>fixture(async f=>{
  const {execution,configure,qa}=buildExecution(f);
  let run=await openControlRun(f.definition,'create',execution);
  assert.equal((await run.host.handle(request('cancel'))).state,'cancelled');run.close();
  const before=snapshot(f);configure(fixedQa(qa));
  await assert.rejects(openControlRun(f.definition,'resume',execution,revision(qa)),{code:'qa_revision_not_completed'});
  assert.deepEqual(snapshot(f),before);
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const record={version:1,fromFingerprint:before.fingerprints.config,toFingerprint:'b'.repeat(64),invariantDigest:'c'.repeat(64),
    previousQaDigest:'d'.repeat(64),qaDigest:'e'.repeat(64),reason:'forged',hostContextId:'main',revisedAt:'2026-09-28T00:00:00Z',
    packageDigest:null,testRunId:null,qaRound:0,taskAttempt:1};
  const body={version:1,seq:before.records.length+1,id:`runner.${String(before.records.length+1).padStart(6,'0')}`,kind:'result',
    payload:{version:3,protocol:'cm-task-runner',type:'qa-config-revised',record},previousDigest:before.records.at(-1).digest};
  assert.throws(()=>readRunnerHistory([...before.records,{...body,digest:digest(body)}],before.records[0].payload.config,3),
    {code:'qa_revision_not_completed'});
}));

test('QA environment-failure declaration requires the one-shot rerun grant and a single-line reason',()=>fixture(async f=>{
  const {execution}=await completed(f);
  for(const options of [{qaEnvironmentFailure:'no rerun grant'},{rerunBlockedQa:true,qaEnvironmentFailure:' '},
    {rerunBlockedQa:true,qaEnvironmentFailure:'two\nlines'},{rerunBlockedQa:true,qaEnvironmentFailure:'x'.repeat(501)}])
    await assert.rejects(openControlRun(f.definition,'resume',execution,options),{code:'qa_recovery_authorization_required'});
}));

test('#26 pre-round revision log mirror is repaired once, never after a QA round; replay keeps round order',()=>fixture(async f=>{
  const {execution,configure,qa}=buildExecution(f);
  await stepToFixtureCompleted(f,execution);
  const fixed=fixedQa(qa);configure(fixed);
  let run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  const saved=snapshot(f),log=path.join(f.specsDir,'运行日志.jsonl'),complete=fs.readFileSync(log,'utf8');
  const withoutMirror=complete.split('\n').filter(line=>!line||JSON.parse(line).phase!=='qa_config_revise').join('\n');
  // Journal-only crash: same authorization reopens without a second record and restores the row.
  fs.writeFileSync(log,withoutMirror);
  run=await openControlRun(f.definition,'resume',execution,revision(qa));run.close();
  assert.deepEqual(snapshot(f),saved);assert.equal(logRows(f).filter(r=>r.phase==='qa_config_revise').length,1);
  run=await openControlRun(f.definition,'resume',execution);run.close();
  assert.equal(logRows(f).filter(r=>r.phase==='qa_config_revise').length,1);
  // A QA round cannot be followed by an unmirrored round-0 revision.
  const [decision]=logRows(f).filter(r=>r.event==='qa');
  fs.writeFileSync(log,withoutMirror+JSON.stringify({schema_version:1,workflow:'cm-ai',event:'test_run',phase:'start',node:'N6',
    run_id:identity.runId,repository_id:identity.repositoryId,feature:'1.login',task:identity.taskId,
    package_digest:decision.package_digest,qa_decision_id:decision.decision_id,operation_id:'forged-round',attempt:1,mode:'commands',case_count:1})+'\n');
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'qa_revision_invalid'});
  // Nor can an existing mirror sit after a QA round (a revision recorded late).
  const lines=complete.trim().split('\n'),mirrorAt=lines.findIndex(line=>JSON.parse(line).phase==='qa_config_revise');
  const forgedRun=fs.readFileSync(log,'utf8').trim().split('\n').at(-1);
  fs.writeFileSync(log,[...lines.slice(0,mirrorAt),forgedRun,...lines.slice(mirrorAt)].join('\n')+'\n');
  await assert.rejects(openControlRun(f.definition,'resume',execution),{code:'qa_revision_invalid'});
  fs.writeFileSync(log,complete);
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const {readQaConfigRevision}=await import('../runtime/js/cm-ai/qa-config-revision.mjs');
  const roundZero=revisedRecords(f)[0];
  assert.equal(readQaConfigRevision(roundZero).qaRound,0);
  // Only a round-0 record may lack a review package or a QA run to supersede.
  assert.throws(()=>readQaConfigRevision({...roundZero,qaRound:1,testRunId:'forged-run',packageDigest:null}));
  const reseal=records=>{for(let i=0;i<records.length;i++){const {digest:ignored,...body}=records[i];
    body.previousDigest=i?records[i-1].digest:null;records[i]={...body,digest:digest(body)};}return records;};
  for(const [field,value,code] of [['packageDigest','b'.repeat(64),'package_mismatch'],['testRunId','forged-run','qa_revision_invalid']]){
    const records=structuredClone(saved.records),target=records.find(r=>r.payload.type==='qa-config-revised');
    target.payload.record[field]=value;
    assert.throws(()=>readRunnerHistory(reseal(records),saved.records[0].payload.config,3),{code},field);
  }
  // Round 0 after a consumed round is out of order in both chain readers.
  run=await openControlRun(f.definition,'resume',execution);
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  const moved={...fixed,environment:{...fixed.environment,target:'second'}};configure(moved);
  run=await openControlRun(f.definition,'resume',execution,revision(fixed));
  await run.host.handle(request('advance'));run.close();
  configure(fixed);
  const chained=snapshot(f),forged=structuredClone(chained),revised=forged.records.filter(r=>r.payload.type==='qa-config-revised');
  assert.deepEqual(revised.map(r=>r.payload.record.qaRound),[0,1]);
  Object.assign(revised[0].payload.record,{qaRound:1,testRunId:'forged-run'});
  Object.assign(revised[1].payload.record,{qaRound:0,testRunId:null});reseal(forged.records);
  const {revision:ignored,...body}=forged;forged.revision=digest(body);
  assert.throws(()=>qaRevisionChain(forged),{code:'qa_revision_chain_invalid'});
  assert.throws(()=>readRunnerHistory(forged.records,forged.records[0].payload.config,3),{code:'qa_revision_chain_invalid'});
}));
