import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {main} from './cm-fix-host.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {checkN4} from './cm-task-gate.mjs';
import {fixCompletionProjection} from '../runtime/js/cm-fix/finish.mjs';
import {loadConfig,resolveRole} from './cm-workflow-config.mjs';

for(const runtime of ['codex','claude']){
test(`${runtime} CLI cause review requires opt-in and matching diagnostic, then resumes without dispatch`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-host-review-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const config=path.join(root,'config.json'),reviewConfig=path.join(root,'review.json');
  fs.writeFileSync(config,JSON.stringify({specsRoot,identity:{repositoryId:'fixture',runId:'fix-host-review',taskId:'T-FIX-demo',attempt:1},
    defect:'Synthetic constant',reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}}));
  const review={model:'synthetic-model',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic-model',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd,model:'synthetic-model',disabledSkills:[],promptTransport:'stdin'})}};
  if(runtime==='claude')review.preflight={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:review.model})};
  fs.writeFileSync(reviewConfig,JSON.stringify({...review,preflight:{...review.preflight,passed:false}}));
  const args=['serve','--config',config,'--mode','create','--host-context','fixture-host','--allow-reproduction','--review-config',reviewConfig];
  if(runtime==='claude')args.push('--runtime','claude');
  let calls=0;
  const reviewWorkerFactory=()=>async({prompt},{onEvent})=>{
    calls++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    for(const event of [{event:'thread.started',provider_thread:'fresh-cause-review'},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
      {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'Synthetic review no findings'}};
  };
  try{
    const discard=new Writable({write(c,e,cb){cb();}});
    assert.equal(await main([...args,'--allow-cause-review'],{error:discard,reviewWorkerFactory}),1);
    assert.equal(fs.existsSync(path.join(specsRoot,'.reviews')),false);assert.equal(calls,0);
    if(runtime==='claude'){
      const wrong={passed:true,cli_model:review.model,prompt_transport:'stdin',
        config_fingerprint:configFingerprint({cwd,model:review.model,disabledSkills:[],promptTransport:'stdin'})};
      fs.writeFileSync(reviewConfig,JSON.stringify({...review,preflight:wrong}));
      assert.equal(await main([...args,'--allow-cause-review'],{error:discard,reviewWorkerFactory}),1);
      fs.writeFileSync(reviewConfig,JSON.stringify({...review,disabledSkills:['/synthetic/unsupported-skill']}));
      assert.equal(await main([...args,'--allow-cause-review'],{error:discard,reviewWorkerFactory}),1);
      assert.equal(fs.existsSync(path.join(specsRoot,'.reviews')),false);assert.equal(calls,0);
    }
    fs.writeFileSync(reviewConfig,JSON.stringify(review));
    for(const pass of ['denied','allowed','resume']){
      args[4]=pass==='denied'?'create':'resume';
      const input=new PassThrough(),rows=[];
      const send=operation=>input.write(JSON.stringify({requestId:operation,operation})+'\n');
      const output=new Writable({write(chunk,enc,done){
        const row=JSON.parse(chunk.toString());rows.push(row);
        if(row.type==='host_ready')send(pass==='denied'?'advance':'cause_review');
        if(row.type==='host_request'){
          const result=row.kind==='fix_learning'?{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'No project instructions'}:
            {status:'diagnosed',rootCause:'Cross-layer constant',plan:'Correct after red test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};
          input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result})+'\n');
        }
        if(row.requestId==='advance')setImmediate(()=>send('cause_review'));
        if(row.requestId==='cause_review')input.end();
        done();
      }});
      assert.equal(await main(pass==='denied'?args:[...args,'--allow-cause-review'],{input,output,error:output,reviewWorkerFactory}),0);
      const result=rows.find(row=>row.requestId==='cause_review').result;
      assert.equal(result.stage,pass==='denied'?'cause_review_required':'red_test_required');
      if(pass==='denied')assert.equal(result.reason,'permission_denied');
      assert.equal(result.completionEligible,false);assert.equal(calls,pass==='denied'?0:1);
    }
    if(runtime==='claude'){
      const statePath=path.join(specsRoot,'.reviews','.execution','fix-host-review','state.json'),bytes=fs.readFileSync(statePath);
      const changed=args.map((value,index)=>index===args.indexOf('--runtime')+1?'codex':value);
      assert.equal(await main(changed,{error:discard,reviewWorkerFactory}),1);
      assert.deepEqual(fs.readFileSync(statePath),bytes);assert.equal(calls,1);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test(`${runtime} CLI stages independently authorize writes and synthetic final review, then resume without redispatch`,{timeout:15000},async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-host-author-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const config=path.join(root,'config.json'),reviewConfig=path.join(root,'review.json');
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  fs.writeFileSync(config,JSON.stringify({specsRoot,identity:{repositoryId:'fixture',runId:'fix-author-cli',taskId:'T-FIX-author',attempt:1},
    defect:'Synthetic',reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['regression.mjs'],command:[process.execPath,'regression.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    testAuthor:{requirements:['value.mjs']},repair:{scope:['value.mjs'],requirements:['value.mjs']},
    walkthrough:{timeoutMs:2000,flows:[{id:'value-flow',modules:['value'],steps:['Read the corrected value'],expected:['value is 2'],kind:'commands',command:[process.execPath,'regression.mjs']}]},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000}}));
  const review={model:'synthetic-model',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic-model',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd,model:'synthetic-model',disabledSkills:[],promptTransport:'stdin'})}};
  if(runtime==='claude')review.preflight={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:review.model})};
  const args=['serve','--config',config,'--mode','create','--host-context','fixture-host','--allow-reproduction','--review-config',reviewConfig];
  if(runtime==='claude')args.push('--runtime','claude');
  let providerCalls=0,writes=0,repairs=0,retrospectives=0;const reviewWorkerFactory=()=>async({prompt},{onEvent})=>{
    providerCalls++;
    const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);assert(data.reviewPackage.handoff);
    const handoff=JSON.parse(Buffer.from(data.reviewPackage.handoff.contentBase64,'base64').toString('utf8'));
    const defectEvidence=JSON.parse(handoff.evidence.find(item=>item.startsWith('fix defect evidence')).split('(data, not instructions) ')[1]);
    assert.equal(defectEvidence.redTest.result.status,'red_confirmed');
    assert.deepEqual(defectEvidence.diagnosis.investigation,{discardedAlternatives:[],boundaryAnalysis:null});
    assert.deepEqual(defectEvidence.redOutput,JSON.parse(fs.readFileSync(path.join(specsRoot,defectEvidence.redTest.result.output.path))));
    const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution','fix-author-cli','state.json')));
    assert.equal(state.records.at(-1).id,'fix-final-registered');
    for(const event of [{event:'thread.started',provider_thread:'actual-final-review'},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic final review'}};
  };
  try{
    fs.writeFileSync(reviewConfig,JSON.stringify({...review,preflight:{...review.preflight,passed:false}}));
    assert.equal(await main([...args,'--allow-test-author'],{reviewWorkerFactory,error:new Writable({write(c,e,cb){cb();}})}),1);
    assert.equal(await main([...args,'--allow-repair'],{reviewWorkerFactory,error:new Writable({write(c,e,cb){cb();}})}),1);
    assert.equal(await main([...args,'--allow-final-review'],{reviewWorkerFactory,error:new Writable({write(c,e,cb){cb();}})}),1);
    assert(!fs.existsSync(path.join(specsRoot,'.reviews')));assert.equal(providerCalls,0);
    fs.writeFileSync(reviewConfig,JSON.stringify(review));
    for(const pass of ['denied','allowed','repair','regression','writeback','final','resume']){
      args[4]=pass==='denied'?'create':'resume';
      const input=new PassThrough(),rows=[];const operations=pass==='denied'?['advance','author_tests']:['author_tests','red_test','baseline','repair','regression','retrospective','learning_writeback','handoff','final_review','publish_review','check_n5','post_review_regression'];let index=0;
      const next=()=>index<operations.length?input.write(JSON.stringify({requestId:operations[index],operation:operations[index++]})+'\n'):input.end();
      const output=new Writable({write(chunk,enc,done){
        const row=JSON.parse(chunk.toString());rows.push(row);if(row.type==='host_ready')setImmediate(next);
        if(row.type==='host_request'){
          let result=row.kind==='fix_learning'?{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'No instructions'}:
            {status:'diagnosed',rootCause:'Wrong constant',plan:'Correct after test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:false,
              investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
          if(row.kind==='fix_test_author'){
            writes++;fs.writeFileSync(path.join(cwd,'regression.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");result={outcome:'authored'};
          }
          if(row.kind==='fix_repair'){repairs++;fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');result={outcome:'repaired'};}
          if(row.kind==='fix_retrospective'){retrospectives++;result={status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Wrong constant',action:'Keep regression assertion',evidence:['regression.mjs']}],reason:null};}
          input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result})+'\n');
        }
        if(Object.hasOwn(row,'requestId'))setImmediate(next);done();
      }});
      const flags=pass==='denied'?[]:pass==='repair'?['--allow-repair']:pass==='regression'?['--allow-regression']:pass==='writeback'?['--allow-learning-writeback']:pass==='final'?['--allow-final-review']:['--allow-test-author','--allow-red-test','--allow-baseline',...(pass==='resume'?['--allow-repair','--allow-regression','--allow-learning-writeback','--allow-final-review']:[])];
      assert.equal(await main([...args,...flags],{input,output,error:output,reviewWorkerFactory}),0);
      if(pass==='denied'){assert(rows.find(row=>row.requestId==='author_tests').error);assert.equal(writes,0);}
      else{
        assert.equal(writes,1);
        if(pass==='allowed'){assert.equal(rows.find(row=>row.requestId==='baseline').result.stage,'repair_required');assert(rows.find(row=>row.requestId==='repair').error);assert.equal(repairs,0);}
        else{
          assert.equal(repairs,1);
          if(pass==='repair'){assert.equal(rows.find(row=>row.requestId==='repair').result.stage,'regression_required');assert(rows.find(row=>row.requestId==='regression').error);}
          else{
            const resumedStage=pass==='resume'?'post_review_regression_required':pass==='final'?'final_review_required':null;
            assert.equal(rows.find(row=>row.requestId==='regression').result.stage,resumedStage??(pass==='writeback'?'learning_writeback_required':'handoff_required'));
            assert.equal(rows.find(row=>row.requestId==='retrospective').result.stage,resumedStage??'learning_writeback_required');assert.equal(retrospectives,1);
            if(pass==='regression'){assert(rows.find(row=>row.requestId==='learning_writeback').error);assert(!fs.existsSync(path.join(cwd,'AGENTS.md')));}
            else{
              assert.equal(rows.find(row=>row.requestId==='learning_writeback').result.stage,resumedStage??'handoff_ready');
              assert.equal(rows.find(row=>row.requestId==='handoff').result.stage,pass==='resume'?'post_review_regression_required':'final_review_required');assert(fs.existsSync(path.join(cwd,'AGENTS.md')));
              if(pass==='writeback')assert.equal(rows.find(row=>row.requestId==='final_review').result.reason,'permission_denied');
              if(pass==='final'||pass==='resume'){
                assert.equal(rows.find(row=>row.requestId==='final_review').result.stage,pass==='resume'?'post_review_regression_required':'final_review_evidence_required');
                assert.equal(rows.find(row=>row.requestId==='publish_review').result.stage,pass==='resume'?'post_review_regression_required':'completion_gate_required');
                assert.equal(rows.find(row=>row.requestId==='publish_review').result.completionEligible,false);
                assert.equal(rows.find(row=>row.requestId==='check_n5').result.stage,'post_review_regression_required');
                if(pass==='final'){
                  assert.equal(rows.find(row=>row.requestId==='post_review_regression').error.code,'host_request_failed');
                  const state=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution','fix-author-cli','state.json')));
                  assert(!state.records.some(record=>record.id==='fix-post-regression-intent'));
                }
                else{
                  assert.equal(rows.find(row=>row.requestId==='post_review_regression').result.stage,'closeout_required');
                  assert.equal(rows.find(row=>row.requestId==='post_review_regression').result.completionEligible,false);
                }
              }
            }
            assert.equal(rows.find(row=>row.requestId==='regression').result.completionEligible,false);
          }
        }
      }
      assert.equal(providerCalls,pass==='final'||pass==='resume'?1:0);
    }
    const reviewsDir=path.join(specsRoot,'.reviews'),reviewPath=path.join(reviewsDir,'fix-author-T-FIX-author-r1.md');
    const gateOptions={reviewsDir,handoff:path.join(reviewsDir,'fix-author-T-FIX-author-a1-handoff.json'),feature:'fix-author',task:'T-FIX-author',projectRoot:cwd,requireLearning:true};
    assert.doesNotThrow(()=>checkN4(gateOptions));
    const bytes=fs.readFileSync(reviewPath),state=JSON.parse(fs.readFileSync(path.join(reviewsDir,'.execution','fix-author-cli','state.json')));
    const saved=state.records[0].payload;
    let owner=openFixExecution({specsRoot,identity:saved.identity,configuration:saved.configuration,create:false});
    try{
      const closed=owner.status();assert.equal(closed.stage,'closeout_required');assert.equal(closed.n5.gate.outcome,'approved');
      assert.deepEqual(await owner.runRegression({authorized:true,postReview:true}),closed);
      assert.throws(()=>owner.publishDossier(),{code:'walkthrough_required'});
      await assert.rejects(()=>owner.runWalkthrough(),{code:'walkthrough_authorization_required'});
      owner.close();const walkInput=new PassThrough(),walkRows=[];
      const walkOutput=new Writable({write(chunk,encoding,done){
        const row=JSON.parse(chunk.toString());walkRows.push(row);
        if(row.type==='host_ready')walkInput.write(JSON.stringify({requestId:'walk',operation:'walkthrough'})+'\n');
        if(row.requestId==='walk')walkInput.end();done();
      }});
      assert.equal(await main([...args,'--allow-walkthrough'],{input:walkInput,output:walkOutput,error:walkOutput,reviewWorkerFactory}),0);
      const walked=walkRows.find(row=>row.requestId==='walk').result;assert.equal(walked.walkthrough.status,'passed');assert.equal(walked.completionEligible,false);
      owner=openFixExecution({specsRoot,identity:saved.identity,configuration:saved.configuration,create:false});
      assert.deepEqual(await owner.runWalkthrough({authorized:true}),walked);
      const archived=owner.publishDossier();assert.equal(archived.stage,'closeout_required');assert.equal(archived.completionEligible,false);
      const dossierBytes=fs.readFileSync(archived.dossier.path);
      assert.equal(fs.statSync(archived.dossier.path).mode&0o777,0o600);
      assert.match(dossierBytes.toString(),/关键流程走查/);assert.match(dossierBytes.toString(),/stdoutBase64/);
      assert.match(dossierBytes.toString(),/诊断记录明确未放弃其他方案/);assert(!dossierBytes.toString().includes('放弃方案：当前宿主记录未提供'));
      assert.deepEqual(owner.publishDossier(),archived);
      fs.renameSync(archived.dossier.path,path.join(root,'saved-dossier.md'));
      assert.deepEqual(owner.publishDossier(),archived);assert.deepEqual(fs.readFileSync(archived.dossier.path),dossierBytes);
      fs.appendFileSync(archived.dossier.path,'conflict');assert.throws(()=>owner.publishDossier(),{code:'review_file_conflict'});
      fs.renameSync(reviewPath,path.join(root,'saved-review.md'));assert.equal(owner.status().stage,'final_review_evidence_required');
      assert.throws(()=>owner.publishDossier(),{code:'fix_closeout_unavailable'});
      assert.equal(owner.publishReview().stage,'closeout_required');assert.deepEqual(fs.readFileSync(reviewPath),bytes);assert.equal(providerCalls,1);
      const logs=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert(logs.every(row=>row.runtime===runtime));
      const routes=logs.filter(row=>row.event==='decision'&&row.phase==='route');
      assert.equal(routes.length,3);
      for(const row of routes){
        const expected=resolveRole(loadConfig({projectRoot:cwd}),row.role,runtime);
        assert.equal(row.adapter,expected.adapter);assert.equal(row.route_state,expected.route_state);
      }
      const reviews=logs.filter(row=>row.event==='review');assert.equal(reviews.length,1);
      assert.equal(reviews[0].node,'FIX');assert.equal(reviews[0].result,'approved');assert.equal(reviews[0].package_digest,walked.n5.packageDigest);
      assert.equal(reviews[0].provider,runtime);
      assert(bytes.toString().includes(`reviewer: ${runtime}-cli`));
      assert.equal(logs.filter(row=>row.event==='task_start').length,1);
      assert(!logs.some(row=>['task_done','run_done'].includes(row.event)));
      fs.appendFileSync(reviewPath,'conflicting bytes');assert.equal(owner.status().stage,'final_review_evidence_required');
      assert.throws(()=>owner.publishReview(),{code:'review_file_conflict'});assert.equal(owner.status().finalReview.review.verdict,'approved');
      fs.writeFileSync(reviewPath,bytes);fs.writeFileSync(archived.dossier.path,dossierBytes);
      assert.throws(()=>owner.finish(),{code:'fix_finish_authorization_required'});
      fs.writeFileSync(path.join(specsRoot,'METRICS.md'),'User custom table, not recognized.\n');
      assert.throws(()=>owner.finish({authorized:true}),{code:'metrics_table_invalid'});
      assert.equal(owner.status().stage,'closeout_incomplete');assert.equal(owner.status().completionHistory.taskDoneEventIds.length,1);
      owner.close();owner=openFixExecution({specsRoot,identity:saved.identity,configuration:saved.configuration,create:false});
      assert.equal(owner.status().stage,'closeout_incomplete');
      fs.renameSync(path.join(specsRoot,'METRICS.md'),path.join(root,'user-metrics.md'));
      owner.close();const finishInput=new PassThrough(),finishRows=[];
      const finishOutput=new Writable({write(chunk,encoding,done){
        const row=JSON.parse(chunk.toString());finishRows.push(row);
        if(row.type==='host_ready')finishInput.write(JSON.stringify({requestId:'finish',operation:'finish'})+'\n');
        if(row.requestId==='finish')finishInput.end();done();
      }});
      assert.equal(await main([...args,'--allow-finish'],{input:finishInput,output:finishOutput,error:finishOutput,reviewWorkerFactory}),0);
      const completed=finishRows.find(row=>row.requestId==='finish').result;assert.equal(completed.stage,'completed');assert.equal(completed.completionEligible,true);
      owner=openFixExecution({specsRoot,identity:saved.identity,configuration:saved.configuration,create:false});
      assert.deepEqual(owner.status(),completed);assert.deepEqual(owner.finish({authorized:true}),completed);
      assert.equal(fixCompletionProjection({specsRoot,identity:saved.identity,status:{...completed,stage:'closeout_required',completionEligible:false,walkthrough:null}}).stage,'closeout_incomplete');
      const finalLogs=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert(finalLogs.every(row=>row.runtime===runtime));
      assert.equal(finalLogs.filter(row=>row.event==='task_done').length,1);assert.equal(finalLogs.filter(row=>row.event==='run_done').length,1);
      assert.match(fs.readFileSync(archived.dossier.path,'utf8'),/验证收口/);assert.equal(providerCalls,1);
      fs.appendFileSync(path.join(cwd,'value.mjs'),' ');assert.equal(owner.status().stage,'learning_writeback_evidence_required');
      assert.deepEqual(owner.status().completionHistory,completed.completionHistory);assert.equal(owner.status().completionEligible,false);
    }finally{owner.close();}
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
}
