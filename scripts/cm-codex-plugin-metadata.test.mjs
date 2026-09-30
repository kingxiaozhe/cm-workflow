import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./cm-codex-plugin-metadata.py',import.meta.url));
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-plugin-metadata-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const run=(operation,file)=>spawnSync(process.env.CM_PYTHON_BIN||'python3',[script,operation,file],{encoding:'utf8'});
  return {root,run};
}
test('metadata fallback reads marketplace identity without rewriting other plugins or user bytes',t=>{
  const {root,run}=fixture(t),file=path.join(root,'marketplace.json');
  const bytes='{"name":"local-personal","plugins":[{"name":"unrelated"}]}\n';fs.writeFileSync(file,bytes);
  const result=run('marketplace-name',file);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'local-personal\n');assert.equal(fs.readFileSync(file,'utf8'),bytes);
  for(const value of ['[]','{"name":"bad@name"}','{"name":"good","name":"other"}']){
    fs.writeFileSync(file,value);assert.equal(run('marketplace-name',file).status,1);
    assert.equal(fs.readFileSync(file,'utf8'),value);
  }
});
test('cache version fallback keeps manifest contents and source base while yielding distinct build identities',t=>{
  const {root,run}=fixture(t);fs.mkdirSync(path.join(root,'.codex-plugin'));
  const file=path.join(root,'.codex-plugin/plugin.json'),before={name:'cm-workflow',version:'0.16.5',skills:'./skills',interface:{displayName:'CM'}};
  fs.writeFileSync(file,JSON.stringify(before));fs.writeFileSync(path.join(root,'VERSION'),'0.16.5\n');
  const first=run('cache-version',root);assert.equal(first.status,0,first.stderr);
  const after=JSON.parse(fs.readFileSync(file));assert.match(after.version,/^0\.16\.5\+codex\.\d{20}\.[a-f0-9]{12}$/);
  assert.deepEqual({...after,version:before.version},before);assert.equal(fs.readFileSync(path.join(root,'VERSION'),'utf8'),'0.16.5\n');
  const second=run('cache-version',root);assert.equal(second.status,0,second.stderr);assert.notEqual(first.stdout,second.stdout);
});
test('metadata fallback rejects unsafe manifests and stages before writing',t=>{
  const {root,run}=fixture(t);fs.mkdirSync(path.join(root,'.codex-plugin'));fs.writeFileSync(path.join(root,'VERSION'),'0.16.5');
  const file=path.join(root,'.codex-plugin/plugin.json');
  for(const data of [{name:'other',version:'0.16.5'},{name:'cm-workflow',version:'0.16.4'}]){
    const bytes=JSON.stringify(data);fs.writeFileSync(file,bytes);assert.equal(run('cache-version',root).status,1);assert.equal(fs.readFileSync(file,'utf8'),bytes);
  }
  const external=path.join(root,'external');fs.writeFileSync(external,'{"name":"cm-workflow","version":"0.16.5"}');
  fs.unlinkSync(file);fs.symlinkSync(external,file);assert.equal(run('cache-version',root).status,1);assert.equal(fs.readFileSync(external,'utf8'),'{"name":"cm-workflow","version":"0.16.5"}');
});

// Uses the same placeholder emitted by the current official creator; installed
// user names and sibling plugins must not be normalized during an upgrade.
test('fresh official marketplace placeholder gets a valid personal name while existing identity is preserved',t=>{
  const {root,run}=fixture(t),file=path.join(root,'marketplace.json');
  const seed={name:'[TODO: marketplace-name]',interface:{displayName:'[TODO: display-name]'},plugins:[{name:'cm-workflow',source:{source:'local',path:'./plugins/cm-workflow'}}]};
  fs.writeFileSync(file,JSON.stringify(seed));assert.equal(run('initialize-marketplace',file).status,0);
  assert.equal(run('marketplace-name',file).stdout,'personal\n');
  const initialized=JSON.parse(fs.readFileSync(file));assert.deepEqual(initialized.plugins,seed.plugins);
  const existing=JSON.stringify({name:'existing-personal',plugins:[...seed.plugins,{name:'other'}]});
  fs.writeFileSync(file,existing);assert.equal(run('initialize-marketplace',file).status,0);assert.equal(fs.readFileSync(file,'utf8'),existing);
  seed.plugins.push({name:'other'});const invalid=JSON.stringify(seed);fs.writeFileSync(file,invalid);
  assert.equal(run('initialize-marketplace',file).status,1);assert.equal(fs.readFileSync(file,'utf8'),invalid);
});
