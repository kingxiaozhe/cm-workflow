// Synthetic local scene provenance only. No runner, provider, Wue, or PRD writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {compactSplitData,splitPromptPages,verifySplitMaterial} from '../runtime/js/cm-ai/review-split-material.mjs';
import {assertSceneSourceCoverage} from '../runtime/js/cm-ai/review-split-scene.mjs';
import {assertSplitCoverage} from '../runtime/js/cm-ai/review-only-split.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const ids=['T-004a','T-004b','T-004c'];
const marker='<cm-offline-scene-data-json>\n';
const closureRule='No scene can close a cross-scene finding or acceptance criterion alone. Require every assigned scene conclusion and all original blocking checks; missing evidence, unsupported reuse or unavailable formal admission remains BLOCKED. Preparation makes no pass/closure finding.';
const record=(name,text)=>({path:name,type:'file',mode:420,size:Buffer.byteLength(text),sha256:sha(text),contentBase64:Buffer.from(text).toString('base64')});
const plainRecord=r=>{
  if(r===null)return null;
  const {contentBase64,...metadata}=r;return {...metadata,text:Buffer.from(contentBase64,'base64').toString('utf8')};
};
const decoded=v=>Array.isArray(v)?v.map(decoded):v&&typeof v==='object'?
  Object.hasOwn(v,'contentBase64')?plainRecord(v):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decoded(x)])):v;
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data));
function fixture(t,{imageCountA=1}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-scene-material-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manifests=['native','continuation'].map((origin,index)=>{
    const storeRoot=path.join(root,origin);fs.mkdirSync(storeRoot);
    const text=index?'# Original continuation\nNever close old findings.\n':'{"value":-0,"nested":{"kept":"all original values"}}\n';
    const raw=Buffer.from(text),h=sha(raw);fs.writeFileSync(path.join(storeRoot,h),raw);
    const images=Array.from({length:index?1:imageCountA+1},(_,i)=>{
      const image=Buffer.from(`synthetic readable original ${origin} ${i}`),hash=sha(image);fs.writeFileSync(path.join(storeRoot,hash),image);
      return {path:`${origin}-${i}.png`,type:'file',mode:420,sha256:hash,contentBlob:hash,size:image.length,description:'Synthetic original image'};
    });
    const files=[{id:'source-1',path:index?'REPORT.md':'values.json',sha256:h,contentBlob:h,size:raw.length,mediaType:index?'text/markdown':'application/json',description:'Full original source'}];
    return {origin,version:2,report:'Original manifest scope and limits remain readable.',manifestDigest:digest(origin),binaryAssets:{storeRoot},images,
      textEvidence:{version:1,manifestDigest:digest(files),storeRoot,files,requirements:[{id:'required-1',fileId:'source-1',pointers:index?[]:['/value','/nested/kept']}]}};
  });
  const shell="it('retains the full original test',()=>{expect(1).toBe(1);});\n";
  const changes=[{path:'mobile/src/__tests__/warm-frost-shell.spec.tsx',before:null,after:record('mobile/src/__tests__/warm-frost-shell.spec.tsx',shell)},
    {path:'mobile/src/ui/GlassSurface.tsx',before:record('mobile/src/ui/GlassSurface.tsx','export const value=0;\n'),after:record('mobile/src/ui/GlassSurface.tsx','export const value=1;\n')}];
  const tests=[{path:changes[0].path,start:1,end:1,description:"it('retains the full original test'",owners:ids}];
  const ac={id:'AC-001',text:'Keep every original acceptance condition.'};
  const tc={id:'TC-001',blocking:true,origin:'user',taskIds:['T-004'],acIds:['AC-001'],steps:['Read original source'],expected:['All original conditions hold']};
  const stripOrigin=({origin,...m})=>m;
  const body={version:1,kind:'cm-review-package',identity:{repositoryId:'fixture',runId:'original',taskId:'T-004',attempt:2},
    baseIdentity:digest('base'),artifactDigest:digest(changes),scope:changes.map(c=>c.path),changes,
    unchangedScope:[{path:'AGENTS.md',sha256:sha('unchanged'),size:9}],requirements:[],specification:{acceptanceCriteria:[ac],testCases:[tc],sources:[{path:'requirements.md',sha256:sha(ac.text)}]},
    checks:[{id:'native-evidence',kind:'native-evidence',material:stripOrigin(manifests[0])}],evidenceContinuation:{newEvidence:{material:stripOrigin(manifests[1])}}};
  const pkg={...body,packageDigest:digest(body)};
  const finding={id:'R1',severity:'P1',path:'handoff.json',message:'Original unresolved finding',evidence:'Original missing-evidence restriction'};
  const receiptBody={id:'original-review',result:{verdict:'blocked',findings:[finding]}};
  const receipt={...receiptBody,receiptDigest:digest(receiptBody)},last={receipts:[receipt]};
  const findings=[{receiptId:receipt.id,receiptDigest:receipt.receiptDigest,finding,owners:ids}];
  const imageMap=manifests.flatMap((m,index)=>m.images.map((i,n)=>({origin:m.origin,path:i.path,sha256:i.sha256,size:i.size,originalDescription:i.description,representation:'complete-original-image-bytes',
    owners:[index?'T-004b':n===imageCountA?'T-004c':'T-004a']})));
  const textSources=manifests.flatMap(m=>m.textEvidence.files.map(f=>({origin:m.origin,fileId:f.id,path:f.path,sha256:f.sha256,size:f.size,
    contentBlob:f.contentBlob,storeRoot:m.textEvidence.storeRoot,mediaType:f.mediaType,requirements:m.textEvidence.requirements.filter(r=>r.fileId===f.id),owners:ids,reason:'Full common source'})));
  const textMapping={images:imageMap,textSources};
  const common={owners:ids,visibleIn:ids,combination:'AND'};
  const responsibilityMapping={version:1,kind:'wue-T004-scene-responsibility-candidate',status:'offline_mapping_only_not_formally_admitted',
    sourceIdentity:pkg.identity,originalPackageDigest:pkg.packageDigest,originalBaseIdentity:pkg.baseIdentity,originalArtifactDigest:pkg.artifactDigest,
    changedPaths:changes.map(c=>({id:c.path,originalRecordCanonicalSha256:digest(c),before:c.before,after:c.after,...common})),
    otherOriginalScope:[...pkg.unchangedScope.map(c=>({id:c.path,original:c,changed:false,...common})),
      ...pkg.specification.sources.map(c=>({id:'specification:'+c.path,original:c,changed:false,...common}))],
    testGroups:tests.map(r=>({id:`${r.path}:${r.start}-${r.end}`,original:r,fileAfterSha256:changes[0].after.sha256,originalText:shell,originalTextUtf8Sha256:sha(shell),originalInventoryEntryCanonicalSha256:digest(r),...common})),
    findings:[{id:receipt.id+':R1',originalReceiptId:receipt.id,originalReceiptDigest:receipt.receiptDigest,original:finding,originalCanonicalSha256:digest(finding),
      messageUtf8Sha256:sha(finding.message),evidenceUtf8Sha256:sha(finding.evidence),disposition:'open',closedByPreparation:false,...common}],
    historicalReceipts:[{id:receipt.id,original:receipt,originalCanonicalSha256:digest(receipt),originalVerdict:receipt.result.verdict,currentApproval:false,...common}],
    acceptanceCriteria:[{id:ac.id,originalText:ac.text,originalTextUtf8Sha256:sha(ac.text),featureAcAcceptedByThisPreparation:false,...common,combination:'AND_for_original_T004_contribution'}],
    originalBlockingCases:[{id:tc.id,original:tc,originalCanonicalSha256:digest(tc),semanticsChanged:false,originalTaskIdsRetained:tc.taskIds,...common}],
    historicalCheckBindings:pkg.checks.map(c=>({id:c.id,originalCanonicalSha256:digest(c),executedNow:false,...common})),
    sharedTextSourceBindings:textSources.map(s=>({id:s.origin+':'+s.fileId,origin:s.origin,fileId:s.fileId,path:s.path,sha256:s.sha256,bytes:s.size,owners:s.owners}))};
  const sceneDefinitions=ids.map(taskId=>({taskId,scene:'Synthetic acceptance scene '+taskId,imageCount:imageMap.filter(i=>i.owners.includes(taskId)).length,
    imagePaths:imageMap.filter(i=>i.owners.includes(taskId)).map(i=>i.path),bounds:'Original historical scope only; no preparation approval.'}));
  responsibilityMapping.imageAssignments=imageMap.map(i=>({...i,id:i.origin+':'+i.path,bytes:i.size,descriptionUtf8Sha256:sha(i.originalDescription),visibleIn:i.owners}));
  responsibilityMapping.scenes=sceneDefinitions.map(s=>({id:s.taskId,imageCount:s.imageCount,imageIds:imageMap.filter(i=>i.owners.includes(s.taskId)).map(i=>i.origin+':'+i.path),mustNotSubstituteForOtherScenes:true}));
  const mapping={sceneDefinitions,responsibilityMapping,textMapping,closureRule},coverageDigest=digest(mapping);
  const source={identity:pkg.identity,originalPackageDigest:pkg.packageDigest,originalPackageFileSha256:sha(JSON.stringify(pkg)),originalStateSha256:sha('fixture state'),originalRecords:97,originalCalls:18};
  const {changes:ignored,...originalContext}=decoded(pkg);
  const data=ids.map(taskId=>{
    const selected=imageMap.filter(i=>i.owners.includes(taskId));
    const images=selected.map(i=>({origin:i.origin,...manifests.find(m=>m.origin===i.origin).images.find(x=>x.path===i.path)}));
    const materials=manifests.map(m=>{const f=m.textEvidence.files[0],text=fs.readFileSync(path.join(m.textEvidence.storeRoot,f.contentBlob),'utf8');
      return {origin:m.origin,metadata:f,requirements:m.textEvidence.requirements,representation:m.origin==='native'?'complete-original-json-text':'complete-original-text',data:text};});
    return structuredClone({kind:'cm-offline-scene-candidate-data',status:'offline-preparation-only',proposedTaskId:taskId,scene:sceneDefinitions.find(s=>s.taskId===taskId),source,
      originalContext,changes:changes.map(c=>({...c,before:plainRecord(c.before),after:plainRecord(c.after)})),oldReceipts:[receipt],originalTestGroups:tests,
      historicalComponentOwnership:{status:'historical-only',changes:changes.map(c=>({path:c.path,owner:'T-004a',beforeSha256:c.before?.sha256??null,afterSha256:c.after.sha256})),tests,findings},
      sourceManifests:manifests,mapping,coverageDigest,materials,images});
  });
  const files=ids.map(id=>path.join(root,id+'.scene-material.json'));
  const plan={sceneCoverage:{version:1,coverageDigest},manifests:manifests.map(m=>{
    const file=path.join(root,m.origin+'-manifest.json');save(file,stripOrigin(m));return {path:file,sha256:sha(fs.readFileSync(file))};
  }),ownership:{paths:Object.fromEntries(changes.map(c=>[c.path,ids])),tests:tests.map(r=>({id:`${r.path}:${r.start}-${r.end}`,owners:ids})),
    findings:[{id:receipt.id+':R1',owners:ids,disposition:'open'}],sources:textSources.map(s=>({id:s.origin+':'+s.fileId,owners:s.owners}))},
    children:ids.map(taskId=>({taskId,paths:changes.map(c=>c.path),tests:tests.map(r=>`${r.path}:${r.start}-${r.end}`),findings:[receipt.id+':R1']}))};
  function write(index,{prefix='OFFLINE CANDIDATE ONLY.\n',images}={}){
    const d=data[index],actual=images??d.images.map(i=>({...i,contentBase64:fs.readFileSync(path.join(manifests.find(m=>m.origin===i.origin).binaryAssets.storeRoot,i.contentBlob)).toString('base64')}));
    const prompt=prefix+marker+JSON.stringify(compactSplitData(d));
    const request={version:1,kind:'cm-offline-scene-candidate-request',status:'offline-preparation-only',proposedTaskId:d.proposedTaskId,providerAccepted:false,dispatchAuthorized:false,prompt,images:actual};
    const paging=splitPromptPages(prompt),imageBytes=actual.reduce((n,i)=>n+i.size,0),capacityBlockers=[...(paging.pageCount>128?['text_page_target_exceeded']:[]),...(actual.length>10?['image_target_exceeded']:[])];
    const v={version:1,kind:'cm-offline-scene-material',source,taskId:d.proposedTaskId,coverageDigest:d.coverageDigest,request,requestSha256:sha(JSON.stringify(request)),expandedDataSha256:sha(JSON.stringify(d)),
      counts:{...paging,images:actual.length,imageBytes,textPlusImageBytes:paging.promptBytes+imageBytes,serializedRequestBytes:Buffer.byteLength(JSON.stringify(request)),wireBytes:null,
        wireBoundary:'No request sent. Serialized UTF-8 JSON includes base64 images, but excludes provider/RPC envelope.'},
      coverage:{codeChanges:changes.length,testGroups:tests.length,acceptanceCriteria:1,receipts:1,oldFindingOccurrences:1,textSourcesIncluded:d.materials.length,textSourcesMapped:2,originalImagesMapped:imageMap.length},
      capacityPassed:capacityBlockers.length===0,capacityBlockers,formalProviderAccepted:false,reviewReady:false};
    save(files[index],v);return v;
  }
  data.forEach((_,i)=>write(i));
  return {root,pkg,last,data,files,write,manifests,mapping,plan};
}
function verified(f,index=0){
  const reports=f.files.map(file=>verifySplitMaterial(file));
  for(const report of reports)assertSceneSourceCoverage(report,f.pkg,f.last);
  assertSplitCoverage(f.plan,f.pkg,f.last,reports);return reports[index];
}
function rejects(f){assert.throws(()=>verified(f),e=>typeof e.code==='string'&&e.code.startsWith('split_'));}

test('scene material carries complete original text/images, required pointers, ACs, receipts, tests and code',t=>{
  const f=fixture(t);
  for(let i=0;i<3;i++){
    const report=verified(f,i);assert.equal(report.integrityVerified,true);assert.equal(report.formalProviderAccepted,false);assert.equal(report.capacityPassed,true);
    assert.equal(report.sceneCoverage.version,1);assert.equal(report.sceneCoverage.coverageDigest,f.data[i].coverageDigest);
    assert.deepEqual(report.scene,f.data[i].scene);assert.equal(Object.getOwnPropertyDescriptor(report,'sceneData').enumerable,false);
    assert.deepEqual(report.sceneData.materials,f.data[i].materials);
  }
});

test('scene assigned text/image removal is refused even with recomputed request digests',t=>{
  const text=fixture(t);text.data[0].materials.shift();text.write(0);rejects(text);
  const image=fixture(t);image.data[0].images=[];image.write(0,{images:[]});rejects(image);
});

test('scene metadata, required pointers, original AC/receipt/test/code cannot be changed by rehashing',t=>{
  const mutations=[d=>{d.materials[0].metadata.description='forged metadata';},d=>{d.materials[0].requirements[0].pointers=[];},
    d=>{d.originalContext.specification.acceptanceCriteria[0].text='weaker assertion';},d=>{d.oldReceipts[0].result.findings[0].message='closed by author';},
    d=>{d.originalTestGroups[0].end=2;},d=>{d.changes[1].after.text='export const value=2;\n';},
    d=>{d.mapping.responsibilityMapping.findings[0].closedByPreparation=true;d.coverageDigest=digest(d.mapping);}];
  for(const mutate of mutations){const f=fixture(t);mutate(f.data[0]);f.write(0);rejects(f);}
  const forged=fixture(t),v=JSON.parse(fs.readFileSync(forged.files[0]));v.requestSha256='0'.repeat(64);save(forged.files[0],v);rejects(forged);
});

test('signed zero JSON requires the complete exact original UTF-8 text',t=>{
  const f=fixture(t),original=f.data[0].materials[0].data;assert(Object.is(JSON.parse(original).value,-0));
  assert.doesNotThrow(()=>verified(f));
  f.data[0].materials[0].representation='complete-original-json-values';f.data[0].materials[0].data=JSON.parse(original);f.write(0);rejects(f);
  const altered=fixture(t);altered.data[0].materials[0].data=altered.data[0].materials[0].data.replace('-0','0');altered.write(0);rejects(altered);
});

test('scene capacity is measured at 16384 UTF-8 bytes/page and never raised above 128 pages or 10 images',t=>{
  const pages=fixture(t);pages.write(0,{prefix:'x'.repeat(128*16384)});
  const report=verifySplitMaterial(pages.files[0]);assert.equal(report.counts.pageBytes,16384);assert(report.counts.pageCount>128);assert.equal(report.capacityPassed,false);
  const images=fixture(t,{imageCountA:11});
  assert.throws(()=>verifySplitMaterial(images.files[0]),e=>e.code==='split_scene_definitions');
});

test('scene and legacy reports cannot mix or evade the explicit plan coverage digest',()=>{
  const scene={sceneCoverage:{version:1,coverageDigest:'a'.repeat(64)}},legacy={};
  assert.throws(()=>assertSplitCoverage({},null,null,[scene,legacy,legacy]),e=>e.code==='split_scene_plan_required');
  assert.throws(()=>assertSplitCoverage({sceneCoverage:{version:1,coverageDigest:'b'.repeat(64)}},null,null,[scene,scene,scene]),e=>e.code==='split_scene_plan');
});
