import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {inspectPrdReviewResponse,publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {recoverPrdResponse} from '../runtime/js/cm-prd/response-recovery.mjs';
import {claimPrdReview,inspectPrdReview} from './cm-prd-review-gate.mjs';

const claudeRoute={adapter:'claude-cli',model:'default',source:'subscription',hostRuntime:'codex',configuredAdapter:'claude-cli'};
function fixture(t,stage='split'){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-route-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const draft={draftDigest:'a'.repeat(64),features:[{directory:'1.guide',name:'guide',documents:[
    {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide'},
    {path:'design.md',content:'## 方案摘要\nNative app'},
    {path:'tasks.md',content:'- [ ] T-001: Guide'}]}]};
  const prepare=reviewRoute=>preparePrdReview({specs,draft,stage,feature:'1.guide',...(reviewRoute?{reviewRoute}:{})});
  const prepared=prepare(claudeRoute);
  const response={reviewer:'claude-cli',contextId:'fresh-claude-context',independent:true,at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'changes_requested',packageDigest:prepared.packageDigest,
      examinedPaths:(stage==='design'?['requirements.md','design.md']:['requirements.md','design.md','tasks.md']).map(file=>`1.guide/${file}`).sort(),
      findings:[{id:'R1',severity:'P2',path:'1.guide/design.md',message:'Native difference missing',evidence:'Comparison required'}],summary:'Preserve native differences'}};
  const inspect=()=>inspectPrdReviewResponse({reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response});
  return {specs,draft,stage,prepare,prepared,response,inspect};
}
for(const stage of ['design','split'])test(`configured Claude ${stage} result publishes original identity and findings`,t=>{
  const {specs,prepared,response,inspect}=fixture(t,stage);
  assert.deepEqual(prepared.reviewPackage.reviewRoute,claudeRoute);
  assert.equal(prepared.packageDigest,digest(prepared.reviewPackage));
  assert.equal(inspect().result.verdict,'changes_requested');
  fs.mkdirSync(path.join(specs,'.reviews'));claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
  const publish=()=>publishPrdReview({specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response});
  const result=publish();assert.equal(result.verdict,'changes_requested');assert.equal(result.completionAuthorized,false);
  const before=fs.readFileSync(prepared.paths.evidence);
  assert.match(before.toString(),/reviewer: claude-cli/);assert.ok(before.toString().includes(JSON.stringify(response)));
  assert.equal(publish().outcome,'r1_published');assert.deepEqual(fs.readFileSync(prepared.paths.evidence),before);
  const findings=inspectPrdFindings({specs,stage,feature:'1.guide'});
  assert.deepEqual(findings.findings,response.result.findings);assert.equal(findings.verdict,'changes_requested');
});
for(const stage of ['design','split'])test(`configured Claude ${stage} rejects wrong provider, context and package`,t=>{
  const {response,inspect}=fixture(t,stage);
  for(const reviewer of ['codex-cli','codex-subagent']){response.reviewer=reviewer;assert.throws(inspect,/prd_review_route_mismatch/);}
  response.reviewer='claude-cli';response.contextId='author';assert.throws(inspect,/prd_review_independence_invalid/);
  response.contextId='fresh-claude-context';response.result.packageDigest='b'.repeat(64);assert.throws(inspect,/review_package_mismatch/);
});
test('explicit Claude route rejects self-degradation before claiming or calling a reviewer',async t=>{
  const {specs,prepared}=fixture(t);let calls=0;
  await assert.rejects(()=>runPrdHostReview({specs,prepared,authorContextId:'author',writeEnabled:true,mode:'self-degraded',
    revalidate:()=>prepared,signal:new AbortController().signal,review:async()=>{calls++;throw Error('must not dispatch');}}),/prd_review_route_mismatch/);
  assert.equal(calls,0);assert.deepEqual(fs.readdirSync(specs),[]);
});
test('route is forwarded through one existing current-host call and does not grant completion',async t=>{
  const {specs,draft,prepare,prepared,response}=fixture(t);let calls=0;
  fs.mkdirSync(path.join(specs,'1.guide'));for(const doc of draft.features[0].documents)fs.writeFileSync(path.join(specs,'1.guide',doc.path),doc.content,{mode:0o600});
  const result=await runPrdHostReview({specs,prepared,authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:()=>prepare(claudeRoute),signal:new AbortController().signal,review:async payload=>{
      calls++;assert.deepEqual(payload.package.reviewRoute,claudeRoute);assert.match(payload.instructions,/source declarations/);return response;}});
  assert.equal(result.status,'review_recorded');assert.equal(result.completionAuthorized,false);assert.equal(calls,1);
  assert.equal((await runPrdHostReview({specs,prepared:prepare(claudeRoute),authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:()=>prepare(claudeRoute),signal:new AbortController().signal,review:async()=>{calls++;return response;}})).status,'review_existing');
  assert.equal(calls,1);
});
for(const stage of ['design','split'])test(`legacy ${stage} claim retains exact old package and receipt bytes`,t=>{
  const {specs,prepare}=fixture(t,stage),original=prepare();
  fs.mkdirSync(path.join(specs,'.reviews'));claimPrdReview({...original.paths,package_sha256:original.packageDigest});
  const adopted=prepare(claudeRoute);assert.deepEqual(adopted.reviewPackage,original.reviewPackage);
  assert.equal(adopted.packageDigest,original.packageDigest);assert.equal(Object.hasOwn(adopted.reviewPackage,'reviewRoute'),false);
  const response={reviewer:'codex-subagent',contextId:'legacy-reviewer',independent:true,at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'approved',packageDigest:original.packageDigest,examinedPaths:(stage==='design'?['requirements.md','design.md']:['requirements.md','design.md','tasks.md']).map(file=>`1.guide/${file}`).sort(),findings:[],summary:'Historical result'}};
  const input={specs,reviewPackage:original.reviewPackage,packageDigest:original.packageDigest,authorContextId:'author',response};
  publishPrdReview(input);const before=fs.readFileSync(original.paths.evidence);
  assert.equal(publishPrdReview(input).outcome,'r1_published');assert.deepEqual(fs.readFileSync(original.paths.evidence),before);
});
test('changed route cannot replace a new claimed route package',t=>{
  const {specs,prepare,prepared}=fixture(t);fs.mkdirSync(path.join(specs,'.reviews'));
  claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
  assert.throws(()=>prepare({...claudeRoute,model:'other-model'}),/prd_review_dispatch_package_changed/);
  assert.equal(inspectPrdReview(prepared.paths).package_sha256,prepared.packageDigest);
});
test('resolver maps current-ai to actual host and preserves explicit opposite-tool role',async t=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-role-')));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  const {resolvePrdReviewRoute,inspectPrdReviewRoute}=await import('../runtime/js/cm-prd/review-route.mjs');
  const file=path.join(project,'.cm-workflow.json');
  fs.writeFileSync(file,JSON.stringify({version:1,roles:{reviewer:{adapter:'current-ai',model:'default',source:'local'}}}));
  assert.deepEqual(resolvePrdReviewRoute({project,runtime:'codex'}),{adapter:'codex-cli',model:'default',source:'local',hostRuntime:'codex',configuredAdapter:'current-ai'});
  assert.equal(resolvePrdReviewRoute({project,runtime:'claude'}).adapter,'claude-cli');
  fs.writeFileSync(file,JSON.stringify({version:1,roles:{reviewer:{adapter:'claude-cli',model:'default',source:'subscription'}}}));
  assert.deepEqual(resolvePrdReviewRoute({project,runtime:'codex'}),claudeRoute);
  assert.throws(()=>inspectPrdReviewRoute({...claudeRoute,adapter:'codex-cli'}),/prd_review_route_invalid/);
  assert.throws(()=>inspectPrdReviewRoute({...claudeRoute,extra:true}),/invalid_input/);
  fs.writeFileSync(file,JSON.stringify({version:1,roles:{reviewer:{adapter:'claude-api',model:'default',source:'api'}}}));
  assert.throws(()=>resolvePrdReviewRoute({project,runtime:'codex'}),/prd_review_route_unavailable/);
});
test('default current Codex channel still accepts canonical fresh subagent declaration',t=>{
  const {prepare}=fixture(t),route={adapter:'codex-cli',model:'default',source:'local',hostRuntime:'codex',configuredAdapter:'current-ai'};
  const prepared=prepare(route),response={reviewer:'codex-subagent',contextId:'/root/fresh_reviewer',independent:true,at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'approved',packageDigest:prepared.packageDigest,examinedPaths:['1.guide/design.md','1.guide/requirements.md','1.guide/tasks.md'],findings:[],summary:'Synthetic fresh context'}};
  assert.equal(inspectPrdReviewResponse({reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response}).result.verdict,'approved');
});
test('explicit Codex route works from a Claude host without changing the host identity',t=>{
  const {prepare}=fixture(t),route={adapter:'codex-cli',model:'gpt-6.1-sol',source:'subscription',hostRuntime:'claude',configuredAdapter:'codex-cli'};
  const prepared=prepare(route),response={reviewer:'codex-cli',contextId:'fresh-codex-thread',independent:true,at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'approved',packageDigest:prepared.packageDigest,examinedPaths:['1.guide/design.md','1.guide/requirements.md','1.guide/tasks.md'],findings:[],summary:'Synthetic opposite tool'}};
  assert.deepEqual(prepared.reviewPackage.reviewRoute,route);
  assert.equal(inspectPrdReviewResponse({reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response}).result.verdict,'approved');
  response.reviewer='claude-cli';assert.throws(()=>inspectPrdReviewResponse({reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response}),/prd_review_route_mismatch/);
});
test('default current channel keeps explicit self-degraded declaration separate from approval',t=>{
  const {prepare}=fixture(t),prepared=prepare({adapter:'codex-cli',model:'default',source:'local',hostRuntime:'codex',configuredAdapter:'current-ai'});
  const response={reviewer:'self-degraded',contextId:'author',independent:false,degradedReason:'No independent channel',at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'blocked',packageDigest:prepared.packageDigest,examinedPaths:['1.guide/design.md','1.guide/requirements.md','1.guide/tasks.md'],findings:[],summary:'Still blocked'}};
  assert.equal(inspectPrdReviewResponse({reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',response}).degraded,true);
});

test('timestamp recovery retains Claude channel, package and result and rejects wrong-channel repair',t=>{
  const {prepared,response}=fixture(t);response.at='2026-10-16T00:00:00.123000+00:00';
  const original=JSON.stringify(response),resultDigest=digest(response.result);
  const recover=()=>recoverPrdResponse({original:response,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author'});
  const fixed=recover();assert.equal(fixed.response.reviewer,'claude-cli');assert.equal(fixed.response.contextId,'fresh-claude-context');
  assert.equal(fixed.response.at,'2026-10-16T00:00:00.123Z');assert.equal(digest(fixed.response.result),resultDigest);
  assert.equal(JSON.stringify(response),original);response.reviewer='codex-cli';assert.throws(recover,/prd_review_route_mismatch/);
});

test('unconfigured current Codex default preserves the original package digest',t=>{
  const {prepare}=fixture(t),original=prepare();
  const route={adapter:'codex-cli',model:'default',source:'local',hostRuntime:'codex',configuredAdapter:'current-ai'};
  const current=prepare(route);assert.deepEqual(current.reviewPackage,original.reviewPackage);
  assert.equal(current.packageDigest,original.packageDigest);assert.equal(Object.hasOwn(current.reviewPackage,'reviewRoute'),false);
  const selected=prepare({...route,model:'explicit-model'});
  assert.equal(selected.reviewPackage.reviewRoute.model,'explicit-model');assert.notEqual(selected.packageDigest,original.packageDigest);
});
