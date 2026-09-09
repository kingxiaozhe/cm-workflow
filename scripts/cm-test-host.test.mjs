import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmTestHost} from '../runtime/js/cm-test/host.mjs';
import {inspectCmTestRecovery} from '../runtime/js/cm-test/recovery.mjs';
import {snapshotSource,sourceChanges} from '../runtime/js/cm-test/source-snapshot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const contract=(kind='logic')=>({schemaVersion:'1.0',feature:'guide',cases:[{id:'TC-001',origin:'user',kind,blocking:true,
  acIds:[],taskIds:[],title:'Reject invalid input',preconditions:[],steps:['Call invalid input'],expected:['Returns error'],cleanup:[]}]});
function fixture(t,args={}){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-test-host-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'input.mjs'),'export const valid = value => value !== null;\n');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Declared test: node --version\n');
  const cases=path.join(temp,'cases.json');fs.writeFileSync(cases,JSON.stringify(contract()));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',arguments:{cases,logic:true,...args},
    sources:['input.mjs','AGENTS.md'],commands:[],environment:{scope:'local',kind:'web',carrier:'browser',target:'http://127.0.0.1:3000'},logHome:path.join(temp,'logs')};
  return {temp,project,cases,config};
}
const logicReply=payload=>({contractDigest:payload.contractDigest,results:payload.contract.cases.filter(item=>item.kind==='logic')
  .map(item=>({id:item.id,verdict:'SUPPORTED',evidence:[{path:'input.mjs',line:1}],explanation:'Invalid input -> validation branch -> rejected'}))});
async function run(config,call){return createCmTestHost(config,{call}).handle({requestId:'run',operation:'start'});}

test('actual shared CLI: Codex and Claude logic -> immutable report and closed original log',async t=>{
  for(const runtime of ['codex','claude']){
    const {temp,config}=fixture(t);config.runtime=runtime;
    const configPath=path.join(temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
    const child=spawn(process.execPath,[path.join(root,'scripts/cm-test-host.mjs'),'serve','--config',configPath],{stdio:['pipe','pipe','pipe']});
    const closed=once(child,'close'),lines=createInterface({input:child.stdout});let sessionId,result,calls=0,stderr='';
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',chunk=>{stderr+=chunk;});
    t.after(()=>child.kill());
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'run',operation:'start'});}
      else if(message.type==='host_request'){
        calls++;assert.equal(message.kind,'qa_logic');
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result:logicReply(message.payload)});
      }else if(message.requestId==='run'){result=message.result;send({type:'host_close',sessionId});}
    }
    assert.equal((await closed)[0],0,stderr);assert.equal(calls,1,JSON.stringify(result));
    assert.equal(result.overall,'REVIEWED',JSON.stringify(result));assert.equal(result.executionPassed,0);
    assert.equal(result.completionAuthorized,false);assert.ok(fs.readFileSync(result.report,'utf8').includes('not execution PASS'));
    const logs=fs.readdirSync(path.join(config.logHome,'runs'),{recursive:true}).filter(name=>name.endsWith('.jsonl'));
    const events=logs.flatMap(name=>fs.readFileSync(path.join(config.logHome,'runs',name),'utf8').trim().split('\n').map(JSON.parse));
    assert.equal(events.at(-1).event,'run_done');assert.ok(events.some(event=>event.event==='test_run'&&event.phase==='complete'));
  }
});
test('generation hard-stops with validated inferred drafts, never calls execution',async t=>{
  const {config}=fixture(t);config.arguments={description:'Validation',generateCases:true};let calls=0;
  const result=await run(config,async kind=>{calls++;assert.equal(kind,'test_cases');return {contract:contract(),report:'# Generation\nScope: validation; source input.mjs:1; expected needs confirmation.'};});
  assert.equal(result.overall,'GENERATED',JSON.stringify(result));assert.equal(calls,1);assert.equal(result.executionPassed,0);
  const draft=JSON.parse(fs.readFileSync(result.artifacts[0],'utf8'));
  assert.equal(draft.cases[0].origin,'inferred');assert.match(draft.cases[0].expected[0],/^\[需确认\]/);
});
test('all: actual declared command plus synthetic browser evidence, no model command authority',async t=>{
  const {config,cases}=fixture(t);config.arguments={cases,all:true};
  const value=contract();value.cases.push({...contract('browser').cases[0],id:'TC-002'});fs.writeFileSync(cases,JSON.stringify(value));
  config.commands=[{id:'version',command:['node','--version'],caseIds:['TC-001'],declaration:{path:'AGENTS.md',line:1}}];
  const result=await run(config,async(kind,payload)=>{
    if(kind==='qa_logic')return logicReply(payload);
    assert.equal(kind,'qa_browser');fs.mkdirSync(payload.reportDir,{recursive:true});
    const evidence=path.join(payload.reportDir,'browser.md');fs.writeFileSync(evidence,'Synthetic browser observation, not live browser proof');
    return {verdict:'PASS',evidence:[evidence],environment:payload.environment,cleanup:'not_needed'};
  });
  assert.equal(result.overall,'PASS',JSON.stringify(result));assert.equal(result.rows.find(row=>row.kind==='commands').exitCode,0);
  assert.equal(result.executionPassed,2);assert.equal(result.completionAuthorized,false);
});
test('source mutation and fabricated evidence block; user changes are not rolled back',async t=>{
  for(const mode of ['drift','bad-line','path-escape']){
    const {config,project}=fixture(t);
    const result=await run(config,async(kind,payload)=>{
      const reply=logicReply(payload);
      if(mode==='drift')fs.writeFileSync(path.join(project,'input.mjs'),'User changed this file');
      if(mode==='bad-line')reply.results[0].evidence[0].line=999;
      if(mode==='path-escape')reply.results[0].evidence[0].path='../outside.mjs';
      return reply;
    });
    assert.equal(result.overall,'BLOCKED',JSON.stringify(result));
    if(mode==='drift'){assert.ok(result.sourceChanges.includes('input.mjs'));assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),'User changed this file');}
  }
});
test('report aliases into source are rejected before any callback/write',t=>{
  const {config,project,temp}=fixture(t);
  fs.symlinkSync(project,path.join(temp,'alias'),'dir');config.arguments.reportDir=path.join(temp,'alias','src');
  assert.throws(()=>createCmTestHost(config,{call:()=>assert.fail()}),/cm_test_report_path_invalid/);
});
test('specs-local logging remains authoritative without mistaking audit writes for source edits',async t=>{
  const {config,project}=fixture(t),specs=path.join(project,'specs'),feature=path.join(specs,'1.guide');
  fs.mkdirSync(feature,{recursive:true});
  for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(feature,'test-cases.json'),JSON.stringify(contract()));
  config.arguments={specs,logic:true};
  const result=await run(config,async(kind,payload)=>logicReply(payload));
  assert.equal(result.overall,'REVIEWED',JSON.stringify(result));
  assert.ok(result.report.startsWith(path.join(specs,'.reviews')));
  const events=fs.readFileSync(path.join(specs,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).event,'run_done');assert.equal(result.sourceChanges.length,0);
  const added=path.join(specs,'2.later');fs.mkdirSync(added);
  for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(added,name),'# Later feature\n');
  assert.equal(inspectCmTestRecovery(config,result).status,'recovered');
});
test('Git snapshot catches edits within the same dirty status and excludes only this report',t=>{
  const {project}=fixture(t),report=path.join(project,'docs/test-reports/current');
  const git=(...args)=>{const result=spawnSync('git',args,{cwd:project});assert.equal(result.status,0,result.stderr.toString());};
  git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const file=path.join(project,'input.mjs');fs.writeFileSync(file,'first edit');
  const before=snapshotSource(project,report);fs.writeFileSync(file,'second edit');
  fs.mkdirSync(report,{recursive:true});fs.writeFileSync(path.join(report,'result.md'),'report');
  assert.deepEqual(sourceChanges(before,snapshotSource(project,report)),['input.mjs']);
});
test('review regression: existing specs contract cannot upgrade generated draft origin',async t=>{
  const {config,project}=fixture(t),specs=path.join(project,'specs'),feature=path.join(specs,'1.guide');
  fs.mkdirSync(feature,{recursive:true});
  for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(feature,'test-cases.json'),JSON.stringify(contract()));
  config.arguments={specs,feature:'1.guide',generateCases:true};let calls=0;
  const result=await run(config,async(kind,payload)=>{
    calls++;assert.equal(kind,'test_cases');assert.equal(payload.operation,'generate');assert.ok(payload.caseText);
    const value=contract();value.cases.push({...value.cases[0],id:'TC-002',origin:'inferred',title:'New inferred case'});
    return {contract:value,report:'# Generation\nExisting and new cases; input.mjs:1; expected intent unconfirmed.'};
  });
  assert.equal(result.overall,'GENERATED',JSON.stringify(result));assert.equal(calls,1);
  const draft=JSON.parse(fs.readFileSync(result.artifacts[0],'utf8'));
  for(const item of draft.cases){assert.equal(item.origin,'inferred');assert.ok(item.expected.every(value=>value.startsWith('[需确认]')));}
  assert.equal(JSON.parse(fs.readFileSync(path.join(feature,'test-cases.json'),'utf8')).cases.length,1);
});
test('review regression: missing commands do not hide observed blocking FAIL',async t=>{
  const {config,cases}=fixture(t);config.arguments={cases,all:true};
  fs.writeFileSync(cases,JSON.stringify(contract('browser')));
  const result=await run(config,async(kind,payload)=>{
    assert.equal(kind,'qa_browser');fs.mkdirSync(payload.reportDir,{recursive:true});
    const evidence=path.join(payload.reportDir,'failure.md');fs.writeFileSync(evidence,'Synthetic assertion failure');
    return {verdict:'FAIL',evidence:[evidence],environment:payload.environment,cleanup:'not_needed'};
  });
  assert.equal(result.overall,'FAIL',JSON.stringify(result));assert.ok(result.problems.includes('No declared project commands'));
  assert.equal(result.sourceChanges.length,0);assert.equal(result.executionPassed,0);
});
test('recovery: new CLI reads historical result without callbacks, rejects changed report/config',async t=>{
  const {temp,config}=fixture(t);
  const result=await run(config,async(kind,payload)=>logicReply(payload));
  assert.equal(result.overall,'REVIEWED',JSON.stringify(result));
  const configPath=path.join(temp,'recover-config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  const output=spawnSync(process.execPath,[path.join(root,'scripts/cm-test-host.mjs'),'inspect','--config',configPath,
    '--run-id',result.runId,'--log-file',result.logFile],{encoding:'utf8'});
  assert.equal(output.status,0,output.stderr);const restored=JSON.parse(output.stdout);
  assert.equal(restored.status,'recovered');assert.equal(restored.overall,'REVIEWED');
  assert.equal(restored.historical,true);assert.equal(restored.currentSourceVerified,false);assert.equal(restored.automaticReplayAllowed,false);
  fs.unlinkSync(config.arguments.cases);
  assert.equal(inspectCmTestRecovery(config,result).status,'recovered');
  assert.throws(()=>inspectCmTestRecovery({...config,sources:['AGENTS.md']},result),/cm_test_config_changed/);
  fs.appendFileSync(result.report,'User report edit');
  assert.throws(()=>inspectCmTestRecovery(config,result),/cm_test_report_changed/);
});
test('recovery: crash prefix returns pending stage, never success or automatic retry',async t=>{
  const {config}=fixture(t);const result=await run(config,async(kind,payload)=>logicReply(payload));
  const events=fs.readFileSync(result.logFile,'utf8').trim().split('\n').map(JSON.parse);
  const stop=events.findIndex(event=>event.event==='decision'&&event.phase==='test_stage');assert.ok(stop>=0);
  fs.writeFileSync(result.logFile,events.slice(0,stop+1).map(event=>JSON.stringify(event)).join('\n')+'\n');
  const before=fs.readFileSync(result.logFile),restored=inspectCmTestRecovery(config,result);
  assert.equal(restored.status,'interrupted');assert.equal(restored.overall,null);assert.equal(restored.lastStage,'qa_logic');
  assert.equal(restored.runClosed,false);assert.equal(restored.automaticReplayAllowed,false);
  assert.deepEqual(fs.readFileSync(result.logFile),before);
});
