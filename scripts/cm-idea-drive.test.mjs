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
test('re-asked save confirmation requires a new decision bound to the abandoned callId',async t=>{
  const f=fixture(t);assert.equal(f.drive(f.plan()).status,0);
  const call=await loseConfirmation(f);assert.equal(call.kind,'idea_confirm_save');
  const resolution={callId:call.callId,requestDigest:call.requestDigest,abandon:true,evidence:'confirmation lost'};
  let run=f.drive(f.plan({resolution}),'resume');
  assert.equal(run.status,2);assert.match(run.stderr,/confirm_reask_decision_required/);
  assert.equal(fs.existsSync(path.join(f.project,'prd')),false);
  const reask=path.join(f.answers,'confirm-save-reask.json');
  fs.writeFileSync(reask,JSON.stringify({decision:'approved',replaces:'another-call'}));
  run=f.drive(f.plan({resolution}),'resume');assert.equal(run.status,2);assert.match(run.stderr,/replaces/);
  fs.writeFileSync(reask,JSON.stringify({decision:'rejected',replaces:call.callId}));
  run=f.drive(f.plan({resolution}),'resume');assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.saveDecision,'rejected');assert.equal(fs.existsSync(path.join(f.project,'prd/fixture.md')),false);
});
