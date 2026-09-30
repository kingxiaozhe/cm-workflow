import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('..',import.meta.url));
test('real isolated Claude install checks correction docs at its installed layout and refuses a missing document',
  {skip:process.platform==='win32',timeout:180000},t=>{
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-claude-install-layout-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const target=path.join(home,'.claude'),env={...process.env,HOME:home,CLAUDE_HOME:target,
    CM_WORKFLOW_HOME:path.join(home,'user'),CM_WORKFLOW_LOG_HOME:path.join(home,'logs')};
  const installed=spawnSync('/bin/bash',[path.join(source,'install.sh'),'--yes'],{cwd:source,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  assert.equal(installed.status,0,installed.stdout+installed.stderr);
  assert.match(installed.stdout,/cm runtime check: PASSED \(claude-compat v/);
  const doc=path.join(target,'cm-workflow/docs/human-correction.md');
  assert.equal(fs.readFileSync(doc,'utf8'),fs.readFileSync(path.join(source,'docs/human-correction.md'),'utf8'));
  assert.equal(fs.existsSync(path.join(target,'docs/human-correction.md')),false);
  fs.unlinkSync(doc);
  const rejected=spawnSync('/bin/bash',[path.join(target,'scripts/cm-check-runtime.sh'),'--project',source],{cwd:source,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/missing cm-workflow\/docs\/human-correction\.md/);
  assert.match(rejected.stderr,/human correction command\/document pair incomplete/);
});
