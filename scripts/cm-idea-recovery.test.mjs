import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {openIdeaSession} from '../runtime/js/cm-idea/session.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const draft=maturity=>({status:'draft',content:'# Synthetic '+maturity,maturity,productType:'B',followup:'What should change?'});
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-recovery-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file:path.join(dir,'interview.json')};}
async function client(t,{dir,file},respond){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-idea-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-idea'),
    '--session-file',file],{cwd:dir,stdio:['pipe','pipe','pipe']});
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
    const requestId=`test-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});}),
    close:async()=>{send({type:'host_close',sessionId});const [code]=await closed;assert.equal(code,0,stderr);}};
}
test('actual new processes retain question, L1/L2 draft and save root without replaying interview',async t=>{
  const f=fixture(t);let calls=0,decisions=0;
  const respond=message=>{
    if(message.kind==='idea_confirm_save'){decisions++;return {decision:decisions===1?'rejected':'approved'};}
    calls++;assert.equal(message.payload.messages.length,calls*2-1);
    return calls===1?{status:'question',question:'Who needs this?',productType:'B'}:draft(message.payload.maturity);
  };
  let c=await client(t,f,respond);await c.request('start',{text:'Synthetic idea'});await c.close();
  assert.equal(fs.statSync(f.file).mode&0o777,0o600);assert.equal(fs.existsSync(path.join(f.dir,'prd')),false);
  c=await client(t,f,respond);let status=(await c.request('status')).result;
  assert.equal(status.stage,'awaiting_user');assert.equal(status.lastReply.question,'Who needs this?');assert.equal(status.turns,1);
  await c.request('advance',{text:'Developers',maturity:'L1'});await c.request('prepare_save',{saveRoot:f.dir});await c.close();
  c=await client(t,f,respond);status=(await c.request('status')).result;assert.deepEqual(status.draft,draft('L1'));assert.equal(status.saveRoot,f.dir);
  await c.request('advance',{text:'Deepen to L2',maturity:'L2'});await c.close();
  c=await client(t,f,respond);status=(await c.request('status')).result;assert.equal(status.draft.maturity,'L2');assert.equal(status.turns,3);
  assert.equal((await c.request('finish',{filename:'prd-fixture.md'})).result.saveDecision,'rejected');
  assert.equal(fs.existsSync(path.join(f.dir,'prd')),false);
  assert.equal((await c.request('finish',{filename:'prd-fixture.md'})).result.stage,'saved');await c.close();
  c=await client(t,f,()=>assert.fail('saved recovery must not call host'));
  status=(await c.request('resume',{resolution:null})).result;assert.equal(status.stage,'saved');assert.equal(status.completionAuthorized,false);
  assert.equal(fs.readFileSync(status.saved.path,'utf8'),'# Synthetic L2');assert.equal(calls,3);assert.equal(decisions,2);await c.close();
});
test('unknown original response is bound once; explicit cancellation remains terminal after restart',async t=>{
  const f=fixture(t);let original;
  let c=await client(t,f,(message,child)=>{original=message;setImmediate(()=>child.kill('SIGKILL'));});
  await c.request('start',{text:'Synthetic interrupted idea'});
  c=await client(t,f,()=>assert.fail('must not redispatch unknown'));
  assert.ok((await c.request('advance',{text:'Skip unknown',maturity:'L1'})).error);
  assert.ok((await c.request('resume',{resolution:null})).error);
  const receipt={...original.payload.recovery,result:draft('L1'),evidence:'Synthetic original response recovered from trusted host output'};
  assert.ok((await c.request('resume',{resolution:{...receipt,requestDigest:'0'.repeat(64)}})).error);
  assert.equal((await c.request('resume',{resolution:receipt})).result.stage,'draft_ready');await c.close();
  c=await client(t,f,()=>undefined);const turn=c.request('advance',{text:'Await next response',maturity:'L2'});
  // Wait for the actual persisted dispatch, not elapsed time.
  while((await c.request('status')).result.recovery?.call===null)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await c.request('cancel')).result.stage,'cancelled');await turn;await c.close();
  c=await client(t,f,()=>assert.fail('cancelled must not call host'));
  assert.equal((await c.request('status')).result.stage,'cancelled');assert.ok((await c.request('resume',{resolution:null})).error);await c.close();
});
test('private session rejects writer contention/foreign data; ambiguous save is never retried or inferred from bytes',t=>{
  const {dir,file}=fixture(t),binding={fixture:'synthetic'};
  let session=openIdeaSession(file,binding);
  const checkpoint={stage:'draft_ready',draft:draft('L1'),lastReply:draft('L1'),saved:null,saveRoot:dir,transcript:[]};
  session.begin({requestId:'save',operation:'finish',filename:'prd-fixture.md'},checkpoint);
  assert.throws(()=>openIdeaSession(file,binding),/idea_session_busy/);
  session.writing();session.close();
  fs.mkdirSync(path.join(dir,'prd'));const target=path.join(dir,'prd/prd-fixture.md');fs.writeFileSync(target,'# Synthetic L1',{mode:0o600});
  session=openIdeaSession(file,binding);assert.throws(()=>session.resume(null),/idea_save_outcome_unknown/);session.close();
  assert.equal(fs.readFileSync(target,'utf8'),'# Synthetic L1');
  const before=fs.readFileSync(file);assert.throws(()=>openIdeaSession(file,{fixture:'different'}),/binding_changed/);
  assert.ok(fs.readFileSync(file).equals(before));fs.chmodSync(file,0o644);assert.throws(()=>openIdeaSession(file,binding),/permissions/);
  assert.ok(fs.readFileSync(file).equals(before));
  const foreign=path.join(dir,'foreign.json');fs.writeFileSync(foreign,'{"user":"owned"}',{mode:0o600});
  assert.throws(()=>openIdeaSession(foreign,binding));assert.equal(fs.readFileSync(foreign,'utf8'),'{"user":"owned"}');
});
