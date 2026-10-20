import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewMaterialManifest,readReviewMaterialManifest,createReviewMaterialSession} from '../runtime/js/cm-ai/review-material.mjs';

const request=()=>{const body={version:1,invocationId:'fixture.1',identity:{repositoryId:'fixture',runId:'material',taskId:'T-001',attempt:1},role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'review',payload:{reviewPackage:{packageDigest:'a'.repeat(64)},priorReview:null}};return {...body,requestDigest:digest(body)};};
function client(session){
 const spec=JSON.parse(session.transport.mcpConfig).mcpServers.cm_review;
 const child=spawn(spec.command,spec.args,{cwd:session.transport.cwd,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let seq=0,stderr='';child.stderr.on('data',b=>{stderr+=b;});
 createInterface({input:child.stdout}).on('line',line=>{const result=JSON.parse(line);pending.get(result.id)?.(result);pending.delete(result.id);});
 child.once('close',()=>{for(const done of pending.values())done({closed:true,stderr});pending.clear();});
 return {child,call(method,params){const id=++seq;return new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},async close(){child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));}};
}
async function withSession(prompt,fn){const session=createReviewMaterialSession({prompt,request:request()});try{await fn(session);}finally{await session.close();}}
const read=async(c,page)=>{const answer=await c.call('tools/call',{name:'read_material',arguments:{page}});assert(!answer.closed);assert(!answer.result.isError);return JSON.parse(answer.result.content[0].text);};

test('pure manifest binds exact request and UTF-8 pages without splitting characters',()=>{
 const prompt='a'.repeat(16383)+'😀中文'+ 'z'.repeat(40000),manifest=reviewMaterialManifest({prompt,request:request()});
 assert.equal(manifest.promptBytes,Buffer.byteLength(prompt));assert.equal(manifest.pageBytes,16384);assert.equal(manifest.pageCount,4);
 assert.equal(manifest.requestDigest,request().requestDigest);assert.equal(manifest.packageDigest,'a'.repeat(64));
 assert.throws(()=>reviewMaterialManifest({prompt,request:{...request(),requestDigest:'0'.repeat(64)}}));
 assert.throws(()=>reviewMaterialManifest({prompt:'x'.repeat(256*16384+1),request:request()}),e=>e.code==='review_input_too_large');
 assert.throws(()=>reviewMaterialManifest({prompt:'\ud800',request:request()}));
});
test('manifest reader rejects malformed counts, missing intervals, hashes and extra fields',()=>{
 const manifest=reviewMaterialManifest({prompt:'a'.repeat(40000),request:request()});assert.deepEqual(readReviewMaterialManifest(manifest),manifest);
 for(const changed of [{...manifest,extra:true},{...manifest,pageCount:2},{...manifest,pageBytes:65536},
  {...manifest,pages:manifest.pages.map((p,i)=>i===1?{...p,offset:p.offset+1}:p)},
  {...manifest,pages:manifest.pages.map((p,i)=>i===1?{...p,sha256:'bad'}:p)},
  {...manifest,promptBytes:manifest.promptBytes+1}])assert.throws(()=>readReviewMaterialManifest(changed));
});
test('real fixed server serves every exact page and finish seals complete bound evidence',async()=>withSession('a'.repeat(16383)+'😀中文'+'z'.repeat(40000),async session=>{
 const c=client(session);try{
  const list=await c.call('tools/list');assert.deepEqual(list.result.tools.map(t=>t.name),['read_material']);
  assert.throws(()=>session.finish('thread-fixture'),e=>e.code==='review_material_incomplete');
  const chunks=[];for(let i=0;i<session.manifest.pageCount;i++)chunks.push((await read(c,i)).content);
  assert.equal(chunks.join(''),'a'.repeat(16383)+'😀中文'+'z'.repeat(40000));
  const proof=session.finish('thread-fixture');assert.equal(proof.providerThreadId,'thread-fixture');assert.equal(proof.manifestDigest,digest(session.manifest));
  assert.equal(proof.pages.length,session.manifest.pageCount);assert.deepEqual(session.finish('thread-fixture'),proof);
  assert.throws(()=>session.finish('other-thread'));
 }finally{await c.close();}
}));
test('duplicates, skipped middle pages and end-only reads cannot complete coverage',async()=>withSession('x'.repeat(40000),async session=>{
 const c=client(session);try{await read(c,2);await read(c,2);await read(c,0);assert.throws(()=>session.finish('thread-fixture'),e=>e.code==='review_material_incomplete');await read(c,1);assert.equal(session.finish('thread-fixture').pages.length,3);}finally{await c.close();}
}));
test('fixed reader rejects extra paths, wrong tools and invalid page identities',async()=>withSession('evidence',async session=>{
 const c=client(session);try{for(const args of [{page:0,path:'/tmp/anything'},{page:-1},{page:1},{page:0.5}])assert((await c.call('tools/call',{name:'read_material',arguments:args})).result.isError);
 assert((await c.call('tools/call',{name:'run_check',arguments:{page:0}})).result.isError);assert.throws(()=>session.finish('thread-fixture'));
 }finally{await c.close();}
}));
test('restart cannot reset or take over the same session coverage ledger',async()=>withSession('evidence',async session=>{
 const first=client(session);await read(first,0);await first.close();const second=client(session);try{const answer=await second.call('tools/list');assert(answer.closed);}finally{await second.close();}assert.equal(session.finish('thread-fixture').pages.length,1);
}));
test('tampered material, configuration, coverage ledger and symlink files fail closed',async()=>{
 for(const name of ['material.txt','tools.json','coverage.json'])await withSession('evidence',async session=>{
  const c=client(session);try{await read(c,0);}finally{await c.close();}
  const file=path.join(path.dirname(session.transport.cwd),name);fs.writeFileSync(file,name==='material.txt'?'different':'{}');assert.throws(()=>session.finish('thread-fixture'));
 });
 await withSession('evidence',async session=>{const root=path.dirname(session.transport.cwd),file=path.join(root,'material.txt');fs.renameSync(file,path.join(root,'retained'));fs.symlinkSync(path.join(root,'retained'),file);const c=client(session);try{assert((await c.call('tools/list')).closed);assert.throws(()=>session.finish('thread-fixture'));}finally{await c.close();}});
 await withSession('evidence',async session=>{const c=client(session);try{await read(c,0);}finally{await c.close();}const root=path.dirname(session.transport.cwd);fs.symlinkSync(path.join(root,'absent'),path.join(root,'evidence.json'));assert.throws(()=>session.finish('thread-fixture'),e=>e.code==='review_material_path');});
});
test('total tool calls stay bounded even when one page is read repeatedly',async()=>withSession('evidence',async session=>{
 const c=client(session);try{for(let i=0;i<256;i++)await read(c,0);const answer=await c.call('tools/call',{name:'read_material',arguments:{page:0}});assert(answer.result.isError);assert.throws(()=>session.finish('thread-fixture'),e=>e.code==='review_material_limit');}finally{await c.close();}
}));
test('cleanup removes only its owned directory and is idempotent',async()=>{
 const session=createReviewMaterialSession({prompt:'evidence',request:request()}),root=path.dirname(session.transport.cwd);assert(fs.existsSync(root));await session.close();await session.close();assert(!fs.existsSync(root));
});

// Regression: a fixed boundary cost must not require one call per page.
test('bounded batch transports all 231 pages with exact bytes and fewer tool boundaries',async()=>withSession('a'.repeat(3772637),async session=>{
 assert.equal(session.manifest.pageCount,231);const c=client(session);try{
  let page=0,calls=0;const chunks=[];
  while(page<session.manifest.pageCount){
   const answer=await c.call('tools/call',{name:'read_material',arguments:{page,count:8}});
   assert(!answer.result.isError,'batch must be accepted, not an invalid argument');
   const value=JSON.parse(answer.result.content[0].text);assert.equal(value.version,2);assert(value.pages.length>=1&&value.pages.length<=8);
   for(const p of value.pages){assert.equal(p.page,page++);assert.equal(p.pageSha256,session.manifest.pages[p.page].sha256);chunks.push(p.content);}
   assert.equal(value.nextPage,page<session.manifest.pageCount?page:null);calls++;
  }
  assert.equal(chunks.join(''),'a'.repeat(3772637));assert(calls<60,'231 scalar boundaries must become at most 59 bounded batches');
  const proof=session.finish('batch-thread');assert.equal(proof.version,2);assert.equal(proof.callCount,calls);assert.equal(proof.pageReadCount,231);
 }finally{await c.close();}
}));

test('batch preserves UTF-8 and worst escaped native-event envelope, with exact nextPage',async()=>{
 for(const unit of ['😀中文','"\\\n\u0000'])await withSession(unit.repeat(24000),async session=>{
  const c=client(session);try{let page=0,result='';while(page<session.manifest.pageCount){
   const response=await c.call('tools/call',{name:'read_material',arguments:{page,count:8}});assert(!response.result.isError);
   const value=JSON.parse(response.result.content[0].text);
   const native={type:'item.completed',item:{id:'fixture',type:'mcp_tool_call',server:'cm_review',tool:'read_material',result:response.result}};
   assert(Buffer.byteLength(JSON.stringify(native))<256*1024,'actual escaped native event fits the unchanged worker line');
   assert(Buffer.byteLength(JSON.stringify(response.result))<=120*1024,'serialized MCP envelope fits the unchanged tool-token bound conservatively');
   for(const p of value.pages){assert.equal(p.page,page++);result+=p.content;}
   assert.equal(value.nextPage,page<session.manifest.pageCount?page:null);
  }assert.equal(result,unit.repeat(24000));session.finish('utf-thread');}finally{await c.close();}
 });
});
test('batch skip still rejects full coverage, explicit count one is v2 and omitted count stays v1',async()=>withSession('x'.repeat(9*16384),async session=>{
 const c=client(session);try{
  const v1=await read(c,0);assert.equal(v1.version,1);
  const r=await c.call('tools/call',{name:'read_material',arguments:{page:2,count:8}});assert(!r.result.isError);
  assert.throws(()=>session.finish('skip-thread'),e=>e.code==='review_material_incomplete');
  const one=await c.call('tools/call',{name:'read_material',arguments:{page:1,count:1}});const value=JSON.parse(one.result.content[0].text);assert.equal(value.version,2);assert.equal(value.pages.length,1);
  assert.equal(session.finish('skip-thread').pages.length,9);
 }finally{await c.close();}
}));
test('batch duplicates and invalid input consume the original 256 page-attempt budget durably',async()=>withSession('x'.repeat(8*16384),async session=>{
 const c=client(session);try{
  for(const args of [{page:0,count:0},{page:0,count:9},{page:0,count:null},{page:0,count:1.5},{page:0,count:1,path:'/tmp/none'}])assert((await c.call('tools/call',{name:'read_material',arguments:args})).result.isError);
  await read(c,7);
  let pageReads=1,failures=5,calls=6;
  while(pageReads+failures+8<=256){const r=await c.call('tools/call',{name:'read_material',arguments:{page:0,count:8}});assert(!r.result.isError);const count=JSON.parse(r.result.content[0].text).pages.length;pageReads+=count;calls++;}
  // Even though all eight distinct pages were covered, another batch overflows.
  const overflow=await c.call('tools/call',{name:'read_material',arguments:{page:0,count:8}});assert(overflow.result.isError);
  const d=session.failureSnapshot();assert.equal(d.ledgerVerified,true);assert.equal(d.toolCallCount,calls+1);assert.equal(d.readPages,8);assert.equal(d.pageReadCount,pageReads);assert.equal(d.toolFailureCount,failures+1);assert.equal(d.duplicateReadCount,pageReads-8);assert(d.pageReadCount<=256,'an overflow must not charge pages never returned');
  assert.throws(()=>session.finish('limit-thread'),e=>e.code==='review_material_limit');
  assert((await c.call('tools/call',{name:'read_material',arguments:{page:0}})).result.isError);
  assert.throws(()=>session.finish('limit-thread'),e=>e.code==='review_material_limit');
 }finally{await c.close();}
}));
