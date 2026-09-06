// Pure review data functions. Only task-runner owns invocation/registration.
import { digest,need,shape,id,text,json,freeze } from './effect-contract.mjs';
export function reviewPaths(pkg) {
  return [...new Set([...pkg.changes.map(c=>c.path),...pkg.requirements.map(f=>f.path)])].sort();
}
export function reviewResult(raw,pkg) {
  const r=json(raw);shape(r,['verdict','packageDigest','examinedPaths','findings','summary']);
  need(['approved','changes_requested','blocked'].includes(r.verdict));text(r.summary);
  need(r.packageDigest===pkg.packageDigest,'review_package_mismatch');
  const paths=reviewPaths(pkg);need(digest(r.examinedPaths)===digest(paths),'missing_material');
  need(Array.isArray(r.findings) && r.findings.length<=100);const ids=new Set();
  for(const f of r.findings) {
    shape(f,['id','severity','path','message','evidence']);id(f.id);need(!ids.has(f.id));ids.add(f.id);
    need(['P0','P1','P2','P3'].includes(f.severity) && paths.includes(f.path));text(f.message);text(f.evidence);
  }
  const blocking=r.findings.filter(f=>f.severity!=='P3').length;
  need(r.verdict!=='approved'||blocking===0,'contradictory_verdict');
  need(r.verdict!=='changes_requested'||blocking>0,'contradictory_verdict');return r;
}
export function reviewReceipt({request,call,result,reviewPackage,developerProvider,fallbackReasons}) {
  const checked=reviewResult(result,reviewPackage);
  need(call.started===true && call.terminal==='succeeded' && call.requestDigest===request.requestDigest
    && call.resultDigest===digest(checked),'execution_mismatch');
  const data={version:1,kind:'cm-review-receipt',id:call.invocationId,identity:request.identity,
    packageDigest:reviewPackage.packageDigest,baseIdentity:reviewPackage.baseIdentity,
    artifactDigest:reviewPackage.artifactDigest,requirementsDigest:reviewPackage.requirementsDigest,
    checksDigest:reviewPackage.checksDigest,execution:json(call),
    route:{mode:call.provider===developerProvider?'same-provider':'cross-provider',fallbackReasons},result:checked};
  return json({...data,receiptDigest:digest(data)});
}
