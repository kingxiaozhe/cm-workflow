import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFixReproduction} from '../runtime/js/cm-fix/reproduce.mjs';

const identity={repositoryId:'fix-test',runId:'fix-run',taskId:'T-FIX-demo',attempt:1};
test('actual reproduction requires authorized command plus matching exit and defect signature',async()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-repro-')));
  try{
    for(const [source,expected] of [
      ["process.stderr.write('BUG: value mismatch');process.exit(3)",'reproduced'],
      ["process.stderr.write('other error');process.exit(3)",'not_reproduced'],
      ["process.stderr.write('BUG: value mismatch');process.exit(2)",'not_reproduced'],
      ["process.stderr.write('BUG: value mismatch')",'not_reproduced'],
      ["process.stdout.write('BUG: value ');process.stderr.write('mismatch');process.exit(3)",'not_reproduced'],
    ]){
      const run=createFixReproduction({cwd,command:[process.execPath,'-e',source],
        expectedFailure:{exitCode:3,outputIncludes:'BUG: value mismatch'},timeoutMs:1000});
      const signal=new AbortController().signal;
      await assert.rejects(run({identity},{signal,authorized:false}),{code:'reproduction_authorization_required'});
      const result=await run({identity},{signal,authorized:true});assert.equal(result.status,expected);
      assert(!result.observation.evidence.includes('BUG:'));
      await assert.rejects(run({identity},{signal,authorized:true}),{code:'reproduction_already_attempted'});
    }
    const missing=createFixReproduction({cwd,command:[path.join(cwd,'missing-command')],
      expectedFailure:{exitCode:3,outputIncludes:'BUG:'},timeoutMs:1000});
    assert.equal((await missing({identity},{signal:new AbortController().signal,authorized:true})).status,'blocked');
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
