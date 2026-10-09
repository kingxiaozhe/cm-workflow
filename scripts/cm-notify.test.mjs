import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {notify,readNotifyConfig,buildNotifyMessage,driveNotice,NOTIFY_LIMITS} from '../runtime/js/notify.mjs';

const NOW=Date.parse('2026-10-08T08:00:00.000Z');
const DRIVE_CORE=new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
const BRIDGE=new URL('../runtime/js/cm-ai/host-tool-bridge.mjs',import.meta.url).href;

// A temp CM_WORKFLOW_HOME with notify.json pointing at a fake command that
// appends its environment message and stdin payload to sent.jsonl.
function home(t,{exit=0,sleepMs=0,config={}}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=path.join(dir,'sent.jsonl'),script=path.join(dir,'fake-notify.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{setTimeout(()=>{fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify({title:process.env.CM_NOTIFY_TITLE,
body:process.env.CM_NOTIFY_BODY,stdin:JSON.parse(input)})+'\\n');process.exit(${exit});},${sleepMs});});`);
  fs.writeFileSync(path.join(dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script],...config}));
  const env={...process.env,CM_WORKFLOW_HOME:dir};
  const rows=()=>fs.existsSync(sent)?fs.readFileSync(sent,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  const log=()=>fs.existsSync(path.join(dir,'notify.log'))?fs.readFileSync(path.join(dir,'notify.log'),'utf8'):'';
  return {dir,env,rows,log};
}
const fields=(key,over={})=>({key,event:'stuck',project:'/srv/work/demo-app',workflow:'cm-fix',runId:'run-1',
  task:'T-001',stage:'blocked',code:'checks_not_passed',nextAction:'核对 reason 后恢复原运行',...over});

test('off without notify.json, and off under node --test unless CM_WORKFLOW_HOME is explicit',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(readNotifyConfig({CM_WORKFLOW_HOME:dir}),null);
  assert.deepEqual(await notify(fields('a'),{env:{CM_WORKFLOW_HOME:dir},now:NOW}),{sent:false,reason:'off'});
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
  fs.writeFileSync(file,JSON.stringify({version:1,command:['/bin/true'],waitMinutes:0.5}));
  assert.deepEqual(readNotifyConfig(h.env),{command:['/bin/true'],waitMs:30000});
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
  assert.deepEqual(await notify(fields('same'),{env:h.env,now:NOW}),{sent:true,reason:'sent'});
  assert.deepEqual(await notify(fields('same'),{env:h.env,now:NOW+5*3600*1000}),{sent:false,reason:'duplicate'});
  assert.equal(h.rows().length,1);
  const [row]=h.rows();
  assert.equal(row.title,'CM cm-fix 需要人处理 · demo-app');assert.equal(row.stdin.title,row.title);assert.equal(row.stdin.body,row.body);
  assert.equal(row.stdin.project,'demo-app');assert.equal(row.stdin.code,'checks_not_passed');assert.equal(row.stdin.key,undefined);
  assert.equal((await notify(fields('same'),{env:h.env,now:NOW+6*3600*1000+1})).sent,true);
  assert.equal(h.rows().length,2);
  const state=JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8'));
  assert.equal(JSON.stringify(state).includes('same'),false);
  assert(!fs.existsSync(path.join(h.dir,'notify-state.lock')));
});

test('at most 4 per rolling minute and 150 per day across keys',async t=>{
  const h=home(t);
  for(let i=0;i<4;i++)assert.equal((await notify(fields(`m${i}`),{env:h.env,now:NOW+i})).sent,true);
  assert.deepEqual(await notify(fields('m4'),{env:h.env,now:NOW+10}),{sent:false,reason:'rate_minute'});
  assert.equal((await notify(fields('m4'),{env:h.env,now:NOW+60010})).sent,true);
  assert.match(h.log(),/skipped rate_minute/);
  const sends=Array.from({length:150},(_,i)=>NOW+120000+i*60000);
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify({version:1,keys:{},sends}));
  assert.deepEqual(await notify(fields('day'),{env:h.env,now:NOW+200*60000}),{sent:false,reason:'rate_day'});
  assert.equal((await notify(fields('day'),{env:h.env,now:NOW+120000+24*3600*1000})).sent,true);
});

test('command failure, timeout and broken state never throw; they log one line without content',async t=>{
  const failing=home(t,{exit:3});
  assert.deepEqual(await notify(fields('f'),{env:failing.env,now:NOW}),{sent:false,reason:'exit_3'});
  assert.match(failing.log(),/^\S+ stuck cm-fix key=[0-9a-f]{16} failed exit_3\n$/);
  const slow=home(t,{sleepMs:5000});
  assert.deepEqual(await notify(fields('s'),{env:slow.env,now:NOW,timeoutMs:200}),{sent:false,reason:'timeout'});
  assert.match(slow.log(),/failed timeout/);
  const missing=home(t);fs.writeFileSync(path.join(missing.dir,'notify.json'),JSON.stringify({version:1,command:['/nonexistent/notify-cmd']}));
  assert.equal((await notify(fields('n'),{env:missing.env,now:NOW})).sent,false);assert.match(missing.log(),/failed spawn_enoent/);
  const broken=home(t);fs.writeFileSync(path.join(broken.dir,'notify-state.json'),'{');
  assert.deepEqual(await notify(fields('b'),{env:broken.env,now:NOW}),{sent:false,reason:'state_invalid'});
  const busy=home(t);fs.writeFileSync(path.join(busy.dir,'notify-state.lock'),'');
  assert.deepEqual(await notify(fields('l'),{env:busy.env,now:NOW}),{sent:false,reason:'state_busy'});
  for(const h of [slow,missing,broken,busy])assert.equal(h.rows().length,0);
  for(const h of [failing,slow,missing,broken,busy])assert(!/demo-app|T-001|核对|run-1/.test(h.log()));
});

test('respects CM_WORKFLOW_HOME: config, state and log stay in that directory',async t=>{
  const a=home(t),b=home(t);fs.rmSync(path.join(b.dir,'notify.json'));
  assert.equal((await notify(fields('h'),{env:b.env,now:NOW})).reason,'off');
  assert.equal((await notify(fields('h'),{env:a.env,now:NOW})).sent,true);
  assert(fs.existsSync(path.join(a.dir,'notify-state.json')));assert(!fs.existsSync(path.join(b.dir,'notify-state.json')));
});

test('driver classification: progress is silent, stops and the run end are reported',()=>{
  const base={host:'/x/scripts/cm-ai-host.mjs',cwd:'/work/demo-app',args:['serve'],operation:'advance'};
  const identity={runId:'r1',taskId:'T-002',attempt:1};
  assert.equal(driveNotice({...base,row:{requestId:'drive',result:{state:'awaiting_review',identity}}}),null);
  assert.equal(driveNotice({...base,operation:'status',row:{requestId:'drive',result:{state:'blocked',identity}}}),null);
  const blocked=driveNotice({...base,row:{requestId:'drive',result:{state:'blocked',code:'develop_checks_not_passed',identity,
    guidance:{nextStep:'修复后 advance'}}}});
  assert.deepEqual({...blocked},{key:'cm-ai|r1|T-002|1|blocked|develop_checks_not_passed',event:'stuck',workflow:'cm-ai',
    project:'demo-app',runId:'r1',task:'T-002',stage:'blocked',code:'develop_checks_not_passed',nextAction:'修复后 advance'});
  assert.equal(driveNotice({...base,host:'cm-fix-host.mjs',row:{requestId:'drive',result:{stage:'cause_review_required',
    progress:{requiresUser:true,blocker:'rediagnosis_review_limit_reached'}}}}).event,'stuck');
  const done=driveNotice({...base,row:{requestId:'drive',result:{state:'run_done',code:'run_done',identity}}});
  assert.equal(done.event,'done');assert.match(done.key,/\|done$/);assert.equal(done.nextAction,null);
  const refused=driveNotice({...base,failure:'host_exited'});
  assert.equal(refused.event,'stuck');assert.equal(refused.code,'host_exited');assert.match(refused.key,/^cm-ai\|args:[0-9a-f]{16}\|/);
});

// Shared driver core (scripts/*-drive.mjs all use driveHost) with a host that
// stops on blocked: one notice; repeating the identical run sends nothing new.
test('driver ending in blocked notifies exactly once; an identical second run does not resend',t=>{
  const h=home(t);
  const host=path.join(h.dir,'cm-demo-host.mjs'),wrapper=path.join(h.dir,'cm-demo-drive.mjs'),project=path.join(h.dir,'demo-app');
  fs.mkdirSync(project);
  fs.writeFileSync(host,`process.stdout.write(JSON.stringify({type:'host_ready',sessionId:'s'})+'\\n');
process.stdin.on('data',chunk=>{for(const line of String(chunk).split('\\n').filter(Boolean)){const row=JSON.parse(line);
 if(row.requestId==='drive')process.stdout.write(JSON.stringify({requestId:'drive',result:{workflow:'cm-demo',state:'blocked',
  code:'checks_not_passed',requiresUser:true,identity:{runId:'run-7',taskId:'T-001',attempt:1}}})+'\\n');}});
process.stdin.on('end',()=>process.exit(0));`);
  fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
driveHost({host:${JSON.stringify(host)},args:['serve'],cwd:${JSON.stringify(project)},operation:'advance',answers:{},answerFor:()=>null});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  for(let i=0;i<2;i++){
    const run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env,timeout:20000});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.state,'blocked');
    assert.equal(h.rows().length,1,`run ${i}`);
  }
  const [row]=h.rows();
  assert.equal(row.title,'CM cm-demo 需要人处理 · demo-app');assert.equal(row.stdin.runId,'run-7');assert.equal(row.stdin.code,'checks_not_passed');
});

// Host bridge: a host_request outstanding past waitMinutes notifies once;
// an answer before then clears it; the timer never keeps the host alive.
test('host wait timer notifies once per call, is cleared on answer and does not keep the process alive',t=>{
  const h=home(t,{config:{waitMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const mode=process.argv[2],bridge=createHostToolBridge();const sent=[];bridge.attach(row=>{sent.push(row);});
const answer=()=>{const r=sent.find(row=>row.type==='host_request');bridge.accept({type:'host_result',sessionId:r.sessionId,callId:r.callId,requestDigest:r.requestDigest,result:{ok:true}});};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(mode==='late'){const p=bridge.call('qa_browser',{},new AbortController().signal);await wait(1500);answer();await p;}
if(mode==='early'){const p=bridge.call('qa_logic',{},new AbortController().signal);await wait(20);answer();await p;await wait(1200);}
if(mode==='hang')bridge.call('develop',{},new AbortController().signal).catch(()=>{});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const late=spawnSync(process.execPath,[script,'late'],{encoding:'utf8',env,timeout:20000});
  assert.equal(late.status,0,late.stderr);
  assert.equal(h.rows().length,1);
  assert.equal(h.rows()[0].title,'CM cm-demo 等待会话应答 · '+path.basename(process.cwd()));
  assert.equal(h.rows()[0].stdin.stage,'qa_browser');assert.equal(h.rows()[0].stdin.code,'waiting_session_answer');
  const early=spawnSync(process.execPath,[script,'early'],{encoding:'utf8',env,timeout:20000});
  assert.equal(early.status,0,early.stderr);assert.equal(h.rows().length,1);
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({version:1,command:['/bin/true'],waitMinutes:10}));
  const started=Date.now(),hang=spawnSync(process.execPath,[script,'hang'],{encoding:'utf8',env,timeout:20000});
  assert.equal(hang.status,0,hang.stderr);assert(Date.now()-started<5000);
});
