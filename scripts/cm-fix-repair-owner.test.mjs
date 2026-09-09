import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {loadHandoff,implementationSha256} from './cm-task-gate.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {fixHandoffEvidence} from '../runtime/js/cm-fix/handoff.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {readProjectInstructionContext} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';

test('durable repair registers before write, preserves cause approval history and never redispatches lost results',async()=>{
  for(const mode of ['revision','revision-approved','revision-lost','normal','lost','cause','unfixed','regression-intent','lesson','retrospective-lost','lesson-intent','lesson-pending','handoff-forged','handoff-legacy','handoff-large']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-repair-owner-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
    fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
    if(mode==='revision-approved')fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
    const identity={repositoryId:'fixture',runId:'repair-owner',taskId:'T-FIX-owner',attempt:1};
    const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'review-context',excludedThreadIds:mode==='cause'?Array.from({length:32},(_,index)=>`excluded-${index}`):[]};
    const options={identity,specsRoot,create:true,configuration:{hostContextId:'fixture-host',defect:'Wrong constant',
      reproduction:{cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:mode==='normal'?'x'.repeat(128):'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
      repair:{scope:['value.mjs'],requirements:['value.mjs']},...(mode==='cause'||mode.startsWith('revision')?{causeReview:reviewer}:{})}};
    if(mode==='handoff-large')options.configuration.redTest.command=[process.execPath,'-e',
      "import('./value.mjs').then(({value})=>{if(value!==2){process.stderr.write('BUG'+'x'.repeat(128*1024-3));process.exitCode=1;}});//"+'x'.repeat(31*1024)];
    if(mode==='revision-approved')options.configuration.walkthrough={timeoutMs:2000,flows:[{id:'value-flow',modules:['one'],steps:['Read corrected value'],expected:['Value is 2'],kind:'commands',command:[process.execPath,'red.mjs']}]};
    const authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
    const causeReview={authorize:authority.authorize,run:createCauseReviewRun(async({prompt},{onEvent})=>{
      const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
      for(const event of [{event:'thread.started',provider_thread:'fresh-cause-thread'},{event:'turn.started',item_type:null},
        {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
      return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Synthetic'}};
    },'codex')};
    const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No project instructions in synthetic fixture'}};
    const prepare=async()=>{
      if(mode!=='revision-approved'||!fs.existsSync(path.join(cwd,'AGENTS.md')))return learning;
      const files=readProjectInstructionContext(cwd,[]).map(({content,...metadata})=>metadata);
      return {files,contextDigest:digest(files),application:{contextDigest:digest(files),status:'applied',summary:'Preserve reviewed first-round lessons'}};
    };
    const bridge=createHostToolBridge();let writes=0,retrospectives=0;
    bridge.attach(row=>{
      if(row.type!=='host_request')return;
      let result={status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['one'],crossLayer:mode==='cause',plan:'Correct constant'};
      if(mode==='revision-approved')result.investigation={discardedAlternatives:[],boundaryAnalysis:null};
      if(row.kind==='fix_retrospective'){
        const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
        assert.equal(state.records.at(-1).id,row.payload.identity.attempt===2?'fix-revision-retrospective-intent':'fix-retrospective-intent');retrospectives++;
        if(mode==='retrospective-lost'){bridge.close();return;}
        result=mode.startsWith('lesson')?{status:mode==='lesson-pending'?'writeback_pending':'lesson_candidate',candidates:[{classification:'structured',trigger:'Wrong constant',action:'Keep regression check',evidence:['red.mjs']}],reason:mode==='lesson-pending'?'Human assessment required':null}
          :{status:'no_new_lesson',candidates:[],reason:null};
        if(mode==='revision-approved')result={status:'lesson_candidate',candidates:[{classification:'structured',trigger:row.payload.identity.attempt===2?'Second repair boundary':'First repair boundary',action:'Keep value regression',evidence:['red.mjs']}],reason:null};
      }
      if(row.kind==='fix_repair'){
        const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
        assert.equal(state.records.at(-1).id,row.payload.identity.attempt===2?'fix-revision-repair-intent':'fix-repair-intent');writes++;
        if(row.payload.identity.attempt===2){assert.equal(row.payload.priorReview.review.findings[0].id,'F1');assert.deepEqual(row.payload.scope,['value.mjs']);}
        fs.writeFileSync(path.join(cwd,'value.mjs'),row.payload.identity.attempt===2?'export const value=2; // reviewed boundary repair':mode==='unfixed'?'export const value=3;':'export const value=2;');
        if(mode==='revision-lost'&&row.payload.identity.attempt===2){bridge.close();return;}
        if(mode==='lost'){bridge.close();return;}result={outcome:'repaired'};
      }
      bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
    });
    let owner=openFixExecution(options,{bridge,prepare,causeReview,assertReviewReady(){}});
    try{
      if(mode==='revision-approved')startFixRun({specsRoot,identity,configuration:options.configuration});
      await owner.advance({authorized:true});
      if(mode==='cause'){
        const pkg=owner.causeReviewPackage();await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
        await owner.reviewCause();
      }
      await owner.runRedTest({authorized:true});assert.equal((await owner.captureBaseline({authorized:true})).stage,'repair_required');
      await assert.rejects(owner.repair(),{code:'repair_authorization_required'});assert.equal(writes,0);
      const result=await owner.repair({authorized:true});assert.equal(result.stage,mode==='lost'?'unknown':'regression_required');
      assert.equal(result.completionEligible,false);if(mode==='cause')assert.equal(result.causeReview.review.verdict,'approved');
      owner.close();
      assert.throws(()=>openFixExecution({...options,create:false,configuration:{...options.configuration,
        repair:{...options.configuration.repair,scope:['AGENTS.md']}}}),{code:'protected_scope'});
      owner=openFixExecution({...options,create:false});
      assert.deepEqual(await owner.repair({authorized:true}),result);assert.equal(writes,1);
      if(mode!=='lost'){
        await assert.rejects(owner.runRegression(),{code:'regression_authorization_required'});
        if(mode==='regression-intent'){
          owner.close();owner=null;
          const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
          const store=openExecutionStore({specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
          store.append({id:'fix-regression-intent',kind:'intent',payload:{repairDigest:digest(result.repair),redDigest:digest(result.redTest),baselineDigest:digest(result.baseline)},expectedRevision:store.snapshot().revision});store.close();
          owner=openFixExecution({...options,create:false});
          assert.equal((await owner.runRegression({authorized:true})).stage,'unknown');assert.equal(owner.status().pending,'regression');continue;
        }
        const checked=await owner.runRegression({authorized:true});
        assert.equal(checked.stage,mode==='unfixed'?'regression_blocked':'handoff_required');
        assert.equal(checked.regression.status,mode==='unfixed'?'defect_remaining':'passed');
        assert.equal(checked.completionEligible,false);owner.close();owner=openFixExecution({...options,create:false});
        assert.deepEqual(await owner.runRegression({authorized:true}),checked);
        if(mode==='unfixed')assert.throws(()=>owner.implementationPackage(),{code:'fix_not_ready_for_handoff'});
        else{
          const pkg=owner.implementationPackage();
          assert.deepEqual(pkg.changes.map(change=>change.path),['value.mjs']);
          assert.deepEqual(pkg.checks.map(check=>check.id),['red-test','baseline.1']);
          assert.deepEqual(pkg.checks[1].command,options.configuration.baseline.commands[0].command);
          owner.close();owner=openFixExecution({...options,create:false},{bridge,prepare});
          const retrospective=await owner.retrospect();
          assert.equal(retrospective.stage,mode==='retrospective-lost'?'unknown':mode.startsWith('lesson')||mode==='revision-approved'?'learning_writeback_required':'handoff_ready');
          assert.equal(retrospective.completionEligible,false);assert.equal(retrospectives,1);
          owner.close();owner=openFixExecution({...options,create:false},{bridge,prepare});
          assert.deepEqual(await owner.retrospect(),retrospective);assert.equal(retrospectives,1);
          assert.equal(fs.existsSync(path.join(cwd,'AGENTS.md')),false);
          if(mode==='retrospective-lost'){assert.equal(owner.status().pending,'retrospective');continue;}
          if(mode==='lesson-intent'){
            owner.close();owner=null;
            const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
            const store=openExecutionStore({specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
            store.append({id:'fix-learning-writeback-intent',kind:'intent',payload:{identity,learningDigest:digest(retrospective.learning),
              retrospectiveDigest:digest(retrospective.retrospective),packageDigest:retrospective.retrospective.packageDigest},expectedRevision:store.snapshot().revision});store.close();
            owner=openFixExecution({...options,create:false});
            assert.equal(owner.writeLearning({authorized:true}).stage,'unknown');assert.equal(owner.status().pending,'learning_writeback');
            assert(!fs.existsSync(path.join(cwd,'AGENTS.md')));continue;
          }
          if(mode==='lesson-pending'){
            const blocked=owner.writeLearning({authorized:true});assert.equal(blocked.stage,'learning_writeback_blocked');
            assert.equal(blocked.learningWriteback.reason,'Human assessment required');owner.close();owner=openFixExecution({...options,create:false});
            assert.deepEqual(owner.writeLearning({authorized:true}),blocked);assert(!fs.existsSync(path.join(cwd,'AGENTS.md')));continue;
          }
          if(mode==='lesson'||mode==='revision-approved'){
            assert.throws(()=>owner.writeLearning(),{code:'learning_writeback_authorization_required'});
            const written=owner.writeLearning({authorized:true});assert.equal(written.stage,'handoff_ready');
            assert.equal(written.learningWriteback.outcome,'written');assert.equal(written.completionEligible,false);
            const bytes=fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8');
            const pkg=owner.implementationPackage();assert.deepEqual(pkg.changes.map(file=>file.path),['AGENTS.md','value.mjs']);
            assert.deepEqual(options.configuration.repair.scope,['value.mjs']);
            owner.close();owner=openFixExecution({...options,create:false});
            assert.deepEqual(owner.writeLearning({authorized:true}),written);assert.equal(fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8'),bytes);
          }
          const handoffPath=path.join(specsRoot,'.reviews','fix-owner-T-FIX-owner-a1-handoff.json');
          if(mode==='handoff-large'){
            assert.throws(()=>owner.createHandoff(),{code:'limit_exceeded'});assert.equal(owner.status().stage,'handoff_ready');
            assert(!fs.existsSync(handoffPath));owner.close();owner=openFixExecution({...options,create:false});
            assert.equal(owner.status().stage,'handoff_ready');
            const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
            assert(!state.records.some(record=>record.id==='fix-handoff-intent'));continue;
          }
          if(['handoff-forged','handoff-legacy'].includes(mode)){
            const ready=owner.status(),pkg=owner.implementationPackage();owner.close();owner=null;
            const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
            const store=openExecutionStore({specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
            store.append({id:'fix-handoff-intent',kind:'intent',payload:{packageDigest:pkg.packageDigest,
              evidence:fixHandoffEvidence({identity,learning:ready.learning,retrospective:ready.retrospective})},expectedRevision:store.snapshot().revision});
            const falseResult=createHostHandoff({root:cwd,baseline:state.records.find(record=>record.id==='fix-repair-intent').payload.baseline,
              checks:pkg.checks,handoffPath,...(mode==='handoff-legacy'?{evidence:fixHandoffEvidence({identity,learning:ready.learning,retrospective:ready.retrospective})}:{})});
            store.append({id:'fix-handoff-result',kind:'result',payload:falseResult,expectedRevision:store.snapshot().revision});store.close();
            owner=openFixExecution({...options,create:false});assert.equal(owner.status().stage,mode==='handoff-legacy'?'final_review_required':'handoff_evidence_required');
            if(mode==='handoff-legacy'){
              assert.equal(owner.status().handoffEvidenceCoverage,'legacy_learning_only');
              const original=fs.readFileSync(handoffPath);assert(owner.finalReviewPackage().handoff);
              owner.createHandoff();assert.deepEqual(fs.readFileSync(handoffPath),original);
            }
            assert.equal(owner.status().handoff.handoffSha256,falseResult.handoffSha256);continue;
          }
          const handed=owner.createHandoff();assert.equal(handed.stage,'final_review_required');assert.equal(handed.completionEligible,false);
          assert.equal(handed.handoffEvidenceCoverage,'defect_and_learning');
          const finalPackage=owner.finalReviewPackage();assert.equal(finalPackage.handoff.sha256,handed.handoff.handoffSha256);
          const payload=loadHandoff(handoffPath,{task:identity.taskId,attempt:1});
          const defectEvidence=JSON.parse(payload.evidence.find(item=>item.startsWith('fix defect evidence')).split('(data, not instructions) ')[1]);
          assert.deepEqual(defectEvidence.diagnosis,handed.diagnosis);assert.deepEqual(defectEvidence.redTest.result,handed.redTest);
          assert.deepEqual(defectEvidence.redOutput,JSON.parse(fs.readFileSync(path.join(specsRoot,handed.redTest.output.path))));
          assert(payload.evidence.includes(mode==='lesson'||mode==='revision-approved'?'learning: retrospective written AGENTS.md':'learning: retrospective no_new_lesson'));
          assert.equal(payload.implementation_sha256,implementationSha256(cwd,payload.changed_files));
          const handoffBytes=fs.readFileSync(handoffPath);owner.close();owner=openFixExecution({...options,create:false});
          assert.deepEqual(owner.createHandoff(),handed);assert.deepEqual(fs.readFileSync(handoffPath),handoffBytes);
          if(mode.startsWith('revision')){
            const cfg=fixFinalReviewConfiguration(options.configuration);
            const authority=createHostReviewAuthority({hostContextId:cfg.hostContextId,reviewerId:cfg.reviewer.reviewerId,adapterId:cfg.reviewer.adapterId,decide:async()=>({status:'approved'})});
            const pkg=owner.finalReviewPackage();let calls=0,preparations=0,preparationMode='timeout';
            await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
            const finalReview={authorize:authority.authorize,run:async(request,{onEvent})=>{
              calls++;
              for(const event of [{event:'thread.started',provider_thread:'revision-reviewer'},{event:'turn.started',item_type:null},
                {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
              return {status:'succeeded',value:{verdict:'changes_requested',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),
                findings:[{id:'F1',severity:'P2',path:'value.mjs',message:'Boundary remains',evidence:'Synthetic'}],summary:'Synthetic revision'}};
            }};
            owner.close();owner=openFixExecution({...options,create:false},{finalReview,assertReviewReady(){},prepare:async request=>{preparations++;assert.equal(request.identity.attempt,2);return preparationMode==='timeout'?new Promise(()=>{}):prepare();}});
            await owner.reviewFinal();assert.equal(owner.publishReview().stage,'final_review_changes_requested');
            await assert.rejects(owner.prepareRevision(),{code:'repair_authorization_required'});assert.equal(preparations,0);
            const before=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records;
            await assert.rejects(owner.prepareRevision({authorized:true}),{code:'fix_learning_interrupted'});
            assert.equal(owner.status().stage,'final_review_changes_requested');
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records,before);
            preparationMode='normal';
            const revised=await owner.prepareRevision({authorized:true});assert.equal(revised.stage,'revision_prepared');
            assert.equal(revised.identity.attempt,1);assert.equal(revised.revision.nextIdentity.attempt,2);assert.equal(revised.completionEligible,false);
            assert.equal(preparations,2);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(handoffPath),handoffBytes);
            const after=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records;
            assert.deepEqual(after.slice(0,-1),before);assert.equal(after.at(-1).id,'fix-revision-prepared');
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),revised);
            assert.deepEqual(await owner.prepareRevision({authorized:true}),revised);assert.equal(calls,1);
            owner.close();owner=openFixExecution({...options,create:false},{bridge,prepare,assertReviewReady(){}});
            await assert.rejects(owner.repair(),{code:'repair_authorization_required'});
            const repairedAgain=await owner.repair({authorized:true});assert.equal(writes,2);assert.equal(calls,1);
            assert.equal(repairedAgain.stage,mode==='revision-lost'?'unknown':'revision_regression_required');
            assert.equal(repairedAgain.completionEligible,false);assert.deepEqual(fs.readFileSync(handoffPath),handoffBytes);
            assert.deepEqual(repairedAgain.repair,revised.repair);
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),repairedAgain);
            assert.deepEqual(await owner.repair({authorized:true}),repairedAgain);assert.equal(writes,2);
            if(mode==='revision-lost'){assert.equal(owner.status().pending,'revision_repair');continue;}
            await assert.rejects(owner.runRegression(),{code:'regression_authorization_required'});
            const regressedAgain=await owner.runRegression({authorized:true});assert.equal(regressedAgain.stage,'revision_handoff_required');
            assert.equal(regressedAgain.revisionRegression.status,'passed');assert.equal(regressedAgain.completionEligible,false);
            assert.equal(fs.existsSync(path.join(specsRoot,'.reviews','fix-owner-a2-red-output.md')),false);
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),regressedAgain);
            assert.deepEqual(await owner.runRegression({authorized:true}),regressedAgain);assert.equal(writes,2);assert.equal(calls,1);
            const cumulative=owner.implementationPackage();assert.equal(cumulative.identity.attempt,2);
            assert.equal(Buffer.from(cumulative.changes.find(change=>change.path==='value.mjs').before.contentBase64,'base64').toString(),'export const value=1;');
            owner.close();owner=openFixExecution({...options,create:false},{bridge,prepare});
            const reflectedAgain=await owner.retrospect();assert.equal(reflectedAgain.stage,mode==='revision-approved'?'revision_learning_writeback_required':'revision_handoff_ready');
            assert.equal(reflectedAgain.revisionRetrospective.identity.attempt,2);assert.equal(retrospectives,2);
            assert.equal(reflectedAgain.revisionRetrospective.packageDigest,cumulative.packageDigest);assert.equal(reflectedAgain.completionEligible,false);
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),reflectedAgain);
            assert.deepEqual(await owner.retrospect(),reflectedAgain);assert.equal(retrospectives,2);
            if(mode==='revision-approved'){
              assert.throws(()=>owner.writeLearning(),{code:'learning_writeback_authorization_required'});
              assert.equal(owner.createHandoff().stage,'revision_learning_writeback_required');
              const written=owner.writeLearning({authorized:true});assert.equal(written.stage,'revision_handoff_ready');
              assert.equal(written.revisionLearningWriteback.outcome,'written');assert.equal(written.revisionLearningWriteback.identity.attempt,2);
              const agents=fs.readFileSync(path.join(cwd,'AGENTS.md'));assert(agents.toString().includes('Second repair boundary'));
              assert(agents.toString().includes('First repair boundary'));assert.equal(written.learningWriteback.identity.attempt,1);
              owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),written);
              assert.deepEqual(owner.writeLearning({authorized:true}),written);assert.deepEqual(fs.readFileSync(path.join(cwd,'AGENTS.md')),agents);
              fs.appendFileSync(path.join(cwd,'AGENTS.md'),' drift');assert.equal(owner.status().stage,'revision_learning_writeback_evidence_required');
              fs.writeFileSync(path.join(cwd,'AGENTS.md'),agents);
            }
            const handedAgain=owner.createHandoff();assert.equal(handedAgain.stage,'revision_final_review_required');
            const secondPath=path.join(specsRoot,'.reviews','fix-owner-T-FIX-owner-a2-handoff.json');
            const secondBytes=fs.readFileSync(secondPath),secondHandoff=loadHandoff(secondPath,{task:identity.taskId,attempt:2});
            assert(secondHandoff.evidence.some(item=>item.startsWith('fix prior review')&&item.includes('F1')));
            if(mode==='revision-approved'){assert(secondHandoff.evidence.includes('learning: retrospective written AGENTS.md'));assert(secondHandoff.changed_files.includes('AGENTS.md'));}
            assert.deepEqual(fs.readFileSync(handoffPath),handoffBytes);assert.equal(handedAgain.completionEligible,false);
            const reviewAgain=owner.finalReviewPackage();assert.equal(reviewAgain.identity.attempt,2);assert.equal(reviewAgain.handoff.sha256,handedAgain.revisionHandoff.handoffSha256);
            assert.equal(Buffer.from(reviewAgain.changes.find(change=>change.path==='value.mjs').before.contentBase64,'base64').toString(),'export const value=1;');
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),handedAgain);
            assert.deepEqual(owner.createHandoff(),handedAgain);assert.deepEqual(fs.readFileSync(secondPath),secondBytes);assert.equal(calls,1);
            fs.appendFileSync(secondPath,' ');assert.equal(owner.status().stage,'revision_handoff_evidence_required');
            assert.throws(()=>owner.finalReviewPackage(),{code:'fix_not_ready_for_review'});fs.writeFileSync(secondPath,secondBytes);
            await authority.hostDecisionProvider.decide({identity:reviewAgain.identity,packageDigest:reviewAgain.packageDigest},new AbortController().signal);
            owner.close();owner=openFixExecution({...options,create:false},{assertReviewReady(){},finalReview:{authorize:authority.authorize,run:async(request,{onEvent})=>{
              calls++;assert.equal(request.identity.attempt,2);assert.equal(request.payload.priorReview.findings[0].id,'F1');
              for(const event of [{event:'thread.started',provider_thread:'second-revision-reviewer'},{event:'turn.started',item_type:null},
                {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
              return {status:'succeeded',value:{...request.payload.priorReview,packageDigest:reviewAgain.packageDigest,examinedPaths:reviewPaths(reviewAgain),
                ...(mode==='revision-approved'?{verdict:'approved',findings:[]}: {})}};
            }}});
            assert.equal((await owner.reviewFinal()).stage,'revision_final_review_evidence_required');
            const reviewedAgain=owner.publishReview();assert.equal(reviewedAgain.stage,mode==='revision-approved'?'revision_completion_gate_required':'revision_review_limit_reached');
            assert.equal(reviewedAgain.completionEligible,false);assert.equal(calls,2);
            owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),reviewedAgain);
            assert.deepEqual(await owner.reviewFinal(),reviewedAgain);assert.equal(calls,2);
            await assert.rejects(owner.prepareRevision({authorized:true}),{code:'fix_revision_unavailable'});
            if(mode==='revision-approved'){
              const gated=owner.checkCompletionGate();assert.equal(gated.stage,'revision_post_review_regression_required');
              assert.equal(gated.revisionN5.gate.attempt,2);assert.equal(gated.completionEligible,false);
              const reviewPath=path.join(specsRoot,'.reviews','fix-owner-T-FIX-owner-r2.md'),reviewBytes=fs.readFileSync(reviewPath);
              owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),gated);assert.deepEqual(owner.checkCompletionGate(),gated);
              fs.renameSync(reviewPath,path.join(root,'saved-r2.md'));assert.equal(owner.status().stage,'revision_final_review_evidence_required');
              assert.equal(owner.publishReview().stage,'revision_post_review_regression_required');assert.deepEqual(fs.readFileSync(reviewPath),reviewBytes);assert.equal(calls,2);
              const log=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
              assert.equal(log.filter(row=>row.event==='review'&&row.attempt===2).length,1);
              assert(!log.some(row=>['task_done','run_done'].includes(row.event)));
              fs.appendFileSync(reviewPath,' conflict');assert.equal(owner.status().stage,'revision_final_review_evidence_required');
              assert.throws(()=>owner.publishReview(),{code:'review_file_conflict'});fs.writeFileSync(reviewPath,reviewBytes);
              await assert.rejects(owner.runRegression({postReview:true}),{code:'regression_authorization_required'});
              const post=await owner.runRegression({postReview:true,authorized:true});assert.equal(post.stage,'revision_closeout_required');
              assert.equal(post.revisionPostRegression.status,'passed');assert.equal(post.completionEligible,false);
              owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),post);
              assert.deepEqual(await owner.runRegression({postReview:true,authorized:true}),post);assert.equal(calls,2);
              await assert.rejects(owner.runWalkthrough(),{code:'walkthrough_authorization_required'});
              const walked=await owner.runWalkthrough({authorized:true});assert.equal(walked.stage,'revision_closeout_required');
              assert.equal(walked.revisionWalkthrough.status,'passed');assert.equal(walked.completionEligible,false);
              const stored=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
              const intent=stored.records.find(row=>row.id==='fix-revision-walkthrough-intent');
              assert.equal(intent.payload.identity.attempt,2);assert.equal(intent.payload.packageDigest,walked.revisionN5.packageDigest);
              owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),walked);
              assert.deepEqual(await owner.runWalkthrough({authorized:true}),walked);assert.equal(calls,2);
              assert.throws(()=>owner.finish(),{code:'fix_finish_authorization_required'});
              fs.writeFileSync(path.join(specsRoot,'METRICS.md'),'User custom table, not recognized.\n');
              assert.throws(()=>owner.finish({authorized:true}),{code:'metrics_table_invalid'});
              assert.equal(owner.status().stage,'revision_closeout_incomplete');
              assert.equal(owner.status().completionHistory.taskDoneEventIds.length,1);
              owner.close();owner=openFixExecution({...options,create:false});
              assert.equal(owner.status().stage,'revision_closeout_incomplete');
              fs.renameSync(path.join(specsRoot,'METRICS.md'),path.join(root,'user-metrics.md'));
              const completed=owner.finish({authorized:true});assert.equal(completed.stage,'completed');assert.equal(completed.completionEligible,true);
              assert.equal(completed.identity.attempt,1);assert.equal(completed.revision.nextIdentity.attempt,2);
              owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),completed);
              assert.deepEqual(owner.finish({authorized:true}),completed);assert.equal(calls,2);
              const finishedLog=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
              for(const event of ['task_done','run_done']){
                const rows=finishedLog.filter(row=>row.event===event);assert.equal(rows.length,1);assert.equal(rows[0].attempt,2);
              }
              assert.equal(finishedLog.filter(row=>row.event==='task_start').length,1);
              const done=finishedLog.find(row=>row.event==='task_done');
              const archive=fs.readFileSync(path.join(specsRoot,done.dossier_file),'utf8');
              assert(archive.includes('先前轮次（历史记录，不替代当前审查）'));assert(archive.includes('changes_requested'));
              assert(fs.readFileSync(path.join(specsRoot,'METRICS.md'),'utf8').includes('| 2 | 1 |'));
            }
            fs.appendFileSync(path.join(cwd,'value.mjs'),' ');assert.equal(owner.status().stage,mode==='revision-approved'?'revision_learning_writeback_evidence_required':'revision_repair_evidence_required');
            if(mode==='revision-approved'){assert.equal(owner.status().completionEligible,false);assert.equal(owner.status().completionHistory.runDoneEventIds.length,1);}
            assert.deepEqual(owner.status().revision,revised.revision);continue;
          }
          if(mode==='cause'){
            const cfg=fixFinalReviewConfiguration(options.configuration,handed.causeReview.providerThreadId);let calls=0;
            assert.equal(cfg.reviewer.excludedThreadIds.length,33);
            const authority=createHostReviewAuthority({hostContextId:cfg.hostContextId,reviewerId:cfg.reviewer.reviewerId,adapterId:cfg.reviewer.adapterId,decide:async()=>({status:'approved'})});
            const finalReview={authorize:authority.authorize,run:async(request,{onEvent})=>{
              calls++;assert.equal(onEvent({event:'thread.started',provider_thread:handed.causeReview.providerThreadId}),false);
              return {status:'failed',code:'synthetic-context-reuse'};
            }};
            await authority.hostDecisionProvider.decide({identity,packageDigest:owner.finalReviewPackage().packageDigest},new AbortController().signal);
            owner.close();owner=openFixExecution({...options,create:false},{finalReview,assertReviewReady(){}});
            const interrupted=await owner.reviewFinal();assert.equal(interrupted.stage,'unknown');assert.equal(interrupted.pending,'final_review');
            owner.close();owner=openFixExecution({...options,create:false},{finalReview,assertReviewReady(){}});
            assert.deepEqual(await owner.reviewFinal(),interrupted);assert.equal(calls,1);continue;
          }
          if(mode==='normal'){
            fs.appendFileSync(handoffPath,' ');assert.equal(owner.status().stage,'handoff_evidence_required');
            assert.throws(()=>owner.finalReviewPackage(),{code:'fix_not_ready_for_review'});
            assert.deepEqual(owner.status().handoff,handed.handoff);fs.writeFileSync(handoffPath,handoffBytes);
            assert.equal(owner.status().stage,'final_review_required');
          }
        }
        fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=4;');assert.equal(owner.status().stage,mode==='lesson'?'learning_writeback_evidence_required':'repair_evidence_required');
        assert.deepEqual(owner.status().repair,result.repair);
      }else assert.equal(owner.status().pending,'repair');
    }finally{owner?.close();bridge.close();fs.rmSync(root,{recursive:true,force:true});}
  }
});
