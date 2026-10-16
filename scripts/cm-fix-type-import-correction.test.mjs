import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const api=()=>import('../runtime/js/cm-fix/type-import-correction.mjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const source="import { Marker, value } from './types.ts';\nconst result: Marker = value;\nif(result!==7)throw new Error('value changed');\n";
const record=(body=source,p='main.ts',mode=0o640)=>({path:p,type:'file',mode,size:Buffer.byteLength(body),sha256:sha(body),contentBase64:Buffer.from(body).toString('base64')});
const options=(file=record())=>({file,declaration:{kind:'type-import-split',path:file.path,beforeSha256:file.sha256,typeNames:['Marker']},scope:[file.path],
  verification:{files:[file.path],checks:[{id:'unit',command:['node','main.ts']}],mutationPaths:[file.path],timeoutMs:1000},
  reviewPackage:{packageDigest:'a'.repeat(64),files:[file]}});
function fixture(t,file=record()){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-type-import-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.dirname(path.join(root,file.path)),{recursive:true});
  fs.writeFileSync(path.join(root,file.path),Buffer.from(file.contentBase64,'base64'));fs.chmodSync(path.join(root,file.path),file.mode);
  return root;
}
test('split retains module, names, mode and all non-import bytes',async()=>{
  const {createTypeImportCorrection,inspectTypeImportCorrection}=await api();
  for(const eol of ['\n','\r\n']){
    const input=record(source.replaceAll('\n',eol)),c=createTypeImportCorrection(options(input));
    assert.deepEqual(c.before,input);assert.equal(c.after.mode,input.mode);
    assert.equal(Buffer.from(c.after.contentBase64,'base64').toString(),`import type { Marker } from './types.ts';${eol}import { value } from './types.ts';${eol}`+source.split('\n').slice(1).join(eol));
    assert.deepEqual(inspectTypeImportCorrection(c),c);
  }
});
test('complex, ambiguous and non-code import shapes are refused',async()=>{
  const {createTypeImportCorrection}=await api();
  for(const line of ["import { Marker as M, value } from './types.ts';", "import { Marker, /* note */ value } from './types.ts';", "import { Marker,\nvalue } from './types.ts';", "import defaultValue, { Marker, value } from './types.ts';", "import * as values from './types.ts';", "import type { Marker, value } from './types.ts';", "import { type Marker, value } from './types.ts';", "import { Marker, value } from './types.ts'", "import { Marker, value } from './types.ts' with { type: 'json' };", "/*\nimport { Marker, value } from './types.ts';\n*/", "const text=`\nimport { Marker, value } from './types.ts';\n`;", "import { Marker, Marker, value } from './types.ts';"])
    assert.throws(()=>createTypeImportCorrection(options(record(line+'\n'))),undefined,line);
});
test('type names must be an explicit unique nonempty proper subset',async()=>{
  const {createTypeImportCorrection}=await api();
  for(const names of [[],['Marker','Marker'],['unknown'],['Marker','value'],['Marker as M'],['类型']]){
    const o=options();o.declaration.typeNames=names;assert.throws(()=>createTypeImportCorrection(o));
  }
});
test('scope, verification lists, package snapshot and declaration bind the file',async()=>{
  const {createTypeImportCorrection}=await api();
  for(const change of [o=>o.scope=['other.ts'],o=>o.verification.files=['other.ts'],o=>o.verification.mutationPaths=['other.ts'],o=>o.reviewPackage.files=[],o=>o.reviewPackage.files=[record('different')],o=>o.declaration.beforeSha256='f'.repeat(64),o=>o.declaration.path='other.ts']){
    const o=options();change(o);assert.throws(()=>createTypeImportCorrection(o));
  }
  assert.throws(()=>createTypeImportCorrection(options(record(source,'types.d.ts'))));
});
test('inspection rederives after and refuses body, mode or metadata tampering',async()=>{
  const {createTypeImportCorrection,inspectTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options());
  for(const change of [x=>x.after=record(Buffer.from(x.after.contentBase64,'base64').toString().replace('!==7','!==8')),x=>x.after.mode=0o600,x=>x.path='other.ts',x=>x.typeNames=['value'],x=>x.extra=true]){
    const x=structuredClone(c);change(x);assert.throws(()=>inspectTypeImportCorrection(x));
  }
});
test('atomic apply preserves mode and reports only file-level idempotence',async t=>{
  const {createTypeImportCorrection,applyTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options()),root=fixture(t);
  assert.equal(applyTypeImportCorrection({root,correction:c}).outcome,'applied');
  assert.equal(fs.readFileSync(path.join(root,c.path),'base64'),c.after.contentBase64);
  assert.equal(fs.statSync(path.join(root,c.path)).mode&0o7777,c.after.mode);
  assert.equal(applyTypeImportCorrection({root,correction:c}).outcome,'already_applied');
  fs.chmodSync(path.join(root,c.path),0o600);assert.throws(()=>applyTypeImportCorrection({root,correction:c}));
});
test('apply rejects parent/file symlinks and multiply linked source files',async t=>{
  const {createTypeImportCorrection,applyTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options(record(source,'src/main.ts'))),root=fixture(t,c.before);
  const original=path.join(root,'src');fs.renameSync(original,path.join(root,'real'));fs.symlinkSync('real',original);
  assert.throws(()=>applyTypeImportCorrection({root,correction:c}));fs.unlinkSync(original);fs.renameSync(path.join(root,'real'),original);
  const file=path.join(original,'main.ts');fs.renameSync(file,file+'.original');fs.symlinkSync('main.ts.original',file);
  assert.throws(()=>applyTypeImportCorrection({root,correction:c}));fs.unlinkSync(file);fs.renameSync(file+'.original',file);
  fs.linkSync(file,file+'.link');assert.throws(()=>applyTypeImportCorrection({root,correction:c}));
});
test('failure before rename preserves source and removes the temporary file',async t=>{
  const {createTypeImportCorrection,applyTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options()),root=fixture(t),rename=fs.renameSync;
  try{fs.renameSync=()=>{throw Object.assign(new Error('synthetic interruption'),{code:'EIO'});};assert.throws(()=>applyTypeImportCorrection({root,correction:c}));}
  finally{fs.renameSync=rename;}
  assert.equal(fs.readFileSync(path.join(root,c.path),'base64'),c.before.contentBase64);assert.deepEqual(fs.readdirSync(root),['main.ts']);
});
test('source drift after temporary fsync is rejected before rename',async t=>{
  const {createTypeImportCorrection,applyTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options()),root=fixture(t),sync=fs.fsyncSync;let touched=false;
  try{fs.fsyncSync=fd=>{sync(fd);if(!touched){touched=true;fs.writeFileSync(path.join(root,c.path),'concurrent user bytes');}};assert.throws(()=>applyTypeImportCorrection({root,correction:c}));}
  finally{fs.fsyncSync=sync;}
  assert.equal(fs.readFileSync(path.join(root,c.path),'utf8'),'concurrent user bytes');assert.deepEqual(fs.readdirSync(root),['main.ts']);
});
test('native type-strip fixture fails before split and runs the same value check afterward',{skip:Number(process.versions.node.split('.')[0])<24},async t=>{
  const {createTypeImportCorrection,applyTypeImportCorrection}=await api();
  const c=createTypeImportCorrection(options()),root=fixture(t);
  fs.writeFileSync(path.join(root,'types.ts'),'export type Marker = number; export const value = 7;\n');
  const run=()=>spawnSync(process.execPath,['--experimental-strip-types','main.ts'],{cwd:root,encoding:'utf8',timeout:5000});
  const before=run();assert.equal(before.status,1);assert.match(before.stderr,/does not provide an export named 'Marker'/);
  applyTypeImportCorrection({root,correction:c});const after=run();assert.equal(after.status,0,after.stderr);
});
