import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const original='export const calc = x => x < 0 ? 0 : x + 1;\n';
const replacement='export function calc(x) { if (x < 0) return 0; return x + 1; }\n';
function fixture(t){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-refactor-host-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'input.mjs'),original);
  fs.writeFileSync(path.join(project,'baseline.mjs'),"import assert from 'node:assert/strict'; import {calc} from './input.mjs'; assert.equal(calc(-1),0); assert.equal(calc(2),3);\n");
  fs.writeFileSync(path.join(project,'judge.mjs'),"import {calc} from './input.mjs'; console.log(JSON.stringify({cases:[-2,0,2].map((x,i)=>({id:String(i),input:x,output:calc(x)}))}));\n");
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  return {temp,project,config:{skillDir:path.join(root,'skills/cm-refactor'),project,specs:null,runtime:'codex',
    target:'Synthetic structure-only refactor',slug:'extract',scope:['input.mjs'],crossModule:false,
    baselineCommands:[{id:'baseline',command:[process.execPath,'baseline.mjs']}],judgeCommand:[process.execPath,'judge.mjs'],
    mutations:[{path:'input.mjs',find:'x + 1',replace:'x + 2'},{path:'input.mjs',find:'x < 0',replace:'x < -5'}],logHome:path.join(temp,'logs')}};
}
function response(kind,payload,mode='normal'){
  if(kind==='refactor_analyze')return {decision:'proceed',metric:{name:'Synthetic nesting',before:2,unit:'levels'},impact:[],claimedMemos:[],reason:'Synthetic simplification'};
  if(kind==='refactor_confirm')return {decision:mode==='reject'?'rejected':'approved'};
  if(kind==='refactor_apply')return {files:[{path:'input.mjs',beforeDigest:digest(original),content:mode==='behavior-change'?replacement.replace('x + 1','x + 9'):replacement}],
    summary:'Synthetic explicit function extraction',metricAfter:1,unfixedDefects:[],conventions:[],
    learningApplication:'No additional relevant project lesson in this fixture',learningRetrospective:'no_new_lesson'};
  assert.equal(kind,'refactor_review');
  return {markdown:`---\nat: 2026-09-08T18:00:00+00:00\nreviewer: codex-subagent\nindependent: true\ntask: ${payload.task}\nattempt: ${payload.attempt}\nround: ${payload.attempt}\nverdict: approved\nblocking_findings: 0\nhandoff: ${path.basename(payload.handoff)}\nhandoff_sha256: ${mode==='stale-review'?'0'.repeat(64):payload.handoffSha256}\nscope:\n  - input.mjs\n---\n\nZero findings in synthetic review; not a live independent reviewer invocation.\n`};
}
test('light-track actual CLI: both runtimes use real baseline/mutations/differential and original gates',async t=>{
  for(const runtime of ['codex','claude']){
    const {config,temp,project}=fixture(t);config.runtime=runtime;
    if(runtime==='codex'){config.specs=path.join(temp,'specs');fs.mkdirSync(config.specs);}
    const configPath=path.join(temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
    const child=spawn(process.execPath,[path.join(root,'scripts/cm-refactor-host.mjs'),'serve','--config',configPath],{stdio:['pipe','pipe','pipe']});
    const closed=once(child,'close'),lines=createInterface({input:child.stdout});let sessionId,result,stderr='';
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',chunk=>{stderr+=chunk;});t.after(()=>child.kill());
    for await(const line of lines){const message=JSON.parse(line);
      if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'start',operation:'start'});}
      else if(message.type==='host_request')send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result:response(message.kind,message.payload)});
      else if(message.requestId==='start'){
        assert.equal(message.result.stage,'awaiting_finish',JSON.stringify(message));send({requestId:'finish',operation:'finish'});
      }else if(message.requestId==='finish'){result=message.result;send({type:'host_close',sessionId});}
    }
    assert.equal((await closed)[0],0,stderr);assert.equal(result.stage,'done',JSON.stringify(result));
    assert.equal(result.differentialCount,3);assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),replacement);
    assert.equal(result.completionAuthorized,false);assert.ok(result.reports.some(file=>file.endsWith('-r1.md')));
    if(config.specs){assert.match(fs.readFileSync(path.join(config.specs,'METRICS.md'),'utf8'),/\| refactor \|/);
      const status=JSON.parse(fs.readFileSync(path.join(config.specs,'.cm-status.json'),'utf8'));
      assert.equal(status.node,'REFACTOR');assert.equal(status.state,'run_done');
      assert.match(fs.readFileSync(path.join(config.specs,'运行日志.jsonl'),'utf8'),/"event":"run_done"/);}
  }
});
test('G0 rejection never mutates or executes the judge',async t=>{
  const {config,project}=fixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload,'reject')});
  const result=await host.handle({requestId:'start',operation:'start'});
  assert.equal(result.stage,'rejected');assert.equal(result.commandCount,0);assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
});
test('behavior regression restores only the controlled file and blocks review',async t=>{
  const {config,project}=fixture(t);let reviewCalls=0;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{if(kind==='refactor_review')reviewCalls++;return response(kind,payload,'behavior-change');}});
  const result=await host.handle({requestId:'start',operation:'start'});
  assert.equal(result.stage,'blocked',JSON.stringify(result));assert.equal(reviewCalls,0);
  assert.equal(result.reason,'refactor_baseline_failed');
  assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
});
test('stale independent-review header cannot bypass existing N5',async t=>{
  const {config}=fixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload,'stale-review')});
  const result=await host.handle({requestId:'start',operation:'start'});
  assert.equal(result.stage,'blocked');assert.match(result.reason,/digest/);
});

function fullResponse(kind,payload){
  if(kind==='refactor_review'){
    const value=response(kind,payload);value.markdown=value.markdown.replace('  - input.mjs',payload.files.map(file=>'  - '+file.path).join('\n'));return value;
  }
  if(kind==='refactor_prepare_tests')return {files:payload.assets.map(file=>({...file,content:file.path==='baseline.mjs'
    ?"import assert from 'node:assert/strict'; import {calc} from './input.mjs'; assert.equal(calc(2),3);\n"
    :"import {calc} from './input.mjs'; console.log(JSON.stringify({cases:[-2,0,2].map((x,i)=>({id:String(i),input:x,output:calc(x)}))}));\n"}))};
  if(kind==='refactor_retrospective')return {learningApplication:'Apply original behavior contract',learning:{status:'lesson_candidate',reason:null,
    candidates:[{classification:'structured',trigger:'Boundary-sensitive refactor',action:'Keep negative inputs in differential judge',evidence:['judge.mjs']}]},
    conventions:[{path:'.claude/rules/shape.md',text:'Use named function exports.',evidence:['input.mjs']}],documentation:payload.files.filter(file=>file.path==='README.md')
      .map(file=>({...file,content:(file.content??'')+'\nRefactored module structure.\n'})),resolved:(payload.needs??[]).map(item=>item.id),unfixedDefects:[],metricAfter:1};
  if(kind==='refactor_batch'){
    if(payload.action==='plan')return {rulebook:'Named functions; preserve values; do not fix bugs.',units:payload.files.filter(file=>!payload.assemblyFiles.includes(file.path))
      .map((file,i)=>({id:`unit-${i}`,files:[file.path],dependsOn:i?[`unit-${i-1}`]:[]})),sample:['input.mjs'],perFileEstimate:300,reason:'Reduce nesting'};
    if(payload.action==='bakeoff')return {channelId:payload.variant,files:payload.files.map(file=>({...file,content:replacement}))};
    if(payload.action==='adjudicate')return {channelId:'third',rulebook:payload.rulebook,decisions:[]};
    if(payload.action==='assemble')return {files:payload.files.map(file=>({...file,content:'export {calc} from "./input.mjs";\n'})),resolved:payload.needs.map(item=>item.id)};
    if(payload.action==='generate')return {files:payload.files.map(file=>({...file,content:file.path==='old.mjs'?null:
      (file.path==='input.mjs'?replacement:'export const helper = 1;\n')+'// REFACTOR STATUS: confidence=high todos=0\n'})),
      needs:payload.files[0].path==='input.mjs'?[{id:'entry-wire',path:'entry.mjs',instruction:'Preserve entry export'}]:[],summary:'Structure only'};
    if(payload.action==='diagnose')return {errorClass:'syntax',reason:'Same generator rule produces invalid syntax'};
  }
  return response(kind,payload);
}
async function finishInProcess(t,config,temp){
  const configPath=path.join(temp,'resume-config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-refactor-host.mjs'),'serve','--config',configPath],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});let sessionId,result,stderr='';
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',chunk=>{stderr+=chunk;});t.after(()=>child.kill());
  for await(const line of lines){const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'finish',operation:'finish'});}
    else if(message.type==='host_request'){
      assert.equal(message.kind,'refactor_confirm');assert.equal(message.payload.gate,'finish');
      send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result:{decision:'approved'}});
    }else if(message.requestId==='finish'){result=message.result;send({type:'host_close',sessionId});}
  }
  assert.equal((await closed)[0],0,stderr);return result;
}
test('missing judge assets, Learning, memo reconciliation and new-process finish use one reviewed path',async t=>{
  const {config,project,temp}=fixture(t);config.specs=path.join(temp,'specs');fs.mkdirSync(config.specs);
  fs.writeFileSync(path.join(config.specs,'LESSONS.md'),'## 待触发备忘\n- [待触发] 重构 input 分支\n');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'# Project\n\nKeep existing instructions.\n');fs.writeFileSync(path.join(project,'README.md'),'# Example\n');
  fs.unlinkSync(path.join(project,'baseline.mjs'));fs.unlinkSync(path.join(project,'judge.mjs'));
  config.testSetup={paths:['baseline.mjs','judge.mjs']};config.writebackPaths=['AGENTS.md','README.md'];let calls=0;
  const call=async(kind,payload)=>{calls++;const result=fullResponse(kind,payload);
    if(kind==='refactor_analyze')result.claimedMemos=['- [待触发] 重构 input 分支'];return result;};
  const host=createCmRefactorHost(config,{call});const started=await host.handle({requestId:'start',operation:'start'});
  assert.equal(started.stage,'awaiting_finish',JSON.stringify(started));const before=calls;
  const finished=await finishInProcess(t,config,temp);assert.equal(finished.stage,'done',JSON.stringify(finished));assert.equal(calls,before);
  assert.match(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),/Keep existing instructions[\s\S]*Boundary-sensitive refactor/);
  const lessons=fs.readFileSync(path.join(config.specs,'LESSONS.md'),'utf8');assert.match(lessons,/已认领/);assert.match(lessons,/仅记忆/);
  assert.equal((fs.readFileSync(path.join(project,'AGENTS.md'),'utf8').match(/cm-learning-v1/g)??[]).length,1);
  const reopened=createCmRefactorHost(config,{call:async()=>{throw Error('must not call');}});
  assert.equal((await reopened.handle({requestId:'again',operation:'finish'})).stage,'done');
  fs.appendFileSync(path.join(project,'input.mjs'),'// user changed after completion\n');
  const status=await reopened.handle({requestId:'status',operation:'status'});assert.equal(status.stage,'correction_required');assert.equal(status.historicalStage,'done');
});
test('batch uses bakeoff, pilot, disk units, add/delete and owner assembly before final review',async t=>{
  const {config,project}=fixture(t);fs.writeFileSync(path.join(project,'old.mjs'),'export const old = true;\n');
  fs.writeFileSync(path.join(project,'entry.mjs'),'export {calc} from "./input.mjs"; // original\n');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'# Project\n');
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]){
    const out=spawnSync('git',args,{cwd:project});assert.equal(out.status,0,out.stderr.toString());}
  config.scope=['input.mjs','new.mjs','old.mjs','entry.mjs'];config.batch={assemblyFiles:['entry.mjs'],cheapCommands:[{id:'syntax',command:[process.execPath,'--check','{file}']}],maxPasses:6};
  config.writebackPaths=['AGENTS.md'];const kinds=[];let generation=0,ruleRevisions=0;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    kinds.push(payload.action??kind);const result=fullResponse(kind,payload);
    if(kind==='refactor_confirm'&&payload.gate==='rulebook_revision')ruleRevisions++;
    if(kind==='refactor_batch'&&payload.action==='generate'&&payload.files[0].path==='input.mjs'){
      generation++;if(generation>=2&&generation<=4)result.files[0].content='export const calc = ;\n// REFACTOR STATUS: confidence=low todos=0\n';}
    return result;}});
  const started=await host.handle({requestId:'start',operation:'start'});assert.equal(started.stage,'awaiting_finish',JSON.stringify(started));
  const finished=await host.handle({requestId:'finish',operation:'finish'});assert.equal(finished.stage,'done',JSON.stringify(finished));
  assert.equal(fs.existsSync(path.join(project,'old.mjs')),false);assert.ok(fs.existsSync(path.join(project,'new.mjs')));
  assert.equal(kinds.filter(kind=>kind==='bakeoff').length,2);assert.equal(kinds.filter(kind=>kind==='refactor_review').length,1);
  assert.equal(ruleRevisions,1);assert.equal(kinds.filter(kind=>kind==='diagnose').length,3);
  assert.ok(kinds.includes('assemble'));assert.match(fs.readFileSync(path.join(project,'docs/refactors/extract/batch-log.jsonl'),'utf8'),/"diff_pass":true/);
});
test('interrupted host invocation needs reconciliation, then resumes without repeating the review',async t=>{
  const {config}=fixture(t);let request=null;
  const broken=createCmRefactorHost(config,{call:async(kind,payload)=>{if(kind==='refactor_review'){request=payload;throw Error('connection lost');}return response(kind,payload);}});
  assert.equal((await broken.handle({requestId:'start',operation:'start'})).stage,'blocked');
  let reviews=0;
  const reopened=createCmRefactorHost(config,{call:async(kind,payload)=>{
    if(kind==='refactor_recover')return {decision:'completed',evidence:'Synthetic recorded reviewer response from original call',
      result:{value:response('refactor_review',request),durationMs:1}};
    if(kind==='refactor_review')reviews++;return response(kind,payload);}});
  const resumed=await reopened.handle({requestId:'resume',operation:'resume'});assert.equal(resumed.stage,'awaiting_finish',JSON.stringify(resumed));assert.equal(reviews,0);
  const finished=await reopened.handle({requestId:'finish',operation:'finish'});assert.equal(finished.stage,'done',JSON.stringify(finished));
});

test('pending finish keeps its key; approved finish replays frozen budget after archival interruption',async t=>{
  const {config,project}=fixture(t);let confirmations=0,reconciliations=0;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    if(kind==='refactor_confirm'&&payload.gate==='finish'){confirmations++;throw Error('lost finish response');}return response(kind,payload);}});
  assert.equal((await host.handle({requestId:'start',operation:'start'})).stage,'awaiting_finish');
  assert.equal((await host.handle({requestId:'finish',operation:'finish'})).stage,'blocked');
  const recovered=createCmRefactorHost(config,{call:async(kind,payload)=>{
    assert.equal(kind,'refactor_recover');assert.equal(payload.input.kind,'refactor_confirm');reconciliations++;
    return {decision:'completed',result:{value:{decision:'approved'},durationMs:51},evidence:'Synthetic original confirmation receipt'};}});
  const finished=await recovered.handle({requestId:'finish',operation:'finish'});assert.equal(finished.stage,'done',JSON.stringify(finished));
  assert.equal(confirmations,1);assert.equal(reconciliations,1);
  const file=path.join(project,'docs/refactors/extract/execution.jsonl'),rows=fs.readFileSync(file,'utf8').trimEnd().split('\n');
  const index=rows.findIndex(line=>{const row=JSON.parse(line);return row.type==='result'&&row.key==='host/finish-1';});assert.ok(index>=0);
  // Isolated crash-prefix fixture: approval persisted, later archive/checkpoint records did not.
  fs.writeFileSync(file,rows.slice(0,index+1).join('\n')+'\n');
  const retry=createCmRefactorHost(config,{call:async()=>{throw Error('approval must not be requested again');}});
  const repeated=await retry.handle({requestId:'finish',operation:'finish'});assert.equal(repeated.stage,'done',JSON.stringify(repeated));
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/host\/finish-2/);
});
test('interrupted resume differential reconciles original round before creating another command',async t=>{
  const {config,project}=fixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload)});
  assert.equal((await host.handle({requestId:'start',operation:'start'})).stage,'awaiting_finish');
  assert.equal((await host.handle({requestId:'resume',operation:'resume'})).stage,'awaiting_finish');
  const file=path.join(project,'docs/refactors/extract/execution.jsonl'),lines=fs.readFileSync(file,'utf8').trimEnd().split('\n'),rows=lines.map(line=>JSON.parse(line));
  const key='command/resume-check/1/differential',index=rows.findIndex(row=>row.type==='intent'&&row.key===key);
  const originalResult=rows.find(row=>row.type==='result'&&row.key===key).result;assert.ok(index>=0);
  fs.writeFileSync(file,lines.slice(0,index+1).join('\n')+'\n');let reconciliations=0;
  const reopened=createCmRefactorHost(config,{call:async(kind,payload)=>{
    assert.equal(kind,'refactor_recover');assert.equal(payload.kind,'command');reconciliations++;
    return {decision:'completed',result:originalResult,cleanupConfirmed:true,evidence:'Synthetic original command result and confirmed cleanup'};}});
  const resumed=await reopened.handle({requestId:'resume',operation:'resume'});assert.equal(resumed.stage,'awaiting_finish',JSON.stringify(resumed));
  assert.equal(reconciliations,1);assert.doesNotMatch(fs.readFileSync(file,'utf8'),/command\/resume-check\/2\//);
});
