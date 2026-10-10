// External answer gaps, batch 3 (O13-O15): cm-idea re-asks the interview and the
// save confirmation under the same pending request, and reconciles an interrupted
// PRD save against the recorded content digest. Every scenario drives the real host.
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
const draft=maturity=>({status:'draft',content:'# Synthetic '+maturity,maturity,productType:'B',followup:'What should change?'});
const question={status:'question',question:'Who needs this?',productType:'B'};
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-gaps-')));
  t.after(()=>{try{fs.chmodSync(path.join(dir,'prd'),0o700);}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,file:path.join(dir,'interview.json')};}
async function client(t,{dir,file},respond,{memory=false}={}){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-idea-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-idea'),
    ...(memory?[]:['--session-file',file])],{cwd:dir,stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
  let sessionId,seq=0,stderr='';const pending=new Map(),closed=once(child,'close'),requests=[];
  let acceptReady,rejectReady;const ready=new Promise((yes,no)=>{acceptReady=yes;rejectReady=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',bytes=>stderr+=bytes);
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;acceptReady();}
    else if(message.type==='host_request'){requests.push(message);Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(rejectReady);}
    else if(pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)rejectReady(Error(stderr));for(const resolve of pending.values())resolve({closed:code});pending.clear();});
  await ready;
  return {child,requests,stderr:()=>stderr,request:(operation,fields={})=>new Promise(resolve=>{
    const requestId=`test-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});}),
    close:async()=>{send({type:'host_close',sessionId});const [code]=await closed;assert.equal(code,0,stderr);}};
}
const state=f=>JSON.parse(fs.readFileSync(f.file,'utf8'));
async function toDraft(t,f){
  const c=await client(t,f,message=>message.payload.messages.length===1?question:draft('L1'));
  await c.request('start',{text:'Synthetic idea'});await c.request('advance',{text:'Developers',maturity:'L1'});
  await c.request('prepare_save',{saveRoot:f.dir});await c.close();
}

test('real host: a refused interview reply is discarded and asked again; the third discard is over the limit',{timeout:20000},async t=>{
  const f=fixture(t);let bad=3;
  const respond=()=>bad-->0?{status:'question',question:' ',productType:'B'}:question;
  let c=await client(t,f,respond);assert.ok((await c.request('start',{text:'Synthetic idea'})).error);await c.close();
  for(let round=1;round<=3;round++){
    c=await client(t,f,respond);const status=(await c.request('status')).result;
    assert.equal(status.recovery.call.status,'recorded');assert.match(status.guidance.nextStep,/discard:true/);
    const {callId,requestDigest}=status.recovery.call;
    const result=await c.request('resume',{resolution:{callId,requestDigest,discard:true,evidence:'blank question'}});
    assert.ok(result.error);if(round===3){assert.match(c.stderr(),/idea_session_abandon_limit/);assert.equal(c.requests.length,0);}
    else{assert.equal(c.requests.length,1);assert.notEqual(c.requests[0].callId,callId);}
    await c.close();
  }
  assert.deepEqual(state(f).abandonedCalls.map(item=>[item.kind,item.reason]),[['idea_interview','answer_rejected'],['idea_interview','answer_rejected']]);
});

test('real host: an unknown interview is abandoned and re-asked; the late original receipt is refused',{timeout:20000},async t=>{
  const f=fixture(t);let original;
  let c=await client(t,f,(message,child)=>{original=message;setImmediate(()=>child.kill('SIGKILL'));});
  await c.request('start',{text:'Synthetic idea'});
  // The re-asked call is lost too, so a call is pending again under a new callId.
  c=await client(t,f,(message,child)=>{setImmediate(()=>child.kill('SIGKILL'));});
  const {callId,requestDigest}=(await c.request('status')).result.recovery.call;
  await c.request('resume',{resolution:{callId,requestDigest,abandon:true,evidence:'session lost it'}});
  c=await client(t,f,()=>question);
  const late={...original.payload.recovery,result:question,evidence:'late original'};
  assert.ok((await c.request('resume',{resolution:late})).error);assert.match(c.stderr(),/idea_session_call_abandoned/);
  const again=(await c.request('status')).result.recovery.call;assert.notEqual(again.callId,original.payload.recovery.callId);
  const second=await c.request('resume',{resolution:{callId:again.callId,requestDigest:again.requestDigest,abandon:true,evidence:'lost twice'}});
  assert.equal(second.result?.stage,'awaiting_user',c.stderr());await c.close();
  assert.deepEqual(state(f).abandonedCalls.map(item=>item.reason),['answer_missing','answer_missing']);
});

test('real host V7: an invalid save decision asks the current user again, and only then writes',{timeout:20000},async t=>{
  const f=fixture(t);await toDraft(t,f);
  let c=await client(t,f,()=>({decision:'maybe'}));
  assert.ok((await c.request('finish',{filename:'prd-fixture.md'})).error);
  let status=(await c.request('status')).result;assert.equal(status.stage,'save_blocked');assert.equal(status.recovery.call.status,'recorded');
  await c.close();assert.equal(fs.existsSync(path.join(f.dir,'prd')),false);
  const asked=[];
  c=await client(t,f,message=>{asked.push(message);return {decision:'approved'};});
  status=(await c.request('status')).result;const {callId,requestDigest}=status.recovery.call;
  const result=(await c.request('resume',{resolution:{callId,requestDigest,discard:true,evidence:'decision was not approved|rejected'}})).result;
  assert.equal(result.stage,'saved');assert.equal(asked.length,1);assert.equal(asked[0].kind,'idea_confirm_save');
  assert.notEqual(asked[0].callId,callId);await c.close();
  assert.equal(fs.readFileSync(path.join(f.dir,'prd/prd-fixture.md'),'utf8'),'# Synthetic L1');
});

test('real host: a refused finish (target exists) keeps draft_ready, so another filename can be confirmed',{timeout:20000},async t=>{
  const f=fixture(t);await toDraft(t,f);fs.mkdirSync(path.join(f.dir,'prd'));fs.writeFileSync(path.join(f.dir,'prd/taken.md'),'user file');
  const c=await client(t,f,()=>({decision:'approved'}));
  assert.ok((await c.request('finish',{filename:'taken.md'})).error);assert.equal(c.requests.length,0);
  assert.equal((await c.request('status')).result.recovery,null);
  assert.equal((await c.request('finish',{filename:'other.md'})).result.stage,'saved');await c.close();
  assert.equal(fs.readFileSync(path.join(f.dir,'prd/taken.md'),'utf8'),'user file');
});

test('real host V6: an interrupted save reconciles absent, matching and conflicting files against the recorded digest',{timeout:30000},async t=>{
  for(const mode of ['absent','matches','conflict']){
    const f=fixture(t);await toDraft(t,f);
    // A read-only prd/ makes the host-owned write fail after the save was approved and recorded.
    fs.mkdirSync(path.join(f.dir,'prd'),{mode:0o500});
    let c=await client(t,f,()=>({decision:'approved'}));
    assert.ok((await c.request('finish',{filename:'prd-fixture.md'})).error);
    let status=(await c.request('status')).result;assert.equal(status.stage,'save_unknown');
    assert.equal(status.recovery.writing,true);assert.equal(status.recovery.expected.length,'# Synthetic L1'.length);
    assert.match(status.guidance.nextStep,/idea_save_recovery_conflict/);await c.close();
    fs.chmodSync(path.join(f.dir,'prd'),0o700);const target=path.join(f.dir,'prd/prd-fixture.md');
    if(mode==='matches')fs.writeFileSync(target,'# Synthetic L1',{mode:0o600});
    if(mode==='conflict')fs.writeFileSync(target,'# Someone else',{mode:0o600});
    c=await client(t,f,()=>assert.fail('the recorded approval is reused, the user is not asked for the same request'));
    const result=await c.request('resume',{resolution:null});
    if(mode==='conflict'){assert.ok(result.error);assert.match(c.stderr(),/idea_save_recovery_conflict/);
      assert.equal(fs.readFileSync(target,'utf8'),'# Someone else');assert.equal((await c.request('status')).result.recovery.writing,true);}
    else{assert.equal(result.result.stage,'saved',JSON.stringify(result));assert.equal(fs.readFileSync(target,'utf8'),'# Synthetic L1');
      assert.equal(fs.statSync(target).mode&0o777,0o600);
      if(mode==='matches')assert.equal(result.result.saved.source,'recovered_write_readback');
      assert.equal((await c.request('status')).result.recovery,null);}
    await c.close();
  }
});

test('memory mode: a failed turn is re-sent twice in the same process, then idea_retry_limit',{timeout:20000},async t=>{
  const f=fixture(t);let bad=3;
  const c=await client(t,f,()=>bad-->0?{status:'unknown'}:question,{memory:true});
  assert.ok((await c.request('start',{text:'Synthetic idea'})).error);
  let status=(await c.request('status')).result;assert.equal(status.stage,'failed');assert.equal(status.retry.remaining,2);
  assert.match(status.guidance.nextStep,/--session-file/);
  assert.ok((await c.request('start',{text:'Synthetic idea'})).error);assert.ok((await c.request('start',{text:'Synthetic idea'})).error);
  assert.ok((await c.request('start',{text:'Synthetic idea'})).error);assert.match(c.stderr(),/idea_retry_limit/);
  status=(await c.request('status')).result;assert.equal(status.retry.remaining,0);
  assert.equal(c.requests.length,3);await c.close();
});

test('real host V6: recovery refuses a symlinked prd/ and removes only the host temp link of the verified file',{timeout:30000},async t=>{
  for(const mode of ['symlink','twin']){
    const f=fixture(t);await toDraft(t,f);fs.mkdirSync(path.join(f.dir,'prd'),{mode:0o500});
    let c=await client(t,f,()=>({decision:'approved'}));assert.ok((await c.request('finish',{filename:'prd-fixture.md'})).error);await c.close();
    fs.chmodSync(path.join(f.dir,'prd'),0o700);
    const elsewhere=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-elsewhere-')));t.after(()=>fs.rmSync(elsewhere,{recursive:true,force:true}));
    if(mode==='symlink'){
      // prd/ was replaced by a link to another directory holding a byte-identical file and a same-inode temp name.
      fs.rmdirSync(path.join(f.dir,'prd'));fs.symlinkSync(elsewhere,path.join(f.dir,'prd'));
      fs.writeFileSync(path.join(elsewhere,'prd-fixture.md'),'# Synthetic L1',{mode:0o600});
      fs.linkSync(path.join(elsewhere,'prd-fixture.md'),path.join(elsewhere,'.cm-review-00000000-0000-0000-0000-000000000000'));
    }else{
      const target=path.join(f.dir,'prd/prd-fixture.md');fs.writeFileSync(target,'# Synthetic L1',{mode:0o600});
      fs.linkSync(target,path.join(f.dir,'prd/.cm-review-00000000-0000-0000-0000-000000000000'));
    }
    c=await client(t,f,()=>assert.fail('no call'));const result=await c.request('resume',{resolution:null});await c.close();
    if(mode==='symlink'){assert.ok(result.error);assert.match(c.stderr(),/idea_save_recovery_conflict/);
      assert.deepEqual(fs.readdirSync(elsewhere).sort(),['.cm-review-00000000-0000-0000-0000-000000000000','prd-fixture.md']);}
    else{assert.equal(result.result.stage,'saved');assert.deepEqual(fs.readdirSync(path.join(f.dir,'prd')),['prd-fixture.md']);
      assert.equal(fs.statSync(path.join(f.dir,'prd/prd-fixture.md')).nlink,1);}
  }
});
