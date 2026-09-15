import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';

test('red test executes real regression, saves bounded private output and rejects unrelated failure',async()=>{
  for(const kind of ['red','green','other','missing','oversized']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-red-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
    const identity={repositoryId:'fixture',runId:'red-test-run',taskId:'T-FIX-red',attempt:1};
    const source=kind==='red'?"console.error('AssertionError: expected 2, got 1');process.exit(1)":kind==='green'?"console.log('passed')":
      kind==='oversized'?"process.stderr.write('x'.repeat(200000),()=>process.exit(1))":"console.error('unrelated configuration error');process.exit(1)";
    fs.writeFileSync(path.join(cwd,'regression.mjs'),source);
    const command=kind==='missing'?['/nonexistent/cm-fixture']: [process.execPath,'regression.mjs'];
    const run=createFixRedTest({cwd,testFiles:['regression.mjs'],command,
      expectedFailure:{exitCode:1,outputIncludes:'AssertionError: expected 2, got 1'},timeoutMs:2000},{specsRoot,identity});
    try{
      await assert.rejects(run({identity},{signal:new AbortController().signal,authorized:false}),{code:'red_test_authorization_required'});
      const result=await run({identity},{signal:new AbortController().signal,authorized:true});
      assert.equal(result.status,kind==='red'?'red_confirmed':['missing','oversized'].includes(kind)?'blocked':'not_red');
      assert.equal(result.output.complete,!['missing','oversized'].includes(kind));
      const artifact=path.join(specsRoot,result.output.path),captured=JSON.parse(fs.readFileSync(artifact,'utf8'));
      if(kind==='red')assert.equal(Buffer.from(captured.stderrBase64,'base64').toString(),'AssertionError: expected 2, got 1\n');
      assert(!JSON.stringify(result).includes('stderrBase64'));assert.equal(result.completionEligible,false);
      assert.equal(fs.statSync(artifact).mode&0o777,0o600);
      if(kind==='red'){
        fs.chmodSync(artifact,0o644);
        const repeat=createFixRedTest({cwd,testFiles:['regression.mjs'],command,
          expectedFailure:{exitCode:1,outputIncludes:'AssertionError: expected 2, got 1'},timeoutMs:2000},{specsRoot,identity});
        await assert.rejects(repeat({identity},{signal:new AbortController().signal,authorized:true}),{code:'red_output_permissions'});
        assert.equal(fs.statSync(artifact).mode&0o777,0o644);
      }
      await assert.rejects(run({identity},{signal:new AbortController().signal,authorized:true}),{code:'red_test_already_attempted'});
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});
