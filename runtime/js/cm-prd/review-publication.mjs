// Publish an unchanged host-attested r1. Not a provider receipt or completion issuer.
import fs from 'node:fs';
import path from 'node:path';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {reviewResultForPaths} from '../cm-ai/review-runner.mjs';
import {need,shape,json,digest,id} from '../cm-ai/effect-contract.mjs';

export function publishPrdReview({specs,reviewPackage,packageDigest,authorContextId,response,inspectOnly=false}){
  reviewPackage=json(reviewPackage,256*1024);response=json(response,64*1024);id(authorContextId);
  need(digest(reviewPackage)===packageDigest&&reviewPackage.workflow==='cm-prd'
    &&['design','split'].includes(reviewPackage.stage),'prd_review_package_invalid');
  const match=typeof reviewPackage.feature==='string'&&reviewPackage.feature.match(/^([1-9]\d*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  need(match,'prd_review_feature_invalid');
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_review_root_invalid');
  const reviews=path.join(specs,'.reviews');
  need(fs.realpathSync(reviews)===reviews&&fs.lstatSync(reviews).isDirectory(),'prd_review_path_invalid');
  const stage=reviewPackage.stage,feature=match[2],prefix=`prd-${feature}-${stage}`;
  const args={stage,feature,evidence:path.join(reviews,`${prefix}-r1.md`),receipt:path.join(reviews,`${prefix}-disposition.json`)};
  const gate=inspectPrdReview(args);
  need(gate.package_sha256===packageDigest&&['dispatch_unknown','resume_disposition','completed'].includes(gate.outcome),
    'prd_review_unclaimed');
  const degraded=response.reviewer==='self-degraded';
  shape(response,['reviewer','contextId','independent','at','result',...(degraded?['degradedReason']:[])]);id(response.contextId);
  need(degraded?response.independent===false&&response.contextId===authorContextId
    &&typeof response.degradedReason==='string'&&response.degradedReason.trim().length>0
    &&!/[\r\n\v\f\x1c-\x1e\x85\u2028\u2029\0]/.test(response.degradedReason):
    ['codex-subagent','codex-cli'].includes(response.reviewer)&&response.independent===true&&response.contextId!==authorContextId,
    'prd_review_independence_invalid');
  need(typeof response.at==='string'&&Number.isFinite(Date.parse(response.at))
    &&new Date(response.at).toISOString()===response.at,'prd_review_timestamp_invalid');
  const files=stage==='design'?['requirements.md','design.md']:['requirements.md','design.md','tasks.md'];
  const examinedPaths=files.map(file=>`${reviewPackage.feature}/${file}`).sort();
  const result=reviewResultForPaths(response.result,{packageDigest},examinedPaths);
  const bytes=Buffer.from(['---',`at: ${response.at}`,`reviewer: ${response.reviewer}`,`independent: ${response.independent}`,
    ...(degraded?[`degraded_reason: ${JSON.stringify(response.degradedReason)}`]:[]),`package_sha256: ${packageDigest}`,
    `verdict: ${result.verdict}`,'scope:',...examinedPaths.map(file=>`  - ${file}`),'---','',
    'Current-host-attested review result; context identity and tool execution require host verification.',
    'Not a V3 invocation receipt, disposition, specification approval or task completion.',
    'Private review material; do not publish or transmit without separate authorization.',
    '```json',JSON.stringify({version:1,authorContextId,reviewPackage,response}),'```',''].join('\n'));
  const validate=file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_review_permissions');
  const published=writeReviewEvidence({reviewsDir:reviews,name:path.basename(args.evidence),bytes,validate,inspectOnly});
  writeReviewEvidence({reviewsDir:reviews,name:path.basename(args.evidence),bytes,validate,inspectOnly:true});
  const after=inspectPrdReview(args);
  need(after.package_sha256===packageDigest&&['resume_disposition','completed'].includes(after.outcome),'prd_review_publication_unknown');
  return json({outcome:'r1_published',path:published.path,packageDigest,verdict:result.verdict,gate:after,
    source:'current_host_review_attestation',independent:response.independent,completionAuthorized:false});
}
