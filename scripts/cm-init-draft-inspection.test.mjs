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
