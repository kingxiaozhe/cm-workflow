import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectCmTestAdmission} from '../../scripts/cm-test-entry.mjs';

const sourceEntry=fileURLToPath(new URL('../../scripts/cm-test-entry.mjs',import.meta.url));

function write(target,value='x\n') {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
}

function feature(specs,name,missing=null) {
  for(const file of ['requirements.md','design.md','tasks.md'])if(file!==missing)write(path.join(specs,name,file));
}

function fixture({compat=false}={}) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-test-entry-'));
  const skillDir=path.join(root,'skills','cm-test'),project=path.join(root,'project');
  fs.mkdirSync(skillDir,{recursive:true});fs.mkdirSync(project);fs.mkdirSync(path.join(root,'templates'));
  write(path.join(root,compat?'templates/cm-VERSION':'VERSION'),'1.0.0\n');
  write(path.join(skillDir,'SKILL.md'),'---\nname: cm-test\n---\n');
  write(path.join(root,'runtime','test-contract.md'));
  const entry=path.join(root,'scripts','cm-test-entry.mjs');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.copyFileSync(sourceEntry,entry);
  return {root,skillDir,project,entry};
}

test('defaults an inferred execution request to all read-only modes',()=>{
  const item=fixture();
  const result=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,description:'login'});
  assert.equal(result.status,'ready');assert.equal(result.operation,'execute');
  assert.deepEqual(result.modes,['logic','commands','browser']);
  assert.deepEqual(result.requiredRoles,['tester','browser_qa']);
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
  assert.equal(Object.isFrozen(result),true);
});

test('generation mode records a hard stop and rejects execution conflicts',()=>{
  const item=fixture();
  const result=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,
    description:'login',generateCases:true});
  assert.equal(result.operation,'generate_cases');assert.equal(result.hardStopAfterGeneration,true);
  assert.deepEqual(result.modes,[]);
  for(const conflict of [{cases:'/missing/cases.json'},{logic:true},{commands:true},{browser:true},{all:true},
    {explore:'login page'}])assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,
      project:item.project,description:'login',generateCases:true,...conflict}),{code:'generate_cases_conflict'});
  assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,
    generateCases:true}),{code:'generation_target_required'});
});

test('selects one valid specs feature and pauses when several need a user choice',()=>{
  const item=fixture(),specs=path.join(item.root,'specs');fs.mkdirSync(specs);
  feature(specs,'1.login');
  const one=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,specs,generateCases:true});
  assert.equal(one.feature,'1.login');assert.equal(one.status,'ready');
  feature(specs,'2.logout');
  feature(specs,'3.wip','design.md');
  const several=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,specs,all:true});
  assert.equal(several.status,'selection_required');assert.deepEqual(several.features,['1.login','2.logout']);
  assert.equal(several.executionAuthorized,false);assert.equal(several.writeAuthorized,false);
  const selected=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,specs,
    feature:'1.login',all:true});
  assert.equal(selected.status,'ready');assert.equal(selected.feature,'1.login');
});

test('requires the direct project specs root and a complete feature triplet',()=>{
  const item=fixture(),nested=path.join(item.project,'src','specs');fs.mkdirSync(nested,{recursive:true});
  feature(nested,'1.login');
  assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,specs:nested,all:true}),
    {code:'specs_location_invalid'});
  const specs=path.join(item.project,'specs');fs.mkdirSync(specs);feature(specs,'1.login','design.md');
  assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,specs,all:true}),
    {code:'feature_contract_missing'});
});

test('canonicalizes a user cases alias but does not authorize a requested report directory',()=>{
  const item=fixture(),cases=path.join(item.root,'cases.json');write(cases,'{}\n');
  const alias=path.join(item.root,'cases-link.json');fs.symlinkSync(cases,alias);
  const reportDir=path.join(item.project,'docs','test-reports','future');
  const result=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,cases:alias,
    commands:true,reportDir});
  assert.equal(result.cases,cases);assert.equal(result.requestedReportDir,reportDir);
  assert.equal(result.reportDirBoundary,'pending');assert.equal(result.writeAuthorized,false);
  assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,
    description:'login',unknown:true}),{code:'invalid_input'});
});

test('keeps exploration separate from cases and execution modes',()=>{
  const item=fixture();
  const result=inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,explore:'login page'});
  assert.equal(result.operation,'explore');assert.deepEqual(result.modes,['browser']);
  assert.deepEqual(result.requiredRoles,['browser_qa']);
  assert.throws(()=>inspectCmTestAdmission({skillDir:item.skillDir,project:item.project,
    explore:'login page',browser:true}),{code:'explore_conflict'});
});

test('installed-layout CLI emits only structured admission and blocks bad arguments',()=>{
  const item=fixture();
  const ready=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--description','login','--commands'],{encoding:'utf8'});
  assert.equal(ready.status,0);assert.equal(ready.stderr,'');
  const parsed=JSON.parse(ready.stdout);assert.equal(parsed.status,'ready');assert.deepEqual(parsed.modes,['commands']);
  const blocked=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--generate-cases','--all'],{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(JSON.parse(blocked.stderr).reason,'generate_cases_conflict');
  const missingValue=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--description','--logic'],{encoding:'utf8'});
  assert.equal(missingValue.status,2);assert.equal(JSON.parse(missingValue.stderr).reason,'invalid_arguments');
});

test('accepts the existing Claude compatibility installation root marker',()=>{
  const item=fixture({compat:true});
  const result=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--description','login','--logic'],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.equal(JSON.parse(result.stdout).runtimeLayout,'claude-compat');
});

test('runs the CLI through a symlinked workflow-root alias',()=>{
  const item=fixture(),alias=`${item.root}-alias`;
  fs.symlinkSync(item.root,alias,'dir');
  const result=spawnSync(process.execPath,[path.join(alias,'scripts','cm-test-entry.mjs'),
    '--skill-dir',path.join(alias,'skills','cm-test'),'--project',item.project,
    '--description','login','--logic'],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  assert.equal(JSON.parse(result.stdout).status,'ready');
});
