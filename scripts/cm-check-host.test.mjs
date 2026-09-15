import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmCheckHost} from '../runtime/js/cm-check/host.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t,exitCode=0){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-check-host-'))),project=path.join(dir,'project');fs.mkdirSync(project);
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const file of ['scripts/cm-check-entry.mjs','scripts/cm-check-host.mjs','runtime/js/cm-check/host.mjs',
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
