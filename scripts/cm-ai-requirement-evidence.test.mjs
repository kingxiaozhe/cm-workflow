import assert from 'node:assert/strict';
import test from 'node:test';

import {REQUIREMENT_EVIDENCE_PREFIX,REQUIREMENT_EVIDENCE_LIMIT,readRequirementItems,encodeRequirementEvidence,
  readRequirementEvidence} from '../runtime/js/cm-ai/requirement-evidence.mjs';
import {readVerificationPrecheck} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {buildReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import fs from 'node:fs';

const identity={repositoryId:'evidence-fixture',runId:'evidence-run',taskId:'T-001',attempt:2};
const item=(requirement,satisfied,evidence)=>({requirement,satisfied,evidence});

test('satisfied answers encode to one handoff entry bound to the task attempt',()=>{
  const entry=encodeRequirementEvidence({identity,items:[item('记录实现前基线',true,'tests 49 / pass 49'),
    item('列出 undoSnapshot 全部出现位置',true,'src/app.js:12, 40, 88')]});
  assert.ok(entry.startsWith(REQUIREMENT_EVIDENCE_PREFIX));
  const record=readRequirementEvidence(entry);
  assert.deepEqual(record.identity,identity);
  assert.deepEqual(record.items,[{requirement:'记录实现前基线',evidence:'tests 49 / pass 49'},
    {requirement:'列出 undoSnapshot 全部出现位置',evidence:'src/app.js:12, 40, 88'}]);
});

test('an unsatisfied answer never becomes reviewable evidence',()=>{
  assert.throws(()=>encodeRequirementEvidence({identity,items:[item('a',true,'b'),item('c',false,'d')]}),{code:'invalid_result'});
});

test('the serialized answer set is bounded below the handoff limit',()=>{
  const near=Math.floor(REQUIREMENT_EVIDENCE_LIMIT/2000)+2;
  const big=Array.from({length:near},(_,index)=>item(`要求 ${index}`,true,'e'.repeat(1990)));
  assert.throws(()=>readRequirementItems(big),{code:'verification_precheck_invalid'});
  assert.throws(()=>readVerificationPrecheck({items:big}),{code:'verification_precheck_invalid'});
  const fits=Array.from({length:20},(_,index)=>item(`要求 ${index}`,true,'e'.repeat(1990)));
  assert.equal(readVerificationPrecheck({items:fits}).items.length,20);
});

test('a tampered or malformed entry is rejected',()=>{
  const entry=encodeRequirementEvidence({identity,items:[item('a',true,'b')]});
  for(const bad of [entry.replace(REQUIREMENT_EVIDENCE_PREFIX,'cm-other: '),
    entry.replace('"version":1','"version":2'),entry.replace('"evidence":"b"','"evidence":""'),
    entry.replace('"attempt":2','"attempt":3'),REQUIREMENT_EVIDENCE_PREFIX+'{not json',
    entry.replace('}]}',',"satisfied":true}]}')])
    assert.throws(()=>readRequirementEvidence(bad),{code:'invalid_input'},bad);
});

test('the precheck verdict returns the validated items for the runner',()=>{
  const verdict=readVerificationPrecheck({items:[item('a',true,'b')]});
  assert.deepEqual(verdict.items,[item('a',true,'b')]);
  assert.ok(Object.isFrozen(verdict.items)&&Object.isFrozen(verdict.items[0]));
});

test('the reviewer is told how to treat developer-reported requirement evidence',()=>{
  const source=fs.readFileSync(new URL('../runtime/js/cm-ai/codex-review-adapter.mjs',import.meta.url),'utf8');
  const instructions=/const INSTRUCTIONS=`([\s\S]*?)`;/.exec(source)[1];
  assert.match(instructions,/cm-requirement-evidence-v1:/);
  assert.match(instructions,/developer's own record, not host-verified fact/);
  assert.match(instructions,/do not request changes or block solely because such a record cannot be re-executed/);
  assert.equal(typeof buildReviewPrompt,'function');
});

test('the runner binds a satisfied gate into the host handoff and resets it per gate run',()=>{
  const source=fs.readFileSync(new URL('../runtime/js/cm-ai/task-runner.mjs',import.meta.url),'utf8');
  const body=/async function verificationSatisfied\(checks\) \{([\s\S]*?)\n  \}/.exec(source)[1];
  assert.match(body,/^\s*requirementEvidence=null;/);
  assert.match(source,/\.\.\.\(requirementEvidence===null\?\[\]:\[requirementEvidence\]\)/);
});
