import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';

test('adapter exception code getter cannot escape the runner failure boundary',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-runner-error-code-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'code.js'),'old\n');
  fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'error-code',taskId:'T-001',attempt:1};
  let getterReads=0;
  const runner=createTaskRunner({root,identity,scope:['code.js'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:()=>{
      const error=new Error('adapter failure');
      Object.defineProperty(error,'code',{get(){getterReads++;throw new Error('private getter');}});
      throw error;
    }},
    reviewers:[{id:'reviewer',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:()=>{throw new Error('must not review');}}],
    check:()=>[],commit:()=>{throw new Error('must not commit');}});
  const result=await runner.executeEffect({version:1,id:'develop-1',identity,kind:'develop'});
  assert.equal(result.state,'unknown');
  assert.equal(result.code,'execution_error');
  assert.equal(getterReads,0);
});
