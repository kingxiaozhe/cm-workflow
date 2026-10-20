import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createReviewMaterialSession,openReviewMaterialReader,REVIEW_MATERIAL_BATCH_PROFILE} from '../runtime/js/cm-ai/review-material.mjs';

const PAGE_BYTES=16384,WIRE_LIMIT=120*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');

function request(){
 const body={version:1,invocationId:'batch.fixture',identity:{repositoryId:'fixture',runId:'batch-material',taskId:'T-001',attempt:1},role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'review',payload:{reviewPackage:{packageDigest:'a'.repeat(64)},priorReview:null}};
 return {...body,requestDigest:digest(body)};
}
function client(session){
 const spec=JSON.parse(session.transport.mcpConfig).mcpServers.cm_review;
 const child=spawn(spec.command,spec.args,{cwd:session.transport.cwd,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let sequence=0;
 child.stderr.resume();
 createInterface({input:child.stdout}).on('line',line=>{
  const reply=JSON.parse(line),done=pending.get(reply.id);pending.delete(reply.id);done?.({reply,wireBytes:Buffer.byteLength(line+'\n')});
 });
 child.once('close',()=>{for(const done of pending.values())done({closed:true});pending.clear();});
 const rpc=(method,params)=>{const id=++sequence;return new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});};
 return {rpc,call(args){return rpc('tools/call',{name:'read_material',arguments:args});},async close(){child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));}};
}
async function withSession(prompt,fn){
 const session=createReviewMaterialSession({prompt,request:request()}),c=client(session);
 try{await fn(session,c);}finally{await c.close();await session.close();}
}
async function read(c,args){
 const result=await c.call(args);assert.equal(result.closed,undefined,'reader unexpectedly closed');
 assert.equal(result.reply.result.isError,undefined,'batch reader must accept the bounded count argument');
 return {...result,value:JSON.parse(result.reply.result.content[0].text)};
}
function assertBatch(session,reply,first,maximum){
 const {value,wireBytes}=reply,manifest=session.manifest;
 assert.deepEqual(Object.keys(value).sort(),['version','kind','manifestDigest','requestDigest','packageDigest','promptSha256','pageCount','totalBytes','nextPage','pages'].sort());
 assert.equal(value.version,2);assert.equal(value.kind,'cm-review-material-batch');
 assert.equal(value.manifestDigest,digest(manifest));assert.equal(value.requestDigest,manifest.requestDigest);
 assert.equal(value.packageDigest,manifest.packageDigest);assert.equal(value.promptSha256,manifest.promptSha256);
 assert.equal(value.pageCount,manifest.pageCount);assert.equal(value.totalBytes,manifest.promptBytes);
 assert(value.pages.length>=1&&value.pages.length<=maximum,'batch must contain between one and requested count complete pages');
 assert(wireBytes<=WIRE_LIMIT,'nested JSON-RPC response exceeds the unchanged 120 KiB wire budget');
 for(const [index,page] of value.pages.entries()){
  assert.deepEqual(Object.keys(page).sort(),['page','offset','end','pageSha256','content'].sort());
  const expected=manifest.pages[first+index];assert(expected,'unexpected page');
  assert.equal(page.page,expected.page);assert.equal(page.offset,expected.offset);assert.equal(page.end,expected.end);
  assert.equal(page.pageSha256,expected.sha256);assert.equal(sha(page.content),expected.sha256);
  const bytes=Buffer.from(page.content);assert.equal(bytes.length,page.end-page.offset);assert(bytes.length<=PAGE_BYTES);
  assert.equal(bytes.toString('utf8'),page.content);
 }
 assert.equal(value.nextPage,first+value.pages.length<manifest.pageCount?first+value.pages.length:null);
}
function assertProof(session,calls,pageReads){
 const proof=session.finish('batch-thread');
 assert.equal(proof.version,2);assert.equal(proof.kind,'cm-review-material-evidence');
 assert.equal(proof.manifest.version,1);assert.equal(proof.callCount,calls);assert.equal(proof.pageReadCount,pageReads);
 assert.equal(proof.manifestDigest,digest(session.manifest));assert.deepEqual(proof.pages,session.manifest.pages);
 const {evidenceDigest,...body}=proof;assert.equal(evidenceDigest,digest(body));
 return proof;
}
async function reject(c,args){
 const result=await c.call(args);assert.equal(result.closed,undefined,'invalid call must receive a bounded tool error');
 assert.equal(result.reply.result.isError,true);assert.match(result.reply.result.content[0].text,/^(review_material_[a-z_]+|invalid_input)$/);
 return result;
}

test('batch count returns four complete consecutive pages through public stdio',{timeout:10000},async()=>withSession('x'.repeat(70000),async(session,c)=>{
 const listed=await c.rpc('tools/list'),tools=listed.reply.result.tools;assert.equal(tools.length,1);assert.equal(tools[0].name,'read_material');
 const schema=tools[0].inputSchema;assert.deepEqual(schema.required,['page']);assert.equal(schema.additionalProperties,false);
 assert.equal(schema.properties.count.type,'integer');assert.equal(schema.properties.count.minimum,1);assert.equal(schema.properties.count.maximum,8);
 assert.deepEqual(REVIEW_MATERIAL_BATCH_PROFILE,{version:2,pageBytes:16384,maxPages:256,maxToolCalls:256,maxPageReadCount:256,maxBatchPages:8,toolResponseJsonBytes:120*1024,encodedJsonBytes:240*1024});
 const reply=await read(c,{page:0,count:4}),{value}=reply;assertBatch(session,reply,0,4);
 assert.equal(value.version,2);assert.equal(value.kind,'cm-review-material-batch');
 assert.deepEqual(value.pages.map(page=>page.page),[0,1,2,3]);assert.equal(value.nextPage,4);
 assert.equal(value.pages.reduce((sum,page)=>sum+Buffer.byteLength(page.content),0),4*16384);
 assert.equal(session.failureSnapshot().pageReadCount,4);
}));

test('3772637 bytes and 231 unchanged pages are delivered in exactly 58 RPCs',{timeout:20000},async()=>{
 const prompt='x'.repeat(3772637);
 await withSession(prompt,async(session,c)=>{
  assert.equal(session.manifest.version,1);assert.equal(session.manifest.pageBytes,PAGE_BYTES);
  assert.equal(session.manifest.pageCount,231);assert.equal(session.manifest.promptBytes,3772637);
  const chunks=[];let page=0,calls=0;
  while(page<session.manifest.pageCount){
   const reply=await read(c,{page,count:4});assertBatch(session,reply,page,4);
   assert.equal(reply.value.pages.length,Math.min(4,session.manifest.pageCount-page));
   chunks.push(...reply.value.pages.map(value=>value.content));page+=reply.value.pages.length;calls++;
  }
  assert.equal(calls,58);assert.equal(page,231);assert.equal(sha(chunks.join('')),sha(prompt));
  const snapshot=session.failureSnapshot();assert.equal(snapshot.toolCallCount,58);assert.equal(snapshot.pageReadCount,231);
  assert.equal(snapshot.readPages,231);assert.deepEqual(snapshot.missingPages,[]);assert.equal(snapshot.duplicateReadCount,0);
  const proof=assertProof(session,58,231);assert.deepEqual(session.finish('batch-thread'),proof);
 });
});

test('mixed UTF-8 boundaries preserve every byte and page SHA in batch responses',{timeout:10000},async()=>{
 const prompt='a'.repeat(16383)+'😀中文'+'😀中é\\\"\n'.repeat(14000);
 await withSession(prompt,async(session,c)=>{
  assert.equal(session.manifest.pages[0].end,16383);
  const chunks=[];let page=0,calls=0;
  while(page<session.manifest.pageCount){const reply=await read(c,{page,count:4});assertBatch(session,reply,page,4);chunks.push(...reply.value.pages.map(p=>p.content));page+=reply.value.pages.length;calls++;}
  assert.equal(sha(chunks.join('')),sha(prompt));assert.equal(Buffer.byteLength(chunks.join('')),Buffer.byteLength(prompt));
  assertProof(session,calls,session.manifest.pageCount);
 });
});

test('worst JSON escaping shrinks batches before 120 KiB without truncating pages',{timeout:10000},async()=>{
 const prompt='\0'.repeat(70000);
 await withSession(prompt,async(session,c)=>{
  let page=0,calls=0;const chunks=[];
  while(page<session.manifest.pageCount){
   const reply=await read(c,{page,count:4});assertBatch(session,reply,page,4);
   if(page<session.manifest.pageCount-1)assert.equal(reply.value.pages.length,1,'two complete NUL pages cannot fit the nested wire budget');
   chunks.push(...reply.value.pages.map(value=>value.content));page+=reply.value.pages.length;calls++;
  }
  assert.equal(sha(chunks.join('')),sha(prompt));assertProof(session,calls,session.manifest.pageCount);
 });
});

test('omitted count preserves the original single-page response and shares the v2 counters',{timeout:10000},async()=>withSession('z'.repeat(20000),async(session,c)=>{
 const {value}=await read(c,{page:0});
 assert.deepEqual(Object.keys(value).sort(),['version','manifestDigest','requestDigest','packageDigest','promptSha256','page','pageCount','offset','end','pageSha256','totalBytes','content'].sort());
 assert.equal(value.version,1);assert.equal(value.page,0);assert.equal(value.end,PAGE_BYTES);assert.equal(sha(value.content),session.manifest.pages[0].sha256);
 assert.equal(value.manifestDigest,digest(session.manifest));assert.equal(value.requestDigest,session.manifest.requestDigest);assert.equal(value.packageDigest,session.manifest.packageDigest);
 const last=await read(c,{page:1,count:4});assertBatch(session,last,1,4);assert.equal(last.value.nextPage,null);
 const snapshot=session.failureSnapshot();assert.equal(snapshot.toolCallCount,2);assert.equal(snapshot.pageReadCount,2);
 assertProof(session,2,2);
}));

test('invalid counts and extra inputs fail without covering or charging unseen pages',{timeout:10000},async()=>withSession('x'.repeat(70000),async(session,c)=>{
 const invalid=[{page:0,count:0},{page:0,count:-1},{page:0,count:9},{page:0,count:1.5},{page:0,count:'2'},{page:0,count:null},{page:0,count:true},{page:0,count:2,path:'/tmp/not-authorized'},{page:-1,count:2},{page:5,count:2},{count:2}];
 for(const args of invalid)await reject(c,args);
 const snapshot=session.failureSnapshot();assert.equal(snapshot.ledgerVerified,true);assert.equal(snapshot.toolCallCount,invalid.length);
 assert.equal(snapshot.pageReadCount,0);assert.equal(snapshot.readPages,0);assert.equal(snapshot.toolFailureCount,invalid.length);
 assert.deepEqual(snapshot.missingPages,[0,1,2,3,4]);assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_incomplete');
}));

test('overlap counts every returned page while missing middle pages prevent finish',{timeout:10000},async()=>withSession('x'.repeat(70000),async(session,c)=>{
 for(const page of [0,0,4]){const result=await read(c,{page,count:2});assertBatch(session,result,page,2);}
 let snapshot=session.failureSnapshot();assert.equal(snapshot.toolCallCount,3);assert.equal(snapshot.pageReadCount,5);
 assert.equal(snapshot.readPages,3);assert.equal(snapshot.duplicateReadCount,2);assert.deepEqual(snapshot.missingPages,[2,3]);
 assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_incomplete');
 const middle=await read(c,{page:2,count:2});assertBatch(session,middle,2,2);
 snapshot=session.failureSnapshot();assert.equal(snapshot.readPages,5);assert.equal(snapshot.pageReadCount,7);assert.equal(snapshot.duplicateReadCount,2);
 assertProof(session,4,7);
}));

test('material drift rejects a whole batch without covering an earlier valid page',{timeout:10000},async()=>withSession('x'.repeat(70000),async(session,c)=>{
 await read(c,{page:0,count:1});
 const file=path.join(path.dirname(session.transport.cwd),'material.txt'),original=fs.readFileSync(file),changed=Buffer.from(original);changed[50000]=121;
 fs.writeFileSync(file,changed);
 try{await reject(c,{page:1,count:4});assert.equal(session.failureSnapshot().ledgerVerified,false);assert.equal(session.failureSnapshot().pageReadCount,null);assert.throws(()=>session.finish('batch-thread'));}
 finally{fs.writeFileSync(file,original);}
 const snapshot=session.failureSnapshot();assert.equal(snapshot.ledgerVerified,true);assert.equal(snapshot.readPages,1);assert.equal(snapshot.pageReadCount,1);
 assert.deepEqual(snapshot.missingPages,[1,2,3,4]);assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_incomplete');
}));

test('256 page-read attempts remain inclusive and a crossing batch is rejected atomically',{timeout:20000},async()=>{
 await withSession('x'.repeat(4*PAGE_BYTES),async(session,c)=>{
  for(let i=0;i<64;i++)await read(c,{page:0,count:4});
  assert.equal(session.failureSnapshot().duplicateReadCount,252);assertProof(session,64,256);
 });
 await withSession('x'.repeat(4*PAGE_BYTES),async(session,c)=>{
  for(let i=0;i<63;i++)await read(c,{page:0,count:4});
  await read(c,{page:0});const before=session.failureSnapshot();assert.equal(before.pageReadCount,253);assert.equal(before.readPages,4);
  const failure=await reject(c,{page:0,count:4});assert.equal(failure.reply.result.content[0].text,'review_material_limit');
  const after=session.failureSnapshot();assert.equal(after.toolCallCount,65);assert.equal(after.pageReadCount,253);
  assert.equal(after.readPages,4);assert.equal(after.duplicateReadCount,before.duplicateReadCount);assert.equal(after.toolFailureCount,1);
  assert.equal(after.toolFailures.at(-1).code,'review_material_limit');
  assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_limit');
 });
});

test('the original 256 RPC bound includes invalid calls and refuses RPC 257',{timeout:20000},async()=>withSession('evidence',async(session,c)=>{
 for(let i=0;i<255;i++)await reject(c,{page:0,count:0});
 await read(c,{page:0});assert.equal(session.failureSnapshot().toolCallCount,256);assert.equal(session.failureSnapshot().pageReadCount,1);
 assertProof(session,256,1);
 const failure=await reject(c,{page:0,count:1});assert.equal(failure.reply.result.content[0].text,'review_material_limit');
 const snapshot=session.failureSnapshot();assert.equal(snapshot.toolCallCount,257);assert.equal(snapshot.pageReadCount,1);assert.equal(snapshot.readPages,1);
 assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_limit');
}));

test('invalid RPCs and returned batch pages share the unchanged 256 work budget',{timeout:20000},async()=>withSession('x'.repeat(4*PAGE_BYTES),async(session,c)=>{
 await reject(c,{page:0,count:0});
 for(let i=0;i<63;i++)await read(c,{page:0,count:4});
 const before=session.failureSnapshot();assert.equal(before.toolCallCount,64);assert.equal(before.pageReadCount,252);assert.equal(before.toolFailureCount,1);
 const failure=await reject(c,{page:0,count:4});assert.equal(failure.reply.result.content[0].text,'review_material_limit');
 const after=session.failureSnapshot();assert.equal(after.toolCallCount,65);assert.equal(after.pageReadCount,252);
 assert.equal(after.readPages,4);assert.equal(after.duplicateReadCount,before.duplicateReadCount);assert.equal(after.toolFailureCount,2);
 assert.equal(after.toolFailures.at(-1).code,'review_material_limit');
 assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_limit');
}));

test('failed batch ledger fsync cannot grant coverage for pages never returned',{timeout:10000},async()=>{
 const session=createReviewMaterialSession({prompt:'x'.repeat(4*PAGE_BYTES),request:request()});
 try{
  const spec=JSON.parse(session.transport.mcpConfig).mcpServers.cm_review,reader=openReviewMaterialReader(spec.args.at(-1));
  const originalFsync=fs.fsyncSync;let injected=false;
  try{
   fs.fsyncSync=function(...args){if(!injected){injected=true;throw Object.assign(new Error('fixture fsync failure'),{code:'EIO'});}return Reflect.apply(originalFsync,fs,args);};
   assert.throws(()=>reader.call('read_material',{page:0,count:4}),error=>error.code==='EIO');
  }finally{fs.fsyncSync=originalFsync;}
  assert.equal(injected,true);
  const snapshot=session.failureSnapshot();assert.equal(snapshot.ledgerVerified,true);assert.equal(snapshot.toolCallCount,1);
  assert.equal(snapshot.readPages,0);assert.equal(snapshot.pageReadCount,0);assert.equal(snapshot.duplicateReadCount,0);
  assert.equal(snapshot.toolFailureCount,1);assert.deepEqual(snapshot.missingPages,[0,1,2,3]);
  assert.throws(()=>session.finish('batch-thread'),e=>e.code==='review_material_incomplete');
 }finally{await session.close();}
});

test('published batch coverage cannot authorize proof after directory and rollback fsync fail',{timeout:10000},async()=>{
 const session=createReviewMaterialSession({prompt:'x'.repeat(4*PAGE_BYTES),request:request()});
 try{
  const spec=JSON.parse(session.transport.mcpConfig).mcpServers.cm_review,reader=openReviewMaterialReader(spec.args.at(-1));
  const originalRename=fs.renameSync,originalFsync=fs.fsyncSync;
  let published=false,directoryFailed=false,rollbackFailed=false;
  try{
   fs.renameSync=function(...args){const value=Reflect.apply(originalRename,fs,args);if(path.basename(args[1])==='coverage.json')published=true;return value;};
   fs.fsyncSync=function(fd){
    const directory=fs.fstatSync(fd).isDirectory();
    if(published&&!directoryFailed&&directory){directoryFailed=true;throw Object.assign(new Error('fixture published directory fsync failure'),{code:'EIO'});}
    if(directoryFailed&&!rollbackFailed&&!directory){rollbackFailed=true;throw Object.assign(new Error('fixture rollback file fsync failure'),{code:'EIO'});}
    return Reflect.apply(originalFsync,fs,[fd]);
   };
   assert.throws(()=>reader.call('read_material',{page:0,count:4}),error=>error.code==='EIO');
  }finally{fs.renameSync=originalRename;fs.fsyncSync=originalFsync;}
  assert.equal(published,true);assert.equal(directoryFailed,true);
  assert.throws(()=>session.finish('batch-thread'),'failed delivery must never return a complete coverage proof');
  const snapshot=session.failureSnapshot();
  assert(snapshot.ledgerVerified!==true||snapshot.readPages!==4,'failed delivery must not expose verified full coverage');
 }finally{await session.close();}
});
