import assert from 'node:assert/strict';
import test from 'node:test';

import {readVerificationPrecheck} from '../runtime/js/cm-ai/host-conversation-execution.mjs';

const item=(requirement,satisfied,evidence)=>({requirement,satisfied,evidence});
const rejects=value=>assert.throws(()=>readVerificationPrecheck(value),
  error=>error.code==='verification_precheck_invalid'||error.code==='invalid_input',
  `expected rejection for ${JSON.stringify(value)}`);

test('every requirement satisfied lets the delivery through to the real review', () => {
  const verdict=readVerificationPrecheck({items:[
    item('记录实现前基线',true,'npm test tests 42 / pass 42 / fail 0'),
    item('观察 RED 并记录失败用例名',true,'4 个用例因占位体抛错失败'),
  ]});
  assert.equal(verdict.satisfied,true);
  assert.deepEqual(verdict.unsatisfied,[]);
});

test('one unsatisfied requirement blocks and is named back', () => {
  const verdict=readVerificationPrecheck({items:[
    item('记录实现前基线',true,'tests 42 / pass 42 / fail 0'),
    item('既有用例数不减少',false,'交付里只有实现后计数，没有实现前基线'),
    item('新增用例只写在指定文件',true,'git status 只列出该文件'),
  ]});
  assert.equal(verdict.satisfied,false);
  assert.deepEqual(verdict.unsatisfied,['既有用例数不减少']);
});

test('a requirement claimed satisfied without citing evidence is rejected', () => {
  // The whole point of the gate is the evidence location, not the verdict.
  rejects({items:[item('记录实现前基线',true,'')]});
  rejects({items:[item('记录实现前基线',true,'   ')]});
});

test('an empty or oversized answer set is rejected', () => {
  rejects({items:[]});
  rejects({items:Array.from({length:65},(_,index)=>item(`要求 ${index}`,true,'证据'))});
  assert.equal(readVerificationPrecheck({items:Array.from({length:64},
    (_,index)=>item(`要求 ${index}`,true,'证据'))}).satisfied,true);
});

test('extra, missing or mistyped fields are rejected', () => {
  rejects({items:[{requirement:'x',satisfied:true}]});
  rejects({items:[{...item('x',true,'y'),note:'多给一个字段'}]});
  rejects({items:[item('x','true','y')]});
  rejects({items:[item('x',1,'y')]});
  rejects({items:'not an array'});
  rejects({});
  rejects({items:[item('x',true,'y')],extra:1});
});

test('control characters and oversized text are rejected', () => {
  rejects({items:[item(`要求${String.fromCharCode(0)}注入`,true,'证据')]});
  rejects({items:[item('要求',true,'a'.repeat(2001))]});
  assert.equal(readVerificationPrecheck({items:[item('要求',true,'a'.repeat(2000))]}).satisfied,true);
});

test('the verdict is frozen so a caller cannot flip it after validation', () => {
  const verdict=readVerificationPrecheck({items:[item('要求',false,'没对上')]});
  assert.throws(()=>{verdict.satisfied=true;},TypeError);
  assert.equal(verdict.satisfied,false);
});

// The gate is only useful if a blocked delivery can be redone. A gate that
// leaves the task unrecoverable would cost more than the rework it prevents.
test('a blocked delivery is reported as resumable, not as an unknown state', async () => {
  const {default:fs}=await import('node:fs');
  const {developmentRetryable}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  assert.equal(developmentRetryable({state:'blocked',code:'verification_precheck_failed'}),true);
  assert.equal(developmentRetryable({state:'unknown',code:'verification_precheck_failed'}),false);
  // resume is the action that predicate maps to.
  const source=fs.readFileSync(new URL('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs',import.meta.url),'utf8');
  assert.match(source,/retryDeveloper\(status\)\|\|retryReview\(status\)\?'resume'/);
});

test('the failure code survives redaction instead of collapsing to execution_error', async () => {
  const {failureCode}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  assert.equal(failureCode(Object.assign(new Error('x'),{code:'verification_precheck_failed'})),
    'verification_precheck_failed');
});

// The serial entry and the parallel batch driver must agree on what is
// retryable. They used to keep separate code lists; a gate code added to one
// and not the other would stall every parallel member that hits it.
test('the batch driver decides retryability from the shared predicate', async () => {
  const {default:fs}=await import('node:fs');
  const {developmentRetryable}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const source=fs.readFileSync(new URL('./cm-ai-batch-run.mjs',import.meta.url),'utf8');
  assert.match(source,/import \{developmentRetryable\}/);
  assert.match(source,/\|\|developmentRetryable\(status\)\)await call\('start'\)/);
  assert.equal(/status\.code==='developer_result_invalid'/.test(source),false,
    'batch driver still carries its own copy of the retryable code list');
  for(const code of ['developer_result_invalid','verification_precheck_failed'])
    assert.equal(developmentRetryable({state:'blocked',code}),true,code);
  assert.equal(developmentRetryable({state:'blocked',code:'package_mismatch'}),false);
  assert.equal(developmentRetryable({state:'unknown',code:'verification_precheck_failed'}),false);
});
