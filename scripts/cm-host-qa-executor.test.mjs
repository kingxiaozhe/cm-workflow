import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {createHostQaDecisionProvider} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {recordCmAiQaDecision,recordCmAiQaRun,inspectCmAiQaResult} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';

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
    assert.equal(status.node,'N6');assert(status.detail.includes('TC-002: case_complete'));
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

for(const kind of ['qa_logic','qa_browser','qa_assess'])test(`QA request watchdog settles ${kind} as BLOCKED`,async()=>{
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
      const {testRunId,...binding}=f.binding;
      const decision=await createHostQaDecisionProvider({timeoutMs:1000,assess:call(kind)}).decide(binding,new AbortController().signal);
      assert.equal(decision.status,'blocked');assert.equal(decision.reason,'host_request_timeout');
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
