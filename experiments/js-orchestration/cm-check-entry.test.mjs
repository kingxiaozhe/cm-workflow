import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createCmCheckInvocation} from '../../scripts/cm-check-entry.mjs';

const entry=fileURLToPath(new URL('../../scripts/cm-check-entry.mjs',import.meta.url));

function fixture(body='printf "project=%s\\n" "$2"\nprintf "config=%s\\n" "$4"\nprintf "flag=%s\\n" "$5"') {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-check-entry-'));
  const skillDir=path.join(root,'skills','cm-check');
  const scripts=path.join(root,'scripts');
  const project=path.join(root,'project');
  fs.mkdirSync(skillDir,{recursive:true});
  fs.mkdirSync(scripts);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: cm-check\n---\n');
  const checker=path.join(scripts,'cm-check-runtime.sh');
  fs.writeFileSync(checker,`#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  fs.chmodSync(checker,0o755);
  const installedEntry=path.join(scripts,'cm-check-entry.mjs');
  fs.copyFileSync(entry,installedEntry);
  const config=path.join(project,'cm-workflow.yml');
  fs.writeFileSync(config,'version: 1\n');
  return {root,skillDir,project,config,checker,entry:installedEntry};
}

test('builds the fixed existing-checker invocation from the active skill path',()=>{
  const item=fixture();
  const invocation=createCmCheckInvocation({skillDir:item.skillDir,project:item.project,config:item.config});
  assert.equal(invocation.checker,item.checker);
  assert.deepEqual(invocation.args,['--project',item.project,'--config',item.config,'--print-effective']);
  assert.equal(Object.isFrozen(invocation),true);
  assert.equal(Object.isFrozen(invocation.args),true);
});

test('installed-layout CLI runs once and preserves checker output and exit status',()=>{
  const item=fixture('printf "visible output\\n"\nprintf "original failure\\n" >&2\nexit 7');
  const result=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--print-effective'],{encoding:'utf8'});
  assert.equal(result.status,7);
  assert.equal(result.stdout,'visible output\n');
  assert.equal(result.stderr,'original failure\n');
});

test('canonicalizes valid path aliases and rejects unexpected input before the checker runs',()=>{
  const item=fixture();
  const linkedProject=path.join(item.root,'linked-project');
  fs.symlinkSync(item.project,linkedProject,'dir');
  assert.equal(createCmCheckInvocation({skillDir:item.skillDir,project:linkedProject}).project,item.project);
  assert.throws(()=>createCmCheckInvocation({skillDir:item.skillDir,project:item.project,extra:true}),
    {code:'invalid_input'});
  const linkedConfig=path.join(item.project,'linked.yml');
  fs.symlinkSync(item.config,linkedConfig);
  assert.equal(createCmCheckInvocation({skillDir:item.skillDir,project:item.project,config:linkedConfig}).config,
    item.config);
});

test('rejects a checker symlink that escapes the installed workflow root',()=>{
  const item=fixture();
  const external=path.join(fs.realpathSync(os.tmpdir()),`outside-checker-${process.pid}-${Date.now()}.sh`);
  fs.writeFileSync(external,'#!/usr/bin/env bash\necho escaped\n');
  fs.chmodSync(external,0o755);
  fs.unlinkSync(item.checker);
  fs.symlinkSync(external,item.checker);
  assert.throws(()=>createCmCheckInvocation({skillDir:item.skillDir,project:item.project}),
    {code:'checker_path_invalid'});
  fs.unlinkSync(external);
});

test('does not add an output cap before forwarding a checker exit status',()=>{
  const item=fixture("python3 -c 'import sys; sys.stdout.write(\"x\" * (5 * 1024 * 1024))'\nexit 7");
  const result=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--print-effective'],{encoding:'utf8',maxBuffer:6*1024*1024});
  assert.equal(result.status,7);
  assert.equal(result.stdout.length,5*1024*1024);
  assert.equal(result.stderr,'');
});

test('CLI requires the fixed print-effective route and forwards checker output',()=>{
  const item=fixture('printf "cm runtime check: PASSED (fixture v1)\\n"');
  const missing=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project],{encoding:'utf8'});
  assert.equal(missing.status,2);
  assert.match(missing.stderr,/invalid_arguments/);
  const result=spawnSync(process.execPath,[item.entry,'--skill-dir',item.skillDir,'--project',item.project,
    '--config',item.config,'--print-effective'],{encoding:'utf8'});
  assert.equal(result.status,0);
  assert.equal(result.stdout,'cm runtime check: PASSED (fixture v1)\n');
  assert.equal(result.stderr,'');
});
