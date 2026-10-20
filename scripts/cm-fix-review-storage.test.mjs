import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openExecutionStore,appendFits} from '../runtime/js/cm-ai/execution-store.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {captureReviewBaseline,createReviewPackage,readReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import * as presentation from '../runtime/js/cm-ai/review-presentation.mjs';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';

const MiB=1024*1024,STATE_LIMIT=16*MiB,workflow='cm-fix-stages-v1';
const copy=value=>JSON.parse(JSON.stringify(value));
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const isolated=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-storage-home-')));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(isolated,{recursive:true,force:true});});

function fixture(t,{mode=workflow}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-review-storage-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'repro.mjs'),"console.error('synthetic fixture');process.exit(1);\n");
  const identity={repositoryId:'synthetic',runId:'review-storage',taskId:'T-FIX-storage',attempt:1};
  let store;
  t.after(()=>{store?.close();fs.rmSync(root,{recursive:true,force:true});});
  let fingerprints;
  if(mode===workflow){
    // Obtain a genuine, validated first configuration record; never advance it.
    const configuration={hostContextId:'storage-fixture-host',defect:'Synthetic storage regression only',
      reproduction:{cwd,command:[process.execPath,'repro.mjs'],expectedFailure:{exitCode:1,outputIncludes:'synthetic fixture'},timeoutMs:2000}};
    const owner=openFixExecution({specsRoot,identity,configuration,create:true},{});owner.close();
    fingerprints=readExecutionSnapshot({specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId}}).fingerprints;
  }else{
    fingerprints={workflow:digest(mode),config:digest('synthetic configuration'),inputs:digest(identity)};
    const initial=openExecutionStore({specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId},fingerprints,create:true});
    initial.append({id:mode==='wrong-fingerprint'?'fix-configuration':'configuration',kind:'intent',
      payload:{workflow:mode==='wrong-fingerprint'?workflow:mode,identity,configuration:{}},expectedRevision:initial.snapshot().revision});initial.close();
  }
  const shortIdentity={repositoryId:identity.repositoryId,runId:identity.runId},options={specsRoot,identity:shortIdentity,fingerprints,create:false};
  store=openExecutionStore(options);
  const stateFile=path.join(specsRoot,'.reviews/.execution',identity.runId,'state.json');
  return {root,cwd,specsRoot,identity,shortIdentity,options,stateFile,store:()=>store,
    close(){store.close();},reopen(){store.close();store=openExecutionStore(options);return store;},
    readonly:()=>readExecutionSnapshot({specsRoot,identity:shortIdentity})};
}
function material(f,size=360*1024,format='utf8'){
  const prefix='export const value=1;\n//';
  const before=Buffer.from(prefix+'x'.repeat(size-Buffer.byteLength(prefix)-1)+'\n');
  if(format==='bom')Buffer.from([0xef,0xbb,0xbf]).copy(before);
  if(format==='binary')before.fill(0xff);
  const after=Buffer.from(before);after[format==='binary'?0:prefix.indexOf('1')]=format==='binary'?0xfe:0x32;
  fs.writeFileSync(path.join(f.cwd,'sample.mjs'),before);
  const baseline=captureReviewBaseline({root:f.cwd,identity:f.identity,scope:['sample.mjs'],requirements:['sample.mjs']});
  fs.writeFileSync(path.join(f.cwd,'sample.mjs'),after);
  const reviewPackage=createReviewPackage({root:f.cwd,baseline,checks:[{id:'synthetic',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Synthetic fixture, not a provider observation'}]});
  assert.deepEqual(readReviewPackage(reviewPackage),reviewPackage);
  assert.equal(reviewPackage.changes[0].before.size,size);assert.equal(reviewPackage.changes[0].after.size,size);
  assert.equal(reviewPackage.requirements[0].contentBase64,reviewPackage.changes[0].after.contentBase64);
  return {baseline,reviewPackage};
}
// Synthetic storage envelopes match the durable owner shape. These fixture
// grants are data only; no reviewer is invoked and no approval is claimed.
function registration(reviewPackage,priorReview=null){
  const request=requestFor({invocationId:'fix-final.synthetic-storage',identity:reviewPackage.identity,role:'reviewer',provider:'codex',
    requestedModel:'synthetic',contextId:'synthetic-storage-context',payload:{reviewPackage,priorReview}});
  return {request,authorizationAt:1000,registeredAt:1000,grant:{synthetic:true}};
}
function writeback(reviewPackage){return {writeback:{identity:reviewPackage.identity,learningDigest:digest('synthetic learning'),
  retrospectiveDigest:digest('synthetic retrospective'),packageDigest:reviewPackage.packageDigest,outcome:'written',changed:true,
  agentsFile:{scope:'project',path:'AGENTS.md',sha256:digest('synthetic instructions')},reason:null,completionEligible:false},reviewPackage};}
const entry=(f,id,payload,kind='intent')=>({id,kind,payload,expectedRevision:f.store().snapshot().revision});
function assertChain(snapshot){
  let previous=null;
  snapshot.records.forEach((record,index)=>{const {digest:checksum,...body}=record;assert.equal(record.seq,index+1);assert.equal(record.previousDigest,previous);assert.equal(digest(body),checksum);previous=checksum;});
  const {revision,...body}=snapshot;assert.equal(digest(body),revision);
}
function rejectAppend(f,id,payload){
  const input=entry(f,id,payload),before=fs.readFileSync(f.stateFile);
  const fits=appendFits(f.store().snapshot(),input);
  assert.throws(()=>f.store().append(input));assert.equal(fits,false);assert.deepEqual(fs.readFileSync(f.stateFile),before);
}
function codec(){
  assert.equal(typeof presentation.packFixJournalPayload,'function','CM_FIX_REVIEW_STORAGE: the bounded CM-fix storage codec must exist');
  assert.equal(typeof presentation.unpackFixJournalPayload,'function','CM_FIX_REVIEW_STORAGE: stored CM-fix evidence must have a real decoder');
  return {pack:presentation.packFixJournalPayload,unpack:presentation.unpackFixJournalPayload};
}

test('a real CM-fix journal stores a repeated canonical review larger than one MiB and preserves exact evidence on reopen',t=>{
  const f=fixture(t),{reviewPackage}=material(f),old=copy(f.store().snapshot());
  assert.equal(old.records[0].id,'fix-configuration');assert.equal(old.records[0].kind,'intent');assert.equal(old.records[0].payload.workflow,workflow);
  const oldPhysical=JSON.parse(fs.readFileSync(f.stateFile,'utf8')),rootPayload=reviewPackage;
  assert(bytes(rootPayload)>MiB);let next;
  const first=entry(f,'fix-retrospective-intent',rootPayload);
  assert.doesNotThrow(()=>{next=f.store().append(first);},'CM_FIX_REVIEW_STORAGE: a real append must admit losslessly deduplicated canonical review evidence above one MiB');
  assert.equal(appendFits(old,first),true);assert.deepEqual(next.records.at(-1).payload,rootPayload);assertChain(next);
  const physical=JSON.parse(fs.readFileSync(f.stateFile,'utf8'));
  assert.deepEqual(physical.records[0],oldPhysical.records[0]);assert(bytes(physical.records[1].payload)<=MiB);
  assert.notDeepEqual(physical.records[1].payload,rootPayload);
  for(const [id,payload] of [
    ['fix-final-review-registered',registration(reviewPackage)],
    ['fix-revision-prepared',{synthetic:'small revision metadata',priorPackageDigest:reviewPackage.packageDigest,nextIdentity:{...f.identity,attempt:2}}],
    ['fix-revision-retrospective-intent',reviewPackage],
    ['fix-revision-final-review-registered',registration(reviewPackage)],
    ['fix-learning-writeback-result',writeback(reviewPackage)],
  ]){
    const input=entry(f,id,payload);assert.equal(appendFits(f.store().snapshot(),input),true);
    next=f.store().append(input);assert.deepEqual(next.records.at(-1).payload,payload);assertChain(next);
  }
  const logical=copy(next),disk=fs.readFileSync(f.stateFile);
  assert.deepEqual(f.readonly(),logical);assert.deepEqual(fs.readFileSync(f.stateFile),disk);
  assert.deepEqual(f.reopen().snapshot(),logical);
  assert.deepEqual(f.store().append(first),logical);assert.deepEqual(fs.readFileSync(f.stateFile),disk);
  const oldRows=JSON.parse(fs.readFileSync(f.stateFile,'utf8')).records;
  const small=entry(f,'small-after-packed',{ok:true},'result');next=f.store().append(small);assertChain(next);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).records.slice(0,-1)),JSON.stringify(oldRows));
  assert.deepEqual(f.readonly(),next);assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).records.at(-1),next.records.at(-1));
  const prepared=next.records.find(row=>row.id==='fix-revision-prepared');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).records[prepared.seq-1],prepared);
});

test('ordinary large data, non-fix workflows and false workflow fingerprints retain the one MiB limit',t=>{
  const f=fixture(t);rejectAppend(f,'large-ordinary',{ordinary:'x'.repeat(MiB)});
  const {reviewPackage}=material(f,64);rejectAppend(f,'small-package-large-ordinary',{reviewPackage,ordinary:'x'.repeat(MiB)});
  rejectAppend(f,'arbitrary-nested-review',{arbitrary:{reviewPackage:material(f).reviewPackage}});
  for(const mode of ['cm-ai-stages-v1','cm-ai-batch-v1','wrong-fingerprint']){
    const other=fixture(t,{mode}),large=material(other).reviewPackage;
    rejectAppend(other,'large-review',{reviewPackage:large});
  }
});

test('a package that still exceeds the encoded limit or the expanded payload budget cannot be appended',t=>{
  const f=fixture(t),{reviewPackage}=material(f,600*1024);
  rejectAppend(f,'encoded-too-large',reviewPackage);
  const smaller=material(f).reviewPackage;
  const oversized=copy(registration(smaller));oversized.request.payload.priorReview={ordinary:'x'.repeat(10*MiB)};
  const {requestDigest,...requestBody}=oversized.request;oversized.request.requestDigest=digest(requestBody);
  rejectAppend(f,'logical-too-large',oversized);
});

test('a small valid review cannot authorize deduplication of repeated ordinary base64 or string metadata',t=>{
  const f=fixture(t),{reviewPackage}=material(f,64),ordinary=Buffer.from('z'.repeat(600*1024)).toString('base64');
  rejectAppend(f,'ordinary-base64-smuggling',registration(reviewPackage,{synthetic:'not valid final feedback; storage boundary only',ordinary:[{contentBase64:ordinary},{contentBase64:ordinary}]}));
  rejectAppend(f,'ordinary-string-smuggling',registration(reviewPackage,{synthetic:'not valid final feedback; storage boundary only',ordinary:[ordinary,ordinary]}));
});

test('the codec preserves small marker-looking data and rejects invalid canonical review evidence',t=>{
  const f=fixture(t),{pack,unpack}=codec(),{reviewPackage}=material(f);
  const collision={version:1,kind:'cm-fix-journal-review-payload',logicalBytes:1,logicalDigest:'a'.repeat(64),data:'ordinary old scalar'};
  assert.deepEqual(pack(collision,{workflow}),collision);
  f.store().append(entry(f,'old-wrapper-lookalike',collision));assert.deepEqual(f.reopen().snapshot().records.at(-1).payload,collision);
  for(const mutate of [p=>{p.extra=true;},p=>{p.packageDigest='0'.repeat(64);},p=>{p.changes[0].after.sha256='0'.repeat(64);},p=>{p.requirements[0].contentBase64+='!';}]){
    const bad=copy(reviewPackage);mutate(bad);rejectAppend(f,'bad-canonical-review',bad);
  }
  const logical=reviewPackage;f.store().append(entry(f,'large-after-old-collision',logical));
  assert.deepEqual(f.reopen().snapshot().records.find(row=>row.id==='old-wrapper-lookalike').payload,collision);
  const encoded=pack(logical,{workflow});
  assert(bytes(encoded)<=MiB);assert.deepEqual(unpack(encoded,{workflow}),logical);
  assert.equal(digest(unpack(encoded,{workflow})),digest(logical));
  for(const format of ['bom','binary']){const pkg=material(f,360*1024,format).reviewPackage;
    f.store().append(entry(f,'lossless-'+format,pkg));assert.deepEqual(f.reopen().snapshot().records.at(-1).payload,pkg);
  }
});

test('read-only and writer replay reject malformed physical wrappers, references and expansion without changing state',t=>{
  const f=fixture(t),{reviewPackage}=material(f);codec();
  f.store().append(entry(f,'large-review',registration(reviewPackage)));
  const logical=copy(f.store().snapshot()),valid=fs.readFileSync(f.stateFile),physical=JSON.parse(valid);
  assert.deepEqual(physical.storageEncoding.records,[2]);f.close();
  const wrapper=s=>s.records[1].payload;
  const firstRef=s=>Object.keys(wrapper(s).data.contents)[0];
  const content=s=>wrapper(s).data.contents[firstRef(s)];
  const edits=[
    ['unmarked oversized legacy payload',s=>{delete s.storageEncoding;s.records[1].payload=copy(logical.records[1].payload);}],
    ['extra wrapper field',s=>{wrapper(s).extra=true;}],
    ['extra presentation field',s=>{wrapper(s).data.presentation.extra=true;}],
    ['extra content field',s=>{content(s).extra=true;}],
    ['bad declared digest',s=>{wrapper(s).logicalDigest='0'.repeat(64);}],
    ['bad content hash',s=>{content(s).sha256='0'.repeat(64);}],
    ['foreign package binding',s=>{wrapper(s).data.presentation.packageDigest='f'.repeat(64);}],
    ['foreign reference',s=>{wrapper(s).data.payload.request.payload.reviewPackage.changes[0].after.contentRef='foreign';}],
    ['orphan reference table entry',s=>{wrapper(s).data.contents.orphan=copy(content(s));}],
    ['unknown content encoding',s=>{content(s).encoding='future-encoding';}],
    ['metadata reference',s=>{wrapper(s).data.payload.request.payload.priorReview={contentRef:firstRef(s)};}],
    ['expanded byte bomb',s=>{const p=wrapper(s).data.payload;p.request.payload.priorReview=Array.from({length:40},()=>copy(p.request.payload.reviewPackage));}],
    ['declared expanded overflow',s=>{wrapper(s).logicalBytes=10*MiB+1;}],
    ['scalar marked wrapper',s=>{s.records[1].payload='ordinary scalar cannot be an encoded row';}],
    ['unknown wrapper kind',s=>{wrapper(s).kind='cm-fix-journal-review-payload-v999';}],
    ['unknown state encoding',s=>{s.storageEncoding.kind='cm-fix-review-payloads-v999';}],
    ['duplicate marked sequence',s=>{s.storageEncoding.records=[2,2];}],
    ['ordinary configuration marked as encoded',s=>{s.storageEncoding.records=[1,2];}],
  ];
  for(const [label,mutate] of edits){
    const bad=copy(physical);mutate(bad);fs.writeFileSync(f.stateFile,JSON.stringify(bad)+'\n');
    const before=fs.readFileSync(f.stateFile),names=fs.readdirSync(path.dirname(f.stateFile));
    assert.throws(()=>f.readonly(),undefined,label);assert.deepEqual(fs.readFileSync(f.stateFile),before,label);
    assert.throws(()=>{let opened;try{opened=openExecutionStore(f.options);}finally{opened?.close();}},undefined,label);
    assert.deepEqual(fs.readFileSync(f.stateFile),before,label);assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)),names,label);
  }
  fs.writeFileSync(f.stateFile,valid);assert.deepEqual(f.reopen().snapshot(),logical);
});

test('the whole-state limit applies to expanded logical evidence even when the physical journal is smaller',t=>{
  const f=fixture(t),{reviewPackage}=material(f);codec();
  f.store().append(entry(f,'large-review',registration(reviewPackage)));
  let logical=copy(f.store().snapshot());const physical=JSON.parse(fs.readFileSync(f.stateFile));f.close();
  const add=payload=>{
    const body={version:1,seq:logical.records.length+1,id:'filler-'+logical.records.length,kind:'result',payload,
      previousDigest:logical.records.at(-1).digest};
    const record={...body,digest:digest(body)};logical.records.push(record);physical.records.push(copy(record));
  };
  // Seed one bounded historical image directly instead of cumulatively writing
  // hundreds of MiB through repeated near-limit appends.
  while(bytes(logical)+900*1024<STATE_LIMIT-4096)add({ordinary:'f'.repeat(900*1024)});
  add({ordinary:''});const finalIndex=logical.records.length-1;
  logical.records[finalIndex].payload.ordinary='f'.repeat(STATE_LIMIT-512-bytes(logical));
  const {digest:ignored,...last}=logical.records[finalIndex];logical.records[finalIndex].digest=digest(last);
  physical.records[finalIndex]=copy(logical.records[finalIndex]);
  const seal=()=>{const {revision,...body}=logical;logical.revision=digest(body);physical.revision=logical.revision;};seal();
  assert.equal(bytes(logical),STATE_LIMIT-512);assert(bytes(physical)<bytes(logical));
  fs.writeFileSync(f.stateFile,JSON.stringify(physical)+'\n');
  assert.deepEqual(f.reopen().snapshot(),logical);assert.deepEqual(f.readonly(),logical);assertChain(logical);
  const tooLarge=entry(f,'overflow-next',{ordinary:'x'.repeat(1024)},'result'),before=fs.readFileSync(f.stateFile);
  assert.equal(appendFits(logical,tooLarge),false);assert.throws(()=>f.store().append(tooLarge));assert.deepEqual(fs.readFileSync(f.stateFile),before);
  // A forged but logically self-consistent over-budget image must also fail
  // public read-only discovery and writer reopen before any rewrite occurs.
  f.close();add(tooLarge.payload);seal();assert(bytes(logical)>STATE_LIMIT);assert(bytes(physical)<STATE_LIMIT);
  fs.writeFileSync(f.stateFile,JSON.stringify(physical)+'\n');const overflowBytes=fs.readFileSync(f.stateFile);
  assert.throws(()=>f.readonly());assert.deepEqual(fs.readFileSync(f.stateFile),overflowBytes);
  assert.throws(()=>{let opened;try{opened=openExecutionStore(f.options);}finally{opened?.close();}});
  assert.deepEqual(fs.readFileSync(f.stateFile),overflowBytes);
});
