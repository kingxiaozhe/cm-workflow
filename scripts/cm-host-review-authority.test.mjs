import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {validateReviewDispatchGrant} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'review-host',runId:'run',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
const binding={specsDir:'/specs',codeProject:'/code',feature:'1.work',identity,packageDigest};
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
