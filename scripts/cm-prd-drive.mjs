#!/usr/bin/env node
// cm-prd 单步驾驶员。请求表从 cm-prd-host.mjs handle/dispatch 与其接线推导；
// host-session.mjs operationNames 是以下操作的传输允许集，不表示其它工作流操作属于 PRD。
// operation                         possible host_request kinds (proving route)
// start/advance (new ready)         prd_materials, prd_analyze; analysis.mjs advance -> processMaterials/analyze.
// start/advance (new analysis_ready, design_ready, awaiting_planning_user,
//   awaiting_design_user, draft_self_check_failed, self_check_failed)
//                                   prd_generate; analysis.mjs plan -> generate.
// advance (new draft_ready)         prd_self_check; analysis.mjs verify -> checkContext.
// start/advance (--change ready/awaiting_user) prd_analyze; change.mjs advance -> invoke.
// advance (--change change_requirements/change_design/change_tasks/change_check_failed)
//                                   prd_generate; change.mjs advance -> invoke.
// advance (--change change_check)   prd_self_check; change.mjs advance -> invoke.
// final_review                      prd_review; cm-prd-host.mjs final_review -> review-host.mjs.
// correct_findings                  prd_correct; cm-prd-host.mjs -> review-correction.mjs.
// review_disposition                prd_self_check only for changed split artifacts;
//                                   review-disposition.mjs performs mechanical checks itself, then checkContext.
// prepare_summary                   prd_summary; cm-prd-host.mjs -> summary.mjs.
// resume                            original pending kind only; cm-prd-host.mjs dispatch -> session.replay.
// plan_design follows the new analysis plan route; same prd_generate kind (analysis.mjs plan).
// status/read_batch/cancel/replace_inputs/promote_design/select_design_reviews/
// final_review_package/review_findings/save_draft/save_design/publish_summary/
// inspect_correction/resume_correction/prepare_revision/decision: none; cm-prd-host.mjs handle/dispatch.
// prd_materials needs PDF/browser observation; this driver has no such runner and refuses it.
// prd_self_check evidence comes from actual PLAN.contextChecks commands, never a static evidence file.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {inspectCmPrdAdmission,inspectCmPrdSources} from './cm-prd-entry.mjs';
import {loadConfig} from './cm-workflow-config.mjs';
import {inspectPrdDraft,inspectPrdDesignDraft,nextPrdFeatureIndex,prdFeatureInventory} from '../runtime/js/cm-prd/draft.mjs';
import {inspectPrdChangeSnapshot,inspectPrdChangeProposal} from '../runtime/js/cm-prd/change.mjs';
import {checkPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {inspectPrdDispositionPlan} from '../runtime/js/cm-prd/disposition-plan.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readCmInitSource} from '../runtime/js/cm-init/draft-inspection.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {inspectPrdSummaryEvidence} from '../runtime/js/cm-prd/summary.mjs';
import {prdDesignRiskSignals} from '../runtime/js/cm-prd/design-risk.mjs';
import {reviewResultForPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-prd-host.mjs',import.meta.url));
const SKILL=fileURLToPath(new URL('../skills/cm-prd',import.meta.url));
const KNOWN=new Set(['start','advance','plan_design','promote_design','select_design_reviews','status','cancel',
  'final_review_package','final_review','review_findings','review_disposition','save_draft','save_design',
  'correct_findings','prepare_summary','publish_summary','inspect_correction','resume_correction',
  'prepare_revision','decision','resume','read_batch','replace_inputs']);
const FILES={prd_analyze:'analyze.json',prd_generate:'generate.json',prd_review:'review.json',
  prd_correct:'correct.json',prd_summary:'summary.json'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const fail=(label,code)=>stop(2,`${label}: ${code}`);
const check=(ok,label)=>{if(!ok)fail('答案格式错误',label);};
const exact=(v,keys,label)=>check(object(v)&&Object.keys(v).every(k=>keys.includes(k)),label);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sessionFile=(specs,id)=>path.join(specs,'.reviews','prd-sessions',id,'state.json');
function load(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-prd-drive.mjs --plan PLAN.json <operation>\nPLAN: project, specs, runtime, session, change, cases, permissions, answers, request, contextChecks。路径相对 PLAN；session 用于继续同一批次。\n');process.exit(0);
  }
  const {operation,plan,base}=loadPlanFile({name:'cm-prd-drive.mjs',known:KNOWN});
  requireFields(plan,['project','specs']);
  const resolve=v=>path.resolve(base,v);
  const project=resolve(plan.project),specs=resolve(plan.specs),runtime=plan.runtime??'codex';
  if(!['codex','claude'].includes(runtime))stop(2,'runtime 只能是 codex 或 claude');
  if(plan.session!==undefined&&!/^prd-[a-zA-Z0-9-]{1,80}$/.test(plan.session))stop(2,'session 格式错误');
  const entry={skillDir:SKILL,project,specs,...(plan.change?{change:plan.change}:{}),...(plan.cases?{cases:resolve(plan.cases)}:{})};
  let admission,sources=null,config;
  try{admission=inspectCmPrdAdmission(entry);config=loadConfig({projectRoot:project});
    if(admission.mode==='new'&&admission.status==='ready')sources=inspectCmPrdSources(entry);}
  catch(e){fail('准入或配置无效',e.code??e.message);}
  if(admission.status!=='ready'&&!(plan.session&&admission.mode==='change'&&admission.reason==='feature_missing'))
    fail('准入失败',admission.reason??admission.status);
  if(!Array.isArray(plan.permissions??[])||!(plan.permissions??[]).every(p=>['--allow-spec-write','--allow-review-write','--allow-disposition-write'].includes(p)))
    stop(2,'permissions 只能包含宿主支持的写入开关');
  if(new Set(plan.permissions??[]).size!==(plan.permissions??[]).length)stop(2,'permissions 不可重复');
  if(plan.predecessor&&!fs.existsSync(resolve(plan.predecessor)))stop(2,`predecessor 文件不存在: ${resolve(plan.predecessor)}`);
  if(plan.permissions?.includes('--allow-review-write')&&!nonempty(plan.hostContext))stop(2,'--allow-review-write 需要 hostContext');
  if(['save_draft','save_design','publish_summary','resume_correction','correct_findings'].includes(operation)
    &&!plan.permissions?.includes('--allow-spec-write'))stop(2,`${operation} 需要 --allow-spec-write`);
  if(operation==='final_review'&&!plan.permissions?.includes('--allow-review-write'))stop(2,'final_review 需要 --allow-review-write');
  if(operation==='review_disposition'&&!plan.permissions?.includes('--allow-disposition-write'))stop(2,'review_disposition 需要 --allow-disposition-write');
  if(['correct_findings','resume_correction'].includes(operation)&&!plan.permissions?.includes('--allow-review-write'))
    stop(2,`${operation} 需要 --allow-review-write`);
  const store=plan.session?sessionFile(specs,plan.session):null;
  if(operation!=='start'&&!plan.session)stop(2,`${operation} 需要 PLAN.session（现有 runId）`);
  if(store&&!fs.existsSync(store))stop(2,`恢复存档不存在: ${store}`);
  if(operation==='start'&&store)stop(2,'start 必须创建新 session；继续请用 advance');
  const state=store?readJson(store,'恢复存档'):null;
  if(state){
    const identity=state.identity;
    if(identity?.entry?.project!==project||identity.entry.specs!==specs||identity.entry.skillDir!==SKILL
      ||identity.entry.change!==entry.change||identity.entry.cases!==entry.cases||identity.runtime!==runtime)
      stop(2,'恢复身份不匹配：project/specs/skillDir/change/cases/runtime');
    if(state.active&&operation!=='resume'&&!['status','read_batch','replace_inputs','cancel'].includes(operation))
      stop(2,`待恢复操作 ${state.active.request.operation}：先用 resume`);
    if(operation==='resume'&&!state.active)stop(2,'恢复存档没有待定操作');
  }
  const request=plan.request??{};
  exact(request,['text','stage','feature','mode','packageDigest','decisions','artifacts','summaryDigest','draftDigest',
    'risks','reason','proposalDigest','approved','allowUserCaseChanges','resolution','successorSpecs','successorSessionId'], 'PLAN.request');
  const needed={start:['text'],advance:['text'],plan_design:['text'],promote_design:['draftDigest','reason'],
    select_design_reviews:['draftDigest','risks'],final_review_package:['stage','feature'],final_review:['stage','feature','mode'],
    review_findings:['stage','feature'],review_disposition:['stage','feature','packageDigest','decisions','artifacts'],
    correct_findings:['stage','feature'],inspect_correction:['stage','feature'],resume_correction:['stage','feature'],
    publish_summary:['summaryDigest'],prepare_revision:['reason'],decision:['proposalDigest','approved','allowUserCaseChanges'],
    replace_inputs:['approved','reason','successorSpecs','successorSessionId']};
  for(const key of needed[operation]??[])if(!Object.hasOwn(request,key))stop(2,`${operation} 缺少 PLAN.request.${key}`);
  if(['review_disposition','correct_findings'].includes(operation)){
    let review;try{review=inspectPrdFindings({specs,stage:request.stage,feature:request.feature});}
    catch(e){fail('原审查记录无效',e.code??e.message);}
    if(operation==='review_disposition')try{inspectPrdDispositionPlan(review,request.decisions,request.artifacts);
      if(review.packageDigest!==request.packageDigest)throw Error('packageDigest 不匹配');}
    catch(e){fail('review_disposition 内容或 scope 无效',e.code??e.message);}
  }
  if(['start','advance','plan_design'].includes(operation)&&!nonempty(request.text))stop(2,`${operation} 需要非空 request.text`);
  if(operation==='resume'){
    if(!Object.hasOwn(request,'resolution'))stop(2,'resume 缺少 PLAN.request.resolution（null 或绑定的回执）');
    if(request.resolution!==null){
      const v=request.resolution;exact(v,['callId','requestDigest','result','evidence','abandon'],'resolution');
      const pending=state.active.calls.find(c=>c.callId===v.callId);
      if(!pending||pending.requestDigest!==v.requestDigest||!nonempty(v.evidence)
        ||Object.hasOwn(pending,'result')||(v.abandon===true?Object.hasOwn(v,'result'):!Object.hasOwn(v,'result')))
        stop(2,'resume 缺少有效 callId/requestDigest/result/evidence 绑定');
      if(v.abandon===true&&state.active.calls.some(c=>c.kind==='prd_review'))stop(2,'prd_review 不可 abandon');
      if(v.abandon!==true&&['prd_materials','prd_self_check'].includes(pending.kind))
        stop(2,`resume 的 ${pending.kind} 是执行证据，不能从静态 resolution.result 应答`);
    }
  }
  if(operation==='replace_inputs'){
    if(request.approved!==true||!nonempty(request.reason)||!path.isAbsolute(request.successorSpecs)
      ||!/^prd-[a-zA-Z0-9-]{1,80}$/.test(request.successorSessionId)||request.successorSessionId===plan.session)
      stop(2,'replace_inputs 缺少 approved:true、reason、绝对 successorSpecs 或新的 successorSessionId');
    try{const successor=inspectCmPrdSources({...entry,specs:request.successorSpecs});
      if(successor.status!=='ready')throw Error(successor.reason);}
    catch(e){fail('successorSpecs 无效',e.code??e.message);}
  }
  const stage=state?.checkpoint?.change?.stage??state?.checkpoint?.analysis?.stage??'ready';
  const change=admission.mode==='change'||state?.checkpoint?.change!==null&&state?.checkpoint?.change!==undefined;
  const asks=[];
  if(['start','advance','plan_design'].includes(operation)){
    if(change){
      if(['ready','awaiting_user'].includes(stage))asks.push('prd_analyze');
      else if(stage==='change_check')asks.push('prd_self_check');
      else if(['change_requirements','change_design','change_tasks','change_check_failed'].includes(stage))asks.push('prd_generate');
    }else if(operation==='plan_design'||['analysis_ready','design_ready','awaiting_planning_user','awaiting_design_user','draft_self_check_failed','self_check_failed'].includes(stage))asks.push('prd_generate');
    else if(stage==='draft_ready')asks.push('prd_self_check');
    else if(['ready','awaiting_user'].includes(stage)){if(sources?.sourceInspection?.sources.some(s=>s.format!=='text')
      ||sources?.sourceInspection?.userCases?.format!=='text'&&sources?.sourceInspection?.userCases)
      asks.push('prd_materials');asks.push('prd_analyze');}
  }
  if(operation==='final_review')asks.push('prd_review');
  if(operation==='correct_findings')asks.push('prd_correct');
  if(operation==='prepare_summary')asks.push('prd_summary');
  if(operation==='review_disposition'&&request.stage==='split'&&request.decisions.some(d=>d.status==='applied'))asks.push('prd_self_check');
  if(operation==='resume'&&request.resolution===null){
    const pending=state.active.calls.find(c=>!Object.hasOwn(c,'result'));
    if(pending)stop(2,`resume 尚缺原调用结果：${pending.kind} ${pending.callId} ${pending.requestDigest}`);
  }
  if(asks.includes('prd_materials'))stop(2,'缺少真实执行 runner: prd_materials（PDF/HTML 读取或浏览器交互）；不能从静态答案文件应答');
  const answersRoot=plan.answers?resolve(plan.answers):null;
  if(answersRoot&&fs.existsSync(path.join(answersRoot,'materials.json')))
    stop(2,'materials.json 是执行证据；不能从静态答案文件应答 prd_materials');
  const answers=preflightAnswers([...new Set(asks.filter(k=>FILES[k]))],kind=>{
    const file=path.join(answersRoot??base,FILES[kind]);const value=readJson(file,kind);
    if(value===undefined)stop(2,`步骤 ${operation} 会反问 ${kind}，但答案文件不存在: ${file}`);
    validate(kind,value,{stage,change,sources,config,specs,state,request,admission,hostContext:plan.hostContext});return value;
  });
  if(asks.includes('prd_self_check')){
    if(!Array.isArray(plan.contextChecks)||plan.contextChecks.length===0)
      stop(2,'步骤会反问 prd_self_check，但 PLAN.contextChecks 缺少真实命令列表');
    try{createHostCheck({cwd:admission.project,commands:plan.contextChecks});}
    catch(e){fail('PLAN.contextChecks 格式错误',e.code??e.message);}
    const judgements=plan.contextJudgements;
    if(!object(judgements))stop(2,'prd_self_check 缺少 PLAN.contextJudgements（逐项人工判断）');
    let draft=state?.checkpoint?.change?.proposal??state?.checkpoint?.analysis?.draft;
    if(operation==='review_disposition'){
      const documents=request.artifacts.map(item=>({path:item.path.slice(request.feature.length+1),
        content:readCmInitSource(specs,item.path)?.toString('utf8')}));
      if(documents.some(doc=>!nonempty(doc.content)))stop(2,'review_disposition 缺少已保存的 artifact 内容');
      draft={draftDigest:digest(request.artifacts),features:[{directory:request.feature,
        name:request.feature.replace(/^\d+\./,''),documents}]};
      draft.mechanicalSelfCheck=checkPrdDraftMechanics(draft);
    }
    if(!draft)stop(2,'prd_self_check 缺少当前草稿');
    for(const feature of draft.features)for(const id of draft.mechanicalSelfCheck.pending){
      const status=judgements[feature.directory]?.[id];
      if(!['passed','failed',...(id==='brownfield_references_and_B2_B3_B5_if_applicable'?['not_applicable']:[])].includes(status))
        stop(2,`PLAN.contextJudgements 缺少 ${feature.directory}.${id} 的合法判断`);
    }
    if(answersRoot&&fs.existsSync(path.join(answersRoot,'self-check.json')))
      stop(2,'self-check.json 是执行证据；不能从静态答案文件应答 prd_self_check');
  }
  return {operation,plan,base,project,specs,runtime,entry,admission,config,sources,state,request,asks,answers,answersRoot};
}
function validate(kind,value,ctx){
  if(kind==='prd_analyze'){
    if(value.status==='question'){exact(value,['status','question'],'analyze.json');check(nonempty(value.question),'analyze.json.question');}
    else if(value.status==='blocked'){exact(value,['status','reason'],'analyze.json');check(nonempty(value.reason),'analyze.json.reason');}
    else if(value.status==='analyzed'){
      exact(value,ctx.change?['status','summary','openQuestions']:['status','summary','sourcePaths','openQuestions'],'analyze.json');
      check(nonempty(value.summary)&&Array.isArray(value.openQuestions)&&value.openQuestions.every(nonempty),'analyze.json');
      if(!ctx.change){const paths=[...ctx.sources.sourceInspection.sources.map(s=>s.path),
        ...(ctx.sources.sourceInspection.userCases?[ctx.sources.sourceInspection.userCases.path]:[])].sort();
        check(Array.isArray(value.sourcePaths)&&JSON.stringify([...value.sourcePaths].sort())===JSON.stringify(paths),'analyze.json.sourcePaths');}
    }else check(false,'analyze.json.status');
  }else if(kind==='prd_generate'){
    if(value.status==='question'){exact(value,['status','question'],'generate.json');check(nonempty(value.question),'generate.json.question');}
    else if(value.status==='blocked'){exact(value,['status','reason'],'generate.json');check(nonempty(value.reason),'generate.json.reason');}
    else if(ctx.change){
      exact(value,['status','summary','features','removed'],'generate.json');
      if(ctx.stage==='change_tasks'||ctx.stage==='change_check_failed'){
        try{inspectPrdChangeProposal(inspectPrdChangeSnapshot(ctx.specs),value,ctx.state.checkpoint.change.selected,ctx.config);}
        catch(e){fail('generate.json 不符合变更草稿或 scope',e.code??e.message);}
      }else{
        check(value.status==='documents'&&nonempty(value.summary)&&Array.isArray(value.features)&&Array.isArray(value.removed),'generate.json');
        const selected=ctx.state.checkpoint.change.selected;
        for(const f of value.features){check(selected.includes(f.directory)||!fs.existsSync(path.join(ctx.specs,f.directory)),'generate.json 越过 scope');
          check(Array.isArray(f.documents)&&f.documents.every(d=>['requirements.md','design.md'].includes(d.path)&&nonempty(d.content)),'generate.json.documents');}
      }
    }else{
      exact(value,['status','summary','features','selfCheckRevisionReason'],'generate.json');
      const nextIndex=Number(ctx.state?.checkpoint?.analysis?.acceptedDesign?.features?.[0]?.directory?.split('.')[0]
        ??ctx.state?.checkpoint?.analysis?.draft?.features?.[0]?.directory?.split('.')[0]
        ??nextPrdFeatureIndex(prdFeatureInventory(ctx.specs)));
      try{if(value.status==='design')inspectPrdDesignDraft(value,{nextIndex});
        else inspectPrdDraft(value,{nextIndex,generateCases:ctx.config.policies.generate_cases,
          userCasesProvided:ctx.sources.sourceInspection.userCases!==null});}
      catch(e){fail('generate.json 不符合草稿 schema',e.code??e.message);}
    }
  }else if(kind==='prd_review'){
    exact(value,['reviewer','contextId','independent','at','result','degradedReason'],'review.json');
    check(['codex-subagent','codex-cli','self-degraded'].includes(value.reviewer)&&nonempty(value.contextId)
      &&typeof value.independent==='boolean'&&Number.isFinite(Date.parse(value.at))&&object(value.result),'review.json');
    check(ctx.request.mode==='self-degraded'?value.reviewer==='self-degraded'&&value.independent===false
      &&value.contextId===ctx.hostContext&&nonempty(value.degradedReason):
      value.reviewer!=='self-degraded'&&value.independent===true&&value.contextId!==ctx.hostContext,'review.json.mode');
    exact(value.result,['verdict','packageDigest','examinedPaths','findings','summary'],'review.json.result');
    check(['approved','changes_requested','blocked'].includes(value.result.verdict)&&hash(value.result.packageDigest)
      &&Array.isArray(value.result.examinedPaths)&&Array.isArray(value.result.findings)&&nonempty(value.result.summary),'review.json.result');
    try{const draft=ctx.request.stage==='design'?ctx.state?.checkpoint?.analysis?.designDraft:ctx.state?.checkpoint?.analysis?.draft;
      const prepared=preparePrdReview({specs:ctx.specs,draft,stage:ctx.request.stage,feature:ctx.request.feature});
      const paths=(ctx.request.stage==='design'?['requirements.md','design.md']:['requirements.md','design.md','tasks.md'])
        .map(name=>`${ctx.request.feature}/${name}`).sort();
      reviewResultForPaths(value.result,{packageDigest:prepared.packageDigest},paths);}
    catch(e){fail('review.json 与当前原审查包不匹配',e.code??e.message);}
  }else if(kind==='prd_correct'){
    exact(value,['decisions','documents'],'correct.json');
    check(Array.isArray(value.decisions)&&Array.isArray(value.documents),'correct.json');
    const review=inspectPrdFindings({specs:ctx.specs,stage:ctx.request.stage,feature:ctx.request.feature});
    check(value.documents.length===review.reviewedArtifacts.length,'correct.json 文档清单不完整');
    for(const doc of value.documents){exact(doc,['path','content'],'correct.json.documents');
      check(review.reviewedArtifacts.some(item=>item.path===doc.path)&&nonempty(doc.content),
      `correct.json 越过 scope: ${doc.path}`);}
    const artifacts=value.documents.map(doc=>({path:doc.path,sha256:createHash('sha256').update(doc.content).digest('hex')}));
    try{inspectPrdDispositionPlan(review,value.decisions,artifacts);}
    catch(e){fail('correct.json 决定或修改范围无效',e.code??e.message);}
  }else if(kind==='prd_summary'){
    exact(value,['deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline','designRisk'],'summary.json');
    for(const k of ['deliveryForm','estimatedTime','openQuestions','risks','contextScope','platformReadiness','uiBaseline'])check(nonempty(value[k]),`summary.json.${k}`);
    check(Array.isArray(value.designRisk),'summary.json.designRisk');
    for(const r of value.designRisk){exact(r,['feature','signals','evidence'],'summary.json.designRisk');
      exact(r.signals,prdDesignRiskSignals,'summary.json.signals');
      check(prdDesignRiskSignals.every(s=>typeof r.signals[s]==='boolean')&&Array.isArray(r.evidence)&&r.evidence.length>0&&r.evidence.every(nonempty),'summary.json.signals');}
    try{const currentFeatures=ctx.state?.checkpoint?.analysis?.draft?.features.map(f=>f.directory);
      const evidence=inspectPrdSummaryEvidence(ctx.specs,{currentFeatures});
      const names=evidence.features.filter(f=>!f.historical).map(f=>f.directory).sort();
      check(JSON.stringify(value.designRisk.map(r=>r.feature).sort())===JSON.stringify(names),'summary.json.designRisk 范围');}
    catch(e){fail('summary.json 或摘要输入无效',e.code??e.message);}
  }
}
let loaded;
async function answerFor(row,answers){
  const v=answers[row.kind];
  if(row.kind==='prd_materials')return null;
  if(row.kind==='prd_self_check'){
    const results=[];
    for(const command of loaded.plan.contextChecks){
      const run=createHostCheck({cwd:loaded.admission.project,commands:[command],onOutput:({stream,chunk})=>process.stderr.write(`[drive check ${command.id} ${stream}] ${chunk}`)});
      const [item]=await run({identity:{repositoryId:'prd',runId:'prd-check',taskId:'prd-check',attempt:1}},
        {signal:new AbortController().signal});
      results.push(item);if(item.outcome!=='passed')break;
    }
    const draft=row.payload.draft;const evidence=results.map(r=>`${r.id}: ${r.evidence}`);
    return {draftDigest:draft.draftDigest,features:draft.features.map(f=>({directory:f.directory,
      checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:results.every(r=>r.outcome==='passed')?
        loaded.plan.contextJudgements[f.directory][id]:'failed',evidence}))}))};
  }
  if(row.kind==='prd_review'){
    reviewResultForPaths(v.result,{packageDigest:row.payload.package.packageDigest},row.payload.examinedPaths);
    return v;
  }
  if(row.kind==='prd_summary')return {...v,evidenceDigest:row.payload.evidenceDigest};
  return v??null;
}
function main(){
  loaded=load();const {operation,plan,project,specs,runtime,request,answers}=loaded;
  const args=['serve','--skill-dir',SKILL,'--project',project,'--specs',specs,'--runtime',runtime,'--allow-log-write',
    ...(plan.cases?['--cases',path.resolve(loaded.base,plan.cases)]:[]),...(plan.change?['--change',plan.change]:[]),
    ...(plan.session?['--session',plan.session]:[]),...(plan.predecessor?['--predecessor',path.resolve(loaded.base,plan.predecessor)]:[]),
    ...(plan.hostContext?['--host-context',plan.hostContext]:[]),...(plan.permissions??[])];
  driveHost({host:HOST,args,cwd:project,operation,request,answers,paths:{answers:loaded.answersRoot},answerFor});
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main();
