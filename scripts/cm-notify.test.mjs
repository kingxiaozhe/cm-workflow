import {hostDiagnostic} from './fixtures/host-diagnostic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {notify,clearAttention,sessionTitle,scheduleWaitNotice,driveProgressKey,readNotifyConfig,parseNotifyConfig,buildNotifyMessage,normalizeNotifyText,driveNotice,NOTIFY_LIMITS,NOTIFY_WORKFLOWS,DEFAULT_NOTIFY_TEXT} from '../runtime/js/notify.mjs';

const NOW=Date.parse('2026-10-08T08:00:00.000Z');
const DRIVE_CORE=new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
const BRIDGE=new URL('../runtime/js/cm-ai/host-tool-bridge.mjs',import.meta.url).href;
const HOST_SESSION=new URL('../runtime/js/cm-ai/host-session.mjs',import.meta.url).href;

// A temp CM_WORKFLOW_HOME with notify.json pointing at a fake command that
// appends its environment message and stdin payload to sent.jsonl.
function home(t,{exit=0,sleepMs=0,config={}}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const sent=path.join(dir,'sent.jsonl'),script=path.join(dir,'fake-notify.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{setTimeout(()=>{fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify({title:process.env.CM_NOTIFY_TITLE,
body:process.env.CM_NOTIFY_BODY,stdin:JSON.parse(input),at:Date.now()})+'\\n');process.exit(${exit});},${sleepMs});});`);
  fs.writeFileSync(path.join(dir,'notify.json'),JSON.stringify({version:1,command:[process.execPath,script],...config}));
  // Never read the real Claude Code session of whoever runs the tests.
  const env={...process.env,CM_WORKFLOW_HOME:dir};delete env.CLAUDE_CODE_SESSION_ID;
  const rows=()=>{
    if(!fs.existsSync(sent))return [];
    const contents=fs.readFileSync(sent,'utf8'),completeEnd=contents.lastIndexOf('\n')+1;
    // appendFileSync may expose an empty file or an unfinished final record.
    // Only complete JSONL records are consumable; malformed complete JSON fails.
    return contents.slice(0,completeEnd).split('\n').slice(0,-1).map(line=>JSON.parse(line));
  };
  const log=()=>fs.existsSync(path.join(dir,'notify.log'))?fs.readFileSync(path.join(dir,'notify.log'),'utf8'):'';
  const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));return check();};
  return {dir,env,rows,log,until};
}
// The project shown in notices: the last two path segments, one when they are the same name
// (CI checks the repository out as .../cm-workflow/cm-workflow).
const label=dir=>{const base=path.basename(dir),parent=path.basename(path.dirname(dir));return parent&&parent!==base?`${parent}/${base}`:base;};
const fields=(key,over={})=>({key,event:'stuck',project:'/srv/work/demo-app',workflow:'cm-fix',runId:'run-1',
  task:'T-001',stage:'blocked',code:'checks_not_passed',nextAction:'核对 reason 后恢复原运行',...over});

test('fixture JSONL reader waits for complete records and rejects malformed complete JSON',t=>{
  const h=home(t),file=path.join(h.dir,'sent.jsonl');
  assert.deepEqual(h.rows(),[]);
  fs.writeFileSync(file,'');assert.deepEqual(h.rows(),[]);
  fs.writeFileSync(file,'{"marker":1');assert.deepEqual(h.rows(),[]);
  fs.appendFileSync(file,'}\n{"marker":');assert.deepEqual(h.rows(),[{marker:1}]);
  fs.appendFileSync(file,'2}\n');assert.deepEqual(h.rows(),[{marker:1},{marker:2}]);
  fs.appendFileSync(file,'{"bad":}\n');assert.throws(()=>h.rows(),SyntaxError);
});

test('off without notify.json, and off under node --test unless CM_WORKFLOW_HOME is explicit',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  assert.equal(readNotifyConfig({CM_WORKFLOW_HOME:dir}),null);
  assert.deepEqual(notify(fields('a'),{env:{CM_WORKFLOW_HOME:dir},now:NOW}),{sent:false,reason:'off'});
  assert.deepEqual(fs.readdirSync(dir),[]);
  assert.equal(readNotifyConfig({NODE_TEST_CONTEXT:'child-v8'}),null);
});

test('invalid config turns the feature off: relative command, bad version, bad waitMinutes',t=>{
  const h=home(t);const file=path.join(h.dir,'notify.json');
  for(const value of [{version:1,command:['notify.sh']},{version:2,command:['/bin/true']},{version:1,command:[]},
    {version:1,command:['/bin/true'],waitMinutes:0},'not json']){
    fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));
    assert.equal(readNotifyConfig(h.env),null,JSON.stringify(value));
  }
  assert.match(h.log(),/config - key=- off invalid_config command_not_absolute/);
  fs.writeFileSync(file,JSON.stringify({version:1,command:['/bin/true'],waitMinutes:0.5}));
  assert.deepEqual(readNotifyConfig(h.env),{command:['/bin/true'],waitMs:30000,checkWaitMs:2700000,idleMs:2700000,followUpMs:7200000,windowMs:600000,perWindow:3});
});

// The runtime reads notify.json through the same safe boundary as /cm:notify:
// no symlink, regular file only, 64 KiB cap, non-blocking open. Every refusal
// turns notices off with one notify.log line; nothing throws or waits.
// Each probe runs in its own process: the log line is once per process, and a
// build that blocks on a FIFO fails by timeout instead of hanging the suite.
const posix=process.platform!=='win32';
const CONFIG={version:1,command:['/bin/true']},PARSED={command:['/bin/true'],waitMs:600000,checkWaitMs:2700000,idleMs:2700000,followUpMs:7200000,windowMs:600000,perWindow:3};
const NOTIFY_URL=new URL('../runtime/js/notify.mjs',import.meta.url).href;
function probe(h){
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `import {readNotifyConfig,notify} from ${JSON.stringify(NOTIFY_URL)};
console.log(JSON.stringify({config:readNotifyConfig(process.env),sent:notify({key:'k'},{env:process.env})}));`],
  {env:{...process.env,CM_WORKFLOW_HOME:h.dir},encoding:'utf8',timeout:5000,killSignal:'SIGKILL'});
  assert.equal(child.error,undefined,'reading notify.json made the runtime wait');
  assert.equal(child.status,0,child.stderr);
  return JSON.parse(child.stdout);
}
const OFF={config:null,sent:{sent:false,reason:'off'}};
const unreadable=(h,reason)=>assert.match(h.log(),new RegExp(`config - key=- off invalid_config unreadable_${reason}\\n$`));

test('runtime read: notify.json that is a symlink is never read, even to a valid config; a normal file still is',{skip:!posix},t=>{
  const h=home(t);const file=path.join(h.dir,'notify.json'),real=path.join(h.dir,'real-config.json');
  fs.writeFileSync(real,JSON.stringify(CONFIG));fs.rmSync(file);fs.symlinkSync(real,file);
  assert.deepEqual(probe(h),OFF);unreadable(h,'not_regular_file');assert.equal(h.rows().length,0);
  // A dangling link is a link too: refused and logged, not treated as "missing".
  const dangling=home(t);fs.rmSync(path.join(dangling.dir,'notify.json'));fs.symlinkSync(path.join(dangling.dir,'nowhere.json'),path.join(dangling.dir,'notify.json'));
  assert.deepEqual(probe(dangling),OFF);unreadable(dangling,'not_regular_file');
  // The same content as a regular file reads exactly as before.
  fs.rmSync(file);fs.writeFileSync(file,JSON.stringify(CONFIG));
  assert.deepEqual(probe(h).config,PARSED);
});

test('runtime read: a FIFO at notify.json is refused at once, never waited on',{skip:!posix},t=>{
  const h=home(t);const file=path.join(h.dir,'notify.json');
  fs.rmSync(file);assert.equal(spawnSync('mkfifo',['-m','600',file]).status,0);
  assert.deepEqual(probe(h),OFF);unreadable(h,'not_regular_file');
});

test('runtime read: notify.json over 64 KiB is refused; exactly 64 KiB is still read',{skip:!posix},t=>{
  const json=JSON.stringify(CONFIG),pad=n=>json+' '.repeat(n-Buffer.byteLength(json));
  const over=home(t);fs.writeFileSync(path.join(over.dir,'notify.json'),pad(64*1024+1));
  assert.deepEqual(probe(over),OFF);unreadable(over,'too_large');
  const exact=home(t);fs.writeFileSync(path.join(exact.dir,'notify.json'),pad(64*1024));
  assert.deepEqual(probe(exact).config,PARSED);assert.equal(exact.log(),'');
});

test('runtime read: a missing file stays silent, a directory is a logged off, a BOM file behaves as before (not_json)',{skip:!posix},t=>{
  const missing=home(t);fs.rmSync(path.join(missing.dir,'notify.json'));
  assert.deepEqual(probe(missing),OFF);assert.equal(missing.log(),'');
  const dir=home(t);fs.rmSync(path.join(dir.dir,'notify.json'));fs.mkdirSync(path.join(dir.dir,'notify.json'));
  assert.deepEqual(probe(dir),OFF);unreadable(dir,'not_regular_file');
  // Same as the plain read it replaces: the BOM is not stripped, JSON.parse rejects it.
  const bom=home(t);fs.writeFileSync(path.join(bom.dir,'notify.json'),'\uFEFF'+JSON.stringify(CONFIG));
  assert.deepEqual(probe(bom),OFF);assert.match(bom.log(),/config - key=- off invalid_config not_json\n$/);
  // Invalid UTF-8 never throws; it is just an invalid file.
  const bad=home(t);fs.writeFileSync(path.join(bad.dir,'notify.json'),Buffer.from([0x7b,0xff,0xfe,0x7d]));
  assert.deepEqual(probe(bad),OFF);assert.match(bad.log(),/off invalid_config not_json\n$/);
});

test('message is bounded and built only from the structured fields',()=>{
  const long='x'.repeat(2000);
  const message=buildNotifyMessage({...fields('k'),workflow:long,project:'/very/secret/path/'+long,runId:long,task:long,
    stage:long,code:long,nextAction:`读 /srv/private/push.env 和 ~/secret/file 后\n${long}`,
    diff:'DIFF-CONTENT',log:'LOG-CONTENT',env:{TOKEN:'SECRET'}},{now:NOW});
  assert(Array.from(message.title).length<=NOTIFY_LIMITS.titleChars);
  assert(Array.from(message.body).length<=NOTIFY_LIMITS.bodyChars);
  for(const forbidden of ['DIFF-CONTENT','LOG-CONTENT','SECRET','push.env','/srv/','/very/secret','~/secret','\0'])
    assert(!message.body.includes(forbidden)&&!message.title.includes(forbidden),forbidden);
  assert.match(message.body,/<路径>/);
  const short=buildNotifyMessage(fields('k'),{now:NOW,timeZone:'Asia/Shanghai'});
  assert.equal(short.title,'CM 需要人处理 · work/demo-app');
  assert.equal(short.subtitle,'cm-fix · T-001');
  assert.equal(buildNotifyMessage(fields('k',{project:'/home/runner/work/cm-workflow/cm-workflow'}),{now:NOW,timeZone:'Asia/Shanghai'}).title,'CM 需要人处理 · cm-workflow');
  assert.equal(short.body,'下一步：核对 reason 后恢复原运行\n卡在：检查没通过（checks_not_passed）\n时间：16:00');
  const named=buildNotifyMessage(fields('k',{feature:'12.app-version-footer',session:'4f9fa27f',code:'qa_decision_required'}),{now:NOW,timeZone:'Asia/Shanghai'});
  assert.equal(named.subtitle,'cm-fix · 12.app-version-footer T-001 · 会话 4f9fa27f');
  assert.equal(named.body,'下一步：核对 reason 后恢复原运行\n卡在：在等 QA 判定（qa_decision_required）\n时间：16:00');
  assert.equal(buildNotifyMessage(fields('k'),{now:NOW,timeZone:'Asia/Shanghai',followUp:true,suppressed:2}).body,
    '第 2 次提醒：上次提醒后仍未处理\n下一步：核对 reason 后恢复原运行\n卡在：检查没通过（checks_not_passed）\n时间：16:00\n另有 2 条提醒为避免刷屏已合并，请一并查看各会话');
  assert.doesNotMatch(short.body,/运行：|run-1|CM 不会自动继续/);
});

test('done shows the next step and local time; project in the title, task in the subtitle; empty fields are left out',()=>{
  const done=buildNotifyMessage(fields('k',{event:'done',stage:'run_done',code:'run_done',nextAction:'建议在新会话里开始下一个任务'}),
    {now:NOW,timeZone:'Asia/Shanghai'});
  assert.equal(done.title,'CM 流程已结束 · work/demo-app');assert.equal(done.subtitle,'cm-fix · T-001');
  assert.equal(done.body,'下一步：建议在新会话里开始下一个任务\n时间：16:00');
  const bare=buildNotifyMessage(fields('k',{event:'done',task:null,nextAction:null}),{now:NOW,timeZone:'UTC'});
  assert.equal(bare.body,'时间：08:00');assert.equal(bare.subtitle,'cm-fix');
  assert.equal(buildNotifyMessage({workflow:'cm-ai',event:'waiting'},{now:NOW,timeZone:'America/New_York'}).body,'时间：04:00');
  assert.equal(buildNotifyMessage({workflow:'cm-ai'},{now:Date.parse('2026-10-08T16:05:00.000Z'),timeZone:'Asia/Shanghai'}).body,'时间：00:05');
});

test('without an injected time zone the clock follows the process TZ',()=>{
  const script=`import {buildNotifyMessage} from ${JSON.stringify(new URL('../runtime/js/notify.mjs',import.meta.url).href)};
process.stdout.write(buildNotifyMessage({workflow:'cm-ai',event:'done',project:'/p/demo'},{now:${NOW}}).body);`;
  for(const [tz,clock] of [['Asia/Shanghai','16:00'],['UTC','08:00'],['America/Los_Angeles','01:00']]){
    const run=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TZ:tz}});
    assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,`时间：${clock}`);
  }
});

// Optional notify.json `text`. Expected strings below are written out by hand
// from the default layout, not computed by the code under test.
const EVENTS=[['done','流程已结束'],['waiting','等待会话应答'],['idle','疑似空转'],['idle_waiting','在等你'],
  ['dead','宿主已退出未收尾'],['stuck','需要人处理'],[undefined,'需要人处理']];
test('custom text: without `text` (or with an empty one) every event is byte-identical to the default',()=>{
  const at={now:NOW,timeZone:'Asia/Shanghai'};
  for(const [event,headline] of EVENTS){
    const base=buildNotifyMessage(fields('k',{event}),at);
    assert.equal(base.title,`CM ${headline} · work/demo-app`,String(event));
    assert.equal(base.body,event==='done'?'下一步：核对 reason 后恢复原运行\n时间：16:00'
      :'下一步：核对 reason 后恢复原运行\n卡在：检查没通过（checks_not_passed）\n时间：16:00');
    for(const text of [{},DEFAULT_NOTIFY_TEXT,null,normalizeNotifyText({}).text])
      assert.deepEqual(buildNotifyMessage(fields('k',{event}),{...at,text}),base,`${event} ${JSON.stringify(text)}`);
  }
  const plainConfig=parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true']}));
  assert.deepEqual(plainConfig,{config:{command:['/bin/true'],waitMs:600000,checkWaitMs:2700000,idleMs:2700000,
    followUpMs:7200000,windowMs:600000,perWindow:3}});
  assert.equal(Object.hasOwn(plainConfig.config,'text'),false);
});

test('custom text: prefix, headlines, field order (runId included) and labels',()=>{
  const at={now:NOW,timeZone:'Asia/Shanghai'};
  const text={titlePrefix:'【工作流】',headlines:{done:'完工',waiting:'等你回话',idle:'没动静',idle_waiting:'该你了',dead:'宿主没了',default:'卡住了'},
    fields:{default:['code','runId','time'],done:['time','task']},labels:{code:'代码',runId:'编号',time:'时刻',task:'工单'}};
  const parsed=parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],text}));
  assert.equal(parsed.textReason,undefined);
  const custom=parsed.config.text;
  const want={done:'完工',waiting:'等你回话',idle:'没动静',idle_waiting:'该你了',dead:'宿主没了',stuck:'卡住了'};
  for(const [event,headline] of Object.entries(want)){
    const message=buildNotifyMessage(fields('k',{event}),{...at,text:custom});
    assert.equal(message.title,`【工作流】 ${headline} · work/demo-app`);
    assert.equal(message.body,event==='done'?'时刻：16:00\n工单：T-001':'代码：检查没通过（checks_not_passed）\n编号：run-1\n时刻：16:00');
  }
  // Partial text: only what is given changes; an empty prefix drops it from the title.
  const partial=buildNotifyMessage(fields('k'),{...at,text:{titlePrefix:'',labels:{nextAction:'先做'}}});
  assert.equal(partial.title,'需要人处理 · work/demo-app');
  assert.equal(partial.body,'先做：核对 reason 后恢复原运行\n卡在：检查没通过（checks_not_passed）\n时间：16:00');
  assert.equal(buildNotifyMessage(fields('k',{event:'waiting'}),{...at,text:{headlines:{waiting:'等'}}}).title,'CM 等 · work/demo-app');
  assert.equal(buildNotifyMessage(fields('k',{event:'idle'}),{...at,text:{headlines:{waiting:'等'}}}).title,'CM 疑似空转 · work/demo-app');
  // Empty field values are still left out under a custom order.
  assert.equal(buildNotifyMessage({workflow:'cm-ai'},{...at,text:{fields:{default:['runId','workflow','time']}}}).body,'流程：cm-ai\n时间：16:00');
});

test('custom text strings are cleaned like field values: paths redacted, control characters removed, each capped',()=>{
  const at={now:NOW,timeZone:'UTC'};
  const text=normalizeNotifyText({titlePrefix:'CM\u0007/Users/example/secret',
    headlines:{default:'卡住\n见/srv/private/push.env\u001b[31m'},labels:{nextAction:'C:\\Users\\example\\a.txt\u0000下一步',project:'~/proj',code:'\\\\srv\\share\\x'}}).text;
  const message=buildNotifyMessage(fields('k'),{...at,text});
  for(const forbidden of ['/Users','example\\','secret','/srv/','push.env','~/proj','\\\\srv','\u0007','\u001b','\u0000','\n见'])
    assert(!message.title.includes(forbidden)&&!message.body.split('\n').map(line=>line.split('：')[0]).join('|').includes(forbidden),JSON.stringify(forbidden));
  assert.equal(message.title,'CM <路径> 卡住 见<路径> [31m · work/demo-app');
  assert.equal(message.body.split('\n')[0],'<路径> 下一步：核对 reason 后恢复原运行');
  assert.equal(text.labels.project,'<路径>');
  assert.match(message.body,/\n<路径>：检查没通过（checks_not_passed）\n/);
  // Caps: prefix 16, headline 24, label 12 characters (… included); title 60, body 500.
  const long=normalizeNotifyText({titlePrefix:'前'.repeat(40),headlines:{default:'标'.repeat(40)},labels:{nextAction:'签'.repeat(40)}}).text;
  assert.equal(long.titlePrefix,'前'.repeat(15)+'…');assert.equal(long.headlines.default,'标'.repeat(23)+'…');
  assert.equal(long.labels.nextAction,'签'.repeat(11)+'…');
  const huge='x'.repeat(2000);
  const big=buildNotifyMessage({...fields('k'),workflow:huge,project:huge,runId:huge,task:huge,stage:huge,code:huge,nextAction:huge},
    {...at,text:{...long,fields:{default:['nextAction','runId','project','workflow','task','stage','code','time']}}});
  assert.equal(Array.from(big.title).length,NOTIFY_LIMITS.titleChars);
  assert(Array.from(big.body).length<=NOTIFY_LIMITS.bodyChars);
  assert.match(big.body,/^签{11}…：x{199}…\n/);
  assert.match(big.body,/\n运行：x{63}…\n/);
});

test('custom text loses bidi and zero-width characters; a string left with nothing visible is invalid',()=>{
  const at={now:NOW,timeZone:'UTC'};
  const hidden=['‪','‫','‬','‭','‮','⁦','⁧','⁨','⁩','‎','‏','؜',
    '​','‌','‍','⁠','﻿','­','\u{e0041}'];
  const text=normalizeNotifyText({titlePrefix:`C${hidden.join('')}M`,headlines:{default:`‮卡住⁦了⁩`},
    labels:{code:'‮原因',task:'​工‍单﻿'}}).text;
  const message=buildNotifyMessage(fields('k'),{...at,text});
  for(const char of hidden)assert(!message.title.includes(char)&&!message.body.includes(char),`U+${char.codePointAt(0).toString(16)}`);
  assert.equal(message.title,'CM 卡住了 · work/demo-app');
  assert.equal(text.labels.task,'工单');assert.match(message.body,/\n原因：检查没通过（checks_not_passed）\n/);
  // Nothing visible left: the whole text is invalid and the default text is used.
  for(const [value,reason] of [[{headlines:{default:'​⁦⁩'}},'headlines'],[{labels:{code:'‮ ‏'}},'labels'],
    [{titlePrefix:'​'},'title_prefix'],[{titlePrefix:'  '},'title_prefix'],[{headlines:{done:'̀'}},'headlines']]){
    assert.equal(normalizeNotifyText(value).reason,reason,JSON.stringify(value));
    assert.equal(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],text:value})).textReason,reason);
    assert.deepEqual(buildNotifyMessage(fields('k'),{...at,text:value}),buildNotifyMessage(fields('k'),at));
  }
  // Field values are not part of the text layer: the default path is unchanged.
  assert.equal(buildNotifyMessage(fields('k',{task:'T​-1'}),at).subtitle,'cm-fix · T​-1');
});

test('custom text redacts absolute paths even when letters touch them; field values keep the shared rule',()=>{
  const at={now:NOW,timeZone:'UTC'};
  for(const [raw,want] of [['see/Users/example/key','see<路径>'],['seeC:\\Users\\example\\key','see<路径>'],['seeC:/Users/example/key','see<路径>'],
    ['see\\\\srv\\share\\key','see<路径>'],['see~/proj/key','see<路径>'],['卡在/srv/a，再看','卡在<路径>，再看'],
    ['x1/etc/passwd y','x1<路径> y'],['CI/CD','CI<路径>'],['停\u0007/tmp/a','停 <路径>'],['停\u200b/tmp/a','停<路径>'],
    ['相对 a\\b 保留','相对 a\\b 保留']]){
    const text=normalizeNotifyText({headlines:{default:raw},labels:{code:raw}}).text;
    assert.equal(text.headlines.default,want,raw);assert.equal(text.labels.code,want.slice(0,12),raw);
    const message=buildNotifyMessage(fields('k'),{...at,text});
    assert.equal(message.title,`CM ${want} · work/demo-app`,raw);
    for(const leak of ['/Users','Users\\','\\\\srv','/srv','~/proj','/etc','/tmp'])assert(!message.title.includes(leak)&&!message.body.includes(leak),`${raw} ${leak}`);
  }
  // The shared rule for field values (and so the default text) is unchanged.
  assert.equal(buildNotifyMessage(fields('k',{task:'see/Users/example/key'}),at).subtitle,'cm-fix · see/Users/example/key');
  assert.equal(buildNotifyMessage(fields('k',{task:'见 /Users/example/key'}),at).subtitle,'cm-fix · 见 <路径>');
});

test('invalid text falls back to the default text with one text_config log line; notices stay on',async t=>{
  const bad=[[null,'text'],['标题','text'],[[],'text'],[{subject:'x'},'text_key'],[{titlePrefix:7},'title_prefix'],
    [{titlePrefix:'\u0007'},'title_prefix'],[{headlines:{stuck:'x'}},'headlines'],[{headlines:{done:''}},'headlines'],
    [{headlines:{done:'\u0001\u0002'}},'headlines'],[{headlines:'x'},'headlines'],[{labels:{secret:'x'}},'labels'],
    [{labels:{task:3}},'labels'],[{fields:{default:['nextAction','diff']}},'fields'],[{fields:{default:[]}},'fields'],
    [{fields:{default:['task','task']}},'fields'],[{fields:{stuck:['task']}},'fields'],[{fields:{done:'task'}},'fields'],
    [{fields:{done:['toString']}},'fields']];
  for(const [text,reason] of bad){
    const parsed=parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],text}));
    assert.equal(parsed.reason,undefined,JSON.stringify(text));assert.equal(parsed.textReason,reason,JSON.stringify(text));
    assert.equal(parsed.config.text,undefined);assert.deepEqual(parsed.config.command,['/bin/true']);
    assert.deepEqual(buildNotifyMessage(fields('k'),{now:NOW,timeZone:'UTC',text}),buildNotifyMessage(fields('k'),{now:NOW,timeZone:'UTC'}));
  }
  // End to end: the typo does not silence the notice, it goes out in the default text, and notify.log says why once.
  const h=home(t,{config:{text:{fields:{default:['nextAction','diff']}}}});
  assert.equal(readNotifyConfig(h.env).text,undefined);
  assert.deepEqual(notify(fields('typo'),{env:h.env,now:NOW}),{sent:true,reason:'launched'});
  assert(await h.until(()=>h.rows().length===1));
  assert.equal(h.rows()[0].title,'CM 需要人处理 · work/demo-app');
  assert.match(h.rows()[0].body,/^下一步：核对 reason 后恢复原运行\n卡在：检查没通过（checks_not_passed）\n/);
  readNotifyConfig(h.env);
  const lines=h.log().split('\n').filter(line=>line.includes('text_config'));
  assert.equal(lines.length,1,h.log());assert.match(lines[0],/ config - key=- default_text text_config fields$/);
  assert.doesNotMatch(h.log(),/off invalid_config/);
});

test('custom text reaches the command in CM_NOTIFY_TITLE/BODY and the stdin JSON',async t=>{
  const h=home(t,{config:{text:{titlePrefix:'提醒',headlines:{default:'卡住了'},fields:{default:['task','code']},labels:{task:'工单'}}}});
  assert.equal(notify(fields('custom'),{env:h.env,now:NOW}).sent,true);
  assert(await h.until(()=>h.rows().length===1));
  const [row]=h.rows();
  assert.equal(row.title,'提醒 卡住了 · work/demo-app');assert.equal(row.body,'工单：T-001\n卡在：检查没通过（checks_not_passed）');
  assert.equal(row.stdin.title,row.title);assert.equal(row.stdin.body,row.body);assert.equal(row.stdin.runId,'run-1');
});

test('sends through env and stdin once per key; the same key within 6 hours is skipped',async t=>{
  const h=home(t);
  assert.deepEqual(notify(fields('same'),{env:h.env,now:NOW}),{sent:true,reason:'launched'});
  assert.deepEqual(notify(fields('same'),{env:h.env,now:NOW+5*3600*1000}),{sent:false,reason:'duplicate'});
  assert(await h.until(()=>h.rows().length===1));
  const [row]=h.rows();
  assert.equal(row.title,'CM 需要人处理 · work/demo-app');assert.equal(row.stdin.title,row.title);assert.equal(row.stdin.body,row.body);
  assert.equal(row.stdin.subtitle,'cm-fix · T-001');assert.equal(row.stdin.project,'work/demo-app');assert.equal(row.stdin.code,'checks_not_passed');assert.equal(row.stdin.key,undefined);
  assert.equal(notify(fields('same'),{env:h.env,now:NOW+6*3600*1000+1}).sent,true);
  assert(await h.until(()=>h.rows().length===2));
  assert.equal(h.rows()[0].stdin.CM_NOTIFY_PAYLOAD,undefined);
  const state=JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8'));
  assert.equal(JSON.stringify(state).includes('same'),false);
  assert(!fs.existsSync(path.join(h.dir,'notify-state.lock')));
});

test('a busy state lock delays the progress clear instead of dropping it; a clear that never gets the lock is logged',async t=>{
  const h=home(t),key='attn|work/demo-app|4f9fa27f',lock=path.join(h.dir,'notify-state.lock');
  assert.equal(notify(fields('b1',{attentionKey:key}),{env:h.env,now:NOW}).sent,true);
  // A lock held by another live process (the parent) is not stale.
  const hold=()=>fs.writeFileSync(lock,JSON.stringify({pid:process.ppid,at:Date.now(),token:'held'}));
  hold();setTimeout(()=>fs.unlinkSync(lock),60);
  assert.equal(await clearAttention(key,{env:h.env,before:NOW+1,attempts:20,delayMs:20}),true);
  assert.equal(notify(fields('b2',{attentionKey:key}),{env:h.env,now:NOW+60000}).sent,true,'the next stop is sent at once');
  hold();
  assert.equal(await clearAttention(key,{env:h.env,before:NOW+60001,attempts:3,delayMs:5}),false);
  assert.match(h.log(),/ clear - key=[0-9a-f]{16} failed state_busy\n/);
  fs.unlinkSync(lock);
});

test('the session is kept whole in the subtitle; a long feature name is shortened instead',()=>{
  const message=buildNotifyMessage(fields('k',{feature:'12.'+'f'.repeat(45),session:'4f9fa27f'}),{now:NOW,timeZone:'UTC'});
  assert(Array.from(message.subtitle).length<=NOTIFY_LIMITS.titleChars,message.subtitle);
  // ' · 会话 4f9fa27f' takes 14 of 60 characters; the rest is cut to 46 (45 + …).
  assert.equal(message.subtitle,'cm-fix · 12.'+'f'.repeat(33)+'… · 会话 4f9fa27f');
});

test('a host still waiting sends one follow-up after followUpMinutes; answering first cancels it',async t=>{
  const h=home(t,{config:{waitMinutes:0.001,frequency:{followUpMinutes:1}}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  const wait=()=>scheduleWaitNotice({kind:'qa_browser',callId:'c1',workflow:'cm-demo',project:'/work/demo-app',session:'4f9fa27f',env:h.env});
  let cancel=wait();
  t.mock.timers.tick(100);
  t.mock.timers.tick(60000);
  cancel();
  t.mock.timers.reset();
  assert(await h.until(()=>h.rows().length===2));
  assert.equal(h.rows().filter(row=>/^第 2 次提醒：/.test(row.body)).length,1);
  // Answered before the follow-up: the second timer is cancelled with the first.
  const other=home(t,{config:{waitMinutes:0.001,frequency:{followUpMinutes:1}}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  cancel=scheduleWaitNotice({kind:'qa_browser',callId:'c2',workflow:'cm-demo',project:'/work/demo-app',session:'aaaa0000',env:other.env});
  t.mock.timers.tick(100);cancel();t.mock.timers.tick(120000);
  t.mock.timers.reset();
  assert(await other.until(()=>other.rows().length===1));
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(other.rows().length,1);
});

test('two hosts without a session id waiting in one project are two notices: the launch arguments keep them apart',async t=>{
  const h=home(t,{config:{waitMinutes:0.001}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:NOW});
  for(const name of ['prd-a','prd-b'])
    scheduleWaitNotice({kind:'answer',callId:'c1',workflow:'cm-prd',project:'/work/demo-app',args:['serve','--session',name],env:h.env});
  t.mock.timers.tick(100);t.mock.timers.reset();
  assert(await h.until(()=>h.rows().length===2));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8')).attention).length,2);
});

test('compact layout: title is the project, subtitle the session title, body only why it stopped',()=>{
  const at={now:NOW,timeZone:'UTC',layout:'compact'};
  const stuck=fields('k',{code:'qa_decision_required',session:'4f9fa27f',sessionTitle:'分析 skills 库'});
  assert.deepEqual(buildNotifyMessage(stuck,at),{title:'work/demo-app',subtitle:'会话：分析 skills 库',body:'在等 QA 判定'});
  // No plain-words entry: the event headline, never the English code. No title: the short session id; neither: the workflow.
  assert.deepEqual(buildNotifyMessage(fields('k',{session:'4f9fa27f',code:'batch_resources_open'}),{...at,text:{headlines:{default:'要你出手'}}}),
    {title:'work/demo-app',subtitle:'会话：4f9fa27f',body:'要你出手'});
  assert.equal(buildNotifyMessage(fields('k'),at).subtitle,'cm-fix');
  assert.equal(buildNotifyMessage(fields('k',{event:'done',code:'qa_decision_required'}),at).body,'流程已结束');
  // Codes without an entry still read as Chinese from their words; only a code saying nothing falls back to the headline.
  for(const [code,want] of [['checks_not_passed','检查没通过'],['qa_failed','QA 没通过'],['develop_checks_not_passed','开发检查没通过'],
    ['review_verification_failed','审查失败'],['qa_fix_action_authorization_required','QA 修复要你授权'],['batch_resources_open','需要人处理'],
    ['spec_drift','规格有改动，需重新批准'],['call_timeout','超时']])
    assert.equal(buildNotifyMessage(fields('k',{code}),at).body,want,code);
  assert.equal(buildNotifyMessage(fields('k',{code:'review_verification_failed'}),{now:NOW,timeZone:'UTC'}).body.split('\n')[1],'卡在：审查失败（review_verification_failed）');
  assert.equal(buildNotifyMessage(stuck,{...at,followUp:true,suppressed:2}).body,'第 2 次：在等 QA 判定\n另有 2 条提醒已合并');
  assert.deepEqual(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],layout:'compact'})).config.layout,'compact');
  assert.equal(Object.hasOwn(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],layout:'full'})).config,'layout'),false);
  assert.equal(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],layout:'tiny'})).reason,'layout');
});

test('session title: last custom-title (else ai-title) from the tail of the session transcript; nothing read without a session or under tests',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-title-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='2e015f08-c743-427a-95fa-0e471a851593',dir=path.join(root,'-Users-x-proj');fs.mkdirSync(dir);
  const file=path.join(dir,`${id}.jsonl`),line=value=>JSON.stringify(value)+'\n';
  const env={CLAUDE_CODE_SESSION_ID:id,CM_NOTIFY_CLAUDE_PROJECTS:root,NODE_TEST_CONTEXT:'child-v8'};
  fs.writeFileSync(file,line({type:'ai-title',aiTitle:'自动标题'})+line({type:'user',message:'x'}));
  assert.equal(sessionTitle(env),'自动标题');
  fs.appendFileSync(file,line({type:'custom-title',customTitle:'分析 skills 库'})+line({type:'ai-title',aiTitle:'更晚的自动标题'}));
  assert.equal(sessionTitle(env),'分析 skills 库','a title the person set wins');
  fs.appendFileSync(file,line({type:'custom-title',customTitle:'改名后 /srv/x/secret'}));
  assert.equal(sessionTitle(env),'改名后 <路径>');
  // Only the last 1 MiB is read: a title further back is not found.
  fs.writeFileSync(file,line({type:'custom-title',customTitle:'很早的标题'})+'x'.repeat(1024*1024+10)+'\n');
  assert.equal(sessionTitle(env),null);
  // A symlinked transcript is never followed.
  fs.writeFileSync(path.join(root,'real.jsonl'),line({type:'custom-title',customTitle:'别读我'}));
  fs.rmSync(file);fs.symlinkSync(path.join(root,'real.jsonl'),file);
  assert.equal(sessionTitle(env),null);
  // A project directory that is a symlink is not followed, even to a valid transcript.
  fs.rmSync(file);const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-outside-')));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,`${id}.jsonl`),line({type:'custom-title',customTitle:'链接外的标题'}));
  fs.rmSync(dir,{recursive:true});fs.symlinkSync(outside,dir);
  assert.equal(sessionTitle(env),null);
  for(const bad of [{...env,CLAUDE_CODE_SESSION_ID:undefined},{...env,CLAUDE_CODE_SESSION_ID:'../x'},{...env,CM_NOTIFY_CLAUDE_PROJECTS:undefined}])
    assert.equal(sessionTitle(bad),null,JSON.stringify(bad));
});

test('session title: a project directory swapped for a link while the transcript is opened is not read',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-race-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-notify-race-out-')));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const id='2e015f08-c743-427a-95fa-0e471a851593',dir=path.join(root,'p'),moved=path.join(root,'.moved');
  const env={CLAUDE_CODE_SESSION_ID:id,CM_NOTIFY_CLAUDE_PROJECTS:root,NODE_TEST_CONTEXT:'child-v8'};
  const title=value=>JSON.stringify({type:'custom-title',customTitle:value})+'\n';
  fs.writeFileSync(path.join(outside,`${id}.jsonl`),title('外部目录标题'));
  const lstat=fs.lstatSync,open=fs.openSync;t.after(()=>{fs.lstatSync=lstat;fs.openSync=open;});
  const target=path.join(dir,`${id}.jsonl`);
  for(const restore of [false,true]){
    fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(moved,{recursive:true,force:true});
    fs.mkdirSync(dir);fs.writeFileSync(target,title('本会话标题'));
    assert.equal(sessionTitle(env),'本会话标题');
    // The directory checks out, then is swapped for a link to the outside just
    // before the transcript is looked at, so the file check and the open both
    // see the outside file; optionally it is put back right after the open.
    let swapped=false;
    fs.lstatSync=(file,...rest)=>{
      if(!swapped&&String(file)===target){swapped=true;fs.renameSync(dir,moved);fs.symlinkSync(outside,dir);}
      return lstat(file,...rest);
    };
    fs.openSync=(file,...rest)=>{
      const fd=open(file,...rest);
      if(restore&&String(file)===target&&swapped&&fs.existsSync(moved)){fs.unlinkSync(dir);fs.renameSync(moved,dir);}
      return fd;
    };
    assert.equal(sessionTitle(env),null,restore?'swapped and restored':'left as a link');
    fs.lstatSync=lstat;fs.openSync=open;
  }
});

test('at most 3 per 10 minutes and 150 per day across keys; skipped notices are counted into the next one',async t=>{
  const h=home(t);
  for(let i=0;i<3;i++)assert.equal(notify(fields(`m${i}`),{env:h.env,now:NOW+i}).sent,true);
  assert.deepEqual(notify(fields('m3'),{env:h.env,now:NOW+10}),{sent:false,reason:'rate_window'});
  assert.deepEqual(notify(fields('m4'),{env:h.env,now:NOW+9*60000}),{sent:false,reason:'rate_window'});
  assert.match(h.log(),/skipped rate_window/);
  assert.equal(notify(fields('m5'),{env:h.env,now:NOW+10*60000+1}).sent,true);
  assert(await h.until(()=>h.rows().length===4));
  // Rows arrive in completion order of the background senders: look them up by content, not position.
  const merged=h.rows().filter(row=>/另有/.test(row.body));
  assert.equal(merged.length,1);assert.match(merged[0].body,/\n另有 2 条提醒为避免刷屏已合并，请一并查看各会话$/);
  // A version 1 state file is still read; the per-day cap is unchanged.
  const sends=Array.from({length:150},(_,i)=>NOW+120000+i*60000);
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify({version:1,keys:{},sends}));
  assert.deepEqual(notify(fields('day'),{env:h.env,now:NOW+200*60000}),{sent:false,reason:'rate_day'});
  assert.equal(notify(fields('day'),{env:h.env,now:NOW+120000+24*3600*1000}).sent,true);
  assert(await h.until(()=>h.rows().length===5));
  assert.equal(h.rows().filter(row=>/\n另有 1 条提醒/.test(row.body)).length,1);
  // The window and the follow-up delay come from notify.json `frequency`.
  assert.deepEqual(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],frequency:{followUpMinutes:30,windowMinutes:5,perWindow:2}})).config,
    {command:['/bin/true'],waitMs:600000,checkWaitMs:2700000,idleMs:2700000,followUpMs:1800000,windowMs:300000,perWindow:2});
  for(const frequency of [{perWindow:0},{perWindow:1.5},{windowMinutes:0},{windowMinutes:0.5},{followUpMinutes:0.1},{followUpMinutes:2000},{other:1},[]])
    assert.equal(parseNotifyConfig(JSON.stringify({version:1,command:['/bin/true'],frequency})).reason,'frequency',JSON.stringify(frequency));
});

test('one session needs one notice: stuck, waiting and idle share it; a new state or one follow-up after 2 hours resends',async t=>{
  const h=home(t),attentionKey='attn|work/demo-app|4f9fa27f',at=over=>fields(over.key,{attentionKey,session:'4f9fa27f',...over});
  assert.equal(notify(at({key:'s1'}),{env:h.env,now:NOW}).sent,true);
  // Same session, same stuck reason, or a lower/equal level: not sent again.
  assert.deepEqual(notify(at({key:'s2'}),{env:h.env,now:NOW+60000}),{sent:false,reason:'duplicate'});
  assert.deepEqual(notify(at({key:'w1',event:'waiting',code:'waiting_session_answer'}),{env:h.env,now:NOW+120000}),{sent:false,reason:'duplicate'});
  assert.deepEqual(notify(at({key:'i1',event:'idle_waiting',code:'waiting_for_you'}),{env:h.env,now:NOW+180000}),{sent:false,reason:'duplicate'});
  // A different stuck reason is a new state.
  assert.equal(notify(at({key:'s3',code:'qa_decision_required'}),{env:h.env,now:NOW+240000}).sent,true);
  // Still unhandled 2 hours later: one follow-up, then nothing more.
  assert.deepEqual(notify(at({key:'s4',code:'qa_decision_required'}),{env:h.env,now:NOW+240000+7199000}),{sent:false,reason:'duplicate'});
  assert.equal(notify(at({key:'s5',code:'qa_decision_required'}),{env:h.env,now:NOW+240000+7200000}).sent,true);
  assert.deepEqual(notify(at({key:'s6',code:'qa_decision_required'}),{env:h.env,now:NOW+240000+3*7200000}),{sent:false,reason:'duplicate'});
  assert(await h.until(()=>h.rows().length===3));
  assert.equal(h.rows().filter(row=>/^第 2 次提醒：上次提醒后仍未处理\n/.test(row.body)).length,1);
  // An idle notice first, then waiting for the session: the higher level is sent.
  const other='attn|work/demo-app|aaaa0000';
  assert.equal(notify(fields('o1',{attentionKey:other,event:'idle',code:'no_next_step'}),{env:h.env,now:NOW+5*3600000}).sent,true);
  assert.equal(notify(fields('o2',{attentionKey:other,event:'waiting',code:'waiting_session_answer'}),{env:h.env,now:NOW+5*3600000+1}).sent,true);
  // Progress clears the record: the same stop is sent at once again. A record newer than the step stays.
  assert.equal(await clearAttention(attentionKey,{env:h.env,before:NOW+240000+7200000-1}),false,'newer record kept');
  assert.equal(await clearAttention(attentionKey,{env:h.env,before:NOW+240000+7200000}),true);
  assert.equal(notify(at({key:'s7',code:'qa_decision_required'}),{env:h.env,now:NOW+8*3600000}).sent,true);
  assert.equal(await clearAttention('attn|unknown',{env:h.env}),false);
  // done keeps its own once-per-key rule and never takes the attention path.
  assert.equal(notify(at({key:'d1',event:'done'}),{env:h.env,now:NOW+9*3600000}).sent,true);
  assert.deepEqual(notify(at({key:'d1',event:'done'}),{env:h.env,now:NOW+9*3600000+1}),{sent:false,reason:'duplicate'});
});

test('command failure, timeout and broken state never throw; they log one line without content',async t=>{
  const failing=home(t,{exit:3});
  assert.deepEqual(notify(fields('f'),{env:failing.env,now:NOW}),{sent:true,reason:'launched'});
  assert(await failing.until(()=>failing.log()!==''));
  assert.match(failing.log(),/^\S+ stuck cm-fix key=[0-9a-f]{16} failed exit_3\n$/);
  const slow=home(t,{sleepMs:5000});
  assert.equal(notify(fields('s'),{env:slow.env,now:NOW,timeoutMs:200}).sent,true);
  assert(await slow.until(()=>/failed timeout/.test(slow.log())));
  const missing=home(t);fs.writeFileSync(path.join(missing.dir,'notify.json'),JSON.stringify({version:1,command:['/nonexistent/notify-cmd']}));
  assert.equal(notify(fields('n'),{env:missing.env,now:NOW}).sent,true);assert(await missing.until(()=>/failed spawn_enoent/.test(missing.log())));
  const broken=home(t);fs.writeFileSync(path.join(broken.dir,'notify-state.json'),'{');
  assert.deepEqual(notify(fields('b'),{env:broken.env,now:NOW}),{sent:false,reason:'state_invalid'});
  await new Promise(r=>setTimeout(r,300));
  for(const h of [slow,missing,broken])assert.equal(h.rows().length,0);
  for(const h of [failing,slow,missing,broken])assert(!/demo-app|T-001|核对|run-1/.test(h.log()));
});

// State and lock files are read bounded: a FIFO, a symlink (live or dangling)
// or an oversized file never blocks the host and never counts as valid state.
// FIFO cases run in a child with a hard deadline so a regression hangs the
// child, not the suite.
test('state and lock reads never block on a FIFO and refuse symlinks and oversized files',{skip:process.platform==='win32'},t=>{
  const fifo=file=>{const made=spawnSync('mkfifo',[file]);assert.equal(made.status,0,`mkfifo ${file}`);};
  const cases=[
    ['state FIFO',h=>fifo(path.join(h.dir,'notify-state.json')),'state_invalid',true],
    ['state symlink',h=>{fs.writeFileSync(path.join(h.dir,'real.json'),JSON.stringify({version:1,keys:{},sends:[]}));fs.symlinkSync(path.join(h.dir,'real.json'),path.join(h.dir,'notify-state.json'));},'state_invalid'],
    ['state dangling symlink',h=>fs.symlinkSync(path.join(h.dir,'missing.json'),path.join(h.dir,'notify-state.json')),'state_invalid'],
    ['state oversized',h=>fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify({version:1,keys:{},sends:[],pad:'x'.repeat(300*1024)})),'state_invalid'],
    ['lock FIFO',h=>fifo(path.join(h.dir,'notify-state.lock')),'state_busy',true],
    ['lock symlink',h=>{fs.writeFileSync(path.join(h.dir,'real.lock'),JSON.stringify({pid:process.pid,at:Date.now()-60000,token:'old'}));fs.symlinkSync(path.join(h.dir,'real.lock'),path.join(h.dir,'notify-state.lock'));},'state_busy'],
    ['lock dangling symlink',h=>fs.symlinkSync(path.join(h.dir,'missing.lock'),path.join(h.dir,'notify-state.lock')),'state_busy'],
  ];
  for(const [name,arrange,reason,inChild=false] of cases){
    const h=home(t);arrange(h);const listing=()=>fs.readdirSync(h.dir).filter(name=>name!=='notify.log').sort(),before=listing();
    let result;
    if(inChild){
      const child=spawnSync(process.execPath,['--input-type=module','-e',
        `import {notify} from ${JSON.stringify(NOTIFY_URL)};process.stdout.write(JSON.stringify(notify(${JSON.stringify(fields('f'))},{now:${NOW}})));`],
        {encoding:'utf8',timeout:5000,env:h.env});
      assert.equal(child.signal,null,`${name}: bounded read must not block (child killed by ${child.signal})`);
      assert.equal(child.status,0,`${name}: ${child.stderr}`);result=JSON.parse(child.stdout);
    }else result=notify(fields('f'),{env:h.env,now:NOW});
    assert.deepEqual(result,{sent:false,reason},name);
    assert.equal(h.rows().length,0,name);
    // Nothing but the log is written through or beside the refused entry.
    assert.deepEqual(listing(),before,name);assert.match(h.log(),new RegExp(`skipped ${reason}`),name);
  }
});

// Where O_NOFOLLOW is 0 (Windows), the open flags no longer refuse a symlink;
// only the lstat check before the open does. The child masks O_NOFOLLOW out of
// every open before the runtime loads (and proves the mask by opening a probe
// link that an unmasked open would refuse) and records every path opened, so
// the refusal is shown to happen before any open of the link: a build that
// first opens and only then notices the link goes red on every platform, not
// only in a Windows job. The link itself and its target are snapshotted so a
// same-name replacement or a rewritten target cannot hide behind a name list.
test('state and lock symlinks are refused before open when O_NOFOLLOW is masked (Windows semantics)',t=>{
  const cases=[
    ['state symlink','notify-state.json','real.json',JSON.stringify({version:1,keys:{},sends:[]}),'state_invalid'],
    ['lock symlink','notify-state.lock','real.lock',JSON.stringify({pid:process.pid,at:Date.now()-60000,token:'old'}),'state_busy'],
  ];
  for(const [name,linkName,targetName,targetBody,reason] of cases){
    const h=home(t),link=path.join(h.dir,linkName),target=path.join(h.dir,targetName);
    try{fs.writeFileSync(target,targetBody);fs.symlinkSync(target,link);fs.writeFileSync(path.join(h.dir,'probe.txt'),'probe');fs.symlinkSync(path.join(h.dir,'probe.txt'),path.join(h.dir,'probe.link'));}
    catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('symlink creation needs a privilege on this Windows host');return;}throw error;}
    const snapshot=()=>({names:fs.readdirSync(h.dir).filter(name=>name!=='notify.log').sort(),isLink:fs.lstatSync(link).isSymbolicLink(),points:fs.readlinkSync(link),target:fs.readFileSync(target,'utf8')});
    const before=snapshot();
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      `import fs from 'node:fs';import path from 'node:path';const open=fs.openSync,opened=[];
fs.openSync=(file,flags,...rest)=>{opened.push(path.resolve(String(file)));return open(file,typeof flags==='number'?flags&~fs.constants.O_NOFOLLOW:flags,...rest);};
const probe=fs.openSync(${JSON.stringify(path.join(h.dir,'probe.link'))},fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const followed=fs.readFileSync(probe,'utf8');fs.closeSync(probe);
const {notify}=await import(${JSON.stringify(NOTIFY_URL)});
const result=notify(${JSON.stringify(fields('f'))},{now:${NOW}});
process.stdout.write(JSON.stringify({followed,result,opened}));`],
      {encoding:'utf8',timeout:5000,env:h.env});
    assert.equal(child.status,0,`${name}: ${child.stderr}`);
    const {followed,result,opened}=JSON.parse(child.stdout);
    assert.equal(followed,'probe',`${name}: the masked open must follow links like a Windows open`);
    assert.ok(opened.includes(path.join(h.dir,'probe.link')),`${name}: the open recorder must see the probe open`);
    assert.ok(!opened.includes(link),`${name}: the link must be refused before any open of it (opened: ${opened.join(', ')})`);
    assert.ok(!opened.includes(target),`${name}: the link target must never be opened`);
    assert.deepEqual(result,{sent:false,reason},name);
    assert.equal(h.rows().length,0,name);
    assert.deepEqual(snapshot(),before,name);assert.match(h.log(),new RegExp(`skipped ${reason}`),name);
  }
});

// Lock contention never waits; only a provably stale lock is reclaimed, and
// a live lock is never removed.
test('lock: a live lock skips at once and is kept; a stale lock is reclaimed safely',async t=>{
  const live=home(t),lockFile=path.join(live.dir,'notify-state.lock');
  const liveBody=JSON.stringify({pid:process.pid,at:Date.now(),token:'other'});fs.writeFileSync(lockFile,liveBody);
  const started=performance.now();
  assert.deepEqual(notify(fields('l'),{env:live.env,now:NOW}),{sent:false,reason:'state_busy'});
  assert(performance.now()-started<50,'no synchronous waiting on contention');
  assert.equal(fs.readFileSync(lockFile,'utf8'),liveBody);assert.match(live.log(),/skipped state_busy/);
  const partial=home(t);fs.writeFileSync(path.join(partial.dir,'notify-state.lock'),'');
  assert.equal(notify(fields('p'),{env:partial.env,now:NOW}).reason,'state_busy');
  const dead=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim();
  for(const body of [{pid:Number(dead),at:Date.now(),token:'gone'},{pid:process.pid,at:Date.now()-60000,token:'old'}]){
    const old=home(t),file=path.join(old.dir,'notify-state.lock');fs.writeFileSync(file,JSON.stringify(body));
    assert.equal(notify(fields('o'),{env:old.env,now:NOW}).sent,true,JSON.stringify(body));
    assert(!fs.existsSync(file));assert.deepEqual(fs.readdirSync(old.dir).filter(name=>name.includes('.lock.')),[]);
    assert(await old.until(()=>old.rows().length===1));
  }
});

test('respects CM_WORKFLOW_HOME: config, state and log stay in that directory',async t=>{
  const a=home(t),b=home(t);fs.rmSync(path.join(b.dir,'notify.json'));
  assert.equal(notify(fields('h'),{env:b.env,now:NOW}).reason,'off');
  assert.equal(notify(fields('h'),{env:a.env,now:NOW}).sent,true);
  assert(await a.until(()=>a.rows().length===1));
  assert(fs.existsSync(path.join(a.dir,'notify-state.json')));assert(!fs.existsSync(path.join(b.dir,'notify-state.json')));
});

// Table-driven: each workflow's real result contract (host named per row)
// maps to stuck (a person must act), done (run ended) or null (progress).
const id={runId:'run-1',taskId:'T-001',attempt:1};
const ai=(over)=>({version:1,workflow:'cm-ai',operation:'advance',identity:id,packageDigest:'d',...over});
const CASES=[
  // cm-ai: cm-ai-conversation-entry.mjs / operator-guidance.mjs / task-runner.mjs / host-qa-fix-owner.mjs
  ['cm-ai','advance',ai({outcome:'finalized',state:'run_done',code:'run_done',pendingAction:'none'}),'done'],
  ['cm-ai','advance',ai({outcome:'finalized',state:'run_done',code:'run_done_degraded',pendingAction:'none'}),'done'],
  ['cm-ai','advance',ai({outcome:'refreshed',state:'fixture_completed',code:'context_refreshed',pendingAction:'start_next_task'}),null],
  ['cm-ai','start',ai({outcome:'advanced',state:'awaiting_review',code:null,pendingAction:'decision'}),null],
  ['cm-ai','advance',ai({outcome:'advanced',state:'changes_requested',code:null,pendingAction:'resume'}),null],
  ['cm-ai','complete',ai({outcome:'advanced',state:'fixture_completed',code:null,pendingAction:'qa'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'fixture_completed',code:'documentation_sync_required',pendingAction:'documentation_sync'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'changes_requested',code:'revision_answer_required',pendingAction:'resume'}),null],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'awaiting_review',code:'decision_required',pendingAction:'decision'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'fixture_completed',code:'qa_decision_required',pendingAction:'qa'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'awaiting',state:'awaiting_spec_approval',code:'specs_not_approved',pendingAction:'none'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'recorded',state:'fixture_completed',code:'qa_triggered',pendingAction:'qa_execution'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'verified',state:'fixture_completed',code:'qa_failed',pendingAction:'fix_authorization'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'blocked',code:'review_limit',pendingAction:'none'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'pending_review',code:'review_transport_timeout',pendingAction:'resume'}),'stuck'],
  ['cm-ai','advance',ai({outcome:'advanced',state:'unknown',code:'execution_error',pendingAction:'reconcile'}),'stuck'],
  ['cm-ai','decision',ai({outcome:'rejected',state:null,code:'stale_decision',pendingAction:'none'}),'stuck'],
  ['cm-ai','fix_advance',{outcome:'blocked',code:'qa_fix_incomplete',fixStage:'cause_review_required'},null],
  ['cm-ai','fix_advance',{outcome:'blocked',code:'qa_fix_incomplete',fixStage:'repair_blocked'},'stuck'],
  ['cm-ai','fix_run',{outcome:'verified',code:'qa_fix_completed'},null],
  ['cm-ai','status',ai({outcome:'reported',state:'blocked',code:'review_limit',pendingAction:'none'}),null],
  // cm-ai-batch: cm-ai-batch-run.mjs
  ['cm-ai-batch','advance',{...ai({outcome:'finalized',state:'run_done',code:'run_done',pendingAction:'none'}),batchId:'b1',task_commit:'abc'},'done'],
  ['cm-ai-batch','advance',{outcome:'blocked',code:'merge_conflict',batchId:'b1',files:['a.js']},'stuck'],
  ['cm-ai-batch','advance',{outcome:'blocked',code:'batch_task_scope_required'},'stuck'],
  ['cm-ai-batch','advance',{outcome:'cancelled',code:'cancelled',batchId:'b1'},'stuck'],
  ['cm-ai-batch','advance',{...ai({outcome:'advanced',state:'awaiting_review',code:null,pendingAction:'decision'}),batchId:'b1'},null],
  // cm-fix: execution.mjs / progress.mjs
  ['cm-fix','finish',{identity:id,stage:'completed',completionEligible:true},'done'],
  ['cm-fix','advance',{identity:id,stage:'cause_review_required'},null],
  ['cm-fix','cause_review',{identity:id,stage:'cause_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','final_review',{identity:id,stage:'final_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','final_review',{identity:id,stage:'revision_final_review_required',reason:'permission_denied'},'stuck'],
  ['cm-fix','repair',{identity:id,stage:'revision_regression_required'},null],
  ['cm-fix','repair',{identity:id,stage:'unknown',pending:'repair'},'stuck'],
  ['cm-fix','cause_review',{identity:id,stage:'rediagnosis_review_limit_reached'},'stuck'],
  ['cm-fix','regression',{identity:id,stage:'regression_blocked'},'stuck'],
  ['cm-fix','finish',{identity:id,stage:'escalated',escalationRunEnded:true},'stuck'],
  ['cm-fix','completion_evidence',{identity:id,stage:'unknown'},null],
  // cm-prd: analysis.mjs / change.mjs / summary.mjs / draft-save.mjs / review-*.mjs
  ['cm-prd','start',{stage:'awaiting_user',result:{status:'question',question:'q'},runId:'prd-1'},'stuck'],
  ['cm-prd','advance',{stage:'analysis_ready',runId:'prd-1'},null],
  ['cm-prd','plan',{stage:'self_check_needs_human',runId:'prd-1'},'stuck'],
  ['cm-prd','plan',{stage:'draft_self_check_failed',runId:'prd-1'},null],
  ['cm-prd','advance',{mode:'change',stage:'change_design',question:'which?',round:1},'stuck'],
  ['cm-prd','advance',{mode:'change',stage:'change_check_failed',round:1},null],
  ['cm-prd','advance',{mode:'change',stage:'change_check_failed',round:2},'stuck'],
  ['cm-prd','advance',{mode:'change',stage:'change_confirmation'},'stuck'],
  ['cm-prd','save_draft',{status:'draft_save_unknown'},'stuck'],
  ['cm-prd','prepare_summary',{status:'human_summary_prepared',readyForAwaitingReview:false},'stuck'],
  ['cm-prd','final_review',{stage:'draft_ready',reviewState:{status:'review_recorded',verdict:'blocked'}},'stuck'],
  ['cm-prd','final_review',{stage:'draft_ready',reviewState:{status:'review_recorded',verdict:'approved'}},null],
  ['cm-prd','publish_summary',{status:'awaiting_review',next:'human_review_then_explicit_cm_ai'},'done'],
  ['cm-prd','save_draft',{status:'blocked',reason:'prd_host_result_unknown'},'stuck'],
  // cm-idea: cm-idea-host.mjs
  ['cm-idea','start',{stage:'awaiting_user',reply:{status:'question',question:'q',productType:null}},'stuck'],
  ['cm-idea','advance',{stage:'draft_ready',reply:{status:'draft'}},'stuck'],
  ['cm-idea','prepare_save',{stage:'draft_ready',confirmationRequired:true},null],
  ['cm-idea','finish',{stage:'saved',saved:{maturity:'L1'}},'done'],
  // cm-init: cm-init-host.mjs / draft-generation.mjs
  ['cm-init','start',{stage:'analysis_ready'},null],
  ['cm-init','start',{stage:'analysis_blocked'},'stuck'],
  ['cm-init','advance',{workflow:'cm-init',status:'draft_generated'},null],
  ['cm-init','advance',{workflow:'cm-init',status:'blocked',reason:'host_generation_blocked'},'stuck'],
  ['cm-init','advance',{stage:'verification_blocked'},'stuck'],
  ['cm-init','advance',{stage:'confirmation_required'},'stuck'],
  ['cm-init','advance',{stage:'review_required'},null],
  ['cm-init','advance',{stage:'rules_written'},'done'],
  // cm-refactor: workflow.mjs
  ['cm-refactor','resume',{stage:'awaiting_finish',runId:'refactor-1'},'stuck'],
  ['cm-refactor','resume',{stage:'blocked',reason:'refactor_review_exhausted',runId:'refactor-1'},'stuck'],
  ['cm-refactor','prepare_judge_revision',{stage:'judge_revision_prepared',runId:'refactor-1'},null],
  ['cm-refactor','finish',{stage:'done',runId:'refactor-1'},'done'],
  ['cm-refactor','start',{stage:'not_needed',runId:'refactor-1'},'done'],
  // cm-test: cm-test/host.mjs
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'FAIL'},'stuck'],
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'BLOCKED'},'stuck'],
  ['cm-test','start',{stage:'reported',runId:'test-1',overall:'PASS'},'done'],
  ['cm-test','start',{stage:'interrupted',runId:'test-1',pending:{key:'1'}},'stuck'],
  ['cm-test','resume',{stage:'reported',runId:'test-1',overall:'FAIL',historical:true},null],
  // cm-check: cm-check/host.mjs
  ['cm-check','start',{stage:'reported',result:{overall:'FAILED'}},'stuck'],
  ['cm-check','start',{stage:'reported',result:{overall:'BLOCKED'}},'stuck'],
  ['cm-check','start',{stage:'reported',result:{overall:'PASSED'}},'done'],
  ['cm-check','start',{stage:'reported',result:{overall:'MECHANICAL_ONLY'}},'done'],
  ['cm-check','start',{stage:'blocked',result:{overall:'BLOCKED',reason:'check_source_changed'}},'stuck'],
];
test('driver classification follows each workflow contract (table)',()=>{
  assert.deepEqual([...new Set(CASES.map(([workflow])=>workflow))].sort(),[...NOTIFY_WORKFLOWS].sort());
  for(const [workflow,operation,result,expected] of CASES){
    const notice=driveNotice({host:`/x/scripts/${workflow}-host.mjs`,cwd:'/work/demo-app',args:['serve'],operation,
      row:{requestId:'drive',result}});
    assert.equal(notice?.event??null,expected,`${workflow} ${operation} ${JSON.stringify(result)}`);
    if(expected==='done')assert.match(notice.nextAction,/新会话/,`${workflow} done suggests a fresh session`);
  }
  for(const workflow of NOTIFY_WORKFLOWS){
    assert.equal(driveNotice({host:`${workflow}-host.mjs`,cwd:'/w/p',operation:'advance',row:{requestId:'drive',error:{code:'host_request_failed'}}}).event,'stuck');
    assert.equal(driveNotice({host:`${workflow}-host.mjs`,cwd:'/w/p',operation:'advance',failure:'host_exited'}).code,'host_exited');
  }
  const blocked=driveNotice({host:'/x/scripts/cm-ai-host.mjs',cwd:'/work/demo-app',args:['serve','--host-context','4F9FA27F-6196-4f1f-9bb7-fe5bcd5614fa'],operation:'advance',
    row:{requestId:'drive',result:ai({outcome:'advanced',state:'blocked',code:'develop_checks_not_passed',pendingAction:'resume',feature:'1.login',
      guidance:{nextStep:'修复后 advance'}})}});
  assert.deepEqual({...blocked},{key:'cm-ai|run-1|T-001|1|blocked|develop_checks_not_passed',attentionKey:'attn|work/demo-app|4f9fa27f',event:'stuck',workflow:'cm-ai',
    project:'/work/demo-app',runId:'run-1',feature:'1.login',task:'T-001',stage:'blocked',session:'4f9fa27f',code:'develop_checks_not_passed',nextAction:'修复后 advance'});
  // Without --host-context the attention record is per project, workflow and run; a non-UUID context is kept as given.
  assert.equal(driveNotice({host:'cm-ai-host.mjs',cwd:'/w/p',args:['serve'],operation:'advance',row:{requestId:'drive',result:ai({state:'blocked',code:'x'})}}).attentionKey,'attn|w/p|cm-ai|run-1');
  assert.equal(driveNotice({host:'cm-ai-host.mjs',cwd:'/w/p',args:['--host-context','claude-session-e2e'],operation:'advance',failure:'host_exited'}).session,'claude-session-e2e');
  // No session and no returned run: the launch arguments keep two runs apart, and progress clears the same key.
  const exited=args=>driveNotice({host:'cm-ai-host.mjs',cwd:'/w/p',args,operation:'advance',failure:'host_exited'}).attentionKey;
  assert.notEqual(exited(['--config','/tmp/run-a.json']),exited(['--config','/tmp/run-b.json']));
  assert.equal(driveProgressKey({host:'cm-ai-host.mjs',cwd:'/w/p',args:['--config','/tmp/run-a.json'],operation:'advance',
    row:{requestId:'drive',result:{workflow:'cm-ai',state:'ready'}}}),exited(['--config','/tmp/run-a.json']));
  // done keeps only its own key, not an attention record.
  assert.equal(Object.hasOwn(driveNotice({host:'cm-test-host.mjs',cwd:'/w/p',operation:'start',row:{requestId:'drive',result:{stage:'reported',runId:'t',overall:'PASS'}}}),'attentionKey'),false);
  const batch=driveNotice({host:'cm-ai-batch-host.mjs',cwd:'/w/p',args:['a'],operation:'advance',
    row:{requestId:'drive',result:{outcome:'blocked',code:'merge_conflict',batchId:'b1'}}});
  assert.equal(batch.runId,'b1');assert.equal(batch.code,'merge_conflict');
  assert.match(driveNotice({host:'cm-ai-host.mjs',cwd:'/w/p',operation:'advance',failure:'host_exited'}).key,/^cm-ai\|args:[0-9a-f]{16}\|/);
});

// Shared driver core (scripts/*-drive.mjs all use driveHost) with a host that
// stops on blocked: one notice; repeating the identical run sends nothing new.
// The notify command takes 3 s, yet the driver exits without waiting for it.
test('driver ending in blocked notifies exactly once, never waits for the command, and an identical run does not resend',async t=>{
  const h=home(t,{sleepMs:3000});
  const host=path.join(h.dir,'cm-ai-host.mjs'),wrapper=path.join(h.dir,'cm-ai-drive.mjs'),project=path.join(h.dir,'demo-app');
  fs.mkdirSync(project);
  fs.writeFileSync(host,`process.stdout.write(JSON.stringify({type:'host_ready',sessionId:'s'})+'\\n');
process.stdin.on('data',chunk=>{for(const line of String(chunk).split('\\n').filter(Boolean)){const row=JSON.parse(line);
 if(row.requestId==='drive')process.stdout.write(JSON.stringify({requestId:'drive',result:{workflow:'cm-ai',outcome:'advanced',state:'blocked',
  code:process.env.FIXTURE_STATE==='progress'?null:'checks_not_passed',pendingAction:'none',identity:{runId:'run-7',taskId:'T-001',attempt:1},
  ...(process.env.FIXTURE_STATE==='progress'?{state:'ready'}:{})}})+'\\n');}});
process.stdin.on('end',()=>setTimeout(()=>process.exit(0),Number(process.env.FIXTURE_CLOSE_DELAY??0)));`);
  fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
driveHost({host:${JSON.stringify(host)},args:['serve','--host-context','4f9fa27f-6196-4f1f-9bb7-fe5bcd5614fa'],cwd:${JSON.stringify(project)},operation:'advance',answers:{},answerFor:()=>null});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  for(let i=0;i<2;i++){
    const started=performance.now(),run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env,timeout:20000});
    assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.state,'blocked');
    assert(performance.now()-started<2000,`driver exit waited on the notify command: ${performance.now()-started} ms`);
    assert.equal(h.rows().length,0,`run ${i}: the command is still running in the background`);
    assert.match(run.stderr,new RegExp(`\\[drive\\] 提醒里的标识：项目 ${label(project)} · 会话 4f9fa27f\\n`));
  }
  assert(await h.until(()=>h.rows().length===1));
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,1);
  const [row]=h.rows();
  assert.equal(row.title,`CM 需要人处理 · ${label(project)}`);assert.equal(row.stdin.runId,'run-7');assert.equal(row.stdin.code,'checks_not_passed');
  assert.equal(row.stdin.session,'4f9fa27f');assert.equal(row.stdin.subtitle,'cm-ai · T-001 · 会话 4f9fa27f');
  // A step that moves on clears the session's record: the same stop is sent at once, not after the 2-hour follow-up.
  const progress=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env:{...env,FIXTURE_STATE:'progress'},timeout:20000});
  assert.equal(progress.status,0,progress.stderr);assert.equal(JSON.parse(progress.stdout).result.state,'ready');
  const cleared=()=>Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8')).attention).length===0;
  assert(await h.until(cleared),'progress cleared the attention record');
  // Keep the per-window cap out of the way: only the attention rule is under test here.
  const state=JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8'));state.sends=[];
  fs.writeFileSync(path.join(h.dir,'notify-state.json'),JSON.stringify(state));
  const again=spawnSync(process.execPath,[wrapper],{encoding:'utf8',env,timeout:20000});
  assert.equal(again.status,0,again.stderr);
  assert(await h.until(()=>h.rows().length===2),'the stop after progress is sent again');
  // The clear is bounded by when the final result arrived, not by when the host closed:
  // a stop recorded while the old host is still closing stays.
  const late=spawn(process.execPath,[wrapper],{env:{...env,FIXTURE_STATE:'progress',FIXTURE_CLOSE_DELAY:'1500'}});
  let out='';late.stdout.on('data',chunk=>out+=chunk);
  const exited=new Promise(resolve=>late.on('close',resolve));
  assert(await h.until(()=>/"state": ?"ready"/.test(out)),'final result printed before the host closed');
  await new Promise(resolve=>setTimeout(resolve,100));
  const fresh=`attn|${label(project)}|4f9fa27f`;
  assert.equal(notify(fields('late-stop',{project,attentionKey:fresh,code:'review_blocked'}),{env:h.env}).sent,true);
  assert.equal(await exited,0);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir,'notify-state.json'),'utf8')).attention).length,1,'the newer stop is kept');
});

// Host bridge: a host_request outstanding past waitMinutes notifies once;
// an answer before then clears it; neither the timer nor a fired, slow
// notify command keeps the host alive.
test('host wait timer notifies once per call, is cleared on answer and does not keep the process alive',async t=>{
  const h=home(t,{config:{waitMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const mode=process.argv[2],bridge=createHostToolBridge();const sent=[];bridge.attach(row=>{sent.push(row);});
const answer=()=>{const r=sent.find(row=>row.type==='host_request');bridge.accept({type:'host_result',sessionId:r.sessionId,callId:r.callId,requestDigest:r.requestDigest,result:{ok:true}});};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(mode==='late'){const p=bridge.call('qa_browser',{},new AbortController().signal);await wait(1000);answer();await p;}
if(mode==='early'){const p=bridge.call('qa_logic',{},new AbortController().signal);await wait(20);answer();await p;await wait(1200);}
if(mode==='hang')bridge.call('develop',{},new AbortController().signal).catch(()=>{});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const late=spawnSync(process.execPath,[script,'late'],{encoding:'utf8',env,timeout:20000});
  assert.equal(late.status,0,late.stderr);
  assert(await h.until(()=>h.rows().length===1));
  assert.equal(h.rows()[0].title,'CM 等待会话应答 · '+label(process.cwd()));assert.equal(h.rows()[0].stdin.subtitle,'cm-demo');
  assert.equal(h.rows()[0].stdin.stage,'qa_browser');assert.equal(h.rows()[0].stdin.code,'waiting_session_answer');
  const early=spawnSync(process.execPath,[script,'early'],{encoding:'utf8',env,timeout:20000});
  assert.equal(early.status,0,early.stderr);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(h.rows().length,1);
  const slow=home(t,{sleepMs:3000,config:{waitMinutes:0.003}});
  const fired=spawnSync(process.execPath,[script,'late'],{encoding:'utf8',env:{...env,CM_WORKFLOW_HOME:slow.dir},timeout:20000});
  assert.equal(fired.status,0,fired.stderr);assert.equal(slow.rows().length,0,'host exited before the slow command finished');
  assert(await slow.until(()=>slow.rows().length===1));
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({version:1,command:['/bin/true'],waitMinutes:10}));
  const started=Date.now(),hang=spawnSync(process.execPath,[script,'hang'],{encoding:'utf8',env,timeout:20000});
  assert.equal(hang.status,0,hang.stderr);assert(Date.now()-started<5000);
});

// A check request waits for the session to run the project's check commands,
// which normally takes tens of minutes: it uses checkWaitMinutes, not waitMinutes.
test('check requests use checkWaitMinutes so normal long checks are not reported as waiting',async t=>{
  const h=home(t,{config:{waitMinutes:0.003}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const kind=process.argv[2],bridge=createHostToolBridge();const sent=[];bridge.attach(row=>{sent.push(row);});
const p=bridge.call(kind,{},new AbortController().signal);await new Promise(resolve=>setTimeout(resolve,1000));
const r=sent.find(row=>row.type==='host_request');bridge.accept({type:'host_result',sessionId:r.sessionId,callId:r.callId,requestDigest:r.requestDigest,result:{ok:true}});await p;`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  for(const kind of ['check','verification_precheck','init_verify']){
    const run=spawnSync(process.execPath,[script,kind],{encoding:'utf8',env,timeout:20000});assert.equal(run.status,0,run.stderr);
  }
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,0,'default 45-minute check threshold');
  const cfg=JSON.parse(fs.readFileSync(path.join(h.dir,'notify.json'),'utf8'));
  fs.writeFileSync(path.join(h.dir,'notify.json'),JSON.stringify({...cfg,waitMinutes:10,checkWaitMinutes:0.003}));
  const run=spawnSync(process.execPath,[script,'check'],{encoding:'utf8',env,timeout:20000});assert.equal(run.status,0,run.stderr);
  assert(await h.until(()=>h.rows().length===1));assert.equal(h.rows()[0].stdin.stage,'check');
});
test('checkWaitMinutes is validated like waitMinutes',t=>{
  const h=home(t,{config:{checkWaitMinutes:0}});
  assert.equal(readNotifyConfig(h.env),null);
});

// Host session: after an operation replies, nothing is in flight and the
// session sends no next operation for idleMinutes, one notice says so. A last
// result that waits on a person says "在等你" instead. Any next operation or
// session end clears it; status polls are not progress.
function idleHost(h,{startupDelayMs=0}={}){
  const script=path.join(h.dir,'cm-prd-host.mjs');
  fs.writeFileSync(script,`import {serveCmAiHost} from ${JSON.stringify(HOST_SESSION)};
const host={handle:async request=>{
  if(request.slowMs)await new Promise(resolve=>setTimeout(resolve,request.slowMs));
  if(['status','fix_status'].includes(request.operation))return {stage:'status_only',doneAt:Date.now()};
  return request.answer;}};
if(${startupDelayMs})await new Promise(resolve=>setTimeout(resolve,${startupDelayMs}));
await serveCmAiHost({host,input:process.stdin,output:process.stdout});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  // steps: [delayMs, request object | raw line string | null to end stdin];
  // delay 'reply:<id>' waits until that requestId has been answered instead.
  const history=[];
  const run=async steps=>{
    const child=spawn(process.execPath,[script],{env,stdio:['pipe','pipe','pipe']});
    const trace=hostDiagnostic(child);
    let stdout='',buffer='';child.stdout.on('data',chunk=>{
      stdout+=chunk;buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{trace.receive(JSON.parse(line));}catch{/* Raw lines are never retained in diagnostics. */}
      }
    });
    const exited=new Promise(resolve=>child.on('close',code=>resolve(code)));
    const replied=id=>stdout.includes(`"requestId":"${id}"`);
    for(const [delay,request] of steps){
      if(typeof delay==='string'){
        const id=delay.slice(6),deadline=Date.now()+15000;
        while(!replied(id)){if(Date.now()>deadline){child.kill();throw trace.attach(new Error('host fixture reply timeout'));}await new Promise(resolve=>setTimeout(resolve,10));}
      }
      else await new Promise(resolve=>setTimeout(resolve,delay));
      if(request===null){trace.send({operation:'eof'});child.stdin.end();break;}
      if(request!==undefined)trace.send(typeof request==='string'?{}:request);
      if(request!==undefined)child.stdin.write((typeof request==='string'?request:JSON.stringify(request))+'\n');
    }
    const started=Date.now(),code=await exited;
    const diagnostic=trace.snapshot();history.push(diagnostic);if(history.length>8)history.shift();
    return {code,stdout,exitMs:Date.now()-started,diagnostic};
  };
  run.diagnostics=()=>history;return run;
}
const op=(n,answer,extra={})=>({requestId:`r${n}`,operation:'advance',answer,...extra});

test('host session idle after a finished step notifies once: 疑似空转 for progress, 在等你 for a person',async t=>{
  const h=home(t,{config:{idleMinutes:0.009}}),run=idleHost(h);
  const progress=await run([[0,op(1,{stage:'requirements_analysis',runId:'prd-1'})],[2700,null]]);
  assert.equal(progress.code,0);
  assert(await h.until(()=>h.rows().length===1));
  const [idle]=h.rows();
  assert.equal(idle.title,'CM 疑似空转 · '+label(process.cwd()));assert.equal(idle.stdin.subtitle,'cm-prd');
  assert.equal(idle.stdin.event,'idle');assert.equal(idle.stdin.code,'no_next_step');
  assert.equal(idle.stdin.runId,'prd-1');assert.equal(idle.stdin.stage,'requirements_analysis');
  const waiting=home(t,{config:{idleMinutes:0.009}});
  const review=await idleHost(waiting)([[0,op(1,{stage:'awaiting_user',runId:'prd-2'})],[2700,null]]);
  assert.equal(review.code,0);
  assert(await waiting.until(()=>waiting.rows().length===1));
  assert.equal(waiting.rows()[0].title,'CM 在等你 · '+label(process.cwd()));
  assert.equal(waiting.rows()[0].stdin.event,'idle_waiting');assert.equal(waiting.rows()[0].stdin.code,'waiting_for_you');
  await new Promise(resolve=>setTimeout(resolve,900));
  assert.equal(h.rows().length,1);assert.equal(waiting.rows().length,1);
});

for(const startupDelayMs of [0,750])test(`host session idle: next step, in-flight step and session end clear it; status polls do not (startup ${startupDelayMs}ms)`,async t=>{
  const h=home(t,{config:{idleMinutes:0.009}}),run=idleHost(h,{startupDelayMs});
  // Sending is not completion: a slow startup can otherwise batch the next
  // line before the first reply, exercising host_busy instead of idle clearing.
  // Steady progress: each next operation arrives before the threshold.
  const steady=[];for(let n=1;n<=6;n++){
    if(n>1)steady.push([`reply:r${n-1}`,undefined]);
    steady.push([n===1?0:180,op(n,{stage:'requirements_analysis'})]);
  }
  assert.equal((await run([...steady,['reply:r6',undefined],[180,null]])).code,0);
  // A long in-flight operation is not idleness; ending right after its reply clears the timer.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'},{slowMs:2700})],[2850,null]])).code,0);
  // A slow next operation: its arrival clears the timer armed by the previous reply.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],['reply:r1',undefined],[180,op(2,{stage:'requirements_analysis'},{slowMs:2700})],[2850,null]])).code,0);
  // A cancel reply while another operation is still in flight does not arm it.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'},{slowMs:2700})],[180,{requestId:'c1',operation:'cancel'}],[2700,null]])).code,0);
  // Driver shape: EOF right after the reply arrived.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],['reply:r1',null]])).code,0);
  // A line the host rejects (not JSON, unknown operation) is still the session's next step.
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],['reply:r1',undefined],[180,'not json'],[2700,null]])).code,0);
  assert.equal((await run([[0,op(1,{stage:'requirements_analysis'})],['reply:r1',undefined],[180,{requestId:'x',operation:'no_such_op'}],[2700,null]])).code,0);
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(h.rows().length,0,JSON.stringify(run.diagnostics()));
  // Polls (status via the control path, fix_status via the normal path) neither
  // hold the timer off nor replace the last real step's result.
  for(const poll of ['status','fix_status']){
    const polls=[[0,op(1,{stage:'requirements_analysis',runId:`run-${poll}`})],['reply:r1',undefined]];
    for(let n=0;n<12;n++)polls.push([180,{requestId:`s${n}`,operation:poll}]);
    assert.equal((await run([...polls,[180,null]])).code,0);
    assert(await h.until(()=>h.rows().some(row=>row.stdin.runId===`run-${poll}`)));
    const row=h.rows().find(row=>row.stdin.runId===`run-${poll}`);
    assert.equal(row.stdin.event,'idle');assert.equal(row.stdin.stage,'requirements_analysis');
  }
  assert.equal(h.rows().length,2);
});

// A poll that is still running when the deadline passes holds the notice; it
// goes out right after the poll replies, not during it.
test('host session idle: a slow status in flight holds the notice until it replies',async t=>{
  const h=home(t,{config:{idleMinutes:0.009}}),run=idleHost(h);
  const result=await run([[0,op(1,{stage:'requirements_analysis'})],[180,{requestId:'s1',operation:'status',slowMs:2100}],['reply:s1',undefined],[1200,null]]);
  assert.equal(result.code,0);
  const doneAt=JSON.parse(result.stdout.split('\n').find(line=>line.includes('"requestId":"s1"'))).result.doneAt;
  assert(await h.until(()=>h.rows().length===1));
  assert(h.rows()[0].at>=doneAt,`notice at ${h.rows()[0].at} before status finished at ${doneAt}`);
  assert.equal(h.rows()[0].stdin.stage,'requirements_analysis');
});

// Tool-bridge sessions end with host_close from the driver: exit 0, no notice.
test('host session idle: host_close ends the session cleanly without a notice',async t=>{
  const h=home(t,{config:{idleMinutes:0.009}});
  const script=path.join(h.dir,'cm-demo-host.mjs');
  fs.writeFileSync(script,`import {serveCmAiHost} from ${JSON.stringify(HOST_SESSION)};
import {createHostToolBridge} from ${JSON.stringify(BRIDGE)};
const bridge=createHostToolBridge();
const host={handle:async()=>({stage:'awaiting_review',asked:await bridge.call('develop',{},new AbortController().signal)})};
await serveCmAiHost({host,input:process.stdin,output:process.stdout,toolBridge:bridge});`);
  const env={...h.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,[script],{env,stdio:['pipe','pipe','pipe']});
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});
  const exited=new Promise(resolve=>child.on('close',resolve));
  const lines=()=>stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  child.stdin.write(JSON.stringify({requestId:'r1',operation:'advance'})+'\n');
  await h.until(()=>lines().some(row=>row.type==='host_request'));
  const ask=lines().find(row=>row.type==='host_request');
  child.stdin.write(JSON.stringify({type:'host_result',sessionId:ask.sessionId,callId:ask.callId,requestDigest:ask.requestDigest,result:{ok:true}})+'\n');
  await h.until(()=>lines().some(row=>row.requestId==='r1'));
  child.stdin.write(JSON.stringify({type:'host_close',sessionId:ask.sessionId})+'\n');
  assert.equal(await exited,0);
  assert.deepEqual(lines().map(row=>row.type??row.requestId),['host_ready','host_request','host_response','r1','host_response']);
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(h.rows().length,0);
});

test('host session idle timer never delays exit and idleMinutes is validated',async t=>{
  const h=home(t,{config:{idleMinutes:600}}),run=idleHost(h);
  const result=await run([[0,op(1,{stage:'requirements_analysis'})],[100,null]]);
  assert.equal(result.code,0);assert(result.exitMs<3000);assert.match(result.stdout,/"requestId":"r1"/);
  assert.equal(h.rows().length,0);
  for(const idleMinutes of [0,-1,1441,'45'])assert.equal(readNotifyConfig(home(t,{config:{idleMinutes}}).env),null);
});
