import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewerSwitchBasis,readReviewerSwitch,effectiveReviewer} from '../runtime/js/cm-ai/reviewer-switch.mjs';

function fixture(){
  const identity={repositoryId:'fixture',runId:'original',taskId:'T-001',attempt:2};
  const reviewer={id:'reviewer',provider:'claude',requestedModel:'fixture-claude',adapterId:'claude-review-adapter',
    allowed:true,available:true,contexts:['review-1','review-2']};
  const requestDigest=digest('request'),packageDigest=digest('package');
  const binding={adapterId:reviewer.adapterId,invocationId:'session.4',requestDigest,identity,
    reviewerId:reviewer.id,logicalContextId:'review-2',packageDigest,hostContextId:'host'};
  const result={outcome:'failed',reconciliationRequired:false,inspection:{kind:'cm-provider-review-failure',
    category:'provider',failure:'reviewer_rate_limited',completionEligible:false,provider:'claude',
    requestedModel:reviewer.requestedModel,logicalContextId:'review-2',requestDigest,identity,providerThreadId:'physical-old'}};
  const reviewInvocation={registration:{binding,requestDigest},started:'physical-old',result};
  const state={state:'blocked',code:'review_provider_failed',attempt:2,
    reviewPackage:{identity,packageDigest},reviewInvocation,receipts:[{identity:{...identity,attempt:1}}],
    calls:[{invocationId:'session.4',channel:'host-review',terminal:'failed',provider:'claude',
      requestedModel:reviewer.requestedModel,contextId:'review-2',requestDigest,resultDigest:digest(result)}],
    cache:[{effect:{id:'review-2-retry-1',kind:'review',identity},result:{state:'blocked',code:'review_provider_failed',reviewInvocation}}]};
  const config={identity,reviewers:[reviewer],reviewInvocation:{},excludedContexts:['host'],
    developer:{provider:'codex',requestedModel:'current-session'},
    controlPolicy:{version:2,development:'conversation'}};
  const context={config,state,reviewer,pending:null,transaction:null,redispatches:1,maxRedispatches:2,switches:0,lastDigest:digest('last'),
    hostContextId:'host',sourceRevision:digest('full-original-prefix-and-fingerprints')};
  const record={...reviewerSwitchBasis(context),toReviewer:{...reviewer,provider:'codex',
    requestedModel:'fixture-codex',adapterId:'codex-review-adapter'},configurationDigest:digest('launch'),
    reason:'明确额度不足后切换审查执行器',at:'2026-10-16T00:00:00.000Z'};
  return {context,record};
}

test('switch validates a definite failure without rewriting state, history, round or contexts',()=>{
  const {context,record}=fixture(),before=structuredClone(context);
  assert.deepEqual(readReviewerSwitch(record,context),record);
  assert.deepEqual(context,before);
  assert.deepEqual(effectiveReviewer(context.reviewer,null),context.reviewer);
  assert.equal(effectiveReviewer(context.reviewer,record).provider,'codex');
  assert.deepEqual(record.toReviewer.contexts,context.reviewer.contexts);
});

test('automatic retry already pending is eligible under the same remaining budget',()=>{
  const {context,record}=fixture();context.state.state='pending_review';
  context.state.cache[0].result.state='pending_review';
  assert.deepEqual(readReviewerSwitch(record,context),record);
});

test('switch cannot bypass exhaustion, a prior switch, outstanding work or terminal state',()=>{
  for(const mutate of [c=>c.redispatches=2,c=>c.switches=1,c=>c.pending={kind:'review'},
    c=>c.transaction={},c=>c.state.state='approved',c=>c.state.cancellationRequested=true,
    c=>c.state.receipts.push({identity:{...c.config.identity}})]){
    const {context,record}=fixture();mutate(context);
    assert.throws(()=>readReviewerSwitch(record,context));
  }
});

test('timeout, generic failure, untrusted observation and a valid verdict never qualify',()=>{
  for(const mutate of [r=>r.outcome='observed',r=>r.outcome='timed_out',r=>r.reconciliationRequired=true,
    r=>r.inspection.failure='reviewer_provider_failed',r=>r.inspection.category='verdict',
    r=>r.inspection.completionEligible=true,r=>r.inspection.provider='codex']){
    const {context}=fixture();mutate(context.state.reviewInvocation.result);
    assert.throws(()=>reviewerSwitchBasis(context));
  }
});

test('source bindings, cache, call and package cannot be replaced independently',()=>{
  for(const mutate of [c=>c.state.reviewPackage.packageDigest=digest('other'),
    c=>c.state.reviewPackage.identity={...c.config.identity,attempt:1},
    c=>c.state.calls[0].terminal='succeeded',c=>c.state.calls[0].requestDigest=digest('other'),
    c=>c.state.calls[0].resultDigest=digest('other'),c=>c.state.cache[0].result.reviewInvocation={},
    c=>c.state.reviewInvocation.registration.binding.reviewerId='other',
    c=>c.state.reviewInvocation.result.inspection.providerThreadId='other']){
    const {context,record}=fixture();mutate(context);assert.throws(()=>readReviewerSwitch(record,context));
  }
});

test('switch record rejects stale chain, altered target, configuration and extra fields',()=>{
  for(const mutate of [r=>r.fromDigest=digest('other'),r=>r.invocationId='old',r=>r.attempt=1,
    r=>r.hostContextId='joined-host',r=>r.sourceRevision=digest('other-source-revision'),
    r=>r.packageDigest=digest('other'),r=>r.toReviewer.contexts=['fresh-1','fresh-2'],
    r=>r.toReviewer.adapterId='claude-review-adapter',r=>r.toReviewer.provider='claude',
    r=>r.toReviewer.allowed=false,r=>r.configurationDigest='not-a-digest',
    r=>r.toReviewer.id='another',r=>r.reason='two\nlines',r=>r.at='invalid',r=>r.extra=true]){
    const {context,record}=fixture();mutate(record);assert.throws(()=>readReviewerSwitch(record,context));
  }
});

test('unsupported execution modes retain the original reviewer and history',()=>{
  for(const mutate of [c=>c.config.controlPolicy.version=1,c=>c.config.controlPolicy.development='provider',
    c=>c.state.attempt=1,c=>c.config.developer.provider='claude',c=>c.hostContextId='joined-host',
    c=>c.config.excludedContexts.push('joined-host'),c=>c.sourceRevision='invalid',
    c=>c.config.developer.requestedModel='provider-model',c=>c.config.bootstrap={},
    c=>c.config.parallelSelection={},c=>c.config.codeProjectPaths=['code'],
    c=>c.config.externalModels={},c=>c.config.executionPolicy={},c=>c.config.binaryAssets={}]){
    const {context,record}=fixture();mutate(context);assert.throws(()=>readReviewerSwitch(record,context));
  }
});
