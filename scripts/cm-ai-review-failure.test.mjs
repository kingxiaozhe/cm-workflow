// Reviewer failures, the verdict contract and the review race bound, driven
// through the real driver -> cm-ai-host -> claudeWorker path with a synthetic
// `claude` process on PATH. No model service is contacted.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {inspectProviderReview,inspectProviderReviewFailure} from '../runtime/js/cm-ai/provider-review-observation.mjs';
import {buildReviewPrompt,VERDICT_RULES} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';

// Every case opens the native V3 store (Node 24.14+ on macOS/Linux) and spawns
// a POSIX shim; like the other runner-host suites, skip elsewhere explicitly.
const skip=!isSupportedExecutionPlatform();
const test=(name,fn)=>nodeTest(name,{skip},fn);

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const identity={repositoryId:'review-failure',runId:'review-failure-run',taskId:'T-001',attempt:1};
const develop=(edits={'target.mjs':'target-content.mjs'})=>({status:'succeeded',value:{outcome:'implemented',
  application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits});

// Synthetic Claude CLI. api_error replays the stream shape captured from the
// real Claude CLI 2.1.274 against a local fake Messages API: system/init, a
// synthetic assistant message carrying the error class, an is_error result, exit 1.
const fakeClaude=(behaviour,calls)=>`import fs from 'node:fs';import {randomUUID} from 'node:crypto';
if(process.argv.includes('--version')){process.stdout.write('2.1.274 (Claude Code)\\n');process.exit(0);}
let prompt='';for await(const part of process.stdin)prompt+=part;
const queue=JSON.parse(fs.readFileSync(${JSON.stringify(behaviour)},'utf8'));
const b=queue.length>1?queue.shift():queue[0];fs.writeFileSync(${JSON.stringify(behaviour)},JSON.stringify(queue));
const marker='<cm-review-data-json>\\n';const data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({mode:b.mode,attempt:data.reviewPackage.identity.attempt,
  verdictRules:prompt.includes('approved requires zero P0, P1 and P2 findings')})+'\\n');
const session_id=randomUUID(),out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
if(b.mode==='no_init'){out({type:'system',subtype:'status',session_id});process.exit(1);}
out({type:'system',subtype:'init',cwd:process.cwd(),session_id,tools:['StructuredOutput'],mcp_servers:[],
  model:'fixture',permissionMode:'dontAsk',slash_commands:[],apiKeySource:'ANTHROPIC_API_KEY',
  claude_code_version:'2.1.274',output_style:'default',agents:[],skills:[],plugins:[],uuid:randomUUID()});
if(b.mode==='api_error'){
  out({type:'assistant',message:{id:randomUUID(),container:null,model:'<synthetic>',role:'assistant',stop_reason:'stop_sequence',
    stop_sequence:'',type:'message',usage:{input_tokens:0,output_tokens:0},content:[{type:'text',text:b.text}],context_management:null},
    parent_tool_use_id:null,session_id,uuid:randomUUID(),error:b.error,is_api_error_message:true});
  out({type:'result',subtype:'success',is_error:true,duration_ms:25,duration_api_ms:0,num_turns:1,result:b.text,
    stop_reason:'stop_sequence',session_id,total_cost_usd:0,terminal_reason:'api_error',api_error_status:b.status,uuid:randomUUID()});
  process.exit(1);
}
const value={verdict:b.verdict??'approved',packageDigest:data.reviewPackage.packageDigest,
  examinedPaths:b.reverse?[...data.examinedPaths].reverse():data.examinedPaths,findings:b.findings??[],summary:b.summary??'Synthetic review'};
out({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}]}});
out({type:'result',subtype:'success',session_id,is_error:false,num_turns:1,result:JSON.stringify(value),structured_output:value});
if(b.mode==='hang_after_result')setInterval(()=>{},1000);
`;

// The cut-off tests wait out a real reviewer budget; it must leave the fake CLI
// ample time to print its final message on a loaded machine.
function fixture(t,{reviewTimeoutMs=null}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-failure-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({version:1,specsDir,codeProject,feature,identity,
    scope:['target.mjs'],requirements:['requirements.md']}));
  const answers=path.join(root,'answers'),bin=path.join(root,'bin');fs.mkdirSync(answers);fs.mkdirSync(bin);
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),typeof value==='string'?value:JSON.stringify(value));
  write('develop.json',develop());write('target-content.mjs','export const value = 42;\n');
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',...(reviewTimeoutMs?{timeoutMs:reviewTimeoutMs}:{}),
    preflight:{passed:true,provider:'claude',cli_model:'fixture',prompt_transport:'stdin',
      config_fingerprint:claudeReviewFingerprint({cwd:codeProject,model:'fixture'})}}));
  const behaviourFile=path.join(root,'behaviour.json'),callsFile=path.join(root,'calls.jsonl');
  // An explicit .mjs module behind a sh shim: never parsed as CommonJS.
  const fakeModule=path.join(root,'claude-fixture.mjs');fs.writeFileSync(fakeModule,fakeClaude(behaviourFile,callsFile));
  fs.writeFileSync(path.join(bin,'claude'),`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeModule)} "$@"\n`,{mode:0o700});
  const behave=(...queue)=>fs.writeFileSync(behaviourFile,JSON.stringify(queue));behave({mode:'ok'});
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'review-host-a',runtime:'claude',
      permissions:['--review-config','review.json'],answers:'answers',
      checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));return file;};
  const drive=(file,operation)=>{const run=spawnSync(process.execPath,[DRIVER,'--plan',file,operation],{encoding:'utf8',timeout:60000,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
      CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
    let result=null;try{result=JSON.parse(run.stdout).result;}catch{}
    return {status:run.status,stderr:run.stderr,result};};
  const store=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  const records=()=>JSON.parse(fs.readFileSync(store,'utf8')).records;
  const replay=()=>{const rows=records();return readRunnerHistory(rows,rows[0].payload.config,3);};
  const calls=()=>fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  const review=(attempt=1)=>['--review-config','review.json','--allow-review-attempt',String(attempt)];
  const awaitingReview=()=>{
    const first=drive(plan(),'advance');assert.equal(first.status,0,first.stderr);
    assert.equal(first.result.state,'awaiting_review');return first.result.packageDigest;
  };
  const decide=(packageDigest,attempt=1)=>drive(plan({mode:'resume',permissions:review(attempt),packageDigest,answers:undefined,checks:undefined}),'decision');
  const lastResult=()=>records().findLast(row=>row.payload.type==='review-invocation-result').payload;
  const intents=()=>records().filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
  return {root,specsDir,codeProject,answers,write,behave,plan,drive,store,records,replay,calls,review,awaitingReview,decide,lastResult,intents};
}

const apiErrors=[
  ['authentication_failed',401,'Invalid API key · Fix external API key','reviewer_auth_failed'],
  ['rate_limit',429,'API Error: 429 rate limited','reviewer_rate_limited'],
  ['server_error',529,'API Error: 529 Overloaded','reviewer_server_error'],
  ['model_not_found',404,'model: claude-opus-5 not found','reviewer_model_not_found'],
];
for(const [error,status,text,failure] of apiErrors)
test(`#8 real Claude CLI ${error} ends in a retryable review that names ${failure}`,t=>{
  const f=fixture(t),packageDigest=f.awaitingReview();
  f.behave({mode:'api_error',error,status,text});
  const failed=f.decide(packageDigest);
  assert.equal(failed.status,0,failed.stderr);
  assert.equal(failed.result.state,'pending_review');assert.equal(failed.result.code,'review_provider_failed');
  assert.equal(failed.result.pendingAction,'resume');assert.match(failed.result.reason,new RegExp(`^${failure}: `));
  const result=f.lastResult();
  assert.equal(result.outcome,'failed');assert.equal(result.reconciliationRequired,false);
  assert.equal(result.inspection.kind,'cm-provider-review-failure');assert.equal(result.inspection.category,'provider');
  assert.equal(result.inspection.failure,failure);assert.equal(result.observation.result.code,failure);
  // No verdict: the normalized stream ends after turn.started with the process exit.
  assert.deepEqual(result.observation.events.map(event=>event.event),['thread.started','turn.started','process_closed']);
  const history=f.replay();assert.equal(history.state.state,'pending_review');assert.equal(history.state.code,'review_provider_failed');
  if(error!=='authentication_failed')return;
  // After logging in, the same attempt is reviewed once more with a new grant.
  f.behave({mode:'ok'});
  const approved=f.decide(packageDigest);
  assert.equal(approved.status,0,approved.stderr);assert.equal(approved.result.state,'approved');
  assert.deepEqual(f.intents(),['develop-1','review-1','review-1-retry-1']);
  const registrations=f.records().filter(row=>row.payload.type==='review-invocation-registered');
  assert.equal(registrations.length,2);
  assert.notEqual(registrations[0].payload.grant.invocationId,registrations[1].payload.grant.invocationId);
  assert.notEqual(registrations[0].payload.grant.grantDigest,registrations[1].payload.grant.grantDigest);
  assert.equal(f.replay().state.state,'approved');assert.equal(f.calls().length,2);
});

test('#8 a reviewer with no init line is retryable once; the second failure is terminal and abandon is refused',t=>{
  const f=fixture(t),packageDigest=f.awaitingReview();
  f.behave({mode:'no_init'});
  const first=f.decide(packageDigest);
  assert.equal(first.result.state,'pending_review');assert.equal(first.result.code,'review_provider_failed');
  assert.match(first.result.reason,/^reviewer_stream_unrecognized: /);
  assert.equal(f.lastResult().inspection.providerThreadId,null);
  assert.deepEqual(f.lastResult().observation.events.map(event=>event.event),['process_closed']);
  const second=f.decide(packageDigest);
  assert.equal(second.result.state,'blocked');assert.equal(second.result.code,'review_provider_failed');
  assert.equal(second.result.pendingAction,'none');assert.equal(f.calls().length,2);
  const before=fs.readFileSync(f.store);
  const abandon=f.drive(f.plan({mode:'resume',permissions:['--review-config','review.json','--allow-abandon-review'],
    reason:'reviewer exited',answers:undefined,checks:undefined}),'abandon_review');
  assert.equal(abandon.result.outcome,'rejected');assert.deepEqual(fs.readFileSync(f.store),before);
  // The retry budget is spent; resume never dispatches a third review.
  assert.equal(f.decide(packageDigest).result.state,'blocked');assert.equal(f.calls().length,2);
});

const contractCases=[
  ['approved with a P2 note','contradictory_verdict',{verdict:'approved',
    findings:[{id:'nit-1',severity:'P2',path:'target.mjs',message:'Consider a named export',evidence:'line 1'}]}],
  ['changes_requested with only P3','contradictory_verdict',{verdict:'changes_requested',
    findings:[{id:'style-1',severity:'P3',path:'target.mjs',message:'Style',evidence:'line 1'}]}],
  ['a finding on a specification file','invalid_finding_path',{verdict:'changes_requested',
    findings:[{id:'spec-1',severity:'P2',path:'1.work/design.md',message:'Design mismatch',evidence:'design'}]}],
  ['examinedPaths not copied exactly','missing_material',{verdict:'approved',reverse:true}],
];
for(const [name,code,answer] of contractCases)
test(`#9 ${name} is a retryable ${code}, never a receipt`,t=>{
  const f=fixture(t),packageDigest=f.awaitingReview();
  f.behave({mode:'ok',...answer});
  const failed=f.decide(packageDigest);
  assert.equal(failed.status,0,failed.stderr);
  assert.equal(failed.result.state,'pending_review');assert.equal(failed.result.code,'review_verdict_invalid');
  assert.equal(failed.result.pendingAction,'resume');assert.match(failed.result.reason,new RegExp(`^${code}: `));
  const result=f.lastResult();
  assert.equal(result.outcome,'failed');assert.equal(result.inspection.category,'verdict');assert.equal(result.inspection.failure,code);
  // The real answer is journaled so replay re-derives the same violation.
  assert.equal(result.observation.result.value.verdict,answer.verdict);
  assert.equal(f.replay().state.receipts.length,0);assert.equal(f.calls()[0].verdictRules,true);
  if(code!=='contradictory_verdict'||answer.verdict!=='approved')return;
  f.behave({mode:'ok',verdict:'changes_requested',
    findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Rename the export',evidence:'line 1'}]});
  const retried=f.decide(packageDigest);
  assert.equal(retried.result.state,'changes_requested');assert.equal(retried.result.identity.attempt,2);
  assert.deepEqual(f.intents(),['develop-1','review-1','review-1-retry-1']);
});

test('#9 a blocked verdict stays terminal and says why instead of a bare code',t=>{
  const f=fixture(t),packageDigest=f.awaitingReview();
  f.behave({mode:'ok',verdict:'blocked',summary:'The approved design contradicts\nthe task',
    findings:[{id:'spec-conflict',severity:'P1',path:'target.mjs',message:'Spec conflict',evidence:'design vs task'}]});
  const blocked=f.decide(packageDigest);
  assert.equal(blocked.result.state,'blocked');assert.equal(blocked.result.code,'review_blocked');
  assert.equal(blocked.result.pendingAction,'none');assert.equal(blocked.result.identity.attempt,1);
  assert.match(blocked.result.reason,/^review_blocked: .*The approved design contradicts the task$/);
  assert.equal(f.replay().state.code,'review_blocked');
});

test('#9 every reviewer prompt states the verdict rules and what blocked means',t=>{
  const f=fixture(t);f.awaitingReview();
  const reviewPackage=f.records().at(-1).payload.checkpoint.reviewPackage;
  for(const provider of ['codex','claude']){
    const request=requestFor({invocationId:'prompt-check',identity,role:'reviewer',provider,requestedModel:'fixture',
      contextId:'cm-conversation-review-1',payload:{reviewPackage,priorReview:null}});
    const prompt=buildReviewPrompt(request,provider);
    assert(prompt.includes(VERDICT_RULES));
    assert.match(prompt,/approved requires zero P0, P1 and P2 findings/);
    assert.match(prompt,/changes_requested requires at least one P0, P1 or P2 finding/);
    assert.match(prompt,/blocked: use it only when no code revision inside the approved scope/);
    assert.match(prompt,/If the developer can fix it inside scope, use changes_requested, never blocked/);
    assert.match(prompt,/Specification, design and task files are not examinedPaths/);
  }
});

test('#8 a final message cut off by the reviewer timeout has an audited exit sharing the one redispatch',t=>{
  const f=fixture(t,{reviewTimeoutMs:5000}),packageDigest=f.awaitingReview();
  f.behave({mode:'hang_after_result'});
  const cut=f.decide(packageDigest);
  assert.equal(cut.status,1,cut.stderr);
  assert.equal(cut.result.state,'unknown');assert.equal(cut.result.code,'transport_timeout');
  assert.equal(cut.result.pendingAction,'abandon_review');
  const result=f.lastResult();
  assert.equal(result.outcome,'timed_out');assert.equal(result.reconciliationRequired,true);
  assert(result.observation.events.some(event=>event.event==='item.completed'));
  const abandonPlan=f.plan({mode:'resume',permissions:['--review-config','review.json','--allow-abandon-review'],
    reason:'reviewer stopped after its final message',answers:undefined,checks:undefined});
  const abandoned=f.drive(abandonPlan,'abandon_review');
  assert.equal(abandoned.status,0,abandoned.stderr);
  assert.equal(abandoned.result.outcome,'abandoned');assert.equal(abandoned.result.state,'pending_review');
  assert.equal(abandoned.result.code,'review_abandoned');assert.equal(abandoned.result.pendingAction,'resume');
  const record=f.records().at(-1).payload,registration=f.records().find(row=>row.payload.type==='review-invocation-registered');
  assert.equal(record.type,'review-invocation-abandoned');assert.equal(record.effectId,'review-1');
  assert.equal(record.registeredDigest,registration.digest);
  assert.equal(record.resultDigest,f.records().find(row=>row.payload.type==='review-invocation-result').digest);
  const log=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    .filter(row=>row.event==='review_abandoned');
  assert.equal(log.length,1);assert.equal(log[0].result_digest,record.resultDigest);
  // A second abandonment has nothing left to abandon.
  const before=fs.readFileSync(f.store);
  assert.equal(f.drive(abandonPlan,'abandon_review').result.outcome,'rejected');assert.deepEqual(fs.readFileSync(f.store),before);
  // The redispatch is the attempt's only one: a failing retry ends blocked.
  f.behave({mode:'api_error',error:'server_error',status:529,text:'API Error: 529 Overloaded'});
  const retried=f.decide(packageDigest);
  assert.equal(retried.result.state,'blocked');assert.equal(retried.result.code,'review_provider_failed');
  assert.deepEqual(f.intents(),['develop-1','review-1','review-1-retry-1']);
  const history=f.replay();assert.equal(history.state.state,'blocked');
  assert.equal(history.state.calls.filter(call=>call.terminal==='abandoned').length,1);
  assert.equal(history.state.sequence,history.state.calls.length);
});

test('#8 the journaled-result exit leads to a normal review and completion',t=>{
  const f=fixture(t,{reviewTimeoutMs:5000}),packageDigest=f.awaitingReview();
  f.behave({mode:'hang_after_result'},{mode:'ok'});
  assert.equal(f.decide(packageDigest).result.pendingAction,'abandon_review');
  const abandoned=f.drive(f.plan({mode:'resume',permissions:['--review-config','review.json','--allow-abandon-review'],
    reason:'reviewer stopped after its final message',answers:undefined,checks:undefined}),'abandon_review');
  assert.equal(abandoned.result.state,'pending_review');
  const approved=f.decide(packageDigest);
  assert.equal(approved.result.state,'approved');assert.equal(approved.result.pendingAction,'complete');
  const complete=f.drive(f.plan({mode:'resume',permissions:['--review-config','review.json'],packageDigest}),'complete');
  assert.equal(complete.status,0,complete.stderr);assert.equal(complete.result.state,'fixture_completed');
});

function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}
test('#8 legacy unknown results replay unchanged and forged failed results are refused',t=>{
  const f=fixture(t),packageDigest=f.awaitingReview();
  f.behave({mode:'no_init'});f.decide(packageDigest);
  const rows=f.records(),configuration=rows[0].payload.config,index=rows.findIndex(row=>row.payload.type==='review-invocation-result');
  const request=requestFor({invocationId:rows[index].payload.invocationId,identity,role:'reviewer',provider:'claude',requestedModel:'fixture',
    contextId:'cm-conversation-review-1',payload:{reviewPackage:rows.find(row=>row.payload.checkpoint?.reviewPackage)
      .payload.checkpoint.reviewPackage,priorReview:null}});
  assert.equal(request.requestDigest,rows.find(row=>row.payload.type==='review-invocation-registered').payload.requestDigest);
  const expectation=JSON.stringify({request,developerThreadId:'cm-conversation-author',excludedThreadIds:['review-host-a']});
  const legacy=code=>{
    // The shape an older version wrote for the same failure.
    const records=structuredClone(rows),result=records[index].payload,checkpoint=records.at(-1).payload.checkpoint;
    result.outcome='unknown';result.reconciliationRequired=true;result.observation.result.code=code;
    result.inspection=inspectProviderReview(JSON.stringify(result.observation),expectation);
    const view=Object.fromEntries(Object.entries(result).filter(([key])=>!['version','protocol','type','effectId','invocationId'].includes(key)));
    checkpoint.state='unknown';checkpoint.code='transport_incomplete';checkpoint.reason=null;
    checkpoint.reviewInvocation.result=view;checkpoint.calls.at(-1).terminal='unknown';checkpoint.calls.at(-1).resultDigest=digest(view);
    checkpoint.cache.at(-1).result=runnerStatus(checkpoint,configuration);
    return rechain(records);
  };
  for(const [code,abandonable] of [['missing_init',true],['unexpected_assistant',false]]){
    const history=readRunnerHistory(legacy(code),configuration,3);
    assert.equal(history.state.state,'unknown');assert.equal(history.state.code,'transport_incomplete');
    assert.equal(history.state.reviewInvocation.result.reconciliationRequired,true);
    // Only the explicit operator exit is new; nothing is reclassified or retried.
    assert.equal(history.reviewResultAbandon!==null,abandonable);
  }
  const forged=(change,expected)=>{const records=structuredClone(rows);change(records[index].payload);
    assert.throws(()=>readRunnerHistory(rechain(records),configuration,3),{code:expected});};
  forged(result=>{result.observation.result.code='output_limit';},'runner_invocation');
  forged(result=>{result.inspection.failure='reviewer_auth_failed';},'runner_history_mismatch');
  forged(result=>{result.reconciliationRequired=true;},'runner_invocation');
  // Even a consistently recomputed failure cannot name a thread that never started.
  forged(result=>{result.observation.events.unshift({event:'thread.started',provider_thread:'forged-thread'});
    result.inspection=inspectProviderReviewFailure(JSON.stringify(result.observation),expectation);},'runner_invocation');
});

// Runner-level fixture: the real V3 task runner and execution store with
// synthetic developer/reviewer adapters, for bounds the driver cannot reach fast.
const checksPassed=[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const grantFor=(request,authorizationAt)=>{
  const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.invocationId}`,adapterId:`${request.provider}-review-adapter`,
    invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,
    reviewerId:'reviewer',logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
    hostContextId:'actual-main',decisionId:'decision-1',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
  return {...body,grantDigest:digest(body)};
};
const reviewEvents=(onEvent,request,{result=true,close=true}={})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});
  onEvent({event:'turn.started',item_type:null});
  if(result){onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});}
  if(close)onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
};
const verdict=(request,value,findings=[])=>({status:'succeeded',value:{verdict:value,packageDigest:request.payload.reviewPackage.packageDigest,
  examinedPaths:reviewPaths(request.payload.reviewPackage),findings,summary:'Synthetic'}});
async function runnerFixture(t,fn,{timeoutMs=1000,reviewTimeoutMs}={}){
  const {createTaskRunner}=await import('../runtime/js/cm-ai/task-runner.mjs');
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-failure-runner-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),reviewsDir=path.join(specsRoot,'.reviews');
  fs.mkdirSync(root);fs.mkdirSync(reviewsDir,{recursive:true});
  const tasksPath=path.join(specsRoot,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(root,'code.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const runIdentity={repositoryId:'fixture',runId:'review-failure-runner',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'feature',specsRoot,identity:{repositoryId:runIdentity.repositoryId,runId:runIdentity.runId},
    fingerprints:{workflow:digest('review-failure'),config:digest('fixture'),inputs:digest('original')},create:true};
  let store=openTaskExecutionStore(owner),dispatches=0,checks=()=>checksPassed;
  const state={review:(request,control)=>{reviewEvents(control.onEvent,request);return verdict(request,'approved');},
    content:attempt=>`new ${attempt}\n`};
  const options={root,identity:runIdentity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer-logical',run:request=>{
      fs.writeFileSync(path.join(root,'code.js'),state.content(request.identity.attempt));return {version:1,invocationId:request.invocationId,
        contextId:request.contextId,provider:request.provider,effectiveModel:'fixture',status:'succeeded',accepted:true,
        result:{outcome:'implemented'}};}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-logical-1','review-logical-2'],run:(request,control)=>{dispatches++;return state.review(request,control);}}],
    check:request=>checks(request),
    taskCompletion:{reviewsDir,handoffs:[path.join(reviewsDir,'a1.json'),path.join(reviewsDir,'a2.json')]},
    reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
      authorize:(request,{authorizationAt})=>grantFor(request,authorizationAt),
      ...(reviewTimeoutMs===undefined?{}:{timeoutMs:reviewTimeoutMs})}};
  const make=(mode,extra={})=>createTaskRunner({...options,reviewInvocation:{...options.reviewInvocation,...extra},persistence:{store,mode,version:3}});
  const reopen=(extra={})=>{store.close();store=openTaskExecutionStore({...owner,create:false});return make('resume',extra);};
  // Simulate a host that died right after the last record of this type.
  const resumePrefix=type=>{
    const current=store.snapshot(),at=current.records.findLastIndex(record=>record.payload.type===type);assert(at>=0);store.close();
    const statePath=path.join(specsRoot,'.reviews','.execution',runIdentity.runId,'state.json');
    const body={version:current.version,identity:current.identity,fingerprints:current.fingerprints,records:current.records.slice(0,at+1)};
    fs.writeFileSync(statePath,JSON.stringify({...body,revision:digest(body)})+'\n',{mode:0o600});
    store=openTaskExecutionStore({...owner,create:false});return make('resume');
  };
  const effect=(kind,attempt=1,suffix='')=>({version:1,id:`${kind}-${attempt}${suffix}`,identity:{...runIdentity,attempt},kind});
  const records=()=>store.snapshot().records;
  t.after(()=>{store.close();fs.rmSync(temp,{recursive:true,force:true});});
  return fn({root,state,options,effect,records,make:(extra)=>make('create',extra),reopen,resumePrefix,dispatches:()=>dispatches,
    setChecks:value=>{checks=value;},replay:()=>readRunnerHistory(records(),records()[0].payload.config,3)});
}

test('#20 the runner review race uses the host bound, not the journaled call timeout',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>new Promise(resolve=>setTimeout(()=>{
    reviewEvents(control.onEvent,request);resolve(verdict(request,'approved'));},300));
  const runner=f.make();
  assert.equal((await runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,'approved');assert.equal(f.dispatches(),1);
  // The bound is transient: the journal keeps timeoutMs 50 and a resumed runner may raise it.
  assert.equal(f.records()[0].payload.config.timeoutMs,50);
  assert.equal(Object.hasOwn(f.records()[0].payload.config.reviewInvocation,'timeoutMs'),false);
  assert.deepEqual(f.reopen({timeoutMs:900000}).status(),reviewed);
},{timeoutMs:50,reviewTimeoutMs:3000}));

test('#20 without a host bound the journaled call timeout still cuts the review',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>new Promise(resolve=>setTimeout(()=>{
    reviewEvents(control.onEvent,request);resolve(verdict(request,'approved'));},300));
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,'pending_review');assert.equal(reviewed.code,'review_transport_timeout');
},{timeoutMs:50}));

test('#20 the host bound is validated before any journal write',t=>runnerFixture(t,async f=>{
  for(const timeoutMs of [0,1.5,'60000',3660001])assert.throws(()=>f.make({timeoutMs}),{code:'runner_invocation'});
  assert.equal(f.records().length,0);
}));

test('#20 the conversation factory sizes the review race above the reviewer budget',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-bound-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);fs.mkdirSync(specsDir);
  const definition={codeProject,specsDir,feature:'1.work',identity,scope:['code.js'],requirements:[]};
  const bridge={call:()=>assert.fail('no host call expected')};
  const preflight={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:'x'};
  return import('../runtime/js/cm-ai/host-conversation-execution.mjs').then(({createConversationExecution,REVIEW_BOUND_MARGIN_MS})=>{
    for(const [reviewTimeout,expected] of [[3000000,3000000+REVIEW_BOUND_MARGIN_MS],[3600000,3660000],[null,1800000],[60000,1800000]]){
      const review={model:'fixture',disabledSkills:[],preflight,...(reviewTimeout===null?{}:{timeoutMs:reviewTimeout})};
      const execution=createConversationExecution(definition,'host-fixture',bridge,review,null,null,false,'claude');
      assert.equal(execution.timeoutMs,1800000,'the journaled call timeout is unchanged');
      assert.equal(execution.reviewInvocation.timeoutMs,expected);
    }
  });
});

test('#20 the real host passes the raised review bound from review-config into the runner race',async t=>{
  const f=fixture(t,{reviewTimeoutMs:3000000}),packageDigest=f.awaitingReview();
  const {createConversationExecution}=await import('../runtime/js/cm-ai/host-conversation-execution.mjs');
  const {openControlRun,readRunDefinition}=await import('./cm-ai-run.mjs');
  const {readConversationReviewConfiguration}=await import('./cm-ai-host.mjs');
  const env={PATH:process.env.PATH,CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
  process.env.PATH=path.join(f.root,'bin')+path.delimiter+process.env.PATH;
  process.env.CM_WORKFLOW_HOME=path.join(f.root,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(f.root,'logs');
  t.after(()=>{for(const [key,value] of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const definition=readRunDefinition(path.join(f.root,'run.json'));
  const review=readConversationReviewConfiguration(path.join(f.root,'review.json'));
  const execution=createConversationExecution(definition,'review-host-a',{call:()=>assert.fail('no host call expected')},
    review,1,null,false,'claude');
  const run=await openControlRun(definition,'resume',execution);
  t.after(()=>run.close());
  const delays=[],originalTimer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{delays.push(delay);return originalTimer(callback,delay,...args);});
  const result=await run.host.handle({version:1,operation:'decision',requestId:'decision-1',identity,packageDigest});
  t.mock.restoreAll();
  assert.equal(result.state,'approved');
  assert(delays.includes(3060000),`runner race bound missing from ${delays}`);
  assert(delays.includes(3000000),`reviewer budget missing from ${delays}`);
  assert(!delays.includes(1800000),'the journaled call timeout no longer bounds the review');
  assert.equal(f.records()[0].payload.config.timeoutMs,1800000);
});

test('#8 abandoning a journaled result frees its effect slot: both attempts and completion fit the six-effect budget',t=>runnerFixture(t,async f=>{
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const seen=new Map();
  f.state.review=(request,control)=>{
    const attempt=request.identity.attempt,count=(seen.get(attempt)??0)+1;seen.set(attempt,count);
    // First review of each attempt: a final message, then the reviewer hangs.
    if(count===1){reviewEvents(control.onEvent,request,{close:false});return new Promise(()=>{});}
    reviewEvents(control.onEvent,request);
    return attempt===1?verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}])
      :verdict(request,'approved');
  };
  let runner=f.make();
  for(const attempt of [1,2]){
    assert.equal((await runner.executeEffect(f.effect('develop',attempt))).state,'awaiting_review');
    const cut=await runner.executeEffect(f.effect('review',attempt));
    assert.equal(cut.state,'unknown');assert.equal(cut.code,'transport_timeout');assert.equal(cut.abandonableReviewResult,true);
    runner=f.reopen();
    const entry=createCmAiConversationEntry({specsDir:path.dirname(f.options.taskCompletion.reviewsDir),codeProject:f.root,
      feature:'feature',identity:f.options.identity,runner,allowAbandonReview:true});
    const status=await entry.handle({version:1,operation:'status',requestId:'status',identity:f.options.identity});
    assert.equal(status.pendingAction,'abandon_review');
    const abandoned=runner.abandonReview({allowed:true,reason:'reviewer stopped after its final message'});
    assert.equal(abandoned.state,'pending_review');assert.equal(abandoned.code,'review_abandoned');
    assert.equal(runner.abandonReview({allowed:true,reason:'again'}).outcome,'rejected');
    runner=f.reopen();assert.deepEqual(runner.status(),abandoned);
    const retried=await runner.executeEffect(f.effect('review',attempt,'-retry-1'));
    assert.equal(retried.state,attempt===1?'changes_requested':'approved');
  }
  const complete=await runner.executeEffect(f.effect('complete',2));
  assert.notEqual(complete.outcome,'rejected');assert.notEqual(complete.code,'limit_exceeded');
  const history=f.replay();assert.equal(history.state.state,complete.state);
  assert.equal(history.state.calls.filter(call=>call.terminal==='abandoned').length,2);
  assert.equal(history.state.cache.length,7);
},{reviewTimeoutMs:200}));

test('#8 legacy timed_out results without inspection keep no exit',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request,{close:false});return new Promise(()=>{});};
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  assert.equal((await runner.executeEffect(f.effect('review'))).abandonableReviewResult,true);
  const records=structuredClone(f.records()),configuration=records[0].payload.config;
  const result=records.find(row=>row.payload.type==='review-invocation-result').payload;
  result.inspection=null;
  const view=Object.fromEntries(Object.entries(result).filter(([key])=>!['version','protocol','type','effectId','invocationId'].includes(key)));
  const checkpoint=records.at(-1).payload.checkpoint;
  checkpoint.reviewInvocation.result=view;checkpoint.calls.at(-1).resultDigest=digest(view);checkpoint.code='reconciliation_required';
  checkpoint.cache.at(-1).result=runnerStatus(checkpoint,configuration);
  const history=readRunnerHistory(rechain(records),configuration,3);
  assert.equal(history.state.state,'unknown');assert.equal(history.reviewResultAbandon,null);
},{reviewTimeoutMs:100}));

test('#21 an attempt-2 delivery identical to the rejected attempt 1 is a retryable same-attempt block',t=>{
  const f=fixture(t);
  fs.copyFileSync(path.join(f.answers,'develop.json'),path.join(f.answers,'develop-a2.json'));
  f.behave({mode:'ok',verdict:'changes_requested',findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Wrong value',evidence:'line 1'}]},
    {mode:'ok'});
  const run=f.drive(f.plan({permissions:f.review(1)}),'advance');
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.result.state,'blocked');assert.equal(run.result.code,'develop_unchanged_after_review');
  assert.equal(run.result.identity.attempt,2);assert.equal(run.result.pendingAction,'resume');
  assert.match(run.result.reason,/^develop_unchanged_after_review: /);
  assert.deepEqual(f.intents(),['develop-1','review-1','develop-2']);assert.equal(f.calls().length,1);
  // A changed second delivery proceeds under a fresh effect id in the same attempt.
  f.write('target-a2.mjs','export const value = 43;\n');f.write('develop-a2.json',develop({'target.mjs':'target-a2.mjs'}));
  const revised=f.drive(f.plan({mode:'resume',permissions:f.review(2)}),'advance');
  assert.equal(revised.status,0,revised.stderr);assert.equal(revised.result.identity.attempt,2);
  assert.deepEqual(f.intents().slice(0,6),['develop-1','review-1','develop-2','develop-2-retry-1','review-2','complete-2']);
  assert.equal(f.calls().length,2);assert.equal(f.replay().state.receipts.length,2);
});

test('#21 replay refuses an unchanged-after-review block outside attempt 2',t=>runnerFixture(t,async f=>{
  f.setChecks(()=>[{...checksPassed[0],outcome:'failed',exitCode:1}]);
  const runner=f.make();
  assert.equal((await runner.executeEffect(f.effect('develop'))).code,'develop_checks_not_passed');
  const records=structuredClone(f.records()),configuration=records[0].payload.config,checkpoint=records.at(-1).payload.checkpoint;
  checkpoint.code='develop_unchanged_after_review';checkpoint.cache.at(-1).result=runnerStatus(checkpoint,configuration);
  assert.throws(()=>readRunnerHistory(rechain(records),configuration,3),{code:'runner_develop'});
}));

test('#21 a gate block at attempt 2 is journaled and replayed instead of poisoning the store',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request);
    return request.identity.attempt===1?verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}])
      :verdict(request,'approved');};
  let runner=f.make();await runner.executeEffect(f.effect('develop'));
  assert.equal((await runner.executeEffect(f.effect('review'))).state,'changes_requested');
  f.setChecks(()=>[{...checksPassed[0],outcome:'failed',exitCode:1}]);
  const blocked=await runner.executeEffect(f.effect('develop',2));
  assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'develop_checks_not_passed');
  runner=f.reopen();assert.deepEqual(runner.status(),blocked);assert.equal(f.replay().state.code,'develop_checks_not_passed');
  // The retry redoes this attempt's own delivery, which changed the reviewed
  // attempt-1 tree on purpose and never became a package: it is dispatched
  // without first restoring that tree, and its new package is checked against
  // the task baseline (out-of-scope drift still refused) when it is built.
  f.setChecks(()=>checksPassed);
  assert.equal((await runner.executeEffect(f.effect('develop',2,'-retry-1'))).state,'awaiting_review');
  assert.equal((await runner.executeEffect(f.effect('review',2))).state,'approved');
}));

test('#21 redoing a gate-blocked attempt 2 still refuses out-of-scope drift',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request);
    return verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}]);};
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  assert.equal((await runner.executeEffect(f.effect('review'))).state,'changes_requested');
  f.setChecks(()=>[{...checksPassed[0],outcome:'failed',exitCode:1}]);
  assert.equal((await runner.executeEffect(f.effect('develop',2))).code,'develop_checks_not_passed');
  f.setChecks(()=>checksPassed);
  fs.writeFileSync(path.join(f.root,'outside.txt'),'drift\n');
  const redo=await runner.executeEffect(f.effect('develop',2,'-retry-1'));
  assert.notEqual(redo.state,'awaiting_review');assert.equal(redo.code,'out_of_scope');
}));

test('#21 a byte-identical attempt 2 through the runner blocks, then a changed one is reviewed',t=>runnerFixture(t,async f=>{
  let second='new 1\n';f.state.content=attempt=>attempt===1?'new 1\n':second;
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request);
    return request.identity.attempt===1?verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}])
      :verdict(request,'approved');};
  let runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const blocked=await runner.executeEffect(f.effect('develop',2));
  assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'develop_unchanged_after_review');
  assert.equal(blocked.packageDigest,f.records().find(row=>row.payload.checkpoint?.reviewPackage).payload.checkpoint.reviewPackage.packageDigest);
  assert.equal(runner.verificationBlocks(),1);
  runner=f.reopen();assert.deepEqual(runner.status(),blocked);
  second='new 2\n';
  assert.equal((await runner.executeEffect(f.effect('develop',2,'-retry-1'))).state,'awaiting_review');
  assert.equal(f.dispatches(),1);
}));

// Only a clean no-verdict failure or a complete contract-breaking answer retries.
const failureCases=[
  ['a failure without an observed process exit',(request,{onEvent})=>{
    onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});onEvent({event:'turn.started',item_type:null});
    return {status:'failed',code:'provider_failed'};},'transport_incomplete'],
  ['a failure after a final message',(request,{onEvent})=>{
    reviewEvents(onEvent,request,{result:true,close:false});
    onEvent({event:'process_closed',exit_code:1,signal:null,timed_out:false});
    return {status:'failed',code:'provider_failed'};},'transport_incomplete'],
  ['a contract-breaking answer from a process that exited non-zero',(request,{onEvent})=>{
    reviewEvents(onEvent,request,{close:false});onEvent({event:'process_closed',exit_code:1,signal:null,timed_out:false});
    return verdict(request,'approved',[{id:'nit',severity:'P2',path:'code.js',message:'Nit',evidence:'fixture'}]);},'transport_incomplete'],
  ['a malformed answer',(request,{onEvent})=>{reviewEvents(onEvent,request);
    return {status:'succeeded',value:{...verdict(request,'approved').value,unexpected:true}};},'observation_invalid'],
];
for(const [name,review,code] of failureCases)
test(`#8/#9 ${name} stays unknown and is never retried`,t=>runnerFixture(t,async f=>{
  f.state.review=review;
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,code);assert.equal(end.reviewInvocation.result.reconciliationRequired,true);
  assert.equal((await runner.executeEffect(f.effect('review',1,'-retry-1'))).code,'stage_mismatch');
  assert.equal(f.dispatches(),1);assert.equal(f.replay().state.state,'unknown');
}));

test('#8 replay refuses a journaled-result abandonment bound to the wrong records',t=>runnerFixture(t,async f=>{
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request,{close:false});return new Promise(()=>{});};
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  assert.equal(runner.abandonReview({allowed:true,reason:'reviewer stopped'}).state,'pending_review');
  const records=f.records(),configuration=records[0].payload.config;
  assert.equal(readRunnerHistory(records,configuration,3).state.code,'review_abandoned');
  for(const field of ['resultDigest','registeredDigest','invocationId','effectId']){
    const changed=structuredClone(records);changed.at(-1).payload[field]=field.endsWith('Digest')?'0'.repeat(64):'other';
    assert.throws(()=>readRunnerHistory(rechain(changed),configuration,3),{code:'runner_abandon'});
  }
  const early=structuredClone(records);early.splice(-2,1);
  assert.throws(()=>readRunnerHistory(rechain(early.map((row,index)=>({...row,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`}))),configuration,3));
},{reviewTimeoutMs:100}));

// Codex review of bf6b6f9: each abandoned invocation must leave the six-call cap
// exactly as it leaves the six-effect cap, or the retry after a second
// abandonment is the seventh counted call and its checkpoint is refused.
for(const exit of ['journaled-result','registered-without-result'])
test(`#8 abandoned reviews at both attempts plus an unchanged attempt-2 block still complete: ${exit}`,t=>runnerFixture(t,async f=>{
  const seen=new Map();let secondDeliveries=0;
  f.state.content=attempt=>attempt===1?'new 1\n':++secondDeliveries===1?'new 1\n':'new 2\n';
  f.state.review=(request,control)=>{
    const attempt=request.identity.attempt,count=(seen.get(attempt)??0)+1;seen.set(attempt,count);
    if(exit==='journaled-result'&&count===1){reviewEvents(control.onEvent,request,{close:false});return new Promise(()=>{});}
    reviewEvents(control.onEvent,request);
    return attempt===1?verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}])
      :verdict(request,'approved');
  };
  let runner=f.make();
  const abandonedReview=async attempt=>{
    const first=await runner.executeEffect(f.effect('review',attempt));
    if(exit==='journaled-result'){assert.equal(first.state,'unknown');assert.equal(first.abandonableReviewResult,true);runner=f.reopen();}
    else runner=f.resumePrefix('review-invocation-started');
    const abandoned=runner.abandonReview({allowed:true,reason:'operator confirmed the reviewer exited'});
    assert.equal(abandoned.state,'pending_review',JSON.stringify(abandoned));assert.equal(abandoned.code,'review_abandoned');
    runner=f.reopen();
    return runner.executeEffect(f.effect('review',attempt,'-retry-1'));
  };
  assert.equal((await runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  assert.equal((await abandonedReview(1)).state,'changes_requested');
  const unchanged=await runner.executeEffect(f.effect('develop',2));
  assert.equal(unchanged.state,'blocked');assert.equal(unchanged.code,'develop_unchanged_after_review');
  assert.equal((await runner.executeEffect(f.effect('develop',2,'-retry-1'))).state,'awaiting_review');
  const approved=await abandonedReview(2);
  assert.equal(approved.state,'approved',JSON.stringify(approved.code));
  // Completion itself is out of this fixture's reach (no handoff evidence); what
  // matters is that the complete effect is admitted and its checkpoint journaled.
  const complete=await runner.executeEffect(f.effect('complete',2));
  assert.notEqual(complete.outcome,'rejected');assert.notEqual(complete.code,'limit_exceeded');
  assert.notEqual(complete.code,'store_failure');
  const history=f.replay();assert.equal(history.state.state,complete.state);assert.equal(history.pending,null);
  assert.equal(f.records().at(-1).payload.effectId,'complete-2');
  assert.equal(history.state.calls.filter(call=>call.terminal==='abandoned').length,2);
  // develop-1, review-1, review-1-retry-1, develop-2, develop-2-retry-1, review-2, review-2-retry-1.
  assert.equal(history.state.calls.length,7);
  assert.deepEqual(f.reopen().status(),complete);
},{reviewTimeoutMs:200}));

// Codex re-review of 4e4c7a8: a retryable develop block whose developer call
// holds no effect slot (check_output_out_of_scope) could repeat until a
// developer call ran without a call slot and its checkpoint poisoned the store.
const strayOutput=[{id:'build',command:[process.execPath,'-e',
  "require('node:fs').mkdirSync('build',{recursive:true});require('node:fs').writeFileSync('build/out.o','x')"]}];
test('develop retries stop before dispatch when no reviewable delivery fits the call budget (real host)',t=>{
  const f=fixture(t),advance=(mode)=>{
    const run=f.drive(f.plan({mode,checks:strayOutput,...(mode==='resume'?{originalHostContext:'review-host-a'}:{})}),'advance');
    fs.rmSync(path.join(f.codeProject,'build'),{recursive:true,force:true});return run;};
  for(let round=1;round<=4;round++){
    const run=advance(round===1?'create':'resume');
    assert.equal(run.status,0,run.stderr);assert.equal(run.result.code,'check_output_out_of_scope');
    assert.equal(run.result.pendingAction,'resume');
  }
  // The fifth delivery uses the fifth call; a sixth could not also be reviewed.
  const fifth=advance('resume');
  assert.equal(fifth.status,0,fifth.stderr);
  assert.equal(fifth.result.state,'blocked');assert.equal(fifth.result.code,'develop_retry_limit');
  assert.equal(fifth.result.pendingAction,'none');
  assert.match(fifth.result.reason,/^develop_retry_limit: 本运行已用 5 次计数调用.*check_output_out_of_scope.*--supersede-reviewed-evidence/);
  const intents=f.intents();
  assert.deepEqual(intents,['develop-1',...[1,2,3,4].map(n=>`develop-1-retry-${n}`)]);
  assert.equal(f.records().at(-1).payload.type,'develop-retry-limit');
  // Resuming again dispatches nothing: no intent, no developer request.
  const after=advance('resume');
  assert.equal(after.status,0,after.stderr);assert.equal(after.result.code,'develop_retry_limit');
  assert.doesNotMatch(after.stderr,/应答 develop/);assert.deepEqual(f.intents(),intents);
  const history=f.replay();assert.equal(history.state.code,'develop_retry_limit');assert.equal(history.pending,null);
});

test('#retry-limit an older journal already out of call slots converts on the next develop request',t=>runnerFixture(t,async f=>{
  let developed=0;const content=f.state.content;f.state.content=attempt=>{developed++;return content(attempt);};
  f.setChecks(()=>{fs.writeFileSync(path.join(f.root,`stray-${developed}.o`),'x');return checksPassed;});
  let runner=f.make();
  for(const suffix of ['','-retry-1','-retry-2','-retry-3','-retry-4']){
    for(const name of fs.readdirSync(f.root).filter(name=>name.startsWith('stray-')))fs.rmSync(path.join(f.root,name));
    await runner.executeEffect(f.effect('develop',1,suffix));
  }
  assert.equal(runner.status().code,'develop_retry_limit');assert.equal(developed,5);
  for(const name of fs.readdirSync(f.root).filter(name=>name.startsWith('stray-')))fs.rmSync(path.join(f.root,name));
  // The shape an older version left: the fifth block without the limit record.
  runner=f.resumePrefix('effect-checkpoint');
  assert.equal(runner.status().code,'check_output_out_of_scope');
  const converted=await runner.executeEffect(f.effect('develop',1,'-retry-5'));
  assert.equal(converted.state,'blocked');assert.equal(converted.code,'develop_retry_limit');
  assert.equal(developed,5,'no developer call');
  assert.equal(f.records().at(-1).payload.type,'develop-retry-limit');
  assert(!f.records().some(row=>row.payload.effect?.id==='develop-1-retry-5'),'no intent');
  assert.deepEqual(f.reopen().status(),converted);
  // Terminal: a later develop request is refused before any intent.
  const refused=await f.reopen().executeEffect(f.effect('develop',1,'-retry-6'));
  assert.equal(refused.outcome,'rejected');assert.equal(refused.code,'stage_mismatch');assert.equal(developed,5);
}));

test('#retry-limit replay accepts the limit record only where the call budget is exhausted',t=>runnerFixture(t,async f=>{
  let developed=0;const content=f.state.content;f.state.content=attempt=>{developed++;return content(attempt);};
  f.setChecks(()=>{fs.writeFileSync(path.join(f.root,`stray-${developed}.o`),'x');return checksPassed;});
  const runner=f.make();
  for(const suffix of ['','-retry-1','-retry-2','-retry-3','-retry-4']){
    for(const name of fs.readdirSync(f.root).filter(name=>name.startsWith('stray-')))fs.rmSync(path.join(f.root,name));
    await runner.executeEffect(f.effect('develop',1,suffix));
  }
  const records=f.records(),configuration=records[0].payload.config,limit=records.at(-1).payload;
  assert.equal(limit.type,'develop-retry-limit');assert.equal(limit.countedCalls,5);
  assert.equal(limit.fromState,'blocked');assert.equal(limit.fromCode,'check_output_out_of_scope');
  const history=readRunnerHistory(records,configuration,3);assert.equal(history.state.code,'develop_retry_limit');
  assert.equal(limit.countedEffects,0);
  for(const [field,value] of [['countedCalls',4],['countedEffects',1],['fromCode','develop_checks_not_passed'],['fromState','ready']]){
    const changed=structuredClone(records);changed.at(-1).payload[field]=value;
    assert.throws(()=>readRunnerHistory(rechain(changed),configuration,3),{code:'runner_retry_limit'});
  }
  // Earlier, with a slot for a delivery and its review, the record is refused.
  const early=structuredClone(records.slice(0,-3));early.push({...structuredClone(records.at(-1)),
    payload:{...limit,countedCalls:4}});
  assert.throws(()=>readRunnerHistory(rechain(early.map((row,index)=>({...row,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`}))),configuration,3),{code:'runner_retry_limit'});
  // After the limit, no develop intent replays.
  const intent=structuredClone(records.findLast(row=>row.payload.type==='effect-intent'));
  intent.payload.effect.id='develop-1-retry-9';
  const extended=[...structuredClone(records),intent].map((row,index)=>({...row,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`}));
  assert.throws(()=>readRunnerHistory(rechain(extended),configuration,3),{code:'runner_stage'});
}));

// Blocks such as develop_checks_not_passed hold an effect slot. Enough of them
// used to leave a delivery that could reach approved but whose complete was then
// refused with limit_exceeded; now the run stops before that delivery.
// develop_checks_not_passed holds both a call and an effect slot. Five of them
// leave no room for another delivery and its review: the run stops cleanly.
test('repeated develop check failures stop at develop_retry_limit before a delivery that could not be reviewed (real host)',t=>{
  const f=fixture(t),marker=path.join(f.root,'checks-pass');
  const gated=[{id:'gate',command:[process.execPath,'-e',`process.exit(require('node:fs').existsSync(${JSON.stringify(marker)})?0:1)`]}];
  const advance=mode=>f.drive(f.plan({mode,checks:gated,...(mode==='resume'?{originalHostContext:'review-host-a'}:{})}),'advance');
  for(let round=1;round<=4;round++){
    const run=advance(round===1?'create':'resume');
    assert.equal(run.status,0,run.stderr);assert.equal(run.result.code,'develop_checks_not_passed');
    assert.equal(run.result.pendingAction,'resume');
  }
  const fifth=advance('resume');
  assert.equal(fifth.status,0,fifth.stderr);
  assert.equal(fifth.result.state,'blocked');assert.equal(fifth.result.code,'develop_retry_limit');
  assert.equal(fifth.result.pendingAction,'none');
  assert.match(fifth.result.reason,/^develop_retry_limit: 本运行已用 5 次计数调用.*5 个计数 effect.*develop_checks_not_passed.*--supersede-reviewed-evidence/);
  const limit=f.records().at(-1).payload;
  assert.deepEqual([limit.type,limit.countedCalls,limit.countedEffects],['develop-retry-limit',5,5]);
  const intents=f.intents();
  assert.deepEqual(intents,['develop-1',...[1,2,3,4].map(n=>`develop-1-retry-${n}`)]);
  // Even with the checks fixed, the run does not develop again.
  fs.writeFileSync(marker,'pass\n');
  const after=advance('resume');
  assert.equal(after.status,0,after.stderr);assert.equal(after.result.code,'develop_retry_limit');
  assert.doesNotMatch(after.stderr,/应答 develop/);assert.deepEqual(f.intents(),intents);
  assert.equal(f.replay().state.code,'develop_retry_limit');
});

// Codex third review of ccc0121: an older version legally reached approved with
// four develop_checks_not_passed blocks, a delivery and its review, i.e. all six
// effect slots, and then refused complete with limit_exceeded. This journal has
// only the old record grammar (the same bytes the base driver writes; checked
// against 40462ea in the audit), and the approved run must now complete.
const OLD_RECORD_TYPES=['init','effect-intent','effect-checkpoint','review-invocation-registered',
  'review-invocation-started','review-invocation-result'];
test('an approved run already holding all six effects (old grammar) completes (real host)',async t=>{
  const f=fixture(t),marker=path.join(f.root,'checks-pass');
  const gated=[{id:'gate',command:[process.execPath,'-e',`process.exit(require('node:fs').existsSync(${JSON.stringify(marker)})?0:1)`]}];
  const run=(operation,extra={})=>f.drive(f.plan({mode:'resume',originalHostContext:'review-host-a',checks:gated,...extra}),operation);
  for(let round=1;round<=4;round++)
    assert.equal(run('advance',round===1?{mode:'create',originalHostContext:undefined}:{}).result.code,'develop_checks_not_passed');
  fs.writeFileSync(marker,'pass\n');
  const delivered=run('advance');assert.equal(delivered.result.state,'awaiting_review',JSON.stringify(delivered.result));
  const packageDigest=delivered.result.packageDigest;
  assert.equal(run('decision',{permissions:f.review(1),packageDigest}).result.state,'approved');
  const {completedEffectCount,effectSlotFree}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const approved=f.replay();
  assert.equal(completedEffectCount(approved.state.cache,approved.state.calls),6);
  assert.deepEqual([...new Set(f.records().map(row=>row.payload.type))].filter(type=>!OLD_RECORD_TYPES.includes(type)),[]);
  assert(!f.records().some(row=>row.payload.outcome==='failed'));
  // Only complete is admitted past the six effects; develop and review are not.
  for(const [kind,free] of [['complete',true],['develop',false],['review',false]])
    assert.equal(effectSlotFree(kind,approved.state.cache,approved.state.calls),free,kind);
  const completed=run('complete',{packageDigest});
  assert.equal(completed.status,0,completed.stderr);
  assert.equal(completed.result.state,'fixture_completed',JSON.stringify(completed.result));
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/\[x\] T-001/);
  assert.equal(f.replay().state.state,'fixture_completed');
});

test('#retry-limit a changes_requested verdict with too few slots left ends the run at once',t=>runnerFixture(t,async f=>{
  let checks=0;f.setChecks(()=>++checks<=3?[{...checksPassed[0],outcome:'failed',exitCode:1}]:checksPassed);
  f.state.review=(request,control)=>{reviewEvents(control.onEvent,request);
    return verdict(request,'changes_requested',[{id:'F1',severity:'P2',path:'code.js',message:'Fix',evidence:'fixture'}]);};
  const runner=f.make();
  for(const suffix of ['','-retry-1','-retry-2'])assert.equal((await runner.executeEffect(f.effect('develop',1,suffix))).code,'develop_checks_not_passed');
  assert.equal((await runner.executeEffect(f.effect('develop',1,'-retry-3'))).state,'awaiting_review');
  // Five calls and effects after review-1: develop-2 and review-2 need two more.
  const reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,'blocked');assert.equal(reviewed.code,'develop_retry_limit');assert.equal(reviewed.identity.attempt,2);
  assert.match(reviewed.reason,/changes_requested。/);
  const limit=f.records().at(-1).payload;
  assert.deepEqual([limit.fromState,limit.fromCode,limit.countedCalls,limit.countedEffects],['changes_requested',null,5,5]);
  assert.deepEqual(f.reopen().status(),reviewed);
}));

// Completion re-checks blocked by changed check results used to hold effect
// slots, so an approved task could end with its complete refused by
// limit_exceeded. They now have their own bound and a clean terminal.
function completionFixture(t){
  const f=fixture(t),marker=path.join(f.root,'checks-pass');
  const gated=[{id:'gate',command:[process.execPath,'-e',`process.exit(require('node:fs').existsSync(${JSON.stringify(marker)})?0:1)`]}];
  const pass=value=>value?fs.writeFileSync(marker,'pass\n'):fs.rmSync(marker,{force:true});
  const run=(operation,{mode='resume',review=false,packageDigest}={})=>f.drive(f.plan({mode,checks:gated,
    ...(mode==='resume'?{originalHostContext:'review-host-a'}:{}),...(review?{permissions:f.review(1)}:{}),
    ...(packageDigest?{packageDigest}:{})}),operation);
  return {...f,pass,run};
}
test('repeated completion re-check blocks stop at completion_retry_limit instead of an uncompletable approval (real host)',t=>{
  const f=completionFixture(t);f.pass(true);
  const delivered=f.run('advance',{mode:'create'});
  assert.equal(delivered.status,0,delivered.stderr);assert.equal(delivered.result.state,'awaiting_review');
  const packageDigest=delivered.result.packageDigest;
  assert.equal(f.run('decision',{review:true,packageDigest}).result.state,'approved');
  f.pass(false);
  for(let block=1;block<=3;block++){
    const blocked=f.run('complete',{packageDigest});
    assert.equal(blocked.status,0,blocked.stderr);assert.equal(blocked.result.code,'completion_checks_changed');
    assert.equal(blocked.result.pendingAction,'complete');
  }
  // The fourth block spends the last re-check: terminal, not another retry.
  const fourth=f.run('complete',{packageDigest});
  assert.equal(fourth.status,0,fourth.stderr);
  assert.equal(fourth.result.state,'blocked');assert.equal(fourth.result.code,'completion_retry_limit');
  assert.equal(fourth.result.pendingAction,'none');
  assert.match(fourth.result.reason,/^completion_retry_limit: 完成前复查已 4 次被拦下.*completion_checks_changed.*--supersede-reviewed-evidence/);
  const limit=f.records().at(-1).payload;
  assert.deepEqual([limit.type,limit.fromCode,limit.completionBlocks],['completion-retry-limit','completion_checks_changed',4]);
  const intents=f.intents();
  assert.deepEqual(intents,['develop-1','review-1','complete-1',...[1,2,3].map(n=>`complete-1-retry-${n}`)]);
  // Fixing the environment afterwards does not reopen this run.
  f.pass(true);
  const after=f.run('advance');
  assert.equal(after.status,0,after.stderr);assert.equal(after.result.code,'completion_retry_limit');
  assert.deepEqual(f.intents(),intents);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/\[ \] T-001/);
  assert.equal(f.replay().state.code,'completion_retry_limit');
});

test('completion re-checks no longer eat the six effects: develop blocks plus re-checks still complete (real host)',t=>{
  const f=completionFixture(t);f.pass(false);
  for(const mode of ['create','resume'])assert.equal(f.run('advance',{mode}).result.code,'develop_checks_not_passed');
  f.pass(true);
  const delivered=f.run('advance');assert.equal(delivered.result.state,'awaiting_review');
  const packageDigest=delivered.result.packageDigest;
  assert.equal(f.run('decision',{review:true,packageDigest}).result.state,'approved');
  // Four effects held; three re-check blocks would previously have used the rest.
  f.pass(false);
  for(let block=1;block<=3;block++)assert.equal(f.run('complete',{packageDigest}).result.code,'completion_checks_changed');
  f.pass(true);
  const completed=f.run('complete',{packageDigest});
  assert.equal(completed.status,0,completed.stderr);assert.equal(completed.result.state,'fixture_completed',JSON.stringify(completed.result));
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/\[x\] T-001/);
});

test('#retry-limit replay accepts the completion limit only once the re-check bound is spent',t=>{
  const f=completionFixture(t);f.pass(true);
  const packageDigest=f.run('advance',{mode:'create'}).result.packageDigest;
  f.run('decision',{review:true,packageDigest});f.pass(false);
  for(let block=1;block<=4;block++)f.run('complete',{packageDigest});
  const records=f.records(),configuration=records[0].payload.config;
  assert.equal(records.at(-1).payload.type,'completion-retry-limit');
  assert.equal(readRunnerHistory(records,configuration,3).state.code,'completion_retry_limit');
  for(const [field,value] of [['completionBlocks',3],['fromCode','completion_package_changed']]){
    const changed=structuredClone(records);changed.at(-1).payload[field]=value;
    assert.throws(()=>readRunnerHistory(rechain(changed),configuration,3),{code:'runner_retry_limit'});
  }
  // Placed after the third block, while one re-check is still allowed, it is refused.
  const cut=records.findLastIndex(row=>row.payload.type==='effect-intent');
  const early=[...structuredClone(records.slice(0,cut)),{...structuredClone(records.at(-1)),
    payload:{...records.at(-1).payload,completionBlocks:3}}].map((row,index)=>({...row,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`}));
  assert.throws(()=>readRunnerHistory(rechain(early),configuration,3),{code:'runner_retry_limit'});
  // After the limit no complete intent replays.
  const intent=structuredClone(records.findLast(row=>row.payload.type==='effect-intent'));
  intent.payload.effect.id='complete-1-retry-9';
  const extended=[...structuredClone(records),intent].map((row,index)=>({...row,seq:index+1,
    id:`runner.${String(index+1).padStart(6,'0')}`}));
  assert.throws(()=>readRunnerHistory(rechain(extended),configuration,3),{code:'runner_stage'});
});

test('#retry-limit an older journal past the completion re-check bound converts on the next complete request',t=>runnerFixture(t,async f=>{
  let failing=false;f.setChecks(()=>failing?[{...checksPassed[0],outcome:'failed',exitCode:1}]:checksPassed);
  let runner=f.make();
  await runner.executeEffect(f.effect('develop'));
  assert.equal((await runner.executeEffect(f.effect('review'))).state,'approved');
  failing=true;
  for(const suffix of ['','-retry-1','-retry-2','-retry-3'])await runner.executeEffect(f.effect('complete',1,suffix));
  assert.equal(runner.status().code,'completion_retry_limit');
  // The shape an older version left: the fourth block without the limit record.
  runner=f.resumePrefix('effect-checkpoint');
  assert.equal(runner.status().code,'completion_checks_changed');
  const intents=f.records().filter(row=>row.payload.type==='effect-intent').length;
  const converted=await runner.executeEffect(f.effect('complete',1,'-retry-4'));
  assert.equal(converted.state,'blocked');assert.equal(converted.code,'completion_retry_limit');
  assert.equal(f.records().at(-1).payload.type,'completion-retry-limit');
  assert.equal(f.records().filter(row=>row.payload.type==='effect-intent').length,intents,'no intent');
  assert.deepEqual(f.reopen().status(),converted);
}));
