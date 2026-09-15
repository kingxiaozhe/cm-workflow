import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFixWalkthrough,verifyFixWalkthroughEvidence} from '../runtime/js/cm-fix/walkthrough.mjs';

test('impact walkthrough requires coverage and authority; preserves observed, static and missing evidence separately',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-walkthrough-')));
  try{
    fs.writeFileSync(path.join(root,'observed.md'),'Synthetic host observation, not a real browser run.');
    const environment={kind:'web',carrier:'browser',target:'http://127.0.0.1:3000',scope:'local'};
    const flow={id:'flow',modules:['value'],steps:['Read value'],expected:['value is 2'],kind:'browser'};
    const options={cwd:root,specsRoot:root,identity:{repositoryId:'fixture',runId:'walk',taskId:'T-FIX-walk',attempt:1},
      packageDigest:'a'.repeat(64),diagnosis:{affectedModules:['value']},configuration:{flows:[flow],environment,timeoutMs:2000}};
    assert.throws(()=>createFixWalkthrough({...options,diagnosis:{affectedModules:['value','other']}}),{code:'walkthrough_module_mismatch'});
    let calls=0;
    const approved=createFixWalkthrough(options,{browser:async()=>{calls++;return {verdict:'PASS',evidence:['observed.md'],environment,cleanup:'completed'};}});
    await assert.rejects(()=>approved.run({signal:new AbortController().signal}),{code:'walkthrough_authorization_required'});assert.equal(calls,0);
    const passed=await approved.run({authorized:true,signal:new AbortController().signal});assert.equal(passed.status,'passed');assert.equal(passed.completionEligible,false);
    verifyFixWalkthroughEvidence(passed,root);
    await assert.rejects(()=>approved.run({authorized:true,signal:new AbortController().signal}),{code:'walkthrough_already_attempted'});assert.equal(calls,1);
    fs.appendFileSync(path.join(root,'observed.md'),' changed');assert.throws(()=>verifyFixWalkthroughEvidence(passed,root),{code:'walkthrough_evidence_changed'});
    for(const mode of ['missing-host','missing-file','cleanup','fail','logic','command']){
      const configuration={...options.configuration,flows:[mode==='logic'?{...flow,kind:'logic'}:mode==='command'?{...flow,kind:'commands',command:[process.execPath,'-e','process.exit(0)']}:flow]};
      const capabilities=mode==='missing-host'?{}:{browser:async()=>({verdict:mode==='fail'?'FAIL':'PASS',evidence:[mode==='missing-file'?'missing.md':'observed.md'],environment,cleanup:mode==='cleanup'?'failed':'completed'}),
        logic:async()=>({verdict:'SUPPORTED',evidence:['Synthetic static reading only']})};
      const result=await createFixWalkthrough({...options,configuration},capabilities).run({authorized:true,signal:new AbortController().signal});
      assert.equal(result.status,mode==='fail'?'failed':mode==='command'?'passed':'blocked',mode);
      if(mode==='logic')assert.equal(result.rows[0].observation.verdict,'SUPPORTED');
      if(mode==='missing-file')assert.equal(result.rows[0].evidenceProblem,'walkthrough_evidence_required');
    }
    for(const kind of ['browser','logic'])for(const reason of ['timeout','cancel']){
      const configuration={...options.configuration,timeoutMs:reason==='timeout'?25:1000,flows:[{...flow,kind}]};
      let rejectLate,observedSignal;const controller=new AbortController();
      const run=createFixWalkthrough({...options,configuration},{[kind]:(request,signal)=>{
        observedSignal=signal;
        if(reason==='cancel')setImmediate(()=>controller.abort());
        return new Promise((resolve,reject)=>{rejectLate=reject;});
      }});
      await assert.rejects(()=>run.run({authorized:true,signal:controller.signal}),{code:reason==='timeout'?'walkthrough_timeout':'cancelled'});
      assert(observedSignal.aborted);rejectLate(new Error('late callback rejection'));await new Promise(resolve=>setImmediate(resolve));
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
