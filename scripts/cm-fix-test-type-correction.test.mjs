import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const api=()=>import('../runtime/js/cm-fix/test-type-correction.mjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const source="type Layer = { props: { style?: object } };\nconst rows: Layer[] = [];\nconst styles = rows.map(c  => c.props.style);\n// 保留后续 JSX 与断言字节\nconst suffix = <Button />;\n";
const record=(body=source,p='src/press-feedback.spec.tsx',mode=0o640)=>({path:p,type:'file',mode,size:Buffer.byteLength(body),sha256:sha(body),contentBase64:Buffer.from(body).toString('base64')});
const options=(file=record(),extra={})=>({file,declaration:{kind:'callback-type-annotation',path:file.path,beforeSha256:file.sha256,line:3,parameter:'c',annotation:'Layer',...extra}});
function fixture(t,file=record()){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-test-type-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.dirname(path.join(root,file.path)),{recursive:true});fs.writeFileSync(path.join(root,file.path),Buffer.from(file.contentBase64,'base64'));
 fs.chmodSync(path.join(root,file.path),file.mode);return root;
}
test('annotation preserves execution emit and all unrelated bytes, including whitespace, CRLF and Unicode',async()=>{
 const {createTestTypeCorrection,inspectTestTypeCorrection}=await api();
 for(const eol of ['\n','\r\n']){
  const file=record(source.replaceAll('\n',eol)),c=createTestTypeCorrection(options(file));
  const expected=source.replace('c  =>','(c: Layer)  =>').replaceAll('\n',eol);
  assert.deepEqual(c.before,file);assert.equal(Buffer.from(c.after.contentBase64,'base64').toString(),expected);assert.equal(c.after.mode,file.mode);
  assert.equal(c.nodeVersion,process.version);
  assert.equal(c.emitSha256,sha(stripTypeScriptTypes(source.split('\n').slice(0,3).join('\n'),{mode:'transform'})));
  assert.deepEqual(inspectTestTypeCorrection(c),c);
 }
});
test('actual Wue-like complete typed helper prefix supports a structural callback annotation without React',async()=>{
 const {createTestTypeCorrection}=await api();
 const prefix="type Node = { props: { style?: object } };\nconst layers: Node[] = [];\nconst styles = layers.map(c => c.props.style);\n";
 const c=createTestTypeCorrection(options(record(prefix),{annotation:'{ props: { style?: object } }'}));
 const before=stripTypeScriptTypes(prefix,{mode:'transform'}),after=stripTypeScriptTypes(Buffer.from(c.after.contentBase64,'base64').toString(),{mode:'transform'});
 assert.equal(before,after);assert.equal(c.emitSha256,sha(before));
});
test('an explicit line allows other callbacks elsewhere and escapes dollar identifiers exactly',async()=>{
 const {createTestTypeCorrection}=await api();
 const text='const first = [1].map($c => $c);\nconst second = [2].map($c\t=> $c);\n';
 const c=createTestTypeCorrection(options(record(text),{line:2,parameter:'$c',annotation:'number'}));
 assert.equal(Buffer.from(c.after.contentBase64,'base64').toString(),text.replace('$c\t=>','($c: number)\t=>'));
});
test('declaration rejects parameter, annotation, line, kind, binding and arbitrary fields',async()=>{
 const {createTestTypeCorrection}=await api();
 for(const extra of [{parameter:'c.x'},{parameter:'c)'},{annotation:''},{annotation:'any'},{annotation:'unknown'},
  {annotation:'Layer as Other'},{annotation:'Layer /* @ts-ignore */'},{annotation:'Layer\n'},{annotation:'a'.repeat(257)},
  {annotation:'import("types").Layer'},{annotation:'typeof rows'},{annotation:'asserts c is Layer'},
  {annotation:'Layer) => { throw Error(); }; const injected = ('},{annotation:'Layer!'},
  {line:0},{line:1.5},{line:99},{kind:'other'},{beforeSha256:'f'.repeat(64)},{path:'other.spec.tsx'},{extra:true}])
  assert.throws(()=>createTestTypeCorrection(options(record(),extra)),undefined,JSON.stringify(extra));
});
test('incomplete statements, JSX prefixes, strings, comments, regex literals and duplicate parameters cannot be rewritten',async()=>{
 const {createTestTypeCorrection}=await api();
 for(const [body,line]of [
  ['function outer() {\n const a = rows.map(c => c);\n}',2],
  ['const a = <Button />;\nconst b = rows.map(c => c);',2],
  ['const text="c => literal";',1],['// c => comment',1],['/* c => comment */',1],
  ['const text=`c => template`;',1],['const re=/c => literal/;',1],
  ['const x = rows.map(c => c).map(c => c);',1],['const x=rows.map((c) => c);',1],
  ['const x=rows.map((c: Layer) => c);',1],['const x=rows.map(notc => notc);',1],
  ['const x=rows.map(λc => λc);',1],['/*\nc => comment\n*/',2],['const x=`\nc => template\n`;',2],
  ["type Label = 'c => string';",1]
 ])assert.throws(()=>createTestTypeCorrection(options(record(body),{line})),undefined,body);
});
test('only safe test suffixes are accepted; full records and exact derived output bind inspection',async()=>{
 const {createTestTypeCorrection,inspectTestTypeCorrection}=await api();
 for(const p of ['src/value.ts','src/value.tsx','../value.spec.ts','/value.test.ts','.claude/value.test.ts','node_modules/value.test.ts','AGENTS.md','src/value.spec.ts/other.ts'])
  assert.throws(()=>createTestTypeCorrection(options(record(source,p))),undefined,p);
 for(const p of ['a.spec.ts','a.spec.tsx','a.test.ts','a.test.tsx'])assert.equal(createTestTypeCorrection(options(record(source,p))).path,p);
 const c=createTestTypeCorrection(options());
 for(const mutate of [x=>x.after=record(Buffer.from(x.after.contentBase64,'base64').toString().replace('c.props.style','null')),
  x=>x.after.mode=0o600,x=>x.emitSha256='f'.repeat(64),x=>x.nodeVersion='v24.0.0',x=>x.line=2,x=>x.annotation='number',x=>x.extra=true]){
  const copy=structuredClone(c);mutate(copy);assert.throws(()=>inspectTestTypeCorrection(copy));
 }
 const malformed=record();malformed.size++;assert.throws(()=>createTestTypeCorrection(options(malformed)));
});
test('atomic apply preserves file mode, verifies exact before and supports already_applied replay',async t=>{
 const {createTestTypeCorrection,applyTestTypeCorrection,readTestTypeCorrectionFile}=await api();
 const c=createTestTypeCorrection(options()),root=fixture(t);
 assert.deepEqual(readTestTypeCorrectionFile({root,path:c.path}),c.before);
 assert.equal(applyTestTypeCorrection({root,correction:c}).outcome,'applied');
 assert.deepEqual(readTestTypeCorrectionFile({root,path:c.path}),c.after);
 assert.equal(applyTestTypeCorrection({root,correction:c}).outcome,'already_applied');
 fs.chmodSync(path.join(root,c.path),0o600);assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
 fs.writeFileSync(path.join(root,c.path),'changed');assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
});
test('read and apply reject root/parent/file symlinks and hardlinked files',async t=>{
 const {createTestTypeCorrection,applyTestTypeCorrection,readTestTypeCorrectionFile}=await api();
 const c=createTestTypeCorrection(options()),root=fixture(t),parent=path.join(root,'src'),target=path.join(root,c.path);
 fs.symlinkSync(root,root+'-link');t.after(()=>fs.unlinkSync(root+'-link'));
 assert.throws(()=>readTestTypeCorrectionFile({root:root+'-link',path:c.path}));
 fs.renameSync(parent,parent+'-real');fs.symlinkSync('src-real',parent);assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
 fs.unlinkSync(parent);fs.renameSync(parent+'-real',parent);fs.renameSync(target,target+'.original');fs.symlinkSync('press-feedback.spec.tsx.original',target);
 assert.throws(()=>applyTestTypeCorrection({root,correction:c}));fs.unlinkSync(target);fs.renameSync(target+'.original',target);
 fs.linkSync(target,target+'.link');assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
});
test('rename failure and post-fsync source drift cannot lose source or leave a temporary file',async t=>{
 const {createTestTypeCorrection,applyTestTypeCorrection}=await api(),c=createTestTypeCorrection(options());
 for(const change of ['rename','drift']){
  const root=fixture(t),directory=path.join(root,'src'),target=path.join(root,c.path),rename=fs.renameSync,sync=fs.fsyncSync;let touched=false;
  try{
   if(change==='rename')fs.renameSync=()=>{throw Object.assign(new Error('fixture'),{code:'EIO'});};
   else fs.fsyncSync=fd=>{sync(fd);if(!touched){touched=true;fs.writeFileSync(target,'concurrent bytes');}};
   assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
  }finally{fs.renameSync=rename;fs.fsyncSync=sync;}
  assert.equal(fs.readFileSync(target,'utf8'),change==='rename'?source:'concurrent bytes');assert.deepEqual(fs.readdirSync(directory),['press-feedback.spec.tsx']);
 }
});
test('temporary content or mode replacement is rejected before renaming over the source',async t=>{
 const {createTestTypeCorrection,applyTestTypeCorrection}=await api(),c=createTestTypeCorrection(options());
 for(const change of ['bytes','mode','link']){
  const root=fixture(t),directory=path.join(root,'src'),sync=fs.fsyncSync;let touched=false;
  try{
   fs.fsyncSync=fd=>{sync(fd);if(touched)return;touched=true;
    const temporary=path.join(directory,fs.readdirSync(directory).find(n=>n.startsWith('.cm-test-type-')));
    if(change==='bytes')fs.appendFileSync(temporary,'injected');
    else if(change==='mode')fs.chmodSync(temporary,0o600);
    else{fs.unlinkSync(temporary);fs.symlinkSync('press-feedback.spec.tsx',temporary);}
   };
   assert.throws(()=>applyTestTypeCorrection({root,correction:c}));
  }finally{fs.fsyncSync=sync;}
  assert.equal(fs.readFileSync(path.join(root,c.path),'utf8'),source);assert.deepEqual(fs.readdirSync(directory),['press-feedback.spec.tsx']);
 }
});
