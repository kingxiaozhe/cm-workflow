// Synthetic local archived-text fixture: no provider, business run or acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {digest,requestFor,failureCode} from '../runtime/js/cm-ai/effect-contract.mjs';
import {assertCodexReviewTransportProfile} from '../runtime/js/cm-ai/codex-review-input.mjs';
import {inspectContinuationPlan} from '../runtime/js/cm-ai/continuation-preflight.mjs';
import {buildReviewPrompt,prepareCodexReviewInput} from '../runtime/js/cm-ai/codex-review-adapter.mjs';

function fixture(t,{bytes=1048568,provider='codex',fallbackCodex=false,observed=false,scopeLimits}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-input-admission-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specs=path.join(root,'specs');fs.mkdirSync(code);fs.mkdirSync(path.join(specs,'.reviews'),{recursive:true});
  const scope=['one.txt','two.txt'],requirements=['requirements.md'];
  for(const name of scope)fs.writeFileSync(path.join(code,name),'old');
  fs.writeFileSync(path.join(code,requirements[0]),'fixed acceptance');
  const tasksPath=path.join(specs,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const identity={repositoryId:'fixture',runId:'input-admission',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'1.feature',specsRoot:specs,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('fixture'),config:digest('input-admission'),inputs:digest('fixture')},create:true};
  let store=openTaskExecutionStore(owner),reviewCalls=0,captured=null;
  t.after(()=>store.close());
  const terminal=(request,status,result)=>({version:1,invocationId:request.invocationId,contextId:request.contextId,
    provider:request.provider,effectiveModel:'fixture',status,accepted:true,result});
  const options={...(scopeLimits?{reviewScopeLimits:scopeLimits}:{}),root:code,identity,scope,requirements,excludedContexts:['main'],timeoutMs:5000,
    developer:{provider:'claude',requestedModel:'fixture',contextId:'developer',run:request=>{
      for(const [i,name] of scope.entries())fs.writeFileSync(path.join(code,name),String.fromCharCode(99+i).repeat(bytes));
      return terminal(request,'succeeded',{outcome:'implemented'});
    }},
    reviewers:[{id:'reviewer',provider,requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],...(observed?{adapterId:'codex-review-adapter'}:{}),run:request=>{reviewCalls++;captured=request;return terminal(request,fallbackCodex&&provider==='claude'?'unavailable':'failed',null);}}],
    check:()=>[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    ...(observed?{taskCompletion:{reviewsDir:path.join(specs,'.reviews'),handoffs:[1,2].map(n=>path.join(specs,'.reviews',`handoff-${n}.json`))},
      reviewInvocation:{developerThreadId:'developer-host',excludedThreadIds:['prior-host']}}
      :{commit:()=>{throw new Error('must not commit');}})};
  if(fallbackCodex)options.reviewers.push({id:'fallback',provider:'codex',requestedModel:'fixture',allowed:true,available:true,contexts:['fallback-one','fallback-two'],run:request=>{reviewCalls++;captured=request;return terminal(request,'failed',null);}});
  const persistence=mode=>({store,mode,...(observed?{version:3}:{})});
  createTaskRunner({...options,persistence:persistence('create')});store.close();
  // Existing scope-revision archives legitimately carry gzip text. Seed that
  // exact historical encoding in this disposable fixture, preserving real
  // baseline, record and store digest checks during the subsequent resume.
  for(const [i,name] of scope.entries())fs.writeFileSync(path.join(code,name),String.fromCharCode(97+i).repeat(bytes));
  const raw=captureReviewBaseline({root:code,identity,scope,requirements,...(observed?{specsRoot:specs}:{})});
  const {baselineDigest,...baseline}=raw;
  baseline.files=baseline.files.map(file=>{if(!scope.includes(file.path))return file;
    const {contentBase64,...rest}=file;return {...rest,contentGzipBase64:gzipSync(Buffer.from(contentBase64,'base64')).toString('base64')};});
  const original={...baseline,baselineDigest:digest(baseline)};
  const statePath=path.join(specs,'.reviews','.execution',identity.runId,'state.json');
  const saved=JSON.parse(fs.readFileSync(statePath));saved.records[0].payload.baseline=original;
  for(const record of saved.records){const {digest:old,...body}=record;record.digest=digest(body);}
  const {revision,...state}=saved;fs.writeFileSync(statePath,JSON.stringify({...state,revision:digest(state)})+'\n');
  store=openTaskExecutionStore({...owner,create:false});
  const runner=createTaskRunner({...options,persistence:persistence('resume')});
  const effect=(kind,id=kind)=>({version:1,id,identity,kind});
  return {root,code,specs,identity,scope,requirements,runner,store,effect,reviewCalls:()=>reviewCalls,captured:()=>captured,resume:limits=>{store.close();store=openTaskExecutionStore({...owner,create:false});return createTaskRunner({...options,reviewScopeLimits:limits,persistence:persistence('resume')});}};
}

for(const observed of [false,true])test(`oversized exact final material is refused before intent, preserving state, records and call budget (v${observed?3:1})`,async t=>{
  const f=fixture(t,{observed,scopeLimits:{pageCount:1024,materialBytes:16777216}});assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const before=JSON.stringify(f.store.snapshot()),status=JSON.stringify(f.runner.status()),records=f.store.snapshot().records.length;
  const result=await f.runner.executeEffect(f.effect('review'));
  assert.deepEqual({result,recordsAdded:f.store.snapshot().records.length-records,reviewCalls:f.reviewCalls(),
    stateUnchanged:JSON.stringify(f.runner.status())===status},{result:{outcome:'rejected',code:'review_input_too_large'},
    recordsAdded:0,reviewCalls:0,stateUnchanged:true});
  assert.equal(JSON.stringify(f.store.snapshot()),before);assert.equal(JSON.stringify(f.runner.status()),status);
  assert.equal(f.reviewCalls(),0);
  assert.deepEqual(await f.runner.executeEffect(f.effect('review','review-second-id')),result);
  assert.equal(JSON.stringify(f.store.snapshot()),before,'refusal does not create another retry or consume an effect');
});

test('complete two megabyte presentation can enter material review but a failed provider is never approval',async t=>{
  const f=fixture(t,{bytes:510000});assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const before=f.store.snapshot().records.length;
  const result=await f.runner.executeEffect(f.effect('review'));
  assert.equal(f.reviewCalls(),1);assert.equal(result.state,'pending_review');assert.equal(result.code,'failed');
  assert.equal(result.receipt,null);assert.equal(result.calls.length,2);
  assert.equal(f.store.snapshot().records.length,before+2);
  const prepared=prepareCodexReviewInput(f.captured());assert(prepared.material);
  assert.equal(prepared.material.prompt,buildReviewPrompt(f.captured(),'codex'));
  assert([...prepared.prompt].length<=1048576);
  assert.equal(assertCodexReviewTransportProfile(prepared,null),prepared);
  assert.throws(()=>assertCodexReviewTransportProfile(prepared,{version:1}),error=>{
    assert.equal(error.code,'review_material_profile_unsupported');
    assert.equal(failureCode(error),'review_material_profile_unsupported');return true;
  });
  const inline={prompt:'small inline input',material:null};
  assert.equal(assertCodexReviewTransportProfile(inline,{version:1}),inline,'ordinary binary review keeps its own tools');
});

test('Claude review is not refused by the Codex initial input or material-page cap',async t=>{
  const f=fixture(t,{provider:'claude',scopeLimits:{pageCount:1024,materialBytes:16777216}});assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const result=await f.runner.executeEffect(f.effect('review'));
  assert.equal(f.reviewCalls(),1);assert.equal(result.state,'pending_review');assert.equal(result.code,'failed');
  assert.equal(result.receipt,null);
});


test('read-only continuation reports the exact next material request without calling or authorizing review',async t=>{
  const f=fixture(t,{bytes:510000,observed:true});assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const saved=f.store.snapshot(),frame=saved.records.at(-1).payload.checkpoint;
  const expected=requestFor({invocationId:`${frame.session}.${frame.sequence+1}`,identity:f.identity,role:'reviewer',provider:'codex',
    requestedModel:'fixture',contextId:'review-one',payload:{reviewPackage:frame.reviewPackage,priorReview:null}});
  const config=path.join(f.root,'run.json'),plan=path.join(f.root,'PLAN.json');
  fs.writeFileSync(config,JSON.stringify({version:1,codeProject:f.code,specsDir:f.specs,feature:'1.feature',identity:f.identity,
    scope:f.scope,requirements:f.requirements}));
  fs.writeFileSync(plan,JSON.stringify({mode:'resume',config:'run.json',hostContext:'never-start',permissions:[]}));
  f.store.close();
  const stateFile=path.join(f.specs,'.reviews','.execution',f.identity.runId,'state.json'),before=fs.readFileSync(stateFile);
  const result=inspectContinuationPlan(plan);assert.deepEqual(result.issues,[]);
  assert.equal(result.currentReviewInput.requestDigest,expected.requestDigest);
  assert.equal(result.currentReviewInput.packageDigest,frame.reviewPackage.packageDigest);
  assert.equal(result.currentReviewInput.transport,'read_material');assert.equal(result.currentReviewInput.authorizationGranted,false);
  assert(result.currentReviewInput.pageCount>1&&result.currentReviewInput.pageCount<=256);
  for(const key of ['pageCount','materialBytes','imageCount','imageBytes'])assert.equal(typeof result.currentReviewInput[key],'number');
  assert.equal(result.currentReviewInput.scope.exceeded,false);
  assert.equal(f.reviewCalls(),0);assert.deepEqual(fs.readFileSync(stateFile),before);
});

test('reachable Codex fallback is admitted before any Claude attempt or review intent',async t=>{
 const f=fixture(t,{provider:'claude',fallbackCodex:true,scopeLimits:{pageCount:1024,materialBytes:16777216}});
 assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
 const before=JSON.stringify(f.store.snapshot()),status=JSON.stringify(f.runner.status());
 assert.deepEqual(await f.runner.executeEffect(f.effect('review')),{outcome:'rejected',code:'review_input_too_large'});
 assert.equal(f.reviewCalls(),0);assert.equal(JSON.stringify(f.store.snapshot()),before);assert.equal(JSON.stringify(f.runner.status()),status);
});

for(const observed of [false,true])test(`scope refusal precedes intent and consumes zero records or review attempts (v${observed?3:1})`,async t=>{
 const f=fixture(t,{bytes:600000,observed});
 assert.equal((await f.runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
 const before=JSON.stringify(f.store.snapshot()),status=JSON.stringify(f.runner.status());
 const result=await f.runner.executeEffect(f.effect('review'));
 assert.equal(result.outcome,'rejected');assert.equal(result.code,'review_scope_too_large');
 assert(result.scope.measured.materialBytes>result.scope.limits.materialBytes);
 assert.match(result.reason,/请把任务拆成多个更小的 task 再审查/);
 assert.equal(f.reviewCalls(),0);assert.equal(JSON.stringify(f.store.snapshot()),before);assert.equal(JSON.stringify(f.runner.status()),status);
 assert.deepEqual(await f.runner.executeEffect(f.effect('review','another-id')),result);
});
test('old registered/cached review resumes under lower limits without redispatch or retroactive refusal',async t=>{
 const f=fixture(t,{bytes:600000,observed:true,scopeLimits:{pageCount:256,materialBytes:4194304}});
 await f.runner.executeEffect(f.effect('develop'));const previous=await f.runner.executeEffect(f.effect('review'));
 assert.equal(f.reviewCalls(),1);
 const resumed=f.resume({pageCount:1,materialBytes:1,imageCount:1,imageBytes:1});
 const result=await resumed.executeEffect(f.effect('review'));
 assert.equal(result.state,previous.state);assert.equal(result.code,previous.code);
 assert.deepEqual(result.calls,previous.calls);assert.deepEqual(result.reviewInvocation,previous.reviewInvocation);assert.equal(f.reviewCalls(),1);
});

function preflightFixture(f,{pending=false,limits}={}){
 f.store.close();
 const stateFile=path.join(f.specs,'.reviews','.execution',f.identity.runId,'state.json');
 if(pending){
  const saved=JSON.parse(fs.readFileSync(stateFile)),at=saved.records.findIndex(r=>r.payload.type==='review-invocation-registered');
  assert(at>=0);const {revision,...body}=saved;body.records=saved.records.slice(0,at+1);
  fs.writeFileSync(stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
 }
 const config=path.join(f.root,'run.json'),plan=path.join(f.root,'PLAN.json');
 fs.writeFileSync(config,JSON.stringify({version:1,codeProject:f.code,specsDir:f.specs,feature:'1.feature',identity:f.identity,scope:f.scope,requirements:f.requirements}));
 const permissions=[];if(limits){fs.writeFileSync(path.join(f.root,'review.json'),JSON.stringify({model:'fixture',preflight:{},scopeLimits:limits}));permissions.push('--review-config','review.json');}
 fs.writeFileSync(plan,JSON.stringify({mode:'resume',config:'run.json',hostContext:'never-start',permissions}));
 const before=fs.readFileSync(stateFile),result=inspectContinuationPlan(plan);assert.deepEqual(fs.readFileSync(stateFile),before);return result;
}
test('oversize preflight keeps all four measurements, blocks new intent and honors review-config overrides',async t=>{
 const f=fixture(t,{bytes:600000,observed:true});await f.runner.executeEffect(f.effect('develop'));
 const blocked=preflightFixture(f);assert.equal(blocked.status,'blocked');assert(blocked.issues.some(i=>i.code==='review_scope_too_large'));
 assert.equal(blocked.currentReviewInput.scopeDisposition,'blocked_new_review');assert.equal(blocked.currentReviewInput.imageCount,0);assert.equal(blocked.currentReviewInput.imageBytes,0);
 const tuned=preflightFixture(f,{limits:{pageCount:256,materialBytes:4194304}});assert.deepEqual(tuned.issues,[]);assert.equal(tuned.currentReviewInput.scope.exceeded,false);assert.equal(f.reviewCalls(),0);
});
test('already registered pending old review is warning-only in read-only preflight with its original request identity',async t=>{
 const f=fixture(t,{bytes:600000,observed:true,scopeLimits:{pageCount:256,materialBytes:4194304}});
 await f.runner.executeEffect(f.effect('develop'));await f.runner.executeEffect(f.effect('review'));
 const request=f.captured(),report=preflightFixture(f,{pending:true});
 assert.deepEqual(report.issues.map(i=>i.code),['pending_effect']);assert.equal(report.currentReviewInput.scope.exceeded,true);
 assert.equal(report.currentReviewInput.scopeDisposition,'warning_existing_review');assert.equal(report.currentReviewInput.requestDigest,request.requestDigest);assert.equal(f.reviewCalls(),1);
});
