// Shared fix-specific diagnostics, authorities and lazy provider adapters.
import {fileURLToPath} from 'node:url';
import {codexWorker,preflightMatches} from '../cm-ai/worker-codex.mjs';
import {claudeWorker,claudePreflightMatches} from '../cm-ai/worker-claude.mjs';
import {createClaudeReviewRun} from '../cm-ai/claude-review-adapter.mjs';
import {createCauseReviewRun,createCodexReviewRun} from '../cm-ai/codex-review-adapter.mjs';
import {createHostReviewAuthority} from '../cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from './final-review.mjs';
import {digest,id,json,need} from '../cm-ai/effect-contract.mjs';

export function createFixReviewHost({codeProject,hostContextId,runtime='codex',review=null,permissions=[],workerFactory=null}){
  id(hostContextId);need(['codex','claude'].includes(runtime),'invalid_runtime');
  const allowed=new Set(json(permissions)),config=review===null?null:json(review);
  const matches=runtime==='claude'?claudePreflightMatches:preflightMatches;
  const worker=workerFactory??(runtime==='claude'?claudeWorker:codexWorker);
  need(runtime!=='claude'||!config||config.disabledSkills.length===0,'invalid_review_config');
  const enabled=['--allow-cause-review','--allow-final-review','--allow-test-author','--allow-repair'].some(flag=>allowed.has(flag));
  need(!enabled||config!==null,'review_configuration_required');
  const workerOptions=config?{cwd:codeProject,model:config.model,disabledSkills:config.disabledSkills,
    promptTransport:'stdin',preflight:config.preflight,
    schemaPath:fileURLToPath(new URL('../cm-ai/review-result.schema.json',import.meta.url))}:null;
  const assertReviewReady=()=>need(config&&matches(config.preflight,workerOptions),'tool_preflight_missing');
  if(enabled)assertReviewReady();
  const reviewer=config?{reviewerId:'fix-cause-reviewer',adapterId:`${runtime}-cause-review-adapter`,provider:runtime,
    requestedModel:config.model,contextId:'fix-cause-review-context',excludedThreadIds:[],
    workerConfigurationDigest:digest({cwd:codeProject,model:config.model,disabledSkills:config.disabledSkills,
      promptTransport:'stdin',...(runtime==='claude'?{runtime}:{})})}:null;
  const authorityFor=(reviewer,permission)=>createHostReviewAuthority({hostContextId,
    reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>allowed.has(permission)?{status:'approved'}:{status:'denied',code:'permission_denied'}});
  const authority=config?authorityFor(reviewer,'--allow-cause-review'):null;
  const finalAuthority=config?authorityFor(fixFinalReviewConfiguration({hostContextId,causeReview:reviewer}).reviewer,'--allow-final-review'):null;
  return {reviewer,authority,finalAuthority,execution:{assertReviewReady,
    ...(config?{causeReview:{authorize:authority.authorize,
      run:(request,control)=>createCauseReviewRun(worker(workerOptions),runtime)(request,control)},
      finalReview:{authorize:finalAuthority.authorize,run:(request,control)=>
        (runtime==='claude'?createClaudeReviewRun:createCodexReviewRun)(worker(workerOptions))(request,control)}}:{})}};
}
