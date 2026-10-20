// Admission of NEW review intents, separate from immutable archive/transport caps.
import {need,shape,json} from './effect-contract.mjs';
import {REVIEW_MATERIAL_PAGE_BYTES} from './review-material.mjs';
// Repository 231-page successes are synthetic reader fixtures, not successful
// model reviews with a time budget. No calibrated live-success bound was found;
// use the requested conservative defaults until real evidence supports tuning.
export const DEFAULT_REVIEW_SCOPE_LIMITS=Object.freeze({pageCount:128,materialBytes:2*1024*1024,imageCount:10,imageBytes:12*1024*1024});
export const REVIEW_SCOPE_MESSAGE='请把任务拆成多个更小的 task 再审查';
export function readReviewScopeLimits(raw={}){
 const value=json(raw);need(value!==null&&typeof value==='object'&&!Array.isArray(value),'review_scope_limits_invalid');
 const keys=Object.keys(DEFAULT_REVIEW_SCOPE_LIMITS);need(Object.keys(value).every(k=>keys.includes(k)),'review_scope_limits_invalid');
 const limits={...DEFAULT_REVIEW_SCOPE_LIMITS,...value};shape(limits,keys);
 for(const n of Object.values(limits))need(Number.isSafeInteger(n)&&n>0,'review_scope_limits_invalid');
 return limits;
}
export function inspectReviewScope(prompt,pkg,rawLimits){
 const limits=readReviewScopeLimits(rawLimits),bytes=Buffer.from(prompt,'utf8');
 // Count the SAME UTF-8 boundaries as the material reader, including inline
 // presentations, without imposing its separate hard transport cap here.
 let pageCount=0;
 for(let offset=0;offset<bytes.length;pageCount++){
  let end=Math.min(offset+REVIEW_MATERIAL_PAGE_BYTES,bytes.length);
  while(end<bytes.length&&(bytes[end]&192)===128)end--;
  offset=end;
 }
 // Package validation already verifies archived PNG sizes/hashes via
 // nativeEvidenceImagePaths. Count every attached image, including old + new
 // evidence-continuation images, even when identical blobs are deduplicated.
 const checks=[...(pkg?.checks??[])];if(pkg?.evidenceContinuation)checks.push(pkg.evidenceContinuation.newEvidence);
 const images=checks.filter(c=>c.kind==='native-evidence'&&c.outcome==='passed').flatMap(c=>c.material.images);
 const measured={pageCount,materialBytes:bytes.length,imageCount:images.length,imageBytes:images.reduce((n,i)=>n+i.size,0)};
 const exceededDimensions=Object.keys(limits).filter(k=>measured[k]>limits[k]);
 return {measured,limits,exceeded:exceededDimensions.length>0,exceededDimensions};
}
export function assertReviewScope(scope){
 if(scope.exceeded)throw Object.assign(new Error(REVIEW_SCOPE_MESSAGE),{code:'review_scope_too_large',scope});
 return scope;
}
