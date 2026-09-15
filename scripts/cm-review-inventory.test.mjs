import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureReviewBaseline,createReviewPackage,readReviewBaseline,readReviewPackage,verifyReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';

const identity={repositoryId:'fixture',runId:'inventory',taskId:'T-001',attempt:1};
const checks=[{id:'fixture',command:['node','fixture.mjs'],outcome:'passed',exitCode:0,evidence:'synthetic check'}];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const capture=(root,extra={})=>captureReviewBaseline({root,identity,scope:['code.js'],requirements:['requirements.md'],...extra});
const write=(root,name,body)=>fs.writeFileSync(path.join(root,name),body);
function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-inventory-')));
  try{write(root,'code.js','before');write(root,'requirements.md','fixture');return fn(root);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('large inventory retains hashes, emits only selected bodies, and verifies the review package',()=>fixture(root=>{
  for(let i=0;i<510;i++)write(root,`asset-${i}`,Buffer.alloc(4096,i%256));
  const media=Buffer.alloc(2*1024*1024+1,17);write(root,'media.bin',media);write(root,'AGENTS.md','fixture instructions');
  const baseline=capture(root);
  assert.equal(baseline.version,2);assert.equal(baseline.files.length,514);
  assert.deepEqual(baseline.files.filter(f=>Object.hasOwn(f,'contentBase64')).map(f=>f.path),['AGENTS.md','code.js','requirements.md']);
  assert.equal(baseline.files.find(f=>f.path==='media.bin').sha256,sha(media));
  assert(Buffer.byteLength(JSON.stringify(baseline))<150000);
  assert.deepEqual(readReviewBaseline(JSON.parse(JSON.stringify(baseline))),baseline);
  write(root,'code.js','after');
  const reviewPackage=createReviewPackage({root,baseline,checks});
  assert.equal(reviewPackage.version,1);
  assert.equal(Buffer.from(reviewPackage.changes[0].before.contentBase64,'base64').toString(),'before');
  assert.deepEqual(readReviewPackage(reviewPackage),reviewPackage);
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest}).outcome,'matched');
}));

for(const mode of ['same-size edit','add','delete','rename','chmod','symlink','hardlink'])
  test(`digest-only out-of-scope file rejects ${mode}`,()=>fixture(root=>{
    write(root,'asset.bin',Buffer.alloc(1024*1024+1,7));const baseline=capture(root);write(root,'code.js','after');
    const target=path.join(root,'asset.bin');
    if(mode==='same-size edit'){const fd=fs.openSync(target,'r+');try{fs.writeSync(fd,Buffer.from([8]),0,1,65537);}finally{fs.closeSync(fd);}}
    if(mode==='add')write(root,'new.bin','extra');
    if(mode==='delete')fs.unlinkSync(target);
    if(mode==='rename')fs.renameSync(target,path.join(root,'renamed.bin'));
    if(mode==='chmod')fs.chmodSync(target,0o700);
    if(mode==='symlink'){fs.unlinkSync(target);fs.symlinkSync('code.js',target);}
    if(mode==='hardlink')fs.linkSync(target,path.join(root,'linked.bin'));
    assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:['symlink','hardlink'].includes(mode)?'unsupported_file':'out_of_scope'});
  }));

for(const mutation of ['truncate','grow','replace'])test(`streamed file ${mutation} fails and closes its descriptor`,t=>fixture(root=>{
  const target=path.join(root,'asset.bin');write(root,'asset.bin',Buffer.alloc(1024*1024+1));
  const originalRead=fs.readSync,originalOpen=fs.openSync,originalClose=fs.closeSync;
  let targetFd,changed=false,closed=false,maxRead=0;
  t.mock.method(fs,'openSync',(...args)=>{const fd=originalOpen(...args);if(args[0]===target)targetFd=fd;return fd;});
  t.mock.method(fs,'readSync',(...args)=>{
    const n=originalRead(...args);
    if(args[0]===targetFd){
      maxRead=Math.max(maxRead,args[3]);
      if(!changed){changed=true;
        if(mutation==='truncate')fs.truncateSync(target,1);
        if(mutation==='grow')fs.appendFileSync(target,'extra');
        if(mutation==='replace'){fs.renameSync(target,target+'.old');write(root,'asset.bin',Buffer.alloc(1024*1024+1));}
      }
    }
    return n;
  });
  t.mock.method(fs,'closeSync',fd=>{if(fd===targetFd)closed=true;return originalClose(fd);});
  assert.throws(()=>capture(root),{code:'snapshot_changed'});assert(changed&&closed);assert(maxRead<=64*1024);
}));

test('oversized inventory fails before reading the file, while selected material retains its smaller cap',t=>fixture(root=>{
  const target=path.join(root,'asset.bin');write(root,'asset.bin','');fs.truncateSync(target,1024*1024*1024+1);
  const original=fs.openSync;let opened=false;
  t.mock.method(fs,'openSync',(...args)=>{if(args[0]===target)opened=true;return original(...args);});
  assert.throws(()=>capture(root),{code:'limit_exceeded'});assert.equal(opened,false);
  fs.unlinkSync(target);write(root,'code.js',Buffer.alloc(1024*1024+1));
  assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('inventory count is bounded without silently omitting the last file',()=>fixture(root=>{
  for(let i=0;i<9998;i++)write(root,`empty-${String(i).padStart(5,'0')}`,'');
  const baseline=capture(root);assert.equal(baseline.files.length,10000);readReviewBaseline(baseline);
  write(root,'one-more','');assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('offline sparse baseline rejects missing required bodies, extra bodies, aliases, and malformed metadata',()=>fixture(root=>{
  write(root,'asset.bin','outside');const original=capture(root);
  for(const mutate of [
    b=>{delete b.files.find(f=>f.path==='code.js').contentBase64;},
    b=>{b.files.find(f=>f.path==='asset.bin').contentBase64=Buffer.from('outside').toString('base64');},
    b=>{b.files[0].size=-1;},b=>{b.files[0].sha256='bad';},
    b=>{b.files.push({...b.files[0],path:'ASSET.bin'});},
  ]){
    const b=structuredClone(original);mutate(b);const {baselineDigest,...data}=b;
    assert.throws(()=>readReviewBaseline({...data,baselineDigest:digest(data)}),{code:'invalid_baseline'});
  }
}));

test('legacy baseline preserves full records and package digests across offline restoration',()=>fixture(root=>{
  write(root,'outside.txt','legacy body');const baseline=capture(root,{version:1});
  assert(baseline.files.every(f=>Object.hasOwn(f,'contentBase64')));
  assert.deepEqual(capture(root,{version:1}),readReviewBaseline(baseline));
  write(root,'code.js','after');const reviewPackage=createReviewPackage({root,baseline,checks});
  assert.equal(verifyReviewPackage({root,baseline:readReviewBaseline(JSON.parse(JSON.stringify(baseline))),checks,
    reviewPackage,expectedDigest:reviewPackage.packageDigest}).outcome,'matched');
  write(root,'outside.txt','changed');assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
}));
