import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {operatorGuidance,guidanceText,projectOperatorGuidance} from '../runtime/js/cm-ai/operator-guidance.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {batchMemberResult} from './cm-ai-batch-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const identity={repositoryId:'fixture',runId:'blockage-fixture',taskId:'T-001',attempt:1};
const packageDigest='a'.repeat(64);
const input=(code='verification_precheck_failed',extra={})=>({workflow:'cm-ai',identity,packageDigest,
  state:'blocked',code,pendingAction:'resume',outcome:'reported',...extra});
const guided=(value,options)=>({...value,guidance:operatorGuidance(value,options)});

test('verification detail reports the actual current reason but cannot add a recovery operation',()=>{
  const reason='verification_precheck_failed: task:T-001:abc:1: missing acceptance obligation, mandatory tests missing: tests/b.test.mjs';
  const value=input(undefined,{reason}),before=JSON.stringify(value),result=guided(value),b=result.guidance.blockage;
  assert.equal(b.phase.code,'verification');assert.equal(b.detail.status,'recorded');assert.equal(b.detail.text,reason);
  assert.equal(b.recovery.operation,'advance');assert.equal(b.recovery.authorizationGranted,false);
  assert.equal(b.validEvidence.status,'unknown');assert.equal(b.inspection.dispatchedCalls,0);
  assert.match(guidanceText(result),/tests\/b.test.mjs/);assert.match(guidanceText(result),/当前可复用证据：UNKNOWN/);
  assert.equal(JSON.stringify(value),before);
  const noPath=guided({...value,pendingAction:'none'});
  assert.equal(noPath.guidance.recoveryOperation,null);assert.equal(noPath.guidance.blockage.recovery.operation,null);
  assert.equal(noPath.guidance.blockage.recovery.decision,'not_available');
});

test('old, arbitrary and control-character reasons remain unknown instead of invented detail',()=>{
  for(const reason of [undefined,'private raw provider message','verification_precheck_failed:',
    'verification_precheck_failed: private\u001b[31m message','verification_precheck_failed: false\u202e message',
    'verification_precheck_failed: '+ 'x'.repeat(8192)]){
    const result=guided(input(undefined,{reason}));
    assert.equal(result.guidance.blockage.detail.status,'unknown');
    assert.doesNotMatch(guidanceText(result),/private|\u001b|\u202e/);
  }
  const result=guided(input(undefined,{reason:'verification_precheck_failed: '+ '义务'.repeat(2000)}));
  assert.equal(result.guidance.blockage.detail.truncated,true);
  assert(Buffer.byteLength(result.guidance.blockage.detail.text)<2000);
  assert.match(guidanceText(result),/完整原因见 result.reason/);
});

test('check, spec drift and review-no-verdict phases use their existing recovery paths and costs',()=>{
  const checks=guided(input('develop_checks_not_passed',{reason:'develop_checks_not_passed: unit-b: failed; assertion'}));
  assert.equal(checks.guidance.blockage.phase.code,'checks');assert.equal(checks.guidance.blockage.detail.status,'recorded');
  assert.equal(checks.guidance.blockage.recovery.checks,'may_run');
  const complete=guided(input('completion_checks_changed',{pendingAction:'complete',reason:'completion_checks_changed: test-b: failed'}));
  assert.equal(complete.guidance.blockage.phase.code,'completion');assert.equal(complete.guidance.blockage.recovery.reviewCalls,'not_dispatched');
  const review=guided(input('review_transport_timeout',{state:'pending_review'}));
  assert.equal(review.guidance.blockage.phase.code,'review');assert.equal(review.guidance.blockage.detail.status,'unknown');
  assert.equal(review.guidance.blockage.recovery.checks,'may_run','advance may continue through completion/QA or next-attempt development');
  assert.equal(review.guidance.blockage.recovery.reviewCalls,'may_dispatch');
  const abandon=guided(input('review_transport_timeout',{state:'unknown',pendingAction:'abandon_review'}));
  assert.equal(abandon.guidance.blockage.recovery.decision,'required');assert.equal(abandon.guidance.blockage.recovery.reviewCalls,'not_dispatched');
  const busy=guided(input('review_transport_timeout',{state:'unknown',pendingAction:'abandon_review'}),{executionActive:true});
  assert.equal(busy.guidance.blockage.recovery.operation,null);assert.equal(busy.guidance.blockage.recovery.decision,'wait');
});

test('only the matching validated completion snapshot supplies currently reusable evidence',()=>{
  const completion={snapshotDigest:'b'.repeat(64),binding:{identity,packageDigest,runnerRevision:'revision'},
    task:{status:'completed',review:{status:'passed',evidence:['receipt:'+'c'.repeat(64)]}},
    feature:{status:'passed',qa:{status:'passed'}}};
  const value=input('documentation_sync_blocked',{state:'fixture_completed',pendingAction:'none',completion});
  assert.equal(guided(value).guidance.blockage.validEvidence.status,'confirmed');
  assert.equal(guided(value).guidance.blockage.validEvidence.items.length,2);
  for(const changed of [{...completion,snapshotDigest:null},{...completion,binding:{...completion.binding,identity:{...identity,attempt:2}}},
    {...completion,binding:{...completion.binding,packageDigest:'d'.repeat(64)}},
    {...completion,task:{...completion.task,status:'unknown'}},{...completion,task:{...completion.task,status:'blocked'}}])
    assert.equal(guided({...value,completion:changed}).guidance.blockage.validEvidence.status,'unknown');
  assert.equal(guided({...value,code:'spec_drift'}).guidance.blockage.validEvidence.status,'unknown');
});

test('protocol and batch reprojections preserve explanations without leaking a single-run launch instruction',()=>{
  const value=input('spec_drift',{pendingAction:'spec_rebind',
    reason:'规格已重新批准，变更文件：1.sample/tasks.md；用 --supersede-reviewed-evidence 新建运行'});
  const single=projectOperatorGuidance(guided(value),{protocol:'v2'});
  assert.equal(single.guidance.blockage.phase.code,'specification');
  assert.match(single.guidance.blockage.detail.text,/1.sample\/tasks.md/);
  assert.doesNotMatch(guidanceText(single),/--supersede-reviewed-evidence/);
  const batch=batchMemberResult(single,{protocol:'v2',taskKey:'1.sample/T-001'});
  assert.equal(batch.pendingAction,'none');assert.equal(batch.guidance.blockage.recovery.operation,null);
  assert.equal(batch.guidance.blockage.recovery.decision,'not_available');
  assert.doesNotMatch(guidanceText(batch),/--expected-control|--rebind-spec-material|--supersede-reviewed-evidence/);
  const retry=batchMemberResult(guided(input('develop_checks_not_passed')),{protocol:'v2'});
  assert.equal(retry.guidance.blockage.recovery.operation,'advance');
  assert.match(guidanceText(retry),/原批次入口/);
});

test('malformed explanation decoration cannot break the existing human guidance renderer',()=>{
  const result=guided(input());
  for(const validEvidence of [null,{message:'safe',status:'confirmed',items:null},{message:'safe',items:[null]}]){
    const output=guidanceText({...result,guidance:{...result.guidance,blockage:{...result.guidance.blockage,validEvidence}}});
    assert.match(output,/交付未满足/);
  }
  const injected=guidanceText({...result,guidance:{...result.guidance,blockage:{...result.guidance.blockage,
    detail:{text:'fake\u001b[31m message'}}}});
  assert.doesNotMatch(injected,/fake|\u001b/);
});

test('real status entry reads runner once and preserves files and dispatch counters',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-blockage-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.sample';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(specsDir,'.cm-status.json'),'original display');
  const files=['.cm-status.json','.cm-specs-status',feature+'/requirements.md',feature+'/design.md',feature+'/tasks.md'];
  const before=files.map(file=>[file,fs.readFileSync(path.join(specsDir,file)),fs.statSync(path.join(specsDir,file)).mtimeMs]);
  let reads=0;const unexpected=()=>{throw Error('must not dispatch or mutate');};
  const status={...input(undefined,{reason:'verification_precheck_failed: task:T-001:missing',calls:[]}),state:'blocked'};
  const entry=createCmAiConversationEntry({specsDir,codeProject,feature,identity,
    runner:{status:()=>{reads++;return status;},executeEffect:unexpected,cancel:unexpected,run:unexpected}});
  const output=await entry.handle({version:1,operation:'status',requestId:'status',identity});
  assert.equal(reads,1);assert.equal(output.guidance.blockage.detail.status,'recorded');
  assert.equal(output.guidance.blockage.validEvidence.status,'unknown');assert.equal(output.guidance.blockage.inspection.dispatchedCalls,0);
  for(const [file,bytes,mtime] of before){assert.deepEqual(fs.readFileSync(path.join(specsDir,file)),bytes);assert.equal(fs.statSync(path.join(specsDir,file)).mtimeMs,mtime);}
  assert.equal(fs.existsSync(path.join(specsDir,'运行日志.jsonl')),false);assert.equal(fs.existsSync(path.join(specsDir,'.reviews')),false);
});
