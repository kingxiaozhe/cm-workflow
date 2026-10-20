// Synthetic local packages and fake processes only; no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {captureNativeReviewEvidence} from '../runtime/js/cm-ai/native-review-evidence.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {prepareCodexReviewInput,createCodexReviewRun,buildReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {readConversationReviewConfigurationValue} from './cm-ai-host.mjs';
import {inspectReviewScope} from '../runtime/js/cm-ai/review-scope-policy.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t,{imageCount=2}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-size-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const [codeProject,specsDir,sourceRoot]=['code','specs','native'].map(n=>{const p=path.join(root,n);fs.mkdirSync(p);return p;});
 const identity={repositoryId:'size',runId:'run',taskId:'T-001',attempt:1};
 fs.writeFileSync(path.join(codeProject,'value.txt'),'before');
 fs.writeFileSync(path.join(codeProject,'requirements.md'),'Synthetic acceptance');
 const baseline=captureReviewBaseline({root:codeProject,identity,scope:['value.txt'],requirements:['requirements.md']});
 fs.writeFileSync(path.join(codeProject,'value.txt'),'after'.repeat(8000));
 const images=Array.from({length:imageCount},(_,i)=>`image-${i}.png`).map(name=>{fs.writeFileSync(path.join(sourceRoot,name),png);return {path:name,size:png.length,sha256:sha(png),description:'Synthetic image'};});
 fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify({version:1,report:'Synthetic provenance, no visual acceptance.',sourceFiles:[{path:'value.txt',sha256:sha(fs.readFileSync(path.join(codeProject,'value.txt')))}],images}));
 const check=captureNativeReviewEvidence({version:1,sourceRoot,manifest:'manifest.json'},{codeProject,specsDir,identity,scope:['value.txt']});
 const pkg=createReviewPackage({root:codeProject,baseline,checks:[check]});
 const request=requestFor({invocationId:'review',identity,role:'reviewer',provider:'codex',requestedModel:'gpt-6.1-sol',contextId:'fresh',payload:{reviewPackage:pkg,priorReview:null}});
 let spawns=0;
 const options={cwd:codeProject,model:'gpt-6.1-sol',effort:'high'};
 const worker=codexWorker({...options,schemaPath:'/fixture/schema',preflight:{passed:true,cli_model:options.model,config_fingerprint:configFingerprint(options)},spawnProcess(){
  spawns++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  queueMicrotask(()=>{for(const event of [{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{}'}},{type:'turn.completed'}])child.stdout.write(JSON.stringify(event)+'\n');child.stdout.end();child.stderr.end();child.emit('close',0,null);});return child;
 }});
 return {request,worker,spawns:()=>spawns,control:{signal:new AbortController().signal,onEvent(){}}};
}
const keys=['pageCount','materialBytes','imageCount','imageBytes'];
test('inclusive limits permit ordinary review and all four exact measurements are present',async t=>{
 const f=fixture(t),scope=prepareCodexReviewInput(f.request).scope;
 assert.deepEqual(scope.limits,{pageCount:128,materialBytes:2097152,imageCount:10,imageBytes:12582912});
 assert.deepEqual(Object.keys(scope.measured),keys);assert(scope.measured.pageCount>1);
 assert.equal(scope.measured.imageCount,2);assert.equal(scope.measured.imageBytes,2*png.length);
 assert.equal(scope.exceeded,false);
 assert.equal((await createCodexReviewRun(f.worker)(f.request,{...f.control,reviewScopeAdmission:{limits:scope.measured}})).status,'succeeded');assert.equal(f.spawns(),1);
});
for(const key of keys)test(`only ${key} exceeds its limit: blocked with zero spawnProcess calls`,async t=>{
 const f=fixture(t),measured=inspectReviewScope(buildReviewPrompt(f.request,'codex'),f.request.payload.reviewPackage).measured,limits={...measured,[key]:measured[key]-1};
 await assert.rejects(async()=>createCodexReviewRun(f.worker)(f.request,{...f.control,reviewScopeAdmission:{limits}}),error=>{
  assert.equal(error.code,'review_scope_too_large');assert.deepEqual(error.scope.measured,measured);
  assert.deepEqual(error.scope.exceededDimensions,[key]);assert.deepEqual(error.scope.limits,limits);
  assert.match(error.message,/请把任务拆成多个更小的 task 再审查/);return true;
 });assert.equal(f.spawns(),0);
});
test('legacy registered dispatch without new-intent admission remains compatible',async t=>{
 const f=fixture(t); // Legacy controls do not acquire a retroactive gate.
 assert.equal((await createCodexReviewRun(f.worker)(f.request,f.control)).status,'succeeded');assert.equal(f.spawns(),1);
});
test('existing review-config accepts project scope overrides and rejects invalid limits',()=>{
 const raw={model:'gpt-6.1-sol',preflight:{},scopeLimits:{imageCount:4}};
 assert.equal(readConversationReviewConfigurationValue(raw).scopeLimits.imageCount,4);
 for(const value of [0,-1,1.5,'10',null])assert.throws(()=>readConversationReviewConfigurationValue({...raw,scopeLimits:{imageCount:value}}));
 assert.throws(()=>readConversationReviewConfigurationValue({...raw,scopeLimits:{imagCount:4}}));
});

test('large 256-page native package reports every exceeded default dimension without starting transport',()=>{
 const image={size:1200000},pkg={checks:[{kind:'native-evidence',outcome:'passed',material:{images:Array(10).fill(image)}}],evidenceContinuation:{newEvidence:{kind:'native-evidence',outcome:'passed',material:{images:Array(8).fill(image)}}}};
 const scope=inspectReviewScope('x'.repeat(4193167),pkg);
 assert.deepEqual(scope.measured,{pageCount:256,materialBytes:4193167,imageCount:18,imageBytes:21600000});
 assert.deepEqual(scope.exceededDimensions,keys);
});

test('project scope policy reaches the conversation execution without rewriting legacy fingerprints',t=>{
 const f=fixture(t);
 // The worker fixture already proves config parsing and dispatch; this checks
 // the production host factory's transient policy forwarding independently.
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-size-config-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const definition={codeProject:root,specsDir:path.dirname(root),feature:'1.work',identity:f.request.identity,scope:['value.txt'],requirements:[]};
 const review=readConversationReviewConfigurationValue({model:'gpt-6.1-sol',preflight:{passed:true,cli_model:'gpt-6.1-sol',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:root,model:'gpt-6.1-sol'})}});
 const bridge={call:()=>assert.fail('no call expected')};
 const old=createConversationExecution(definition,'host-fixture',bridge,review);
 const tuned=createConversationExecution(definition,'host-fixture',bridge,{...review,scopeLimits:{imageCount:4}});
 assert.deepEqual(old.configuration,tuned.configuration);assert.equal(tuned.reviewScopeLimits.imageCount,4);
});
