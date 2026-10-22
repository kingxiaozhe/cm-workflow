// Synthetic protocol fixtures only: these observations are not an independent
// review of this change and must never be used as product approval evidence.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {readIntegrationPlan,validateIntegrationRecord,previewReviewedIntegration,readIntegrationEvidence,verifyReviewedIntegration}
  from '../runtime/js/cm-ai/reviewed-integration.mjs';
import {canonical,sha,createReviewedIntegrationFixture,syntheticIntegrationReview} from './fixtures/reviewed-integration.mjs';

let shared;
const cleanup=[];
const sharedFixture=()=>shared??=(async()=>{
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Shared fixture preparation exceeded 90000 ms')),90000);});
  try{return await Promise.race([createReviewedIntegrationFixture({after:fn=>cleanup.push(fn)},{unrelated:true,premature:true}),deadline]);}
  finally{clearTimeout(timer);}
})();
after(()=>{for(const fn of cleanup.reverse())fn();});

const rejectPreview=(input,message)=>{
  const result=previewReviewedIntegration(input);
  assert.equal(result.eligibleForAdoption,false,message??JSON.stringify(result));
  assert.notEqual(result.code,'integration_review_required',message??JSON.stringify(result));
  return result;
};
const rejectOwner=action=>{
  let result;
  try{result=action();}catch(error){assert.equal(typeof error.code,'string');return;}
  assert.equal(result?.outcome,'rejected',JSON.stringify(result));
};
function reseal(records){
  let previous=null;
  return structuredClone(records).map(row=>{
    const {digest:old,...body}=row;body.previousDigest=previous;
    const result={...body,digest:digest(body)};previous=result.digest;return result;
  });
}

test('a reviewed integration plan retains exact source identities without an alias field',()=>{
  const plan={version:1,kind:'cm-reviewed-integration-v1',author:{provider:'codex',contextId:'synthetic-integration-author'},
    target:{identity:{repositoryId:'oldrepo',runId:'parent-run',taskId:'T-001',attempt:1},
      rootDigest:'a'.repeat(64),baselineDigest:'b'.repeat(64),packageDigest:'c'.repeat(64),recordCount:1,lastDigest:'d'.repeat(64)},
    sources:[{identity:{repositoryId:'oldrepo',runId:'source-run',taskId:'T-002',attempt:1},
      root:fs.realpathSync(os.tmpdir()),revision:'e'.repeat(64),packageDigest:'f'.repeat(64)}],documents:[]};
  assert.deepEqual(readIntegrationPlan(plan),plan);
  assert.throws(()=>readIntegrationPlan({...plan,alias:{oldrepo:'newrepo'}}));
  assert.throws(()=>readIntegrationPlan({...plan,sources:[plan.sources[0],plan.sources[0]]}));
  assert.throws(()=>readIntegrationPlan({...plan,sources:[{...plan.sources[0],identity:plan.target.identity}]}));
  assert.throws(()=>readIntegrationPlan({...plan,sources:[{...plan.sources[0],identity:{...plan.sources[0].identity,attempt:0}}]}));
  assert.throws(()=>readIntegrationPlan({...plan,sources:Array.from({length:65},(_,i)=>({...plan.sources[0],
    identity:{...plan.sources[0].identity,runId:`source-${i}`}}))}));
  for(const name of ['../docs/guide.md','src/guide.md','docs/guide.js','/docs/guide.md']){
    const descriptor={path:name,type:'file',mode:0o644,size:1,sha256:'a'.repeat(64)};
    assert.throws(()=>readIntegrationPlan({...plan,documents:[{path:name,before:descriptor,after:descriptor}]}));
  }
});

// The first fixture user owns the existing 90 s preparation budget plus its
// original 30 s test-body allowance; product invocation budgets are unchanged.
test('pure acceptance binds the original prefix and preserves original baseline and package',{timeout:120000},async t=>{
  const f=await sharedFixture(),before=structuredClone(f.input.records);
  const validate=record=>validateIntegrationRecord({record,baseline:f.input.baseline,parentPackage:f.input.parentPackage,records:before});
  assert.doesNotThrow(()=>validate(f.record));assert.deepEqual(f.input.records,before);
  for(const change of [record=>record.plan.target.recordCount++,record=>record.plan.target.lastDigest='0'.repeat(64),
    record=>record.plan.target.baselineDigest='0'.repeat(64),record=>record.plan.target.packageDigest='0'.repeat(64),
    record=>record.plan.target.rootDigest='0'.repeat(64),record=>record.plan.target.identity.attempt++,
    record=>record.reason='',record=>record.reviewFile.sha256='invalid']){
    const record=structuredClone(f.record);change(record);record.planDigest=digest(record.plan);assert.throws(()=>validate(record));
  }
  assert.throws(()=>validate({...f.record,planDigest:'0'.repeat(64)}));
  assert.throws(()=>validateIntegrationRecord({record:f.record,baseline:f.input.baseline,
    parentPackage:f.input.parentPackage,records:before.slice(0,-1)}));
});

test('preview requires review only after the whole mapped tree matches and never changes the run',{timeout:30000},async t=>{
  const f=await sharedFixture(),bytes=fs.readFileSync(f.statePath('parent')),calls={...f.calls};
  const before=previewReviewedIntegration({...f.input,review:null});
  assert.equal(before.eligibleForAdoption,false);assert.equal(before.code,'integration_review_required');
  const ready=previewReviewedIntegration(f.input);
  assert.equal(ready.eligibleForAdoption,true,JSON.stringify(ready));assert.equal(ready.planDigest,digest(f.plan));assert.equal(ready.sourceCount,2);
  assert.doesNotThrow(()=>verifyReviewedIntegration(f.input));
  assert.equal(f.history('parent').saved.records[0].payload.config.developer.provider,'claude');
  assert.equal(f.plan.author.provider,'codex');assert.equal(f.review.registration.request.provider,'claude');
  for(let n=0;n<48;n++)f.write(`extra-${String(n).padStart(2,'0')}.mjs`,'// unreviewed\n');
  const extras=rejectPreview(f.input);assert(extras.paths.includes('extra-47.mjs'),JSON.stringify(extras));
  for(let n=0;n<48;n++)fs.unlinkSync(path.join(f.codeProject,`extra-${String(n).padStart(2,'0')}.mjs`));
  f.write('docs/guide.md',f.documents['docs/guide.md'].after+' ');
  assert(rejectPreview(f.input).paths.includes('docs/guide.md'));
  f.write('docs/guide.md',f.documents['docs/guide.md'].after);
  if(process.platform!=='win32'){
    fs.chmodSync(path.join(f.codeProject,'source.mjs'),0o755);rejectPreview(f.input);fs.chmodSync(path.join(f.codeProject,'source.mjs'),0o644);
  }
  assert.equal(previewReviewedIntegration(f.input).eligibleForAdoption,true);
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),bytes);assert.deepEqual(f.calls,calls);
});

test('sources stay fixed to completed snapshots, exact identity and the original Git repository',{timeout:30000},async t=>{
  const f=await sharedFixture(),base={...f.input,review:null};
  const withSource=source=>({...base,plan:{...f.plan,sources:[source,f.plan.sources[1]]}});
  const source=f.plan.sources[0];
  for(const altered of [{...source,revision:'0'.repeat(64)},{...source,packageDigest:'0'.repeat(64)},
    {...source,identity:{...source.identity,repositoryId:'arbitrary-alias'}},
    {...source,identity:{...source.identity,taskId:'T-other'}},{...source,root:f.codeProject}])rejectPreview(withSource(altered));
  const alias=path.join(f.root,'source-alias');fs.symlinkSync(f.sourceRoot,alias);
  rejectPreview(withSource({...source,root:alias}));
  // Keep the same source path and its real completed snapshot. Remove only its
  // worktree registration, then point .git directly at the target common dir.
  // Root/package/snapshot bindings still match; commonDir equality alone would
  // incorrectly accept this unregistered directory.
  const gitFile=path.join(f.sourceRoot,'.git'),gitBytes=fs.readFileSync(gitFile);
  const admin=fs.realpathSync(path.resolve(f.sourceRoot,gitBytes.toString('utf8').trim().slice('gitdir: '.length)));
  const heldAdmin=path.join(f.root,'held-worktree-admin');fs.renameSync(admin,heldAdmin);
  fs.writeFileSync(gitFile,`gitdir: ${path.join(f.codeProject,'.git')}\n`);
  try{rejectPreview(base,'sharing commonDir without a registered worktree is insufficient');}
  finally{fs.writeFileSync(gitFile,gitBytes);fs.renameSync(heldAdmin,admin);}
  const unrelated=f.makePlan('parent',['unrelated','renamed']);
  rejectPreview({...base,plan:unrelated},'a separately initialized Git repository cannot be mapped by file equality');
  const complete=fs.readFileSync(f.statePath('cross'));
  fs.writeFileSync(f.statePath('cross'),f.approvedBytes.cross);
  const approved=JSON.parse(f.approvedBytes.cross);
  rejectPreview(withSource({...source,revision:approved.revision}),'approved but incomplete is not a delivered source');
  fs.writeFileSync(f.statePath('cross'),complete);
  const renameFile=f.statePath('rename'),held=renameFile+'.held';
  fs.renameSync(renameFile,held);
  try{rejectPreview(base,'new repository identity needs the completed old-name to new-name package');}
  finally{fs.renameSync(held,renameFile);}
  assert.equal(previewReviewedIntegration(f.input).eligibleForAdoption,true);
});

test('a later rename cannot retroactively authorize a source using the new repository identity',{timeout:30000},async t=>{
  const f=await sharedFixture();
  rejectPreview({...f.input,plan:f.makePlan('parent',['cross','premature']),review:null});
});

test('evidence reader rejects links, duplicate keys and noncanonical bytes',{timeout:30000},async t=>{
  const f=await sharedFixture(),original=fs.readFileSync(f.evidenceFile);
  assert.deepEqual(readIntegrationEvidence(f.evidenceFile),{plan:f.plan,review:f.review});
  for(const bytes of [JSON.stringify({plan:f.plan,review:f.review}),JSON.stringify({plan:f.plan,review:f.review},null,2)+'\n',
    canonical({plan:f.plan,review:f.review}).replace('{"plan":','{"plan":null,"plan":')]){
    fs.writeFileSync(f.evidenceFile,bytes);assert.throws(()=>readIntegrationEvidence(f.evidenceFile));
  }
  fs.writeFileSync(f.evidenceFile,original);
  const hardlink=path.join(f.root,'evidence-hardlink.json');fs.linkSync(f.evidenceFile,hardlink);
  assert.throws(()=>readIntegrationEvidence(f.evidenceFile));fs.unlinkSync(hardlink);
  const symlink=path.join(f.root,'evidence-symlink.json');fs.symlinkSync(f.evidenceFile,symlink);
  assert.throws(()=>readIntegrationEvidence(symlink));
  assert.deepEqual(readIntegrationEvidence(f.evidenceFile),{plan:f.plan,review:f.review});
});

test('review binds current author, exact plan bytes, document transforms and mechanical verification',{timeout:30000},async t=>{
  const f=await sharedFixture();
  const stalePlan={...f.plan,target:{...f.plan.target,recordCount:f.plan.target.recordCount+1}};
  const staleReview=await syntheticIntegrationReview(f.root,stalePlan,f.documents);
  rejectPreview({...f.input,review:staleReview},'a valid review of another target cannot authorize this plan');
  const wrongDocuments={'docs/guide.md':{...f.documents['docs/guide.md'],after:'Different reviewed bytes\n'}};
  const wrongReview=await syntheticIntegrationReview(f.root,f.plan,wrongDocuments);
  rejectPreview({...f.input,review:wrongReview},'a separately reviewed document cannot supply different after bytes');
  const legacy=await syntheticIntegrationReview(f.root,f.plan,f.documents,{includeVerification:false});
  rejectPreview({...f.input,review:legacy},'approved without the required isolated verification evidence is insufficient');
  const reused=await syntheticIntegrationReview(f.root,f.plan,f.documents,{threadId:'synthetic-parent-review-thread'});
  rejectPreview({...f.input,review:reused},'a valid observation cannot reuse the historical parent provider thread');
  for(const change of [review=>delete review.result.verification,review=>review.result.verification.packageDigest='0'.repeat(64),
    review=>review.configuration.hostContextId='another-author',review=>review.started='synthetic-parent-review-thread']){
    const review=structuredClone(f.review);change(review);rejectPreview({...f.input,review});
  }
  const sameProviderPlan={...f.plan,author:{...f.plan.author,provider:'claude'}};
  assert.throws(()=>readIntegrationPlan(sameProviderPlan));
  assert.equal(previewReviewedIntegration(f.input).eligibleForAdoption,true);
});

test('original owner accepts once, replay retains all history and live drift blocks without refunding calls',{timeout:30000},async t=>{
  const f=await sharedFixture(),before=f.history('parent'),bytes=fs.readFileSync(f.statePath('parent')),
    tasks=fs.readFileSync(path.join(f.specsDir,f.definitions.parent.feature,'tasks.md')),calls={...f.calls};
  let run=await f.openParent();
  try{
    assert.equal(typeof run.host.acceptReviewedIntegration,'function');
    const args={allowed:true,evidenceFile:f.evidenceFile,expectedDigest:digest(f.plan)};
    rejectOwner(()=>run.host.acceptReviewedIntegration({...args,allowed:false}));
    rejectOwner(()=>run.host.acceptReviewedIntegration({...args,expectedDigest:'0'.repeat(64)}));
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),bytes);
    const accepted=run.host.acceptReviewedIntegration(args);assert.equal(accepted.state,'fixture_completed',JSON.stringify(accepted));
    const after=f.history('parent');
    assert.equal(after.saved.records.length,before.saved.records.length+1);
    assert.deepEqual(after.saved.records.slice(0,-1),before.saved.records);
    assert.deepEqual(after.state,before.state);assert.deepEqual(after.original,before.original);
    assert.deepEqual(after.saved.identity,before.saved.identity);assert.deepEqual(after.saved.fingerprints,before.saved.fingerprints);
    const added=after.saved.records.at(-1);assert.equal(added.payload.type,'reviewed-integration-accepted');
    assert.equal(added.payload.record.reviewFile.sha256,sha(fs.readFileSync(f.evidenceFile)));
    const adopted=fs.readFileSync(f.statePath('parent'));
    assert.equal(run.host.acceptReviewedIntegration(args).state,'fixture_completed');
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    for(const change of [record=>record.plan.target.recordCount++,record=>record.plan.target.lastDigest='0'.repeat(64),
      record=>record.reason='',record=>record.planDigest='0'.repeat(64)]){
      const records=structuredClone(after.saved.records);change(records.at(-1).payload.record);
      assert.throws(()=>readRunnerHistory(reseal(records),records[0].payload.config,3));
    }
    run.close();run=null;
    run=await f.openParent();
    const status=await run.host.handle(f.request('parent','status'));
    assert.equal(status.state,'fixture_completed');assert.equal(status.code,null,JSON.stringify(status));
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    const proof=fs.readFileSync(f.evidenceFile);fs.writeFileSync(f.evidenceFile,Buffer.concat([proof,Buffer.from(' ')]));
    const drift=await run.host.handle(f.request('parent','status'));assert.equal(drift.code,'correction_review_required',JSON.stringify(drift));
    assert.deepEqual(f.history('parent').state,before.state);assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    fs.writeFileSync(f.evidenceFile,proof);
    const sourceBytes=fs.readFileSync(f.statePath('cross'));fs.writeFileSync(f.statePath('cross'),f.approvedBytes.cross);
    const stale=await run.host.handle(f.request('parent','status'));assert.equal(stale.code,'correction_review_required',JSON.stringify(stale));
    fs.writeFileSync(f.statePath('cross'),sourceBytes);
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    assert.deepEqual(f.calls,calls);assert.deepEqual(fs.readFileSync(path.join(f.specsDir,f.definitions.parent.feature,'tasks.md')),tasks);
    // The accepted parent is not a recursively acceptable source. Without this
    // guard its original parent package would exactly explain these two edits.
    const cross=f.history('cross'),inverse=f.makePlan('cross',['parent'],false);
    fs.writeFileSync(path.join(f.sourceRoot,'parent.mjs'),'export const parent=1;\n');
    fs.writeFileSync(path.join(f.sourceRoot,'docs/guide.md'),f.documents['docs/guide.md'].before);
    rejectPreview({root:f.sourceRoot,specsRoot:f.specsDir,baseline:cross.original,parentPackage:cross.state.reviewPackage,
      records:cross.saved.records,plan:inverse,review:null},'accepted integration sources cannot be recursively adopted');
  }finally{run?.close();}
});
