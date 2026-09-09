import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {recordPrdReview,claimPrdReview} from './cm-prd-review-gate.mjs';
function fixture(t){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-review-prep-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const documents=[{path:'requirements.md',content:'# Req\n## 功能需求\n1. [F-001] Guide\n## 私有附录\nNot needed in split'},
    {path:'design.md',content:'# Design\n## 功能模块设计\nGuide\n## 接口契约\nNone\n## 无关附录\nNot needed in split'},
    {path:'tasks.md',content:'- [ ] T-001: Guide'}];
  const draft={draftDigest:'a'.repeat(64),features:[{name:'guide',directory:'1.guide',documents}]};
  return {specs,draft,documents,prepare:stage=>preparePrdReview({specs,draft,stage,feature:'1.guide'})};
}
test('preparation uses original gate without writes and keeps split package scoped',t=>{
  const {specs,prepare}=fixture(t);
  const result=prepare('split');assert.equal(result.gate.outcome,'dispatch_once');
  assert.equal(result.dispatchAuthorized,false);assert.deepEqual(fs.readdirSync(specs),[]);
  assert.ok(!JSON.stringify(result.reviewPackage.content).includes('Not needed in split'));
  assert.ok(prepare('design').reviewPackage.content.requirements.includes('Not needed in split'));
});
test('existing r1 and disposition resume via original gate, stale draft and r2 fail',t=>{
  const {specs,draft,documents,prepare}=fixture(t);fs.mkdirSync(path.join(specs,'.reviews'));fs.mkdirSync(path.join(specs,'1.guide'));
  for(const document of documents)fs.writeFileSync(path.join(specs,'1.guide',document.path),document.content);
  const args=prepare('design').paths;
  fs.writeFileSync(args.evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.guide/design.md\n---\nSynthetic review.');
  assert.equal(prepare('design').gate.outcome,'resume_disposition');
  recordPrdReview({...args,disposition:'no_findings',finding_count:0,unresolved_count:0,
    artifact:[path.join(specs,'1.guide/design.md')]});
  assert.equal(prepare('design').gate.outcome,'completed');
  draft.features[0].documents[0].content+=' changed';assert.throws(()=>prepare('design'),/prd_review_draft_disk_mismatch/);
  fs.writeFileSync(path.join(specs,'.reviews/prd-guide-design-r2.md'),'Not allowed');assert.throws(()=>prepare('design'));
});
test('historic review slug collisions cannot select another feature review',t=>{
  const {specs,prepare}=fixture(t);fs.mkdirSync(path.join(specs,'2.guide'));
  assert.throws(()=>prepare('split'),/prd_review_slug_collision/);
});
test('split keeps Chinese and English summary sections and rejects contracts alone',t=>{
  const {draft,prepare}=fixture(t),design=draft.features[0].documents.find(item=>item.path==='design.md');
  for(const heading of ['方案摘要','Summary']){
    design.content=`# Design\n## ${heading}\nCritical choice\n## 接口契约\nAPI details`;
    assert.ok(prepare('split').reviewPackage.content.designSummary.includes('Critical choice'));
  }
  design.content='# Design\n## 接口契约\nAPI details';
  assert.throws(()=>prepare('split'),/prd_review_design_summary_missing/);
});
test('unknown dispatch stays bound to original package without requiring spec writes',t=>{
  const {specs,draft,prepare}=fixture(t);fs.mkdirSync(path.join(specs,'.reviews'));
  const ready=prepare('split');claimPrdReview({...ready.paths,package_sha256:ready.packageDigest});
  assert.equal(prepare('split').gate.outcome,'dispatch_unknown');
  draft.draftDigest='b'.repeat(64);
  assert.throws(()=>prepare('split'),/prd_review_dispatch_package_changed/);
});
test('dispatch package binding survives r1 and completed disposition',t=>{
  for(const completed of [false,true]){
    const {specs,draft,documents,prepare}=fixture(t);fs.mkdirSync(path.join(specs,'.reviews'));fs.mkdirSync(path.join(specs,'1.guide'));
    for(const document of documents)fs.writeFileSync(path.join(specs,'1.guide',document.path),document.content);
    const ready=prepare('design');claimPrdReview({...ready.paths,package_sha256:ready.packageDigest});
    fs.writeFileSync(ready.paths.evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.guide/design.md\n---\nSynthetic original package review');
    if(completed)recordPrdReview({...ready.paths,disposition:'no_findings',finding_count:0,unresolved_count:0,
      artifact:[path.join(specs,'1.guide/design.md')]});
    assert.equal(prepare('design').gate.package_sha256,ready.packageDigest);
    draft.features[0].documents[0].content+='\nNew requirement';
    fs.writeFileSync(path.join(specs,'1.guide/requirements.md'),draft.features[0].documents[0].content);
    assert.throws(()=>prepare('design'),/prd_review_dispatch_package_changed/);
  }
});
