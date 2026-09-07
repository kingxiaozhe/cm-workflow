import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {inspectCmIdeaAdmission} from '../../scripts/cm-idea-entry.mjs';
import {inspectCmPrdAdmission} from '../../scripts/cm-prd-entry.mjs';

const sourceIdea=fileURLToPath(new URL('../../scripts/cm-idea-entry.mjs',import.meta.url));
const sourcePrd=fileURLToPath(new URL('../../scripts/cm-prd-entry.mjs',import.meta.url));

function write(target,value='x\n') {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
}

function fixture(t,{compat=false}={}) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-planning-entry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ideaSkill=path.join(root,'skills','cm-idea'),prdSkill=path.join(root,'skills','cm-prd');
  const project=path.join(root,'project'),specs=path.join(root,'specs');
  fs.mkdirSync(path.join(root,'templates'),{recursive:true});fs.mkdirSync(project);fs.mkdirSync(specs);
  write(path.join(root,compat?'templates/cm-VERSION':'VERSION'),'1.0.0\n');
  write(path.join(ideaSkill,'SKILL.md'),'---\nname: cm-idea\n---\n');
  write(path.join(ideaSkill,'references','idea-to-prd.md'));
  write(path.join(prdSkill,'SKILL.md'),'---\nname: cm-prd\n---\n');
  write(path.join(prdSkill,'references','change-mode.md'));
  for(const file of ['project-context.md','review.md','logging.md'])write(path.join(root,'runtime',file));
  const ideaEntry=path.join(root,'scripts','cm-idea-entry.mjs');
  const prdEntry=path.join(root,'scripts','cm-prd-entry.mjs');
  fs.mkdirSync(path.dirname(ideaEntry),{recursive:true});
  fs.copyFileSync(sourceIdea,ideaEntry);fs.copyFileSync(sourcePrd,prdEntry);
  write(path.join(project,'package.json'),'{}\n');
  write(path.join(specs,'docs','requirements.md'),'# Requirement\n');
  return {root,ideaSkill,prdSkill,project,specs,ideaEntry,prdEntry};
}

function feature(specs,name,{complete=true}={}) {
  const root=path.join(specs,name);fs.mkdirSync(root,{recursive:true});
  for(const file of complete?['requirements.md','design.md','tasks.md']:['requirements.md','design.md'])
    write(path.join(root,file));
  return root;
}

test('cm-idea admits only the existing interview handoff without authorizing writes',t=>{
  const item=fixture(t),result=inspectCmIdeaAdmission({skillDir:item.ideaSkill});
  assert.equal(result.status,'ready');assert.equal(result.operation,'interview');
  assert.equal(result.next,'load_interview');assert.equal(result.handoff,'cm-prd');
  assert.equal(result.saveRequiresConfirmation,true);
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
  assert.equal(Object.isFrozen(result),true);
  const cli=spawnSync(process.execPath,[item.ideaEntry,'--skill-dir',item.ideaSkill],{encoding:'utf8'});
  assert.equal(cli.status,0);assert.equal(cli.stderr,'');assert.equal(JSON.parse(cli.stdout).status,'ready');
});

test('cm-idea rejects incomplete or linked workflow-owned resources',t=>{
  const missing=fixture(t);fs.unlinkSync(path.join(missing.ideaSkill,'references','idea-to-prd.md'));
  assert.throws(()=>inspectCmIdeaAdmission({skillDir:missing.ideaSkill}),{code:'skill_path_invalid'});
  const linked=fixture(t),outside=`${linked.root}-templates`;
  fs.mkdirSync(outside);t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.rmSync(path.join(linked.root,'templates'),{recursive:true,force:true});
  fs.symlinkSync(outside,path.join(linked.root,'templates'),'dir');
  assert.throws(()=>inspectCmIdeaAdmission({skillDir:linked.ideaSkill}),{code:'skill_path_invalid'});
});

test('cm-prd admits new requirements without reading content or authorizing generation',t=>{
  const item=fixture(t),result=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs
  });
  assert.equal(result.status,'ready');assert.equal(result.mode,'new');
  assert.equal(result.next,'requirements_analysis');assert.equal(result.requirementsSourceCount,1);
  assert.deepEqual(result.requiredRoles,['analyst','planner']);
  assert.equal(result.roleResolution,'pending');assert.equal(result.logging,'pending');
  assert.equal(result.executionAuthorized,false);assert.equal(result.writeAuthorized,false);
});

test('cm-prd blocks a missing, empty or metadata-only docs source before side effects',t=>{
  const missing=fixture(t);fs.rmSync(path.join(missing.specs,'docs'),{recursive:true,force:true});
  const absent=inspectCmPrdAdmission({skillDir:missing.prdSkill,project:missing.project,specs:missing.specs});
  assert.equal(absent.status,'blocked');assert.equal(absent.reason,'requirements_source_missing');
  assert.equal(absent.next,'add_requirements_docs');
  const empty=fixture(t);fs.rmSync(path.join(empty.specs,'docs','requirements.md'));
  const noFiles=inspectCmPrdAdmission({skillDir:empty.prdSkill,project:empty.project,specs:empty.specs});
  assert.equal(noFiles.status,'blocked');assert.equal(noFiles.requirementsSourceCount,0);
  write(path.join(empty.specs,'docs','.DS_Store'));write(path.join(empty.specs,'docs','.gitkeep'));
  const metadataOnly=inspectCmPrdAdmission({
    skillDir:empty.prdSkill,project:empty.project,specs:empty.specs
  });
  assert.equal(metadataOnly.status,'blocked');assert.equal(metadataOnly.requirementsSourceCount,0);
});

test('cm-prd change mode resolves an exact feature or a unique numeric selector',t=>{
  const item=fixture(t);feature(item.specs,'1.login');
  const exact=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs,change:'1.login'
  });
  assert.equal(exact.status,'ready');assert.equal(exact.mode,'change');
  assert.equal(exact.feature,'1.login');assert.equal(exact.next,'change_analysis');
  const numeric=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs,change:'1'
  });
  assert.equal(numeric.status,'ready');assert.equal(numeric.feature,'1.login');
});

test('cm-prd reports ambiguous, missing and incomplete change targets without writes',t=>{
  const item=fixture(t);feature(item.specs,'1.login');feature(item.specs,'1.logout');
  const ambiguous=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs,change:'1'
  });
  assert.equal(ambiguous.status,'selection_required');assert.equal(ambiguous.reason,'feature_required');
  assert.deepEqual(ambiguous.features,['1.login','1.logout']);
  const missing=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs,change:'2'
  });
  assert.equal(missing.status,'blocked');assert.equal(missing.reason,'feature_missing');
  feature(item.specs,'3.partial',{complete:false});
  const incomplete=inspectCmPrdAdmission({
    skillDir:item.prdSkill,project:item.project,specs:item.specs,change:'3.partial'
  });
  assert.equal(incomplete.status,'blocked');assert.equal(incomplete.reason,'feature_contract_missing');
  assert.equal(incomplete.writeAuthorized,false);
});

test('cm-prd CLI canonicalizes aliases, supports cases and separates blocks from errors',t=>{
  const item=fixture(t,{compat:true}),alias=`${item.root}-alias`,cases=path.join(item.root,'cases.md');
  fs.symlinkSync(item.root,alias,'dir');t.after(()=>fs.rmSync(alias,{force:true}));write(cases);
  const ready=spawnSync(process.execPath,[path.join(alias,'scripts','cm-prd-entry.mjs'),
    '--skill-dir',path.join(alias,'skills','cm-prd'),'--project',item.project,
    '--specs',item.specs,'--cases',cases],{encoding:'utf8'});
  assert.equal(ready.status,0);assert.equal(ready.stderr,'');
  const parsed=JSON.parse(ready.stdout);
  assert.equal(parsed.runtimeLayout,'claude-compat');assert.equal(parsed.cases,cases);
  fs.rmSync(path.join(item.specs,'docs'),{recursive:true,force:true});
  const blocked=spawnSync(process.execPath,[item.prdEntry,'--skill-dir',item.prdSkill,
    '--project',item.project,'--specs',item.specs],{encoding:'utf8'});
  assert.equal(blocked.status,2);assert.equal(blocked.stdout,'');
  assert.equal(JSON.parse(blocked.stderr).status,'blocked');
  const invalid=spawnSync(process.execPath,[item.prdEntry,'--skill-dir',item.prdSkill],{encoding:'utf8'});
  assert.equal(invalid.status,2);assert.equal(invalid.stdout,'');
  assert.equal(JSON.parse(invalid.stderr).status,'error');
  assert.equal(JSON.parse(invalid.stderr).reason,'invalid_input');
});
