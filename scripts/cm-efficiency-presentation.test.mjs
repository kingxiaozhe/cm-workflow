import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactReviewData,expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
const file=(path,bytes)=>({path,type:'file',mode:420,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')});
test('complete inline presentation preserves AC/interface/context and all exact file bytes',()=>{
  const text=Buffer.from('Fixture \"quotes\"\n中文 content\n'.repeat(1000));
  const original={reviewPackage:{packageDigest:'a'.repeat(64),changes:[{path:'fixture.json',before:file('fixture.json',text),after:file('fixture.json',text)}],
    specification:{acceptanceCriteria:['AC-001'],interfaceContracts:['GET /fixture'],systemContext:'Required deployment context'},
    handoff:file('handoff.json',Buffer.from('{"case":"UI-001","passed":true}')),checks:[{id:'ui',command:['test-ui'],outcome:'passed',exitCode:0,evidence:'Case UI-001 passed'}]},
    priorReview:{verdict:'changes_requested',findings:[{severity:'P1',message:'Original finding'}]},examinedPaths:['fixture.json']};
  const bytes=JSON.stringify(original),presented=compactReviewData(original);
  assert.deepEqual(expandReviewData(presented),original);assert.equal(JSON.stringify(original),bytes);
  assert.equal(Object.keys(presented.contents).length,2);assert.equal(presented.contents['content-1'].encoding,'utf8');
  assert(JSON.stringify(presented).length<bytes.length);assert.deepEqual(presented.reviewPackage.specification,original.reviewPackage.specification);
  assert.deepEqual(presented.reviewPackage.checks,original.reviewPackage.checks);assert.deepEqual(presented.priorReview,original.priorReview);
});
test('binary, invalid UTF8 and BOM preserve base64 instead of silently changing bytes',()=>{
  for(const bytes of [Buffer.from([0xff,0x80]),Buffer.from([0xef,0xbb,0xbf,0x61]),Buffer.from([0,1,2])]){
    const original={reviewPackage:{packageDigest:'a'.repeat(64),materials:[file('binary',bytes)]},priorReview:null,examinedPaths:['binary']};
    assert.deepEqual(expandReviewData(compactReviewData(original)),original);
  }
});
test('wrong SHA, byte size or noncanonical base64 cannot become review presentation',()=>{
  const entry=file('file',Buffer.from('evidence'));
  for(const bad of [{...entry,sha256:'a'.repeat(64)},{...entry,size:500},{...entry,contentBase64:entry.contentBase64+'!'}])
    assert.throws(()=>compactReviewData({reviewPackage:{packageDigest:'b'.repeat(64),changes:[bad]},priorReview:null,examinedPaths:['file']}),/review_presentation_invalid/);
});

test('presentation refuses reserved reference keys rather than overwriting evidence',()=>{
  const data={reviewPackage:{packageDigest:'a'.repeat(64),materials:[file('file',Buffer.from('evidence'))]},priorReview:null,examinedPaths:['file']};
  for(const bad of [{...data,contents:{evidence:'original'}},{...data,presentation:{evidence:'original'}},
    {...data,reviewPackage:{...data.reviewPackage,materials:[{...data.reviewPackage.materials[0],contentRef:'original'}]}}])
    assert.throws(()=>compactReviewData(bad),/review_presentation_invalid/);
});
