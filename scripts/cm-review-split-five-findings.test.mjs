import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {splitFixture} from './cm-ai-review-split-fixture.mjs';
import {prepareReviewOnlySplit,registerReviewOnlySplit,reviewOnlyTask,inspectReviewOnlySplit} from '../runtime/js/cm-ai/review-only-split.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {matchesCmAiTaskSelection} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {inspectSpecs} from './cm-failover.mjs';
import {compactSplitData,expandSplitData,splitPromptPages} from '../runtime/js/cm-ai/review-split-material.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function mutatePacket(f,edit){
  const child=f.plan.children[0],v=JSON.parse(fs.readFileSync(child.material.path));
  const marker='<cm-review-split-data-json>\n',start=v.request.prompt.indexOf(marker)+marker.length;
  const data=expandSplitData(JSON.parse(v.request.prompt.slice(start)));edit(data);
  v.request.prompt=v.request.prompt.slice(0,start)+JSON.stringify(compactSplitData(data));
  const imageBytes=v.request.images.reduce((n,image)=>n+image.size,0);
  v.counts={...splitPromptPages(v.request.prompt),images:v.request.images.length,imageBytes,
    textPlusImageBytes:Buffer.byteLength(v.request.prompt)+imageBytes,serializedRequestBytes:Buffer.byteLength(JSON.stringify(v.request)),wireBytes:null,wireBoundary:v.counts.wireBoundary};
  v.requestSha256=hash(Buffer.from(JSON.stringify(v.request)));fs.writeFileSync(child.material.path,JSON.stringify(v));child.material=f.ref(child.material.path);
}
test('R1: owned production bytes and lock delta cannot be omitted or rewritten behind fresh hashes',()=>{
  for(const edit of [
    d=>{d.changes=d.changes.filter(c=>!c.path.endsWith('/GlassSurface.tsx'));},
    d=>{d.changes.find(c=>c.path.endsWith('/GlassSurface.tsx')).after.text='different implementation';},
    d=>{d.changes.find(c=>c.path.endsWith('/GlassSurface.tsx')).after.mode=0o600;},
    d=>{d.changes.find(c=>c.kind==='verified-json-delta').changed=[];},
  ]){
    const f=splitFixture();try{
      mutatePacket(f,edit);const result=prepareReviewOnlySplit(f.plan);
      assert.equal(result.accepted,false);assert.ok(result.blockers.some(b=>['split_source_bytes_missing','split_source_delta'].includes(b.code)),JSON.stringify(result.blockers));
      assert.throws(()=>registerReviewOnlySplit(f.plan),{code:'split_preflight_failed'});
      assert.equal(inspectReviewOnlySplit(f.plan).parentRecords,f.snapshot.records.length);
    }finally{f.cleanup();}
  }
});
test('R2: parent intent alone blocks every ordinary creation, task selection and failover',async()=>{
  const f=splitFixture();try{
    const p=f.plan,splitDigest=digest(p),store=openExecutionStore({specsRoot:p.specsDir,identity:{repositoryId:'fixture',runId:'parent'},fingerprints:p.parent.fingerprints,create:false});
    const payload={type:'review-only-split-intent',version:1,splitDigest,parent:p.parent,feature:p.feature,
      children:p.children.map(c=>({runId:c.runId,taskId:c.taskId})),plan:p};
    store.append({id:`split-${splitDigest.slice(0,40)}-intent`,kind:'intent',payload,expectedRevision:store.snapshot().revision});store.close();
    assert.deepEqual(inspectReviewOnlySplit(p).children.map(c=>c.stage),['absent','absent','absent']);
    for(const taskId of ['T-004','T-004a','T-004b','T-004c']){
      assert.equal(reviewOnlyTask({specsDir:p.specsDir,feature:p.feature,taskId}),true);
      assert.equal(matchesCmAiTaskSelection({state:'ready',specsDir:p.specsDir,nextTask:{feature:p.feature,id:taskId}},p.feature,taskId),false);
      await assert.rejects(openControlRun({specsDir:p.specsDir,codeProject:p.codeProject,feature:p.feature,
        identity:{repositoryId:'fixture',runId:'ordinary-alternative-'+taskId,taskId,attempt:1}},'create'),{code:'review_only_split_no_ordinary_run'});
    }
    assert.equal(inspectSpecs(p.specsDir).features[0].breakpoint.state,'review_only_split');
    assert.equal(registerReviewOnlySplit(p).stage,'committed');
  }finally{f.cleanup();}
});
