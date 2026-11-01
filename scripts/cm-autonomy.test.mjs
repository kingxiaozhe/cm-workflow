import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from './cm-autonomy.mjs';
import {readAutonomy,standingChangeProblem} from '../runtime/js/autonomy.mjs';
import {driveNotice} from '../runtime/js/notify.mjs';

function home(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-autonomy-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={...process.env,CM_WORKFLOW_HOME:dir};delete env.CM_NOTIFY_OFF;delete env.CLAUDE_CODE_SESSION_ID;
  const out=[],err=[];
  const run=(...argv)=>({code:main(argv,{env,stdout:{write:s=>out.push(s)},stderr:{write:s=>err.push(s)}}),out:out.splice(0).join(''),err:err.splice(0).join('')});
  return {dir,env,run};
}

test('autonomy is on only from recorded words, and off keeps the record',t=>{
  const h=home(t);
  assert.match(h.run().out,/关闭（未开启）/);
  assert.equal(h.run('on').code,2);
  assert.equal(h.run('on','--response','  ').code,2);
  assert.equal(h.run('on','--response','就按这份','--kind','fatal').code,2);
  assert.equal(h.run('on','--response','就按这份').code,0);
  assert.deepEqual({on:readAutonomy(h.env).on,response:readAutonomy(h.env).value.response},{on:true,response:'就按这份'});
  assert.equal(fs.statSync(path.join(h.dir,'autonomy.json')).mode&0o777,0o600);
  assert.match(h.run('show').out,/开启[\s\S]*就按这份[\s\S]*上限：2 次/);
  assert.equal(h.run('off').code,0);
  assert.equal(readAutonomy(h.env).on,false);
  assert.ok(fs.existsSync(path.join(h.dir,'autonomy.off.json')));
  // A file that is not exactly the recorded shape is off, never on.
  for(const value of [{version:1,mode:'until_fatal',response:'',at:'2026-11-01T00:00:00.000Z'},{version:2,mode:'until_fatal',response:'x',at:'2026-11-01T00:00:00.000Z'},'not json']){
    fs.writeFileSync(path.join(h.dir,'autonomy.json'),typeof value==='string'?value:JSON.stringify(value));
    assert.deepEqual(readAutonomy(h.env),{on:false,reason:'invalid'});
  }
});

test('a fatal stop pages at once with the reason as the action',async t=>{
  const h=home(t),sent=path.join(h.dir,'sent.jsonl'),script=path.join(h.dir,'fake.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(sent)},i);});`);
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script]}));
  assert.equal(h.run('notify','--kind','fatal','--project','/w/app').code,2);
  const result=h.run('notify','--kind','fatal','--project','/w/app','--reason','T-004 自动重开 2 次仍未通过');
  assert.equal(result.code,0);assert.match(result.out,/已交给提醒渠道发送/);
  for(let i=0;i<100&&!fs.existsSync(sent);i++)await new Promise(resolve=>setTimeout(resolve,50));
  const payload=JSON.parse(fs.readFileSync(sent,'utf8'));
  assert.equal(payload.event,'stuck');assert.equal(payload.code,'autonomy_fatal_stop');
  assert.match(payload.action,/致命问题，已停下：T-004 自动重开 2 次仍未通过/);
});

test('under autonomy a driver stop waits and a finished unit is not paged',t=>{
  const h=home(t);
  const notice=row=>driveNotice({host:'/x/scripts/cm-ai-host.mjs',cwd:'/w/app',args:['serve'],operation:'advance',row,env:h.env});
  const result=over=>({requestId:'drive',result:{version:1,workflow:'cm-ai',operation:'advance',
    identity:{runId:'r1',taskId:'T-001',attempt:1},packageDigest:'d',...over}});
  const limit=result({outcome:'advanced',state:'blocked',code:'review_limit',pendingAction:'none'});
  const done=result({outcome:'finalized',state:'run_done',code:'run_done',pendingAction:'none'});
  assert.equal(notice(limit).delivery,'now');assert.equal(notice(done)?.event,'done');
  h.run('on','--response','就按这份');
  assert.equal(notice(limit).delivery,'later');assert.equal(notice(done),null);
});

test('standing approval covers design, tasks and generated cases, never requirements, features or user cases',()=>{
  const digest='c'.repeat(64);
  const archive=(proposal={},before={})=>({before:{directories:['1.login'],files:{'1.login/requirements.md':'R','1.login/tasks.md':'T'},...before},
    proposal:{proposalDigest:digest,changedUserCases:[],removed:[],files:{'1.login/requirements.md':'R','1.login/tasks.md':'T2'},...proposal}});
  assert.equal(standingChangeProblem(archive(),digest),null);
  assert.equal(standingChangeProblem(archive(),'d'.repeat(64)),'找不到这份提案的归档');
  assert.equal(standingChangeProblem(null,digest),'找不到这份提案的归档');
  assert.equal(standingChangeProblem(archive({files:{'1.login/requirements.md':'R2'}}),digest),'提案改了需求');
  assert.equal(standingChangeProblem(archive({changedUserCases:[{id:'TC-1'}]}),digest),'提案删除或减弱了用户用例');
  assert.equal(standingChangeProblem(archive({removed:['1.login']}),digest),'提案删除了功能');
  assert.equal(standingChangeProblem(archive({files:{'2.new/tasks.md':'T'}}),digest),'提案新增了功能');
});
