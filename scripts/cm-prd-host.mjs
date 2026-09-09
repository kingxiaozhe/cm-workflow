#!/usr/bin/env node
// Current conversation transport; original platform adapter owns log locking.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectCmPrdAdmission} from './cm-prd-entry.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {runPrdHostReview,validatePrdReviewMode} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {createPrdDispositionOwner} from '../runtime/js/cm-prd/review-disposition.mjs';
import {savePrdDraft,savePrdDesign,savePrdPromotedDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {createPrdCorrectionOwner,inspectPrdCorrectionRecovery,resumePrdCorrection} from '../runtime/js/cm-prd/review-correction.mjs';
import {createPrdSummaryOwner,publishPrdAwaitingReview} from '../runtime/js/cm-prd/summary.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {need,shape,json,id,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {createPrdChange,assertPrdReviewsSettled} from '../runtime/js/cm-prd/change.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  let bridge,analysis,session,change=null,started=false,closed=false,record;
  try{
    if(argv.length===1&&argv[0]==='--help'){
      output.write('New and --change SELECTOR share this host. --session prd-ID resumes a durable local conversation; obtain runId from status. resume {requestId,operation,resolution:null|{callId,requestDigest,result,evidence}} consumes only the original host result, never re-dispatches an unknown call. decision {requestId,operation,proposalDigest,approved,allowUserCaseChanges} confirms an exact change proposal; save_draft archives and writes awaiting_review. prepare_revision {requestId,operation,reason} revises the saved current batch with original review history retained; no review counters reset.\n');
      output.write('promote_design {requestId,operation,draftDigest,reason} moves an unreviewed full draft to design while preserving draft and self-check rounds. Saved drafts require complete exact original bytes with private permissions; partial/conflicting saves, prior review and exhausted rounds are rejected. Saved task revisions archive both versions before replacement; no approval is implied.\n');
      output.write('select_design_reviews {requestId,operation,draftDigest,risks:[{feature,signals,evidence}]} at design_ready freezes host-reported Step 9.5 risks for every feature. Only high-risk features may request design review; low-risk exact saved designs continue without it. Not approval; existing attempts cannot be downgraded.\n');
      output.write('plan_design {requestId,operation,text} generates requirements/design only. design_ready permits save_design with --allow-spec-write and original design review. After original design disposition, advance generates tasks from the exact current design, then original self-check/save_draft. No approval is implied.\n');
      output.write('Optional --allow-spec-write enables save_draft and publish_summary. prepare_summary is read-only; publish_summary {requestId,operation,summaryDigest} requires the exact current prepared summary and writes awaiting_review only, then stops execution. --allow-disposition-write enables original disposition receipts. correct_findings requires both spec and review writes. None grants provider access or specification approval.\n');
      output.write('Optional --allow-review-write --host-context ACTUAL_AUTHOR_ID enables final_review {requestId,operation,stage,feature,mode:independent|self-degraded}. This permits original claim/r1 writes only; the trusted host must have actual review-channel authority. No provider authorization is implied. Interrupted attempts remain unknown and are not retried.\n');
      output.write('cm-prd-host.mjs serve --skill-dir PATH --project PATH --specs PATH --runtime codex|claude --allow-log-write [--cases PATH] [--change SELECTOR] [--session prd-ID]\nJSONL start/advance {requestId,operation,text}; status/cancel/resume. Conversations and pending requests persist privately under specs/.reviews/prd-sessions, never in global log bodies. No provider calls, approval or development.\n');return 0;
    }
    need(argv[0]==='serve'&&argv.filter(x=>x==='--allow-log-write').length===1,'invalid_arguments');
    const reviewEnabled=argv.includes('--allow-review-write');
    const dispositionEnabled=argv.includes('--allow-disposition-write');
    const specWriteEnabled=argv.includes('--allow-spec-write');
    need(argv.filter(x=>x==='--allow-spec-write').length<=1,'invalid_arguments');
    need(argv.filter(x=>x==='--allow-disposition-write').length<=1,'invalid_arguments');
    need(argv.filter(x=>x==='--allow-review-write').length<=1,'invalid_arguments');
    const args=argv.slice(1).filter(x=>!['--allow-log-write','--allow-review-write','--allow-disposition-write','--allow-spec-write'].includes(x)),options={};
    for(let i=0;i<args.length;i+=2){
      need(['--skill-dir','--project','--specs','--runtime','--cases','--host-context','--change','--session'].includes(args[i])
        &&!Object.hasOwn(options,args[i])&&typeof args[i+1]==='string','invalid_arguments');
      options[args[i]]=args[i+1];
    }
    const runtime=options['--runtime'];need(['codex','claude'].includes(runtime),'invalid_runtime');
    const authorContextId=options['--host-context']??null;
    if(authorContextId!==null)id(authorContextId);if(reviewEnabled)need(authorContextId!==null,'prd_review_host_context_required');
    const entry={skillDir:options['--skill-dir'],project:options['--project'],specs:options['--specs'],
      ...(options['--change']?{change:options['--change']} : {}),
      ...(options['--cases']?{cases:options['--cases']}:{})};
    const admission=inspectCmPrdAdmission(entry);
    need(admission.status==='ready'||options['--session']&&admission.mode==='change'&&admission.reason==='feature_missing','prd_admission_blocked');
    need(fileURLToPath(import.meta.url)===path.join(admission.workflowRoot,'scripts/cm-prd-host.mjs'),'entry_path_invalid');
    const runId=options['--session']??`prd-${randomUUID()}`;let routeTurn=0;
    session=openPrdSession({specs:admission.specs,sessionId:runId,identity:{entry,runtime}});
    if(admission.status!=='ready')need(session.state.checkpoint?.change?.stage==='awaiting_review'
      ||session.state.active?.request.operation==='save_draft','prd_admission_blocked');
    record=({event,phase='analysis',data={},at=null})=>{
      if(event==='decision')data={...data,analysis_turn:++routeTurn};
      const result=spawnSync('python3',[path.join(admission.workflowRoot,'scripts/cm-log-event.py'),
        '--workflow','cm-prd','--event',event,'--phase',phase,'--runtime',runtime,
        '--project-root',admission.project,'--specs-dir',admission.specs,'--run-id',runId,
        '--detail','Current conversation PRD workflow','--data-json',JSON.stringify(data),...(at?['--at',at]:[])],
      {env:process.env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      need(!result.error&&result.status===0&&result.signal===null,'prd_log_failed');
      const receipt=JSON.parse(result.stdout);
      need(receipt.run_id===runId&&receipt.project_log===path.join(admission.specs,'运行日志.jsonl'),'prd_log_failed');
    };
    bridge=createHostToolBridge({responseLimit:1024*1024});
    const call=(kind,payload,signal)=>session.call(kind,payload,signal,(body,sig)=>bridge.call(kind,body,sig));
    const restoreAnalysis=restored=>admission.mode==='new'?createCmPrdAnalysis({input:entry,runtime,record,restored,
      checkContext:(payload,signal)=>call('prd_self_check',payload,signal),
      generate:(payload,signal)=>call('prd_generate',payload,signal),
      processMaterials:(payload,signal)=>call('prd_materials',payload,signal),
      analyze:(payload,signal)=>call('prd_analyze',payload,signal)}):null;
    const restoreChange=(restored=null,selected,reason)=>createPrdChange({admission,runtime,call,restored,...(selected?{selected,reason}:{})});
    let reviewState=null;const reviewController=new AbortController();
    let summaryState=null,publishedSummary=false;
    const summarize=createPrdSummaryOwner({summarize:(payload,signal)=>call('prd_summary',{
      ...payload,project:admission.project,analysis:analysis.status(),
      reference:path.join(admission.workflowRoot,'skills/cm-prd/SKILL.md')},signal)});
    const makeCorrect=()=>createPrdCorrectionOwner({correct:(payload,signal)=>call('prd_correct',{
      ...payload,project:admission.project,specs:admission.specs,
      reference:path.join(admission.workflowRoot,'skills/cm-prd/SKILL.md')},signal)});
    let correct=makeCorrect(),replaying=false;
    const dispose=createPrdDispositionOwner({canRecoverRecorded:()=>replaying&&session.state.active.calls.some(call=>call.kind==='prd_self_check'&&Object.hasOwn(call,'result')),
      checkContext:(payload,signal)=>call('prd_self_check',{
      ...payload,project:admission.project,specs:admission.specs,
      reference:path.join(admission.workflowRoot,'skills/cm-prd/references/spec-self-check.md')},signal)});
    const restore=value=>{
      correct=makeCorrect();
      analysis=restoreAnalysis(value?.analysis??null);
      change=value?.change?restoreChange(value.change):admission.mode==='change'?restoreChange():null;
      started=value?.started??false;routeTurn=value?.routeTurn??0;reviewState=value?.reviewState??null;
      summaryState=value?.summaryState??null;publishedSummary=value?.publishedSummary??false;
    };
    const contextStartedAt=new Date().toISOString();
    const stored=session.state,cancelled=stored.checkpoint?.analysis?.stage==='cancelled'||stored.checkpoint?.change?.stage==='cancelled';
    restore(cancelled?stored.checkpoint:stored.active?.before??stored.checkpoint);
    const contextCompletedAt=new Date().toISOString();let contextLogged=false;
    const checkpoint=()=>({analysis:analysis?.checkpoint()??null,change:change?.checkpoint()??null,started,routeTurn,reviewState,summaryState,publishedSummary});
    const status=()=>({...change?.status()??analysis.status(),runId,logWriteEnabled:true,reviewState,summaryState,publishedSummary,
      recovery:session.state.active?{request:session.state.active.request,calls:session.state.active.calls.map(({callId,requestDigest,kind,result})=>
        ({callId,requestDigest,kind,status:result===undefined?'unknown':'recorded'}))}:null});
    const handle=async raw=>{
      const request=json(raw);
      need(['start','advance','plan_design','promote_design','select_design_reviews','status','cancel','final_review_package','final_review','review_findings','review_disposition','save_draft','save_design','correct_findings','prepare_summary','publish_summary','inspect_correction','resume_correction','prepare_revision','decision'].includes(request.operation),'host_operation_invalid');
      shape(request,['requestId','operation',...(['start','advance','plan_design'].includes(request.operation)?['text']:
        ['final_review_package','review_findings','correct_findings','inspect_correction','resume_correction'].includes(request.operation)?['stage','feature']:
          request.operation==='review_disposition'?['stage','feature','packageDigest','decisions','artifacts']:
          request.operation==='publish_summary'?['summaryDigest']:request.operation==='select_design_reviews'?['draftDigest','risks']:
          request.operation==='promote_design'?['draftDigest','reason']:request.operation==='prepare_revision'?['reason']:
          request.operation==='decision'?['proposalDigest','approved','allowUserCaseChanges']:
          request.operation==='final_review'?['stage','feature','mode']:[])]);
      if(request.operation==='status')return status();
      if(request.operation==='cancel'){analysis?.cancel();change?.cancel();reviewController.abort();return status();}
      if(request.operation==='inspect_correction')return inspectPrdCorrectionRecovery({specs:admission.specs,stage:request.stage,feature:request.feature});
      if(request.operation==='prepare_revision'){
        need(change===null&&analysis!==null&&typeof request.reason==='string'&&request.reason.trim(),'prd_revision_not_ready');
        const selected=analysis.status().draft?.features.map(feature=>feature.directory);need(selected?.length,'prd_revision_no_saved_draft');
        assertPrdReviewsSettled(admission.specs,selected,{requireSplit:true});change=restoreChange(null,selected,request.reason);
        publishedSummary=false;summaryState=null;return status();
      }
      if(change!==null){
        if(request.operation==='decision')return change.confirm(request);
        if(request.operation==='save_draft'){
          const result=change.save(specWriteEnabled);for(const phase of ['changed','awaiting_review'])record({event:'spec_lifecycle',phase,data:{feature_count:result.features.length}});
          publishedSummary=true;return result;
        }
        need(['start','advance'].includes(request.operation)&&!publishedSummary,'prd_change_operation_invalid');
        need(request.operation==='start'?!started:started,'prd_turn_not_ready');
        if(!started){record({event:'run_start'});started=true;}return change.advance(request.text,reviewController.signal);
      }
      need(!publishedSummary,'prd_human_review_required');
      if(request.operation==='promote_design')return analysis.promoteDesign({draftDigest:request.draftDigest,reason:request.reason});
      if(request.operation==='select_design_reviews')return analysis.selectDesignReviews({draftDigest:request.draftDigest,risks:request.risks});
      if(request.operation==='resume_correction')return resumePrdCorrection({specs:admission.specs,stage:request.stage,
        feature:request.feature,writeEnabled:specWriteEnabled&&reviewEnabled},reviewController.signal);
      if(request.operation==='prepare_summary'){
        need(started,'prd_turn_not_ready');summaryState=await summarize(admission.specs,reviewController.signal);return summaryState;
      }
      if(request.operation==='publish_summary'){
        need(summaryState!==null&&summaryState.summaryDigest===request.summaryDigest,'prd_summary_not_ready');
        need(!reviewController.signal.aborted,'cancelled');
        const result=publishPrdAwaitingReview({specs:admission.specs,summary:summaryState,writeEnabled:specWriteEnabled,recover:replaying});
        // Even an uncertain status write must not be silently retried.
        publishedSummary=true;
        if(result.status==='awaiting_review')for(const phase of ['generated','awaiting_review'])
          record({event:'spec_lifecycle',phase,data:{feature_count:result.features.length,task_count:summaryState.totals.tasks}});
        return result;
      }
      if(request.operation==='save_draft')return (analysis.status().designPromotion?.saved===true?savePrdPromotedDraft:savePrdDraft)({specs:admission.specs,
        writeEnabled:specWriteEnabled,getDraft:()=>analysis.currentDraftForSave(),getOriginal:()=>analysis.originalPromotedDraft()});
      if(request.operation==='save_design')return savePrdDesign({specs:admission.specs,
        writeEnabled:specWriteEnabled,getDraft:()=>analysis.currentDesignForSave()});
      if(request.operation==='correct_findings'){
        if(replaying&&fs.existsSync(path.join(admission.specs,`.reviews/prd-${request.feature.replace(/^\d+\./,'')}-${request.stage}-correction.md`)))
          return resumePrdCorrection({specs:admission.specs,stage:request.stage,feature:request.feature,writeEnabled:specWriteEnabled&&reviewEnabled},reviewController.signal);
        return correct({specs:admission.specs,stage:request.stage,feature:request.feature,writeEnabled:specWriteEnabled&&reviewEnabled},reviewController.signal);
      }
      if(request.operation==='review_findings')return inspectPrdFindings({specs:admission.specs,stage:request.stage,feature:request.feature});
      if(request.operation==='review_disposition')return dispose({specs:admission.specs,
        stage:request.stage,feature:request.feature,packageDigest:request.packageDigest,
        decisions:request.decisions,artifacts:request.artifacts,writeEnabled:dispositionEnabled},reviewController.signal);
      if(request.operation==='final_review_package')return analysis.prepareReview(request.stage,request.feature);
      if(request.operation==='final_review'){
        need(reviewEnabled,'prd_review_not_enabled');
        const prepared=analysis.prepareReview(request.stage,request.feature);
        reviewState={status:'reviewing',feature:request.feature,stage:request.stage};
        reviewState=await runPrdHostReview({specs:admission.specs,prepared,authorContextId,writeEnabled:reviewEnabled,
          mode:request.mode,signal:reviewController.signal,revalidate:()=>analysis.prepareReview(request.stage,request.feature),
          review:(payload,signal)=>call('prd_review',{...payload,project:admission.project,specs:admission.specs,
            reference:path.join(admission.workflowRoot,'runtime/steelman-review.md')},signal)});
        return status();
      }
      need(request.operation==='start'?!started:started,'prd_turn_not_ready');
      need(typeof request.text==='string'&&request.text.trim().length>0,'prd_input_invalid');
      if(!started){record({event:'run_start'});started=true;}
      if(request.operation==='plan_design'||analysis.status().stage==='awaiting_design_user'){
        const planned=await analysis.plan(request.text,{designOnly:true});return {...status(),planningReply:planned.planningReply};
      }
      if(analysis.status().stage==='draft_ready')return {...await analysis.verify(),runId,logWriteEnabled:true};
      if(['analysis_ready','design_ready','awaiting_planning_user','draft_self_check_failed','self_check_failed'].includes(analysis.status().stage)){
        const planned=await analysis.plan(request.text);return {...status(),planningReply:planned.planningReply};
      }
      await analysis.advance(request.text);return status();
    };
    const phaseFor=request=>{
      const stage=change?.status().stage??analysis?.status().stage;
      if(request.operation==='final_review')return request.stage==='design'?['prd-design-review','design_review']:['prd-spec-review','spec_review'];
      if(['review_disposition','correct_findings'].includes(request.operation))return request.stage==='design'?['prd-design-review','design_review']:['prd-spec-review','spec_review'];
      if(['save_draft','decision'].includes(request.operation)&&change)return ['prd-spec-validation','spec_validation'];
      if(!['start','advance','plan_design'].includes(request.operation))return null;
      if(['ready','awaiting_user'].includes(stage))return ['prd-requirements','requirements_analysis'];
      if(stage==='change_requirements')return ['prd-requirements','requirements_analysis'];
      if(stage==='change_design'||request.operation==='plan_design'||stage==='awaiting_design_user')return ['prd-design','design_generation'];
      if(['draft_ready','change_check'].includes(stage))return ['prd-spec-validation','spec_validation'];
      return ['prd-task-split','task_split'];
    };
    const host={handle:async request=>{
      if(request.operation==='status')return status();
      if(request.operation==='cancel'){const value=await handle(request);session.checkpoint(checkpoint());return value;}
      if(request.operation==='inspect_correction')return handle(request);
      let operation=request;
      if(request.operation==='resume'){
        shape(request,['requestId','operation','resolution']);
        need(!reviewController.signal.aborted&&session.state.checkpoint?.analysis?.stage!=='cancelled'
          &&session.state.checkpoint?.change?.stage!=='cancelled','cancelled');
        if(request.resolution!==null)session.resolve(request.resolution);
        const active=session.replay();
        need(active.calls.every(call=>Object.hasOwn(call,'result')),'prd_host_result_unknown');
        restore(active.before);operation=active.request;replaying=true;
        // Claim-first review recovery publishes the recorded ORIGINAL result through
        // the existing owner. It must not try to claim or dispatch a second review.
        if(operation.operation==='final_review'&&active.calls.length){
          need(reviewEnabled,'prd_review_not_enabled');const original=active.calls.find(call=>call.kind==='prd_review');
          const prepared=analysis.prepareReview(operation.stage,operation.feature);
          need(prepared.packageDigest===original.payload.package.packageDigest,'prd_review_inputs_changed');
          validatePrdReviewMode(operation.mode,original.result);
          reviewState={status:'review_recorded',...publishPrdReview({specs:admission.specs,reviewPackage:prepared.reviewPackage,
            packageDigest:prepared.packageDigest,authorContextId:original.payload.authorContextId,response:original.result})};
          session.commit(checkpoint());return status();
        }
      }else{replaying=false;session.begin(request,checkpoint());}
      if(!contextLogged){
        const segment=session.segment('context_load');
        record({event:'progress',phase:'start',at:contextStartedAt,data:{operation_id:'prd-context',phase_name:'context_load',segment}});
        record({event:'progress',phase:'complete',at:contextCompletedAt,data:{operation_id:'prd-context',phase_name:'context_load',segment,outcome:'completed'}});
        contextLogged=true;
      }
      const phase=phaseFor(operation),phases=phase?[phase]:[];
      // The accepted full-draft host contract coalesces three outputs in one call.
      // Preserve that efficient contract; report overlapping spans explicitly,
      // never invent per-section clocks or sum them as exclusive elapsed time.
      if(!change&&['advance'].includes(operation.operation)&&['analysis_ready','awaiting_planning_user','draft_self_check_failed','self_check_failed'].includes(analysis.status().stage))
        phases.push(['prd-requirements','requirements_analysis'],['prd-design','design_generation']);
      const segments=phases.map(([operation_id,phase_name])=>({operation_id,phase_name,segment:session.segment(phase_name),
        ...(phases.length>1?{timing_scope:'combined_host_call'}:{})}));
      for(const data of segments)record({event:'progress',phase:'start',data});
      try{
        const result=await handle(operation);
        const pending=session.state.active.calls.some(call=>!Object.hasOwn(call,'result'))
          ||result.status?.includes('unknown')===true||result.reviewState?.status?.includes('unknown')===true
          ||result.reviewState?.gate?.outcome==='dispatch_unknown';
        if(!pending)session.commit(checkpoint());
        for(const data of segments)record({event:'progress',phase:'complete',data:{...data,
          outcome:pending?'blocked':/awaiting|question|confirmation/.test(change?.status().stage??analysis?.status().stage)?'awaiting_input':'completed'}});
        return result;
      }catch(cause){
        for(const data of segments)record({event:'progress',phase:'complete',data:{...data,outcome:'blocked'}});
        if(reviewController.signal.aborted)return status();
        if(!session.state.active.calls.some(call=>!Object.hasOwn(call,'result'))&&session.state.active.calls.length===0)
          session.commit(checkpoint());
        throw cause;
      }
    }};
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host,input,output,toolBridge:bridge,inputLimit:1024*1024});}finally{if(rawMode)input.setRawMode(false);}
    if(started){
      const stage=change?.status().stage??analysis.status().stage;
      closed=true; // An uncertain terminal log write must not be automatically repeated.
      record({event:'run_done',data:{outcome:stage==='cancelled'?'cancelled':stage==='blocked'?'blocked':'incomplete'}});
    }
    return 0;
  }catch(cause){
    if(started&&!closed&&record)try{closed=true;record({event:'run_done',data:{outcome:'incomplete'}});}catch{}
    error.write(JSON.stringify({error:{code:cause?.code??'prd_host_failed'}})+'\n');return 1;
  }finally{bridge?.close();session?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
