import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createProjectExecution} from '../runtime/js/cm-ai/host-project-execution.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {loadHandoff,checkN4,checkN5} from './cm-task-gate.mjs';
import {developerArgs} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
import {ownerGuardSource} from './fixtures/process-cleanup.mjs';
const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1};
const control=()=>({signal:new AbortController().signal});
const command=(id,code)=>({id,command:[process.execPath,'-e',code]});
// Hung checks die with this test process even if the host check never reaps them.
const hung=(id,code)=>command(id,ownerGuardSource()+code);
async function fixture(fn){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-')));
  try{await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

test('host check evidence retains bounded deterministic test counts',()=>fixture(async cwd=>{
  for(const [output,expected] of [
    ['ℹ tests 20\nℹ pass 20\nℹ fail 0\n',' (tests 20, pass 20, fail 0)'],
    ['  ℹ TESTS: 20\r\n tests=99\nPASS = 20\nfail 0',' (tests 20, pass 20, fail 0)'],
    ['tests 1\nsuites 2\npass 3\npassed 4\npassing 5\nfail 6\nfailed 7\nfailing 8\nskipped 9\ntodo 10',
      ' (tests 1, suites 2, pass 3, passed 4, passing 5, fail 6, failed 7, failing 8)'],
    [`tests 20\npass ${'9'.repeat(180)}\nfail 0`,' (tests 20)'],
  ]){
    const check=createHostCheck({cwd,commands:[command('counts',`process.stdout.write(${JSON.stringify(output)})`)]});
    const [result]=await check({identity},control());
    assert.equal(result.outcome,'passed');assert.equal(result.evidence,`host check exited 0${expected}`);
    assert(result.evidence.length<=200);
  }
}));

test('host check evidence excludes credentials paths and timing output',()=>fixture(async cwd=>{
  const output='token: abc123\nduration_ms 155.8\nat /srv/app/secret.js:12\ntests 20 token: abc123\npass 20.5\n';
  const check=createHostCheck({cwd,commands:[command('private',`process.stderr.write(${JSON.stringify(output)})`)]});
  const [result]=await check({identity},control());
  assert.equal(result.outcome,'passed');assert.equal(result.evidence,'host check exited 0');
}));

test('async output capture rejects safely and waits for process cleanup',()=>fixture(async cwd=>{
  const check=createHostCheck({cwd,commands:[hung('capture',
    "require('node:fs').writeFileSync('pid',String(process.pid));process.on('SIGTERM',()=>{});console.log('fixture');setInterval(()=>{},1000)")],
    timeoutMs:3000,onOutput:async()=>{throw Error('synthetic capture failure');}});
  const [result]=await check({identity},control());
  assert.equal(result.outcome,'unavailable');assert.equal(result.evidence,'host check: output_capture_failed');
  assert.throws(()=>process.kill(Number(fs.readFileSync(path.join(cwd,'pid'),'utf8')),0),{code:'ESRCH'});
}));

test('actual check output stays private while exit result feeds existing handoff',()=>fixture(async temp=>{
  const cwd=path.join(temp,'code');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'a.txt'),'old');fs.writeFileSync(path.join(cwd,'requirements.md'),'synthetic task');
  const baseline=captureReviewBaseline({root:cwd,identity,scope:['a.txt'],requirements:['requirements.md']});
  fs.writeFileSync(path.join(cwd,'a.txt'),'new');
  const check=createHostCheck({cwd,commands:[command('content',"require('node:assert/strict').equal(require('node:fs').readFileSync('a.txt','utf8'),'new');console.log('private output');")]});
  const checks=await check({identity},control());assert.equal(checks[0].outcome,'passed');
  assert(!checks[0].evidence.includes('private output'));
  const handoffPath=path.join(temp,'handoff.json');createHostHandoff({root:cwd,baseline,checks,handoffPath});
  assert.equal(loadHandoff(handoffPath).status,'ready_for_review');
}));
test('nonzero exit stops subsequent commands and does not report pass',()=>fixture(async cwd=>{
  const check=createHostCheck({cwd,commands:[command('fail','process.exit(3)'),command('later',"require('node:fs').writeFileSync('unexpected','x')")]});
  const results=await check({identity},control());assert.equal(results.length,1);
  assert.equal(results[0].outcome,'failed');assert.equal(results[0].exitCode,3);
  assert.equal(fs.existsSync(path.join(cwd,'unexpected')),false);
}));

// Synthetic project scanner contract, not evidence of any real scanner's coverage.
for(const scenario of [
  {name:'clean',code:0,outcome:'passed',exitCode:0},
  {name:'finding',code:1,outcome:'failed',exitCode:1},
  {name:'scanner-error',code:2,outcome:'failed',exitCode:2},
  {name:'missing-tool',outcome:'unavailable',exitCode:null},
  {name:'timeout',outcome:'unavailable',exitCode:null},
])test(`project security check ${scenario.name} reaches the existing review gate`,()=>fixture(async temp=>{
  const cwd=path.join(temp,'code'),reviewsDir=path.join(temp,'reviews');
  fs.mkdirSync(cwd);fs.mkdirSync(reviewsDir);
  fs.writeFileSync(path.join(cwd,'app.txt'),'before');
  fs.writeFileSync(path.join(cwd,'requirements.md'),'Run the declared project security check');
  const baseline=captureReviewBaseline({root:cwd,identity,scope:['app.txt'],requirements:['requirements.md']});
  fs.writeFileSync(path.join(cwd,'app.txt'),'after');
  const security=scenario.name==='missing-tool'?{id:'security',command:[path.join(temp,'absent-scanner')]}:
    (scenario.name==='timeout'?hung:command)('security',scenario.name==='timeout'?'setInterval(()=>{},1000)':
      // Misleading success text must never override a nonzero exit code.
      `console.log('PASS synthetic private scanner output');process.exit(${scenario.code})`);
  const check=createHostCheck({cwd,timeoutMs:scenario.name==='timeout'?1000:5000,
    commands:[command('unit','process.exit(0)'),security,command('later','process.exit(0)')]});
  const checks=await check({identity},control());
  assert.equal(checks[0].outcome,'passed');
  assert.equal(checks[1].outcome,scenario.outcome);assert.equal(checks[1].exitCode,scenario.exitCode);
  const passed=scenario.outcome==='passed';assert.equal(checks.length,passed?3:2);
  const handoff=path.join(reviewsDir,'work-T-001-a1-handoff.json');
  createHostHandoff({root:cwd,baseline,checks,handoffPath:handoff,
    evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
  const payload=loadHandoff(handoff);
  assert.equal(payload.status,passed?'ready_for_review':'blocked');
  assert(payload.verification.every(row=>!row.evidence.includes('synthetic private scanner output')));
  const selectors={handoff,reviewsDir,feature:'work',task:identity.taskId,projectRoot:cwd,requireLearning:true};
  if(passed){
    assert.equal(checkN4(selectors).content_bound,true);
    assert.throws(()=>checkN5(selectors)); // Passing scans still requires independent Review.
  }else{
    assert(payload.blockers.some(value=>value.includes('security')));
    assert.throws(()=>checkN4(selectors),/N4 requires a ready_for_review handoff/);
    assert.throws(()=>checkN5(selectors),/N5 requires a ready_for_review handoff/);
  }
}));
test('native Codex profile allows business writes but protects specs for project checks',
  {skip:process.platform!=='darwin'},()=>fixture(async cwd=>{
    const specsRoot=path.join(cwd,'specs');fs.mkdirSync(specsRoot);
    fs.writeFileSync(path.join(specsRoot,'tasks.md'),'host-owned');
    const args=developerArgs({cwd,specsRoot,model:'fixture',schemaPath:'/unused'});
    assert(!args.includes('--sandbox'));assert(!args.some(x=>x.startsWith('sandbox_workspace_write')));
    assert(args.includes('default_permissions="cm-specs"'));
    const check=createHostCheck({cwd,specsRoot,commands:[command('verify',`
      const fs=require('node:fs'),assert=require('node:assert/strict');
      const denied=fn=>assert.throws(fn,e=>['EPERM','EACCES'].includes(e.code));
      fs.writeFileSync('business.txt','allowed');
      assert.equal(fs.readFileSync('specs/tasks.md','utf8'),'host-owned');
      denied(()=>fs.writeFileSync('specs/tasks.md','bad'));
      denied(()=>fs.writeFileSync('specs/new.md','bad'));
      denied(()=>fs.renameSync('specs','moved-specs'));
      denied(()=>fs.writeFileSync('AGENTS.md','bad'));
      const child=require('node:child_process').spawnSync(process.execPath,['-e',
        'require("node:fs").writeFileSync("specs/tasks.md","bad")']);
      assert.notEqual(child.status,0);
    `)]});
    const result=await check({identity},control());assert.equal(result[0].outcome,'passed',JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(specsRoot,'tasks.md'),'utf8'),'host-owned');
    assert.equal(fs.readFileSync(path.join(cwd,'business.txt'),'utf8'),'allowed');
  }));
test('cancelled check dispatches nothing and hung check is unavailable',()=>fixture(async cwd=>{
  const check=createHostCheck({cwd,timeoutMs:50,commands:[hung('hang','setInterval(()=>{},1000)')]});
  const ac=new AbortController();ac.abort();await assert.rejects(check({identity},{signal:ac.signal}),{code:'cancelled'});
  const results=await check({identity},control());assert.equal(results[0].outcome,'unavailable');
  assert.equal(results[0].evidence,'host check: timeout');
}));

// This file belongs to the existing native-Codex test inventory. Optional tsx
// uses a caller-supplied existing CLI; no test installs dependencies.
async function ipcFixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ipc-native-'))),cwd=path.join(root,'code'),specsRoot=path.join(cwd,'specs');
  fs.mkdirSync(specsRoot,{recursive:true});fs.mkdirSync(path.join(cwd,'.claude'));
  for(const [name,value]of [['specs/tasks.md','host-owned'],['AGENTS.md','instructions'],['CLAUDE.md','instructions'],['.claude/rule.md','instructions']])fs.writeFileSync(path.join(cwd,name),value);
  try{return await run({root,cwd,specsRoot});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const ipcCommand=code=>command('ipc',code);
test('native protected IPC allows only owned AF_UNIX while specs, instructions, TCP and UDP remain denied',
  {skip:process.platform!=='darwin'},()=>ipcFixture(async({root,cwd,specsRoot})=>{
    const outsideSocket=path.join(root,'host.pipe'),unix=net.createServer(c=>c.end('forbidden')),tcp=net.createServer(c=>c.end('forbidden'));
    try{
      await new Promise((ok,no)=>{unix.once('error',no);unix.listen(outsideSocket,ok)});
      await new Promise((ok,no)=>{tcp.once('error',no);tcp.listen(0,'127.0.0.1',ok)});
    const code=`(async()=>{
      const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram'),path=require('node:path'),assert=require('node:assert/strict');
      const tmp=process.env.TMPDIR;fs.writeFileSync('private-tmp.txt',tmp);assert.equal(fs.statSync(tmp).mode&511,448);
      const socket=path.join(tmp,'fixture.pipe'),server=net.createServer(c=>c.end('IPC_OK'));
      await new Promise((ok,no)=>{server.once('error',no);server.listen(socket,ok)});
      const reply=await new Promise((ok,no)=>{const c=net.connect(socket);let s='';c.on('data',x=>s+=x);c.once('end',()=>ok(s));c.once('error',no)});
      assert.equal(reply,'IPC_OK');await new Promise(ok=>server.close(ok));
      const denied=fn=>assert.throws(fn,e=>['EPERM','EACCES','EROFS'].includes(e.code));
      for(const p of ['specs/tasks.md','specs/new.md','AGENTS.md','CLAUDE.md','.claude/rule.md'])denied(()=>fs.writeFileSync(p,'bad'));
      denied(()=>fs.renameSync('specs','moved-specs'));
      for(const target of [{path:path.resolve('outside-private.pipe')},{port:0,host:'127.0.0.1'}]){
        const s=net.createServer();const e=await new Promise(ok=>{s.once('error',ok);s.listen(target,()=>{s.close();ok(null)})});
        assert(e&&['EPERM','EACCES'].includes(e.code),'unscoped AF_UNIX/TCP listen was not refused');
      }
      for(const target of [${JSON.stringify(outsideSocket)},{port:${tcp.address().port},host:'127.0.0.1'}]){
        const c=net.connect(target);const e=await new Promise(ok=>{c.once('error',ok);c.once('connect',()=>ok(null))});c.destroy();
        assert(e&&['EPERM','EACCES'].includes(e.code),'outbound AF_UNIX/TCP connect was not refused');
      }
      const udp=dgram.createSocket('udp4');const e=await new Promise(ok=>{udp.once('error',ok);udp.bind(0,'127.0.0.1',()=>ok(null))});
      try{udp.close()}catch{}assert(e&&['EPERM','EACCES'].includes(e.code));
      console.log('tests 1');console.log('pass 1');
    })().catch(e=>{console.error(e);process.exitCode=1});`;
    const rows=await createProjectExecution({definition:{codeProject:cwd,specsDir:specsRoot,identity,scope:['private-tmp.txt']},
      protection:{checkCommands:[ipcCommand(code)],timeoutMs:15000}}).check({identity},control());
    assert.equal(rows[0].outcome,'passed',JSON.stringify(rows));assert.equal(rows[0].exitCode,0);
    const tmp=fs.readFileSync(path.join(cwd,'private-tmp.txt'),'utf8');assert(!fs.existsSync(tmp));
    assert.equal(fs.readFileSync(path.join(specsRoot,'tasks.md'),'utf8'),'host-owned');
    }finally{await Promise.all([unix,tcp].map(s=>s.listening?new Promise(ok=>s.close(ok)):Promise.resolve()));}
  }));
const tsx=process.env.CM_TEST_TSX_CLI;
for(const failed of [false,true])test(`native protected npm/tsx reaches real ${failed?'failing':'passing'} assertion and preserves exit`,
  {skip:process.platform!=='darwin'||!tsx},()=>ipcFixture(async({cwd,specsRoot})=>{
    assert(fs.statSync(tsx).isFile());fs.mkdirSync(path.join(cwd,'mobile'));
    fs.writeFileSync(path.join(cwd,'mobile/logic.ts'),`import assert from 'node:assert/strict';const n:number=2;assert.equal(n,${failed?3:2});console.log('TSX_REACHED');`);
    fs.writeFileSync(path.join(cwd,'mobile/package.json'),JSON.stringify({name:'cm-isolated-ipc',version:'1.0.0',scripts:{test:`${JSON.stringify(process.execPath)} ${JSON.stringify(tsx)} logic.ts`}}));
    const run=ipcCommand(`const fs=require('node:fs'),r=require('node:child_process').spawnSync('npm',['test'],{cwd:'mobile',encoding:'utf8'});fs.writeFileSync('tsx.log',(r.stdout??'')+(r.stderr??''));process.exit(r.status??99)`);
    const rows=await createProjectExecution({definition:{codeProject:cwd,specsDir:specsRoot,identity,scope:['mobile/logic.ts']},
      protection:{checkCommands:[run],timeoutMs:15000}}).check({identity},control());
    assert.equal(rows[0].outcome,failed?'failed':'passed');assert.equal(rows[0].exitCode,failed?1:0);
    const output=fs.readFileSync(path.join(cwd,'tsx.log'),'utf8');assert(!output.includes('listen EPERM'));
    assert(output.includes(failed?'AssertionError':'TSX_REACHED'),output);
  }));
