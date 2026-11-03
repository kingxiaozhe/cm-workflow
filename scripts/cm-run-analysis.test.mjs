import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withHostProgress,startHostProgress} from '../runtime/js/cm-ai/host-progress.mjs';
import {recordCmAiQaDecision,recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {analyzeRunRows,inspectRunAnalysis,runAnalysisLines} from '../runtime/js/run-analysis.mjs';
const cli=fileURLToPath(new URL('./cm-run-analysis.mjs',import.meta.url));
const base={run_id:'run-1',workflow:'cm-ai',runtime:'codex',stage:'develop',role:'developer',adapter:'codex-cli',requested_model:'configured',source:'native-cli-terminal',purpose:'workflow-execution'};
const claim=(id,extra={})=>({...base,event:'model_call',phase:'claimed',call_id:id,...extra});
const usage=(id,extra={})=>({...base,event:'model_usage',phase:'complete',call_id:id,usage_state:'observed',outcome:'success',input_tokens:10,output_tokens:5,...extra});
const progress=(phase,time,extra={})=>({run_id:'run-1',workflow:'cm-prd',event:'progress',phase,operation_id:'prd-design',phase_name:'design_generation',segment:1,at:`2026-01-01T00:${time}Z`,...(phase==='complete'?{outcome:'completed'}:{}),...extra});
function fixture(t,rows){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-analysis-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'运行日志.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return dir;}

test('reuses native usage identity, reasoning subset and unavailable semantics',()=>{
  const report=analyzeRunRows([claim('a'),usage('a',{outcome:'error',cache_write_tokens:3,reasoning_tokens:4}),claim('b'),usage('b',{usage_state:'unavailable',input_tokens:undefined,output_tokens:undefined}),claim('c')]);
  assert.equal(report.usage.status,'partial');assert.equal(report.usage.summary.observed_calls,1);
  assert.equal(report.usage.summary.outcomes.error,1);assert.equal(report.usage.summary.unavailable_calls,1);
  assert.equal(report.usage.summary.unresolved_claims,1);assert.equal(report.usage.summary.output_tokens,5);
  assert.equal(report.usage.native_components.fields.reasoning_tokens.tokens,4);
  assert.equal(report.usage.native_components.fields.cache_read_tokens.tokens,null);
  assert.equal(report.repetitions.groups[0].count,3);
});
test('claim mismatch, missing prior claim, duplicate call and invalid reasoning are never counted',()=>{
  const report=analyzeRunRows([usage('missing'),claim('a'),usage('a',{stage:'review'}),claim('b'),usage('b',{reasoning_tokens:6}),claim('c'),usage('c'),usage('c')]);
  assert.equal(report.usage.summary.observed_calls,1);assert.equal(report.usage.summary.invalid_calls,4);
  assert.equal(report.usage.summary.unresolved_claims,2);assert.equal(report.usage.status,'partial');
});
test('paired phase segments exclude waiting gaps and union combined call overlaps',()=>{
  const rows=[progress('start','00:00'),progress('complete','00:10',{outcome:'awaiting_input'}),
    progress('start','05:00',{segment:2,timing_scope:'combined_host_call'}),
    progress('start','05:00',{operation_id:'prd-task',phase_name:'task_split',timing_scope:'combined_host_call'}),
    progress('complete','05:20',{segment:2,timing_scope:'combined_host_call'}),
    progress('complete','05:20',{operation_id:'prd-task',phase_name:'task_split',timing_scope:'combined_host_call'})];
  const r=analyzeRunRows(rows).timing;assert.equal(r.activeIntervalUnionMs,30000);assert.equal(r.closedForInput,1);
  assert.equal(r.combinedSegments,2);assert.equal(r.waitingMs,null);assert.equal(r.stages[0].durationMs,30000);
});
test('timing never pairs across run, workflow, operation, duplicate or inverted order',()=>{
  const r=analyzeRunRows([progress('start','00:00'),progress('complete','00:10',{run_id:'run-2'}),
    progress('complete','00:10',{workflow:'cm-ai'}),progress('start','00:00',{operation_id:'duplicate'}),progress('start','00:00',{operation_id:'duplicate'}),progress('complete','00:10',{operation_id:'duplicate'}),
    progress('complete','00:10',{operation_id:'inverted'}),progress('start','00:00',{operation_id:'inverted'})]).timing;
  assert.equal(r.pairedSegments,0);assert.equal(r.activeIntervalUnionMs,null);assert.equal(r.incompleteSegments,4);assert.equal(r.unrecognizedEvents,1);
});
test('selects original run, deduplicates exact events, rejects conflicting identity and preserves legacy unknown',()=>{
  const a=claim('a',{event_id:'event-1'});const r=analyzeRunRows([a,a,usage('a'),claim('other',{run_id:'run-2'}),{event:'legacy'}],{runId:'run-1'});
  assert.deepEqual(r.runs,['run-1']);assert.equal(r.deduplicatedEvents,1);assert.equal(r.ignoredHistoricalRows,1);
  assert.equal(r.usage.summary.observed_calls,1);
  assert.throws(()=>analyzeRunRows([a,{...a,stage:'review'}]),/log_invalid/);
  assert.throws(()=>analyzeRunRows([a],{runId:'absent'}),/run_not_found/);
});
test('QA repetitions are unique operation starts, command execution remains unknown',()=>{
  const start={run_id:'run-1',workflow:'cm-ai',event:'test_run',phase:'start',feature:'1.login',task:'T-001',operation_id:'qa-1'};
  const r=analyzeRunRows([start,start,{...start,operation_id:'qa-2'}]).repetitions;
  assert.equal(r.groups[0].count,2);assert.equal(r.commandReexecution,'unavailable');
});
test('actual CLI reads one stable log and does not modify logs or state',t=>{
  const dir=fixture(t,[claim('a'),usage('a'),progress('start','00:00'),progress('complete','00:10')]);
  const state=path.join(dir,'.cm-run.json');fs.writeFileSync(state,'{"run_id":"do-not-use-pointer"}');
  const before=fs.readdirSync(dir).map(name=>[name,fs.readFileSync(path.join(dir,name)),fs.statSync(path.join(dir,name)).mtimeMs]);
  const result=spawnSync(process.execPath,[cli,'--specs',dir,'--run-id','run-1','--json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).usage.summary.observed_calls,1);
  for(const [name,bytes,mtime] of before){assert.deepEqual(fs.readFileSync(path.join(dir,name)),bytes);assert.equal(fs.statSync(path.join(dir,name)).mtimeMs,mtime);}
  assert.equal(fs.readdirSync(dir).length,before.length);
});
test('malformed, symlink and oversized authoritative logs fail closed without raw input',t=>{
  const dir=fixture(t,[]),file=path.join(dir,'运行日志.jsonl');fs.writeFileSync(file,'SECRET-BAD-JSON');
  let r=spawnSync(process.execPath,[cli,'--specs',dir,'--json'],{encoding:'utf8'});assert.equal(r.status,2);assert.doesNotMatch(r.stderr,/SECRET/);
  fs.unlinkSync(file);fs.writeFileSync(path.join(dir,'other'),'{}');fs.symlinkSync('other',file);assert.throws(()=>inspectRunAnalysis({specs:dir}),/unavailable/);
  fs.unlinkSync(file);fs.writeFileSync(file,'');fs.truncateSync(file,32*1024*1024+1);assert.throws(()=>inspectRunAnalysis({specs:dir}),/unavailable/);
});
test('missing Python is explicit unavailable and malicious labels never reach human output',()=>{
  const old=process.env.PATH;try{process.env.PATH='';const r=analyzeRunRows([claim('a'),usage('a')]);assert.equal(r.usage.status,'unavailable');assert.equal(r.usage.reason,'usage_reader_unavailable');}finally{process.env.PATH=old;}
  const r=analyzeRunRows([claim('a',{stage:'\u001b[31mSECRET'}),usage('a',{stage:'\u001b[31mSECRET'})]);
  assert.equal(r.usage.summary.observed_calls,0);assert.equal(r.usage.summary.invalid_claims,1);
  assert.doesNotMatch(runAnalysisLines(r).join('\n'),/SECRET|\u001b/);
});


test('actual AI progress producer: returned, failed, aborted and unfinished operations remain distinct',async t=>{
  const dir=fixture(t,[]),specsDir=dir,codeProject=path.join(dir,'code');fs.mkdirSync(codeProject);
  const definition={specsDir,codeProject,feature:'1.example'},identity={repositoryId:'analysis-fixture',runId:'run-ai-native',taskId:'T-001',attempt:1};
  const options={definition,identity,stage:'checking'};
  await withHostProgress({...options,signal:new AbortController().signal},async()=>({outcome:'failed'}));
  await assert.rejects(withHostProgress({...options,signal:new AbortController().signal},async()=>{throw Error('fixture failure');}),/fixture failure/);
  const controller=new AbortController(),p=startHostProgress({...options,signal:controller.signal});controller.abort();p.complete('returned');
  startHostProgress({...options,signal:new AbortController().signal});
  const rows=fs.readFileSync(path.join(dir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(rows.filter(x=>x.event==='progress').every(x=>!Object.hasOwn(x,'segment')));
  const report=inspectRunAnalysis({specs:dir}),timing=report.timing;
  assert.equal(timing.pairedSegments,3);assert.equal(timing.incompleteSegments,1);assert.equal(timing.unrecognizedEvents,0);
  assert.equal(timing.status,'partial');assert.deepEqual(timing.stages[0].outcomes,{returned:1,failed:1,aborted:1});
  assert.equal(timing.waitingMs,null);assert.equal(timing.closedForInput,0);
  assert.match(runAnalysisLines(report).join('\n'),/returned=1, failed=1, aborted=1/);
  const start=rows.find(x=>x.phase==='start');
  const wrong={...rows.find(x=>x.phase==='complete'),event_id:'wrong-task',task:'T-002'};
  assert.equal(analyzeRunRows([start,wrong]).timing.pairedSegments,0);
  assert.equal(analyzeRunRows([{...start,workflow:'cm-prd'}]).timing.unrecognizedEvents,1);
});

test('actual QA writer provides identity and operation fields consumed by repetition analysis',t=>{
  const dir=fixture(t,[]),codeProject=path.join(dir,'code');fs.mkdirSync(codeProject);
  const identity={repositoryId:'analysis-fixture',runId:'run-qa-native',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
  const binding={specsDir:dir,codeProject,feature:'1.example',identity,packageDigest,logHome:path.join(dir,'mirror')};
  recordCmAiQaDecision({...binding,decision:{decisionId:'qa-decision',identity,packageDigest,status:'triggered',score:null,reason:'api',at:'2026-01-01T00:00:00Z'}});
  recordCmAiQaRun({...binding,testRunId:'qa-operation-native',mode:'commands',caseCount:1,phase:'start'});
  const row=fs.readFileSync(path.join(dir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(x=>x.event==='test_run');
  assert.equal(row.operation_id,'qa-operation-native');assert.equal(row.feature,'1.example');assert.equal(row.task,'T-001');
  // A second distinct start follows the exact producer shape; does not simulate a QA verdict or retry authorization.
  const report=analyzeRunRows([row,{...row,event_id:'second-observed-start',operation_id:'qa-operation-2'}]);
  assert.equal(report.repetitions.groups[0].count,2);assert.equal(report.repetitions.groups[0].kind,'qa_invocation_start');
});

test('global event identity collisions across runs are rejected before usage deduplication',()=>{
  const a=usage('a',{event_id:'same-event'}),b=usage('b',{run_id:'run-2',event_id:'same-event'});
  assert.throws(()=>analyzeRunRows([a,b]),/log_invalid/);
  assert.throws(()=>analyzeRunRows([a,b],{runId:'run-1'}),/log_invalid/);
});
