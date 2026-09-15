import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCmTestLogicResults} from '../runtime/js/cm-test/logic-results.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const contract=()=>({schemaVersion:'1.0',feature:'guide',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:[],taskIds:[],title:'Reject invalid input',preconditions:[],steps:['Call with invalid input'],expected:['Returns an error'],cleanup:[]}]});
const response=(value,verdict)=>({contractDigest:digest(value),results:[{id:'TC-001',verdict,
  evidence:verdict==='INSUFFICIENT_EVIDENCE'?[]:[{path:'src/input.mjs',line:12}],
  explanation:'Synthetic input -> validation branch -> error result'}]});
test('static verdicts preserve original FAIL/BLOCKED/REVIEWED without execution PASS',()=>{
  const value=contract();
  for(const [verdict,overall] of [['SUPPORTED','REVIEWED'],['CONTRADICTED','FAIL'],['INSUFFICIENT_EVIDENCE','BLOCKED']]){
    const result=inspectCmTestLogicResults(value,response(value,verdict));
    assert.equal(result.overall,overall);assert.equal(result.counts.executedPassed,0);assert.equal(result.executed,false);
  }
});
test('missing cases, stale binding, invented PASS and unconfirmed expectations cannot succeed',()=>{
  const value=contract();
  for(const change of [row=>{row.results=[];},row=>{row.contractDigest='0'.repeat(64);},
    row=>{row.results[0].verdict='PASS';},row=>{row.results[0].evidence=[];}]){
    const row=response(value,'SUPPORTED');change(row);assert.throws(()=>inspectCmTestLogicResults(value,row));
  }
  value.cases[0].origin='inferred';value.cases[0].expected=['[需确认] 当前行为刻画: Returns an error'];
  assert.throws(()=>inspectCmTestLogicResults(value,response(value,'SUPPORTED')));
  assert.equal(inspectCmTestLogicResults(value,response(value,'INSUFFICIENT_EVIDENCE')).overall,'BLOCKED');
});
