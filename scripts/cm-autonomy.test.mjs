import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from './cm-autonomy.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readAutonomy,standingProposalProblem} from '../runtime/js/autonomy.mjs';
import {driveNotice,notifyLater,sendPendingNotice} from '../runtime/js/notify.mjs';

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
  // The window limit never swallows a fatal stop.
  const state=path.join(h.dir,'notify-state.json'),now=Date.now();
  fs.writeFileSync(state,JSON.stringify({version:2,keys:{},attention:{},sends:[now-3000,now-2000,now-1000],suppressed:0}));
  assert.equal(h.run('notify','--kind','fatal','--project','/w/app','--reason','额度用完').code,0);
  assert.equal(h.run('notify','--kind','fatal','--project','/w/app','--reason','额度用完').code,0,'same reason within 6 h is not resent');
  fs.rmSync(path.join(h.dir,'notify.json'));
  const off=h.run('notify','--kind','fatal','--project','/w/app','--reason','设备要本人解锁');
  assert.equal(off.code,1);assert.match(off.out,/没有发出提醒/);
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
  const cases=list=>JSON.stringify({schemaVersion:1,feature:'login',cases:list});
  const user={id:'TC-001',origin:'user',title:'login works'},generated={id:'TC-002',origin:'generated',title:'g'};
  const before={directories:['1.login'],files:{'1.login/requirements.md':'R','1.login/design.md':'D','1.login/tasks.md':'T',
    '1.login/test-cases.json':cases([user,generated])}};
  const proposal=(files={},over={})=>({changedUserCases:[],removed:[],...over,files:{...before.files,'1.login/tasks.md':'T2',...files}});
  assert.equal(standingProposalProblem(before,proposal()),null);
  assert.equal(standingProposalProblem(before,proposal({'1.login/design.md':'D2','1.login/test-cases.json':cases([user])})),null);
  const refused=[
    [proposal({'1.login/requirements.md':'R2'}),'提案改了需求'],
    [proposal({},{changedUserCases:[{id:'TC-001'}]}),'提案删除或减弱了用户用例'],
    [proposal({'1.login/test-cases.json':cases([generated])}),'提案删除或减弱了用户用例'],
    [proposal({'1.login/test-cases.json':cases([{...user,title:'weaker'}])}),'提案删除或减弱了用户用例'],
    [(()=>{const value=proposal();delete value.files['1.login/test-cases.json'];return value;})(),'提案删除或减弱了用户用例'],
    [proposal({'1.login/test-cases.json':'not json'}),'提案的测试用例无法解析'],
    [proposal({},{removed:['1.login']}),'提案删除了功能'],
    [proposal({'2.new/requirements.md':'R','2.new/design.md':'D','2.new/tasks.md':'T'}),'提案新增了功能'],
    [proposal({'1.login/assets/x.png':'b'}),'提案改了规格以外的文件（1.login/assets/x.png）'],
    [(()=>{const value=proposal();delete value.files['1.login/design.md'];return value;})(),'提案内容不完整，无法判断'],
    [{changedUserCases:[],removed:[],files:[]},'提案内容不完整，无法判断'],
    [{changedUserCases:[],removed:[],files:{}},'提案内容不完整，无法判断'],
    [{changedUserCases:[],removed:[],files:null},'提案内容不完整，无法判断'],
    [proposal({'1.login/tasks.md':5}),'提案内容不完整，无法判断']];
  for(const [value,reason] of refused)assert.equal(standingProposalProblem(before,value),reason,JSON.stringify(value).slice(0,120));
});

test('check-proposal judges against the specs on disk and reopen counts to the limit',t=>{
  const h=home(t),specs=path.join(h.dir,'specs'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});
  for(const [name,content] of [['requirements.md','R'],['design.md','D'],['tasks.md','T']])fs.writeFileSync(path.join(feature,name),content);
  const file=path.join(h.dir,'proposal.json'),check=files=>{
    fs.writeFileSync(file,JSON.stringify({result:{proposal:{changedUserCases:[],removed:[],files}}}));
    return h.run('check-proposal','--specs-dir',specs,'--proposal',file);
  };
  const ok=check({'1.login/requirements.md':'R','1.login/design.md':'D','1.login/tasks.md':'T2'});
  assert.equal(ok.code,0);assert.match(ok.out,/可以按常设授权自行批准/);
  const no=check({'1.login/requirements.md':'R2','1.login/design.md':'D','1.login/tasks.md':'T2'});
  assert.equal(no.code,1);assert.match(no.out,/提案改了需求.*不要发送 decision/);
  assert.equal(h.run('check-proposal','--specs-dir',specs,'--proposal',path.join(h.dir,'missing.json')).code,1);
  const reopen=()=>h.run('reopen','--project',h.dir,'--task','1.login/T-004');
  assert.equal(reopen().code,1,'off: the person decides');
  h.run('on','--response','就按这份');
  assert.equal(h.run('reopen','--project',h.dir,'--task','T-004').code,2);
  assert.match(reopen().out,/第 1 次/);assert.match(reopen().out,/第 2 次/);
  const third=reopen();assert.equal(third.code,1);assert.match(third.out,/上限 2.*致命停车/);
  assert.match(h.run('reopen','--project',h.dir,'--task','1.login/T-005').out,/第 1 次/);
  assert.match(h.run('show').out,/1\.login\/T-004 2 次/);
});

test('a deferred stop that comes due is not lost to the window limit',async t=>{
  const h=home(t),sent=path.join(h.dir,'sent.jsonl'),script=path.join(h.dir,'fake.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(sent)},i);});`);
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script]}));
  const fields={key:'cm-ai|r1|T-001|1|blocked|review_limit',attentionKey:'attn|w/app|cm-ai|r1',event:'stuck',workflow:'cm-ai',project:'/w/app',code:'review_limit'};
  assert.equal((await notifyLater(fields,{env:h.env,delayMs:5*60000})).scheduled,true);
  const pending=path.join(h.dir,'notify-pending'),[name]=fs.readdirSync(pending);
  const token=JSON.parse(fs.readFileSync(path.join(pending,name),'utf8')).token,now=Date.now();
  // Both the window and the daily limit are already used up.
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify({version:2,keys:{},attention:{},
    sends:Array.from({length:150},(_,i)=>now-1000-i*1000),suppressed:0}));
  assert.deepEqual(await sendPendingNotice(fields,token,{env:h.env}),{sent:true,reason:'launched'});
});

test('concurrent reopen takers never pass the limit',async t=>{
  const h=home(t),cli=fileURLToPath(new URL('./cm-autonomy.mjs',import.meta.url));
  h.run('on','--response','就按这份');
  const take=()=>new Promise(resolve=>{
    const child=spawn(process.execPath,[cli,'reopen','--project',h.dir,'--task','1.login/T-004'],{env:h.env,stdio:'ignore'});
    child.on('exit',code=>resolve(code));
  });
  const codes=await Promise.all(Array.from({length:8},take));
  assert.deepEqual(codes.sort(),[0,0,1,1,1,1,1,1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir,'autonomy-reopens.json'),'utf8'))[`${h.dir}|1.login/T-004`],2);
});
