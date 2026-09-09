import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareFixTestAuthor} from '../runtime/js/cm-fix/test-author.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

test('current host writes only regression scope after readiness/registration; real test subsequently goes red',async()=>{
  for(const mode of ['authored','out-of-scope','no-op','review-unavailable']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-author-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    const identity={repositoryId:'fixture',runId:'author-run',taskId:'T-FIX-author',attempt:1};
    let ready=0,registered=0,calls=0;const bridge=createHostToolBridge();
    bridge.attach(row=>{
      if(row.type!=='host_request')return;
      calls++;assert.equal(row.kind,'fix_test_author');assert.equal(ready,1);assert.equal(registered,1);
      if(mode!=='no-op')fs.writeFileSync(path.join(cwd,'regression.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('EXPECTED VALUE 2');process.exit(1)}");
      if(mode==='out-of-scope')fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
      bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:{outcome:'authored'}});
    });
    const options={codeProject:cwd,specsRoot,identity,testFiles:['regression.mjs'],requirements:['value.mjs'],
      defect:'Wrong constant',diagnosis:{rootCause:'constant mismatch'},reproduction:{status:'reproduced'}};
    const capabilities={bridge,assertReviewReady(){ready++;if(mode==='review-unavailable')throw Object.assign(new Error('unavailable'),{code:'review_unavailable'});}};
    try{
      assert.throws(()=>prepareFixTestAuthor({...options,testFiles:['AGENTS.md']},capabilities),{code:'protected_scope'});
      const author=prepareFixTestAuthor(options,capabilities);
      const control={authorized:true,signal:new AbortController().signal,register(baseline){registered++;assert.equal(baseline.baselineDigest,author.baseline.baselineDigest);}};
      await assert.rejects(author.execute({...control,authorized:false}),{code:'test_author_authorization_required'});
      if(mode==='authored'){
        const result=await author.execute(control);assert.deepEqual(result.changedFiles,['regression.mjs']);assert.equal(result.completionEligible,false);
        const red=await createFixRedTest({cwd,testFiles:['regression.mjs'],command:[process.execPath,'regression.mjs'],
          expectedFailure:{exitCode:1,outputIncludes:'EXPECTED VALUE 2'},timeoutMs:2000},{specsRoot,identity})({identity},control);
        assert.equal(red.status,'red_confirmed');await assert.rejects(author.execute(control),{code:'test_author_already_attempted'});
      }else{
        await assert.rejects(author.execute(control),{code:mode==='out-of-scope'?'out_of_scope':mode==='no-op'?'test_author_no_test':'review_unavailable'});
        if(mode==='review-unavailable'){assert.equal(calls,0);assert.equal(registered,0);assert(!fs.existsSync(path.join(cwd,'regression.mjs')));}
      }
    }finally{bridge.close();fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('fix owner registers test writing before bridge, resumes without redispatch, and keeps lost results unknown',async()=>{
  for(const mode of ['authored','lost','unavailable','wrong-root','wrong-specs']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-author-owner-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    const identity={repositoryId:'fixture',runId:'owner-author',taskId:'T-FIX-author',attempt:1};
    const options={specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Constant bug',
      reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd,testFiles:['regression.mjs'],command:[process.execPath,'regression.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      testAuthor:{requirements:['value.mjs']}}};
    let writes=0;const bridge=createHostToolBridge();
    bridge.attach(row=>{
      if(row.type!=='host_request')return;
      let result={status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['one'],plan:'Correct after test',crossLayer:false};
      if(row.kind==='fix_test_author'){
        const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
        assert(state.records.some(record=>record.id==='fix-test-author-intent'));
        writes++;fs.writeFileSync(path.join(cwd,'regression.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
        if(mode==='lost'){bridge.close();return;}result={outcome:'authored'};
      }
      bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
    });
    let owner=openFixExecution(options,{bridge,assertReviewReady(){if(mode==='unavailable')throw new Error('not ready');}});
    try{
      assert.equal((await owner.advance({authorized:true})).stage,'test_author_required');
      if(mode.startsWith('wrong-')){
        const other=path.join(root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'value.mjs'),'export const value=1;');
        let baseline=captureReviewBaseline({root:mode==='wrong-root'?other:cwd,specsRoot,identity,
          scope:['regression.mjs'],requirements:['value.mjs']});
        if(mode==='wrong-specs'){
          const {baselineDigest,...body}=baseline;body.specsPath='different-specs';baseline={...body,baselineDigest:digest(body)};
        }
        owner.close();owner=null;
        const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
        const store=openExecutionStore({specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
        store.append({id:'fix-test-author-intent',kind:'intent',payload:baseline,expectedRevision:store.snapshot().revision});store.close();
        assert.throws(()=>openFixExecution({...options,create:false}),{code:'test_author_binding_mismatch'});
        continue;
      }
      assert.equal((await owner.runRedTest({authorized:true})).stage,'test_author_required');
      await assert.rejects(owner.authorTests(),{code:'test_author_authorization_required'});
      if(mode==='unavailable'){
        await assert.rejects(owner.authorTests({authorized:true}),{code:'test_author_preparation_failed'});
        assert.equal(writes,0);assert.equal(owner.status().pending,null);
      }else{
        assert.equal((await owner.authorTests({authorized:true})).stage,mode==='lost'?'unknown':'red_test_required');
        const before=owner.status();owner.close();owner=openFixExecution({...options,create:false});
        assert.deepEqual(await owner.authorTests({authorized:true}),before);assert.equal(writes,1);
        if(mode==='authored'){
          fs.appendFileSync(path.join(cwd,'regression.mjs'),'\n// drift');
          assert.equal(owner.status().stage,'test_author_evidence_required');
          assert.equal((await owner.runRedTest({authorized:true})).stage,'test_author_evidence_required');
        }else assert.equal(owner.status().pending,'test_author');
      }
    }finally{owner?.close();bridge.close();fs.rmSync(root,{recursive:true,force:true});}
  }
});
