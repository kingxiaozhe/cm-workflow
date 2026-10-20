import test from 'node:test';import assert from 'node:assert/strict';
import {materialContinuationBinding,applyMaterialContinuation,readMaterialContinuationSource} from '../runtime/js/cm-ai/material-review-continuation.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
function sample(){
 const identity={repositoryId:'fixture',runId:'timeout',taskId:'T-001',attempt:2},fingerprints={workflow:'1'.repeat(64),config:'2'.repeat(64),inputs:'3'.repeat(64)};
 const binding={identity,hostContextId:'original-host',invocationId:'fixture.12',requestDigest:'4'.repeat(64),packageDigest:'5'.repeat(64)};
 const result={outcome:'timed_out',reconciliationRequired:false,observation:{result:{status:'failed',code:'timeout'},events:[{event:'process_closed',timed_out:true}]},inspection:{review:null}};
 const s={state:'blocked',code:'review_transport_timeout',attempt:2,sequence:12,calls:Array.from({length:12},(_,i)=>({invocationId:`fixture.${i+1}`})),cache:[{effect:{id:'old-material-continuation'},result:{state:'blocked'}}],reviewInvocation:{registration:{binding},result},reviewPackage:{packageDigest:binding.packageDigest},receipt:null,receipts:Array.from({length:3},()=>({result:{verdict:'blocked'}}))};
 s.calls[11]={invocationId:binding.invocationId,requestDigest:binding.requestDigest,terminal:'failed'};
 const config={identity,completion:{fingerprints},controlPolicy:{version:2,development:'conversation',bootstrap:'disabled',qaFix:'disabled'},developer:{provider:'codex',requestedModel:'current-session'},reviewers:[{provider:'codex'}],scope:['file.txt']};
 const correction={epoch:1,materialReview:{consumed:true,recordDigest:'6'.repeat(64),effectId:'old-material'},materialContinuation:{consumed:true,recordDigest:'7'.repeat(64),effectId:'old-material-continuation'}};
 return {records:[],s,config,original:{baselineDigest:'8'.repeat(64)},correction};
}
test('one explicit timeout continuation binds failed twelve and batch policy; normal grant cannot repeat',()=>{
 const f=sample(),args=[f.records,f.s,f.config,f.original,f.correction];assert.throws(()=>materialContinuationBinding(...args));
 const b=materialContinuationBinding(...args,true);assert.equal(b.source.invocationId,'fixture.12');assert.match(b.source.transportProfileDigest,/^[a-f0-9]{64}$/);assert.notEqual(b.reviewEffectId,f.correction.materialContinuation.effectId);
 const record={...b,oldInvocationStopped:true,reason:'separate new opportunity after timeout; no refund',at:new Date().toISOString()};
 const state=applyMaterialContinuation(...args,record,true);assert.equal(state.state,'awaiting_review');assert.deepEqual(state.calls,f.s.calls);assert.deepEqual(state.receipts,f.s.receipts);
 assert.throws(()=>readMaterialContinuationSource({...b.source,transportProfileDigest:'0'.repeat(64)},true));
 for(const bad of [{...f.s,state:'unknown'},{...f.s,code:'review_provider_failed'},{...f.s,cancellationRequested:true},{...f.s,calls:f.s.calls.slice(0,11)},{...f.s,reviewInvocation:{...f.s.reviewInvocation,result:{...f.s.reviewInvocation.result,outcome:'observed'}}}])assert.throws(()=>materialContinuationBinding(f.records,bad,f.config,f.original,f.correction,true));
 assert.throws(()=>materialContinuationBinding(f.records,f.s,f.config,f.original,{...f.correction,materialTimeoutContinuation:{consumed:true}},true));
 assert.throws(()=>applyMaterialContinuation(...args,{...record,oldInvocationStopped:false},true));
 assert.throws(()=>applyMaterialContinuation(...args,{...record,source:{...b.source,packageDigest:'0'.repeat(64)}},true));
 assert.throws(()=>applyMaterialContinuation(f.records,f.s,{...f.config,scope:['changed.txt']},f.original,f.correction,record,true));
 assert.throws(()=>applyMaterialContinuation(f.records,f.s,{...f.config,completion:{fingerprints:{...f.config.completion.fingerprints,config:'0'.repeat(64)}}},f.original,f.correction,record,true));
});
