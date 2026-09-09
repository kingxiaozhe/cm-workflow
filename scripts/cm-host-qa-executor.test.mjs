import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const input={...f.binding,mode:executor.mode,caseCount:executor.caseCount};
  recordCmAiQaRun({...input,phase:'start',logHome:f.configuration.logHome});
  return input;
}

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
