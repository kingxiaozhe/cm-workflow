import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {claimPrdReview,inspectPrdReview} from './cm-prd-review-gate.mjs';
function fixture(t){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-r1-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));fs.mkdirSync(path.join(specs,'.reviews'));
  const feature='1.guide',draft={draftDigest:'a'.repeat(64),features:[{directory:feature,name:'guide',documents:[
    {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide'},
    {path:'design.md',content:'## 方案摘要\nDocumentation'},
    {path:'tasks.md',content:'- [ ] T-001: Guide'}]}]};
  const prepared=preparePrdReview({specs,draft,stage:'split',feature});
  const response={reviewer:'codex-subagent',contextId:'reviewer-context',independent:true,at:'2026-09-08T00:00:00.000Z',
    result:{verdict:'approved',packageDigest:prepared.packageDigest,
      examinedPaths:['1.guide/design.md','1.guide/requirements.md','1.guide/tasks.md'],findings:[],summary:'Synthetic no findings'}};
  return {specs,prepared,response,claim:()=>claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest}),
    publish:()=>publishPrdReview({specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author-context',response})};
}
test('claimed result publishes r1 once, readback resumes original gate and conflict preserves bytes',t=>{
  const {prepared,response,claim,publish}=fixture(t);claim();
  const result=publish();assert.equal(result.gate.outcome,'resume_disposition');assert.equal(result.completionAuthorized,false);
  const bytes=fs.readFileSync(prepared.paths.evidence);assert.equal(fs.statSync(prepared.paths.evidence).mode&0o777,0o600);
  assert.equal(publish().outcome,'r1_published');
  response.result.summary='Different later review';assert.throws(publish,/review_file_conflict/);
  assert.deepEqual(fs.readFileSync(prepared.paths.evidence),bytes);
  assert.equal(fs.existsSync(prepared.paths.receipt),false);
});
test('unclaimed or non-independent self-report cannot publish independent r1',t=>{
  const {prepared,response,claim,publish}=fixture(t);assert.throws(publish,/prd_review_unclaimed/);
  claim();response.contextId='author-context';assert.throws(publish,/prd_review_independence_invalid/);
  assert.equal(fs.existsSync(prepared.paths.evidence),false);
  response.contextId='reviewer-context';response.result.examinedPaths=[];assert.throws(publish,/missing_material/);
  assert.equal(inspectPrdReview(prepared.paths).outcome,'dispatch_unknown');
});
test('changes and explicit self-degradation stay findings, not completion or independent approval',t=>{
  const {prepared,response,claim,publish}=fixture(t);claim();
  response.reviewer='self-degraded';response.contextId='author-context';response.independent=false;
  response.degradedReason='Independent channel unavailable';response.result.verdict='changes_requested';
  response.result.findings=[{id:'R1',severity:'P2',path:'1.guide/tasks.md',message:'Missing task',evidence:'Synthetic finding'}];
  const result=publish();assert.equal(result.independent,false);assert.equal(result.verdict,'changes_requested');
  assert.match(fs.readFileSync(prepared.paths.evidence,'utf8'),/independent: false/);
  assert.equal(result.gate.outcome,'resume_disposition');assert.equal(fs.existsSync(prepared.paths.receipt),false);
});

test('archived findings read without draft files and never repair or redispatch',t=>{
  const {specs,prepared,response,claim,publish}=fixture(t);claim();
  const inspect=()=>inspectPrdFindings({specs,stage:'split',feature:'1.guide'});
  assert.throws(inspect,/prd_review_archive_unavailable/);
  assert.equal(fs.existsSync(prepared.paths.evidence),false);
  response.result.verdict='changes_requested';
  response.result.findings=[{id:'R1',severity:'P2',path:'1.guide/tasks.md',message:'Missing task',evidence:'Synthetic finding'}];
  publish();const before=fs.readFileSync(prepared.paths.evidence);
  const result=inspect();assert.deepEqual(result.findings,response.result.findings);
  assert.equal(result.next,'resolve_original_findings');assert.equal(result.completionAuthorized,false);
  assert.equal(fs.existsSync(path.join(specs,'1.guide')),false);
  assert.equal(fs.existsSync(prepared.paths.receipt),false);
  assert.throws(()=>inspectPrdFindings({specs,stage:'split',feature:'2.guide'}),/identity_mismatch/);
  fs.writeFileSync(prepared.paths.evidence,before.toString().replace('verdict: changes_requested','verdict: approved'));
  assert.throws(inspect,/review_file_conflict/);
  assert.equal(fs.readFileSync(prepared.paths.evidence,'utf8').includes('verdict: approved'),true);
});

test('blocked review with no findings cannot suggest no-findings disposition',t=>{
  const {specs,response,claim,publish}=fixture(t);claim();
  response.result.verdict='blocked';publish();
  const result=inspectPrdFindings({specs,stage:'split',feature:'1.guide'});
  assert.equal(result.next,'keep_blocked_and_request_human_review');
  assert.equal(result.completionAuthorized,false);
});
