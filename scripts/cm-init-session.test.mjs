import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const analyzed={status:'analyzed',selection:{versionControl:'none',modules:[],analysis:'Synthetic local project'},
  evidence:'Synthetic source observation',noGitDecision:'explicit_user_refusal'};
const checks=status=>({checks:Object.fromEntries(['commands','globs','file_references','constraint_preservation','rule_applicability']
  .map(category=>[category,{status,evidence:'Synthetic fixture evidence'}])),constraintChanges:[]});
const receipt=(message,result)=>({...message.payload.recovery,result,evidence:'Synthetic original host output reference'});
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-session-'))),project=path.join(dir,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# Synthetic project\n');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,project,file:path.join(dir,'init.json')};
}
async function client(t,f,respond,{author='author-a',allowWrite=false}={}){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-init-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-init'),
    '--project',f.project,...(author===null?[]:['--host-context',author]),...(allowWrite?['--allow-write']:[]),'--session-file',f.file],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
  let sessionId,seq=0,stderr='';const pending=new Map(),closed=once(child,'close');
  let acceptReady,rejectReady;const ready=new Promise((yes,no)=>{acceptReady=yes;rejectReady=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',bytes=>stderr+=bytes);
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;acceptReady();}
    else if(message.type==='host_request')Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(rejectReady);
    else if(pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)rejectReady(Error(stderr));for(const resolve of pending.values())resolve({closed:code});pending.clear();});
  await ready;
  return {child,request:(operation,fields={})=>new Promise(resolve=>{
    const requestId=`request-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});}),
    close:async()=>{send({type:'host_close',sessionId});const [code]=await closed;assert.equal(code,0,stderr);}};
}
function reply(message){
  if(message.kind==='init_analyze')return analyzed;
  if(message.kind==='init_generate')return {status:'generated',documents:message.payload.targets.map(file=>({path:file,content:'# Synthetic rules\n'}))};
  if(message.kind==='init_verify')return checks('verified');
  if(message.kind==='init_confirm')return {decision:'approved'};
  if(message.kind==='init_review')return {reviewer:'codex-subagent',contextId:'reviewer-fixture',independent:true,at:new Date().toISOString(),
    result:{verdict:'approved',packageDigest:message.payload.package.packageDigest,examinedPaths:message.payload.package.examinedPaths,findings:[],summary:'Synthetic independent review'}};
  assert.fail('unexpected host call '+message.kind);
}
test('new CLI processes retain analysis, draft, blocked verification and revision; no recovered write permission',{timeout:10000},async t=>{
  const f=fixture(t),calls=[];let verifyCount=0;
  fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# Original constraint\n');
  const respond=message=>{calls.push(message.kind);if(message.kind==='init_verify')return {...checks(++verifyCount===1?'unverified':'verified'),constraintChanges:['AGENTS.md']};return reply(message);};
  let c=await client(t,f,respond,{allowWrite:true});assert.equal((await c.request('start')).result.stage,'analysis_ready');await c.close();
  c=await client(t,f,respond);assert.equal((await c.request('status')).result.analysisResult.selection.analysis,analyzed.selection.analysis);
  assert.equal((await c.request('advance')).result.status,'draft_generated');await c.close();
  c=await client(t,f,respond);const documents=(await c.request('status')).result.result.documents;
  assert.equal((await c.request('advance')).result.stage,'verification_blocked');await c.close();
  c=await client(t,f,respond);assert.equal((await c.request('status')).result.stage,'verification_blocked');
  assert.equal((await c.request('prepare_revision',{documents})).result.stage,'draft_generated');await c.close();
  c=await client(t,f,respond,{author:'author-b'});assert.equal((await c.request('status')).result.revisionHistory.length,1);
  assert.equal((await c.request('advance')).result.stage,'confirmation_required');await c.close();
  c=await client(t,f,respond,{author:'author-b'});assert.equal((await c.request('status')).result.verification.constraintChanges[0],'AGENTS.md');
  assert.equal((await c.request('advance')).result.stage,'review_required');await c.close();
  c=await client(t,f,respond,{author:'author-c'});assert.equal((await c.request('advance')).result.stage,'reviewed_draft');await c.close();
  c=await client(t,f,()=>assert.fail('write permission must not resume'));
  assert.equal((await c.request('resume',{resolution:null})).result.stage,'reviewed_draft');
  assert.ok((await c.request('advance')).error);await c.close();
  assert.deepEqual(calls,['init_analyze','init_generate','init_verify','init_verify','init_confirm','init_review']);
  assert.deepEqual(fs.readdirSync(f.project),['AGENTS.md','README.md']);assert.equal(fs.statSync(f.file).mode&0o777,0o600);
  assert.equal(fs.readFileSync(path.join(f.project,'AGENTS.md'),'utf8'),'# Original constraint\n');
});
test('SIGKILL pending analysis/generation/verification resumes original results once, wrong receipts and target drift block',{timeout:10000},async t=>{
  const f=fixture(t);let original,c;
  for(const kind of ['init_analyze','init_generate','init_verify']){
    c=await client(t,f,(message,child)=>{assert.equal(message.kind,kind);original=message;setImmediate(()=>child.kill('SIGKILL'));});
    await c.request(kind==='init_analyze'?'start':'advance');
    c=await client(t,f,()=>assert.fail('unknown must never redispatch'));
    assert.ok((await c.request('advance')).error);assert.ok((await c.request('resume',{resolution:null})).error);
    assert.equal((await c.request('status')).result.recovery.call.kind,kind);
    assert.ok((await c.request('resume',{resolution:{...receipt(original,reply(original)),requestDigest:'0'.repeat(64)}})).error);
    if(kind==='init_verify'){
      // Same raw result remains recorded even when applying it is blocked by drift.
      fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# User-owned change\n');
      assert.ok((await c.request('resume',{resolution:receipt(original,reply(original))})).error);
      assert.equal((await c.request('status')).result.recovery.call.status,'recorded');
      assert.equal(fs.readFileSync(path.join(f.project,'AGENTS.md'),'utf8'),'# User-owned change\n');
      fs.unlinkSync(path.join(f.project,'AGENTS.md')); // restore only this fixture's known change
      assert.equal((await c.request('resume',{resolution:null})).result.stage,'review_required');
    }else assert.ok((await c.request('resume',{resolution:receipt(original,reply(original))})).result);
    await c.close();
  }
});
test('original review identity survives new author; cancellation and unknown write stay terminal',{timeout:10000},async t=>{
  const f=fixture(t);let original;
  let c=await client(t,f,reply);await c.request('start');await c.request('advance');await c.request('advance');await c.close();
  c=await client(t,f,(message,child)=>{original=message;setImmediate(()=>child.kill('SIGKILL'));});await c.request('advance');
  c=await client(t,f,()=>assert.fail('review must not redispatch'),{author:'author-b',allowWrite:true});
  assert.equal((await c.request('resume',{resolution:receipt(original,reply(original))})).result.stage,'reviewed_draft');await c.close();
  c=await client(t,f,(message,child)=>{assert.equal(message.kind,'init_write');setImmediate(()=>child.kill('SIGKILL'));},{allowWrite:true});
  await c.request('advance');
  c=await client(t,f,()=>assert.fail('unknown write must not redispatch'),{allowWrite:true});
  assert.equal((await c.request('status')).result.recovery.writing,true);
  assert.ok((await c.request('resume',{resolution:null})).error);await c.request('cancel');await c.close();
  c=await client(t,f,()=>assert.fail('cancelled must not call host'));
  assert.equal((await c.request('status')).result.stage,'cancelled');assert.ok((await c.request('resume',{resolution:null})).error);await c.close();
  assert.equal(fs.existsSync(path.join(f.project,'AGENTS.md')),false);
  assert.equal(fs.readdirSync(path.join(f.project,'.reviews')).length,1);
});
test('private recovery refuses anonymous authors before revision or checkpoint writes',{timeout:5000},async t=>{
  const f=fixture(t);
  let c=await client(t,f,message=>message.kind==='init_verify'?checks('unverified'):reply(message));
  await c.request('start');await c.request('advance');await c.request('advance');await c.close();
  const before=fs.readFileSync(f.file);
  await assert.rejects(()=>client(t,f,()=>assert.fail('anonymous author must not dispatch'),{author:null}),/init_session_host_context_required/);
  assert.ok(fs.readFileSync(f.file).equals(before));
  c=await client(t,f,()=>assert.fail('status must not dispatch'),{author:'author-b'});
  const documents=(await c.request('status')).result.result.documents.map(document=>({...document,content:document.content+'Specific revision\n'}));
  assert.equal((await c.request('prepare_revision',{documents})).result.stage,'draft_generated');await c.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')).checkpoint.authorContexts,['author-a','author-b']);
});
