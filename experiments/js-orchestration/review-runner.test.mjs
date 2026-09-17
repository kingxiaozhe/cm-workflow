import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPaths,reviewResult,reviewResultForPaths} from './review-runner.mjs';

const pkg={packageDigest:'fixture-digest',changes:[{path:'code.js'}],requirements:[{path:'requirements.md'}],
  instructions:[{path:'AGENTS.md'}],bootstrapRequirements:{files:[{path:'design.md'}]},
  handoff:{path:'work-T-001-a1-handoff.json'}};
const finding={id:'F1',severity:'P3',path:'code.js',message:'Synthetic concern',evidence:'Fixture evidence'};
const result=()=>({verdict:'approved',packageDigest:pkg.packageDigest,
  examinedPaths:['AGENTS.md','code.js','requirements.md','specs:design.md'],findings:[{...finding}],summary:'Reviewed'});

test('handoff is allowed for findings without changing required examined paths',()=>{
  const r=result();assert.deepEqual(reviewPaths(pkg),r.examinedPaths);
  for(const path of [...r.examinedPaths,pkg.handoff.path]){
    r.findings[0].path=path;assert.deepEqual(reviewResult(r,pkg),r);
  }
  for(const examinedPaths of [r.examinedPaths.slice(1),[...r.examinedPaths,pkg.handoff.path],
    [...r.examinedPaths].reverse(),[...r.examinedPaths,r.examinedPaths[0]]]){
    assert.throws(()=>reviewResult({...r,examinedPaths},pkg),{code:'missing_material'});
  }
  const {handoff,...withoutHandoff}=pkg;
  assert.throws(()=>reviewResult(r,withoutHandoff),{code:'invalid_finding_path'});
});

for(const [label,findings,code] of [
  ['outside path',[{...finding,path:'outside.js'}],'invalid_finding_path'],
  ['nonstring path',[{...finding,path:null}],'invalid_finding_path'],
  ['spaced id',[{...finding,id:'invalid id'}],'invalid_finding_id'],
  ['empty id',[{...finding,id:''}],'invalid_finding_id'],
  ['long id',[{...finding,id:'a'.repeat(129)}],'invalid_finding_id'],
  ['nonstring id',[{...finding,id:42}],'invalid_finding_id'],
  ['severity',[{...finding,severity:'P4'}],'invalid_finding_severity'],
  ['null finding',[null],'invalid_finding_shape'],
  ['array finding',[[]],'invalid_finding_shape'],
  ['missing field',[{id:'F1',severity:'P3',path:'code.js',message:'Concern'}],'invalid_finding_shape'],
  ['extra field',[{...finding,extra:true}],'invalid_finding_shape'],
  ['duplicate id',[{...finding},{...finding}],'invalid_finding_shape'],
  ['empty message',[{...finding,message:' '}],'invalid_finding_shape'],
  ['invalid evidence',[{...finding,evidence:null}],'invalid_finding_shape'],
  ['nonarray findings',null,'invalid_finding_shape'],
  ['too many findings',Array.from({length:101},(_,i)=>({...finding,id:`F${i}`})),'invalid_finding_shape'],
])test(`result names invalid finding: ${label}`,()=>{
  assert.throws(()=>reviewResult({...result(),findings},pkg),{code});
});

test('blocking handoff findings still require a consistent verdict',()=>{
  const r=result();r.findings[0]={...finding,path:pkg.handoff.path,severity:'P2'};
  assert.throws(()=>reviewResult(r,pkg),{code:'contradictory_verdict'});
  for(const verdict of ['changes_requested','blocked'])assert.equal(reviewResult({...r,verdict},pkg).verdict,verdict);
  assert.throws(()=>reviewResult({...r,verdict:'changes_requested',findings:[]},pkg),{code:'contradictory_verdict'});
});

test('explicit root-cause paths work without implementation-package fields',()=>{
  const cause={packageDigest:'cause-digest',files:[{path:'cause.js'}]},paths=['cause.js'];
  const r={...result(),packageDigest:cause.packageDigest,examinedPaths:paths,findings:[{...finding,path:'cause.js'}]};
  assert.deepEqual(reviewResultForPaths(r,cause,paths),r);
  assert.throws(()=>reviewResultForPaths({...r,findings:[finding]},cause,paths),{code:'invalid_finding_path'});
  assert.throws(()=>reviewResultForPaths({...r,examinedPaths:[]},cause,paths),{code:'missing_material'});
});
