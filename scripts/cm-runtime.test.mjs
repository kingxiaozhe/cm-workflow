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
