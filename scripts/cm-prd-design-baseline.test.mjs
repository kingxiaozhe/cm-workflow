import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {importPrdDesignBaseline,inspectPrdDesignBaseline,publishPrdBaselineForFeature,inspectPrdPublishedBaseline} from '../runtime/js/cm-prd/design-baseline.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'prd-baseline-')));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  const specs=path.join(project,'specs'),prototypeRoot=path.join(project,'prototype');fs.mkdirSync(specs);fs.mkdirSync(prototypeRoot);
  fs.writeFileSync(path.join(prototypeRoot,'index.html'),'<button>Next</button>');
  // A complete 1x1 PNG, not an invented file carrying only the magic bytes.
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMuoAAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(prototypeRoot,'screen.png'),image);
  const font=Buffer.alloc(32);font.write('wOF2');font.writeUInt32BE(32,8);fs.writeFileSync(path.join(prototypeRoot,'font.woff2'),font);
  const input={prototypeRoot,captureRoot:null,confirmation:{reference:'user-message-1',messageDigest:'d'.repeat(64),level:'pixel',nativeDifferences:'list_each_platform_difference'},
    sources:[{sourcePath:'index.html',sha256:sha('<button>Next</button>')}],
    screenshots:[{id:'main',sourcePath:'screen.png',sha256:sha(image),width:1,height:1,page:'main',skin:'warm',state:'default'}],
    fonts:[{id:'round',sourcePath:'font.woff2',sha256:sha(font),license:'Synthetic fixture font only',source:'Synthetic test fixture'}],
    specSheet:{source:'rendered-computed',channel:'codex-in-app',url:'https://prototype.example/',viewport:{width:390,height:844,deviceScaleFactor:1},elements:[{sel:'button',geo:{x:0,y:0,w:20,h:20},font:null,style:{color:'rgb(0, 0, 0)'}}]},
    interaction:{status:'complete',channel:'codex-in-app',coverage:['main'],steps:[{id:'tap',action:'Click next',result:'Next state shown',screenshots:['main']}]},cssSource:null};
  const args={project,specs,sessionId:'prd-original',input,sourceDigest:'a'.repeat(64),configDigest:'b'.repeat(64),writeEnabled:true};
  return {project,specs,prototypeRoot,input,args};
}
test('formal baseline import binds files without allocating a feature and repeats exactly',t=>{
  const {specs,args}=fixture(t),baseline=importPrdDesignBaseline(args);
  assert.equal(baseline.ready,true);assert.equal(baseline.sessionId,'prd-original');assert.equal(baseline.completionAuthorized,false);
  assert.equal(fs.readdirSync(specs).some(name=>/^\d+\./.test(name)),false);
  assert.deepEqual(importPrdDesignBaseline(args),baseline);
  const result=inspectPrdDesignBaseline({...args,baseline});assert.equal(result.manifest.sourceDigest,args.sourceDigest);
  assert.equal(result.manifest.artifacts.length,3);
  const published=publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});
  assert.equal(published.artifacts.length,4);assert.equal(fs.statSync(path.join(specs,'1.native/design-baseline/manifest.json')).mode&0o777,0o600);
  assert.deepEqual(publishPrdBaselineForFeature({...args,baseline,feature:'1.native'}),published);
});
test('incomplete interaction and undeclared font license may be retained but cannot publish a ready baseline',t=>{
  const {args,input}=fixture(t);input.interaction.status='incomplete';input.fonts[0].license=null;
  const baseline=importPrdDesignBaseline(args);assert.equal(baseline.ready,false);
  assert.throws(()=>publishPrdBaselineForFeature({...args,baseline,feature:'1.native'}),/prd_baseline_incomplete/);
});
test('source, copied asset and binding drift are rejected',t=>{
  const {args,prototypeRoot,specs}=fixture(t),baseline=importPrdDesignBaseline(args);
  assert.throws(()=>inspectPrdDesignBaseline({...args,baseline,configDigest:'c'.repeat(64)}),/prd_baseline_binding/);
  fs.writeFileSync(path.join(prototypeRoot,'index.html'),'changed');
  assert.throws(()=>inspectPrdDesignBaseline({...args,baseline}),/prd_baseline_source_changed/);
  fs.writeFileSync(path.join(prototypeRoot,'index.html'),'<button>Next</button>');
  fs.writeFileSync(path.join(specs,path.dirname(baseline.path),'screenshot-1.png'),'changed');
  assert.throws(()=>inspectPrdDesignBaseline({...args,baseline}),/prd_baseline_asset_changed/);
});
test('hash mismatch, path escape, symlinks, wrong magic and arbitrary target directories reject before writes',t=>{
  const {args,input,prototypeRoot,specs}=fixture(t);input.screenshots[0].sha256='c'.repeat(64);
  assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_source_changed/);assert.deepEqual(fs.readdirSync(specs),[]);
  input.screenshots[0].sourcePath='../outside.png';assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_path/);
  input.screenshots[0].sourcePath='link.png';fs.symlinkSync('screen.png',path.join(prototypeRoot,'link.png'));
  assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_path/);
  input.screenshots[0].sourcePath='screen.png';fs.writeFileSync(path.join(prototypeRoot,'screen.png'),'not image');input.screenshots[0].sha256=sha('not image');
  assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_image/);
});
test('static CSS cannot impersonate rendered parameters or actual interaction',t=>{
  const {args,input}=fixture(t);input.specSheet.source='css-source';assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_sheet/);
  input.specSheet.source='rendered-computed';input.interaction.channel='css-source';assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_interaction/);
});
test('foreign destination content is never overwritten and linked roots do not escape',t=>{
  const {args,specs,project}=fixture(t),baseline=importPrdDesignBaseline(args);fs.mkdirSync(path.join(specs,'1.native'));fs.mkdirSync(path.join(specs,'1.native/design-baseline'));
  fs.writeFileSync(path.join(specs,'1.native/design-baseline/manifest.json'),'user content');
  assert.throws(()=>publishPrdBaselineForFeature({...args,baseline,feature:'1.native'}),/prd_baseline_conflict/);
  assert.equal(fs.readFileSync(path.join(specs,'1.native/design-baseline/manifest.json'),'utf8'),'user content');
  fs.symlinkSync(project,path.join(specs,'2.link'));
  assert.throws(()=>publishPrdBaselineForFeature({...args,baseline,feature:'2.link'}),/prd_baseline_path/);
  assert.equal(fs.existsSync(path.join(project,'design-baseline')),false);
});
test('source imports are bounded, exact-schema and write opt-in',t=>{
  const {args,input,specs}=fixture(t);assert.throws(()=>importPrdDesignBaseline({...args,writeEnabled:false}),/prd_baseline_write_disabled/);
  input.target='user-file';assert.throws(()=>importPrdDesignBaseline(args),/invalid_input/);delete input.target;
  input.sources.push({...input.sources[0]});assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_duplicate/);
  assert.deepEqual(fs.readdirSync(specs),[]);
});

test('published review inspection is read-only and detects asset, mode and inventory drift',t=>{
  const {args,specs}=fixture(t),baseline=importPrdDesignBaseline(args),input={...args,baseline,feature:'1.native'};
  assert.throws(()=>inspectPrdPublishedBaseline(input),/ENOENT/);assert.equal(fs.existsSync(path.join(specs,'1.native')),false);
  publishPrdBaselineForFeature(input);const result=inspectPrdPublishedBaseline(input);
  assert.equal(result.ready,true);assert.equal(result.confirmation.messageDigest,args.input.confirmation.messageDigest);assert.equal(result.artifacts.length,4);
  const target=path.join(specs,'1.native/design-baseline/screenshot-1.png'),original=fs.readFileSync(target);
  fs.chmodSync(target,0o644);assert.throws(()=>inspectPrdPublishedBaseline(input),/prd_baseline_asset_changed/);fs.chmodSync(target,0o600);
  fs.writeFileSync(target,'changed');assert.throws(()=>inspectPrdPublishedBaseline(input),/prd_baseline_asset_changed/);fs.writeFileSync(target,original);
  fs.writeFileSync(path.join(specs,'1.native/design-baseline/unbound.png'),'extra');assert.throws(()=>inspectPrdPublishedBaseline(input),/prd_baseline_asset_changed/);
});

test('large variable font remains byte-bound while the existing total budget stays bounded',t=>{
  const {args,input,prototypeRoot,specs}=fixture(t),font=Buffer.alloc(64*1024*1024+1);font.write('OTTO');
  const fontPath=path.join(prototypeRoot,'large.otf');fs.writeFileSync(fontPath,font);
  input.fonts=[{id:'rounded-variable',sourcePath:'large.otf',sha256:sha(font),license:'Synthetic fixture only',source:'Synthetic large variable-font fixture'}];
  const baseline=importPrdDesignBaseline(args);assert.equal(baseline.ready,true);
  const published=publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});
  const copied=path.join(specs,'1.native/design-baseline/font-1.otf');assert.equal(sha(fs.readFileSync(copied)),sha(font));
  assert.equal(fs.statSync(copied).size,font.length);assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).manifestDigest,published.manifestDigest);
  fs.copyFileSync(fontPath,path.join(prototypeRoot,'second.otf'));
  input.fonts.push({...input.fonts[0],id:'second',sourcePath:'second.otf'});
  assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_limit/,'two large fonts exceed the unchanged total budget');
  const fd=fs.openSync(path.join(prototypeRoot,'too-large.otf'),'w');fs.ftruncateSync(fd,128*1024*1024+1);fs.closeSync(fd);
  input.fonts=[{...input.fonts[0],sourcePath:'too-large.otf'}];
  assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_path/,'single-file bounds reject before reading oversized sparse input');
});

for(const mode of ['changed-capture','removed-capture-root'])test(`frozen screenshot survives ${mode} while prototype sources remain bound`,t=>{
  const {args,input,prototypeRoot}=fixture(t);
  const captureRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'prd-external-capture-')));
  t.after(()=>fs.rmSync(captureRoot,{recursive:true,force:true}));
  fs.copyFileSync(path.join(prototypeRoot,'screen.png'),path.join(captureRoot,'screen.png'));input.captureRoot=captureRoot;
  const baseline=importPrdDesignBaseline(args);
  if(mode==='changed-capture')fs.writeFileSync(path.join(captureRoot,'screen.png'),'Tool scratch output changed after import');
  else fs.rmSync(captureRoot,{recursive:true,force:true});
  assert.equal(inspectPrdDesignBaseline({...args,baseline}).reference.manifestDigest,baseline.manifestDigest);
  assert.equal(publishPrdBaselineForFeature({...args,baseline,feature:'1.native'}).status,'baseline_published');
  assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).ready,true);
  const source=path.join(prototypeRoot,'index.html'),original=fs.readFileSync(source);
  fs.writeFileSync(source,'Changed source HTML');assert.throws(()=>inspectPrdDesignBaseline({...args,baseline}),/prd_baseline_source_changed/);
  fs.writeFileSync(source,original);const font=path.join(prototypeRoot,'font.woff2'),changed=fs.readFileSync(font);changed[20]^=1;fs.writeFileSync(font,changed);
  assert.throws(()=>inspectPrdDesignBaseline({...args,baseline}),/prd_baseline_source_changed/);
});

test('atomic staging opens beside the immutable asset directory and is removed after publication',t=>{
  const {args,specs}=fixture(t),open=fs.openSync,staging=[];let baseline;
  try{
    fs.openSync=function(target,flags,...rest){
      const tracked=typeof target==='string'&&path.basename(target).startsWith('.baseline-')&&flags==='wx';
      const before=tracked?fs.existsSync(target):null,fd=open.call(this,target,flags,...rest);
      if(tracked)staging.push({path:target,before,after:fs.existsSync(target)});return fd;
    };
    baseline=importPrdDesignBaseline(args);publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});
  }finally{fs.openSync=open;}
  const privateAssets=path.join(specs,path.dirname(baseline.path)),publishedAssets=path.join(specs,'1.native/design-baseline');
  assert.ok(staging.length>=8,'the hook observes actual file creation for import and projection');
  for(const record of staging){
    assert.equal(record.before,false);assert.equal(record.after,true);
    assert.ok([path.dirname(privateAssets),path.dirname(publishedAssets)].includes(path.dirname(record.path)),
      'staging must be in the asset parent, outside the immutable inventory');
    assert.equal(fs.existsSync(record.path),false,'normal publication removes only its own temporary file');
  }
  assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).ready,true);
});

test('orphan parent staging does not poison exact replay or remove user files',t=>{
  const {args,specs}=fixture(t),baseline=importPrdDesignBaseline(args);
  const privateParent=path.dirname(path.join(specs,path.dirname(baseline.path))),feature=path.join(specs,'1.native');fs.mkdirSync(feature);
  const retained=[];
  for(const parent of [privateParent,feature]){
    for(const [name,content] of [['.baseline-11111111-1111-4111-8111-111111111111','Simulated crash staging'],['user-notes.json','User work, outside immutable asset inventory']]){
      const file=path.join(parent,name);fs.writeFileSync(file,content,{mode:0o600});retained.push({file,bytes:fs.readFileSync(file)});
    }
  }
  assert.deepEqual(importPrdDesignBaseline(args),baseline);assert.equal(inspectPrdDesignBaseline({...args,baseline}).reference.ready,true);
  publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).ready,true);
  for(const item of retained)assert.deepEqual(fs.readFileSync(item.file),item.bytes,'no orphan/user cleanup is authorized');
});

// Recreate the exact inode/name relation from the real publisher's link-before-unlink window.
// No process is killed: every copied byte and link belongs to this temporary fixture.
for(const targetKind of ['private-image','private-font','private-manifest','published-image','published-manifest'])
  test(`post-link crash residue preserves ${targetKind} across inspection and exact replay`,t=>{
    const {args,specs}=fixture(t),link=fs.linkSync,pairs=[];let baseline;
    try{
      fs.linkSync=function(source,target,...rest){const result=link.call(this,source,target,...rest);
        if(typeof source==='string'&&path.basename(source).startsWith('.baseline-'))pairs.push({source,target});return result;};
      baseline=importPrdDesignBaseline(args);publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});
    }finally{fs.linkSync=link;}
    const root=targetKind.startsWith('private-')?path.join(specs,path.dirname(baseline.path)):path.join(specs,'1.native/design-baseline');
    const name=targetKind.endsWith('manifest')?'manifest.json':targetKind.endsWith('font')?'font-1.woff2':'screenshot-1.png';
    const target=path.join(root,name),pair=pairs.find(item=>item.target===target);assert.ok(pair,'capture a real staging name created by this publisher');
    assert.match(path.basename(pair.source),/^\.baseline-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.equal(path.dirname(pair.source),path.dirname(root));assert.equal(fs.existsSync(pair.source),false);
    fs.linkSync(target,pair.source);const before=fs.lstatSync(target),residue=fs.lstatSync(pair.source),bytes=fs.readFileSync(target);
    assert.equal(before.nlink,2);assert.equal(residue.nlink,2);assert.equal(before.ino,residue.ino);assert.equal(before.dev,residue.dev);
    assert.equal(inspectPrdDesignBaseline({...args,baseline}).reference.manifestDigest,baseline.manifestDigest);
    assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).ready,true,'read-only projection inspection accepts the same bounded crash residue');
    assert.deepEqual(importPrdDesignBaseline(args),baseline);
    const first=publishPrdBaselineForFeature({...args,baseline,feature:'1.native'});
    assert.deepEqual(publishPrdBaselineForFeature({...args,baseline,feature:'1.native'}),first);
    assert.equal(inspectPrdPublishedBaseline({...args,baseline,feature:'1.native'}).ready,true);
    for(const file of [target,pair.source]){assert.equal(fs.lstatSync(file).nlink,2);assert.equal(fs.lstatSync(file).ino,before.ino);assert.deepEqual(fs.readFileSync(file),bytes);}
  });

for(const mode of ['source-html','source-font','external-link','non-staging-name','invalid-staging-name','wrong-uuid-version','wrong-inode','third-link'])
  test(`crash residue exception does not permit ${mode} hard links`,t=>{
    const {args,specs,prototypeRoot}=fixture(t),uuid='.baseline-11111111-1111-4111-8111-111111111111';
    if(mode.startsWith('source-')){
      const name=mode==='source-html'?'index.html':'font.woff2',source=path.join(prototypeRoot,name);
      fs.linkSync(source,path.join(prototypeRoot,uuid));assert.equal(fs.lstatSync(source).nlink,2);
      assert.throws(()=>importPrdDesignBaseline(args),/prd_baseline_path/);return;
    }
    const baseline=importPrdDesignBaseline(args),dir=path.join(specs,path.dirname(baseline.path)),target=path.join(dir,'screenshot-1.png');
    const parent=path.dirname(dir),residue=mode==='external-link'?path.join(prototypeRoot,uuid):
      path.join(parent,mode==='non-staging-name'||mode==='wrong-inode'?'user-copy.png':mode==='invalid-staging-name'?'.baseline-not-a-uuid':mode==='wrong-uuid-version'?'.baseline-11111111-1111-5111-8111-111111111111':uuid);
    fs.linkSync(target,residue);if(mode==='wrong-inode')fs.writeFileSync(path.join(parent,uuid),'Different inode, valid staging name',{mode:0o600});if(mode==='third-link')fs.linkSync(target,path.join(parent,'another-copy.png'));
    const snapshot=fs.readFileSync(residue);assert.throws(()=>inspectPrdDesignBaseline({...args,baseline}),/prd_baseline_(path|conflict|asset_changed)/);
    assert.deepEqual(fs.readFileSync(residue),snapshot,'rejection cannot clean up unknown links');
  });
