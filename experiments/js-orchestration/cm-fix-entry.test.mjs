import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectCmFixAdmission} from '../../scripts/cm-fix-entry.mjs';

const sourceEntry=fileURLToPath(new URL('../../scripts/cm-fix-entry.mjs',import.meta.url));

function write(target,value='x\n') {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
}

function fixture(t,{compat=false}={}) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-fix-entry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const skillDir=path.join(root,'skills','cm-fix'),project=path.join(root,'project');
  const specs=path.join(root,'specs'),entry=path.join(root,'scripts','cm-fix-entry.mjs');
  fs.mkdirSync(path.join(root,'templates'),{recursive:true});fs.mkdirSync(project);fs.mkdirSync(specs);
  write(path.join(root,compat?'templates/cm-VERSION':'VERSION'),'1.0.0\n');
  write(path.join(skillDir,'SKILL.md'),'---\nname: cm-fix\n---\n');
  write(path.join(skillDir,'references','cross-boundary-debugging.md'));
  for(const file of ['project-context.md','orchestration.md','review.md','logging.md','project-learning.md'])
    write(path.join(root,'runtime',file));
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.copyFileSync(sourceEntry,entry);
  write(path.join(project,'package.json'),'{}\n');
  return {root,skillDir,project,specs,entry};
}

test('admits the reproduce entry without diagnosing or authorizing side effects',t=>{
  const item=fixture(t),before=fs.readdirSync(item.project);
  const result=inspectCmFixAdmission({
    skillDir:item.skillDir,project:item.project,specs:item.specs,defectPresent:true
  });
  assert.equal(result.status,'ready');assert.equal(result.next,'reproduce');
  assert.equal(result.reproductionRequired,true);assert.equal(result.unreproducedNext,'observation');
  assert.equal(result.designIssueNext,'cm-prd_change');assert.equal(result.maxReviewRounds,2);
  assert.deepEqual(result.requiredRoles,['coder','tester','reviewer']);
  assert.equal(result.roleResolution,'pending');assert.equal(result.logging,'pending');
  assert.equal(result.learning,'pending');assert.equal(result.reviewPreflightRequired,true);
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
  assert.deepEqual(fs.readdirSync(item.project),before);assert.equal(Object.isFrozen(result),true);
});

test('supports the existing bare-project archive mode without creating directories',t=>{
  const item=fixture(t),before=fs.readdirSync(item.project);
  const result=inspectCmFixAdmission({
    skillDir:item.skillDir,project:item.project,defectPresent:true
  });
  assert.equal(result.status,'ready');assert.equal(result.mode,'bare');assert.equal(result.specs,null);
  assert.deepEqual(fs.readdirSync(item.project),before);
  assert.equal(fs.existsSync(path.join(item.project,'docs','fixes')),false);
});

test('blocks missing defect text before reproduction while keeping all authority false',t=>{
  const item=fixture(t),result=inspectCmFixAdmission({
    skillDir:item.skillDir,project:item.project,specs:item.specs,defectPresent:false
  });
  assert.equal(result.status,'blocked');assert.equal(result.reason,'defect_required');
  assert.equal(result.next,'collect_defect_description');
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
});

test('canonicalizes valid aliases and rejects unexpected or invalid targets',t=>{
  const item=fixture(t),projectAlias=path.join(item.root,'project-alias');
  const skillAlias=path.join(item.root,'skill-alias');
  fs.symlinkSync(item.project,projectAlias,'dir');fs.symlinkSync(item.skillDir,skillAlias,'dir');
  const result=inspectCmFixAdmission({skillDir:skillAlias,project:projectAlias,
    specs:item.specs,defectPresent:true});
  assert.equal(result.project,item.project);assert.equal(result.skillDir,item.skillDir);
  assert.throws(()=>inspectCmFixAdmission({skillDir:item.skillDir,project:item.project,
    defectPresent:true,extra:true}),{code:'invalid_input'});
  assert.throws(()=>inspectCmFixAdmission({skillDir:item.skillDir,project:item.project,
    specs:path.join(item.root,'missing'),defectPresent:true}),{code:'specs_path_invalid'});
});

test('CLI supports the Claude marker and separates ready, blocked and error results',t=>{
  const item=fixture(t,{compat:true}),alias=`${item.root}-alias`;
  fs.symlinkSync(item.root,alias,'dir');t.after(()=>fs.rmSync(alias,{force:true}));
  const ready=spawnSync(process.execPath,[path.join(alias,'scripts','cm-fix-entry.mjs'),
    '--skill-dir',path.join(alias,'skills','cm-fix'),'--project',item.project,
    '--specs',item.specs,'--defect-present'],{encoding:'utf8'});
  assert.equal(ready.status,0);assert.equal(ready.stderr,'');
  const parsed=JSON.parse(ready.stdout);
  assert.equal(parsed.status,'ready');assert.equal(parsed.runtimeLayout,'claude-compat');
  const blocked=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,
    '--project',item.project],{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(blocked.stdout,'');
  assert.equal(JSON.parse(blocked.stderr).reason,'defect_required');
  const invalid=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir],{encoding:'utf8'});
  assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');
  assert.equal(JSON.parse(invalid.stderr).status,'error');
});

test('requires the complete canonical workflow-owned installation',t=>{
  const missing=fixture(t);fs.unlinkSync(path.join(missing.root,'runtime','review.md'));
  assert.throws(()=>inspectCmFixAdmission({skillDir:missing.skillDir,project:missing.project,
    defectPresent:true}),{code:'skill_path_invalid'});
  const linked=fixture(t),outside=`${linked.root}-templates`;
  fs.mkdirSync(outside);t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.rmSync(path.join(linked.root,'templates'),{recursive:true,force:true});
  fs.symlinkSync(outside,path.join(linked.root,'templates'),'dir');
  assert.throws(()=>inspectCmFixAdmission({skillDir:linked.skillDir,project:linked.project,
    defectPresent:true}),{code:'skill_path_invalid'});
});
