// The driver must preview the same frozen task selection as the actual owner.
// No provider, command execution or native sandbox is required by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {validateRunDefinition} from './cm-ai-run.mjs';
import {developPreview,projectDevelopCheckpoint,plannedCheckResults} from './cm-ai-drive.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-selection-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),
    '- [ ] T-001: independent first\n- [ ] T-002: independent second\n- [ ] T-003: dependent third\n\n- T-003 依赖 T-001, T-002\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const value = 1;\n');
  const definition=(taskId,taskSelection)=>validateRunDefinition({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'selection-fixture',runId:`selection-${taskId}-run`,taskId,attempt:1},
    scope:['a.mjs'],requirements:[],...(taskSelection?{taskSelection}:{})});
  const project=definition=>{
    const preview=developPreview({definition});assert.ok(preview,'the actual review baseline must be available');
    return projectDevelopCheckpoint({preview,codeProject,attempt:1,
      value:{status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}},
      projected:new Map([['a.mjs',{path:'a.mjs',contentBase64:Buffer.from('export const value = 42;\n').toString('base64'),mode:0o644}]]),
      checks:plannedCheckResults([{id:'syntax',command:[process.execPath,'--check','a.mjs']}])});
  };
  return {root,codeProject,specsDir,definition,project};
}

test('driver checkpoint projection honors frozen eligible single task selection',t=>{
  const f=fixture(t),selected=f.definition('T-002',{version:1,taskId:'T-002'});
  const originalDefinition=JSON.stringify(selected),projected=f.project(selected);
  assert.ok(projected?.pkg,'eligible selected task must produce its real projected review package');
  assert.equal(projected.pkg.identity.taskId,'T-002');
  assert.ok(projected.learningBytes>0);
  assert.equal(JSON.stringify(selected),originalDefinition,'preview must not rewrite the frozen definition');
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false,'preflight must not open an owner store');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'export const value = 1;\n');
});

test('driver default checkpoint projection still admits the real next task',t=>{
  const f=fixture(t),projected=f.project(f.definition('T-001'));
  assert.equal(projected.pkg.identity.taskId,'T-001');
});

test('driver cannot infer a selection for an eligible task that is not the default',t=>{
  const f=fixture(t);
  assert.throws(()=>f.project(f.definition('T-002')),{code:'learning_context_invalid'});
});

test('driver frozen selection cannot make an ineligible dependent task eligible',t=>{
  const f=fixture(t);
  assert.throws(()=>f.project(f.definition('T-003',{version:1,taskId:'T-003'})),{code:'learning_context_invalid'});
});
