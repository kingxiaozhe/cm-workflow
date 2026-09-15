import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateCmInitRules} from './cm-init-entry.mjs';

const repository=fileURLToPath(new URL('..',import.meta.url));
const selection={versionControl:'none',modules:['frontend'],analysis:'Synthetic web project; commands remain unverified.'};
function documents(request){return request.targets.map(file=>({path:file,content:file==='AGENTS.md'
  ?'# Fixture\nKeep original restriction.\n':file==='.claude/CLAUDE.md'
    ?'# Fixture\n@rules/testing.md\n':`# ${file}\nFixture rule.\n`}));}
test('init generation: real repository templates feed host draft and existing inspection without writes',async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-generate-')));
  try{
    fs.writeFileSync(path.join(project,'AGENTS.md'),'Keep original restriction.');
    let calls=0;
    const result=await generateCmInitRules({project,skillDir:path.join(repository,'skills/cm-init')},selection,
      {generate:async request=>{
        calls++;assert.equal(request.existing[0].content,'Keep original restriction.');
        assert.equal(request.templates.length,4);
        assert.ok(request.templates.every(template=>template.content.includes('模板骨架')));
        assert.equal(request.targets.includes('.claude/rules/git-workflow.md'),false);
        assert.equal(request.writeAuthorized,false);
        return {status:'generated',documents:documents(request)};
      }});
    assert.equal(calls,1);assert.equal(result.status,'draft_generated');
    assert.equal(result.inspection.status,'structurally_checked');
    assert.deepEqual(result.inspection.existingChangeReviewRequired,['AGENTS.md']);
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),'Keep original restriction.');
    assert.equal(fs.existsSync(path.join(project,'.claude')),false);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
test('init generation: host block, invalid target and existing-constraint drift stop without retry',async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-generate-')));
  const input={project,skillDir:path.join(repository,'skills/cm-init')};
  try{
    fs.writeFileSync(path.join(project,'AGENTS.md'),'Keep original restriction.');
    let calls=0;
    const blocked=await generateCmInitRules(input,selection,{generate:async()=>{calls++;return {status:'blocked'};}});
    assert.equal(blocked.status,'blocked');assert.equal(calls,1);
    await assert.rejects(generateCmInitRules(input,selection,{generate:async request=>{
      const output=documents(request);output[0].path='.claude/settings.json';return {status:'generated',documents:output};
    }}),/init_generation_targets_invalid/);
    await assert.rejects(generateCmInitRules(input,selection,{generate:async request=>{
      fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent human edit');
      return {status:'generated',documents:documents(request)};
    }}),/init_generation_project_changed/);
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),'Concurrent human edit');
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
