import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {createHostQaDecisionProvider} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {recordCmAiQaDecision,recordCmAiQaRun,inspectCmAiQaResult,readCmAiQaRunRound} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';

function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-exec-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work',logHome=path.join(root,'logs');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.mkdirSync(path.join(specsDir,'.reviews'));
  fs.writeFileSync(path.join(codeProject,'source.mjs'),'export const value=42;\n');
  fs.writeFileSync(path.join(codeProject,'check.test.mjs'),"import assert from 'node:assert/strict'; import {value} from './source.mjs'; assert.equal(value,42);\n");
  fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'# Fixture\nTest command: node --test check.test.mjs\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,
    project:{workflow:'web-frontend'},policies:{tests:['commands']}}));
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'- [AC-001]: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  const cases=['logic','browser','browser'].map((kind,index)=>({id:`TC-00${index+1}`,kind,blocking:index!==2,
    origin:'user',acIds:['AC-001'],taskIds:['T-001'],title:'Synthetic case',preconditions:[],steps:['Observe fixture'],
    expected:['Synthetic expected behavior'],cleanup:index===1?['Close synthetic resource']:[]}));
  fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases}));
  const identity={repositoryId:'qa-fixture',runId:'qa-fixture-run',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
  const binding={codeProject,specsDir,feature,identity,packageDigest,testRunId:'qa-fixture-test'};
  const configuration={codeProject,specsDir,feature,runtime:'codex',requirements:['source.mjs'],
    commands:[{id:'declared-test',command:[process.execPath,'--test','check.test.mjs'],caseIds:['TC-001']}],
    environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1:4100',scope:'local'},timeoutMs:5000,logHome};
  recordCmAiQaDecision({codeProject,specsDir,feature,identity,packageDigest,logHome,decision:{decisionId:'qa-fixture-decision',
    identity,packageDigest,status:'triggered',score:null,reason:'fixture',at:'2026-09-08T01:00:00Z'}});
  return {root,binding,configuration,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

function begin(f,executor) {
  if(executor.prepare)executor={...executor,...executor.prepare()};
  const input={...f.binding,mode:executor.mode,caseCount:executor.caseCount};
  recordCmAiQaRun({...input,phase:'start',deferredCases:executor.configuration.plan.deferred_cases,logHome:f.configuration.logHome});
  return input;
}

for(const protectedMode of [false,true])test(`progress R1: quiet QA command boundaries; protected=${protectedMode}`,
  {skip:protectedMode&&spawnSync('codex',['--version']).status!==0},async()=>{
  const f=fixture(),events=[],original=process.stderr.write;let captured='';
  try{
    fs.unlinkSync(path.join(f.configuration.specsDir,f.configuration.feature,'test-cases.json'));
    f.configuration.commands=[{id:'quiet-qa',command:[process.execPath,'-e',
      "setTimeout(()=>{console.log('fixture-raw-output');process.exit(0)},400)"],caseIds:[]}];
    const executor=createHostQaExecutor({...f.configuration,...(protectedMode?{specsRoot:f.configuration.specsDir}:{})});
    const binding=begin(f,executor);
    process.stderr.write=function(chunk,...args){
      captured+=String(chunk);if(String(chunk).includes('[check]'))events.push({text:String(chunk),at:Date.now()});
      return original.call(this,chunk,...args);
    };
    const result=await executor.run(binding,new AbortController().signal);
    assert.equal(result.result,'PASS');assert.equal(events.length,2,captured);
    assert.match(events[0].text,/开始检查.*quiet-qa/);assert.match(events[1].text,/检查结束.*quiet-qa.*passed/);
    assert(events[1].at-events[0].at>=300,'start must be visible during the quiet command');
    assert(!captured.includes('fixture-raw-output'),'QA raw project output remains private');
  }finally{process.stderr.write=original;f.cleanup();}
});

for(const transport of ['synchronous','jsonl','coalesced-jsonl'])test(`incident sequence: immediate QA replies over ${transport}`,{timeout:30000},async()=>{
  const f=fixture(),bridge=createHostToolBridge(),input=new PassThrough(),output=new PassThrough();
  let serving;
  try{
    fs.writeFileSync(path.join(f.configuration.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,
      project:{workflow:'web-frontend'},policies:{tests:['logic','commands','browser']}}));
    const featureRoot=path.join(f.configuration.specsDir,f.configuration.feature);
    fs.writeFileSync(path.join(featureRoot,'tasks.md'),'- [x] T-001: first\n- [x] T-002: second\n');
    const contract=JSON.parse(fs.readFileSync(path.join(featureRoot,'test-cases.json')));
    contract.cases=Array.from({length:7},(_,i)=>({...contract.cases[0],id:`TC-00${i+1}`,
      kind:i>=3&&i<=5?'browser':'logic',taskIds:i===6?['T-001','T-002']:['T-002']}));
    fs.writeFileSync(path.join(featureRoot,'test-cases.json'),JSON.stringify(contract));
    f.configuration.commands[0].caseIds=['TC-001','TC-002','TC-003','TC-007'];
    const seen=[];
    const answer=row=>{
      seen.push(row.kind==='qa_assess'?row.kind:row.payload.case.id);
      if(row.kind==='qa_assess')return {scores:{scope:1,risk:1,accumulation:1,boundary:1},
        changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}};
      if(row.kind==='qa_logic')return {verdict:'SUPPORTED',evidence:['Synthetic static observation']};
      const artifact=path.join(f.configuration.specsDir,'.reviews',`${row.payload.case.id}.txt`);
      fs.writeFileSync(artifact,'Synthetic browser evidence; no real browser');
      return {verdict:'PASS',evidence:[artifact],environment:row.payload.environment,cleanup:'completed'};
    };
    const execute=async()=>{
      const provider=createHostQaDecisionProvider({timeoutMs:5000,assess:(r,s)=>bridge.call('qa_assess',r,s)});
      const {testRunId,...decisionBinding}=f.binding;
      assert.equal((await provider.decide(decisionBinding,new AbortController().signal)).reason,'feature_complete');
      const executor=createHostQaExecutor({...f.configuration,
        logic:(r,s)=>bridge.call('qa_logic',r,s),browser:(r,s)=>bridge.call('qa_browser',r,s)});
      assert.equal(executor.caseCount,8);
      const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
      recordCmAiQaRun({...binding,phase:'complete',result,logHome:f.configuration.logHome});
      const {codeProject,mode,caseCount,...resultBinding}=binding;
      return {code:'qa_result',...inspectCmAiQaResult(resultBinding)};
    };
    if(transport==='synchronous'){
      bridge.attach(row=>{if(row.type==='host_request')assert.equal(bridge.accept({type:'host_result',
        sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:answer(row)}).accepted,true);});
      assert.equal((await execute()).status,'passed');
    }else{
      let buffer='',result,scheduled=false;
      const drain=()=>{
        scheduled=false;let end;
        while((end=buffer.indexOf('\n'))!==-1){
          const row=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
          if(row.type==='host_request')input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,
            callId:row.callId,requestDigest:row.requestDigest,result:answer(row)})+'\n');
          if(row.result){result=row.result;input.end();}
        }
      };
      output.on('data',chunk=>{
        buffer+=chunk;
        if(transport==='jsonl')drain();
        else if(!scheduled){scheduled=true;setImmediate(drain);}
      });
      serving=serveCmAiHost({host:{handle:execute},input,output,toolBridge:bridge});
      input.write(JSON.stringify({operation:'advance',requestId:'incident'})+'\n');
      await serving;assert.deepEqual(result,{code:'qa_result',status:'passed'});
    }
    assert.deepEqual(seen,['qa_assess','TC-004','TC-005','TC-006','TC-001','TC-002','TC-003','TC-007']);
  }finally{bridge.close();input.end();await serving;f.cleanup();}
});

test('QA producer records three distinct rounds and rejects unknown, skipped and exhausted retries',async()=>{
  const f=fixture();
  try{
    const executor=createHostQaExecutor({...f.configuration,
      logic:async()=>({verdict:'SUPPORTED',evidence:['source.mjs:1']}),
      browser:async request=>{
        const artifact=path.join(f.configuration.specsDir,'.reviews','round-browser.txt');
        fs.writeFileSync(artifact,'Synthetic failed browser observation; no real browser used');
        return {verdict:'FAIL',evidence:[artifact],environment:request.environment,cleanup:'completed'};
      }});
    const base={...f.binding,mode:executor.mode,caseCount:executor.caseCount,logHome:f.configuration.logHome};
    const start=(qaRound,testRunId)=>recordCmAiQaRun({...base,qaRound,testRunId,phase:'start'});
    assert.throws(()=>start(2,'qa-round-2'));
    for(let qaRound=1;qaRound<=3;qaRound++){
      const testRunId=`qa-round-${qaRound}`;
      if(qaRound===3)assert.throws(()=>start(3,'qa-round-1'));
      start(qaRound,testRunId);
      assert.throws(()=>start(qaRound+1,`qa-unknown-${qaRound}`));
      const input={...f.binding,mode:executor.mode,caseCount:executor.caseCount,qaRound,testRunId};
      await assert.rejects(executor.run({...input,qaRound:qaRound+1},new AbortController().signal));
      const result=await executor.run(input,new AbortController().signal);
      assert.equal(result.result,'FAIL');
      if(qaRound>1)assert.throws(()=>recordCmAiQaRun({...base,testRunId,phase:'complete',result}));
      recordCmAiQaRun({...base,qaRound,testRunId,phase:'complete',result});
      assert.equal(inspectCmAiQaResult({specsDir:input.specsDir,feature:input.feature,identity:input.identity,
        packageDigest:input.packageDigest,testRunId}).status,'failed');
      if(qaRound===1)assert.throws(()=>start(3,'qa-skipped'));
    }
    const log=path.join(f.configuration.specsDir,'运行日志.jsonl'),before=fs.readFileSync(log,'utf8');
    assert.throws(()=>start(4,'qa-round-4'));assert.throws(()=>start(1,'qa-reset'));
    assert.equal(fs.readFileSync(log,'utf8'),before);
    const rows=before.trim().split('\n').map(JSON.parse);
    for(const phase of ['start','case_start','case_complete','complete'])
      assert.deepEqual(rows.filter(row=>row.event==='test_run'&&row.phase===phase).map(row=>row.attempt),[1,2,3]);
  }finally{f.cleanup();}
});

test('host QA runs a declared command, retains blocking disabled modes and archives per-case evidence',async()=>{
  const f=fixture(),seen=[];
  try{
    const executor=createHostQaExecutor({...f.configuration,
      logic:async request=>{seen.push(request.case.id);return {verdict:'SUPPORTED',evidence:['source.mjs:1']};},
      browser:async request=>{
        seen.push(request.case.id);assert.equal(request.case.blocking,true);
        const log=fs.readFileSync(path.join(f.configuration.specsDir,'运行日志.jsonl'),'utf8');
        assert(log.includes('case_start'));assert(log.includes('browser_qa'));
        const artifact=path.join(f.configuration.specsDir,'.reviews','browser-fixture.txt');
        fs.writeFileSync(artifact,'Synthetic browser-host evidence; no real browser used\n');
        return {verdict:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'};
      }});
    assert.equal(executor.mode,'all');assert.equal(executor.caseCount,3);
    const input=begin(f,executor),result=await executor.run(input,new AbortController().signal);
    assert.equal(result.result,'PASS');assert.equal(result.passed,3);assert.deepEqual(seen,['TC-002','TC-001']);
    const report=fs.readFileSync(result.report,'utf8');assert(report.includes('"staticVerdict": "SUPPORTED"'));
    assert(report.includes('"commandEvidence": ['));assert(!report.includes('TC-003'));
    recordCmAiQaRun({...input,phase:'complete',result,logHome:f.configuration.logHome});
    assert.equal(inspectCmAiQaResult({specsDir:input.specsDir,feature:input.feature,identity:input.identity,
      packageDigest:input.packageDigest,testRunId:input.testRunId}).status,'passed');
    assert.throws(()=>recordCmAiQaRun({...input,qaRound:2,testRunId:'qa-after-pass',phase:'start',logHome:f.configuration.logHome}));
    const rows=fs.readFileSync(path.join(input.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.phase==='case_start').length,1);
    assert.equal(rows.filter(row=>row.phase==='case_complete').length,1);
    assert(rows.filter(row=>row.phase==='route').every(row=>!Object.hasOwn(row,'effective_model')));
    assert.equal(rows.filter(row=>row.event==='resource'&&row.phase==='acquired').length,1);
    assert.equal(rows.filter(row=>row.event==='resource'&&row.phase==='released').length,1);
    const status=JSON.parse(fs.readFileSync(path.join(input.specsDir,'.cm-status.json'),'utf8'));
    assert.equal(status.node,'N6');assert.equal(status.state,'qa_passed');
    assert.equal(status.detail,'QA 结果 PASS（通过 3 / 失败 0 / 阻断 0）');
  }finally{f.cleanup();}
});

for(const mode of ['no-runtime-evidence','wrong-carrier','cleanup-failed','source-drift','empty-evidence'])
test(`host QA does not convert incomplete or unsafe evidence to PASS: ${mode}`,async()=>{
  const f=fixture();
  try{
    if(mode==='no-runtime-evidence'){
      const source=path.join(f.configuration.specsDir,f.configuration.feature,'test-cases.json');
      const contract=JSON.parse(fs.readFileSync(source));contract.cases=contract.cases.slice(0,1);
      fs.writeFileSync(source,JSON.stringify(contract));
      fs.writeFileSync(path.join(f.configuration.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{tests:['logic']}}));
      f.configuration.commands=[];
    }
    const executor=createHostQaExecutor({...f.configuration,
      logic:async()=>({verdict:'SUPPORTED',evidence:['source.mjs:1']}),browser:async request=>{
        const artifact=path.join(f.configuration.specsDir,'.reviews','browser-fixture.txt');
        fs.writeFileSync(artifact,mode==='empty-evidence'?'':'Synthetic evidence');
        if(mode==='source-drift')fs.writeFileSync(path.join(f.configuration.codeProject,'source.mjs'),'export const value=43;\n');
        return {verdict:'PASS',evidence:[artifact],environment:mode==='wrong-carrier'?{...request.environment,kind:'app'}:request.environment,
          cleanup:mode==='cleanup-failed'?'failed':'completed'};
      }});
    const result=await executor.run(begin(f,executor),new AbortController().signal);
    assert.equal(result.result,'BLOCKED');assert(result.blocked>0);
    if(mode==='no-runtime-evidence')assert.equal(result.passed,0);
    if(mode==='source-drift')assert(fs.readFileSync(result.report,'utf8').includes('"sourceChanged": true'));
    if(mode==='empty-evidence'){
      assert(fs.readFileSync(result.report,'utf8').includes('"evidenceProblem": "qa_evidence_required"'));
      recordCmAiQaRun({...f.binding,mode:executor.mode,caseCount:executor.caseCount,phase:'complete',result,logHome:f.configuration.logHome});
      const {specsDir,feature,identity,packageDigest,testRunId}=f.binding;
      assert.equal(inspectCmAiQaResult({specsDir,feature,identity,packageDigest,testRunId}).status,'blocked');
    }
  }finally{f.cleanup();}
});

test('host QA cancellation leaves an unfinished invocation and never writes success',async()=>{
  const f=fixture(),controller=new AbortController();
  try{
    const executor=createHostQaExecutor({...f.configuration,browser:async request=>{
      controller.abort();return {verdict:'PASS',evidence:['ignored-after-cancel'],environment:request.environment,cleanup:'completed'};
    }});
    await assert.rejects(executor.run(begin(f,executor),controller.signal),{code:'cancelled'});
    const rows=fs.readFileSync(path.join(f.configuration.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(!rows.some(row=>row.event==='test_run'&&row.phase==='complete'));
    assert.equal(fs.readdirSync(path.join(f.configuration.specsDir,'.reviews')).filter(name=>name.endsWith('execution.md')).length,0);
  }finally{f.cleanup();}
});

for(const kind of ['qa_logic','qa_browser','qa_assess'])test(`QA request watchdog settles ${kind} ${kind==='qa_assess'?'as a retryable qa_decision_timeout':'as BLOCKED'}`,async()=>{
  const f=fixture(),bridge=createHostToolBridge(),sent=[];
  try{
    bridge.attach(row=>{if(row.type==='host_request'){
      sent.push(row);
      if(row.kind!==kind){
        const artifact=path.join(f.configuration.specsDir,'.reviews','watchdog-browser.txt');
        fs.writeFileSync(artifact,'Synthetic browser observation');
        const result=row.kind==='qa_logic'?{verdict:'SUPPORTED',evidence:['source.mjs:1']}:
          {verdict:'PASS',evidence:[artifact],environment:row.payload.environment,cleanup:'completed'};
        assert.equal(bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,
          requestDigest:row.requestDigest,result}).accepted,true);
      }
    }});
    const call=(name)=>(r,s)=>bridge.call(name,r,s,{timeoutMs:20});
    if(kind==='qa_assess'){
      // A missed assessment window is a transport outcome: nothing to record.
      const {testRunId,...binding}=f.binding;
      const log=path.join(f.binding.specsDir,'运行日志.jsonl'),before=fs.readFileSync(log);
      await assert.rejects(createHostQaDecisionProvider({timeoutMs:1000,assess:call(kind)}).decide(binding,new AbortController().signal),
        {code:'qa_decision_timeout'});
      assert.deepEqual(fs.readFileSync(log),before);
    }else{
      const executor=createHostQaExecutor({...f.configuration,logic:call('qa_logic'),browser:call('qa_browser')});
      const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
      assert.equal(result.result,'BLOCKED');assert.equal(result.blocked,1);
      assert.match(fs.readFileSync(result.report,'utf8'),/host_request_timeout/);
      recordCmAiQaRun({...binding,phase:'complete',result,logHome:f.configuration.logHome});
      const {codeProject,mode,caseCount,...query}=binding;
      assert.equal(inspectCmAiQaResult(query).status,'blocked');
    }
    const expired=sent.find(row=>row.kind===kind);
    assert.equal(bridge.accept({type:'host_result',sessionId:expired.sessionId,callId:expired.callId,
      requestDigest:expired.requestDigest,result:{verdict:'PASS'}}).accepted,false);
  }finally{bridge.close();f.cleanup();}
});

for(const mode of ['empty','abandoned-crash','partial-abandoned-crash','no-authorization','partial-no-authorization',
  'PASS','FAIL','BLOCKED','case-blocked','report','partial-report','resource','partial-resource'])
test(`explicit QA recovery: ${mode}`,async()=>{
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const {inspectCmAiQaRecovery,latestCmAiQaRun}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const {inspectRunClosure}=await import('./cm-log-event.mjs');
  const f=fixture();
  try{
    const start={...f.binding,mode:'commands',caseCount:1,logHome:f.configuration.logHome};
    recordCmAiQaRun({...start,phase:'start'});
    const log=path.join(f.binding.specsDir,'运行日志.jsonl');
    const rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    const row=rows().at(-1),append=value=>fs.appendFileSync(log,JSON.stringify(value)+'\n');
    if(['PASS','FAIL','BLOCKED','case-blocked'].includes(mode)||mode.startsWith('partial-')){
      append({...row,phase:'case_start',case_id:'TC-001'});
      append({...row,phase:mode==='case-blocked'?'case_blocked':'case_complete',case_id:'TC-001',
        result:mode.startsWith('partial-')?'PASS':mode==='case-blocked'?'BLOCKED':mode});
    }
    if(['report','partial-report'].includes(mode))fs.writeFileSync(path.join(f.binding.specsDir,'.reviews',`${f.binding.testRunId}-execution.md`),'Result before complete');
    if(['resource','partial-resource'].includes(mode))append({...row,event:'resource',phase:'acquired',resource_id:'live-command',resource_kind:'qa_command',cleanup_required:true});
    if(['abandoned-crash','partial-abandoned-crash'].includes(mode)){
      // Persist abandonment, crash before the successor start, then resume.
      recordCmAiQaRun({...start,phase:'abandoned'});
      assert.equal(inspectRunClosure(log,f.binding.identity.runId).closed,false);
      assert.throws(()=>recordCmAiQaRun({...start,phase:'complete',result:{result:'PASS',passed:1,failed:0,blocked:0,report:'none'}}));
    }
    let calls=0,invocation;
    const completed={state:'fixture_completed',code:null,identity:f.binding.identity,packageDigest:f.binding.packageDigest};
    const options={specsDir:f.binding.specsDir,codeProject:f.binding.codeProject,feature:f.binding.feature,
      identity:f.binding.identity,runner:{status:()=>completed,executeEffect:async()=>assert.fail('no development/review replay'),
        cancel:()=>completed,run:async()=>completed},
      qaLogHome:f.configuration.logHome,rerunUnknownQa:!mode.endsWith('no-authorization'),
      qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('existing QA decision must be reused')},
      qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
        calls++;invocation=binding;
        const report=path.join(f.binding.specsDir,'.reviews',`${binding.testRunId}-execution.md`);
        fs.writeFileSync(report,'Synthetic rerun command evidence');
        return {result:'PASS',passed:1,failed:0,blocked:0,report};
      }}};
    const before=fs.readFileSync(log);
    const operation={version:1,operation:'advance',requestId:'resume-qa',identity:f.binding.identity};
    const result=await createCmAiConversationEntry(options).handle(operation);
    if(['empty','abandoned-crash','partial-abandoned-crash','PASS'].includes(mode)){
      assert.equal(result.code,'qa_passed',JSON.stringify(result));assert.equal(calls,1);
      assert.notEqual(invocation.testRunId,f.binding.testRunId);assert.equal(invocation.qaRound,1);
      assert.equal(rows().filter(row=>row.phase==='abandoned').length,1);
      assert.equal(rows().find(row=>row.phase==='abandoned').previous_test_run_id,f.binding.testRunId);
      assert.deepEqual(rows().find(row=>row.phase==='abandoned').partial_pass_cases,
        ['PASS','partial-abandoned-crash'].includes(mode)?['TC-001']:[]);
      assert.deepEqual(rows().filter(row=>row.phase==='start').map(row=>row.attempt),[1,1]);
      assert.equal(rows().filter(row=>row.phase==='complete').length,1);
      const {codeProject,testRunId,...query}=f.binding;
      assert.equal(latestCmAiQaRun(query).status,'passed');
      assert.throws(()=>inspectCmAiQaResult({...query,testRunId}),{code:'qa_result_stale'});
      assert.throws(()=>inspectCmAiQaRecovery(query),{code:'qa_execution_unknown'});
      const after=fs.readFileSync(log);
      assert.equal((await createCmAiConversationEntry(options).handle(operation)).code,'qa_passed');
      assert.equal(calls,1);assert.deepEqual(fs.readFileSync(log),after);
    }else{
      assert.equal(result.code,mode.endsWith('resource')?'qa_log_failed':'qa_execution_unknown',JSON.stringify(result));
      assert.equal(calls,0);assert.deepEqual(fs.readFileSync(log),before);
    }
  }finally{f.cleanup();}
});

test('same-round successors require bound abandonment; repaired FAIL rounds still advance and cap at three',async()=>{
  const {latestCmAiQaRun,readCmAiQaRunRound}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const f=fixture();
  try{
    const base={...f.binding,mode:'commands',caseCount:1,logHome:f.configuration.logHome};
    const {codeProject,testRunId,...query}=f.binding;
    recordCmAiQaRun({...base,phase:'start'});
    assert.throws(()=>recordCmAiQaRun({...base,testRunId:'illegal-successor',previousTestRunId:testRunId,phase:'start'}));
    recordCmAiQaRun({...base,phase:'abandoned'});
    assert.throws(()=>recordCmAiQaRun({...base,testRunId:'illegal-successor',previousTestRunId:'wrong',phase:'start'}));
    recordCmAiQaRun({...base,testRunId:'retry-1',previousTestRunId:testRunId,phase:'start'});
    const log=path.join(f.binding.specsDir,'运行日志.jsonl'),valid=fs.readFileSync(log,'utf8');
    for(const variant of ['missing','wrong-id','duplicate','reset','changed-mode']){
      let rows=valid.trim().split('\n').map(JSON.parse);
      const index=rows.findIndex(row=>row.phase==='abandoned');
      if(variant==='missing')rows.splice(index,1);
      if(variant==='wrong-id')rows[index].previous_test_run_id='wrong';
      if(variant==='duplicate')rows.splice(index,0,rows[index]);
      if(variant==='reset')rows.at(-1).attempt=2;
      if(variant==='changed-mode'){rows.at(-1).mode='browser';delete rows.at(-1).previous_test_run_id;}
      fs.writeFileSync(log,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
      assert.throws(()=>readCmAiQaRunRound({...query,testRunId:'retry-1'}),undefined,variant);
    }
    const legacy=valid.trim().split('\n').map(JSON.parse);
    delete legacy.find(row=>row.phase==='abandoned').partial_pass_cases;
    fs.writeFileSync(log,legacy.map(JSON.stringify).join('\n')+'\n');
    assert.equal(readCmAiQaRunRound({...query,testRunId:'retry-1'}),1);
    for(let qaRound=1;qaRound<=3;qaRound++){
      const id=`retry-${qaRound}`;
      if(qaRound>1)recordCmAiQaRun({...base,testRunId:id,qaRound,phase:'start'});
      const report=path.join(f.binding.specsDir,'.reviews',`${id}-execution.md`);fs.writeFileSync(report,'Synthetic FAIL');
      recordCmAiQaRun({...base,testRunId:id,qaRound,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
      assert.equal(latestCmAiQaRun(query).status,'failed');
    }
    assert.throws(()=>recordCmAiQaRun({...base,testRunId:'retry-4',qaRound:4,phase:'start'}));
  }finally{f.cleanup();}
});

for(const interruptedAfterAbandonment of [false,true])
test(`partial PASS recovery reruns the full real executor plan; abandoned crash=${interruptedAfterAbandonment}`,async()=>{
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const {readCmAiQaRunRound}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const {inspectRunClosure}=await import('./cm-log-event.mjs');
  const f=fixture();
  try{
    fs.writeFileSync(path.join(f.configuration.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,
      project:{workflow:'web-frontend'},policies:{tests:['commands','browser','logic']}}));
    const seen=[],executor=createHostQaExecutor({...f.configuration,
      logic:async request=>{seen.push(request.case.id);return {verdict:'SUPPORTED',evidence:['Synthetic static observation']};},
      browser:async request=>{
        seen.push(request.case.id);
        const file=path.join(f.binding.specsDir,'.reviews',`${request.testRunId}-${request.case.id}.txt`);
        fs.writeFileSync(file,'Fresh synthetic browser evidence');
        return {verdict:'PASS',evidence:[file],environment:request.environment,cleanup:'completed'};
      }});
    assert.equal(executor.caseCount,4);
    const start=begin(f,executor),log=path.join(f.binding.specsDir,'运行日志.jsonl');
    const rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    const seed=rows().at(-1),oldEvidence=path.join(f.binding.specsDir,'.reviews','old-browser-pass.txt');
    fs.writeFileSync(oldEvidence,'Historical PASS evidence');
    for(const caseId of ['TC-002','TC-003'])for(const phase of ['case_start','case_complete'])
      fs.appendFileSync(log,JSON.stringify({...seed,phase,case_id:caseId,
        ...(phase==='case_complete'?{result:'PASS',evidence:[oldEvidence]}:{})})+'\n');
    const history=fs.readFileSync(log,'utf8');
    if(interruptedAfterAbandonment)recordCmAiQaRun({...start,phase:'abandoned',logHome:f.configuration.logHome});
    const completed={state:'fixture_completed',code:null,identity:f.binding.identity,packageDigest:f.binding.packageDigest};
    const options={specsDir:f.binding.specsDir,codeProject:f.binding.codeProject,feature:f.binding.feature,
      identity:f.binding.identity,runner:{status:()=>completed,executeEffect:async()=>assert.fail('no development/review replay'),
        cancel:()=>completed,run:async()=>completed},qaLogHome:f.configuration.logHome,rerunUnknownQa:true,
      qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('reuse existing decision')},qaExecutor:executor};
    const result=await createCmAiConversationEntry(options).handle({version:1,operation:'advance',
      requestId:'partial-rerun',identity:f.binding.identity});
    assert.equal(result.code,'qa_passed',JSON.stringify(result));
    assert.deepEqual(seen,['TC-002','TC-003','TC-001']);
    assert.equal(fs.readFileSync(oldEvidence,'utf8'),'Historical PASS evidence');
    assert(fs.readFileSync(log,'utf8').startsWith(history));
    assert(!fs.existsSync(path.join(f.binding.specsDir,'.reviews',`${f.binding.testRunId}-execution.md`)));
    const abandoned=rows().filter(row=>row.phase==='abandoned');
    assert.equal(abandoned.length,1);assert.deepEqual(abandoned[0].partial_pass_cases,['TC-002','TC-003']);
    const successor=rows().filter(row=>row.phase==='start').at(-1);
    assert.notEqual(successor.operation_id,f.binding.testRunId);assert.equal(successor.attempt,1);
    const fresh=rows().filter(row=>row.operation_id===successor.operation_id);
    assert.deepEqual(fresh.filter(row=>row.phase==='case_complete').map(row=>row.case_id),['TC-002','TC-003']);
    assert.equal(fresh.find(row=>row.phase==='complete').passed,4);
    // A real command resource release proves the commands stage also ran again.
    assert(fresh.some(row=>row.event==='resource'&&row.resource_kind==='qa_command'&&row.phase==='released'));
    assert.equal(inspectRunClosure(log,f.binding.identity.runId).closed,true);
    const valid=fs.readFileSync(log,'utf8');
    for(const badResult of ['FAIL','BLOCKED','case_blocked']){
      const invalid=rows(),prior=invalid.find(row=>row.operation_id===f.binding.testRunId&&row.phase==='case_complete');
      prior.result=badResult==='case_blocked'?'BLOCKED':badResult;
      if(badResult==='case_blocked')prior.phase='case_blocked';
      fs.writeFileSync(log,invalid.map(JSON.stringify).join('\n')+'\n');
      const {codeProject,testRunId,...query}=f.binding;
      assert.throws(()=>readCmAiQaRunRound({...query,testRunId:successor.operation_id}));
      assert.throws(()=>inspectRunClosure(log,f.binding.identity.runId));
      fs.writeFileSync(log,valid);
    }
    for(const partial of [undefined,null,[],['TC-002'],['TC-002','TC-003','TC-999']]){
      const invalid=rows(),abandonment=invalid.find(row=>row.phase==='abandoned');
      if(partial===undefined)delete abandonment.partial_pass_cases;
      else abandonment.partial_pass_cases=partial;
      fs.writeFileSync(log,invalid.map(JSON.stringify).join('\n')+'\n');
      const {codeProject,testRunId,...query}=f.binding;
      assert.throws(()=>readCmAiQaRunRound({...query,testRunId:successor.operation_id}));
      assert.throws(()=>inspectRunClosure(log,f.binding.identity.runId));
      fs.writeFileSync(log,valid);
    }
  }finally{f.cleanup();}
});

function plannedExecutor(options) {
  const executor=createHostQaExecutor(options);
  return {...executor,...executor.prepare()};
}

function midFeature(f,{complete=false,empty=false}={}) {
  const root=path.join(f.configuration.specsDir,f.configuration.feature);
  fs.writeFileSync(path.join(root,'tasks.md'),Array.from({length:4},(_,i)=>
    `- [${complete||i===0?'x':' '}] T-00${i+1}: fixture`).join('\n')+'\n');
  const contract=JSON.parse(fs.readFileSync(path.join(root,'test-cases.json')));
  contract.cases=Array.from({length:9},(_,i)=>({...contract.cases[0],id:`TC-00${i+1}`,
    kind:[0,1,7].includes(i)?'logic':'browser',blocking:true,
    taskIds:i===7&&!empty?['T-001']:i===2?['T-003','T-004']:['T-001','T-002']}));
  fs.writeFileSync(path.join(root,'test-cases.json'),JSON.stringify(contract));
  f.configuration.commands=[{...f.configuration.commands[0],id:'npm-test',caseIds:['TC-008']},
    {...f.configuration.commands[0],id:'deferred-test',caseIds:['TC-001','TC-002']}];
  return contract;
}

for(const complete of [false,true])test(`step30 four tasks / nine cases; feature complete=${complete}`,async()=>{
  const f=fixture();
  try{
    const contract=midFeature(f,{complete}),seen=[];
    const executor=plannedExecutor({...f.configuration,
      logic:async request=>{seen.push(request.case.id);return {verdict:'SUPPORTED',evidence:['Synthetic source check']};},
      browser:async request=>{
        seen.push(request.case.id);
        const artifact=path.join(f.configuration.specsDir,'.reviews',`${request.case.id}.txt`);
        fs.writeFileSync(artifact,'Synthetic browser observation');
        return {verdict:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'};
      }});
    const plan=executor.configuration.plan;
    const selected=complete?contract.cases.map(item=>item.id):['TC-008'];
    const deferred=complete?[]:contract.cases.filter(item=>item.id!=='TC-008')
      .map(item=>({id:item.id,taskIds:item.taskIds.filter(taskId=>taskId!=='T-001')}));
    assert.deepEqual(plan.cases.map(item=>item.id),selected);
    assert.deepEqual(plan.deferred_cases,deferred);
    assert.deepEqual(plan.commands.map(item=>item.id),complete?['npm-test','deferred-test']:['npm-test']);
    assert.equal(executor.caseCount,complete?11:2);
    const binding=begin(f,executor);
    await assert.rejects(executor.run({...binding,caseCount:executor.caseCount+1},new AbortController().signal),{code:'qa_execution_mismatch'});
    const result=await executor.run(binding,new AbortController().signal);
    assert.equal(result.result,'PASS');assert.equal(result.passed,executor.caseCount);assert.equal(result.blocked,0);
    assert.deepEqual(seen.sort(),selected);
    const report=fs.readFileSync(result.report,'utf8');assert(report.includes(JSON.stringify(deferred,null,2)));
    const rows=fs.readFileSync(path.join(f.configuration.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.find(row=>row.phase==='start').deferred_cases,deferred);
    assert(!rows.some(row=>deferred.some(item=>item.id===row.case_id)));
    console.log('STEP30 selection',JSON.stringify({complete,selected,deferred,commands:plan.commands.map(item=>item.id),caseCount:executor.caseCount,result:result.result}));
  }finally{f.cleanup();}
});

test('step30 no applicable case or command remains explicitly BLOCKED',async()=>{
  const f=fixture();
  try{
    midFeature(f,{empty:true});
    fs.writeFileSync(path.join(f.configuration.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{tests:['logic']}}));
    const executor=plannedExecutor({...f.configuration,logic:()=>assert.fail('no deferred host request'),
      browser:()=>assert.fail('no deferred browser request')});
    assert.equal(executor.configuration.plan.cases.length,0);assert.equal(executor.configuration.plan.commands.length,0);
    assert.equal(executor.configuration.plan.deferred_cases.length,9);
    const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
    assert.equal(result.result,'BLOCKED');assert.equal(result.passed,0);assert.equal(result.blocked,1);
    assert.match(fs.readFileSync(result.report,'utf8'),/no-applicable-cases/);
    recordCmAiQaRun({...binding,phase:'complete',result,logHome:f.configuration.logHome});
    const {codeProject,mode,caseCount,...query}=binding;
    assert.equal(inspectCmAiQaResult(query).status,'blocked');
  }finally{f.cleanup();}
});

for(const afterAbandonment of [false,true])test(`step30 resume old ten-item QA into fresh two-item plan; abandoned=${afterAbandonment}`,async()=>{
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const {readCmAiQaRunRound}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const {inspectRunClosure}=await import('./cm-log-event.mjs');
  const f=fixture();
  try{
    midFeature(f);
    const log=path.join(f.configuration.specsDir,'运行日志.jsonl');
    const old={...f.binding,mode:'all',caseCount:10,logHome:f.configuration.logHome};
    recordCmAiQaRun({...old,phase:'start'});
    const rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    fs.appendFileSync(log,JSON.stringify({...rows().at(-1),phase:'case_start',case_id:'TC-003'})+'\n');
    if(afterAbandonment)recordCmAiQaRun({...old,phase:'abandoned'});
    const before=fs.readFileSync(log,'utf8'),seen=[];
    // Host construction precedes N5. Its plan must be refreshed after completion.
    const tasks=path.join(f.configuration.specsDir,f.configuration.feature,'tasks.md');
    const completedTasks=fs.readFileSync(tasks,'utf8');fs.writeFileSync(tasks,completedTasks.replace('[x]','[ ]'));
    const executor=plannedExecutor({...f.configuration,
      logic:async request=>{seen.push(request.case.id);return {verdict:'SUPPORTED',evidence:['Synthetic static observation']};},
      browser:()=>assert.fail('unfinished browser case must never dispatch')});
    assert.equal(executor.configuration.plan.cases.length,0);
    fs.writeFileSync(tasks,completedTasks);
    const completed={state:'fixture_completed',code:null,identity:f.binding.identity,packageDigest:f.binding.packageDigest};
    const entry=createCmAiConversationEntry({specsDir:f.binding.specsDir,codeProject:f.binding.codeProject,
      feature:f.binding.feature,identity:f.binding.identity,runner:{status:()=>completed,
        executeEffect:async()=>assert.fail('no developer/reviewer replay'),cancel:()=>completed,run:async()=>completed},
      qaLogHome:f.configuration.logHome,rerunUnknownQa:true,
      qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('reuse historical decision')},qaExecutor:executor});
    const operation={version:1,operation:'advance',requestId:'step30-resume',identity:f.binding.identity};
    const result=await entry.handle(operation);assert.equal(result.code,'qa_passed',JSON.stringify(result));
    assert.deepEqual(seen,['TC-008']);assert(fs.readFileSync(log,'utf8').startsWith(before));
    const starts=rows().filter(row=>row.phase==='start'),fresh=starts.at(-1);
    assert.equal(starts.length,2);assert.notEqual(fresh.operation_id,f.binding.testRunId);
    assert.equal(fresh.previous_test_run_id,f.binding.testRunId);assert.equal(fresh.case_count,2);
    assert.equal(fresh.deferred_cases.length,8);assert.equal(fresh.attempt,1);
    assert.equal(rows().find(row=>row.phase==='abandoned').case_count,10);
    assert.equal(inspectRunClosure(log,f.binding.identity.runId).closed,true);
    const valid=fs.readFileSync(log,'utf8');
    assert.equal((await entry.handle(operation)).code,'qa_passed');assert.deepEqual(seen,['TC-008']);
    assert.equal(fs.readFileSync(log,'utf8'),valid);
    const {codeProject,testRunId,...query}=f.binding;
    for(const previous of [undefined,'wrong-predecessor']){
      const invalid=rows();const start=invalid.filter(row=>row.phase==='start').at(-1);
      if(previous===undefined)delete start.previous_test_run_id;else start.previous_test_run_id=previous;
      fs.writeFileSync(log,invalid.map(JSON.stringify).join('\n')+'\n');
      assert.throws(()=>readCmAiQaRunRound({...query,testRunId:fresh.operation_id}));
      fs.writeFileSync(log,valid);
    }
  }finally{f.cleanup();}
});

test('step30 completed-but-dropped task does not make a mid-feature case applicable',()=>{
  const f=fixture();
  try{
    midFeature(f);
    const tasks=path.join(f.configuration.specsDir,f.configuration.feature,'tasks.md');
    fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replace('- [ ] T-002: fixture','- [x] ~~T-002: fixture~~ [DROPPED v2]'));
    const executor=plannedExecutor(f.configuration);
    assert.deepEqual(executor.configuration.plan.cases.map(item=>item.id),['TC-008']);
    assert.deepEqual(executor.configuration.plan.deferred_cases.find(item=>item.id==='TC-001'),{id:'TC-001',taskIds:['T-002']});
  }finally{f.cleanup();}
});

test('step30 deferred-only command mappings do not block applicable browser cases',async()=>{
  const f=fixture();
  try{
    const contract=midFeature(f),source=path.join(f.configuration.specsDir,f.configuration.feature,'test-cases.json');
    contract.cases.find(item=>item.id==='TC-008').kind='browser';fs.writeFileSync(source,JSON.stringify(contract));
    f.configuration.commands=f.configuration.commands.filter(item=>item.id==='deferred-test');
    const executor=plannedExecutor({...f.configuration,browser:async request=>{
      const artifact=path.join(f.configuration.specsDir,'.reviews','browser.txt');fs.writeFileSync(artifact,'Synthetic observation');
      return {verdict:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'};
    }});
    assert.deepEqual(executor.configuration.plan.modes,['browser']);assert.equal(executor.caseCount,1);
    const result=await executor.run(begin(f,executor),new AbortController().signal);
    assert.equal(result.result,'PASS');assert.equal(result.blocked,0);
  }finally{f.cleanup();}
});

test('step30 invocation selection does not change the legacy persisted executor configuration',()=>{
  const f=fixture();
  try{
    midFeature(f);
    const before=createHostQaExecutor(f.configuration),selected=before.prepare();
    assert.equal(selected.caseCount,2);assert.equal(before.caseCount,11);
    assert.equal(Object.hasOwn(before.configuration.plan,'deferred_cases'),false);
    const tasks=path.join(f.configuration.specsDir,f.configuration.feature,'tasks.md');
    fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replaceAll('[ ]','[x]'));
    const after=createHostQaExecutor(f.configuration);
    assert.deepEqual(after.configuration,before.configuration);
    assert.equal(after.mode,before.mode);assert.equal(after.caseCount,before.caseCount);
    assert.equal(after.prepare().caseCount,11);
    assert.deepEqual(selected.configuration.plan.cases.map(item=>item.id),['TC-008']);
  }finally{f.cleanup();}
});

test('step30b empty mid-feature plan emits one explicit deferred BLOCKED row',async()=>{
  const f=fixture();
  try{
    const contract=midFeature(f,{empty:true});
    const executor=plannedExecutor({...f.configuration,logic:()=>assert.fail('no deferred logic request'),
      browser:()=>assert.fail('no deferred browser request')});
    const plan=executor.configuration.plan;
    const deferred=contract.cases.map(item=>({id:item.id,taskIds:item.taskIds.filter(id=>id!=='T-001')}));
    assert.deepEqual(plan.cases,[]);assert.deepEqual(plan.commands,[]);
    assert.deepEqual(plan.modes,['commands']);assert.equal(executor.mode,'commands');
    assert.equal(executor.caseCount,1);assert.deepEqual(plan.deferred_cases,deferred);
    const binding=begin(f,executor);
    const tasks=path.join(f.configuration.specsDir,f.configuration.feature,'tasks.md');
    const original=fs.readFileSync(tasks,'utf8');
    fs.writeFileSync(tasks,original.replace('- [ ] T-002','- [x] T-002'));
    await assert.rejects(executor.run(binding,new AbortController().signal),{code:'qa_plan_changed'});
    fs.writeFileSync(tasks,original);
    const result=await executor.run(binding,new AbortController().signal);
    assert.equal(result.result,'BLOCKED');assert.equal(result.passed,0);
    assert.equal(result.failed,0);assert.equal(result.blocked,1);
    const report=fs.readFileSync(result.report,'utf8');
    const rows=report.split(/^## /m).slice(2).map(section=>JSON.parse(section.slice(section.indexOf('\n')).trim()));
    assert.deepEqual(rows,[{id:'no-applicable-cases',kind:'commands',verdict:'BLOCKED',
      evidence:['all applicable cases are bound to unfinished tasks; deferred to feature completion',
        ...deferred.map(item=>`${item.id}: ${item.taskIds.join(', ')}`)]}]);
    assert(report.includes(JSON.stringify(deferred,null,2)));
    const log=fs.readFileSync(path.join(f.configuration.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.find(row=>row.event==='test_run'&&row.phase==='start').deferred_cases,deferred);
    assert(!log.some(row=>row.event==='resource'||row.phase?.startsWith('case_')));
    recordCmAiQaRun({...binding,phase:'complete',result,logHome:f.configuration.logHome});
    const {codeProject,mode,caseCount,...query}=binding;
    assert.equal(inspectCmAiQaResult(query).status,'blocked');
    console.log('STEP30B reproduction',JSON.stringify({selected:plan.cases,deferred:plan.deferred_cases,
      commands:plan.commands,caseCount:executor.caseCount,result,rows}));
  }finally{f.cleanup();assert.equal(fs.existsSync(f.root),false);}
});

// 2026-10-08 aihot 5.author-column: tasks dropped with the official [DROPPED]
// marker kept their cases (blocking or not) in the feature-completion plan, so
// the session was asked about hidden features and the round ended BLOCKED.
const DROPPED_LINE=id=>`- [ ] ~~${id}: deferred work~~ \`[DROPPED v2: 数据源未定，暂缓]\``;
function droppedFeature(f,{pending=false,cases,commands,tests=['logic','commands','browser']}){
  const root=path.join(f.configuration.specsDir,f.configuration.feature);
  fs.writeFileSync(path.join(root,'tasks.md'),['- [x] T-001: live work',DROPPED_LINE('T-002'),DROPPED_LINE('T-003'),
    ...(pending?['- [ ] T-004: later work']:[])].join('\n')+'\n');
  const contract=JSON.parse(fs.readFileSync(path.join(root,'test-cases.json')));
  contract.cases=cases.map(([kind,blocking,taskIds],i)=>({...contract.cases[0],id:`TC-00${i+1}`,kind,blocking,taskIds,cleanup:[]}));
  fs.writeFileSync(path.join(root,'test-cases.json'),JSON.stringify(contract));
  fs.writeFileSync(path.join(f.configuration.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,
    project:{workflow:'cm-default'},policies:{tests}}));
  const marker=path.join(f.root,'dropped-command-ran');
  f.configuration.commands=commands.map(([id,caseIds])=>({id,caseIds,command:id.startsWith('dropped')
    ?[process.execPath,'-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},'x')`]:f.configuration.commands[0].command}));
  return marker;
}
const reportSections=file=>fs.readFileSync(file,'utf8').split(/^## /m).slice(1)
  .map(part=>[part.slice(0,part.indexOf('\n')),JSON.parse(part.slice(part.indexOf('\n')+1))]);

for(const answer of ['PASS','BLOCKED'])test(`dropped tasks: cases bound only to them are NOT_APPLICABLE, never asked or counted; live answer ${answer}`,async()=>{
  const {inspectCmAiQaRecovery}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const f=fixture();
  try{
    // TC-005 mixes a live and a dropped task: still planned.
    const marker=droppedFeature(f,{cases:[['logic',true,['T-001']],['logic',false,['T-002']],['browser',true,['T-003']],
      ['browser',false,['T-002','T-003']],['browser',true,['T-001','T-002']],['logic',false,['T-002']]],
      commands:[['live-test',['TC-001']],['dropped-test',['TC-002','TC-006']]]});
    const seen=[];
    const options={...f.configuration,logic:async request=>{seen.push(request.case.id);return {verdict:'SUPPORTED',evidence:['Synthetic source check']};},
      browser:async request=>{
        seen.push(request.case.id);
        const artifact=path.join(f.configuration.specsDir,'.reviews',`${request.case.id}.txt`);fs.writeFileSync(artifact,'Synthetic observation');
        return {verdict:answer,evidence:answer==='PASS'?[artifact]:[],environment:request.environment,cleanup:'not_needed'};
      }};
    // The persisted (fingerprinted) configuration is planned without task state, exactly as before.
    const initial=createHostQaExecutor(options);
    assert.equal(initial.caseCount,8);assert.equal(initial.configuration.plan.cases.length,6);
    assert.equal(Object.hasOwn(initial.configuration.plan,'dropped_task_cases'),false);
    assert.equal(Object.hasOwn(initial.configuration.plan,'dropped_task_commands'),false);
    const executor={...initial,...initial.prepare()},plan=executor.configuration.plan;
    const dropped=[{id:'TC-002',taskIds:['T-002']},{id:'TC-003',taskIds:['T-003']},{id:'TC-004',taskIds:['T-002','T-003']},{id:'TC-006',taskIds:['T-002']}];
    assert.deepEqual(plan.cases.map(item=>item.id),['TC-001','TC-005']);assert.deepEqual(plan.deferred_cases,[]);
    assert.deepEqual(plan.dropped_task_cases,dropped);
    assert.deepEqual(plan.dropped_task_commands,[{id:'dropped-test',caseIds:['TC-002','TC-006']}]);
    assert.deepEqual(plan.commands.map(item=>item.id),['live-test']);assert.equal(executor.caseCount,3);
    const binding={...f.binding,mode:executor.mode,caseCount:executor.caseCount};
    recordCmAiQaRun({...binding,phase:'start',deferredCases:plan.deferred_cases,droppedTaskCases:plan.dropped_task_cases,
      droppedTaskCommands:plan.dropped_task_commands,logHome:f.configuration.logHome});
    const result=await executor.run(binding,new AbortController().signal);
    assert.deepEqual(seen.sort(),['TC-001','TC-005']);assert.equal(fs.existsSync(marker),false);
    assert.deepEqual({result:result.result,passed:result.passed,failed:result.failed,blocked:result.blocked},
      answer==='PASS'?{result:'PASS',passed:3,failed:0,blocked:0}:{result:'BLOCKED',passed:2,failed:0,blocked:1});
    const sections=reportSections(result.report),listed=Object.fromEntries(sections);
    assert.deepEqual(listed.not_applicable,[...dropped.map(item=>({...item,verdict:'NOT_APPLICABLE',
      reason:`bound only to dropped tasks: ${item.taskIds.join(', ')}`})),{id:'dropped-test',caseIds:['TC-002','TC-006'],kind:'commands',
      verdict:'NOT_APPLICABLE',reason:'declared only for cases bound only to dropped tasks: TC-002, TC-006'}]);
    assert.deepEqual(sections.map(([name])=>name).filter(name=>!['deferred_cases','not_applicable'].includes(name)).sort(),['TC-001','TC-005','live-test']);
    const log=fs.readFileSync(path.join(f.configuration.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const start=log.find(row=>row.event==='test_run'&&row.phase==='start');
    assert.deepEqual(start.dropped_task_cases,dropped);assert.deepEqual(start.dropped_task_commands,plan.dropped_task_commands);
    assert(!log.some(row=>dropped.some(item=>item.id===row.case_id)));
    recordCmAiQaRun({...binding,phase:'complete',result,logHome:f.configuration.logHome});
    const {codeProject,mode,caseCount,...query}=binding;
    assert.equal(inspectCmAiQaResult(query).status,answer==='PASS'?'passed':'blocked');
    // The rerun reader skips the not_applicable list like deferred_cases.
    const {testRunId,...run}=query;
    if(answer==='BLOCKED')assert.deepEqual(inspectCmAiQaRecovery(run,{blocked:true}).blockedCases,['TC-005']);
  }finally{f.cleanup();}
});

test('dropped tasks: mid-feature, a case bound only to them is recorded as dropped, not deferred',()=>{
  const f=fixture();
  try{
    droppedFeature(f,{pending:true,cases:[['logic',true,['T-001']],['browser',false,['T-002']],['browser',true,['T-004']],
      ['logic',true,['T-002','T-004']]],commands:[['live-test',['TC-001']]]});
    const {plan}=plannedExecutor(f.configuration).configuration;
    assert.deepEqual(plan.cases.map(item=>item.id),['TC-001']);
    assert.deepEqual(plan.dropped_task_cases,[{id:'TC-002',taskIds:['T-002']}]);
    assert.deepEqual(plan.deferred_cases,[{id:'TC-003',taskIds:['T-004']},{id:'TC-004',taskIds:['T-002','T-004']}]);
  }finally{f.cleanup();}
});

// Codex review R1: the test-kind policy must not hide a dropped-only case and so schedule its command.
test('dropped tasks: a command declared only for a policy-excluded dropped case never runs; the round stays BLOCKED',async()=>{
  const f=fixture();
  try{
    const marker=droppedFeature(f,{tests:['commands'],cases:[['logic',false,['T-002']]],commands:[['dropped-test',['TC-001']]]});
    const executor=plannedExecutor({...f.configuration,logic:()=>assert.fail('no dropped logic request')});
    const plan=executor.configuration.plan;
    assert.deepEqual(plan.dropped_task_cases,[{id:'TC-001',taskIds:['T-002']}]);
    assert.deepEqual(plan.dropped_task_commands,[{id:'dropped-test',caseIds:['TC-001']}]);
    assert.deepEqual(plan.commands,[]);assert.deepEqual(plan.cases,[]);
    const result=await executor.run(begin(f,executor),new AbortController().signal);
    assert.equal(fs.existsSync(marker),false,'the dropped-only command never runs');
    assert.deepEqual([result.result,result.passed,result.blocked],['BLOCKED',0,1]);
    const listed=Object.fromEntries(reportSections(result.report));
    assert.deepEqual(listed.not_applicable.map(item=>[item.id,item.verdict]),[['TC-001','NOT_APPLICABLE'],['dropped-test','NOT_APPLICABLE']]);
    assert.equal(listed['commands-unavailable'].verdict,'BLOCKED');
  }finally{f.cleanup();}
});

for(const tests of [['logic','browser'],['logic','commands','browser']])
test(`dropped tasks: nothing left to verify stays BLOCKED, never a PASS from nothing; policies ${tests.join('+')}`,async()=>{
  const f=fixture();
  try{
    droppedFeature(f,{tests,cases:[['logic',true,['T-002']],['browser',false,['T-003']]],
      commands:tests.includes('commands')?[['dropped-test',['TC-001']]]:[]});
    const executor=plannedExecutor({...f.configuration,logic:()=>assert.fail('no dropped logic request'),
      browser:()=>assert.fail('no dropped browser request')});
    assert.deepEqual(executor.configuration.plan.cases,[]);assert.equal(executor.caseCount,1);
    const result=await executor.run(begin(f,executor),new AbortController().signal);
    assert.deepEqual([result.result,result.passed,result.blocked],['BLOCKED',0,1]);
    const rows=reportSections(result.report).filter(([name])=>!['deferred_cases','not_applicable'].includes(name));
    assert.equal(rows.length,1);assert.equal(rows[0][1].verdict,'BLOCKED');
    assert.equal(rows[0][0],tests.includes('commands')?'commands-unavailable':'qa-unavailable');
    assert(rows[0][1].evidence.includes('TC-001: bound only to dropped tasks: T-002'));
  }finally{f.cleanup();}
});

for(const mode of ['unavailable-only','confirmation','failed-and-unavailable','insufficient-and-unavailable','unmapped'])
test(`logic report rows record why they are BLOCKED: ${mode}`,async()=>{
  const f=fixture();
  try{
    const kill=[process.execPath,'-e','process.kill(process.pid,"SIGKILL")'];
    f.configuration.commands=[{id:'killed',command:kill,caseIds:mode==='unmapped'?[]:['TC-001']},
      ...(mode==='failed-and-unavailable'?[{id:'fails',command:[process.execPath,'-e','process.exit(1)'],caseIds:['TC-001']}]:[])];
    if(mode==='confirmation'){
      const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
      contract.cases[0].expected=['[需确认] synthetic expectation'];fs.writeFileSync(source,JSON.stringify(contract));
    }
    const artifact=path.join(f.binding.specsDir,'.reviews','browser.txt');fs.writeFileSync(artifact,'Synthetic observation');
    const executor=createHostQaExecutor({...f.configuration,logic:async()=>({verdict:mode==='insufficient-and-unavailable'?'INSUFFICIENT_EVIDENCE':'SUPPORTED',
      evidence:['Synthetic static observation']}),
      browser:async request=>({verdict:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'})});
    const result=await executor.run(begin(f,executor),new AbortController().signal);
    const row=fs.readFileSync(result.report,'utf8').split(/^## /m).filter(part=>part.startsWith('TC-001\n'))
      .map(part=>JSON.parse(part.slice('TC-001'.length+1)))[0];
    assert.equal(row.verdict,mode==='failed-and-unavailable'?'FAIL':'BLOCKED');
    assert.equal(row.commandUnavailable,mode==='unavailable-only'?true:undefined);
    assert.equal(row.needsConfirmation,mode==='confirmation'?true:undefined);
  }finally{f.cleanup();}
});

test('superseded rows written before recovery_rule 2 replay under the original rule; new rows use the contract',async()=>{
  const f=fixture();
  try{
    // The original rule accepted a logic INSUFFICIENT_EVIDENCE case even with [需确认].
    const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
    contract.cases[0].expected=['[需确认] synthetic expectation'];fs.writeFileSync(source,JSON.stringify(contract));
    f.configuration.commands[0].caseIds=[];
    const artifact=path.join(f.binding.specsDir,'.reviews','browser.txt');fs.writeFileSync(artifact,'Synthetic observation');
    const executor=createHostQaExecutor({...f.configuration,logic:async()=>({verdict:'INSUFFICIENT_EVIDENCE',evidence:['Synthetic static observation']}),
      browser:async request=>({verdict:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'})});
    const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
    const base={...binding,logHome:f.configuration.logHome};recordCmAiQaRun({...base,phase:'complete',result});
    assert.equal(result.result,'BLOCKED');
    // Old executors never wrote the marker; an old host wrote the superseded row without recovery_rule.
    fs.writeFileSync(result.report,fs.readFileSync(result.report,'utf8').replace(/,\n\s*"needsConfirmation": true/g,''));
    const {codeProject,testRunId,mode,caseCount,...query}=binding;
    const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
    const data={node:'N6',repository_id:binding.identity.repositoryId,feature:binding.feature,task:binding.identity.taskId,
      package_digest:binding.packageDigest,qa_decision_id:'qa-fixture-decision',operation_id:testRunId,attempt:1,mode,case_count:caseCount,
      previous_test_run_id:testRunId,reason:'host_evidence_problem',blocked_cases:['TC-001'],expected_environment:f.configuration.environment};
    const written=spawnSync(process.env.CM_PYTHON_BIN||'python3',[writer,'--workflow','cm-ai','--event','test_run','--phase','superseded',
      '--runtime','codex','--project-root',codeProject,'--specs-dir',binding.specsDir,'--run-id',binding.identity.runId,
      '--detail','QA superseded','--data-json',JSON.stringify(data)],{encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:f.configuration.logHome}});
    assert.equal(written.status,0,written.stderr);
    recordCmAiQaRun({...base,testRunId:'legacy-round-2',qaRound:2,previousTestRunId:testRunId,phase:'start'});
    assert.equal(readCmAiQaRunRound({...query,testRunId:'legacy-round-2'}),2);
    // The same history claimed under the current rule is refused: the contract still says [需确认].
    const log=path.join(binding.specsDir,'运行日志.jsonl'),kept=fs.readFileSync(log,'utf8');
    fs.writeFileSync(log,kept.split('\n').map(line=>{if(!line)return line;const row=JSON.parse(line);
      return row.phase==='superseded'?JSON.stringify({...row,recovery_rule:2}):line;}).join('\n'));
    assert.throws(()=>readCmAiQaRunRound({...query,testRunId:'legacy-round-2'}),{code:'qa_round_invalid'});
    fs.writeFileSync(log,kept);assert.equal(readCmAiQaRunRound({...query,testRunId:'legacy-round-2'}),2);
    // The original rule itself is replayed exactly: it never accepted a SUPPORTED logic case.
    const report=fs.readFileSync(result.report,'utf8');
    fs.writeFileSync(result.report,report.replace('"staticVerdict": "INSUFFICIENT_EVIDENCE"','"staticVerdict": "SUPPORTED"'));
    assert.throws(()=>readCmAiQaRunRound({...query,testRunId:'legacy-round-2'}),{code:'qa_round_invalid'});
    fs.writeFileSync(result.report,report);assert.equal(readCmAiQaRunRound({...query,testRunId:'legacy-round-2'}),2);
  }finally{f.cleanup();}
});

// Report forgeries: the approved contract, not the report marker, decides [需确认].
const FORGED={'contract-resolved-after-run':'logic-confirmation-insufficient','forged-confirmation-insufficient':'logic-confirmation-insufficient',
  'forged-confirmation-unavailable':'logic-confirmation-unavailable','forged-browser-confirmation':'needs-confirmation',
  // No browser answer happened: a marker added to the report must not stand in for one.
  'forged-no-capability':'no-browser-capability','forged-browser-evidence':'needs-confirmation'};
// source-drift and incomplete have their own tests below (2026-10-06 author-column-T-009).
for(const name of ['evidence','cleanup','environment','timeout','logic','commands','product-blocked',
  'FAIL','mixed-failure','round-limit','superseded-crash','one-shot','metadata-command',
  'legacy-product-blocked','needs-confirmation','command-unavailable','command-exit','declared-command-exit','declared-product-fail',
  'declared-contradicted','declared-after-repair','declared-superseded-crash','declared-blocked','declared-unknown-verdict',
  'logic-confirmation-unavailable','logic-confirmation-insufficient','no-browser-capability',...Object.keys(FORGED)])
test(`completed BLOCKED QA explicit rerun: ${name}`,async()=>{
  const scenario=FORGED[name]??name;
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const {inspectCmAiQaRecovery}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const {inspectRunClosure}=await import('./cm-log-event.mjs');
  const f=fixture();
  try{
    const artifact=path.join(f.binding.specsDir,'.reviews','browser.txt');fs.writeFileSync(artifact,'Synthetic observation');
    if(scenario==='logic')f.configuration.commands[0].caseIds=[];
    if(scenario==='metadata-command')f.configuration.commands[0].id='deferred_cases';
    if(scenario==='commands')f.configuration.commands=[];
    // [需确认] keeps a case BLOCKED on every round; a rerun can never resolve it.
    const confirmation={'needs-confirmation':1,'logic-confirmation-unavailable':0,'logic-confirmation-insufficient':0}[scenario];
    if(confirmation!==undefined){
      const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
      contract.cases[confirmation].expected=['[需确认] synthetic expectation'];fs.writeFileSync(source,JSON.stringify(contract));
    }
    // Environment stand-in outside both roots: killed (no exit code) or exit 65 until it is fixed.
    const ready=path.join(f.root,'environment-ready');
    const exits=['command-exit','declared-command-exit','declared-contradicted','declared-after-repair','declared-superseded-crash','declared-unknown-verdict'];
    const killed=['command-unavailable','logic-confirmation-unavailable'].includes(scenario);
    if([...(killed?[scenario]:[]),...exits].includes(scenario))f.configuration.commands[0].command=[process.execPath,'-e',
      `require('node:fs').existsSync(${JSON.stringify(ready)})||${killed?'process.kill(process.pid,"SIGKILL")':'process.exit(65)'}`];
    const failLike=['FAIL','declared-product-fail'].includes(scenario),contradicted=['mixed-failure','declared-contradicted'].includes(scenario);
    const hostBlocked=['product-blocked','legacy-product-blocked'].includes(scenario);
    let repaired=false,browserCalls=0,logicCalls=0,corrections=0;
    const executor=createHostQaExecutor({...f.configuration,
      logic:async()=>{logicCalls++;return {verdict:contradicted?'CONTRADICTED':
        ['logic','logic-confirmation-insufficient'].includes(scenario)?'INSUFFICIENT_EVIDENCE':'SUPPORTED',evidence:['Synthetic static observation']};},
      // Without a browser capability the executor itself blocks the case; no
      // session answered it, so a rerun on the same host cannot change it.
      ...(scenario==='no-browser-capability'?{}:{browser:async request=>{
        // A correction round re-asks the same case once; this session answers it the same way.
        if(request.correction){corrections++;}else browserCalls++;
        if(!repaired&&scenario==='source-drift')fs.appendFileSync(path.join(f.configuration.codeProject,'source.mjs'),'// drift\n');
        if(!repaired&&scenario==='timeout')throw Object.assign(new Error('timeout'),{code:'host_request_timeout'});
        return {verdict:!repaired&&failLike?'FAIL':!repaired&&hostBlocked?'BLOCKED':'PASS',
          evidence:!repaired&&['evidence','source-drift','round-limit','incomplete','superseded-crash','one-shot','mixed-failure','declared-contradicted','metadata-command','declared-blocked'].includes(scenario)
            ?['not-an-evidence-file']: [artifact],
          environment:!repaired&&scenario==='environment'?{...request.environment,target:'different-target'}:request.environment,
          cleanup:!repaired&&scenario==='cleanup'?'failed':'completed'};
      }})});
    const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
    const {codeProject,testRunId,mode,caseCount,...query}=binding;
    const base={...binding,logHome:f.configuration.logHome};
    // Unusable evidence on a PASS from the registered environment is asked back once.
    const formSlip=['evidence','round-limit','superseded-crash','one-shot','mixed-failure',
      'declared-contradicted','metadata-command','declared-blocked'].includes(scenario);
    assert.equal(corrections,formSlip?1:0,scenario);
    if(scenario!=='incomplete')recordCmAiQaRun({...base,phase:'complete',result});
    // Older executors wrote host-declared BLOCKED rows without the marker; those stay ineligible.
    if(scenario==='legacy-product-blocked')fs.writeFileSync(result.report,
      fs.readFileSync(result.report,'utf8').replace(/,\n\s*"hostDeclaredBlocked": true/g,''));
    // The contract no longer says [需确认], but the run's own report does: still refused.
    if(name==='contract-resolved-after-run'){
      const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
      contract.cases[0].expected=['Synthetic expected behavior'];fs.writeFileSync(source,JSON.stringify(contract));
    }else if(FORGED[name]){
      const forge={'forged-confirmation-insufficient':['TC-001',row=>{delete row.needsConfirmation;}],
        'forged-confirmation-unavailable':['TC-001',row=>{delete row.needsConfirmation;row.commandUnavailable=true;}],
        'forged-browser-confirmation':['TC-002',row=>{row.hostDeclaredBlocked=true;}],
        'forged-no-capability':['TC-002',row=>{row.hostDeclaredBlocked=true;}],
        // A forged evidence problem on a [需确认] case: the contract still refuses it.
        'forged-browser-evidence':['TC-002',row=>{row.evidenceProblem='qa_evidence_required';}]}[name];
      const parts=fs.readFileSync(result.report,'utf8').split(/^## /m),index=parts.findIndex(part=>part.startsWith(`${forge[0]}\n`));
      const body=parts[index].slice(forge[0].length+1),row=JSON.parse(body);forge[1](row);
      parts[index]=`${forge[0]}\n\n${JSON.stringify(row,null,2)}${body.match(/\s*$/)[0]}`;
      fs.writeFileSync(result.report,parts.map((part,i)=>i?`## ${part}`:part).join(''));
    }
    // A report row outside PASS/FAIL/BLOCKED no longer matches the recorded counts.
    if(scenario==='declared-unknown-verdict')fs.writeFileSync(result.report,
      fs.readFileSync(result.report,'utf8').replace(/("id": "TC-001",[\s\S]*?"verdict": )"FAIL"/,'$1"SKIPPED"'));
    if(scenario!=='incomplete'){
      const state=JSON.parse(fs.readFileSync(path.join(binding.specsDir,'.cm-status.json')));
      assert.equal(state.state,result.failed?'qa_failed':'qa_blocked');assert.equal(state.node,'N6');
      assert.equal(state.detail,`QA 结果 ${result.result}（通过 ${result.passed} / 失败 ${result.failed} / 阻断 ${result.blocked}）`);
    }
    const log=path.join(binding.specsDir,'运行日志.jsonl'),rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    if(scenario==='round-limit')for(let round=1;round<3;round++){
      const previous=round===1?testRunId:`blocked-${round}`;
      recordCmAiQaRun({...base,testRunId:previous,qaRound:round,phase:'superseded'});
      recordCmAiQaRun({...base,testRunId:`blocked-${round+1}`,qaRound:round+1,previousTestRunId:previous,phase:'start'});
      recordCmAiQaRun({...base,testRunId:`blocked-${round+1}`,qaRound:round+1,phase:'complete',result});
    }
    if(scenario==='declared-superseded-crash')recordCmAiQaRun({...base,phase:'superseded',
      expectedEnvironment:f.configuration.environment,environmentFailure:'simulator runtime was missing'});
    if(scenario==='superseded-crash'){
      recordCmAiQaRun({...base,phase:'superseded'});
      assert.equal(inspectRunClosure(log,binding.identity.runId).closed,false);
      assert.throws(()=>recordCmAiQaRun({...base,testRunId:'bad-link',qaRound:2,previousTestRunId:'wrong',phase:'start'}));
    }
    const completed={state:'fixture_completed',code:null,identity:binding.identity,packageDigest:binding.packageDigest};
    const options={specsDir:query.specsDir,feature:query.feature,identity:query.identity,codeProject,runner:{status:()=>completed,executeEffect:()=>assert.fail('no development/Review replay'),
      cancel:()=>completed,run:()=>assert.fail('no task replay')},qaExecutor:executor,qaLogHome:f.configuration.logHome,
      qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('no repeated QA decision')}};
    const operation={version:1,operation:'advance',requestId:'rerun-blocked',identity:binding.identity};
    const before=fs.readFileSync(log);
    const without=await createCmAiConversationEntry(options).handle(operation);
    assert.equal(without.code,scenario==='incomplete'?'qa_execution_unknown':result.failed?'qa_failed':'qa_result_blocked');
    if(!result.failed&&scenario!=='incomplete')assert.equal(without.pendingAction,'none');
    assert.deepEqual(fs.readFileSync(log),before);
    if(scenario==='declared-command-exit'){
      // The declaration only travels with the one-shot rerun grant and a superseded row.
      for(const bad of [{qaEnvironmentFailure:'no rerun grant'},{rerunBlockedQa:true,qaEnvironmentFailure:'two\nlines'}])
        assert.throws(()=>createCmAiConversationEntry({...options,...bad}),{code:'qa_recovery_authorization_required'});
      assert.throws(()=>recordCmAiQaRun({...base,testRunId:'declared-start',qaRound:2,phase:'start',environmentFailure:'misplaced'}),
        {code:'qa_recovery_authorization_required'});
    }
    // An accepted repair already owns the next round of that FAIL.
    const repairedRunner=scenario==='declared-after-repair'?{runner:{...options.runner,status:()=>({...completed,
      acceptedQaFix:{qaRound:1,testRunId,evidenceDigest:'c'.repeat(64)}})}}:{};
    const entry=createCmAiConversationEntry({...options,...repairedRunner,rerunBlockedQa:true,
      ...(scenario.startsWith('declared-')&&scenario!=='declared-superseded-crash'?{qaEnvironmentFailure:'simulator runtime was missing'}:{})});
    if(['commands','legacy-product-blocked','needs-confirmation','source-drift','FAIL','mixed-failure','round-limit','incomplete',
      'command-exit','declared-product-fail','declared-contradicted','declared-after-repair','declared-blocked',
      'declared-unknown-verdict','logic-confirmation-unavailable','logic-confirmation-insufficient','no-browser-capability'].includes(scenario)){
      const rejected=await entry.handle(operation);
      assert.equal(rejected.code,scenario==='round-limit'?'qa_round_invalid':scenario==='incomplete'?'qa_execution_unknown':'qa_rerun_not_blocked_by_evidence');
      assert.deepEqual(fs.readFileSync(log),before);
      assert.equal(browserCalls,['needs-confirmation','no-browser-capability'].includes(scenario)?0:1);
      if(name==='no-browser-capability'){
        // Neither the durable log nor the report claims a host answer that never happened.
        const row=JSON.parse(fs.readFileSync(result.report,'utf8').split(/^## /m).find(part=>part.startsWith('TC-002\n')).slice('TC-002'.length+1));
        assert.equal(row.hostDeclaredBlocked,undefined);
        assert.equal(rows().find(item=>item.phase==='case_blocked'&&item.case_id==='TC-002').host_declared_blocked,undefined);
      }
    }else{
      const queried=await entry.handle({...operation,operation:'qa_result',packageDigest:binding.packageDigest,testRunId});
      assert.equal(queried.pendingAction,result.failed?'fix_authorization':'qa');
      repaired=scenario!=='one-shot';
      if(['command-unavailable',...exits].includes(scenario))fs.writeFileSync(ready,'');
      const rerun=await entry.handle(operation);
      assert.equal(rerun.code,['logic','one-shot'].includes(scenario)?'qa_result_blocked':'qa_passed',JSON.stringify(rerun));
      assert.equal(browserCalls,2);assert.equal(logicCalls,2);
      assert.equal(rows().filter(row=>row.phase==='superseded').length,1);
      const starts=rows().filter(row=>row.phase==='start');assert.deepEqual(starts.map(row=>row.attempt),[1,2]);
      assert.equal(starts[1].previous_test_run_id,testRunId);assert.notEqual(starts[1].operation_id,testRunId);
      assert.equal(rows().filter(row=>row.phase==='complete').length,2);
      assert.equal(rows().filter(row=>row.event==='qa').length,1);
      assert.equal(inspectRunClosure(log,binding.identity.runId).closed,true);
      assert.throws(()=>inspectCmAiQaResult({...query,testRunId}),{code:'qa_result_stale'});
      const after=fs.readFileSync(log);await entry.handle(operation);
      assert.equal(browserCalls,2);assert.deepEqual(fs.readFileSync(log),after);
      // Replay checks the predecessor's evidence and exact blocked case set.
      for(const tamper of [
        rows=>{rows.find(row=>row.phase==='superseded').blocked_cases=['invented'];},
        rows=>{rows.find(row=>row.phase==='complete').mode='browser';},
        rows=>{rows.find(row=>row.phase==='complete').passed=String(result.passed);},
        rows=>{rows.splice(rows.findIndex(row=>row.phase==='superseded'),1);
          delete rows.filter(row=>row.phase==='start')[1].previous_test_run_id;},
      ]){
        const corrupt=rows();tamper(corrupt);
        fs.writeFileSync(log,corrupt.map(JSON.stringify).join('\n')+'\n');
        assert.throws(()=>inspectCmAiQaRecovery(query,{blocked:true}));fs.writeFileSync(log,after);
      }
      // The passing successor re-validates its predecessor's exact report and
      // supersession fields, so each forged detail is caught on its own.
      const round2=starts[1].operation_id,firstReport=rows().find(row=>row.phase==='complete'&&row.operation_id===testRunId).report;
      const precise=[];
      if(scenario==='command-unavailable')precise.push(['report',row=>{row.exitCode=0;}],
        ['report',row=>{row.evidence=['No declared project test command'];}],
        ['log',list=>{list.find(row=>row.phase==='superseded').failed_cases=[];}],
        // The logic case is eligible only by its own "blocked by that command" marker.
        ['report',row=>{delete row.commandUnavailable;},'TC-001'],['report',row=>{row.commandEvidence=[];},'TC-001'],
        ['report',row=>{row.needsConfirmation=true;},'TC-001'],
        ['report',row=>{row.staticVerdict='CONTRADICTED';},'TC-001'],
        ['log',list=>{list.find(row=>row.phase==='superseded').recovery_rule=3;}],
        ['contract',contract=>{contract.cases=contract.cases.filter(item=>item.id!=='TC-001');}]);
      // The host-declared BLOCKED needs both the durable log row and the report mirror.
      if(scenario==='product-blocked')precise.push(
        ['log',list=>{delete list.find(row=>row.phase==='case_blocked'&&row.operation_id===testRunId).host_declared_blocked;}],
        ['report',row=>{delete row.hostDeclaredBlocked;},'TC-002']);
      if(['declared-command-exit','declared-superseded-crash'].includes(scenario))precise.push(['report',row=>{row.exitCode=null;}],
        ['report',row=>{row.exitCode=0;}],['log',list=>{list.find(row=>row.phase==='superseded').environment_failure_reason=' ';}],
        ['log',list=>{list.find(row=>row.phase==='superseded').failed_cases=['declared-test'];}],
        ['report',row=>{row.verdict='SKIPPED';},'TC-001']);
      if(precise.length)assert.equal(inspectCmAiQaResult({...query,testRunId:round2}).status,'passed');
      const contractFile=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contractBytes=fs.readFileSync(contractFile);
      for(const [target,tamper,caseId='declared-test'] of precise){
        const report=fs.readFileSync(firstReport,'utf8');
        if(target==='contract'){const contract=JSON.parse(contractBytes);tamper(contract);fs.writeFileSync(contractFile,JSON.stringify(contract));}
        else if(target==='report'){
          const parts=report.split(/^## /m),index=parts.findIndex(part=>part.startsWith(`${caseId}\n`));
          const body=parts[index].slice(caseId.length+1),row=JSON.parse(body);tamper(row);
          parts[index]=`${caseId}\n\n${JSON.stringify(row,null,2)}${body.match(/\s*$/)[0]}`;
          fs.writeFileSync(firstReport,parts.map((part,i)=>i?`## ${part}`:part).join(''));
        }else{const corrupt=rows();tamper(corrupt);fs.writeFileSync(log,corrupt.map(JSON.stringify).join('\n')+'\n');}
        assert.throws(()=>inspectCmAiQaResult({...query,testRunId:round2}),{code:'qa_result_invalid'},`${target} ${tamper}`);
        fs.writeFileSync(firstReport,report);fs.writeFileSync(log,after);fs.writeFileSync(contractFile,contractBytes);
      }
      if(precise.length)assert.equal(inspectCmAiQaResult({...query,testRunId:round2}).status,'passed');
    }
  }finally{f.cleanup();}
});

// A source change during QA (2026-10-06 author-column-T-009): files in scope were
// replaced mid-run. The executor marks every row BLOCKED/sourceChanged; a host
// before this fix wrote the report, then rejected stale_qa before `complete`,
// leaving qa_execution_unknown with no recovery path.
async function driftFixture({browserOnly=false,firstBrowser='PASS',commandFails=false,drift=true,confirmLogic=false}={}){
  const {createCmAiConversationEntry}=await import('../runtime/js/cm-ai/cm-ai-conversation-entry.mjs');
  const f=fixture();
  const sourceFile=path.join(f.configuration.codeProject,'source.mjs'),reviewed=fs.readFileSync(sourceFile);
  if(browserOnly){
    const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
    contract.cases=contract.cases.filter(item=>item.kind==='browser').map((item,index)=>({...item,id:`TC-00${index+1}`}));fs.writeFileSync(source,JSON.stringify(contract));
    f.configuration.commands[0].caseIds=[];
  }
  const artifact=path.join(f.binding.specsDir,'.reviews','browser.txt');fs.writeFileSync(artifact,'Synthetic observation');
  // A real product failure: the declared command exits 1 (an exit code, not unavailable).
  if(commandFails)f.configuration.commands[0].command=[process.execPath,'-e','process.exit(1)'];
  if(confirmLogic){
    const source=path.join(f.binding.specsDir,f.binding.feature,'test-cases.json'),contract=JSON.parse(fs.readFileSync(source));
    contract.cases[0].expected=['[需确认] synthetic expectation'];fs.writeFileSync(source,JSON.stringify(contract));
  }
  const state={round:0,browserCalls:0,stale:false};
  const executor=createHostQaExecutor({...f.configuration,
    logic:async()=>({verdict:'SUPPORTED',evidence:['Synthetic static observation']}),
    browser:async request=>{
      state.browserCalls++;
      if(state.round===0&&drift)fs.appendFileSync(sourceFile,'// replaced mid-QA\n');
      return {verdict:state.round===0?firstBrowser:'PASS',evidence:[artifact],environment:request.environment,cleanup:'completed'};
    }});
  const completed={state:'fixture_completed',code:null,identity:f.binding.identity,packageDigest:f.binding.packageDigest};
  const stale={...completed,code:'correction_review_required'};
  const {codeProject,testRunId,...query}=f.binding;
  const log=path.join(f.binding.specsDir,'运行日志.jsonl'),rows=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  const entry=(extra={})=>createCmAiConversationEntry({specsDir:query.specsDir,feature:query.feature,identity:query.identity,codeProject,
    runner:{status:()=>state.stale?stale:completed,executeEffect:()=>assert.fail('no development/Review replay'),
      cancel:()=>completed,run:()=>assert.fail('no task replay')},
    qaExecutor:{...executor,run:async(...args)=>{const result=await executor.run(...args);
      // The fix association notices the replaced files right after the run.
      if(state.round===0)state.stale=true;state.round++;return result;}},
    qaLogHome:f.configuration.logHome,qaDecisionProvider:{timeoutMs:1000,decide:()=>assert.fail('no repeated QA decision')},...extra});
  const advance={version:1,operation:'advance',requestId:'advance',identity:f.binding.identity};
  const restore=()=>{fs.writeFileSync(sourceFile,reviewed);state.stale=false;};
  const report=()=>path.join(f.binding.specsDir,'.reviews',`${rows().find(row=>row.phase==='start').operation_id}-execution.md`);
  const reportRows=()=>fs.readFileSync(report(),'utf8').split(/^## /m).slice(1).map(part=>{
    const split=part.indexOf('\n');return [part.slice(0,split),JSON.parse(part.slice(split+1))];}).filter(([name])=>name!=='deferred_cases');
  return {f,state,entry,advance,restore,rows,log,report,reportRows,query};
}

test('a stale QA run records what it observed (complete, BLOCKED/sourceChanged) before stale_qa, then reruns once restored',async()=>{
  const d=await driftFixture();
  try{
    const stale=await d.entry().handle(d.advance);
    assert.equal(stale.outcome,'rejected');assert.equal(stale.code,'stale_qa');
    const complete=d.rows().filter(row=>row.phase==='complete');
    assert.equal(complete.length,1);assert.equal(complete[0].result,'BLOCKED');assert.equal(complete[0].passed,0);
    for(const [,row] of d.reportRows()){assert.equal(row.sourceChanged,true);assert.equal(row.verdictBeforeSourceChange,'PASS');}
    d.restore();
    const blocked=await d.entry().handle(d.advance);
    assert.equal(blocked.code,'qa_result_blocked');
    const rerun=await d.entry({rerunBlockedQa:true}).handle(d.advance);
    assert.equal(rerun.code,'qa_passed',JSON.stringify(rerun));
    const superseded=d.rows().filter(row=>row.phase==='superseded');
    assert.equal(superseded.length,1);assert.equal(superseded[0].incomplete_report,undefined);
    assert.deepEqual(superseded[0].blocked_cases,['TC-001','TC-002','declared-test']);
    assert.deepEqual(d.rows().filter(row=>row.phase==='start').map(row=>row.attempt),[1,2]);
  }finally{d.f.cleanup();}
});

test('a source-changed row that was FAIL before the change is never rerun, and a forged pre-change verdict is refused',async()=>{
  const fail=await driftFixture({firstBrowser:'FAIL'});
  try{
    await fail.entry().handle(fail.advance);fail.restore();
    const refused=await fail.entry({rerunBlockedQa:true}).handle(fail.advance);
    assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');
    assert.equal(fail.rows().filter(row=>row.phase==='superseded').length,0);
  }finally{fail.f.cleanup();}
  // A command that really exited 1 before the change is a product FAIL: never rerun.
  const exited=await driftFixture({browserOnly:true,commandFails:true});
  try{
    await exited.entry().handle(exited.advance);exited.restore();
    assert.deepEqual(exited.reportRows().filter(([name])=>name==='declared-test').map(([,row])=>[row.verdict,row.verdictBeforeSourceChange,row.exitCode]),
      [['BLOCKED','FAIL',1]]);
    const refused=await exited.entry({rerunBlockedQa:true}).handle(exited.advance);
    assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');
    assert.equal(exited.rows().filter(row=>row.phase==='superseded').length,0);
  }finally{exited.f.cleanup();}
  const forged=await driftFixture();
  try{
    await forged.entry().handle(forged.advance);forged.restore();
    // The command really exited 1; the report claims it was PASS before the change.
    const text=fs.readFileSync(forged.report(),'utf8');
    fs.writeFileSync(forged.report(),text.replace(/("id": "declared-test",[\s\S]*?"exitCode": )0/,'$11'));
    const refused=await forged.entry({rerunBlockedQa:true}).handle(forged.advance);
    assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');
  }finally{forged.f.cleanup();}
});

// The exact T-009 history: report written, no complete row, report rows without
// verdictBeforeSourceChange (pre-fix executor). The log is never edited.
async function legacyIncomplete(options){
  const d=await driftFixture(options);
  const {recordCmAiQaRun:record}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
  const begun={...d.f.binding,logHome:d.f.configuration.logHome};
  const executor=d.entry();
  // Reproduce the pre-fix host: run, report, then no complete row.
  const qa=createHostQaExecutor({...d.f.configuration,logic:async()=>({verdict:'SUPPORTED',evidence:['Synthetic static observation']}),
    browser:async request=>{d.state.browserCalls++;fs.appendFileSync(path.join(d.f.configuration.codeProject,'source.mjs'),'// replaced\n');
      return {verdict:options?.firstBrowser??'PASS',evidence:[path.join(d.f.binding.specsDir,'.reviews','browser.txt')],environment:request.environment,cleanup:'completed'};}});
  const binding=begin(d.f,qa);await qa.run(binding,new AbortController().signal);
  void record;void begun;void executor;
  const text=fs.readFileSync(d.report(),'utf8');
  fs.writeFileSync(d.report(),text.replace(/,\n\s*"verdictBeforeSourceChange": "[A-Z]+"/g,''));
  d.state.round=1;d.restore();
  return d;
}

test('a pre-fix call with a fixed report but no complete row reruns under --rerun-blocked-qa; the log is only appended',async()=>{
  const d=await legacyIncomplete({browserOnly:true});
  try{
    assert.equal(d.rows().some(row=>row.phase==='complete'),false);
    assert.equal(d.reportRows().some(([,row])=>Object.hasOwn(row,'verdictBeforeSourceChange')),false);
    const before=fs.readFileSync(d.log);
    assert.equal((await d.entry().handle(d.advance)).code,'qa_execution_unknown');
    assert.equal((await d.entry({rerunUnknownQa:true}).handle(d.advance)).code,'qa_execution_unknown');
    assert.deepEqual(fs.readFileSync(d.log),before);
    const rerun=await d.entry({rerunBlockedQa:true}).handle(d.advance);
    assert.equal(rerun.code,'qa_passed',JSON.stringify(rerun));
    const after=fs.readFileSync(d.log);
    assert.deepEqual(after.subarray(0,before.length),before);
    const superseded=d.rows().filter(row=>row.phase==='superseded');
    assert.equal(superseded.length,1);assert.equal(superseded[0].incomplete_report,true);
    assert.deepEqual(superseded[0].blocked_cases,['TC-001','declared-test']);
    // Replay re-reads the same report: changing its Overall breaks the history.
    const text=fs.readFileSync(d.report(),'utf8');
    fs.writeFileSync(d.report(),text.replace('Overall: BLOCKED','Overall: PASS'));
    assert.throws(()=>readCmAiQaRunRound({...d.query,testRunId:d.rows().filter(row=>row.phase==='start')[1].operation_id}));
    fs.writeFileSync(d.report(),text);
  }finally{d.f.cleanup();}
});

test('a pre-fix incomplete call stays refused when a row cannot be told (legacy logic) or was a FAIL',async()=>{
  for(const options of [{},{browserOnly:true,firstBrowser:'FAIL'}]){
    const d=await legacyIncomplete(options);
    try{
      const before=fs.readFileSync(d.log);
      const refused=await d.entry({rerunBlockedQa:true}).handle(d.advance);
      assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence',JSON.stringify(options));
      assert.deepEqual(fs.readFileSync(d.log),before);
    }finally{d.f.cleanup();}
  }
});

test('a stale run with an all-PASS observation records no complete; only --rerun-unknown-qa discards and reruns it',async()=>{
  const d=await driftFixture({drift:false});
  try{
    const stale=await d.entry().handle(d.advance);
    assert.equal(stale.code,'stale_qa');
    assert.equal(d.rows().some(row=>row.phase==='complete'),false);
    assert.match(fs.readFileSync(d.report(),'utf8'),/^Overall: PASS$/m);
    d.restore();
    // Never read as a pass, by this run or by the project gate's latest-run reader.
    const {latestCmAiQaRun}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
    assert.throws(()=>latestCmAiQaRun(d.query),{code:'qa_result_incomplete'});
    assert.equal((await d.entry().handle(d.advance)).code,'qa_execution_unknown');
    assert.equal((await d.entry({rerunBlockedQa:true}).handle(d.advance)).code,'qa_rerun_not_blocked_by_evidence');
    // A forged PASS on the command row without its zero exit is not backed.
    const text=fs.readFileSync(d.report(),'utf8');
    fs.writeFileSync(d.report(),text.replace(/("id": "declared-test",[\s\S]*?"exitCode": )0/,'$11'));
    assert.equal((await d.entry({rerunUnknownQa:true}).handle(d.advance)).code,'qa_execution_unknown');
    fs.writeFileSync(d.report(),text);
    const rerun=await d.entry({rerunUnknownQa:true}).handle(d.advance);
    assert.equal(rerun.code,'qa_passed',JSON.stringify(rerun));
    assert.equal(d.rows().filter(row=>row.phase==='abandoned').length,1);
  }finally{d.f.cleanup();}
});

test('a pre-fix incomplete report cannot hide a real failure behind a PASS verdict, nor a [需确认] case behind a PASS pre-change verdict',async()=>{
  // The command really exited 1; only its final verdict is edited to PASS.
  const hidden=await legacyIncomplete({browserOnly:true,commandFails:true});
  try{
    const text=fs.readFileSync(hidden.report(),'utf8');
    fs.writeFileSync(hidden.report(),text.replace(/("id": "declared-test",\s*"kind": "commands",\s*"verdict": )"BLOCKED"/,'$1"PASS"'));
    assert.match(fs.readFileSync(hidden.report(),'utf8'),/"verdict": "PASS"/);
    const refused=await hidden.entry({rerunBlockedQa:true}).handle(hidden.advance);
    assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');
    assert.equal(hidden.rows().filter(row=>row.phase==='superseded').length,0);
  }finally{hidden.f.cleanup();}
  // The approved contract still says [需确认]; the report drops the marker and claims PASS before the change.
  const unconfirmed=await driftFixture({confirmLogic:true});
  try{
    await unconfirmed.entry().handle(unconfirmed.advance);unconfirmed.restore();
    const text=fs.readFileSync(unconfirmed.report(),'utf8');
    const parts=text.split(/^## /m),index=parts.findIndex(part=>part.startsWith('TC-001\n'));
    const body=parts[index].slice('TC-001'.length+1),row=JSON.parse(body);
    assert.equal(row.verdictBeforeSourceChange,'BLOCKED');assert.equal(row.needsConfirmation,true);
    delete row.needsConfirmation;row.verdictBeforeSourceChange='PASS';
    parts[index]=`TC-001\n\n${JSON.stringify(row,null,2)}${body.match(/\s*$/)[0]}`;
    fs.writeFileSync(unconfirmed.report(),parts.map((part,i)=>i?`## ${part}`:part).join(''));
    const refused=await unconfirmed.entry({rerunBlockedQa:true}).handle(unconfirmed.advance);
    assert.equal(refused.code,'qa_rerun_not_blocked_by_evidence');
  }finally{unconfirmed.f.cleanup();}
});

// 2026-10-07 AI潮: most QA BLOCKED rows were answer-form slips (evidence outside
// the QA directory, the reported device not the registered one), each spending a
// whole QA round. The host now asks such an answer back once, inside the case.
test('a browser answer with fixable form problems is asked back once and then judged as usual',async()=>{
  const f=fixture();
  try{
    f.configuration.commands[0].caseIds=[];
    const inside=path.join(f.binding.specsDir,'.reviews','qa-evidence','walk.txt');
    fs.mkdirSync(path.dirname(inside),{recursive:true});fs.writeFileSync(inside,'Synthetic observation');
    const outside=path.join(f.configuration.codeProject,'README.md');fs.writeFileSync(outside,'not QA evidence');
    // Inside the specs root but outside its .reviews directory: still not QA evidence.
    const specsOnly=path.join(f.binding.specsDir,'evidence','walk.txt');fs.mkdirSync(path.dirname(specsOnly));fs.writeFileSync(specsOnly,'x');
    const requests=[];
    const executor=createHostQaExecutor({...f.configuration,
      logic:async()=>({verdict:'INSUFFICIENT_EVIDENCE',evidence:['Synthetic static observation']}),
      browser:async request=>{requests.push(request);
        return request.correction?{verdict:'PASS',evidence:[inside],environment:request.environment,cleanup:'completed'}
          :{verdict:'PASS',evidence:[inside,outside,specsOnly],environment:request.environment,cleanup:'completed'};}});
    const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
    const rows=fs.readFileSync(result.report,'utf8').split(/^## /m).slice(1).map(part=>JSON.parse(part.slice(part.indexOf('\n')+1)));
    const browserRows=rows.filter(row=>row.kind==='browser');
    assert(browserRows.length>=1);
    for(const row of browserRows){
      assert.equal(row.verdict,'PASS');assert.equal(row.evidenceProblem,null);
      assert.deepEqual(row.answerCorrection.problems.map(item=>[item.code,item.path]),
        [['evidence_outside_reviews_or_missing',outside],['evidence_outside_reviews_or_missing',specsOnly]]);
      assert.equal(row.answerCorrection.first.verdict,'PASS');
    }
    // Each corrected case was asked exactly twice, the second time with the problems and the honesty instruction.
    assert.equal(requests.length,browserRows.length*2);
    const correction=requests.find(request=>request.correction).correction;
    assert.match(correction.instruction,/\.reviews directory of the specs root/);assert.match(correction.instruction,/Keep the verdict, environment and cleanup/);
    const log=fs.readFileSync(path.join(f.binding.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log.filter(row=>row.phase==='case_start').length,browserRows.length);
    assert.equal(log.filter(row=>row.phase==='case_blocked').length,0);
  }finally{f.cleanup();}
});

test('a correction is asked at most once, never for a BLOCKED answer, and a timed-out correction stays BLOCKED',async()=>{
  for(const mode of ['blocked','timeout','fail','environment']){
    const f=fixture();
    try{
      f.configuration.commands[0].caseIds=[];let calls=0;
      const executor=createHostQaExecutor({...f.configuration,
        logic:async()=>({verdict:'INSUFFICIENT_EVIDENCE',evidence:['Synthetic static observation']}),
        browser:async request=>{calls++;
          if(mode==='blocked')return {verdict:'BLOCKED',evidence:['simulator unreachable'],environment:{...request.environment,target:'x'},cleanup:'not_needed'};
          // A FAIL, or a PASS from another device, is never asked again (no FAIL→PASS, no field swap).
          if(mode==='fail')return {verdict:'FAIL',evidence:['not-a-file'],environment:request.environment,cleanup:'completed'};
          if(mode==='environment')return {verdict:'PASS',evidence:['not-a-file'],environment:{...request.environment,target:'another-device'},cleanup:'completed'};
          if(request.correction)throw Object.assign(new Error('timeout'),{code:'host_request_timeout'});
          return {verdict:'PASS',evidence:['not-a-file'],environment:request.environment,cleanup:'completed'};}});
      const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
      const rows=fs.readFileSync(result.report,'utf8').split(/^## /m).slice(1).map(part=>JSON.parse(part.slice(part.indexOf('\n')+1)))
        .filter(row=>row.kind==='browser');
      assert.equal(calls,rows.length*(mode==='timeout'?2:1),mode);
      for(const row of rows){
        assert.equal(row.verdict,'BLOCKED');
        if(mode!=='timeout')assert.equal(row.answerCorrection,undefined);
        if(mode==='blocked')assert.equal(row.hostDeclaredBlocked,true);
        else if(mode!=='timeout'){assert.equal(row.hostDeclaredBlocked,undefined);assert.equal(row.evidenceProblem,'qa_evidence_required');}
        else{assert.equal(row.hostRequestTimeout,true);assert.equal(row.hostDeclaredBlocked,undefined);
          assert.deepEqual(row.answerCorrection.problems.map(item=>item.code),['evidence_outside_reviews_or_missing']);}
      }
    }finally{f.cleanup();}
  }
});

test('a correction never changes anything but evidence: required cleanup not done is not asked, a changed answer does not pass',async()=>{
  for(const mode of ['cleanup-not-done','changed-cleanup']){
    const f=fixture();
    try{
      f.configuration.commands[0].caseIds=[];let calls=0;
      const inside=path.join(f.binding.specsDir,'.reviews','qa-evidence','walk.txt');
      fs.mkdirSync(path.dirname(inside),{recursive:true});fs.writeFileSync(inside,'Synthetic observation');
      const executor=createHostQaExecutor({...f.configuration,
        logic:async()=>({verdict:'INSUFFICIENT_EVIDENCE',evidence:['Synthetic static observation']}),
        browser:async request=>{calls++;
          const needsCleanup=request.case.cleanup.length>0;
          if(mode==='cleanup-not-done')return {verdict:'PASS',evidence:['not-a-file'],environment:request.environment,
            cleanup:needsCleanup?'not_needed':'not_needed'};
          // First answer is acceptable but for its evidence; the "correction" also flips cleanup.
          return request.correction?{verdict:'PASS',evidence:[inside],environment:request.environment,cleanup:needsCleanup?'not_needed':'completed'}
            :{verdict:'PASS',evidence:['not-a-file'],environment:request.environment,cleanup:needsCleanup?'completed':'not_needed'};}});
      const binding=begin(f,executor),result=await executor.run(binding,new AbortController().signal);
      const rows=fs.readFileSync(result.report,'utf8').split(/^## /m).slice(1).map(part=>JSON.parse(part.slice(part.indexOf('\n')+1)))
        .filter(row=>row.kind==='browser');
      const cleaned=rows.filter(row=>f.configuration&&row.id==='TC-002');
      assert(cleaned.length===1,'TC-002 requires cleanup in the fixture');
      const row=cleaned[0];
      assert.equal(row.verdict,'BLOCKED',mode);
      if(mode==='cleanup-not-done')assert.equal(row.answerCorrection,undefined);
      else{assert.equal(row.evidenceProblem,'qa_correction_changed_answer');assert.equal(row.answerCorrection.first.cleanup,'completed');}
    }finally{f.cleanup();}
  }
});
