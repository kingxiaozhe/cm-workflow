import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {loadHandoff} from './cm-task-gate.mjs';
import {developerArgs} from '../runtime/js/cm-ai/worker-codex-developer.mjs';
const identity={repositoryId:'test',runId:'run',taskId:'T-001',attempt:1};
const control=()=>({signal:new AbortController().signal});
const command=(id,code)=>({id,command:[process.execPath,'-e',code]});
async function fixture(fn){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-')));
  try{await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

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
