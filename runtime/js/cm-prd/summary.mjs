// Evidence-backed human handoff. No specification approval or development.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {buildManifest} from '../../../scripts/cm-spec-manifest.mjs';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {inspectPrdFindings} from './review-findings.mjs';
import {checkPrdDraftMechanics} from './self-check.mjs';
import {need,json,shape,digest} from '../cm-ai/effect-contract.mjs';
import {prdDesignRiskSignals} from './design-risk.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function inspectPrdSummaryEvidence(specs){
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_summary_root_invalid');
  const specFiles=buildManifest(specs),names=[...new Set(specFiles.map(item=>item.path.split('/')[0]))];
  const slugs=new Set(),features=[],documents=[],evidenceFiles=[];
  const statusBytes=readCmInitSource(specs,'.cm-specs-status');
  if(statusBytes!==null)evidenceFiles.push({path:'.cm-specs-status',sha256:sha(statusBytes)});
  for(const directory of names){
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
      let findings=null;
      if(['resume_disposition','completed'].includes(gate.outcome))findings=inspectPrdFindings({specs,stage,feature:directory});
      if(gate.outcome==='completed'){
        const receipt=JSON.parse(readCmInitSource(specs,prefix+'-disposition.json').toString('utf8'));
        const expected=stage==='design'?[`${directory}/design.md`]:files.map(item=>`${directory}/${item.path}`).sort();
        need(digest(receipt.artifacts.map(item=>item.path).sort())===digest(expected),'prd_summary_receipt_coverage');
      }
      reviews[stage]={gate,independent:findings?.independent??null,verdict:findings?.verdict??null,
        findings:findings?.findings??[],source:findings?.source??null};
    }
    let cases={total:0,user:0,generated:0};
    const contract=files.find(item=>item.path==='test-cases.json');
    if(contract){const data=JSON.parse(contract.content);need(Array.isArray(data.cases),'prd_summary_cases_invalid');
      cases={total:data.cases.length,user:data.cases.filter(item=>item.origin==='user').length,
        generated:data.cases.filter(item=>item.origin==='generated').length};}
    features.push({directory,reviews,cases});
  }
  const mechanical=checkPrdDraftMechanics({draftDigest:digest(evidenceFiles),features:documents});
  return json({specs,specFiles,features,documents,mechanical,evidenceFiles},1024*1024);
}

export function publishPrdAwaitingReview({specs,summary,writeEnabled,recover=false}){
  need(writeEnabled===true,'prd_summary_write_not_enabled');
  need(summary.status==='human_summary_prepared'&&summary.readyForAwaitingReview===true
    &&summary.blockers.length===0,'prd_summary_not_ready');
  const before=inspectPrdSummaryEvidence(specs);
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
    specFiles:before.specFiles,testCases:before.specFiles.filter(item=>item.path.endsWith('/test-cases.json'))};
  const bytes=Buffer.from(JSON.stringify(status)+'\n'),target=path.join(specs,'.cm-specs-status');
  const temporary=path.join(specs,`.cm-prd-status-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    need(digest(inspectPrdSummaryEvidence(specs))===summary.evidenceDigest,'prd_summary_inputs_changed');
    fs.renameSync(temporary,target);
    const dir=fs.openSync(specs,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    need(readCmInitSource(specs,'.cm-specs-status')?.equals(bytes),'prd_summary_status_unknown');
    need(digest(buildManifest(specs))===digest(before.specFiles),'prd_summary_inputs_changed');
    return json({status:'awaiting_review',path:target,features:status.features,completionAuthorized:false,
      next:'human_review_then_explicit_cm_ai'});
  }catch{return json({status:'awaiting_review_write_unknown',next:'inspect_status_and_specs_without_automatic_retry',completionAuthorized:false});}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

const requiredSignals=prdDesignRiskSignals;
export function createPrdSummaryOwner({summarize}){
  need(typeof summarize==='function','prd_summary_host_required');
  return async(specs,signal)=>{
    need(!signal.aborted,'cancelled');const evidence=inspectPrdSummaryEvidence(specs),evidenceDigest=digest(evidence);
    const details=json(await summarize({evidence,evidenceDigest,
      instructions:'Prepare original cm-prd Step 11 human summary. Read actual source/context as needed. Return {evidenceDigest,deliveryForm,estimatedTime,openQuestions,risks,contextScope,platformReadiness,uiBaseline,designRisk:[{feature,signals:{greenfieldAdr,architectureOrDataFlow,newRuntimeDependencyOrToolchain,publicContractDataOrSecurity,fiveOrMoreFunctions},evidence:[specific references]}]}. Signals are booleans and must cover original Step 9.5 criteria; unknown facts must remain explicit in openQuestions/risks, never infer approval. All descriptive fields are non-empty strings. Do not claim review or tests beyond supplied evidence, write files, dispatch reviewers/providers, approve specs or start development.'},signal),64*1024);
    need(!signal.aborted,'cancelled');
    shape(details,['evidenceDigest','deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline','designRisk']);
    need(details.evidenceDigest===evidenceDigest,'prd_summary_binding');
    for(const field of ['deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline'])
      need(typeof details[field]==='string'&&details[field].trim(),'prd_summary_details_invalid');
    need(Array.isArray(details.designRisk)&&details.designRisk.length===evidence.features.length,'prd_summary_risk_coverage');
    const seen=new Set(),blockers=[];
    for(const risk of details.designRisk){
      shape(risk,['feature','signals','evidence']);shape(risk.signals,requiredSignals);
      const feature=evidence.features.find(item=>item.directory===risk.feature);
      need(feature&&!seen.has(risk.feature)&&requiredSignals.every(key=>typeof risk.signals[key]==='boolean')
        &&Array.isArray(risk.evidence)&&risk.evidence.length&&risk.evidence.every(item=>typeof item==='string'&&item.trim()),'prd_summary_risk_invalid');seen.add(risk.feature);
      const {design,split}=feature.reviews;
      if(split.gate.outcome!=='completed'||split.verdict==='blocked')blockers.push(`${risk.feature}: split_review_disposition_required`);
      if(Object.values(risk.signals).some(Boolean)){
        if(design.gate.outcome!=='completed'||design.verdict==='blocked')blockers.push(`${risk.feature}: design_review_disposition_required`);
      }else if(!['dispatch_once','completed'].includes(design.gate.outcome)||design.verdict==='blocked')
        blockers.push(`${risk.feature}: existing_design_attempt_unresolved`);
    }
    if(evidence.mechanical.status==='failed')blockers.push('mechanical_self_check_failed');
    need(digest(inspectPrdSummaryEvidence(specs))===evidenceDigest,'prd_summary_inputs_changed');
    const checklist=['跨feature产物不重复','依赖完整且无环','AC可验证','功能粒度合规且每feature≤15任务',
      '开放问题和敏感决策已经人工确认','交付形态符合需求','存在原型时功能与交互覆盖完整'];
    const totals=evidence.mechanical.features.reduce((sum,item)=>({tasks:sum.tasks+item.tasks,
      acceptanceCriteria:sum.acceptanceCriteria+item.acceptanceCriteria}),{tasks:0,acceptanceCriteria:0});
    const summary=json({status:'human_summary_prepared',evidenceDigest,details,features:evidence.features,totals,
      mechanicalSelfCheck:evidence.mechanical,blockers,checklist:checklist.map(text=>({text,checked:false})),
      specFiles:evidence.specFiles,publicationInput:evidence.evidenceFiles,readyForAwaitingReview:blockers.length===0,
      next:'human_review_then_explicit_cm_ai',completionAuthorized:false},1024*1024);
    return json({...summary,summaryDigest:digest(summary)},1024*1024);
  };
}
