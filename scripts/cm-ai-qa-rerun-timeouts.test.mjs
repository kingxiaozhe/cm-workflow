// QA re-run and timeout recovery through the real single-task host CLI.
// Fake codex reviewer and synthetic session answers only: no model, network,
// simulator or browser is used. Every log home is a temporary directory.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {findCmAiQaDecision,inspectCmAiQaResult,recordCmAiQaDecision,recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {readHostQaFixHandoff} from '../runtime/js/cm-ai/host-qa-fix.mjs';
import {inspectFixQaSource,qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-rerun-home-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(home,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
  fs.rmSync(home,{recursive:true,force:true});
});
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
// The host CLI scenarios run real QA commands (host-check needs POSIX process
// groups and refuses win32) and POSIX fixtures (fake codex, sh shim).
const POSIX={skip:process.platform==='win32'?'host-check QA commands and the fixtures need POSIX':false};
const identity={repositoryId:'qa-rerun-fixture',runId:'qa-rerun-run',taskId:'T-001',attempt:1};
const simulator={kind:'app',carrier:'ios-simulator',target:'Fixture-iPhone',scope:'local'};
const service={kind:'service',carrier:'cli',target:'node',scope:'local'};
const lowRisk={scores:{scope:1,risk:1,accumulation:1,boundary:1},
  changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}};

// The QA command stands in for xcodebuild/simulator scripts. It reads a mode
// file outside both roots, so switching the "environment" never touches the
// reviewed code or the specs.
const PROBE=`import fs from 'node:fs';
const mode=fs.readFileSync(new URL('../environment-mode',import.meta.url),'utf8').trim();
if(mode==='killed')process.kill(process.pid,'SIGKILL');
if(mode==='exit65')process.exit(65);
if(mode!=='ready')process.exit(1);
`;

function fixture(t,{browser=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-rerun-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Fixture\n\n- [AC-001] tab bar shows four tabs\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  if(browser)fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:Array.from({length:browser===true?1:browser},(_,index)=>({id:`TC-00${index+1}`,origin:'generated',kind:'browser',
      blocking:true,acIds:['AC-001'],taskIds:['T-001'],title:'four tabs',
      preconditions:['UI test'],steps:['launch on simulator'],expected:['four tabs visible'],cleanup:[]}))}));
  const manifest=buildManifest(specsDir);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:manifest,
    ...(browser?{testCases:manifest.filter(item=>item.path.endsWith('/test-cases.json'))}:{})}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(codeProject,'probe.mjs'),PROBE);
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['target.mjs'],requirements:['requirements.md']};
  const config=path.join(root,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const fake=path.join(bin,'codex');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);fs.chmodSync(fake,0o700);
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',disabledSkills:[],promptTransport:'stdin'})}};
  const reviewFile=path.join(root,'review.json');fs.writeFileSync(reviewFile,JSON.stringify(review));
  const log=path.join(specsDir,'运行日志.jsonl');
  const f={root,codeProject,specsDir,feature,definition,config,reviewFile,log,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
      CM_WORKFLOW_HOME:path.join(root,'user'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')},
    environment:mode=>fs.writeFileSync(path.join(root,'environment-mode'),mode+'\n'),
    rows:()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],
    journal:()=>JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',identity.runId,'state.json'))),
    workflow:(name,qa)=>{const file=path.join(root,`${name}.json`);
      fs.writeFileSync(file,JSON.stringify({qa,documentationPaths:[],applicableAgentFiles:[]}));return file;}};
  f.environment('ready');
  return f;
}
const qaRows=f=>f.rows().filter(row=>row.event==='qa'&&row.node==='N6');
const testRuns=(f,phase)=>f.rows().filter(row=>row.event==='test_run'&&(phase===undefined||row.phase===phase));
const probeQa=(extra={})=>({commands:[{id:'probe',command:[process.execPath,'probe.mjs'],caseIds:[]}],environment:service,...extra});

function defaultAnswer(f,row){
  if(row.kind==='develop'){
    fs.writeFileSync(path.join(f.codeProject,'target.mjs'),'export const value = 1;\n');
    return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
  }
  if(row.kind==='check')return [{id:'syntax',command:[process.execPath,'--check','target.mjs'],outcome:'passed',exitCode:0,
    evidence:'Synthetic node --check'}];
  if(row.kind==='qa_assess')return lowRisk;
  if(row.kind==='documentation_inspect')return {syncId:row.payload.syncId,identity:row.payload.identity,
    packageDigest:row.payload.packageDigest,contextDigest:row.payload.contextDigest,status:'completed',
    reason:'No documentation path configured',at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
  throw Error(`unexpected host request ${row.kind}`);
}

// A python3 shim that refuses only the N6 test_run/start append, so the real host
// leaves exactly the durable prefix a crash right before that append leaves.
// POSIX only: callers are skipped on win32 before this runs.
function failingStartShim(f){
  const lookup=spawnSync('/bin/sh',['-c','command -v python3'],{encoding:'utf8'});
  assert.equal(lookup.status,0,'python3 must be on PATH for the interruption fixture');
  const dir=path.join(f.root,'shim');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'python3'),
    `#!/bin/sh\ncase " $* " in *" --event test_run --phase start "*) exit 3;; esac\nexec ${JSON.stringify(lookup.stdout.trim())} "$@"\n`,{mode:0o700});
  return dir;
}

// answers[kind] may be a value, a function(row) or 'IGNORE' (never answered);
// a function may also return 'IGNORE', or 'KILL' to SIGKILL the host mid-call.
function launch(f,{mode='resume',operation='advance',workflow=null,extra=[],answers={},review=true,pathPrefix=null}={}){
  return new Promise((resolve,reject)=>{
    const args=['serve','--config',f.config,'--mode',mode,'--host-context','session-A','--allow-development',
      '--review-config',f.reviewFile,...(review?['--allow-review-attempt','1']:[]),
      ...(workflow?['--workflow-config',workflow,'--allow-qa']:[]),...extra];
    const env=pathPrefix?{...f.env,PATH:pathPrefix+path.delimiter+f.env.PATH}:f.env;
    const child=spawn(process.execPath,[cli,...args],{env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',sessionId=null;const rows=[],asked=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error(`host timeout: ${stderr}`));},60000);
    const send=value=>{try{child.stdin.write(JSON.stringify(value)+'\n');}catch{}};
    child.on('error',reject);child.stderr.on('data',chunk=>stderr+=chunk);
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let index;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
        let row;try{row=JSON.parse(line);}catch{continue;}
        rows.push(row);
        if(row.type==='host_ready'){sessionId=row.sessionId;
          send({version:1,operation,requestId:'request',identity});}
        if(row.type==='host_request'){
          asked.push(row.kind);
          const configured=answers[row.kind];
          if(configured==='IGNORE')continue;
          let result;
          try{result=configured===undefined?defaultAnswer(f,row):typeof configured==='function'?configured(row):configured;}
          catch(error){child.kill('SIGKILL');clearTimeout(timer);reject(error);return;}
          if(result==='IGNORE')continue;
          if(result==='KILL'){child.kill('SIGKILL');continue;}
          send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
        }
        if(row.requestId==='request'&&(row.result||row.error))send({type:'host_close',sessionId});
      }
    });
    child.once('close',code=>{clearTimeout(timer);
      resolve({code,stderr,asked,result:rows.find(row=>row.requestId==='request')?.result??null});});
  });
}
const done=run=>{assert.equal(run.code,0,run.stderr);assert(run.result,run.stderr);return run.result;};

test('#7 a qa_assess answer window miss is a retryable rejection, never a durable BLOCKED decision',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa({timeoutMs:1500}));
  const first=done(await launch(f,{mode:'create',workflow,answers:{qa_assess:'IGNORE'}}));
  assert.equal(first.outcome,'rejected',JSON.stringify(first));assert.equal(first.code,'qa_decision_timeout');
  assert.equal(qaRows(f).length,0,'a transport timeout must not write an N6 decision');
  const status=done(await launch(f,{operation:'status',workflow}));
  assert.equal(status.state,'fixture_completed');assert.equal(status.code,null);
  // The same run, same configuration: the session now answers and N6 continues.
  const resumed=await launch(f,{workflow});
  const result=done(resumed);
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert.deepEqual(resumed.asked.filter(kind=>kind==='qa_assess'),['qa_assess']);
  assert.deepEqual(qaRows(f).map(row=>[row.status,row.reason]),[['triggered','feature_complete']]);
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['PASS']);
});

// Writes exactly the row an older host wrote when qa_assess timed out:
// same writer, deterministic decision id and no supersession link.
function legacyTimeoutDecision(f,packageDigest){
  if(qaRows(f).length)return;
  recordCmAiQaDecision({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,packageDigest,
    logHome:path.join(f.specsDir,'.reviews','host-log-mirror'),
    decision:{decisionId:`qa-${digest({identity,packageDigest}).slice(0,48)}`,identity,packageDigest,
      status:'blocked',reason:'host_request_timeout',score:null,at:'2026-09-28T10:48:11Z'}});
}

test('#7 a legacy 阻塞:host_request_timeout decision stays blocked unless --rerun-blocked-qa re-asks qa_assess once',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa({timeoutMs:1500}));
  done(await launch(f,{mode:'create',workflow,answers:{qa_assess:'IGNORE'}}));
  const status=done(await launch(f,{operation:'status',workflow}));
  legacyTimeoutDecision(f,status.packageDigest);
  const [legacy]=qaRows(f);assert.equal(legacy.status,'blocked');assert.equal(legacy.reason,'host_request_timeout');
  const logBefore=fs.readFileSync(f.log),journalBefore=f.journal();
  // Compatibility: without the explicit flag the recorded decision is replayed as before.
  const plain=await launch(f,{workflow});
  const blocked=done(plain);
  assert.equal(blocked.code,'qa_blocked');assert.equal(blocked.pendingAction,'none');
  assert.equal(blocked.reason,'host_request_timeout');assert.deepEqual(plain.asked,[]);
  assert(fs.readFileSync(f.log).equals(logBefore));assert.deepEqual(f.journal(),journalBefore);
  // Explicit, audited recovery: the recorded decision is superseded, not rewritten.
  const recovery=await launch(f,{workflow,extra:['--rerun-blocked-qa']});
  const recovered=done(recovery);
  assert.equal(recovered.state,'run_done',JSON.stringify(recovered));
  assert.deepEqual(recovery.asked.filter(kind=>kind==='qa_assess'),['qa_assess']);
  assert(fs.readFileSync(f.log).subarray(0,logBefore.length).equals(logBefore),'history bytes are kept');
  const decisions=qaRows(f);
  assert.deepEqual(decisions.map(row=>[row.status,row.reason]),[['blocked','host_request_timeout'],['triggered','feature_complete']]);
  assert.equal(decisions[1].previous_decision_id,legacy.decision_id);assert.notEqual(decisions[1].decision_id,legacy.decision_id);
  assert.deepEqual(testRuns(f,'start').map(row=>[row.attempt,row.qa_decision_id]),[[1,decisions[1].decision_id]]);
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['PASS']);
  // Replays read the effective decision; the flag cannot supersede a second time.
  for(const extra of [[],['--rerun-blocked-qa']]){
    const again=await launch(f,{workflow,extra,answers:{qa_assess:()=>assert.fail('qa_assess must not be re-asked')}});
    assert.equal(again.code,0,again.stderr);assert.equal(qaRows(f).length,2);
  }
  assert.deepEqual(f.journal().records.slice(0,journalBefore.records.length),journalBefore.records);
});

test('#7 recovery interrupted after the replacement decision, before QA start, resumes with the same command',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa({timeoutMs:1500}));
  done(await launch(f,{mode:'create',workflow,answers:{qa_assess:'IGNORE'}}));
  legacyTimeoutDecision(f,done(await launch(f,{operation:'status',workflow})).packageDigest);
  const interrupted=done(await launch(f,{workflow,extra:['--rerun-blocked-qa'],pathPrefix:failingStartShim(f)}));
  assert.equal(interrupted.outcome,'rejected',JSON.stringify(interrupted));assert.equal(interrupted.code,'qa_log_failed');
  const prefix=qaRows(f);
  assert.deepEqual(prefix.map(row=>row.status),['blocked','triggered']);assert.equal(testRuns(f).length,0);
  // The same authorized command finishes the recovery as the ordinary first
  // round; qa_assess is not asked again. Here that round meets a killed command.
  const noAssess={qa_assess:()=>assert.fail('qa_assess must not be re-asked')};
  f.environment('killed');
  const resumed=done(await launch(f,{workflow,extra:['--rerun-blocked-qa'],answers:noAssess}));
  assert.equal(resumed.code,'qa_result_blocked',JSON.stringify(resumed));
  assert.deepEqual(qaRows(f).map(row=>row.decision_id),prefix.map(row=>row.decision_id));
  assert.deepEqual(testRuns(f,'start').map(row=>[row.attempt,row.qa_decision_id,row.previous_test_run_id]),[[1,prefix[1].decision_id,undefined]]);
  // Once a round exists under the replacement, the flag is an ordinary rerun again.
  f.environment('ready');
  const result=done(await launch(f,{workflow,extra:['--rerun-blocked-qa'],answers:noAssess}));
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert.deepEqual(testRuns(f,'start').map(row=>row.attempt),[1,2]);
  assert.deepEqual(testRuns(f,'superseded').map(row=>row.reason),['host_evidence_problem']);
});

test('#13 a host-declared BLOCKED simulator case re-runs on unchanged code with --rerun-blocked-qa',POSIX,async t=>{
  const f=fixture(t,{browser:true}),workflow=f.workflow('workflow',probeQa({environment:simulator}));
  const evidence=path.join(f.specsDir,'.reviews','tc-001.png');
  const down=row=>({verdict:'BLOCKED',evidence:[],environment:row.payload.environment,cleanup:'not_needed'});
  const up=row=>{fs.writeFileSync(evidence,'png');return {verdict:'PASS',evidence:[evidence],environment:row.payload.environment,cleanup:'not_needed'};};
  const first=done(await launch(f,{mode:'create',workflow,extra:['--browser-qa','available'],answers:{qa_browser:down}}));
  assert.equal(first.code,'qa_result_blocked',JSON.stringify(first));
  const rerun=await launch(f,{workflow,extra:['--browser-qa','available','--rerun-blocked-qa'],answers:{qa_browser:up}});
  const result=done(rerun);
  assert.equal(result.state,'run_done',JSON.stringify(result));
  const superseded=testRuns(f,'superseded');
  assert.equal(superseded.length,1);assert.equal(superseded[0].reason,'host_evidence_problem');
  assert.deepEqual(superseded[0].blocked_cases,['TC-001']);
  assert.deepEqual(testRuns(f,'start').map(row=>row.attempt),[1,2]);
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['BLOCKED','PASS']);
});

test('#13 an unavailable QA command (killed, no exit code) re-runs; the round budget still caps at three',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa());
  f.environment('killed');
  const first=done(await launch(f,{mode:'create',workflow}));
  assert.equal(first.code,'qa_result_blocked',JSON.stringify(first));
  for(let round=2;round<=3;round++){
    const again=done(await launch(f,{workflow,extra:['--rerun-blocked-qa']}));
    assert.equal(again.code,'qa_result_blocked',JSON.stringify(again));
  }
  const exhausted=done(await launch(f,{workflow,extra:['--rerun-blocked-qa']}));
  assert.equal(exhausted.code,'qa_round_invalid',JSON.stringify(exhausted));
  assert.deepEqual(testRuns(f,'start').map(row=>row.attempt),[1,2,3]);
  assert.deepEqual(testRuns(f,'superseded').map(row=>row.blocked_cases),[['probe'],['probe']]);
});

test('#13 the environment recovers: an unavailable command reaches run_done on the same approved code',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa());
  f.environment('killed');
  assert.equal(done(await launch(f,{mode:'create',workflow})).code,'qa_result_blocked');
  f.environment('ready');
  const result=done(await launch(f,{workflow,extra:['--rerun-blocked-qa']}));
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['BLOCKED','PASS']);
});

test('#13 a non-zero QA exit stays a product FAIL; only an explicit, recorded operator declaration re-runs it',POSIX,async t=>{
  const f=fixture(t),workflow=f.workflow('workflow',probeQa());
  f.environment('exit65');
  const first=done(await launch(f,{mode:'create',workflow}));
  assert.equal(first.code,'qa_failed',JSON.stringify(first));
  const logBefore=fs.readFileSync(f.log);
  const refused=done(await launch(f,{workflow,extra:['--rerun-blocked-qa']}));
  assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');assert(fs.readFileSync(f.log).equals(logBefore));
  const orphan=await launch(f,{workflow,extra:['--qa-environment-failure','simulator runtime was missing']});
  assert.equal(orphan.code,1);assert.match(orphan.stderr,/qa_recovery_authorization_required/);
  // The host refuses the orphan declaration before it even reads the run definition.
  const early=await launch({...f,config:path.join(f.root,'missing-run.json')},{workflow,extra:['--qa-environment-failure','x']});
  assert.equal(early.code,1);assert.match(early.stderr,/qa_recovery_authorization_required/);
  f.environment('ready');
  const declared=done(await launch(f,{workflow,extra:['--rerun-blocked-qa','--qa-environment-failure','simulator runtime was missing']}));
  assert.equal(declared.state,'run_done',JSON.stringify(declared));
  const [superseded]=testRuns(f,'superseded');
  assert.equal(superseded.reason,'declared_environment_failure');
  assert.equal(superseded.environment_failure_reason,'simulator runtime was missing');
  assert.deepEqual(superseded.failed_cases,['probe']);assert.deepEqual(superseded.blocked_cases,[]);
  assert.deepEqual(testRuns(f,'start').map(row=>row.attempt),[1,2]);
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['FAIL','PASS']);
});

test('#26 a wrong QA workflow config is revised before any QA round, without consuming a round',POSIX,async t=>{
  const f=fixture(t);
  const wrong=f.workflow('workflow-old',{commands:[{id:'probe',command:[process.execPath,'-e','process.exit(3)'],caseIds:[]}],environment:service});
  const fixed=f.workflow('workflow-new',probeQa());
  const waiting=done(await launch(f,{mode:'create',workflow:wrong,review:false}));
  assert.equal(waiting.state,'awaiting_review',JSON.stringify(waiting));
  const before=f.journal();
  const drift=await launch(f,{workflow:fixed,review:false});
  assert.equal(drift.code,1);assert.match(drift.stderr,/fingerprint_mismatch/);
  const revise=['--revise-qa-config',wrong,'--qa-config-revision-reason','QA 命令写错，运行前修正'];
  const revised=await launch(f,{workflow:fixed,extra:revise});
  const result=done(revised);
  assert.equal(result.state,'run_done',JSON.stringify(result));
  const records=f.journal().records.filter(row=>row.payload.type==='qa-config-revised');
  assert.equal(records.length,1);
  assert.equal(records[0].payload.record.qaRound,0);assert.equal(records[0].payload.record.testRunId,null);
  assert.deepEqual(f.journal().records.slice(0,before.records.length),before.records);
  assert.equal(f.rows().filter(row=>row.event==='decision'&&row.phase==='qa_config_revise').length,1);
  assert.deepEqual(testRuns(f,'start').map(row=>[row.attempt,row.previous_test_run_id]),[[1,undefined]]);
  assert.equal(testRuns(f,'superseded').length,0);
  assert.deepEqual(testRuns(f,'complete').map(row=>row.result),['PASS']);
  // The chain now binds the corrected file; the old one no longer resumes.
  assert.equal((await launch(f,{workflow:fixed,operation:'status'})).code,0);
  const old=await launch(f,{workflow:wrong,operation:'status'});
  assert.equal(old.code,1);assert.match(old.stderr,/fingerprint_mismatch/);
});

test('#7 decision chain: one linked supersession of a timeout decision, read by N6 and cm-fix alike',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-chain-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),logHome=path.join(root,'logs');
  fs.mkdirSync(path.join(specsDir,'.reviews'),{recursive:true});fs.mkdirSync(codeProject);
  const packageDigest='a'.repeat(64),feature='1.work',binding={specsDir,codeProject,feature,identity,packageDigest,logHome};
  const query={specsDir,feature,identity,packageDigest},log=path.join(specsDir,'运行日志.jsonl');
  const decision=(decisionId,status,reason,at)=>({decisionId,identity,packageDigest,status,reason,score:null,at});
  const legacy=decision('qa-legacy','blocked','host_request_timeout','2026-09-28T10:48:11Z');
  assert.throws(()=>recordCmAiQaDecision({...binding,previousDecisionId:'qa-legacy',
    decision:decision('qa-fresh','triggered','feature_complete','2026-09-28T11:00:00Z')}),{code:'qa_decision_conflict'});
  recordCmAiQaDecision({...binding,decision:legacy});
  const onlyLegacy=fs.readFileSync(log);
  // A link must name a recorded decision, and an identical row is not a supersession of itself.
  assert.throws(()=>recordCmAiQaDecision({...binding,packageDigest:'d'.repeat(64),previousDecisionId:'qa-legacy',
    decision:{...legacy,decisionId:'qa-d',packageDigest:'d'.repeat(64)}}),{code:'qa_decision_conflict'});
  assert.throws(()=>recordCmAiQaDecision({...binding,previousDecisionId:'qa-legacy',decision:legacy}),{code:'qa_decision_conflict'});
  // Only a timeout decision is supersedable, only by a linked distinct decision.
  assert.throws(()=>recordCmAiQaDecision({...binding,previousDecisionId:'qa-legacy',decision:{...legacy,at:'2026-09-28T11:00:00Z'}}),
    {code:'qa_decision_conflict'});
  assert.throws(()=>recordCmAiQaDecision({...binding,previousDecisionId:'qa-other',
    decision:decision('qa-fresh','triggered','feature_complete','2026-09-28T11:00:00Z')}),{code:'qa_decision_conflict'});
  assert.deepEqual(fs.readFileSync(log),onlyLegacy);
  // A decision that is not a timeout block is never superseded, even when named exactly.
  const other={...binding,packageDigest:'b'.repeat(64)},otherDecision={decisionId:'qa-other-package',identity,
    packageDigest:'b'.repeat(64),status:'triggered',reason:'feature_complete',score:null,at:'2026-09-28T10:00:00Z'};
  recordCmAiQaDecision({...other,decision:otherDecision});
  const withOther=fs.readFileSync(log);
  assert.throws(()=>recordCmAiQaDecision({...other,previousDecisionId:'qa-other-package',
    decision:{...otherDecision,decisionId:'qa-other-fresh',at:'2026-09-28T11:00:00Z'}}),{code:'qa_decision_conflict'});
  assert.deepEqual(fs.readFileSync(log),withOther);
  // Only once: even a second timeout block (from a custom provider) is final.
  const timeoutTwice={...binding,packageDigest:'c'.repeat(64)},block=(decisionId,at)=>({decisionId,identity,
    packageDigest:'c'.repeat(64),status:'blocked',reason:'host_request_timeout',score:null,at});
  recordCmAiQaDecision({...timeoutTwice,decision:block('qa-c1','2026-09-28T10:00:00Z')});
  recordCmAiQaDecision({...timeoutTwice,previousDecisionId:'qa-c1',decision:block('qa-c2','2026-09-28T10:10:00Z')});
  const twice=fs.readFileSync(log);
  assert.throws(()=>recordCmAiQaDecision({...timeoutTwice,previousDecisionId:'qa-c2',
    decision:{...block('qa-c3','2026-09-28T10:20:00Z'),status:'triggered',reason:'feature_complete'}}),{code:'qa_decision_conflict'});
  assert.deepEqual(fs.readFileSync(log),twice);
  const fresh=decision('qa-fresh','triggered','feature_complete','2026-09-28T11:00:00Z');
  recordCmAiQaDecision({...binding,previousDecisionId:'qa-legacy',decision:fresh});
  recordCmAiQaDecision({...binding,previousDecisionId:'qa-legacy',decision:fresh});
  const chained=fs.readFileSync(log);
  assert.equal(findCmAiQaDecision(query).decisionId,'qa-fresh');
  assert.throws(()=>recordCmAiQaDecision({...binding,previousDecisionId:'qa-fresh',
    decision:{...decision('qa-third','skipped','risk_score_below_threshold','2026-09-28T12:00:00Z'),score:4}}),{code:'qa_decision_conflict'});
  assert.deepEqual(fs.readFileSync(log),chained);
  // The QA round and a cm-fix child bind the effective decision.
  const report=path.join(specsDir,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic QA FAIL');
  const qa={...binding,mode:'commands',caseCount:1,testRunId:'qa-round-1'};
  recordCmAiQaRun({...qa,phase:'start'});
  recordCmAiQaRun({...qa,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
  assert.equal(inspectCmAiQaResult({...query,testRunId:'qa-round-1'}).status,'failed');
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).find(row=>row.phase==='start').qa_decision_id,'qa-fresh');
  const handoff=readHostQaFixHandoff({...query,codeProject,testRunId:'qa-round-1'});
  const qaSource={feature,identity,packageDigest,testRunId:'qa-round-1',handoffDigest:handoff.handoffDigest};
  const configuration={qaSource,reproduction:{cwd:codeProject}};
  assert.equal(inspectFixQaSource({specsRoot:specsDir,identity:qaFixIdentity(qaSource),configuration}).handoffDigest,handoff.handoffDigest);
  // Forged chains fail closed in every reader.
  const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const at=rows.findIndex(row=>row.decision_id==='qa-fresh');
  for(const [label,forge] of [
    ['unlinked',list=>{delete list[at].previous_decision_id;}],
    ['orphan successor',list=>{list.splice(list.findIndex(row=>row.decision_id==='qa-legacy'),1);}],
    ['reused id',list=>{Object.assign(list[at],{decision_id:'qa-legacy'});}],
    ['non-timeout predecessor',list=>{list.find(row=>row.decision_id==='qa-legacy').reason='feature_complete';}],
    ['third decision',list=>{list.splice(at+1,0,{...list[at],decision_id:'qa-third',previous_decision_id:'qa-fresh'});}],
  ]){
    const copy=structuredClone(rows);forge(copy);
    fs.writeFileSync(log,copy.map(row=>JSON.stringify(row)).join('\n')+'\n');
    assert.throws(()=>findCmAiQaDecision(query),{code:'context_not_ready'},label);
    assert.throws(()=>inspectCmAiQaResult({...query,testRunId:'qa-round-1'}),{code:'qa_not_triggered'},label);
    assert.throws(()=>inspectFixQaSource({specsRoot:specsDir,identity:qaFixIdentity(qaSource),configuration}),label);
  }
});

// A QA call stopped as a whole (qa_execution_timeout, or the host gone) leaves no
// complete and no report. Here the probe command passes, TC-001 gets no session
// answer within qa.timeoutMs, and the host dies while TC-002 waits.
async function timedOutCall(t){
  const f=fixture(t,{browser:2}),workflow=f.workflow('workflow',probeQa({environment:simulator,timeoutMs:1500}));
  const browserQa=['--browser-qa','available'];
  const aborted=await launch(f,{mode:'create',workflow,extra:browserQa,
    answers:{qa_browser:row=>row.payload.case.id==='TC-001'?'IGNORE':'KILL'}});
  assert.notEqual(aborted.code,0);
  const recorded=testRuns(f).map(row=>[row.phase,row.case_id]);
  assert.deepEqual(recorded,[['start',undefined],['case_start','TC-001'],['case_blocked','TC-001'],['case_start','TC-002']]);
  assert.equal(testRuns(f,'case_blocked')[0].host_request_timeout,true);
  return {f,workflow,browserQa};
}
const pass=f=>row=>{const file=path.join(f.specsDir,'.reviews',`${row.payload.case.id}.png`);fs.writeFileSync(file,'png');
  return {verdict:'PASS',evidence:[file],environment:row.payload.environment,cleanup:'not_needed'};};

test('#26c --rerun-unknown-qa supersedes a call stopped as a whole whose only non-PASS case is a host request timeout',POSIX,async t=>{
  const {f,workflow,browserQa}=await timedOutCall(t);
  const unknown=done(await launch(f,{workflow,extra:browserQa}));
  assert.equal(unknown.code,'qa_execution_unknown');assert.equal(unknown.pendingAction,'reconcile');
  const logBefore=fs.readFileSync(f.log),oldRun=testRuns(f,'start')[0].operation_id;
  // --rerun-blocked-qa needs a completed call; its refusal names the flag that applies.
  const wrong=done(await launch(f,{workflow,extra:[...browserQa,'--rerun-blocked-qa']}));
  assert.equal(wrong.code,'qa_rerun_unknown_qa_required',JSON.stringify(wrong));
  assert(fs.readFileSync(f.log).equals(logBefore));
  const rerun=await launch(f,{workflow,extra:[...browserQa,'--rerun-unknown-qa'],answers:{qa_browser:pass(f)}});
  const result=done(rerun);
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert(fs.readFileSync(f.log).subarray(0,logBefore.length).equals(logBefore),'history bytes are kept');
  // Every case and command runs again at qaRound+1; no PASS is carried forward.
  assert.deepEqual(rerun.asked.filter(kind=>kind==='qa_browser'),['qa_browser','qa_browser']);
  const [superseded]=testRuns(f,'superseded');
  assert.equal(superseded.operation_id,oldRun);assert.equal(superseded.reason,'host_request_timeout');
  assert.deepEqual([superseded.timed_out_cases,superseded.partial_pass_cases,superseded.request_timeout_ms],[['TC-001'],[],1500]);
  const starts=testRuns(f,'start');
  assert.deepEqual(starts.map(row=>[row.attempt,row.previous_test_run_id]),[[1,undefined],[2,oldRun]]);
  assert.equal(f.rows().filter(row=>row.event==='resource'&&row.phase==='released'&&row.operation_id===starts[1].operation_id).length,1);
  assert.deepEqual(testRuns(f,'complete').map(row=>[row.attempt,row.result]),[[2,'PASS']]);
  assert.equal(done(await launch(f,{workflow,extra:browserQa})).state,'run_done');
});

test('#26c a session-declared BLOCKED, a FAIL or an unproven older timeout row still refuses --rerun-unknown-qa',POSIX,async t=>{
  const {f,workflow,browserQa}=await timedOutCall(t);
  const original=fs.readFileSync(f.log,'utf8');
  const variant=edit=>original.trim().split('\n').map(line=>{const row=JSON.parse(line);
    return JSON.stringify(row.event==='test_run'&&row.phase==='case_blocked'?edit(row):row);}).join('\n')+'\n';
  const legacy=(seconds)=>row=>{const {host_request_timeout,...rest}=row;
    const start=testRuns(f,'case_start')[0].at;return {...rest,at:new Date(Date.parse(start)+seconds*1000).toISOString().replace(/\.\d{3}Z$/,'Z')};};
  for(const [name,edit] of [
    ['session-declared',row=>({...row,host_declared_blocked:true,host_request_timeout:false})],
    ['other BLOCKED',row=>({...row,host_request_timeout:false})],
    ['FAIL',row=>({...row,phase:'case_complete',result:'FAIL',host_request_timeout:undefined})],
    ['older row, window not elapsed',legacy(0)]]){
    fs.writeFileSync(f.log,variant(edit));const before=fs.readFileSync(f.log);
    const refused=done(await launch(f,{workflow,extra:[...browserQa,'--rerun-unknown-qa']}));
    assert.equal(refused.code,'qa_execution_unknown',`${name}: ${JSON.stringify(refused)}`);
    assert(fs.readFileSync(f.log).equals(before),name);
  }
  // An older row without the marker counts once its case shows the full window.
  fs.writeFileSync(f.log,variant(legacy(2)));
  const rerun=done(await launch(f,{workflow,extra:[...browserQa,'--rerun-unknown-qa'],answers:{qa_browser:pass(f)}}));
  assert.equal(rerun.state,'run_done',JSON.stringify(rerun));
  assert.deepEqual(testRuns(f,'superseded').map(row=>row.timed_out_cases),[['TC-001']]);
});
