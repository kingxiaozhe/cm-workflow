import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {providerFailureDiagnostic,readProviderFailureDiagnostic,mergeProviderFailureDiagnostics} from '../runtime/js/cm-ai/provider-failure-diagnostic.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {requestFor,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {inspectProviderReview,inspectProviderReviewFailure} from '../runtime/js/cm-ai/provider-review-observation.mjs';

async function failedStream(failure,{stderr='',onDiagnostic=()=>{},cleanupError=false}={}) {
  const options={cwd:'/fixture',model:'fixture'},events=[];
  const run=codexWorker({...options,schemaPath:'/unused',timeoutMs:1000,onDiagnostic,
    preflight:{passed:true,cli_model:'fixture',config_fingerprint:configFingerprint(options)},
    spawnProcess(){
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      let closed=false;
      const close=()=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',0,null);};
      child.kill=()=>{if(cleanupError)throw Error('synthetic cleanup failure');queueMicrotask(close);return true;};
      queueMicrotask(()=>{
        child.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture-review'})+'\n');
        child.stdout.write(JSON.stringify({type:'turn.started'})+'\n');
        if(stderr)child.stderr.write(stderr);
        for(const event of failure)child.stdout.write(JSON.stringify(event)+'\n');
        close();
      });
      return child;
    }});
  const result=await run({prompt:'private prompt must not appear'},{signal:new AbortController().signal,onEvent:e=>events.push(e)});
  return {result,events};
}

test('stdout error with exit zero preserves an actionable bound diagnostic',async()=>{
  const diagnostics=[];
  const {result,events}=await failedStream([{type:'error',message:'context_length_exceeded'}],{onDiagnostic:d=>diagnostics.push(d)});
  assert.deepEqual(result,{status:'failed',code:'provider_failed'});
  const failure=events.find(e=>e.event==='error');
  assert.equal(failure.diagnostic.category,'context_limit');
  assert.equal(failure.diagnostic.code,'context_length_exceeded');
  assert.equal(failure.diagnostic.messageBytes,23);
  assert.equal(diagnostics.length,1);
  assert.equal(diagnostics[0].exitCode,0);
});

test('unknown and oversized provider text stays private and explicitly unclassified',async()=>{
  for(const message of ['Authorization: Bearer fixture-private-token /private/account-file', 'private-content'.repeat(900)]) {
    const {result,events}=await failedStream([{type:'error',message}]);
    assert.equal(result.status,'failed');
    const d=events.find(e=>e.event==='error').diagnostic;
    assert.equal(d.category,'unknown');assert.equal(d.code,null);
    assert.equal(d.messageBytes,Buffer.byteLength(message));assert.match(d.messageSha256,/^[a-f0-9]{64}$/);
    assert(!JSON.stringify(events).includes('private-content'));
    assert(!JSON.stringify(events).includes('fixture-private-token'));
    assert(JSON.stringify(d).length<600);
  }
});

test('a later turn.failed keeps its structured cause without a second failure terminal',async()=>{
  const {result,events}=await failedStream([{type:'error',message:'request failed'},
    {type:'turn.failed',error:{code:'rate_limit_exceeded',message:'private-native-detail'}}]);
  assert.equal(result.code,'provider_failed');
  assert.equal(events.filter(e=>['error','turn.failed'].includes(e.event)).length,1);
  assert.equal(events.at(-1).event,'process_closed');
  assert.equal(events.at(-1).diagnostic.code,'rate_limit_exceeded');
  assert.equal(events.at(-1).diagnostic.source,'stdout_turn_failed');
  assert(!JSON.stringify(events).includes('private-native-detail'));
});

test('diagnostic sink errors cannot turn failure into success or hide durable events',async()=>{
  const {result,events}=await failedStream([{type:'error',message:'invalid_image'}],{onDiagnostic(){throw Error('sink unavailable');}});
  assert.equal(result.status,'failed');assert.equal(events[2].diagnostic.category,'image_load_failed');
});

test('known then unknown preserves cause; disagreeing known causes stay conflict',async()=>{
  for(const [later,category,code] of [['unclassified request failure','context_limit','context_length_exceeded'],
    ['rate_limit_exceeded','conflict',null]]){
    const {events}=await failedStream([{type:'error',message:'context_length_exceeded'},
      {type:'turn.failed',error:{message:later}}]);
    assert.equal(events.at(-1).diagnostic.category,category);assert.equal(events.at(-1).diagnostic.code,code);
  }
});

test('diagnostic schema refuses arbitrary text, wrong version and contradictory classifications',()=>{
  const valid=providerFailureDiagnostic({error:{code:'invalid_image',message:'private raw detail'}},'stdout_turn_failed');
  for(const bad of [{...valid,message:'secret'},{...valid,version:2},{...valid,code:'private-code'},
    {...valid,category:'quota'},{...valid,messageBytes:-1},{...valid,messageSha256:'invalid'},
    {...valid,category:'conflict'}])assert.throws(()=>readProviderFailureDiagnostic(bad));
  const unknown=providerFailureDiagnostic({message:'context_length_exceeded private-suffix'},'stdout_error');
  assert.equal(unknown.category,'unknown','a substring does not establish the cause');
  assert.equal(mergeProviderFailureDiagnostics(unknown,valid).code,'invalid_image');
});

test('exit-zero stderr is classified without exposing its text; uncertain cleanup stays failed',async()=>{
  const {result,events}=await failedStream([{type:'error'}],{stderr:'error: http 429'});
  assert.equal(result.code,'provider_failed');assert.equal(events.at(-1).diagnostic.category,'http_status');
  assert.equal(events.at(-1).diagnostic.httpStatus,429);assert(!JSON.stringify(events).includes('error: http'));
  const uncertain=await failedStream([{type:'error',message:'context_length_exceeded'}],{cleanupError:true});
  assert.equal(uncertain.result.code,'process_cleanup_unknown');
  assert.equal(uncertain.events.at(-1).diagnostic.code,'context_length_exceeded');
});

test('observer binds diagnostic bytes while preserving legacy observation digests',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-failure-diagnostic-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'file.txt'),'old');
  fs.writeFileSync(path.join(root,'criteria.txt'),'Preserve bounded failure evidence.');
  const identity={repositoryId:'fixture',runId:'failure-diagnostic',taskId:'T-001',attempt:1};
  const baseline=captureReviewBaseline({root,identity,scope:['file.txt'],requirements:['criteria.txt']});
  fs.writeFileSync(path.join(root,'file.txt'),'new');const pkg=createReviewPackage({root,baseline,
    checks:[{id:'synthetic',command:['true'],outcome:'passed',exitCode:0,evidence:'fixture only'}]});
  const request=requestFor({invocationId:'review-1',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',
    contextId:'logical-reviewer',payload:{reviewPackage:pkg,priorReview:null}});
  const expectation=JSON.stringify({request,developerThreadId:'author-thread',excludedThreadIds:[]});
  const native=await failedStream([{type:'error',message:'context_length_exceeded'}]);
  const observation={version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,events:native.events,result:native.result};
  const inspected=inspectProviderReviewFailure(JSON.stringify(observation),expectation);
  assert.equal(inspected.diagnostic.category,'context_limit');assert.equal(inspected.completionEligible,false);
  assert.equal(inspected.observationDigest,digest(observation));
  const legacy=structuredClone(observation);for(const event of legacy.events)delete event.diagnostic;
  const before=JSON.stringify(legacy),legacyInspection=inspectProviderReviewFailure(before,expectation);
  assert.equal(legacyInspection.observationDigest,digest(legacy));assert(!Object.hasOwn(legacyInspection,'diagnostic'));
  assert.equal(JSON.stringify(legacy),before);
  for(const eventIndex of [2,3]){
    const malformed=structuredClone(observation);malformed.events[eventIndex].diagnostic.raw='private-secret';
    assert.throws(()=>inspectProviderReview(JSON.stringify(malformed),expectation));
    assert.equal(inspectProviderReviewFailure(JSON.stringify(malformed),expectation),null);
  }
  const onProgress=structuredClone(legacy);onProgress.events[1].diagnostic=inspected.diagnostic;
  assert.throws(()=>inspectProviderReview(JSON.stringify(onProgress),expectation));
});
