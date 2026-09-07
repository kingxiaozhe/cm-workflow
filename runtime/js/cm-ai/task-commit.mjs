// Fixture-only transaction primitive. Not a provider bridge or runner-v1 adapter.
import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { types } from 'node:util';
import {createRequire} from 'node:module';
import { verifyReviewPackage } from './review-package.mjs';
import { checkCompletion } from './gate-bridge.mjs';
import { need,shape,json,digest,validIdentity } from './effect-contract.mjs';
import {planBytes,readCommitIntent,readCommitResult} from './task-commit-codec.mjs';
import {resolveFixtureCommit} from './task-runner.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {prepareMarkDone,verifyMarkDonePlan} from '../../../scripts/cm-task-gate.mjs';

const requireNative=createRequire(import.meta.url);
const taskOwnerTarget=store=>requireNative('./task-owner.mjs').taskOwnerTarget(store);

const MiB=1024*1024,FILE_LIMIT=256*1024;
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const signalPrototype=AbortSignal.prototype;
const signalSlots=Object.getOwnPropertySymbols(new AbortController().signal);
const sha=b=>createHash('sha256').update(b).digest('hex');
const equal=(a,b)=>digest(a)===digest(b);
const mode=s=>Number(s.mode&0o7777n);
const statFields=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String);
const sameStat=(a,b)=>statFields(a).join(':')===statFields(b).join(':');
const sameInode=(a,b)=>a.dev===b.dev && a.ino===b.ino;
function pathString(p) {need(typeof p==='string' && !p.includes('\0') && path.isAbsolute(p) && path.resolve(p)===p,'unsupported_path');}
function canonicalPath(p) {pathString(p);need(fs.realpathSync(p)===p,'unsupported_path');return p;}
function disjoint(a,b) {need(a!==b && !a.startsWith(b+path.sep) && !b.startsWith(a+path.sep),'overlapping_roots');}
function cancellation(signal) {
  let value=false;
  if(signal!==undefined)try{
    // Node's native getter reads symbol properties; it is not a callback-free
    // brand check. Reject proxies before reflection, and require own data slots
    // on every read so neither accessors nor prototype lookup can run caller code.
    need(signal!==null && typeof signal==='object' && !types.isProxy(signal)
      && Object.getPrototypeOf(signal)===signalPrototype,'invalid_input');
    const keys=Reflect.ownKeys(signal);need(keys.length<=64,'invalid_input');
    for(const key of keys)need(Object.hasOwn(Object.getOwnPropertyDescriptor(signal,key),'value'),'invalid_input');
    for(const key of signalSlots)need(Object.hasOwn(signal,key),'invalid_input');
    value=aborted.call(signal);
  }catch{need(false,'invalid_input');}
  need(!value,'cancelled');
}
function parentRevision(p) {
  canonicalPath(p);const s=fs.lstatSync(p,{bigint:true});need(s.isDirectory() && !s.isSymbolicLink(),'unsupported_path');
  return {path:p,dev:String(s.dev),ino:String(s.ino),mode:mode(s)};
}
function readFile(p) {
  let fd;
  try {
    const before=fs.lstatSync(p,{bigint:true});
    need(before.isFile() && !before.isSymbolicLink() && before.nlink===1n,'unsupported_file');
    need(before.size<=BigInt(FILE_LIMIT),'limit_exceeded');
    fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    need(sameStat(before,fs.fstatSync(fd,{bigint:true})),'snapshot_changed');
    const data=Buffer.alloc(Number(before.size)+1);let size=0;
    while(size<data.length){const n=fs.readSync(fd,data,size,data.length-size,size);if(!n)break;size+=n;}
    need(size===Number(before.size) && sameStat(before,fs.fstatSync(fd,{bigint:true}))
      && sameStat(before,fs.lstatSync(p,{bigint:true})),'snapshot_changed');
    return {bytes:data.subarray(0,size),stat:before};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function nativeRevision(p,f) {return digest({path:p,stat:statFields(f.stat),sha256:sha(f.bytes)});}
function completionSelectors(selectors,identity){return {...selectors,task:identity.taskId};}
function verifyProof(v) {
  verifyReviewPackage({root:v.root,baseline:v.baseline,checks:v.checks,reviewPackage:v.reviewPackage,expectedDigest:v.reviewPackage.packageDigest});
  checkCompletion({receipt:v.receipt,registered:v.registered,execution:v.execution,reviewPackage:v.reviewPackage,identity:v.identity});
}
function ownerMatch(store,owner,initial,revision) {
  need(equal(taskOwnerTarget(store),owner),'task_owner_mismatch');const s=store.snapshot();
  need(equal(s.identity,initial.identity) && equal(s.fingerprints,initial.fingerprints),'identity_mismatch');
  need(s.revision===revision,'commit_store_changed');return s;
}
function boundedRecord(record) {need(Buffer.byteLength(JSON.stringify(record))<=MiB,'limit_exceeded');}
function append(store,current,id,kind,payload) {
  const data={version:1,seq:current.records.length+1,id,kind,payload,previousDigest:current.records.at(-1)?.digest??null};
  const record={...data,digest:digest(data)};boundedRecord(record);
  store.append({id,kind,payload,expectedRevision:current.revision});const saved=store.snapshot();
  need(saved.records.length===current.records.length+1 && equal(saved.records.at(-1),record),'commit_store_changed');return saved;
}
function history(store,owner) {
  const s=store.snapshot();need(s.records.length>0,'commit_missing');need(s.records.length<=2,'commit_history_invalid');
  for(const r of s.records)boundedRecord(r);
  const r=s.records[0],p=r.payload;
  need(r.id==='task-commit.intent' && r.kind==='commit-intent','commit_history_invalid');
  readCommitIntent(p,{owner,identity:{...s.identity,taskId:p.identity?.taskId,attempt:p.identity?.attempt},fingerprints:s.fingerprints});
  if(s.records.length===2){const last=s.records[1];
    need(last.id==='task-commit.result' && last.kind==='commit-result','commit_history_invalid');
    readCommitResult(last.payload,{intentDigest:r.digest,planDigest:p.plan.planDigest});}
  return {s,p,intentDigest:r.digest};
}
export function commitFixtureTask(store,input,signal) {
  const owner=taskOwnerTarget(store),initial=store.snapshot();need(initial.records.length===0,'commit_records_present');
  let current=initial;
  return commitCore(input,signal,owner,initial,
    ()=>ownerMatch(store,owner,initial,current.revision),
    payload=>{current=append(store,current,'task-commit.intent','commit-intent',payload);return current.records.at(-1).digest;},
    payload=>{current=append(store,current,'task-commit.result','commit-result',payload);});
}
// Internal native entry. Only the live runner can issue the opaque capability.
export function commitRunnerFixture(token,store,input,signal) {
  const binding=resolveFixtureCommit(token,store,'guard');
  need(arguments.length===4 && binding.phase==='prepared','commit_phase_invalid');
  const v=json(input,16*MiB);need(digest(v)===binding.inputDigest,'commit_input_mismatch');
  const initial={identity:{repositoryId:binding.identity.repositoryId,runId:binding.identity.runId},fingerprints:binding.fingerprints};
  return commitCore(v,signal,binding.owner,initial,
    ()=>resolveFixtureCommit(token,store,'guard'),
    payload=>resolveFixtureCommit(token,store,'append-intent',payload).intentDigest,
    payload=>resolveFixtureCommit(token,store,'append-result',payload));
}
// Closures below are constructed only by the two fixed wrappers, never supplied
// by a public host option. The composed wrapper owns no second mutable revision.
function commitCore(input,signal,owner,initial,guard,appendIntent,appendResult) {
  cancellation(signal);const v=json(input,16*MiB);
  shape(v,['selectors','root','identity','baseline','reviewPackage','checks','receipt','registered','execution']);
  shape(v.selectors,['handoff','reviewsDir','tasksPath','feature']);validIdentity(v.identity);
  need(equal(initial.identity,{repositoryId:v.identity.repositoryId,runId:v.identity.runId}),'identity_mismatch');
  const selectors=v.selectors;
  need(selectors.tasksPath===owner.tasksPath && selectors.feature===owner.feature,'task_owner_mismatch');
  for(const p of [v.root,selectors.tasksPath,selectors.reviewsDir,selectors.handoff])canonicalPath(p);
  need([path.join(owner.specsRoot,'.reviews'),path.join(path.dirname(owner.tasksPath),'.reviews')].includes(selectors.reviewsDir)
    && path.dirname(selectors.handoff)===selectors.reviewsDir,'unsupported_path');
  disjoint(v.root,owner.specsRoot);const parent=parentRevision(path.dirname(owner.tasksPath));
  let plan;
  try{plan=json(prepareMarkDone(completionSelectors(selectors,v.identity)),MiB);}
  catch{need(false,'preparation_failed');}
  const {after}=planBytes(plan);
  need(plan.tasksPath===owner.tasksPath && plan.feature===owner.feature && plan.taskId===v.identity.taskId
    && plan.attempt===v.identity.attempt,'identity_mismatch');verifyProof(v);cancellation(signal);
  guard();need(equal(parentRevision(parent.path),parent),'snapshot_changed');
  const payload={version:1,protocol:'cm-task-commit',type:'intent',identity:v.identity,owner,
    fingerprints:initial.fingerprints,plan,proof:{root:v.root,baselineDigest:v.baseline.baselineDigest,
      packageDigest:v.reviewPackage.packageDigest,receiptDigest:v.receipt.receiptDigest,checksDigest:v.reviewPackage.checksDigest},
    parent,temporaryName:`.cm-task.${randomUUID()}.tmp`};
  const temporary=path.join(parent.path,payload.temporaryName);let fd;
  try {
    const intentDigest=appendIntent(payload);
    guard();need(equal(parentRevision(parent.path),parent),'snapshot_changed');cancellation(signal);
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    const created=fs.fstatSync(fd,{bigint:true});
    const checkTemp=()=>{const f=readFile(temporary);need(sameInode(f.stat,created) && mode(f.stat)===plan.mode
      && f.bytes.equals(after) && sha(f.bytes)===plan.afterDigest,'temporary_changed');return f;};
    fs.writeFileSync(fd,after);fs.fchmodSync(fd,plan.mode);fs.fsyncSync(fd);
    const synced=checkTemp();need(sameStat(synced.stat,fs.fstatSync(fd,{bigint:true})),'temporary_changed');
    fs.closeSync(fd);fd=undefined;
    let verified;
    try{verified=verifyMarkDonePlan(completionSelectors(selectors,v.identity),plan.planDigest);}
    catch{need(false,'preparation_failed');}
    shape(verified,['outcome','planDigest']);need(verified.outcome==='matched' && verified.planDigest===plan.planDigest,'invalid_plan');
    verifyProof(v);guard();
    need(equal(parentRevision(parent.path),parent),'snapshot_changed');
    for(const e of plan.evidence)need(nativeRevision(e.path,readFile(e.path))===e.revision,'snapshot_changed');
    need(nativeRevision(owner.tasksPath,readFile(owner.tasksPath))===plan.taskRevision,'snapshot_changed');
    checkTemp();cancellation(signal);fs.renameSync(temporary,owner.tasksPath);
    const dir=fs.openSync(parent.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const opened=fs.fstatSync(dir,{bigint:true});
      need(equal({path:parent.path,dev:String(opened.dev),ino:String(opened.ino),mode:mode(opened)},parent)
        && equal(parentRevision(parent.path),parent),'snapshot_changed');fs.fsyncSync(dir);
    }finally{fs.closeSync(dir);}
    guard();
    appendResult({version:1,protocol:'cm-task-commit',type:'result',
      intentDigest,planDigest:plan.planDigest,outcome:'fixture_committed'});
    return json({outcome:'fixture_committed',intentDigest,planDigest:plan.planDigest});
  }catch{need(false,'commit_unknown');}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{/* Retain unknown; never compensate task bytes. */}}
}
function observeImage(owner,p) {
  const {before,after}=planBytes(p.plan);let observation='conflict';
  try {
    need(equal(parentRevision(p.parent.path),p.parent),'snapshot_changed');const f=readFile(owner.tasksPath);
    need(equal(parentRevision(p.parent.path),p.parent),'snapshot_changed');
    if(mode(f.stat)===p.plan.mode){if(f.bytes.equals(before))observation='observed_before';else if(f.bytes.equals(after))observation='observed_after';}
  }catch{/* Unsafe/missing/changed target is observation conflict, not write authority. */}
  return observation;
}
export function observeFixtureCommit(store) {
  const owner=taskOwnerTarget(store);let h;
  try{h=history(store,owner);}catch(error){if(error.code==='commit_missing')throw error;need(false,'commit_history_invalid');}
  const {s,p,intentDigest}=h,observation=observeImage(owner,p);
  ownerMatch(store,owner,s,s.revision);
  return json({observation,recordedOutcome:s.records.length===2?'fixture_committed':null,intentDigest,planDigest:p.plan.planDigest});
}
export function observeRunnerFixture(store) {
  const owner=taskOwnerTarget(store);need(arguments.length===1);
  const s=store.snapshot();need(s.records.length>0,'runner_missing');let config,parsed;
  try{
    config=json(s.records[0].payload.config,16*MiB);
    need(equal({repositoryId:config.identity.repositoryId,runId:config.identity.runId},s.identity)
      &&equal(config.completion.owner,owner)&&equal(config.completion.fingerprints,s.fingerprints),'identity_mismatch');
    parsed=readRunnerHistory(s.records,config,2);
  }catch{need(false,'runner_history_invalid');}
  const transaction=parsed.transaction;
  const observedImage=transaction?observeImage(owner,transaction.intentRecord.payload.commit):'not_observed';
  ownerMatch(store,owner,s,s.revision);
  return json({version:1,protocol:'cm-runner-observation',identity:{...config.identity,attempt:parsed.state.attempt},
    observedImage,recordedNativeOutcome:transaction?.resultRecord?'fixture_committed':null,
    recordedRunnerState:parsed.state.state,recordedRunnerCode:parsed.state.code,taskCommit:parsed.state.taskCommit});
}
