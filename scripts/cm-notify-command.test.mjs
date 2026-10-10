import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseAssignments,readPrivateFile,readSecret,runSender,responseCodeType,readRegularFile,entryDecision,WINDOWS_UNSUPPORTED,SEND_EXIT} from '../runtime/js/notify-send.mjs';
import {main,notifyStatus,switchChannel,turnOff,sendTest,formatTest,previewText,formatPreview,managedSenderPath,classifyCommand,SENDER_SOURCE,TEMPLATES} from './cm-notify.mjs';

// Every test works in its own temp CM_WORKFLOW_HOME / log home / HOME: the
// real ~/.cm-workflow/notify.json would push to the user's phone.
const BARK_SECRET='FakeBarkKey123456',OTHER_BARK_SECRET='OtherKey12345',PUSH_SECRET='FakePushplusToken789'; // gitleaks:allow 测试用合成假值，不是真实密钥
const CLI=fileURLToPath(new URL('./cm-notify.mjs',import.meta.url));
const posix=process.platform!=='win32';
function sandbox(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-cmd-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'cm-home');fs.mkdirSync(home,{mode:0o700});
  const env={...process.env,CM_WORKFLOW_HOME:home,CM_WORKFLOW_LOG_HOME:path.join(root,'logs'),HOME:path.join(root,'user'),USERPROFILE:path.join(root,'user')};
  delete env.CM_NOTIFY_DRY_RUN;delete env.HTTPS_PROXY;delete env.https_proxy;
  const write=(name,text,mode=0o600)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode});fs.chmodSync(file,mode);return file;};
  const read=name=>fs.readFileSync(path.join(home,name),'utf8');
  const exists=name=>fs.existsSync(path.join(home,name));
  const snapshot=()=>{
    const out={};
    const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())walk(file);else out[path.relative(home,file)]=fs.readFileSync(file).toString('base64');
    }};
    walk(home);return out;
  };
  const cli=(args,extra={})=>spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',env:{...env,...extra},timeout:30000});
  const log=()=>exists('notify.log')?read('notify.log'):'';
  return {root,home,env,write,read,exists,snapshot,cli,log};
}
const noSecret=(text,label='output')=>{for(const secret of [BARK_SECRET,PUSH_SECRET])assert(!String(text).includes(secret),`${label} leaks a secret`);};
const sink=()=>{let text='';return {stream:{write:chunk=>{text+=chunk;return true;}},text:()=>text};};
const endedStdin=(line='{"title":"x"}\n')=>{const s=new PassThrough();s.end(line);return s;};

// Loopback server standing in for Bark/pushplus. `request` rewrites the
// target host to it; this injection exists only in the module API.
async function fakeServer(t,handler){
  const seen=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{seen.push({method:req.method,url:req.url,headers:req.headers,body});handler(req,res,body);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections?.();server.close();});
  const port=server.address().port,targets=[];
  const request=(options,callback)=>{targets.push({hostname:options.hostname,path:options.path,rejectUnauthorized:options.rejectUnauthorized});
    return http.request({...options,hostname:'127.0.0.1',port},callback);};
  return {seen,targets,request,port};
}
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(typeof value==='string'?value:JSON.stringify(value));};

test('secret files parse strictly as data and errors name the line, never the value',()=>{
  const ok=parseAssignments(`# 注释\n\nexport BARK_KEY="${BARK_SECRET}"\n  BARK_SERVER='https://bark.example.com'  \n`,['BARK_KEY','BARK_SERVER'],'bark.env');
  assert.deepEqual(ok.values,{BARK_KEY:BARK_SECRET,BARK_SERVER:'https://bark.example.com'});
  assert.deepEqual(ok.lines,{BARK_KEY:3,BARK_SERVER:4});
  assert.equal(parseAssignments(`BARK_KEY="${BARK_SECRET}'\n`,['BARK_KEY'],'b').values.BARK_KEY,`"${BARK_SECRET}'`,'unmatched quotes are kept');
  for(const [text,line] of [[`BARK_KEY=${BARK_SECRET}\nBARK_KEY=${BARK_SECRET}\n`,2],[`OTHER=${BARK_SECRET}\n`,1],
    [`# c\n${BARK_SECRET}\n`,2],[`$(echo ${BARK_SECRET})=1\n`,1],[`=x\n`,1]]){
    assert.throws(()=>parseAssignments(text,['BARK_KEY','BARK_SERVER'],'bark.env'),error=>{
      assert.equal(error.exit,SEND_EXIT.config);assert.equal(error.detail.line,line);
      assert.match(error.message,new RegExp(`bark.env 第 ${line} 行`));noSecret(error.message);return true;});
  }
});

test('secret files must be private regular files with mode 600 on POSIX',{skip:!posix},async t=>{
  const s=sandbox(t);
  const file=s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`,0o644);
  await assert.rejects(()=>readPrivateFile(file,'bark.env'),/必须是自己的普通文件且权限 600/);
  await assert.rejects(()=>readPrivateFile(file,'bark.env',{platform:'win32'}),error=>error.message===WINDOWS_UNSUPPORTED,'Windows is refused, never trusted');
  fs.chmodSync(file,0o600);assert.equal(await readPrivateFile(file,'bark.env'),`BARK_KEY=${BARK_SECRET}\n`);
  const link=path.join(s.home,'pushplus.env');fs.symlinkSync(file,link);
  await assert.rejects(()=>readPrivateFile(link,'pushplus.env'),/普通文件/);
  s.write('big.env','#'.repeat(70*1024));await assert.rejects(()=>readPrivateFile(path.join(s.home,'big.env'),'big.env'),/太大/);
  fs.writeFileSync(path.join(s.home,'bad.env'),Buffer.from([0x42,0xff,0xfe]),{mode:0o600});
  await assert.rejects(()=>readPrivateFile(path.join(s.home,'bad.env'),'bad.env'),/读取 bad.env 失败/);
});

test('secret values are validated per channel with file and line in the message',async t=>{
  const s=sandbox(t);
  const cases=[
    ['bark',`BARK_KEY=\n`,'empty',/bark.env 第 1 行 BARK_KEY 未填写/],
    ['bark',`# only comments\n`,'empty',/bark.env BARK_KEY 未填写/],
    ['bark',`BARK_KEY=short\n`,'invalid',/第 1 行 BARK_KEY 格式不对/],
    ['bark',`BARK_KEY=${'a1'.repeat(32)}\n`,'invalid',/Device Token/],
    ['bark',`BARK_KEY=${BARK_SECRET}\nBARK_SERVER=http://bark.example.com\n`,'invalid',/第 2 行 BARK_SERVER 必须是不带路径的 https 地址/],
    ['bark',`BARK_KEY=${BARK_SECRET}\nBARK_SERVER=https://bark.example.com/path\n`,'invalid',/第 2 行 BARK_SERVER/],
    ['pushplus',`PUSHPLUS_TOKEN=''\n`,'empty',/pushplus.env 第 1 行 PUSHPLUS_TOKEN 未填写/],
    ['pushplus',`PUSHPLUS_TOKEN=has-dash-${PUSH_SECRET}\n`,'invalid',/PUSHPLUS_TOKEN 格式不对/],
  ];
  for(const [channel,text,state,pattern] of cases){
    s.write(`${channel}.env`,text);
    await assert.rejects(()=>readSecret(s.home,channel),error=>{assert.equal(error.detail.state,state,text);assert.match(error.message,pattern);noSecret(error.message);return true;});
  }
  fs.rmSync(path.join(s.home,'bark.env'));
  await assert.rejects(()=>readSecret(s.home,'bark'),error=>error.detail.state==='missing');
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  assert.deepEqual(await readSecret(s.home,'bark'),{key:BARK_SECRET,server:'https://api.day.app'});
});

test('success needs HTTP 200 and a numeric JSON code 200',()=>{
  assert.deepEqual(responseCodeType('{"code":200}'),{ok:true,type:'number'});
  for(const [raw,type] of [['{"code":"200"}','string'],['{"code":true}','boolean'],['{"code":null}','null'],['{"msg":1}','missing'],['oops','not_json'],['[200]','missing'],['{"code":[200]}','array']])
    assert.deepEqual(responseCodeType(raw),{ok:false,type},raw);
});

test('dry-run reads no secret and touches no network',async t=>{
  const s=sandbox(t);s.write('notify-channel.conf','CHANNEL=pushplus\n');
  const out=sink(),err=sink();
  const code=await runSender({env:{...s.env,CM_NOTIFY_DRY_RUN:'1',CM_NOTIFY_TITLE:'标题',CM_NOTIFY_BODY:'正文'},home:s.home,stdin:endedStdin(),
    stdout:out.stream,stderr:err.stream,request:()=>{throw new Error('network used');}});
  assert.equal(code,0,err.text());
  assert.equal(out.text(),`POST https://www.pushplus.plus/send\n${JSON.stringify({token:'<已隐藏>',title:'标题',content:'正文',template:'txt',channel:'wechat'})}\n`);
  assert(!s.exists('pushplus.env'));
});

test('bark and pushplus requests: fields, numeric code check, rejected responses never echo values',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');
  let reply=(req,res)=>json(res,200,{code:200,message:'success'});
  const server=await fakeServer(t,(req,res,body)=>reply(req,res,body));
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\nBARK_SERVER=https://bark.example.com:8443\n`);
  const run=async(env={})=>{const out=sink(),err=sink();
    const code=await runSender({env:{...s.env,CM_NOTIFY_TITLE:'t'.repeat(150),CM_NOTIFY_BODY:'正文',...env},home:s.home,stdin:endedStdin(),stdout:out.stream,stderr:err.stream,request:server.request});
    noSecret(out.text()+err.text());return {code,out:out.text(),err:err.text()};};
  let result=await run();
  assert.equal(result.code,0,result.err);
  assert.deepEqual(server.targets.at(-1),{hostname:'bark.example.com',path:'/push',rejectUnauthorized:true});
  assert.deepEqual(JSON.parse(server.seen.at(-1).body),{device_key:BARK_SECRET,title:'t'.repeat(100),body:'正文',group:'CM',level:'active'});
  assert.match(server.seen.at(-1).headers['content-type'],/application\/json/);
  for(const [status,body,type] of [[200,{code:'200',echo:BARK_SECRET},'string'],[200,{code:true},'boolean'],[500,{code:200},'number'],
    [200,`{"code":400,"msg":"${BARK_SECRET}"}`,'number'],[200,'not json '+BARK_SECRET,'not_json']]){
    reply=(req,res)=>json(res,status,body);
    result=await run();
    assert.equal(result.code,SEND_EXIT.rejected,JSON.stringify(body));
    assert.equal(result.err,`cm-notify: bark 推送返回 http=${status} code类型=${type}\n`);
  }
  // Redirects are not followed: one request, rejected.
  const before=server.seen.length;
  reply=(req,res)=>{res.writeHead(302,{Location:'https://evil.example/steal'});res.end();};
  result=await run();
  assert.equal(result.code,SEND_EXIT.rejected);assert.match(result.err,/http=302/);assert.equal(server.seen.length,before+1);
  reply=(req,res)=>{res.writeHead(200);res.end('x'.repeat(70*1024));};
  result=await run();assert.equal(result.code,SEND_EXIT.rejected);assert.match(result.err,/响应过大/);
  // pushplus goes to the fixed endpoint with its own fields.
  s.write('notify-channel.conf','CHANNEL=pushplus\n');s.write('pushplus.env',`PUSHPLUS_TOKEN=${PUSH_SECRET}\n`);
  reply=(req,res)=>json(res,200,{code:200});
  result=await run();
  assert.equal(result.code,0,result.err);
  assert.deepEqual(server.targets.at(-1),{hostname:'www.pushplus.plus',path:'/send',rejectUnauthorized:true});
  assert.deepEqual(JSON.parse(server.seen.at(-1).body),{token:PUSH_SECRET,title:'t'.repeat(100),content:'正文',template:'txt',channel:'wechat'});
});

test('network failure, deadline (also while waiting on stdin) and unexpected errors exit 3 without details',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const server=await fakeServer(t,()=>{});// never answers
  let err=sink();
  let code=await runSender({env:s.env,home:s.home,stdin:endedStdin(),stdout:sink().stream,stderr:err.stream,request:server.request,deadlineMs:300});
  assert.equal(code,SEND_EXIT.network);assert.equal(err.text(),'cm-notify: 整次调用超过 1 秒，已放弃\n');
  err=sink();const silent=new PassThrough();t.after(()=>silent.destroy());
  const started=process.hrtime.bigint();
  code=await runSender({env:s.env,home:s.home,stdin:silent,stdout:sink().stream,stderr:err.stream,request:()=>{throw new Error('must not send');},deadlineMs:200});
  assert.equal(code,SEND_EXIT.network);assert.match(err.text(),/整次调用超过/);
  assert(Number(process.hrtime.bigint()-started)/1e6<2000);
  // A line without EOF is enough: the sender does not wait for the stream to end.
  const open=new PassThrough();open.write('{"title":"x"}\n');t.after(()=>open.destroy());
  code=await runSender({env:{...s.env,CM_NOTIFY_DRY_RUN:'1'},home:s.home,stdin:open,stdout:sink().stream,stderr:sink().stream,deadlineMs:2000});
  assert.equal(code,0);
  err=sink();
  code=await runSender({env:s.env,home:s.home,stdin:endedStdin(),stdout:sink().stream,stderr:err.stream,request:()=>{throw new Error(`boom ${BARK_SECRET}`);}});
  assert.equal(code,SEND_EXIT.network);assert.equal(err.text(),'cm-notify: 意外错误（详情已隐藏，避免带出密钥）\n');
  err=sink();
  code=await runSender({env:s.env,home:s.home,stdin:endedStdin(),stdout:sink().stream,stderr:err.stream,
    request:(options,callback)=>http.request({...options,hostname:'127.0.0.1',port:1},callback)});
  assert.equal(code,SEND_EXIT.network);assert.equal(err.text(),'cm-notify: bark 请求失败或超时\n');
});

const [major,minor]=process.versions.node.split('.').map(Number);
test('HTTPS_PROXY is honoured through a CONNECT tunnel on Node 24.5+',{skip:!(major>24||(major===24&&minor>=5))},async t=>{
  const s=sandbox(t);s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const connects=[];
  const proxy=http.createServer();proxy.on('connect',(req,socket)=>{connects.push(req.url);socket.destroy();});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>proxy.close());
  const err=sink(),proxyPort=proxy.address().port;
  const code=await runSender({env:{...s.env,HTTPS_PROXY:`http://127.0.0.1:${proxyPort}`},home:s.home,stdin:endedStdin(),stdout:sink().stream,stderr:err.stream});
  assert.equal(code,SEND_EXIT.network);assert.deepEqual(connects,['api.day.app:443']);noSecret(err.text());
});

test('the sender runs as a standalone copy: config problems exit 2, dry-run exit 0',t=>{
  const s=sandbox(t);
  const copy=path.join(s.root,'elsewhere','cm-notify-send.mjs');fs.mkdirSync(path.dirname(copy));fs.copyFileSync(SENDER_SOURCE,copy);
  const run=extra=>spawnSync(process.execPath,[copy],{input:'{"title":"x"}\n',encoding:'utf8',env:{...s.env,...extra},timeout:20000});
  let result=run({});assert.equal(result.status,2);assert.equal(result.stderr,'cm-notify: 读不到 notify-channel.conf\n');
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  result=run({CM_NOTIFY_DRY_RUN:'1'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^POST https:\/\/api.day.app\/push\n/);noSecret(result.stdout);
  result=spawnSync(process.execPath,[copy,'--check'],{input:'',encoding:'utf8',env:s.env,timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'cm-notify: 渠道 bark 配置可解析（未发送）\n');
  s.write('bark.env','BARK_KEY=\n');result=run({});assert.equal(result.status,2);assert.match(result.stderr,/bark.env 第 1 行 BARK_KEY 未填写/);
});

test('status shows each channel as missing, empty, malformed or filled, marks the active one, never a value',async t=>{
  const s=sandbox(t);
  let status=(await notifyStatus(s.home));
  assert.equal(status.active,null);assert.equal(status.config.state,'missing');
  assert.deepEqual([status.channels.bark.state,status.channels.pushplus.state],['missing','missing']);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('pushplus.env','PUSHPLUS_TOKEN=\n');
  {
    assert.equal(s.cli(['bark']).status,0);
    let result=s.cli([]);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/发送命令：CM 托管发送器/);
    assert.match(result.stdout,/当前渠道：bark（生效中）/);
    assert.match(result.stdout,/渠道 bark［当前］：已填写，可解析/);
    assert.match(result.stdout,new RegExp(`渠道 pushplus：未填写 — .*pushplus.env\\n  请在 .*pushplus.env 第 1 行 PUSHPLUS_TOKEN= 后面填写`));
    noSecret(result.stdout+result.stderr);
    s.write('pushplus.env',`PUSHPLUS_TOKEN=${PUSH_SECRET}\nEXTRA=1\n`);
    result=s.cli(['status','--json']);const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.active,'bark');assert.equal(parsed.channels.pushplus.state,'invalid');assert.equal(parsed.channels.pushplus.line,2);
    noSecret(result.stdout);
    if(posix){
      fs.chmodSync(path.join(s.home,'bark.env'),0o644);
      result=s.cli([]);assert.match(result.stdout,/渠道 bark［当前］：格式不对/);assert.match(result.stdout,/chmod 600/);noSecret(result.stdout);
    }
    assert.equal(s.log(),'','status writes nothing, not even notify.log');
  }
});

test('switching refuses an unfilled or malformed target and leaves every existing file unchanged',t=>{
  const s=sandbox(t);
  s.write('notify.json',JSON.stringify({version:1,command:['/bin/echo','custom'],waitMinutes:7}));
  s.write('notify-channel.conf','CHANNEL=bark\n');
  let before=s.snapshot();
  let result=s.cli(['pushplus']);
  assert.equal(result.status,2);
  assert.match(result.stderr,/没有切换到 pushplus，原有设置都没动：未填写（文件不存在）。已新建空模板 .*pushplus.env（权限 600）。请在 .*pushplus.env 第 3 行 PUSHPLUS_TOKEN= 后面填写/);
  const after=s.snapshot();
  assert.equal(after['pushplus.env'],Buffer.from(TEMPLATES.pushplus.text).toString('base64'),'only the missing template is new');
  delete after['pushplus.env'];assert.deepEqual(after,before);
  if(posix)assert.equal(fs.statSync(path.join(s.home,'pushplus.env')).mode&0o777,0o600);
  assert.equal(TEMPLATES.pushplus.text.split('\n')[TEMPLATES.pushplus.line-1],'PUSHPLUS_TOKEN=');
  assert.equal(TEMPLATES.bark.text.split('\n')[TEMPLATES.bark.line-1],'BARK_KEY=');
  before=s.snapshot();
  result=s.cli(['pushplus']);
  assert.equal(result.status,2);assert.match(result.stderr,/未填写。请在 .*pushplus.env 第 3 行 PUSHPLUS_TOKEN= 后面填写/);
  assert.deepEqual(s.snapshot(),before);
  s.write('pushplus.env',`# x\nPUSHPLUS_TOKEN=${PUSH_SECRET}\nPUSHPLUS_TOKEN=${PUSH_SECRET}\n`);before=s.snapshot();
  result=s.cli(['pushplus']);
  assert.equal(result.status,2);assert.match(result.stderr,/格式不对。pushplus.env 第 3 行无法识别或重复；请打开 .*pushplus.env 第 3 行修正/);
  assert.deepEqual(s.snapshot(),before);noSecret(result.stderr);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('notify.json','{not json');before=s.snapshot();
  result=s.cli(['bark']);assert.equal(result.status,2);assert.match(result.stderr,/不是有效 JSON/);assert.deepEqual(s.snapshot(),before);
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,managedSenderPath(s.home)],waitMinutes:0}));before=s.snapshot();
  result=s.cli(['bark']);assert.equal(result.status,2);assert.match(result.stderr,/其他字段无效（wait_minutes）/);assert.deepEqual(s.snapshot(),before);
  assert.equal(s.cli(['bark','extra']).status,2);assert.equal(s.cli(['--nope']).status,2);
});

test('a custom notify.json command is never overwritten silently; --replace-custom backs it up first',t=>{
  const s=sandbox(t);
  const original=JSON.stringify({version:1,command:['/usr/local/bin/my-notify','--flag'],waitMinutes:12,idleMinutes:30,note:'keep'});
  s.write('notify.json',original);s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const before=s.snapshot();
  let result=s.cli(['bark']);
  assert.equal(result.status,2);assert.match(result.stderr,/你自己配置的提醒命令，cm-notify 不会静默覆盖.*--replace-custom/);
  assert.deepEqual(s.snapshot(),before);
  assert.match(s.cli([]).stdout,/发送命令：自定义命令/);
  result=s.cli(['bark','--replace-custom']);
  assert.equal(result.status,0,result.stderr);
  const backups=fs.readdirSync(s.home).filter(name=>name.startsWith('notify.json.bak-'));
  assert.equal(backups.length,1);assert.equal(s.read(backups[0]),original);
  const next=JSON.parse(s.read('notify.json'));
  assert.deepEqual(next,{version:1,command:[process.execPath,managedSenderPath(s.home)],waitMinutes:12,idleMinutes:30,note:'keep'});
  assert.equal(s.read('notify-channel.conf').trim().split('\n').at(-1),'CHANNEL=bark');
  assert(fs.readFileSync(managedSenderPath(s.home)).equals(fs.readFileSync(SENDER_SOURCE)));
});

test('the legacy private cm-notify.py layout is recognised and migrated with a backup; its files keep working',t=>{
  const s=sandbox(t);
  const legacy=s.write('cm-notify.py','#!/usr/bin/python3 -I\n# private\n',0o700);
  const original=JSON.stringify({version:1,command:[legacy],waitMinutes:10});
  s.write('notify.json',original);s.write('notify-channel.conf','# 本机\nCHANNEL=bark\n');
  s.write('bark.env',`export BARK_KEY='${BARK_SECRET}'\n`);s.write('pushplus.env',`PUSHPLUS_TOKEN=${PUSH_SECRET}\n`);
  let result=s.cli([]);
  assert.match(result.stdout,/旧版本机脚本 cm-notify.py/);assert.match(result.stdout,/当前渠道：bark（生效中）/);
  result=s.cli(['pushplus']);
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/原 cm-notify.py 未改动/);
  assert.equal(fs.readFileSync(legacy,'utf8'),'#!/usr/bin/python3 -I\n# private\n');
  assert.deepEqual(JSON.parse(s.read('notify.json')).command,[process.execPath,managedSenderPath(s.home)]);
  assert.equal(JSON.parse(s.read('notify.json')).waitMinutes,10);
  assert.equal(s.read(fs.readdirSync(s.home).find(name=>name.startsWith('notify.json.bak-'))),original);
  const check=spawnSync(process.execPath,[managedSenderPath(s.home),'--check'],{input:'',encoding:'utf8',env:s.env});
  assert.equal(check.status,0,check.stderr);assert.match(check.stdout,/渠道 pushplus 配置可解析/);
  result=s.cli(['bark']);assert.equal(result.status,0);
  assert.equal(fs.readdirSync(s.home).filter(name=>name.startsWith('notify.json.bak-')).length,1,'managed → managed needs no backup');
});

test('off moves notify.json aside; switching back restores its other fields',t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  assert.equal(s.cli(['off']).stdout.trim(),'提醒本来就没有开启，什么都没改。');
  assert.equal(s.cli(['bark']).status,0);
  const config=JSON.parse(s.read('notify.json'));config.waitMinutes=20;s.write('notify.json',JSON.stringify(config));
  let result=s.cli(['off']);assert.equal(result.status,0);
  assert(!s.exists('notify.json'));assert(s.exists('notify.off.json'));
  assert.match(s.cli([]).stdout,/发送命令：已关闭/);
  assert.equal(s.cli(['test']).status,2);
  result=s.cli(['bark']);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/已从 notify.off.json 恢复/);
  assert(!s.exists('notify.off.json'));assert.equal(JSON.parse(s.read('notify.json')).waitMinutes,20);
  assert.equal(turnOff(s.home).changed,true);
});

test('test refuses when the active secret is not filled and never runs the sender',t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);assert.equal(s.cli(['bark']).status,0);
  s.write('bark.env','BARK_KEY=\n');
  let result=s.cli(['test']);
  assert.equal(result.status,2);assert.match(result.stderr,/没有发送：当前渠道 bark 未填写。请在 .*bark.env 第 1 行 BARK_KEY= 后面填写/);
  s.write('bark.env','BARK_KEY=bad!\n');
  result=s.cli(['test']);assert.equal(result.status,2);assert.match(result.stderr,/没有发送：当前渠道 bark 格式不对/);
  fs.rmSync(path.join(s.home,'bark.env'));
  result=s.cli(['test']);assert.equal(result.status,2);assert.match(result.stderr,/未填写（文件不存在）/);
  assert.equal(s.log(),'','the sender was never started');
});

test('test goes through the configured command, bypasses dedupe/limits, and reports only the exit code',async t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`+'BARK_SERVER=https://127.0.0.1:1'+'\n');assert.equal(s.cli(['bark']).status,0);
  let result=s.cli(['test'],{CM_NOTIFY_DRY_RUN:'1'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/^渠道 bark：演练模式（CM_NOTIFY_DRY_RUN=1），没有运行发送命令、没有联网，也没有读取或检查密钥文件（是否填好请用 \/cm:notify 查看）；下面是按渠道设置生成的脱敏请求。\nPOST https:\/\/api.day.app\/push\n/);
  assert.match(result.stdout,/"device_key":"<已隐藏>","title":"CM 测试推送"/);noSecret(result.stdout);
  assert.equal(s.log(),'','dry-run runs nothing');
  result=s.cli(['test']);// real sender, loopback port 1: refused connection, no external network
  assert.equal(result.status,SEND_EXIT.network,result.stderr);
  assert.equal(result.stdout,'渠道 bark：退出码 3，网络失败或超时。\n');
  noSecret(result.stdout+result.stderr);noSecret(s.log(),'notify.log');
  assert.match(s.log(),/test cm-notify key=- test failed exit_3/);
  // A custom command receives the same contract as the runtime launcher.
  const record=path.join(s.root,'record.json'),script=path.join(s.root,'fake.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({title:process.env.CM_NOTIFY_TITLE,body:process.env.CM_NOTIFY_BODY,stdin:input}));
process.stderr.write('custom says ${BARK_SECRET}');});`);
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,script]}));
  for(let round=0;round<6;round++){result=s.cli(['test']);assert.equal(result.status,0,result.stderr);}
  assert.equal(result.stdout,'自定义命令：退出码 0，已被推送服务接受（不代表已送达）。\n');noSecret(result.stdout+result.stderr,'custom output is not shown');
  const seen=JSON.parse(fs.readFileSync(record,'utf8'));
  assert.equal(seen.title,'CM 测试推送');assert.match(seen.body,/^这是 \/cm:notify test 发出的测试消息。\n时间：\d\d:\d\d$/);
  assert.deepEqual(JSON.parse(seen.stdin),{title:seen.title,body:seen.body,event:'test',workflow:'cm-notify'});assert(seen.stdin.endsWith('\n'));
  assert(!s.exists('notify-state.json'),'test pushes are not deduped or counted');
  const slow=path.join(s.root,'slow.mjs');fs.writeFileSync(slow,'setTimeout(()=>{},60000);');
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,slow]}));
  const timed=await sendTest(s.home,{env:s.env,timeoutMs:300});
  assert.deepEqual([timed.exit,timed.reason],[null,'timeout']);
});

test('switch writes everything or nothing, and the CLI refuses the real home under node --test',async t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('notify-channel.conf','CHANNEL=pushplus\n');
  const before=s.snapshot();
  await assert.rejects(()=>switchChannel(s.home,'bark',{senderSource:path.join(s.root,'missing.mjs')}),/找不到发送器/);
  assert.deepEqual(s.snapshot(),before);
  if(posix){
    fs.mkdirSync(path.join(s.home,'notify'));fs.symlinkSync(path.join(s.root,'x'),managedSenderPath(s.home));
    await assert.rejects(()=>switchChannel(s.home,'bark'),/不是普通文件/);
    fs.rmSync(path.join(s.home,'notify'),{recursive:true});
    assert.deepEqual(s.snapshot(),before);
  }
  const env={...process.env,NODE_TEST_CONTEXT:'child'};delete env.CM_WORKFLOW_HOME;
  const err=sink();
  assert.equal(await main(['status'],{env,stdout:sink().stream,stderr:err.stream}),2);
  assert.match(err.text(),/必须设置 CM_WORKFLOW_HOME/);
});

test('only the exact command shape counts as managed or legacy; look-alikes are custom and protected',t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const sender=managedSenderPath(s.home),legacy=path.join(s.home,'cm-notify.py');
  for(const command of [['/bin/echo',sender],[process.execPath,sender,'--extra'],['node',sender],[path.join(s.root,'nodejs'),sender],
    [process.execPath,path.join(s.home,'notify','other.mjs')],['/usr/bin/python3',legacy],[legacy,'--flag']]){
    s.write('notify.json',JSON.stringify({version:1,command}));const before=s.snapshot();
    assert.equal(classifyCommand(s.home,command),'custom',JSON.stringify(command));
    const result=s.cli(['bark']);
    assert.equal(result.status,2,JSON.stringify(command));assert.match(result.stderr,/--replace-custom/);
    assert.deepEqual(s.snapshot(),before);
  }
  assert.equal(classifyCommand(s.home,[process.execPath,sender]),'managed');
  assert.equal(classifyCommand(s.home,[legacy]),'legacy');
});

test('test never relays any command output, maps exit codes to fixed words, strips NODE_OPTIONS and runs the checked snapshot',async t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);assert.equal(s.cli(['bark']).status,0);
  const record=path.join(s.root,'record.json');
  const fake=code=>`import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({options:process.env.NODE_OPTIONS??null,execArgv:process.execArgv}));
process.stdout.write('${BARK_SECRET}\\n');process.stderr.write('cm-notify: leaked ${BARK_SECRET}\\n');process.exit(${code});});`;
  // The installed managed sender itself is replaced: same command shape, output still never shown.
  const preload=path.join(s.root,'preload.cjs');fs.writeFileSync(preload,'// harmless for the manager itself\n');
  const words={0:'已被推送服务接受（不代表已送达）',2:'配置或密钥问题',3:'网络失败或超时',4:'服务端拒绝',7:'未知'};
  for(const [code,word] of Object.entries(words)){
    fs.writeFileSync(managedSenderPath(s.home),fake(code),{mode:0o600});
    const result=s.cli(['test'],{NODE_OPTIONS:`--require=${preload}`});
    assert.equal(result.status,Number(code),result.stderr);
    assert.equal(result.stdout,`渠道 bark：退出码 ${code}，${word}。\n`);noSecret(result.stdout+result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(record,'utf8')),{options:null,execArgv:[]},'NODE_OPTIONS is not passed to the sender');
  }
  // Dry-run never runs the installed command.
  fs.rmSync(record);
  const dry=s.cli(['test'],{CM_NOTIFY_DRY_RUN:'1'});
  assert.equal(dry.status,0);assert(!fs.existsSync(record));noSecret(dry.stdout);assert.match(dry.stdout,/<已隐藏>/);
  // Custom commands cannot be dry-run.
  const other=path.join(s.root,'other.mjs');fs.writeFileSync(other,fake(0));
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,other]}));
  const refused=s.cli(['test'],{CM_NOTIFY_DRY_RUN:'1'});assert.equal(refused.status,2);assert.match(refused.stderr,/演练模式只适用于/);assert(!fs.existsSync(record));
  // The command that runs is the snapshot that was checked, even if notify.json changes in between.
  fs.writeFileSync(managedSenderPath(s.home),fake(0),{mode:0o600});
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,managedSenderPath(s.home)]}));
  const result=await sendTest(s.home,{env:s.env,beforeSpawn:()=>s.write('notify.json',JSON.stringify({version:1,command:['/bin/sh','-c','exit 9']}))});
  assert.equal(result.exit,0);assert.deepEqual(JSON.parse(fs.readFileSync(record,'utf8')).execArgv,[]);
  assert.equal(formatTest(result),'渠道 bark：退出码 0，已被推送服务接受（不代表已送达）。');
});

// Simulated slow reads: file-system calls of the sender replaced through its module API.
const delayedOps=({lstatMs=0,block=false,before}={})=>({open:fsp.open,lstat:async(file,options)=>{
  before?.();
  if(block){const end=performance.now()+lstatMs;while(performance.now()<end){}}
  else if(lstatMs)await new Promise(resolve=>setTimeout(resolve,lstatMs));
  return fsp.lstat(file,options);}});

test('slow reads (blocking or async) end with 3 on time; dry-run, --check and sends never return 0 after the budget',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  let sent=0;const request=()=>{sent++;throw new Error('must not send');};
  const kinds={blocking:delayedOps({lstatMs:100,block:true}),slowAsync:delayedOps({lstatMs:400})};
  for(const [kind,fileOps] of Object.entries(kinds))for(const [argv,env] of [[[],{}],[[],{CM_NOTIFY_DRY_RUN:'1'}],[['--check'],{}]])for(const deadlineMs of [20,60]){
    const err=sink(),out=sink();const begin=performance.now();
    const code=await runSender({argv,env:{...s.env,...env},home:s.home,stdin:endedStdin(),stdout:out.stream,stderr:err.stream,fileOps,request,deadlineMs});
    const took=performance.now()-begin,label=`${kind} ${argv} ${JSON.stringify(env)} ${deadlineMs}`;
    assert.equal(code,SEND_EXIT.network,label);assert.equal(out.text(),'',label);
    assert.match(err.text(),/^cm-notify: 整次调用超过 1 秒，已放弃/,label);
    if(kind==='slowAsync')assert(took<deadlineMs+150,`${label} returned on time (${Math.round(took)} ms)`);
  }
  assert.equal(sent,0,'no request was started after the budget ran out');
  // Every exit 0 checks the budget itself: time passes during a read but the timer has not run yet.
  const server0=await fakeServer(t,(req,res)=>json(res,200,{code:200}));
  for(const [argv,env,req] of [[['--check'],{},request],[[],{CM_NOTIFY_DRY_RUN:'1'},request],[[],{},server0.request]]){
    let now=0,reads=0;const err=sink(),out=sink();
    const lastRead=argv.length||env.CM_NOTIFY_DRY_RUN?(argv.length?2:1):99;
    const code=await runSender({argv,env:{...s.env,...env},home:s.home,stdin:endedStdin(),stdout:out.stream,stderr:err.stream,deadlineMs:5000,
      clock:()=>now,request:(...args)=>{now=6000;return req(...args);},fileOps:delayedOps({before:()=>{if(++reads===lastRead)now=6000;}})});
    assert.equal(code,SEND_EXIT.network,`${argv} ${JSON.stringify(env)}`);assert.equal(out.text(),'');assert.match(err.text(),/整次调用超过 5 秒，已放弃/);
  }
  assert.equal(server0.seen.length,1,'the late send was accepted but is still reported as 3');
  // With enough budget the same slow read still sends.
  const server=await fakeServer(t,(req,res)=>json(res,200,{code:200}));
  const code=await runSender({env:s.env,home:s.home,stdin:endedStdin(),stdout:sink().stream,stderr:sink().stream,fileOps:kinds.blocking,request:server.request,deadlineMs:2000});
  assert.equal(code,0);assert.equal(server.seen.length,1);
});

test('the process entry arms a hard timer: a read that never settles still exits 3 at the deadline',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const sender=new URL('../runtime/js/notify-send.mjs',import.meta.url).href;
  // The soft deadline is disabled so only the hard timer can end the process.
  const script=`import {runCli} from ${JSON.stringify(sender)};
import fsp from 'node:fs/promises';
runCli({argv:[],deadlineMs:300,softDeadlineMs:1e9,senderOptions:{fileOps:{open:fsp.open,lstat:()=>new Promise(()=>{})}}});`;
  for(const extra of [{},{CM_NOTIFY_DRY_RUN:'1'}]){
    const begin=performance.now();
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:'{}\n',encoding:'utf8',env:{...s.env,...extra},timeout:10000});
    const took=performance.now()-begin;
    assert.equal(result.status,SEND_EXIT.network,result.stderr);assert.equal(result.stdout,'');
    assert.equal(result.stderr,'cm-notify: 整次调用超过 1 秒，已放弃\n');
    assert(took<3000,`exited on time (${Math.round(took)} ms)`);
  }
});

test('off restores the previous notify.off.json when moving notify.json fails, and names the backup if that fails too',t=>{
  const s=sandbox(t);
  const on=JSON.stringify({version:1,command:['/bin/true'],waitMinutes:5}),old=JSON.stringify({version:1,command:['/bin/false'],note:'old off'});
  const fail=(match,code='EACCES')=>{const calls=[];return {calls,ops:{renameSync:(from,to)=>{calls.push([path.basename(from),path.basename(to)]);
    if(match(from,to,calls.length)){const error=new Error('injected');error.code=code;throw error;}return fs.renameSync(from,to);}}};};
  const reset=()=>{for(const name of fs.readdirSync(s.home))fs.rmSync(path.join(s.home,name),{recursive:true});s.write('notify.json',on);s.write('notify.off.json',old);};
  // Second rename fails: the old off file goes back to its place.
  reset();let before=s.snapshot();
  let fault=fail((from,to,n)=>n===2);
  assert.throws(()=>turnOff(s.home,{ops:fault.ops}),error=>{assert.match(error.message,/关闭失败（EACCES）：notify.json 仍在原处，提醒仍开启；原来的 notify.off.json 已放回原处/);return true;});
  assert.deepEqual(s.snapshot(),before);assert.equal(fault.calls.length,3);
  // Second rename and the restore both fail: the message names the backup path, and the backup holds the old content.
  reset();
  fault=fail((from,to,n)=>n>=2);
  assert.throws(()=>turnOff(s.home,{ops:fault.ops}),error=>{
    const backup=fs.readdirSync(s.home).find(name=>name.startsWith('notify.off.json.bak-'));
    assert(backup);assert.equal(s.read(backup),old);assert.equal(s.read('notify.json'),on);assert(!s.exists('notify.off.json'));
    assert(error.message.includes(path.join(s.home,backup)),error.message);assert.match(error.message,/放回时也失败（EACCES），请手动把它改回 notify.off.json/);return true;});
  // First rename fails: nothing changed.
  reset();before=s.snapshot();
  assert.throws(()=>turnOff(s.home,{ops:fail(()=>true).ops}),/什么都没改/);assert.deepEqual(s.snapshot(),before);
  // Without an old off file a failed move reports that notify.json is still on.
  reset();fs.rmSync(path.join(s.home,'notify.off.json'));before=s.snapshot();
  assert.throws(()=>turnOff(s.home,{ops:fail(()=>true).ops}),/notify.json 仍在原处，提醒仍开启；其他文件没改/);assert.deepEqual(s.snapshot(),before);
  // Normal path keeps the old off file as a backup.
  reset();const done=turnOff(s.home);assert.equal(done.changed,true);assert.equal(s.read('notify.off.json'),on);assert.equal(fs.readFileSync(done.backup,'utf8'),old);
});

test('a partly written switch is rolled back without extra copies; whatever cannot be restored is named with where its content is',async t=>{
  const s=sandbox(t);
  const custom=JSON.stringify({version:1,command:['/usr/local/bin/mine'],waitMinutes:9});
  const reset=()=>{for(const name of fs.readdirSync(s.home))fs.rmSync(path.join(s.home,name),{recursive:true});
    s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('notify-channel.conf','# 原来\nCHANNEL=pushplus\n');s.write('notify.json',custom);};
  const injected=code=>Object.assign(new Error('injected'),{code});
  const faulty=({rename=()=>false,unlink=()=>false})=>({writeFileSync:fs.writeFileSync,chmodSync:fs.chmodSync,
    renameSync:(from,to)=>{if(rename(from,to))throw injected('EIO');return fs.renameSync(from,to);},
    unlinkSync:file=>{if(unlink(file))throw injected('EBUSY');return fs.unlinkSync(file);}});
  const conf=path.join(s.home,'notify-channel.conf'),notifyJson=path.join(s.home,'notify.json'),sender=managedSenderPath(s.home);
  const tempTo=target=>(from,to)=>from.endsWith('.tmp')&&to===target;// the atomic write of `target`
  const isBackup=from=>path.basename(from).startsWith('notify.json.bak-');
  const noCopies=()=>assert.deepEqual(fs.readdirSync(s.home).filter(name=>/restore|\.tmp$/.test(name)),[],'no rescue copies or temp files');
  const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // 1. Writing notify.json fails; sender and channel file are put back and the renamed original returns: byte-identical.
  reset();let before=s.snapshot();
  await assert.rejects(()=>switchChannel(s.home,'bark',{replaceCustom:true,ops:faulty({rename:tempTo(notifyJson)})}),error=>{
    assert.match(error.message,new RegExp(`切换失败：写 ${escape(notifyJson)} 时失败（EIO）；已写入的文件都已恢复原样`));
    assert.deepEqual(error.unrestored,[]);assert.deepEqual(error.restored,[conf,sender,notifyJson]);return true;});
  assert.deepEqual(s.snapshot(),before,'no backup left behind and nothing changed');noCopies();
  // 2. Restoring the channel file fails too: never claims success, says its old content is not on disk, no copy is made.
  reset();
  let confWrites=0;
  await assert.rejects(()=>switchChannel(s.home,'bark',{replaceCustom:true,ops:faulty({rename:(from,to)=>tempTo(notifyJson)(from,to)||(tempTo(conf)(from,to)&&++confWrites>1)})}),error=>{
    assert.doesNotMatch(error.message,/都已恢复原样/);
    assert.deepEqual(error.unrestored.map(entry=>entry.file),[conf]);
    assert(error.message.includes(`${conf} 没能恢复（EIO），原内容没有留在磁盘上`),error.message);
    assert(error.message.includes(`已恢复：${sender}、${notifyJson}`),error.message);return true;});
  assert.equal(s.read('notify.json'),custom,'the renamed original is back');
  assert.match(s.read('notify-channel.conf'),/CHANNEL=bark/,'the unrestored file is reported, not hidden');noCopies();
  // 3. The renamed original cannot be put back: the message says where it still is.
  reset();
  await assert.rejects(()=>switchChannel(s.home,'bark',{replaceCustom:true,ops:faulty({rename:(from,to)=>tempTo(notifyJson)(from,to)||isBackup(from)})}),error=>{
    const backup=fs.readdirSync(s.home).find(name=>name.startsWith('notify.json.bak-'));
    assert(backup);assert.equal(s.read(backup),custom);assert(!s.exists('notify.json'));
    assert(error.message.includes(`${notifyJson} 没能改回原名（EIO），原内容仍在 ${path.join(s.home,backup)}`),error.message);return true;});
  noCopies();
  // 4. A newly created sender that cannot be removed is reported as such.
  reset();
  await assert.rejects(()=>switchChannel(s.home,'bark',{replaceCustom:true,ops:faulty({rename:tempTo(notifyJson),unlink:file=>file===sender})}),error=>{
    assert(error.message.includes(`${sender} 是这次新建的，没能删除（EBUSY）`),error.message);return true;});
  // 5. The backup rename itself fails: nothing changed.
  reset();before=s.snapshot();
  await assert.rejects(()=>switchChannel(s.home,'bark',{replaceCustom:true,ops:faulty({rename:(from,to)=>from===notifyJson})}),/备份 .* 失败（EIO），什么都没改/);
  assert.deepEqual(s.snapshot(),before);
  reset();assert.equal(s.cli(['bark','--replace-custom']).status,0);
});

test('the backup of a replaced config is the original file renamed, so its permissions travel with it',{skip:!posix},t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const original=s.write('notify.json',JSON.stringify({version:1,command:['/usr/local/bin/mine']}),0o640);
  const ino=fs.statSync(original).ino;
  assert.equal(s.cli(['bark','--replace-custom']).status,0);
  const backup=path.join(s.home,fs.readdirSync(s.home).find(name=>name.startsWith('notify.json.bak-')));
  assert.equal(fs.statSync(backup).ino,ino,'same file, renamed');assert.equal(fs.statSync(backup).mode&0o777,0o640);
  assert.equal(fs.statSync(original).mode&0o777,0o600,'the new notify.json is private');assert.notEqual(fs.statSync(original).ino,ino);
  // From notify.off.json: the off file itself becomes the backup.
  fs.rmSync(original);const off=s.write('notify.off.json',JSON.stringify({version:1,command:['/usr/local/bin/mine'],idleMinutes:30}),0o640);
  const offIno=fs.statSync(off).ino;
  assert.equal(s.cli(['pushplus','--replace-custom']).status,2,'pushplus secret is missing');
  s.write('pushplus.env','PUSHPLUS_TOKEN=FakePushplusToken789\n');
  assert.equal(s.cli(['pushplus','--replace-custom']).status,0);
  const offBackup=path.join(s.home,fs.readdirSync(s.home).find(name=>name.startsWith('notify.off.json.bak-')));
  assert.equal(fs.statSync(offBackup).ino,offIno);assert(!s.exists('notify.off.json'));assert.equal(JSON.parse(s.read('notify.json')).idleMinutes,30);
});

test('the opened handle must be the file that was checked by path: a swap is refused before reading',async t=>{
  const s=sandbox(t);
  const file=s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`),other=s.write('other.env',`BARK_KEY=${OTHER_BARK_SECRET}\n`);
  // The path is swapped between the lstat check and the open.
  const swapped={lstat:fsp.lstat,open:async(...args)=>{fs.renameSync(file,`${file}.old`);fs.renameSync(other,file);return fsp.open(...args);}};
  await assert.rejects(()=>readPrivateFile(file,'bark.env',{fileOps:swapped}),error=>{
    assert.equal(error.exit,SEND_EXIT.config);assert.match(error.message,/bark.env 在核对期间被替换/);noSecret(error.message);return true;});
  assert.equal(await readPrivateFile(file,'bark.env'),`BARK_KEY=${OTHER_BARK_SECRET}\n`,'an unchanged path reads normally');
});

test('Windows is refused on every path with exit 2 and no network',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  let sent=0;const request=()=>{sent++;throw new Error('must not send');};
  // The sender: normal, --check and dry-run.
  for(const [argv,env] of [[[],{}],[['--check'],{}],[[],{CM_NOTIFY_DRY_RUN:'1'}]]){
    const out=sink(),err=sink();
    const code=await runSender({argv,env:{...s.env,...env},home:s.home,stdin:endedStdin(),stdout:out.stream,stderr:err.stream,platform:'win32',request,
      fileOps:{lstat:()=>{throw new Error('must not touch files');},open:()=>{throw new Error('must not touch files');}}});
    assert.equal(code,SEND_EXIT.config,`${argv}`);assert.equal(out.text(),'');assert.equal(err.text(),`cm-notify: ${WINDOWS_UNSUPPORTED}\n`);
  }
  assert.equal(sent,0);
  // The manager: switch, test and dry-run refuse before touching any file; nothing is created.
  assert.equal(s.cli(['bark']).status,0,'set up on POSIX first');
  const before=s.snapshot();
  for(const [argv,env] of [[['bark'],{}],[['pushplus'],{}],[['pushplus','--replace-custom'],{}],[['test'],{}],[['test'],{CM_NOTIFY_DRY_RUN:'1'}]]){
    const out=sink(),err=sink();
    const code=await main(argv,{env:{...s.env,...env},stdout:out.stream,stderr:err.stream,platform:'win32'});
    assert.equal(code,2,`${argv}`);assert.equal(out.text(),'');assert.equal(err.text(),`cm-notify: ${WINDOWS_UNSUPPORTED}\n`);
  }
  assert.deepEqual(s.snapshot(),before,'no file changed, no template created, nothing logged');
  // Status still shows the channel and whether each secret file exists, without reading secret content.
  fs.chmodSync(path.join(s.home,'bark.env'),0o000);
  const out=sink();
  assert.equal(await main([],{env:s.env,stdout:out.stream,stderr:sink().stream,platform:'win32'}),0);
  assert.match(out.text(),new RegExp(WINDOWS_UNSUPPORTED));
  assert.match(out.text(),/当前渠道：bark（Windows 上不会发送）/);
  assert.match(out.text(),/渠道 bark：文件存在（Windows 上不读取内容，无法判断是否填好）/);
  assert.match(out.text(),/渠道 pushplus：未填写（文件不存在）/);noSecret(out.text());
  fs.chmodSync(path.join(s.home,'bark.env'),0o600);
});

test('time spent before the sender work counts toward the same 12 s budget',async t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const sender=new URL('../runtime/js/notify-send.mjs',import.meta.url).href;
  const run=(body,extra={})=>{const begin=performance.now();
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import {runCli} from ${JSON.stringify(sender)};\n${body}`],
      {input:'{}\n',encoding:'utf8',env:{...s.env,...extra},timeout:15000});
    return {...result,took:performance.now()-begin};};
  // The start recorded at entry is honoured: time already spent leaves no budget for an exit 0.
  for(const argv of [['--check'],[]]){
    const result=run(`import {performance} from 'node:perf_hooks';runCli({argv:${JSON.stringify(argv)},startedAt:performance.now()-12050});`,{CM_NOTIFY_DRY_RUN:'1'});
    assert.equal(result.status,SEND_EXIT.network,`${argv} ${result.stderr}`);assert.equal(result.stdout,'');assert(result.took<5000);
  }
  // 250 ms already spent, the slow read needs more than the 50 ms left: 3, never 0.
  const result=run(`import {performance} from 'node:perf_hooks';import fsp from 'node:fs/promises';
runCli({argv:['--check'],deadlineMs:300,startedAt:performance.now()-250,senderOptions:{fileOps:{open:fsp.open,lstat:async(f,o)=>{await new Promise(r=>setTimeout(r,200));return fsp.lstat(f,o);}}}});`);
  assert.equal(result.status,SEND_EXIT.network,result.stderr);assert.equal(result.stdout,'');assert(result.took<3000);
});

test('entry is decided by import.meta.main alone: imported does nothing, unsupported Node exits 3, Windows is refused first',()=>{
  assert.equal(entryDecision(true,'darwin'),'run');assert.equal(entryDecision(true,'linux'),'run');
  assert.equal(entryDecision(true,'win32'),'windows');
  assert.equal(entryDecision(false,'win32'),'imported');assert.equal(entryDecision(false,'linux'),'imported');
  assert.equal(entryDecision(undefined,'linux'),'unsupported_node');assert.equal(entryDecision(undefined,'win32'),'unsupported_node');
  const source=fs.readFileSync(SENDER_SOURCE,'utf8'),manager=fs.readFileSync(fileURLToPath(new URL('./cm-notify.mjs',import.meta.url)),'utf8');
  assert.doesNotMatch(source+manager,/realpath/,'no path resolution is used for entry detection');
  // In the sender the hard timer is armed and the Windows refusal follows it before any other statement runs.
  const order=['const ENTRY_STARTED_AT','const ENTRY=entryDecision','process.exit(3);}','const ENTRY_HARD_TIMER',"if(ENTRY==='windows')",'export const SEND_EXIT'].map(mark=>source.indexOf(mark));
  assert(order.every((at,i)=>at>=0&&(i===0||at>order[i-1])),`entry order ${order}`);
});

test('symlinked entries with another name still run, both sender and manager',{skip:!posix},t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const senderAlias=path.join(s.root,'alias-sender.mjs');fs.symlinkSync(SENDER_SOURCE,senderAlias);
  let result=spawnSync(process.execPath,[senderAlias,'--check'],{input:'',encoding:'utf8',env:s.env,timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'cm-notify: 渠道 bark 配置可解析（未发送）\n');
  const managerAlias=path.join(s.root,'notify-alias.mjs');fs.symlinkSync(CLI,managerAlias);
  result=spawnSync(process.execPath,[managerAlias,'status'],{encoding:'utf8',env:s.env,timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/CM 提醒设置/);noSecret(result.stdout);
});

test('the manager refuses Windows as its first action, before the test-home guard or any file access',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-win-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'never-created');
  for(const env of [{...process.env,NODE_TEST_CONTEXT:'child',CM_WORKFLOW_HOME:undefined},{...process.env,CM_WORKFLOW_HOME:home}])
    for(const argv of [['bark'],['pushplus','--replace-custom'],['test'],['nonsense']]){
      const err=sink(),out=sink();
      assert.equal(await main(argv,{env,stdout:out.stream,stderr:err.stream,platform:'win32'}),2,`${argv}`);
      assert.equal(err.text(),`cm-notify: ${WINDOWS_UNSUPPORTED}\n`);assert.equal(out.text(),'');
    }
  assert(!fs.existsSync(home),'nothing was created');
});

test('the channel file is read through the safe boundary: never via a symlink, size capped, identity checked',async t=>{
  const s=sandbox(t);
  const secret=s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`),conf=path.join(s.home,'notify-channel.conf');
  fs.symlinkSync(secret,conf);
  const noOpen={lstat:fsp.lstat,open:()=>{throw new Error('must not open');}};
  await assert.rejects(()=>readRegularFile(conf,'notify-channel.conf',{fileOps:noOpen}),error=>{
    assert.match(error.message,/notify-channel.conf 必须是普通文件（不能是符号链接）/);noSecret(error.message);return true;});
  // Windows status shows the problem without reading the linked secret.
  const out=sink();
  assert.equal(await main([],{env:s.env,stdout:out.stream,stderr:sink().stream,platform:'win32'}),0);
  assert.match(out.text(),/当前渠道：无法确定：notify-channel.conf 必须是普通文件（不能是符号链接）/);noSecret(out.text());
  // POSIX status refuses the link as well.
  const posixOut=sink();
  assert.equal(await main([],{env:s.env,stdout:posixOut.stream,stderr:sink().stream,platform:'linux'}),0);
  assert.match(posixOut.text(),/当前渠道：无法确定：notify-channel.conf 必须是自己的普通文件且权限 600/);noSecret(posixOut.text());
  fs.rmSync(conf);
  // Directories, oversized files and swapped files are refused.
  fs.mkdirSync(conf);await assert.rejects(()=>readRegularFile(conf,'notify-channel.conf'),/必须是普通文件/);fs.rmdirSync(conf);
  fs.writeFileSync(conf,'#'.repeat(70*1024));
  await assert.rejects(()=>readRegularFile(conf,'notify-channel.conf',{fileOps:noOpen}),/notify-channel.conf 太大/);
  fs.writeFileSync(conf,'CHANNEL=bark\n');const other=s.write('other.conf','CHANNEL=pushplus\n');
  const swapped={lstat:fsp.lstat,open:async(...args)=>{fs.renameSync(conf,`${conf}.old`);fs.renameSync(other,conf);return fsp.open(...args);}};
  await assert.rejects(()=>readRegularFile(conf,'notify-channel.conf',{fileOps:swapped}),/在核对期间被替换/);
  assert.equal(await readRegularFile(conf,'notify-channel.conf'),'CHANNEL=pushplus\n');
});

test('the installed sender detects its entry without file-system resolution, also through a symlinked path',{skip:!posix},t=>{
  const s=sandbox(t);
  s.write('notify-channel.conf','CHANNEL=bark\n');s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);
  const real=path.join(s.root,'real');fs.mkdirSync(real);fs.copyFileSync(SENDER_SOURCE,path.join(real,'cm-notify-send.mjs'));
  const linked=path.join(s.root,'linked');fs.symlinkSync(real,linked);
  for(const dir of [real,linked]){
    const result=spawnSync(process.execPath,[path.join(dir,'cm-notify-send.mjs'),'--check'],{input:'',encoding:'utf8',env:s.env,timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'cm-notify: 渠道 bark 配置可解析（未发送）\n');
  }
});

test('manager dry-run never opens or checks the secret file',async t=>{
  const s=sandbox(t);
  const file=s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);assert.equal(s.cli(['bark']).status,0);
  // An unreadable, an empty and a missing secret file all give the same dry-run result: it is never read.
  const cases=[()=>fs.chmodSync(file,0o000),()=>{fs.chmodSync(file,0o600);fs.writeFileSync(file,'BARK_KEY=\n');},()=>fs.rmSync(file)];
  for(const prepare of cases){
    prepare();
    const result=s.cli(['test'],{CM_NOTIFY_DRY_RUN:'1'});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/也没有读取或检查密钥文件/);
    assert.match(result.stdout,/"device_key":"<已隐藏>"/);noSecret(result.stdout);
  }
  // Without dry-run the same missing file is refused.
  const result=s.cli(['test']);assert.equal(result.status,2);assert.match(result.stderr,/未填写（文件不存在）/);
});

// Optional notify.json `text` is the user's: /cm:notify keeps it (and any other
// unknown key) across switch, off and on, and status says which text is in use.
const CUSTOM_TEXT={titlePrefix:'提醒',headlines:{default:'卡住了',done:'完工'},fields:{default:['nextAction','task','time']},labels:{task:'工单'}};
test('custom text survives switch, off and on; status shows 文案：默认/自定义/无效 and writes nothing',t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('pushplus.env',`PUSHPLUS_TOKEN=${PUSH_SECRET}\n`);
  assert.equal(s.cli(['bark']).status,0);
  assert.match(s.cli([]).stdout,/\n文案：默认\n/);
  assert.equal(JSON.parse(s.cli(['--json']).stdout).config.textState,'default');
  const config={...JSON.parse(s.read('notify.json')),text:CUSTOM_TEXT,note:'kept'};s.write('notify.json',JSON.stringify(config));
  let result=s.cli([]);assert.match(result.stdout,/\n文案：自定义（\/cm:notify preview 查看效果）\n/);
  let parsed=JSON.parse(s.cli(['status','--json']).stdout);
  assert.equal(parsed.config.textState,'custom');assert.equal(JSON.stringify(parsed).includes('卡住了'),false,'status lists no custom strings');
  result=s.cli(['pushplus']);assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/text 无效/);
  assert.deepEqual(JSON.parse(s.read('notify.json')).text,CUSTOM_TEXT);assert.equal(JSON.parse(s.read('notify.json')).note,'kept');
  assert.equal(s.cli(['off']).status,0);
  assert.deepEqual(JSON.parse(s.read('notify.off.json')).text,CUSTOM_TEXT);
  assert.doesNotMatch(s.cli([]).stdout,/文案：/);
  result=s.cli(['bark']);assert.equal(result.status,0,result.stderr);
  const restored=JSON.parse(s.read('notify.json'));
  assert.deepEqual(restored.text,CUSTOM_TEXT);assert.equal(restored.note,'kept');assert.equal(restored.command[1],managedSenderPath(s.home));
  assert.match(s.cli([]).stdout,/\n文案：自定义/);
  // A broken text is kept as written, never dropped; notices stay on with the default text.
  const broken={...restored,text:{fields:{default:['diff']}}};s.write('notify.json',JSON.stringify(broken));
  result=s.cli([]);assert.match(result.stdout,/\n文案：默认（notify.json 里的 text 无效：fields，已改用默认文案，提醒照常发送）\n/);
  assert.match(result.stdout,/当前渠道：bark（生效中）/);
  parsed=JSON.parse(s.cli(['--json']).stdout);assert.equal(parsed.config.textState,'invalid');assert.equal(parsed.config.textReason,'fields');
  result=s.cli(['pushplus']);assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/提示：notify.json 里的 text 无效（fields），提醒使用默认文案/);
  assert.deepEqual(JSON.parse(s.read('notify.json')).text,broken.text);
  assert.equal(s.log(),'','status and switch write nothing to notify.log');
  noSecret(s.cli([]).stdout);
});

test('preview prints every event from sample fields with the current text; it sends, logs and changes nothing',async t=>{
  const s=sandbox(t);
  const at={now:Date.parse('2026-10-08T08:00:00.000Z'),timeZone:'Asia/Shanghai'};
  let preview=await previewText(s.home,at);
  assert.equal(preview.textState,null);assert.deepEqual(preview.messages.map(m=>m.event),['stuck','waiting','idle','idle_waiting','dead','done']);
  assert.equal(preview.messages[0].title,'CM cm-ai 需要人处理 · demo-app');
  assert.equal(preview.messages[5].body,'项目：demo-app\n任务：T-001\n时间：16:00');
  assert.match(formatPreview(preview),/^提醒文案预览，用示例字段生成，不发送。文案：默认（没有生效的 notify.json，按默认文案预览）\n/);
  // Point notify.json at a command that would record any run: preview must never run it.
  const ran=path.join(s.root,'ran');
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(ran)},'x')`],text:CUSTOM_TEXT}));
  preview=await previewText(s.home,at);
  assert.equal(preview.textState,'custom');
  assert.deepEqual(preview.messages.map(m=>m.title),['提醒 cm-ai 卡住了 · demo-app','提醒 cm-ai 等待会话应答 · demo-app','提醒 cm-ai 疑似空转 · demo-app',
    '提醒 cm-ai 在等你 · demo-app','提醒 cm-ai 宿主已退出未收尾 · demo-app','提醒 cm-ai 完工 · demo-app']);
  assert.equal(preview.messages[0].body,'下一步：核对原因后恢复原运行\n工单：T-001\n时间：16:00');
  assert.equal(preview.messages[5].body,'项目：demo-app\n工单：T-001\n时间：16:00');
  const before=s.snapshot();
  let result=s.cli(['preview']);assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/^提醒文案预览，用示例字段生成，不发送。文案：自定义\n\n【卡住，需要人处理】stuck\n标题：提醒 cm-ai 卡住了 · demo-app\n下一步：核对原因后恢复原运行\n工单：T-001\n时间：\d\d:\d\d\n/);
  assert.match(result.stdout,/【流程已结束】done\n标题：提醒 cm-ai 完工 · demo-app\n/);
  assert.equal(JSON.parse(s.cli(['preview','--json']).stdout).messages.length,6);
  // Also allowed on Windows: it reads notify.json only, never a secret file.
  const out=sink();assert.equal(await main(['preview'],{env:s.env,stdout:out.stream,stderr:sink().stream,platform:'win32'}),0);
  assert.match(out.text(),/标题：提醒 cm-ai 卡住了 · demo-app/);
  s.write('notify.json',JSON.stringify({version:1,command:['/bin/true'],text:{labels:{secret:'x'}}}));
  assert.match(s.cli(['preview']).stdout,/文案：默认（notify.json 里的 text 无效：labels，已改用默认文案，提醒照常发送）\n\n【卡住，需要人处理】stuck\n标题：CM cm-ai 需要人处理 · demo-app\n/);
  s.write('notify.json','not json');
  assert.match(s.cli(['preview']).stdout,/文案：默认（notify.json 无效，按默认文案预览）/);
  s.write('notify.json',JSON.stringify({version:1,command:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(ran)},'x')`],text:CUSTOM_TEXT}));
  assert.deepEqual(s.snapshot(),before,'preview wrote nothing');assert(!fs.existsSync(ran),'the command never ran');
  assert.equal(s.log(),'');
});

// notify.json is read through the same safe boundary as the channel file in
// every manager path: a symlink (e.g. to a secret file), a FIFO or an oversized
// file is never read; status says so instead of guessing.
test('status, preview, test and switch never follow a notify.json symlink or read a non-regular or oversized file',{skip:!posix},async t=>{
  const s=sandbox(t);
  s.write('bark.env',`BARK_KEY=${BARK_SECRET}\n`);s.write('notify-channel.conf','CHANNEL=bark\n');
  // The link target is valid JSON with a marker: if anything followed the link, the marker would show up.
  const target=s.write('elsewhere.json',JSON.stringify({version:1,command:['/bin/true'],text:{headlines:{default:'LEAKED'}}}));
  const link=path.join(s.home,'notify.json');fs.symlinkSync(target,link);
  let status=await notifyStatus(s.home);
  assert.equal(status.config.state,'invalid');assert.equal(status.config.reason,'not_regular_file');
  let result=s.cli([]);assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/发送命令：notify.json 不是普通文件（可能是符号链接），cm-notify 不读取它，无法确认提醒是否生效/);
  const preview=await previewText(s.home,{now:Date.parse('2026-10-08T08:00:00.000Z'),timeZone:'UTC'});
  assert.equal(preview.state,'invalid');assert.equal(preview.textState,null);
  assert.equal(preview.messages[0].title,'CM cm-ai 需要人处理 · demo-app');
  result=s.cli(['preview']);assert.equal(result.status,0);assert.doesNotMatch(result.stdout,/LEAKED/);
  assert.match(result.stdout,/文案：默认（notify.json 无效，按默认文案预览）/);
  result=s.cli(['test']);assert.equal(result.status,2);assert.match(result.stderr,/notify.json 无效（not_regular_file）/);
  result=s.cli(['bark']);assert.equal(result.status,2);assert.match(result.stderr,/不是普通文件/);
  assert(fs.lstatSync(link).isSymbolicLink());assert.match(fs.readFileSync(target,'utf8'),/LEAKED/);
  // The same for notify.off.json as the base of a switch.
  fs.unlinkSync(link);fs.symlinkSync(target,path.join(s.home,'notify.off.json'));
  result=s.cli(['bark']);assert.equal(result.status,2);assert.match(result.stderr,/不是普通文件/);
  assert(!s.exists('notify.json'));fs.unlinkSync(path.join(s.home,'notify.off.json'));
  // A FIFO is refused at once instead of blocking the read.
  assert.equal(spawnSync('mkfifo',[link]).status,0);
  const started=performance.now();status=await notifyStatus(s.home);
  assert.equal(status.config.reason,'not_regular_file');assert(performance.now()-started<5000);
  fs.unlinkSync(link);
  // Oversized: not read, reported as such.
  s.write('notify.json',JSON.stringify({version:1,command:['/bin/true'],pad:'x'.repeat(70*1024)}));
  status=await notifyStatus(s.home);assert.equal(status.config.reason,'too_large');
  assert.match(s.cli([]).stdout,/notify.json 超过 64 KiB，cm-notify 不读取它/);
  // Switching from an oversized notify.off.json is refused before anything is read or written.
  fs.renameSync(path.join(s.home,'notify.json'),path.join(s.home,'notify.off.json'));
  const beforeSwitch=s.snapshot();
  result=s.cli(['bark']);assert.equal(result.status,2);assert.match(result.stderr,/notify.off.json 超过 64 KiB，cm-notify 不会改它/);
  assert.deepEqual(s.snapshot(),beforeSwitch);fs.unlinkSync(path.join(s.home,'notify.off.json'));
  // A regular file still works, byte for byte as the runtime reads it (a BOM stays invalid JSON for both).
  s.write('notify.json','﻿'+JSON.stringify({version:1,command:['/bin/true']}));
  status=await notifyStatus(s.home);assert.equal(status.config.state,'invalid');assert.equal(status.config.reason,'not_json');
  s.write('notify.json',JSON.stringify({version:1,command:['/bin/true'],text:{headlines:{default:'卡住了'}}}));
  status=await notifyStatus(s.home);assert.equal(status.config.state,'custom');assert.equal(status.config.textState,'custom');
  assert.equal(s.log(),'');
});
