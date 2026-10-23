// Every create probes the legacy shared writer (.reviews/.execution/writer.sqlite).
// Two creates started together in different processes used to fail one of them
// with store_busy. A briefly held legacy lock is now waited out; one that stays
// held still refuses, and that refused create leaves nothing behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {openExecutionStore,LEGACY_PROBE_ATTEMPTS,LEGACY_PROBE_DELAY_MS} from '../runtime/js/cm-ai/execution-store.mjs';

const hash=char=>char.repeat(64);
const fingerprints={workflow:hash('a'),config:hash('b'),inputs:hash('c')};

function legacyRoot(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-legacy-probe-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // A real store built by the current protocol, then placed where the legacy shared writer lives.
  const seed=openExecutionStore({specsRoot:root,identity:{repositoryId:'probe',runId:'seed-run-0001'},fingerprints,create:true});
  seed.close();
  const execution=path.join(root,'.reviews','.execution'),seedDir=path.join(execution,'seed-run-0001');
  for(const name of ['writer.sqlite','writer-ready.json'])fs.copyFileSync(path.join(seedDir,name),path.join(execution,name));
  return {root,legacy:path.join(execution,'writer.sqlite'),execution};
}

// Another process holds the legacy writer's write lock for holdMs, as a concurrent
// create's probe does; resolves once the lock is actually held.
function holdLegacy(t,legacy,holdMs){
  const child=spawn(process.execPath,['--no-warnings','-e',`
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1],{timeout:0});
    db.exec('BEGIN IMMEDIATE');process.stdout.write('held\\n');
    setTimeout(()=>{db.exec('ROLLBACK');db.close();process.stdout.write('released\\n');},Number(process.argv[2]));
  `,legacy,String(holdMs)],{stdio:['ignore','pipe','inherit']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';
  const held=new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('held'))resolve();});
    child.on('exit',code=>{if(!output.includes('held'))reject(new Error(`holder exited ${code}`));});
  });
  const exited=new Promise(resolve=>child.on('exit',()=>resolve(output)));
  return {held,exited};
}

test('a create waits out a legacy writer lock that another process holds briefly',async t=>{
  const f=legacyRoot(t);
  const holdMs=Math.floor(LEGACY_PROBE_ATTEMPTS*LEGACY_PROBE_DELAY_MS/4);
  const holder=holdLegacy(t,f.legacy,holdMs);await holder.held;
  const store=openExecutionStore({specsRoot:f.root,identity:{repositoryId:'probe',runId:'new-run-0001'},fingerprints,create:true});
  store.close();
  assert(fs.existsSync(path.join(f.execution,'new-run-0001','writer.sqlite')));
  assert.match(await holder.exited,/released/);
});

test('a legacy writer lock held past the retry budget still refuses with store_busy and creates nothing',async t=>{
  const f=legacyRoot(t);
  const holder=holdLegacy(t,f.legacy,LEGACY_PROBE_ATTEMPTS*LEGACY_PROBE_DELAY_MS*4);await holder.held;
  const started=Date.now();
  assert.throws(()=>openExecutionStore({specsRoot:f.root,identity:{repositoryId:'probe',runId:'new-run-0002'},fingerprints,create:true}),
    error=>error.code==='store_busy');
  // It retried for roughly its budget instead of failing on the first contention.
  assert(Date.now()-started>=(LEGACY_PROBE_ATTEMPTS-1)*LEGACY_PROBE_DELAY_MS*0.8);
  assert.equal(fs.existsSync(path.join(f.execution,'new-run-0002')),false);
});

test('an unreadable legacy writer is not retried and refuses at once',t=>{
  const f=legacyRoot(t);
  fs.writeFileSync(f.legacy,'not a sqlite database');
  const started=Date.now();
  assert.throws(()=>openExecutionStore({specsRoot:f.root,identity:{repositoryId:'probe',runId:'new-run-0003'},fingerprints,create:true}),
    error=>error.code==='store_busy');
  assert(Date.now()-started<LEGACY_PROBE_DELAY_MS*3);
  assert.equal(fs.existsSync(path.join(f.execution,'new-run-0003')),false);
});
