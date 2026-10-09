import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {notify,readNotifyConfig,buildNotifyMessage,driveNotice,NOTIFY_LIMITS,NOTIFY_WORKFLOWS} from '../runtime/js/notify.mjs';

const NOW=Date.parse('2026-10-08T08:00:00.000Z');
const DRIVE_CORE=new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
const BRIDGE=new URL('../runtime/js/cm-ai/host-tool-bridge.mjs',import.meta.url).href;
const HOST_SESSION=new URL('../runtime/js/cm-ai/host-session.mjs',import.meta.url).href;

// A temp CM_WORKFLOW_HOME with notify.json pointing at a fake command that
// appends its environment message and stdin payload to sent.jsonl.
function home(t,{exit=0,sleepMs=0,config={}}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=path.join(dir,'sent.jsonl'),script=path.join(dir,'fake-notify.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{setTimeout(()=>{fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify({title:process.env.CM_NOTIFY_TITLE,
body:process.env.CM_NOTIFY_BODY,stdin:JSON.parse(input),at:Date.now()})+'\\n');process.exit(${exit});},${sleepMs});});`);
  fs.writeFileSync(path.join(dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script],...config}));
  const env={...process.env,CM_WORKFLOW_HOME:dir};
  const rows=()=>fs.existsSync(sent)?fs.readFileSync(sent,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  const log=()=>fs.existsSync(path.join(dir,'notify.log'))?fs.readFileSync(path.join(dir,'notify.log'),'utf8'):'';
  const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));return check();};
  return {dir,env,rows,log,until};
}
const fields=(key,over={})=>({key,event:'stuck',project:'/srv/work/demo-app',workflow:'cm-fix',runId:'run-1',
  task:'T-001',stage:'blocked',code:'checks_not_passed',nextAction:'核对 reason 后恢复原运行',...over});

test('off without notify.json, and off under node --test unless CM_WORKFLOW_HOME is explicit',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(readNotifyConfig({CM_WORKFLOW_HOME:dir}),null);
  assert.deepEqual(notify(fields('a'),{env:{CM_WORKFLOW_HOME:dir},now:NOW}),{sent:false,reason:'off'});
  assert.deepEqual(fs.readdirSync(dir),[]);
  assert.equal(readNotifyConfig({NODE_TEST_CONTEXT:'child-v8'}),null);
});

test('invalid config turns the feature off: relative command, bad version, bad waitMinutes',t=>{
  const h=home(t);const file=path.join(h.dir,'notify.json');
  for(const value of [{version:1,command:['notify.sh']},{version:2,command:['/bin/true']},{version:1,command:[]},
    {version:1,command:['/bin/true'],waitMinutes:0},'not json']){
    fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));
    assert.equal(readNotifyConfig(h.env),null,JSON.stringify(value));
  }
  assert.match(h.log(),/config - key=- off invalid_config command_not_absolute/);
  fs.writeFileSync(file,JSON.stringify({version:1,command:['/bin/true'],waitMinutes:0.5}));
  assert.deepEqual(readNotifyConfig(h.env),{command:['/bin/true'],waitMs:30000,checkWaitMs:2700000,idleMs:2700000});
});

test('message is bounded and built only from the structured fields',()=>{
  const long='x'.repeat(2000);
  const message=buildNotifyMessage({...fields('k'),workflow:long,project:'/very/secret/path/'+long,runId:long,task:long,
    stage:long,code:long,nextAction:`读 /srv/private/push.env 和 ~/secret/file 后\n${long}`,
    diff:'DIFF-CONTENT',log:'LOG-CONTENT',env:{TOKEN:'SECRET'}},{now:NOW});
  assert(Array.from(message.title).length<=NOTIFY_LIMITS.titleChars);
  assert(Array.from(message.body).length<=NOTIFY_LIMITS.bodyChars);
  for(const forbidden of ['DIFF-CONTENT','LOG-CONTENT','SECRET','push.env','/srv/','/very/secret','~/secret','\0'])
    assert(!message.body.includes(forbidden)&&!message.title.includes(forbidden),forbidden);
  assert.match(message.body,/<路径>/);
  const short=buildNotifyMessage(fields('k'),{now:NOW});
  assert.equal(short.title,'CM cm-fix 需要人处理 · demo-app');
  assert.match(short.body,/^项目：demo-app\n流程：cm-fix\n运行：run-1\n任务：T-001\n阶段：blocked\n原因：checks_not_passed\n下一步：/);
  assert.match(short.body,/CM 不会自动继续/);
});

test('sends through env and stdin once per key; the same key within 6 hours is skipped',async t=>{
  const h=home(t);
  assert.deepEqual(notify(fields('same'),{env:h.env,now:NOW}),{sent:true,reason:'launched'});
  assert.deepEqual(notify(fields('same'),{env:h.env,now:NOW+5*3600*1000}),{sent:false,reason:'duplicate'});
  assert(await h.until(()=>h.rows().length===1));
  const [row]=h.rows();
  assert.equal(row.title,'CM cm-fix 需要人处理 · demo-app');assert.equal(row.stdin.title,row.title);assert.equal(row.stdin.body,row.body);
  assert.equal(row.stdin.project,'demo-app');assert.equal(row.stdin.code,'checks_not_passed');assert.equal(row.stdin.key,undefined);
  assert.equal(notify(fields('same'),{env:h.env,now:NOW+6*3600*1000+1}).sent,true);
  assert(await h.until(()=>h.rows().length===2));
  assert.equal(h.rows()[0].stdin.CM_NOTIFY_PAYLOAD,undefined);
  const state=JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8'));
  assert.equal(JSON.stringify(state).includes('same'),false);
  assert(!fs.existsSync(path.join(h.dir,'notify-state.lock')));
});

test('at most 4 per rolling minute and 150 per day across keys',async t=>{
  const h=home(t);
  for(let i=0;i<4;i++)assert.equal(notify(fields(`m${i}`),{env:h.env,now:NOW+i}).sent,true);
  assert.deepEqual(notify(fields('m4'),{env:h.env,now:NOW+10}),{sent:false,reason:'rate_minute'});
  assert.equal(notify(fields('m4'),{env:h.env,now:NOW+60010}).sent,true);
  assert.match(h.log(),/skipped rate_minute/);
  const sends=Array.from({length:150},(_,i)=>NOW+120000+i*60000);
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify({version:1,keys:{},sends}));
  assert.deepEqual(notify(fields('day'),{env:h.env,now:NOW+200*60000}),{sent:false,reason:'rate_day'});
  assert.equal(notify(fields('day'),{env:h.env,now:NOW+120000+24*3600*1000}).sent,true);
  assert(await h.until(()=>h.rows().length===6));
});

test('command failure, timeout and broken state never throw; they log one line without content',async t=>{
  const failing=home(t,{exit:3});
  assert.deepEqual(notify(fields('f'),{env:failing.env,now:NOW}),{sent:true,reason:'launched'});
  assert(await failing.until(()=>failing.log()!==''));
  assert.match(failing.log(),/^\S+ stuck cm-fix key=[0-9a-f]{16} failed exit_3\n$/);
  const slow=home(t,{sleepMs:5000});
  assert.equal(notify(fields('s'),{env:slow.env,now:NOW,timeoutMs:200}).sent,true);
  assert(await slow.until(()=>/failed timeout/.test(slow.log())));
  const missing=home(t);fs.writeFileSync(path.join(missing.dir,'notify.json'),JSON.stringify({version:1,command:['/nonexistent/notify-cmd']}));
  assert.equal(notify(fields('n'),{env:missing.env,now:NOW}).sent,true);assert(await missing.until(()=>/failed spawn_enoent/.test(missing.log())));
  const broken=home(t);fs.writeFileSync(path.join(broken.dir,'notify-state.json'),'{');
  assert.deepEqual(notify(fields('b'),{env:broken.env,now:NOW}),{sent:false,reason:'state_invalid'});
  await new Promise(r=>setTimeout(r,300));
  for(const h of [slow,missing,broken])assert.equal(h.rows().length,0);
  for(const h of [failing,slow,missing,broken])assert(!/demo-app|T-001|核对|run-1/.test(h.log()));
});

// Lock contention never waits; only a provably stale lock is reclaimed, and
// a live lock is never removed.
test('lock: a live lock skips at once and is kept; a stale lock is reclaimed safely',async t=>{
  const live=home(t),lockFile=path.join(live.dir,'notify-state.lock');
  const liveBody=JSON.stringify({pid:process.pid,at:Date.now(),token:'other'});fs.writeFileSync(lockFile,liveBody);
  const started=performance.now();
  assert.deepEqual(notify(fields('l'),{env:live.env,now:NOW}),{sent:false,reason:'state_busy'});
  assert(performance.now()-started<50,'no synchronous waiting on contention');
  assert.equal(fs.readFileSync(lockFile,'utf8'),liveBody);assert.match(live.log(),/skipped state_busy/);
  const partial=home(t);fs.writeFileSync(path.join(partial.dir,'notify-state.lock'),'');
  assert.equal(notify(fields('p'),{env:partial.env,now:NOW}).reason,'state_busy');
  const dead=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim();
  for(const body of [{pid:Number(dead),at:Date.now(),token:'gone'},{pid:process.pid,at:Date.now()-60000,token:'old'}]){
    const old=home(t),file=path.join(old.dir,'notify-state.lock');fs.writeFileSync(file,JSON.stringify(body));
    assert.equal(notify(fields('o'),{env:old.env,now:NOW}).sent,true,JSON.stringify(body));
    assert(!fs.existsSync(file));assert.deepEqual(fs.readdirSync(old.dir).filter(name=>name.includes('.lock.')),[]);
    assert(await old.until(()=>old.rows().length===1));
  }
});

test('respects CM_WORKFLOW_HOME: config, state and log stay in that directory',async t=>{
  const a=home(t),b=home(t);fs.rmSync(path.join(b.dir,'notify.json'));
  assert.equal(notify(fields('h'),{env:b.env,now:NOW}).reason,'off');
  assert.equal(notify(fields('h'),{env:a.env,now:NOW}).sent,true);
  assert(await a.until(()=>a.rows().length===1));
  assert(fs.existsSync(path.join(a.dir,'notify-state.json')));assert(!fs.existsSync(path.join(b.dir,'notify-state.json')));
});

// Table-driven: each workflow's real result contract (host named per row)
// maps to stuck (a person must act), done (run ended) or null (progress).
const id={runId:'run-1',taskId:'T-001',attempt:1};
const ai=(over)=>({version:1,workflow:'cm-ai',operation:'advance',identity:id,packageDigest:'d',...over});
const CASES=[
  // cm-ai: cm-ai-conversation-entry.mjs / operator-guidance.mjs / task-runner.mjs / host-qa-fix-owner.mjs
  ['cm-ai','advance',ai({outcome:'finalized',state:'run_done',code:'run_done',pendingAction:'none'}),'done'],
  ['cm-ai','advance',ai({outcome:'finalized',state:'run_done',code:'run_done_degraded',pendingAction:'none'}),'done'],
  ['cm-ai','advance',ai({outcome:'refreshed',state:'fixture_completed',code:'context_refreshed',pendingAction:'start_next_task'}),null],
  ['cm-ai','start',ai({outcome:'advanced',state:'awaiting_review',code:null,pendingAction:'decision'}),null],
  ['cm-ai','advance',ai({outcome:'advanced',state:'changes_requested',code:null,pendingAction:'resume'}),null],
  ['cm-ai','complete',ai({outcome:'advanced',state:'fixture_completed',code:null,pendingAction:'qa'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'fixture_completed',code:'documentation_sync_required',pendingAction:'documentation_sync'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'changes_requested',code:'revision_answer_required',pendingAction:'resume'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'awaiting_review',code:'decision_required',pendingAction:'decision'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'fixture_completed',code:'qa_decision_required',pendingAction:'qa'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'awaiting_spec_approval',code:'specs_not_approved',pendingAction:'none'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'recorded',state:'fixture_completed',code:'qa_triggered',pendingAction:'qa_execution'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'verified',state:'fixture_completed',code:'qa_failed',pendingAction:'fix_authorization'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'blocked',code:'review_limit',pendingAction:'none'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'pending_review',code:'review_transport_timeout',pendingAction:'resume'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'unknown',code:'execution_error',pendingAction:'reconcile'}),'stuck'],
  ['cm-ai','decision',ai({outcome:'rejected',state:null,code:'stale_decision',pendingAction:'none'}),'stuck'],
  ['cm-ai','fix_advance',{outcome:'blocked',code:'qa_fix_incomplete',fixStage:'cause_review_required'},null],
  ['cm-ai','fix_advance',{outcome:'blocked',code:'qa_fix_incomplete',fixStage:'repair_blocked'},'stuck'],
  ['cm-ai','fix_run',{outcome:'verified',code:'qa_fix_completed'},null],
  ['cm-ai','status',ai({outcome:'reported',state:'blocked',code:'review_limit',pendingAction:'none'}),null],
  // cm-ai-batch: cm-ai-batch-run.mjs
  ['cm-ai-batch','advance',{...ai({outcome:'finalized',state:'run_done',code:'run_done',pendingAction:'none'}),batchId:'b1',task_commit:'abc'},'done'],
  ['cm-ai-batch','advance',{outcome:'blocked',code:'merge_conflict',batchId:'b1',files:['a.js']},'stuck'],
  ['cm-ai-batch','advance',{outcome:'blocked',code:'batch_task_scope_required'},'stuck'],
  ['cm-ai-batch','advance',{outcome:'cancelled',code:'cancelled',batchId:'b1'},'stuck'],
  ['cm-ai-batch','advance',{...ai({outcome:'advanced',state:'awaiting_review',code:null,pendingAction:'decision'}),batchId:'b1'},null],
  // cm-fix: execution.mjs / progress.mjs
  ['cm-fix','finish',{identity:id,stage:'completed',completionEligible:true},'done'],
  ['cm-fix','advance',{identity:id,stage:'cause_review_required'},null],
  ['cm-fix','cause_review',{identity:id,stage:'cause_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','final_review',{identity:id,stage:'final_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','final_review',{identity:id,stage:'revision_final_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','repair',{identity:id,stage:'revision_regression_required'},null],
  ['cm-fix','repair',{identity:id,stage:'unknown',pending:'repair'},'stuck'],
  ['cm-fix','cause_review',{identity:id,stage:'rediagnosis_review_limit_reached'},'stuck'],
  ['cm-fix','regression',{identity:id,stage:'regression_blocked'},'stuck'],
  ['cm-fix','finish',{identity:id,stage:'escalated',escalationRunEnded:true},'stuck'],
  ['cm-fix','completion_evidence',{identity:id,stage:'unknown'},null],
  // cm-prd: analysis.mjs / change.mjs / summary.mjs / draft-save.mjs / review-*.mjs
  ['cm-prd','start',{stage:'awaiting_user',result:{status:'question',question:'q'},runId:'prd-1'},'stuck'],
  ['cm-prd','advance',{stage:'analysis_ready',runId:'prd-1'},null],
  ['cm-prd','plan',{stage:'self_check_needs_human',runId:'prd-1'},'stuck'],
  ['cm-prd','plan',{stage:'draft_self_check_failed',runId:'prd-1'},null],
  ['cm-prd','advance',{mode:'change',stage:'change_design',question:'which?',round:1},'stuck'],
  ['cm-prd','advance',{mode:'change',stage:'change_check_failed',round:1},null],
  ['cm-prd','advance',{mode:'change',stage:'change_check_failed',round:2},'stuck'],
  ['cm-prd','advance',{mode:'change',stage:'change_confirmation'},'stuck'],
  ['cm-prd','save_draft',{status:'draft_save_unknown'},'stuck'],
  ['cm-prd','prepare_summary',{status:'human_summary_prepared',readyForAwaitingReview:false},'stuck'],
  ['cm-prd','final_review',{stage:'draft_ready',reviewState:{status:'review_recorded',verdict:'blocked'}},'stuck'],
  ['cm-prd','final_review',{stage:'draft_ready',reviewState:{status:'review_recorded',verdict:'approved'}},null],
  ['cm-prd','publish_summary',{status:'awaiting_review',next:'human_review_then_explicit_cm_ai'},'done'],
  ['cm-prd','save_draft',{status:'blocked',reason:'prd_host_result_unknown'},'stuck'],
  // cm-idea: cm-idea-host.mjs
  ['cm-idea','start',{stage:'awaiting_user',reply:{status:'question',question:'q',productType:null}},'stuck'],
  ['cm-idea','advance',{stage:'draft_ready',reply:{status:'draft'}},'stuck'],
  ['cm-idea','prepare_save',{stage:'draft_ready',confirmationRequired:true},null],
  ['cm-idea','finish',{stage:'saved',saved:{maturity:'L1'}},'done'],
  // cm-init: cm-init-host.mjs / draft-generation.mjs
  ['cm-init','start',{stage:'analysis_ready'},null],
  ['cm-init','start',{stage:'analysis_blocked'},'stuck'],
  ['cm-init','advance',{workflow:'cm-init',status:'draft_generated'},null],
  ['cm-init','advance',{workflow:'cm-init',status:'blocked',reason:'host_generation_blocked'},'stuck'],
  ['cm-init','advance',{stage:'verification_blocked'},'stuck'],
  ['cm-init','advance',{stage:'confirmation_required'},'stuck'],
  ['cm-init','advance',{stage:'review_required'},null],
  ['cm-init','advance',{stage:'rules_written'},'done'],
  // cm-refactor: workflow.mjs
  ['cm-refactor','resume',{stage:'awaiting_finish',runId:'refactor-1'},'stuck'],
  ['cm-refactor','resume',{stage:'blocked',reason:'refactor_review_exhausted',runId:'refactor-1'},'stuck'],
  ['cm-refactor','prepare_judge_revision',{stage:'judge_revision_prepared',runId:'refactor-1'},null],
  ['cm-refactor','finish',{stage:'done',runId:'refactor-1'},'done'],
  ['cm-refactor','start',{stage:'not_needed',runId:'refactor-1'},'done'],
  // cm-test: cm-test/host.mjs
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'FAIL'},'stuck'],
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'BLOCKED'},'stuck'],
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'PASS'},'done'],
  ['cm-test','start',{stage:'interrupted',runId:'test-1',pending:{key:'1'}},'stuck'],
  ['cm-test','resume',{stage:'reported',runId:'test-1',overall:'FAIL',historical:true},null],
  // cm-check: cm-check/host.mjs
  ['cm-check','start',{stage:'reported',result:{overall:'FAILED'}},'stuck'],
  ['cm-check','start',{stage:'reported',result:{overall:'BLOCKED'}},'stuck'],
  ['cm-check','start',{stage:'reported',result:{overall:'PASSED'}},'done'],
  ['cm-check','start',{stage:'reported',result:{overall:'MECHANICAL_ONLY'}},'done'],
  ['cm-check','start',{stage:'blocked',result:{overall:'BLOCKED',reason:'check_source_changed'}},'stuck'],
];
test('driver classification follows each workflow contract (table)',()=>{
  assert.deepEqual([...new Set(CASES.map(([workflow])=>workflow))].sort(),[...NOTIFY_WORKFLOWS].sort());
  for(const [workflow,operation,result,expected] of CASES){
    const notice=driveNotice({host:`/x/scripts/${workflow}-host.mjs`,cwd:'/work/demo-app',args:['serve'],operation,
      row:{requestId:'drive',result}});
    assert.equal(notice?.event??null,expected,`${workflow} ${operation} ${JSON.stringify(result)}`);
    if(expected==='done')assert.match(notice.nextAction,/新会话/,`${workflow} done suggests a fresh session`);
  }
  for(const workflow of NOTIFY_WORKFLOWS){
    assert.equal(driveNotice({host:`${workflow}-host.mjs`,cwd:'/w/p',operation:'advance',row:{requestId:'drive',error:{code:'host_request_failed'}}}).event,'stuck');
    assert.equal(driveNotice({host:`${workflow}-host.mjs`,cwd:'/w/p',operation:'advance',failure:'host_exited'}).code,'host_exited');
  }
  const blocked=driveNotice({host:'/x/scripts/cm-ai-host.mjs',cwd:'/work/demo-app',args:['serve'],operation:'advance',
    row:{requestId:'drive',result:ai({outcome:'advanced',state:'blocked',code:'develop_checks_not_passed',pendingAction:'resume',
      guidance:{nextStep:'修复后 advance'}})}});
  assert.deepEqual({...blocked},{key:'cm-ai|run-1|T-001|1|blocked|develop_checks_not_passed',event:'stuck',workflow:'cm-ai',
    project:'demo-app',runId:'run-1',task:'T-001',stage:'blocked',code:'develop_checks_not_passed',nextAction:'修复后 advance'});
  const batch=driveNotice({host:'cm-ai-batch-host.mjs',cwd:'/w/p',args:['a'],operation:'advance',
    row:{requestId:'drive',result:{outcome:'blocked',code:'merge_conflict',batchId:'b1'}}});
  assert.equal(batch.runId,'b1');assert.equal(batch.code,'merge_conflict');
  assert.match(driveNotice({host:'cm-ai-host.mjs',cwd:'/w/p',operation:'advance',failure:'host_exited'}).key,/^cm-ai\|args:[0-9a-f]{16}\|/);
});

// Shared driver core (scripts/*-drive.mjs all use driveHost) with a host that
// stops on blocked: one notice; repeating the identical run sends nothing new.
// The notify command takes 3 s, yet the driver exits without waiting for it.
test('driver ending in blocked notifies exactly once, never waits for the command, and an identical run does not resend',async t=>{
  const h=home(t,{sleepMs:3000});
  const host=path.join(h.dir,'cm-ai-host.mjs'),wrapper=path.join(h.dir,'cm-ai-drive.mjs'),project=path.join(h.dir,'demo-app');
  fs.mkdirSync(project);
  fs.writeFileSync(host,`process.stdout.write(JSON.stringify({type:'host_ready',sessionId:'s'})+'\\n');
process.stdin.on('data',chunk=>{for(const line of String(chunk).split('\\n').filter(Boolean)){const row=JSON.parse(line);
 if(row.requestId==='drive')process.stdout.write(JSON.stringify({requestId:'drive',result:{workflow:'cm-ai',outcome:'advanced',state:'blocked',
  code:'checks_not_passed',pendingAction:'none',identity:{runId:'run-7',taskId:'T-001',attempt:1}}})+'\\n');}});
process.stdin.on('end',()=>process.exit(0));`);
  fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
driveHost({host:${JSON.stringify(host)},args:['serve'],cwd:${JSON.stringify(project)},operation:'advance',answers:{},answerFor:()=>null});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  for(let i=0;i<2;i++){
    const started=performance.now(),run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env,timeout:20000});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.state,'blocked');
    assert(performance.now()-started<2000,`driver exit waited on the notify command: ${performance.now()-started} ms`);
    assert.equal(h.rows().length,0,`run ${i}: the command is still running in the background`);
  }
  assert(await h.until(()=>h.rows().length===1));
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,1);
  const [row]=h.rows();
  assert.equal(row.title,'CM cm-ai 需要人处理 · demo-app');assert.equal(row.stdin.runId,'run-7');assert.equal(row.stdin.code,'checks_not_passed');
});

// Host bridge: a host_request outstanding past waitMinutes notifies once;
// an answer before then clears it; neither the timer nor a fired, slow
// notify command keeps the host alive.
test('host wait timer notifies once per call, is cleared on answer and does not keep the process alive',async t=>{
  const h=home(t,{config:{waitMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const mode=process.argv[2],bridge=createHostToolBridge();const sent=[];bridge.attach(row=>{sent.push(row);});
const answer=()=>{const r=sent.find(row=>row.type==='host_request');bridge.accept({type:'host_result',sessionId:r.sessionId,callId:r.callId,requestDigest:r.requestDigest,result:{ok:true}});};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(mode==='late'){const p=bridge.call('qa_browser',{},new AbortController().signal);await wait(1000);answer();await p;}
if(mode==='early'){const p=bridge.call('qa_logic',{},new AbortController().signal);await wait(20);answer();await p;await wait(1200);}
if(mode==='hang')bridge.call('develop',{},new AbortController().signal).catch(()=>{});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const late=spawnSync(process.execPath,[script,'late'],{encoding:'utf8',env,timeout:20000});
  assert.equal(late.status,0,late.stderr);
  assert(await h.until(()=>h.rows().length===1));
  assert.equal(h.rows()[0].title,'CM cm-demo 等待会话应答 · '+path.basename(process.cwd()));
  assert.equal(h.rows()[0].stdin.stage,'qa_browser');assert.equal(h.rows()[0].stdin.code,'waiting_session_answer');
  const early=spawnSync(process.execPath,[script,'early'],{encoding:'utf8',env,timeout:20000});
  assert.equal(early.status,0,early.stderr);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(h.rows().length,1);
  const slow=home(t,{sleepMs:3000,config:{waitMinutes:0.003}});
  const fired=spawnSync(process.execPath,[script,'late'],{encoding:'utf8',env:{...env,CM_WORKFLOW_HOME:slow.dir},timeout:20000});
  assert.equal(fired.status,0,fired.stderr);assert.equal(slow.rows().length,0,'host exited before the slow command finished');
  assert(await slow.until(()=>slow.rows().length===1));
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({version:1,command:['/bin/true'],waitMinutes:10}));
  const started=Date.now(),hang=spawnSync(process.execPath,[script,'hang'],{encoding:'utf8',env,timeout:20000});
  assert.equal(hang.status,0,hang.stderr);assert(Date.now()-started<5000);
});

// A check request waits for the session to run the project's check commands,
// which normally takes tens of minutes: it uses checkWaitMinutes, not waitMinutes.
test('check requests use checkWaitMinutes so normal long checks are not reported as waiting',async t=>{
  const h=home(t,{config:{waitMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const kind=process.argv[2],bridge=createHostToolBridge();const sent=[];bridge.attach(row=>{sent.push(row);});
const p=bridge.call(kind,{},new AbortController().signal);await new Promise(resolve=>setTimeout(resolve,1000));
const r=sent.find(row=>row.type==='host_request');bridge.accept({type:'host_result',sessionId:r.sessionId,callId:r.callId,requestDigest:r.requestDigest,result:{ok:true}});await p;`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  for(const kind of ['check','verification_precheck','init_verify']){
    const run=spawnSync(process.execPath,[script,kind],{encoding:'utf8',env,timeout:20000});assert.equal(run.status,0,run.stderr);
  }
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,0,'default 45-minute check threshold');
  const cfg=JSON.parse(fs.readFileSync(path.join(h.dir,'notify.json'),'utf8'));
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({...cfg,waitMinutes:10,checkWaitMinutes:0.003}));
  const run=spawnSync(process.execPath,[script,'check'],{encoding:'utf8',env,timeout:20000});assert.equal(run.status,0,run.stderr);
  assert(await h.until(()=>h.rows().length===1));assert.equal(h.rows()[0].stdin.stage,'check');
});
test('checkWaitMinutes is validated like waitMinutes',t=>{
  const h=home(t,{config:{checkWaitMinutes:0}});
  assert.equal(readNotifyConfig(h.env),null);
});

// Host session: after an operation replies, nothing is in flight and the
// session sends no next operation for idleMinutes, one notice says so. A last
// result that waits on a person says "在等你" instead. Any next operation or
// session end clears it; status polls are not progress.
function idleHost(h){
  const script=path.join(h.dir,'cm-prd-host.mjs');
  fs.writeFileSync(script,`import {serveCmAiHost} from ${JSON.stringify(HOST_SESSION)};
const host={handle:async request=>{
  if(request.slowMs)await new Promise(resolve=>setTimeout(resolve,request.slowMs));
  if(['status','fix_status'].includes(request.operation))return {stage:'status_only',doneAt:Date.now()};
  return request.answer;}};
await serveCmAiHost({host,input:process.stdin,output:process.stdout});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  // steps: [delayMs, request object | raw line string | null to end stdin];
  // delay 'reply:<id>' waits until that requestId has been answered instead.
  return async steps=>{
    const child=spawn(process.execPath,[script],{env,stdio:['pipe','pipe','pipe']});
    let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});
    const exited=new Promise(resolve=>child.on('close',code=>resolve(code)));
    const replied=id=>stdout.includes(`"requestId":"${id}"`);
    for(const [delay,request] of steps){
      if(typeof delay==='string'){const id=delay.slice(6);while(!replied(id))await new Promise(resolve=>setTimeout(resolve,10));}
      else await new Promise(resolve=>setTimeout(resolve,delay));
      if(request===null){child.stdin.end();break;}
      if(request!==undefined)child.stdin.write((typeof request==='string'?request:JSON.stringify(request))+'\n');
    }
    const started=Date.now(),code=await exited;
    return {code,stdout,exitMs:Date.now()-started};
  };
}
const op=(n,answer,extra={})=>({requestId:`r${n}`,operation:'advance',answer,...extra});

test('host session idle after a finished step notifies once: 疑似空转 for progress, 在等你 for a person',async t=>{
  const h=home(t,{config:{idleMinutes:0.003}}),run=idleHost(h);
  const progress=await run([[0,op(1,{stage:'requirements_analysis',runId:'prd-1'})],[900,null]]);
  assert.equal(progress.code,0);
  assert(await h.until(()=>h.rows().length===1));
  const [idle]=h.rows();
  assert.equal(idle.title,'CM cm-prd 疑似空转 · '+path.basename(process.cwd()));
  assert.equal(idle.stdin.event,'idle');assert.equal(idle.stdin.code,'no_next_step');
  assert.equal(idle.stdin.runId,'prd-1');assert.equal(idle.stdin.stage,'requirements_analysis');
  const waiting=home(t,{config:{idleMinutes:0.003}});
  const review=await idleHost(waiting)([[0,op(1,{stage:'awaiting_user',runId:'prd-2'})],[900,null]]);
  assert.equal(review.code,0);
  assert(await waiting.until(()=>waiting.rows().length===1));
  assert.equal(waiting.rows()[0].title,'CM cm-prd 在等你 · '+path.basename(process.cwd()));
  assert.equal(waiting.rows()[0].stdin.event,'idle_waiting');assert.equal(waiting.rows()[0].stdin.code,'waiting_for_you');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(h.rows().length,1);assert.equal(waiting.rows().length,1);
});

test('host session idle: next step, in-flight step and session end clear it; status polls do not',async t=>{
  const h=home(t,{config:{idleMinutes:0.003}}),run=idleHost(h);
  // Steady progress: each next operation arrives before the threshold.
  const steady=[];for(let n=1;n<=6;n++)steady.push([n===1?0:60,op(n,{stage:'requirements_analysis'})]);
  assert.equal((await run([...steady,[60,null]])).code,0);
  // A long in-flight operation is not idleness; ending right after its reply clears the timer.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'},{slowMs:900})],[950,null]])).code,0);
  // A slow next operation: its arrival clears the timer armed by the previous reply.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],[60,op(2,{stage:'requirements_analysis'},{slowMs:900})],[950,null]])).code,0);
  // A cancel reply while another operation is still in flight does not arm it.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'},{slowMs:900})],[60,{requestId:'c1',operation:'cancel'}],[900,null]])).code,0);
  // Driver shape: EOF right after the reply arrived.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],['reply:r1',null]])).code,0);
  // A line the host rejects (not JSON, unknown operation) is still the session's next step.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],[60,'not json'],[900,null]])).code,0);
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],[60,{requestId:'x',operation:'no_such_op'}],[900,null]])).code,0);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.equal(h.rows().length,0,h.log());
  // Polls (status via the control path, fix_status via the normal path) neither
  // hold the timer off nor replace the last real step's result.
  for(const poll of ['status','fix_status']){
    const polls=[[0,op(1,{stage:'requirements_analysis',runId:`run-${poll}`})]];
    for(let n=0;n<12;n++)polls.push([60,{requestId:`s${n}`,operation:poll}]);
    assert.equal((await run([...polls,[60,null]])).code,0);
    assert(await h.until(()=>h.rows().some(row=>row.stdin.runId===`run-${poll}`)));
    const row=h.rows().find(row=>row.stdin.runId===`run-${poll}`);
    assert.equal(row.stdin.event,'idle');assert.equal(row.stdin.stage,'requirements_analysis');
  }
  assert.equal(h.rows().length,2);
});

// A poll that is still running when the deadline passes holds the notice; it
// goes out right after the poll replies, not during it.
test('host session idle: a slow status in flight holds the notice until it replies',async t=>{
  const h=home(t,{config:{idleMinutes:0.003}}),run=idleHost(h);
  const result=await run([[0,op(1,{stage:'requirements_analysis'})],[60,{requestId:'s1',operation:'status',slowMs:700}],['reply:s1',undefined],[400,null]]);
  assert.equal(result.code,0);
  const doneAt=JSON.parse(result.stdout.split('\n').find(line=>line.includes('"requestId":"s1"'))).result.doneAt;
  assert(await h.until(()=>h.rows().length===1));
  assert(h.rows()[0].at>=doneAt,`notice at ${h.rows()[0].at} before status finished at ${doneAt}`);
  assert.equal(h.rows()[0].stdin.stage,'requirements_analysis');
});

// Tool-bridge sessions end with host_close from the driver: exit 0, no notice.
test('host session idle: host_close ends the session cleanly without a notice',async t=>{
  const h=home(t,{config:{idleMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {serveCmAiHost} from ${JSON.stringify(HOST_SESSION)};
import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const bridge=createHostToolBridge();
const host={handle:async()=>({stage:'awaiting_review',asked:await bridge.call('develop',{},new AbortController().signal)})};
await serveCmAiHost({host,input:process.stdin,output:process.stdout,toolBridge:bridge});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[script],{env,stdio:['pipe','pipe','pipe']});
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});
  const exited=new Promise(resolve=>child.on('close',resolve));
  const lines=()=>stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  child.stdin.write(JSON.stringify({requestId:'r1',operation:'advance'})+'\n');
  await h.until(()=>lines().some(row=>row.type==='host_request'));
  const ask=lines().find(row=>row.type==='host_request');
  child.stdin.write(JSON.stringify({type:'host_result',sessionId:ask.sessionId,callId:ask.callId,requestDigest:ask.requestDigest,result:{ok:true}})+'\n');
  await h.until(()=>lines().some(row=>row.requestId==='r1'));
  child.stdin.write(JSON.stringify({type:'host_close',sessionId:ask.sessionId})+'\n');
  assert.equal(await exited,0);
  assert.deepEqual(lines().map(row=>row.type??row.requestId),['host_ready','host_request','host_response','r1','host_response']);
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,0);
});

test('host session idle timer never delays exit and idleMinutes is validated',async t=>{
  const h=home(t,{config:{idleMinutes:600}}),run=idleHost(h);
  const result=await run([[0,op(1,{stage:'requirements_analysis'})],[100,null]]);
  assert.equal(result.code,0);assert(result.exitMs<3000);assert.match(result.stdout,/"requestId":"r1"/);
  assert.equal(h.rows().length,0);
  for(const idleMinutes of [0,-1,1441,'45'])assert.equal(readNotifyConfig(home(t,{config:{idleMinutes}}).env),null);
});
