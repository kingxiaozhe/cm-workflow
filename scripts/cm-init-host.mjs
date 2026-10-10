#!/usr/bin/env node
// One local conversation: host-owned rule edits are separately launch-authorized.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectCmInitAdmission,generateCmInitRules} from './cm-init-entry.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {need,shape,json,digest,id} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewResultForPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {publishCmInitReviewEvidence,loadCmInitRecoveryDraft} from '../runtime/js/cm-init/review-evidence.mjs';
import {inspectCmInitDraft,readCmInitSource} from '../runtime/js/cm-init/draft-inspection.mjs';
import {inspectCmInitProjectAnalysis} from '../runtime/js/cm-init/project-analysis.mjs';
import {validateCmInitSelection} from '../runtime/js/cm-init/draft-generation.mjs';
import {openDraftSession,MAX_CALL_ABANDONS} from '../runtime/js/cm-idea/session.mjs';
import {legacyInitBindings} from '../runtime/js/policy-binding-compat.mjs';

const STEP_KINDS={ready:'init_generate',analysis_ready:'init_generate',draft_generated:'init_verify',
  confirmation_required:'init_confirm',review_required:'init_review'};
// Chinese next steps for a blocked draft (R4). Presentation only, never authority.
export function initRecoveryGuidance({stage,pending,abandoned,retry,packageDigest}){
  const used=kind=>abandoned.filter(item=>item.kind===kind).length;
  const draft=packageDigest?`--resume-draft ${packageDigest}`:'--resume-draft <packageDigest>';
  if(pending?.writing||['write_unknown','write_incomplete'].includes(stage))return {summary:'规则写入结果未知或只写了一部分，会话模式下 resume 会报 idea_save_outcome_unknown。',
    nextStep:`不要重发 init_write。先运行 cm-init-entry.mjs --inspect-recovery ${packageDigest??'<packageDigest>'} 逐文件比对；然后去掉 --session-file，在启动参数末尾加 ${draft}：全部一致停在 rules_present，部分写入回到已审草稿续写（重新核验、确认、独立审查），冲突报 init_recovery_conflict 交人。`,
    authorizationGranted:false};
  const call=pending?.call;
  if(call){const left=MAX_CALL_ABANDONS-used(call.kind),person=call.kind==='init_confirm';
    if(call.status==='unknown')return {summary:`${call.kind} 的应答没有拿到（超时、断开或宿主退出）。`,
      nextStep:`有原回执就 resume 交回；没有就 resume {resolution:{callId,requestDigest,abandon:true,evidence}} 作废后${person?'重新问当前用户':'重问'}（本会话 ${call.kind} 还可 ${left} 次）。迟到的旧答复一律不用。`,authorizationGranted:false};
    return {summary:`${call.kind} 的应答已记录。`,
      nextStep:`resume {resolution:null} 消费原结果；若宿主拒收（stderr diagnostic 的码），用 {callId,requestDigest,discard:true,evidence} 作废后${person?'重新问当前用户':'重问'}（还可 ${left} 次）。`,authorizationGranted:false};}
  if(stage==='failed'&&retry)return {summary:`${retry.kind} 没有拿到合格应答（超时、校验不过或断开）。`,
    nextStep:retry.remaining>0?`再发一次 ${retry.operation} 重问，还可 ${retry.remaining} 次。内存模式下宿主退出就只能从头开始，需要可恢复请改用 --session-file。`
      :'本进程重问次数已用完（init_retry_limit）；交人处理，或改用 --session-file 重新开始。',authorizationGranted:false};
  return null;
}

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  let bridge,session;
  try{
    if(argv.length===1&&argv[0]==='--help'){
      output.write('Optional trailing --session-file ABS_JSON enables private 0600 pre-archive checkpoints and original call results. Restart with the same project/Skill/file, status first, resume {resolution:null} for recorded results; unknown calls require original {callId,requestDigest,result,evidence}, never redispatch. Requires actual --host-context on each launch. Default remains memory-only. Cancel persists. This is not write authority; --allow-write must be granted on the current launch. Unknown writes require the existing archived-draft recovery, not session replay. Cannot combine with --resume-draft.\n');
      output.write('After verification_blocked, review_changes_requested or review_blocked, explicit prepare_revision with the complete documents array replaces the in-memory draft within the same paths and unchanged disk baseline. It clears current verification/confirmation/review and restarts at draft_generated. Prior findings remain in revisionHistory and the next review package. No automatic retry, file write, scope change or completion authority.\n');
      output.write('For first-time analysis, send {requestId,operation:"start"} in ready. init_analyze returns {status:"analyzed",selection:{versionControl,modules,analysis,runtimes?},evidence,noGitDecision} or {status:"blocked",reason}. noGitDecision is explicit_user_refusal for none, otherwise null. These are host attestations, not proof or Git authority. In analysis_ready send advance without selection to generate. Existing advance with pre-analyzed selection remains supported.\n');
      output.write('Optional --allow-write after --host-context ID permits one init_write host request only after the draft review approves and originals still match. The host edits only the fixed reviewed paths; JS reads back every target. Partial/unknown writes stop without retry or rollback. A private immutable .reviews/cm-init-<packageDigest>.md archive is saved before init_write; conflicts or archives over 256 KiB block writing. The archive is not a write result or completion receipt. rules_written does not complete a task; append --resume-draft DIGEST to load an archived draft without regeneration. Conflicts refuse startup. Partial drafts require fresh verification, confirmation when needed and independent review; --allow-write remains required. Only changed targets are dispatched. All-matching drafts stop at rules_present, not task completion. This is draft recovery, not replay of unknown in-flight calls.\n');
      output.write('Optional --host-context ID binds the actual author context and is required for review. In review_required, advance requests init_review from the trusted host; it must return an actual independent reviewer result. The shared review result validator checks package/coverage/findings. Approval only reaches reviewed_draft, not completion or write authority. No provider dispatch authorization is implied.\n');
      output.write('final_review_package is read-only in review_required: fixed draft, original constraints, host verification and confirmation, exact paths and package digest. It is not a registered V3 receipt and neither dispatches a reviewer nor authorizes completion.\n');
      output.write('Recovery (V1/V7): with --session-file, resume {resolution:{callId,requestDigest,discard:true,evidence}} discards a recorded answer the host refused and {callId,requestDigest,abandon:true,evidence} abandons an unknown analyze/generate/verify/confirm/review call; both ask again under the same pending request with a fresh callId (init_confirm asks the current user again), keep append-only abandonedCalls, 2 per kind per session. init_write is never re-asked: use --inspect-recovery and --resume-draft. Without --session-file a failed step may be re-sent twice in the same process; a dead memory-only host starts over.\n');
      output.write('cm-init-host.mjs serve --skill-dir PATH --project PATH\nOne local draft via existing JSONL host bridge: advance with selection {versionControl,modules,analysis,runtimes?}, then advance without selection for init_verify and, only when required, init_confirm. Status and cancel remain available. Replies use host_result with exact sessionId/callId/requestDigest. Confirmation must convey the explicit current user decision; approval only reaches independent review. Verification is a current-host report, not independent review. No provider or task-completion authority; project writes require --allow-write and the reviewed-draft stage. Host results retain the shared 64 KiB limit.\n');return 0;
    }
    const sessionFile=argv.at(-2)==='--session-file'?argv.at(-1):null;
    if(sessionFile!==null)argv=argv.slice(0,-2);
    const resumeDigest=argv.at(-2)==='--resume-draft'?argv.at(-1):null;
    need(sessionFile===null||resumeDigest===null,'init_recovery_modes_conflict');
    if(resumeDigest!==null)argv=argv.slice(0,-2);
    const recoveryOrigin=resumeDigest===null?null:{packageDigest:resumeDigest,resumptionId:randomUUID()};
    need([5,7,8].includes(argv.length)&&argv[0]==='serve'&&argv[1]==='--skill-dir'&&argv[3]==='--project','invalid_arguments');
    const hostContextId=argv.length>=7?argv[6]:null;
    if(hostContextId!==null){need(argv[5]==='--host-context','invalid_arguments');id(hostContextId);}
    const allowWrite=argv.length===8;
    if(allowWrite)need(argv[7]==='--allow-write','invalid_arguments');
    const request={skillDir:argv[2],project:argv[4]},admission=inspectCmInitAdmission(request);
    need(admission.status==='ready','existing_project_required');
    need(fs.realpathSync(fileURLToPath(import.meta.url))===path.join(admission.workflowRoot,'scripts/cm-init-host.mjs'),'entry_path_invalid');
    bridge=createHostToolBridge();
    const controller=new AbortController();let stage='ready',result=null,verification=null,selection=null,confirmation=null,review=null,writeResult=null,reviewPackage=null,reviewEvidence=null,analysisResult=null;
    const revisionHistory=[],retries={};let failedStep=null;
    let authorContexts=hostContextId===null?[]:[hostContextId];
    const snapshot=()=>({stage,result,verification,selection,confirmation,review,writeResult,reviewPackage,reviewEvidence,analysisResult,revisionHistory,authorContexts,authorContextId:hostContextId});
    const restore=state=>{
      ({stage,result,verification,selection,confirmation,review,writeResult,reviewPackage,reviewEvidence,analysisResult}=state);
      revisionHistory.splice(0,revisionHistory.length,...state.revisionHistory);
      authorContexts=[...new Set([...state.authorContexts,...(hostContextId===null?[]:[hostContextId])])];
    };
    if(sessionFile!==null){
      need(hostContextId!==null,'init_session_host_context_required');
      const policyFiles=['skills/cm-init/SKILL.md','skills/cm-init/references/js-host.md',
        ...fs.readdirSync(path.join(admission.workflowRoot,'templates/rules')).filter(name=>name.endsWith('.md')).sort().map(name=>'templates/rules/'+name)];
      const policy=policyFiles.map(file=>[file,readCmInitSource(admission.workflowRoot,file)?.toString('utf8')??null]);
      session=openDraftSession(sessionFile,{project:admission.project,workflowRoot:admission.workflowRoot,policyDigest:digest(policy)},'cm-init',
        {legacyBindings:legacyInitBindings({project:admission.project,workflowRoot:admission.workflowRoot,files:policy})});
      if(session.state.checkpoint)restore(session.state.checkpoint);
      if(session.state.cancelled){stage='cancelled';controller.abort();}
    }
    const call=(kind,payload,signal)=>session?session.call(kind,payload,signal,(body,abort)=>bridge.call(kind,body,abort)):bridge.call(kind,payload,signal);
    if(resumeDigest!==null){
      const restored=loadCmInitRecoveryDraft({project:admission.project,packageDigest:resumeDigest});
      // V6: a conflict goes to a person with the per-file comparison, never as a new delivery.
      if(restored.report.status==='conflict'){
        error.write(JSON.stringify({diagnostic:'init_recovery_conflict',files:restored.report.files.map(({path,status})=>({path,status})),
          guidance:'这些文件既不是原文也不是已审草稿（conflict）：逐个核对是谁改的；保留用户改动，不覆盖、不回滚、不删档。处理后先用 cm-init-entry.mjs --inspect-recovery 复核，再决定续写或重新初始化。'})+'\n');
        need(false,'init_recovery_conflict');
      }
      need(restored.inspection.status==='structurally_checked','init_draft_structural_failure');
      selection=restored.selection;
      result={status:'draft_generated',documents:restored.documents,inspection:restored.inspection,
        recovery:restored.report,writeAuthorized:false};
      stage=restored.report.status==='matches_reviewed_draft'?'rules_present':'draft_generated';
    }
    const current=()=>{
      const inspection=inspectCmInitDraft({project:admission.project,documents:result.documents,selection});
      need(inspection.status==='structurally_checked','init_draft_structural_failure');
      need(digest(inspection.changes)===digest(result.inspection.changes),'init_verification_project_changed');
    };
    const retryInfo=()=>failedStep&&!session?{...failedStep,remaining:MAX_CALL_ABANDONS-(retries[failedStep.kind]??0)}:null;
    const guidance=()=>initRecoveryGuidance({stage,retry:retryInfo(),abandoned:session?.abandonedCalls??[],
      pending:session?.state.pending?{writing:session.state.pending.writing,call:session.state.pending.call?{kind:session.state.pending.call.kind,
        status:Object.hasOwn(session.state.pending.call,'result')?'recorded':'unknown'}:null}:null,
      packageDigest:writeResult?.packageDigest??reviewPackage?.packageDigest??null});
    const handle=async raw=>{
      const message=json(raw);need(['start','advance','status','cancel','final_review_package','prepare_revision'].includes(message.operation),'host_operation_invalid');
      // V1 without --session-file: nothing was recorded for a failed step, so the
      // same operation may be sent again from the stage before it, twice per kind.
      if(stage==='failed'&&failedStep&&!session&&['start','advance'].includes(message.operation)){
        need(message.operation===failedStep.operation,'init_generation_already_started');
        need((retries[failedStep.kind]??0)<MAX_CALL_ABANDONS,'init_retry_limit');
        retries[failedStep.kind]=(retries[failedStep.kind]??0)+1;stage=failedStep.priorStage;failedStep=null;
      }
      const priorStage=stage,failedKind=message.operation==='start'?'init_analyze':STEP_KINDS[stage];
      const fail=cause=>{stage=controller.signal.aborted?'cancelled':'failed';
        if(stage==='failed'&&failedKind&&['start','advance'].includes(message.operation))failedStep={operation:message.operation,priorStage,kind:failedKind};
        throw cause;};
      shape(message,message.operation==='prepare_revision'?['requestId','operation','documents']:
        message.operation==='advance'&&stage==='ready'?['requestId','operation','selection']:['requestId','operation']);
      if(message.operation==='status'){const advice=guidance(),retry=retryInfo();
        return {stage,result,analysisResult,verification,confirmation,review,writeResult,reviewEvidence,revisionHistory,writeAuthorized:false,
          ...(retry?{retry}:{}),...(advice?{guidance:advice}:{})};}
      if(message.operation==='prepare_revision'){
        need(['verification_blocked','review_changes_requested','review_blocked'].includes(stage),'init_revision_not_ready');
        current();
        const documents=message.documents;
        need(Array.isArray(documents)&&documents.length===result.documents.length
          &&documents.every(document=>result.documents.some(prior=>prior.path===document?.path)),'init_revision_scope_changed');
        const inspection=inspectCmInitDraft({project:admission.project,documents,selection});
        need(inspection.status==='structurally_checked','init_draft_structural_failure');
        revisionHistory.push({draftDigest:digest(result.documents),verification,confirmation,review});
        result={...result,documents,inspection,status:'draft_generated'};
        verification=null;confirmation=null;review=null;reviewPackage=null;reviewEvidence=null;
        stage='draft_generated';
        return {stage,revision:revisionHistory.length,writeAuthorized:false,independentReviewRequired:true};
      }
      if(message.operation==='start'){
        need(stage==='ready','init_analysis_already_started');stage='analyzing';
        try{
          const observations=inspectCmInitProjectAnalysis({project:admission.project});
          const response=json(await call('init_analyze',{project:admission.project,observations,
            instructions:'Read current project evidence including non-Node/subproject manifests, README, CI, configs and existing rules. Determine actual stack, commands, modules and version control; root observations are not a complete analysis. Do not execute unsafe commands, install, write, dispatch providers or create Git. If no Git, obtain the actual user choice; none requires explicit refusal of Git, while Git creation requires separate authorization outside this analysis. Report missing evidence as blocked. Return selection and concise evidence, no secrets.'},controller.signal));
          need(!controller.signal.aborted,'cancelled');
          if(response.status==='blocked'){
            shape(response,['status','reason']);need(typeof response.reason==='string'&&response.reason.trim().length>0,'init_analysis_invalid');
            analysisResult={source:'current_host_report',...response};stage='analysis_blocked';
          }else{
            shape(response,['status','selection','evidence','noGitDecision']);
            need(response.status==='analyzed'&&typeof response.evidence==='string'&&response.evidence.trim().length>0,'init_analysis_invalid');
            selection=validateCmInitSelection(response.selection);
            need(selection.versionControl==='none'?response.noGitDecision==='explicit_user_refusal':response.noGitDecision===null,'init_analysis_git_choice_required');
            need(digest(observations)===digest(inspectCmInitProjectAnalysis({project:admission.project})),'init_analysis_project_changed');
            analysisResult={source:'current_host_report',observations,...response};stage='analysis_ready';
          }
          return {stage,analysisResult,writeAuthorized:false};
        }catch(cause){fail(cause);}
      }
      if(message.operation==='final_review_package'){
        need(stage==='review_required','init_review_not_ready');current();
        const originals=result.documents.map(document=>{
          const bytes=readCmInitSource(admission.project,document.path);
          const sha256=bytes===null?null:createHash('sha256').update(bytes).digest('hex');
          need(sha256===result.inspection.changes.find(change=>change.path===document.path).beforeSha256,
            'init_review_original_changed');
          const content=bytes===null?null:bytes.toString('utf8');
          need(bytes===null||Buffer.from(content,'utf8').equals(bytes),'init_review_text_encoding_invalid');
          return {path:document.path,content,sha256};
        });
        current();
        const body={version:1,kind:'cm-init-draft-review-package',project:admission.project,
          ...(revisionHistory.length?{revisionHistory}:{}),
          ...(analysisResult?{analysisResult}:{}),
          ...(recoveryOrigin?{recoveryOrigin}:{}),
          selection,documents:result.documents,originals,verification,confirmation,
          examinedPaths:result.documents.map(document=>document.path).sort(),
          boundaries:['Review the complete proposed rules and original constraints, not only the host summary.',
            'Host verification and user confirmation do not establish independent review.',
            'This is draft material, not a V3 registered receipt or permission to write.']};
        return {package:{...body,packageDigest:digest(body)},independentReviewRequired:true,writeAuthorized:false};
      }
      if(message.operation==='cancel'){
        if(['ready','analyzing','analysis_ready','generating','draft_generated','verifying','confirmation_required','confirming','review_required','reviewing','reviewed_draft','writing'].includes(stage)){controller.abort();stage='cancelled';}
        return {stage,writeAuthorized:false};
      }
      if(stage==='reviewed_draft'){
        need(allowWrite,'init_write_authorization_required');current();
        session?.writing();
        reviewEvidence=publishCmInitReviewEvidence({project:admission.project,reviewPackage,review});
        const inspectWritten=()=>result.inspection.changes.map(change=>{
          try{
            const bytes=readCmInitSource(admission.project,change.path);
            const actual=bytes===null?null:createHash('sha256').update(bytes).digest('hex');
            return {path:change.path,status:actual===change.afterSha256?'written':actual===change.beforeSha256?'unchanged':'conflict',sha256:actual};
          }catch{return {path:change.path,status:'unreadable',sha256:null};}
        });
        stage='writing';
        try{
          const expected=result.inspection.changes.filter(change=>change.action!=='unchanged');
          const response=json(await call('init_write',{project:admission.project,
            documents:result.documents.filter(document=>expected.some(change=>change.path===document.path)),expected,review,confirmation,
            instructions:'Write only these reviewed documents using current-host editing tools. Recheck expected original bytes before each edit; preserve other files and user changes. Stop on conflict or partial failure, do not retry or roll back blindly. This authorizes no install, provider, Git or task-completion action.'},controller.signal));
          need(!controller.signal.aborted,'cancelled');shape(response,['status']);
          need(['written','blocked'].includes(response.status),'init_write_result_invalid');
          const files=inspectWritten();
          writeResult={source:'current_host_write_and_disk_readback',files,packageDigest:review.packageDigest};
          stage=response.status==='written'&&files.every(file=>file.status==='written')?'rules_written':'write_incomplete';
          return {stage,writeResult,completionAuthorized:false};
        }catch(cause){
          writeResult={source:'disk_readback_after_unknown_write',files:inspectWritten(),packageDigest:review.packageDigest};
          stage='write_unknown';throw cause;
        }
      }
      if(stage==='review_required'){
        need(hostContextId!==null,'init_review_host_context_required');
        const {package:pkg}=await handle({requestId:message.requestId,operation:'final_review_package'});
        stage='reviewing';
        try{
          const authorContextId=session?.state.pending?.call?.kind==='init_review'?session.state.checkpoint.authorContextId:hostContextId;
          const response=json(await call('init_review',{package:pkg,authorContextId,
            instructions:'Use an actual fresh independent reviewer in the authorized host environment. Verify the real context and return its unchanged result with reviewer/independent/at/scope binding. Do not self-review, invent an execution, install tools or invoke a provider without separate authorization.'},controller.signal));
          need(!controller.signal.aborted,'cancelled');current();
          shape(response,['reviewer','contextId','independent','at','result']);id(response.contextId);
          need(['codex-subagent','codex-cli','claude-cli'].includes(response.reviewer)
            &&response.independent===true&&!authorContexts.includes(response.contextId),'init_review_independence_required');
          need(typeof response.at==='string'&&Number.isFinite(Date.parse(response.at))
            &&new Date(response.at).toISOString()===response.at,'init_review_timestamp_invalid');
          const checked=reviewResultForPaths(response.result,pkg,pkg.examinedPaths);
          review={source:'current_host_review_attestation',packageDigest:pkg.packageDigest,
            reviewer:response.reviewer,contextId:response.contextId,independent:true,at:response.at,result:checked};
          reviewPackage=pkg;
          stage=checked.verdict==='approved'?'reviewed_draft':checked.verdict==='changes_requested'?'review_changes_requested':'review_blocked';
          return {stage,review,writeAuthorized:false,completionAuthorized:false};
        }catch(cause){fail(cause);}
      }
      if(stage==='confirmation_required'){
        stage='confirming';
        try{
          current();
          const changes=verification.constraintChanges.map(file=>({path:file,
            before:readCmInitSource(admission.project,file).toString('utf8'),
            after:result.documents.find(document=>document.path===file).content}));
          const payload={project:admission.project,draftDigest:verification.draftDigest,changes,
            instructions:'Show the actual original/proposed constraints to the current user and ask for approval. Return only the explicit current user decision. Silence, a model opinion or previous generic approval is not consent. This does not authorize writing or replace independent review.'};
          const response=json(await call('init_confirm',payload,controller.signal));
          need(!controller.signal.aborted,'cancelled');current();
          shape(response,['decision']);need(['approved','rejected'].includes(response.decision),'init_confirmation_invalid');
          confirmation={source:'current_host_user_decision',draftDigest:verification.draftDigest,
            paths:[...verification.constraintChanges],decision:response.decision};
          stage=response.decision==='approved'?'review_required':'confirmation_rejected';
          return {stage,confirmation,independentReviewRequired:true,writeAuthorized:false};
        }catch(cause){fail(cause);}
      }
      if(stage==='draft_generated'){
        stage='verifying';
        try{
          current();
          const categories=['commands','globs','file_references','constraint_preservation','rule_applicability'];
          const payload={project:admission.project,selection,documents:result.documents,inspection:result.inspection,categories,
            instructions:'Check every assertion against project evidence. Do not execute unsafe commands, write files or dispatch providers. Report unverified honestly. Constraint changes require separate human confirmation; this is not independent review.'};
          const response=json(await call('init_verify',payload,controller.signal));
          need(!controller.signal.aborted,'cancelled');current();
          shape(response,['checks','constraintChanges']);shape(response.checks,categories);
          for(const check of Object.values(response.checks)){
            shape(check,['status','evidence']);
            need(['verified','not_applicable','unverified','failed'].includes(check.status)
              &&typeof check.evidence==='string'&&check.evidence.trim().length>0,'init_verification_result_invalid');
          }
          need(Array.isArray(response.constraintChanges)&&new Set(response.constraintChanges).size===response.constraintChanges.length
            &&response.constraintChanges.every(file=>result.inspection.existingChangeReviewRequired.includes(file)),
          'init_verification_result_invalid');
          verification={draftDigest:digest(result.documents),source:'current_host_report',...response};
          stage=Object.values(response.checks).some(check=>['unverified','failed'].includes(check.status))?'verification_blocked'
            :response.constraintChanges.length?'confirmation_required':'review_required';
          return {stage,verification,independentReviewRequired:true,writeAuthorized:false};
        }catch(cause){fail(cause);}
      }
      need(['ready','analysis_ready'].includes(stage),'init_generation_already_started');
      if(stage==='analysis_ready')need(digest(analysisResult.observations)===digest(inspectCmInitProjectAnalysis({project:admission.project})),'init_analysis_project_changed');
      const selected=stage==='analysis_ready'?selection:message.selection;stage='generating';
      try{
        selection=validateCmInitSelection(selected);
        result=await generateCmInitRules(request,selection,{signal:controller.signal,
          generate:(payload,signal)=>call('init_generate',payload,signal)});
        stage=result.status;return result;
      }catch(cause){fail(cause);}
    };
    const host={handle:async raw=>{
      if(!session)return handle(raw);
      if(raw.operation==='status'){
        const pending=session.state.pending,record=pending?.call;
        return {...await handle(raw),sessionFile,recovery:pending?{operation:pending.request.operation,writing:pending.writing,
          call:record?{kind:record.kind,callId:record.callId,requestDigest:record.requestDigest,status:Object.hasOwn(record,'result')?'recorded':'unknown'}:null}:null};
      }
      if(raw.operation==='cancel'){
        shape(raw,['requestId','operation']);stage='cancelled';session.cancel(snapshot());controller.abort();
        return {stage,writeAuthorized:false};
      }
      if(raw.operation==='final_review_package')return handle(raw);
      need(!controller.signal.aborted,'cancelled');
      let message=raw;
      if(raw.operation==='resume'){
        shape(raw,['requestId','operation','resolution']);
        const reask=raw.resolution?.discard===true||raw.resolution?.abandon===true;
        if(reask)session.abandonCall(raw.resolution);
        message=session.resume(reask?null:raw.resolution);
        if(message===null)return host.handle({requestId:raw.requestId,operation:'status'});
        restore(session.state.checkpoint);
      }else session.begin(raw,snapshot());
      try{const value=await handle(message);session.commit(snapshot());return value;}
      catch(cause){
        if(!session.state.cancelled&&session.state.pending?.call===null&&!session.state.pending.writing){
          restore(session.state.checkpoint);session.commit(snapshot());
        }
        throw cause;
      }
    }};
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';
    if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host,input,output,toolBridge:bridge});}
    finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){
    error.write(JSON.stringify({error:{code:typeof cause?.code==='string'?cause.code:'init_host_failed'}})+'\n');return 1;
  }finally{bridge?.close();session?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
