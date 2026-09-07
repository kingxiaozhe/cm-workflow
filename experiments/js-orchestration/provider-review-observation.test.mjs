import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectProviderReview} from './provider-review-observation.mjs';
import {captureReviewBaseline,createReviewPackage} from './review-package.mjs';
import {requestFor,digest,terminalFor} from './effect-contract.mjs';
import {reviewPaths} from './review-runner.mjs';
import {checkCompletion} from './gate-bridge.mjs';
import {createTaskRunner} from './task-runner.mjs';

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-observation-')));
  try{
    fs.writeFileSync(path.join(root,'code.js'),'old');fs.writeFileSync(path.join(root,'requirements.md'),'synthetic requirement');
    const identity={repositoryId:'synthetic',runId:'run',taskId:'T-001',attempt:1};
    const baseline=captureReviewBaseline({root,identity,scope:['code.js'],requirements:['requirements.md']});
    fs.writeFileSync(path.join(root,'code.js'),'new');
    const pkg=createReviewPackage({root,baseline,checks:[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}]});
    const request=requestFor({invocationId:'invocation-1',identity,role:'reviewer',provider:'codex',requestedModel:'synthetic-model',contextId:'logical-review',payload:{reviewPackage:pkg,priorReview:null}});
    const expectation={request,developerThreadId:'actual-developer',excludedThreadIds:['actual-main']};
    const observation={version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,events:[
      {event:'thread.started',provider_thread:'actual-review'}, {event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'}, {event:'turn.completed',item_type:null},
      {event:'process_closed',exit_code:0,signal:null,timed_out:false}],
      result:{status:'succeeded',value:{verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'Synthetic review'}}};
    return {expectation:structuredClone(expectation),observation:structuredClone(observation)};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const inspect=f=>inspectProviderReview(JSON.stringify(f.observation),JSON.stringify(f.expectation));
test('valid recorded review is inspectable but never completion authority',()=>{
  const f=fixture(),value=inspect(f);
  assert.equal(value?.observationStatus,'completed');
  assert.equal(value.completionEligible,false);assert.equal(value.effectiveModel,null);
  assert.equal(value.review.verdict,'approved');assert.equal(value.providerThreadId,'actual-review');
});

test('inspector is pure with a removed source root and output deeply frozen',()=>{
  const f=fixture(),saved=JSON.stringify(f),reads=fs.readFileSync;
  try{fs.readFileSync=()=>assert.fail('inspector must not read files');
    const v=inspect(f);assert(Object.isFrozen(v));assert(Object.isFrozen(v.review.findings));
    assert.equal(v.logicalContextId,'logical-review');assert.equal(v.requestDigest,f.expectation.request.requestDigest);
    assert.equal(v.observationDigest,digest(f.observation));assert.equal(JSON.stringify(f),saved);
    assert(!Object.hasOwn(v,'events'));assert(!Object.hasOwn(v,'payload'));
  }finally{fs.readFileSync=reads;}
});
for(const verdict of ['changes_requested','blocked'])test(`completed transport retains ${verdict} without completion permission`,()=>{
  const f=fixture();f.observation.result.value.verdict=verdict;
  if(verdict==='changes_requested')f.observation.result.value.findings=[{id:'F1',severity:'P2',path:'code.js',message:'synthetic defect',evidence:'fixture'}];
  const v=inspect(f);assert.equal(v.observationStatus,'completed');assert.equal(v.review.verdict,verdict);assert.equal(v.completionEligible,false);
});
for(const [label,change] of Object.entries({
  same_actual_thread:f=>f.observation.events[0].provider_thread='actual-developer',
  excluded_actual_thread:f=>f.observation.events[0].provider_thread='actual-main',
  empty_thread:f=>f.observation.events[0].provider_thread='',
  wrong_request:f=>f.observation.requestDigest=digest('other'),
  wrong_package:f=>f.observation.result.value.packageDigest=digest('other'),
  missing_material:f=>f.observation.result.value.examinedPaths=['code.js'],
  unknown_verdict:f=>f.observation.result.value.verdict='pass',
  approved_with_blocker:f=>f.observation.result.value.findings=[{id:'F1',severity:'P1',path:'code.js',message:'bug',evidence:'proof'}],
  unbound_identity:f=>f.expectation.request.identity.taskId='T-002',
  unbound_attempt:f=>f.expectation.request.identity.attempt=2,
  bad_version:f=>f.observation.version=2,
  authority_flag:f=>f.observation.completionEligible=true,
  model_claim:f=>f.observation.result.effectiveModel='pretend-verified',
  extra_event_field:f=>f.observation.events[0].authority='host',
  duplicate_thread:f=>f.observation.events.splice(1,0,f.observation.events[0]),
  swapped_start:f=>[f.observation.events[0],f.observation.events[1]]=[f.observation.events[1],f.observation.events[0]],
  tool_item:f=>f.observation.events[2].item_type='command_execution',
  reasoning_dialect:f=>f.observation.events[2].item_type='reasoning',
  duplicate_terminal:f=>f.observation.events.splice(4,0,f.observation.events[3]),
  after_close:f=>f.observation.events.push({event:'turn.failed',item_type:null}),
  bad_close_code:f=>f.observation.events[4].exit_code='0',
  bad_close_timeout:f=>f.observation.events[4].timed_out='false',
  too_many_events:f=>f.observation.events=Array(65).fill(f.observation.events[0]),
  wrong_status:f=>f.observation.result.status='approved',
  missing_failed_code:f=>f.observation.result={status:'failed'},
}))test(`rejects ${label}`,()=>{const f=fixture();change(f);assert.throws(()=>inspect(f));});

for(const [label,change,status,code] of [
  ['host timeout',f=>f.observation.events[4].timed_out=true,'unknown','transport_timeout'],
  ['adapter timeout',f=>f.observation.result={status:'failed',code:'timeout'},'unknown','transport_timeout'],
  ['host cancellation',f=>f.observation.result={status:'cancelled',code:'cancelled'},'cancelled','transport_cancelled'],
  ['signal with late success',f=>f.observation.events[4].signal='SIGTERM','unknown','transport_incomplete'],
  ['nonzero exit',f=>f.observation.events[4].exit_code=1,'unknown','transport_incomplete'],
  ['missing close',f=>f.observation.events.pop(),'unknown','transport_incomplete'],
  ['missing terminal',f=>f.observation.events.splice(3,1),'unknown','transport_incomplete'],
  ['failure terminal',f=>f.observation.events[3].event='turn.failed','unknown','transport_incomplete'],
  ['error terminal',f=>f.observation.events[3].event='error','unknown','transport_incomplete'],
  ['failure result',f=>f.observation.result={status:'failed',code:'provider_failed'},'unknown','transport_incomplete'],
  ['null exit',f=>f.observation.events[4].exit_code=null,'unknown','transport_incomplete'],
  ['empty stream',f=>f.observation.events=[],'unknown','transport_incomplete'],
  ['timeout wins over cancelled',f=>{f.observation.result={status:'cancelled',code:'cancelled'};f.observation.events[4].timed_out=true;},'unknown','transport_timeout'],
  ['failed cancelled code',f=>f.observation.result={status:'failed',code:'cancelled'},'cancelled','transport_cancelled'],
  ['opaque timeout-like code',f=>f.observation.result={status:'failed',code:'timeout_maybe'},'unknown','transport_incomplete'],
  ['opaque cancellation-like code',f=>f.observation.result={status:'failed',code:'cancelled_maybe'},'unknown','transport_incomplete'],
  ['early error',f=>{f.observation.events=[{event:'error',item_type:null}];f.observation.result={status:'failed',code:'startup'};},'unknown','transport_incomplete'],
])test(`${label} cannot export even an approved review`,()=>{
  const f=fixture();change(f);const v=inspect(f);
  assert.equal(v.observationStatus,status);assert.equal(v.code,code);assert.equal(v.review,null);assert.equal(v.completionEligible,false);
});
test('failure before thread start remains diagnostic, not fallback permission',()=>{
  const f=fixture();f.observation.events=[{event:'process_closed',exit_code:1,signal:null,timed_out:false}];
  f.observation.result={status:'failed',code:'spawn_failed'};
  const v=inspect(f);assert.equal(v.providerThreadId,null);assert.equal(v.observationStatus,'unknown');assert.equal(v.review,null);
});
test('logical context cannot replace actual provider thread provenance',()=>{
  const f=fixture();f.expectation.request.contextId='actual-developer';
  const {requestDigest,...body}=f.expectation.request;f.expectation.request.requestDigest=digest(body);f.observation.requestDigest=digest(body);
  assert.equal(inspect(f).observationStatus,'completed'); // Logical names are not provider IDs.
  f.observation.events[0].provider_thread='actual-developer';assert.throws(()=>inspect(f));
});
for(const [name,change] of Object.entries({
  developer_role:r=>r.role='developer',claude_not_yet_supported:r=>r.provider='claude',
  missing_model:r=>r.requestedModel=null,wrong_request_version:r=>r.version=2,
  task_package_mismatch:r=>r.identity.taskId='T-999',extra_payload:r=>r.payload.authorized=true,
  malformed_package:r=>r.payload.reviewPackage.changes[0].after.contentBase64='Zm9yZ2Vk',
}))test(`rejects recomputed but invalid expected ${name}`,()=>{
  const f=fixture();change(f.expectation.request);const {requestDigest,...body}=f.expectation.request;
  f.expectation.request.requestDigest=digest(body);f.observation.requestDigest=digest(body);assert.throws(()=>inspect(f));
});
test('input types are refused without getters, proxy traps or coercion',()=>{
  const f=fixture(),o=JSON.stringify(f.observation),e=JSON.stringify(f.expectation);let hits=0;
  const trap=new Proxy({},{get(){hits++;throw Error('trap');},ownKeys(){hits++;throw Error('trap');}});
  for(const invalid of [null,{},trap,{get toJSON(){hits++;throw Error('getter');}},[],42]){
    assert.throws(()=>inspectProviderReview(invalid,e));assert.throws(()=>inspectProviderReview(o,invalid));
  }
  assert.equal(hits,0);assert.throws(()=>inspectProviderReview(o,e,true));
});
test('malformed, deep and oversized JSON is bounded',()=>{
  const f=fixture(),o=JSON.stringify(f.observation),e=JSON.stringify(f.expectation);
  for(const invalid of ['{','null','[]','"x"','['.repeat(50)+'0'+']'.repeat(50),' '.repeat(1024*1024+1),'{"x":1e400}'])
    assert.throws(()=>inspectProviderReview(invalid,e));
  assert.throws(()=>inspectProviderReview(o,' '.repeat(10*1024*1024+1)));
});
test('diagnostic output and a replay never become a legacy terminal or registered receipt',()=>{
  const f=fixture(),v=inspect(f);assert.deepEqual(inspect(f),v);
  assert.equal(v.completionEligible,false);
  assert.throws(()=>terminalFor(v,f.expectation.request));
  assert.throws(()=>checkCompletion({receipt:v,registered:v,execution:v,
    reviewPackage:f.expectation.request.payload.reviewPackage,identity:f.expectation.request.identity}));
});
test('existing task runner cannot complete by consuming an inspected provider recording',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-observation-runner-')));let commits=0,inspected=null;
  try{
    fs.writeFileSync(path.join(root,'code.js'),'old');fs.writeFileSync(path.join(root,'requirements.md'),'synthetic');
    fs.writeFileSync(path.join(root,'tasks.md'),'- [ ] T-001\n');
    const identity={repositoryId:'synthetic',runId:'run',taskId:'T-001',attempt:1};
    const runner=createTaskRunner({root,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],
      developer:{provider:'codex',requestedModel:'synthetic',contextId:'dev',run:r=>{
        fs.writeFileSync(path.join(root,'code.js'),'new');return {version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
          effectiveModel:'fixture',status:'succeeded',accepted:true,result:{outcome:'implemented'}};}},
      reviewers:[{id:'reviewer',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,contexts:['review1','review2'],run:r=>{
        const f=fixture();f.expectation.request=r;f.observation.requestDigest=r.requestDigest;
        f.observation.result.value.packageDigest=r.payload.reviewPackage.packageDigest;
        f.observation.result.value.examinedPaths=reviewPaths(r.payload.reviewPackage);
        inspected=inspect(f);return inspected;
      }}],check:()=>[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}],
      commit:()=>{commits++;return {outcome:'fixture_completed'};}});
    const out=await runner.run();assert.equal(inspected?.observationStatus,'completed');
    assert.equal(inspected.review.verdict,'approved');assert.equal(inspected.completionEligible,false);
    assert.equal(out.state,'unknown');assert.equal(commits,0);
    assert.equal(out.receipts.length,0);assert.equal(fs.readFileSync(path.join(root,'tasks.md'),'utf8'),'- [ ] T-001\n');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
