// One current-host attempt, owned durably by the original PRD review gate.
import fs from 'node:fs';
import path from 'node:path';
import {claimPrdReview,inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {publishPrdReview} from './review-publication.mjs';
import {need,id,json,digest} from '../cm-ai/effect-contract.mjs';

export function validatePrdReviewMode(mode,response){
  need(['independent','self-degraded'].includes(mode)
    &&(mode==='self-degraded'?response.reviewer==='self-degraded':response.reviewer!=='self-degraded'),'prd_review_mode_changed');
}

export async function runPrdHostReview({specs,prepared,authorContextId,writeEnabled,mode,review,revalidate,signal}){
  need(writeEnabled===true&&['independent','self-degraded'].includes(mode)
    &&typeof review==='function'&&typeof revalidate==='function','prd_review_not_enabled');id(authorContextId);
  need(!signal.aborted,'cancelled');
  prepared=json(prepared,512*1024);
  const pkg=prepared.reviewPackage,match=pkg.feature.match(/^([1-9]\d*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  need(match&&digest(pkg)===prepared.packageDigest&&['design','split'].includes(pkg.stage),'prd_review_package_invalid');
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_review_root_invalid');
  const reviews=path.join(specs,'.reviews'),prefix=`prd-${match[2]}-${pkg.stage}`;
  const args={stage:pkg.stage,feature:match[2],evidence:path.join(reviews,`${prefix}-r1.md`),
    receipt:path.join(reviews,`${prefix}-disposition.json`)};
  need(digest(prepared.paths)===digest(args),'prd_review_path_invalid');
  const current=()=>need(revalidate().packageDigest===prepared.packageDigest,'prd_review_inputs_changed');
  current();
  const before=inspectPrdReview(args);
  if(before.outcome!=='dispatch_once')return json({status:'review_existing',gate:before,completionAuthorized:false});
  try{fs.mkdirSync(reviews,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(reviews)===reviews&&fs.lstatSync(reviews).isDirectory(),'prd_review_path_invalid');
  try{
    claimPrdReview({...args,package_sha256:prepared.packageDigest});
    need(!signal.aborted,'cancelled');current();
    const paths=(pkg.stage==='design'?['requirements.md','design.md']:['requirements.md','design.md','tasks.md'])
      .map(file=>`${pkg.feature}/${file}`).sort();
    const response=json(await review({package:{...pkg,packageDigest:prepared.packageDigest},examinedPaths:paths,authorContextId,mode,
      instructions:'Use only the authorized current-host review channel. independent requires an actual fresh reviewer context, not the author. self-degraded uses the author and must explain unavailable independence. Verify context identity and forward the original result unchanged. No provider/CLI invocation, installation, external transmission, Git or project writes without separate authority. Return {reviewer,contextId,independent,at,result}, plus degradedReason only for self-degraded. Result follows verdict/packageDigest/examinedPaths/findings/summary. Do not retry or switch mode after this attempt; unavailable/interrupted remains unknown.'},signal),64*1024);
    need(!signal.aborted,'cancelled');current();
    validatePrdReviewMode(mode,response);
    const published=publishPrdReview({specs,reviewPackage:pkg,packageDigest:prepared.packageDigest,authorContextId,response});
    return json({status:'review_recorded',...published});
  }catch{
    // A partial claim or any interruption may already have consumed the attempt.
    // Keep the original durable record. Never remove it or dispatch a replacement.
    return json({status:signal.aborted?'review_cancelled':'review_unknown',packageDigest:prepared.packageDigest,
      next:'inspect_original_attempt_without_redispatch',completionAuthorized:false});
  }
}
