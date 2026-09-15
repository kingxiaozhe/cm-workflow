// Read-only handoff to the separate cm-fix lifecycle. Never a dispatch grant.
import path from 'node:path';
import {loadConfig} from '../../../scripts/cm-workflow-config.mjs';
import {inspectCmAiQaFailure,readCmAiQaFailureHistory} from './cm-ai-qa-log.mjs';
import {readReviewSourceFiles} from './review-package.mjs';
import {digest,freeze,need,shape} from './effect-contract.mjs';

export function readHostQaFixHandoff(input){
  return readHandoff(input,inspectCmAiQaFailure);
}

export function readHostQaFixHistory(input){
  return readHandoff(input,readCmAiQaFailureHistory);
}

function readHandoff(input,inspectFailure){
  shape(input,['specsDir','codeProject','feature','identity','packageDigest','testRunId']);
  const {codeProject,...binding}=input;
  const failure=inspectFailure(binding);
  const config=loadConfig({projectRoot:codeProject}),policy=config.policies.auto_fix;
  need(['never','explicit','auto'].includes(policy),'qa_fix_policy_unavailable');
  const relative=path.relative(input.specsDir,failure.report).split(path.sep).join('/');
  const [{contentBase64,...reportEvidence}]=readReviewSourceFiles(input.specsDir,[relative]);
  const exhausted=failure.qaRound>=3;
  const value={version:1,kind:'cm-qa-fix-handoff',policy,policyDigest:digest(config),
    status:exhausted||policy==='never'?'blocked':policy==='explicit'?'authorization_required':'dispatch_required',
    reason:exhausted?'qa_round_limit':policy==='never'?'auto_fix_disabled':policy==='explicit'?'fix_authorization_required':'fix_dispatch_required',
    source:{...failure,reportEvidence},execution:'not_started'};
  return freeze({...value,handoffDigest:digest(value)});
}
