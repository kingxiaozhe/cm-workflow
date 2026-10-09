// V2 + R3 (P1-2): a current-session develop whose answer never arrived (timed
// out after writing, disconnected) cannot be redispatched until the operator
// confirms the session stopped (develop_redo + reason, journaled). The redo
// keeps the edits on disk; the package is built against the task baseline and
// reviewed, so nothing written during the lost answer skips review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {gapFixture,gapExecution,gapSession,records,added} from './cm-ai-answer-gap-fixture.mjs';

const hangAfterWrite={write:'half written\n',response:new Promise(()=>{})};

test('develop_answer_missing: a develop that timed out after writing waits for develop_redo, then redoes the round',async t=>{
  const f=gapFixture(t,'redo');
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:[hangAfterWrite]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','develop_answer_missing','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/代码根已变化/);assert.equal(stuck.guidance.recoveryOperation,'develop_redo');
  const before=records(f);
  // The journal is what older runtimes wrote: unknown/call_timeout.
  assert.deepEqual([before.at(-1).payload.checkpoint.state,before.at(-1).payload.checkpoint.code],['unknown','call_timeout']);
  // advance alone never redispatches; develop_redo needs its launch flag.
  const [advanced,refused]=await gapSession(f,'resume',gapExecution(f),[['advance',1],['develop_redo',1,{reason:'会话已停止'}]]);
  // advance reports the block without even trying a develop effect.
  assert.deepEqual([advanced.outcome,advanced.code,advanced.pendingAction],['reported','develop_answer_missing','develop_redo'],JSON.stringify(advanced));
  assert.equal(records(f).length,before.length);
  assert.deepEqual([refused.outcome,refused.code],['rejected','develop_redo_authorization_required']);
  // Confirmed: develop-answer-redo, then advance redoes the round with a new effect id.
  const [confirmed,status]=await gapSession(f,'resume',gapExecution(f),
    [['develop_redo',1,{reason:'会话已停止修改代码'}],['status',1]],{allowDevelopRedo:true});
  assert.equal(confirmed.outcome,'recorded',JSON.stringify(confirmed));
  assert.deepEqual([status.state,status.code,status.pendingAction],['blocked','develop_answer_missing','resume']);
  assert.equal(f.calls.developer,1);
  const redo=records(f).at(-1).payload;
  assert.deepEqual([redo.type,redo.cause,redo.reason],['develop-answer-redo','call_timeout','会话已停止修改代码']);
  const middle=records(f);
  const [delivered]=await gapSession(f,'resume',gapExecution(f,{developer:['final\n'],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,2);
  assert.deepEqual(added(f,middle).slice(0,2),['intent:develop-1-retry-1','effect-checkpoint']);
  assert.ok(added(f,middle).includes('intent:review-1'),JSON.stringify(delivered));
  const checkpoint=records(f)[middle.length+1].payload.checkpoint;
  assert.equal(checkpoint.state,'awaiting_review');
  // Reviewed against the task baseline, not re-captured after the lost answer.
  assert.equal(Buffer.from(checkpoint.reviewPackage.changes.find(c=>c.path==='a.mjs').before.contentBase64,'base64').toString(),'old\n');
  const history=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.equal(history.answerGaps.developRedo,1);
  assert.deepEqual(records(f).slice(0,before.length),before,'journal is append-only');
});

test('develop_answer_missing: a disconnected develop (unknown/unknown) takes the same confirmed redo; the cap is two per run',async t=>{
  const f=gapFixture(t,'disconnect');
  const disconnect=write=>({write,throw:'host_disconnected'});
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:[disconnect('one\n')]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','develop_answer_missing','develop_redo'],JSON.stringify(stuck));
  assert.deepEqual([records(f).at(-1).payload.checkpoint.state,records(f).at(-1).payload.checkpoint.code],['unknown','unknown']);
  for(const [index,write] of ['two\n','three\n'].entries()){
    const [ok]=await gapSession(f,'resume',gapExecution(f,{developer:[disconnect(write)]}),
      [['develop_redo',1,{reason:`确认第 ${index+1} 次`}],['advance',1]],{allowDevelopRedo:true});
    assert.equal(ok.outcome,'recorded');
  }
  // Two redos used: the third stuck develop has no redo exit left.
  const [last]=await gapSession(f,'resume',gapExecution(f),[['status',1],['develop_redo',1,{reason:'第三次'}]],{allowDevelopRedo:true});
  assert.deepEqual([last.state,last.code,last.pendingAction],['unknown','unknown','reconcile'],JSON.stringify(last));
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'three\n');
  assert.deepEqual(records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id),
    ['develop-1','develop-1-retry-1','develop-1-retry-2']);
});

test('develop_answer_missing: a bare failed answer (blocked/failed without a result) also needs develop_redo; the driver checks the plan',async t=>{
  const f=gapFixture(t,'bare');
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:[{write:'tried\n',response:{status:'failed',code:'session_error'}}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','develop_answer_missing','develop_redo'],JSON.stringify(stuck));
  assert.match(stuck.reason,/只回了 failed/);
  const {developRedoPlanError}=await import('./cm-ai-drive.mjs');
  assert.equal(developRedoPlanError('develop_redo',{mode:'resume',reason:'已停'},['--allow-develop-redo']),null);
  assert.match(developRedoPlanError('develop_redo',{mode:'resume',reason:'已停'},[]),/--allow-develop-redo/);
  assert.match(developRedoPlanError('develop_redo',{mode:'create',reason:'已停'},['--allow-develop-redo']),/resume/);
});

test('develop_redo passes the shared JSONL transport (serveCmAiHost) and is journaled',async t=>{
  const {PassThrough}=await import('node:stream');
  const {serveCmAiHost}=await import('../runtime/js/cm-ai/host-session.mjs');
  const {openControlRun}=await import('./cm-ai-run.mjs');
  const {definition,identity}=await import('./cm-ai-answer-gap-fixture.mjs');
  const f=gapFixture(t,'transport');
  await gapSession(f,'create',gapExecution(f,{developer:[{write:'one\n',throw:'host_disconnected'}]}),[['advance',1]]);
  const run=await openControlRun(definition(f),'resume',gapExecution(f),{allowDevelopRedo:true});
  const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();let text='';
  output.on('data',chunk=>{text+=chunk;});
  try{
    const served=serveCmAiHost({host:run.host,input,output,errorOutput:errors});
    input.write(JSON.stringify({version:1,operation:'develop_redo',requestId:'redo-1',identity:identity(1),reason:'会话已停止修改代码'})+'\n');
    input.end();await served;
  }finally{run.close();}
  const rows=text.trim().split('\n').map(line=>JSON.parse(line));
  const reply=rows.find(row=>row.requestId==='redo-1');
  assert.ok(reply&&!reply.error,text);
  assert.deepEqual([reply.result.outcome,reply.result.code,reply.result.pendingAction],['recorded','develop_answer_missing','resume']);
  assert.equal(records(f).at(-1).payload.type,'develop-answer-redo');
});
