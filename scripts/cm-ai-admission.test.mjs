import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const entry=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-product-admission-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),'- [ ] T-001: implement login\n');
  try{return run({root,specs,code});}finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('product admission selects one approved task across every code project',()=>fixture(({root,specs,code})=>{
  const backend=path.join(root,'backend');fs.mkdirSync(backend);fs.writeFileSync(path.join(backend,'README.md'),'existing\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--code-project',backend],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const admission=JSON.parse(result.stdout);
  assert.deepEqual(admission.nextTask,{feature:'1.login',id:'T-001',description:'implement login'});
  assert.deepEqual(admission.codeProjects,[code,backend]);
  assert.deepEqual(admission.projectAdmissions.map(item=>item.state),['ready','ready']);
}));

test('product admission reports generic continuation without approving or writing specs',()=>fixture(({root,specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const before=fs.readFileSync(path.join(specs,'.cm-specs-status'));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approval-response','继续'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).reason,'spec_approval_required');
  assert.deepEqual(fs.readFileSync(path.join(specs,'.cm-specs-status')),before);
  assert.equal(fs.readdirSync(root).length,2);
}));
