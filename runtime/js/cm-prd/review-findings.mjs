// Read the original host archive for disposition, without a draft or redispatch.
import fs from 'node:fs';
import {TextDecoder} from 'node:util';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {publishPrdReview} from './review-publication.mjs';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';

export function inspectPrdFindings({specs,stage,feature}){
  need(typeof specs==='string'&&fs.realpathSync(specs)===specs,'prd_review_root_invalid');
  need(['design','split'].includes(stage),'prd_review_stage_invalid');
  const match=typeof feature==='string'&&feature.match(/^([1-9]\d*)\.([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  need(match,'prd_review_feature_invalid');
  const relative=`.reviews/prd-${match[2]}-${stage}-r1.md`;
  const bytes=readCmInitSource(specs,relative);
  need(bytes!==null&&bytes.length<=256*1024,'prd_review_archive_unavailable');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const archiveLine=text.match(/\n```json\n([^\n]+)\n```\n$/);
  need(archiveLine,'prd_review_archive_unavailable');
  const archive=json(JSON.parse(archiveLine[1]),256*1024);
  shape(archive,['version','authorContextId','reviewPackage','response']);
  need(archive.version===1&&archive.reviewPackage.feature===feature&&archive.reviewPackage.stage===stage,
    'prd_review_archive_identity_mismatch');
  const packageDigest=digest(archive.reviewPackage);
  // Reuse the publisher's complete validation and exact-byte projection, but
  // inspect only: never repair, recreate, overwrite or dispatch from this read.
  const verified=publishPrdReview({specs,...archive,packageDigest,inspectOnly:true});
  const result=archive.response.result;
  return json({status:'review_findings_ready',stage,feature,packageDigest,
    draftDigest:archive.reviewPackage.draftDigest,evidence:relative,gate:verified.gate,
    verdict:result.verdict,findings:result.findings,summary:result.summary,
    reviewedArtifacts:archive.reviewPackage.artifacts,independent:verified.independent,
    source:verified.source,next:result.verdict==='blocked'?'keep_blocked_and_request_human_review':
      verified.gate.outcome==='completed'?'inspect_existing_disposition':
      result.findings.length?'resolve_original_findings':'record_no_findings_after_artifacts_saved',
    dispatchAuthorized:false,writeAuthorized:false,completionAuthorized:false});
}
