// Optional, mechanically collected verification. No identity or approval proof.
import {digest,json,need,shape,hex,id} from '../cm-ai/effect-contract.mjs';
import {binaryVerificationVersions} from './review-verification-binary.mjs';
import {verificationPath} from './review-verification-path.mjs';
export {verificationPath} from './review-verification-path.mjs';
export const VERIFICATION_TOOLS=Object.freeze(['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__mutate_check']);
export function verificationTools(configuration){
 const c=readReviewVerification(configuration);
 if(c.binaryReview)return ['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__read_binary'];
 return c.binaryAssets?[...VERIFICATION_TOOLS,'mcp__cm_review__read_binary']:[...VERIFICATION_TOOLS];
}
export function readReviewVerification(raw){
  const c=json(raw,32768);shape(c,['files','checks','mutationPaths','timeoutMs',...['binaryAssets','binaryReview'].filter(k=>Object.hasOwn(c,k))]);
  for(const key of ['files','mutationPaths']){
    need(Array.isArray(c[key])&&c[key].length>=(key==='mutationPaths'&&c.binaryReview?0:1)&&c[key].length<=256&&new Set(c[key]).size===c[key].length,'review_verification_config');
    c[key].forEach(verificationPath);
  }
  need(c.mutationPaths.every(p=>c.files.includes(p)&&!/(^|\/)(?:tests?|fixtures|AGENTS\.md|CLAUDE\.md)(\/|$)|\.(?:test|spec)\./i.test(p)),'review_verification_config');
  if(Object.hasOwn(c,'binaryAssets')){
    shape(c.binaryAssets,['version','paths']);const b=c.binaryAssets;
    need(b.version===1&&Array.isArray(b.paths)&&b.paths.length>0&&b.paths.length<=256&&new Set(b.paths).size===b.paths.length
      &&b.paths.every(p=>c.files.includes(p)&&!c.mutationPaths.includes(p)),'review_verification_config');b.paths.forEach(verificationPath);
  }
  if(Object.hasOwn(c,'binaryReview')){
    shape(c.binaryReview,['version']);need(c.binaryReview.version===1&&c.binaryAssets&&c.mutationPaths.length===0,'review_verification_config');
  }
  need(Array.isArray(c.checks)&&c.checks.length>0&&c.checks.length<=8&&new Set(c.checks.map(c=>c.id)).size===c.checks.length,'review_verification_config');
  for(const check of c.checks){shape(check,['id','command']);id(check.id);
    need(Array.isArray(check.command)&&check.command.length>0&&check.command.length<=32
      &&check.command.every(v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\0\r\n]/.test(v)),'review_verification_config');}
  need(Number.isInteger(c.timeoutMs)&&c.timeoutMs>=1&&c.timeoutMs<=300000,'review_verification_config');
  return c;
}
export function bindVerificationFiles(files,pkg){
 const required=[...(pkg.files??[]),...(pkg.contextFiles??[]),...(pkg.changes??[]).filter(c=>c.after).map(c=>({...c.after,path:c.path})),
  ...(pkg.unchangedScope??[]),...(pkg.requirements??[]),...(pkg.instructions??[])];
 for(const r of required)need(files.some(f=>f.path===r.path&&f.sha256===r.sha256&&(r.mode===undefined||f.mode===r.mode)
  &&(!Object.hasOwn(r,'contentBlob')||r.contentBlob===r.sha256&&f.size===r.size)), 'review_verification_package_binding');
 for(const r of (pkg.changes??[]).filter(c=>!c.after))need(!files.some(f=>f.path===r.path&&f.sha256!==null),'review_verification_package_binding');
}
export function inspectReviewVerificationEvidence(raw,{request,configuration,providerThreadId,binaryReview=false}){
  const c=readReviewVerification(configuration),e=json(raw,128*1024);
  shape(e,['version','requestDigest','packageDigest','profileDigest','providerThreadId','files','snapshotDigest','checks','mutations',...(c.binaryAssets?['binaryFiles']:[]),...(c.binaryReview?['binaryReads']:[])]);
  need(e.version===1&&e.requestDigest===request.requestDigest&&e.packageDigest===request.payload.reviewPackage.packageDigest
    &&e.profileDigest===digest(c)&&e.providerThreadId===providerThreadId
    &&(request.provider==='claude'||request.provider==='codex'&&binaryReview&&c.binaryReview
      &&request.payload.reviewPackage.kind==='cm-review-package'),'review_verification_binding');
  id(e.providerThreadId);
  need(Array.isArray(e.files)&&e.files.length===c.files.length,'review_verification_binding');
  for(const f of e.files){shape(f,['path','sha256','mode',...(c.binaryAssets?.paths.includes(f.path)&&f.sha256!==null?['size']:[])]);verificationPath(f.path);if(f.sha256===null)need(f.mode===null,'review_verification_binding');else{hex(f.sha256);need(Number.isInteger(f.mode)&&f.mode>=0&&f.mode<=511,'review_verification_binding');}}
  need(digest(e.files.map(f=>f.path).sort())===digest([...c.files].sort())&&e.snapshotDigest===digest(e.files),'review_verification_binding');
  bindVerificationFiles(e.files,request.payload.reviewPackage);
  const binaryFiles=binaryVerificationVersions(c,request.payload.reviewPackage);
  if(c.binaryAssets)need(digest(e.binaryFiles)===digest(binaryFiles),'review_verification_binding');
  if(c.binaryReview){
    need(Array.isArray(e.binaryReads),'review_verification_evidence');
    const reads=binaryFiles.map(({path,version,sha256,size})=>({path,version,sha256,size}));
    need(digest(e.binaryReads)===digest(reads),'review_verification_binary_reads');
  }
  const timing=r=>need(Number.isSafeInteger(r.startedAt)&&Number.isSafeInteger(r.endedAt)&&r.startedAt<=r.endedAt,'review_verification_evidence');
  need(Array.isArray(e.checks)&&e.checks.length===c.checks.length,'review_verification_evidence');
  for(const [i,r] of e.checks.entries()){
    shape(r,['id','commandDigest','exitCode','outputSha256','startedAt','endedAt']);timing(r);hex(r.outputSha256);
    need(r.id===c.checks[i].id&&r.commandDigest===digest(c.checks[i].command)&&r.exitCode===0,'review_verification_evidence');
  }
  need(Array.isArray(e.mutations)&&e.mutations.length>=(binaryReview&&c.binaryReview?0:1)&&e.mutations.length<=8,'review_verification_evidence');
  if(binaryReview)need(c.binaryReview&&request.payload.reviewPackage.kind==='cm-review-package','review_verification_binding');
  for(const m of e.mutations){
    shape(m,['path','beforeSha256','afterSha256','checkId','baselineExitCode','mutatedExitCode','restoredExitCode','restoredSha256','startedAt','endedAt']);timing(m);hex(m.afterSha256);
    need(c.mutationPaths.includes(m.path)&&c.checks.some(r=>r.id===m.checkId)&&m.beforeSha256===e.files.find(f=>f.path===m.path)?.sha256
      &&m.afterSha256!==m.beforeSha256&&m.restoredSha256===m.beforeSha256&&m.baselineExitCode===0
      &&Number.isInteger(m.mutatedExitCode)&&m.mutatedExitCode>0&&m.mutatedExitCode<=255&&m.restoredExitCode===0,'review_verification_evidence');
  }
  return e;
}
