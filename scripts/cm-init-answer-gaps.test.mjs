// External answer gaps, batch 3 (O08-O12): cm-init re-asks read-only steps and
// confirmations under the same pending request, and leaves unknown writes to the
// archived-draft recovery. Every scenario drives the real cm-init-host.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {openDraftSession} from '../runtime/js/cm-idea/session.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const analyzed={status:'analyzed',selection:{versionControl:'none',modules:[],analysis:'Synthetic local project'},
  evidence:'Synthetic source observation',noGitDecision:'explicit_user_refusal'};
const checks=status=>({checks:Object.fromEntries(['commands','globs','file_references','constraint_preservation','rule_applicability']
  .map(category=>[category,{status,evidence:'Synthetic fixture evidence'}])),constraintChanges:[]});
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-gaps-'))),project=path.join(dir,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'# Synthetic project\n');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,project,file:path.join(dir,'init.json')};
}
function args(f,{author='author-a',allowWrite=false,memory=false,resumeDraft=null}={}){
  return [path.join(root,'scripts/cm-init-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-init'),'--project',f.project,
    '--host-context',author,...(allowWrite?['--allow-write']:[]),...(memory?[]:resumeDraft?['--resume-draft',resumeDraft]:['--session-file',f.file])];
}
async function client(t,f,respond,options={}){
  const child=spawn(process.execPath,args(f,options),{stdio:['pipe','pipe','pipe']});
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
    else if(message.type==='host_response'){if(message.accepted===false)requests.push({rejected:message.code});}
    else if(pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)rejectReady(Object.assign(Error(stderr),{stderr,code}));for(const resolve of pending.values())resolve({closed:code});pending.clear();});
  await ready;
  return {child,requests,stderr:()=>stderr,send:value=>send({...value,sessionId}),request:(operation,fields={})=>new Promise(resolve=>{
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
const saved=f=>JSON.parse(fs.readFileSync(f.file,'utf8'));

test('real host: a recorded refused analysis is discarded and asked again twice, the third discard hits the limit',{timeout:20000},async t=>{
  const f=fixture(t);let bad=3;
  const respond=message=>message.kind==='init_analyze'&&bad-->0?{...analyzed,evidence:' '}:reply(message);
  let c=await client(t,f,respond);
  assert.equal((await c.request('start')).error.code,'host_request_failed');await c.close();
  c=await client(t,f,()=>assert.fail('a recorded answer is replayed, not re-asked'));
  let status=(await c.request('status')).result;
  assert.equal(status.recovery.call.status,'recorded');assert.match(status.guidance.nextStep,/discard:true/);
  assert.equal((await c.request('resume',{resolution:null})).error.code,'host_request_failed');await c.close();
  for(let round=1;round<=3;round++){
    c=await client(t,f,respond);status=(await c.request('status')).result;
    const {callId,requestDigest}=status.recovery.call;
    const result=await c.request('resume',{resolution:{callId,requestDigest,discard:true,evidence:'evidence was blank'}});
    if(round<3){assert.equal(result.error.code,'host_request_failed');assert.equal(c.requests.at(-1).kind,'init_analyze');
      assert.notEqual(c.requests.at(-1).callId,callId);}
    else{assert.equal(result.error.code,'host_request_failed');assert.match(c.stderr(),/idea_session_abandon_limit/);assert.equal(c.requests.length,0);}
    await c.close();
  }
  const record=saved(f).abandonedCalls;
  assert.equal(record.length,2);assert.deepEqual(record.map(item=>[item.kind,item.reason,item.operation]),
    [['init_analyze','answer_rejected','start'],['init_analyze','answer_rejected','start']]);
  assert.equal(record[0].evidence.length,'evidence was blank'.length);assert.equal(JSON.stringify(record).includes('evidence was blank'),false);
});

test('real host: an unknown verification is abandoned and re-asked; the late original receipt is refused',{timeout:20000},async t=>{
  const f=fixture(t);let original;
  let c=await client(t,f,reply);await c.request('start');await c.request('advance');await c.close();
  c=await client(t,f,(message,child)=>{original=message;setImmediate(()=>child.kill('SIGKILL'));});await c.request('advance');
  c=await client(t,f,reply);
  const status=(await c.request('status')).result;assert.equal(status.recovery.call.status,'unknown');
  assert.match(status.guidance.nextStep,/abandon:true/);
  const {callId,requestDigest}=status.recovery.call;
  assert.ok((await c.request('resume',{resolution:{callId,requestDigest,discard:true,evidence:'wrong mode'}})).error,'discard needs a recorded answer');
  const resumed=(await c.request('resume',{resolution:{callId,requestDigest,abandon:true,evidence:'session lost the call'}})).result;
  assert.equal(resumed.stage,'review_required');assert.equal(c.requests.at(-1).kind,'init_verify');await c.close();
  c=await client(t,f,()=>assert.fail('no call'));
  const late={callId:original.payload.recovery.callId,requestDigest:original.payload.recovery.requestDigest,result:checks('verified'),evidence:'late'};
  assert.equal((await c.request('resume',{resolution:late})).error.code,'host_request_failed');await c.close();
  assert.equal(saved(f).abandonedCalls[0].reason,'answer_missing');
});

test('real host V7: a lost confirmation asks the current user again with a new callId',{timeout:20000},async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# Original constraint\n');
  const respond=message=>message.kind==='init_verify'?{...checks('verified'),constraintChanges:['AGENTS.md']}:reply(message);
  let c=await client(t,f,respond);await c.request('start');await c.request('advance');
  assert.equal((await c.request('advance')).result.stage,'confirmation_required');await c.close();
  let first;c=await client(t,f,(message,child)=>{first=message;setImmediate(()=>child.kill('SIGKILL'));});await c.request('advance');
  const asked=[];
  c=await client(t,f,message=>{asked.push(message);return {decision:'rejected'};});
  const {callId,requestDigest}=(await c.request('status')).result.recovery.call;
  const result=(await c.request('resume',{resolution:{callId,requestDigest,abandon:true,evidence:'user decision was lost'}})).result;
  assert.equal(result.stage,'confirmation_rejected');assert.equal(asked.length,1);assert.equal(asked[0].kind,'init_confirm');
  assert.notEqual(asked[0].payload.recovery.callId,first.payload.recovery.callId);await c.close();
  assert.equal(fs.readFileSync(path.join(f.project,'AGENTS.md'),'utf8'),'# Original constraint\n');
});

test('forged, duplicated and over-limit abandon records are refused when the session is reopened',{timeout:20000},async t=>{
  const f=fixture(t);let bad=1;
  let c=await client(t,f,message=>message.kind==='init_analyze'&&bad-->0?{status:'analyzed'}:reply(message));
  await c.request('start');const {callId,requestDigest}=(await c.request('status')).result.recovery.call;
  await c.request('resume',{resolution:{callId,requestDigest,discard:true,evidence:'missing fields'}});await c.close();
  const good=fs.readFileSync(f.file,'utf8'),state=JSON.parse(good),record=state.abandonedCalls[0];
  assert.equal(state.checkpoint.stage,'analysis_ready');
  const variants={
    duplicate:{...state,abandonedCalls:[record,record]},
    overLimit:{...state,abandonedCalls:[1,2,3].map(n=>({...record,callId:`${record.callId}-${n}`}))},
    forgedKind:{...state,abandonedCalls:[{...record,kind:'init_write'}]},
    forgedShape:{...state,abandonedCalls:[{...record,evidence:'raw text'}]},
    missingResult:{...state,abandonedCalls:[{...record,resultDigest:null}]},
  };
  for(const [name,value] of Object.entries(variants)){
    fs.writeFileSync(f.file,JSON.stringify(value),{mode:0o600});
    await assert.rejects(()=>client(t,f,()=>assert.fail(name)),/idea_session_abandon_record_invalid/,name);
  }
  // The untouched file still opens and keeps its record.
  fs.writeFileSync(f.file,good,{mode:0o600});
  const session=openDraftSession(f.file,state.binding,'cm-init');assert.equal(session.abandonedCalls.length,1);session.close();
});

test('an old session file without abandonedCalls replays unchanged',{timeout:20000},async t=>{
  const f=fixture(t);let c=await client(t,f,reply);await c.request('start');await c.request('advance');await c.close();
  const before=fs.readFileSync(f.file,'utf8');assert.equal(Object.hasOwn(JSON.parse(before),'abandonedCalls'),false);
  c=await client(t,f,()=>assert.fail('status and resume of a finished operation never call the host'));
  const status=(await c.request('status')).result;assert.equal(status.stage,'draft_generated');assert.equal(status.recovery,null);
  assert.equal((await c.request('resume',{resolution:null})).result.stage,'draft_generated');await c.close();
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
});

test('memory mode: a failed step is re-sent twice in the same process, then init_retry_limit',{timeout:20000},async t=>{
  const f=fixture(t);let bad=3;
  const c=await client(t,f,message=>message.kind==='init_analyze'&&bad-->0?{status:'analyzed'}:reply(message),{memory:true});
  assert.ok((await c.request('start')).error);
  let status=(await c.request('status')).result;assert.equal(status.stage,'failed');assert.equal(status.retry.remaining,2);
  assert.match(status.guidance.nextStep,/--session-file/);
  assert.ok((await c.request('advance')).error,'a different operation does not reuse the failed step');
  assert.ok((await c.request('start')).error);assert.ok((await c.request('start')).error);
  status=(await c.request('status')).result;assert.equal(status.retry.remaining,0);
  assert.ok((await c.request('start')).error);assert.match(c.stderr(),/init_retry_limit/);
  assert.equal(c.requests.filter(item=>item.kind==='init_analyze').length,3);await c.close();
});

test('unknown write stays on archived-draft recovery; a conflict lists every file for a person',{timeout:30000},async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# Original constraint\n');
  const respond=message=>message.kind==='init_verify'?{...checks('verified'),constraintChanges:['AGENTS.md']}:reply(message);
  let c=await client(t,f,respond);await c.request('start');await c.request('advance');await c.request('advance');
  await c.request('advance');await c.request('advance');await c.close();
  c=await client(t,f,(message,child)=>{
    assert.equal(message.kind,'init_write');
    for(const document of message.payload.documents.slice(0,1))fs.writeFileSync(path.join(f.project,document.path),document.content);
    setImmediate(()=>child.kill('SIGKILL'));},{allowWrite:true});
  await c.request('advance');
  c=await client(t,f,()=>assert.fail('unknown write never redispatches'),{allowWrite:true});
  const status=(await c.request('status')).result,digest=fs.readdirSync(path.join(f.project,'.reviews'))[0].slice('cm-init-'.length,-3);
  assert.equal(status.recovery.writing,true);assert.match(status.guidance.nextStep,new RegExp(`--resume-draft ${digest}`));
  assert.ok((await c.request('resume',{resolution:null})).error);
  assert.ok((await c.request('resume',{resolution:{...status.recovery.call,discard:true,evidence:'x'}})).error);await c.close();
  assert.match(c.stderr(),/idea_save_outcome_unknown/);
  const driver=spawnSync(process.execPath,[path.join(root,'scripts/cm-init-drive.mjs'),'--plan',(()=>{const plan=path.join(f.dir,'plan.json');
    fs.writeFileSync(plan,JSON.stringify({project:f.project,sessionFile:f.file,mode:'resume',hostContext:'author-a',originalHostContext:'author-a',resolution:null}));return plan;})(),'resume'],{encoding:'utf8'});
  assert.equal(driver.status,2);assert.match(driver.stderr,new RegExp(`--resume-draft ${digest}`));
  fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# Someone else edited this\n');
  const error=await client(t,f,()=>assert.fail('conflict never starts'),{resumeDraft:digest}).then(()=>null,cause=>cause);
  assert.ok(error);const lines=error.stderr.trim().split('\n').map(line=>JSON.parse(line));
  const diagnostic=lines.find(line=>line.diagnostic==='init_recovery_conflict');
  assert.deepEqual(diagnostic.files.find(file=>file.path==='AGENTS.md').status,'conflict');assert.match(diagnostic.guidance,/保留用户改动/);
  assert.equal(lines.at(-1).error.code,'init_recovery_conflict');
  assert.equal(fs.readFileSync(path.join(f.project,'AGENTS.md'),'utf8'),'# Someone else edited this\n');
});

test('notify classifies the new cm-init and cm-idea blocks as stuck',async()=>{
  const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
  for(const [workflow,result] of [
    ['cm-init',{stage:'draft_generated',recovery:{operation:'advance',writing:false,call:{kind:'init_verify',status:'recorded'}}}],
    ['cm-init',{stage:'failed',retry:{operation:'start',kind:'init_analyze',remaining:1}}],
    ['cm-init',{stage:'reviewed_draft',recovery:{operation:'advance',writing:true,call:{kind:'init_write',status:'unknown'}}}],
    ['cm-idea',{stage:'draft_ready',recovery:{operation:'finish',writing:true,expected:{length:1},call:{kind:'idea_confirm_save',status:'recorded'}}}],
    ['cm-idea',{stage:'awaiting_user',recovery:{operation:'advance',writing:false,call:{kind:'idea_interview',status:'recorded'}}}],
    ['cm-idea',{stage:'save_blocked'}],['cm-idea',{stage:'failed',retry:{operation:'start',remaining:0}}]])
    assert.equal(classifyDriveResult(workflow,{result}),'stuck',JSON.stringify(result));
  assert.equal(classifyDriveResult('cm-idea',{result:{stage:'saved',saved:{source:'recovered_write_readback'}}}),'done');
  assert.equal(classifyDriveResult('cm-init',{error:{code:'host_request_failed'}}),'stuck');
});

async function lostConfirm(t,f){
  fs.writeFileSync(path.join(f.project,'AGENTS.md'),'# Original constraint\n');
  const respond=message=>message.kind==='init_verify'?{...checks('verified'),constraintChanges:['AGENTS.md']}:reply(message);
  let c=await client(t,f,respond);await c.request('start');await c.request('advance');await c.request('advance');await c.close();
  c=await client(t,f,(message,child)=>{setImmediate(()=>child.kill('SIGKILL'));});await c.request('advance');
  const call=saved(f).pending.call;assert.equal(call.kind,'init_confirm');return call;
}
function initDriver(f,resolution){
  const answers=path.join(f.dir,'answers');fs.mkdirSync(answers,{recursive:true});
  fs.writeFileSync(path.join(answers,'confirm.json'),JSON.stringify({decision:'approved'}));
  const drive=(value=resolution)=>{const plan=path.join(f.dir,'plan.json');
    fs.writeFileSync(plan,JSON.stringify({project:f.project,sessionFile:f.file,mode:'resume',hostContext:'author-a',originalHostContext:'author-a',
      answers:'answers',resolution:value}));
    return spawnSync(process.execPath,[path.join(root,'scripts/cm-init-drive.mjs'),'--plan',plan,'resume'],{encoding:'utf8',timeout:60000});};
  return {answers,reask:path.join(answers,'confirm-reask.json'),drive};
}
// After the stop: only a decision bound to the newly registered call is used.
function answerRegisteredInit(f,d,old){
  const call=saved(f).pending.call;assert.equal(call.kind,'init_confirm');assert.equal(Object.hasOwn(call,'result'),false);
  assert.notEqual(call.callId,old.callId);
  if(fs.existsSync(d.reask)){const stale=d.drive(null);assert.equal(stale.status,2);assert.match(stale.stderr,/confirm_reask_decision_stale/);fs.rmSync(d.reask);}
  let run=d.drive(null);assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_required/);assert.match(run.stderr,new RegExp(call.callId));
  for(const stale of [{decision:'approved',replaces:old.callId},{callId:old.callId,requestDigest:old.requestDigest,decision:'approved'},
    {callId:call.callId,requestDigest:'0'.repeat(64),decision:'approved'}]){
    fs.writeFileSync(d.reask,JSON.stringify(stale));run=d.drive(null);assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_stale/);
    assert.equal(Object.hasOwn(saved(f).pending.call,'result'),false);
  }
  fs.writeFileSync(d.reask,JSON.stringify({callId:call.callId,requestDigest:call.requestDigest,decision:'rejected'}));
  run=d.drive(null);assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.stage,'confirmation_rejected');
}
test('driver V7: a re-asked init_confirm is registered first; confirm.json and decisions bound to other calls are never used',{timeout:60000},async t=>{
  const f=fixture(t),call=await lostConfirm(t,f),d=initDriver(f,null);
  const run=d.drive({callId:call.callId,requestDigest:call.requestDigest,abandon:true,evidence:'confirmation lost'});
  assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_required/);
  answerRegisteredInit(f,d,call);
});
// Round-2 narrow review: a decision bound to an earlier (historical) confirmation is
// on disk when a later confirmation is re-issued after a crash; it is never reused.
test('driver V7 cross-request: after a crash before registration, a stale decision of an earlier call is refused',{timeout:60000},async t=>{
  const f=fixture(t),call=await lostConfirm(t,f),state=saved(f);
  const {createHash}=await import('node:crypto');const evidence='confirmation lost';
  state.abandonedCalls=[{kind:call.kind,callId:call.callId,requestDigest:call.requestDigest,operation:state.pending.request.operation,
    reason:'answer_missing',resultDigest:null,evidence:{sha256:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),length:evidence.length},
    at:new Date().toISOString()}];
  state.pending={...state.pending,call:null};fs.writeFileSync(f.file,JSON.stringify(state),{mode:0o600});
  const d=initDriver(f,null);
  // The earlier call's approval, in both the old and the new decision-file shapes.
  for(const stale of [{decision:'approved',replaces:call.callId},{callId:call.callId,requestDigest:call.requestDigest,decision:'approved'}]){
    fs.writeFileSync(d.reask,JSON.stringify(stale));
    const run=d.drive(null);assert.equal(run.status,2,run.stdout);
    assert.match(run.stderr,/confirm_reask_decision_(required|stale)/);assert.notEqual(saved(f).checkpoint.stage,'review_required');
  }
  answerRegisteredInit(f,d,call);
});
