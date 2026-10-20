import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {binaryAssetStoreRoot} from '../runtime/js/cm-ai/binary-assets.mjs';
import {binaryAssetReviewProfile,runBinaryAssetReview,verifyBinaryReviewEvidence} from '../runtime/js/cm-ai/host-binary-review.mjs';
import {createReviewVerificationSession} from '../runtime/js/cm-fix/review-verification.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
function fixture({deleted=false,bad=false,codeOnly=false,nestedAgent=null,mixed=false,provider='claude'}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-host-binary-review-'))),codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),sourceRoot=path.join(root,'answers');
 for(const d of [codeProject,specsDir,sourceRoot])fs.mkdirSync(d);
 const identity={repositoryId:'fixture',runId:'binary-review',taskId:'T-001',attempt:1};
 const binding={version:1,paths:['font.ttf'],storeRoot:binaryAssetStoreRoot({specsDir,identity})};
 fs.writeFileSync(path.join(codeProject,'requirements.md'),'Fixed font requirement');fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Rules\nPreserve protection.\n');
 const before=Buffer.alloc(2*1024*1024,0xfe);before.writeUInt32BE(65536,0);fs.writeFileSync(path.join(codeProject,'font.ttf'),before);
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');const scope=codeOnly||mixed?['font.ttf','value.mjs']:['font.ttf'];
 if(nestedAgent!==null){fs.mkdirSync(path.join(codeProject,'nested'));fs.writeFileSync(path.join(codeProject,'nested/value.mjs'),'export const nested=1;');scope.push('nested/value.mjs');
  if(nestedAgent)fs.writeFileSync(path.join(codeProject,'nested/AGENTS.md'),'# Original nested rules\n');}
 const baseline=captureReviewBaseline({root:codeProject,specsRoot:specsDir,identity,scope,requirements:['requirements.md'],binaryAssets:binding});
 if(codeOnly)fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');
 else if(deleted)fs.unlinkSync(path.join(codeProject,'font.ttf'));else{const after=Buffer.from(before);after[after.length-1]=128;if(bad)after.writeUInt32BE(0,0);fs.writeFileSync(path.join(codeProject,'font.ttf'),after);}
 if(mixed)fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');
 const pkg=createReviewPackage({root:codeProject,baseline,checks:[{id:'author',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'Synthetic only'}]});
 const body={version:1,invocationId:'binary-review.1',identity,role:'reviewer',provider,requestedModel:'synthetic',contextId:'fresh-binary',payload:{reviewPackage:pkg,priorReview:null}};
 const request={...body,requestDigest:digest(body)},definition={identity,codeProject,specsDir,scope,requirements:['requirements.md']};
 const binaryAssets={...binding,sourceRoot};
 return {root,definition,binaryAssets,request,close(){fs.rmSync(root,{recursive:true,force:true});}};
}
const fake=fileURLToPath(new URL('./fixtures/binary-review-claude.mjs',import.meta.url));
const codexFake=fileURLToPath(new URL('./fixtures/binary-review-codex.mjs',import.meta.url));
function spawnFixture(mode){return (command,args,options)=>command==='/usr/bin/sandbox-exec'
 ?spawn(command,[...args.slice(0,2),process.execPath,fake,...args.slice(3)],options)
 :spawn(process.execPath,[fake,...args],{...options,env:{...options.env,CM_BINARY_REVIEW_FIXTURE_MODE:mode}});}
test('binary auto profile binds exact paths/model checks and leaves original no-tools configuration unchanged',()=>{
 const f=fixture();try{
  const p=binaryAssetReviewProfile(f);assert.deepEqual(p.mutationPaths,[]);assert.deepEqual(p.binaryReview,{version:1});
  assert(p.files.includes('AGENTS.md'));assert(p.files.includes('requirements.md'));assert.equal(p.checks[0].id,'asset-integrity');
  const changed={...f.binaryAssets,paths:['other.ttf']};assert.throws(()=>binaryAssetReviewProfile({...f,binaryAssets:changed}));
 }finally{f.close();}
});
for(const mode of ['valid','metadata-only','missing-before','bad-format','deleted','unchanged'])test(`actual binary review tools gate ${mode}`,{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const f=fixture({deleted:mode==='deleted',bad:mode==='bad-format',codeOnly:mode==='unchanged'});const events=[];
 try{
  const result=await runBinaryAssetReview({...f,reviewOptions:{cwd:f.definition.codeProject,model:'synthetic',timeoutMs:10000,spawnProcess:spawnFixture(mode)},
   control:{signal:new AbortController().signal,onEvent:e=>events.push(e)}});
  assert.equal(result.status,['valid','deleted','unchanged'].includes(mode)?'succeeded':'failed',JSON.stringify(result));
  assert(events.some(e=>e.event==='thread.started'));
  const evidenceRoot=path.join(f.definition.specsDir,'.reviews','.binary-review','fixture','binary-review',f.request.requestDigest);
  if(['valid','deleted','unchanged'].includes(mode)){
   const proof=JSON.parse(fs.readFileSync(path.join(evidenceRoot,fs.readdirSync(evidenceRoot)[0]))),{evidenceDigest,...body}=proof;
   assert.equal(evidenceDigest,digest(body));assert.equal(proof.evidence.checks[0].exitCode,0);
   assert.equal(proof.evidence.binaryReads.length,['deleted','unchanged'].includes(mode)?1:2);assert.deepEqual(proof.evidence.mutations,[]);
   assert.equal(proof.providerThreadId,'synthetic-binary-review');
  }else assert(!fs.existsSync(evidenceRoot));
 }finally{f.close();}
});
test('completion readback rejects missing, changed or differently bound binary evidence',{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const f=fixture();try{
  const result=await runBinaryAssetReview({...f,reviewOptions:{cwd:f.definition.codeProject,model:'synthetic',timeoutMs:10000,spawnProcess:spawnFixture('valid')},
   control:{signal:new AbortController().signal,onEvent(){}}});assert.equal(result.status,'succeeded',JSON.stringify(result));
  const args={...f,providerThreadId:'synthetic-binary-review'},proof=verifyBinaryReviewEvidence(args),bytes=fs.readFileSync(proof.path);
  const receiptRequest={provider:'claude',requestedModel:'synthetic',requestDigest:f.request.requestDigest,identity:f.request.identity,payload:{reviewPackage:f.request.payload.reviewPackage}};
  const {sourceRoot,...binding}=f.binaryAssets;
  assert.equal(verifyBinaryReviewEvidence({...args,binaryAssets:binding,request:receiptRequest}).evidenceDigest,proof.evidenceDigest);
  assert.throws(()=>verifyBinaryReviewEvidence({...args,providerThreadId:'wrong-thread'}));
  const wrong=structuredClone(receiptRequest);wrong.payload.reviewPackage.packageDigest='0'.repeat(64);
  assert.throws(()=>verifyBinaryReviewEvidence({...args,request:wrong}),{code:'binary_review_evidence_changed'});
  fs.writeFileSync(proof.path,'{}');assert.throws(()=>verifyBinaryReviewEvidence(args));
  fs.writeFileSync(proof.path,bytes);assert.equal(verifyBinaryReviewEvidence(args).evidenceDigest,proof.evidenceDigest);
  fs.writeFileSync(path.join(f.definition.codeProject,'requirements.md'),'A later approved task changed current text');
  fs.writeFileSync(path.join(f.definition.codeProject,'font.ttf'),Buffer.from('later product bytes'));
  assert.throws(()=>verifyBinaryReviewEvidence(args));
  assert.equal(verifyBinaryReviewEvidence({...args,inspectCurrent:false}).evidenceDigest,proof.evidenceDigest);
  const original=f.request.payload.reviewPackage.changes.find(c=>c.path==='font.ttf').before;
  const blob=path.join(f.binaryAssets.storeRoot,original.contentBlob),blobBytes=fs.readFileSync(blob);
  fs.writeFileSync(blob,'changed original review blob');
  assert.throws(()=>verifyBinaryReviewEvidence({...args,inspectCurrent:false}));
  fs.writeFileSync(blob,blobBytes);assert.equal(verifyBinaryReviewEvidence({...args,inspectCurrent:false}).evidenceDigest,proof.evidenceDigest);
  fs.unlinkSync(proof.path);assert.throws(()=>verifyBinaryReviewEvidence(args),{code:'ENOENT'});
  assert.throws(()=>verifyBinaryReviewEvidence({...args,inspectCurrent:false}),{code:'ENOENT'});
 }finally{f.close();}
});
test('binary-only evidence does not relax ordinary CM fix mutation requirement',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
  const configuration=binaryAssetReviewProfile(f);s=createReviewVerificationSession({codeProject:f.definition.codeProject,configuration,request:f.request});
  for(const version of ['before','after'])await s.call('read_binary',{path:'font.ttf',version,length:16});
  assert.equal((await s.call('run_check',{id:'asset-integrity'})).exitCode,0);
  assert.throws(()=>s.finish('fresh-binary'),{code:'review_verification_evidence'});
 }finally{await s?.close();f.close();}
});
for(const originallyPresent of [false,true])test(`historical binary proof survives ${originallyPresent?'removed':'new'} parent instructions without widening profile`,{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const f=fixture({nestedAgent:originallyPresent});try{
  const result=await runBinaryAssetReview({...f,reviewOptions:{cwd:f.definition.codeProject,model:'synthetic',timeoutMs:10000,spawnProcess:spawnFixture('valid')},
   control:{signal:new AbortController().signal,onEvent(){}}});assert.equal(result.status,'succeeded',JSON.stringify(result));
  const args={...f,providerThreadId:'synthetic-binary-review'},proof=verifyBinaryReviewEvidence(args),original=fs.readFileSync(proof.path);
  const agents=path.join(f.definition.codeProject,'nested/AGENTS.md');if(originallyPresent)fs.unlinkSync(agents);else fs.writeFileSync(agents,'# Later task rules\n');
  assert.throws(()=>verifyBinaryReviewEvidence(args));
  assert.equal(verifyBinaryReviewEvidence({...args,inspectCurrent:false}).evidenceDigest,proof.evidenceDigest);
  const reseal=change=>{
   const value=JSON.parse(original);change(value);const {evidenceDigest,...body}=value;value.evidenceDigest=digest(body);
   fs.writeFileSync(proof.path,JSON.stringify(value)+'\n');
  };
  reseal(value=>value.configuration.files.push('unrelated/AGENTS.md'));
  assert.throws(()=>verifyBinaryReviewEvidence({...args,inspectCurrent:false}),{code:'binary_review_instruction_paths'});
  for(const change of [value=>value.configuration.files.push('unregistered.mjs'),value=>value.configuration.timeoutMs++,
   value=>value.configuration.checks[0].command.push('arbitrary')]){
   reseal(change);assert.throws(()=>verifyBinaryReviewEvidence({...args,inspectCurrent:false}),{code:'binary_review_evidence_changed'});
  }
 }finally{f.close();}
});
test('binary review refuses provider/model mismatch before any probe',async()=>{
 const f=fixture();let probes=0;try{
  const result=await runBinaryAssetReview({...f,request:{...f.request,provider:'unsupported'},reviewOptions:{model:'synthetic'},
   control:{signal:new AbortController().signal,onEvent(){}}},{preview:async()=>{probes++;}});
  assert.equal(result.status,'failed');assert.equal(result.code,'binary_review_provider');assert.equal(probes,0);
 }finally{f.close();}
});
for(const mode of ['valid','metadata-only'])test(`Codex mixed font review ${mode} requires original/current bytes and fixed integrity evidence`,
 {skip:process.platform!=='darwin',timeout:30000},async()=>{
 const f=fixture({mixed:true,provider:'codex'}),events=[];
 try{
  if(mode==='valid'){
   const roles=path.join(f.definition.codeProject,'.cm-workflow.yml');
   fs.writeFileSync(roles,'version: 1\nruntimes: {available: both}\nroles:\n  coder: {adapter: codex-cli, source: subscription}\n  reviewer: {adapter: claude-cli, source: subscription}\n');
   const roleBytes=fs.readFileSync(roles),review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:f.definition.codeProject,model:'synthetic'})}};
   const definition={...f.definition,version:1,feature:'1.font'},options={reviewRuntime:'codex',protection:{
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','value.mjs']}],timeoutMs:10000,
    binaryAssets:{version:1,paths:['font.ttf'],sourceRoot:f.binaryAssets.sourceRoot}}};
   const execution=createConversationExecution(definition,'binary-codex-host',{call(){assert.fail('factory cannot dispatch');}},
    review,null,null,false,'codex',options);
   assert.equal(execution.configuration.reviewRuntime,'codex');assert.equal(execution.reviewers[0].provider,'codex');
   assert.deepEqual(fs.readFileSync(roles),roleBytes,'per-run binary selection cannot rewrite project role defaults');
   assert.throws(()=>createConversationExecution(definition,'binary-codex-host',{call(){}},review,null,null,false,'codex',
    {reviewRuntime:'codex'}),{code:'runtime_selection_mismatch'});
  }
  const cli=path.join(f.root,'codex-fixture');
  fs.writeFileSync(cli,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(codexFake)} --fixture-mode ${mode} "$@"\n`,{mode:0o700});
  const before=fs.readFileSync(path.join(f.definition.codeProject,'font.ttf'));
  const result=await runBinaryAssetReview({...f,reviewOptions:{cwd:f.definition.codeProject,model:'synthetic',cli,
   disabledSkills:[],promptTransport:'stdin',timeoutMs:10000,schemaPath:fileURLToPath(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url))},
   control:{signal:new AbortController().signal,onEvent:event=>events.push(event)}});
  assert.equal(result.status,mode==='valid'?'succeeded':'failed',JSON.stringify(result));
  assert(events.some(event=>event.event==='thread.started'));assert(events.every(event=>event.item_type!=='mcp_tool_call'),
   'only the registered verification server may consume tool events; owner observation stays strict');
  assert.deepEqual(fs.readFileSync(path.join(f.definition.codeProject,'font.ttf')),before,'review must never write original font bytes');
  if(mode==='valid'){
   const proof=verifyBinaryReviewEvidence({...f,providerThreadId:'synthetic-binary-codex-review'});
   assert.deepEqual(new Set(proof.evidence.binaryReads.map(({path,version})=>path+':'+version)),
    new Set(['font.ttf:before','font.ttf:after']));
   assert.equal(proof.evidence.checks[0].id,'asset-integrity');assert.equal(proof.evidence.checks[0].exitCode,0);
   const envelope=JSON.parse(fs.readFileSync(proof.path));assert.equal(envelope.provider,'codex');
   assert.equal(envelope.requestDigest,f.request.requestDigest);assert.deepEqual(proof.evidence.mutations,[]);
  }else{
   assert.equal(result.code,'review_verification_binary_reads',JSON.stringify(result));
   assert(!fs.existsSync(path.join(f.definition.specsDir,'.reviews','.binary-review')),'missing native evidence cannot create an accepted proof');
  }
 }finally{f.close();}
});
