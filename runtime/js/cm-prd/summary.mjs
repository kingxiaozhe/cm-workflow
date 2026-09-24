// Evidence-backed human handoff. No specification approval or development.
import fs from 'node:fs';
import {assertPrdBatchActive,readPrdPredecessor} from './inputs-replaced.mjs';
import {readPrdSelfCheckRevision,prdSelfCheckRevisionPath} from './self-check-revision.mjs';
import {inspectPrdSplitDesign} from './split-design.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {writeSpecsStatus} from '../specs-status.mjs';
import {buildManifest} from '../../../scripts/cm-spec-manifest.mjs';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {inspectPrdFindings} from './review-findings.mjs';
import {checkPrdDraftMechanics} from './self-check.mjs';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
import {inspectPrdFailedCorrection} from './failed-correction.mjs';
import {prdDesignRiskSignals} from './design-risk.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function inspectPrdSummaryEvidence(specs,{currentFeatures}={}){
  assertPrdBatchActive(specs);
  const predecessor=readPrdPredecessor(specs);
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_summary_root_invalid');
  const specFiles=buildManifest(specs),names=[...new Set(specFiles.map(item=>item.path.split('/')[0]))];
  need(currentFeatures===undefined||(Array.isArray(currentFeatures)&&currentFeatures.length>0
    &&new Set(currentFeatures).size===currentFeatures.length&&currentFeatures.every(name=>names.includes(name))),
    'prd_summary_scope_unknown');
  const slugs=new Set(),features=[],documents=[],evidenceFiles=[];
  const statusBytes=readCmInitSource(specs,'.cm-specs-status');
  if(statusBytes!==null)evidenceFiles.push({path:'.cm-specs-status',sha256:sha(statusBytes)});
  for(const directory of names){
    const historical=currentFeatures!==undefined&&!currentFeatures.includes(directory);
    need(/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory),'prd_summary_feature_invalid');
    const slug=directory.replace(/^\d+\./,'');need(!slugs.has(slug),'prd_summary_slug_collision');slugs.add(slug);
    const files=specFiles.filter(item=>item.path.startsWith(directory+'/')).map(item=>{
      const bytes=readCmInitSource(specs,item.path);need(bytes!==null,'prd_summary_file_missing');
      evidenceFiles.push({path:item.path,sha256:sha(bytes)});
      return {path:item.path.slice(directory.length+1),content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
    });
    documents.push({directory,name:slug,documents:files});
    const reviews={};
    for(const stage of ['design','split']){
      const prefix=`.reviews/prd-${slug}-${stage}`;
      for(const suffix of ['-r1.md','-r2.md','-disposition.json','-dispatch.json']){
        const file=prefix+suffix,bytes=readCmInitSource(specs,file);
        if(bytes!==null)evidenceFiles.push({path:file,sha256:sha(bytes)});
      }
      const args={stage,feature:slug,evidence:path.join(specs,prefix+'-r1.md'),receipt:path.join(specs,prefix+'-disposition.json')};
      const gate=inspectPrdReview(args);
      let findings=null,archiveIssue={},correctionSelfCheck=null;
      try{
        if(['resume_disposition','completed'].includes(gate.outcome))findings=inspectPrdFindings({specs,stage,feature:directory});
        if(gate.outcome==='completed'){
          const receipt=JSON.parse(readCmInitSource(specs,prefix+'-disposition.json').toString('utf8'));
          if(receipt.disposition==='self_check_failed'){
            correctionSelfCheck=inspectPrdFailedCorrection({specs,receipt});
            for(const suffix of ['-correction-check-start.json','-correction-check-result.json']){
              const file=prefix+suffix; evidenceFiles.push({path:file,sha256:sha(readCmInitSource(specs,file))});
            }
          }
          const expected=stage==='design'?[`${directory}/design.md`]:files.map(item=>`${directory}/${item.path}`).sort();
          need(digest(receipt.artifacts.map(item=>item.path).sort())===digest(expected),'prd_summary_receipt_coverage');
        }
      }catch(error){
        if(!historical)throw error;
        const original=readCmInitSource(specs,prefix+'-r1.md');
        archiveIssue={archive:original!==null&&!/\n```json\n[^\n]+\n```\n$/.test(original.toString('utf8'))?'legacy_format':'unavailable',
          reason:error.message};
      }
      if(historical&&gate.outcome!=='completed'&&(stage==='split'||gate.outcome!=='dispatch_once'))
        archiveIssue={archive:archiveIssue.archive??'receipt_missing',
          reason:[archiveIssue.reason,'prd_summary_receipt_missing'].filter(Boolean).join('; ')};
      reviews[stage]={gate,independent:findings?.independent??null,verdict:findings?.verdict??null,
        findings:findings?.findings??[],source:findings?.source??null,
        ...(correctionSelfCheck?{correctionSelfCheck}:{}),...archiveIssue};
    }
    let cases={total:0,user:0,generated:0};
    const contract=files.find(item=>item.path==='test-cases.json');
    if(contract){
      try{
        const data=JSON.parse(contract.content);need(Array.isArray(data.cases),'prd_summary_cases_invalid');
        cases={total:data.cases.length,user:data.cases.filter(item=>item.origin==='user').length,
          generated:data.cases.filter(item=>item.origin==='generated').length};
      }catch(error){
        if(!reviews.split.correctionSelfCheck?.failedChecks.some(item=>item.code==='test_cases_invalid'))throw error;
        cases={total:null,user:null,generated:null,status:'invalid',reason:'test_cases_invalid'};
      }
    }
    const revision=readPrdSelfCheckRevision(specs,directory);
    if(revision!==null){
      const target=revision.features.find(f=>f.directory===directory);
      evidenceFiles.push({path:prdSelfCheckRevisionPath(directory),sha256:sha(readCmInitSource(specs,prdSelfCheckRevisionPath(directory)))});
      // The note is about exactly the revision reviewed by this split, including low-risk designs.
      inspectPrdSplitDesign({specs,feature:directory,draftDigest:revision.draftDigest,
        originalSha:target.documents.find(d=>d.path==='design.md').beforeSha256,
        requirementsSha:target.documents.find(d=>d.path==='requirements.md').beforeSha256});
    }
    features.push({directory,reviews,cases,...(revision?{selfCheckRevision:{reason:revision.reason,round:revision.round,
      changedFiles:revision.features.find(f=>f.directory===directory).changedFiles}}:{}),...(currentFeatures===undefined?{}:{historical})});
  }
  const mechanical=checkPrdDraftMechanics({draftDigest:digest(evidenceFiles),
    features:documents.filter(item=>currentFeatures===undefined||currentFeatures.includes(item.directory))});
  return json({specs,specFiles,features,documents,mechanical,evidenceFiles,
    ...(predecessor?{predecessor}:{}),
    ...(currentFeatures===undefined?{}:{currentFeatures})},1024*1024);
}

export function publishPrdAwaitingReview({specs,summary,writeEnabled,recover=false}){
  assertPrdBatchActive(specs);
  need(writeEnabled===true,'prd_summary_write_not_enabled');
  need(summary.status==='human_summary_prepared'&&summary.readyForAwaitingReview===true
    &&summary.blockers.length===0,'prd_summary_not_ready');
  const scope={currentFeatures:summary.currentFeatures};
  const before=inspectPrdSummaryEvidence(specs,scope);
  const existing=readCmInitSource(specs,'.cm-specs-status');
  if(recover&&existing!==null){
    const value=JSON.parse(existing);
    if(value.summaryDigest===summary.summaryDigest){
      need(value.status==='awaiting_review'&&digest(value.specFiles)===digest(before.specFiles)
        &&summary.publicationInput.every(item=>item.path==='.cm-specs-status'||before.evidenceFiles.some(next=>next.path===item.path&&next.sha256===item.sha256))
        &&before.evidenceFiles.filter(item=>item.path!=='.cm-specs-status').length===summary.publicationInput.filter(item=>item.path!=='.cm-specs-status').length,
        'prd_summary_inputs_changed');
      return json({status:'awaiting_review',path:path.join(specs,'.cm-specs-status'),features:value.features,
        completionAuthorized:false,next:'human_review_then_explicit_cm_ai'});
    }
  }
  need(digest(before)===summary.evidenceDigest,'prd_summary_inputs_changed');
  const status={status:'awaiting_review',summaryDigest:summary.summaryDigest,at:new Date().toISOString(),features:before.features.map(item=>item.directory),
    specFiles:before.specFiles,testCases:before.specFiles.filter(item=>item.path.endsWith('/test-cases.json')),approval:null};
  const bytes=Buffer.from(JSON.stringify(status)+'\n'),target=path.join(specs,'.cm-specs-status');
  try{
    writeSpecsStatus(specs,status,{beforeRename:()=>{
      need(digest(inspectPrdSummaryEvidence(specs,scope))===summary.evidenceDigest,'prd_summary_inputs_changed');
    }});
    need(readCmInitSource(specs,'.cm-specs-status')?.equals(bytes),'prd_summary_status_unknown');
    need(digest(buildManifest(specs))===digest(before.specFiles),'prd_summary_inputs_changed');
    return json({status:'awaiting_review',path:target,features:status.features,completionAuthorized:false,
      next:'human_review_then_explicit_cm_ai'});
  }catch{return json({status:'awaiting_review_write_unknown',next:'inspect_status_and_specs_without_automatic_retry',completionAuthorized:false});}
}

const requiredSignals=prdDesignRiskSignals;
export function createPrdSummaryOwner({summarize}){
  need(typeof summarize==='function','prd_summary_host_required');
  return async(specs,options={},signal=new AbortController().signal)=>{
    // Preserve the original (specs, signal) API for existing consumers.
    if(typeof options.aborted==='boolean'){signal=options;options={};}
    const scope={currentFeatures:Array.isArray(options.currentFeatures)?options.currentFeatures.slice():options.currentFeatures};
    need(!signal.aborted,'cancelled');const evidence=inspectPrdSummaryEvidence(specs,scope),evidenceDigest=digest(evidence);
    const details=json(await summarize({evidence,evidenceDigest,
      instructions:'Prepare original cm-prd Step 11 human summary. Read actual source/context as needed. Return {evidenceDigest,deliveryForm,estimatedTime,openQuestions,risks,contextScope,platformReadiness,uiBaseline,designRisk:[{feature,signals:{greenfieldAdr,architectureOrDataFlow,newRuntimeDependencyOrToolchain,publicContractDataOrSecurity,fiveOrMoreFunctions},evidence:[specific references]}]}. designRisk must cover exactly the current features (historical !== true); historical reviews are registration notes only, never new blockers. Signals are booleans and must cover original Step 9.5 criteria; unknown facts must remain explicit in openQuestions/risks, never infer approval. All descriptive fields are non-empty strings. Do not claim review or tests beyond supplied evidence, write files, dispatch reviewers/providers, approve specs or start development.'},signal),64*1024);
    need(!signal.aborted,'cancelled');
    shape(details,['evidenceDigest','deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline','designRisk']);
    need(details.evidenceDigest===evidenceDigest,'prd_summary_binding');
    for(const field of ['deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline'])
      need(typeof details[field]==='string'&&details[field].trim(),'prd_summary_details_invalid');
    const current=evidence.features.filter(item=>!item.historical),historical=evidence.features.filter(item=>item.historical);
    need(Array.isArray(details.designRisk)&&details.designRisk.length===current.length,'prd_summary_risk_coverage');
    const seen=new Set(),blockers=[],notes=[];
    for(const feature of historical)for(const [stage,review] of Object.entries(feature.reviews)){
      if(review.archive)notes.push(`历史 feature ${feature.directory}：${stage} 审查${review.archive==='legacy_format'?'为旧版归档':review.archive==='receipt_missing'?'缺少处置回执':'归档不可用'}${review.reason.includes('prd_summary_receipt_missing')&&review.archive!=='receipt_missing'?'，无处置回执':''}，已登记未重审（${review.reason}）`);
    }
    for(const risk of details.designRisk){
      shape(risk,['feature','signals','evidence']);shape(risk.signals,requiredSignals);
      const feature=current.find(item=>item.directory===risk.feature);
      need(feature&&!seen.has(risk.feature)&&requiredSignals.every(key=>typeof risk.signals[key]==='boolean')
        &&Array.isArray(risk.evidence)&&risk.evidence.length&&risk.evidence.every(item=>typeof item==='string'&&item.trim()),'prd_summary_risk_invalid');seen.add(risk.feature);
      const {design,split}=feature.reviews;
      if(split.gate.outcome!=='completed'||split.verdict==='blocked')blockers.push(`${risk.feature}: split_review_disposition_required`);
      if(Object.values(risk.signals).some(Boolean)){
        if(design.gate.outcome!=='completed'||design.verdict==='blocked')blockers.push(`${risk.feature}: design_review_disposition_required`);
      }else if(!['dispatch_once','completed'].includes(design.gate.outcome)||design.verdict==='blocked')
        blockers.push(`${risk.feature}: existing_design_attempt_unresolved`);
    }
    const riskCard=evidence.features.filter(feature=>feature.reviews.split.correctionSelfCheck).map(feature=>({
      feature:feature.directory,disposition:'self_check_failed',status:'awaiting_human_ruling',
      failedChecks:feature.reviews.split.correctionSelfCheck.failedChecks}));
    // Only the exact mechanically failed items already disposed for human ruling
    // cease to block publication. Unrelated/new failures keep the original gate.
    const unrecorded=evidence.mechanical.findings.filter(finding=>!riskCard.some(risk=>
      risk.feature===finding.feature&&risk.failedChecks.some(check=>digest(check)===digest(finding))));
    if(evidence.mechanical.status==='failed'&&unrecorded.length)blockers.push('mechanical_self_check_failed');
    need(digest(inspectPrdSummaryEvidence(specs,scope))===evidenceDigest,'prd_summary_inputs_changed');
    const checklist=['跨feature产物不重复','依赖完整且无环','AC可验证','功能粒度合规且每feature≤15任务',
      '开放问题和敏感决策已经人工确认','交付形态符合需求','存在原型时功能与交互覆盖完整'];
    const totals=evidence.mechanical.features.reduce((sum,item)=>({tasks:sum.tasks+item.tasks,
      acceptanceCriteria:sum.acceptanceCriteria+item.acceptanceCriteria}),{tasks:0,acceptanceCriteria:0});
    const revisionNotes=current.filter(feature=>feature.selfCheckRevision).map(feature=>
      `${feature.directory}：整稿自检失败后，在设计审查后修订了 ${feature.selfCheckRevision.changedFiles.join('、')}；原因：${feature.selfCheckRevision.reason}；第 ${feature.selfCheckRevision.round} 轮；${feature.reviews.split.gate.outcome==='completed'?'这些改动已由拆分审查审阅':'这些改动待拆分审查审阅'}，未另做设计审查。`);
    if(evidence.predecessor)revisionNotes.push(`前序批次 ${evidence.predecessor.sessionId} 因输入已替换而结束；原因：${evidence.predecessor.reason}。旧证据仅作历史，本批全部重新审查。`);
    const humanDetails=riskCard.length||revisionNotes.length?{...details,risks:[...riskCard.map(risk=>
      `${risk.feature}：修正自检失败，待人工裁决；${JSON.stringify(risk.failedChecks)}`),...revisionNotes,details.risks].join('\n')}:details;
    const summary=json({...(evidence.predecessor?{predecessor:evidence.predecessor}:{}),status:'human_summary_prepared',evidenceDigest,details:humanDetails,features:evidence.features,totals,
      ...(riskCard.length?{riskCard}:{}),
      ...(evidence.currentFeatures===undefined?{}:{currentFeatures:evidence.currentFeatures}),
      notes,historicalSummary:`历史 feature：${historical.length} 个已登记，${historical.filter(item=>Object.values(item.reviews).some(review=>review.archive)).length} 个含旧版归档说明`,
      mechanicalSelfCheck:evidence.mechanical,blockers,checklist:checklist.map(text=>({text,checked:false})),
      specFiles:evidence.specFiles,publicationInput:evidence.evidenceFiles,readyForAwaitingReview:blockers.length===0,
      next:'human_review_then_explicit_cm_ai',completionAuthorized:false},1024*1024);
    return json({...summary,summaryDigest:digest(summary)},1024*1024);
  };
}
