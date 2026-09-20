import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {validateHostWorkflowConfiguration} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';

const cli=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));

const qa=timeoutMs=>({commands:[{id:'unit',command:['npm','test'],caseIds:[]}],
  environment:{kind:'web',carrier:'browser',target:'fixture-command-only',scope:'local'},
  ...(timeoutMs===undefined?{}:{timeoutMs})});
const workflow=timeoutMs=>({qa:qa(timeoutMs),documentationPaths:[],applicableAgentFiles:[]});

test('a QA budget beyond one minute is accepted up to the shared call-timeout range', () => {
  // A real browser walkthrough of one blocking case runs for minutes; the old
  // 60000 cap made every such case time out with no way to raise it.
  for(const timeoutMs of [1,60000,900000,3600000]){
    assert.equal(validateHostWorkflowConfiguration(workflow(timeoutMs)).qa.timeoutMs,timeoutMs);
  }
});

test('a QA budget outside that range is still rejected', () => {
  for(const timeoutMs of [0,-1,3600001,1.5,'900000',null]){
    assert.throws(()=>validateHostWorkflowConfiguration(workflow(timeoutMs)),
      error=>error.code==='invalid_workflow_config',`expected rejection for ${String(timeoutMs)}`);
  }
});

test('omitting the budget stays valid and plants no key', () => {
  const config=validateHostWorkflowConfiguration(workflow(undefined));
  assert.equal(Object.hasOwn(config.qa,'timeoutMs'),false);
});

function batchFixture(fn){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-recovery-')));
  const specs=path.join(temp,'specs'),code=path.join(temp,'code');
  fs.mkdirSync(path.join(specs,'.reviews'),{recursive:true});fs.mkdirSync(code,{recursive:true});
  const config=path.join(temp,'batch.json');
  fs.writeFileSync(config,JSON.stringify({batch:{version:1,repositoryId:'fixture',batchId:'recovery-fixture',
    specsDir:specs,codeProject:code,tasks:[{feature:'9.demo',taskId:'T-001',scope:['a.mjs'],requirements:[]}]},
    workflows:{'9.demo/T-001':workflow(900000)}}));
  const run=args=>spawnSync(process.execPath,[cli,'serve','--config',config,'--host-context','author',
    '--allow-development',...args],{encoding:'utf8',timeout:15000,input:''});
  try{fn(run);}finally{fs.rmSync(temp,{recursive:true,force:true});}
}

test('the two QA recovery flags are mutually exclusive', () => batchFixture(run => {
  const result=run(['--allow-qa','--rerun-unknown-qa','--rerun-blocked-qa']);
  assert.equal(result.status,1);
  assert.match(result.stderr,/qa_recovery_authorization_required/);
}));

test('a QA recovery flag without --allow-qa is refused', () => batchFixture(run => {
  const result=run(['--rerun-blocked-qa']);
  assert.equal(result.status,1);
  assert.match(result.stderr,/qa_recovery_authorization_required/);
}));

test('the same flag twice is refused', () => batchFixture(run => {
  const result=run(['--allow-qa','--rerun-blocked-qa','--rerun-blocked-qa']);
  assert.equal(result.status,1);
  assert.match(result.stderr,/invalid_arguments/);
}));

test('a single recovery flag with --allow-qa passes the launch guards', () => batchFixture(run => {
  // The batch has no --mode: whether the flag applies is decided per task at
  // open time, so the launch guards must not reject it the way the single-task
  // host does. The fixture batch is otherwise minimal and still fails later for
  // unrelated reasons, so this asserts only that the recovery guard stayed quiet.
  const line=result=>result.stderr.split('\n').find(item=>item.startsWith('{'))??'';
  const withFlag=run(['--allow-qa','--rerun-blocked-qa']);
  const without=run(['--allow-qa']);
  assert.equal(/qa_recovery_authorization_required/.test(withFlag.stderr),false,withFlag.stderr);
  assert.equal(line(withFlag),line(without));
  assert.equal(withFlag.status,without.status);
}));
