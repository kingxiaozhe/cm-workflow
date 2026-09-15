import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectCmInitAdmission} from '../../scripts/cm-init-entry.mjs';

const sourceEntry=fileURLToPath(new URL('../../scripts/cm-init-entry.mjs',import.meta.url));

function write(target,value='x\n') {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
}

function fixture(t,{compat=false,material=true}={}) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-init-entry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const skillDir=path.join(root,'skills','cm-init'),project=path.join(root,'project');
  fs.mkdirSync(skillDir,{recursive:true});fs.mkdirSync(project);fs.mkdirSync(path.join(root,'templates'));
  write(path.join(root,compat?'templates/cm-VERSION':'VERSION'),'1.0.0\n');
  write(path.join(skillDir,'SKILL.md'),'---\nname: cm-init\n---\n');
  write(path.join(root,'runtime','project-context.md'));
  const entry=path.join(root,'scripts','cm-init-entry.mjs');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.copyFileSync(sourceEntry,entry);
  if(material)write(path.join(project,'README.md'),'# Existing project\n');
  return {root,skillDir,project,entry};
}

test('admits an existing project without authorizing analysis or writes',t=>{
  const item=fixture(t);
  const result=inspectCmInitAdmission({skillDir:item.skillDir,project:item.project});
  assert.equal(result.status,'ready');assert.equal(result.reason,null);
  assert.equal(result.next,'analyze_project');assert.equal(result.projectState,'existing');
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
  assert.equal(Object.isFrozen(result),true);
});

test('stops an empty or metadata-only directory at the existing-project boundary',t=>{
  const item=fixture(t,{material:false});
  fs.mkdirSync(path.join(item.project,'.git'));write(path.join(item.project,'.DS_Store'));
  const result=inspectCmInitAdmission({skillDir:item.skillDir,project:item.project});
  assert.equal(result.status,'blocked');assert.equal(result.reason,'existing_project_required');
  assert.equal(result.next,'cm-prd');assert.equal(result.projectState,'empty');
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
});

test('canonicalizes project and active-skill aliases and rejects extra input',t=>{
  const item=fixture(t),projectAlias=path.join(item.root,'project-alias');
  const skillAlias=path.join(item.root,'skill-alias');
  fs.symlinkSync(item.project,projectAlias,'dir');fs.symlinkSync(item.skillDir,skillAlias,'dir');
  const result=inspectCmInitAdmission({skillDir:skillAlias,project:projectAlias});
  assert.equal(result.project,item.project);assert.equal(result.skillDir,item.skillDir);
  assert.throws(()=>inspectCmInitAdmission({skillDir:item.skillDir,project:item.project,extra:true}),
    {code:'invalid_input'});
});

test('CLI distinguishes structured ready, policy-blocked and invocation-error results',t=>{
  const ready=fixture(t);
  const readyResult=spawnSync(process.execPath,[ready.entry,'--skill-dir',ready.skillDir,
    '--project',ready.project],{encoding:'utf8'});
  assert.equal(readyResult.status,0);assert.equal(readyResult.stderr,'');
  assert.equal(JSON.parse(readyResult.stdout).status,'ready');
  const empty=fixture(t,{material:false});
  const blocked=spawnSync(process.execPath,[empty.entry,'--skill-dir',empty.skillDir,
    '--project',empty.project],{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(blocked.stdout,'');
  assert.equal(JSON.parse(blocked.stderr).reason,'existing_project_required');
  const invalidArguments=spawnSync(process.execPath,[ready.entry,'--skill-dir',ready.skillDir],{encoding:'utf8'});
  assert.equal(invalidArguments.status,2);assert.equal(invalidArguments.stdout,'');
  assert.deepEqual(JSON.parse(invalidArguments.stderr),{schemaVersion:1,workflow:'cm-init',status:'error',
    reason:'invalid_arguments',executionAuthorized:false,writeAuthorized:false});
  const invalidProject=spawnSync(process.execPath,[ready.entry,'--skill-dir',ready.skillDir,
    '--project',path.join(ready.root,'missing-project')],{encoding:'utf8'});
  assert.equal(invalidProject.status,2);assert.equal(invalidProject.stdout,'');
  assert.equal(JSON.parse(invalidProject.stderr).status,'error');
  assert.equal(JSON.parse(invalidProject.stderr).reason,'project_path_invalid');
});

test('supports the Claude marker and a symlinked workflow-root CLI alias',t=>{
  const item=fixture(t,{compat:true}),alias=`${item.root}-alias`;
  fs.symlinkSync(item.root,alias,'dir');
  t.after(()=>fs.rmSync(alias,{force:true}));
  const result=spawnSync(process.execPath,[path.join(alias,'scripts','cm-init-entry.mjs'),
    '--skill-dir',path.join(alias,'skills','cm-init'),'--project',item.project],{encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stderr,'');
  const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.status,'ready');assert.equal(parsed.runtimeLayout,'claude-compat');
});

test('requires a complete root and rejects linked workflow-owned assets',t=>{
  const incomplete=fixture(t);fs.rmSync(path.join(incomplete.root,'templates'),{recursive:true,force:true});
  assert.throws(()=>inspectCmInitAdmission({skillDir:incomplete.skillDir,project:incomplete.project}),
    {code:'skill_path_invalid'});
  const linkedTemplates=fixture(t),externalTemplates=`${linkedTemplates.root}-templates`;
  fs.mkdirSync(externalTemplates);t.after(()=>fs.rmSync(externalTemplates,{recursive:true,force:true}));
  fs.rmSync(path.join(linkedTemplates.root,'templates'),{recursive:true,force:true});
  fs.symlinkSync(externalTemplates,path.join(linkedTemplates.root,'templates'),'dir');
  assert.throws(()=>inspectCmInitAdmission({skillDir:linkedTemplates.skillDir,project:linkedTemplates.project}),
    {code:'skill_path_invalid'});
  const item=fixture(t),external=path.join(item.root,'external-context.md');
  write(external);fs.unlinkSync(path.join(item.root,'runtime','project-context.md'));
  fs.symlinkSync(external,path.join(item.root,'runtime','project-context.md'));
  assert.throws(()=>inspectCmInitAdmission({skillDir:item.skillDir,project:item.project}),
    {code:'skill_path_invalid'});
});
