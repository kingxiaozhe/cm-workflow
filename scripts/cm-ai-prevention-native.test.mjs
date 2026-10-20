import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as native from '../runtime/js/cm-ai/native-review-evidence.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const identity={repositoryId:'native-prevention',runId:'original',taskId:'T-001',attempt:2};
function fixture(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-prevention-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const [codeProject,specsDir,sourceRoot]=['code','specs','native'].map(name=>{
  const dir=path.join(root,name);fs.mkdirSync(dir);return dir;
 });
 const scope=[...Array.from({length:8},(_,i)=>`helper-${i}.json`),'target.mjs','mobile/package.json','mobile/package-lock.json'].sort();
 fs.mkdirSync(path.join(codeProject,'mobile'));
 for(const name of scope)fs.writeFileSync(path.join(codeProject,name),name==='target.mjs'?'export const value = 45;\n':'{}\n');
 fs.writeFileSync(path.join(sourceRoot,'screen.png'),png);
 const manifest={version:1,report:'Synthetic native material; rendering, physical device and visual acceptance remain unknown.',
  sourceFiles:scope.map(name=>({path:name,sha256:sha(fs.readFileSync(path.join(codeProject,name)))})),
  images:[{path:'screen.png',sha256:sha(png),size:png.length,description:'Synthetic one-pixel fixture'}]};
 const manifestFile=path.join(sourceRoot,'manifest.json'),write=()=>fs.writeFileSync(manifestFile,JSON.stringify(manifest));write();
 const profile={version:1,sourceRoot,manifest:'manifest.json'};
 const context={codeProject,specsDir,identity,scope};
 const snapshot=()=>{
  const rows=[];
  const visit=dir=>{for(const name of fs.readdirSync(dir).sort()){
   const file=path.join(dir,name),st=fs.lstatSync(file,{bigint:true});
   rows.push({path:path.relative(root,file),mode:String(st.mode),mtime:String(st.mtimeNs),size:String(st.size),
    sha256:st.isFile()?sha(fs.readFileSync(file)):null});
   if(st.isDirectory())visit(file);
  }};visit(root);return rows;
 };
 return {root,sourceRoot,manifestFile,manifest,write,profile,context,snapshot};
}

test('eleven-file native candidate inspection verifies current and projected hashes without archives or writes',t=>{
 const f=fixture(t),before=f.snapshot();
 const result=native.inspectNativeReviewEvidence(f.profile,f.context);
 assert.equal(result.readOnly,true);assert.equal(result.integrityOnly,true);assert.equal(result.renderingUnknown,true);
 assert.deepEqual(result.scope,f.context.scope);assert.deepEqual(result.sourceFiles,f.manifest.sourceFiles);
 assert.equal(result.manifestDigest,sha(fs.readFileSync(f.manifestFile)));
 assert.deepEqual(result.material,{version:1,report:f.manifest.report,sourceFiles:f.manifest.sourceFiles,images:f.manifest.images});
 assert.equal(Object.hasOwn(result.material,'binaryAssets'),false);assert.equal(Object.hasOwn(result,'outcome'),false);
 assert(Object.isFrozen(result.material.images));assert.deepEqual(f.snapshot(),before);
 assert.equal(fs.existsSync(path.join(f.context.specsDir,'.reviews')),false);
 f.manifest.sourceFiles.find(row=>row.path==='target.mjs').sha256=sha(Buffer.from('projected final correction\n'));f.write();
 const projected=f.snapshot(),sourceFiles=structuredClone(f.manifest.sourceFiles);
 assert.deepEqual(native.inspectNativeReviewEvidence(f.profile,{...f.context,sourceFiles}).sourceFiles,sourceFiles);
 assert.throws(()=>native.inspectNativeReviewEvidence(f.profile,{...f.context,sourceFiles:null}),{code:'native_evidence_sources'});
 assert.throws(()=>native.inspectNativeReviewEvidence(f.profile,{...f.context,sourceFiles:sourceFiles.slice(1)}),{code:'native_evidence_scope'});
 assert.deepEqual(f.snapshot(),projected,'projection reads never apply candidate source bytes');
 assert.throws(()=>native.inspectNativeReviewEvidence(f.profile,f.context),{code:'native_evidence_source_changed'});
});

test('native readiness rejects absent or malformed evidence and stale candidate hashes through shared capture validation',t=>{
 const f=fixture(t),inspect=()=>native.inspectNativeReviewEvidence(f.profile,f.context);
 fs.renameSync(f.manifestFile,f.manifestFile+'.saved');
 let before=f.snapshot();assert.throws(inspect,{code:'ENOENT'});assert.deepEqual(f.snapshot(),before);
 fs.renameSync(f.manifestFile+'.saved',f.manifestFile);
 f.manifest.report='';f.write();before=f.snapshot();assert.throws(inspect,{code:'native_evidence_report'});assert.deepEqual(f.snapshot(),before);
 f.manifest.report='Synthetic provenance';f.manifest.sourceFiles[0].sha256='0'.repeat(64);f.write();
 before=f.snapshot();assert.throws(inspect,{code:'native_evidence_source_changed'});
 assert.throws(()=>native.captureNativeReviewEvidence(f.profile,f.context),{code:'native_evidence_source_changed'});
 assert.deepEqual(f.snapshot(),before,'capture rejects the same stale material before publishing blobs');
 f.manifest.sourceFiles=f.context.scope.map(name=>({path:name,sha256:sha(fs.readFileSync(path.join(f.context.codeProject,name)))}));
 const invalid=Buffer.from('not PNG');fs.writeFileSync(path.join(f.sourceRoot,'screen.png'),invalid);
 Object.assign(f.manifest.images[0],{sha256:sha(invalid),size:invalid.length});f.write();
 before=f.snapshot();assert.throws(inspect,{code:'native_evidence_png'});
 assert.throws(()=>native.captureNativeReviewEvidence(f.profile,f.context),{code:'native_evidence_png'});
 assert.deepEqual(f.snapshot(),before);assert.equal(fs.existsSync(path.join(f.context.specsDir,'.reviews')),false);
});

// The real driver must perform this check before a host can consume develop.
test('driver validates declared native candidate before host dispatch and preserves original files on refusal',t=>{
 const f=fixture(t),answers=path.join(f.root,'answers');fs.mkdirSync(answers);
 const final=Buffer.from('export const value = 46;\n');fs.writeFileSync(path.join(answers,'final.mjs'),final);
 const invoke=()=>spawnSync(process.execPath,['--input-type=module','-e',`
 import {preflightDevelopDeliveries} from ${JSON.stringify(new URL('./cm-ai-drive.mjs',import.meta.url).href)};
 const cfg=JSON.parse(process.env.CM_PREVENTION_FIXTURE);
 preflightDevelopDeliveries({...cfg,deliveries:[{file:'develop-a2.json',attempt:2,value:{status:'succeeded',
 value:{outcome:'implemented',retrospective:{status:'no_new_lesson'}},edits:{'target.mjs':'final.mjs'}}}]});
 process.stdout.write('ready-before-host');`],{encoding:'utf8',env:{...process.env,CM_PREVENTION_FIXTURE:JSON.stringify({answersRoot:answers,codeProject:f.context.codeProject,
 scope:f.context.scope,requirements:[],nativeEvidence:f.profile,nativeContext:f.context})}});
 const before=f.snapshot(),bad=invoke();assert.equal(bad.status,2,bad.stderr);
 assert.match(bad.stderr,/native_evidence_source_changed/);assert.doesNotMatch(bad.stdout,/ready-before-host/);
 assert.deepEqual(f.snapshot(),before);assert.equal(fs.existsSync(path.join(f.context.specsDir,'.reviews')),false);
 f.manifest.sourceFiles.find(row=>row.path==='target.mjs').sha256=sha(final);f.write();
 const ready=f.snapshot(),good=invoke();assert.equal(good.status,0,good.stderr);assert.equal(good.stdout,'ready-before-host');
 assert.deepEqual(f.snapshot(),ready);assert.equal(fs.existsSync(path.join(f.context.specsDir,'.reviews')),false);
});
