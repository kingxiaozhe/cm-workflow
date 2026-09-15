import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCodexReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {createFixFinalReview,inspectFixFinalResult,inspectFixRepairReview,fixRevisionReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {prepareFixRepair} from '../runtime/js/cm-fix/repair.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {createFixWalkthrough} from '../runtime/js/cm-fix/walkthrough.mjs';

test('final review uses existing grant, prompt and normalized inspection without issuing completion',async()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-final-review-')));
  const root=path.join(temp,'code');fs.mkdirSync(root);
  try{
    const identity={repositoryId:'fixture',runId:'final-review',taskId:'T-FIX-demo',attempt:1};
    fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');
    const baseline=captureReviewBaseline({root,identity,scope:['value.mjs'],requirements:['value.mjs']});
    fs.writeFileSync(path.join(root,'value.mjs'),'export const value=2;');
    const checks=[{id:'synthetic',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Protocol fixture only'}];
    const handoffPath=path.join(temp,'fix-demo-T-FIX-demo-a1-handoff.json');
    createHostHandoff({root,baseline,checks,handoffPath,evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
    const pkg=createReviewPackage({root,baseline,checks,handoffPath});
    for(const mode of ['approved','changes_requested','denied','excluded','lost','timeout']){
      const reviewer={reviewerId:'final-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'logical-review',excludedThreadIds:mode==='excluded'?['actual-review']:mode==='changes_requested'?[...Array.from({length:32},(_,index)=>`configured-${index}`),'cause-reviewer']:[]};
      const configuration={hostContextId:'actual-host',reviewer};let registered=null,started=null,calls=0;
      const authority=createHostReviewAuthority({hostContextId:configuration.hostContextId,reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
        decide:async()=>mode==='denied'?{status:'denied',code:'permission_denied'}:{status:'approved'}});
      await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
      const run=createCodexReviewRun(async({prompt},{onEvent})=>{
        calls++;assert(registered);assert(prompt.includes(pkg.handoff.contentBase64));
        if(mode==='timeout')return new Promise(()=>{});
        if(mode==='lost')throw Error('synthetic loss');
        const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
        for(const event of [{event:'thread.started',provider_thread:'actual-review'},{event:'turn.started',item_type:null},
          {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
        return {status:'succeeded',value:{verdict:mode==='changes_requested'?mode:'approved',packageDigest:pkg.packageDigest,examinedPaths:data.examinedPaths,
          findings:mode==='changes_requested'?[{id:'F1',severity:'P2',path:'value.mjs',message:'Boundary case remains',evidence:'Synthetic finding'}]:[],summary:'Synthetic'}};
      });
      const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:mode==='timeout'?10:2000},{authorize:authority.authorize,run});
      const result=await review({signal:new AbortController().signal,register(value){registered=value;},onStarted(thread){assert(registered);started=thread;}});
      assert.equal(result.completionEligible,false);
      assert.equal(result.outcome,['approved','changes_requested'].includes(mode)?'observed':mode==='denied'?'denied':'unknown');
      if(['approved','changes_requested'].includes(mode)){
        const feedback={configuration,registration:registered,started,result:result.value},next={...identity,attempt:2};
        if(mode==='changes_requested'){
          const checked=inspectFixRepairReview(feedback,next);
          assert.equal(checked.review.findings[0].id,'F1');assert.equal(checked.providerThreadId,'actual-review');
          assert.throws(()=>inspectFixRepairReview(feedback,{...next,taskId:'T-FIX-other'}),{code:'fix_review_identity_mismatch'});
          assert.throws(()=>inspectFixRepairReview(feedback,{...next,attempt:3}),{code:'invalid_input'});
          assert.throws(()=>inspectFixRepairReview(feedback,identity),{code:'fix_review_limit'});
          assert.throws(()=>inspectFixRepairReview({...feedback,started:'different-thread'},next),{code:'final_registration_mismatch'});
          const specsRoot=path.join(temp,'specs');fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
          fs.writeFileSync(path.join(root,'red.mjs'),"import {value} from './value.mjs';if(value!==3){console.error('remaining bug');process.exit(1)}");
          const signal=new AbortController().signal;
          const redTest={cwd:root,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'remaining bug'},timeoutMs:2000};
          const base={cwd:root,testFiles:['red.mjs'],commands:[{id:'existing',command:[process.execPath,'--check','red.mjs']}],timeoutMs:2000};
          const redEvidence=await createFixRedTest(redTest,{identity:next,specsRoot})({identity:next},{authorized:true,signal});
          const beforeBaseline=await createFixBaseline(base)({identity:next},{authorized:true,signal});
          let repairRegistered=false;
          const repair=prepareFixRepair({identity:next,specsRoot,codeProject:root,scope:['value.mjs'],requirements:['value.mjs'],
            defect:'Remaining boundary',diagnosis:{status:'diagnosed',affectedPaths:['value.mjs']},redTest,baseline:base,redEvidence,beforeBaseline,reviewFeedback:feedback},
          {assertReviewReady(){},bridge:{async call(kind,request){
            assert(repairRegistered);assert.equal(kind,'fix_repair');assert.deepEqual(request.priorReview,checked);
            assert.deepEqual(request.scope,['value.mjs']);fs.writeFileSync(path.join(root,'value.mjs'),'export const value=3;');return {outcome:'repaired'};
          }}});
          const repaired=await repair.execute({authorized:true,signal,register(){repairRegistered=true;}});
          assert.equal(repaired.outcome,'repaired');assert.equal(repaired.completionEligible,false);
          const nextBaseline=captureReviewBaseline({root,identity:next,scope:['value.mjs'],requirements:['value.mjs']});
          fs.appendFileSync(path.join(root,'value.mjs'),' // second review fixture');
          const nextHandoff=path.join(temp,'fix-demo-T-FIX-demo-a2-handoff.json');
          createHostHandoff({root,baseline:nextBaseline,checks,handoffPath:nextHandoff,evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
          const nextPackage=createReviewPackage({root,baseline:nextBaseline,checks,handoffPath:nextHandoff});
          const nextConfiguration=fixRevisionReviewConfiguration(feedback,next);
          assert(nextConfiguration.reviewer.excludedThreadIds.includes('actual-review'));
          assert.equal(nextConfiguration.reviewer.excludedThreadIds.length,34);
          for(const thread of ['actual-review','fresh-second-review']){
            await authority.hostDecisionProvider.decide({identity:next,packageDigest:nextPackage.packageDigest},signal);
            const nextRun=createFixFinalReview({reviewPackage:nextPackage,configuration:nextConfiguration,timeoutMs:2000},{authorize:authority.authorize,run:async(request,{onEvent})=>{
              assert.equal(request.payload.priorReview.findings[0].id,'F1');
              if(!onEvent({event:'thread.started',provider_thread:thread}))return {status:'failed',code:'excluded'};
              for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
              return {status:'succeeded',value:{verdict:'approved',packageDigest:nextPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Synthetic'}};
            }});
            const observed=await nextRun({signal,register(){},onStarted(){}});
            assert.equal(observed.outcome,thread==='actual-review'?'unknown':'observed');
            if(thread!=='actual-review')assert.equal(observed.inspection.review.verdict,'approved');
          }
        }else{
          assert.throws(()=>inspectFixRepairReview(feedback,next),{code:'fix_review_repair_unavailable'});
          for(const status of ['failed','passed','blocked']){
            const config={timeoutMs:2000,flows:[{id:'flow',modules:['one'],steps:['Check'],expected:[status==='blocked'?'[需确认] expectation':'Expected'],
              kind:'commands',command:[process.execPath,'-e',`process.exit(${status==='passed'?0:1})`]}]};
            const walkthrough=createFixWalkthrough({cwd:root,specsRoot:temp,identity,packageDigest:pkg.packageDigest,
              diagnosis:{affectedModules:['one']},configuration:config});
            const result=await walkthrough.run({authorized:true,signal:new AbortController().signal});
            const failure={configuration:config,binding:walkthrough.binding,result},extended={...feedback,walkthroughFailure:failure};
            if(status==='failed'){
              const checked=inspectFixRepairReview(extended,next);
              assert.equal(checked.review.verdict,'approved');assert.equal(checked.walkthroughFailure.result.status,'failed');
              assert(fixRevisionReviewConfiguration(extended,next).reviewer.excludedThreadIds.includes(started));
              assert.throws(()=>inspectFixRepairReview({...extended,walkthroughFailure:{...failure,binding:{...failure.binding,packageDigest:'0'.repeat(64)}}},next),{code:'fix_review_repair_unavailable'});
            }else assert.throws(()=>inspectFixRepairReview(extended,next),{code:'fix_review_repair_unavailable'});
          }
        }
      }
      if(mode==='approved'){
        assert.equal(inspectFixFinalResult(result.value,registered,configuration,started).review.verdict,'approved');
        assert.equal(result.inspection.completionEligible,false);
      }
      if(mode==='denied'){assert.equal(calls,0);assert.equal(registered,null);}
      if(mode==='excluded')assert.equal(started,null);
      if(mode==='timeout'){
        assert.equal(result.reason,'timeout');
        assert.deepEqual(result.diagnostic,{phase:'transport',code:'timeout'});
      }
      await assert.rejects(review({signal:new AbortController().signal,register(){},onStarted(){}}),{code:'final_review_already_attempted'});
    }
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
