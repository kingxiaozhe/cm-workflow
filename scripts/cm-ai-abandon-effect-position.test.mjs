import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerPayloadV3} from '../runtime/js/cm-ai/durable-runner-state.mjs';

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-abandon-position-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,reviewsDir:path.join(specsDir,'.reviews'),
    tasksPath:path.join(specsDir,feature,'tasks.md')};
}
const identity=runId=>({repositoryId:'abandon-position',runId,taskId:'T-002',attempt:1});
const definition=(f,runId)=>({version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
  identity:identity(runId),scope:['a.mjs'],requirements:['requirements.md']});
const request=runId=>({version:1,operation:'abandon_effect',requestId:'abandon',identity:identity(runId),reason:'Old host and children exited'});
function execution(f,verdict='blocked'){
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(value,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:'review-thread'});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict,packageDigest:value.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(value.payload.reviewPackage),findings:[],summary:'Fixture review'}};
    }};
  return {configuration:{kind:'abandon-position-v1'},timeoutMs:2000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({
      requestedModel:'fixture',worker:async()=>{fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'written\n');
        return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
          retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[reviewer],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],
      authorize:(value,{authorizationAt})=>{const body={version:1,kind:'cm-review-dispatch-grant',
        grantId:'grant',adapterId:'codex-review-adapter',invocationId:value.invocationId,
        requestDigest:value.requestDigest,identity:value.identity,reviewerId:'reviewer',
        logicalContextId:value.contextId,packageDigest:value.payload.reviewPackage.packageDigest,
        hostContextId:'control',decisionId:'approved',decision:'approved',issuedAt:authorizationAt,
        expiresAt:authorizationAt+60000};return {...body,grantDigest:digest(body)};}},
    hostDecision:{status:'approved'},check:createHostCheck({cwd:f.codeProject,
      commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})};
}
async function start(f,runId,verdict='blocked',options={}){
  const run=await openControlRun(definition(f,runId),'create',execution(f,verdict),options);
  try{return await run.host.handle({version:1,operation:'advance',requestId:'advance',identity:identity(runId)});}
  finally{run.close();}
}
function statePath(f,runId){return path.join(f.reviewsDir,'.execution',runId,'state.json');}
function savePrefix(f,runId,type,kind){
  const file=statePath(f,runId),state=JSON.parse(fs.readFileSync(file,'utf8'));
  const index=state.records.findIndex(row=>row.payload.type===type
    &&(kind===null||row.payload.effect?.kind===kind));
  assert(index>=0,`missing ${type} ${kind}`);
  const {revision,...body}=state;body.records=state.records.slice(0,index+1);
  fs.writeFileSync(file,JSON.stringify({...body,revision:digest(body)})+'\n');
  return body.records;
}
function append(f,runId,type,fields,kind=type==='control'?'cancel':'result'){
  const file=statePath(f,runId),state=JSON.parse(fs.readFileSync(file,'utf8'));
  const {revision,...body}=state,seq=body.records.length+1;
  const record={version:1,seq,id:`runner.${String(seq).padStart(6,'0')}`,kind,
    payload:runnerPayloadV3(type,fields),previousDigest:body.records.at(-1).digest};
  body.records.push({...record,digest:digest(record)});
  fs.writeFileSync(file,JSON.stringify({...body,revision:digest(body)})+'\n');
  return body.records;
}
async function resume(f,runId,verdict='blocked'){
  return openControlRun(definition(f,runId),'resume',execution(f,verdict),{allowAbandonEffect:true});
}
function mutated(records,index,change){
  const result=structuredClone(records);change(result[index].payload);
  for(let at=index;at<result.length;at++){
    const {digest:discard,...body}=result[at];body.previousDigest=at?result[at-1].digest:null;
    result[at]={...body,digest:digest(body)};
  }
  return result;
}

for(const [kind,event] of [['develop','cancel'],['complete','late-cancel']])
test(`${kind} intent plus ${event} control replays and abandons at the bound position`,async()=>{
  const f=fixture(),runId=`control-${kind}`;
  try{
    await start(f,runId,kind==='complete'?'approved':'blocked');
    const intentRecords=savePrefix(f,runId,'effect-intent',kind);
    const intent=intentRecords.at(-1);
    const first=append(f,runId,'control',{event});
    assert.equal(readRunnerHistory(first,first[0].payload.config,3).state.code,'reconciliation_required');
    const prefix=append(f,runId,'control',{event:'workflow-error'});
    const projected=readRunnerHistory(prefix,prefix[0].payload.config,3);
    assert.equal(projected.state.state,'unknown');assert.equal(projected.state.code,'reconciliation_required');
    assert.equal(projected.pendingAbandonable,true);
    if(kind==='complete')fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    await assert.rejects(start(f,`${runId}-next`,'blocked',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true}),
    error=>error.code==='supersede_unavailable'&&/abandon_effect/.test(error.reason));
    const run=await resume(f,runId,kind==='complete'?'approved':'blocked');
    try{
      const status=await run.host.handle({version:1,operation:'status',requestId:'status',identity:identity(runId)});
      assert.equal(status.pendingAction,'abandon_effect');
      const result=await run.host.handle(request(runId));
      assert.equal(result.outcome,'abandoned');assert.equal(result.state,'cancelled');
    }finally{run.close();}
    const records=JSON.parse(fs.readFileSync(statePath(f,runId),'utf8')).records;
    const abandoned=records.at(-1);
    assert.equal(abandoned.payload.intentDigest,intent.digest);
    assert.equal(abandoned.payload.lastRecordDigest,records.at(-2).digest);
    assert.equal(readRunnerHistory(records,records[0].payload.config,3).state.code,'effect_abandoned');
    for(const key of ['intentDigest','lastRecordDigest']){
      const wrong=mutated(records,records.length-1,p=>{p[key]='0'.repeat(64);});
      assert.throws(()=>readRunnerHistory(wrong,wrong[0].payload.config,3),{code:'runner_abandon'});
    }
    const oldShape=mutated(records,records.length-1,p=>{delete p.lastRecordDigest;});
    assert.throws(()=>readRunnerHistory(oldShape,oldShape[0].payload.config,3),{code:'runner_abandon'});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('review intent before any join or registration uses abandon_effect; registration keeps abandon_review',async()=>{
  const f=fixture(),runId='review-before-dispatch';
  try{
    await start(f,runId);
    const prefix=savePrefix(f,runId,'effect-intent','review');
    const config=prefix[0].payload.config;
    const controlled=append(f,runId,'control',{event:'cancel'});
    assert.equal(readRunnerHistory(controlled,config,3).pendingAbandonable,true);
    await assert.rejects(start(f,'review-next','blocked',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true}),
    error=>error.code==='supersede_unavailable'&&/abandon_effect/.test(error.reason));
    const run=await resume(f,runId);
    try{
      const status=await run.host.handle({version:1,operation:'status',requestId:'status',identity:identity(runId)});
      assert.equal(status.pendingAction,'abandon_effect');
      assert.equal((await run.host.handle(request(runId))).code,'effect_abandoned');
    }finally{run.close();}
    const records=JSON.parse(fs.readFileSync(statePath(f,runId),'utf8')).records;
    assert.equal(readRunnerHistory(records,config,3).state.state,'cancelled');
    const events=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.findLast(row=>row.event==='effect_abandoned')?.node,'N4');
    savePrefix(f,runId,'effect-intent','review');
    append(f,runId,'host-joined',{hostContextId:'fresh-host'},'result');
    const joined=JSON.parse(fs.readFileSync(statePath(f,runId),'utf8')).records;
    assert.equal(readRunnerHistory(joined,config,3).pendingAbandonable,false);
    const forged=append(f,runId,'effect-abandoned',{effectId:prefix.at(-1).payload.effect.id,
      effectKind:'review',intentDigest:prefix.at(-1).digest,lastRecordDigest:joined.at(-1).digest,
      reason:'old host exited',at:new Date().toISOString()},'result');
    assert.throws(()=>readRunnerHistory(forged,config,3),{code:'runner_abandon'});
    savePrefix(f,runId,'host-joined',null);
    const joinedRun=await resume(f,runId);
    try{assert.equal((await joinedRun.host.handle(request(runId))).code,'effect_abandon_review_pending');}
    finally{joinedRun.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('legacy direct effect-abandoned record replays without the last-record field',async()=>{
  const f=fixture(),runId='legacy-direct';
  try{
    await start(f,runId);
    const records=savePrefix(f,runId,'effect-intent','develop');
    const intent=records.at(-1);
    const old=append(f,runId,'effect-abandoned',{effectId:intent.payload.effect.id,
      effectKind:'develop',intentDigest:intent.digest,reason:'old host exited',
      at:new Date().toISOString()},'result');
    assert.equal(readRunnerHistory(old,old[0].payload.config,3).state.code,'effect_abandoned');
    const extra=mutated(old,old.length-1,p=>{p.intentDigest='0'.repeat(64);});
    assert.throws(()=>readRunnerHistory(extra,extra[0].payload.config,3),{code:'runner_abandon'});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('registered review stays on abandon_review and cannot replay effect-abandoned',async()=>{
  const f=fixture(),runId='review-registered';
  try{
    await start(f,runId);
    const records=savePrefix(f,runId,'review-invocation-registered',null);
    const config=records[0].payload.config,intent=records.findLast(row=>row.payload.type==='effect-intent');
    const projected=readRunnerHistory(records,config,3);
    assert.equal(projected.pendingAbandonable,false);
    await assert.rejects(start(f,'registered-next','blocked',
      {supersedeReason:'restart',acceptSupersededCodeDrift:true}),
    error=>error.code==='supersede_unavailable'&&/abandon_review/.test(error.reason));
    const run=await resume(f,runId);
    try{
      const status=await run.host.handle({version:1,operation:'status',requestId:'status',identity:identity(runId)});
      assert.equal(status.pendingAction,'abandon_review');
      assert.equal((await run.host.handle(request(runId))).code,'effect_abandon_review_pending');
    }finally{run.close();}
    const forged=append(f,runId,'effect-abandoned',{effectId:intent.payload.effect.id,
      effectKind:'review',intentDigest:intent.digest,lastRecordDigest:records.at(-1).digest,
      reason:'old host exited',at:new Date().toISOString()},'result');
    assert.throws(()=>readRunnerHistory(forged,config,3),{code:'runner_abandon'});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
