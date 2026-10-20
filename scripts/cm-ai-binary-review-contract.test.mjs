// No provider or network. Exercise the actual fixed check and mechanical tool gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readBinaryAssetConfiguration} from '../runtime/js/cm-ai/binary-assets.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {binaryAssetReviewProfile,persistBinaryReviewEvidence,verifyBinaryReviewEvidence} from '../runtime/js/cm-ai/host-binary-review.mjs';
import {createReviewVerificationSession} from '../runtime/js/cm-fix/review-verification.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {inspectReviewVerificationEvidence} from '../runtime/js/cm-fix/review-verification-contract.mjs';
import {binaryVerificationVersions} from '../runtime/js/cm-fix/review-verification-binary.mjs';

// Pure contract qualification for an outer review sandbox that cannot apply a
// second OS sandbox. These rows are explicitly synthetic: no command execution,
// actual tool use, independent model activity or product acceptance is claimed.
test('synthetic evidence contract preserves exact binary reads and ordinary fix gates',async t=>{
 const binary=(sha256,size)=>({path:'font.ttf',type:'file',mode:0o644,size,sha256,contentBlob:sha256});
 const reviewPackage={kind:'cm-review-package',packageDigest:'a'.repeat(64),binaryAssets:{version:1,paths:['font.ttf'],storeRoot:'/fixture/specs/.reviews/.binary-assets/fixture/contract'},
  changes:[{path:'font.ttf',before:binary('b'.repeat(64),2),after:binary('c'.repeat(64),3)}]};
 const request={provider:'claude',requestDigest:'d'.repeat(64),payload:{reviewPackage}};
 const configuration={files:['font.ttf'],mutationPaths:[],checks:[{id:'asset-integrity',command:['synthetic-contract-no-command-executed']}],timeoutMs:60000,
  binaryAssets:{version:1,paths:['font.ttf']},binaryReview:{version:1}};
 const files=[{path:'font.ttf',sha256:'c'.repeat(64),mode:0o644,size:3}],binaryFiles=binaryVerificationVersions(configuration,reviewPackage);
 const evidence={version:1,requestDigest:request.requestDigest,packageDigest:reviewPackage.packageDigest,profileDigest:digest(configuration),providerThreadId:'synthetic-contract',
  files,snapshotDigest:digest(files),binaryFiles,binaryReads:binaryFiles.map(({path,version,sha256,size})=>({path,version,sha256,size})),
  checks:[{id:'asset-integrity',commandDigest:digest(configuration.checks[0].command),exitCode:0,outputSha256:'e'.repeat(64),startedAt:1,endedAt:2}],mutations:[]};
 const inspect=(e,extra={})=>inspectReviewVerificationEvidence(e,{request,configuration,providerThreadId:'synthetic-contract',binaryReview:true,...extra});
 assert.equal(inspect(evidence).binaryReads.length,2);
 for(const [name,change]of [
  ['missing-before',e=>{e.binaryReads=e.binaryReads.filter(r=>r.version!=='before');}],
  ['missing-after',e=>{e.binaryReads=e.binaryReads.filter(r=>r.version!=='after');}],
  ['wrong-read-sha',e=>{e.binaryReads[0].sha256='f'.repeat(64);}],
  ['wrong-blob-record',e=>{e.binaryFiles[0].contentBlob='f'.repeat(64);}],
  ['wrong-package',e=>{e.packageDigest='f'.repeat(64);}],
  ['wrong-profile',e=>{e.profileDigest='f'.repeat(64);}],
  ['wrong-thread',e=>{e.providerThreadId='other-thread';}],
  ['missing-check',e=>{e.checks=[];}],
  ['failed-check',e=>{e.checks[0].exitCode=1;}],
 ])await t.test(name,()=>{const invalid=structuredClone(evidence);change(invalid);assert.throws(()=>inspect(invalid));});
 await t.test('ordinary-fix-still-requires-mutation',()=>assert.throws(()=>inspect(evidence,{binaryReview:false}),{code:'review_verification_evidence'}));
});

test('binary tool gate requires both exact version reads and an actual fixed check before evidence can pass',
  {skip:process.platform!=='darwin'},async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-binary-contract-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),sourceRoot=path.join(root,'answers');
  for(const dir of [codeProject,specsDir,sourceRoot])fs.mkdirSync(dir);
  const identity={repositoryId:'fixture',runId:'binary-contract',taskId:'T-001',attempt:1};
  const definition={codeProject,specsDir,scope:['font.ttf'],requirements:['requirement.md']};
  fs.writeFileSync(path.join(codeProject,'requirement.md'),'Fixture requirements\n');
  const before=Buffer.alloc(1024*1024+1,0x80),after=Buffer.alloc(2*1024*1024+3,0x90);
  before.writeUInt32BE(65536);after.writeUInt32BE(65536);
  fs.writeFileSync(path.join(codeProject,'font.ttf'),before);
  const binaryAssets=readBinaryAssetConfiguration({version:1,paths:['font.ttf'],sourceRoot},{...definition,identity});
  const {sourceRoot:ignored,...binding}=binaryAssets;
  const baseline=captureReviewBaseline({root:codeProject,specsRoot:specsDir,identity,
    scope:definition.scope,requirements:definition.requirements,binaryAssets:binding});
  fs.writeFileSync(path.join(codeProject,'font.ttf'),after);
  const checks=[{id:'fixture',command:['node','fixture.mjs'],outcome:'passed',exitCode:0,evidence:'Fixture author checks'}];
  const reviewPackage=createReviewPackage({root:codeProject,baseline,checks});
  const request={provider:'claude',requestedModel:'synthetic',identity,requestDigest:digest({identity,packageDigest:reviewPackage.packageDigest}),payload:{reviewPackage}};
  const configuration=binaryAssetReviewProfile({definition,binaryAssets,request});
  const session=createReviewVerificationSession({codeProject,configuration,request,binaryReview:true});
  t.after(()=>session.close());
  assert.throws(()=>session.finish('fixture-reviewer'),/ENOENT|review_verification/);
  assert.equal((await session.call('run_check',{id:'asset-integrity'})).exitCode,0);
  assert.throws(()=>session.finish('fixture-reviewer'),{code:'review_verification_binary_reads'});
  const current=await session.call('read_binary',{path:'font.ttf',version:'after',length:16});
  assert.equal(current.totalBytes,after.length);
  assert.throws(()=>session.finish('fixture-reviewer'),{code:'review_verification_binary_reads'});
  const original=await session.call('read_binary',{path:'font.ttf',version:'before',length:16});
  assert.equal(original.totalBytes,before.length);
  const evidence=session.finish('fixture-reviewer');
  assert.equal(evidence.checks[0].exitCode,0);assert.equal(evidence.binaryReads.length,2);
  const stored=persistBinaryReviewEvidence({definition,request,configuration,evidence,providerThreadId:'fixture-reviewer'});
  assert.equal(verifyBinaryReviewEvidence({definition,binaryAssets,request,providerThreadId:'fixture-reviewer'}).evidenceDigest,stored.evidenceDigest);
});
