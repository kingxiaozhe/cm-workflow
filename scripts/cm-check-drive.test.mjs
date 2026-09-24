import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t,exit=0){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-drive-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of ['scripts/cm-check-entry.mjs','scripts/cm-check-host.mjs','scripts/cm-check-drive.mjs',
    'scripts/cm-workflow-config.mjs','runtime/js/cm-check/host.mjs','runtime/js/cm-ai/drive-core.mjs',
    'runtime/js/cm-ai/host-tool-bridge.mjs','runtime/js/cm-ai/host-session.mjs','runtime/js/cm-ai/effect-contract.mjs',
    'runtime/js/cm-ai/contracts.mjs','runtime/js/cm-init/draft-inspection.mjs','skills/cm-check/SKILL.md']){
    fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(dir,file));
  }
  fs.writeFileSync(path.join(dir,'VERSION'),'0.0.0\n');fs.writeFileSync(path.join(dir,'README.md'),'# Fixture\n');
  const project=path.join(dir,'project');fs.mkdirSync(project);
  const marker=path.join(dir,'marker');
  fs.writeFileSync(path.join(dir,'scripts/cm-check-runtime.sh'),`#!/bin/sh\nprintf 'real stdout\\n'; printf 'real stderr\\n' >&2; printf x >> '${marker}'; exit ${exit}\n`,{mode:0o755});
  const answers=path.join(dir,'answers');fs.mkdirSync(answers);
  const report={checks:Array.from({length:8},(_,i)=>({id:i+1,status:'passed',evidence:[{path:'skills/cm-check/SKILL.md',line:1}],findings:[]})),
    optional:['statusline','updater','subagents','isolated_review','external_browser'].map(id=>({id,status:'degraded',reason:'Fixture unavailable'}))};
  fs.writeFileSync(path.join(answers,'check-semantic.json'),JSON.stringify(report));
  const checker=path.join(dir,'scripts/cm-check-runtime.sh');
  const plan=(over={})=>({skillDir:path.join(dir,'skills/cm-check'),project,answers,
    checks:[{id:'check_runtime',command:[checker,'--project',project,'--print-effective']}],...over});
  const drive=(value,operation='start')=>{
    const file=path.join(dir,'plan.json');fs.writeFileSync(file,JSON.stringify(value));
    return spawnSync(process.execPath,[path.join(dir,'scripts/cm-check-drive.mjs'),'--plan',file,operation],{encoding:'utf8'});
  };
  return {dir,project,marker,answers,report,plan,drive};
}
test('real host: actual checker once, then semantic assessment; status is read only',t=>{
  const f=fixture(t),run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);
  const value=JSON.parse(run.stdout).result;assert.equal(value.result.overall,'PASSED');
  assert.equal(value.mechanical.output,'real stdout\nreal stderr\n');assert.equal(fs.readFileSync(f.marker,'utf8'),'x');
  const status=f.drive(f.plan({answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).result.stage,'ready');
  assert.equal(fs.readFileSync(f.marker,'utf8'),'x');
});
test('real nonzero checker overrides static passed evidence and stops semantics',t=>{
  const f=fixture(t,7);fs.writeFileSync(path.join(f.answers,'check-runtime.json'),JSON.stringify({exitCode:0}));
  const run=f.drive(f.plan());assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.result.overall,'FAILED');assert.equal(fs.readFileSync(f.marker,'utf8'),'x');
});
test('preflight missing answer, malformed answer, missing runner, and false resume leave no checker execution',t=>{
  const f=fixture(t);fs.rmSync(path.join(f.answers,'check-semantic.json'));
  let run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/check-semantic\.json/);
  fs.writeFileSync(path.join(f.answers,'check-semantic.json'),'{}');
  run=f.drive(f.plan());assert.equal(run.status,2);assert.match(run.stderr,/答案格式错误/);
  run=f.drive(f.plan({checks:undefined}));assert.equal(run.status,2);assert.match(run.stderr,/PLAN\.checks/);
  run=f.drive(f.plan({mode:'resume'}));assert.equal(run.status,2);assert.match(run.stderr,/不能 resume/);
  assert.equal(fs.existsSync(f.marker),false);
});
test('quick mode needs real runner and returns mechanical-only',t=>{
  const f=fixture(t);fs.rmSync(path.join(f.answers,'check-semantic.json'));
  const run=f.drive(f.plan({quick:true}));assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.result.overall,'MECHANICAL_ONLY');
});
