import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectCmInitDraft} from '../runtime/js/cm-init/draft-inspection.mjs';
const repository=fileURLToPath(new URL('..',import.meta.url));
const draft=()=>[{path:'AGENTS.md',content:'# Project\n'},
  {path:'.claude/CLAUDE.md',content:'# Project\n@rules/testing.md\n'},
  {path:'.claude/rules/testing.md',content:'# Testing\n'}];
test('init draft CLI: proposals reference each other; existing changes remain review-required and unwritten',()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-draft-')));
  try{
    fs.writeFileSync(path.join(project,'AGENTS.md'),'Original user constraint');
    const cli=spawnSync(process.execPath,[path.join(repository,'scripts/cm-init-entry.mjs'),'--inspect-draft',
      '--skill-dir',path.join(repository,'skills/cm-init'),'--project',project],
    {input:JSON.stringify(draft()),encoding:'utf8',timeout:3000});
    assert.equal(cli.status,0,cli.stderr);
    const result=JSON.parse(cli.stdout).draftInspection;
    assert.equal(result.status,'structurally_checked');
    assert.deepEqual(result.existingChangeReviewRequired,['AGENTS.md']);
    assert.equal(result.writeAuthorized,false);assert.ok(result.remainingChecks.includes('commands_and_globs'));
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),'Original user constraint');
    assert.equal(fs.existsSync(path.join(project,'.claude')),false);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
test('init draft: missing imports, line limit, invalid write scope and linked parents cannot pass silently',()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-draft-')));
  try{
    let documents=draft().slice(0,2);
    assert.equal(inspectCmInitDraft({project,documents}).issues[0].code,'rule_reference_missing');
    documents=draft();documents[1].content='line\n'.repeat(151);
    assert.equal(inspectCmInitDraft({project,documents}).issues[0].code,'claude_line_limit');
    documents=draft();documents[2].path='.claude/settings.json';
    assert.throws(()=>inspectCmInitDraft({project,documents}),/init_draft_invalid/);
    fs.symlinkSync(project,path.join(project,'.claude'));
    assert.throws(()=>inspectCmInitDraft({project,documents:draft()}),/init_draft_link/);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});

for(const filename of ['.cm-workflow.yml','.cm-workflow.yaml','.cm-workflow.json'])test(`init draft: validates ${filename} and preserves unrelated effective fields`,()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-config-')));
  const encode=value=>JSON.stringify(value);
  const old={version:1,project:{type:'custom'},roles:{coder:{model:'custom-model'},tester:{adapter:'local'}},policies:{generate_cases:false}};
  const updated={...old,runtimes:{available:'both'},roles:{...old.roles,
    coder:{model:'custom-model',adapter:'codex-cli',source:'subscription'},reviewer:{adapter:'claude-cli',source:'subscription'}}};
  const inspect=content=>inspectCmInitDraft({project,documents:[...draft(),{path:filename,content}]});
  try{
    // Keep YAML fixtures in the parser's supported block-mapping form.
    const serialize=value=>filename.endsWith('.json')?encode(value):yaml(value);
    function yaml(value,indent=''){
      return Object.entries(value).map(([key,item])=>item&&typeof item==='object'&&!Array.isArray(item)
        ?`${indent}${key}:\n${yaml(item,indent+'  ')}`:`${indent}${key}: ${JSON.stringify(item)}\n`).join('');
    }
    assert.equal(inspect(serialize({version:1,runtimes:{available:'codex'}})).status,'structurally_checked');
    assert.equal(inspect(serialize({version:1})).issues[0].code,'runtimes_declaration_missing');
    const invalid=inspect(filename.endsWith('.json')?'{':'version: [');
    assert.equal(invalid.status,'blocked');assert.equal(invalid.issues[0].code,'workflow_config_invalid');
    assert.equal(typeof invalid.issues[0].message,'string');
    fs.writeFileSync(path.join(project,filename),serialize(old));
    let result=inspect(serialize(updated));
    assert.equal(result.status,'structurally_checked');assert.equal(result.changes.at(-1).action,'modify');
    assert.ok(result.existingChangeReviewRequired.includes(filename));assert.equal(result.writeAuthorized,false);
    for(const changed of [
      {...updated,project:{type:'auto'}},
      {...updated,policies:{generate_cases:true}},
      {...updated,roles:{...updated.roles,coder:{...updated.roles.coder,model:'other-model'}}},
      {...updated,roles:{...updated.roles,tester:{adapter:'current-ai'}}},
    ]){
      result=inspect(serialize(changed));assert.equal(result.status,'blocked');
      assert.deepEqual(result.issues.map(issue=>issue.code),['existing_config_fields_changed']);
    }
    fs.writeFileSync(path.join(project,filename),'invalid');
    assert.equal(inspect(serialize(updated)).issues[0].code,'workflow_config_invalid');
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});

test('init draft: config is root-only, links rejected, maximum 13 documents and CLAUDE-only checks stay scoped',()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-config-')));
  try{
    const content='# comment\n'.repeat(151)+'version: 1\nruntimes:\n  available: codex\n';
    const rules=['coding-style','testing','security','git-workflow','frontend','miniprogram','backend-api','database','smart-contract','finance'];
    const documents=[...draft().slice(0,2),...rules.map(name=>({path:`.claude/rules/${name}.md`,content:'# Rule\n'})),
      {path:'.cm-workflow.yml',content}];
    assert.equal(documents.length,13);assert.equal(inspectCmInitDraft({project,documents}).status,'structurally_checked');
    assert.throws(()=>inspectCmInitDraft({project,documents:[...documents,{path:'.cm-workflow.yaml',content}]}),/init_draft_invalid/);
    for(const file of ['sub/.cm-workflow.yml','.claude/.cm-workflow.json','.cm-workflow.toml']){
      assert.throws(()=>inspectCmInitDraft({project,documents:[...draft(),{path:file,content}]}),/init_draft_invalid/);
    }
    fs.writeFileSync(path.join(project,'original.yml'),content);
    fs.symlinkSync(path.join(project,'original.yml'),path.join(project,'.cm-workflow.yml'));
    assert.throws(()=>inspectCmInitDraft({project,documents}),/init_draft_link/);
  }finally{fs.rmSync(project,{recursive:true,force:true});}
});
