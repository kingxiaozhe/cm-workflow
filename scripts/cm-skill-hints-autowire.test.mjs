// Install-time default for skill hints (decided 2026-10-25): every install wires the
// hint hook for its own host, unless the user said no (--no-skill-hints,
// CM_SKILL_HINTS_INSTALL=off, "enabled": false) or removed the hook after it was there.
// Every case runs in a disposable HOME; no real config, key or Jev is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  install,enable,main,statusText,hasHintHook,hookCommand,settledHosts,
  localPath,installDir,autoPath,claudeSettingsPath,codexHooksPath,SCRIPT_NAME,
} from './cm-skill-hints.mjs';

const NODE='/usr/bin/node';

function box(t){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-skill-hints-auto-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={HOME:home,CLAUDE_HOME:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),
    CM_WORKFLOW_HOME:path.join(home,'.cm-workflow'),CM_WORKFLOW_LOG_HOME:path.join(home,'.cm-workflow','logs')};
  const file=host=>host==='codex'?codexHooksPath(env):claudeSettingsPath(env);
  const read=host=>{try{return JSON.parse(fs.readFileSync(file(host),'utf8'));}catch{return undefined;}};
  const wired=host=>hasHintHook(read(host),env,host);
  const ours=host=>(read(host)?.hooks?.UserPromptSubmit??[]).filter(group=>hasHintHook({hooks:{UserPromptSubmit:[group]}},env,host)).length;
  const run=async(host,options={})=>{
    let out='';
    const code=await install({env,host,node:NODE,write:text=>{out+=text;},...options});
    return {code,out};
  };
  const writeConfig=(host,value)=>{
    fs.mkdirSync(path.dirname(file(host)),{recursive:true});
    fs.writeFileSync(file(host),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  };
  return {home,env,file,read,wired,ours,run,writeConfig};
}

test('first install wires only its own host, records it and says how to turn it off',async t=>{
  const b=box(t);
  const claude=await b.run('claude');
  assert.equal(claude.code,0,claude.out);
  assert.ok(b.wired('claude'));
  assert.ok(!fs.existsSync(b.file('codex')),'the Claude install must not touch Codex');
  assert.ok(fs.existsSync(path.join(installDir(b.env),SCRIPT_NAME)));
  assert.deepEqual(settledHosts(b.env).hosts,['claude']);
  assert.match(claude.out,/已给 Claude 挂上技能提醒钩子/);
  assert.match(claude.out,/"enabled": false/);
  // Turning hints off is "enabled": false; --no-skill-hints only stops an install from adding the hook.
  assert.match(claude.out,/关掉提醒：在 .* 写 \{"enabled": false\}/);
  assert.match(claude.out,/--no-skill-hints 只是不自动挂，不会摘掉已挂的钩子/);
  assert.doesNotMatch(claude.out,/或重装时加 --no-skill-hints/);
  assert.match(claude.out,/TypeSafe.*500/);
  assert.doesNotMatch(claude.out,/信任/);

  const codex=await b.run('codex');
  assert.equal(codex.code,0,codex.out);
  assert.ok(b.wired('codex'));
  assert.match(b.read('codex').hooks.UserPromptSubmit[0].hooks[0].command,/--host codex$/);
  assert.match(codex.out,/Codex 首次运行这条钩子时会请你确认信任/);
  assert.deepEqual(settledHosts(b.env).hosts.sort(),['claude','codex']);
});

test('a repeated install keeps one hook and leaves the config bytes alone',async t=>{
  const b=box(t);
  b.writeConfig('claude',{statusLine:{command:'x'},hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'other'}]}]}});
  assert.equal((await b.run('claude')).code,0);
  const after=fs.readFileSync(b.file('claude'),'utf8');
  assert.equal(b.read('claude').statusLine.command,'x');
  assert.equal(b.read('claude').hooks.UserPromptSubmit.length,2);
  const again=await b.run('claude');
  assert.equal(again.code,0,again.out);
  assert.equal(fs.readFileSync(b.file('claude'),'utf8'),after);
  assert.equal(b.ours('claude'),1);
  assert.doesNotMatch(again.out,/已给 Claude 挂上/);
});

for(const [label,options,env,local,settles] of [
  ['the --no-skill-hints flag',{skip:true},{},undefined,true],
  ['CM_SKILL_HINTS_INSTALL=off',{},{CM_SKILL_HINTS_INSTALL:'off'},undefined,true],
  ['"enabled": false in the local file',{},{},{enabled:false},false],
]){
  test(`${label} keeps a fresh install from wiring anything`,async t=>{
    const b=box(t);
    if(local){fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});fs.writeFileSync(localPath(b.env),JSON.stringify(local));}
    Object.assign(b.env,env);
    for(const host of ['claude','codex']){
      const result=await b.run(host,options);
      assert.equal(result.code,0,result.out);
      assert.match(result.out,/没给 (Claude|Codex) 挂/);
      assert.ok(!fs.existsSync(b.file(host)));
    }
    assert.ok(!fs.existsSync(installDir(b.env)));
    // An opt-out by flag or variable settles the host: a later plain install does not wire it.
    // "enabled": false is a lasting switch of its own and settles nothing.
    assert.deepEqual(settledHosts(b.env).hosts.sort(),settles?['claude','codex']:[]);
  });
}

test('after an opt-out by flag, a later plain install does not wire that host',async t=>{
  const b=box(t);
  const skipped=await b.run('claude',{skip:true});
  assert.match(skipped.out,/以后安装也不会自动挂/);
  assert.match(skipped.out,/enable --claude/);
  const plain=await b.run('claude');
  assert.equal(plain.code,0,plain.out);
  assert.ok(!fs.existsSync(b.file('claude')));
  assert.equal((await b.run('codex')).code,0);
  assert.ok(b.wired('codex'),'the other host is still wired by default');
});

test('an opt-out run keeps an existing hook and says how to really turn hints off',async t=>{
  const b=box(t);
  await b.run('claude');
  const result=await b.run('claude',{skip:true});
  assert.equal(result.code,0,result.out);
  assert.ok(b.wired('claude'));
  assert.match(result.out,/已挂着的钩子不受影响.*"enabled": false/);
});

test('an opted-out run still refreshes the copy of a user who already has hints',async t=>{
  const b=box(t);
  await b.run('claude');
  fs.writeFileSync(path.join(installDir(b.env),SCRIPT_NAME),'// old version\n');
  const result=await b.run('claude',{skip:true});
  assert.equal(result.code,0,result.out);
  assert.notEqual(fs.readFileSync(path.join(installDir(b.env),SCRIPT_NAME),'utf8'),'// old version\n');
  assert.ok(b.wired('claude'),'opting out of the install default never removes a hook');
});

test('a hook the user removed is not added back by a later install',async t=>{
  const b=box(t);
  b.writeConfig('claude',{model:'opus'});
  await b.run('claude');
  // The user takes our hook out again, keeping the rest.
  b.writeConfig('claude',{model:'opus',hooks:{UserPromptSubmit:[]}});
  const before=fs.readFileSync(b.file('claude'),'utf8');
  const result=await b.run('claude');
  assert.equal(result.code,0,result.out);
  assert.equal(fs.readFileSync(b.file('claude'),'utf8'),before);
  assert.match(result.out,/之前挂过后被移除/);
  assert.match(result.out,/enable --claude/);
  // Explicit enable still works and the next install leaves it in place.
  assert.equal(await enable({env:b.env,hosts:['claude'],node:NODE,write:()=>{}}),0);
  assert.ok(b.wired('claude'));
  assert.equal((await b.run('claude')).code,0);
  assert.equal(b.ours('claude'),1);
});

test('enabling one host by hand does not count as removing the other',async t=>{
  const b=box(t);
  assert.equal(await enable({env:b.env,hosts:['claude'],node:NODE,write:()=>{}}),0);
  assert.ok(fs.existsSync(installDir(b.env)));
  const result=await b.run('codex');
  assert.equal(result.code,0,result.out);
  assert.ok(b.wired('codex'));
});

test('a copy made before this record existed counts as the user\'s own choice for both hosts',async t=>{
  const b=box(t);
  // An earlier `enable --claude`: copy directory and Claude hook, no record.
  fs.mkdirSync(installDir(b.env),{recursive:true});
  b.writeConfig('claude',{hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:hookCommand(b.env,'claude',NODE)}]}]}});
  const codex=await b.run('codex');
  assert.equal(codex.code,0,codex.out);
  assert.ok(!fs.existsSync(b.file('codex')));
  assert.match(codex.out,/没给 Codex 挂/);
  assert.equal((await b.run('claude')).code,0);
  assert.ok(b.wired('claude'));
  assert.deepEqual(settledHosts(b.env).hosts.sort(),['claude','codex']);
});

test('a config that cannot be read or has the wrong shape is left alone and retried next time',async t=>{
  const b=box(t);
  b.writeConfig('claude','{broken');
  const broken=await b.run('claude');
  assert.equal(broken.code,1);
  assert.equal(fs.readFileSync(b.file('claude'),'utf8'),'{broken');
  assert.match(broken.out,/未改动/);
  assert.ok(!settledHosts(b.env).hosts.includes('claude'));
  b.writeConfig('codex',{hooks:{UserPromptSubmit:{}}});
  const shaped=await b.run('codex');
  assert.equal(shaped.code,1);
  assert.match(shaped.out,/格式异常/);
  // Once the user fixes the file, the next install wires it.
  b.writeConfig('claude',{});
  assert.equal((await b.run('claude')).code,0);
  assert.ok(b.wired('claude'));
});

test('a local file that cannot be read keeps the install from wiring, with a warning',async t=>{
  const b=box(t);
  fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});
  fs.writeFileSync(localPath(b.env),'{"enabled": fals');
  const result=await b.run('claude');
  assert.equal(result.code,0);
  assert.match(result.out,/⚠.*读取失败.*没给 Claude 挂/);
  assert.ok(!fs.existsSync(b.file('claude')));
});

test('a failure only warns: a linked copy directory is never written through',async t=>{
  const b=box(t);
  const elsewhere=path.join(b.home,'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});
  fs.symlinkSync(elsewhere,installDir(b.env));
  const result=await b.run('claude');
  assert.equal(result.code,1);
  assert.match(result.out,/✗|⚠/);
  assert.deepEqual(fs.readdirSync(elsewhere),[]);
  assert.ok(!b.wired('claude'));
});

test('main install takes --host and --no-skill-hints; a bad host is a usage error',async t=>{
  const b=box(t);
  const quiet={env:b.env,write:()=>{},error:()=>{}};
  assert.equal(await main(['install','--host','codex','--no-skill-hints'],quiet),0);
  assert.ok(!fs.existsSync(b.file('codex')));
  assert.equal(await main(['install','--host','claude'],quiet),0);
  assert.ok(b.wired('claude'));
  assert.equal(await main(['install','--host','other'],quiet),2);
  assert.equal(await main(['install'],quiet),2);
  assert.equal(await main(['install','--host','claude','--extra'],quiet),2);
});

// ---- review round 1 ----

const recordText=b=>fs.existsSync(autoPath(b.env))?fs.readFileSync(autoPath(b.env),'utf8'):null;
const writeRecord=(b,text)=>{fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});fs.writeFileSync(autoPath(b.env),text);};

test('the record is re-read and merged under the lock: another installer\'s host is not lost',async t=>{
  const b=box(t);
  await b.run('claude');
  fs.rmSync(autoPath(b.env));
  writeRecord(b,'{"version":1,"hosts":[]}\n');
  // Claude is wired; while this install runs, the Codex installer records codex.
  const result=await b.run('claude',{beforeRecord:()=>writeRecord(b,'{"version":1,"hosts":["codex"]}\n')});
  assert.equal(result.code,0,result.out);
  assert.deepEqual(settledHosts(b.env).hosts.sort(),['claude','codex']);
});

test('a record changed between read and replace is not overwritten',async t=>{
  const b=box(t);
  await b.run('claude');
  writeRecord(b,'{"version":1,"hosts":[]}\n');
  const result=await b.run('claude',{beforeRecordReplace:()=>writeRecord(b,'{"version":1,"hosts":["codex"]}\n')});
  assert.equal(result.code,1);
  assert.match(result.out,/⚠.*未能记下/);
  assert.equal(recordText(b),'{"version":1,"hosts":["codex"]}\n');
  assert.ok(b.wired('claude'));
});

for(const [label,text] of [
  ['an empty object','{}'],
  ['hosts as a string','{"version":1,"hosts":"claude"}'],
  ['an unknown version','{"version":2,"hosts":[]}'],
  ['an unknown host','{"version":1,"hosts":["vim"]}'],
  ['broken JSON','{"version":1,'],
]){
  test(`a record with ${label} is kept as is, nothing is wired and the install warns`,async t=>{
    const b=box(t);
    writeRecord(b,text);
    const fresh=await b.run('codex');
    assert.equal(fresh.code,1);
    assert.match(fresh.out,/⚠.*skill-hints\.auto\.json.*异常.*没给 Codex 挂/);
    assert.ok(!fs.existsSync(b.file('codex')));
    // A wired host does not overwrite it either.
    b.writeConfig('claude',{hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:hookCommand(b.env,'claude',NODE)}]}]}});
    const wired=await b.run('claude');
    assert.equal(wired.code,1);
    assert.match(wired.out,/⚠.*异常/);
    assert.equal(recordText(b),text);
    // Status names the pause.
    assert.match(statusText({env:b.env}),/安装时自动挂：暂停（.*skill-hints\.auto\.json.*异常/);
  });
}

for(const [label,text] of [['a list','[]'],['null','null'],['enabled as a string','{"enabled":"false"}']]){
  test(`a local file holding ${label} keeps the install from wiring, with a warning`,async t=>{
    const b=box(t);
    fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});
    fs.writeFileSync(localPath(b.env),text);
    const result=await b.run('claude');
    assert.match(result.out,/⚠.*格式异常.*没给 Claude 挂/);
    assert.ok(!fs.existsSync(b.file('claude')));
    assert.ok(!fs.existsSync(installDir(b.env)));
    assert.equal(fs.readFileSync(localPath(b.env),'utf8'),text);
    assert.match(statusText({env:b.env}),/安装时自动挂：暂停/);
  });
}

test('a first copy that fails half way is retried by the next install, not taken for an old enable',async t=>{
  const b=box(t);
  const failed=await b.run('claude',{copyFiles:env=>{fs.mkdirSync(installDir(env),{recursive:true});throw new Error('disk full');}});
  assert.equal(failed.code,1);
  assert.ok(fs.existsSync(installDir(b.env)));
  const again=await b.run('claude');
  assert.equal(again.code,0,again.out);
  assert.ok(b.wired('claude'));
});

test('an install that finds the hook wired warns when the record cannot be written',async t=>{
  const b=box(t);
  const {lockPath}=await import('./cm-config-lock.mjs');
  b.writeConfig('claude',{hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:hookCommand(b.env,'claude',NODE)}]}]}});
  const lock=lockPath(b.env,autoPath(b.env));
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  fs.writeFileSync(lock,'other');
  const result=await b.run('claude',{lockWaitMs:100});
  assert.equal(result.code,1);
  assert.match(result.out,/⚠.*未能记下/);
  assert.ok(!fs.existsSync(autoPath(b.env)));
  assert.ok(b.wired('claude'));
});

test('a local file that cannot be read pauses the install default in status',async t=>{
  const b=box(t);
  fs.mkdirSync(b.env.CM_WORKFLOW_HOME,{recursive:true});
  fs.writeFileSync(localPath(b.env),'{"enabled": fals');
  assert.match(statusText({env:b.env}),/安装时自动挂：暂停（.*读取失败/);
});

test('status says whether installs wire the hook and which hosts are settled',async t=>{
  const b=box(t);
  assert.match(statusText({env:b.env}),/安装时自动挂：开；已处理过：无/);
  await b.run('claude');
  assert.match(statusText({env:b.env}),/安装时自动挂：开；已处理过：Claude（这些端不会再被自动挂上）/);
  assert.match(statusText({env:{...b.env,CM_SKILL_HINTS_INSTALL:'off'}}),/安装时自动挂：已关闭（CM_SKILL_HINTS_INSTALL=off）/);
  fs.writeFileSync(localPath(b.env),JSON.stringify({enabled:false}));
  assert.match(statusText({env:b.env}),/安装时自动挂：已关闭（.*enabled 为 false）/);
});

test('the hook still fails quietly and exits 0',async t=>{
  const b=box(t);
  await b.run('claude');
  assert.equal(await main(['hook','--host','claude'],{env:b.env,readInput:()=>'{not json',write:()=>{assert.fail('no output');}}),0);
});
