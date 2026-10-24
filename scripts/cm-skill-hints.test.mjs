import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hook,main,enable,statusText,loadRules,stripCode,hookCommand,hasHintHook,
  localPath,logFile,installDir,claudeSettingsPath,codexHooksPath,defaultRulesPath,
  MAX_PROMPT,ADOPT_WINDOW,LOG_LIMIT,SCRIPT_NAME,RULES_NAME,
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
  for(const [root,name] of authorSkills){
    const dir=path.join(home,root,name);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'SKILL.md'),'---\nname: x\n---\n');
  }
  const send=(prompt,{host='claude',session='s1',extraEnv={}}={})=>{
    const out=hook({prompt,session_id:session},{env:{...env,...extraEnv},host,rulesFile,now:NOW});
    return out?JSON.parse(out).hookSpecificOutput.additionalContext:'';
  };
  const log=()=>{try{return fs.readFileSync(logFile(env),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}};
  return {home,env,rulesFile,send,log};
}

test('a keyword hint names the skill in the host\'s own syntax',t=>{
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me'],['.agents/skills','grill-me']]});
  assert.match(f.send('帮我设计一个方案'),/- \/grill-me：先问透/);
  assert.match(f.send('帮我设计一个方案',{host:'codex',session:'s2'}),/- \$grill-me：先问透/);
});

test('matching ignores case and supports optional regex patterns',t=>{
  const f=fixture(t,{authorSkills:[['.claude/skills','grill-me']]});
  assert.match(f.send('please GRILL ME on this'),/grill-me/);
  assert.match(f.send('覆盖率 40 太低',{session:'s2'}),/cm-test/);
  assert.equal(f.send('覆盖率很低',{session:'s3'}),'');
});

test('a missing author skill falls back to its CM counterpart, or is dropped',t=>{
  const f=fixture(t);
  const text=f.send('帮我设计一个方案，会话太长了');
  assert.match(text,/\/cm-challenge：先挑战/);
  assert.doesNotMatch(text,/grill-me|handoff/);
});

test('an author skill installed only for the other host does not count',t=>{
  const f=fixture(t,{authorSkills:[['.agents/skills','grill-me']]});
  assert.match(f.send('设计一个方案'),/cm-challenge/);
});

test('at most two hints per message, user rules first',t=>{
  const f=fixture(t,{local:{rules:[{skill:'my-skill',keywords:['bug'],reason:'自己的'}]}});
  const text=f.send('设计一个方案，修这个 bug，再补单测');
  const lines=text.split('\n').filter(line=>line.startsWith('- '));
  assert.deepEqual(lines,['- /my-skill：自己的','- /cm-challenge：先挑战']);
});

test('the same skill is hinted once per session, again in a new session',t=>{
  const f=fixture(t);
  assert.match(f.send('修这个 bug'),/cm-fix/);
  assert.equal(f.send('再修这个 bug'),'');
  assert.match(f.send('修这个 bug',{session:'other'}),/cm-fix/);
});

test('no hint when the user already typed or named the skill',t=>{
  const f=fixture(t);
  assert.equal(f.send('/cm-fix 修这个 bug'),'');
  assert.equal(f.send('用 cm-fix 修这个 bug',{session:'s2'}),'');
});

test('long messages and fenced code never trigger',t=>{
  const f=fixture(t);
  assert.equal(f.send('修这个 bug'+'x'.repeat(MAX_PROMPT)),'');
  assert.equal(f.send('看日志：\n```\n修这个 bug\n```\n怎么回事',{session:'s2'}),'');
  assert.equal(stripCode('a```x```b```y'),'a b ');
});

test('CM_SKILL_HINTS=off and enabled:false both silence the hook',t=>{
  const f=fixture(t);
  assert.equal(f.send('修这个 bug',{extraEnv:{CM_SKILL_HINTS:'off'}}),'');
  const g=fixture(t,{local:{enabled:false}});
  assert.equal(g.send('修这个 bug'),'');
});

test('disable switches off a CM rule by id; a broken local file keeps CM rules',t=>{
  const f=fixture(t,{local:{disable:['fix-bug']}});
  assert.equal(f.send('修这个 bug'),'');
  const g=fixture(t,{local:'{oops'});
  assert.match(g.send('修这个 bug'),/cm-fix/);
  assert.equal(loadRules({env:g.env,rulesFile:g.rulesFile}).localError,'parse');
});

test('invalid user rules are skipped, not fatal',t=>{
  const f=fixture(t,{local:{rules:[{skill:'bad name',keywords:['bug']},{skill:'ok',keywords:[]},{skill:'re',patterns:['(']},
    {skill:'good',keywords:['修这个']}]}});
  assert.match(f.send('修这个 bug'),/- \/good/);
});

test('the log keeps rule, skill, host and time, never the message',t=>{
  const f=fixture(t);
  f.send('修这个 bug，密码是 hunter2');
  const [entry]=f.log();
  assert.deepEqual(entry,{t:'2026-10-24T08:00:00.000Z',event:'hint',host:'claude',rule:'fix-bug',skill:'cm-fix'});
  assert.doesNotMatch(fs.readFileSync(logFile(f.env),'utf8'),/hunter2|修这个/);
});

test('typing the hinted skill within the window is logged as adopted',t=>{
  const f=fixture(t);
  f.send('修这个 bug');
  f.send('好的');
  f.send('/cm-fix 开始');
  assert.deepEqual(f.log().map(entry=>entry.event),['hint','adopted']);
});

test('typing it after the window is not adopted',t=>{
  const f=fixture(t);
  f.send('修这个 bug');
  for(let i=0;i<ADOPT_WINDOW;i++)f.send(`第 ${i} 条`);
  f.send('/cm-fix 开始');
  assert.deepEqual(f.log().map(entry=>entry.event),['hint']);
});

test('the log drops its older half once over the size limit',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(logFile(f.env)),{recursive:true});
  const line=JSON.stringify({t:'old',pad:'x'.repeat(200)})+'\n';
  fs.writeFileSync(logFile(f.env),line.repeat(Math.ceil(LOG_LIMIT/line.length)+10));
  const before=fs.readFileSync(logFile(f.env),'utf8').split('\n').filter(Boolean).length;
  f.send('修这个 bug');
  const after=f.log();
  assert.ok(after.length<=Math.floor(before/2)+1);
  assert.equal(after.at(-1).rule,'fix-bug');
});

test('main hook stays quiet on bad input and exits 0',t=>{
  const f=fixture(t);
  let out='';
  assert.equal(main(['hook','--host','claude'],{env:f.env,readInput:()=>'not json',write:text=>{out+=text;}}),0);
  assert.equal(out,'');
  assert.equal(main(['hook','--host','claude'],{env:f.env,readInput:()=>{throw new Error('closed');},write:text=>{out+=text;}}),0);
  assert.equal(out,'');
});

test('main hook prints the UserPromptSubmit JSON shape with the shipped table',t=>{
  const f=fixture(t);
  let out='';
  main(['hook','--host','codex'],{env:f.env,readInput:()=>JSON.stringify({prompt:'帮我修这个 bug',session_id:'x'}),write:text=>{out+=text;}});
  const parsed=JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName,'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext,/\$cm-fix/);
});

test('the shipped table loads cleanly and every rule resolves to a CM skill or a fallback',()=>{
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

test('enable copies a stable script and merges one hook into each host config',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(claudeSettingsPath(f.env)),{recursive:true});
  fs.writeFileSync(claudeSettingsPath(f.env),JSON.stringify({statusLine:{command:'x'},hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'other'}]}]}}));
  let out='';
  assert.equal(enable({env:f.env,node:'/usr/bin/node',write:text=>{out+=text;}}),0);
  assert.ok(fs.existsSync(path.join(installDir(f.env),SCRIPT_NAME)));
  assert.ok(fs.existsSync(path.join(installDir(f.env),RULES_NAME)));
  const claude=JSON.parse(fs.readFileSync(claudeSettingsPath(f.env),'utf8'));
  assert.equal(claude.statusLine.command,'x');
  assert.equal(claude.hooks.UserPromptSubmit.length,2);
  assert.equal(claude.hooks.UserPromptSubmit[1].hooks[0].command,hookCommand(f.env,'claude','/usr/bin/node'));
  const codex=JSON.parse(fs.readFileSync(codexHooksPath(f.env),'utf8'));
  assert.ok(hasHintHook(codex));
  assert.match(codex.hooks.UserPromptSubmit[0].hooks[0].command,/--host codex$/);
  assert.match(out,/信任/);
  enable({env:f.env,node:'/usr/bin/node',write:()=>{}});
  assert.equal(JSON.parse(fs.readFileSync(claudeSettingsPath(f.env),'utf8')).hooks.UserPromptSubmit.length,2);
});

test('enable never rewrites a config it cannot parse',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.dirname(codexHooksPath(f.env)),{recursive:true});
  fs.writeFileSync(codexHooksPath(f.env),'{broken');
  let out='';
  assert.equal(enable({env:f.env,hosts:['codex'],write:text=>{out+=text;}}),1);
  assert.equal(fs.readFileSync(codexHooksPath(f.env),'utf8'),'{broken');
  assert.match(out,/未改动/);
});

test('the installed copy runs on its own with its own table',async t=>{
  const f=fixture(t);
  enable({env:f.env,write:()=>{}});
  const installed=await import(path.join(installDir(f.env),SCRIPT_NAME));
  const out=installed.hook({prompt:'修这个 bug',session_id:'z'},{env:f.env,host:'claude',now:NOW});
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext,/cm-fix/);
});

test('hook command quotes paths with spaces',t=>{
  const env={HOME:'/Users/a b',CM_WORKFLOW_HOME:'/Users/a b/.cm-workflow'};
  assert.equal(hookCommand(env,'claude','/opt/node/bin/node'),
    `/opt/node/bin/node '/Users/a b/.cm-workflow/skill-hints/${SCRIPT_NAME}' hook --host claude`);
});

test('status reports wiring, switch and table counts',t=>{
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
