// Light runtime modules are copied on their own into partial runtimes (scripts/cm-check-drive.test.mjs
// copies a hand-picked list). The authority here is Node's real module resolver: copy ONLY the allowed
// files into a fresh temp dir and import the module in a child process. Every import syntax is covered
// (import{...}from, export ... from, multi-line, top-level dynamic import), with no scanner to fool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CHECK_DRIVE_COPIED_FILES} from './cm-check-drive-files.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const GUIDANCE='runtime/js/cm-ai/operator-guidance.mjs',LIMITS='runtime/js/cm-ai/review-dispatch-limits.mjs';

// Copy exactly `files` (optionally appending `append` to `entry`) and import `entry` from the copy.
function importFromCopy(t,entry,files,append=''){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-light-module-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of files){
    fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(dir,file));
  }
  if(append)fs.appendFileSync(path.join(dir,entry),append);
  return spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(dir,entry)).href)});`],
    {encoding:'utf8',cwd:dir});
}

test('review-dispatch-limits.mjs imports with only itself copied',t=>{
  const run=importFromCopy(t,LIMITS,[LIMITS]);assert.equal(run.status,0,run.stderr);
});
test('operator-guidance.mjs imports with only itself and review-dispatch-limits.mjs copied',t=>{
  const run=importFromCopy(t,GUIDANCE,[GUIDANCE,LIMITS]);assert.equal(run.status,0,run.stderr);
});
test('operator-guidance.mjs imports from exactly the partial runtime cm-check-drive.test.mjs copies',t=>{
  const run=importFromCopy(t,GUIDANCE,CHECK_DRIVE_COPIED_FILES);assert.equal(run.status,0,run.stderr);
});

// Negative controls: each added import reaches a file the partial copy does not have, so the real
// resolver must fail. They run against the copy, never the repository file.
const REACH=[
  ['compact import{...}from with an alias',"\nimport{readRunnerHistory as probe}from './durable-runner-state.mjs';\n"],
  ['multi-line import',"\nimport {\n  readRunnerHistory,\n  runnerStatus,\n} from './durable-runner-state.mjs';\n"],
  ['import sharing a line with other code',"\nconst unrelated=1;import x from './task-runner.mjs';\n"],
  ['export ... from',"\nexport {readRunnerHistory} from './durable-runner-state.mjs';\n"],
  ['top-level dynamic import',"\nawait import('./durable-runner-state.mjs');\n"],
];
for(const [name,append] of REACH)
  test(`guard fails when operator-guidance.mjs gains a ${name}`,t=>{
    const run=importFromCopy(t,GUIDANCE,CHECK_DRIVE_COPIED_FILES,append);
    assert.notEqual(run.status,0,'the import must not resolve in the partial runtime');
    assert.match(run.stderr,/ERR_MODULE_NOT_FOUND/);
  });
test('guard fails when operator-guidance.mjs gains an import of a file only the wider cm-check copy has',t=>{
  const run=importFromCopy(t,GUIDANCE,[GUIDANCE,LIMITS],"\nimport x from './effect-contract.mjs'\n");
  assert.notEqual(run.status,0);assert.match(run.stderr,/ERR_MODULE_NOT_FOUND/);
});
