// Pure review data functions. Only task-runner owns invocation/registration.
import { digest,need,shape,id,text,json,freeze,REVIEW_TEXT_LIMIT } from './effect-contract.mjs';
export function reviewPaths(pkg) {
  return [...new Set([...pkg.changes.map(c=>c.path),...pkg.requirements.map(f=>f.path),
    ...(pkg.unchangedScope??[]).map(file=>file.path),
    ...(pkg.instructions??[]).map(file=>file.path),
    ...(pkg.bootstrapRequirements?.files??[]).map(file=>'specs:'+file.path)])].sort();
}
export function allowedFindingPaths(pkg,paths=reviewPaths(pkg)) {
  return [...paths,pkg.handoff?.path].filter(Boolean);
}
export function reviewResult(raw,pkg) {
  return reviewResultForPaths(raw,pkg,reviewPaths(pkg));
}
export function reviewResultForPaths(raw,pkg,paths) {
  const r=json(raw);shape(r,['verdict','packageDigest','examinedPaths','findings','summary']);
  need(['approved','changes_requested','blocked'].includes(r.verdict));text(r.summary);
  need(r.packageDigest===pkg.packageDigest,'review_package_mismatch');
  need(digest(r.examinedPaths)===digest(paths),'missing_material');
  need(Array.isArray(r.findings) && r.findings.length<=100,'invalid_finding_shape');
  const ids=new Set(),findingPaths=allowedFindingPaths(pkg,paths);
  for(const f of r.findings) {
    try {shape(f,['id','severity','path','message','evidence']);}
    catch {need(false,'invalid_finding_shape');}
    try {id(f.id);}
    catch {need(false,'invalid_finding_id');}
    need(!ids.has(f.id),'invalid_finding_shape');ids.add(f.id);
    need(['P0','P1','P2','P3'].includes(f.severity),'invalid_finding_severity');
    need(findingPaths.includes(f.path),'invalid_finding_path');
    try {text(f.message);text(f.evidence);}
    catch {need(false,'invalid_finding_shape');}
  }
  const blocking=r.findings.filter(f=>f.severity!=='P3').length;
  need(r.verdict!=='approved'||blocking===0,'contradictory_verdict');
  need(r.verdict!=='changes_requested'||blocking>0,'contradictory_verdict');return r;
}
// A reviewer result is journaled many times (see developCheckpointReserve), so its
// text is bounded before any record is written. Rule, applied only when the result
// JSON without examinedPaths exceeds REVIEW_TEXT_LIMIT bytes:
// 1. every finding message and evidence and the summary are cut to one shared,
//    largest-fitting byte cap and end with TRUNCATED;
// 2. if even the smallest cap does not fit, findings are omitted from the end,
//    P3 first, then blocking ones while at least one blocking finding remains,
//    and the summary says how many were omitted.
// Ids, severities, paths and the verdict are never changed. Malformed results are
// returned as they are for the validator to refuse. Null means nothing fits.
const TRUNCATED=' …[cm-ai: truncated to the review text limit]';
const MIN_CAP=Buffer.byteLength(TRUNCATED)+16;
const reviewTextBytes=r=>Buffer.byteLength(JSON.stringify(r))-Buffer.byteLength(JSON.stringify(r.examinedPaths));
function utf8Prefix(value,max){
  const bytes=Buffer.from(value);if(bytes.length<=max)return value;
  let end=max;while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
}
export function boundReviewText(value){
  const shaped=value!==null&&typeof value==='object'&&!Array.isArray(value)&&typeof value.summary==='string'
    &&Array.isArray(value.examinedPaths)&&Array.isArray(value.findings)
    &&value.findings.every(f=>f!==null&&typeof f==='object'&&typeof f.message==='string'&&typeof f.evidence==='string');
  if(!shaped||reviewTextBytes(value)<=REVIEW_TEXT_LIMIT)return value;
  const cut=(text,cap)=>Buffer.byteLength(text)<=cap?text:utf8Prefix(text,cap-Buffer.byteLength(TRUNCATED))+TRUNCATED;
  const candidate=(findings,cap,omitted)=>{
    const note=omitted?` [cm-ai: ${omitted} findings omitted to fit the review text limit]`:'';
    return {...value,findings:findings.map(f=>({...f,message:cut(f.message,cap),evidence:cut(f.evidence,cap)})),
      summary:cut(value.summary,Math.max(MIN_CAP,cap-Buffer.byteLength(note)))+note};
  };
  const widest=Math.max(MIN_CAP,...[value.summary,...value.findings.flatMap(f=>[f.message,f.evidence])].map(text=>Buffer.byteLength(text)));
  const fitted=(findings,omitted)=>{
    if(reviewTextBytes(candidate(findings,MIN_CAP,omitted))>REVIEW_TEXT_LIMIT)return null;
    let low=MIN_CAP,high=widest;
    while(low<high){const middle=Math.ceil((low+high)/2);
      if(reviewTextBytes(candidate(findings,middle,omitted))<=REVIEW_TEXT_LIMIT)low=middle;else high=middle-1;}
    return candidate(findings,low,omitted);
  };
  let findings=[...value.findings];
  for(;;){
    const result=fitted(findings,value.findings.length-findings.length);if(result)return result;
    let index=findings.findLastIndex(f=>f.severity==='P3');
    if(index===-1&&findings.filter(f=>f.severity!=='P3').length>1)index=findings.length-1;
    if(index===-1)return null;
    findings=findings.filter((_,position)=>position!==index);
  }
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
