// #14: mutable project/user/plugin CM config must not make a QA run unopenable.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun,runConfigMaterial} from './cm-ai-run.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-fingerprint-home-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
fs.mkdirSync(process.env.CM_WORKFLOW_HOME,{recursive:true});
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const userRuntimes=preset=>fs.writeFileSync(path.join(process.env.CM_WORKFLOW_HOME,'runtimes.yml'),
  `runtimes: {available: both}\npreset: ${preset}\n`);
const template=fs.readFileSync(fileURLToPath(new URL('../templates/cm-workflow.yml',import.meta.url)));
const identity={repositoryId:'fingerprint-fixture',runId:'fingerprint-run',taskId:'T-002',attempt:1};
const request=(operation,extra={})=>({version:1,operation,requestId:operation,identity,...extra});

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'run-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  return {root,codeProject,specsDir,feature,definition,projectConfig:path.join(codeProject,'.cm-workflow.yml')};
}
const environment={kind:'web',carrier:'browser',target:'fixture',scope:'local'};
const syntax=[{id:'unit',command:[process.execPath,'--check','a.mjs'],caseIds:[]}];

// The real current-conversation factory builds the built-in QA executor.
const conversation=(f,commands=syntax)=>createConversationExecution(f.definition,'host-session-1',
  {call:async()=>{throw new Error('not dispatched');}},null,null,
  {qa:{commands,environment},documentationPaths:[],applicableAgentFiles:[]},true,'claude');
async function opens(f,mode,execution,options){
  const run=await openControlRun(f.definition,mode,execution,options);run.close();
}

test('#14 user runtimes, project policies, the bootstrap template and test policy do not change the QA run fingerprint',async()=>{
  for(const change of ['user-runtimes','auto-fix','bootstrap-template','test-policy']){
    const f=fixture();userRuntimes('codex-codes');
    await opens(f,'create',conversation(f));
    const before=fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json'));
    if(change==='user-runtimes')userRuntimes('claude-codes');
    if(change==='auto-fix')fs.writeFileSync(f.projectConfig,'version: 1\npolicies:\n  auto_fix: auto\n');
    if(change==='bootstrap-template')fs.writeFileSync(f.projectConfig,template);
    if(change==='test-policy')fs.writeFileSync(f.projectConfig,'version: 1\npolicies:\n  tests: [commands]\n');
    await opens(f,'resume',conversation(f));
    assert(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')).equals(before),change);
  }
});

test('#14 the host QA inputs themselves stay bound by the fingerprint',async()=>{
  const f=fixture();userRuntimes('codex-codes');
  await opens(f,'create',conversation(f));
  await assert.rejects(opens(f,'resume',conversation(f,[{id:'other',command:[process.execPath,'--version'],caseIds:[]}])),
    {code:'fingerprint_mismatch'});
});

// Synthetic trusted host that reaches N5 and N6 with the real built-in executor.
function synthetic(f,{commands=syntax,browser=null}={}){
  const logHome=path.join(f.specsDir,'.reviews','host-log-mirror');
  return {configuration:{kind:'synthetic-host-v1',hostContextId:'control',workflow:{qa:{commands,environment},documentationPaths:[],applicableAgentFiles:[]}},
    timeoutMs:5000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'export const a=1;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:(review,{onEvent})=>{
        onEvent({event:'thread.started',provider_thread:`thread-${review.identity.attempt}`});onEvent({event:'turn.started',item_type:null});
        onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});
        onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
        return {status:'succeeded',value:{verdict:'approved',packageDigest:review.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(review.payload.reviewPackage),findings:[],summary:'Synthetic review'}};}}],
    reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],authorize:(review,{authorizationAt})=>{
      const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${review.identity.attempt}`,adapterId:'codex-review-adapter',
        invocationId:review.invocationId,requestDigest:review.requestDigest,identity:review.identity,reviewerId:'reviewer',
        logicalContextId:review.contextId,packageDigest:review.payload.reviewPackage.packageDigest,hostContextId:'control',
        decisionId:'decision',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
      return {...body,grantDigest:digest(body)};}},
    hostDecision:{status:'approved'},check:createHostCheck({cwd:f.codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]}),
    qaLogHome:logHome,
    qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:'qa-decision',identity:binding.identity,
      packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-28T00:00:00Z'})},
    qaExecutor:createHostQaExecutor({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,requirements:['requirements.md'],
      runtime:'codex',commands,environment,timeoutMs:60000,logHome,...(browser?{browser}:{})})};
}
const testRuns=f=>fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  .filter(row=>row.event==='test_run'&&['start','complete'].includes(row.phase));

test('#14 a completed QA run is recoverable after the user enables auto_fix, with the round bound in its QA records',async()=>{
  const f=fixture();userRuntimes('codex-codes');
  fs.writeFileSync(f.projectConfig,'version: 1\npolicies:\n  auto_fix: explicit\n');
  let run=await openControlRun(f.definition,'create',synthetic(f,{commands:[]}));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_result_blocked');run.close();
  // --auto-qa-fix needs this project policy; the next QA round must still open.
  fs.writeFileSync(f.projectConfig,'version: 1\npolicies:\n  auto_fix: auto\n');userRuntimes('claude-codes');
  run=await openControlRun(f.definition,'resume',synthetic(f),{qaConfigRevision:{
    previousWorkflow:{qa:{commands:[],environment},documentationPaths:[],applicableAgentFiles:[]},reason:'补上漏配的项目测试命令'}});
  const result=await run.host.handle(request('advance'));run.close();
  assert.equal(result.code,'qa_passed',JSON.stringify(result));
  const rows=testRuns(f);
  assert.deepEqual(rows.map(row=>[row.phase,row.attempt,row.mode,row.case_count]),
    [['start',1,'commands',1],['complete',1,'commands',1],['start',2,'commands',1],['complete',2,'commands',1]]);
});

test('#14 a store fingerprinted in the historical plan form still opens and advances exactly as before',async()=>{
  const f=fixture();userRuntimes('codex-codes');
  let browserUp=false;
  const browser=async browserRequest=>{
    if(!browserUp)return {verdict:'BLOCKED',evidence:[],environment:browserRequest.environment,cleanup:'failed'};
    const shot=path.join(f.specsDir,'.reviews','tc-001.txt');fs.writeFileSync(shot,'observed');
    return {verdict:'PASS',evidence:[shot],environment:browserRequest.environment,cleanup:'not_needed'};
  };
  fs.writeFileSync(path.join(f.specsDir,f.feature,'requirements.md'),'# R\n\n- AC-001: page renders\n');
  fs.writeFileSync(path.join(f.specsDir,f.feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases:[
    {id:'TC-001',origin:'generated',kind:'browser',blocking:true,acIds:['AC-001'],taskIds:['T-002'],title:'renders',
      preconditions:['fixture'],steps:['open'],expected:['visible'],cleanup:[]}]}));
  const manifest=buildManifest(f.specsDir);
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[f.feature],specFiles:manifest,
    testCases:manifest.filter(item=>item.path.endsWith('/test-cases.json'))}));
  // An older runtime created the store with the plan-bearing fingerprint and
  // stopped after the initializer; the current code must finish and keep it.
  const legacy=runConfigMaterial(f.definition,synthetic(f,{browser}),{legacyQa:true});
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),feature:'work',specsRoot:f.specsDir,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},create:true,
    fingerprints:{workflow:digest('cm-ai-host-execution-v1'),config:digest(legacy),inputs:digest({feature:f.feature,task:identity.taskId})}});
  store.close();
  let run=await openControlRun(f.definition,'resume',synthetic(f,{browser}));
  assert.equal((await run.host.handle(request('advance'))).code,'qa_result_blocked');run.close();
  const state=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
  assert.equal(JSON.parse(fs.readFileSync(state)).fingerprints.config,digest(legacy));
  // Historical stores keep their original fail-closed binding, now with a reason.
  fs.writeFileSync(f.projectConfig,'version: 1\npolicies:\n  auto_fix: auto\n');
  await assert.rejects(openControlRun(f.definition,'resume',synthetic(f,{browser})),
    error=>error.code==='fingerprint_mismatch'&&/\.cm-workflow\.yml/.test(error.reason));
  fs.rmSync(f.projectConfig);browserUp=true;
  run=await openControlRun(f.definition,'resume',synthetic(f,{browser}),{rerunBlockedQa:true});
  assert.equal((await run.host.handle(request('advance'))).code,'qa_passed');run.close();
  assert.equal(JSON.parse(fs.readFileSync(state)).fingerprints.config,digest(legacy));
});
