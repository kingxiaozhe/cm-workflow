import {verificationFailure,verificationFailureCode,bindVerificationDiagnostic} from './review-verification-diagnostic.mjs';
import {readReviewVerification} from './review-verification-contract.mjs';
import {createReviewVerificationSession,assertVerificationIsolation,validateReviewVerificationInputs} from './review-verification.mjs';
import {ConfigError,loadConfig,resolveProtectedRuntimes} from '../../../scripts/cm-workflow-config.mjs';
import {selectExternalModels} from '../cm-ai/external-models.mjs';
import {readExecutionPolicy} from '../cm-ai/execution-policy.mjs';
import {createNativeUsageLog} from '../cm-ai/native-usage-log.mjs';
// Shared fix-specific diagnostics, authorities and lazy provider adapters.
import {fileURLToPath} from 'node:url';
import {codexWorker,preflightMatches} from '../cm-ai/worker-codex.mjs';
import {claudeWorker,claudePreflightMatches} from '../cm-ai/worker-claude.mjs';
import {createClaudeReviewRun} from '../cm-ai/claude-review-adapter.mjs';
import {createCauseReviewRun,createCodexReviewRun} from '../cm-ai/codex-review-adapter.mjs';
import {createHostReviewAuthority} from '../cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from './final-review.mjs';
import {digest,id,json,need} from '../cm-ai/effect-contract.mjs';

const DEFAULT_REVIEW_TIMEOUT_MS=900000;
export function createFixReviewHost({codeProject,hostContextId,runtime:hostRuntime='codex',reviewRuntime,review=null,permissions=[],workerFactory=null,externalModels=null,executionPolicy=null,specsDir=null,verification=null}){
  id(hostContextId);need(['codex','claude'].includes(hostRuntime),'invalid_runtime');
  if(reviewRuntime!==undefined)need(['codex','claude'].includes(reviewRuntime),'invalid_runtime');
  const runtime=reviewRuntime??hostRuntime;
  if(verification!==null){verification=readReviewVerification(verification);need(runtime==='claude','review_verification_provider');assertVerificationIsolation();}
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  // Explicit selection is bound to declared roles; absence preserves old runs.
  const assertRoute=()=>{
    if(reviewRuntime===undefined)return;
    let route;
    try{route=resolveProtectedRuntimes(loadConfig({projectRoot:codeProject}),hostRuntime);}
    catch(error){if(error instanceof ConfigError)need(false,'invalid_workflow_config');throw error;}
    need(route.coderRuntime===hostRuntime&&route.reviewerRuntime===runtime,'fix_review_runtime_mismatch');
  };
  assertRoute();
  const policy=executionPolicy===null?null:readExecutionPolicy(executionPolicy);
  const allowed=new Set(json(permissions)),config=review===null?null:json(review);
  const pair=externalModels?selectExternalModels(externalModels,[runtime]).providers[runtime]:null;
  need(!pair||!config||(config.model===pair.model&&config.effort===pair.effort),'external_model_pair_conflict');
  const matches=runtime==='claude'?claudePreflightMatches:preflightMatches;
  const worker=workerFactory??(runtime==='claude'?claudeWorker:codexWorker);
  need(runtime!=='claude'||!config||config.disabledSkills.length===0,'invalid_review_config');
  const enabled=['--allow-cause-review','--allow-final-review','--allow-test-author','--allow-repair'].some(flag=>allowed.has(flag));
  need(!(enabled||reviewRuntime!==undefined||verification!==null)||config!==null,'review_configuration_required');
  // Review transport budget from the review configuration (outside its
  // authorized digest), shared by the worker and the owner's review watchdog.
  const timeoutMs=config?.timeoutMs??DEFAULT_REVIEW_TIMEOUT_MS;
  const workerOptions=config?{cwd:codeProject,model:config.model,...(pair?{effort:pair.effort}:{}),disabledSkills:config.disabledSkills,
    promptTransport:'stdin',preflight:config.preflight,timeoutMs,...(verification?{verification}:{}),
    schemaPath:fileURLToPath(new URL('../cm-ai/review-result.schema.json',import.meta.url))}:null;
  const assertReviewReady=reviewPackage=>{assertRoute();need(config&&matches(config.preflight,workerOptions),'tool_preflight_missing');
    if(verification&&reviewPackage)validateReviewVerificationInputs({codeProject,configuration:verification,reviewPackage});};
  if(enabled||reviewRuntime!==undefined)assertReviewReady();
  const reviewer=config?{reviewerId:'fix-cause-reviewer',adapterId:`${runtime}-cause-review-adapter`,provider:runtime,
    requestedModel:config.model,contextId:'fix-cause-review-context',excludedThreadIds:[],
    workerConfigurationDigest:digest({cwd:codeProject,model:config.model,...(pair?{effort:pair.effort}:{}),disabledSkills:config.disabledSkills,
      promptTransport:'stdin',...(runtime==='claude'?{runtime}:{}),...(verification?{verification}:{}),...(policy?{executionPolicy:policy}:{})})}:null;
  const authorityFor=(reviewer,permission)=>createHostReviewAuthority({hostContextId,
    reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>allowed.has(permission)?{status:'approved'}:{status:'denied',code:'permission_denied'}});
  const authority=config?authorityFor(reviewer,'--allow-cause-review'):null;
  const finalAuthority=config?authorityFor(fixFinalReviewConfiguration({hostContextId,causeReview:reviewer}).reviewer,'--allow-final-review'):null;
  const runVerifiedReview=async(request,control,cause)=>{
    assertReviewReady();
    let session=null,providerThreadId=null,log=null,usage={usage_state:'unavailable'},result,phase='snapshot';
    const failure=error=>({status:'failed',code:verificationFailureCode(error),verificationDiagnostic:session
      ?session.diagnostic(providerThreadId,error,phase)
      :bindVerificationDiagnostic(verificationFailure({phase,code:verificationFailureCode(error)}),{request,configuration:verification,providerThreadId})});
    try{
      if(verification)session=createReviewVerificationSession({codeProject,configuration:verification,request});
      phase='worker';
      const native=worker({...workerOptions,...(session?{verificationTransport:session.transport}:{}),...(policy?{onUsage:value=>{usage=value;},onUsageClaim:()=>{
        log??=createNativeUsageLog({definition:{codeProject,specsDir,feature:request.identity.feature??'fix'},request,provider:runtime,role:'reviewer',workflow:'cm-fix'});log.claimed();
      }}:{})});
      const wrapped=session?async(input,inner)=>{
        need(input.prompt.includes('Use no tools and do not execute code.')||input.prompt.includes('No tools or follow-up fetches.'),'review_verification_prompt_contract');
        const prompt=input.prompt.replaceAll('Use no tools and do not execute code.','Use only the isolated cm_review verification tools.')
          .replace('No tools or follow-up fetches.','Only registered isolated verification tools are available.')+session.prompt;
        const answer=await native({prompt},{...inner,onEvent:event=>{
          if(event.event==='thread.started')providerThreadId=event.provider_thread;return inner.onEvent(event);
        }});
        if(answer.status==='succeeded'){
          phase='finish';const evidence=session.finish(providerThreadId);
          phase='callback';need(typeof control.onVerification==='function','review_verification_callback_failed');
          need(control.onVerification(evidence)!==false,'review_verification_callback_failed');
        }
        return answer;
      }:native;
      result=await (cause?createCauseReviewRun(wrapped,runtime,policy):(runtime==='claude'?createClaudeReviewRun:createCodexReviewRun)(wrapped,policy))(request,control);
    }catch(error){
      result=failure(error);
    }finally{
      let cleaned=false;try{await session?.close();cleaned=true;}catch(error){phase='cleanup';result=failure(error);}
      finally{log?.complete(usage,control.signal.aborted?'cancelled':cleaned&&result?.status==='succeeded'?'success':'error');}
    }
    return result;
  };
  const runReview=(request,control,cause)=>{
    assertReviewReady();
    if(verification)return runVerifiedReview(request,control,cause);
    // Retain the legacy synchronous validation and lazy worker contract.
    let log=null,usage={usage_state:'unavailable'},result;
    const native=worker({...workerOptions,...(policy?{onUsage:value=>{usage=value;},onUsageClaim:()=>{
      log??=createNativeUsageLog({definition:{codeProject,specsDir,feature:request.identity.feature??'fix'},request,provider:runtime,role:'reviewer',workflow:'cm-fix'});log.claimed();
    }}:{})});
    const complete=()=>log?.complete(usage,control.signal.aborted?'cancelled':result?.status==='succeeded'?'success':'error');
    try{
      const pending=(cause?createCauseReviewRun(native,runtime,policy):(runtime==='claude'?createClaudeReviewRun:createCodexReviewRun)(native,policy))(request,control);
      if(!policy)return pending;
      return Promise.resolve(pending).then(value=>{result=value;return value;}).finally(complete);
    }catch(error){complete();throw error;}
  };
  return {reviewer,authority,finalAuthority,execution:{assertReviewReady,
    ...(config?{causeReview:{authorize:authority.authorize,timeoutMs,
      run:(request,control)=>runReview(request,control,true)},
      finalReview:{authorize:finalAuthority.authorize,timeoutMs,run:(request,control)=>
        runReview(request,control,false)}}:{})}};
}
