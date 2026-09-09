import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createFixRetrospective,inspectFixRetrospective} from '../runtime/js/cm-fix/retrospective.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

test('local retrospective distinguishes no-new, candidate and pending without writing lessons or granting completion',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-retrospective-')));
  const identity={repositoryId:'fixture',runId:'retrospective-run',taskId:'T-FIX-demo',attempt:1};
  fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');
  const baseline=captureReviewBaseline({root,identity,scope:['value.mjs'],requirements:['value.mjs']});
  fs.writeFileSync(path.join(root,'value.mjs'),'export const value=2;');
  const reviewPackage=createReviewPackage({root,baseline,checks:[{id:'fixture',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Synthetic check record, not a live provider observation'}]});
  const files=[],contextDigest=digest(files),learning={contextDigest,files,application:{contextDigest,status:'no_relevant_lesson',summary:'No instructions'}};
  try{
    const other=path.join(root,'other-project');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'only-other-evidence.mjs'),'// other project');
    let wrongCalls=0;
    assert.throws(()=>createFixRetrospective({identity,codeProject:other,learning,reviewPackage},{bridge:{call(){wrongCalls++;}}}),{code:'retrospective_root_mismatch'});
    assert.equal(wrongCalls,0);
    for(const status of ['no_new_lesson','lesson_candidate','writeback_pending','missing-evidence']){
      const bridge=createHostToolBridge();let registered=0;
      bridge.attach(row=>{
        if(row.type!=='host_request')return;assert.equal(row.kind,'fix_retrospective');assert.equal(registered,1);
        const content={status:status==='missing-evidence'?'lesson_candidate':status,
          candidates:status==='no_new_lesson'?[]:[{classification:'structured',trigger:'Wrong constant',action:'Keep an assertion for the required value',evidence:[status==='missing-evidence'?'missing.mjs':'value.mjs']}],
          reason:status==='writeback_pending'?'Writeback not yet authorized':null};
        bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:content});
      });
      try{
        const run=createFixRetrospective({identity,codeProject:root,learning,reviewPackage},{bridge});
        const control={signal:new AbortController().signal,register(){registered++;}};
        if(status==='missing-evidence')await assert.rejects(run(control));
        else{
          const result=await run(control);assert.equal(result.content.status,status);assert.equal(result.completionEligible,false);
          assert(!fs.existsSync(path.join(root,'AGENTS.md')));
          assert.throws(()=>inspectFixRetrospective(result,{identity,learningDigest:'0'.repeat(64),packageDigest:reviewPackage.packageDigest}),{code:'retrospective_binding_mismatch'});
          await assert.rejects(run(control),{code:'retrospective_already_attempted'});
        }
      }finally{bridge.close();}
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
