// Optional, mechanically collected verification. No identity or approval proof.
import {digest,json,need,shape,hex,id} from '../cm-ai/effect-contract.mjs';
export const VERIFICATION_TOOLS=Object.freeze(['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__mutate_check']);
export function verificationPath(value){
  need(typeof value==='string'&&value.length<=240&&!value.includes('\\')&&!value.includes('\0')
    &&!value.startsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')
    &&!value.split('/').some(p=>/^(?:\.env(?:\..*)?|\.git|\.reviews|\.codex|\.claude|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|credentials\.json|id_rsa|node_modules)$/i.test(p)),'review_verification_path');
  return value;
}
export function readReviewVerification(raw){
  const c=json(raw,32768);shape(c,['files','checks','mutationPaths','timeoutMs']);
  for(const key of ['files','mutationPaths']){
    need(Array.isArray(c[key])&&c[key].length>0&&c[key].length<=256&&new Set(c[key]).size===c[key].length,'review_verification_config');
    c[key].forEach(verificationPath);
  }
  need(c.mutationPaths.every(p=>c.files.includes(p)&&!/(^|\/)(?:tests?|fixtures|AGENTS\.md|CLAUDE\.md)(\/|$)|\.(?:test|spec)\./i.test(p)),'review_verification_config');
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
 for(const r of required)need(files.some(f=>f.path===r.path&&f.sha256===r.sha256&&(r.mode===undefined||f.mode===r.mode)), 'review_verification_package_binding');
 for(const r of (pkg.changes??[]).filter(c=>!c.after))need(!files.some(f=>f.path===r.path&&f.sha256!==null),'review_verification_package_binding');
}
export function inspectReviewVerificationEvidence(raw,{request,configuration,providerThreadId}){
  const c=readReviewVerification(configuration),e=json(raw,128*1024);
  shape(e,['version','requestDigest','packageDigest','profileDigest','providerThreadId','files','snapshotDigest','checks','mutations']);
  need(e.version===1&&e.requestDigest===request.requestDigest&&e.packageDigest===request.payload.reviewPackage.packageDigest
    &&e.profileDigest===digest(c)&&e.providerThreadId===providerThreadId&&request.provider==='claude','review_verification_binding');
  id(e.providerThreadId);
  need(Array.isArray(e.files)&&e.files.length===c.files.length,'review_verification_binding');
  for(const f of e.files){shape(f,['path','sha256','mode']);verificationPath(f.path);if(f.sha256===null)need(f.mode===null,'review_verification_binding');else{hex(f.sha256);need(Number.isInteger(f.mode)&&f.mode>=0&&f.mode<=511,'review_verification_binding');}}
  need(digest(e.files.map(f=>f.path).sort())===digest([...c.files].sort())&&e.snapshotDigest===digest(e.files),'review_verification_binding');
  bindVerificationFiles(e.files,request.payload.reviewPackage);
  const timing=r=>need(Number.isSafeInteger(r.startedAt)&&Number.isSafeInteger(r.endedAt)&&r.startedAt<=r.endedAt,'review_verification_evidence');
  need(Array.isArray(e.checks)&&e.checks.length===c.checks.length,'review_verification_evidence');
  for(const [i,r] of e.checks.entries()){
    shape(r,['id','commandDigest','exitCode','outputSha256','startedAt','endedAt']);timing(r);hex(r.outputSha256);
    need(r.id===c.checks[i].id&&r.commandDigest===digest(c.checks[i].command)&&r.exitCode===0,'review_verification_evidence');
  }
  need(Array.isArray(e.mutations)&&e.mutations.length>=1&&e.mutations.length<=8,'review_verification_evidence');
  for(const m of e.mutations){
    shape(m,['path','beforeSha256','afterSha256','checkId','baselineExitCode','mutatedExitCode','restoredExitCode','restoredSha256','startedAt','endedAt']);timing(m);hex(m.afterSha256);
    need(c.mutationPaths.includes(m.path)&&c.checks.some(r=>r.id===m.checkId)&&m.beforeSha256===e.files.find(f=>f.path===m.path)?.sha256
      &&m.afterSha256!==m.beforeSha256&&m.restoredSha256===m.beforeSha256&&m.baselineExitCode===0
      &&Number.isInteger(m.mutatedExitCode)&&m.mutatedExitCode>0&&m.mutatedExitCode<=255&&m.restoredExitCode===0,'review_verification_evidence');
  }
  return e;
}
