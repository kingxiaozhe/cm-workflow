import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareFixRepair} from '../runtime/js/cm-fix/repair.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {createFixRegression} from '../runtime/js/cm-fix/regression.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

test('host minimal repair preserves tests and real red-to-green regression, rejecting unauthorized/no-op/test edits',async()=>{
  for(const mode of ['repaired','test-edit','no-op','not-ready']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-repair-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('TARGET BUG');process.exit(1)}");
    fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
    const identity={repositoryId:'fixture',runId:'repair-run',taskId:'T-FIX-repair',attempt:1},signal=new AbortController().signal;
    const redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:2000};
    const baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000};
    const bridge=createHostToolBridge();let ready=0,registered=0,writes=0;
    bridge.attach(row=>{
      if(row.type!=='host_request')return;assert.equal(row.kind,'fix_repair');assert.equal(ready,1);assert.equal(registered,1);
      writes++;
      if(mode!=='no-op')fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
      if(mode==='test-edit')fs.writeFileSync(path.join(cwd,'red.mjs'),'// fake passing test');
      bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:{outcome:'repaired'}});
    });
    try{
      const redEvidence=await createFixRedTest(redTest,{identity,specsRoot})({identity},{authorized:true,signal});
      const beforeBaseline=await createFixBaseline(baseline)({identity},{authorized:true,signal});
      const options={identity,specsRoot,codeProject:cwd,scope:['value.mjs'],requirements:['value.mjs'],defect:'Wrong constant',
        diagnosis:{status:'diagnosed',affectedPaths:['value.mjs','red.mjs'],rootCause:'Wrong constant'},redTest,baseline,redEvidence,beforeBaseline};
      const capabilities={bridge,assertReviewReady(){ready++;if(mode==='not-ready')throw Object.assign(new Error('not ready'),{code:'review_unavailable'});}};
      assert.throws(()=>prepareFixRepair({...options,scope:['red.mjs']},capabilities),{code:'repair_test_scope_forbidden'});
      const repair=prepareFixRepair(options,capabilities);
      const control={authorized:true,signal,register(value){registered++;assert.equal(value.baselineDigest,repair.baseline.baselineDigest);}};
      await assert.rejects(repair.execute({...control,authorized:false}),{code:'repair_authorization_required'});
      if(mode==='repaired'){
        const result=await repair.execute(control);assert.deepEqual(result.changedFiles,['value.mjs']);assert.equal(result.completionEligible,false);
        const regression=await createFixRegression({identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline})({identity},{authorized:true,signal});
        assert.equal(regression.status,'passed');assert.equal(regression.completionEligible,false);
        await assert.rejects(repair.execute(control),{code:'repair_already_attempted'});
      }else{
        await assert.rejects(repair.execute(control),{code:mode==='test-edit'?'red_test_files_changed':mode==='no-op'?'repair_no_changes':'review_unavailable'});
        if(mode==='not-ready'){assert.equal(writes,0);assert.equal(registered,0);}
      }
    }finally{bridge.close();fs.rmSync(root,{recursive:true,force:true});}
  }
});
