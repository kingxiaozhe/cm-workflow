import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {prepareReviewSplitMaterials,verifySplitMaterial,compactSplitData,expandSplitData,splitPromptPages} from '../runtime/js/cm-ai/review-split-material.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-split-material-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const identity={repositoryId:'fixture',runId:'run-1',taskId:'T-004',attempt:2};
 const rec=(path,text)=>({path,mode:420,size:Buffer.byteLength(text),sha256:hash(text),contentBase64:Buffer.from(text).toString('base64')});
 const change=(p,text)=>({path:p,before:null,after:rec(p,text)});
 const changes=[change('mobile/src/ui/GlassSurface.tsx','surface'),change('mobile/src/ui/GlassHeader.tsx','header'),change('mobile/src/ui/BrandBar.tsx','brand'),change('mobile/src/__tests__/warm-frost-shell.spec.tsx',"it('keeps assertion',()=>{assert.equal(1,1);});\n")];
 const sourceDoc={scope:'all',rows:[{selector:'.dock',value:1},{selector:'.brandline',value:2},{selector:'.surface',value:3,children:[{selector:'.dock',value:4}]}],originalGzipBase64:'original-binding'};
 const materials=['native','continuation'].map((origin,n)=>{
  const store=path.join(root,origin);fs.mkdirSync(store);const raw=Buffer.from(JSON.stringify(sourceDoc)),h=hash(raw);fs.writeFileSync(path.join(store,h),raw);
  const image=Buffer.from('retained image '+n),ih=hash(image);fs.writeFileSync(path.join(store,ih),image);
  return {version:2,manifestDigest:hash('manifest'+n),sourceFiles:[],binaryAssets:{storeRoot:store},images:[{path:n?'native.png':'small-max-two-states.png',contentBlob:ih,sha256:ih,size:image.length,description:'fixture'}],textEvidence:{manifestDigest:hash('text'+n),storeRoot:store,files:[{id:'doc',path:'evidence.json',sha256:h,contentBlob:h,size:raw.length,mediaType:'application/json'}],requirements:[{id:'required-1',fileId:'doc',pointers:n?['']:[]}]}};
 });
 const finding={id:'R1',path:'handoff.json',message:'Unresolved',severity:'P1'},receipt={id:'review.1',receiptDigest:hash('receipt'),result:{findings:[finding],summary:'not accepted'}};
 const pkg={identity,changes,checks:[{kind:'native-evidence',material:materials[0]}],evidenceContinuation:{newEvidence:{material:materials[1]}},handoff:rec('handoff.json','original handoff'),specification:{requirements:['all assertions stay']}};
 changes.push({path:'mobile/package-lock.json',before:rec('mobile/package-lock.json',JSON.stringify({packages:{base:{version:'1'}}})),after:rec('mobile/package-lock.json',JSON.stringify({packages:{base:{version:'1'},new:{version:'2'}}}))});
 pkg.packageDigest=digest(pkg);
 const state={revision:hash('revision'),records:[{payload:{checkpoint:{receipts:[receipt]}}}]};
 const statePath=path.join(root,'state.json');save(statePath,state);
 const inventory={source:{originalPackageDigest:pkg.packageDigest,originalIdentity:identity,originalStatePath:statePath,originalStateFileSha256:hash(fs.readFileSync(statePath)),formalCalls:18},coverageMatrix:changes.map((c,i)=>({path:c.path,owner:['T-004a','T-004b','T-004c','T-004a','T-004a'][i],beforeSha256:c.before?.sha256??null,afterSha256:c.after.sha256})),testCaseOwnershipMatrix:[{path:changes[3].path,start:1,end:1,owners:['T-004a'],description:'assertion'}],priorFindingsOwnership:[{receiptId:receipt.id,receiptDigest:receipt.receiptDigest,finding,owners:['T-004a','T-004b','T-004c']}]};
 const packageFile=path.join(root,'package.json'),inventoryFile=path.join(root,'inventory.json');save(packageFile,pkg);inventory.source.originalPackageFileSha256=hash(fs.readFileSync(packageFile));save(inventoryFile,inventory);
 return {root,pkg,inventory,packageFile,inventoryFile,sourceDoc,materials};
}
function artifact(f,result,packet){const file=path.join(f.root,packet.taskId+'.material.json');save(file,{version:1,kind:'cm-review-split-material',source:result.source,coverageDigest:result.coverageDigest,...packet});return file;}
function rebindSource(f){
 const {packageDigest,...body}=f.pkg;f.pkg.packageDigest=digest(body);save(f.packageFile,f.pkg);
 f.inventory.source.originalPackageDigest=f.pkg.packageDigest;f.inventory.source.originalPackageFileSha256=hash(fs.readFileSync(f.packageFile));save(f.inventoryFile,f.inventory);
}
function rebindRequest(v,data){
 const marker='<cm-review-split-data-json>\n',prefix=v.request.prompt.split(marker)[0];v.request.prompt=prefix+marker+JSON.stringify(compactSplitData(data));
 v.requestSha256=hash(JSON.stringify(v.request));const paging=splitPromptPages(v.request.prompt),imageBytes=v.request.images.reduce((n,i)=>n+i.size,0);
 v.counts={...v.counts,...paging,images:v.request.images.length,imageBytes,textPlusImageBytes:paging.promptBytes+imageBytes,serializedRequestBytes:Buffer.byteLength(JSON.stringify(v.request))};
 v.blockers=[...(paging.pageCount>128?['text_page_target_exceeded']:[]),...(v.request.images.length>10?['image_target_exceeded']:[]),'formal_split_admission_required'];
}
test('offline candidate preserves both manifests, root pointers, original assertions and image bytes',t=>{
 const f=fixture(t),before=hash(fs.readFileSync(f.packageFile)),result=prepareReviewSplitMaterials(f);
 assert.equal(result.packets.length,3);assert.equal(result.coverage.findings.length,1);
 assert.ok(result.coverage.materials[0].rows.some(r=>r.pointer==='/rows/2'&&r.owners.includes('T-004a')));
 for(const p of result.packets){
  assert.equal(p.request.dispatchAuthorized,false);assert.equal(p.reviewReady,false);
  const data=expandSplitData(JSON.parse(p.request.prompt.split('<cm-review-split-data-json>\n')[1]));
  assert.equal(data.sourceManifests.length,2);assert.deepEqual(data.materials.find(m=>m.origin==='continuation').data,f.sourceDoc);
  assert.equal(data.allTestGroupCoverage[0].description,'assertion');assert.match(data.originalContext.handoff.text,/original handoff/);
  const verified=verifySplitMaterial(artifact(f,result,p),{expectedSource:result.source,expectedCoverageDigest:result.coverageDigest});
  assert.equal(verified.integrityVerified,true);assert.equal(verified.accepted,false);assert.equal(verified.budgetEligible,true);assert.equal(verified.capacityPassed,true);assert.equal(verified.originalPackageDigest,result.source.originalPackageDigest);
  assert.equal(verified.coverage.images.length,2);assert.equal(verified.readableImages.length,2);
  assert.deepEqual(verified.sourceManifests.map(m=>m.images),f.materials.map(m=>m.images));
 }
 assert.equal(hash(fs.readFileSync(f.packageFile)),before);
});
test('all original images have readable responsibility; rehashed omission and byte tamper are refused',t=>{
 const f=fixture(t),m=f.materials[0];
 for(const name of ['paint-apricot-today.png','paint-apricot-plan.png','paint-rose-today.png','paint-rose-plan.png','final-apricot-new.png','final-rose-new.png'])m.images.push({...m.images[0],path:name});
 rebindSource(f);const result=prepareReviewSplitMaterials(f),seen=new Set();
 for(const p of result.packets){
  const verified=verifySplitMaterial(artifact(f,result,p));
  for(const i of verified.readableImages)seen.add(i.origin+'/'+i.path);
 }
 assert.equal(seen.size,8);assert.equal(result.coverage.images.length,8);
 assert.deepEqual(result.coverage.images.find(i=>i.path==='final-rose-new.png').owners,['T-004a']);
 assert.deepEqual(result.coverage.images.find(i=>i.path==='paint-rose-today.png').owners,['T-004a','T-004b','T-004c']);
 const p=result.packets[0],file=artifact(f,result,p),v=JSON.parse(fs.readFileSync(file)),data=expandSplitData(JSON.parse(v.request.prompt.split('<cm-review-split-data-json>\n')[1]));
 v.request.images=v.request.images.filter(i=>i.path!=='paint-apricot-today.png');data.images=data.images.filter(i=>i.path!=='paint-apricot-today.png');rebindRequest(v,data);save(file,v);
 assert.throws(()=>verifySplitMaterial(file),e=>e.code==='split_material_images');
 const fresh=JSON.parse(fs.readFileSync(artifact(f,result,p))),freshData=expandSplitData(JSON.parse(fresh.request.prompt.split('<cm-review-split-data-json>\n')[1]));
 fresh.request.images[0].contentBase64=Buffer.from('different original bytes').toString('base64');rebindRequest(fresh,freshData);save(file,fresh);
 assert.throws(()=>verifySplitMaterial(file),e=>e.code==='split_material_images');
});
test('source blob drift and omitted original assertion group are refused without side effects',t=>{
 const f=fixture(t),m=f.materials[1];fs.appendFileSync(path.join(m.textEvidence.storeRoot,m.textEvidence.files[0].contentBlob),' ');
 assert.throws(()=>prepareReviewSplitMaterials(f),e=>e.code==='split_material_digest');
 const g=fixture(t);g.inventory.testCaseOwnershipMatrix=[];save(g.inventoryFile,g.inventory);
 assert.throws(()=>prepareReviewSplitMaterials(g),e=>e.code==='split_material_tests');
});
test('exact serialized request and source binding are checked; 11 images stay blocked',t=>{
 const f=fixture(t),result=prepareReviewSplitMaterials(f),p=result.packets[0],file=artifact(f,result,p);
 assert.throws(()=>verifySplitMaterial(file,{expectedSource:{bad:true}}),e=>e.code==='split_material_source');
 const tampered=JSON.parse(fs.readFileSync(file));tampered.request.prompt+=' ';save(file,tampered);
 assert.throws(()=>verifySplitMaterial(file),e=>e.code==='split_material_digest');
 const g=fixture(t),m=g.pkg.evidenceContinuation.newEvidence.material;
 for(let i=0;i<10;i++)m.images.push({...m.images[0],path:'extra-'+i+'.png'});
 const {packageDigest,...body}=g.pkg;g.pkg.packageDigest=digest(body);save(g.packageFile,g.pkg);g.inventory.source.originalPackageDigest=g.pkg.packageDigest;g.inventory.source.originalPackageFileSha256=hash(fs.readFileSync(g.packageFile));save(g.inventoryFile,g.inventory);
 const more=prepareReviewSplitMaterials(g),packet=more.packets[0];assert.ok(packet.blockers.includes('image_target_exceeded'));assert.equal(packet.reviewReady,false);
 assert.equal(verifySplitMaterial(artifact(g,more,packet)).budgetEligible,false);
});
test('UTF-8 boundary paging and inline shared JSON roundtrip preserve complete values',()=>{
 const prompt='中'.repeat(20000),pages=splitPromptPages(prompt),b=Buffer.from(prompt);
 assert.equal(pages.pageBytes,16384);assert.equal(pages.pageCount,4);
 assert.equal(pages.pages.map(p=>b.subarray(p.offset,p.end).toString('utf8')).join(''),prompt);
 const row={shared:'x'.repeat(400)},data={a:{nested:row},b:{nested:row},c:row};
 assert.deepEqual(expandSplitData(compactSplitData(data)),data);
 assert.throws(()=>expandSplitData({body:{splitInlineRef:'s1'},inline:{s1:{splitInlineRef:'s1'}}}),e=>e.code==='split_material_reference');
});
