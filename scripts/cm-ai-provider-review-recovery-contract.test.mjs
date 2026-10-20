import {planBytes} from '../runtime/js/cm-ai/task-commit-codec.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import {strictProviderFailure,providerRecoveryExhausted,providerRecoveryCapacity,PROVIDER_RECOVERY_EFFECT} from '../runtime/js/cm-ai/provider-review-recovery.mjs';
const failure=()=>({outcome:'failed',reconciliationRequired:false,inspection:{kind:'cm-provider-review-failure',category:'provider',failure:'reviewer_provider_failed'},
 observation:{result:{status:'failed',code:'provider_failed'},events:[{event:'thread.started',provider_thread:'fresh-thread'},{event:'turn.started',item_type:null},{event:'error',item_type:null},{event:'process_closed',exit_code:1,signal:null,timed_out:false}]}});
test('native failure needs thread/turn, one failure terminal, no business message and known non-timeout close',()=>{
 const r=failure();assert.equal(strictProviderFailure(r),true);
 const dialect=failure();dialect.observation.events[2].event='turn.failed';assert.equal(strictProviderFailure(dialect),true);
 for(const missing of [0,1,2,3]){const c=failure();c.observation.events.splice(missing,1);assert.equal(strictProviderFailure(c),false);}
 const message=failure();message.observation.events.splice(2,0,{event:'item.completed',item_type:'agent_message'});assert.equal(strictProviderFailure(message),false);
 const timeout=failure();timeout.observation.events[3].timed_out=true;assert.equal(strictProviderFailure(timeout),false);
 const two=failure();two.observation.events.splice(3,0,{event:'turn.failed',item_type:null});assert.equal(strictProviderFailure(two),false);
});
test('classification and diagnostic cannot turn malformed, cancelled or unknown output into a native failure',()=>{
 for(const code of ['invalid_event','unexpected_event','missing_init','incomplete_result','process_cleanup_unknown','cancelled','timeout']){const r=failure();r.observation.result.code=code;assert.equal(strictProviderFailure(r),false);}
 for(const outcome of ['observed','unknown','timed_out','cancelled'])assert.equal(strictProviderFailure({...failure(),outcome}),false);
 assert.equal(strictProviderFailure({...failure(),reconciliationRequired:true}),false);
 const r=failure();r.inspection.category='verdict';assert.equal(strictProviderFailure(r),false);
});
test('consumed technical recovery projects exhaustion only for its own no-result effect',()=>{
 const s={state:'blocked',receipt:null,cache:[{effect:{id:PROVIDER_RECOVERY_EFFECT}}]},r={consumed:true,record:{reviewEffectId:PROVIDER_RECOVERY_EFFECT}};
 assert.equal(providerRecoveryExhausted(s,r),true);assert.equal(providerRecoveryExhausted({...s,receipt:{result:{verdict:'blocked'}}},r),false);
 assert.equal(providerRecoveryExhausted(s,{...r,consumed:false}),false);assert.equal(providerRecoveryExhausted({...s,cache:[]},r),false);
});

test("recovery capacity preserves the original record limit before granting or dispatching",()=>{
 const state={calls:[],receipts:[]},pkg={changes:[],requirements:[]};
 assert.throws(()=>providerRecoveryCapacity(Array(1015).fill(null),state,pkg),e=>e.code==='provider_recovery_capacity');
 assert(providerRecoveryCapacity(Array(1015).fill(null),state,pkg,false));
 assert.throws(()=>providerRecoveryCapacity([{large:'x'.repeat(16*1024*1024)}],state,pkg),e=>e.code==='provider_recovery_capacity');
});

test('native completion codec accepts the twelve exact provider recovery pins and rejects other names/counts',()=>{
 const sha=b=>createHash('sha256').update(b).digest('hex'),before=Buffer.from('- [ ] T-001 native\n'),after=Buffer.from('- [x] T-001 native\n');
 const suffixes=['a1-handoff.json','a2-handoff.json','r1.md','r2.md','native-correction-1-handoff.json','native-correction-1.json','native-correction-1.md','native-correction-1-receipt.json','native-correction-1-material-1.md','native-correction-1-material-1-receipt.json','native-correction-1-provider-recovery-1.md','native-correction-1-provider-recovery-1-receipt.json'];
 const body={version:1,protocol:'cm-mark-done-plan',feature:'work',taskId:'T-001',attempt:2,tasksPath:'/fixture/specs/1.work/tasks.md',mode:0o600,
  beforeBase64:before.toString('base64'),afterBase64:after.toString('base64'),beforeDigest:sha(before),afterDigest:sha(after),taskRevision:'a'.repeat(64),
  evidence:suffixes.map(s=>({path:'/fixture/specs/.reviews/work-T-001-'+s,revision:'b'.repeat(64)})).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)))};
 assert.deepEqual(planBytes({...body,planDigest:digest(body)}),{before,after});
 const altered={...body,evidence:body.evidence.map(e=>({...e,path:e.path.replace('provider-recovery-1.md','provider-recovery-2.md')}))};
 assert.throws(()=>planBytes({...altered,planDigest:digest(altered)}),e=>e.code==='invalid_plan');
 const extra={...body,evidence:[...body.evidence,{path:'/fixture/specs/.reviews/work-T-001-native-correction-1-evidence-1.md',revision:'c'.repeat(64)}]};
 assert.throws(()=>planBytes({...extra,planDigest:digest(extra)}),e=>e.code==='invalid_plan','the original twelve-pin maximum remains unchanged');
});
