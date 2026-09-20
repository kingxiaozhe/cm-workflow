import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {main,settingsPath,declinedPath,hasAnnounceHook,withAnnounceHook,ANNOUNCE_COMMAND} from './cm-announce-hook.mjs';

function fixture(t,settings){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-announce-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={HOME:home,CLAUDE_HOME:path.join(home,'.claude'),CM_WORKFLOW_HOME:path.join(home,'.cm-workflow')};
  if(settings!==undefined){
    fs.mkdirSync(env.CLAUDE_HOME,{recursive:true});
    fs.writeFileSync(settingsPath(env),typeof settings==='string'?settings:JSON.stringify(settings,null,2));
  }
  return {env,read:()=>JSON.parse(fs.readFileSync(settingsPath(env),'utf8'))};
}
const run=async(env,answer,interactive=true)=>{
  let text='';
  const output=new Writable({write(chunk,_e,cb){text+=chunk;cb();}});
  await main({env,input:Readable.from(answer===null?[]:[`${answer}\n`]),output,interactive});
  return text;
};

test('an existing hook is reported, never duplicated',async t=>{
  const existing={hooks:{SessionStart:[{hooks:[{type:'command',command:ANNOUNCE_COMMAND,timeout:5}]}]}};
  const f=fixture(t,existing);
  const text=await run(f.env,'y');
  assert.match(text,/已启用/);
  assert.deepEqual(f.read(),existing,'settings must be untouched');
});

test('yes adds only the announcement hook and preserves every other setting',async t=>{
  const original={statusLine:{type:'command',command:'~/.claude/statusline.sh'},
    env:{FOO:'bar'},hooks:{SessionStart:[{hooks:[{type:'command',command:'~/mine.sh'}]}],
      PreToolUse:[{hooks:[{type:'command',command:'~/guard.sh'}]}]}};
  const f=fixture(t,original);
  await run(f.env,'y');
  const after=f.read();
  assert.deepEqual(after.statusLine,original.statusLine,'the user statusline survives');
  assert.deepEqual(after.env,original.env);
  assert.deepEqual(after.hooks.PreToolUse,original.hooks.PreToolUse,'other hook kinds survive');
  assert.deepEqual(after.hooks.SessionStart[0],original.hooks.SessionStart[0],'the existing SessionStart hook survives');
  assert.equal(hasAnnounceHook(after),true);
  assert.equal(after.hooks.SessionStart.length,2);
  // The background updater is a separate decision and must never be added here.
  assert.equal(JSON.stringify(after).includes('cm-update.sh'),false);
});

test('no answer leaves settings alone and is remembered',async t=>{
  const f=fixture(t,{statusLine:{type:'command',command:'~/mine.sh'}});
  const text=await run(f.env,'n');
  assert.equal(hasAnnounceHook(f.read()),false);
  assert.match(text,/未开启/);
  assert.equal(fs.existsSync(declinedPath(f.env)),true);
  const again=await run(f.env,'y');
  assert.match(again,/此前已选择不开启/);
  assert.equal(hasAnnounceHook(f.read()),false,'a remembered refusal is not overridden');
});

test('non-interactive installs never write and print the exact manual step',async t=>{
  const f=fixture(t,{});
  const text=await run(f.env,null,false);
  assert.equal(hasAnnounceHook(f.read()),false);
  assert.match(text,/hooks\.SessionStart/);
  assert.match(text,new RegExp(ANNOUNCE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(fs.existsSync(declinedPath(f.env)),false,'declining was never asked, so nothing is remembered');
});

test('unparsable settings are reported and left byte-identical',async t=>{
  const broken='{ this is not json';
  const f=fixture(t,broken);
  const text=await run(f.env,'y');
  assert.match(text,/无法解析/);
  assert.equal(fs.readFileSync(settingsPath(f.env),'utf8'),broken);
});

test('a missing settings file is created with just the hook',async t=>{
  const f=fixture(t);
  await run(f.env,'y');
  assert.deepEqual(f.read(),{hooks:{SessionStart:[{hooks:[{type:'command',command:ANNOUNCE_COMMAND,timeout:5}]}]}});
});

test('withAnnounceHook does not mutate its input',()=>{
  const input={hooks:{SessionStart:[]}};
  const snapshot=JSON.stringify(input);
  withAnnounceHook(input);
  assert.equal(JSON.stringify(input),snapshot);
});
