import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  hook,main,enable,statusText,loadRules,stripCode,hookCommand,hasHintHook,
  localPath,logFile,installDir,claudeSettingsPath,codexHooksPath,defaultRulesPath,
  MAX_PROMPT,ADOPT_WINDOW,LOG_LIMIT,SCRIPT_NAME,RULES_NAME,patternMatches,typed,readJson,loadAuthorCheck,
} from './cm-skill-hints.mjs';

const NOW=Date.parse('2026-10-24T08:00:00Z');

function fixture(t,{rules,local,authorSkills=[]}={}){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-skill-hints-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={HOME:home,CLAUDE_HOME:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),
    CM_WORKFLOW_HOME:path.join(home,'.cm-workflow'),CM_WORKFLOW_LOG_HOME:path.join(home,'.cm-workflow','logs')};
  const rulesFile=path.join(home,'rules.json');
  fs.writeFileSync(rulesFile,JSON.stringify(rules??{version:1,rules:[
    {id:'grill-plan',skill:'grill-me',author:true,keywords:['设计一个方案','Grill Me'],reason:'先问透',
      fallback:{skill:'cm-challenge',reason:'先挑战'}},
    {id:'long-session',skill:'handoff',author:true,keywords:['会话太长'],reason:'写交接'},
    {id:'fix-bug',skill:'cm-fix',keywords:['修这个 bug'],reason:'先复现'},
    {id:'test',skill:'cm-test',keywords:['补单测'],patterns:['覆盖率\\s*\\d+'],reason:'补测试'},
  ]}));
  if(local!==undefined){
    fs.mkdirSync(env.CM_WORKFLOW_HOME,{recursive:true});
    fs.writeFileSync(localPath(env),typeof local==='string'?local:JSON.stringify(local));
  }
  // Pinned "author versions" for the test: exact SKILL.md + LICENSE bytes, checked by hash.
  const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
  const authorOptions={license:sha('MIT'),skills:['grill-me','handoff'].map(name=>({name,files:{'SKILL.md':sha(`author ${name}`)}}))};
  // The real checker, fed the test's pinned list instead of the upstream one.
  const loadAuthor=async()=>({...(await loadAuthorCheck()),skills:authorOptions.skills,license:authorOptions.license});
  for(const [root,name,content=`author ${name}`] of authorSkills){
    const dir=path.join(home,root,name);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),content);
    fs.writeFileSync(path.join(dir,'LICENSE'),'MIT');
  }
  const send=async(prompt,{host='claude',session='s1',extraEnv={},now=NOW}={})=>{
    const out=await hook({prompt,session_id:session},{env:{...env,...extraEnv},host,rulesFile,now,loadAuthor});
    return out?JSON.parse(out).hookSpecificOutput.additionalContext:'';
  };
  const log=()=>{try{return fs.readFileSync(logFile(env),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};
  return {home,env,rulesFile,send,log,authorOptions};
}

test('a keyword hint names the skill in the host\'s own syntax',async t=>{
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me'],['.agents/skills','grill-me']]});
  assert.match(await f.send('帮我设计一个方案'),/- \/grill-me：先问透/);
  assert.match(await f.send('帮我设计一个方案',{host:'codex',session:'s2'}),/- \$grill-me：先问透/);
});

test('matching ignores case and supports optional regex patterns',async t=>{
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me']]});
  assert.match(await f.send('please GRILL ME on this'),/grill-me/);
  assert.match(await f.send('覆盖率 40 太低',{session:'s2'}),/cm-test/);
  assert.equal(await f.send('覆盖率很低',{session:'s3'}),'');
});

test('a missing author skill falls back to its CM counterpart, or is dropped',async t=>{
  const f=fixture(t);
  const text=await f.send('帮我设计一个方案，会话太长了');
  assert.match(text,/\/cm-challenge：先挑战/);
  assert.doesNotMatch(text,/grill-me|handoff/);
});

test('an author skill installed only for the other host does not count',async t=>{
  const f=fixture(t,{authorSkills:[['.agents/skills','grill-me']]});
  assert.match(await f.send('设计一个方案'),/cm-challenge/);
});

test('at most two hints per message, user rules first',async t=>{
  const f=fixture(t,{local:{rules:[{skill:'my-skill',keywords:['bug'],reason:'自己的'}]}});
  const text=await f.send('设计一个方案，修这个 bug，再补单测');
  const lines=text.split('\n').filter(line=>line.startsWith('- '));
  assert.deepEqual(lines,['- /my-skill：自己的','- /cm-challenge：先挑战']);
});

test('the same skill is hinted once per session, again in a new session',async t=>{
  const f=fixture(t);
  assert.match(await f.send('修这个 bug'),/cm-fix/);
  assert.equal(await f.send('再修这个 bug'),'');
  assert.match(await f.send('修这个 bug',{session:'other'}),/cm-fix/);
});

test('no hint when the user already typed or named the skill',async t=>{
  const f=fixture(t);
  assert.equal(await f.send('/cm-fix 修这个 bug'),'');
  assert.equal(await f.send('用 cm-fix 修这个 bug',{session:'s2'}),'');
});

test('long messages and fenced code never trigger',async t=>{
  const f=fixture(t);
  assert.equal(await f.send('修这个 bug'+'x'.repeat(MAX_PROMPT)),'');
  assert.equal(await f.send('看日志：\n```\n修这个 bug\n```\n怎么回事',{session:'s2'}),'');
  assert.equal(stripCode('a```x```b```y'),'a b ');
});

test('CM_SKILL_HINTS=off and enabled:false both silence the hook',async t=>{
  const f=fixture(t);
  assert.equal(await f.send('修这个 bug',{extraEnv:{CM_SKILL_HINTS:'off'}}),'');
  const g=fixture(t,{local:{enabled:false}});
  assert.equal(await g.send('修这个 bug'),'');
});

test('disable switches off a CM rule by id; a broken local file keeps CM rules',async t=>{
  const f=fixture(t,{local:{disable:['fix-bug']}});
  assert.equal(await f.send('修这个 bug'),'');
  const g=fixture(t,{local:'{oops'});
  assert.match(await g.send('修这个 bug'),/cm-fix/);
  assert.equal(loadRules({env:g.env,rulesFile:g.rulesFile}).localError,'parse');
});

test('invalid user rules are skipped, not fatal',async t=>{
  const f=fixture(t,{local:{rules:[{skill:'bad name',keywords:['bug']},{skill:'ok',keywords:[]},{skill:'re',patterns:['(']},
    {skill:'good',keywords:['修这个']}]}});
  assert.match(await f.send('修这个 bug'),/- \/good/);
});

test('the log keeps rule, skill, host and time, never the message',async t=>{
  const f=fixture(t);
  await f.send('修这个 bug，密码是 hunter2');
  const [entry]=f.log();
  assert.deepEqual(entry,{t:'2026-10-24T08:00:00.000Z',event:'hint',host:'claude',rule:'fix-bug',skill:'cm-fix'});
  assert.doesNotMatch(fs.readFileSync(logFile(f.env),'utf8'),/hunter2|修这个/);
});

test('typing the hinted skill within the window is logged as adopted',async t=>{
  const f=fixture(t);
  await f.send('修这个 bug');
  await f.send('好的');
  await f.send('/cm-fix 开始');
  assert.deepEqual(f.log().map(entry=>entry.event),['hint','adopted']);
});

test('typing it after the window is not adopted',async t=>{
  const f=fixture(t);
  await f.send('修这个 bug');
  for(let i=0;i<ADOPT_WINDOW;i++)await f.send(`第 ${i} 条`);
  await f.send('/cm-fix 开始');
  assert.deepEqual(f.log().map(entry=>entry.event),['hint']);
});

test('the log drops its older half once over the size limit',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(logFile(f.env)),{recursive:true});
  const line=JSON.stringify({t:'old',pad:'x'.repeat(200)})+'\n';
  fs.writeFileSync(logFile(f.env),line.repeat(Math.ceil(LOG_LIMIT/line.length)+10));
  const before=fs.readFileSync(logFile(f.env),'utf8').split('\n').filter(Boolean).length;
  await f.send('修这个 bug');
  const after=f.log();
  assert.ok(after.length<=Math.floor(before/2)+1);
  assert.equal(after.at(-1).rule,'fix-bug');
});

test('main hook stays quiet on bad input and exits 0',async t=>{
  const f=fixture(t);
  let out='';
  assert.equal(await main(['hook','--host','claude'],{env:f.env,readInput:()=>'not json',write:text=>{out+=text;}}),0);
  assert.equal(out,'');
  assert.equal(await main(['hook','--host','claude'],{env:f.env,readInput:()=>{throw new Error('closed');},write:text=>{out+=text;}}),0);
  assert.equal(out,'');
});

test('main hook prints the UserPromptSubmit JSON shape with the shipped table',async t=>{
  const f=fixture(t);
  let out='';
  await main(['hook','--host','codex'],{env:f.env,readInput:()=>JSON.stringify({prompt:'帮我修这个 bug',session_id:'x'}),write:text=>{out+=text;}});
  const parsed=JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName,'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext,/\$cm-fix/);
});

test('the shipped table loads cleanly and every rule resolves to a CM skill or a fallback',async ()=>{
  const table=JSON.parse(fs.readFileSync(defaultRulesPath(),'utf8'));
  const loaded=loadRules({env:{HOME:'/nonexistent',CM_WORKFLOW_HOME:'/nonexistent/.cm'}});
  assert.equal(loaded.cmCount,table.rules.length);
  assert.ok(table.rules.length>=10&&table.rules.length<=15);
  assert.equal(new Set(table.rules.map(rule=>rule.id)).size,table.rules.length);
  const skills=new Set(fs.readdirSync(path.join(path.dirname(defaultRulesPath()),'..','skills')));
  for(const rule of table.rules){
    if(rule.author)continue;
    assert.ok(skills.has(rule.skill),`${rule.id} 指向不存在的 CM 技能 ${rule.skill}`);
  }
  for(const rule of table.rules.filter(rule=>rule.fallback))assert.ok(skills.has(rule.fallback.skill));
});

test('enable copies a stable script and merges one hook into each host config',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(claudeSettingsPath(f.env)),{recursive:true});
  fs.writeFileSync(claudeSettingsPath(f.env),JSON.stringify({statusLine:{command:'x'},hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'other'}]}]}}));
  let out='';
  assert.equal(await enable({env:f.env,node:'/usr/bin/node',write:text=>{out+=text;}}),0);
  assert.ok(fs.existsSync(path.join(installDir(f.env),SCRIPT_NAME)));
  assert.ok(fs.existsSync(path.join(installDir(f.env),RULES_NAME)));
  const claude=JSON.parse(fs.readFileSync(claudeSettingsPath(f.env),'utf8'));
  assert.equal(claude.statusLine.command,'x');
  assert.equal(claude.hooks.UserPromptSubmit.length,2);
  assert.equal(claude.hooks.UserPromptSubmit[1].hooks[0].command,hookCommand(f.env,'claude','/usr/bin/node'));
  const codex=JSON.parse(fs.readFileSync(codexHooksPath(f.env),'utf8'));
  assert.ok(hasHintHook(codex,f.env,"codex"));
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command,/--host codex$/);
  assert.match(out,/信任/);
  await enable({env:f.env,node:'/usr/bin/node',write:()=>{}});
  assert.equal(JSON.parse(fs.readFileSync(claudeSettingsPath(f.env),'utf8')).hooks.UserPromptSubmit.length,2);
});

test('enable never rewrites a config it cannot parse',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(codexHooksPath(f.env)),{recursive:true});
  fs.writeFileSync(codexHooksPath(f.env),'{broken');
  let out='';
  assert.equal(await enable({env:f.env,hosts:['codex'],write:text=>{out+=text;}}),1);
  assert.equal(fs.readFileSync(codexHooksPath(f.env),'utf8'),'{broken');
  assert.match(out,/未改动/);
});

test('the installed copy runs on its own with its own table',async t=>{
  const f=fixture(t);
  await enable({env:f.env,write:()=>{}});
  const installed=await import(path.join(installDir(f.env),SCRIPT_NAME));
  const out=await installed.hook({prompt:'修这个 bug',session_id:'z'},{env:f.env,host:'claude',now:NOW});
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext,/cm-fix/);
});

test('hook command quotes paths with spaces',async t=>{
  const env={HOME:'/Users/a b',CM_WORKFLOW_HOME:'/Users/a b/.cm-workflow'};
  assert.equal(hookCommand(env,'claude','/opt/node/bin/node'),
    `/opt/node/bin/node '/Users/a b/.cm-workflow/skill-hints/${SCRIPT_NAME}' hook --host claude`);
});

test('status reports wiring, switch and table counts',async t=>{
  const f=fixture(t,{local:{rules:[{skill:'mine',keywords:['x']}],disable:['fix-bug']}});
  let text=statusText({env:f.env,rulesFile:f.rulesFile});
  assert.match(text,/Claude 未挂，Codex 未挂；开关 开/);
  assert.match(text,/CM 自带 3 条；用户自加 1 条；关掉自带 1 条/);
  fs.writeFileSync(localPath(f.env),JSON.stringify({enabled:false}));
  text=statusText({env:f.env,rulesFile:f.rulesFile});
  assert.match(text,/开关 关/);
});

test('CM-launched Claude and Codex sessions carry the off switch',async()=>{
  const {claudeEnvironment}=await import('../runtime/js/cm-ai/worker-claude.mjs');
  const {cleanEnvironment}=await import('../runtime/js/cm-ai/codex-config.mjs');
  assert.equal(claudeEnvironment().CM_SKILL_HINTS,'off');
  assert.equal(cleanEnvironment().CM_SKILL_HINTS,'off');
});

// ---- regressions from Codex review round 1 ----

test('a same-named skill that is not the pinned author version does not count as installed',async t=>{
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me','someone else\'s grill-me']]});
  const text=await f.send('设计一个方案');
  assert.match(text,/cm-challenge/);
  assert.doesNotMatch(text,/grill-me/);
});

test('a catastrophic user regex is cut off by the time budget; keywords still match',async t=>{
  const f=fixture(t,{local:{rules:[{skill:'slow',patterns:['^(a+)+$']}]}});
  const started=Date.now();
  const text=await f.send('a'.repeat(40)+'! 修这个 bug');
  assert.ok(Date.now()-started<2000,`took ${Date.now()-started}ms`);
  assert.match(text,/cm-fix/);
  assert.doesNotMatch(text,/slow/);
  assert.deepEqual(patternMatches([{patterns:[/^(a+)+$/]}],'a'.repeat(40)+'!',50),[false]);
});

test('special files at the local rules, state or log path never block the hook',async t=>{
  const f=fixture(t);
  fs.mkdirSync(f.env.CM_WORKFLOW_HOME,{recursive:true});
  fs.mkdirSync(path.dirname(logFile(f.env)),{recursive:true});
  execFileSync('mkfifo',[localPath(f.env)]);
  execFileSync('mkfifo',[logFile(f.env)]);
  assert.equal(readJson(localPath(f.env)).error,'not-file');
  assert.match(await f.send('修这个 bug'),/cm-fix/);
  assert.equal(loadRules({env:f.env,rulesFile:f.rulesFile}).localError,'not-file');
});

test('a user rule with a CM rule id replaces that CM rule',async t=>{
  const f=fixture(t,{local:{rules:[{id:'fix-bug',skill:'my-fix',keywords:['修这个 bug'],reason:'用我的'}]}});
  const lines=(await f.send('修这个 bug')).split('\n').filter(line=>line.startsWith('- '));
  assert.deepEqual(lines,['- /my-fix：用我的']);
});

test('session state is never pruned: a session resumed much later still does not repeat a hint',async t=>{
  const f=fixture(t);
  await f.send('修这个 bug',{session:'old'});
  const dir=path.join(installDir(f.env),'state');
  const [name]=fs.readdirSync(dir);
  const ancient=new Date(NOW-365*24*60*60*1000);
  fs.utimesSync(path.join(dir,name),ancient,ancient);
  await f.send('补单测',{session:'new'});
  assert.ok(fs.existsSync(path.join(dir,name)));
  assert.equal(await f.send('修这个 bug',{session:'old'}),'');
});

test('a foreign command that merely mentions the script name is not taken as ours',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(claudeSettingsPath(f.env)),{recursive:true});
  const tail=hookCommand(f.env,'claude','x').slice(2);
  fs.writeFileSync(claudeSettingsPath(f.env),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[
    {type:'command',command:`echo ${SCRIPT_NAME}`},{type:'command',command:`echo x ${tail}`}]}]}}));
  assert.match(statusText({env:f.env,rulesFile:f.rulesFile}),/Claude 未挂/);
  await enable({env:f.env,hosts:['claude'],node:'/usr/bin/node',write:()=>{}});
  assert.ok(hasHintHook(JSON.parse(fs.readFileSync(claudeSettingsPath(f.env),'utf8')),f.env,'claude'));
  assert.match(statusText({env:f.env,rulesFile:f.rulesFile}),/Claude 已挂/);
  const codexCmd=hookCommand(f.env,'codex','/usr/bin/node');
  assert.ok(!hasHintHook({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:codexCmd}]}]}},f.env,'claude'));
});

test('an existing empty or blank host config is reported and left byte-identical',async t=>{
  for(const content of ['','  \n']){
    const f=fixture(t);
    fs.mkdirSync(path.dirname(claudeSettingsPath(f.env)),{recursive:true});
    fs.writeFileSync(claudeSettingsPath(f.env),content);
    let out='';
    assert.equal(await enable({env:f.env,hosts:['claude'],write:text=>{out+=text;}}),1);
    assert.equal(fs.readFileSync(claudeSettingsPath(f.env),'utf8'),content);
    assert.match(out,/empty/);
  }
});

test('a config changed by someone else during enable is not overwritten',async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(claudeSettingsPath(f.env)),{recursive:true});
  fs.writeFileSync(claudeSettingsPath(f.env),'{"a":1}');
  let out='';
  const code=await enable({env:f.env,hosts:['claude'],write:text=>{out+=text;},
    beforeReplace:file=>fs.writeFileSync(file,'{"a":1,"theirs":true}')});
  assert.equal(code,1);
  assert.equal(fs.readFileSync(claudeSettingsPath(f.env),'utf8'),'{"a":1,"theirs":true}');
  assert.match(out,/刚被其他程序改动/);
});

test('adoption needs the whole skill token, not a longer name sharing its prefix',async t=>{
  assert.ok(typed('/cm-fix 开始','cm-fix','claude'));
  assert.ok(typed('先 $cm-fix','cm-fix','codex'));
  assert.ok(!typed('/cm-fix-extra','cm-fix','claude'));
  assert.ok(!typed('/cm-fix.v2','cm-fix','claude'));
  const f=fixture(t);
  await f.send('修这个 bug');
  await f.send('/cm-fix-extra 开始');
  assert.deepEqual(f.log().map(entry=>entry.event),['hint']);
});

// ---- regressions from Codex review round 2 ----

test('only a node interpreter running the managed copy counts as our hook',async t=>{
  const f=fixture(t);
  const tail=hookCommand(f.env,'claude','node').slice('node '.length);
  const ours=command=>hasHintHook({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command}]}]}},f.env,'claude');
  assert.ok(ours(`node ${tail}`));
  assert.ok(ours(`/opt/homebrew/bin/node ${tail}`));
  assert.ok(ours(`'/Users/a b/node' ${tail}`));
  assert.ok(!ours(`echo ${tail}`));
  assert.ok(!ours(`python3 ${tail}`));
  assert.ok(!ours(`'/Users/a b/echo' ${tail}`));
});

test('two CM writers never hold the config lock at once; a stale lock is taken over',async t=>{
  const f=fixture(t);
  const {withConfigLock,LockBusy,lockPath}=await import('./cm-config-lock.mjs');
  const file=claudeSettingsPath(f.env);
  assert.throws(()=>withConfigLock(f.env,file,()=>withConfigLock(f.env,file,()=>'inner',{waitMs:100})),LockBusy);
  assert.equal(withConfigLock(f.env,file,()=>'free again'),'free again');
  const lock=lockPath(f.env,file);
  fs.writeFileSync(lock,'12345');
  const old=new Date(Date.now()-60000);
  fs.utimesSync(lock,old,old);
  assert.equal(withConfigLock(f.env,file,()=>'taken over',{waitMs:100}),'taken over');
  assert.ok(!fs.existsSync(lock));
});

test('enable leaves the config alone while another CM writer holds its lock',async t=>{
  const f=fixture(t);
  const {lockPath}=await import('./cm-config-lock.mjs');
  const lock=lockPath(f.env,claudeSettingsPath(f.env));
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  fs.writeFileSync(lock,'other');
  let out='';
  assert.equal(await enable({env:f.env,hosts:['claude'],write:text=>{out+=text;},lockWaitMs:100}),1);
  assert.ok(!fs.existsSync(claudeSettingsPath(f.env)));
  assert.match(out,/另一个 CM 程序正在改/);
});

test('a missing author checker falls back to CM skills instead of failing',async t=>{
  assert.equal(await loadAuthorCheck('./does-not-exist.mjs'),null);
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me']]});
  const out=await hook({prompt:'设计一个方案',session_id:'m'},{env:f.env,host:'claude',rulesFile:f.rulesFile,now:NOW,loadAuthor:async()=>null});
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext,/cm-challenge/);
});

test('the installed hook still exits 0 with a hint when its checker file is gone',async t=>{
  const f=fixture(t);
  await enable({env:f.env,hosts:['claude'],write:()=>{}});
  fs.unlinkSync(path.join(installDir(f.env),'cm-matt-skills.mjs'));
  const out=execFileSync(process.execPath,[path.join(installDir(f.env),SCRIPT_NAME),'hook','--host','claude'],
    {env:{...process.env,...f.env},input:JSON.stringify({prompt:'帮我设计一个方案',session_id:'gone'}),encoding:'utf8'});
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext,/cm-challenge/);
});

test('a failed companion copy leaves the previously installed script in place',async t=>{
  const f=fixture(t);
  const dir=installDir(f.env);
  fs.mkdirSync(path.join(dir,'cm-config-lock.mjs','blocker'),{recursive:true});
  fs.writeFileSync(path.join(dir,SCRIPT_NAME),'// previous working copy\n');
  let out='';
  assert.equal(await enable({env:f.env,hosts:['claude'],write:text=>{out+=text;}}),1);
  assert.equal(fs.readFileSync(path.join(dir,SCRIPT_NAME),'utf8'),'// previous working copy\n');
  assert.match(out,/复制提醒脚本/);
});

test('a URL or path ending in the skill name is not an adoption',async t=>{
  assert.ok(!typed('请看 https://example.invalid/cm-fix','cm-fix','claude'));
  assert.ok(!typed('文件在 docs/cm-fix','cm-fix','claude'));
  assert.ok(!typed('a$cm-fix','cm-fix','codex'));
  assert.ok(typed('好，/cm-fix','cm-fix','claude'));
  assert.ok(typed('用（/cm-fix）','cm-fix','claude'));
});
