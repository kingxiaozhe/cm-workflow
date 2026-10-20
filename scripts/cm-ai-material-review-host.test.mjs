import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {requestFor,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {runMaterialReview,readMaterialReviewResult,republishMaterialReviewProof} from '../runtime/js/cm-ai/host-material-review.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {prepareCodexReviewInput} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {createReviewMaterialSession,openReviewMaterialReader} from '../runtime/js/cm-ai/review-material.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-material-host-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.reviews'));fs.writeFileSync(path.join(root,'requirements.md'),'fixed criteria\n');fs.writeFileSync(path.join(root,'file.txt'),'base\n');const identity={repositoryId:'fixture',runId:'material-run',taskId:'T-001',attempt:1};const baseline=captureReviewBaseline({root,identity,scope:['file.txt'],requirements:['requirements.md']});fs.writeFileSync(path.join(root,'file.txt'),'changed\n');let pkg=createReviewPackage({root,baseline,checks:[{id:'check',command:['true'],outcome:'passed',exitCode:0,evidence:'synthetic check'}]});
 // Use a validated historical compressed text record; no filesystem budget change.
 const bytes=Buffer.from('original full evidence\n'.repeat(27000));const record={path:'file.txt',type:'file',mode:420,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentGzipBase64:gzipSync(bytes).toString('base64')};pkg=structuredClone(pkg);pkg.changes[0].after=record;const before=Buffer.from('previous full evidence\n'.repeat(27000));pkg.changes[0].before={...record,size:before.length,sha256:createHash('sha256').update(before).digest('hex'),contentGzipBase64:gzipSync(before).toString('base64')};pkg.artifactDigest=digest(pkg.changes);const {packageDigest,...body}=pkg;pkg={...body,packageDigest:digest(body)};
 const request=requestFor({invocationId:'material-review-1',identity,role:'reviewer',provider:'codex',requestedModel:'synthetic',contextId:'fresh-material',payload:{reviewPackage:pkg,priorReview:null}});return {root,request,definition:{specsDir:root},reviewOptions:{cwd:root,model:'synthetic',promptTransport:'stdin'}};}
for(const mode of ['incomplete','full','cancel-after-terminal','invalid-ledger','provider-failed'])test(`material ${mode} coverage gates all successful events and reconciliation`,async t=>{
 const all=['full','cancel-after-terminal'].includes(mode),controller=new AbortController();const f=fixture(t),events=[],receipts=[];let sessionPath;
 const historyFile=path.join(f.root,'.reviews','old-receipt.json'),history=Buffer.from('{"verdict":"blocked","history":"retained"}\n');fs.writeFileSync(historyFile,history);
 const dependencies={preview:async options=>({passed:true,cli_model:options.model,prompt_transport:'stdin',config_fingerprint:configFingerprint(options)}),worker:options=>async(input,control)=>{
   sessionPath=path.dirname(options.materialTransport.cwd);const config=JSON.parse(options.materialTransport.mcpConfig);const reader=openReviewMaterialReader(config.mcpServers.cm_review.args[1]);const plan=prepareCodexReviewInput(f.request);assert.equal(input.prompt,plan.prompt);assert(input.prompt.length<1048576);
   control.onEvent({event:'thread.started',provider_thread:'real-synthetic-thread'});control.onEvent({event:'turn.started',item_type:null});
   for(let page=0;page<(all?reader.manifest.pageCount:1);page++)reader.call('read_material',{page});
   if(mode==='invalid-ledger')fs.writeFileSync(path.join(sessionPath,'coverage.json'),'{}\n');
   if(mode==='provider-failed'){
    control.onEvent({event:'process_closed',exit_code:1,signal:null,timed_out:false});
    control.onTerminal({status:'failed',code:'provider_failed'});return {status:'failed',code:'provider_failed'};
   }
   control.onEvent({event:'item.completed',item_type:'agent_message'});control.onEvent({event:'turn.completed',item_type:null});control.onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});const value={verdict:'approved',packageDigest:f.request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(f.request.payload.reviewPackage),findings:[],summary:'synthetic transport fixture'};control.onTerminal({status:'succeeded',value});if(mode==='cancel-after-terminal'){controller.abort();return {status:'cancelled',code:'cancelled'};}return {status:'succeeded',value};}};
 const before=JSON.stringify(f.request);const result=await runMaterialReview({...f,control:{signal:controller.signal,onEvent:e=>events.push(e),onReconciliation:r=>{assert(fs.readdirSync(path.join(f.root,'.reviews')).some(p=>p.startsWith('material-')),'proof exists before terminal');receipts.push(r);}}},dependencies);
 assert.equal(JSON.stringify(f.request),before);assert.equal(fs.existsSync(sessionPath),false);
 assert.deepEqual(fs.readFileSync(historyFile),history,'old evidence is never modified');
 const files=fs.readdirSync(path.join(f.root,'.reviews')),diagnosticFiles=files.filter(p=>p.startsWith('material-failure-'));
 if(all){
  assert.equal(result.status,mode==='cancel-after-terminal'?'cancelled':'succeeded');assert.equal(receipts.length,1);assert(events.some(e=>e.event==='turn.completed'));
  assert.equal(diagnosticFiles.length,0);const file=files.find(p=>p.startsWith('material-'));
  const proof=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',file)));assert.equal(proof.pages.length,proof.manifest.pageCount);assert.equal(proof.requestDigest,f.request.requestDigest);
 }else{
  assert.equal(result.status,'failed');assert.equal(events.some(e=>e.event==='turn.completed'||e.event==='item.completed'),false);
  assert.equal(receipts.length,mode==='provider-failed'?1:0);
  if(mode==='provider-failed')assert.equal(receipts[0].result.status,'failed');
  if(mode==='incomplete')assert.equal(result.code,'review_material_incomplete');
  assert.equal(diagnosticFiles.length,1);assert.equal(files.filter(p=>p.startsWith('material-')&&!p.startsWith('material-failure-')).length,0,'diagnostic is not a complete coverage proof');
  const file=path.join(f.root,'.reviews',diagnosticFiles[0]),bytes=fs.readFileSync(file),d=JSON.parse(bytes),{diagnosticDigest,...body}=d;
  const expected=prepareCodexReviewInput(f.request).material.manifest;
  assert.equal(diagnosticDigest,digest(body));assert.equal(d.requestDigest,f.request.requestDigest);assert.equal(d.packageDigest,f.request.payload.reviewPackage.packageDigest);
  assert.equal(d.promptSha256,expected.promptSha256);assert.equal(d.manifestDigest,digest(expected));assert.equal(d.providerThreadId,'real-synthetic-thread');
  assert.equal(d.version,4);assert.equal(d.invocationId,f.request.invocationId);assert.deepEqual(d.identity,f.request.identity);
  assert.equal(d.providerEndEvent,mode==='provider-failed'?null:'turn.completed');assert.equal(d.processClosed.exit_code,mode==='provider-failed'?1:0);
  assert.deepEqual(d.providerTerminal,{status:mode==='provider-failed'?'failed':'succeeded',code:mode==='provider-failed'?'provider_failed':null});
  assert.deepEqual(d.cleanupErrors,[]);
  assert.equal(d.stage,mode==='provider-failed'?'provider':'coverage');assert.equal(d.code,result.code);assert.equal(d.completionEligible,false);assert.equal(d.expectedPages,expected.pageCount);
  if(mode==='invalid-ledger'){
   assert.equal(d.ledgerVerified,false);assert.equal(d.pageReadCount,null);assert.equal(d.readPages,null);assert.equal(d.missingPages,null);assert.equal(d.toolCallCount,null);
  }else{
   assert.equal(d.ledgerVerified,true);assert.equal(d.pageReadCount,1);assert.equal(d.readPages,1);assert.equal(d.toolCallCount,1);
   assert.deepEqual(d.missingPages,Array.from({length:expected.pageCount-1},(_,i)=>i+1));
  }
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.deepEqual(Object.keys(d).sort(),['version','kind','invocationId','identity','requestDigest','packageDigest','promptSha256','manifestDigest','providerThreadId','stage','code','expectedPages','readPages','missingPages','toolCallCount','pageReadCount','ledgerVerified','toolFailures','toolFailureCount','duplicateReadCount','providerTerminal','providerEndEvent','processClosed','nativeDiagnostic','cleanupErrors','completionEligible','diagnosticDigest'].sort());
  assert(bytes.length<16*1024,'bounded metadata, no material or secret');
 }
});

const preview=async options=>({passed:true,cli_model:options.model,prompt_transport:'stdin',config_fingerprint:configFingerprint(options)});
test('actual worker failure with exit zero retains diagnostics in immutable material sidecar',async t=>{
 const f=fixture(t),events=[],receipts=[];
 const options={...f.reviewOptions,timeoutMs:2000,spawnProcess(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  let closed=false;const close=()=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',0,null);};
  child.kill=()=>{queueMicrotask(close);return true;};
  queueMicrotask(()=>{
   for(const event of [{type:'thread.started',thread_id:'diagnostic-native-thread'},{type:'turn.started'},
    {type:'error',message:'unclassified native error'},
    {type:'turn.failed',error:{code:'context_length_exceeded',message:'PRIVATE provider details'}}])child.stdout.write(JSON.stringify(event)+'\n');
   close();
  });return child;
 }};
 const result=await runMaterialReview({...f,reviewOptions:options,control:{signal:new AbortController().signal,
  onEvent:e=>events.push(e),onReconciliation:r=>receipts.push(r)}},{preview,session:input=>{
   const session=createReviewMaterialSession(input),config=JSON.parse(session.transport.mcpConfig);
   // A real CLI starts the material MCP server even when it reads zero pages.
   // The synthetic process must perform that initialization, without any call.
   openReviewMaterialReader(config.mcpServers.cm_review.args[1]);return session;
  }});
 assert.deepEqual(result,{status:'failed',code:'provider_failed'});
 const file=fs.readdirSync(path.join(f.root,'.reviews')).find(n=>n.startsWith('material-failure-'));
 const failure=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',file))),{diagnosticDigest,...body}=failure;
 assert.equal(diagnosticDigest,digest(body));assert.equal(failure.nativeDiagnostic.diagnostic.code,'context_length_exceeded');
 assert.equal(failure.readPages,0);assert.equal(failure.toolCallCount,0);assert.equal(failure.processClosed.exit_code,0);
 assert.equal(receipts.length,1);assert.equal(receipts[0].events.at(-1).diagnostic.code,'context_length_exceeded');
 assert.equal(events.filter(e=>['error','turn.failed'].includes(e.event)).length,1);
 assert(!JSON.stringify({events,failure,receipts}).includes('PRIVATE'));
 assert.equal(failure.completionEligible,false);
});
function syntheticWorker(f,{mode='full',verdict='approved',afterTerminal=()=>{},batch=false}={}){
 return options=>async(input,control)=>{
  const root=path.dirname(options.materialTransport.cwd);
  if(mode==='worker-throw'){const e=new Error('PRIVATE stderr body');e.code='EIO';throw e;}
  const config=JSON.parse(options.materialTransport.mcpConfig),reader=openReviewMaterialReader(config.mcpServers.cm_review.args[1]);
  control.onEvent({event:'thread.started',provider_thread:'saved-result-thread'});control.onEvent({event:'turn.started',item_type:null});
  if(mode==='tool-failure'){
   assert.throws(()=>reader.call('read_material',{page:-1}));
   reader.call('read_material',{page:0});reader.call('read_material',{page:0});
  }else for(let page=0;page<reader.manifest.pageCount;){
   if(batch){const value=reader.call('read_material',{page,count:8});page+=value.pages.length;assert.equal(value.nextPage,page<reader.manifest.pageCount?page:null);}
   else{reader.call('read_material',{page});page++;}
  }
  control.onEvent({event:'item.completed',item_type:'agent_message'});control.onEvent({event:'turn.completed',item_type:null});
  control.onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
  const value={verdict,packageDigest:f.request.payload.reviewPackage.packageDigest,
   examinedPaths:reviewPaths(f.request.payload.reviewPackage),findings:verdict==='changes_requested'
    ?[{id:'F1',severity:'P2',path:'file.txt',message:'synthetic concrete defect',evidence:'synthetic evidence'}]:[],summary:'synthetic result'};
  if(mode==='invalid-result')value.packageDigest='b'.repeat(64);
  control.onTerminal({status:'succeeded',value});afterTerminal(root);return {status:'succeeded',value};
 };
}
for(const mode of ['preflight','preflight-cleanup','worker-throw','tool-failure','proof-publication','result-publication','cleanup','invalid-result'])test(`material failure ${mode} preserves bound diagnostics without success forwarding`,async t=>{
 const f=fixture(t),events=[],receipts=[],temporaryRoots=[];let sessionCount=0;
 const dependencies={preview:mode==='preflight'?async()=>{throw new Error('PRIVATE prompt/token/stderr');}:preview,
  session:input=>{
   const session=createReviewMaterialSession(input),root=path.dirname(session.transport.cwd);temporaryRoots.push(root);sessionCount++;
   if((mode==='cleanup'&&sessionCount===2)||(mode==='preflight-cleanup'&&sessionCount===1))return {...session,close:async()=>{await session.close();const e=new Error('PRIVATE cleanup detail');e.code='EACCES';throw e;}};
   return session;
  },worker:syntheticWorker(f,{mode,afterTerminal:()=>{
   if(mode==='proof-publication'||mode==='result-publication'){
    const name=(mode==='proof-publication'?'material-':'material-result-')+digest({request:f.request.requestDigest,thread:'saved-result-thread'})+'.json';
    fs.writeFileSync(path.join(f.root,'.reviews',name),'conflict\n',{mode:0o600});
   }
  }})};
 const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:e=>events.push(e),onReconciliation:r=>receipts.push(r)}},dependencies);
 assert.equal(result.status,'failed');assert(!events.some(e=>e.event==='turn.completed'||e.event==='item.completed'));assert.equal(receipts.length,0);
 assert(temporaryRoots.every(root=>!fs.existsSync(root)),'temporary materials are removed even on failed publication');
 const files=fs.readdirSync(path.join(f.root,'.reviews')),failure=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',files.find(n=>n.startsWith('material-failure-')))));
 assert.equal(failure.invocationId,f.request.invocationId);assert.deepEqual(failure.identity,f.request.identity);
 assert.equal(failure.requestDigest,f.request.requestDigest);assert.equal(failure.completionEligible,false);assert(failure.expectedPages>1);
 assert.equal(failure.stage,{'preflight':'preflight','preflight-cleanup':'preflight_cleanup','worker-throw':'provider','tool-failure':'coverage','proof-publication':'proof_publication','result-publication':'result_publication','cleanup':'cleanup','invalid-result':'result_publication'}[mode]);
 const rendered=JSON.stringify(failure);assert(!rendered.includes('PRIVATE'));assert(!rendered.includes('original full evidence'));assert(rendered.length<16*1024);
 if(['preflight','preflight-cleanup','worker-throw'].includes(mode)){
  assert.equal(failure.readPages,null);assert.equal(failure.missingPages,null);assert.equal(failure.toolFailures,null);
  assert.equal(failure.providerTerminal,null);assert.equal(failure.processClosed,null);
 }
 if(mode==='tool-failure'){
  assert.equal(failure.readPages,1);assert.equal(failure.pageReadCount,2);assert.equal(failure.toolCallCount,3);assert.equal(failure.duplicateReadCount,1);
  assert.equal(failure.toolFailureCount,1);assert.deepEqual(failure.toolFailures,[{call:1,code:'review_material_page'}]);
 }
 if(mode==='cleanup')assert.deepEqual(failure.cleanupErrors,[{resource:'session',code:'EACCES'}]);
 if(['cleanup','proof-publication'].includes(mode)){
  const options={definition:f.definition,request:f.request,providerThreadId:'saved-result-thread'};
  const saved=readMaterialReviewResult(options);assert.equal(saved.ownerAccepted,false);assert.equal(saved.result.verdict,'approved');
  assert.equal(saved.proof.pages.length,saved.proof.manifest.pageCount);
  const sidecar=path.join(f.root,'.reviews','material-result-'+digest({request:f.request.requestDigest,thread:'saved-result-thread'})+'.json'),before=fs.readFileSync(sidecar);
  if(mode==='proof-publication'){
   assert.throws(()=>republishMaterialReviewProof(options),'conflicting proof must not be overwritten');
   // Test-owned fault removal represents retrying an interrupted publication.
   fs.unlinkSync(path.join(f.root,'.reviews','material-'+digest({request:f.request.requestDigest,thread:'saved-result-thread'})+'.json'));
  }
  assert.deepEqual(republishMaterialReviewProof(options),saved);assert.deepEqual(republishMaterialReviewProof(options),saved);
  assert.deepEqual(fs.readFileSync(sidecar),before,'same result remains immutable');
  assert.throws(()=>readMaterialReviewResult({...options,providerThreadId:'wrong-thread'}));
  assert.throws(()=>readMaterialReviewResult({...options,request:{...f.request,invocationId:'wrong-invocation'}}));
 }
});
for(const verdict of ['approved','changes_requested','blocked'])test(`material ${verdict} adapter result is saved before forwarding without owner receipt`,async t=>{
 const f=fixture(t),events=[];const options={definition:f.definition,request:f.request,providerThreadId:'saved-result-thread'};
 const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:e=>{
  if(e.event==='turn.completed')assert.equal(readMaterialReviewResult(options).result.verdict,verdict);
  events.push(e);
 }}},{preview,worker:syntheticWorker(f,{verdict})});
 assert.equal(result.status,'succeeded');assert.equal(result.value.verdict,verdict);assert(events.some(e=>e.event==='turn.completed'));
 const saved=readMaterialReviewResult(options);assert.equal(saved.result.verdict,verdict);assert.equal(saved.ownerAccepted,false);
 assert(!fs.readdirSync(path.join(f.root,'.reviews')).some(n=>n.includes('receipt')));
});
test('cleanup failure cannot erase an earlier material failure or invent exit information',async t=>{
 const f=fixture(t);let count=0;
 const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:()=>{}}},{preview,
  session:input=>{const session=createReviewMaterialSession(input);if(++count!==2)return session;
   return {...session,close:async()=>{await session.close();const e=new Error('private');e.code='EACCES';throw e;}};},
  worker:()=>async()=>{const e=new Error('private root failure');e.code='EIO';throw e;}});
 assert.deepEqual(result,{status:'failed',code:'EIO'});
 const name=fs.readdirSync(path.join(f.root,'.reviews')).find(n=>n.startsWith('material-failure-')),
  diagnostic=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',name)));
 assert.equal(diagnostic.code,'EIO');assert.equal(diagnostic.stage,'provider');assert.equal(diagnostic.processClosed,null);
 assert.deepEqual(diagnostic.cleanupErrors,[{resource:'session',code:'EACCES'}]);
});
test('input admission diagnostics keep unavailable material counts unknown',async t=>{
 const f=fixture(t);let touched=false;
 const result=await runMaterialReview({...f,reviewOptions:{...f.reviewOptions,model:'wrong-model'},control:{signal:new AbortController().signal,onEvent:()=>{}}},
  {preview:async()=>{touched=true;},worker:()=>{touched=true;}});
 assert.equal(result.status,'failed');assert.equal(touched,false);
 const name=fs.readdirSync(path.join(f.root,'.reviews')).find(n=>n.startsWith('material-failure-')),
  d=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',name)));
 assert.equal(d.stage,'input_admission');assert.equal(d.expectedPages,null);assert.equal(d.readPages,null);assert.equal(d.missingPages,null);
 assert.equal(d.invocationId,f.request.invocationId);assert.equal(d.processClosed,null);
});
test('confirmed native exit classification is retained without raw provider diagnostics',async t=>{
 const f=fixture(t);const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:()=>{}}},{preview,
  worker:options=>async(_input,control)=>{
   options.onDiagnostic({kind:'codex_review_exit',category:'rate_limit',httpStatus:429,stderrByteCount:100,stderr:'PRIVATE TOKEN'});
   control.onEvent({event:'process_closed',exit_code:1,signal:null,timed_out:false});return {status:'failed',code:'incomplete_result'};
  }});
 assert.equal(result.status,'failed');const file=fs.readdirSync(path.join(f.root,'.reviews')).find(n=>n.startsWith('material-failure-')),
  d=JSON.parse(fs.readFileSync(path.join(f.root,'.reviews',file)));
 assert.deepEqual(d.nativeDiagnostic,{kind:'codex_review_exit',category:'rate_limit',httpStatus:429,stderrByteCount:100});
 assert.equal(d.processClosed.exit_code,1);assert.equal(d.providerTerminal,null);assert(!JSON.stringify(d).includes('PRIVATE'));
});
test('saved material result rejects linked roots/files and same-byte mutation during fd read',async t=>{
 const f=fixture(t),options={definition:f.definition,request:f.request,providerThreadId:'saved-result-thread'};
 const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:()=>{}}},{preview,worker:syntheticWorker(f)});
 assert.equal(result.status,'succeeded');
 const reviewsDir=path.join(f.root,'.reviews'),name='material-result-'+digest({request:f.request.requestDigest,thread:'saved-result-thread'})+'.json',
  file=path.join(reviewsDir,name),retained=file+'.retained';
 fs.renameSync(file,retained);fs.symlinkSync(retained,file);
 assert.throws(()=>readMaterialReviewResult(options),e=>e.code==='review_material_path');fs.unlinkSync(file);fs.renameSync(retained,file);
 const alternate=path.join(f.root,'retained-reviews');fs.renameSync(reviewsDir,alternate);fs.symlinkSync(alternate,reviewsDir);
 assert.throws(()=>readMaterialReviewResult(options),e=>e.code==='review_material_path');fs.unlinkSync(reviewsDir);fs.renameSync(alternate,reviewsDir);
 const originalRead=fs.readFileSync;let raced=false;
 fs.readFileSync=function(target,...args){
  const bytes=originalRead.call(this,target,...args);
  if(typeof target==='number'&&!raced){raced=true;const st=fs.statSync(file);fs.utimesSync(file,st.atime,new Date(st.mtimeMs+10000));}
  return bytes;
 };
 try{assert.throws(()=>readMaterialReviewResult(options),e=>e.code==='review_material_changed');assert.equal(raced,true);}
 finally{fs.readFileSync=originalRead;}
});

for(const legacy of [false,true])test(`saved material ${legacy?'legacy v1':'batch v2'} proof retains strict result reconciliation`,async t=>{
 const f=fixture(t),options={definition:f.definition,request:f.request,providerThreadId:'saved-result-thread'};
 const result=await runMaterialReview({...f,control:{signal:new AbortController().signal,onEvent:()=>{}}},
  {preview,worker:syntheticWorker(f,{batch:!legacy})});
 assert.equal(result.status,'succeeded');
 const sidecar=path.join(f.root,'.reviews','material-result-'+digest({request:f.request.requestDigest,thread:'saved-result-thread'})+'.json');
 const original=JSON.parse(fs.readFileSync(sidecar));assert.equal(original.proof.version,2);
 assert.equal(original.proof.pageReadCount,original.proof.manifest.pageCount);
 if(!legacy)assert(original.proof.callCount<original.proof.manifest.pageCount,'host must receive real batch counts');
 const writeProof=mutate=>{
  const value=structuredClone(original);mutate(value.proof);
  const {evidenceDigest,...proofBody}=value.proof;value.proof={...proofBody,evidenceDigest:digest(proofBody)};
  const {resultArtifactDigest,...body}=value;fs.writeFileSync(sidecar,JSON.stringify({...body,resultArtifactDigest:digest(body)})+'\n');
 };
 if(legacy){
  writeProof(p=>{p.version=1;p.callCount=p.pageReadCount;delete p.pageReadCount;});
  assert.equal(readMaterialReviewResult(options).proof.version,1,'historical single-page proof accepted without migration');
 }else{
  assert.equal(readMaterialReviewResult(options).proof.version,2);
  for(const mutate of [p=>p.pageReadCount--,p=>p.pageReadCount=257,p=>p.callCount=0,p=>p.callCount=257,p=>p.version=3,
   p=>p.pages.pop(),p=>p.promptSha256='0'.repeat(64),p=>p.promptBytes--]){
   writeProof(mutate);assert.throws(()=>readMaterialReviewResult(options),e=>e.code==='review_material_binding');
  }
 }
 fs.writeFileSync(sidecar,JSON.stringify(original)+'\n');
 assert.equal(readMaterialReviewResult(options).result.verdict,'approved');
});
