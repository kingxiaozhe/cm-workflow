// Spent review authority never grows because its provider returned no verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import {effectSlotFree,nativeCorrectionReviewExhausted,nativeTransportReviewRetryBinding} from '../runtime/js/cm-ai/durable-runner-state.mjs';

test('failed or unknown tenth review has no eleventh intent or renewable authority',()=>{
 const correction={epoch:1,developConsumed:true,reviewConsumed:true,
  reviewRetry:{recordDigest:'a'.repeat(64),effectId:'review-2-retry-2-correction-1',consumed:true},
  transportReviewRetry:{recordDigest:'b'.repeat(64),effectId:'review-2-retry-3-correction-1',consumed:true}};
 for(const state of ['blocked','unknown']){
  const s={state,code:'review_provider_failed',attempt:2,sequence:10,
   calls:Array.from({length:10},()=>({terminal:'failed'})),cache:[{effect:{kind:'review',id:correction.transportReviewRetry.effectId}}]};
  if(state==='blocked')assert.equal(nativeCorrectionReviewExhausted(s,correction),true);
  for(const id of [correction.reviewRetry.effectId,correction.transportReviewRetry.effectId,'review-2-retry-4-correction-1']){
   assert.equal(effectSlotFree('review',[],[],[],null,id,s,correction),false);
  }
  assert.equal(effectSlotFree('develop',[],[],[],null,'develop-2-correction-1',s,correction),false);
  assert.throws(()=>nativeTransportReviewRetryBinding(s,{}, {},correction),{code:'native_review_retry_unavailable'});
  // Even erasing a local projection of the new grant cannot bypass raw call9.
  const withoutNewGrant={...correction};delete withoutNewGrant.transportReviewRetry;
  assert.throws(()=>nativeTransportReviewRetryBinding(s,{}, {},withoutNewGrant),{code:'native_review_retry_unavailable'});
 }
});
