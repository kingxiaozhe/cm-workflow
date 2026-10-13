import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const moduleUrl=process.env.CM_DRIVE_LIVENESS_MODULE??new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
function run(t,body,{answer='async()=>({ok:true})',liveness={}}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-liveness-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const host=path.join(dir,'host.mjs');
  fs.writeFileSync(host,`import fs from 'node:fs';setTimeout(()=>process.exit(97),3500).unref();\nimport readline from 'node:readline';\nconst send=x=>process.stdout.write(JSON.stringify(x)+'\\n');\nconst ready=(heartbeat=false)=>send({type:'host_ready',sessionId:'fixture',...(heartbeat?{heartbeat:{intervalMs:20,timeoutMs:100}}:{})});\n${body}`);
  const driver=path.join(dir,'driver.mjs');
  fs.writeFileSync(driver,`import {driveHost} from ${JSON.stringify(moduleUrl)};\ndriveHost({host:${JSON.stringify(host)},args:[],cwd:${JSON.stringify(dir)},operation:'advance',answers:{},paths:{},answerFor:${answer},liveness:${JSON.stringify({startupMs:200,operationMs:700,heartbeatMs:100,graceMs:50,closeMs:150,killMs:100,pollMs:10,...liveness})}});`);
  const started=Date.now();const result=spawnSync(process.execPath,[driver],{encoding:'utf8',timeout:4000,env:{...process.env,CM_WORKFLOW_HOME:path.join(dir,'home'),CM_WORKFLOW_LOG_HOME:path.join(dir,'logs'),CM_NOTIFY:'off'}});
  return {...result,elapsedMs:Date.now()-started};
}
test('driver bounds a host that stays alive without ready',t=>{
  const out=run(t,'setInterval(()=>{},1000);');assert.equal(out.status,70,out.stderr);assert.match(out.stderr,/host_start_timeout/);
});
test('driver detects host exit before result and does not invent success',t=>{
  const out=run(t,'process.exit(7);');assert.equal(out.status,71,out.stderr);assert.match(out.stderr,/host_exited/);assert.equal(out.stdout,'');
});
test('advertised heartbeat loss expires independently of operation budget',t=>{
  const out=run(t,'ready(true);setInterval(()=>{},1000);');assert.equal(out.status,72,out.stderr);assert.match(out.stderr,/host_heartbeat_timeout/);
});
test('heartbeats do not extend the deadline of a stuck bridge phase',t=>{
  const out=run(t,`ready(true);const started=Date.now();setInterval(()=>send({type:'host_heartbeat',sessionId:'fixture',inFlight:{requestId:'drive',operation:'advance',stage:'review',call:{callId:'call',kind:'review',deadlineMs:started+150}}}),20);`);
  assert.equal(out.status,73,out.stderr);assert.match(out.stderr,/host_stage_timeout/);
});
test('valid long bridge budget survives generic shorter operation budget',t=>{
  const out=run(t,`ready(true);const started=Date.now();const timer=setInterval(()=>send({type:'host_heartbeat',sessionId:'fixture',inFlight:{requestId:'drive',operation:'advance',stage:'check',call:{callId:'call',kind:'check',deadlineMs:started+650}}}),20);setTimeout(()=>{clearInterval(timer);send({requestId:'drive',result:{state:'fixture_completed'}});},400);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,{liveness:{operationMs:150}});
  assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.state,'fixture_completed');
});
test('host_busy waits for the named original result and never closes active work',t=>{
  const out=run(t,`ready();readline.createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);if(row.operation){send({requestId:'drive',error:{code:'host_busy',inFlight:{requestId:'original',operation:'advance',startedAt:new Date().toISOString(),stage:'review'}}});setTimeout(()=>send({requestId:'original',result:{state:'fixture_completed'}}),50);}else if(row.type==='host_close')process.exit(19);});process.stdin.on('end',()=>process.exit(0));`);
  assert.equal(out.status,0,out.stderr);assert.match(out.stderr,/host_busy/);assert.equal(JSON.parse(out.stdout).requestId,'original');
});
test('legacy host with no heartbeat remains supported and bounded',t=>{
  const good=run(t,`ready();process.stdin.once('data',()=>send({requestId:'drive',result:{state:'fixture_completed'}}));process.stdin.on('end',()=>process.exit(0));`);
  assert.equal(good.status,0,good.stderr);
  const stuck=run(t,`ready();process.stdin.resume();setInterval(()=>{},1000);`,{liveness:{operationMs:150}});
  assert.equal(stuck.status,73,stuck.stderr);
});
test('unanswered request explicitly forces close instead of bypassing close protection with EOF',t=>{
  const out=run(t,`ready(true);let acknowledged=false;readline.createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);if(row.operation)send({type:'host_request',sessionId:'fixture',callId:'call',kind:'develop',requestDigest:'digest'});else if(row.type==='host_close'){if(row.force!==true)process.exit(19);setTimeout(()=>{acknowledged=true;send({type:'host_response',accepted:true,closing:true});},30);}});process.stdin.on('end',()=>process.exit(acknowledged?0:19));`,{answer:'async()=>null',liveness:{heartbeatMs:500}});
  assert.equal(out.status,1,out.stderr);assert.match(out.stderr,/force.*unknown/);
});
test('driver handles absent pipe reader without uncaught EPIPE',t=>{
  const out=run(t,`fs.closeSync(0);ready();setInterval(()=>{},1000);`);
  assert.equal(out.status,74,out.stderr);assert.match(out.stderr,/host_pipe_closed/);assert.doesNotMatch(out.stderr,/Unhandled 'error'/);
});

test('a final result cannot conceal a host that refuses to exit',t=>{
  const out=run(t,`ready();process.stdin.once('data',()=>send({requestId:'drive',result:{state:'fixture_completed'}}));process.stdin.resume();setInterval(()=>{},1000);`);
  assert.equal(out.status,75,out.stderr);assert.match(out.stderr,/host_close_timeout/);
});
test('watchdog terminates only its own spawned host group',t=>{
  const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>{if(unrelated.exitCode===null&&unrelated.signalCode===null)unrelated.kill('SIGKILL');});
  const out=run(t,'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);');
  assert.equal(out.status,70,out.stderr);assert.equal(unrelated.exitCode,null);assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
});

test('native stage deadline wins over a longer live bridge deadline',t=>{
  const out=run(t,`ready(true);const started=Date.now();setInterval(()=>send({type:'host_heartbeat',sessionId:'fixture',inFlight:{requestId:'drive',operation:'advance',nativeStage:{id:'native',kind:'check',deadlineMs:started+150},call:{callId:'call',kind:'develop',deadlineMs:started+1500}}}),20);`);
  assert.equal(out.status,73,out.stderr);assert.match(out.stderr,/host_stage_timeout/);assert.ok(out.elapsedMs<1000,`native deadline lost: ${out.elapsedMs}ms`);
});
test('ending a nested call restores the original native deadline without extending it',t=>{
  const out=run(t,`ready(true);const started=Date.now();setInterval(()=>{const age=Date.now()-started;send({type:'host_heartbeat',sessionId:'fixture',inFlight:{requestId:'drive',operation:'advance',nativeStage:{id:'outer',kind:'complete',deadlineMs:age<120?started+350:Date.now()+1500},call:age<120?{callId:'inner',kind:'check',deadlineMs:started+200}:null}});},20);`);
  assert.equal(out.status,73,out.stderr);assert.match(out.stderr,/host_stage_timeout/);
});

for(const mode of ['watchdog','unexpected-exit'])test(`owned same-group worker cannot outlive ${mode} host closure`,async t=>{
  const body=`import {spawn} from 'node:child_process';
    const worker=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),2500);setInterval(()=>{},20)'],{stdio:'ignore'});
    console.log('worker:'+worker.pid);
    ${mode==='unexpected-exit'?'setTimeout(()=>process.exit(7),100);':'setInterval(()=>{},1000);'}`;
  const out=run(t,body);assert.equal(out.status,mode==='watchdog'?70:71,out.stderr);
  const pid=Number(out.stdout.trim().slice('worker:'.length));assert.ok(Number.isInteger(pid)&&pid>0);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
