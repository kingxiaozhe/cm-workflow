// Focused provenance negatives; no runner, provider, product writes or grants.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {assertSplitCoverage} from '../runtime/js/cm-ai/review-only-split.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ids=['T-004a','T-004b','T-004c'];
const key=row=>`${row.path}:${row.start}-${row.end}`;
const findingKey=row=>`${row.receiptId}:${row.finding.id}`;
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-split-coverage-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const record=text=>({type:'file',mode:420,size:Buffer.byteLength(text),sha256:sha(text),
    contentGzipBase64:gzipSync(text).toString('base64')});
  const shellPath='mobile/src/__tests__/warm-frost-shell.spec.tsx';
  const todayPath='mobile/src/__tests__/today-warm-theme.spec.tsx';
  const shell=Array.from({length:22},(_,i)=>`it('shell ${i+1}', () => {\n  expect(${i}).toBe(${i});\n});`).join('\n')+'\n';
  const todayBefore="it('navigation', () => {\n  expect(header).toBe('old');\n});\nit('unchanged', () => {\n  expect(true).toBe(true);\n});\n";
  const todayAfter=todayBefore.replace("toBe('old')","toBe('new')");
  const changes=[{path:shellPath,before:null,after:record(shell)},
    {path:todayPath,before:record(todayBefore),after:record(todayAfter)}];
  const tests=Array.from({length:22},(_,i)=>({path:shellPath,start:i*3+1,end:i*3+3,
    description:`it('shell ${i+1}', () => {`,owners:[ids[i%3]]}));
  tests.push({path:todayPath,start:1,end:3,description:"it('navigation', () => {",owners:['T-004b']});
  const materials=['native','continuation'].map((origin,index)=>({version:2,manifestDigest:sha(origin),images:[],
    textEvidence:{version:1,manifestDigest:sha('text-'+origin),storeRoot:root,
      files:Array.from({length:25},(_,i)=>({id:'source-'+i,path:origin+'-'+i+'.txt',sha256:sha(origin+i),size:i+1})),
      requirements:[]}}));
  const pkg={changes,checks:[{id:'native-evidence',kind:'native-evidence',material:materials[0]}],
    evidenceContinuation:{newEvidence:{material:materials[1]}}};
  const receipts=ids.slice(0,2).map((_,i)=>({id:'receipt-'+i,receiptDigest:sha('receipt-'+i),
    result:{findings:[{id:'R'+i,severity:'P2',message:'Retain unresolved finding '+i}]}}));
  const findings=receipts.map((r,i)=>({receiptId:r.id,receiptDigest:r.receiptDigest,
    finding:r.result.findings[0],owners:[ids[i]]}));
  const changeCoverage=ids.map(owner=>({path:shellPath,owner,beforeSha256:null,afterSha256:changes[0].after.sha256}));
  changeCoverage.push({path:todayPath,owner:'T-004b',beforeSha256:changes[1].before.sha256,afterSha256:changes[1].after.sha256});
  const sources=materials.flatMap((m,i)=>m.textEvidence.files.map(f=>({origin:['native','continuation'][i],fileId:f.id,
    sha256:f.sha256,size:f.size,requirements:[],owners:[...ids]})));
  const coverage={changes:changeCoverage,tests,findings,materials:sources,images:[]};
  const sourceManifests=materials.map((m,i)=>({origin:['native','continuation'][i],manifestDigest:m.manifestDigest,textEvidence:m.textEvidence,images:m.images,binaryAssets:null}));
  const reports=ids.map(taskId=>({taskId,coverageDigest:digest(coverage),coverage:structuredClone(coverage),
    sourceManifests:structuredClone(sourceManifests),readableImages:[],oldReceipts:structuredClone(receipts),capacityPassed:true,
    selectedChanges:changes.filter(c=>c.path===shellPath||taskId==='T-004b').map(c=>({path:c.path,
      before:c.before?{...c.before,text:todayBefore}:null,after:{...c.after,text:c.path===shellPath?shell:todayAfter}}))}));
  const manifests=materials.map((m,i)=>{
    const file=path.join(root,'manifest-'+i+'.json'),bytes=Buffer.from(JSON.stringify(m));fs.writeFileSync(file,bytes);
    return {path:file,sha256:sha(bytes)};
  });
  const ownership={paths:{[shellPath]:[...ids],[todayPath]:['T-004b']},
    tests:tests.map(r=>({id:key(r),owners:r.owners})),
    findings:findings.map(r=>({id:findingKey(r),owners:r.owners,disposition:'open'})),
    sources:sources.map(r=>({id:r.origin+':'+r.fileId,owners:r.owners}))};
  const plan={manifests,ownership,children:ids.map(taskId=>({taskId,
    paths:Object.keys(ownership.paths).filter(p=>ownership.paths[p].includes(taskId)),
    tests:ownership.tests.filter(r=>r.owners.includes(taskId)).map(r=>r.id),
    findings:ownership.findings.filter(r=>r.owners.includes(taskId)).map(r=>r.id)}))};
  const sync=mutate=>{const copy=structuredClone(reports[0].coverage);mutate(copy);
    reports.forEach(r=>{r.coverage=structuredClone(copy);r.coverageDigest=digest(copy);});};
  return {plan,pkg,last:{receipts},reports,sync,root};
}
const run=f=>assertSplitCoverage(f.plan,f.pkg,f.last,f.reports);
const rejected=(f,code)=>assert.throws(()=>run(f),error=>error.code===code,
  `Expected ${code}`);

test('coverage authority: all 22 new test groups, existing changed block, 50 origin-qualified sources and original findings are accepted',t=>{
  const f=fixture(t);assert.equal(f.plan.ownership.tests.length,23);assert.equal(f.plan.ownership.sources.length,50);
  assert.doesNotThrow(()=>run(f));
});

test('coverage authority: omitting one new test or changed existing block is refused despite matching self-described maps',t=>{
  for(const index of [7,22]){
    const f=fixture(t),removed=f.reports[0].coverage.tests[index];
    f.sync(c=>{c.tests.splice(index,1);});
    f.plan.ownership.tests=f.plan.ownership.tests.filter(r=>r.id!==key(removed));
    for(const child of f.plan.children)child.tests=child.tests.filter(id=>id!==key(removed));
    rejected(f,index===22?'split_test_owners':'split_test_coverage');
  }
});

test('coverage authority: omitting one source or finding is refused even if plan ownership agrees',t=>{
  const source=fixture(t);source.sync(c=>{c.materials.pop();});source.plan.ownership.sources.pop();
  rejected(source,'split_source_coverage');
  const finding=fixture(t);finding.sync(c=>{c.findings.pop();});finding.plan.ownership.findings.pop();
  finding.plan.children[1].findings=[];rejected(finding,'split_finding_coverage');
});

test('coverage authority: mismatched plan manifest or any child manifest and old receipt are refused',t=>{
  const planManifest=fixture(t),ref=planManifest.plan.manifests[0];
  const data=JSON.parse(fs.readFileSync(ref.path));data.manifestDigest=sha('different');
  const bytes=Buffer.from(JSON.stringify(data));fs.writeFileSync(ref.path,bytes);ref.sha256=sha(bytes);
  rejected(planManifest,'split_manifest_source');
  const childManifest=fixture(t);childManifest.reports[2].sourceManifests[0].manifestDigest=sha('drift');
  rejected(childManifest,'split_manifest_source');
  const receipt=fixture(t);receipt.reports[1].oldReceipts[0].result.findings[0].message='silently closed';
  rejected(receipt,'split_receipt_coverage');
});

test('coverage authority: duplicate finding cannot replace another, and closed or misowned findings are refused',t=>{
  const duplicate=fixture(t);duplicate.sync(c=>{c.findings[1]=structuredClone(c.findings[0]);});
  rejected(duplicate,'split_finding_coverage');
  const closed=fixture(t);closed.plan.ownership.findings[0].disposition='closed';
  rejected(closed,'split_findings_ownership');
  const owner=fixture(t);owner.plan.children[2].findings.push(owner.plan.ownership.findings[0].id);
  rejected(owner,'split_child_coverage');
});

test('coverage authority: group truncation and dropped test bytes fail closed',t=>{
  const short=fixture(t);short.sync(c=>{c.tests[0].end--;});
  const oldId=short.plan.ownership.tests[0].id,newId=key(short.reports[0].coverage.tests[0]);
  short.plan.ownership.tests[0].id=newId;
  for(const child of short.plan.children)child.tests=child.tests.map(id=>id===oldId?newId:id);
  rejected(short,'split_test_coverage');
  const omittedBytes=fixture(t);omittedBytes.reports[0].selectedChanges[0].after.text+='\n';
  rejected(omittedBytes,'split_source_bytes_missing');
});

test('coverage authority: existing changed test must identify its actual declaration and complete block',t=>{
  for(const edit of [row=>{row.start=2;},row=>{row.end=2;}]){
    const f=fixture(t),index=22,oldId=key(f.reports[0].coverage.tests[index]);
    f.sync(c=>edit(c.tests[index]));const newId=key(f.reports[0].coverage.tests[index]);
    f.plan.ownership.tests[index].id=newId;
    for(const child of f.plan.children)child.tests=child.tests.map(id=>id===oldId?newId:id);
    assert.throws(()=>run(f),error=>typeof error.code==='string'&&error.code.startsWith('split_test_'));
  }
});
