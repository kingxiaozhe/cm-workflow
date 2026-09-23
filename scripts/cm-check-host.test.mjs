import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmCheckHost} from '../runtime/js/cm-check/host.mjs';

// Keep runtime declarations and log mirrors independent of the invoking user's home.
const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-host-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));
const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t,exitCode=0){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-host-'))),project=path.join(dir,'project');fs.mkdirSync(project);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of ['scripts/cm-check-entry.mjs','scripts/cm-check-host.mjs','scripts/cm-workflow-config.mjs','runtime/js/cm-check/host.mjs',
    'runtime/js/cm-ai/host-tool-bridge.mjs','runtime/js/cm-ai/host-session.mjs','runtime/js/cm-ai/effect-contract.mjs',
    'runtime/js/cm-ai/contracts.mjs','runtime/js/cm-init/draft-inspection.mjs','skills/cm-check/SKILL.md']){
    fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(dir,file));
  }
  fs.writeFileSync(path.join(dir,'VERSION'),'0.0.0\n');fs.writeFileSync(path.join(dir,'README.md'),'# Synthetic fixture\n');
  const checker=path.join(dir,'scripts/cm-check-runtime.sh');fs.writeFileSync(checker,`#!/bin/bash\nprintf 'original checker output\\n'\nprintf 'original stderr\\n' >&2\nexit ${exitCode}\n`,{mode:0o755});
  return {dir,input:{skillDir:path.join(dir,'skills/cm-check'),project}};
}
const assessment=payload=>({sourceDigest:payload.sourceDigest,checks:payload.checklist.map((_,i)=>({id:i+1,status:'passed',evidence:[{path:'skills/cm-check/SKILL.md',line:1}],findings:[]})),
  optional:payload.optionalIds.map(id=>({id,status:'degraded',reason:'Synthetic optional tool unavailable; manual handoff remains possible'}))});
function mechanical(payload){
  const output=spawnSync(payload.invocation.checker,payload.invocation.args,{cwd:payload.invocation.project,encoding:'utf8'});
  return {exitCode:output.status,output:output.stdout+output.stderr,evidence:'Actual isolated fixture terminal execution'};
}
test('actual JSONL CLI runs fixture checker once then eight groups; optional degradation does not fail core',{timeout:5000},async t=>{
  const f=fixture(t),child=spawn(process.execPath,[path.join(f.dir,'scripts/cm-check-host.mjs'),'serve','--skill-dir',f.input.skillDir,'--project',f.input.project],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});t.after(()=>child.kill());
  let sessionId,result,stderr='';const calls=[];const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',bytes=>stderr+=bytes);
  for await(const line of lines){const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'start',operation:'start'});}
    else if(message.type==='host_request'){
      calls.push(message.kind);const result=message.kind==='check_runtime'?mechanical(message.payload):assessment(message.payload);
      send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }else if(message.requestId==='start'){result=message.result;send({type:'host_close',sessionId});}
  }
  assert.equal((await closed)[0],0,stderr);assert.equal(result.result.overall,'PASSED',JSON.stringify(result));
  assert.deepEqual(calls,['check_runtime','check_semantic']);assert.equal(result.result.checks.length,8);
  assert.equal(result.mechanical.output,'original checker output\noriginal stderr\n');assert.equal(result.result.completionAuthorized,false);
  assert.deepEqual(fs.readdirSync(f.input.project),[]);
});
test('mechanical failure stops semantics, repeated start never retries',async t=>{
  const f=fixture(t,7);let calls=0;const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{calls++;assert.equal(kind,'check_runtime');return mechanical(payload);}});
  const value=await host.handle({requestId:'start',operation:'start'});assert.equal(value.result.overall,'FAILED');assert.equal(value.result.semanticChecked,false);
  assert.match(value.mechanical.output,/original stderr/);await assert.rejects(()=>host.handle({requestId:'again',operation:'start'}),/check_already_started/);assert.equal(calls,1);
});
for(const {name,statuses,core,overall} of [
  {name:'all configured',statuses:['configured'],core:'passed',overall:'PASSED'},
  {name:'all degraded',statuses:['degraded'],core:'passed',overall:'PASSED'},
  {name:'all unknown',statuses:['unknown'],core:'passed',overall:'PASSED'},
  {name:'mixed statuses',statuses:['unknown','configured','degraded'],core:'passed',overall:'PASSED'},
  {name:'configured cannot mask a failed check',statuses:['configured'],core:'failed',overall:'FAILED'},
])test(`optional report preserves order and reasons without changing core: ${name}`,async t=>{
  const f=fixture(t);let expectedOptional;
  const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
    if(kind==='check_runtime')return mechanical(payload);
    const value=assessment(payload);
    // Deliberately report a different order and distinct reasons, including surrounding whitespace.
    value.optional.reverse().forEach((row,i)=>{
      row.status=statuses[i%statuses.length];row.reason=`  Synthetic ${row.id}: ${row.status} (${i})  `;
    });
    expectedOptional=structuredClone(value.optional);
    if(core==='failed'){value.checks[1].status='failed';value.checks[1].findings=['Synthetic reproducible broken link'];}
    return value;
  }});
  const report=await host.handle({requestId:'optional',operation:'start'});
  assert.equal(report.result.overall,overall,JSON.stringify(report.result));
  assert.equal(report.result.semanticChecked,true);
  assert.deepEqual(report.result.optional,expectedOptional);
  assert.equal(report.result.checks[1].status,core);
  assert.equal(report.result.findingsCount,core==='failed'?1:0);
});

for(const {name,mutate,reason} of [
  {name:'unknown status enabled',mutate:rows=>{rows[0].status='enabled';},reason:'check_optional_invalid'},
  {name:'uppercase status CONFIGURED',mutate:rows=>{rows[0].status='CONFIGURED';},reason:'check_optional_invalid'},
  {name:'empty reason',mutate:rows=>{rows[0].reason='';},reason:'check_optional_invalid'},
  {name:'whitespace reason',mutate:rows=>{rows[0].reason=' \t\n ';},reason:'check_optional_invalid'},
  {name:'missing id',mutate:rows=>{rows.pop();},reason:'check_optional_incomplete'},
  {name:'duplicate id at unchanged length',mutate:rows=>{rows[1].id=rows[0].id;},reason:'check_optional_incomplete'},
  {name:'extra id',mutate:rows=>{rows.push({id:'unrecognized_tool',status:'configured',reason:'Synthetic extra tool'});},reason:'check_optional_incomplete'},
  {name:'unknown id at unchanged length',mutate:rows=>{rows[0].id='unrecognized_tool';},reason:'check_optional_invalid'},
])test(`invalid optional report blocks with exact reason: ${name}`,async t=>{
  const f=fixture(t);
  const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
    if(kind==='check_runtime')return mechanical(payload);
    const value=assessment(payload);mutate(value.optional);return value;
  }});
  const report=await host.handle({requestId:'optional-invalid',operation:'start'});
  assert.equal(report.result.overall,'BLOCKED',JSON.stringify(report.result));
  assert.equal(report.result.reason,reason);
});

test('coverage, evidence, stale source/config, core findings and cancellation preserve honest verdicts',async t=>{
  for(const mode of ['missing','bad-line','stale','source-drift','config-drift','failed','blocked','cancel']){
    const f=fixture(t);let host;host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
      if(kind==='check_runtime')return mechanical(payload);
      const value=assessment(payload);
      if(mode==='missing')value.checks.pop();
      if(mode==='bad-line')value.checks[0].evidence[0].line=999999;
      if(mode==='stale')value.sourceDigest='wrong';
      if(mode==='source-drift')fs.appendFileSync(path.join(f.dir,'README.md'),'User change');
      if(mode==='config-drift')fs.writeFileSync(path.join(f.input.project,'.cm-workflow.json'),'{}');
      if(mode==='failed'){value.checks[1].status='failed';value.checks[1].findings=['Synthetic reproducible broken link'];}
      if(mode==='blocked'){value.checks[1].status='blocked';value.checks[1].findings=['Evidence unavailable'];}
      if(mode==='cancel')await host.handle({requestId:'cancel',operation:'cancel'});
      return value;
    }});
    const value=await host.handle({requestId:'start',operation:'start'});
    assert.equal(value.result.overall,mode==='failed'?'FAILED':'BLOCKED',mode+JSON.stringify(value));
    if(mode==='cancel')assert.equal(value.stage,'cancelled');
    if(mode==='failed')assert.equal(value.result.findingsCount,1);
  }
});

test('a Claude-compatible installation waives only the Codex-owned halves and still reaches PASSED',{timeout:5000},async t=>{
  const f=fixture(t);
  // A claude-compat installation: no .codex-plugin manifest, the version marker is templates/cm-VERSION.
  fs.mkdirSync(path.join(f.dir,'templates'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'templates/cm-VERSION'),'9.9.9\n');
  let seenMode=null;
  const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
    if(kind==='check_runtime')return mechanical(payload);
    seenMode=payload.installMode;
    const value=assessment(payload);
    for(const id of [1,7]){
      const row=value.checks.find(check=>check.id===id);
      row.status='not_applicable';row.evidence=[];
      row.findings=[`installMode=${payload.installMode}: the Codex-owned artefact is absent by install mode`];
    }
    return value;
  }});
  const report=await host.handle({requestId:'na-1',operation:'start'});
  assert.equal(seenMode,'claude-compat','the assessor must be told the mode, not left to guess');
  assert.equal(report.result.overall,'PASSED',JSON.stringify(report.result));
  assert.equal(report.result.installMode,'claude-compat');
  assert.equal(report.result.version,'9.9.9','claude-compat reports templates/cm-VERSION, not the root VERSION');
  assert.equal(report.result.findingsCount,0);
  assert.deepEqual(report.result.checks.filter(row=>row.status==='not_applicable').map(row=>row.id),[1,7]);
});

test('not_applicable is refused outside the mode-scoped groups and when findings are missing',{timeout:5000},async t=>{
  for(const mutate of [
    value=>{const row=value.checks.find(check=>check.id===3);row.status='not_applicable';row.evidence=[];row.findings=['not a mode-scoped group'];},
    value=>{const row=value.checks.find(check=>check.id===1);row.status='not_applicable';row.evidence=[];row.findings=[];},
  ]){
    const f=fixture(t);
    const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
      if(kind==='check_runtime')return mechanical(payload);
      const value=assessment(payload);mutate(value);return value;
    }});
    const report=await host.handle({requestId:'na-2',operation:'start'});
    assert.equal(report.result.overall,'BLOCKED',JSON.stringify(report.result));
    assert.equal(report.result.reason,'check_result_invalid');
  }
});

test('a plugin installation keeps reporting the root VERSION', {timeout:5000}, async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.dir,'.codex-plugin'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'.codex-plugin/plugin.json'),JSON.stringify({name:'cm-workflow',version:'0.0.0'}));
  let seenMode=null;
  const host=createCmCheckHost(f.input,{call:async(kind,payload)=>{
    if(kind==='check_runtime')return mechanical(payload);
    seenMode=payload.installMode;return assessment(payload);
  }});
  const report=await host.handle({requestId:'na-3',operation:'start'});
  assert.equal(seenMode,'plugin');
  assert.equal(report.result.installMode,'plugin');
  assert.equal(report.result.version,'0.0.0');
  assert.equal(report.result.overall,'PASSED');
});

test('quick mode stops after the mechanical checker and never claims PASSED',{timeout:5000},async t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.dir,'templates'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'templates/cm-VERSION'),'7.7.7\n');
  const kinds=[];
  const host=createCmCheckHost({...f.input,quick:true},{call:async(kind,payload)=>{
    kinds.push(kind);
    if(kind==='check_runtime')return mechanical(payload);
    throw Error('quick mode must not request the semantic groups');
  }});
  const report=await host.handle({requestId:'q-1',operation:'start'});
  assert.deepEqual(kinds,['check_runtime'],'the eight groups must never be requested');
  assert.equal(report.result.overall,'MECHANICAL_ONLY');
  assert.notEqual(report.result.overall,'PASSED','a quick run must not be quotable as a full pass');
  assert.equal(report.result.semanticChecked,false);
  assert.equal(report.result.reason,'quick_mode_semantic_not_run');
  assert.equal(report.result.version,'7.7.7');
  assert.deepEqual(report.result.checks,[]);
  assert.equal(report.result.completionAuthorized,false);
});

test('quick mode still reports an actual mechanical failure',{timeout:5000},async t=>{
  const f=fixture(t,3);
  const host=createCmCheckHost({...f.input,quick:true},{call:async(kind,payload)=>{
    assert.equal(kind,'check_runtime');return mechanical(payload);
  }});
  const report=await host.handle({requestId:'q-2',operation:'start'});
  assert.equal(report.result.overall,'FAILED','quick mode must not swallow a failing checker');
  assert.equal(report.result.semanticChecked,false);
});
