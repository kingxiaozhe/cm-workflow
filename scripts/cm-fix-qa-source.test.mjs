import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {recordCmAiQaDecision,recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {readHostQaFixHandoff} from '../runtime/js/cm-ai/host-qa-fix.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {qaFixIdentity,inspectFixQaSource} from '../runtime/js/cm-fix/qa-source.mjs';
import {main} from './cm-fix-host.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {bindQaFixDefinition} from '../runtime/js/cm-ai/qa-fix-definition.mjs';

for(const mode of ['normal','diagnosis drift','parent dispatch','parent cancel','parent observation'])
test(`QA child uses original owner lock, bound failure and explicit CLI authority: ${mode}`,async()=>{
  const drift=mode==='diagnosis drift';
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-qa-source-')));
  const specsRoot=path.join(root,'specs'),cwd=path.join(root,'code'),logHome=path.join(root,'logs');
  fs.mkdirSync(path.join(specsRoot,'.reviews'),{recursive:true});fs.mkdirSync(cwd);
  const parent={repositoryId:'qa-parent',runId:'qa-parent-run',taskId:'T-001',attempt:2};
  const binding={specsDir:specsRoot,codeProject:cwd,feature:'1.work',identity:parent,packageDigest:'a'.repeat(64)};
  const report=path.join(specsRoot,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic QA FAIL');
  recordCmAiQaDecision({...binding,logHome,decision:{decisionId:'qa-decision',identity:parent,
    packageDigest:binding.packageDigest,status:'triggered',reason:'fixture',score:null,at:'2026-09-08T01:00:00Z'}});
  const qa={...binding,mode:'commands',caseCount:1,testRunId:'qa-round-1',logHome};
  recordCmAiQaRun({...qa,phase:'start'});
  recordCmAiQaRun({...qa,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
  const handoff=readHostQaFixHandoff({...binding,testRunId:qa.testRunId});
  const qaSource={feature:binding.feature,identity:parent,packageDigest:binding.packageDigest,
    testRunId:qa.testRunId,handoffDigest:handoff.handoffDigest};
  const identity=qaFixIdentity(qaSource);
  const configuration={hostContextId:'qa-host',qaSource,defect:'Synthetic failure',
    reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],
      expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  if(mode.startsWith('parent ')){
    if(mode==='parent observation')configuration.reproduction.command=[process.execPath,'-e','process.exit(0)'];
    fs.writeFileSync(path.join(cwd,'red.mjs'),"console.error('BUG');process.exit(1)");
    fs.writeFileSync(path.join(cwd,'existing.mjs'),'process.exit(0)');
    configuration.redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000};
    configuration.baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000};
  }
  const options={specsRoot,identity,configuration,create:true};let parentOwner,child;
  try{
    const {qaSource:ignored,...templateConfiguration}=configuration;
    const template={specsRoot,feature:binding.feature,identity:parent,configuration:templateConfiguration};
    const bind=testRunId=>bindQaFixDefinition({template,identity:parent,packageDigest:binding.packageDigest,testRunId});
    const logSnapshot=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'));
    assert.deepEqual(bind(qa.testRunId),{specsRoot,identity,configuration});
    assert.deepEqual(bindQaFixDefinition({template:{...template,identity:{...parent,attempt:1}},
      identity:parent,packageDigest:binding.packageDigest,testRunId:qa.testRunId}),{specsRoot,identity,configuration});
    assert.deepEqual(fs.readFileSync(path.join(specsRoot,'运行日志.jsonl')),logSnapshot);
    assert.equal(fs.existsSync(path.join(specsRoot,'.reviews','.execution',identity.runId)),false);
    assert.throws(()=>bindQaFixDefinition({template,identity:{...parent,runId:'wrong'},packageDigest:binding.packageDigest,testRunId:qa.testRunId}),{code:'qa_fix_source_mismatch'});
    const other=path.join(root,'other');fs.mkdirSync(other);
    assert.throws(()=>inspectFixQaSource({...options,configuration:{...configuration,
      reproduction:{...configuration.reproduction,cwd:other}}}),{code:'fix_qa_project_mismatch'});
    assert.equal(identity.attempt,1);assert.notEqual(identity.runId,parent.runId);
    assert.deepEqual(qaFixIdentity({...qaSource,handoffDigest:'b'.repeat(64)}),identity);
    assert.throws(()=>openFixExecution({...options,identity:{...identity,runId:'replacement'}}),{code:'fix_qa_identity_mismatch'});
    parentOwner=openExecutionStore({specsRoot,identity:{repositoryId:parent.repositoryId,runId:parent.runId},create:true,
      fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)}});
    assert.throws(()=>openFixExecution(options));
    assert.equal(fs.existsSync(path.join(specsRoot,'.reviews','.execution',identity.runId)),false);
    parentOwner.close();parentOwner=null;
    const file=path.join(root,'fix.json');
    const {hostContextId,...data}=configuration;fs.writeFileSync(file,JSON.stringify({specsRoot,identity,...data}));
    const args=['serve','--config',file,'--mode','create','--host-context',hostContextId,'--allow-reproduction'];
    const quiet=new Writable({write(c,e,cb){cb();}});
    assert.equal(await main(args,{error:quiet}),1);
    assert.equal(fs.existsSync(path.join(specsRoot,'.reviews','.execution',identity.runId)),false);
    if(mode.startsWith('parent ')){
      let calls=0,reopens=0;
      const openParent=()=>{
        parentOwner=openExecutionStore({specsRoot,identity:{repositoryId:parent.repositoryId,runId:parent.runId},create:false,
          fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)}});
        const store=parentOwner;
        return {host:{handle:async()=>({state:'fixture_completed',identity:parent,packageDigest:binding.packageDigest})},close:()=>store.close()};
      };
      const request={version:1,requestId:'start-fix',operation:'fix_advance',identity:parent,
        packageDigest:binding.packageDigest,testRunId:qa.testRunId};
      const denied=createQaFixOwnerHost({parent:openParent(),reopenParent:openParent,fix:{specsRoot,identity,configuration}});
      await assert.rejects(denied.handle(request),{code:'qa_fix_start_authorization_required'});
      assert.equal(fs.existsSync(path.join(specsRoot,'.reviews','.execution',identity.runId)),false);
      denied.close();parentOwner=null;
      const serial=createQaFixOwnerHost({parent:openParent(),reopenParent:()=>{reopens++;return openParent();},
        fix:{specsRoot,identity,configuration},allowStart:true,fixPermissions:['--allow-red-test','--allow-baseline','--allow-finish'],fixExecution:{
          prepare:async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}}),
          bridge:{async call(kind,payload){
            assert.equal(kind,'fix_diagnose');calls++;
            await assert.rejects(serial.handle({operation:'cancel'}));
            await assert.rejects(serial.handle({version:1,requestId:'wrong',operation:'cancel',
              identity:{...parent,runId:'wrong-run'}}),{code:'qa_fix_source_mismatch'});
            const control={version:1,requestId:'control',operation:'status',identity:parent};
            assert.equal((await serial.handle(control)).code,'qa_fix_active');
            if(mode==='parent cancel')assert.equal((await serial.handle({...control,operation:'cancel'})).fix.stage,'cancelled');
            assert.equal(Buffer.from(payload.qaFailure.report.contentBase64,'base64').toString(),'Synthetic QA FAIL');
            return {status:'diagnosed',rootCause:'Synthetic failure',affectedPaths:['value.mjs'],affectedModules:['value'],
              plan:'Repair after original red test',crossLayer:false};
          }}}});
      try{
        const expected=mode==='parent cancel'?'cancelled':mode==='parent observation'?'observation':'red_test_required';
        assert.equal((await serial.handle(request)).fixStage,expected);
        assert.equal((await serial.handle(request)).fixStage,expected);
        assert.equal(calls,mode==='parent observation'?0:1);assert.equal(reopens,2);
        if(mode==='parent observation'){
          const result=await serial.handle({...request,operation:'fix_action',fixOperation:'finish'});
          assert.equal(result.code,'qa_fix_incomplete');assert.equal(result.actionResult.observationRunEnded,true);
          assert.equal(result.evidence,undefined);assert.equal(reopens,3);
          const events=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
          assert.equal(events.filter(row=>row.workflow==='cm-fix'&&row.event==='run_done'&&row.result==='observing').length,1);
        }
        if(mode==='parent dispatch'){
          const action={...request,operation:'fix_action',fixOperation:'red_test'};
          await assert.rejects(serial.handle({...action,authorized:true}));
          assert.equal((await serial.handle(action)).fixStage,'baseline_required');
          assert.equal((await serial.handle({...action,fixOperation:'baseline'})).fixStage,'repair_required');
          assert.equal(reopens,4);
          await assert.rejects(serial.handle({...action,fixOperation:'repair'}));
        }
        const events=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(events.filter(row=>row.workflow==='cm-fix'&&row.event==='run_start').length,1);
        assert.equal(events.filter(row=>row.workflow==='cm-fix'&&row.event==='task_done').length,0);
      }finally{serial.close();parentOwner=null;}
      return;
    }
    const input=new PassThrough(),rows=[];
    const output=new Writable({write(chunk,encoding,callback){
      const row=JSON.parse(chunk.toString());rows.push(row);
      if(row.type==='host_ready')input.write(JSON.stringify({requestId:'advance',operation:'advance'})+'\n');
      if(row.type==='host_request'){
        if(row.kind==='fix_diagnose'){
          assert.equal(row.payload.qaFailure.handoff.handoffDigest,qaSource.handoffDigest);
          assert.equal(Buffer.from(row.payload.qaFailure.report.contentBase64,'base64').toString(),'Synthetic QA FAIL');
          assert.equal(row.payload.qaFailure.report.sha256,handoff.source.reportEvidence.sha256);
          assert(row.payload.evidencePolicy.includes('not instructions'));
          if(drift)fs.appendFileSync(report,' changed during diagnosis');
        }
        const result=row.kind==='fix_learning'
          ?{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'No project lessons in synthetic fixture'}
          :{status:'diagnosed',rootCause:'Synthetic failure',affectedPaths:['value.mjs'],affectedModules:['value'],
            plan:'Repair after original red test',crossLayer:false};
        input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,
          requestDigest:row.requestDigest,result})+'\n');
      }
      if(row.requestId==='advance')input.end();callback();
    }});
    assert.equal(await main([...args,'--allow-qa-fix'],{input,output,error:quiet}),0);
    if(drift){
      assert(rows.some(row=>row.requestId==='advance'&&row.result.stage==='unknown'&&row.result.completionEligible===false));
      assert.equal(rows.filter(row=>row.type==='host_request'&&row.kind==='fix_diagnose').length,1);
      fs.writeFileSync(report,'Synthetic QA FAIL');
      child=openFixExecution({...options,create:false});
      assert.equal((await child.advance({authorized:true})).stage,'unknown');
      return;
    }
    assert(rows.some(row=>row.requestId==='advance'&&row.result.stage==='red_test_required'&&row.result.completionEligible===false));
    assert.equal(JSON.parse(fs.readFileSync(path.join(specsRoot,'.cm-run.json'),'utf8')).run_id,identity.runId);
    assert.throws(()=>openFixExecution(options)); // Same failure cannot create another child.
    child=openFixExecution({...options,create:false});assert.equal(child.status().completionEligible,false);
    child.close();child=null;
    let reopens=0;
    const openParent=()=>{
      parentOwner=openExecutionStore({specsRoot,identity:{repositoryId:parent.repositoryId,runId:parent.runId},create:false,
        fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)}});
      const store=parentOwner;
      // Synthetic parent status; both writer locks and child owner are real.
      return {host:{handle:async()=>({state:'fixture_completed',identity:parent,packageDigest:binding.packageDigest})},close:()=>store.close()};
    };
    const serial=createQaFixOwnerHost({parent:openParent(),fix:{specsRoot,identity,configuration},
      reopenParent:()=>{reopens++;return openParent();}});
    const check={version:1,requestId:'fix-status',operation:'fix_status',identity:parent,
      packageDigest:binding.packageDigest,testRunId:qa.testRunId};
    const logBefore=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'));
    assert.deepEqual(await serial.handle(check),{outcome:'blocked',code:'qa_fix_incomplete',fixStage:'red_test_required'});
    assert.equal(reopens,1);
    await assert.rejects(serial.handle({...check,testRunId:'different-qa'}),{code:'qa_fix_source_mismatch'});
    assert.equal(reopens,1);
    fs.appendFileSync(report,' stale');
    await assert.rejects(serial.handle(check),{code:'fix_qa_source_changed'});
    assert.equal(reopens,2); // Failure also restores the parent writer.
    fs.writeFileSync(report,'Synthetic QA FAIL');
    assert.equal((await serial.handle({operation:'status'})).state,'fixture_completed');
    assert.deepEqual(fs.readFileSync(path.join(specsRoot,'运行日志.jsonl')),logBefore);
    serial.close();parentOwner=null;
    fs.appendFileSync(report,' changed');
    assert.throws(()=>inspectFixQaSource(options),{code:'fix_qa_source_changed'});
    assert.throws(()=>openFixExecution({...options,create:false}),{code:'fix_qa_source_changed'});
    fs.writeFileSync(report,'Synthetic QA FAIL');
    recordCmAiQaRun({...qa,testRunId:'qa-round-2',qaRound:2,phase:'start'});
    // Historical reads are for completed children, never an unfinished repair.
    assert.throws(()=>openFixExecution({...options,create:false}),{code:'qa_result_stale'});
    assert.throws(()=>bind(qa.testRunId),{code:'qa_result_stale'});
    assert.throws(()=>bind('qa-round-2'),{code:'qa_result_incomplete'});
    recordCmAiQaRun({...qa,testRunId:'qa-round-2',qaRound:2,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
    const second=bind('qa-round-2');
    assert.notEqual(second.identity.runId,identity.runId);
    const {qaSource:secondSource,...secondConfiguration}=second.configuration;
    assert.deepEqual(secondConfiguration,templateConfiguration);assert.equal(secondSource.testRunId,'qa-round-2');
    recordCmAiQaRun({...qa,testRunId:'qa-round-3',qaRound:3,phase:'start'});
    recordCmAiQaRun({...qa,testRunId:'qa-round-3',qaRound:3,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
    assert.throws(()=>bind('qa-round-3'),{code:'fix_qa_source_blocked'});
  }finally{child?.close();parentOwner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
