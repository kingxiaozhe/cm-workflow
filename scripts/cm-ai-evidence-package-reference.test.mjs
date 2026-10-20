// Pure storage contracts; these synthetic packages are never review authority.
import {pathToFileURL} from 'node:url';import path from 'node:path';
import {evidenceCheckpointBudget} from '../runtime/js/cm-ai/valid-review-evidence-continuation.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {digest,JOURNAL_PAYLOAD_LIMIT} from '../runtime/js/cm-ai/effect-contract.mjs';
import {packageMaterialReference,resolveCheckpointPackage,checkpointStoragePlan} from '../runtime/js/cm-ai/checkpoint-package-material.mjs';
const identity={repositoryId:'fixture',runId:'run',taskId:'T-001',attempt:2},hex='0'.repeat(64),size=x=>Buffer.byteLength(JSON.stringify(x));
function append(records,payload,kind='result'){const body={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,kind,payload,previousDigest:records.at(-1)?.digest??null};return [...records,{...body,digest:digest(body)}];}
function registration(bytes=673104){
 function build(n){const old={version:1,kind:'cm-review-package',identity,scope:['target'],changes:[],requirements:[],material:'x'.repeat(n)},oldDigest=digest(old),receipt={identity,packageDigest:oldDigest,result:{verdict:'blocked',findings:[{id:'B1',severity:'P1'}]}},oldReceipt={...receipt,receiptDigest:digest(receipt)};
  const source={identity,hostContextId:'owner',revision:hex,oldReceiptDigest:oldReceipt.receiptDigest,oldPackageDigest:oldDigest,configDigest:hex,baselineDigest:hex,candidateDigest:hex,fingerprints:{workflow:hex,config:hex,inputs:hex}},findings=[{id:'B1',disposition:'Author explanation only',evidenceIds:['new.png']}],newEvidence={material:{manifestDigest:hex,images:[{path:'new.png'}]}};
  const body={...old,evidenceContinuation:{version:1,source,oldReceipt,findings,newEvidence}},pkg={...body,packageDigest:digest(body)},request={version:1,reason:'Data only',evidenceContinuation:true,source,nativeEvidence:{version:1,sourceRoot:'/fixture/evidence',manifest:'manifest.json'},manifestDigest:hex,findings};
  return {pkg,request,source};
 }
 let built=build(0);built=build(bytes-size(built.pkg));assert.equal(size(built.pkg),bytes);
 let records=append([],{version:3,protocol:'cm-task-runner',type:'init',config:{identity},baselinePadding:'b'.repeat(416706)});
 const payload={version:3,protocol:'cm-task-runner',type:'review-evidence-registered',fromDigest:records.at(-1).digest,...built,requestDigest:digest(built.request),retainedEvidence:[{path:'/fixture/old.md',sha256:hex},{path:'/fixture/old-receipt.json',sha256:hex}],reviewPackage:built.pkg,at:'2026-10-18T00:00:00.000Z'};delete payload.pkg;
 records=append(records,payload);return {records,pkg:built.pkg};
}
function frame(pkg,id,kind,state){return {state,attempt:2,reviewPackage:pkg,padding:'p'.repeat(600000),cache:[{effect:{version:1,id,kind,identity},result:{state,identity,packageDigest:pkg.packageDigest}}]};}
function rechain(records,index,change){const out=structuredClone(records);change(out[index].payload);for(let i=index;i<out.length;i++){out[i].previousDigest=out[i-1]?.digest??null;const {digest:old,...body}=out[i];out[i].digest=digest(body);}return out;}
const invalid={code:'checkpoint_package_material_invalid'};
test('416KB baseline and exact 673104-byte evidence package are stored once; oversized review/complete frames use the same bound reference',async()=>{
 const {records,pkg}=registration();
 if(process.env.CM_EVIDENCE_REFERENCE_BASELINE){const old=await import(pathToFileURL(path.join(process.env.CM_EVIDENCE_REFERENCE_BASELINE,'runtime/js/cm-ai/checkpoint-package-material.mjs')).href);assert.equal(old.packageMaterialReference(records,pkg,identity),null);assert.throws(()=>old.checkpointStoragePlan({records,effectId:'review-evidence',checkpoint:frame(pkg,'review-evidence','review','approved'),identity,enabled:true,reserve:200000}),invalid);process.stderr.write('[red baseline] same 673104-byte evidence registration cannot supply the oversized later checkpoint in old runtime\n');}
 const reference=packageMaterialReference(records,pkg,identity);assert.equal(reference.recordId,records.at(-1).id);assert.equal(reference.recordDigest,records.at(-1).digest);
 for(const [kind,state]of [['review','approved'],['complete','fixture_completed']]){
  const id=kind+'-evidence',checkpoint=frame(pkg,id,kind,state);assert(size(checkpoint)>JOURNAL_PAYLOAD_LIMIT);
  const plan=checkpointStoragePlan({records,effectId:id,checkpoint,identity,enabled:true,reserve:200000});assert.equal(plan.checkpoint.reviewPackage,null);assert.deepEqual(plan.payloadFields,{packageRef:reference});
  const payload={version:3,protocol:'cm-task-runner',type:'effect-checkpoint',effectId:id,checkpoint:plan.checkpoint,...plan.payloadFields};assert(size(payload)<JOURNAL_PAYLOAD_LIMIT);
  assert.deepEqual(resolveCheckpointPackage(payload,records,identity),checkpoint);
  for(const key of ['recordId','recordDigest','packageDigest']){const changed={...reference,[key]:key==='recordId'?'runner.999999':'f'.repeat(64)};assert.throws(()=>resolveCheckpointPackage({...payload,packageRef:changed},records,identity),invalid);}
 }
});
test('evidence registration source must remain exact; unrelated, forged, stale and package-drift records cannot be references',()=>{
 const {records,pkg}=registration(10000);
 for(const change of [p=>p.fromDigest=hex,p=>p.requestDigest=hex,p=>p.request.manifestDigest='f'.repeat(64),p=>p.reviewPackage.material+='drift',p=>p.source={...p.source,oldPackageDigest:'f'.repeat(64)},p=>p.request={...p.request,evidenceContinuation:false}]){
  const altered=rechain(records,1,change);assert.throws(()=>packageMaterialReference(altered,pkg,identity),invalid);
 }
 const unrelated=rechain(records,1,p=>p.type='review-evidence-authorized');assert.equal(packageMaterialReference(unrelated,pkg,identity),null);
 const checkpoint=frame(pkg,'review','review','approved'),ref={recordId:unrelated[1].id,recordDigest:unrelated[1].digest,packageDigest:pkg.packageDigest};assert.throws(()=>resolveCheckpointPackage({version:3,protocol:'cm-task-runner',type:'effect-checkpoint',effectId:'review',checkpoint:{...checkpoint,reviewPackage:null},packageRef:ref},unrelated,identity),invalid);
 assert.throws(()=>packageMaterialReference(records,pkg,{...identity,runId:'other'}),invalid);
});

test('registration and preflight share the original future-checkpoint reserve and reject an oversized reference frame',()=>{
 const {pkg}=registration(),state=frame(pkg,'review','review','approved');state.calls=[];state.receipts=[];
 const budget=evidenceCheckpointBudget(state,pkg);assert.equal(budget.newPackageBytes,673104);assert.equal(budget.payloadLimit,JOURNAL_PAYLOAD_LIMIT);assert(budget.futureCheckpointMaxBytes<=JOURNAL_PAYLOAD_LIMIT);
 assert.throws(()=>evidenceCheckpointBudget({...state,padding:'x'.repeat(JOURNAL_PAYLOAD_LIMIT)},pkg),{code:'evidence_checkpoint_capacity'});
});
