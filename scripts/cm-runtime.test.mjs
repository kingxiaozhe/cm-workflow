import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig,runtimePreset,runtimesSource,resolveRole,MAX_CONFIG_BYTES} from './cm-workflow-config.mjs';
import {setProjectRuntime,writeUserRuntime,showRuntime} from './cm-runtime.mjs';
import {editRuntimeDeclaration} from './cm-runtime-edit.mjs';
import {json as strictJson} from '../runtime/js/cm-ai/effect-contract.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-runtime-')));
  const old=process.env.CM_WORKFLOW_HOME;
  process.env.CM_WORKFLOW_HOME=path.join(root,'user');
  const env={...process.env,HOME:root,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const run=(...args)=>spawnSync(process.execPath,[path.join(scripts,'cm-runtime.mjs'),...args],{cwd:root,env,encoding:'utf8'});
  try{return fn(root,run,env);}finally{if(old===undefined)delete process.env.CM_WORKFLOW_HOME;else process.env.CM_WORKFLOW_HOME=old;fs.rmSync(root,{recursive:true,force:true});}
}

test('show is read-only; missing CLI only warns; explicit preset commands work without TTY',()=>fixture((root,run,env)=>{
  const show=run('show');assert.equal(show.status,0,show.stderr);assert.match(show.stdout,/runtimes_source: none/);
  assert.deepEqual(fs.readdirSync(root),[]);
  for(const preset of ['codex-only','claude-only','codex-codes','claude-codes']){
    const result=run('set','--user',preset);assert.equal(result.status,0,result.stderr);
    const config=loadConfig({projectRoot:root});assert.equal(runtimesSource(config),'user');
    assert.equal(config.roles.coder.adapter,runtimePreset(preset).roles.coder.adapter);
  }
  const diagnostic=showRuntime(root,{probe:wanted=>wanted.map(runtime=>({runtime,available:false}))});
  assert.match(diagnostic,/preset: claude-codes/);assert.match(diagnostic,/WARN: .*codex CLI/);assert.match(diagnostic,/WARN: .*claude CLI/);
  const set=run('set','codex-only','--project',root);assert.equal(set.status,0,set.stderr);
  assert.equal(runtimesSource(loadConfig({projectRoot:root})),'project');
  assert.match(run('show','--project',root).stdout,/preset: codex-only/);
  assert.equal(run('unset','--user').status,0);assert.equal(run('unset','--user').status,0);
  assert(!fs.existsSync(path.join(env.CM_WORKFLOW_HOME,'runtimes.yml')));
  assert.equal(runtimesSource(loadConfig({projectRoot:root})),'project');
  const logs=fs.readdirSync(path.join(root,'logs','runs'),{recursive:true}).filter(file=>file.endsWith('.jsonl'));
  const events=logs.flatMap(file=>fs.readFileSync(path.join(root,'logs','runs',file),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(events.length,5);assert(events.every(event=>event.event==='decision'&&event.phase==='route'&&event.project_path===root));
  assert(events.every(event=>Object.keys(event).sort().join(',')===['schema_version','run_id','at','workflow','event','runtime','project','detail','phase','project_path','preset','source','event_id'].sort().join(',')));
  assert(!fs.existsSync(path.join(root,'.cm-run.json')));
}));

test('lossless edits retain comments, BOM, CRLF, quoted keys, models and unrelated raw bytes',()=>fixture(root=>{
  const text='\ufeff# header\r\nversion: 1\r\n"runtimes": {available: codex} # declaration\r\nroles:\r\n  coder: {adapter: codex-cli, model: "special", source: subscription} # coder\r\n  reviewer:\r\n    adapter: codex-cli   # review\r\n    source: subscription\r\n    model: default\r\npolicies: {tests: [commands], auto_fix: never} # tail';
  const file=path.join(root,'.cm-workflow.yml');fs.writeFileSync(file,text);
  setProjectRuntime(root,'claude-codes');
  const expected=text.replace('available: codex','available: both').replace('coder: {adapter: codex-cli','coder: {adapter: claude-cli');
  assert.equal(fs.readFileSync(file,'utf8'),expected);
  assert.equal(loadConfig({projectRoot:root}).roles.coder.model,'special');
  const again=fs.readFileSync(file);setProjectRuntime(root,'claude-codes');assert.deepEqual(fs.readFileSync(file),again);
}));

test('insertion preserves all original bytes for missing nested fields and supported JSON/YAML mappings',()=>fixture(root=>{
  for(const [file,text] of [
    ['x.yml','version: 1'],
    ['x.yml','version: 1\nroles:\n  coder:\n    model: custom # keep\n# final\n'],
    ['x.yml',"version: 1\nroles: {'coder': {model: 'it''s-safe'}, reviewer: {}}\n".replace("it''s-safe",'safe')],
    ['x.yml','version: 1\nruntimes: {}\nroles: {}\n'],
    ['x.json','{ "version" : 1, "roles": { "coder": {"model":"custom"} } }\n'],
    ['x.yml','version: 1\rroles:\r  coder: {model: custom}\r'],
  ]){
    const changed=editRuntimeDeclaration(text,file,runtimePreset('claude-codes'));
    const config=loadConfig({projectRoot:root,configPath:file,text:changed});
    assert.equal(config.roles.coder.adapter,'claude-cli',changed);assert.equal(config.roles.reviewer.source,'subscription');
    // With no existing target scalars, changes consist solely of inserted bytes.
    let cursor=0;for(const character of text){cursor=changed.indexOf(character,cursor);assert(cursor>=0,`${file}: deleted original bytes`);cursor++;}
  }
}));

test('invalid preset/config/conflicts are rejected before writing; symlinks and directories are preserved',()=>fixture((root,run)=>{
  const file=path.join(root,'.cm-workflow.yml');
  fs.writeFileSync(file,'version: 1\nroles:\n  analyst: {adapter: claude-cli}\n');
  const original=fs.readFileSync(file);
  assert.notEqual(run('set','wrong').status,0);assert.deepEqual(fs.readFileSync(file),original);
  assert.throws(()=>setProjectRuntime(root,'codex-only'),/roles.analyst.adapter/);assert.deepEqual(fs.readFileSync(file),original);
  fs.writeFileSync(file,'version: 1\nunknown: true\n');assert.throws(()=>setProjectRuntime(root,'codex-codes'),/unknown/);
  fs.unlinkSync(file);fs.symlinkSync(path.join(root,'external.yml'),file);
  assert.throws(()=>setProjectRuntime(root,'codex-codes'),/symlink/);assert(!fs.existsSync(path.join(root,'external.yml')));
  fs.unlinkSync(file);fs.mkdirSync(file);assert.throws(()=>setProjectRuntime(root,'codex-codes'),/non-file/);
  const user=process.env.CM_WORKFLOW_HOME;fs.symlinkSync(root,user);
  assert.throws(()=>writeUserRuntime('codex-only'),/symlink/);assert(!fs.existsSync(path.join(root,'runtimes.yml')));
  for(const args of [['show','--user'],['unset'],['set','codex-only','--user','--project',root],['show','extra']])assert.notEqual(run(...args).status,0);
}));

test('installer helper skips redirected input and --yes with no file writes',()=>fixture((root,run,env)=>{
  for(const args of [[],['--yes']]){
    const result=spawnSync(process.execPath,[path.join(scripts,'cm-runtime-install.mjs'),...args],{env,encoding:'utf8',input:'3\n1\n'});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.deepEqual(fs.readdirSync(root),[]);
  }
  writeUserRuntime('claude-only');const file=path.join(env.CM_WORKFLOW_HOME,'runtimes.yml'),before=fs.readFileSync(file);
  const result=spawnSync(process.execPath,[path.join(scripts,'cm-runtime-install.mjs')],{env,encoding:'utf8'});
  assert.equal(result.status,0);assert.deepEqual(fs.readFileSync(file),before);
}));


test('source metadata never changes strict host JSON, role routes or persisted config fields',()=>fixture(root=>{
  for(const preset of ['codex-only','claude-codes']){
    writeUserRuntime(preset);const config=loadConfig({projectRoot:root});
    assert.equal(runtimesSource(config),'user');
    assert.deepEqual(strictJson(config),config);
    const role=resolveRole(config,'coder','codex');assert.deepEqual(strictJson(role),role);
    assert(!Reflect.ownKeys(config).includes('runtimes_source'));
    assert(!Reflect.ownKeys(role).includes('runtimes_source'));
  }
}));


test('candidate over the shared file size limit is rejected before atomic replacement',()=>fixture(root=>{
  const file=path.join(root,'.cm-workflow.yml');
  const original='version: 1\n#'+'x'.repeat(MAX_CONFIG_BYTES-12);
  fs.writeFileSync(file,original);assert.equal(loadConfig({projectRoot:root}).version,1);
  assert.throws(()=>setProjectRuntime(root,'codex-codes'),/exceeds/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
}));

// Pseudo TTY streams still use the production node:readline implementation.
async function wizardFixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-runtime-wizard-')));
  const previous={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
  process.env.CM_WORKFLOW_HOME=path.join(root,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'logs');
  try{await fn(root);}finally{
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(root,{recursive:true,force:true});
  }
}
import {PassThrough} from 'node:stream';
import {main,askRuntimePreset as wizardPreset} from './cm-runtime.mjs';
import {askRuntimePreset as installerPreset,promptRuntime} from './cm-runtime-install.mjs';
import {runtimeLanguage} from './cm-runtime-i18n.mjs';
function tty(){
  const input=new PassThrough(),output=new PassThrough();input.isTTY=output.isTTY=true;
  let text='';output.on('data',chunk=>{text+=chunk;});
  return {input,output,text:()=>text};
}
async function wizard(root,answers,lang='en'){
  const io=tty();const running=main(['--project',root],{...io,lang});
  io.input.end(answers);const code=await running;return {code,text:io.text()};
}
test('wizard and installer share the same preset question function',()=>assert.equal(wizardPreset,installerPreset));
test('language priority, explicit overrides, locales, Intl and English fallback',()=>{
  for(const [env,expected] of [
    [{CM_WORKFLOW_LANG:'en',LC_ALL:'zh_CN.UTF-8'},'en'],
    [{CM_WORKFLOW_LANG:'zh',LC_ALL:'en_US.UTF-8'},'zh'],
    [{LC_ALL:'en_US.UTF-8',LC_MESSAGES:'zh_CN.UTF-8'},'en'],
    [{LC_MESSAGES:'zh_CN.UTF-8',LANG:'en_US.UTF-8'},'zh'],
    [{LANG:'zh_CN.UTF-8'},'zh'],[{LANG:'en_US.UTF-8'},'en'],
    [{LANG:'C'},'en'],[{},'en'],
  ])assert.equal(runtimeLanguage(env,()=>undefined),expected);
  assert.equal(runtimeLanguage({},()=> 'zh-TW'),'zh');
  assert.equal(runtimeLanguage({},()=>{throw new Error('Intl unavailable');}),'en');
});
test('TTY project wizard changes exactly five fields, logs decision and shows result',()=>wizardFixture(async root=>{
  const file=path.join(root,'.cm-workflow.yml');
  const before='\ufeff# keep\r\nversion: 1\r\nruntimes: {available: codex}\r\nroles:\r\n  coder: {adapter: current-ai, source: local, model: default} # keep coder\r\n  reviewer: {adapter: current-ai, source: local, model: default}\r\n';
  const initial=before;
  fs.writeFileSync(file,initial);
  const result=await wizard(root,'1\n3\n1\nY\n');assert.equal(result.code,0,result.text);
  assert.equal(fs.readFileSync(file,'utf8'),initial.replace('available: codex','available: both').replace('adapter: current-ai','adapter: codex-cli').replace('adapter: current-ai','adapter: claude-cli').replaceAll('source: local','source: subscription'));
  assert.match(result.text,/Which AI tools do you have/);assert.match(result.text,/Who writes code/);
  assert.match(result.text,/preset: codex-codes/);assert.match(result.text,/runtimes_source: project/);
  const logs=fs.readdirSync(path.join(root,'logs','runs'),{recursive:true}).filter(x=>x.endsWith('.jsonl'));
  assert.equal(logs.length,1);const event=JSON.parse(fs.readFileSync(path.join(root,'logs','runs',logs[0]),'utf8'));
  assert.equal(event.event,'decision');assert.equal(event.preset,'codex-codes');
}));
test('missing project defaults to user scope and Chinese preset/comment/output',()=>wizardFixture(async root=>{
  const result=await wizard(root,'\n2\nY\n','zh');assert.equal(result.code,0);
  assert(!fs.existsSync(path.join(root,'.cm-workflow.yml')));
  assert.match(fs.readFileSync(path.join(root,'user','runtimes.yml'),'utf8'),/# 用 cm-runtime.*\npreset: claude-only/s);
  assert.match(result.text,/你手上有哪个 AI 工具/);assert.match(result.text,/确认？/);assert.match(result.text,/runtimes_source: user/);
}));
test('three empty mandatory answers, refusal, EOF and SIGINT do not write',()=>wizardFixture(async root=>{
  for(const answers of ['2\n\n\n\n','2\n1\nn\n','2\n']){
    const result=await wizard(root,answers);assert.equal(result.code,0);assert.match(result.text,/Cancelled/);assert.deepEqual(fs.readdirSync(root),[]);
  }
  const io=tty(),running=main(['--project',root],io);process.emit('SIGINT');
  assert.equal(await running,0);assert.match(io.text(),/Cancelled/);assert.deepEqual(fs.readdirSync(root),[]);
}));
test('explicit project creation, existing-project scope default and invalid choice retry',()=>wizardFixture(async root=>{
  const created=await wizard(root,'1\nwrong\n1\ny\n');assert.equal(created.code,0);assert.match(created.text,/Will create project configuration/);
  const changed=await wizard(root,'\n3\n2\n\n');assert.equal(changed.code,0);assert.match(changed.text,/preset: claude-codes/);
  assert.equal(loadConfig({projectRoot:root}).roles.coder.adapter,'claude-cli');
}));
test('non-TTY no command exits 2 with usage and no writes',()=>fixture((root,run)=>{
  const result=run();assert.equal(result.status,2);assert.match(result.stdout,/cm-runtime/);assert.deepEqual(fs.readdirSync(root),[]);
}));
test('installer yes skips even TTY; culture selects shared English or Chinese text',()=>wizardFixture(async root=>{
  for(const culture of ['en-US','zh-CN']){
    const io=tty();await promptRuntime(['--yes','--lang',culture],io.input,io.output);
    assert.equal(io.text(),'');assert.deepEqual(fs.readdirSync(root),[]);
  }
}));
test('human diagnostics translate while structured fields and user file data stay identical',()=>wizardFixture(async root=>{
  writeUserRuntime('codex-codes',{lang:'en'});
  const options={probe:()=>[{runtime:'codex',available:true},{runtime:'claude',available:false}]};
  const en=showRuntime(root,{...options,lang:'en'}),zh=showRuntime(root,{...options,lang:'zh'});
  assert.equal(en.split('\n').slice(0,3).join('\n'),zh.split('\n').slice(0,3).join('\n'));
  assert.match(en,/declared, not dispatched/);assert.match(zh,/已声明未派发/);
  assert.match(en,/presence does not prove quota/);assert.match(zh,/可解析≠配额可用/);
  assert.match(fs.readFileSync(path.join(root,'user','runtimes.yml'),'utf8'),/# Use cm-runtime/);
}));
test('installer culture reaches shared prompts and comments; explicit override wins',()=>wizardFixture(async root=>{
  const keys=['CM_WORKFLOW_LANG','LC_ALL','LC_MESSAGES','LANG'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    for(const key of keys)delete process.env[key];
    for(const [culture,override,expected] of [['zh-CN',undefined,'zh'],['en-US',undefined,'en'],['zh-CN','en','en']]){
      if(override)process.env.CM_WORKFLOW_LANG=override;else delete process.env.CM_WORKFLOW_LANG;
      const io=tty(),running=promptRuntime(['--lang',culture],io.input,io.output);
      io.input.end('3\n2\n');await running;
      assert.match(io.text(),expected==='zh'?/你手上有哪个 AI 工具/:/Which AI tools do you have/);
      const file=path.join(root,'user','runtimes.yml');assert.match(fs.readFileSync(file,'utf8'),expected==='zh'?/# 用 cm-runtime/:/# Use cm-runtime/);
      fs.unlinkSync(file);
    }
  }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}));
