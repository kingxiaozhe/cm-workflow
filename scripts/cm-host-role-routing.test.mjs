import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveHostRole} from '../runtime/js/cm-ai/host-role-routing.mjs';

test('current host rereads role config and logs degradation/errors without model invocation',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-host-role-')));
  try{
    const definition={specsDir:path.join(root,'specs'),codeProject:path.join(root,'code'),feature:'1.work'};
    fs.mkdirSync(definition.specsDir);fs.mkdirSync(definition.codeProject);
    const config=path.join(definition.codeProject,'.cm-workflow.json');
    const identity={repositoryId:'roles',runId:'roles-fixture-run',taskId:'T-001',attempt:1};
    const controller=new AbortController();
    const resolve=role=>resolveHostRole({definition,identity,role,signal:controller.signal});
    assert.equal(resolve('coder').model,'default');
    fs.writeFileSync(config,JSON.stringify({version:1,roles:{tester:{adapter:'claude-cli',model:'requested-only',source:'subscription'}}}));
    assert.equal(resolve('tester').model,'requested-only');
    const logfile=path.join(definition.specsDir,'运行日志.jsonl');
    let rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
    assert(rows.some(row=>row.event==='degrade'&&row.outcome==='current_conversation_only'));
    assert(rows.every(row=>!Object.hasOwn(row,'effective_model')&&row.event!=='model_usage'));
    fs.writeFileSync(config,'{invalid-private-value');
    assert.throws(()=>resolve('coder'),{code:'invalid_workflow_config'});
    assert(!fs.readFileSync(logfile,'utf8').includes('invalid-private-value'));
    rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).event,'error');
    const before=fs.readFileSync(logfile);controller.abort();
    assert.throws(()=>resolve('tester'),{code:'cancelled'});
    assert.deepEqual(fs.readFileSync(logfile),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
