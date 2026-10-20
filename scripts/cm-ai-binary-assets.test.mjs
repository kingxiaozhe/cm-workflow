import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {readBinaryAssetConfiguration,readBinaryAssetBinding,binaryAssetStoreRoot,captureBinaryAsset,readBinaryAssetBytes,importBinaryAsset,BINARY_ASSET_LIMITS} from '../runtime/js/cm-ai/binary-assets.mjs';
import {captureReviewBaseline,createReviewPackage,readReviewBaseline,readReviewPackage,verifyReviewPackage,verifyCompletionReviewPackage,projectedReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';
import {attemptBaseline} from '../runtime/js/cm-ai/durable-runner-state.mjs';
const identity={repositoryId:'fixture',runId:'binary',taskId:'T-001',attempt:1};
const checks=[{id:'fixture',command:['node','fixture.mjs'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const hash=data=>createHash('sha256').update(data).digest('hex');
function fixture(fn){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-binary-assets-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),sourceRoot=path.join(root,'answers');
  for(const p of [codeProject,specsDir,sourceRoot])fs.mkdirSync(p);
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'requirements');
  const raw={version:1,paths:['font.ttf'],sourceRoot};
  const config=readBinaryAssetConfiguration(raw,{scope:['font.ttf'],codeProject,specsDir,identity});
  const {sourceRoot:ignored,...binding}=config;
  try{return fn({root,codeProject,specsDir,sourceRoot,raw,binding});}finally{fs.rmSync(root,{recursive:true,force:true});}}
const baseline=f=>captureReviewBaseline({root:f.codeProject,specsRoot:f.specsDir,identity,scope:['font.ttf'],requirements:['requirements.md'],binaryAssets:f.binding});

test('large binary bytes stay outside journal and preserve before/after package and completion binding',()=>fixture(f=>{
  const before=Buffer.alloc(3*1024*1024,0xff),after=Buffer.alloc(68*1024*1024,0x81);
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),before);const base=baseline(f);
  assert.equal(base.files.find(r=>r.path==='font.ttf').contentBlob,hash(before));
  assert(Buffer.byteLength(JSON.stringify(base))<65536);
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),after);const pkg=createReviewPackage({root:f.codeProject,baseline:base,checks});
  assert(pkg.changes[0].after.contentBlob);assert(Buffer.byteLength(JSON.stringify(pkg))<65536);
  assert.deepEqual(readBinaryAssetBytes({binding:f.binding,record:pkg.changes[0].before}),before);
  assert.deepEqual(readBinaryAssetBytes({binding:f.binding,record:pkg.changes[0].after}),after);
  assert.equal(readReviewBaseline(base).baselineDigest,base.baselineDigest);assert.equal(readReviewPackage(pkg).packageDigest,pkg.packageDigest);
  const input={root:f.codeProject,baseline:base,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest};
  assert.equal(verifyReviewPackage(input).outcome,'matched');assert.equal(verifyCompletionReviewPackage(input).outcome,'matched');
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.from('drift'));
  assert.throws(()=>verifyCompletionReviewPackage(input));
}));
test('explicit source import requires exact size/hash and deduplicates immutable records',()=>fixture(f=>{
  const data=Buffer.from([0,255,128,1]);fs.writeFileSync(path.join(f.sourceRoot,'font.ttf'),data);
  const args={binding:f.binding,sourceRoot:f.sourceRoot,sourcePath:'font.ttf',sha256:hash(data),size:data.length};
  assert.throws(()=>importBinaryAsset({...args,size:data.length+1}));assert.throws(()=>importBinaryAsset({...args,sha256:'0'.repeat(64)}));
  const row=importBinaryAsset(args);assert.deepEqual(row,importBinaryAsset(args));assert.equal(fs.readdirSync(f.binding.storeRoot).length,1);
  assert.equal(fs.statSync(path.join(f.binding.storeRoot,row.contentBlob)).mode&511,384);
}));
test('configuration rejects source roots inside code/specs, scope escapes, text and requirements paths',()=>fixture(f=>{
  const opts={scope:['font.ttf'],codeProject:f.codeProject,specsDir:f.specsDir,identity};
  assert.throws(()=>readBinaryAssetConfiguration({...f.raw,sourceRoot:f.codeProject},opts));
  assert.throws(()=>readBinaryAssetConfiguration({...f.raw,sourceRoot:f.specsDir},opts));
  assert.throws(()=>readBinaryAssetConfiguration({...f.raw,paths:['AGENTS.md']},opts));
  assert.throws(()=>readBinaryAssetConfiguration({...f.raw,paths:['../font.ttf']},opts));
  assert.throws(()=>readBinaryAssetConfiguration({...f.raw,paths:['other.ttf']},opts));
  assert.throws(()=>readBinaryAssetConfiguration(f.raw,{...opts,requirements:['font.ttf']}));
  assert.throws(()=>readBinaryAssetBinding({...f.binding,storeRoot:f.root}));
}));
test('symlinks and hardlinks in sources and blob store fail closed',()=>fixture(f=>{
  const data=Buffer.from([0,255]);fs.writeFileSync(path.join(f.sourceRoot,'font.ttf'),data);
  fs.symlinkSync(path.join(f.sourceRoot,'font.ttf'),path.join(f.codeProject,'font.ttf'));assert.throws(()=>baseline(f));fs.unlinkSync(path.join(f.codeProject,'font.ttf'));
  fs.linkSync(path.join(f.sourceRoot,'font.ttf'),path.join(f.codeProject,'font.ttf'));assert.throws(()=>baseline(f));fs.unlinkSync(path.join(f.codeProject,'font.ttf'));
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),data);const row=captureBinaryAsset({root:f.codeProject,path:'font.ttf',binding:f.binding});
  const target=path.join(f.binding.storeRoot,row.contentBlob);fs.linkSync(target,path.join(f.root,'linked'));
  assert.throws(()=>readBinaryAssetBytes({binding:f.binding,record:row}));
}));
test('missing or tampered sidecar refuses structural replay and completed verification',()=>fixture(f=>{
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.from([0,255]));const base=baseline(f);
  const record=base.files.find(r=>r.contentBlob);fs.writeFileSync(path.join(f.binding.storeRoot,record.contentBlob),'tampered');
  assert.throws(()=>readReviewBaseline(base));fs.unlinkSync(path.join(f.binding.storeRoot,record.contentBlob));assert.throws(()=>readReviewBaseline(base));
}));
test('projected binary package equals disk package and no binary declaration cannot select blob bodies',()=>fixture(f=>{
  const base=baseline(f),data=Buffer.from([128,0,255]);fs.writeFileSync(path.join(f.codeProject,'font.ttf'),data);
  const row=captureBinaryAsset({root:f.codeProject,path:'font.ttf',binding:f.binding});
  const projected=projectedReviewPackage({root:f.codeProject,baseline:base,checks,scopeFiles:[row]});
  assert.equal(projected.packageDigest,createReviewPackage({root:f.codeProject,baseline:base,checks}).packageDigest);
  const {binaryAssets,baselineDigest,...old}=base;const resealed={...old,baselineDigest:digest(old)};
  assert.throws(()=>projectedReviewPackage({root:f.codeProject,baseline:resealed,checks,scopeFiles:[row]}));
}));
test('unconfigured large files keep the existing inline material limit',()=>fixture(f=>{
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.alloc(2*1024*1024));
  assert.throws(()=>captureReviewBaseline({root:f.codeProject,specsRoot:f.specsDir,identity,scope:['font.ttf'],requirements:['requirements.md']}));
  assert.equal(BINARY_ASSET_LIMITS.file,128*1024*1024);assert.equal(binaryAssetStoreRoot({specsDir:f.specsDir,identity}),f.binding.storeRoot);
}));
test('binary file and configuration counts have separate hard limits',()=>fixture(f=>{
  const target=path.join(f.sourceRoot,'font.ttf'),fd=fs.openSync(target,'w');fs.ftruncateSync(fd,BINARY_ASSET_LIMITS.file+1);fs.closeSync(fd);
  assert.throws(()=>importBinaryAsset({binding:f.binding,sourceRoot:f.sourceRoot,sourcePath:'font.ttf',sha256:'0'.repeat(64),size:BINARY_ASSET_LIMITS.file+1}));
  assert(!fs.existsSync(f.binding.storeRoot));
  assert.throws(()=>readBinaryAssetBinding({...f.binding,paths:Array.from({length:33},(_,i)=>`font-${i}.ttf`)}));
  assert.throws(()=>readBinaryAssetBinding({...f.binding,paths:['font.ttf','FONT.TTF']}));
  assert.throws(()=>readBinaryAssetBinding(f.binding,{...identity,runId:'foreign'}));
}));
test('unowned permissions and noncanonical blob records cannot pass readback',()=>fixture(f=>{
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.from([0,255]));const row=captureBinaryAsset({root:f.codeProject,path:'font.ttf',binding:f.binding});
  assert.throws(()=>readBinaryAssetBytes({binding:f.binding,record:{...row,size:3}}));
  assert.throws(()=>readBinaryAssetBytes({binding:f.binding,record:{...row,contentBlob:'0'.repeat(64)}}));
  fs.chmodSync(f.binding.storeRoot,0o755);assert.throws(()=>readBinaryAssetBytes({binding:f.binding,record:row}));
}));
for(const phase of ['staged','linked','published'])test(`owner import recovers exact ${phase} publish prefix without readonly repair`,()=>fixture(f=>{
  const data=Buffer.from([255,0,128]),sha256=hash(data);fs.writeFileSync(path.join(f.sourceRoot,'font.ttf'),data);
  // Establish the private root through an ordinary published distinct blob.
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.from([1]));captureBinaryAsset({root:f.codeProject,path:'font.ttf',binding:f.binding});
  const target=path.join(f.binding.storeRoot,sha256),staged=path.join(path.dirname(f.binding.storeRoot),`.binary-${identity.runId}-${sha256}-${randomUUID()}`);
  if(phase!=='published')fs.writeFileSync(staged,data,{mode:0o600});
  if(phase==='linked')fs.linkSync(staged,target);else if(phase==='published')fs.writeFileSync(target,data,{mode:0o600});
  const record={path:'font.ttf',type:'file',mode:0o644,size:data.length,sha256,contentBlob:sha256};
  if(phase!=='published'){assert.throws(()=>readBinaryAssetBytes({binding:f.binding,record}));assert(fs.existsSync(staged));}
  const imported=importBinaryAsset({binding:f.binding,sourceRoot:f.sourceRoot,sourcePath:'font.ttf',sha256,size:data.length});
  assert.equal(imported.contentBlob,sha256);assert(!fs.existsSync(staged));assert.equal(fs.lstatSync(target).nlink,1);
  assert.deepEqual(readBinaryAssetBytes({binding:f.binding,record}),data);
}));
test('owner publication preserves foreign and ambiguous staging files',()=>fixture(f=>{
  const data=Buffer.from([255,0,128]),sha256=hash(data);fs.writeFileSync(path.join(f.sourceRoot,'font.ttf'),data);
  fs.writeFileSync(path.join(f.codeProject,'font.ttf'),Buffer.from([1]));captureBinaryAsset({root:f.codeProject,path:'font.ttf',binding:f.binding});
  const staged=path.join(path.dirname(f.binding.storeRoot),`.binary-${identity.runId}-${sha256}-${randomUUID()}`);
  fs.writeFileSync(staged,'wrong bytes',{mode:0o600});
  const args={binding:f.binding,sourceRoot:f.sourceRoot,sourcePath:'font.ttf',sha256,size:data.length};
  assert.throws(()=>importBinaryAsset(args));assert.equal(fs.readFileSync(staged,'utf8'),'wrong bytes');
  fs.writeFileSync(staged,data);const other=path.join(path.dirname(f.binding.storeRoot),`.binary-${identity.runId}-${sha256}-${randomUUID()}`);
  fs.writeFileSync(other,data,{mode:0o600});assert.throws(()=>importBinaryAsset(args));assert(fs.existsSync(staged)&&fs.existsSync(other));
}));
test('before and after blob versions share the fixed 256 MiB run budget',()=>fixture(f=>{
  fs.mkdirSync(f.binding.storeRoot,{recursive:true,mode:0o700});const size=BINARY_ASSET_LIMITS.file,block=Buffer.alloc(65536);
  for(const last of [0,1]){
    const sha=createHash('sha256');for(let offset=0;offset<size;offset+=block.length){
      const piece=offset+block.length===size?Buffer.from(block):block;if(offset+block.length===size)piece[piece.length-1]=last;sha.update(piece);}
    const target=path.join(f.binding.storeRoot,sha.digest('hex')),fd=fs.openSync(target,'wx',0o600);
    fs.ftruncateSync(fd,size);if(last)fs.writeSync(fd,Buffer.from([last]),0,1,size-1);fs.closeSync(fd);
  }
  const data=Buffer.from([255]);fs.writeFileSync(path.join(f.sourceRoot,'font.ttf'),data);
  assert.throws(()=>importBinaryAsset({binding:f.binding,sourceRoot:f.sourceRoot,sourcePath:'font.ttf',sha256:hash(data),size:1}),error=>error.code==='binary_asset_limit');
  assert.equal(fs.readdirSync(f.binding.storeRoot).length,2);
}));
test('unchanged existing binary retains reviewable exact version through text-only r2 and replay',()=>fixture(f=>{
  const font=Buffer.alloc(3*1024*1024,0x81);fs.writeFileSync(path.join(f.codeProject,'font.ttf'),font);
  fs.writeFileSync(path.join(f.codeProject,'code.js'),'before');fs.writeFileSync(path.join(f.codeProject,'unchanged.js'),'stable');
  const original=captureReviewBaseline({root:f.codeProject,specsRoot:f.specsDir,identity,
    scope:['font.ttf','code.js','unchanged.js'],requirements:['requirements.md'],binaryAssets:f.binding});
  fs.writeFileSync(path.join(f.codeProject,'code.js'),'round one');
  const first=createReviewPackage({root:f.codeProject,baseline:original,checks});
  assert.equal(first.changes.length,1);assert.equal(first.changes[0].path,'code.js');
  const originalFont=original.files.find(row=>row.path==='font.ttf');
  assert.deepEqual(first.unchangedScope.find(row=>row.path==='font.ttf'),originalFont);
  assert.deepEqual(first.unchangedScope.find(row=>row.path==='unchanged.js'),{path:'unchanged.js',sha256:hash('stable')});
  // Restore the actual durable baseline representation, then use the same
  // attemptBaseline constructor the owner uses after changes_requested.
  const restoredOriginal=readReviewBaseline(JSON.parse(JSON.stringify(original))),secondBase=attemptBaseline(restoredOriginal,2);
  const secondText='round two';fs.writeFileSync(path.join(f.codeProject,'code.js'),secondText);
  const second=createReviewPackage({root:f.codeProject,baseline:secondBase,checks});
  const projected=projectedReviewPackage({root:f.codeProject,baseline:secondBase,checks,
    scopeFiles:[{path:'code.js',contentBase64:Buffer.from(secondText).toString('base64'),mode:0o644}]});
  assert.equal(projected.packageDigest,second.packageDigest);assert.equal(second.identity.attempt,2);
  assert.deepEqual(second.unchangedScope.find(row=>row.path==='font.ttf'),originalFont);
  const replayed=readReviewPackage(JSON.parse(JSON.stringify(second)));
  assert.equal(replayed.packageDigest,second.packageDigest);
  const input={root:f.codeProject,baseline:secondBase,checks,reviewPackage:replayed,expectedDigest:replayed.packageDigest};
  assert.equal(verifyReviewPackage(input).outcome,'matched');assert.equal(verifyCompletionReviewPackage(input).outcome,'matched');
  const reseal=raw=>{const {packageDigest,...body}=raw;return {...body,packageDigest:digest(body)};};
  for(const alter of [row=>({path:row.path,sha256:row.sha256}),row=>({...row,size:row.size+1}),row=>({...row,contentBlob:'0'.repeat(64)})]){
    const bad=structuredClone(second);bad.unchangedScope=bad.unchangedScope.map(row=>row.path==='font.ttf'?alter(row):row);
    assert.throws(()=>readReviewPackage(reseal(bad)));
  }
  const extraBody=structuredClone(second);extraBody.unchangedScope.find(row=>row.path==='unchanged.js').contentBlob=hash('stable');
  assert.throws(()=>readReviewPackage(reseal(extraBody)));
  fs.writeFileSync(path.join(f.binding.storeRoot,originalFont.contentBlob),'corrupt');
  assert.throws(()=>readReviewPackage(JSON.parse(JSON.stringify(second))));assert.throws(()=>verifyCompletionReviewPackage(input));
}));
