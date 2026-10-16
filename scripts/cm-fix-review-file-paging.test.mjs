import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createVerificationTools} from '../runtime/js/cm-fix/review-verification.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
function fixture(t,text){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-pages-'))),cwd=path.join(root,'project');
 fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'value.mjs'),text);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const configuration={files:['value.mjs'],checks:[{id:'value',command:[process.execPath,'value.mjs']}],mutationPaths:['value.mjs'],timeoutMs:1000};
 const options={configuration,cwd,files:[{path:'value.mjs',sha256:sha(text),mode:fs.statSync(path.join(cwd,'value.mjs')).mode&511}],
  requestDigest:'a'.repeat(64),packageDigest:'b'.repeat(64),evidencePath:path.join(root,'evidence.json'),activePath:path.join(root,'active.json')};
 return {root,cwd,options,tools:createVerificationTools(options)};
}
test('read_file keeps complete small text and full-file SHA, with a terminal cursor',async t=>{
 const text='export const value="你好🌿";\n',f=fixture(t,text);
 const page=await f.tools.call('read_file',{path:'value.mjs'});
 assert.equal(page.content,text);assert.equal(page.sha256,sha(text));
 assert.equal(page.offset,0);assert.equal(page.nextOffset,null);assert.equal(page.totalBytes,Buffer.byteLength(text));
});
test('read_file reads a registered 31 KiB file in bounded pages without truncation',async t=>{
 const text='x'.repeat(31*1024),f=fixture(t,text);let offset=0,content='';
 do{const page=await f.tools.call('read_file',{path:'value.mjs',offset});
  assert.equal(page.offset,offset);assert.equal(page.sha256,sha(text));assert.equal(page.totalBytes,Buffer.byteLength(text));
  assert(Buffer.byteLength(page.content)<=16384);assert(page.content.length>0);content+=page.content;offset=page.nextOffset;
 }while(offset!==null);
 assert.equal(content,text);
});
test('read_file byte cursors preserve Chinese and supplementary Unicode at page edges',async t=>{
 const text='x'.repeat(16382)+'中🌿'.repeat(3000),f=fixture(t,text);let offset=0,content='';
 do{const page=await f.tools.call('read_file',{path:'value.mjs',offset});
  assert(Buffer.byteLength(page.content)<=16384);assert(!page.content.includes('\ufffd'));
  if(page.nextOffset!==null)assert.equal(page.nextOffset,offset+Buffer.byteLength(page.content));
  content+=page.content;offset=page.nextOffset;
 }while(offset!==null);
 assert.equal(content,text);
 await assert.rejects(f.tools.call('read_file',{path:'value.mjs',offset:16383}),{code:'review_verification_offset'});
 await assert.rejects(f.tools.call('read_file',{path:'value.mjs',offset:16386}),{code:'review_verification_offset'});
});
test('read_file supports the last page of an admitted 2 MiB file without enlarging a page',async t=>{
 const text='x'.repeat(2*1024*1024),f=fixture(t,text),offset=Buffer.byteLength(text)-100;
 const page=await f.tools.call('read_file',{path:'value.mjs',offset});
 assert.equal(page.content,'x'.repeat(100));assert.equal(page.nextOffset,null);assert.equal(page.sha256,sha(text));
 const eof=await f.tools.call('read_file',{path:'value.mjs',offset:Buffer.byteLength(text)});
 assert.equal(eof.content,'');assert.equal(eof.nextOffset,null);
});
test('empty files terminate, invalid UTF-8 cannot be silently replaced, and call budget stays bounded',async t=>{
 const empty=fixture(t,'');assert.equal((await empty.tools.call('read_file',{path:'value.mjs'})).nextOffset,null);
 const invalid=fixture(t,Buffer.from([0x61,0xf0,0x9f]));
 await assert.rejects(invalid.tools.call('read_file',{path:'value.mjs'}),{code:'review_verification_encoding'});
 const f=fixture(t,'hello');
 for(let i=0;i<32;i++)assert.equal((await f.tools.call('read_file',{path:'value.mjs'})).content,'hello');
 await assert.rejects(f.tools.call('read_file',{path:'value.mjs'}),{code:'review_verification_limit'});
});
test('read_file rejects invalid cursors, extra fields, unregistered paths and oversized input files',async t=>{
 const f=fixture(t,'value');
 for(const offset of [-1,0.5,'1',null,6,Number.MAX_SAFE_INTEGER])
  await assert.rejects(f.tools.call('read_file',{path:'value.mjs',offset}),{code:'review_verification_offset'});
 await assert.rejects(f.tools.call('read_file',{path:'value.mjs',offset:0,length:999999}));
 for(const target of ['../value.mjs','other.mjs','/value.mjs'])
  await assert.rejects(f.tools.call('read_file',{path:target,offset:0}),{code:'review_verification_path'});
 fs.writeFileSync(path.join(f.cwd,'value.mjs'),'x'.repeat(2*1024*1024+1));
 await assert.rejects(f.tools.call('read_file',{path:'value.mjs'}),{code:'review_verification_path'});
});
test('every continuation still rejects drift, links and active-command cleanup',async t=>{
 for(const change of ['content','mode','symlink','active']){
  const f=fixture(t,'x'.repeat(20000));await f.tools.call('read_file',{path:'value.mjs'});
  if(change==='content')fs.appendFileSync(path.join(f.cwd,'value.mjs'),'changed');
  if(change==='mode')fs.chmodSync(path.join(f.cwd,'value.mjs'),0o700);
  if(change==='symlink'){fs.renameSync(path.join(f.cwd,'value.mjs'),path.join(f.cwd,'other.mjs'));fs.symlinkSync('other.mjs',path.join(f.cwd,'value.mjs'));}
  if(change==='active')fs.writeFileSync(f.options.activePath,JSON.stringify({pid:123}));
  await assert.rejects(f.tools.call('read_file',{path:'value.mjs',offset:16384}),
   {code:change==='symlink'?'review_verification_path':change==='active'?'review_verification_cleanup':'review_verification_copy_drift'});
 }
});
test('MCP advertises optional bounded byte offset and default path-only requests still work',t=>{
 const f=fixture(t,'hello'),config=path.join(f.root,'tools.json');fs.writeFileSync(config,JSON.stringify(f.options));
 const messages=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_file',arguments:{path:'value.mjs'}}}];
 const result=spawnSync(process.execPath,[new URL('../runtime/js/cm-fix/review-verification-server.mjs',import.meta.url).pathname,config],
  {input:messages.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);const replies=result.stdout.trim().split('\n').map(x=>JSON.parse(x));
 const tool=replies[0].result.tools.find(x=>x.name==='read_file');
 assert.deepEqual(tool.inputSchema.required,['path']);assert.equal(tool.inputSchema.properties.offset.type,'integer');
 assert.equal(tool.inputSchema.properties.offset.minimum,0);assert.match(tool.description,/byte/i);
 assert.equal(JSON.parse(replies[1].result.content[0].text).content,'hello');
});
