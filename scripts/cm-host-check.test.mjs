import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {loadHandoff,checkN4,checkN5} from './cm-task-gate.mjs';
import {developerArgs} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1};
const control=()=>({signal:new AbortController().signal});
const command=(id,code)=>({id,command:[process.execPath,'-e',code]});
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
  const check=createHostCheck({cwd,commands:[command('capture',
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
    command('security',scenario.name==='timeout'?'setInterval(()=>{},1000)':
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
  const check=createHostCheck({cwd,timeoutMs:50,commands:[command('hang','setInterval(()=>{},1000)')]});
  const ac=new AbortController();ac.abort();await assert.rejects(check({identity},{signal:ac.signal}),{code:'cancelled'});
  const results=await check({identity},control());assert.equal(results[0].outcome,'unavailable');
  assert.equal(results[0].evidence,'host check: timeout');
}));
