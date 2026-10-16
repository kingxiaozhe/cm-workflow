import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createReviewVerificationSession,createVerificationTools,verifyReviewVerificationBaseline} from '../runtime/js/cm-fix/review-verification.mjs';
import {readReviewVerification} from '../runtime/js/cm-fix/review-verification-contract.mjs';
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-verification-')));
 fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;\n');
 fs.writeFileSync(path.join(root,'value.test.mjs'),"import {value} from './value.mjs'; if(value!==1)process.exit(1);\n");
 const config={files:['value.mjs','value.test.mjs'],checks:[{id:'value',command:[process.execPath,'value.test.mjs']}],mutationPaths:['value.mjs'],timeoutMs:10000};
 return {root,config,request:{requestDigest:'a'.repeat(64),provider:'claude',payload:{reviewPackage:{packageDigest:'b'.repeat(64),files:[]}}}};
}
test('verification profile rejects traversal, secrets, test mutations and arbitrary fields',()=>{
 const f=fixture();try{assert.deepEqual(readReviewVerification(f.config),f.config);
 for(const p of ['../x','.env','.git/config','a/../x'])assert.throws(()=>readReviewVerification({...f.config,files:[p]}));
 assert.throws(()=>readReviewVerification({...f.config,mutationPaths:['value.test.mjs']}));
 assert.throws(()=>readReviewVerification({...f.config,extra:true}));
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('isolated session mechanically runs baseline, killed mutation and restoration without changing source', {skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
 s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
 assert.notEqual(s.cwd,f.root);
 assert.throws(()=>s.finish('fresh-review'),/review_verification/);
 const check=await s.call('run_check',{id:'value'});assert.equal(check.exitCode,0);
 const mutation=await s.call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=2',checkId:'value'});assert.equal(mutation.killed,true);
 const e=s.finish('fresh-review');assert.equal(e.mutations.length,1);assert.equal(e.checks.length,1);
 assert.equal(fs.readFileSync(path.join(f.root,'value.mjs'),'utf8'),'export const value=1;\n');
 assert.equal(fs.readFileSync(path.join(s.cwd,'value.mjs'),'utf8'),'export const value=1;\n');
 await assert.rejects(s.call('mutate_check',{path:'value.test.mjs',find:'1',replace:'2',checkId:'value'}));
 fs.writeFileSync(path.join(f.root,'value.mjs'),'changed');assert.throws(()=>s.finish('fresh-review'),/drift/);
 }finally{await s?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('snapshot rejects source links and package mismatch before tools start',{skip:process.platform!=='darwin'},()=>{
 const f=fixture();try{
 fs.symlinkSync('value.mjs',path.join(f.root,'link.mjs'));
 assert.throws(()=>createReviewVerificationSession({codeProject:f.root,configuration:{...f.config,files:[...f.config.files,'link.mjs']},request:f.request}));
 assert.throws(()=>createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:{...f.request,payload:{reviewPackage:{...f.request.payload.reviewPackage,files:[{path:'value.mjs',sha256:'0'.repeat(64)}]}}}}),/binding/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('package binding covers requirements, instructions and modes; absent future slots stay absent',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();try{
  const {createHash}=await import('node:crypto');const h=createHash('sha256').update(fs.readFileSync(path.join(f.root,'value.mjs'))).digest('hex');
  for(const record of [{requirements:[{path:'value.mjs',sha256:'0'.repeat(64),mode:420}]},{instructions:[{path:'value.mjs',sha256:'0'.repeat(64),mode:420}]},{files:[{path:'value.mjs',sha256:h,mode:493}]}]){
   assert.throws(()=>createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:{...f.request,payload:{reviewPackage:{...f.request.payload.reviewPackage,...record}}}}),/binding/);
  }
  const s=createReviewVerificationSession({codeProject:f.root,configuration:{...f.config,files:[...f.config.files,'future.mjs']},request:f.request});
  assert.equal(fs.existsSync(path.join(s.cwd,'future.mjs')),false);await s.close();
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('a later failed mutation baseline invalidates earlier successful evidence',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
  s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
  let laterFailure=false;
  const tools=createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath)),runCommand:async()=>{
   const failed=laterFailure||fs.readFileSync(path.join(s.cwd,'value.mjs'),'utf8').includes('value=2');
   return {outcome:failed?'failed':'passed',exitCode:failed?1:0,code:null,output:'synthetic'};
  }});
  await tools.call('run_check',{id:'value'});
  assert.equal((await tools.call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=2',checkId:'value'})).killed,true);
  s.finish('fresh-review');laterFailure=true;
  await assert.rejects(tools.call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=3',checkId:'value'}),/baseline_failed/);
  assert.throws(()=>s.finish('fresh-review'),/review_verification/);
 }finally{await s?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
test('each command removes unregistered artifacts before reusing the snapshot',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();let s;try{
  fs.writeFileSync(path.join(f.root,'value.test.mjs'),`import fs from 'node:fs';import {value} from './value.mjs';if(fs.existsSync('.cache'))process.exit(3);fs.writeFileSync('.cache','residue');if(value!==1)process.exit(1);`);
  s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
  assert.equal((await s.call('run_check',{id:'value'})).exitCode,0);
  assert.equal(fs.existsSync(path.join(s.cwd,'.cache')),false);
  assert.equal((await s.call('run_check',{id:'value'})).exitCode,0);
  assert.equal((await s.call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=2',checkId:'value'})).killed,true);
  s.finish('fresh-review');
 }finally{await s?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('host closes a registered command group after its MCP server is killed',{skip:process.platform!=='darwin'},async()=>{
 const {spawn}=await import('node:child_process');
 const f=fixture();let s,server,pid;
 try{
  fs.writeFileSync(path.join(f.root,'value.test.mjs'),"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
  server=spawn(process.execPath,[new URL('../runtime/js/cm-fix/review-verification-server.mjs',import.meta.url).pathname,s.configPath],{stdio:['pipe','pipe','pipe'],detached:true});
  server.stdout.resume();server.stderr.resume();
  server.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_check',arguments:{id:'value'}}})+'\n');
  const active=path.join(path.dirname(s.cwd),'active-command.json'),until=Date.now()+5000;
  while(!fs.existsSync(active)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert(fs.existsSync(active),'command must be registered before termination');pid=JSON.parse(fs.readFileSync(active,'utf8')).pid;
  const closed=new Promise(r=>server.once('close',r));process.kill(-server.pid,'SIGKILL');await closed;
  await s.close();s=null;
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{
  if(server?.pid)try{process.kill(-server.pid,'SIGKILL');}catch{}
  if(pid)try{process.kill(-pid,'SIGKILL');}catch{}
  await s?.close();fs.rmSync(f.root,{recursive:true,force:true});
 }
});

test('unknown cleanup retains the private directory and reports it without claiming success',{skip:process.platform!=='darwin'},async t=>{
 const f=fixture();let s;
 try{
  s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
  const active=path.join(path.dirname(s.cwd),'active-command.json');fs.writeFileSync(active,JSON.stringify({pid:2147483646}));
  const messages=[];const kill=t.mock.method(process,'kill',()=>true),stderr=t.mock.method(process.stderr,'write',chunk=>{messages.push(String(chunk));return true;});
  try{await assert.rejects(s.close(),{code:'process_cleanup_unknown'});assert(fs.existsSync(s.cwd));assert(messages.some(s=>s.includes('retainedDirectory')));}
  finally{kill.mock.restore();stderr.mock.restore();fs.rmSync(active,{force:true});}
 }finally{await s?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});


test('unknown command cleanup prevents later tools and evidence from replacing the active group',{skip:process.platform!=='darwin'},async t=>{
 const f=fixture();let s,active;
 try{
  s=createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});
  active=path.join(path.dirname(s.cwd),'active-command.json');let calls=0;
  const tools=createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath)),runCommand:async({onSpawn})=>{
   calls++;onSpawn(2147483646);return {exitCode:null,outcome:'unavailable',code:'verification_cleanup_unknown',output:''};
  }});
  assert.equal((await tools.call('run_check',{id:'value'})).code,'verification_cleanup_unknown');
  const saved=fs.readFileSync(active);
  await assert.rejects(tools.call('run_check',{id:'value'}),{code:'review_verification_cleanup'});
  await assert.rejects(tools.call('read_file',{path:'value.mjs'}),{code:'review_verification_cleanup'});
  assert.equal(calls,1);assert.deepEqual(fs.readFileSync(active),saved);
  assert.throws(()=>s.finish('fresh-review'),{code:'review_verification_cleanup'});
  const kill=t.mock.method(process,'kill',()=>true),stderr=t.mock.method(process.stderr,'write',()=>true);
  try{await assert.rejects(s.close(),{code:'process_cleanup_unknown'});assert(fs.existsSync(s.cwd));assert.deepEqual(fs.readFileSync(active),saved);}
  finally{kill.mock.restore();stderr.mock.restore();}
 }finally{if(active)fs.rmSync(active,{force:true});await s?.close();fs.rmSync(f.root,{recursive:true,force:true});}
});


test('fixed verification baseline observes cancellation instead of waiting for command timeout',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture(),controller=new AbortController();
 f.config.checks=[{id:'long',command:[process.execPath,'-e','setTimeout(()=>{},10000)']}];f.config.timeoutMs=2000;
 const timer=setTimeout(()=>controller.abort(),100);
 try{
  await assert.rejects(verifyReviewVerificationBaseline({codeProject:f.root,configuration:f.config,reviewPackage:f.request.payload.reviewPackage,signal:controller.signal}),error=>{
   assert.equal(error.verificationDiagnostic.code,'verification_cancelled');return true;
  });
 }finally{clearTimeout(timer);fs.rmSync(f.root,{recursive:true,force:true});}
});
