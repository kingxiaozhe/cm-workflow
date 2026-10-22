import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createFixFinalReview} from '../runtime/js/cm-fix/final-review.mjs';

const MARKER='CM_SNAPSHOT_REUSE',runtimeRoot=path.resolve(import.meta.dirname,'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clockKey=Symbol.for('CM_SNAPSHOT_REUSE_OWNED_VALIDATOR_COST');
function fixture(t,open=openExecutionStore){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-snapshot-reuse-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
 const identity={repositoryId:'fixture',runId:'snapshot-reuse',taskId:'T-FIX-snapshot',attempt:1};fs.writeFileSync(path.join(cwd,'repro.mjs'),"console.error('owned fixture');process.exit(1);\n");
 const config={hostContextId:'owned-snapshot-host',defect:'Snapshot reuse fixture only',reproduction:{cwd,command:[process.execPath,'repro.mjs'],expectedFailure:{exitCode:1,outputIncludes:'owned fixture'},timeoutMs:2000}};
 const owner=openFixExecution({specsRoot,identity,configuration:config,create:true},{});owner.close();
 const short={repositoryId:identity.repositoryId,runId:identity.runId},fingerprints=readExecutionSnapshot({specsRoot,identity:short}).fingerprints,options={specsRoot,identity:short,fingerprints,create:false};let store=open(options);
 const dir=path.join(specsRoot,'.reviews','.execution',identity.runId),state=path.join(dir,'state.json');
 t.after(()=>{store?.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,cwd,specsRoot,identity,dir,state,store:()=>store,close(){store.close();},reopen(){store.close();store=open(options);return store;},append(id,payload){const before=store.snapshot();return store.append({id,kind:'intent',payload,expectedRevision:before.revision});}};
}
function material(f){
 fs.writeFileSync(path.join(f.cwd,'sample.mjs'),'export const value=1;\n//'+'x'.repeat(360*1024));
 const baseline=captureReviewBaseline({root:f.cwd,identity:f.identity,scope:['sample.mjs'],requirements:['sample.mjs']});
 fs.writeFileSync(path.join(f.cwd,'sample.mjs'),'export const value=2;\n//'+'x'.repeat(360*1024));
 const checks=[{id:'owned-fixture',command:['synthetic-not-executed'],outcome:'passed',exitCode:0,evidence:'Canonical storage fixture only; no command or provider result'}],handoffPath=path.join(f.root,'fix-snapshot-T-FIX-snapshot-a1-handoff.json');
 createHostHandoff({root:f.cwd,baseline,checks,handoffPath,evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
 const pkg=createReviewPackage({root:f.cwd,baseline,checks,handoffPath});assert(Buffer.byteLength(JSON.stringify(pkg))>1024*1024,MARKER+': fixture must exercise the actual large-review codec');return pkg;
}
async function instrumentedStore(t){
 // Only the owned copied validator is instrumented. It still executes the real
 // decoder/validator/encoder. No cache branch, return or export is replaced.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-snapshot-clock-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const originalStore=path.join(runtimeRoot,'runtime/js/cm-ai/execution-store.mjs'),file=path.join(root,'execution-store.mjs'),before=fs.readFileSync(originalStore,'utf8'),needle='function validateState(raw,options) {';
 assert.equal(before.split(needle).length,2,MARKER+': exact private validator instrumentation point');
 fs.writeFileSync(file,before.replace(needle,needle+'\n  globalThis[Symbol.for("CM_SNAPSHOT_REUSE_OWNED_VALIDATOR_COST")]?.();').replace(/from '([.][^']+)'/g,(_match,specifier)=>"from '"+pathToFileURL(path.resolve(path.dirname(originalStore),specifier)).href+"'"));
 const module=await import(pathToFileURL(file));return {open:module.openExecutionStore,sourceSha256:hash(before)};
}
function poisonedAfter(f,mutate,accept){
 const original=fs.readFileSync(f.state);f.store().snapshot();mutate();
 assert.throws(()=>f.store().snapshot(),accept,MARKER+': cached data must not hide a current failure');
 fs.writeFileSync(f.state,original,{mode:0o600});assert.throws(()=>f.store().snapshot(),{code:'store_poisoned'},MARKER+': failure must poison even after exact bytes return');
}

test('CM_SNAPSHOT_REUSE: identical validated snapshots preserve a real final-review grant under controlled validation cost',async t=>{
 const instrumented=await instrumentedStore(t),f=fixture(t,instrumented.open),pkg=material(f);f.append('fix-retrospective-intent',pkg);f.store().snapshot();
 const physicalBefore=fs.readFileSync(f.state);assert(JSON.parse(physicalBefore).storageEncoding,MARKER+': large review must really be encoded');
 let now=1700000000000,costEnabled=false,passes=0,calls=0,registered=null,registrationCost=0,result,error;const originalNow=Date.now;
 globalThis[clockKey]=()=>{if(costEnabled){passes++;now+=2000;}};Date.now=()=>now;
 try{
  const configuration={hostContextId:'owned-snapshot-host',reviewer:{reviewerId:'final-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'owned-final-review',excludedThreadIds:[]}};
  const authority=createHostReviewAuthority({hostContextId:configuration.hostContextId,reviewerId:configuration.reviewer.reviewerId,adapterId:configuration.reviewer.adapterId,decide:async()=>({status:'approved'})});
  const signal=new AbortController().signal;await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},signal);
  const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:2000},{authorize:authority.authorize,run:async()=>{calls++;return {status:'failed',code:'owned_no_provider'};}});
  try{result=await review({signal,register(value){
   registered=value;assert.equal(value.grant.expiresAt-value.grant.issuedAt,60000);
   costEnabled=true;const start=now;
   try{for(let index=0;index<40;index++){const current=f.store().snapshot();assert.equal(current.records.at(-1).payload.packageDigest,pkg.packageDigest);}
    assert.deepEqual(fs.readFileSync(f.state),physicalBefore,MARKER+': read-only projection must not write');
    f.append('fix-final-registered',value);for(let index=0;index<4;index++)assert.equal(f.store().snapshot().records.at(-1).payload.request.requestDigest,value.request.requestDigest);
   }finally{registrationCost=now-start;costEnabled=false;}
  },onStarted(){assert.fail(MARKER+': no provider or real review thread may start');}});}catch(caught){error=caught;}
  assert.equal(error?.code,undefined,MARKER+': repeated validated snapshot cost expired the real grant ('+(error?.code??'none')+'), passes='+passes+', simulatedMs='+registrationCost);
  assert.equal(calls,1,MARKER+': the still-valid original grant must reach only the failed hard stub');assert(registered);assert.equal(result.completionEligible,false);assert.equal(result.value?.observation?.result?.status,'failed');assert(!['approved','changes_requested'].includes(result.inspection?.verdict));
  assert(registrationCost<60000,MARKER+': registration must retain the original authority lifetime');
  assert.equal(f.store().snapshot().records.at(-1).payload.request.requestDigest,registered.request.requestDigest);
  console.log(JSON.stringify({marker:MARKER,kind:'controlled-real-grant',sourceSha256:instrumented.sourceSha256,repeatedSnapshots:44,fullValidationPasses:passes,simulatedValidationMs:registrationCost,grantMs:60000,failedStubCalls:calls,providerCalls:0}));
 }finally{Date.now=originalNow;delete globalThis[clockKey];}
});

test('CM_SNAPSHOT_REUSE: append invalidates old logical contents and an idempotent append preserves physical old rows',t=>{
 const f=fixture(t),before=f.store().snapshot(),initialBytes=fs.readFileSync(f.state);for(let i=0;i<3;i++)assert.deepEqual(f.store().snapshot(),before);
 const first=f.append('owned-first',{note:'one'}),firstBytes=fs.readFileSync(f.state);assert.notDeepEqual(firstBytes,initialBytes);assert.notEqual(first.revision,before.revision);assert.equal(f.store().snapshot().records.at(-1).payload.note,'one');
 const after=f.append('owned-second',{note:'two'}),physical=JSON.parse(fs.readFileSync(f.state));assert.equal(after.records.length,first.records.length+1);assert.deepEqual(physical.records.slice(0,-1),JSON.parse(firstBytes).records);
 const saved=fs.readFileSync(f.state);const same=f.store().append({id:'owned-second',kind:'intent',payload:{note:'two'},expectedRevision:after.revision});assert.deepEqual(same,after);assert.deepEqual(fs.readFileSync(f.state),saved);
});

test('CM_SNAPSHOT_REUSE: different physical bytes and bad digest are never repaired by the cache and remain poisoned',t=>{
 for(const mode of ['digest','noncanonical']){const f=fixture(t);f.append('owned-payload',{note:'one'});poisonedAfter(f,()=>{const raw=JSON.parse(fs.readFileSync(f.state));if(mode==='digest')raw.revision='0'.repeat(64);fs.writeFileSync(f.state,JSON.stringify(raw)+'\n'+(mode==='noncanonical'?' ':''));},{code:'store_corrupt'});}
});

test('CM_SNAPSHOT_REUSE: cache hits still enforce permissions, unknown files, symlink, readiness and writer ownership',t=>{
 for(const mode of ['state-mode','unknown-file','state-symlink','readiness-mode','writer-inode','directory-mode']){
  const f=fixture(t);f.store().snapshot();let expected;
  if(mode==='state-mode'){fs.chmodSync(f.state,0o644);expected='store_permissions';}
  if(mode==='unknown-file'){fs.writeFileSync(path.join(f.dir,'unknown'),'owned');expected='store_unknown_file';}
  if(mode==='state-symlink'){const external=path.join(f.root,'saved-state');fs.renameSync(f.state,external);fs.symlinkSync(external,f.state);expected='unsupported_file';}
  if(mode==='readiness-mode'){fs.chmodSync(path.join(f.dir,'writer-ready.json'),0o644);expected='store_permissions';}
  if(mode==='writer-inode'){const writer=path.join(f.dir,'writer.sqlite'),old=path.join(f.root,'saved-writer');fs.renameSync(writer,old);fs.copyFileSync(old,writer);fs.chmodSync(writer,0o600);expected='store_ownership';}
  if(mode==='directory-mode'){fs.chmodSync(f.dir,0o755);expected='store_permissions';}
  assert.throws(()=>f.store().snapshot(),{code:expected},MARKER+': '+mode);assert.throws(()=>f.store().snapshot(),{code:'store_poisoned'},MARKER+': poison '+mode);
 }
});

test('CM_SNAPSHOT_REUSE: every cache hit really reads fresh bytes and rejects an inode swap during the read',t=>{
 const f=fixture(t);f.append('owned-payload',{note:'one'});const bytes=fs.readFileSync(f.state),replacement=path.join(f.root,'replacement');fs.writeFileSync(replacement,bytes,{mode:0o600});f.store().snapshot();
 const inode=fs.statSync(f.state),original=fs.readFileSync;let triggered=0;
 fs.readFileSync=function(file,...args){const match=typeof file==='number'&&fs.fstatSync(file).ino===inode.ino&&fs.fstatSync(file).dev===inode.dev,value=original.call(this,file,...args);if(match&&!triggered++){fs.renameSync(replacement,f.state);}return value;};
 try{assert.throws(()=>f.store().snapshot(),{code:'snapshot_changed'},MARKER+': current read must bind the same inode before and after');assert.equal(triggered,1);assert.throws(()=>f.store().snapshot(),{code:'store_poisoned'});}finally{fs.readFileSync=original;}
});

test('CM_SNAPSHOT_REUSE: returned snapshots cannot be changed by callers and close/reopen revalidates preserved state',t=>{
 const f=fixture(t);f.append('owned-data',{nested:{value:'retained'}});const a=f.store().snapshot(),bytes=fs.readFileSync(f.state),revision=a.revision;
 assert.throws(()=>{a.records.at(-1).payload.nested.value='changed';},TypeError);assert.throws(()=>a.records.push({}),TypeError);assert.throws(()=>{a.revision='0'.repeat(64);},TypeError);
 for(let i=0;i<3;i++){const b=f.store().snapshot();assert.equal(b.records.at(-1).payload.nested.value,'retained');assert.equal(b.revision,revision);}assert.deepEqual(fs.readFileSync(f.state),bytes);
 f.close();assert.throws(()=>f.store().snapshot(),{code:'store_closed'});f.reopen();assert.deepEqual(f.store().snapshot(),a);assert.deepEqual(fs.readFileSync(f.state),bytes);
});
