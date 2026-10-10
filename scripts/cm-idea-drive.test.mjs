import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-drive-'))),project=path.join(dir,'project');
  fs.mkdirSync(project);const answers=path.join(dir,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'interview.json'),JSON.stringify({status:'draft',content:'# Fixture PRD',
    maturity:'L1',productType:'B',followup:'What should change?'}));
  fs.writeFileSync(path.join(answers,'confirm-save.json'),JSON.stringify({decision:'approved'}));
  const sessionFile=path.join(dir,'session.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const plan=(over={})=>({project,sessionFile,mode:fs.existsSync(sessionFile)?'resume':'create',
    answers,text:'Fixture idea',saveRoot:project,filename:'fixture.md',...over});
  const drive=(value,operation='start')=>{const file=path.join(dir,'plan.json');fs.writeFileSync(file,JSON.stringify(value));
    return spawnSync(process.execPath,[path.join(root,'scripts/cm-idea-drive.mjs'),'--plan',file,operation],{encoding:'utf8'});};
  return {dir,project,answers,sessionFile,plan,drive};
}
test('real idea host: interview draft, status, resumed save with host write and readback',t=>{
  const f=fixture(t);let run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.stage,'draft_ready');
  const before=fs.readFileSync(f.sessionFile);
  run=f.drive(f.plan({answers:undefined}),'status');assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.stage,'draft_ready');assert.deepEqual(fs.readFileSync(f.sessionFile),before);
  run=f.drive(f.plan(),'finish');assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.stage,'saved');
  assert.equal(fs.readFileSync(path.join(f.project,'prd','fixture.md'),'utf8'),'# Fixture PRD');
});
test('missing or malformed answer and out-of-scope filename refuse before session creation',t=>{
  const f=fixture(t),file=path.join(f.answers,'interview.json');
  fs.rmSync(file);let run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/interview\.json/);
  fs.writeFileSync(file,'{"status":"draft"}');run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/答案格式错误/);
  run=f.drive(f.plan());assert.equal(run.status,2);assert.equal(fs.existsSync(f.sessionFile),false);
  fs.writeFileSync(file,JSON.stringify({status:'draft',content:'# Fixture',maturity:'L1',productType:'B',followup:'Next?'}));
  assert.equal(f.drive(f.plan()).status,0);
  run=f.drive(f.plan({filename:'../outside.md'}),'finish');assert.equal(run.status,2);assert.match(run.stderr,/filename/);
  assert.equal(fs.existsSync(path.join(f.project,'prd')),false);
});
test('missing save decision and resume session binding refuse before launch',t=>{
  const f=fixture(t);assert.equal(f.drive(f.plan()).status,0);
  const before=fs.readFileSync(f.sessionFile);
  fs.rmSync(path.join(f.answers,'confirm-save.json'));
  let run=f.drive(f.plan(),'finish');assert.equal(run.status,2);assert.match(run.stderr,/confirm-save\.json/);
  run=f.drive(f.plan({sessionFile:undefined}),'finish');assert.equal(run.status,2);assert.match(run.stderr,/sessionFile/);
  assert.deepEqual(fs.readFileSync(f.sessionFile),before);
});

// V7 blocker: a re-asked save confirmation is never answered from the earlier
// confirm-save.json; it needs a new decision that names the abandoned callId.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
async function loseConfirmation(f){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-idea-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-idea'),
    '--session-file',f.sessionFile,'--save-root',f.project],{cwd:f.project,stdio:['pipe','pipe','pipe']});
  const closed=new Promise(resolve=>child.on('close',resolve));
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);
    if(message.type==='host_ready')child.stdin.write(JSON.stringify({requestId:'f',operation:'finish',filename:'fixture.md'})+'\n');
    if(message.type==='host_request')child.kill('SIGKILL');});
  await closed;return JSON.parse(fs.readFileSync(f.sessionFile,'utf8')).pending.call;
}
const reaskFile=f=>path.join(f.answers,'confirm-save-reask.json');
const pendingCall=f=>JSON.parse(fs.readFileSync(f.sessionFile,'utf8')).pending?.call??null;
// After the stop: only a decision bound to the newly registered call is used.
function answerRegistered(f,old){
  const call=pendingCall(f);assert.equal(call.kind,'idea_confirm_save');assert.equal(Object.hasOwn(call,'result'),false);
  if(old)assert.notEqual(call.callId,old.callId);
  // A decision bound to the old call (if any) is refused as stale, then removed.
  if(fs.existsSync(reaskFile(f))){const stale=f.drive(f.plan({resolution:null}),'resume');assert.equal(stale.status,2);
    assert.match(stale.stderr,/confirm_reask_decision_stale/);fs.rmSync(reaskFile(f));}
  let run=f.drive(f.plan({resolution:null}),'resume');assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_required/);
  assert.match(run.stderr,new RegExp(call.callId));
  // The earlier confirm-save.json style, and a decision bound to another call, are refused.
  for(const stale of [{decision:'approved'},{decision:'approved',replaces:old?.callId??'x'},
    {callId:old?.callId??'other',requestDigest:call.requestDigest,decision:'approved'},{callId:call.callId,requestDigest:'0'.repeat(64),decision:'approved'}]){
    fs.writeFileSync(reaskFile(f),JSON.stringify(stale));
    run=f.drive(f.plan({resolution:null}),'resume');assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_stale/);
    assert.equal(Object.hasOwn(pendingCall(f),'result'),false);
  }
  fs.writeFileSync(reaskFile(f),JSON.stringify({callId:call.callId,requestDigest:call.requestDigest,decision:'rejected'}));
  run=f.drive(f.plan({resolution:null}),'resume');assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.saveDecision,'rejected');assert.equal(fs.existsSync(path.join(f.project,'prd/fixture.md')),false);
}
test('re-asked save confirmation: the host registers the new call, the driver stops, only a decision bound to it is used',async t=>{
  const f=fixture(t);assert.equal(f.drive(f.plan()).status,0);
  const call=await loseConfirmation(f);assert.equal(call.kind,'idea_confirm_save');
  const resolution={callId:call.callId,requestDigest:call.requestDigest,abandon:true,evidence:'confirmation lost'};
  // confirm-save.json says approved; the driver must not answer the re-ask with it.
  const run=f.drive(f.plan({resolution}),'resume');
  assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_required/);
  assert.equal(fs.existsSync(path.join(f.project,'prd')),false);
  answerRegistered(f,call);
});

// Round-2 blocker: the host recorded the abandon (pending.call cleared) and exited
// before registering the re-asked call. A plain resume reads the re-ask from the
// persisted abandon history and still needs the fresh decision.
test('crash after the abandon was recorded: the re-issued call is registered first and answered only from a bound decision',async t=>{
  const f=fixture(t);assert.equal(f.drive(f.plan()).status,0);
  const call=await loseConfirmation(f);assert.equal(call.kind,'idea_confirm_save');
  const state=JSON.parse(fs.readFileSync(f.sessionFile,'utf8'));
  const {createHash}=await import('node:crypto');const evidence='confirmation lost';
  state.abandonedCalls=[{kind:call.kind,callId:call.callId,requestDigest:call.requestDigest,operation:state.pending.request.operation,
    reason:'answer_missing',resultDigest:null,evidence:{sha256:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),length:evidence.length},
    at:new Date().toISOString()}];
  state.pending={...state.pending,call:null};fs.writeFileSync(f.sessionFile,JSON.stringify(state),{mode:0o600});
  // A decision bound to the abandoned call is already on disk: it must not be used.
  fs.writeFileSync(reaskFile(f),JSON.stringify({callId:call.callId,requestDigest:call.requestDigest,decision:'approved'}));
  const run=f.drive(f.plan({resolution:null}),'resume');
  assert.equal(run.status,2,run.stdout);assert.match(run.stderr,/confirm_reask_decision_required/);
  assert.equal(fs.existsSync(path.join(f.project,'prd')),false);
  answerRegistered(f,call);
});
