import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,JOURNAL_PAYLOAD_LIMIT,REVIEW_TEXT_LIMIT,REVIEW_RESULT_COPIES,developCheckpointReserve} from '../runtime/js/cm-ai/effect-contract.mjs';
import {packageMaterialEligible,checkpointStoragePlan,resolveCheckpointPackage} from '../runtime/js/cm-ai/checkpoint-package-material.mjs';
import {measureCheckpointCapacity,inspectRecoveryCapacity} from '../runtime/js/cm-ai/recovery-capacity.mjs';
const identity={repositoryId:'recovery-capacity',runId:'capacity-original-run',taskId:'T-003',attempt:1};
const config={root:'/fixture/project',identity,controlPolicy:{version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}};
const size=value=>Buffer.byteLength(JSON.stringify(value));
function append(records,payload,kind='result'){
  const body={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,kind,payload,previousDigest:records.at(-1)?.digest??null};
  return [...records,{...body,digest:digest(body)}];
}
function packageOf(attempt=1,bytes=700000){const body={version:1,kind:'cm-review-package',identity:{...identity,attempt},material:'x'.repeat(bytes)};
  return {...body,packageDigest:digest(body)};}
const intent=(records,id,kind,attempt)=>append(records,{version:3,protocol:'cm-task-runner',type:'effect-intent',effect:{id,kind,identity:{...identity,attempt}}},'intent');
function checkpoint(pkg,id,kind,attempt=1,state='awaiting_review'){
  return {state,attempt,reviewPackage:pkg,cache:[{effect:{id,kind,identity:{...identity,attempt}},result:{state,identity:{...identity,attempt},packageDigest:pkg.packageDigest}}]};
}
const payload=(id,cp,fields={})=>({effectId:id,checkpoint:cp,version:3,protocol:'cm-task-runner',type:'effect-checkpoint',...fields});
function fixture(attempt=2,target=873052){
  const prior=packageOf(1,16),old=checkpoint(prior,'develop-1','develop');
  let records=append([],{version:3,protocol:'cm-task-runner',type:'init',config});
  records=intent(records,'develop-1','develop',1);records=append(records,payload('develop-1',old));
  const pkg=packageOf(attempt),id=`develop-${attempt}`,cp=checkpoint(pkg,id,'develop',attempt);
  records=intent(records,id,'develop',attempt);
  cp.padding='';cp.padding='p'.repeat(target-size(payload(id,cp)));
  return {records,effectId:id,checkpoint:cp,identity:{...identity,attempt},reserve:315305};
}
function snapshot(records){const body={version:1,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
  fingerprints:{workflow:'1'.repeat(64),config:'2'.repeat(64),inputs:'3'.repeat(64)},records};return {...body,revision:digest(body)};}

test('shared eligibility is durable-mode based and does not require or consume a protected scope supplement',()=>{
  assert.equal(packageMaterialEligible(config,3),true);
  assert.equal(packageMaterialEligible({...config,protectedSupplement:{untrusted:true}},3),true);
  for(const [change,version] of [[{},2],[{root:''},3],[{controlPolicy:{...config.controlPolicy,version:1}},3],
    [{controlPolicy:{...config.controlPolicy,development:'provider'}},3],[{controlPolicy:{...config.controlPolicy,bootstrap:'write'}},3],
    [{bootstrap:{}},3],[{providerDevelopment:{}},3],[{parallelSelection:{}},3],[{parallelMember:true},3],
    [{batchWorkflowsDigest:'x'},3],[{codeProjectPaths:['a','b']},3],[{codeProjects:['/a','/b']},3]])
    assert.equal(packageMaterialEligible({...config,...change},version),false,JSON.stringify(change));
  let called=0;const getter={...config};Object.defineProperty(getter,'root',{enumerable:true,get(){called++;return config.root;}});
  assert.equal(packageMaterialEligible(getter,3),false);assert.equal(called,0);
});

test('historical a2 with r1 and no protectedSupplement reports actual 873052 inline versus original 733271 budget and passes material storage',()=>{
  const f=fixture(),before=JSON.stringify(f),report=inspectRecoveryCapacity({...f,config,version:3});
  assert.equal(report.inlineBytes,873052);assert.equal(report.budget,733271);
  assert.equal(report.reserve,315305);assert.equal(report.eligible,true);assert.equal(report.mode,'material');assert.equal(report.fits,true);
  assert.equal(report.encodedBytes,size(payload(f.effectId,f.checkpoint,{packageMaterial:true})));
  assert.equal(report.recordBytes-report.encodedBytes>0,true);assert(report.encodedBytes<=JOURNAL_PAYLOAD_LIMIT);
  assert.deepEqual(report.unverified,['state','physical']);assert.equal(JSON.stringify(f),before);
  const legacy=inspectRecoveryCapacity({...f,config,version:2});assert.equal(legacy.fits,false);assert.equal(legacy.mode,'inline');
  assert.equal(legacy.encodedBytes,873052);assert.equal(legacy.code,'checkpoint_review_reserve_exceeded');
});

test('reports exact reference bytes after archive while preserving all frame fields and immutable r1 history',()=>{
  const f=fixture(1),plan=checkpointStoragePlan({...f,enabled:true});
  let records=append(f.records,payload(f.effectId,plan.checkpoint,plan.payloadFields));
  records=intent(records,'review-1','review',1);const cp=checkpoint(f.checkpoint.reviewPackage,'review-1','review',1,'approved');
  cp.observationPadding='r'.repeat(280000);
  const before=JSON.stringify({records,cp});
  const report=measureCheckpointCapacity({records,effectId:'review-1',checkpoint:cp,identity,reserve:f.reserve,enabled:true});
  const refPlan=checkpointStoragePlan({records,effectId:'review-1',checkpoint:cp,identity,reserve:f.reserve,enabled:true});
  assert.equal(report.mode,'reference');assert.equal(report.fits,true);
  assert.equal(report.encodedBytes,size(payload('review-1',refPlan.checkpoint,refPlan.payloadFields)));
  assert(report.encodedBytes<report.inlineBytes-f.checkpoint.reviewPackage.material.length);
  assert.equal(JSON.stringify({records,cp}),before);
});

test('genuine record, reserve, state, count and physical limits remain binding and unprovided evidence is explicit',()=>{
  const f=fixture(),oversize=structuredClone(f.checkpoint);oversize.padding+='x'.repeat(JOURNAL_PAYLOAD_LIMIT);
  const no=inspectRecoveryCapacity({...f,checkpoint:oversize,config,version:3});assert.equal(no.fits,false);assert.equal(no.code,'checkpoint_payload_too_large');
  const current=snapshot(f.records),known=inspectRecoveryCapacity({...f,config,version:3,snapshot:current,physicalBytes:size(current)+1});
  assert.deepEqual(known.unverified,[]);assert.equal(known.fits,true);assert.equal(known.checks.state,true);assert.equal(known.checks.physical,true);
  const physical=inspectRecoveryCapacity({...f,config,version:3,snapshot:current,physicalBytes:32*1024*1024});
  assert.equal(physical.fits,false);assert.equal(physical.code,'checkpoint_physical_limit');
  assert.deepEqual(known.limits,{payload:1048576,appendInput:1049600,state:16777216,physical:33554432,records:1024});
  let crowded=f.records;
  while(crowded.length<1024)crowded=append(crowded,{version:3,protocol:'cm-task-runner',type:'fixture-control',ordinal:crowded.length});
  const count=inspectRecoveryCapacity({...f,records:crowded,config,version:3});
  assert.equal(count.fits,false);assert.equal(count.code,'checkpoint_record_limit');
  let full=f.records;
  for(let n=0;n<17;n++)full=append(full,{version:3,protocol:'cm-task-runner',type:'fixture-control',padding:'s'.repeat(940000)});
  const fullSnapshot=snapshot(full),state=inspectRecoveryCapacity({...f,records:full,config,version:3,snapshot:fullSnapshot});
  assert.equal(state.fits,false);assert.equal(state.code,'checkpoint_state_limit');assert(state.nextStateBytes>16*1024*1024);
  assert.equal(REVIEW_TEXT_LIMIT,12288);assert.equal(REVIEW_RESULT_COPIES,13);
  assert.equal(developCheckpointReserve({examinedPathsBytes:100}),13*(100+12288)+2*(2+2+4)+96*1024);
});

test('read-only report binds snapshot revision/records and refuses tampering instead of silently enabling recovery',()=>{
  const f=fixture(),current=snapshot(f.records),before=JSON.stringify(current);
  const report=inspectRecoveryCapacity({...f,version:3,config,snapshot:current});assert.equal(report.revision,current.revision);
  assert.equal(JSON.stringify(current),before);
  const changed=structuredClone(current);changed.revision='0'.repeat(64);
  assert.throws(()=>inspectRecoveryCapacity({...f,version:3,config,snapshot:changed}),{code:'recovery_capacity_invalid'});
  const changedRecord=structuredClone(f.records);changedRecord[0].digest='0'.repeat(64);
  assert.throws(()=>inspectRecoveryCapacity({...f,records:changedRecord,version:3,config}),{code:'checkpoint_package_material_invalid'});
});

test('reconciled review may reference prior exact package with all original binding fields, but never introduce a material archive',()=>{
  const f=fixture(1),plan=checkpointStoragePlan({...f,enabled:true});
  const records=intent(append(f.records,payload(f.effectId,plan.checkpoint,plan.payloadFields)),'review-1','review',1);
  const cp=checkpoint(f.checkpoint.reviewPackage,'review-1','review',1,'approved');
  const binding={invocationId:'invocation-1',registeredDigest:'1'.repeat(64),startedDigest:'2'.repeat(64),resultDigest:'3'.repeat(64),receiptDigest:'4'.repeat(64)};
  const options={records,effectId:'review-1',checkpoint:cp,identity,reserve:f.reserve,enabled:true,type:'review-invocation-reconciled',binding};
  const stored=checkpointStoragePlan(options);
  assert.equal(stored.checkpoint.reviewPackage,null);assert(stored.payloadFields.packageRef);
  const p={...payload('review-1',stored.checkpoint,stored.payloadFields),type:options.type,...binding};
  assert.deepEqual(resolveCheckpointPackage(p,records,identity),cp);
  const report=measureCheckpointCapacity(options);assert.equal(report.encodedBytes,size(p));
  assert.throws(()=>checkpointStoragePlan({...options,records:f.records,checkpoint:f.checkpoint,effectId:f.effectId}),
    {code:'checkpoint_package_material_invalid'},'reconciled record cannot create first material even when large');
  for(const alter of [x=>{x.packageMaterial=true;delete x.packageRef;x.checkpoint=cp;},x=>{x.extraCommand=['skip'];},x=>{delete x.receiptDigest;}]){
    const bad=structuredClone(p);alter(bad);assert.throws(()=>resolveCheckpointPackage(bad,records,identity),{code:'checkpoint_package_material_invalid'});
  }
});
