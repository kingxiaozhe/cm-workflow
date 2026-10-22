import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSplitSceneProposalEntry,assertSplitSceneDependencies} from '../runtime/js/cm-ai/review-split-proposal.mjs';
const hash=n=>String(n).repeat(64),clone=value=>structuredClone(value);
function scene(){
 const plan={sceneCoverage:{version:1,coverageDigest:hash(1)}};
 const child={taskId:'T-004a',material:{sha256:hash(2)}};
 const report={integrityVerified:true,taskId:child.taskId,fileSha256:hash(2),requestSha256:hash(3),coverageDigest:hash(1),
  sceneCoverage:{version:1,coverageDigest:hash(1)},scene:{taskId:child.taskId,scene:'402pt regular native Today/Plan/New'},
  readableImages:[{origin:'native',path:'paint-apricot-today.png'},{origin:'native',path:'final-rose-new.png'}],
  coverage:{materials:[{origin:'native',fileId:'native-original',owners:['T-004a','T-004c']},
   {origin:'continuation',fileId:'continuation-original',owners:['T-004a']},{origin:'native',fileId:'special',owners:['T-004c']}]}};
 const entry={text:'- [ ] T-004a: [NEW v3] Review scene\n  - review-only\n  - scope: `mobile/file.tsx`\n  - test-groups: `mobile/test.tsx:1-3`\n'
  +'  - review-scene: '+report.scene.scene+'\n  - scene-contract: `'+hash(1)+'`\n'
  +'  - scene-material: `'+hash(2)+'` `'+hash(3)+'`\n'
  +'  - scene-images: `native:paint-apricot-today.png` `native:final-rose-new.png`\n'
  +'  - scene-sources: `native:native-original` `continuation:continuation-original`\n'
  +'  - scene-closure: all-required-scenes\n'};
 return {plan,child,report,entry};
}
test('scene entry binds exact approved scene, mapping, material/request bytes and ordered original evidence',()=>{
 const f=scene();assert.deepEqual(assertSplitSceneProposalEntry(f.entry,f.plan,f.child,f.report),
  {taskId:'T-004a',scene:f.report.scene.scene,images:2,sources:2,coverageDigest:hash(1)});
});
test('scene metadata missing, duplicate, reordered, changed or extra is rejected',()=>{
 const original=scene();const mutations=[
  text=>text.replace('  - review-scene: 402pt regular native Today/Plan/New\n',''),
  text=>text+'  - scene-closure: all-required-scenes\n',
  text=>text.replace('402pt regular native Today/Plan/New','375pt alignment'),
  text=>text.replace('scene-contract: `'+hash(1)+'`','scene-contract: `'+hash(4)+'`'),
  text=>text.replace('scene-material: `'+hash(2)+'`','scene-material: `'+hash(4)+'`'),
  text=>text.replace('`'+hash(3)+'`','`'+hash(4)+'`'),
  text=>text.replace('`native:paint-apricot-today.png` `native:final-rose-new.png`','`native:final-rose-new.png` `native:paint-apricot-today.png`'),
  text=>text.replace(' `continuation:continuation-original`',''),
  text=>text.replace('all-required-scenes','this-scene-alone'),
  text=>text+'  - scene-unrecognized: trusted\n',
 ];
 for(const mutate of mutations){const f=clone(original);f.entry.text=mutate(f.entry.text);
  assert.throws(()=>assertSplitSceneProposalEntry(f.entry,f.plan,f.child,f.report),{code:'split_proposal_scene_binding'});}
});
test('unverified material, wrong task/hash and mismatched global scene digest cannot bind a proposal',()=>{
 for(const mutate of [f=>f.report.integrityVerified=false,f=>f.report.taskId='T-004b',f=>f.report.scene.taskId='T-004b',
  f=>f.report.fileSha256=hash(4),f=>f.report.sceneCoverage.coverageDigest=hash(4),f=>f.plan.sceneCoverage.version=2,
  f=>f.report.readableImages.push(clone(f.report.readableImages[0])),f=>f.report.coverage.materials[0].owners=['T-004c']]){
  const f=scene();mutate(f);assert.throws(()=>assertSplitSceneProposalEntry(f.entry,f.plan,f.child,f.report),error=>/^split_proposal_scene_/.test(error.code));
 }
});
const before='# Tasks\n- [x] T-001: Complete\n  - Original continuation\n- [ ] T-004: Original parent\n  - Original parent continuation\n- [ ] T-005: Existing downstream\n\n## 依赖关系\n- T-004 依赖 T-001, T-002, T-003\n- T-005 依赖 T-004\n- T-013 依赖 T-005\n\n## Other section\nKeep exact.\n';
const children=['T-004a','T-004b','T-004c'];
const after=before.replace('- T-004 依赖 T-001, T-002, T-003\n',
 '- T-004 依赖 T-001, T-002, T-003\n'+children.map(id=>`- ${id} 依赖 T-001, T-002, T-003\n`).join(''))
 .replace('- T-005 依赖 T-004\n','- T-005 依赖 T-004a, T-004b, T-004c\n');
test('standalone dependency migration preserves historical parent and requires every child as downstream prerequisite',()=>{
 assert.deepEqual(assertSplitSceneDependencies(before,after,'T-004',children),{parent:'T-004',children,preservedParent:true});
 for(const text of [after.replace('- T-005 依赖 T-004a, T-004b, T-004c','- T-005 依赖 T-004a'),
  after.replace('- T-004b 依赖 T-001, T-002, T-003','- T-004b 依赖 T-004a'),
  after.replace('- T-013 依赖 T-005','- T-013 依赖 T-004c'),after.replace('- T-004 依赖 T-001, T-002, T-003\n',''),
  after.replace('- T-005 依赖','- T-005 [OR] 依赖'),after+'- T-001 依赖 T-004a\n'])
  assert.throws(()=>assertSplitSceneDependencies(before,text,'T-004',children),{code:'split_proposal_scene_dependencies'});
});
