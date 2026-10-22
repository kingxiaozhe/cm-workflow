import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureReviewBaseline,createReviewPackage,readReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createFixCausePackage,readFixCausePackage,causeReviewPaths} from '../runtime/js/cm-fix/cause-package.mjs';
import {buildReviewPrompt,buildCauseReviewPrompt,createCodexReviewRun,createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const INPUT_LIMIT=1048576,marker='\n<cm-review-data-json>\n';
// Captured from the a401 baseline INSTRUCTIONS, not copied from the repair.
// The legacy prompt of the current main: it carries the scope-revision unchangedScope
// clause added after #223, so its digest differs from the #223-era value.
// Re-pinned deliberately when the reviewer instructions gained the requirement-evidence rule.
const LEGACY_PREFIX_SHA='b69f7260a89c92741f125b92207f4a25c44dd399ac1d105da96f3af19e8a9a06';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const checks=[{id:'unit',command:['node','synthetic-unit.mjs'],outcome:'passed',exitCode:0,evidence:'Synthetic unit evidence, not a command execution'},
  {id:'boundary',command:['node','synthetic-boundary.mjs'],outcome:'passed',exitCode:0,evidence:'Synthetic boundary evidence, not a provider call'}];
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prompt-input-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs'),feature='1.prompt';
  fs.mkdirSync(cwd);fs.mkdirSync(path.join(specsRoot,feature),{recursive:true});
  const identity={repositoryId:'synthetic',runId:'prompt-input',taskId:'T-001',attempt:1};
  const writeSpec=(name,content)=>fs.writeFileSync(path.join(specsRoot,feature,name),content);
  writeSpec('tasks.md','# Tasks\n- [ ] T-001: preserve complete prompt evidence ~1h\n\n## 验证要求\n- T-001: node --test prompt.test.mjs\n');
  writeSpec('requirements.md','# Requirements\n- [ ] [AC-001] Supply all exact evidence\n- AC-002: Preserve every check and the final handoff\n');
  writeSpec('design.md','# Interface\nexport function preserveEvidence(value): Evidence;\n\n## System context\nSynthetic approved system context must survive presentation.\n');
  writeSpec('test-cases.json',JSON.stringify({cases:[{id:'TC-001',taskIds:['T-001'],acIds:['AC-001','AC-002'],description:'Entire evidence survives'}]}));
  fs.writeFileSync(path.join(specsRoot,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsRoot)}));
  fs.writeFileSync(path.join(cwd,'context.md'),'Synthetic required caller context; retain this whole file.\n');
  const handoffPath=path.join(specsRoot,'handoff.json');
  fs.writeFileSync(handoffPath,JSON.stringify({synthetic:true,summary:'Final handoff and Learning evidence must remain exact',checks:checks.map(c=>c.id)})+'\n');
  return {root,cwd,specsRoot,feature,identity,handoffPath};
}
function material(f,size=360*1024,format='utf8'){
  const prefix='export const value=1;\n//',room=size-Buffer.byteLength(prefix)-1;
  const before=Buffer.from(prefix+(format==='unicode'?'界'.repeat(Math.floor(room/3))+'x'.repeat(room%3):'x'.repeat(room))+'\n');
  if(format==='bom')Buffer.from([0xef,0xbb,0xbf]).copy(before);
  if(format==='binary')before.fill(0xff);
  const after=Buffer.from(before);after[format==='binary'?0:prefix.indexOf('1')]=format==='binary'?0xfe:0x32;
  fs.writeFileSync(path.join(f.cwd,'source.mjs'),before);
  const baseline=captureReviewBaseline({root:f.cwd,specsRoot:f.specsRoot,identity:f.identity,scope:['source.mjs'],requirements:['source.mjs','context.md'],
    specification:{specsRoot:f.specsRoot,feature:f.feature}});
  fs.writeFileSync(path.join(f.cwd,'source.mjs'),after);
  const pkg=createReviewPackage({root:f.cwd,baseline,checks,handoffPath:f.handoffPath});
  assert.deepEqual(readReviewPackage(pkg),pkg);return pkg;
}
function cause(f,{differentContext=false}={}){
  const content=Buffer.from('x'.repeat(600*1024));fs.writeFileSync(path.join(f.cwd,'source.mjs'),content);
  const context=Buffer.from(content);if(differentContext)context[0]=0x79;
  fs.writeFileSync(path.join(f.cwd,'caller.mjs'),context);
  const identity={...f.identity,taskId:'T-FIX-input'};
  const status={identity,stage:'cause_review_required',learning:null,
    reproduction:{status:'reproduced',next:'diagnose',observation:{id:'reproduce',command:['node','synthetic-repro.mjs'],outcome:'failed',exitCode:1,evidence:'Synthetic reproduced boundary',signatureMatched:true}},
    diagnosis:{status:'diagnosed',rootCause:'Synthetic prompt boundary',plan:'Preserve all current evidence',crossLayer:false,affectedPaths:['source.mjs'],affectedModules:['source']},
    rediagnosis:{historyDigest:digest('synthetic history'),priorPackageDigest:digest('synthetic old package'),priorObservationDigest:digest('synthetic old observation'),reason:'Retain caller context',
      reviewFeedback:{verdict:'changes_requested',packageDigest:digest('synthetic old package'),examinedPaths:['caller.mjs','source.mjs'],
        findings:[{id:'F1',severity:'P2',path:'caller.mjs',message:'Caller context is required',evidence:'Synthetic context fixture'}],summary:'Synthetic earlier feedback'}}};
  const pkg=createFixCausePackage({codeProject:f.cwd,defect:'Synthetic input size boundary',status});
  assert.deepEqual(readFixCausePackage(pkg),pkg);assert.deepEqual(pkg.contextFiles.map(file=>file.path),['caller.mjs']);return pkg;
}
function request(pkg,provider){return requestFor({invocationId:'synthetic-review',identity:pkg.identity,role:'reviewer',provider,
  requestedModel:'synthetic',contextId:'synthetic-review-context',payload:{reviewPackage:pkg,priorReview:null}});}
function parse(prompt){const at=prompt.indexOf(marker);assert(at>0);return {prefix:prompt.slice(0,at),data:JSON.parse(prompt.slice(at+marker.length))};}
function expected(pkg,isCause=false){return {reviewPackage:pkg,priorReview:null,examinedPaths:isCause?causeReviewPaths(pkg):reviewPaths(pkg),
  ...(!isCause&&pkg.handoff?{handoffPath:pkg.handoff.path}:{})};}
function complete(prompt,pkg,isCause=false){
  const parsed=parse(prompt);assert(parsed.data.presentation,'Large fallback must retain a complete inline table');
  const restored=expandReviewData(parsed.data),original=expected(pkg,isCause);
  assert.deepEqual(restored,original);assert.equal(digest(restored),digest(original));
  assert.equal(restored.reviewPackage.packageDigest,pkg.packageDigest);
  (isCause?readFixCausePackage:readReviewPackage)(restored.reviewPackage);return parsed.data;
}

test('policy-null large Codex implementation prompt fits the input boundary with every canonical evidence byte preserved',t=>{
  const f=fixture(t),pkg=material(f),raw=buildReviewPrompt(request(pkg,'claude'),'claude');
  assert(Buffer.byteLength(raw,'utf8')>INPUT_LIMIT);assert.deepEqual(parse(raw).data,expected(pkg));
  const prompt=buildReviewPrompt(request(pkg,'codex'),'codex');
  assert(Buffer.byteLength(prompt,'utf8')<=INPUT_LIMIT,'CM_CODEX_PROMPT_INPUT: final complete Codex prompt must fit the conservative UTF-8 input bound');
  const data=complete(prompt,pkg),restored=expandReviewData(data).reviewPackage;
  assert.deepEqual(restored.checks,checks);assert.deepEqual(restored.handoff,pkg.handoff);assert.deepEqual(restored.specification,pkg.specification);
  assert.deepEqual(restored.requirements,pkg.requirements);assert.equal(restored.specification.acceptanceCriteria.length,2);
  assert.match(restored.specification.designExcerpt,/System context/);assert.equal(restored.specification.testCases.length,1);
});

test('small policy-null Codex and unchanged Claude keep the exact legacy prefix and serialized evidence',t=>{
  const f=fixture(t),pkg=material(f,128),codex=buildReviewPrompt(request(pkg,'codex'),'codex'),claude=buildReviewPrompt(request(pkg,'claude'),'claude');
  assert.equal(codex,claude);const parsed=parse(codex);assert.equal(sha(parsed.prefix),LEGACY_PREFIX_SHA);
  assert.equal(codex,parsed.prefix+marker+JSON.stringify(expected(pkg)));assert.equal(parsed.data.presentation,undefined);
  assert(Buffer.byteLength(codex,'utf8')<INPUT_LIMIT);
  const large=material(f),largeClaude=buildReviewPrompt(request(large,'claude'),'claude');
  assert.equal(sha(parse(largeClaude).prefix),LEGACY_PREFIX_SHA);assert.equal(parse(largeClaude).data.presentation,undefined);
  assert.equal(largeClaude,parsed.prefix+marker+JSON.stringify(expected(large)));
});

test('the existing explicit policy still chooses the same full or compact representation for both providers',t=>{
  const f=fixture(t);
  for(const size of [128,360*1024]){
    const pkg=material(f,size),codex=buildReviewPrompt(request(pkg,'codex'),'codex',EXECUTION_POLICY_V1),claude=buildReviewPrompt(request(pkg,'claude'),'claude',EXECUTION_POLICY_V1);
    assert.equal(codex,claude);assert(Buffer.byteLength(codex,'utf8')<=INPUT_LIMIT);
    if(size===128){assert.equal(codex,buildReviewPrompt(request(pkg,'codex'),'codex'));assert.equal(parse(codex).data.presentation,undefined);}
    else complete(codex,pkg);
  }
});

test('a large legal cause review retains all diagnosed files, round-two caller context and feedback',t=>{
  const f=fixture(t),pkg=cause(f),raw=buildCauseReviewPrompt(request(pkg,'claude'),'claude');assert(Buffer.byteLength(raw,'utf8')>INPUT_LIMIT);
  assert.deepEqual(parse(raw).data,expected(pkg,true));
  const prompt=buildCauseReviewPrompt(request(pkg,'codex'),'codex');
  assert(Buffer.byteLength(prompt,'utf8')<=INPUT_LIMIT,'CM_CODEX_PROMPT_INPUT: complete cause evidence and context must fit before dispatch');
  complete(prompt,pkg,true);
});

test('uncompressible implementation and cause prompts fail before a worker sees any truncated evidence',t=>{
  const f=fixture(t),pkg=material(f,700*1024);let calls=0;
  const worker=()=>{calls++;throw Error('Unreachable: no provider or CLI is authorized in this fixture');};
  const control={signal:new AbortController().signal,onEvent(){}};
  for(const policy of [null,EXECUTION_POLICY_V1]){
    assert.throws(()=>buildReviewPrompt(request(pkg,'codex'),'codex',policy),{code:'limit_exceeded'});
    assert.throws(()=>createCodexReviewRun(worker,policy)(request(pkg,'codex'),control),{code:'limit_exceeded'});
  }
  const unicode=material(f,600*1024,'unicode'),unicodeCompact=buildReviewPrompt(request(unicode,'claude'),'claude',EXECUTION_POLICY_V1);
  assert(unicodeCompact.length<INPUT_LIMIT);assert(Buffer.byteLength(unicodeCompact,'utf8')>INPUT_LIMIT);
  for(const policy of [null,EXECUTION_POLICY_V1]){
    assert.throws(()=>buildReviewPrompt(request(unicode,'codex'),'codex',policy),{code:'limit_exceeded'});
    assert.throws(()=>createCodexReviewRun(worker,policy)(request(unicode,'codex'),control),{code:'limit_exceeded'});
  }
  const causePackage=cause(f,{differentContext:true});
  for(const policy of [null,EXECUTION_POLICY_V1]){
    assert.throws(()=>buildCauseReviewPrompt(request(causePackage,'codex'),'codex',policy),{code:'limit_exceeded'});
    assert.throws(()=>createCauseReviewRun(worker,'codex',policy)(request(causePackage,'codex'),control),{code:'limit_exceeded'});
  }
  assert.equal(calls,0);
});

test('binary and BOM source bytes survive the bounded prompt fallback without lossy UTF-8 conversion',t=>{
  const f=fixture(t);
  for(const format of ['binary','bom']){
    const pkg=material(f,300*1024,format),prompt=buildReviewPrompt(request(pkg,'codex'),'codex');
    assert(Buffer.byteLength(prompt,'utf8')<=INPUT_LIMIT,'CM_CODEX_PROMPT_INPUT: binary-preserving fallback must fit in full');
    const data=complete(prompt,pkg),before=data.reviewPackage.changes[0].before;
    assert.equal(data.contents[before.contentRef].encoding,'base64');
    assert.equal(Buffer.from(expandReviewData(data).reviewPackage.changes[0].before.contentBase64,'base64').length,300*1024);
  }
});
