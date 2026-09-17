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

// Positive regression for the T4a runtime declaration target reproduction.
for(const filename of [null,'.cm-workflow.yml','.cm-workflow.yaml','.cm-workflow.json'])test(`init generation: runtime target and template preserve ${filename??'new config'}`,async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-runtime-')));
  const target=filename??'.cm-workflow.yml';
  const prior=filename?.endsWith('.json')?'{"version":1,"project":{"type":"custom"}}':'version: 1\nproject:\n  type: custom\n';
  const content=target.endsWith('.json')?'{"version":1,"project":{"type":"custom"},"runtimes":{"available":"codex"}}'
    :'version: 1\nproject:\n  type: custom\nruntimes:\n  available: codex\n';
  try{
    fs.writeFileSync(path.join(project,'README.md'),'# Fixture\n');
    if(filename)fs.writeFileSync(path.join(project,filename),prior);
    const result=await generateCmInitRules({project,skillDir:path.join(repository,'skills/cm-init')},
      {...selection,runtimes:{available:'codex',preset:'codex-only'}},{generate:async request=>{
        assert.equal(request.targets.at(-1),target);
        const template=request.templates.at(-1);
        assert.equal(template.target,target);assert.equal(template.source,'templates/cm-workflow.yml');
        assert.equal(template.content,fs.readFileSync(path.join(repository,template.source),'utf8'));
        assert.equal(template.fallbackRequired,false);
        assert.equal(request.existing.at(-1).content,filename?prior:null);
        assert.deepEqual(request.selection.runtimes,{available:'codex',preset:'codex-only'});
        assert.ok(request.constraints.includes('Config file: fill only runtimes.available and roles.coder/reviewer adapter+source per preset; keep every other existing value; no secrets.'));
        return {status:'generated',documents:documents(request).map(document=>document.path===target?{path:target,content}:document)};
      }});
    assert.equal(result.status,'draft_generated');assert.equal(result.inspection.status,'structurally_checked');
    assert.equal(result.inspection.changes.at(-1).action,filename?'modify':'create');
    assert.equal(fs.existsSync(path.join(project,target)),Boolean(filename));
    if(filename)assert.equal(fs.readFileSync(path.join(project,filename),'utf8'),prior);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});

test('init generation: optional runtime selection validates all presets and rejects incomplete or inconsistent shapes',async()=>{
  const {validateCmInitSelection,cmInitRuleTargets}=await import('../runtime/js/cm-init/draft-generation.mjs');
  const original=['AGENTS.md','.claude/CLAUDE.md','.claude/rules/coding-style.md','.claude/rules/testing.md',
    '.claude/rules/security.md','.claude/rules/frontend.md'];
  assert.deepEqual(cmInitRuleTargets(selection),original);
  for(const [available,preset] of [['codex','codex-only'],['claude','claude-only'],['both','codex-codes'],['both','claude-codes']]){
    assert.deepEqual(cmInitRuleTargets({...selection,runtimes:{available,preset}}),[...original,'.cm-workflow.yml']);
  }
  for(const runtimes of [null,[],{},'codex',{available:'codex'},{preset:'codex-only'},
    {available:'unknown',preset:'codex-only'},{available:'codex',preset:'claude-only'},
    {available:'claude',preset:'codex-only'},{available:'both',preset:'codex-only'},
    {available:'codex',preset:'codex-only',extra:true}]){
    assert.throws(()=>validateCmInitSelection({...selection,runtimes}),/init_generation_selection_invalid/);
  }
  assert.throws(()=>validateCmInitSelection({...selection,extra:true}),/init_generation_selection_invalid/);
});

test('init generation: multiple existing configs reject before host call; omitted runtimes leaves config untouched',async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-runtime-')));
  const input={project,skillDir:path.join(repository,'skills/cm-init')};
  try{
    fs.writeFileSync(path.join(project,'.cm-workflow.yml'),'version: 1\nruntimes:\n  available: codex\n');
    fs.writeFileSync(path.join(project,'.cm-workflow.json'),'{"version":1}');
    await assert.rejects(generateCmInitRules(input,{...selection,runtimes:{available:'codex',preset:'codex-only'}},
      {generate:async()=>assert.fail('ambiguous configs must not reach host')}),/multiple CM workflow configs/);
    const result=await generateCmInitRules(input,selection,{generate:async request=>{
      assert.ok(request.targets.every(file=>!file.startsWith('.cm-workflow.')));
      return {status:'generated',documents:documents(request)};
    }});
    assert.equal(result.inspection.status,'structurally_checked');
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
