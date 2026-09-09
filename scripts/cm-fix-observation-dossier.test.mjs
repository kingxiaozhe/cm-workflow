import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {fixObservationRecoveryEvidence} from '../runtime/js/cm-fix/handoff.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {checkN4} from './cm-task-gate.mjs';
import {causeExpectation} from '../runtime/js/cm-fix/cause-invocation.mjs';

for(const mode of ['normal','late-final','late-repair','late-retrospective','late-learning','late-handoff','lost','unreproduced','needs_evidence','walk-failure','regression-failure'])
test(`observation recovery: ${mode}`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-observation-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  if(mode==='regression-failure')fs.writeFileSync(path.join(cwd,'red.mjs'),
    `import fs from 'node:fs';import {value} from './value.mjs';if(value!==2||(fs.existsSync(${JSON.stringify(path.join(root,'post-failure'))})&&!fs.readFileSync('value.mjs','utf8').includes('second-pass'))){console.error('BUG');process.exit(1)}`);
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const options={specsRoot,identity:{repositoryId:'fixture',runId:'observe-run',taskId:'T-FIX-intermittent',attempt:1},create:true,
    configuration:{hostContextId:'fixture-host',defect:'Intermittent wrong result',reproduction:{cwd,
      command:[process.execPath,'-e',"const fs=require('node:fs');fs.appendFileSync('visits','1');if(fs.existsSync('trigger')){console.error('BUG');process.exit(1)}"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}}};
  options.configuration.redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000};
  options.configuration.baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000};
  options.configuration.repair={scope:['value.mjs'],requirements:['value.mjs']};
  options.configuration.causeReview={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',contextId:'cause-context',excludedThreadIds:[]};
  options.configuration.walkthrough={timeoutMs:2000,flows:[{id:'value-flow',modules:['one'],steps:['Read value'],expected:['Value is 2'],kind:'commands',command:[process.execPath,'red.mjs']}]};
  if(mode==='walk-failure')options.configuration.walkthrough.flows[0].command=[process.execPath,'-e',"if(!require('node:fs').readFileSync('value.mjs','utf8').includes('second-pass'))process.exit(1)"];
  const learning={files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}};
  let owner;
  const reviewRecoveredCause=async(correction=false)=>{
    const required=correction?'observation_cause_review_correction_required':'cause_review_required';
    const resumed=typeof correction==='string'?correction:correction?'repair_required':'red_test_required';
    assert.equal(owner.status().stage,required);
    assert.equal((await owner.runRedTest({authorized:true})).stage,required);
    const pkg=owner.causeReviewPackage(),reviewer=options.configuration.causeReview;
    const priorHandoff=resumed==='final_review_required'?fs.readFileSync(path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a1-handoff.json')):null;
    if(priorHandoff)assert.equal(pkg.correction.handoffSha256,owner.status().handoff.handoffSha256);
    const authority=createHostReviewAuthority({hostContextId:options.configuration.hostContextId,
      reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
    if(correction){assert.equal(pkg.correction.reason,'observation_cause_review_omitted');assert.equal(pkg.correction.resumeStage,resumed);}
    if(resumed==='regression_required'){
      const change=pkg.correction.repairPackage.changes.find(row=>row.path==='value.mjs');
      assert.equal(Buffer.from(change.before.contentBase64,'base64').toString(),'export const value=1;');
      assert.equal(Buffer.from(change.after.contentBase64,'base64').toString(),'export const value=2;');
      assert.equal(pkg.correction.repairPackage.checks[0].id,'reproduction-before-repair');
      assert.equal(pkg.correction.repairPackage.checks[0].outcome,'failed');
    }
    if(resumed==='handoff_ready'){
      assert(pkg.correction.repairPackage.checks.every(row=>row.outcome==='passed'));
      if(mode==='late-learning')assert(pkg.correction.repairPackage.changes.some(row=>row.path==='AGENTS.md'));
    }
    let calls=0;
    const causeReview={authorize:authority.authorize,run:async(request,{onEvent})=>{
      calls++;
      if(resumed==='completion_gate_required'){
        assert.equal(pkg.correction.finalReview.providerThreadId,'synthetic-recovery-reviewer');
        assert(causeExpectation(request,options.configuration).excludedThreadIds.includes('synthetic-recovery-reviewer'));
      }
      for(const event of [{event:'thread.started',provider_thread:'synthetic-observation-cause'},
        {event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
        {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
      return {status:'succeeded',value:{verdict:'approved',packageDigest:pkg.packageDigest,
        examinedPaths:['value.mjs'],findings:[],summary:'Synthetic recovered cause review'}};
    }};
    owner.close();owner=openFixExecution({...options,create:false},{causeReview});
    if(correction){
      assert.equal((await owner.reviewCause()).reason,'permission_denied');assert.equal(calls,0);
      assert.equal(owner.status().stage,required);
    }
    await authority.hostDecisionProvider.decide({identity:options.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    assert.equal((await owner.reviewCause()).stage,resumed);
    owner.close();owner=openFixExecution({...options,create:false},{causeReview});
    assert.equal((await owner.reviewCause()).stage,resumed);assert.equal(calls,1);
    if(priorHandoff)assert.deepEqual(fs.readFileSync(path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a1-handoff.json')),priorHandoff);
  };
  const completeRecovery=async(prefixBytes,archivePath,exitCount)=>{
      const pkg=owner.finalReviewPackage(),cfg=fixFinalReviewConfiguration(options.configuration);
      const authority=createHostReviewAuthority({hostContextId:cfg.hostContextId,reviewerId:cfg.reviewer.reviewerId,adapterId:cfg.reviewer.adapterId,decide:async()=>({status:'approved'})});
      await authority.hostDecisionProvider.decide({identity:options.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
      let calls=0;owner.close();owner=openFixExecution({...options,create:false},{assertReviewReady(){},finalReview:{authorize:authority.authorize,run:async(request,{onEvent})=>{
        calls++;
        for(const event of [{event:'thread.started',provider_thread:'synthetic-recovery-reviewer'},{event:'turn.started',item_type:null},
          {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
        return {status:'succeeded',value:{verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'Synthetic fixture only'}};
      }}});
      await owner.reviewFinal();owner.publishReview();
      if(mode==='late-final'){
        const stateFile=path.join(specsRoot,'.reviews','.execution',options.identity.runId,'state.json');
        const old=JSON.parse(fs.readFileSync(stateFile));
        old.records=old.records.filter(row=>!row.id.startsWith('fix-cause-'));
        let previousDigest=null;
        old.records=old.records.map((row,index)=>{
          const {digest:ignored,...value}=row;value.seq=index+1;value.previousDigest=previousDigest;
          previousDigest=digest(value);return {...value,digest:previousDigest};
        });
        const {revision:ignored,...value}=old;old.revision=digest(value);
        const finalFile=path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-r1.md'),finalBytes=fs.readFileSync(finalFile);
        owner.close();fs.writeFileSync(stateFile,JSON.stringify(old)+'\n');
        fs.unlinkSync(path.join(specsRoot,'.reviews','fix-intermittent-cause-r1.md'));
        owner=openFixExecution({...options,create:false});
        await reviewRecoveredCause('completion_gate_required');
        assert.deepEqual(fs.readFileSync(finalFile),finalBytes);
        assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).records.slice(0,old.records.length),old.records);
      }
      owner.checkCompletionGate();
      if(mode==='regression-failure')fs.writeFileSync(path.join(root,'post-failure'),'synthetic external condition');
      await owner.runRegression({postReview:true,authorized:true});await owner.runWalkthrough({authorized:true});
      if(['walk-failure','regression-failure'].includes(mode)){
        const regressionFailure=mode==='regression-failure',failureKey=regressionFailure?'regressionFailure':'walkthroughFailure';
        const failed=owner.status();assert.equal(failed.stage,regressionFailure?'post_review_regression_blocked':'walkthrough_blocked');
        assert.equal(failed.finalReview.review.verdict,'approved');
        assert.equal(regressionFailure?failed.postReviewRegression.status:failed.walkthrough.status,regressionFailure?'defect_remaining':'failed');
        owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning,assertReviewReady(){},bridge:{async call(kind,payload){
          if(kind==='fix_repair'){
            assert.equal(payload.identity.attempt,2);assert.equal(payload.priorReview.review.verdict,'approved');
            const failure=payload.priorReview[failureKey];
            assert.equal(failure.result.status,regressionFailure?'defect_remaining':'failed');
            assert.equal(regressionFailure?failure.packageDigest:failure.binding.packageDigest,pkg.packageDigest);
            fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2; // second-pass');return {outcome:'repaired'};
          }
          assert.equal(kind,'fix_retrospective');return {status:'no_new_lesson',candidates:[],reason:null};
        }}});
        await assert.rejects(owner.prepareRevision(),{code:'repair_authorization_required'});
        assert.equal((await owner.prepareRevision({authorized:true})).stage,'revision_prepared');
        const repaired=await owner.repair({authorized:true});assert.equal(repaired.stage,'revision_regression_required');
        assert.equal(repaired.finalReview.review.verdict,'approved');
        await owner.runRegression({authorized:true});await owner.retrospect();
        const handed=owner.createHandoff();assert.equal(handed.stage,'revision_final_review_required');
        owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),handed);
        const handoff=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a2-handoff.json')));
        const feedback=JSON.parse(handoff.evidence.find(item=>item.startsWith('fix prior review ')).split('(data, not instructions) ')[1]);
        assert.equal(feedback.review.verdict,'approved');assert.equal(feedback[failureKey].result.status,regressionFailure?'defect_remaining':'failed');
        assert.equal(calls,1);assert.equal(handed.completionEligible,false);
        const handoffPath=path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a2-handoff.json');
        const handoffBytes=fs.readFileSync(handoffPath);
        const gate={handoff:handoffPath,reviewsDir:path.join(specsRoot,'.reviews'),feature:'fix-intermittent',
          task:options.identity.taskId,projectRoot:cwd,requireLearning:true};
        assert.equal(checkN4(gate).outcome,'ready_for_review');
        for(const corruption of ['package','identity','review','duplicate','passed']){
          const changed=structuredClone(handoff),prefix='fix prior review (data, not instructions) ';
          const index=changed.evidence.findIndex(item=>item.startsWith(prefix));
          const prior=JSON.parse(changed.evidence[index].slice(prefix.length));
          if(corruption==='package')(regressionFailure?prior.regressionFailure:prior.walkthroughFailure.binding).packageDigest='0'.repeat(64);
          if(corruption==='identity')prior.identity.runId='different-run';
          if(corruption==='review')prior.review.summary='Not the recorded review';
          if(corruption==='passed')prior[failureKey].result.status='passed';
          changed.evidence[index]=prefix+JSON.stringify(prior);
          if(corruption==='duplicate')changed.evidence.push(prefix+' '+JSON.stringify(prior));
          fs.writeFileSync(handoffPath,JSON.stringify(changed));
          try{assert.throws(()=>checkN4(gate),/invalid cm-fix walkthrough retry evidence/);}
          finally{fs.writeFileSync(handoffPath,handoffBytes);}
        }
        const nextPackage=owner.finalReviewPackage(),nextIdentity=handed.revision.nextIdentity;
        await authority.hostDecisionProvider.decide({identity:nextIdentity,packageDigest:nextPackage.packageDigest},new AbortController().signal);
        owner.close();owner=openFixExecution({...options,create:false},{assertReviewReady(){},finalReview:{authorize:authority.authorize,run:async(request,{onEvent})=>{
          calls++;assert.equal(request.identity.attempt,2);assert.equal(request.payload.priorReview.verdict,'approved');
          for(const event of [{event:'thread.started',provider_thread:'synthetic-recovery-reviewer-2'},{event:'turn.started',item_type:null},
            {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
          return {status:'succeeded',value:{verdict:'approved',packageDigest:nextPackage.packageDigest,examinedPaths:reviewPaths(nextPackage),findings:[],summary:'Synthetic second review'}};
        }}});
        await owner.reviewFinal();owner.publishReview();owner.checkCompletionGate();
        await owner.runRegression({postReview:true,authorized:true});await owner.runWalkthrough({authorized:true});
        assert.equal(owner.status().revisionWalkthrough.status,'passed');
        const completed=owner.finish({authorized:true});assert.equal(completed.stage,'completed');assert.equal(completed.completionEligible,true);
        const evidence=owner.completionEvidence();
        assert.equal(evidence.identity.attempt,2);
        assert.equal(evidence.reviewPackage.packageDigest,completed.revisionN5.packageDigest);
        assert.equal(evidence.handoffSha256,completed.revisionHandoff.handoffSha256);
        assert.equal(regressionFailure?completed.postReviewRegression.status:completed.walkthrough.status,regressionFailure?'defect_remaining':'failed');
        assert.equal(completed.revisionWalkthrough.status,'passed');
        const final=fs.readFileSync(archivePath);assert(final.subarray(0,prefixBytes.length).equals(prefixBytes));
        const priorSection=final.toString().split('## 先前轮次（历史记录，不替代当前审查）\n\n')[1].split('\n## ')[0];
        const prior=JSON.parse(priorSection.split('\n').map(line=>line.startsWith('    ')?line.slice(4):line).join('\n').trim());
        assert.equal(prior[0].finalReview.review.verdict,'approved');
        assert.equal(regressionFailure?prior[0].postReviewRegression.status:prior[0].walkthrough.status,regressionFailure?'defect_remaining':'failed');
        owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),completed);
        assert.deepEqual(owner.finish({authorized:true}),completed);assert.equal(calls,2);
        const log=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
        const done=log.filter(row=>row.event==='task_done');assert.equal(done.length,1);assert.equal(done[0].attempt,2);
        assert.equal(log.filter(row=>row.event==='review'&&row.phase==='complete'&&row.result==='approved').length,2);
        fs.appendFileSync(archivePath,' drift');assert.equal(owner.status().completionEligible,false);return;
      }
      const continued=owner.publishDossier();assert.equal(continued.dossier.path,archivePath);
      const draft=fs.readFileSync(continued.dossier.path);assert(draft.subarray(0,prefixBytes.length).equals(prefixBytes));
      assert(draft.toString().includes('cm-fix-recovery'));assert(draft.toString().includes('收尾待完成'));
      fs.appendFileSync(continued.dossier.path,'User continuation');assert.throws(()=>owner.finish({authorized:true}),{code:'review_file_conflict'});
      fs.writeFileSync(continued.dossier.path,draft);
      const completed=owner.finish({authorized:true});assert.equal(completed.stage,'completed');assert.equal(completed.completionEligible,true);
      const evidence=owner.completionEvidence();
      assert.equal(evidence.kind,'cm-fix-completion-evidence');assert.equal(evidence.qaSource,null);
      assert.deepEqual(evidence.identity,options.identity);
      assert.equal(evidence.reviewPackage.packageDigest,completed.n5.packageDigest);
      assert.equal(evidence.handoffSha256,completed.handoff.handoffSha256);
      assert.deepEqual(evidence.completionHistory,completed.completionHistory);
      const final=fs.readFileSync(continued.dossier.path);assert(final.subarray(0,prefixBytes.length).equals(prefixBytes));assert(final.toString().includes('验证收口'));
      owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),completed);
      assert.deepEqual(owner.finish({authorized:true}),completed);assert.equal(calls,1);
      const finalLog=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(finalLog.filter(row=>row.event==='run_done').length,exitCount+1);assert.equal(finalLog.filter(row=>row.event==='task_done').length,1);
      if(mode==='late-final'){
        const stateFile=path.join(specsRoot,'.reviews','.execution',options.identity.runId,'state.json');
        const original=fs.readFileSync(stateFile),old=JSON.parse(original);
        old.records=old.records.filter(row=>!row.id.startsWith('fix-cause-'));
        let previousDigest=null;
        old.records=old.records.map((row,index)=>{
          const {digest:ignored,...value}=row;value.seq=index+1;value.previousDigest=previousDigest;
          previousDigest=digest(value);return {...value,digest:previousDigest};
        });
        const {revision:ignored,...value}=old;old.revision=digest(value);
        owner.close();fs.writeFileSync(stateFile,JSON.stringify(old)+'\n');owner=openFixExecution({...options,create:false});
        const blocked=owner.status();assert.equal(blocked.causeReviewCorrection,undefined);
        assert.equal(blocked.completionEligible,false);assert.equal(blocked.completionHistory.taskDoneEventIds.length,1);
        assert.throws(()=>owner.causeReviewPackage(),{code:'fix_cause_review_unavailable'});
        owner.close();assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),old);
        fs.writeFileSync(stateFile,original);owner=openFixExecution({...options,create:false});
      }
      fs.appendFileSync(continued.dossier.path,' drift');assert.equal(owner.status().completionEligible,false);
      assert.throws(()=>owner.completionEvidence(),{code:'fix_completion_evidence_unavailable'});
  };
  try{
    owner=openFixExecution(options,{prepare:async()=>learning});
    assert.throws(()=>owner.completionEvidence(),{code:'fix_completion_evidence_unavailable'});
    assert.throws(()=>owner.publishDossier(),{code:'fix_closeout_unavailable'});
    assert.equal((await owner.advance({authorized:true})).stage,'observation');
    const archived=owner.publishDossier(),bytes=fs.readFileSync(archived.dossier.path);
    assert.equal(archived.stage,'observation');assert.equal(archived.completionEligible,false);
    assert.equal((fs.statSync(archived.dossier.path).mode&0o777),0o600);
    assert.match(bytes.toString(),/观测中/);assert.match(bytes.toString(),/not_reproduced/);assert.match(bytes.toString(),/等待证据/);
    assert.equal(archived.diagnosis,null);
    owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.publishDossier(),archived);
    await owner.advance({authorized:true});assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    assert.throws(()=>owner.finish(),{code:'fix_finish_authorization_required'});
    assert(!fs.existsSync(path.join(specsRoot,'METRICS.md')));assert(!fs.existsSync(path.join(specsRoot,'运行日志.jsonl')));
    fs.renameSync(archived.dossier.path,path.join(root,'saved.md'));
    assert.deepEqual(owner.publishDossier(),archived);assert.deepEqual(fs.readFileSync(archived.dossier.path),bytes);
    fs.appendFileSync(archived.dossier.path,'User note');assert.throws(()=>owner.publishDossier(),{code:'review_file_conflict'});
    assert(fs.readFileSync(archived.dossier.path,'utf8').endsWith('User note'));
    assert.throws(()=>owner.finish({authorized:true}),{code:'review_file_conflict'});
    assert(!fs.existsSync(path.join(specsRoot,'运行日志.jsonl')));
    const legacy=Buffer.from(bytes.toString().replace('观测退出以原运行日志为准；收到新证据后的恢复','观测退出日志、收到新证据后的恢复'));
    fs.writeFileSync(archived.dossier.path,legacy);assert.deepEqual(fs.readFileSync(owner.publishDossier().dossier.path),legacy);
    startFixRun({specsRoot,identity:options.identity,configuration:options.configuration});
    const ended=owner.finish({authorized:true});assert.equal(ended.stage,'observation');assert.equal(ended.completionEligible,false);assert.equal(ended.observationRunEnded,true);
    // Reopen without an explicit close proves finish released the writer lock.
    owner=openFixExecution({...options,create:false});assert.deepEqual(owner.finish({authorized:true}),ended);
    const log=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.filter(row=>row.event==='run_done').length,1);assert(!log.some(row=>row.event==='task_done'));
    const event=log.find(row=>row.event==='run_done');assert.equal(event.phase,'observation');assert.equal(event.result,'observing');
    assert.equal(event.dossier_sha256,ended.dossier.sha256);assert(event.detail.startsWith('观测中:等'));
    assert(!fs.existsSync(path.join(specsRoot,'METRICS.md')));
    owner=openFixExecution({...options,create:false});
    fs.writeFileSync(archived.dossier.path,bytes);
    assert.throws(()=>owner.finish({authorized:true}),{code:'fix_observation_exit_conflict'});
    assert.equal(fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.event==='run_done').length,1);
    fs.writeFileSync(archived.dossier.path,legacy);
    fs.writeFileSync(path.join(specsRoot,'failure.txt'),'BUG: new observed failure, synthetic fixture');
    assert.throws(()=>owner.resume({evidenceFiles:['failure.txt']}),{code:'fix_execution_authorization_required'});
    assert.throws(()=>owner.resume({authorized:true,evidenceFiles:[]}),{code:'fix_observation_evidence_required'});
    assert.throws(()=>owner.resume({authorized:true,evidenceFiles:['运行日志.jsonl']}),{code:'fix_observation_evidence_required'});
    fs.symlinkSync(path.join(root,'saved.md'),path.join(specsRoot,'outside.txt'));
    assert.throws(()=>owner.resume({authorized:true,evidenceFiles:['outside.txt']}));
    const prepared=owner.resume({authorized:true,evidenceFiles:['failure.txt']});
    assert.equal(prepared.stage,'observation_resume_prepared');assert.equal(prepared.identity.attempt,1);assert.equal(prepared.completionEligible,false);
    assert.equal(prepared.observationResume.eventId,event.event_id);assert.equal(prepared.observationResume.dossier.sha256,event.dossier_sha256);
    assert.deepEqual(prepared.reproduction,archived.reproduction);
    owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),prepared);
    assert.deepEqual(owner.resume({authorized:true,evidenceFiles:['failure.txt']}),prepared);
    await assert.rejects(owner.advance(),{code:'fix_execution_authorization_required'});assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    fs.appendFileSync(path.join(specsRoot,'failure.txt'),' changed');assert.equal(owner.status().stage,'observation_resume_evidence_required');
    assert.throws(()=>owner.resume({authorized:true,evidenceFiles:['failure.txt']}),{code:'fix_observation_resume_unavailable'});
    fs.writeFileSync(path.join(specsRoot,'failure.txt'),'BUG: new observed failure, synthetic fixture');
    if(mode!=='unreproduced')fs.writeFileSync(path.join(cwd,'trigger'),'fixture event now occurs');
    const finishWaiting=()=>{
      const before=owner.status(),draft=owner.publishDossier();
      const continued=fs.readFileSync(draft.dossier.path);
      assert.equal(draft.dossier.path,archived.dossier.path);
      assert.deepEqual(continued.subarray(0,legacy.length),legacy);
      assert.match(continued.toString(),/恢复观测（仍未完成）/);
      fs.appendFileSync(draft.dossier.path,'user note');
      assert.throws(()=>owner.finish({authorized:true}),{code:'review_file_conflict'});
      fs.writeFileSync(draft.dossier.path,continued);
      assert.throws(()=>owner.finish(),{code:'fix_finish_authorization_required'});
      const endedAgain=owner.finish({authorized:true});
      assert.equal(endedAgain.stage,before.stage);assert.equal(endedAgain.completionEligible,false);
      assert.equal(endedAgain.observationRunEnded,true);
      owner=openFixExecution({...options,create:false});assert.deepEqual(owner.finish({authorized:true}),endedAgain);
      const rows=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const exits=rows.filter(row=>row.event==='run_done');
      assert.equal(exits.length,2);assert.equal(exits[1].resume_digest,digest(prepared.observationResume));
      assert.equal(exits[1].observation_exit_event_id,event.event_id);assert.equal(exits[1].dossier_sha256,draft.dossier.sha256);
      assert(!rows.some(row=>row.event==='task_done'));assert(!fs.existsSync(path.join(specsRoot,'METRICS.md')));
      assert.equal(JSON.parse(fs.readFileSync(path.join(specsRoot,'.cm-run.json'))).status,'done');
      assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'11');
    };
    owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning});
    const reproduced=await owner.advance({authorized:true});
    if(mode==='unreproduced'){
      assert.equal(reproduced.stage,'observation_not_reproduced');finishWaiting();
      for(const cycle of [2,3]){
        fs.writeFileSync(path.join(specsRoot,`failure-${cycle}.txt`),`Additional synthetic evidence ${cycle}`);
        owner=openFixExecution({...options,create:false},{prepare:async()=>learning,bridge:{async call(){
          return {status:'diagnosed',rootCause:'Observed trigger',affectedPaths:['value.mjs'],affectedModules:['one'],plan:'Repair',crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
        }}});
        const beforeArchive=fs.readFileSync(archived.dossier.path);
        const next=owner.resume({authorized:true,evidenceFiles:[`failure-${cycle}.txt`]});
        assert.equal(next.observationCycle,cycle);assert.equal(next.identity.attempt,1);
        owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning});
        assert.deepEqual(owner.status(),next);
        if(cycle===3)fs.writeFileSync(path.join(cwd,'trigger'),'fixture event');
        const result=await owner.advance({authorized:true});
        assert.equal(result.stage,cycle===2?'observation_not_reproduced':'observation_diagnose_required');
        assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1'.repeat(cycle+1));
        if(cycle===2){
          const ended=owner.finish({authorized:true});
          const continued=fs.readFileSync(archived.dossier.path);
          assert.deepEqual(continued.subarray(0,beforeArchive.length),beforeArchive);
          owner=openFixExecution({...options,create:false});assert.deepEqual(owner.finish({authorized:true}),ended);
        }else{
          owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning,bridge:{async call(){
            return {status:'diagnosed',rootCause:'Observed trigger',affectedPaths:['value.mjs'],affectedModules:['one'],plan:'Repair',crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
          }}});
          assert.equal((await owner.advance({authorized:true})).stage,'cause_review_required');
          await reviewRecoveredCause();
          owner.close();owner=openFixExecution({...options,create:false});assert.equal(owner.status().stage,'red_test_required');
          const rows=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
          assert.equal(rows.filter(row=>row.event==='resume').length,3);
          assert.equal(rows.filter(row=>row.event==='run_done').length,3);
          assert.equal(rows.filter(row=>row.event==='task_start').length,1);
          assert(!rows.some(row=>row.event==='task_done'));
          owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning,assertReviewReady(){},bridge:{async call(kind){
            if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
            assert.equal(kind,'fix_retrospective');return {status:'no_new_lesson',candidates:[],reason:null};
          }}});
          await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});
          await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();
          const handed=owner.createHandoff();assert.equal(handed.stage,'final_review_required');
          const handoff=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a1-handoff.json')));
          const history=JSON.parse(handoff.evidence.find(item=>item.startsWith('fix prior observation archive ')).split('(data, not instructions) ')[1]);
          assert.deepEqual(Buffer.from(history.contentBase64,'base64'),beforeArchive);
          assert.equal(history.sha256,next.observationResume.dossier.sha256);
          owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),handed);
          fs.renameSync(archived.dossier.path,path.join(root,'multi-history.md'));
          assert.equal(owner.status().stage,'observation_resume_evidence_required');
          owner.close();owner=openFixExecution({...options,create:false});
          assert.equal(owner.status().stage,'observation_resume_evidence_required');
          fs.renameSync(path.join(root,'multi-history.md'),archived.dossier.path);
          fs.writeFileSync(archived.dossier.path,'changed historical prefix');
          assert.equal(owner.status().stage,'observation_resume_evidence_required');
          owner.close();owner=openFixExecution({...options,create:false});assert.equal(owner.status().stage,'observation_resume_evidence_required');
          fs.writeFileSync(archived.dossier.path,beforeArchive);assert.deepEqual(owner.status(),handed);
          await completeRecovery(beforeArchive,archived.dossier.path,3);
        }
      }
      return;
    }
    assert.equal(reproduced.stage,'observation_diagnose_required');
    assert.equal(JSON.parse(fs.readFileSync(path.join(specsRoot,'.cm-run.json'))).status,'running');
    assert.equal(reproduced.observationReproduction.status,'reproduced');assert.equal(reproduced.reproduction.status,'not_reproduced');
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'11');
    let diagnoses=0;owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning,bridge:{async call(kind,payload){
      diagnoses++;assert.equal(kind,'fix_diagnose');assert.equal(payload.reproduction.status,'reproduced');
      assert.equal(payload.observationEvidence.eventId,event.event_id);assert.equal(payload.observationEvidence.files[0].path,'failure.txt');
      if(mode==='lost')throw Object.assign(new Error('Synthetic host disconnected'),{code:'host_disconnected'});
      return {status:mode==='needs_evidence'?'needs_evidence':'diagnosed',rootCause:'Observed trigger',affectedPaths:['value.mjs'],affectedModules:['one'],plan:'Repair bounded trigger',crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
    }}});
    const diagnosed=await owner.advance({authorized:true});
    if(mode==='needs_evidence'){assert.equal(diagnosed.stage,'observation_needs_evidence');finishWaiting();return;}
    assert.equal(diagnosed.stage,mode==='lost'?'unknown':'cause_review_required');assert.equal(diagnosed.identity.attempt,1);
    if(mode==='lost')assert.equal(diagnosed.pending,'observation_diagnose');
    else{assert.equal(diagnosed.reproduction.status,'reproduced');assert.equal(diagnosed.observationDiagnosis.status,'diagnosed');}
    owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),diagnosed);
    assert.deepEqual(await owner.advance({authorized:true}),diagnosed);assert.equal(diagnoses,1);assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'11');
    const recoveredLog=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const resumes=recoveredLog.filter(row=>row.event==='resume');assert.equal(resumes.length,1);
    assert.equal(resumes[0].observation_exit_event_id,event.event_id);assert.equal(resumes[0].resume_digest,digest(prepared.observationResume));
    assert(recoveredLog.indexOf(resumes[0])>recoveredLog.findIndex(row=>row.event_id===event.event_id));
    assert.equal(recoveredLog.filter(row=>row.event==='task_start').length,1);assert(!recoveredLog.some(row=>row.event==='task_done'));
    if(['normal','late-final','late-repair','late-retrospective','late-learning','late-handoff','walk-failure','regression-failure'].includes(mode)){
      await reviewRecoveredCause();
      owner.close();owner=openFixExecution({...options,create:false},{prepare:async()=>learning,assertReviewReady(){},bridge:{async call(kind,payload){
        if(kind==='fix_repair'){assert.deepEqual(payload.scope,['value.mjs']);fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
        assert.equal(kind,'fix_retrospective');return mode==='late-learning'
          ?{status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Wrong constant',action:'Keep the red test',evidence:['red.mjs']}],reason:null}
          :{status:'no_new_lesson',candidates:[],reason:null};
      }}});
      await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});
      if(['normal','late-repair','late-retrospective','late-learning','late-handoff'].includes(mode)){
        if(mode!=='normal')assert.equal((await owner.repair({authorized:true})).stage,'regression_required');
        if(['late-retrospective','late-learning','late-handoff'].includes(mode)){
          await owner.runRegression({authorized:true});await owner.retrospect();
          if(mode==='late-learning')owner.writeLearning({authorized:true});
          assert.equal(owner.status().stage,'handoff_ready');
          if(mode==='late-handoff')assert.equal(owner.createHandoff().stage,'final_review_required');
        }
        // Model an older in-flight snapshot that legitimately recorded red/baseline
        // under the old implementation, but omitted the required cause review.
        const stateFile=path.join(specsRoot,'.reviews','.execution',options.identity.runId,'state.json');
        const original=fs.readFileSync(stateFile),old=JSON.parse(original);
        old.records=old.records.filter(row=>!row.id.startsWith('fix-cause-'));
        let previousDigest=null;
        old.records=old.records.map((row,index)=>{
          const {digest:ignored,...value}=row;value.seq=index+1;value.previousDigest=previousDigest;
          previousDigest=digest(value);return {...value,digest:previousDigest};
        });
        const {revision:ignored,...value}=old;old.revision=digest(value);
        owner.close();fs.writeFileSync(stateFile,JSON.stringify(old)+'\n');
        owner=openFixExecution({...options,create:false});
        const correction=owner.status();assert.equal(correction.stage,'observation_cause_review_correction_required');
        assert.equal(correction.completionEligible,false);assert.equal(correction.redTest.status,'red_confirmed');
        assert.equal((await owner.repair({authorized:true})).stage,correction.stage);
        owner.close();assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)),old);
        fs.unlinkSync(path.join(specsRoot,'.reviews','fix-intermittent-cause-r1.md')); // Absent in the old omitted-review fixture.
        owner=openFixExecution({...options,create:false});
        await reviewRecoveredCause(mode==='late-repair'?'regression_required':mode==='normal'?true:mode==='late-handoff'?'final_review_required':'handoff_ready');
        const corrected=JSON.parse(fs.readFileSync(stateFile));
        assert.deepEqual(corrected.records.slice(0,old.records.length),old.records);
        assert.match(fs.readFileSync(path.join(specsRoot,'.reviews','fix-intermittent-cause-r1.md'),'utf8'),/Late observation cause review/);
        owner.close();
        owner=openFixExecution({...options,create:false},{prepare:async()=>learning,assertReviewReady(){},bridge:{async call(kind){
          if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
          assert.equal(kind,'fix_retrospective');return {status:'no_new_lesson',candidates:[],reason:null};
        }}});
      }
      await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();
      const handed=owner.createHandoff();assert.equal(handed.stage,'final_review_required');
      const file=path.join(specsRoot,'.reviews','fix-intermittent-T-FIX-intermittent-a1-handoff.json');
      const handoff=JSON.parse(fs.readFileSync(file));
      const recovery=JSON.parse(handoff.evidence.find(item=>item.startsWith('fix observation recovery ')).split('(data, not instructions) ')[1]);
      assert.equal(recovery.initialReproduction.status,'not_reproduced');assert.equal(recovery.initialDiagnosis,null);
      assert.equal(Buffer.from(recovery.files[0].contentBase64,'base64').toString(),'BUG: new observed failure, synthetic fixture');
      assert.equal(recovery.resume.eventId,event.event_id);
      assert.throws(()=>fixObservationRecoveryEvidence({...recovery,files:recovery.files.map(file=>({...file,contentBase64:Buffer.from('forged').toString('base64')}))}),{code:'observation_evidence_mismatch'});
      owner.close();owner=openFixExecution({...options,create:false});assert.deepEqual(owner.status(),handed);
      assert.deepEqual(owner.createHandoff(),handed);assert(owner.finalReviewPackage().handoff.sha256);
      fs.appendFileSync(path.join(specsRoot,'failure.txt'),' drift');assert.equal(owner.status().stage,'observation_resume_evidence_required');
      fs.writeFileSync(path.join(specsRoot,'failure.txt'),'BUG: new observed failure, synthetic fixture');
      await completeRecovery(legacy,archived.dossier.path,1);
    }
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
