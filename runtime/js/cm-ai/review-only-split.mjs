// Append-only provenance preparation. Deliberately has no provider or runner adapter.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {verifySplitMaterial} from './review-split-material.mjs';
import {need,digest,shape,id,hex} from './effect-contract.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {openExecutionStore,appendFits} from './execution-store.mjs';
import {oldWriterOpen} from './reviewed-evidence-supersede.mjs';
import {assertSavedSplitProposal} from './review-split-proposal.mjs';
import {assertSceneSourceCoverage} from './review-split-scene.mjs';

const HASH=bytes=>createHash('sha256').update(bytes).digest('hex');
const TYPES=new Set(['review-only-split-intent','review-only-split-committed','review-only-child']);
const roles=['run','policy','review','protected','workflow','source-manifest','source-runner','source-store','source-contract','source-material','source-proposal'];
const unique=items=>Array.isArray(items)&&new Set(items).size===items.length;
const fail=code=>need(false,code);
function file(ref){
  shape(ref,['path','sha256']);hex(ref.sha256);need(path.isAbsolute(ref.path),'split_path');
  need(fs.realpathSync(ref.path)===ref.path,'split_path');
  const s=fs.lstatSync(ref.path);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=16*1024*1024,'split_file');
  const fd=fs.openSync(ref.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const bytes=fs.readFileSync(fd),a=fs.fstatSync(fd),b=fs.lstatSync(ref.path);
    need([a,b].every(v=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>v[k]===s[k])),'split_artifact_drift');
    need(HASH(bytes)===ref.sha256,'split_artifact_drift');return bytes;
  }finally{fs.closeSync(fd);}
}
const read=ref=>JSON.parse(file(ref).toString('utf8'));
function prefix(snapshot,n){
  const data={version:snapshot.version,identity:snapshot.identity,fingerprints:snapshot.fingerprints,records:snapshot.records.slice(0,n)};
  return {...data,revision:digest(data)};
}
function childPayload(plan,child){return {type:'review-only-child',version:1,splitDigest:digest(plan),parent:plan.parent,
  feature:plan.feature,taskId:child.taskId,child,originalPackage:plan.originalPackage,
  ownershipDigest:digest(plan.ownership),manifests:plan.manifests,proposal:plan.proposal,
  callAllocation:null,dispatch:'unsupported_requires_separate_authorization_and_adapter'};}
function parentPayload(plan,type){return {type,version:1,splitDigest:digest(plan),parent:plan.parent,
  feature:plan.feature,children:plan.children.map(c=>({runId:c.runId,taskId:c.taskId})),plan};}
const recordId=(plan,suffix)=>`split-${digest(plan).slice(0,40)}-${suffix}`;
function stages(plan,snapshot){
  need(snapshot.records.length>=plan.parent.prefixCount,'split_parent_prefix');
  need(prefix(snapshot,plan.parent.prefixCount).revision===plan.parent.revision,'split_parent_revision');
  need(digest(snapshot.fingerprints)===digest(plan.parent.fingerprints),'split_parent_fingerprints');
  const tail=snapshot.records.slice(plan.parent.prefixCount),intent=parentPayload(plan,'review-only-split-intent'),commit=parentPayload(plan,'review-only-split-committed');
  need(tail.length<=2,'split_parent_tail');
  if(tail.length)need(tail[0].id===recordId(plan,'intent')&&tail[0].kind==='intent'&&digest(tail[0].payload)===digest(intent),'split_parent_tail');
  if(tail.length===2)need(tail[1].id===recordId(plan,'committed')&&tail[1].kind==='result'&&digest(tail[1].payload)===digest(commit),'split_parent_tail');
  return tail.length===2?'committed':tail.length===1?'intent':'prepared';
}
export function assertOrdinaryRun(snapshot){
  need(!snapshot.records.some(r=>TYPES.has(r.payload.type)),'review_only_split_no_ordinary_run');
}
// Selection/failover must not turn provenance stores into fresh developer runs.
export const reviewOnlyRunId=runId=>typeof runId==='string'&&runId.startsWith('cm-review-only-');
export function reviewOnlyTask({specsDir,feature,taskId}){
  const root=path.join(specsDir,'.reviews','.execution');if(!fs.existsSync(root))return false;
  for(const item of fs.readdirSync(root,{withFileTypes:true})){
    if(!item.isDirectory()||item.isSymbolicLink()){
      need(!reviewOnlyRunId(item.name),'split_child_store_invalid');continue;
    }
    const f=path.join(root,item.name,'state.json');if(!fs.existsSync(f))continue;
    const stat=fs.lstatSync(f);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16*1024*1024,'split_child_store_invalid');
    const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;
    try{
      const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(f);
      need([after,current].every(v=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>v[k]===stat[k])),'split_child_store_invalid');
      const text=bytes.toString('utf8');
      // Parent intent precedes every child store; inspect ordinary directories
      // too. The existing execution snapshot limit bounds both parent and child.
      if(![...TYPES].some(type=>text.includes(type)))continue;
      raw=JSON.parse(text);
    }finally{fs.closeSync(fd);}
    need(raw.identity?.runId===item.name,'split_child_store_invalid');
    const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:raw.identity});
    if(snapshot.records.some(r=>TYPES.has(r.payload.type)&&r.payload.feature===feature
      &&(r.payload.taskId===taskId||r.payload.parent?.taskId===taskId||r.payload.plan?.parent.taskId===taskId
        ||r.payload.children?.some(c=>c.taskId===taskId))))return true;
  }
  return false;
}
function decoded(record){
  if(record===null)return null;
  need(Number.isSafeInteger(record.size)&&record.size>=0&&record.size<=16*1024*1024,'split_original_bytes');
  need((typeof record.contentBase64==='string')!==(typeof record.contentGzipBase64==='string'),'split_original_bytes_missing');
  const b=typeof record.contentBase64==='string'?Buffer.from(record.contentBase64,'base64')
    :gunzipSync(Buffer.from(record.contentGzipBase64,'base64'),{maxOutputLength:record.size+1});
  need(b.length===record.size&&HASH(b)===record.sha256,'split_original_bytes');return b;
}
const testKey=row=>`${row.path}:${row.start}-${row.end}`;
const findingKey=row=>`${row.receiptId}:${row.finding.id}`;
function exactRows(actual,expected,key,code){
  need(Array.isArray(actual)&&unique(actual.map(key))&&actual.length===expected.length,code);
  const all=new Map(expected.map(row=>[key(row),row]));
  for(const row of actual)need(all.has(key(row))&&digest(row)===digest(all.get(key(row))),code);
}
function jsonDelta(before,after,pointer='',changed=[],unchanged=[]){
  if(digest(before)===digest(after))unchanged.push({pointer,sha256:digest(before)});
  else if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
    for(const key of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
      const p=pointer+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1');
      if(!Object.hasOwn(before,key))changed.push({pointer:p,operation:'add',after:after[key]});
      else if(!Object.hasOwn(after,key))changed.push({pointer:p,operation:'remove',before:before[key]});
      else jsonDelta(before[key],after[key],p,changed,unchanged);
    }
  }else changed.push({pointer,operation:'replace',before,after});
  return {changed,unchanged};
}
function assertSelectedChange(selected,original){
  need(selected?.path===original.path,'split_source_bytes_missing');
  const metadata=(actual,source)=>need(actual&&source&&['sha256','size','mode'].every(k=>actual[k]===source[k]),'split_source_bytes_missing');
  if(selected.kind==='verified-json-delta'){
    need(original.path.endsWith('/package-lock.json')&&original.before?.type==='file'&&original.after?.type==='file','split_source_delta');
    metadata(selected.before,original.before);metadata(selected.after,original.after);
    const before=JSON.parse(decoded(original.before)),after=JSON.parse(decoded(original.after));
    need(digest({changed:selected.changed,unchanged:selected.unchanged})===digest(jsonDelta(before,after)),'split_source_delta');
    let rebuilt=structuredClone(before);
    for(const op of selected.changed){
      if(op.pointer===''){rebuilt=structuredClone(op.after);continue;}
      const keys=op.pointer.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));
      let parent=rebuilt;for(const key of keys.slice(0,-1)){need(Object.hasOwn(parent,key),'split_source_delta');parent=parent[key];}
      const key=keys.at(-1);
      if(op.operation==='remove')delete parent[key];
      else Object.defineProperty(parent,key,{value:structuredClone(op.after),enumerable:true,configurable:true,writable:true});
    }
    need(digest(rebuilt)===digest(after),'split_source_delta');return;
  }
  for(const side of ['before','after']){
    const source=original[side],actual=selected[side];
    if(source===null){need(actual===null,'split_source_bytes_missing');continue;}
    metadata(actual,source);
    need(actual.type===source.type&&typeof actual.text==='string'&&Buffer.from(actual.text,'utf8').equals(decoded(source)),'split_source_bytes_missing');
  }
}
export function assertSplitCoverage(plan,pkg,last,materials){
  const common=materials[0],coverage=common.coverage;
  if(Object.hasOwn(plan,'sceneCoverage')){
    shape(plan.sceneCoverage,['version','coverageDigest']);
    need(plan.sceneCoverage.version===1,'split_scene_version');hex(plan.sceneCoverage.coverageDigest);
    for(const m of materials){
      need(m.sceneCoverage?.coverageDigest===plan.sceneCoverage.coverageDigest,'split_scene_plan');
      assertSceneSourceCoverage(m,pkg,last);
    }
  }else need(materials.every(m=>!m.sceneCoverage),'split_scene_plan_required');
  need(coverage&&materials.every(m=>m.coverageDigest===common.coverageDigest&&digest(m.coverage)===digest(coverage)),'split_material_coverage');
  const originals=[['native',pkg.checks.find(c=>c.id==='native-evidence')?.material],
    ['continuation',pkg.evidenceContinuation?.newEvidence?.material]];
  need(originals.every(([,m])=>m?.textEvidence?.files&&m.images),'split_two_manifests');
  for(const [index,[origin,manifest]] of originals.entries()){
    need(digest(read(plan.manifests[index]))===digest(manifest),'split_manifest_source');
    const represented=common.sourceManifests.find(m=>m.origin===origin);
    need(represented?.manifestDigest===manifest.manifestDigest&&digest(represented.textEvidence)===digest(manifest.textEvidence)
      &&digest(represented.images)===digest(manifest.images)&&digest(represented.binaryAssets??null)===digest(manifest.binaryAssets??null),'split_manifest_source');
  }
  for(const material of materials)need(digest(material.sourceManifests)===digest(common.sourceManifests),'split_manifest_source');
  need(common.sourceManifests.length===2&&unique(common.sourceManifests.map(m=>m.origin)),'split_manifest_source');
  const images=originals.flatMap(([origin,m])=>m.images.map(image=>({origin,...image})));
  const imageKey=image=>image.origin+':'+image.path;
  need(Array.isArray(coverage.images)&&coverage.images.length===images.length&&unique(coverage.images.map(imageKey)),'split_image_coverage');
  for(const image of images){
    const row=coverage.images.find(r=>imageKey(r)===imageKey(image));
    need(row&&unique(row.owners)&&row.owners.length>0&&row.representation==='complete-original-bytes'
      &&row.sha256===image.sha256&&row.size===image.size,'split_image_coverage');
    for(const owner of row.owners){
      const material=materials.find(m=>m.taskId===owner),readable=material?.readableImages?.filter(r=>imageKey(r)===imageKey(image));
      need(readable?.length===1&&readable[0].sha256===image.sha256&&readable[0].size===image.size,'split_image_bytes_missing');
    }
  }
  for(const material of materials){
    const expected=coverage.images.filter(r=>r.owners.includes(material.taskId)).map(imageKey).sort();
    need(digest((material.readableImages??[]).map(imageKey).sort())===digest(expected),'split_image_coverage');
  }
  const sourceRows=originals.flatMap(([origin,m])=>m.textEvidence.files.map(f=>({origin,fileId:f.id,sha256:f.sha256,size:f.size,
    requirements:m.textEvidence.requirements.filter(r=>r.fileId===f.id)})));
  need(coverage.materials.length===sourceRows.length&&unique(coverage.materials.map(r=>r.origin+':'+r.fileId)),'split_source_coverage');
  for(const row of sourceRows){
    const found=coverage.materials.find(r=>r.origin===row.origin&&r.fileId===row.fileId);
    need(found&&['sha256','size','requirements'].every(k=>digest(found[k])===digest(row[k])),'split_source_coverage');
  }
  const receipts=last.receipts;need(Array.isArray(receipts),'split_receipts_missing');
  for(const m of materials)exactRows(m.oldReceipts,receipts,r=>r.id,'split_receipt_coverage');
  const findings=receipts.flatMap(r=>(r.result.findings??[]).map(f=>({receiptId:r.id,receiptDigest:r.receiptDigest,finding:f})));
  need(unique(findings.map(findingKey))&&coverage.findings.length===findings.length,'split_finding_coverage');
  need(unique(coverage.findings.map(findingKey)),'split_finding_coverage');
  for(const row of coverage.findings){
    const old=findings.find(f=>findingKey(f)===findingKey(row));
    need(old&&['receiptId','receiptDigest','finding'].every(k=>digest(old[k])===digest(row[k])),'split_finding_coverage');
  }
  need(unique(coverage.changes.map(c=>c.path+':'+c.owner))
    &&new Set(coverage.changes.map(c=>c.path)).size===pkg.changes.length
    &&coverage.changes.every(r=>pkg.changes.some(c=>c.path===r.path)),'split_path_coverage');
  const expectedPaths={};
  for(const c of pkg.changes){
    const rows=coverage.changes.filter(r=>r.path===c.path);
    need(rows.length&&rows.every(row=>row.beforeSha256===(c.before?.sha256??null)&&row.afterSha256===(c.after?.sha256??null)),'split_path_coverage');
    const owners=rows.map(r=>r.owner);
    expectedPaths[c.path]=owners.sort();
    need(digest([...(plan.ownership.paths[c.path]??[])].sort())===digest(owners),'split_path_ownership');
    for(const owner of owners){
      const material=materials.find(m=>m.taskId===owner),selected=material?.selectedChanges?.filter(r=>r.path===c.path);
      need(selected?.length===1,'split_source_bytes_missing');assertSelectedChange(selected[0],c);
    }
    if(!c.path.endsWith('.spec.tsx'))continue;
    const groups=coverage.tests.filter(r=>r.path===c.path),after=decoded(c.after).toString('utf8').split(/\r?\n/);
    need(digest([...new Set(groups.flatMap(r=>r.owners))].sort())===digest([...owners].sort()),'split_test_owners');
    need(groups.length>0&&groups.every(r=>Number.isInteger(r.start)&&Number.isInteger(r.end)&&r.start>0&&r.end>=r.start&&r.end<=after.length),'split_test_coverage');
    if(c.before===null){
      const starts=after.flatMap((line,i)=>/^\s*it(?:\.each)?\(/.test(line)?[i+1]:[]);
      let end=after.length;while(end>0&&!after[end-1].trim())end--;
      need(starts.length===groups.length&&starts.every((start,i)=>groups.some(r=>r.start===start
        &&r.end===(starts[i+1]?starts[i+1]-1:end))),'split_test_coverage');
    }else{
      const before=decoded(c.before).toString('utf8').split(/\r?\n/);let a=0,b=0;
      while(a<before.length&&a<after.length&&before[a]===after[a])a++;
      while(b<before.length-a&&b<after.length-a&&before.at(-1-b)===after.at(-1-b))b++;
      const starts=after.flatMap((line,i)=>/^\s*it(?:\.each)?\(/.test(line)?[i+1]:[]);
      let end=after.length;while(end>0&&!after[end-1].trim())end--;
      const group=groups[0],index=starts.indexOf(group?.start);
      need(groups.length===1&&index>=0&&group.end===(starts[index+1]?starts[index+1]-1:end)
        &&group.start<=a+1&&group.end>=after.length-b,'split_test_hunk_coverage');
    }
    for(const owner of expectedPaths[c.path]){
      const material=materials.find(m=>m.taskId===owner),included=material?.selectedChanges?.find(r=>r.path===c.path);
      need(included&&included.after?.text===decoded(c.after).toString('utf8')
        &&(c.before===null?included.before===null:included.before?.text===decoded(c.before).toString('utf8')),'split_test_bytes_missing');
    }
  }
  for(const material of materials){
    const expected=plan.children.find(c=>c.taskId===material.taskId)?.paths;
    need(Array.isArray(expected)&&unique(material.selectedChanges.map(c=>c.path))
      &&digest(material.selectedChanges.map(c=>c.path).sort())===digest([...expected].sort()),'split_source_scope');
  }
  need(coverage.tests.every(r=>pkg.changes.some(c=>c.path===r.path&&c.path.endsWith('.spec.tsx'))),'split_test_coverage');
  const sets={tests:coverage.tests.map(r=>({id:testKey(r),owners:r.owners})),
    findings:coverage.findings.map(r=>({id:findingKey(r),owners:r.owners,disposition:'open'})),
    sources:coverage.materials.map(r=>({id:r.origin+':'+r.fileId,owners:r.owners}))};
  for(const name of Object.keys(sets))exactRows(plan.ownership[name],sets[name],r=>r.id,'split_'+name+'_ownership');
  for(const child of plan.children)for(const name of ['tests','findings'])
    need(digest([...child[name]].sort())===digest(sets[name].filter(r=>r.owners.includes(child.taskId)).map(r=>r.id).sort()),'split_child_coverage');
  for(const m of materials)need(m.capacityPassed,'split_material_capacity');
}

function validate(plan,snapshot){
  shape(plan,['version','kind','specsDir','codeProject','feature','parent','originalPackage','bindings','proposal','manifests','ownership','children',
    ...(Object.hasOwn(plan,'sceneCoverage')?['sceneCoverage']:[])]);
  need(plan.version===1&&plan.kind==='cm-review-only-split','split_version');
  if(Object.hasOwn(plan,'sceneCoverage')){
    shape(plan.sceneCoverage,['version','coverageDigest']);need(plan.sceneCoverage.version===1,'split_scene_version');hex(plan.sceneCoverage.coverageDigest);
  }
  need(fs.realpathSync(plan.specsDir)===plan.specsDir&&fs.realpathSync(plan.codeProject)===plan.codeProject,'split_path');
  shape(plan.parent,['repositoryId','runId','taskId','attempt','prefixCount','revision','fingerprints','callCount','callLedgerDigest']);
  for(const key of ['repositoryId','runId','taskId'])id(plan.parent[key]);hex(plan.parent.revision);
  need(Number.isInteger(plan.parent.attempt)&&plan.parent.attempt>0&&Number.isInteger(plan.parent.prefixCount)&&plan.parent.prefixCount>0,'split_identity');
  stages(plan,snapshot);
  const initial=snapshot.records[0].payload,identity=initial.config?.identity;
  need(initial.type==='init'&&identity&&['repositoryId','runId','taskId'].every(k=>identity[k]===plan.parent[k]),'split_identity');
  const history=snapshot.records.slice(0,plan.parent.prefixCount),last=history.filter(r=>r.payload.type==='effect-checkpoint').at(-1)?.payload.checkpoint;
  need(last&&['blocked','unknown','awaiting_review','changes_requested'].includes(last.state)
    &&last.attempt===plan.parent.attempt&&last.sequence===plan.parent.callCount
    &&Array.isArray(last.calls)&&last.calls.length===plan.parent.callCount
    &&digest(last.calls)===plan.parent.callLedgerDigest,'split_call_ledger');
  need(Array.isArray(plan.bindings)&&unique(plan.bindings.map(b=>b.role))&&roles.every(role=>plan.bindings.some(b=>b.role===role)),'split_frozen_inputs');
  for(const b of plan.bindings){shape(b,['role','file']);file(b.file);}
  const sourceRoot=fileURLToPath(new URL('../../../',import.meta.url));
  for(const [role,relative] of [['source-manifest','package.json'],['source-runner','scripts/cm-ai-run.mjs'],['source-store','runtime/js/cm-ai/execution-store.mjs'],['source-contract','runtime/js/cm-ai/review-only-split.mjs'],['source-material','runtime/js/cm-ai/review-split-material.mjs'],['source-proposal','runtime/js/cm-ai/review-split-proposal.mjs']])
    need(plan.bindings.find(b=>b.role===role).file.path===path.join(sourceRoot,relative),'split_source_mismatch');
  if(plan.sceneCoverage)need(plan.bindings.find(b=>b.role==='source-scene')?.file.path
    ===path.join(sourceRoot,'runtime/js/cm-ai/review-split-scene.mjs'),'split_source_mismatch');
  const frozenRun=read(plan.bindings.find(b=>b.role==='run').file);
  need(frozenRun.identity&&['repositoryId','runId','taskId'].every(k=>frozenRun.identity[k]===plan.parent[k]),'split_frozen_identity');
  const pkg=read(plan.originalPackage);
  const {packageDigest,...packageBody}=pkg;
  need(digest(packageBody)===packageDigest&&digest(pkg.changes)===pkg.artifactDigest,'split_original_package_digest');
  need(pkg.packageDigest&&history.some(r=>JSON.stringify(r.payload).includes(pkg.packageDigest)),'split_original_package_unbound');
  need(['repositoryId','runId','taskId','attempt'].every(k=>pkg.identity?.[k]===plan.parent[k])&&Array.isArray(pkg.changes)&&pkg.changes.length>0,'split_original_package');
  const originalPaths=pkg.changes.map(c=>c.path);need(unique(originalPaths),'split_original_package');
  for(const change of pkg.changes){
    need(typeof change.path==='string'&&!path.isAbsolute(change.path)&&!change.path.split('/').includes('..'),'split_path');
    for(const side of [change.before,change.after])if(side?.type==='file'){
      need(Number.isSafeInteger(side.size)&&side.size>=0&&side.size<=16*1024*1024,'split_original_bytes');
      need((typeof side.contentBase64==='string')!==(typeof side.contentGzipBase64==='string'),'split_original_bytes_missing');
      const bytes=typeof side.contentBase64==='string'?Buffer.from(side.contentBase64,'base64')
        :gunzipSync(Buffer.from(side.contentGzipBase64,'base64'),{maxOutputLength:side.size+1});
      need(bytes.length===side.size&&HASH(bytes)===side.sha256,'split_original_bytes');
    }
    const final=path.join(plan.codeProject,change.path);
    if(change.after===null||change.after?.type==='missing')need(!fs.existsSync(final),'split_final_drift');
    else{need(change.after?.type==='file','split_file_type');file({path:final,sha256:change.after.sha256});need((fs.statSync(final).mode&0o777)===change.after.mode,'split_final_drift');}
  }
  shape(plan.proposal,['sessionId','file','proposalDigest']);
  const prd=read(plan.proposal.file),change=prd.checkpoint?.change;
  need(plan.proposal.file.path===path.join(plan.specsDir,'.reviews','prd-sessions',plan.proposal.sessionId,'state.json')
    &&prd.active===null&&prd.identity?.entry?.specs===plan.specsDir&&prd.identity?.entry?.project===plan.codeProject
    &&prd.identity?.entry?.change===plan.feature
    &&change?.proposal?.proposalDigest===plan.proposal.proposalDigest,'split_proposal_identity');
  const prdWriter=path.join(path.dirname(plan.proposal.file.path),'writer.json');
  if(fs.existsSync(prdWriter)){
    const writer=JSON.parse(fs.readFileSync(prdWriter,'utf8'));need(Number.isSafeInteger(writer.pid)&&writer.pid>0,'split_prd_writer_unknown');
    try{process.kill(writer.pid,0);fail('split_prd_writer_active');}catch(error){if(error.code!=='ESRCH')throw error;}
  }
  assertSavedSplitProposal(plan);
  need(plan.manifests.length===2&&unique(plan.manifests.map(m=>m.path)),'split_two_manifests');
  for(const manifest of plan.manifests)file(manifest);
  shape(plan.ownership,['paths','tests','findings','sources']);
  need(unique(plan.children.map(c=>c.taskId))&&unique(plan.children.map(c=>c.runId))&&plan.children.length===3,'split_children');
  const ids=plan.children.map(c=>c.taskId);need(ids.every((v,i)=>v===`${plan.parent.taskId}${'abc'[i]}`),'split_child_task');
  need(Object.keys(plan.ownership.paths).sort().join('\n')===originalPaths.sort().join('\n'),'split_path_coverage');
  const materials=[];
  for(const c of plan.children){
    shape(c,['taskId','runId','paths','tests','findings','material']);id(c.runId);
    need(reviewOnlyRunId(c.runId)&&c.runId!==plan.parent.runId&&unique(c.paths)&&unique(c.tests)&&unique(c.findings)&&c.paths.length>0,'split_child_identity');
    for(const p of c.paths)need(plan.ownership.paths[p]?.includes(c.taskId),'split_path_ownership');
    const material=verifySplitMaterial(c.material.path,{expectedSha256:c.material.sha256});
    need(material.integrityVerified&&material.taskId===c.taskId
      &&material.originalPackageDigest===pkg.packageDigest,'split_material_identity');
    materials.push(material);
    need(digest(material.source.identity)===digest(pkg.identity)&&material.source.originalRevision===plan.parent.revision
      &&material.source.originalRecords===plan.parent.prefixCount&&material.source.originalCalls===plan.parent.callCount
      &&material.source.originalPackageFileSha256===plan.originalPackage.sha256
      &&material.source.originalStateSha256===HASH(Buffer.from(JSON.stringify(prefix(snapshot,plan.parent.prefixCount))+'\n')),'split_material_parent_binding');

  }
  for(const [p,owners] of Object.entries(plan.ownership.paths))need(unique(owners)&&owners.length>0&&owners.every(owner=>ids.includes(owner)
    &&plan.children.find(c=>c.taskId===owner).paths.includes(p)),'split_path_ownership');
  for(const name of ['tests','findings','sources']){
    need(Array.isArray(plan.ownership[name])&&unique(plan.ownership[name].map(r=>r.id)),'split_ownership');
    for(const row of plan.ownership[name]){
      need(typeof row.id==='string'&&row.id&&unique(row.owners)&&row.owners.length>0&&row.owners.every(v=>ids.includes(v)),'split_ownership');
      if(name!=='sources')for(const owner of row.owners)need(plan.children.find(c=>c.taskId===owner)[name].includes(row.id),'split_ownership');
      if(name==='findings')need(row.disposition==='open','split_finding_closed');
    }
  }
  need(plan.ownership.tests.length>0&&plan.ownership.sources.length>0,'split_coverage_missing');
  assertSplitCoverage(plan,pkg,last,materials);
  return pkg;
}
function snapshotFor(plan){return readExecutionSnapshot({specsRoot:plan.specsDir,identity:{repositoryId:plan.parent.repositoryId,runId:plan.parent.runId}});}
function childIdentity(plan,c){return {repositoryId:plan.parent.repositoryId,runId:c.runId};}
function childPrint(plan,c){return {workflow:digest('cm-review-only-split-v1'),config:digest(plan),inputs:digest(c)};}
function inspectChildren(plan){
  return plan.children.map(c=>{
    const directory=path.join(plan.specsDir,'.reviews','.execution',c.runId);
    if(!fs.existsSync(directory))return {taskId:c.taskId,runId:c.runId,stage:'absent'};
    // A crash may have initialized an empty child; only the matching fingerprint can resume it.
    const child=readExecutionSnapshot({specsRoot:plan.specsDir,identity:childIdentity(plan,c)});
    need(digest(child.fingerprints)===digest(childPrint(plan,c))&&child.records.length<=1,'split_child_conflict');
    if(child.records.length)need(child.records[0].id===recordId(plan,c.taskId)&&digest(child.records[0].payload)===digest(childPayload(plan,c)),'split_child_conflict');
    return {taskId:c.taskId,runId:c.runId,stage:child.records.length?'bound':'initialized'};
  });
}
export function inspectReviewOnlySplit(plan){
  const snapshot=snapshotFor(plan),stage=stages(plan,snapshot),children=inspectChildren(plan);
  need(stage!=='prepared'||children.every(c=>c.stage==='absent'),'split_child_without_intent');
  need(stage!=='committed'||children.every(c=>c.stage==='bound'),'split_incomplete_committed');
  return {kind:'cm-review-only-split-status',splitDigest:digest(plan),stage,children,
    parentPrefixCount:plan.parent.prefixCount,parentRecords:snapshot.records.length,
    callCount:plan.parent.callCount,newReviewCalls:0,newDevelopmentCalls:0,dispatchSupported:false};
}
export function prepareReviewOnlySplit(plan){
  const blockers=[];
  // Collect independent missing/drifted inputs before the deeper structural validation.
  const refs=[plan.originalPackage,plan.proposal?.file,...(plan.bindings??[]).map(b=>b.file),...(plan.manifests??[])].filter(Boolean);
  for(const ref of refs)try{file(ref);}catch(e){blockers.push({code:e.code??'split_input_invalid',path:ref.path});}
  // Derived requests include original image base64. Use their existing reader
  // and capacity contract; source/config readers do not define material limits.
  for(const child of plan.children??[])try{
    const material=verifySplitMaterial(child.material.path,{expectedSha256:child.material.sha256});
    if(!material.capacityPassed)blockers.push({code:'split_material_capacity',path:child.material.path});
  }catch(e){blockers.push({code:e.code??'split_material_invalid',path:child.material?.path});}
  let status=null;
  try{const snapshot=snapshotFor(plan);validate(plan,snapshot);status=inspectReviewOnlySplit(plan);
    if(oldWriterOpen(path.join(plan.specsDir,'.reviews','.execution'),plan.parent.runId))blockers.push({code:'split_writer_active'});
  }catch(e){blockers.push({code:e.code??'split_invalid'});}
  return {kind:'cm-review-only-split-preflight',accepted:blockers.length===0,splitDigest:digest(plan),blockers,status,
    newReviewCalls:0,newDevelopmentCalls:0,dispatchSupported:false};
}
export function registerReviewOnlySplit(plan){
  const prepared=prepareReviewOnlySplit(plan);need(prepared.accepted,'split_preflight_failed');
  const stores=[];
  try{
    const parent=openExecutionStore({specsRoot:plan.specsDir,identity:{repositoryId:plan.parent.repositoryId,runId:plan.parent.runId},fingerprints:plan.parent.fingerprints,create:false});stores.push(parent);
    validate(plan,parent.snapshot());
    const existing=inspectReviewOnlySplit(plan);
    // Hold every existing child writer before any append, and create missing stores
    // only after the durable parent intent. A pending intent is never runnable.
    const children=new Map();
    for(const c of plan.children)if(existing.children.find(row=>row.runId===c.runId).stage!=='absent'){
      const store=openExecutionStore({specsRoot:plan.specsDir,identity:childIdentity(plan,c),fingerprints:childPrint(plan,c),create:false});stores.push(store);children.set(c.runId,store);
    }
    const append=(store,record)=>{const current=store.snapshot();
      if(!current.records.some(row=>row.id===record.id))need(appendFits(current,{...record,expectedRevision:current.revision}),'split_store_capacity');
      store.append({...record,expectedRevision:current.revision});};
    // Check the complete parent suffix before starting; retained state is bounded.
    let projected=parent.snapshot();
    for(const [suffix,kind,type] of [['intent','intent','review-only-split-intent'],['committed','result','review-only-split-committed']]){
      const record={id:recordId(plan,suffix),kind,payload:parentPayload(plan,type)};
      if(!projected.records.some(r=>r.id===record.id)){
        need(appendFits(projected,{...record,expectedRevision:projected.revision}),'split_store_capacity');
        const body={version:1,seq:projected.records.length+1,...record,previousDigest:projected.records.at(-1)?.digest??null};
        const {revision,...data}=projected;data.records=[...projected.records,{...body,digest:digest(body)}];projected={...data,revision:digest(data)};
      }
    }
    append(parent,{id:recordId(plan,'intent'),kind:'intent',payload:parentPayload(plan,'review-only-split-intent')});
    for(const c of plan.children){
      let child=children.get(c.runId);
      if(!child){child=openExecutionStore({specsRoot:plan.specsDir,identity:childIdentity(plan,c),fingerprints:childPrint(plan,c),create:true});stores.push(child);}
      append(child,{id:recordId(plan,c.taskId),kind:'result',payload:childPayload(plan,c)});
    }
    // Revalidate mutable artifacts while the parent writer still belongs to us.
    validate(plan,parent.snapshot());
    append(parent,{id:recordId(plan,'committed'),kind:'result',payload:parentPayload(plan,'review-only-split-committed')});
    return inspectReviewOnlySplit(plan);
  }finally{for(const store of stores.reverse())store.close();}
}
