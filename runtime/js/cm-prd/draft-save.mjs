// Save the current self-checked draft; never issue specification approval.
import fs from 'node:fs';
import {assertPrdBatchActive} from './inputs-replaced.mjs';
import {inspectPrdSelfCheckRevision,readPrdSelfCheckRevision,prdSelfCheckRevisionPath} from './self-check-revision.mjs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {createHash} from 'node:crypto';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {writeImmutableWorkflowFile} from '../cm-ai/review-evidence-file.mjs';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
import {inspectPrdFindings} from './review-findings.mjs';
import {replacePrdDocument} from './review-correction.mjs';

export function savePrdDraft(input){
  assertPrdBatchActive(input.specs);
  if(input.getSelfCheckRevision?.())return saveSelfCheckRevision(input);
  return saveDocuments(input,false);
}
export function savePrdDesign({specs,writeEnabled,getDraft}){
  assertPrdBatchActive(specs);
  return saveDocuments({specs,writeEnabled,getDraft},true);
}
// Only the analysis owner can supply the original saved promotion and the
// self-checked successor. Requirements/design are never rewritten here.
export function savePrdPromotedDraft({specs,writeEnabled,getDraft,getOriginal}){
  assertPrdBatchActive(specs);
  need(writeEnabled===true&&typeof getDraft==='function'&&typeof getOriginal==='function','prd_spec_save_not_enabled');
  const draft=json(getDraft(),256*1024),original=json(getOriginal(),256*1024);
  const inventory=value=>value.features.map(feature=>feature.directory);
  need(digest(inventory(draft))===digest(inventory(original)),'prd_promoted_save_scope_changed');
  if(draft.features.every(feature=>readCmInitSource(specs,`.reviews/prd-${feature.name}-split-disposition.json`)!==null)){
    for(const feature of draft.features)need(inspectPrdFindings({specs,stage:'split',feature:feature.directory}).gate.outcome==='completed',
      'prd_spec_save_split_disposition_required');
    return savePrdDraft({specs,writeEnabled,getDraft});
  }
  const files=[];
  for(const feature of draft.features){
    const prior=original.features.find(item=>item.directory===feature.directory);
    // Keep the original contract inventory. Removing saved test intent requires
    // an explicit change workflow, not silently leaving or deleting its file.
    need(digest(feature.documents.map(doc=>doc.path).sort())===digest(prior.documents.map(doc=>doc.path).sort()),
      'prd_promoted_save_inventory_changed');
    for(const doc of feature.documents){
      need(Buffer.from(doc.content).toString('utf8')===doc.content,'prd_spec_save_encoding_invalid');
      const relative=`${feature.directory}/${doc.path}`,before=prior.documents.find(item=>item.path===doc.path).content;
      const mutable=['tasks.md','test-cases.json'].includes(doc.path);
      need(mutable||['requirements.md','design.md'].includes(doc.path),'prd_spec_save_document_invalid');
      files.push({relative,content:doc.content,before:mutable?before:doc.content,mutable});
    }
  }
  const current=()=>{
    need(getDraft().draftDigest===draft.draftDigest&&getOriginal().draftDigest===original.draftDigest,'prd_promoted_save_changed');
    for(const file of files){
      const bytes=readCmInitSource(specs,file.relative);
      need(bytes!==null&&(bytes.equals(Buffer.from(file.before))||bytes.equals(Buffer.from(file.content)))
        &&(fs.lstatSync(path.join(specs,file.relative)).mode&0o777)===0o600,'prd_promoted_save_conflict');
    }
    for(const feature of draft.features)for(const suffix of ['-r1.md','-r2.md','-dispatch.json','-disposition.json'])
      need(readCmInitSource(specs,`.reviews/prd-${feature.name}-split${suffix}`)===null,'prd_promoted_save_split_started');
  };
  current();
  const reviews=path.join(specs,'.reviews');
  const name=`prd-task-revision-${original.draftDigest}.md`;
  const bytes=Buffer.from('# Saved draft task revision\n\nNot approval. Original and successor bytes for explicit recovery.\n```json\n'
    +JSON.stringify({version:1,original,draft})+'\n```\n');
  // Existing design review already owns this canonical directory.
  writeImmutableWorkflowFile({reviewsDir:reviews,name,bytes,
    validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_spec_save_permissions')});
  const written=[];
  try{
    for(const file of files){
      current();
      if(!file.mutable||readCmInitSource(specs,file.relative).equals(Buffer.from(file.content)))continue;
      replacePrdDocument({specs,relative:file.relative,content:file.content,current});written.push(file.relative);
    }
    current();
    for(const file of files)need(readCmInitSource(specs,file.relative).equals(Buffer.from(file.content)),'prd_promoted_save_readback');
    return json({status:'draft_saved',draftDigest:draft.draftDigest,archive:`.reviews/${name}`,
      artifacts:files.map(file=>({path:file.relative,sha256:createHash('sha256').update(file.content).digest('hex')})),
      next:'continue_original_split_review_and_human_approval',completionAuthorized:false});
  }catch{return json({status:'draft_save_unknown',archive:`.reviews/${name}`,observedSaved:written,
    next:'inspect_archive_and_files_before_explicit_resume',completionAuthorized:false});}
}
function saveDocuments({specs,writeEnabled,getDraft},designOnly){
  need(writeEnabled===true&&typeof getDraft==='function','prd_spec_save_not_enabled');
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_spec_save_root_invalid');
  const draft=json(getDraft(),256*1024);
  need(Array.isArray(draft.features)&&draft.features.length>0
    &&draft.draftDigest===digest({summary:draft.summary,features:draft.features}),'prd_spec_save_draft_invalid');
  const files=[],directories=new Set();
  for(const feature of draft.features){
    need(typeof feature.directory==='string'&&/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.directory)
      &&!directories.has(feature.directory)&&Array.isArray(feature.documents),'prd_spec_save_feature_invalid');
    directories.add(feature.directory);const names=new Set();
    for(const doc of feature.documents){
      need((designOnly?['requirements.md','design.md']:['requirements.md','design.md','tasks.md','test-cases.json']).includes(doc.path)&&!names.has(doc.path)
        &&typeof doc.content==='string'&&doc.content.trim(),'prd_spec_save_document_invalid');names.add(doc.path);
      const bytes=Buffer.from(doc.content);
      need(bytes.toString('utf8')===doc.content,'prd_spec_save_encoding_invalid');
      files.push({directory:feature.directory,name:doc.path,relative:`${feature.directory}/${doc.path}`,bytes});
    }
    need((designOnly?['requirements.md','design.md']:['requirements.md','design.md','tasks.md']).every(name=>names.has(name)),
      'prd_spec_save_triad_missing');
  }
  const current=()=>need(getDraft().draftDigest===draft.draftDigest,'prd_spec_save_draft_changed');
  const permissions=file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_spec_save_permissions');
  // Check every target before any write. Identical files permit explicit resume;
  // different files or symlinks are conflicts, not overwrite authorization.
  for(const file of files){
    const before=readCmInitSource(specs,file.relative);
    need(before===null||before.equals(file.bytes),'prd_spec_save_conflict');
    if(before!==null)permissions(path.join(specs,file.relative));
  }
  const saved=[];
  try{
    for(const file of files){
      current();const directory=path.join(specs,file.directory);
      try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      need(fs.realpathSync(directory)===directory&&fs.lstatSync(directory).isDirectory(),'prd_spec_save_path_invalid');
      writeImmutableWorkflowFile({reviewsDir:directory,name:file.name,bytes:file.bytes,validate:permissions});
      saved.push(file.relative);
    }
    current();
    for(const file of files){
      need(readCmInitSource(specs,file.relative)?.equals(file.bytes),'prd_spec_save_readback_failed');
      permissions(path.join(specs,file.relative));
    }
    return json({status:designOnly?'design_saved':'draft_saved',draftDigest:draft.draftDigest,
      artifacts:files.map(file=>({path:file.relative,sha256:createHash('sha256').update(file.bytes).digest('hex')})),
      next:designOnly?'continue_original_design_review_and_disposition':'continue_original_review_and_human_approval',completionAuthorized:false});
  }catch{
    return json({status:designOnly?'design_save_unknown':'draft_save_unknown',draftDigest:draft.draftDigest,observedSaved:saved,
      next:'inspect_current_files_before_explicit_resume',completionAuthorized:false});
  }
}

// Re-save a completed split's exact on-disk result without overwriting it with
// the pre-review memory draft. Unchanged runs return the identical original.
export function acceptedPrdDraftForSave(specs,draft){
  let changed=false;
  const features=draft.features.map(feature=>{
    const differs=feature.documents.some(doc=>{
      const bytes=readCmInitSource(specs,`${feature.directory}/${doc.path}`);
      return bytes!==null&&!bytes.equals(Buffer.from(doc.content));
    });
    if(!differs||readCmInitSource(specs,`.reviews/prd-${feature.name}-split-disposition.json`)===null)return feature;
    const review=inspectPrdFindings({specs,stage:'split',feature:feature.directory});
    need(review.gate.outcome==='completed'&&review.verdict!=='blocked'&&review.draftDigest===draft.draftDigest,
      'prd_spec_save_split_disposition_required');
    const originals=feature.documents.map(doc=>({path:`${feature.directory}/${doc.path}`,
      sha256:createHash('sha256').update(doc.content).digest('hex')}));
    const order=items=>[...items].sort((a,b)=>a.path.localeCompare(b.path));
    need(digest(order(originals))===digest(order(review.reviewedArtifacts)),'prd_spec_save_split_binding_changed');
    const receipt=JSON.parse(readCmInitSource(specs,review.evidence.replace(/-r1\.md$/,'-disposition.json')).toString('utf8'));
    need(digest(receipt.artifacts.map(item=>item.path).sort())===digest(originals.map(item=>item.path).sort()),
      'prd_spec_save_split_binding_changed');
    const documents=feature.documents.map(doc=>{
      const relative=`${feature.directory}/${doc.path}`,bytes=readCmInitSource(specs,relative);
      need(bytes!==null&&createHash('sha256').update(bytes).digest('hex')===receipt.artifacts.find(item=>item.path===relative)?.sha256,
        'prd_spec_save_split_artifact_changed');
      return {path:doc.path,content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    });
    changed=true;return {...feature,documents};
  });
  return changed?json({...draft,features,draftDigest:digest({summary:draft.summary,features})},256*1024):draft;
}

// Save only the owner-recorded self-check revision. The immutable record precedes
// replacement, so a partial write can resume against exactly the same two versions.
function saveSelfCheckRevision({specs,writeEnabled,getDraft,getSelfCheckRevision,onSelfCheckRevisionSaved}){
  need(writeEnabled===true&&typeof onSelfCheckRevisionSaved==='function','prd_spec_save_not_enabled');
  const revision=inspectPrdSelfCheckRevision(getSelfCheckRevision()),draft=json(getDraft(),256*1024);
  const changed=revision.features.filter(f=>f.changedFiles.length);
  const existing=changed.map(f=>readPrdSelfCheckRevision(specs,f.directory));
  need(existing.every(value=>value===null||digest(value)===digest(revision)),'prd_self_check_revision_binding_changed');
  const files=changed.flatMap(f=>f.documents.filter(d=>f.changedFiles.includes(d.path)).map(d=>({...d,relative:`${f.directory}/${d.path}`})));
  const current=()=>{
    need(digest(getSelfCheckRevision())===digest(revision),'prd_self_check_revision_binding_changed');
    // The owner validates sources, original review bindings, exact revision and
    // partial-save tolerance. Unrelated disk edits still stop the operation.
    need(getDraft().draftDigest===draft.draftDigest,'prd_spec_save_draft_changed');
    for(const file of files){
      const bytes=readCmInitSource(specs,file.relative),observed=bytes===null?null:createHash('sha256').update(bytes).digest('hex');
      need([file.beforeSha256,file.sha256].includes(observed)
        &&(fs.lstatSync(path.join(specs,file.relative)).mode&0o777)===0o600,'prd_spec_save_conflict');
    }
  };
  // Completed split receipts own the latest saved version. Never roll them back.
  if(draft.features.some(f=>readCmInitSource(specs,`.reviews/prd-${f.name}-split-disposition.json`)!==null))
    return saveDocuments({specs,writeEnabled,getDraft},false);
  current();
  need(draft.draftDigest===revision.draftDigest,'prd_self_check_revision_binding_changed');
  for(const feature of draft.features)for(const suffix of ['-r1.md','-r2.md','-dispatch.json','-disposition.json'])
    need(readCmInitSource(specs,`.reviews/prd-${feature.name}-split${suffix}`)===null,'prd_self_check_revision_split_started');
  // Preflight tasks/contracts as well, before replacing accepted documents.
  for(const feature of draft.features)for(const doc of feature.documents){
    const relative=`${feature.directory}/${doc.path}`;if(files.some(f=>f.relative===relative))continue;
    const before=readCmInitSource(specs,relative);
    need(before===null||before.equals(Buffer.from(doc.content)),'prd_spec_save_conflict');
  }
  const reviews=path.join(specs,'.reviews');
  try{fs.mkdirSync(reviews,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(reviews)===reviews&&fs.lstatSync(reviews).isDirectory(),'prd_review_path_invalid');
  for(const feature of changed)writeImmutableWorkflowFile({reviewsDir:reviews,
    name:path.basename(prdSelfCheckRevisionPath(feature.directory)),bytes:Buffer.from(JSON.stringify(revision)+'\n'),
    validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'prd_spec_save_permissions')});
  try{
    for(const file of files){
      current();if(readCmInitSource(specs,file.relative).equals(Buffer.from(file.content)))continue;
      replacePrdDocument({specs,relative:file.relative,content:file.content,current});
    }
    const result=saveDocuments({specs,writeEnabled,getDraft},false);
    if(result.status==='draft_saved')onSelfCheckRevisionSaved();return result;
  }catch{return json({status:'draft_save_unknown',draftDigest:draft.draftDigest,
    next:'inspect_recorded_self_check_revision_before_explicit_resume',completionAuthorized:false});}
}
