import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildCauseReviewPrompt,buildReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {inspectProviderCauseReview,inspectProviderReview} from '../runtime/js/cm-ai/provider-review-observation.mjs';
import {inspectFixInvestigation} from '../runtime/js/cm-fix/investigation.mjs';

test('cause package binds only selected current source and never advances the fix',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cause-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'.env'),'SYNTHETIC_NOT_FOR_PACKAGE');
  const options={specsRoot,create:true,identity:{repositoryId:'fixture',runId:'cause-run',taskId:'T-FIX-cause',attempt:1},
    configuration:{hostContextId:'fixture-host',defect:'Synthetic value mismatch',reproduction:{cwd,
      command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}}};
  let owner;
  const investigation={discardedAlternatives:[{option:'Rewrite all callers',reason:'Synthetic defect is confined to the constant'}],
    boundaryAnalysis:{callChain:'consumer -> value.mjs',edgeEvidence:'Synthetic fixture value.mjs exports 1',lastNormalEdge:'consumer invocation',firstFailingEdge:'constant value',
      hypotheses:[{hypothesis:'Wrong constant',support:'value.mjs exports 1',counterTest:'Compare the exported constant with expected 2',result:'Mismatch in synthetic fixture'}]}};
  assert.throws(()=>inspectFixInvestigation({...investigation,boundaryAnalysis:{...investigation.boundaryAnalysis,hypotheses:[]}},true),{code:'invalid_fix_investigation'});
  assert.throws(()=>inspectFixInvestigation(investigation,false),{code:'invalid_fix_investigation'});
  try{
    owner=openFixExecution(options,{bridge:{async call(kind,request){assert(request.diagnosticRecord);return {status:'diagnosed',rootCause:'Cross-layer constant',
      plan:'Correct the source constant',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true,investigation};}}});
    assert.throws(()=>owner.causeReviewPackage(),{code:'fix_cause_review_unavailable'});
    assert.equal((await owner.advance({authorized:true})).stage,'cause_review_required');
    const first=owner.causeReviewPackage();assert.equal(first.files.length,1);
    assert.deepEqual(first.diagnosis.investigation,investigation);
    assert.equal(Buffer.from(first.files[0].contentBase64,'base64').toString(),'export const value=1;');
    assert.equal(JSON.stringify(first).includes('SYNTHETIC_NOT_FOR_PACKAGE'),false);
    for(const provider of ['codex','claude']){
      const request=requestFor({invocationId:'cause-call',identity:options.identity,role:'reviewer',provider,
        requestedModel:'synthetic',contextId:'logical-review',payload:{reviewPackage:first,priorReview:null}});
      assert.match(buildCauseReviewPrompt(request,provider),/pre-implementation review/);
      assert.match(buildCauseReviewPrompt(request,provider),/Rewrite all callers/);
      assert.throws(()=>buildReviewPrompt(request,provider));
      const expectation=JSON.stringify({request,developerThreadId:'author',excludedThreadIds:['fixture-host']});
      const observation={version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
        events:[{event:'thread.started',provider_thread:'fresh-review'},{event:'turn.started',item_type:null},
          {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
          {event:'process_closed',exit_code:0,signal:null,timed_out:false}],
        result:{status:'succeeded',value:{verdict:'approved',packageDigest:first.packageDigest,
          examinedPaths:['value.mjs'],findings:[],summary:'No actionable finding in synthetic evidence'}}};
      const inspect=value=>inspectProviderCauseReview(JSON.stringify(value),expectation);
      assert.equal(inspect(observation).observationStatus,'completed');
      assert.equal(inspect(observation).completionEligible,false);
      assert.throws(()=>inspectProviderReview(JSON.stringify(observation),expectation));
      assert.equal(inspect({...observation,events:observation.events.slice(0,-1)}).observationStatus,'unknown');
      assert.throws(()=>inspect({...observation,events:[{event:'thread.started',provider_thread:'author'},...observation.events.slice(1)]}),
        {code:'observation_context'});
    }
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
    assert.notEqual(owner.causeReviewPackage().packageDigest,first.packageDigest);
    assert.equal(owner.status().stage,'cause_review_required');assert.equal(owner.status().completionEligible,false);
    owner.close();owner=openFixExecution({...options,create:false});
    assert.deepEqual(owner.status().diagnosis.investigation,investigation);
    assert.equal(owner.causeReviewPackage().diagnosis.rootCause,first.diagnosis.rootCause);
    fs.symlinkSync(specsRoot,path.join(cwd,'linked'));
    assert.throws(()=>readReviewSourceFiles(cwd,['linked/file.mjs']),{code:'unsupported_path'});
    assert.throws(()=>readReviewSourceFiles(cwd,['.env']),{code:'unsupported_path'});
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
