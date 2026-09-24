import test from 'node:test';
import assert from 'node:assert/strict';
import {createRun,transition,restoreRun} from '../runtime/js/cm-ai/contracts.mjs';

const definition={runId:'state-fixture',fingerprint:'source-config',scope:'synthetic',
  steps:[{id:'first',requiresApproval:true}]};
const identity={runId:definition.runId,fingerprint:definition.fingerprint,scope:definition.scope,
  stepId:'first',attempt:1,requestHash:'request-first'};
const event=(id,type,extra={})=>({id,type,...identity,...extra});
const host={source:'host',now:10};

test('restoreRun accepts active, waiting_user, deny and revoked states but rejects an unknown decision',()=>{
  const active=createRun(definition);
  const waiting=transition(active,event('ask','request_decision',{requestId:'decision-1',expiresAt:20}),host).state;
  const approved=transition(waiting,event('approve','decision',{requestId:'decision-1',decision:'approve'}),host).state;
  const denied=transition(waiting,event('deny','decision',{requestId:'decision-1',decision:'deny'}),host).state;
  const revoked=transition(approved,event('revoke','revoke'),host).state;
  for(const [name,snapshot,runStatus,stepStatus,decision] of [
    ['active',active,'active','pending',null],
    ['waiting_user',waiting,'active','waiting_user','waiting'],
    ['deny',denied,'blocked','blocked','deny'],
    ['revoked',revoked,'blocked','blocked','revoked']]){
    const restored=restoreRun(snapshot,definition);
    assert.equal(restored.status,runStatus,name);
    assert.equal(restored.steps[0].status,stepStatus,name);
    assert.equal(restored.steps[0].approval?.decision??null,decision,name);
  }
  const invalid=structuredClone(denied);invalid.steps[0].approval.decision='not_a_decision';
  assert.throws(()=>restoreRun(invalid,definition),/invalid_snapshot/);
});
