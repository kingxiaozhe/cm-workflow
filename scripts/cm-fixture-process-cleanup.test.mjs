// Guards for the test-only fixture process helper (2026-09-28: hung fake
// reviewers outlived their tests by 17+ hours).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fixtureProcesses,guardFixtureSource,killFixtureProcesses,ownerGuardSource} from './fixtures/process-cleanup.mjs';

const skip=process.platform==='win32';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
async function until(predicate,ms=4000){
  for(const deadline=Date.now()+ms;Date.now()<deadline;){if(predicate())return true;await new Promise(r=>setTimeout(r,25));}
  return predicate();
}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fixture-process-')));
  t.after(()=>{killFixtureProcesses(root);fs.rmSync(root,{recursive:true,force:true});});
  return root;
}
const hang="process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
function readPid(child){
  return new Promise((resolve,reject)=>{let out='';
    child.stdout.on('data',b=>{out+=b;const m=out.match(/^(\d+)\n/);if(m)resolve(Number(m[1]));});
    child.once('error',reject);child.once('close',code=>{if(!/^\d+\n/.test(out))reject(Error(`no pid: ${code}`));});});
}

test('a guarded detached fixture dies with the test process that created it, even when TERM-resistant',{skip},async t=>{
  const root=fixture(t),script=path.join(root,'hang.cjs');
  // The owner stands in for a test process: it spawns the fixture detached, as
  // the host under test does, then dies without any cleanup.
  const owner=spawn(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';
    import {ownerGuardSource} from ${JSON.stringify(new URL('./fixtures/process-cleanup.mjs',import.meta.url).href)};
    fs.writeFileSync(${JSON.stringify(script)},ownerGuardSource()+${JSON.stringify(hang)});
    const c=spawn(process.execPath,[${JSON.stringify(script)}],{detached:true,stdio:'ignore'});c.unref();
    process.stdout.write(c.pid+'\\n');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','inherit']});
  const pid=await readPid(owner);
  assert.equal(fixtureProcesses(root).map(row=>row.pid).includes(pid),true);
  await new Promise(r=>setTimeout(r,600));assert.equal(alive(pid),true,'guard must not stop a fixture while its owner lives');
  owner.kill('SIGKILL');
  assert.equal(await until(()=>!alive(pid)),true,`guarded fixture ${pid} outlived its owner`);
});

test('a guarded fixture stops at its lifetime ceiling while the owner lives',{skip},async t=>{
  const root=fixture(t),script=path.join(root,'hang.cjs');
  fs.writeFileSync(script,guardFixtureSource(`#!${process.execPath}\n${hang}`,{maxLifetimeMs:300}),{mode:0o700});
  assert(fs.readFileSync(script,'utf8').startsWith(`#!${process.execPath}\n;(()=>{`));
  const child=spawn(script,[],{stdio:'ignore'});
  const closed=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  assert.deepEqual(closed,{code:null,signal:'SIGKILL'});
  assert.throws(()=>ownerGuardSource({maxLifetimeMs:0}),/invalid_owner_guard/);
});

test('killFixtureProcesses removes a marked detached leader and its unmarked TERM-resistant descendant',{skip},async t=>{
  const root=fixture(t),script=path.join(root,'leader.cjs');
  fs.writeFileSync(script,`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(hang)}],{stdio:'ignore'});
process.stdout.write(c.pid+'\\n');${hang}`);
  const leader=spawn(process.execPath,[script],{detached:true,stdio:['ignore','pipe','ignore']});
  const descendant=await readPid(leader);
  assert.equal(fixtureProcesses(root).some(row=>row.pid===descendant),false,'descendant carries no marker');
  const killed=killFixtureProcesses(root);
  assert.deepEqual(killed.map(row=>row.pid),[leader.pid]);
  assert.equal(await until(()=>!alive(descendant)),true,'group kill must reach the descendant');
  assert.deepEqual(fixtureProcesses(root),[]);
  assert.throws(()=>fixtureProcesses('/tmp'),/invalid_fixture_marker/);
  assert.throws(()=>fixtureProcesses('relative/fixture-root'),/invalid_fixture_marker/);
});

test('an unrelated process that merely names the fixture root survives, as does this test group',{skip},async t=>{
  const root=fixture(t),log=path.join(root,'fixture.log');fs.writeFileSync(log,'');
  // Double-fork via sh so these are no descendants of this test, like a user's
  // own tail/grep of a fixture path or a node one-liner with the path as an argument.
  const detach=command=>new Promise((resolve,reject)=>{
    const sh=spawn('/bin/sh',['-c',`${command} >/dev/null 2>&1 </dev/null & echo $!`],{stdio:['ignore','pipe','ignore']});
    let out='';sh.stdout.on('data',b=>out+=b);sh.once('error',reject);sh.once('close',()=>resolve(Number(out.trim())));
  });
  const q=value=>`'${value}'`;
  const unrelated=[await detach(`/usr/bin/tail -f ${q(log)}`),
    await detach(`${q(process.execPath)} -e ${q('setTimeout(()=>{},30000)')} ${q(log)}`)];
  try{
    for(const pid of unrelated)assert(Number.isSafeInteger(pid)&&alive(pid));
    assert.equal(await until(()=>unrelated.every(pid=>fixtureProcesses(root).every(row=>row.pid!==pid)&&
      spawnSync('ps',['-o','ppid=','-p',String(pid)],{encoding:'utf8'}).stdout.trim()==='1')),true);
    assert.deepEqual(killFixtureProcesses(root),[]);
    await new Promise(r=>setTimeout(r,300));
    for(const pid of unrelated)assert.equal(alive(pid),true,`unrelated process ${pid} was killed`);
    // A descendant of this test that carries the root is still taken, without touching this test's group.
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',log],{stdio:'ignore'});
    await until(()=>fixtureProcesses(root).some(row=>row.pid===child.pid));
    assert.deepEqual(killFixtureProcesses(root).map(row=>row.pid),[child.pid]);
    assert.equal(alive(process.pid),true);
  }finally{for(const pid of unrelated)try{process.kill(pid,'SIGKILL');}catch{}}
});
