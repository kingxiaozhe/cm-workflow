import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {patrol,inspectHosts,processAlive} from './cm-patrol.mjs';
import {hostRegistryDir,buildNotifyMessage} from '../runtime/js/notify.mjs';

const HOST_SESSION=new URL('../runtime/js/cm-ai/host-session.mjs',import.meta.url).href;
const PATROL=fileURLToPath(new URL('./cm-patrol.mjs',import.meta.url));
const NOW=Date.parse('2026-10-09T08:00:00.000Z');
const KEYS=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'];

// A temp CM_WORKFLOW_HOME whose notify.json points at a fake command that
// appends its message to sent.jsonl.
function home(t,{withConfig=true}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-patrol-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=path.join(dir,'sent.jsonl'),script=path.join(dir,'fake-notify.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify({title:process.env.CM_NOTIFY_TITLE,
body:process.env.CM_NOTIFY_BODY,stdin:JSON.parse(input)})+'\\n');});`);
  if(withConfig)fs.writeFileSync(path.join(dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script]}));
  const env={...process.env,CM_WORKFLOW_HOME:dir};
  const rows=()=>fs.existsSync(sent)?fs.readFileSync(sent,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));return check();};
  const registry=()=>fs.existsSync(hostRegistryDir(env))?fs.readdirSync(hostRegistryDir(env)).filter(name=>name.endsWith('.json')).sort():[];
  const write=(key,entry)=>{fs.mkdirSync(hostRegistryDir(env),{recursive:true});fs.writeFileSync(path.join(hostRegistryDir(env),`${key}.json`),
    typeof entry==='string'?entry:JSON.stringify({version:1,sessionKey:key,workflow:'cm-ai',project:'/srv/work/demo-app',startedAt:new Date(NOW-3600000).toISOString(),
      at:new Date(NOW-600000).toISOString(),runId:'run-1',task:'T-003',stage:'awaiting_review',operation:'advance',...entry}));};
  return {dir,env,rows,until,registry,write};
}
// A pid that certainly existed and is gone now.
function gonePid(){const child=spawnSync(process.execPath,['-e','']);assert.equal(child.status,0);return child.pid;}

test('processAlive: own pid and a finished child',()=>{
  assert.equal(processAlive(process.pid),true);
  assert.equal(processAlive(gonePid()),false);
});

test('host session registers itself when notices are configured: written at start, updated per reply, removed at end',async t=>{
  const h=home(t);
  const script=path.join(h.dir,'cm-prd-host.mjs');
  fs.writeFileSync(script,`import {serveCmAiHost} from ${JSON.stringify(HOST_SESSION)};
const host={handle:async request=>request.operation==='status'?{stage:'poll'}:{stage:request.stage,runId:'prd-9'}};
await serveCmAiHost({host,input:process.stdin,output:process.stdout});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[script],{env,stdio:['pipe','pipe','pipe']});
  t.after(()=>{try{child.kill();}catch{}});
  const exited=new Promise(resolve=>child.on('close',resolve));
  let out='';child.stdout.on('data',chunk=>{out+=chunk;});
  assert(await h.until(()=>h.registry().length===1),'registered at start');
  const read=()=>JSON.parse(fs.readFileSync(path.join(hostRegistryDir(env),h.registry()[0]),'utf8'));
  const first=read();
  assert.equal(first.pid,child.pid);assert.equal(first.workflow,'cm-prd');assert.equal(first.project,process.cwd());
  assert.equal(first.runId,null);assert.equal(first.operation,null);
  child.stdin.write(JSON.stringify({requestId:'r1',operation:'advance',stage:'requirements_analysis'})+'\n');
  assert(await h.until(()=>out.includes('"requestId":"r1"')&&read().operation==='advance'));
  const after=read();assert.equal(after.runId,'prd-9');assert.equal(after.stage,'requirements_analysis');assert.equal(after.sessionKey,first.sessionKey);
  child.stdin.write(JSON.stringify({requestId:'s1',operation:'status'})+'\n');
  assert(await h.until(()=>out.includes('"requestId":"s1"')));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(read().stage,'requirements_analysis','a status poll does not overwrite the registry');
  child.stdin.end();assert.equal(await exited,0);
  assert.deepEqual(h.registry(),[],'removed at session end');
  // A session that ends immediately leaves nothing behind either.
  const quick=spawnSync(process.execPath,[script],{env,input:''});assert.equal(quick.status,0,quick.stderr);
  assert.deepEqual(h.registry(),[]);
  // Without notify.json nothing is written.
  const off=home(t,{withConfig:false});const offEnv={...off.env};delete offEnv.NODE_TEST_CONTEXT;
  const silent=spawnSync(process.execPath,[script],{env:offEnv,input:JSON.stringify({requestId:'r1',operation:'advance',stage:'x'})+'\n'});
  assert.equal(silent.status,0,silent.stderr);assert.equal(fs.existsSync(hostRegistryDir(offEnv)),false);
});

test('patrol: dead hosts are merged into one notice and their entries removed; live, stale and invalid entries are left alone',async t=>{
  const h=home(t),gone=gonePid();
  h.write(KEYS[0],{pid:process.pid});
  h.write(KEYS[1],{pid:gone,workflow:'cm-ai',task:'T-003',at:new Date(NOW-900000).toISOString()});
  h.write(KEYS[2],{pid:gone,workflow:'cm-fix',runId:'fix-2',task:null,stage:'repair_required',at:new Date(NOW-300000).toISOString()});
  h.write(KEYS[3],{pid:gone,at:new Date(NOW-49*3600000).toISOString()});
  h.write('55555555-5555-4555-8555-555555555555','{not json');
  const seen=inspectHosts({env:h.env,now:NOW});
  assert.deepEqual([seen.live.length,seen.dead.length,seen.stale.length,seen.invalid],[1,2,1,1]);
  const first=patrol({env:h.env,now:NOW});
  assert.equal(first.notice,'sent');assert.equal(first.dead,2);
  assert(await h.until(()=>h.rows().length===1));
  const [row]=h.rows();
  assert.equal(row.title,'CM cm 宿主已退出未收尾 · demo-app');
  assert.equal(row.stdin.code,'host_process_gone');assert.equal(row.stdin.stage,'2 个宿主进程已不在');
  assert.match(row.body,/cm-ai run-1 T-003 awaiting_review 最后动静 07:45Z；cm-fix fix-2 repair_required 最后动静 07:55Z/);
  assert.doesNotMatch(row.body,/srv|demo-app\//,'no paths');
  assert.deepEqual(h.registry(),[`${KEYS[0]}.json`,`${KEYS[3]}.json`,'55555555-5555-4555-8555-555555555555.json']);
  const again=patrol({env:h.env,now:NOW+60000});
  assert.equal(again.notice,'none');assert.equal(again.dead,0);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(h.rows().length,1);
});

test('patrol: a single dead host names its run and workflow; rate-limited or off keeps the entry for a later pass',async t=>{
  const h=home(t),gone=gonePid();
  h.write(KEYS[1],{pid:gone,workflow:'cm-prd',runId:'prd-7',task:null,stage:'awaiting_user'});
  const state={version:1,keys:{},sends:Array.from({length:4},()=>NOW-1000)};
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify(state));
  assert.equal(patrol({env:h.env,now:NOW}).notice,'rate_minute');
  assert.deepEqual(h.registry(),[`${KEYS[1]}.json`],'kept for the next pass');
  assert.equal(patrol({env:h.env,now:NOW+61000}).notice,'sent');
  assert(await h.until(()=>h.rows().length===1));
  assert.equal(h.rows()[0].title,'CM cm-prd 宿主已退出未收尾 · demo-app');
  assert.equal(h.rows()[0].stdin.runId,'prd-7');assert.equal(h.rows()[0].stdin.stage,'1 个宿主进程已不在');
  assert.deepEqual(h.registry(),[]);
  const off=home(t,{withConfig:false});off.write(KEYS[1],{pid:gone});
  assert.equal(patrol({env:off.env,now:NOW}).notice,'off');assert.deepEqual(off.registry(),[`${KEYS[1]}.json`]);
});

test('--report prints the summary and neither notifies nor removes anything',t=>{
  const h=home(t),gone=gonePid();
  h.write(KEYS[1],{pid:gone});
  const run=spawnSync(process.execPath,[PATROL,'--report'],{encoding:'utf8',env:{...h.env,NODE_TEST_CONTEXT:undefined}});
  assert.equal(run.status,0,run.stderr);
  const summary=JSON.parse(run.stdout);
  assert.equal(summary.notice,'report_only');assert.equal(summary.dead,1);assert.equal(summary.deadHosts[0].pid,gone);
  assert.deepEqual(h.registry(),[`${KEYS[1]}.json`]);assert.equal(h.rows().length,0);
  const plain=spawnSync(process.execPath,[PATROL],{encoding:'utf8',env:{...h.env,NODE_TEST_CONTEXT:undefined}});
  assert.equal(plain.status,0,plain.stderr);assert.equal(plain.stdout,'');
});

test('Windows paths are redacted like POSIX ones',()=>{
  const {body}=buildNotifyMessage({workflow:'cm-ai',nextAction:'见 C:\\Users\\me\\proj\\a.txt 和 \\\\server\\share\\b 以及 /tmp/c'},{now:NOW});
  assert.match(body,/下一步：见 <路径> 和 <路径> 以及 <路径>/);
});
