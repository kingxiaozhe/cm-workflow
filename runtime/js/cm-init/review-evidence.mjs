// Immutable archive of host-attested review material, not a completion receipt.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readCmInitSource,inspectCmInitDraft} from './draft-inspection.mjs';
import {digest,need} from '../cm-ai/effect-contract.mjs';
import {reviewResultForPaths} from '../cm-ai/review-runner.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';

function archiveBytes({project,reviewPackage,review}){
  const {packageDigest,...body}=reviewPackage;
  need(packageDigest===digest(body)&&body.project===project,'review_package_mismatch');
  need(review.source==='current_host_review_attestation'&&review.packageDigest===packageDigest
    &&review.independent===true&&['codex-subagent','codex-cli','claude-cli'].includes(review.reviewer),
  'init_review_evidence_invalid');
  need(typeof review.at==='string'&&Number.isFinite(Date.parse(review.at))
    &&new Date(review.at).toISOString()===review.at,'init_review_evidence_invalid');
  const checked=reviewResultForPaths(review.result,reviewPackage,body.examinedPaths);
  need(checked.verdict==='approved','init_review_not_approved');
  need(path.isAbsolute(project)&&fs.realpathSync(project)===project,'unsupported_path');
  const bytes=Buffer.from(['---','workflow: cm-init',`at: ${review.at}`,`reviewer: ${review.reviewer}`,
    'independent: true','verdict: approved',`package_sha256: ${packageDigest}`,'scope:',
    ...body.examinedPaths.map(file=>`  - ${file}`),'---','',
    'Host-attested independent draft review. Not a V3 receipt, write result or task completion.',
    'Contains private project material. Do not publish or transmit without separate authorization.',
    '```json',JSON.stringify({version:1,reviewPackage,review}),'```',''].join('\n'));
  need(bytes.length<=256*1024,'limit_exceeded');
  return bytes;
}

export function publishCmInitReviewEvidence({project,reviewPackage,review}){
  const bytes=archiveBytes({project,reviewPackage,review});
  const {packageDigest}=reviewPackage;
  const reviewsDir=path.join(project,'.reviews');
  try{fs.mkdirSync(reviewsDir,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.lstatSync(reviewsDir).isDirectory()&&!fs.lstatSync(reviewsDir).isSymbolicLink()
    &&fs.realpathSync(reviewsDir)===reviewsDir,'unsupported_path');
  const name=`cm-init-${packageDigest}.md`;
  const validate=file=>need((fs.lstatSync(file).mode&0o777)===0o600,'init_review_evidence_permissions');
  const published=writeReviewEvidence({reviewsDir,name,bytes,validate});
  writeReviewEvidence({reviewsDir,name,bytes,validate,inspectOnly:true});
  return {...published,packageDigest,kind:'cm-init-review-archive',completionAuthorized:false};
}

// Read-only current-state comparison. Archive contents never reauthorize a write.
export function inspectCmInitRecovery({project,packageDigest}){
  return loadCmInitRecoveryDraft({project,packageDigest}).report;
}

// Host-only draft input; neither the archived verdict nor confirmation is restored.
export function loadCmInitRecoveryDraft({project,packageDigest}){
  need(typeof packageDigest==='string'&&/^[a-f0-9]{64}$/.test(packageDigest),'init_archive_digest_invalid');
  need(path.isAbsolute(project)&&fs.realpathSync(project)===project,'unsupported_path');
  const relative=`.reviews/cm-init-${packageDigest}.md`;
  const bytes=readCmInitSource(project,relative);
  need(bytes!==null&&bytes.length<=256*1024,'init_archive_invalid');
  need((fs.lstatSync(path.join(project,relative)).mode&0o777)===0o600,'init_review_evidence_permissions');
  let saved;
  try{saved=JSON.parse(bytes.toString('utf8').split('\n').at(-3));}catch{need(false,'init_archive_invalid');}
  need(saved?.version===1&&saved.reviewPackage?.packageDigest===packageDigest,'init_archive_invalid');
  need(archiveBytes({project,reviewPackage:saved.reviewPackage,review:saved.review}).equals(bytes),'init_archive_invalid');
  const pkg=saved.reviewPackage;
  need(pkg.kind==='cm-init-draft-review-package'&&pkg.version===1,'init_archive_invalid');
  const inspection=inspectCmInitDraft({project,documents:pkg.documents});
  need(Array.isArray(pkg.originals)&&pkg.originals.length===pkg.documents.length,'init_archive_invalid');
  const sha=value=>createHash('sha256').update(value).digest('hex');
  const files=inspection.changes.map((change,index)=>{
    const original=pkg.originals[index];
    need(original?.path===change.path&&(original.content===null||typeof original.content==='string'), 'init_archive_invalid');
    const before=original.content===null?null:sha(Buffer.from(original.content));
    need(before===original.sha256,'init_archive_invalid');
    return {path:change.path,status:change.beforeSha256===change.afterSha256?'written':
      change.beforeSha256===before?'not_written':'conflict',sha256:change.beforeSha256};
  });
  const report={version:1,workflow:'cm-init',phase:'recovery_inspection',packageDigest,files,
    status:files.some(file=>file.status==='conflict')?'conflict':files.every(file=>file.status==='written')?'matches_reviewed_draft':'incomplete',
    source:'archive_and_current_disk',writeAuthorized:false,completionAuthorized:false,
    next:'host_review_current_state_before_any_new_authorization'};
  return {report,documents:pkg.documents,selection:pkg.selection,inspection};
}
