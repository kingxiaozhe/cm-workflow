// R2-01: the recovery table of design 3.4 driven through the real batch session
// entry (cm-ai-batch-drive.mjs -> cm-ai-batch-host.mjs -> member run). The test
// plays the current session on the live develop channel. Every scenario checks the
// number of live develop requests, the final state/code, the target bytes, the
// review count (fixture Codex witness) and the member's durable journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const BATCH=fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url));
const key='1.work/T-001',identity={repositoryId:'session-recovery-fixture'};
const ORIGINAL='export const value = 1;\n',PROPOSED='export const value = 42;\n';
const sha=text=>createHash('sha256').update(text).digest('hex');
const learning={application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};

// Same fixture as cm-ai-batch-session-e2e.test.mjs, with a tracked target.mjs so a
// stale proposal and a partially changed code root can be told apart.
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-session-recovery-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'app'),bin=path.join(root,'bin'),witness=path.join(root,'witness.jsonl');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: walk the page\n  - 范围: `target.mjs`\n  - 开发: 会话\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],
    specFiles:buildManifest(specsDir),taskGrammar:3}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(codeProject,'target.mjs'),ORIGINAL);
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'codex'},
    roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'codex-cli'}}}));
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const r=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({batch:{version:1,repositoryId:identity.repositoryId,batchId:'session-recovery-batch',
    specsDir,codeProject,tasks:[{feature:'1.work',taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']}],
    memberDevelopment:{[key]:'session'}},
    workflows:{[key]:{qa:null,documentationPaths:[],applicableAgentFiles:[]}}}));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({version:2,development:'provider',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(root,'protected.json'),JSON.stringify({model:'fixture',timeoutMs:5000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  const answers=path.join(root,'answers','1.work','T-001');fs.mkdirSync(answers,{recursive:true});
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected'}));
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),record=row=>fs.appendFileSync(${JSON.stringify(witness)},JSON.stringify(row)+'\\n');
if(args[0]==='sandbox'){
  const command=args.slice(args.indexOf('--')+1);
  // A check whose answer never arrives: the first check after hang-check was
  // armed outlives the runner's call limit (the marker is consumed).
  const hang=${JSON.stringify(path.join(root,'hang-check'))};
  if(command.includes('--check')&&fs.existsSync(hang)){fs.rmSync(hang);record({type:'check_hang'});setTimeout(()=>process.exit(0),20000);return;}
  record({type:command.includes('--check')?'check':'sandbox'});
  const checked=cp.spawnSync(command[0],command.slice(1),{cwd:process.cwd(),encoding:'utf8'});
  process.stdout.write(checked.stdout??'');process.stderr.write(checked.stderr??'');process.exit(checked.status??1);
}
let prompt='';process.stdin.on('data',part=>prompt+=part);process.stdin.on('end',()=>{
  if(prompt.includes('<cm-developer-data-json>')){record({type:'provider_develop'});process.exit(1);}
  const data=JSON.parse(prompt.split('<cm-review-data-json>\\n')[1]);
  const value={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic independent review'};
  record({type:'review',attempt:data.reviewPackage.identity.attempt});
  for(const event of [{type:'thread.started',thread_id:'fixture-session-member-review'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])
    process.stdout.write(JSON.stringify(event)+'\\n');
});
`,{mode:0o700});
  const plan=path.join(root,'plan.json'),exchange=path.join(root,'exchange');
  fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'create',hostContext:'session-recovery-host',controlConfig:'control.json',
    permissions:['--review-config','review.json','--protected-config','protected.json'],answers:'answers',
    liveEvidence:{directory:'exchange',kinds:['develop'],timeoutMs:60000}}));
  // The member run's host-call limit for a session member is fixed at 30 minutes
  // (host-conversation-execution.mjs outerTimeoutMs) and journaled in the run
  // config. This preload leaves the journaled value alone and only shortens the
  // actual 30-minute timers armed while the shrink file holds a positive number.
  const shrink=path.join(root,'shrink-ms'),preload=path.join(root,'shrink-timer.mjs');
  fs.writeFileSync(preload,`import fs from 'node:fs';
const original=globalThis.setTimeout;
const patched=function(fn,delay,...rest){
  if(delay===1800000){try{const value=Number(fs.readFileSync(${JSON.stringify(shrink)},'utf8'));if(value>0)delay=value;}catch{}}
  return original.call(this,fn,delay,...rest);
};
for(const key of Reflect.ownKeys(original))if(!Reflect.has(patched,key)||typeof key==='symbol')try{patched[key]=original[key];}catch{}
globalThis.setTimeout=patched;
`);
  return {root,specsDir,codeProject,plan,witness,exchange,shrink,target:path.join(codeProject,'target.mjs'),
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_NOTIFY_OFF:'1',
      NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${pathToFileURL(preload).href}`.trim(),
      CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}};
}
const writePlan=(f,patch)=>fs.writeFileSync(f.plan,JSON.stringify({...JSON.parse(fs.readFileSync(f.plan,'utf8')),...patch}));
const resumePlan=(f,patch={})=>writePlan(f,{mode:'resume',originalHostContext:'session-recovery-host',...patch});
// Every live develop request any driver wrote, oldest first.
function developRequests(f){
  if(!fs.existsSync(f.exchange))return [];
  const out=[];
  for(const dir of fs.readdirSync(f.exchange)){
    const sub=path.join(f.exchange,dir);if(!fs.statSync(sub).isDirectory())continue;
    for(const name of fs.readdirSync(sub).filter(item=>item.endsWith('.request.json'))){
      const file=path.join(sub,name),row=JSON.parse(fs.readFileSync(file,'utf8'));
      if(row.kind==='develop')out.push({file,row,mtime:fs.statSync(file).mtimeMs});
    }
  }
  return out.sort((a,b)=>a.mtime-b.mtime);
}
const witness=f=>fs.existsSync(f.witness)?fs.readFileSync(f.witness,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const reviews=f=>witness(f).filter(row=>row.type==='review').map(row=>row.attempt);
function journal(f){
  const dir=path.join(f.specsDir,'.reviews','.execution');
  const runs=fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>fs.existsSync(path.join(dir,name,'state.json'))):[];
  assert.equal(runs.length,1,`one member run: ${runs}`);
  return JSON.parse(fs.readFileSync(path.join(dir,runs[0],'state.json'),'utf8')).records;
}
const types=f=>journal(f).map(row=>row.payload.type);
const effectIds=f=>journal(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
const lastCheckpoint=f=>journal(f).filter(row=>row.payload.type==='effect-checkpoint').at(-1)?.payload.checkpoint??null;
const dump=f=>JSON.stringify({types:types(f),effects:effectIds(f),cp:lastCheckpoint(f)&&{s:lastCheckpoint(f).state,c:lastCheckpoint(f).code,a:lastCheckpoint(f).attempt},dev:developRequests(f).length,rev:reviews(f),file:fs.readFileSync(f.target,'utf8')});
const proposal=(request,overrides={})=>({status:'succeeded',value:{outcome:'implemented',...learning},
  edits:[{path:'target.mjs',beforeSha256:request.payload.expected['target.mjs'],content:PROPOSED}],...overrides});
function reply(file,request,result){
  const target=file.replace(/\.request\.json$/,'.result.json'),tmp=target+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({type:'host_result',sessionId:request.sessionId,callId:request.callId,
    requestDigest:request.requestDigest,result}),{mode:0o600});fs.renameSync(tmp,target);
}
// One driver invocation. respond(request,index) returns a result to write, or
// undefined to leave the request unanswered. kill(request) may stop the whole
// driver process group (driver + batch host) with SIGKILL.
async function drive(f,{operation='advance',respond=request=>proposal(request),onRequest=null,env={},timeoutMs=90000}={}){
  const seen=new Set(developRequests(f).map(item=>item.file));
  const child=spawn(process.execPath,[BATCH,'--plan',f.plan,operation],{env:{...f.env,...env},stdio:['ignore','pipe','pipe'],detached:true});
  let stdout='',stderr='',killed=false;child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  // The batch host runs in its own process group (drive-core.mjs): kill both groups.
  const killGroup=()=>{killed=true;
    const ps=spawnSync('ps',['-A','-o','pid=,ppid='],{encoding:'utf8'}).stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    for(const [pid,ppid] of ps)if(ppid===child.pid)try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}
    try{process.kill(-child.pid,'SIGKILL');}catch{}};
  let index=0;
  const timer=setInterval(()=>{try{
    for(const {file,row} of developRequests(f)){
      if(seen.has(file))continue;seen.add(file);
      if(onRequest&&onRequest(row,{kill:killGroup,file})===false)continue;
      const result=respond(row,index++);if(result!==undefined)reply(file,row,result);
    }
  }catch(error){stderr+=`\n[test] ${error.stack}`;}},50);
  const code=await new Promise(resolve=>{const kill=setTimeout(killGroup,timeoutMs);child.on('exit',(value,signal)=>{clearTimeout(kill);resolve(value??signal);});});
  clearInterval(timer);
  if(killed){await new Promise(resolve=>setTimeout(resolve,300));return {code,stdout,stderr,killed,result:null};}
  let result=null;try{result=JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1)).result;}catch{}
  return {code,stdout,stderr,killed,result};
}
const killOnRequest={respond:()=>undefined,onRequest:(row,{kill})=>{setTimeout(kill,300);return false;}};
function recoveryPlan(f,patch={}){
  const plan=JSON.parse(fs.readFileSync(f.plan,'utf8'));
  for(const field of ['taskKey','reason','expectedControl'])delete plan[field];
  fs.writeFileSync(f.plan,JSON.stringify({...plan,...patch}));
}
const attempts=f=>developRequests(f).map(item=>item.row.payload.request.identity.attempt);
function assertSessionOnly(f){
  assert.equal(witness(f).filter(row=>row.type==='provider_develop').length,0,'the session member never reaches the provider');
}
// The driver exits 1 when the member's state is unknown or needs reconciling
// (drive-core.mjs hostResponseFailed), else 0; either way it printed a result.
function settled(r){
  assert.ok(r.result,`no result: ${r.stderr.slice(-2000)}`);
  assert.equal(r.code,r.result.state==='unknown'||r.result.pendingAction==='reconcile'?1:0,r.stderr.slice(-2000));
}
const summary=r=>JSON.stringify(r.result??{code:r.code,stdout:r.stdout.slice(-1500),stderr:r.stderr.slice(-2500)}).slice(0,3000);

// Row 2: the host records unknown/call_timeout; the code root still equals the
// round start, so advance redoes the same round with a new effect id.
test('row 2: a timed-out session develop is redone in the same round by advance and completes with one review',async t=>{
  const f=fixture(t);
  fs.writeFileSync(f.shrink,'2500');
  const first=await drive(f,{respond:()=>undefined});
  settled(first);
  assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction,first.result.guidance.recoveryOperation],
    ['blocked','develop_call_timeout','resume','advance'],summary(first));
  assert.deepEqual([lastCheckpoint(f).state,lastCheckpoint(f).code],['unknown','call_timeout'],'the journal keeps the raw timeout');
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL);
  fs.rmSync(f.shrink);resumePlan(f);
  const second=await drive(f);
  settled(second);
  assert.deepEqual([second.result.state,second.result.code],['fixture_completed','qa_triggered'],summary(second));
  assert.deepEqual(attempts(f),[1,1],'one new live request, same round');
  assert.deepEqual(effectIds(f),['develop-1','develop-1-retry-1','review-1','complete-1']);
  assert.equal(types(f).filter(type=>type==='develop-timeout-retry').length,1);
  assert.deepEqual(reviews(f),[1],'the timeout spent no review round');
  assert.equal(fs.readFileSync(f.target,'utf8'),PROPOSED);
  assertSessionOnly(f);
});

// Rows 2/2b: at most 2 timeout redos per run; afterwards no exit re-sends the request.
test('row 2b: after two timeout redos the third timeout stays stopped and advance sends no new develop request',async t=>{
  const f=fixture(t);
  fs.writeFileSync(f.shrink,'2500');
  const results=[];
  for(let round=0;round<3;round++){
    if(round)resumePlan(f);
    const r=await drive(f,{respond:()=>undefined});settled(r);results.push(r.result);
  }
  assert.deepEqual(results.map(r=>r.code),['develop_call_timeout','develop_call_timeout','call_timeout']);
  assert.deepEqual(effectIds(f),['develop-1','develop-1-retry-1','develop-1-retry-2']);
  assert.equal(types(f).filter(type=>type==='develop-timeout-retry').length,2,'budget: two redos per run');
  const before=journal(f);
  const again=await drive(f);
  settled(again);
  assert.deepEqual([again.result.state,again.result.code,again.result.pendingAction,again.result.guidance.recoveryOperation],
    ['unknown','call_timeout','reconcile',null],summary(again));
  assert.deepEqual(journal(f),before,'nothing recorded');
  assert.deepEqual(attempts(f),[1,1,1],'no fourth live request');
  assert.deepEqual(reviews(f),[]);
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL);
  assertSessionOnly(f);
});

// Row 3: an invalid proposal (an out-of-scope path) is a retryable block; advance asks
// the same round again and spends no review round.
test('row 3: an invalid session proposal blocks with developer_result_invalid and advance re-requests the same round',async t=>{
  const f=fixture(t);
  const first=await drive(f,{respond:request=>proposal(request,{edits:[{path:'other.mjs',beforeSha256:null,content:'x\n'}]})});
  settled(first);
  assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction,first.result.guidance.recoveryOperation],
    ['blocked','developer_result_invalid','resume','advance'],summary(first));
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL);
  assert.ok(!fs.existsSync(path.join(f.codeProject,'other.mjs')),'nothing outside the scope was written');
  assert.deepEqual(reviews(f),[]);
  resumePlan(f);
  const second=await drive(f);
  settled(second);
  assert.deepEqual([second.result.state,second.result.code],['fixture_completed','qa_triggered'],summary(second));
  assert.deepEqual(attempts(f),[1,1]);
  assert.deepEqual(effectIds(f),['develop-1','develop-1-retry-1','review-1','complete-1']);
  assert.deepEqual(reviews(f),[1],'one review round in all');
  assert.equal(fs.readFileSync(f.target,'utf8'),PROPOSED);
  assertSessionOnly(f);
});

// Row 4: a stale proposal (beforeSha256 differs, disk is not the proposal) stays blocked.
test('row 4: a stale session proposal stays blocked on protected_edit_stale; advance sends nothing and keeps the file',async t=>{
  const f=fixture(t);
  const first=await drive(f,{respond:request=>proposal(request,{edits:[{path:'target.mjs',beforeSha256:sha('drifted\n'),content:PROPOSED}]})});
  settled(first);
  assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction,first.result.guidance.recoveryOperation],
    ['blocked','protected_edit_stale','none',null],summary(first));
  const before=journal(f);
  resumePlan(f);
  const second=await drive(f);
  settled(second);
  assert.deepEqual([second.result.outcome,second.result.state,second.result.code],['reported','blocked','protected_edit_stale'],summary(second));
  assert.deepEqual(journal(f),before,'nothing recorded');
  assert.deepEqual(effectIds(f),['develop-1']);
  assert.deepEqual(attempts(f),[1],'no new live request');
  assert.deepEqual(reviews(f),[]);
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL,'the file is kept, never overwritten');
  assertSessionOnly(f);
});

// Row 5: the develop succeeded and was applied; the check after it never answered.
// advance journals develop-recheck and re-runs only the checks, never the develop.
test('row 5: a check answer gap after a delivered session develop re-runs only the checks on advance',async t=>{
  const f=fixture(t);
  // The check's own sandbox limit must outlast the shortened runner call limit.
  fs.writeFileSync(path.join(f.root,'protected.json'),JSON.stringify({model:'fixture',timeoutMs:60000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  fs.writeFileSync(f.shrink,'6000');fs.writeFileSync(path.join(f.root,'hang-check'),'');
  const first=await drive(f);
  settled(first);
  assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction,first.result.guidance.recoveryOperation],
    ['blocked','check_answer_missing','resume','advance'],summary(first));
  assert.equal(witness(f).filter(row=>row.type==='check_hang').length,1);
  assert.equal(fs.readFileSync(f.target,'utf8'),PROPOSED,'the delivery is on disk');
  fs.rmSync(f.shrink);resumePlan(f);
  const second=await drive(f);
  settled(second);
  assert.deepEqual([second.result.state,second.result.code],['fixture_completed','qa_triggered'],summary(second));
  assert.deepEqual(attempts(f),[1],'the re-check never asks the session to develop again');
  assert.equal(types(f).filter(type=>type==='develop-recheck').length,1);
  assert.equal(types(f).filter(type=>type==='develop-worker').length,2,'one proposal apply in all');
  assert.ok(witness(f).filter(row=>row.type==='check').length>=1,'the checks re-ran');
  assert.deepEqual(reviews(f),[1]);
  assert.equal(fs.readFileSync(f.target,'utf8'),PROPOSED);
  assertSessionOnly(f);
});

// Row 6: the session legitimately cannot do the task.
test('row 6: a legitimate blocked outcome stops at blocked/failed with the reason and advance asks nothing more',async t=>{
  const f=fixture(t),why='浏览器走查环境不可用';
  const first=await drive(f,{respond:()=>({status:'succeeded',value:{outcome:'blocked',reason:why,...learning},edits:[]})});
  settled(first);
  assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction,first.result.blockedReason],
    ['blocked','failed','none',why],summary(first));
  assert.equal(lastCheckpoint(f).calls.at(-1).blockedReason,why,'the reason is journaled');
  const before=journal(f);
  resumePlan(f);
  const second=await drive(f);
  settled(second);
  assert.deepEqual([second.result.outcome,second.result.state,second.result.code,second.result.blockedReason],
    ['reported','blocked','failed',why],summary(second));
  assert.deepEqual(journal(f),before,'nothing recorded');
  assert.deepEqual(attempts(f),[1]);
  assert.deepEqual(reviews(f),[]);
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL);
  assertSessionOnly(f);
});

async function statusTarget(f){
  recoveryPlan(f);
  const status=await drive(f,{operation:'status'});settled(status);
  return status.result;
}
async function abandon(f,target,reason='Session host was killed before answering'){
  recoveryPlan(f,{taskKey:key,reason,expectedControl:target.controlTarget});
  const result=await drive(f,{operation:'abandon_effect'});recoveryPlan(f);return result;
}

// Rows 7/8: the driver and batch host are SIGKILLed while the live develop request is
// unanswered. Only an explicit v2 abandon_effect (status controlTarget as expectedControl)
// registers the interruption; the next advance sends a fresh request.
test('row 7: a killed pending session develop needs an explicit abandon_effect, then advance re-requests and completes',async t=>{
  const f=fixture(t);
  const killed=await drive(f,killOnRequest);
  assert.ok(killed.killed);
  assert.deepEqual(types(f),['init','effect-intent'],'the develop is left pending');
  resumePlan(f);
  const plain=await drive(f);
  settled(plain);
  assert.deepEqual([plain.result.state,plain.result.code,plain.result.pendingAction,plain.result.guidance.recoveryOperation],
    ['unknown','reconciliation_required','abandon_effect','abandon_effect'],summary(plain));
  assert.deepEqual(types(f),['init','effect-intent'],'advance without authorization records nothing');
  assert.deepEqual(attempts(f),[1],'and sends no new request');
  // v2 recovery: the v1 permission grant is refused by the driver, and so is a
  // recovery operation without the status controlTarget.
  const permissions=JSON.parse(fs.readFileSync(f.plan,'utf8')).permissions;
  recoveryPlan(f,{taskKey:key,reason:'Session host was killed',permissions:[...permissions,'--allow-abandon-effect',key]});
  const granted=await drive(f,{operation:'abandon_effect'});
  assert.equal(granted.code,2);assert.match(granted.stderr,/禁止 --allow-\*/);
  recoveryPlan(f,{taskKey:key,reason:'Session host was killed',permissions});
  const blind=await drive(f,{operation:'abandon_effect'});
  assert.equal(blind.code,2);assert.match(blind.stderr,/expectedControl/);
  assert.deepEqual(types(f),['init','effect-intent']);
  const target=await statusTarget(f);
  assert.deepEqual([target.controlTarget.taskKey,target.controlTarget.member.effectId],[key,'develop-1']);
  const registered=await abandon(f,target);
  settled(registered);
  assert.deepEqual([registered.result.outcome,registered.result.state,registered.result.code,registered.result.pendingAction],
    ['recorded','blocked','develop_interrupted','resume'],summary(registered));
  assert.deepEqual(types(f),['init','effect-intent','effect-interrupted']);
  const resumed=await drive(f);
  settled(resumed);
  assert.deepEqual([resumed.result.state,resumed.result.code],['fixture_completed','qa_triggered'],summary(resumed));
  assert.deepEqual(attempts(f),[1,1],'one fresh request after the registered interruption');
  assert.deepEqual(effectIds(f),['develop-1','develop-1-resume-1','review-1','complete-1']);
  assert.deepEqual(reviews(f),[1]);
  assert.equal(fs.readFileSync(f.target,'utf8'),PROPOSED);
  assertSessionOnly(f);
});

test('row 8: a code root changed since the round start refuses abandon_effect and stays blocked',async t=>{
  const f=fixture(t),partial='export const value = 4;\n';
  await drive(f,killOnRequest);
  fs.writeFileSync(f.target,partial);
  resumePlan(f);
  const target=await statusTarget(f);
  const refused=await abandon(f,target);
  settled(refused);
  assert.deepEqual([refused.result.outcome,refused.result.code],['rejected','effect_interrupt_root_changed'],summary(refused));
  assert.match(refused.result.reason,/target\.mjs/);
  assert.deepEqual(types(f),['init','effect-intent'],'the refusal records nothing');
  const again=await drive(f);
  settled(again);
  assert.deepEqual([again.result.state,again.result.code,again.result.pendingAction],['unknown','reconciliation_required','abandon_effect'],summary(again));
  assert.deepEqual(attempts(f),[1],'no new request');
  assert.deepEqual(reviews(f),[]);
  assert.equal(fs.readFileSync(f.target,'utf8'),partial,'the partial bytes are kept for a person to inspect');
  assertSessionOnly(f);
});

// Three killed requests with two registered interruptions in between.
async function reachInterruptLimit(f){
  await drive(f,killOnRequest);resumePlan(f);
  for(let round=1;round<=2;round++){
    const registered=await abandon(f,await statusTarget(f));
    assert.equal(registered.result?.code,'develop_interrupted',summary(registered));
    await drive(f,killOnRequest);
  }
  return statusTarget(f);
}
test('rows 7/8: the develop interruption budget is two in-run recoveries; the third only voids the run',async t=>{
  const f=fixture(t);
  const limited=await reachInterruptLimit(f);
  assert.deepEqual(effectIds(f),['develop-1','develop-1-resume-1','develop-1-resume-2']);
  assert.equal(types(f).filter(type=>type==='effect-interrupted').length,2);
  assert.deepEqual([limited.state,limited.code,limited.pendingAction],['unknown','effect_interrupt_limit','abandon_effect'],JSON.stringify(limited));
  const voided=await abandon(f,limited);
  assert.deepEqual([voided.result.outcome,voided.result.state,voided.result.code],['abandoned','cancelled','effect_abandoned'],summary(voided));
  assert.equal(types(f).at(-1),'effect-abandoned');
  const after=await drive(f);
  assert.deepEqual([after.result.outcome,after.result.state,after.result.code],['reported','cancelled','effect_abandoned'],summary(after));
  assert.deepEqual(attempts(f),[1,1,1],'no fourth request');
  assert.deepEqual(reviews(f),[]);
  assert.equal(fs.readFileSync(f.target,'utf8'),ORIGINAL);
  assertSessionOnly(f);
});

// Found by this suite (design 3.4 row 8: a batch member has no single-task supersede
// exit). At effect_interrupt_limit the batch guidance still says abandon_effect and
// then advance continues the batch, and the reason names --supersede-reviewed-evidence;
// in fact abandon_effect voids the member run (cancelled/effect_abandoned) and the
// batch cannot continue it. Left as todo: the guidance text is not changed here.
test('rows 7/8 guidance: at effect_interrupt_limit the batch guidance does not promise advance or a supersede exit',{todo:'guidance defect reported to the main session'},async t=>{
  const f=fixture(t);
  const limited=await reachInterruptLimit(f);
  assert.equal(limited.code,'effect_interrupt_limit');
  assert.doesNotMatch(limited.guidance.nextStep,/之后 advance 继续本批次/);
  assert.doesNotMatch(limited.reason,/--supersede-reviewed-evidence/);
});
