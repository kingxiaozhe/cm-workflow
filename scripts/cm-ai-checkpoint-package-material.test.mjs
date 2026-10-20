import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,JOURNAL_PAYLOAD_LIMIT} from '../runtime/js/cm-ai/effect-contract.mjs';
import {packageMaterialReference,resolveCheckpointPackage,checkpointStoragePlan,checkpointPackageBudget} from '../runtime/js/cm-ai/checkpoint-package-material.mjs';

const identity={repositoryId:'capacity',runId:'capacity-fixture',taskId:'T-001',attempt:1};
const invalid={code:'checkpoint_package_material_invalid'};
const size=value=>Buffer.byteLength(JSON.stringify(value));
const pkg=(bytes=789000,who=identity)=>{const body={version:1,kind:'cm-review-package',identity:who,material:'x'.repeat(bytes)};
  return {...body,packageDigest:digest(body)};};
function append(records,payload,kind='result'){
  const body={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,kind,payload,
    previousDigest:records.at(-1)?.digest??null};
  return [...records,{...body,digest:digest(body)}];
}
const payload=(effectId,checkpoint,fields={})=>({version:3,protocol:'cm-task-runner',type:'effect-checkpoint',effectId,checkpoint,...fields});
function intent(records,id,kind='develop',who=identity){return append(records,{version:3,protocol:'cm-task-runner',type:'effect-intent',
  effect:{version:1,id,kind,identity:who}},'intent');}
function frame(reviewPackage,id='develop-1',kind='develop',state='awaiting_review',who=identity){return {
  state,attempt:who.attempt,reviewPackage,cache:[{effect:{version:1,id,kind,identity:who},
    result:{state,identity:who,packageDigest:reviewPackage?.packageDigest??null}}]};}
function fixture(){
  const material=pkg();let records=append([],{version:3,protocol:'cm-task-runner',type:'init',config:{identity}});
  records=intent(records,'develop-1');const checkpoint=frame(material);
  const plan=checkpointStoragePlan({records,effectId:'develop-1',checkpoint,identity,enabled:true,reserve:272125});
  return {material,records,checkpoint,plan,archived:append(records,payload('develop-1',plan.checkpoint,plan.payloadFields))};
}

test('legacy disabled and small checkpoints stay inline and input records/frame remain byte exact',()=>{
  const f=fixture(),before=JSON.stringify({records:f.records,checkpoint:f.checkpoint});
  const disabled=checkpointStoragePlan({...f,effectId:'develop-1',identity,enabled:false,reserve:272125});
  assert.deepEqual(disabled.payloadFields,{});assert.deepEqual(disabled.checkpoint,f.checkpoint);
  const small=frame(pkg(32)),plan=checkpointStoragePlan({records:f.records,effectId:'develop-1',checkpoint:small,identity,enabled:true,reserve:272125});
  assert.deepEqual(plan.payloadFields,{});assert.deepEqual(plan.checkpoint,small);
  assert.deepEqual(resolveCheckpointPackage(payload('develop-1',small),f.records,identity),small);
  assert.equal(JSON.stringify({records:f.records,checkpoint:f.checkpoint}),before);
});

test('large accepted develop checkpoint archives package and business frame in one ordinary bounded append',()=>{
  const f=fixture();assert.deepEqual(f.plan.payloadFields,{packageMaterial:true});
  assert.deepEqual(f.plan.checkpoint,f.checkpoint);
  const p=payload('develop-1',f.plan.checkpoint,f.plan.payloadFields);
  assert(size(p)>JOURNAL_PAYLOAD_LIMIT-272125&&size(p)<=JOURNAL_PAYLOAD_LIMIT);
  assert.equal(f.archived.length,f.records.length+1);
  assert.deepEqual(resolveCheckpointPackage(p,f.records,identity),f.checkpoint);
  const record=f.archived.at(-1);
  assert.deepEqual(packageMaterialReference(f.archived,f.material,identity),{
    recordId:record.id,recordDigest:record.digest,packageDigest:f.material.packageDigest});
});

test('inline develop followed by a failed review crossing the future reserve stays inline within the original record limit',()=>{
  const material=pkg(644000),developId='develop-inline';
  let records=append([],{version:3,protocol:'cm-task-runner',type:'init',config:{identity}});
  records=intent(records,developId);
  const develop=frame(material,developId),developReserve=285101;
  develop.padding='';develop.padding='d'.repeat(747564-size(payload(developId,develop)));
  const initial=checkpointStoragePlan({records,effectId:developId,checkpoint:develop,identity,enabled:true,reserve:developReserve});
  assert.deepEqual(initial.payloadFields,{});
  records=append(records,payload(developId,initial.checkpoint,initial.payloadFields));
  assert.equal(packageMaterialReference(records,material,identity),null);
  const original=JSON.stringify(records);
  for(const [effectId,kind,state] of [['review-failed','review','pending_review'],['complete-inline','complete','fixture_completed']]){
    const current=intent(records,effectId,kind),checkpoint=frame(material,effectId,kind,state),reserve=286013;
    if(kind==='review'){
      checkpoint.code='review_provider_failed';
      checkpoint.reviewInvocation={result:{outcome:'failed',reconciliationRequired:false,
        observation:{events:[{event:'process_closed',exit_code:1,timed_out:false}]},
        inspection:{kind:'cm-provider-review-failure',category:'provider',failure:'reviewer_exited'}}};
    }
    checkpoint.padding='';checkpoint.padding='r'.repeat(764046-size(payload(effectId,checkpoint)));
    assert(size(payload(effectId,checkpoint))>JOURNAL_PAYLOAD_LIMIT-reserve);
    assert(size(payload(effectId,checkpoint))<JOURNAL_PAYLOAD_LIMIT);
    const before=JSON.stringify(checkpoint);
    const plan=checkpointStoragePlan({records:current,effectId,checkpoint,identity,enabled:true,reserve});
    assert.deepEqual(plan.payloadFields,{},'later inline checkpoints cannot introduce a first material archive');
    assert.deepEqual(plan.checkpoint,checkpoint);
    assert.deepEqual(resolveCheckpointPackage(payload(effectId,plan.checkpoint),current,identity),checkpoint);
    assert.equal(JSON.stringify(checkpoint),before);
    const oversized=structuredClone(checkpoint);oversized.padding+='x'.repeat(JOURNAL_PAYLOAD_LIMIT);
    assert.throws(()=>checkpointStoragePlan({records:current,effectId,checkpoint:oversized,identity,enabled:true,reserve}),invalid);
  }
  assert.equal(JSON.stringify(records),original);
});

test('later review and completion references restore the exact full package and never rewrite stored evidence',()=>{
  const f=fixture(),before=JSON.stringify(f.archived);
  let records=intent(f.archived,'review-1','review');
  for(const [id,kind,state] of [['review-1','review','approved'],['complete-1','complete','fixture_completed']]){
    if(kind==='complete')records=intent(records,id,kind);
    const checkpoint=frame(f.material,id,kind,state),plan=checkpointStoragePlan({records,effectId:id,checkpoint,identity,enabled:true,reserve:272125});
    assert.equal(plan.checkpoint.reviewPackage,null);assert.equal(plan.payloadFields.packageMaterial,undefined);
    assert.equal(plan.payloadFields.packageRef.packageDigest,f.material.packageDigest);
    const p=payload(id,plan.checkpoint,plan.payloadFields);assert(size(p)<2048);
    assert.deepEqual(resolveCheckpointPackage(p,records,identity),checkpoint);
    records=append(records,p);
  }
  assert.equal(JSON.stringify(f.archived),before);
});

test('missing, forward, tampered envelope or package and wrong record bindings are refused',()=>{
  const f=fixture(),checkpoint=frame(f.material,'review-1','review','approved');
  const records=intent(f.archived,'review-1','review');
  const plan=checkpointStoragePlan({records,effectId:'review-1',checkpoint,identity,enabled:true,reserve:272125});
  const p=payload('review-1',plan.checkpoint,plan.payloadFields);
  for(const change of [ref=>{ref.recordId='runner.999999';},ref=>{ref.recordDigest='0'.repeat(64);},ref=>{ref.packageDigest='1'.repeat(64);},ref=>{ref.extra=true;}]){
    const changed=structuredClone(p);change(changed.packageRef);assert.throws(()=>resolveCheckpointPackage(changed,records,identity),invalid);
  }
  assert.throws(()=>resolveCheckpointPackage(p,f.records,identity),invalid);
  const damaged=structuredClone(records);damaged[2].payload.checkpoint.reviewPackage.material+='tampered';
  assert.throws(()=>resolveCheckpointPackage(p,damaged,identity),invalid);
  let resealed=structuredClone(f.records),bad=structuredClone(f.plan.checkpoint);bad.reviewPackage.material+='tampered';
  resealed=append(resealed,payload('develop-1',bad,{packageMaterial:true}));
  assert.throws(()=>packageMaterialReference(resealed,f.material,identity),invalid);
});

test('markers require actual develop awaiting_review, exact current identity/attempt, one flag and an inline package',()=>{
  const f=fixture(),p=payload('develop-1',f.checkpoint,{packageMaterial:true});
  for(const change of [x=>{x.packageMaterial=false;},x=>{x.packageRef={recordId:'runner.000003',recordDigest:'0'.repeat(64),packageDigest:f.material.packageDigest};},
    x=>{x.checkpoint.reviewPackage=null;},x=>{x.checkpoint.state='approved';},x=>{x.checkpoint.attempt=2;},x=>{x.effectId='not-developed';}]){
    const changed=structuredClone(p);change(changed);assert.throws(()=>resolveCheckpointPackage(changed,f.records,identity),invalid);
  }
  for(const changed of [{...identity,taskId:'T-002'},{...identity,runId:'other-run'}])
    assert.throws(()=>packageMaterialReference(f.archived,f.material,changed),invalid);
  const reviewRecords=intent(f.records,'review-1','review'),review=frame(f.material,'review-1','review','awaiting_review');
  assert.throws(()=>resolveCheckpointPackage(payload('review-1',review,{packageMaterial:true}),reviewRecords,identity),invalid);
});

test('a reference cannot replace the current package, erase other frame fields or combine an inline package',()=>{
  const f=fixture(),records=intent(f.archived,'review-1','review');
  const checkpoint=frame(f.material,'review-1','review','approved'),plan=checkpointStoragePlan({records,effectId:'review-1',checkpoint,identity,enabled:true,reserve:272125});
  const p=payload('review-1',plan.checkpoint,plan.payloadFields);
  const old=structuredClone(p);old.checkpoint.cache[0].result.packageDigest=pkg(24).packageDigest;
  assert.throws(()=>resolveCheckpointPackage(old,records,identity),invalid);
  const inline=structuredClone(p);inline.checkpoint.reviewPackage=f.material;
  assert.throws(()=>resolveCheckpointPackage(inline,records,identity),invalid);
  const restored=resolveCheckpointPackage(p,records,identity);
  assert.deepEqual({...restored,reviewPackage:null},p.checkpoint);
  assert.equal(packageMaterialReference(f.archived,pkg(32),identity),null);
  const secondIdentity={...identity,attempt:2},secondPackage=pkg(789000,secondIdentity);
  assert.equal(packageMaterialReference(f.archived,secondPackage,secondIdentity),null,'old r1 material must not replace r2');
  const secondRecords=intent(f.archived,'develop-2','develop',secondIdentity),secondCheckpoint=frame(secondPackage,'develop-2','develop','awaiting_review',secondIdentity);
  const second=checkpointStoragePlan({records:secondRecords,effectId:'develop-2',checkpoint:secondCheckpoint,identity:secondIdentity,enabled:true,reserve:272125});
  assert.deepEqual(second.payloadFields,{packageMaterial:true},'old r1 material must not block legal new r2 material');
});

test('r1 changes_requested keeps its archived r1 package while the result and frame advance to attempt 2',()=>{
  const f=fixture(),nextIdentity={...identity,attempt:2},records=intent(f.archived,'review-1','review');
  const checkpoint=frame(f.material,'review-1','review','changes_requested');
  checkpoint.attempt=2;checkpoint.cache[0].result.identity=nextIdentity;
  // A legal large review frame must reference, not fall back to an oversized inline package.
  checkpoint.observationPadding='r'.repeat(280000);
  assert(size(payload('review-1',checkpoint))>JOURNAL_PAYLOAD_LIMIT);
  const plan=checkpointStoragePlan({records,effectId:'review-1',checkpoint,identity:nextIdentity,enabled:true,reserve:272125});
  assert.equal(plan.checkpoint.reviewPackage,null);assert.equal(plan.payloadFields.packageRef.packageDigest,f.material.packageDigest);
  const p=payload('review-1',plan.checkpoint,plan.payloadFields);
  for(const callerIdentity of [identity,nextIdentity])assert.deepEqual(resolveCheckpointPackage(p,records,callerIdentity),checkpoint);
  assert.equal(packageMaterialReference(records,f.material,nextIdentity).packageDigest,f.material.packageDigest);
  for(const change of [x=>{x.checkpoint.cache[0].result.identity.attempt=1;},x=>{x.checkpoint.cache[0].effect.identity.taskId='T-002';}]){
    const changed=structuredClone(p);change(changed);assert.throws(()=>resolveCheckpointPackage(changed,records,identity),invalid);
  }
});

test('r2 failed develop may retain the r1 package and exact r1 archive without substituting its digest for a new r2 package',()=>{
  const f=fixture(),nextIdentity={...identity,attempt:2},records=intent(f.archived,'develop-2','develop',nextIdentity);
  const checkpoint=frame(f.material,'develop-2','develop','blocked',nextIdentity);
  checkpoint.code='develop_checks_not_passed';checkpoint.receiptPadding='p'.repeat(280000);
  const plan=checkpointStoragePlan({records,effectId:'develop-2',checkpoint,identity:nextIdentity,enabled:true,reserve:272125});
  assert.equal(plan.checkpoint.reviewPackage,null);assert.equal(plan.payloadFields.packageRef.packageDigest,f.material.packageDigest);
  const p=payload('develop-2',plan.checkpoint,plan.payloadFields);
  assert.deepEqual(resolveCheckpointPackage(p,records,nextIdentity),checkpoint);
  const replaced=structuredClone(p);replaced.checkpoint.cache[0].result.packageDigest=pkg(32,nextIdentity).packageDigest;
  assert.throws(()=>resolveCheckpointPackage(replaced,records,nextIdentity),invalid);
});

test('a package above the original record limit cannot be admitted by material storage and no reserve is changed',()=>{
  const f=fixture(),oversize=frame(pkg(JOURNAL_PAYLOAD_LIMIT));
  const measured={inlineBytes:815380,packageBytes:789175,reserve:272125};
  assert.deepEqual(checkpointPackageBudget({...measured,enabled:false}),{fits:false,material:false,bytes:815380,budget:776451});
  assert.deepEqual(checkpointPackageBudget({...measured,enabled:true}),{fits:true,material:true,bytes:26717,budget:776451});
  assert.deepEqual(checkpointPackageBudget({...measured,enabled:true,referenced:true}),{fits:true,material:false,bytes:26717,budget:776451});
  assert.equal(checkpointPackageBudget({...measured,inlineBytes:JOURNAL_PAYLOAD_LIMIT-1023,enabled:true}).fits,false);
  assert.equal(checkpointPackageBudget({...measured,packageBytes:16,enabled:true}).fits,false,'future compact frame must leave original reserve');
  assert.throws(()=>checkpointStoragePlan({records:f.records,effectId:'develop-1',checkpoint:oversize,identity,enabled:true,reserve:272125}),invalid);
  for(const reserve of [-1,JOURNAL_PAYLOAD_LIMIT,1.5])assert.throws(()=>checkpointStoragePlan({records:f.records,effectId:'develop-1',checkpoint:f.checkpoint,identity,enabled:true,reserve}),invalid);
});
