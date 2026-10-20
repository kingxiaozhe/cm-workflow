import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readReviewVerification,verificationTools,inspectReviewVerificationEvidence} from '../runtime/js/cm-fix/review-verification-contract.mjs';
import {createReviewVerificationSession} from '../runtime/js/cm-fix/review-verification.mjs';
import {binaryVerificationVersions,readVerificationBinary,BINARY_FILE_LIMIT} from '../runtime/js/cm-fix/review-verification-binary.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture({deleted=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-binary-review-'))),code=path.join(root,'code');fs.mkdirSync(code);
 const storeRoot=path.join(root,'specs','.reviews','.binary-assets','fixture','binary-review');fs.mkdirSync(storeRoot,{recursive:true,mode:0o700});
 const before=Buffer.alloc(2*1024*1024+11,0xfd),after=Buffer.alloc(3*1024*1024+5,0xff);after.write('BINARY',7);
 const binary=(bytes)=>({path:'assets/font.ttf',type:'file',mode:0o644,size:bytes.length,sha256:sha(bytes),contentBlob:sha(bytes)});
 for(const bytes of [before,after])fs.writeFileSync(path.join(storeRoot,sha(bytes)),bytes,{mode:0o600});
 fs.mkdirSync(path.join(code,'assets'));if(!deleted)fs.writeFileSync(path.join(code,'assets/font.ttf'),after);
 fs.writeFileSync(path.join(code,'value.mjs'),'export const value=1;\n');
 fs.writeFileSync(path.join(code,'verify.mjs'),`import fs from 'node:fs';import {createHash} from 'node:crypto';import {value} from './value.mjs';if(value!==1)process.exit(2);${deleted?"if(fs.existsSync('assets/font.ttf'))process.exit(3);":`if(createHash('sha256').update(fs.readFileSync('assets/font.ttf')).digest('hex')!==${JSON.stringify(sha(after))})process.exit(4);`}`);
 const configuration={files:['value.mjs','verify.mjs','assets/font.ttf'],checks:[{id:'asset',command:[process.execPath,'verify.mjs']}],mutationPaths:['value.mjs'],timeoutMs:10000,
  binaryAssets:{version:1,paths:['assets/font.ttf']}};
 const reviewPackage={packageDigest:'b'.repeat(64),identity:{repositoryId:'fixture',runId:'binary-review',taskId:'T-001',attempt:1},binaryAssets:{version:1,paths:['assets/font.ttf'],storeRoot},
  changes:[{path:'assets/font.ttf',before:binary(before),after:deleted?null:binary(after)}]};
 return {root,code,storeRoot,before,after,configuration,reviewPackage,request:{provider:'claude',requestDigest:'a'.repeat(64),payload:{reviewPackage}},close(){fs.rmSync(root,{recursive:true,force:true});}};
}
test('binary verification is explicit and preserves legacy profile and tool names',()=>{
 const f=fixture();try{
  const old={...f.configuration};delete old.binaryAssets;assert.deepEqual(readReviewVerification(old),old);
  assert.deepEqual(verificationTools(old),['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__mutate_check']);
  assert(verificationTools(f.configuration).includes('mcp__cm_review__read_binary'));
  for(const binaryAssets of [{version:1,paths:['../font']},{version:1,paths:['value.mjs']},{version:1,paths:['missing.ttf']},
   {version:1,paths:['assets/font.ttf'],storeRoot:f.storeRoot},{version:2,paths:['assets/font.ttf']}])assert.throws(()=>readReviewVerification({...f.configuration,binaryAssets}));
  assert.throws(()=>binaryVerificationVersions(old,f.reviewPackage),{code:'review_verification_package_binding'});
  const changed=structuredClone(f.reviewPackage);changed.changes[0].after.contentBlob='c'.repeat(64);
  assert.throws(()=>binaryVerificationVersions(f.configuration,changed),{code:'review_verification_package_binding'});
 }finally{f.close();}
});
test('binary reader enforces byte limit, exact size/hash, ranges, source links and hard links',()=>{
 const f=fixture();try{
  const r=readVerificationBinary(f.code,'assets/font.ttf',{offset:6,length:8});assert.equal(Buffer.from(r.contentBase64,'base64').length,8);
  assert.equal(r.sha256,sha(f.after));assert.equal(r.size,f.after.length);
  for(const options of [{offset:-1,length:1},{offset:f.after.length+1,length:1},{length:16385},{expected:{sha256:'0'.repeat(64),size:f.after.length}}])assert.throws(()=>readVerificationBinary(f.code,'assets/font.ttf',options));
  fs.symlinkSync('font.ttf',path.join(f.code,'assets/link.ttf'));assert.throws(()=>readVerificationBinary(f.code,'assets/link.ttf'));
  fs.linkSync(path.join(f.code,'assets/font.ttf'),path.join(f.code,'assets/hard.ttf'));assert.throws(()=>readVerificationBinary(f.code,'assets/font.ttf'));
  fs.unlinkSync(path.join(f.code,'assets/hard.ttf'));
  const fd=fs.openSync(path.join(f.code,'assets/large.ttf'),'w');fs.ftruncateSync(fd,BINARY_FILE_LIMIT+1);fs.closeSync(fd);
  assert.throws(()=>readVerificationBinary(f.code,'assets/large.ttf'));
 }finally{f.close();}
});
test('binary versions enforce a separate aggregate budget without expanding text limits',()=>{
 const f=fixture();try{
  const pkg=structuredClone(f.reviewPackage),configuration=structuredClone(f.configuration);
  configuration.files.push('assets/other.ttf');configuration.binaryAssets.paths.push('assets/other.ttf');pkg.binaryAssets.paths.push('assets/other.ttf');
  const row={path:'assets/other.ttf',type:'file',mode:0o644,size:128*1024*1024,sha256:'c'.repeat(64),contentBlob:'c'.repeat(64)};
  pkg.changes=[{path:'assets/font.ttf',before:{...row,path:'assets/font.ttf'},after:{...row,path:'assets/font.ttf'}},
   {path:'assets/other.ttf',before:null,after:row}];
  assert.throws(()=>binaryVerificationVersions(configuration,pkg),{code:'review_verification_package_binding'});
 }finally{f.close();}
});
for(const deleted of [false,true])test(`isolated binary before/after survives ${deleted?'deletion':'replacement'} and real checks/mutation`,{skip:process.platform!=='darwin'},async()=>{
 const f=fixture({deleted});let s;try{
  s=createReviewVerificationSession({codeProject:f.code,configuration:f.configuration,request:f.request});
  const original=await s.call('read_binary',{path:'assets/font.ttf',version:'before',offset:3,length:7});
  assert.equal(original.sha256,sha(f.before));assert.equal(original.examinedPath,'assets/font.ttf');assert.equal(Buffer.from(original.contentBase64,'base64').length,7);
  if(deleted)await assert.rejects(s.call('read_binary',{path:'assets/font.ttf'}),{code:'review_verification_binary_version'});
  else{
   const next=await s.call('read_binary',{path:'assets/font.ttf',offset:7,length:6});assert.equal(Buffer.from(next.contentBase64,'base64').toString(),'BINARY');
   assert.equal(next.sha256,sha(f.after));assert.equal(next.totalBytes,f.after.length);
   await assert.rejects(s.call('read_file',{path:'assets/font.ttf'}),{code:'review_verification_encoding'});
  }
  await assert.rejects(s.call('read_binary',{path:'value.mjs'}),{code:'review_verification_path'});
  assert.equal((await s.call('run_check',{id:'asset'})).exitCode,0);
  const m=await s.call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=2',checkId:'asset'});assert.equal(m.killed,true);
  const evidence=s.finish('fresh-binary-review');assert.equal(evidence.binaryFiles.length,deleted?1:2);
  const tampered=structuredClone(evidence);tampered.binaryFiles[0].sha256='0'.repeat(64);
  assert.throws(()=>inspectReviewVerificationEvidence(tampered,{request:f.request,configuration:f.configuration,providerThreadId:'fresh-binary-review'}),{code:'review_verification_binding'});
  assert.equal(fs.readFileSync(path.join(f.code,'value.mjs'),'utf8'),'export const value=1;\n');
  if(!deleted)assert.equal(sha(fs.readFileSync(path.join(f.code,'assets/font.ttf'))),sha(f.after));
 }finally{await s?.close();f.close();}
});
test('binary snapshot rejects unbound metadata, changed store, and source drift',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
  const bad=structuredClone(f.request);bad.payload.reviewPackage.changes[0].after.size++;
  assert.throws(()=>createReviewVerificationSession({codeProject:f.code,configuration:f.configuration,request:bad}),{code:'review_verification_package_binding'});
  s=createReviewVerificationSession({codeProject:f.code,configuration:f.configuration,request:f.request});
  fs.writeFileSync(path.join(f.storeRoot,sha(f.before)),Buffer.from('changed'));
  assert.throws(()=>s.finish('fresh-binary-review'),{code:'review_verification_package_binding'});
  await s.close();s=null;
  fs.writeFileSync(path.join(f.storeRoot,sha(f.before)),f.before);
  s=createReviewVerificationSession({codeProject:f.code,configuration:f.configuration,request:f.request});
  fs.writeFileSync(path.join(f.code,'assets/font.ttf'),Buffer.from('changed'));
  assert.throws(()=>s.finish('fresh-binary-review'),{code:'review_verification_source_drift'});
 }finally{await s?.close();f.close();}
});
test('binary MCP catalog and real stdio read expose only registered bounded versions',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
  s=createReviewVerificationSession({codeProject:f.code,configuration:f.configuration,request:f.request});
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_binary',arguments:{path:'assets/font.ttf',version:'before',length:8}}}];
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../runtime/js/cm-fix/review-verification-server.mjs',import.meta.url)),s.configPath],
   {input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:10000,maxBuffer:65536});
  assert.equal(r.status,0,r.stderr);const lines=r.stdout.trim().split('\n').map(x=>JSON.parse(x));
  assert(lines[0].result.tools.some(x=>x.name==='read_binary'));
  const binary=JSON.parse(lines[1].result.content[0].text);assert.equal(binary.sha256,sha(f.before));assert.equal(Buffer.from(binary.contentBase64,'base64').length,8);
  assert(!JSON.stringify(lines[0]).includes(f.storeRoot));
 }finally{await s?.close();f.close();}
});
