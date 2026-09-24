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
  let calls=0,reviews=0;
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['main'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      calls++;fs.writeFileSync(path.join(f.codeProject,'a.js'),'new\n');
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
      "require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'),'new\\n')"]}]})};

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
  const provider=execution.qaDecisionProvider;
  if(attach){execution.configuration.workflow.qa=null;delete execution.qaExecutor;delete execution.qaDecisionProvider;}
  let run=await openControlRun(f.definition,'create',execution);
  let result=await run.host.handle(request('advance'));run.close();
  if(attach){
    assert.equal(result.code,'qa_decision_required');configure(qa);execution.qaDecisionProvider=provider;
    run=await openControlRun(f.definition,'resume',execution);result=await run.host.handle(request('advance'));run.close();
  }
  assert.equal(result.code,'qa_result_blocked',JSON.stringify(result));
  assert.equal(result.state,'fixture_completed');
  assert.equal(calls,twoAttempts?2:1);assert.equal(reviews,twoAttempts?2:1);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.login','tasks.md'),'utf8'),/\[x\]/);
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
