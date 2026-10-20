// Commander phase 1: the read-only ledger. Pure rules use synthetic inputs with
// a fixed clock; one integration test drives a real run and replays it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {composeLedger,readLogEvents,buildLedger,readRuns,rawHints,checkedSupersession,originBound,IDLE_MINUTES} from '../runtime/js/commander/ledger.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {main,renderLedger} from './cm-commander.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolated,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
test.after(()=>fs.rmSync(isolated,{recursive:true,force:true}));

const NOW='2026-10-20T10:00:00.000Z';
const minutesAgo=n=>new Date(Date.parse(NOW)-n*60000).toISOString();
// The real admission result shape: state plus reason (not code).
const ready={state:'ready',reason:'task_selected',nextTask:{feature:'1.work',id:'T-002'}};
const features=[{name:'1.work',tasks:[
  {id:'T-001',completed:true,dropped:false,dependsOn:[]},
  {id:'T-002',completed:false,dropped:false,dependsOn:[]},
  {id:'T-003',completed:false,dropped:false,dependsOn:['T-002']}]}];
const run=(runId,taskId,extra={})=>({runId,kind:'cm-ai',verified:true,feature:'1.work',taskId,state:'awaiting_review',
  code:null,attempt:1,pending:null,committed:false,trustedPrevious:[],claimedPrevious:[],records:4,...extra});
const unverified=(runId,taskId,extra={})=>run(runId,taskId,{verified:false,chainVerified:true,state:null,attempt:null,...extra});
const log=(entries={})=>({present:true,invalid:0,runs:new Map(Object.entries(entries).map(([id,ago])=>[id,{at:minutesAgo(ago),event:'progress',detail:'x',runDone:false}]))});
const compose=(runs,logs,admission=ready,runsError=null)=>composeLedger({specsDir:'/s',admission,features,runs,runsError,log:logs,now:NOW});

test('with no run in flight the next step is admission’s task; its reason is carried through',()=>{
  const l=compose([],log());
  assert.equal(l.next.kind,'start_task');assert.equal(l.next.task,'T-002');
  assert.deepEqual(l.features[0].tasks.map(t=>t.status),['done','todo','todo']);
  assert.equal(compose([],log(),{state:'complete',reason:'all_tasks_terminal'}).next.kind,'finish');
  const blocked=compose([],log(),{state:'blocked',reason:'spec_drift',detail:{feature:'1.work'},warnings:['w']});
  assert.equal(blocked.next.kind,'admission_blocked');assert.equal(blocked.next.reason,'spec_drift');
  assert.match(blocked.next.why,/blocked\/spec_drift/);assert.deepEqual(blocked.admission.detail,{feature:'1.work'});
  assert.deepEqual(blocked.admission.warnings,['w']);
});

test('single-flight on an unchecked task: an active run is waited on; idle, silent or stopped runs come first',()=>{
  const active=compose([run('r-active','T-002')],log({'r-active':5}));
  assert.equal(active.next.kind,'wait_run','no new task while a run is active');
  assert.equal(active.features[0].tasks[1].status,'in_run');
  const idle=compose([run('r-idle','T-002')],log({'r-idle':IDLE_MINUTES}));
  assert.equal(idle.next.kind,'attend_run');assert.match(idle.next.why,/45 分钟没有新日志/);
  const silent=compose([run('r-silent','T-002')],log());
  assert.equal(silent.next.kind,'attend_run');assert.match(silent.next.why,/没有日志活动/);
  const both=compose([run('r-idle','T-002'),run('r-stop','T-003',{state:'blocked',code:'review_blocked'})],log({'r-idle':300,'r-stop':1}));
  assert.equal(both.next.runId,'r-stop','a stopped run outranks a merely idle one');
  assert.deepEqual(both.queue.map(a=>a.runId),['r-idle']);
});

test('a journaled but unfinished effect is executing, not stopped',()=>{
  const busy=compose([run('r','T-002',{state:'unknown',code:'reconciliation_required',pending:'develop'})],log({r:0}));
  assert.equal(busy.features[0].tasks[1].status,'in_run');assert.equal(busy.next.kind,'wait_run');
  assert.match(busy.next.why,/正在执行 develop/);
  const quiet=compose([run('r','T-002',{state:'unknown',code:'reconciliation_required',pending:'review'})],log({r:120}));
  assert.equal(quiet.next.kind,'attend_run');assert.match(quiet.next.why,/未结的 review/);
});

test('two open runs of one task both stay in the queue; recent activity does not retire the other',()=>{
  const l=compose([run('old','T-002',{state:'blocked',code:'review_blocked'}),run('new','T-002')],log({old:600,new:1}));
  assert.equal(l.next.runId,'old','the stopped run is handled before waiting on the active one');
  assert.deepEqual(l.features[0].tasks[1].runIds.sort(),['new','old']);
  assert.ok(l.inconsistencies.some(i=>i.kind==='multiple_open_runs'));
});

test('a replayed supersession retires its predecessor; a claimed one does not, and asks for a check',()=>{
  const trusted=compose([run('old','T-002',{state:'blocked',code:'review_blocked'}),run('new','T-002',{trustedPrevious:['old']})],log({old:600,new:3}));
  assert.equal(trusted.next.kind,'wait_run');assert.equal(trusted.next.runId,'new');
  assert.equal(trusted.runs.find(r=>r.runId==='old').supersededBy,'new');assert.deepEqual(trusted.inconsistencies,[]);
  const claimed=compose([run('old','T-002',{state:'blocked',code:'review_blocked'}),unverified('new','T-002',{claimedPrevious:['old']})],log({old:600,new:3}));
  assert.equal(claimed.runs.find(r=>r.runId==='old').supersededBy,null,'an unchecked claim never retires a run');
  assert.equal(claimed.next.runId,'old');assert.ok(claimed.queue.some(q=>q.kind==='check_records'&&q.runId==='new'));
  const crossTask=compose([run('old','T-002',{state:'blocked',code:'review_blocked'}),run('new','T-003',{trustedPrevious:['old']})],log({old:600,new:3}));
  assert.equal(crossTask.runs.find(r=>r.runId==='old').supersededBy,null,'a supersession across tasks is refused');
  assert.ok(crossTask.inconsistencies.some(i=>i.kind==='supersession_task_mismatch'));
});

test('an unverified run is never stopped, and its commit claim is not a commit',()=>{
  const recent=compose([unverified('u','T-002',{state:'blocked'})],log({u:2}));
  assert.equal(recent.features[0].tasks[1].status,'in_run');assert.equal(recent.next.kind,'wait_run');
  assert.match(recent.next.why,/未校验/);
  const quiet=compose([unverified('u','T-002')],log({u:90}));
  assert.equal(quiet.next.kind,'attend_run');assert.match(quiet.next.why,/未校验/);
  const claim=compose([unverified('u','T-002',{committedClaim:true})],log({u:90}));
  assert.equal(claim.next.kind,'attend_run','a commit claim does not end the run');
  assert.ok(!claim.inconsistencies.some(i=>i.kind==='commit_without_check'));
});

test('unreadable runs or an unreadable run directory never become “nothing in flight”',()=>{
  const bad=compose([{runId:'x',kind:'unreadable',code:'store_corrupt'}],log());
  assert.equal(bad.next.kind,'check_records');assert.match(bad.next.why,/store_corrupt/);
  const dir=compose([],log(),ready,'EACCES');
  assert.equal(dir.next.kind,'check_records');assert.match(dir.next.why,/EACCES/);
  const fix=compose([{runId:'f',kind:'cm-fix',records:3},{runId:'e',kind:'empty'}],log());
  assert.equal(fix.next.kind,'start_task','identified cm-fix history and empty residue directories do not block');
});

test('a checked task: a run is history only on evidence, never on the checkmark or log age alone',()=>{
  const live=compose([run('d','T-001',{state:'developing'})],log({d:3}));
  assert.equal(live.next.kind,'attend_run');assert.equal(live.next.runId,'d');assert.match(live.next.why,/任务已勾选/);
  const old=compose([run('d','T-001',{state:'blocked',code:'failed'})],log({d:9000}));
  assert.equal(old.next.kind,'start_task','a verified terminal attempt with nothing in flight is history');
  assert.ok(old.inconsistencies.some(i=>i.kind==='checked_with_open_run'));
  for(const logs of [log({p:60}),log()]){
    const pending=compose([run('p','T-001',{state:'unknown',code:'reconciliation_required',pending:'develop'})],logs);
    assert.equal(pending.next.kind,'attend_run','an unfinished effect is never history');assert.match(pending.next.why,/未结的 develop/);
  }
  const committed=compose([unverified('u','T-001',{committedClaim:true}),unverified('v','T-001',{committedClaim:true})],log({u:9000,v:9000}));
  assert.equal(committed.next.kind,'start_task','an intact chain that journaled the commit is history');
  assert.deepEqual(committed.inconsistencies,[]);
  const unproven=compose([unverified('u','T-001')],log({u:9000}));
  assert.equal(unproven.next.kind,'attend_run','an unverified run without a commit record is not proven over');
  assert.match(unproven.next.why,/没有可核验的结束记录/);
  const recent=compose([unverified('u','T-001',{committedClaim:true})],log({u:1}));
  assert.equal(recent.next.kind,'attend_run','recent activity on a checked task is never history');
  const brokenChain=compose([unverified('u','T-001',{committedClaim:true,chainVerified:false})],log({u:9000}));
  assert.equal(brokenChain.next.kind,'attend_run','a commit claim in a broken chain proves nothing');
  const commitNoCheck=compose([run('c','T-003',{committed:true})],log({c:3}));
  assert.ok(commitNoCheck.inconsistencies.some(i=>i.kind==='commit_without_check'&&i.task==='T-003'));
  assert.throws(()=>composeLedger({specsDir:'/s',admission:ready,features,runs:[],log:log(),now:'yesterday'}),{code:'invalid_now'});
});

test('the log reader keeps the latest event per run, sticky run_done, and counts bad lines',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-log-'));test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const row=(run_id,at,event='progress')=>JSON.stringify({run_id,at,event,detail:event});
  fs.writeFileSync(path.join(dir,'运行日志.jsonl'),[row('a',minutesAgo(10),'run_done'),row('a',minutesAgo(5)),row('a',minutesAgo(20)),
    'not json',JSON.stringify({run_id:'b',at:'bad'}),row('b',minutesAgo(1))].join('\n')+'\n');
  const read=readLogEvents(dir);
  assert.equal(read.invalid,2);assert.equal(read.runs.get('a').at,minutesAgo(5));assert.equal(read.runs.get('a').runDone,true);
  assert.equal(readLogEvents(path.join(dir,'missing')).present,false);
});

// Integration: a real driven run in awaiting_review, then the same journal made
// unreplayable by a foreign record type, still mapped to its task.
const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const REVIEW=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
function project(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),bin=path.join(root,'bin'),answers=path.join(root,'answers');
  for(const dir of [path.join(specsDir,'1.work'),codeProject,bin,answers])fs.mkdirSync(dir,{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: fixture\n- [ ] T-002: next\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const identity={repositoryId:'commander',runId:'commander-run',taskId:'T-001',attempt:1};
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({version:1,specsDir,codeProject,feature:'1.work',identity,scope:['target.mjs'],requirements:['requirements.md']}));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(bin,'codex'),fs.readFileSync(REVIEW,'utf8'),{mode:0o700});
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:{outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt'}}));
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value = 42;\n');
  const plan=path.join(root,'plan.json');
  fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'create',hostContext:'commander-host',controlConfig:'control.json',
    permissions:['--review-config','review.json'],answers:'answers',checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const started=spawnSync(process.execPath,[DRIVER,'--plan',plan,'start'],{encoding:'utf8',timeout:60000,env});
  assert.equal(started.status,0,started.stderr);assert.equal(JSON.parse(started.stdout).result.state,'awaiting_review',started.stdout);
  return {specsDir,codeProject,store:path.join(specsDir,'.reviews/.execution/commander-run/state.json')};
}

test('a real run replays into the ledger read-only, and an unreplayable copy keeps its task mapping',t=>{
  const p=project(t),before=fs.readFileSync(p.store);
  // Every file and directory under specs, with size and mtime, before and after.
  const listing=dir=>fs.readdirSync(dir,{recursive:true}).sort().map(name=>{const s=fs.lstatSync(path.join(dir,name));
    return `${name}|${s.isDirectory()?'d':s.size}|${s.mtimeMs}`;});
  const tree=listing(p.specsDir);
  const live=buildLedger({specsDir:p.specsDir,codeProject:p.codeProject});
  const task=live.features[0].tasks[0];
  assert.equal(task.status,'in_run');assert.equal(task.verified,true);assert.equal(task.runState,'awaiting_review');
  assert.equal(live.next.kind,'wait_run','the run was just active');assert.equal(live.next.runId,'commander-run');
  const later=buildLedger({specsDir:p.specsDir,codeProject:p.codeProject,now:new Date(Date.now()+2*3600000).toISOString()});
  assert.equal(later.next.kind,'attend_run');assert.match(later.next.how,/cm-ai-drive\.mjs status/);
  assert.deepEqual(listing(p.specsDir),tree,'reading the ledger adds, removes or modifies nothing under specs');
  const text=main(['ledger','--specs',p.specsDir,'--code-project',p.codeProject]);
  assert.equal(text.code,0);assert.match(text.text,/下一步：等 1\.work T-001/);
  assert.equal(main(['ledger','--specs',p.specsDir]).code,2,'missing code project is a usage error');
  // Append a record type this runtime does not know, keeping the hash chain valid.
  const state=JSON.parse(before),last=state.records.at(-1);
  const body={version:1,seq:last.seq+1,id:`runner.${String(last.seq+1).padStart(6,'0')}`,kind:'result',
    payload:{version:3,protocol:'cm-task-runner',type:'foreign-branch-record'},previousDigest:last.digest};
  state.records.push({...body,digest:digest(body)});const {revision,...rest}=state;
  fs.writeFileSync(p.store,JSON.stringify({...rest,revision:digest(rest)})+'\n');
  const foreign=buildLedger({specsDir:p.specsDir,codeProject:p.codeProject}).features[0].tasks[0];
  assert.equal(foreign.status,'in_run');assert.equal(foreign.verified,false);assert.equal(foreign.runId,'commander-run');
  assert.match(renderLedger(buildLedger({specsDir:p.specsDir,codeProject:p.codeProject})),/回放不了记录的运行 1 个/);
});

test('raw hints map an unreplayable run to its task, predecessors and commit record',()=>{
  const records=[{payload:{protocol:'cm-task-runner',type:'init',config:{identity:{taskId:'T-007'},
      completion:{owner:{tasksPath:'/s/7.skins/tasks.md'}}}}},
    {payload:{type:'evidence-superseded',record:{previousRunIds:['old-1','old-2',3]}}},
    {payload:{type:'task-commit-result'}}];
  assert.deepEqual(rawHints(records),{feature:'7.skins',taskId:'T-007',previousRunIds:['old-1','old-2'],committed:true});
  assert.deepEqual(rawHints([{payload:{config:{identity:{taskId:'T-1'},taskLearning:{feature:'1.a'}}}}]),
    {feature:'1.a',taskId:'T-1',previousRunIds:[],committed:false});
});

test('a structural supersession check needs the record in place, valid, and naming this run and task',()=>{
  const record={version:1,feature:'7.skins',taskId:'T-007',newRunId:'new',previousRunIds:['old'],reason:'r',files:[],
    authorizedAt:'2026-10-20T09:00:00.000Z'};
  const records=at=>[{kind:'result',payload:{type:'init'}},...(at===1?[]:[{kind:'result',payload:{type:'x'}}]),
    {kind:'result',payload:{type:'evidence-superseded',record}}];
  const hints={feature:'7.skins',taskId:'T-007'};
  assert.deepEqual(checkedSupersession(records(1),'new',hints),['old']);
  assert.deepEqual(checkedSupersession(records(2),'new',hints),[],'only the second record counts, as in replay');
  assert.deepEqual(checkedSupersession(records(1),'other',hints),[],'it must name this run');
  assert.deepEqual(checkedSupersession(records(1),'new',{...hints,taskId:'T-008'}),[],'and this task');
  const forged=[records(1)[0],{kind:'result',payload:{type:'evidence-superseded',record:{...record,files:'x'}}}];
  assert.deepEqual(checkedSupersession(forged,'new',hints),[],'and pass the shared record validator');
});

test('a supersession is believed only when the run’s start binds snapshot, init and feature together',()=>{
  const init=(over={})=>({kind:'result',payload:{version:3,type:'init',protocol:'cm-task-runner',config:{
    identity:{repositoryId:'repo',runId:'new',taskId:'T-007',...over.identity},
    completion:{owner:{tasksPath:'/s/7.skins/tasks.md'}},taskLearning:{feature:over.feature??'7.skins'}}}});
  const snapshot={identity:{repositoryId:'repo',runId:'new'}};
  assert.equal(originBound([init()],snapshot,'new'),true);
  assert.equal(originBound([init({identity:{runId:'different-run'}})],snapshot,'new'),false,'init must name this run');
  assert.equal(originBound([init({feature:'8.other'})],snapshot,'new'),false,'task path and learning feature must agree');
  assert.equal(originBound([init({identity:{repositoryId:'elsewhere'}})],snapshot,'new'),false,'and the snapshot repository');
  assert.equal(originBound([init()],null,'new'),false,'without a validated snapshot nothing binds');
});

test('a state file that exists but cannot be read is unreadable, not an empty residue',t=>{
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-eacces-')));
  const runDir=path.join(specs,'.reviews','.execution','locked');fs.mkdirSync(runDir,{recursive:true});
  fs.writeFileSync(path.join(runDir,'state.json'),'{}');fs.mkdirSync(path.join(specs,'.reviews','.execution','residue'));
  fs.chmodSync(runDir,0o000);
  t.after(()=>{fs.chmodSync(runDir,0o700);fs.rmSync(specs,{recursive:true,force:true});});
  const {runs,error}=readRuns(specs);
  assert.equal(error,null);
  assert.deepEqual(runs.map(r=>[r.runId,r.kind,r.code??null]),[['locked','unreadable','EACCES'],['residue','empty',null]]);
});

test('reading a chain-valid journal whose init names another run trusts none of its supersession',t=>{
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-forged-')));t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const runDir=path.join(specs,'.reviews','.execution','new');fs.mkdirSync(runDir,{recursive:true,mode:0o700});
  fs.chmodSync(path.join(specs,'.reviews','.execution'),0o700);fs.chmodSync(runDir,0o700);
  const config={identity:{repositoryId:'repo',runId:'different-run',taskId:'T-007'},
    completion:{owner:{tasksPath:path.join(specs,'7.skins','tasks.md')}},taskLearning:{feature:'7.skins'}};
  const record={version:1,feature:'7.skins',taskId:'T-007',newRunId:'new',previousRunIds:['old'],reason:'r',files:[],
    authorizedAt:'2026-10-20T09:00:00.000Z'};
  const payloads=[{config,version:3,protocol:'cm-task-runner',type:'init'},{record,version:3,protocol:'cm-task-runner',type:'evidence-superseded'}];
  let previous=null;const records=payloads.map((payload,i)=>{const body={version:1,seq:i+1,id:`runner.${String(i+1).padStart(6,'0')}`,
    kind:'result',payload,previousDigest:previous};previous=digest(body);return {...body,digest:previous};});
  const body={version:1,identity:{repositoryId:'repo',runId:'new'},fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)},records};
  fs.writeFileSync(path.join(runDir,'state.json'),JSON.stringify({...body,revision:digest(body)})+'\n',{mode:0o600});
  const [run]=readRuns(specs).runs;
  assert.equal(run.kind,'cm-ai');assert.equal(run.verified,false);assert.equal(run.chainVerified,true,'the chain itself is intact');
  assert.deepEqual(run.claimedPrevious,['old']);assert.deepEqual(run.trustedPrevious,[],'an unbound start proves no supersession');
});
