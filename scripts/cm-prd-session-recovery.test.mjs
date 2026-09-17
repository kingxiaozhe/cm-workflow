import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sessionId='prd-recovery-fixture';
async function fixture(t,{ready=false,change=false}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-recovery-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['docs','mirror','1.guide'])fs.mkdirSync(path.join(dir,name));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic request');
  for(const [file,content] of Object.entries({'requirements.md':'- [ ] [AC-001] Guide',
    'design.md':'# Guide','tasks.md':'- [ ] T-001: Guide'}))fs.writeFileSync(path.join(dir,'1.guide',file),content,{mode:0o600});
  const entry={skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir,...(change?{change:'1.guide'}:{})};
  const identity={entry,runtime:'codex'},open=()=>openPrdSession({specs:dir,sessionId,identity});
  if(!change){
    const analysis=createCmPrdAnalysis({input:entry,runtime:'codex',record:()=>{},analyze:async()=>({
      status:'analyzed',summary:'Synthetic request',sourcePaths:['docs/input.md'],openQuestions:[]})});
    if(!ready)await analysis.advance('Analyze');
    const session=open();session.checkpoint({analysis:analysis.checkpoint(),change:null,started:!ready,
      routeTurn:0,reviewState:null,summaryState:ready?null:{currentFeatures:['1.guide']},publishedSummary:false});session.close();
  }
  const stateFile=path.join(dir,'.reviews/prd-sessions',sessionId,'state.json');
  return {dir,entry,open,state:()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))};
}
async function client(t,f){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',f.entry.skillDir,
    '--project',f.dir,'--specs',f.dir,'--runtime','codex','--allow-log-write','--session',sessionId,
    ...(f.entry.change?['--change',f.entry.change]:[])],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.dir,'mirror')},stdio:['pipe','pipe','pipe']});
  let stderr='',seq=0;child.stderr.on('data',chunk=>stderr+=chunk);
  const closed=once(child,'close'),lines=createInterface({input:child.stdout}),queue=[],waiters=[];
  lines.on('line',line=>{const value=JSON.parse(line),index=waiters.findIndex(w=>w.match(value));
    if(index===-1)queue.push(value);else waiters.splice(index,1)[0].resolve(value);});
  const wait=match=>{const index=queue.findIndex(match);return index===-1?
    new Promise(resolve=>waiters.push({match,resolve})):Promise.resolve(queue.splice(index,1)[0]);};
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;lines.close();});
  const ready=await wait(m=>m.type==='host_ready');
  return {wait,send,request:(operation,fields={})=>{const requestId=`request-${++seq}`;
    const reply=wait(m=>m.requestId===requestId);send({requestId,operation,...fields});return reply;},
  close:async()=>{send({type:'host_close',sessionId:ready.sessionId});assert.equal((await closed)[0],0,stderr);},
  result:(call,result)=>send({type:'host_result',sessionId:ready.sessionId,callId:call.callId,requestDigest:call.requestDigest,result})};
}
function blocked(reply,reason){
  assert.equal(reply.error,undefined);assert.equal(reply.result.status,'blocked');assert.equal(reply.result.reason,reason);
  assert.equal(reply.result.completionAuthorized,false);assert.ok(Object.hasOwn(reply.result,'recovery'));return reply.result;
}
async function unknownSummary(t,f){
  const c=await client(t,f),pending=c.request('prepare_summary');
  const call=await c.wait(m=>m.type==='host_request');assert.equal(call.kind,'prd_summary');
  await c.close();assert.equal((await pending).error.code,'host_request_failed');return call;
}
const abandon=call=>({callId:call.payload.recovery.callId,requestDigest:call.payload.recovery.requestDigest,
  abandon:true,evidence:'Synthetic original call unavailable; explicit discard reference'});

test('unknown summary exposes session reasons, abandon restores before and permits fresh host request', {timeout:20000},async t=>{
  const f=await fixture(t),original=await unknownSummary(t,f),before=f.state().active.before;
  let c=await client(t,f);
  const recovery=blocked(await c.request('prepare_summary'),'prd_operation_recovery_required').recovery;
  assert.equal(recovery.calls[0].callId,original.payload.recovery.callId);assert.equal(recovery.calls[0].status,'unknown');
  blocked(await c.request('resume',{resolution:null}),'prd_host_result_unknown');
  const initial=f.state(),resolution=abandon(original);
  for(const bad of [{...resolution,result:{}},{...resolution,requestDigest:'wrong'},
    {...resolution,callId:'wrong'},{...resolution,abandon:false},{...resolution,unexpected:true}]){
    blocked(await c.request('resume',{resolution:bad}),'prd_recovery_binding');assert.deepEqual(f.state(),initial);
  }
  for(const bad of [{...resolution,evidence:'  '},{callId:resolution.callId,requestDigest:resolution.requestDigest,abandon:true},
    {callId:resolution.callId,requestDigest:resolution.requestDigest,result:{},evidence:''}]){
    blocked(await c.request('resume',{resolution:bad}),'prd_recovery_evidence_required');assert.deepEqual(f.state(),initial);
  }
  const result=(await c.request('resume',{resolution})).result;
  assert.equal(result.stage,before.analysis.stage);assert.equal(result.recovery,null);
  assert.equal(f.state().active,null);assert.deepEqual(f.state().checkpoint,before);
  assert.equal(JSON.stringify(f.state()).includes(resolution.evidence),false);
  const rows=fs.readFileSync(path.join(f.dir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const decisions=rows.filter(row=>row.event==='decision'&&row.phase==='recovery');assert.equal(decisions.length,1);
  const decision=decisions[0];assert.equal(decision.operation,'prepare_summary');assert.equal(decision.kind,'prd_summary');
  assert.equal(decision.callId,resolution.callId);assert.match(decision.evidence.sha256,/^[a-f0-9]{64}$/);
  assert.equal(decision.evidence.length,resolution.evidence.length);assert.equal(Object.hasOwn(decision,'payload'),false);
  for(const row of decisions)assert.equal(JSON.stringify(row).includes(resolution.evidence),false);
  await c.close();c=await client(t,f);
  blocked(await c.request('resume',{resolution:null}),'prd_nothing_to_resume');
  const retry=c.request('prepare_summary'),fresh=await c.wait(m=>m.type==='host_request');
  assert.equal(fresh.kind,'prd_summary');assert.notEqual(fresh.payload.recovery.callId,resolution.callId);
  assert.deepEqual(fresh.payload.evidence.currentFeatures,['1.guide']);
  await c.close();await retry;
});

for(const mode of ['summary','analysis','change'])test(`cancel clears pending ${mode} and stays terminal across restart`,{timeout:15000},async t=>{
  const f=await fixture(t,{ready:mode==='analysis',change:mode==='change'});let c=await client(t,f);
  const pending=c.request(mode==='summary'?'prepare_summary':'start',mode==='summary'?{}:{text:'Analyze'});
  const call=await c.wait(m=>m.type==='host_request');
  const cancelled=(await c.request('cancel')).result;assert.equal(cancelled.stage,'cancelled');assert.equal(cancelled.recovery,null);
  assert.equal((await pending).result.stage,'cancelled');
  const key=mode==='change'?'change':'analysis';assert.equal(f.state().checkpoint[key].stage,'cancelled');assert.equal(f.state().active,null);
  c.result(call,{});assert.equal((await c.wait(m=>m.type==='host_response')).accepted,false);
  for(const resolution of [null,abandon(call),{...abandon(call),result:{}}])blocked(await c.request('resume',{resolution}),'cancelled');
  blocked(await c.request('prepare_summary'),'cancelled');await c.close();
  c=await client(t,f);assert.equal((await c.request('status')).result.stage,'cancelled');
  blocked(await c.request('resume',{resolution:null}),'cancelled');blocked(await c.request('start',{text:'Retry'}),'cancelled');
  assert.equal(f.state().active,null);await c.close();
});

test('old cancelled checkpoint with active is normalized without replay', {timeout:15000},async t=>{
  const f=await fixture(t);await unknownSummary(t,f);
  const session=f.open(),checkpoint=session.state.checkpoint;
  session.checkpoint({...checkpoint,analysis:{...checkpoint.analysis,stage:'cancelled'}});session.close();
  assert.ok(f.state().active);const c=await client(t,f);
  assert.equal(f.state().active,null);assert.equal((await c.request('status')).result.stage,'cancelled');
  blocked(await c.request('resume',{resolution:null}),'cancelled');await c.close();
});

async function seedCalls(f,calls,request={requestId:'original',operation:'prepare_summary'}){
  const session=f.open();try{
    session.begin(request,session.state.checkpoint);
    for(const {kind,result} of calls){
      try{await session.call(kind,{synthetic:'private-payload'},new AbortController().signal,async()=>{
        if(result===undefined)throw Error('synthetic disconnect');return result;});}catch(e){assert.equal(e.message,'synthetic disconnect');}
    }
  }finally{session.close();}
}
for(const mixed of [false,true])test(`abandon rejects any prd_review call in operation: mixed=${mixed}`,{timeout:15000},async t=>{
  const f=await fixture(t);await seedCalls(f,mixed?[{kind:'prd_review',result:{}},{kind:'prd_self_check'}]:[{kind:'prd_review'}]);
  const before=f.state(),target=before.active.calls.at(-1),c=await client(t,f);
  const resolution={callId:target.callId,requestDigest:target.requestDigest,abandon:true,evidence:'Synthetic discard request'};
  const result=blocked(await c.request('resume',{resolution}),'prd_review_recovery_required');
  assert.equal(result.recovery.calls.length,before.active.calls.length);assert.deepEqual(f.state(),before);await c.close();
});

test('turn and replay errors are visible while unrelated errors remain redacted', {timeout:15000},async t=>{
  const f=await fixture(t,{ready:true});let c=await client(t,f);
  assert.equal(blocked(await c.request('advance',{text:'Too early'}),'prd_turn_not_ready').recovery,null);
  assert.equal((await c.request('save_draft')).error.code,'host_request_failed');await c.close();
  await seedCalls(f,[{kind:'prd_analyze',result:{status:'question',question:'Original'}}],{requestId:'original',operation:'start',text:'Analyze'});
  c=await client(t,f);const result=blocked(await c.request('resume',{resolution:null}),'prd_replay_inputs_changed');
  assert.equal(result.recovery.calls[0].status,'recorded');await c.close();
});

test('session rejects abandoning recorded results and late replies cannot resurrect cancelled active',async t=>{
  const f=await fixture(t),session=f.open();try{
  session.begin({requestId:'original',operation:'prepare_summary'},session.state.checkpoint);
  await session.call('prd_summary',{},new AbortController().signal,async()=>({original:true}));
  const before=session.state,target=before.active.calls[0];
  assert.throws(()=>session.abandon({callId:target.callId,requestDigest:target.requestDigest,abandon:true,evidence:'Reference'}),{code:'prd_recovery_binding'});
  assert.deepEqual(session.state,before);
  session.commit(before.checkpoint);session.begin({requestId:'late',operation:'prepare_summary'},before.checkpoint);
  let finish;const controller=new AbortController();
  const pending=session.call('prd_summary',{},controller.signal,()=>new Promise(resolve=>{finish=resolve;}));
  const terminal={...before.checkpoint,analysis:{...before.checkpoint.analysis,stage:'cancelled'}};
  controller.abort();session.commit(terminal);finish({late:true});
  await assert.rejects(pending,{code:'cancelled'});assert.equal(session.state.active,null);assert.deepEqual(f.state().checkpoint,terminal);
  }finally{session.close();}
});

test('help documents abandon shape and terminal cancellation',()=>{
  const result=spawnSync(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'--help'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/abandon:true/);assert.match(result.stdout,/result absent/);
  assert.match(result.stdout,/cancel is terminal/);assert.match(result.stdout,/prd_review/);
});
