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
export function createFixReviewHost({codeProject,hostContextId,runtime='codex',review=null,permissions=[],workerFactory=null,externalModels=null,executionPolicy=null,specsDir=null}){
  id(hostContextId);need(['codex','claude'].includes(runtime),'invalid_runtime');
  const policy=executionPolicy===null?null:readExecutionPolicy(executionPolicy);
  const allowed=new Set(json(permissions)),config=review===null?null:json(review);
  const pair=externalModels?selectExternalModels(externalModels,[runtime]).providers[runtime]:null;
  need(!pair||!config||(config.model===pair.model&&config.effort===pair.effort),'external_model_pair_conflict');
  const matches=runtime==='claude'?claudePreflightMatches:preflightMatches;
  const worker=workerFactory??(runtime==='claude'?claudeWorker:codexWorker);
  need(runtime!=='claude'||!config||config.disabledSkills.length===0,'invalid_review_config');
  const enabled=['--allow-cause-review','--allow-final-review','--allow-test-author','--allow-repair'].some(flag=>allowed.has(flag));
  need(!enabled||config!==null,'review_configuration_required');
  // Review transport budget from the review configuration (outside its
  // authorized digest), shared by the worker and the owner's review watchdog.
  const timeoutMs=config?.timeoutMs??DEFAULT_REVIEW_TIMEOUT_MS;
  const workerOptions=config?{cwd:codeProject,model:config.model,...(pair?{effort:pair.effort}:{}),disabledSkills:config.disabledSkills,
    promptTransport:'stdin',preflight:config.preflight,timeoutMs,
    schemaPath:fileURLToPath(new URL('../cm-ai/review-result.schema.json',import.meta.url))}:null;
  const assertReviewReady=()=>need(config&&matches(config.preflight,workerOptions),'tool_preflight_missing');
  if(enabled)assertReviewReady();
  const reviewer=config?{reviewerId:'fix-cause-reviewer',adapterId:`${runtime}-cause-review-adapter`,provider:runtime,
    requestedModel:config.model,contextId:'fix-cause-review-context',excludedThreadIds:[],
    workerConfigurationDigest:digest({cwd:codeProject,model:config.model,...(pair?{effort:pair.effort}:{}),disabledSkills:config.disabledSkills,
      promptTransport:'stdin',...(runtime==='claude'?{runtime}:{}),...(policy?{executionPolicy:policy}:{})})}:null;
  const authorityFor=(reviewer,permission)=>createHostReviewAuthority({hostContextId,
    reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>allowed.has(permission)?{status:'approved'}:{status:'denied',code:'permission_denied'}});
  const authority=config?authorityFor(reviewer,'--allow-cause-review'):null;
  const finalAuthority=config?authorityFor(fixFinalReviewConfiguration({hostContextId,causeReview:reviewer}).reviewer,'--allow-final-review'):null;
  const runReview=(request,control,cause)=>{
    let log=null,usage={usage_state:'unavailable'},result;
    const native=worker({...workerOptions,...(policy?{onUsage:value=>{usage=value;},onUsageClaim:()=>{
      log??=createNativeUsageLog({definition:{codeProject,specsDir,feature:request.identity.feature??'fix'},request,provider:runtime,role:'reviewer',workflow:'cm-fix'});
      log.claimed();
    }}: {})});
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
