// The failed whole-draft check permits one in-scope revision, not another design review.
import {createHash} from 'node:crypto';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {need,json,digest,shape} from '../cm-ai/effect-contract.mjs';
import {checkPrdDraftMechanics,inspectPrdContextCheck} from './self-check.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const names=['requirements.md','design.md'];
export const prdSelfCheckRevisionPath=feature=>{
  need(/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature),'prd_self_check_revision_feature_invalid');
  return `.reviews/prd-${feature.replace(/^\d+\./,'')}-self-check-revision.json`;
};
export function prdSelfCheckFailedRecord(draft,contextCheck,round){
  return {round,draftDigest:draft.draftDigest,mechanical:draft.mechanicalSelfCheck,contextCheck};
}
export function createPrdSelfCheckRevision({designDraft,acceptedDesign,draft,contextCheck,round,revised,reason}){
  need(typeof reason==='string'&&reason.trim(),'prd_self_check_revision_reason_required');
  const failedSelfCheck=prdSelfCheckFailedRecord(draft,contextCheck,round);
  const features=acceptedDesign.features.map(feature=>({directory:feature.directory,
    documents:feature.documents.map(doc=>{
      const content=revised.features.find(f=>f.directory===feature.directory).documents.find(d=>d.path===doc.path).content;
      return {path:doc.path,content,sha256:sha(content),beforeSha256:sha(doc.content)};
    }),changedFiles:feature.documents.filter(doc=>doc.content!==revised.features.find(f=>f.directory===feature.directory)
      .documents.find(d=>d.path===doc.path).content).map(doc=>doc.path)}));
  return inspectPrdSelfCheckRevision({version:1,designDraftDigest:designDraft.draftDigest,
    acceptedDesignDigest:acceptedDesign.bindingDigest,reason,round:round+1,failedDraft:draft,
    failedSelfCheck,failedSelfCheckDigest:digest(failedSelfCheck),draftDigest:revised.draftDigest,features});
}
export function inspectPrdSelfCheckRevision(value){
  const revision=json(value,1024*1024);
  shape(revision,['version','designDraftDigest','acceptedDesignDigest','reason','round','failedDraft','failedSelfCheck',
    'failedSelfCheckDigest','draftDigest','features']);
  const {failedDraft,failedSelfCheck}=revision;
  need(revision.version===1&&typeof revision.reason==='string'&&revision.reason.trim()
    &&revision.round===2&&failedSelfCheck.round===1,'prd_self_check_revision_invalid');
  need(failedDraft.draftDigest===digest({summary:failedDraft.summary,features:failedDraft.features})
    &&failedSelfCheck.draftDigest===failedDraft.draftDigest&&digest(failedSelfCheck)===revision.failedSelfCheckDigest
    &&digest(failedDraft.mechanicalSelfCheck)===digest(failedSelfCheck.mechanical)
    &&digest(checkPrdDraftMechanics(failedDraft))===digest(failedSelfCheck.mechanical),'prd_self_check_revision_binding_changed');
  let failed=failedSelfCheck.mechanical.status==='failed';
  if(failedSelfCheck.contextCheck!==null){
    const {draftDigest,features}=failedSelfCheck.contextCheck;
    const checked=inspectPrdContextCheck({draftDigest,features},failedDraft);
    need(digest(checked)===digest(failedSelfCheck.contextCheck),'prd_self_check_revision_binding_changed');
    failed ||= checked.status==='failed';
  }
  need(failed,'prd_self_check_revision_failure_required');
  need(Array.isArray(revision.features)&&digest(revision.features.map(f=>f.directory))===digest(failedDraft.features.map(f=>f.directory)),
    'prd_accepted_design_scope_changed');
  for(const feature of revision.features){
    shape(feature,['directory','documents','changedFiles']);prdSelfCheckRevisionPath(feature.directory);
    need(Array.isArray(feature.documents)&&feature.documents.length===2
      &&digest(feature.documents.map(d=>d.path).sort())===digest([...names].sort()),'prd_accepted_design_scope_changed');
    for(const doc of feature.documents){
      shape(doc,['path','content','sha256','beforeSha256']);
      const before=failedDraft.features.find(f=>f.directory===feature.directory).documents.find(d=>d.path===doc.path);
      need(typeof doc.content==='string'&&doc.content.trim()&&Buffer.from(doc.content).toString('utf8')===doc.content
        &&doc.sha256===sha(doc.content)&&doc.beforeSha256===sha(before.content),'prd_self_check_revision_binding_changed');
    }
    need(digest(feature.changedFiles)===digest(feature.documents.filter(d=>d.sha256!==d.beforeSha256).map(d=>d.path)),
      'prd_self_check_revision_binding_changed');
  }
  need(revision.features.some(f=>f.changedFiles.length),'prd_self_check_revision_empty');
  return revision;
}
export function readPrdSelfCheckRevision(specs,feature,{designDraftDigest,originalSha,requirementsSha}={}){
  const bytes=readCmInitSource(specs,prdSelfCheckRevisionPath(feature));if(bytes===null)return null;
  const revision=inspectPrdSelfCheckRevision(JSON.parse(bytes.toString('utf8')));
  const target=revision.features.find(f=>f.directory===feature);
  need(target&&target.changedFiles.length&&(designDraftDigest===undefined||revision.designDraftDigest===designDraftDigest)
    &&(originalSha===undefined||target.documents.find(d=>d.path==='design.md').beforeSha256===originalSha)
    &&(requirementsSha===undefined||target.documents.find(d=>d.path==='requirements.md').beforeSha256===requirementsSha),
    'prd_self_check_revision_binding_changed');
  return revision;
}
export function prdSelfCheckRevisionBaseline(specs,feature,baseline){
  const revision=readPrdSelfCheckRevision(specs,feature,baseline);
  if(revision===null)return baseline;
  const documents=revision.features.find(f=>f.directory===feature).documents;
  return {...baseline,draftDigest:revision.draftDigest,originalSha:documents.find(d=>d.path==='design.md').sha256,
    requirementsSha:documents.find(d=>d.path==='requirements.md').sha256};
}
