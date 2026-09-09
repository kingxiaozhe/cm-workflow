import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {validateReviewDispatchGrant} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'review-host',runId:'run',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
const binding={specsDir:'/specs',codeProject:'/code',feature:'1.work',identity,packageDigest};
const operation=name=>({version:1,operation:name,requestId:name,identity,...(name==='decision'?{packageDigest}:{})});
const request=requestFor({invocationId:'actual-request',identity,role:'reviewer',provider:'codex',
  requestedModel:'fixture',contextId:'review-context',payload:{reviewPackage:{packageDigest},priorReview:null}});
const authority=decide=>createHostReviewAuthority({hostContextId:'host',reviewerId:'reviewer',adapterId:'codex-review-adapter',decide});

test('host decision issues one original grant only after the actual request exists',async()=>{
  const host=authority(async got=>{assert.deepEqual(got,binding);return {status:'approved'};});
  assert.deepEqual(host.authorize(request,{authorizationAt:Date.now()}),{status:'denied',code:'permission_denied'});
  await host.hostDecisionProvider.decide(binding,new AbortController().signal);
  const authorizationAt=Date.now(),grant=host.authorize(request,{authorizationAt});
  assert.deepEqual(validateReviewDispatchGrant(grant,{request,reviewerId:'reviewer',adapterId:'codex-review-adapter',
    packageDigest,hostContextIds:['host'],authorizationAt,registeredAt:authorizationAt}),grant);
  assert.deepEqual(host.authorize(request,{authorizationAt}),{status:'denied',code:'permission_denied'});
  for(const mode of ['package','cancel','expired','denied']){
    const controlled=authority(async()=>mode==='denied'?{status:'denied',code:'permission_denied'}:{status:'approved'});
    const controller=new AbortController();await controlled.hostDecisionProvider.decide(binding,controller.signal);
    if(mode==='cancel')controller.abort();
    const input=mode==='package'?{...request,payload:{reviewPackage:{packageDigest:'b'.repeat(64)}}}:request;
    assert.deepEqual(controlled.authorize(input,{authorizationAt:Date.now()+(mode==='expired'?60001:0)}),
      {status:'denied',code:'permission_denied'},mode);
  }
});

for(const mode of ['approved','awaiting','denied','timeout','cancel','drift'])test(`dynamic review decision: ${mode}`,async()=>{
  let current={state:'awaiting_review',code:null,identity,packageDigest},effects=0,started,release;
  const ready=new Promise(resolve=>{started=resolve;});
  const runner={status:()=>current,run:async()=>current,
    cancel:()=>{current={...current,state:'cancelled',code:'cancelled',cancellationRequested:true};return current;},
    executeEffect:async()=>{effects++;return current;}};
  let decisions=0;
  const entry=createCmAiConversationEntry({specsDir:binding.specsDir,codeProject:binding.codeProject,
    feature:binding.feature,identity,runner,hostDecisionProvider:{timeoutMs:mode==='timeout'?10:1000,
      decide:async(got,signal)=>{
        decisions++;assert.deepEqual(got,binding);assert.equal(signal.aborted,false);started();
        if(mode==='cancel'||mode==='timeout')return new Promise(resolve=>{release=resolve;});
        if(mode==='drift')current={...current,packageDigest:'b'.repeat(64)};
        if(mode==='awaiting')return null;
        return mode==='denied'?{status:'denied',code:'permission_denied'}:{status:'approved'};
      }}});
  const running=entry.handle(operation('decision'));await ready;
  if(mode==='cancel')await entry.handle(operation('cancel'));
  const result=await running;
  if(release){release({status:'approved'});await Promise.resolve();}
  assert.equal(effects,mode==='approved'?1:0);
  const expected={approved:null,awaiting:'decision_required',denied:'permission_denied',
    timeout:'review_decision_timeout',cancel:'cancelled',drift:'stale_decision'};
  assert.equal(result.code,expected[mode]);
  current={state:'unknown',code:'reconciliation_required',identity,packageDigest};
  const historical=await entry.handle(operation('decision'));
  assert.equal(historical.state,'unknown');assert.equal(decisions,1,'unknown review must not ask for another decision');
});
