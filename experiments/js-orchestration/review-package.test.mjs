import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest } from './contracts.mjs';
import { captureReviewBaseline, createReviewPackage, verifyReviewPackage,readReviewBaseline,readReviewPackage } from './review-package.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { repositoryId:'fixture', runId:'run-1', taskId:'feature.T-001', attempt:1 };
const checks = [{ id:'unit', command:['node','test.mjs'], outcome:'passed', exitCode:0, evidence:'synthetic passed' }];
const write = (root,p,body) => {
  fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});
  fs.writeFileSync(path.join(root,p),body);
};
function fixture(fn) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-s2a-'));
  try {
    write(root,'src/a.js','const value = 1;\r\n');
    write(root,'requirements.md','合成规格\n');
    write(root,'unrelated.txt','existing dirty\n');
    return fn(root);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
const capture = (root,extra={}) => captureReviewBaseline({root,identity,scope:['src/a.js','src/new.js'],requirements:['requirements.md'],...extra});
const resign = (obj,field) => { const {[field]:ignored,...data}=obj; return {...data,[field]:digest(data)}; };
function prepared(root,extra={}) {
  const baseline=capture(root,extra); write(root,'src/a.js','changed\n');
  const reviewPackage=createReviewPackage({root,baseline,checks});
  return {root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest};
}

test('S3b2b offline readers retain validated original bytes despite later edits',()=>fixture(root=>{
  const {baseline,reviewPackage}=prepared(root);write(root,'src/a.js','edited after checkpoint');
  assert.deepEqual(readReviewBaseline(baseline),baseline);assert.deepEqual(readReviewPackage(reviewPackage),reviewPackage);
  assert(Object.isFrozen(readReviewBaseline(baseline).files[0]));assert(Object.isFrozen(readReviewPackage(reviewPackage).changes));
  const bad=structuredClone(baseline);bad.files[0].contentBase64='AA==';assert.throws(()=>readReviewBaseline(bad));
  const pkg=structuredClone(reviewPackage);pkg.checksDigest='0'.repeat(64);assert.throws(()=>readReviewPackage(pkg));
  let getters=0;assert.throws(()=>readReviewBaseline({get version(){getters++;return 1;}}));assert.equal(getters,0);
}));

test('S2a baseline binds exact bytes, root and initial dirty state without mutating input',()=>fixture(root=>{
  const options={root,identity,scope:['src/new.js','src/a.js'],requirements:['requirements.md']};
  const saved=structuredClone(options),base=captureReviewBaseline(options);
  assert.deepEqual(options,saved);
  assert.equal(base.kind,'cm-review-baseline');
  assert.equal(base.version,1);
  assert.equal(base.rootDigest,sha(fs.realpathSync(root)));
  assert.deepEqual(base.scope,['src/a.js','src/new.js']);
  assert.equal(base.files.length,3);
  const f=base.files.find(f=>f.path==='src/a.js');
  assert.equal(Buffer.from(f.contentBase64,'base64').toString(),'const value = 1;\r\n');
  assert.equal(f.sha256,sha(Buffer.from(f.contentBase64,'base64')));
  assert(Object.isFrozen(base.files[0]));
  assert.throws(()=>{base.identity.runId='forged';},TypeError);
  assert.deepEqual(capture(root),base);
}));

test('S2a verify matches frozen content and rejects later code edits under the old digest',()=>fixture(root=>{
  const baseline=capture(root); write(root,'src/a.js','changed\n');
  const reviewPackage=createReviewPackage({root,baseline,checks});
  const request={root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest};
  assert.deepEqual(verifyReviewPackage(request),{outcome:'matched',packageDigest:reviewPackage.packageDigest});
  write(root,'src/a.js','changed again\n');
  assert.throws(()=>verifyReviewPackage(request),{code:'package_mismatch'});
}));

test('S2a package derives only task changes and carries exact requirements and check evidence',()=>fixture(root=>{
  const base=capture(root);
  write(root,'src/a.js','const value = 2;\n'); write(root,'src/new.js',Buffer.from([0,255,13,10]));
  const pkg=createReviewPackage({root,baseline:base,checks});
  assert.equal(pkg.baseIdentity,base.baselineDigest);
  assert.deepEqual(pkg.changes.map(c=>c.path),['src/a.js','src/new.js']);
  assert.equal(pkg.changes[1].before,null);
  assert.equal(pkg.changes[1].after.contentBase64,'AP8NCg==');
  assert.equal(pkg.requirements[0].path,'requirements.md');
  assert.deepEqual(pkg.checks,checks);
  assert(Object.isFrozen(pkg.changes[0].after));
  assert.deepEqual(createReviewPackage({root,baseline:base,checks}),pkg);
}));

test('S2a deletion and rename include both paths, mode-only including special bits invalidates approval',()=>fixture(root=>{
  const baseline=capture(root); fs.renameSync(path.join(root,'src/a.js'),path.join(root,'src/new.js'));
  const pkg=createReviewPackage({root,baseline,checks});
  assert.equal(pkg.changes[0].after,null); assert.equal(pkg.changes[1].before,null);
  assert.deepEqual(pkg.changes[0].before.contentBase64,pkg.changes[1].after.contentBase64);
  for(const bit of [0o100,0o1000,0o2000,0o4000]) {
    fs.chmodSync(path.join(root,'src/new.js'),0o644);
    const reviewPackage=createReviewPackage({root,baseline,checks});
    fs.chmodSync(path.join(root,'src/new.js'),0o644|bit);
    assert.equal(fs.statSync(path.join(root,'src/new.js')).mode&0o7777,0o644|bit);
    assert.throws(()=>verifyReviewPackage({root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest}),{code:'package_mismatch'});
  }
}));

test('S2a real temporary Git dirty and ignored files use filesystem baseline, not HEAD',()=>fixture(root=>{
  const git=(...argv)=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q'); git('config','user.name','CM Fixture'); git('config','user.email','fixture@example.invalid');
  write(root,'.gitignore','ignored.txt\n'); git('add','.'); git('commit','-qm','fixture baseline');
  write(root,'src/a.js','existing dirty, not HEAD\n'); write(root,'ignored.txt','old ignored\n');
  const baseline=capture(root); write(root,'src/a.js','task change\n');
  const pkg=createReviewPackage({root,baseline,checks});
  assert.equal(Buffer.from(pkg.changes[0].before.contentBase64,'base64').toString(),'existing dirty, not HEAD\n');
  write(root,'ignored.txt','new ignored\n');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
}));

for(const operation of ['add','modify','delete']) test(`S2a out-of-scope ${operation} rejects`,()=>fixture(root=>{
  const baseline=capture(root); write(root,'src/a.js','task change\n');
  if(operation==='add')write(root,'undeclared.txt','new');
  if(operation==='modify')write(root,'unrelated.txt','different dirty');
  if(operation==='delete')fs.unlinkSync(path.join(root,'unrelated.txt'));
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
}));

test('S2a no change and absent requirements do not produce usable packages',()=>fixture(root=>{
  const baseline=capture(root);
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'empty_changes'});
  assert.throws(()=>capture(root,{requirements:['missing.md']}),{code:'read_failed'});
  const withRequirement=capture(root,{scope:['src/a.js','requirements.md']});
  fs.unlinkSync(path.join(root,'requirements.md'));
  assert.throws(()=>createReviewPackage({root,baseline:withRequirement,checks}),{code:'read_failed'});
}));

test('S2a changes to requirements or check evidence cannot reuse an old digest',()=>fixture(root=>{
  const r=prepared(root,{scope:['src/a.js','requirements.md']});
  write(root,'requirements.md','different requirement');
  assert.throws(()=>verifyReviewPackage(r),{code:'package_mismatch'});
  write(root,'requirements.md','合成规格\n');
  const different=structuredClone(checks); different[0].evidence='other run result';
  assert.throws(()=>verifyReviewPackage({...r,checks:different}),{code:'package_mismatch'});
}));

test('S2a different root, run, task, attempt, repository and frozen baseline are not interchangeable',()=>fixture(root=>{
  const r=prepared(root);
  fixture(other=>assert.throws(()=>verifyReviewPackage({...r,root:other}),{code:'invalid_baseline'}));
  for(const key of ['runId','taskId','repositoryId','attempt']) {
    const b=structuredClone(r.baseline); b.identity[key]=key==='attempt'?2:'other';
    assert.throws(()=>verifyReviewPackage({...r,baseline:resign(b,'baselineDigest')}),{code:'package_mismatch'});
  }
  const b=structuredClone(r.baseline),f=b.files.find(f=>f.path==='src/a.js');
  f.contentBase64=Buffer.from('different baseline').toString('base64'); f.size=18; f.sha256=sha('different baseline');
  assert.throws(()=>verifyReviewPackage({...r,baseline:resign(b,'baselineDigest')}),{code:'package_mismatch'});
}));

for(const p of ['../escape','/absolute','C:/drive','dir\\file','a//b','a/./b','a/../b','a\u0000b','a\nb','e\u0301.txt','.git/config','nested/.git/file','.env','.env.example','.ssh/key','.aws/credentials','.gnupg/file']) {
  test(`S2a forbidden declaration ${JSON.stringify(p)} is rejected before reading`,t=>fixture(root=>{
    let reads=0; const original=fs.readSync;
    t.mock.method(fs,'readSync',(...args)=>{reads++;return original(...args);});
    assert.throws(()=>capture(root,{scope:[p]}),{code:'unsupported_path'});
    assert.throws(()=>capture(root,{requirements:[p]}),{code:'unsupported_path'});
    assert.equal(reads,0);
  }));
}

test('S2a duplicate/case aliases, directories, empty fields and non-JSON inputs reject',()=>fixture(root=>{
  for(const scope of [[],['src/a.js','src/a.js'],['src/a.js','SRC/A.JS'],['src']]) assert.throws(()=>capture(root,{scope}));
  for(const attempt of [0,3,'1']) assert.throws(()=>capture(root,{identity:{...identity,attempt}}));
  assert.throws(()=>capture(root,{extra:true}));
  assert.throws(()=>capture(root,{scope:Array(1)}));
  assert.throws(()=>capture(root,{identity:new Date()}));
  const cyc={};cyc.self=cyc;assert.throws(()=>capture(root,{identity:cyc}));
  let invoked=false; const options={root,scope:['src/a.js'],requirements:['requirements.md']};
  Object.defineProperty(options,'identity',{enumerable:true,get(){invoked=true;return identity;}});
  assert.throws(()=>captureReviewBaseline(options)); assert.equal(invoked,false);
}));

for(const kind of ['leaf-link','directory-link','hardlink','fifo','nested-git','git-file','git-link','sensitive']) {
  test(`S2a physical unsupported ${kind} never follows the target`,t=>fixture(root=>{
    if(kind==='leaf-link')fs.symlinkSync('requirements.md',path.join(root,'link'));
    if(kind==='directory-link')fs.symlinkSync('src',path.join(root,'dir-link'));
    if(kind==='hardlink')fs.linkSync(path.join(root,'src/a.js'),path.join(root,'hard'));
    if(kind==='fifo')execFileSync('mkfifo',[path.join(root,'pipe')]);
    if(kind==='nested-git')fs.mkdirSync(path.join(root,'src/.git'));
    if(kind==='git-file')write(root,'.git','gitdir: elsewhere');
    if(kind==='git-link')fs.symlinkSync('src',path.join(root,'.git'));
    if(kind==='sensitive')write(root,'.env','synthetic only');
    const opened=[],original=fs.openSync;
    t.mock.method(fs,'openSync',(...args)=>{opened.push(args[0]); return original(...args);});
    assert.throws(()=>capture(root));
    assert(!opened.some(p=>['link','dir-link','pipe','.git','.env','hard'].includes(path.basename(p))));
  }));
}

test('S2a root Git metadata is excluded but cannot appear in restored declarations or records',()=>fixture(root=>{
  fs.mkdirSync(path.join(root,'.git')); write(root,'.git/config','not read');
  const r=prepared(root); assert(!r.baseline.files.some(f=>f.path.startsWith('.git')));
  for(const target of ['scope','requirements','files']) {
    const b=structuredClone(r.baseline);
    if(target==='files')b.files[0].path='.git/config';else b[target]=['.git/config'];
    assert.throws(()=>createReviewPackage({root,baseline:resign(b,'baselineDigest'),checks}),{code:'invalid_baseline'});
  }
  const p=structuredClone(r.reviewPackage);p.requirements[0].path='.git/config';
  p.requirementsDigest=digest(p.requirements);
  assert.throws(()=>verifyReviewPackage({...r,reviewPackage:resign(p,'packageDigest')}),{code:'invalid_package'});
}));

test('S2a stale reads and permission denial fail explicitly and close opened descriptors',t=>fixture(root=>{
  let closes=0; const fstat=fs.fstatSync,close=fs.closeSync;
  t.mock.method(fs,'closeSync',fd=>{closes++;return close(fd);});
  const patch=t.mock.method(fs,'fstatSync',(...args)=>{const s=fstat(...args);return {...s,mtimeNs:s.mtimeNs+1n};});
  assert.throws(()=>capture(root),{code:'snapshot_changed'}); assert.equal(closes,1); patch.mock.restore();
  t.mock.method(fs,'openSync',()=>{throw Object.assign(new Error('synthetic denial'),{code:'EACCES'});});
  assert.throws(()=>capture(root),{code:'read_failed'});
}));

test('S2a file and total byte limits include raw Unicode bytes, not characters',()=>fixture(root=>{
  fs.unlinkSync(path.join(root,'unrelated.txt'));write(root,'requirements.md','r');
  write(root,'src/a.js',Buffer.alloc(1024*1024)); write(root,'src/new.js',Buffer.alloc(1024*1024-1));
  assert.equal(capture(root).files.reduce((n,f)=>n+f.size,0),2*1024*1024);
  write(root,'extra','x');assert.throws(()=>capture(root),{code:'limit_exceeded'});fs.unlinkSync(path.join(root,'extra'));
  write(root,'src/a.js','中'.repeat(350000)); assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('S2a file count and directory depth limits reject instead of omitting records',()=>fixture(root=>{
  for(let i=0;i<253;i++)write(root,`empty-${i}`,''); assert.equal(capture(root).files.length,256);
  write(root,'one-more','');assert.throws(()=>capture(root),{code:'limit_exceeded'});
  fs.unlinkSync(path.join(root,'one-more')); for(let i=0;i<253;i++)fs.unlinkSync(path.join(root,`empty-${i}`));
  const dirs=Array.from({length:32},()=> 'd').join('/');write(root,dirs+'/f','');capture(root);
  write(root,dirs+'/d/f','');assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('S2a checks retain failures but validate contradictory outcomes and exact byte limits',()=>fixture(root=>{
  const r=prepared(root);
  for(const item of [{...checks[0],outcome:'failed',exitCode:1},{...checks[0],outcome:'unavailable',exitCode:null}]) {
    const pkg=createReviewPackage({checks:[item],root:r.root,baseline:r.baseline});
    assert.equal(pkg.checks[0].outcome,item.outcome); assert(!Object.hasOwn(pkg,'verdict'));
  }
  for(const edits of [{exitCode:1},{outcome:'failed',exitCode:0},{outcome:'unavailable',exitCode:0},{evidence:''},{command:[]},{extra:true}])
    assert.throws(()=>createReviewPackage({root,baseline:r.baseline,checks:[{...checks[0],...edits}]}));
  const c=structuredClone(checks);c[0].evidence='';const overhead=Buffer.byteLength(JSON.stringify(c));
  c[0].evidence='x'.repeat(64*1024-overhead);createReviewPackage({root,baseline:r.baseline,checks:c});
  c[0].evidence+='x';assert.throws(()=>createReviewPackage({root,baseline:r.baseline,checks:c}),{code:'limit_exceeded'});
}));

test('S2a complete package size bound rejects before returning oversized base64 data',()=>fixture(root=>{
  fs.unlinkSync(path.join(root,'unrelated.txt'));
  for(const p of ['src/a.js','requirements.md'])write(root,p,Buffer.alloc(1024*1024,1));
  const baseline=capture(root,{scope:['src/a.js','requirements.md'],requirements:['requirements.md','src/a.js']});
  for(const p of ['src/a.js','requirements.md'])write(root,p,Buffer.alloc(1024*1024,2));
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'limit_exceeded'});
}));

test('S2a malformed baseline/package or self-consistent forgery cannot match fixed expected digest',()=>fixture(root=>{
  const r=prepared(root);
  for(const edit of [b=>{b.version=2;},b=>{b.extra=true;},b=>{delete b.rootDigest;},b=>{b.files[0].sha256='0'.repeat(64);},b=>{b.files[0].contentBase64+='!';}]) {
    const b=structuredClone(r.baseline);edit(b);
    assert.throws(()=>createReviewPackage({root,baseline:resign(b,'baselineDigest'),checks}),{code:'invalid_baseline'});
  }
  for(const edit of [p=>{p.version=2;},p=>{p.extra=true;},p=>{delete p.rootDigest;},p=>{p.changes[0].after.size++;}]) {
    const p=structuredClone(r.reviewPackage);edit(p);
    assert.throws(()=>verifyReviewPackage({...r,reviewPackage:resign(p,'packageDigest')}),{code:'invalid_package'});
  }
  const p=structuredClone(r.reviewPackage);p.checks[0].evidence='forged';p.checksDigest=digest(p.checks);
  assert.throws(()=>verifyReviewPackage({...r,reviewPackage:resign(p,'packageDigest')}),{code:'package_mismatch'});
  assert.throws(()=>verifyReviewPackage({...r,expectedDigest:'0'.repeat(64)}),{code:'package_mismatch'});
}));

test('S2a non-array objects with Array.prototype are not accepted as plain input',()=>fixture(root=>{
  assert.throws(()=>capture(root,{identity:Object.assign(Object.create(Array.prototype),identity)}),{code:'invalid_input'});
}));

test('S2a baseline output is bounded even when a declared future path is enormous',()=>fixture(root=>{
  assert.throws(()=>capture(root,{scope:['x'.repeat(8*1024*1024)]}),{code:'limit_exceeded'});
}));

test('S2a R1: all C1 controls reject in declarations, physical files and restored records before content open',t=>{
  for(let code=0x80;code<=0x9f;code++)fixture(root=>{
    const p=`a${String.fromCodePoint(code)}b`,r=prepared(root),opened=[];
    const original=fs.openSync;
    const patch=t.mock.method(fs,'openSync',(...args)=>{opened.push(args[0]);return original(...args);});
    try {
      assert.throws(()=>capture(root,{scope:[p]}),{code:'unsupported_path'});
      assert.throws(()=>capture(root,{requirements:[p]}),{code:'unsupported_path'});
      assert.equal(opened.length,0);
      write(root,p,'synthetic control-path content'); opened.length=0;
      assert.throws(()=>capture(root),{code:'unsupported_path'});
      assert.throws(()=>createReviewPackage({root,baseline:r.baseline,checks}),{code:'unsupported_path'});
      assert.throws(()=>verifyReviewPackage(r),{code:'unsupported_path'});
      assert(!opened.some(name=>path.basename(name)===p)); fs.unlinkSync(path.join(root,p));
      opened.length=0;
      for(const field of ['scope','requirements','files']) {
        const b=structuredClone(r.baseline);
        if(field==='files')b.files[0].path=p; else b[field]=[p];
        assert.throws(()=>createReviewPackage({root,baseline:resign(b,'baselineDigest'),checks}),{code:'invalid_baseline'});
      }
      for(const field of ['scope','requirements','changes']) {
        const pkg=structuredClone(r.reviewPackage);
        if(field==='scope')pkg.scope=[p];
        if(field==='requirements')pkg.requirements[0].path=p;
        if(field==='changes')pkg.changes[0].path=p;
        pkg.artifactDigest=digest(pkg.changes);pkg.requirementsDigest=digest(pkg.requirements);
        assert.throws(()=>verifyReviewPackage({...r,reviewPackage:resign(pkg,'packageDigest')}),{code:'invalid_package'});
      }
      assert.equal(opened.length,0);
    } finally { patch.mock.restore(); }
  });
});
