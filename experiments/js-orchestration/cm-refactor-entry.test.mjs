import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectCmRefactorAdmission} from '../../scripts/cm-refactor-entry.mjs';

const sourceEntry=fileURLToPath(new URL('../../scripts/cm-refactor-entry.mjs',import.meta.url));

function write(target,value='x\n') {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
}

function fixture(t,{compat=false}={}) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-refactor-entry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const skillDir=path.join(root,'skills','cm-refactor'),project=path.join(root,'project');
  const specs=path.join(root,'specs'),entry=path.join(root,'scripts','cm-refactor-entry.mjs');
  fs.mkdirSync(path.join(root,'templates'),{recursive:true});fs.mkdirSync(project);fs.mkdirSync(specs);
  write(path.join(root,compat?'templates/cm-VERSION':'VERSION'),'1.0.0\n');
  write(path.join(skillDir,'SKILL.md'),'---\nname: cm-refactor\n---\n');
  write(path.join(root,'templates','refactor','cm-refactor-denies.json'),'{}\n');
  for(const file of ['project-context.md','orchestration.md','workflow-routing.md','review.md',
    'logging.md','project-learning.md'])write(path.join(root,'runtime',file));
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.copyFileSync(sourceEntry,entry);
  write(path.join(project,'package.json'),'{}\n');
  return {root,skillDir,project,specs,entry};
}

test('admits only structure-preserving work to G0 without authorizing side effects',t=>{
  const item=fixture(t),before=fs.readdirSync(item.project);
  const result=inspectCmRefactorAdmission({skillDir:item.skillDir,project:item.project,
    specs:item.specs,targetPresent:true,intent:'structure-only'});
  assert.equal(result.status,'ready');assert.equal(result.next,'g0_feasibility');
  assert.equal(result.behaviorMustRemainUnchanged,true);
  assert.equal(result.humanApprovalRequiredBeforeChange,true);
  assert.deepEqual(result.requiredRoles,['coder','tester','reviewer']);
  assert.equal(result.roleResolution,'pending');assert.equal(result.logging,'pending');
  assert.equal(result.learning,'pending');assert.equal(result.executionAuthorized,false);
  assert.equal(result.writeAuthorized,false);assert.deepEqual(fs.readdirSync(item.project),before);
  assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result.requiredRoles),true);
});

test('supports the existing bare-project archive mode without creating directories',t=>{
  const item=fixture(t),before=fs.readdirSync(item.project);
  const result=inspectCmRefactorAdmission({skillDir:item.skillDir,project:item.project,
    targetPresent:true,intent:'structure-only'});
  assert.equal(result.status,'ready');assert.equal(result.mode,'bare');assert.equal(result.specs,null);
  assert.deepEqual(fs.readdirSync(item.project),before);
  assert.equal(fs.existsSync(path.join(item.project,'docs','refactors')),false);
});

test('blocks a missing target before G0 while keeping all authority false',t=>{
  const item=fixture(t),result=inspectCmRefactorAdmission({skillDir:item.skillDir,
    project:path.join(item.root,'missing-project'),targetPresent:false,intent:'structure-only'});
  assert.equal(result.status,'blocked');assert.equal(result.reason,'target_required');
  assert.equal(result.next,'collect_refactor_target');assert.equal(result.executionAuthorized,false);
  assert.equal(result.writeAuthorized,false);
});

test('routes the three non-refactor intents to their existing exits',t=>{
  const item=fixture(t),cases=[
    ['defect','defect_flow_required','cm-fix'],
    ['behavior-change','behavior_change_flow_required','cm-prd_change'],
    ['gradual-adoption','gradual_adoption_not_refactor','ordinary_change']
  ];
  for(const [intent,reason,next] of cases){
    const result=inspectCmRefactorAdmission({skillDir:item.skillDir,
      project:path.join(item.root,'missing-project'),specs:path.join(item.root,'missing-specs'),
      targetPresent:true,intent});
    assert.equal(result.status,'redirect');assert.equal(result.reason,reason);assert.equal(result.next,next);
    assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
  }
});

test('canonicalizes valid aliases and rejects unexpected, invalid, or missing targets',t=>{
  const item=fixture(t),projectAlias=path.join(item.root,'project-alias');
  const skillAlias=path.join(item.root,'skill-alias');
  fs.symlinkSync(item.project,projectAlias,'dir');fs.symlinkSync(item.skillDir,skillAlias,'dir');
  const result=inspectCmRefactorAdmission({skillDir:skillAlias,project:projectAlias,
    specs:item.specs,targetPresent:true,intent:'structure-only'});
  assert.equal(result.project,item.project);assert.equal(result.skillDir,item.skillDir);
  assert.throws(()=>inspectCmRefactorAdmission({skillDir:item.skillDir,project:item.project,
    targetPresent:true,intent:'structure-only',extra:true}),{code:'invalid_input'});
  assert.throws(()=>inspectCmRefactorAdmission({skillDir:item.skillDir,project:item.project,
    targetPresent:true,intent:'unknown'}),{code:'invalid_input'});
  assert.throws(()=>inspectCmRefactorAdmission({skillDir:item.skillDir,project:item.project,
    specs:path.join(item.root,'missing'),targetPresent:true,intent:'structure-only'}),
    {code:'specs_path_invalid'});
});

test('CLI supports the Claude marker and separates ready, redirect, blocked, and error',t=>{
  const item=fixture(t,{compat:true}),alias=`${item.root}-alias`;
  fs.symlinkSync(item.root,alias,'dir');t.after(()=>fs.rmSync(alias,{force:true}));
  const ready=spawnSync(process.execPath,[path.join(alias,'scripts','cm-refactor-entry.mjs'),
    '--skill-dir',path.join(alias,'skills','cm-refactor'),'--project',item.project,
    '--specs',item.specs,'--intent','structure-only','--target-present'],{encoding:'utf8'});
  assert.equal(ready.status,0);assert.equal(ready.stderr,'');
  const parsed=JSON.parse(ready.stdout);
  assert.equal(parsed.status,'ready');assert.equal(parsed.runtimeLayout,'claude-compat');
  const redirect=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,
    '--project',item.project,'--intent','defect','--target-present'],{encoding:'utf8'});
  assert.equal(redirect.status,2);assert.equal(redirect.stdout,'');
  assert.equal(JSON.parse(redirect.stderr).next,'cm-fix');
  const blocked=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,
    '--project',item.project,'--intent','structure-only'],{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(JSON.parse(blocked.stderr).reason,'target_required');
  const invalid=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,
    '--project',item.project,'--intent'],{encoding:'utf8'});
  assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');
  assert.equal(JSON.parse(invalid.stderr).status,'error');
});

test('requires the complete canonical workflow-owned installation',t=>{
  const missing=fixture(t);fs.unlinkSync(path.join(missing.root,'runtime','workflow-routing.md'));
  assert.throws(()=>inspectCmRefactorAdmission({skillDir:missing.skillDir,project:missing.project,
    targetPresent:true,intent:'structure-only'}),{code:'skill_path_invalid'});
  const linked=fixture(t),outside=`${linked.root}-templates`;
  fs.mkdirSync(outside);t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.rmSync(path.join(linked.root,'templates'),{recursive:true,force:true});
  fs.symlinkSync(outside,path.join(linked.root,'templates'),'dir');
  assert.throws(()=>inspectCmRefactorAdmission({skillDir:linked.skillDir,project:linked.project,
    targetPresent:true,intent:'structure-only'}),{code:'skill_path_invalid'});
});
