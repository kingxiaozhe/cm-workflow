// External answer gaps, batch 3 (O18/O19): a refused or lost text-only answer is
// discarded by an append-only journal row and asked again; commands and writes
// never are. Main paths drive the real cm-refactor-host.mjs over JSONL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {openRefactorRecords,effectDigest} from '../runtime/js/cm-refactor/records.mjs';
import {refactorDiscardable} from '../runtime/js/cm-refactor/workflow.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {fixture,response,original,replacement} from './fixtures/cm-refactor.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const journalFile=project=>path.join(project,'docs/refactors/extract/execution.jsonl');
const rows=project=>fs.readFileSync(journalFile(project),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));

// One real host process: sends each operation after the previous reply.
async function serve(t,config,temp,respond,operations){
  const configPath=path.join(temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-refactor-host.mjs'),'serve','--config',configPath],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});let sessionId,stderr='',index=0;const results=[],asked=[];
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',chunk=>{stderr+=chunk;});
  const next=()=>{if(index<operations.length){const op=operations[index++];send({requestId:`r${index}`,...(typeof op==='function'?op(results):op)});}
    else send({type:'host_close',sessionId});};
  for await(const line of lines){const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;next();}
    else if(message.type==='host_request'){asked.push(message);const result=await respond(message,child);
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});}
    else if(message.requestId){results.push(message.result??message.error);next();}
  }
  const [code]=await closed;return {code,results,asked,stderr};
}

test('real host O18: a refused analysis replays the same refusal until it is discarded, then the run continues',{timeout:60000},async t=>{
  const {config,temp,project}=fixture(t);let bad=1;
  const respond=message=>message.kind==='refactor_analyze'&&bad-->0?{decision:'proceed'}:response(message.kind,message.payload);
  let run=await serve(t,config,temp,respond,[{operation:'start'},{operation:'resume'}]);
  assert.equal(run.code,0,run.stderr);
  for(const result of run.results){assert.equal(result.stage,'blocked');assert.equal(result.reason,'refactor_analysis_invalid');}
  const blocked=run.results[1];assert.equal(blocked.recovery.lastAnswer.kind,'refactor_analyze');assert.match(blocked.guidance.nextStep,/discard/);
  assert.equal(run.asked.length,1);
  const {key,requestDigest}=blocked.recovery.lastAnswer;
  run=await serve(t,config,temp,respond,[{operation:'resume',discard:{key,requestDigest:'0'.repeat(64),evidence:'wrong binding'}},
    {operation:'resume',discard:{key,requestDigest,evidence:'analysis reply had no reason or metric'}}]);
  assert.equal(run.code,0,run.stderr);assert.equal(run.results[0].reason,'refactor_discard_binding');
  assert.equal(run.results[1].stage,'awaiting_finish',JSON.stringify(run.results[1]));
  assert.equal(run.asked.filter(item=>item.kind==='refactor_analyze').length,1);
  const discard=rows(project).filter(row=>row.type==='discard');
  assert.equal(discard.length,1);assert.equal(discard[0].reason,'answer_rejected');assert.equal(discard[0].kind,'refactor_analyze');
  assert.equal(JSON.stringify(discard).includes('analysis reply had no reason'),false);
  assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),replacement);
});

test('real host O19: an apply answer nobody can recover is discarded as answer_missing; the proposal is asked again',{timeout:60000},async t=>{
  const {config,temp,project}=fixture(t);
  let run=await serve(t,config,temp,(message,child)=>{
    if(message.kind==='refactor_apply'){setImmediate(()=>child.kill('SIGKILL'));return undefined;}
    return response(message.kind,message.payload);},[{operation:'start'}]);
  assert.notEqual(run.code,0);assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
  run=await serve(t,config,temp,message=>{
    if(message.kind==='refactor_recover')return {decision:'unknown',evidence:'the original session is gone'};
    return response(message.kind,message.payload);},[{operation:'resume'}]);
  const blocked=run.results[0];assert.equal(blocked.reason,'refactor_unknown_effect');
  const unknown=blocked.recovery.unknown[0];assert.equal(unknown.callKind,'refactor_apply');assert.match(blocked.guidance.nextStep,/discard/);
  run=await serve(t,config,temp,message=>response(message.kind,message.payload),
    [{operation:'resume',discard:{key:unknown.key,requestDigest:unknown.requestDigest,evidence:'session lost the proposal'}}]);
  assert.equal(run.results[0].stage,'awaiting_finish',JSON.stringify(run.results[0]));
  assert.deepEqual(run.asked.map(item=>item.kind),['refactor_apply','refactor_review']);
  assert.equal(rows(project).find(row=>row.type==='discard').reason,'answer_missing');
});

test('commands with unknown results are never discardable; guidance asks for the original receipt',{timeout:60000},async t=>{
  const {config,project}=fixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload)});
  assert.equal((await host.handle({operation:'start'})).stage,'awaiting_finish');
  const lines=fs.readFileSync(journalFile(project),'utf8').trimEnd().split('\n'),index=lines.findIndex(line=>JSON.parse(line).type==='intent'&&JSON.parse(line).kind==='command');
  // Crash prefix at the first judge command: no source write had happened yet.
  fs.writeFileSync(journalFile(project),lines.slice(0,index+1).join('\n')+'\n');fs.writeFileSync(path.join(project,'input.mjs'),original);
  const reopened=createCmRefactorHost(config,{call:async kind=>{assert.equal(kind,'refactor_recover');return {decision:'unknown',evidence:'not known'};}});
  const blocked=await reopened.handle({operation:'resume'});
  assert.equal(blocked.reason,'refactor_unknown_effect');assert.match(blocked.guidance.nextStep,/cleanupConfirmed/);
  const command=blocked.recovery.unknown[0];assert.equal(command.kind,'command');
  const refused=await reopened.handle({operation:'resume',discard:{key:command.key,requestDigest:command.requestDigest,evidence:'try'}});
  assert.equal(refused.reason,'refactor_discard_binding');assert.equal(rows(project).some(row=>row.type==='discard'),false);
});

// Forged rows keep a valid hash chain; replay must still refuse them.
function appendRow(project,body){
  const list=rows(project),row={...body,previous:list.at(-1).hash};
  fs.appendFileSync(journalFile(project),JSON.stringify({...row,hash:digest(row)})+'\n');
}
test('replay refuses forged, duplicated and over-limit discard rows; an old journal replays unchanged',{timeout:60000},async t=>{
  const {config,project}=fixture(t);let bad=1;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>kind==='refactor_analyze'&&bad-->0?{decision:'proceed'}:response(kind,payload)});
  const blocked=await host.handle({operation:'start'});const last=blocked.recovery.lastAnswer;
  const base=fs.readFileSync(journalFile(project),'utf8');
  const open=()=>openRefactorRecords(path.dirname(journalFile(project)),{discardable:refactorDiscardable});
  const good={type:'discard',key:last.key,kind:'refactor_analyze',reason:'answer_rejected',attempt:1,requestDigest:last.requestDigest,resultDigest:last.resultDigest,
    evidence:{sha256:digest('x'),length:1},released:null,at:'2026-10-09T00:00:00.000Z'};
  const forged={wrongResult:{...good,resultDigest:'0'.repeat(64)},wrongReason:{...good,reason:'answer_missing',resultDigest:null},
    notReaskable:{...good,kind:'refactor_recover'},rawEvidence:{...good,evidence:'x'},wrongAttempt:{...good,attempt:2},
    wrongIdentity:{...good,requestDigest:'0'.repeat(64)},
    noRelease:Object.fromEntries(Object.entries(good).filter(([name])=>name!=='released'))};
  for(const [name,row] of Object.entries(forged)){
    fs.writeFileSync(journalFile(project),base);appendRow(project,row);
    assert.throws(open,/refactor_journal_invalid/,name);
  }
  // Duplicate: the same answer discarded twice (the second has no effect left to discard).
  fs.writeFileSync(journalFile(project),base);appendRow(project,good);assert.doesNotThrow(open);
  appendRow(project,good);assert.throws(open,/refactor_journal_invalid/);
  // Over limit: three discards of one kind, each with its own re-asked answer.
  fs.writeFileSync(journalFile(project),base);
  const intent=rows(project).find(row=>row.type==='intent'&&row.key===last.key);
  for(let n=0;n<3;n++){
    if(n)for(const type of ['intent','result'])
      appendRow(project,type==='intent'?{type,key:last.key,kind:'host',input:intent.input,attempt:n+1}:{type,key:last.key,result:{value:{decision:'proceed'},durationMs:n}});
    const current=rows(project).filter(row=>row.type==='result'&&row.key===last.key).at(-1);
    appendRow(project,{...good,attempt:n+1,requestDigest:effectDigest({input:intent.input,attempt:n+1}),resultDigest:digest(current.result)});
    if(n<2)assert.doesNotThrow(open,`discard ${n+1}`);else assert.throws(open,/refactor_journal_invalid/,'third discard');
  }
  // A re-asked intent must carry the next attempt; without it the replay refuses.
  fs.writeFileSync(journalFile(project),base);appendRow(project,good);
  appendRow(project,{type:'intent',key:last.key,kind:'host',input:intent.input});assert.throws(open,/refactor_journal_invalid/,'missing attempt');
  // An old journal (no discard rows) replays exactly as before.
  fs.writeFileSync(journalFile(project),base);
  const replay=createCmRefactorHost(config,{call:async()=>assert.fail('a recorded answer is replayed')});
  const again=await replay.handle({operation:'resume'});assert.equal(again.reason,'refactor_analysis_invalid');
  assert.equal(fs.readFileSync(journalFile(project),'utf8').split('\n').filter(line=>line.includes('"type":"discard"')).length,0);
});

test('a discard that is not the most recent intent, or outside a blocked run, is refused',{timeout:60000},async t=>{
  const {config,project}=fixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload)});
  assert.equal((await host.handle({operation:'start'})).stage,'awaiting_finish');
  const analysis=rows(project).find(row=>row.type==='intent'&&row.key==='host/analysis');
  const result=await host.handle({operation:'resume',discard:{key:'host/analysis',requestDigest:digest(analysis.input),evidence:'not blocked'}});
  assert.equal(result.reason,'refactor_discard_unavailable');
  const records=openRefactorRecords(path.dirname(journalFile(project)),{discardable:refactorDiscardable});records.acquire();
  assert.throws(()=>records.discard({key:'host/analysis',requestDigest:digest(analysis.input),evidence:'old'}),/refactor_discard_not_last/);records.release();
  const plan=path.join(path.dirname(project),'plan.json');
  fs.writeFileSync(path.join(path.dirname(project),'drive-config.json'),JSON.stringify(config));
  fs.writeFileSync(plan,JSON.stringify({config:'drive-config.json',discard:{key:'host/analysis',requestDigest:digest(analysis.input),evidence:'old'}}));
  const driver=spawnSync(process.execPath,[path.join(root,'scripts/cm-refactor-drive.mjs'),'--plan',plan,'resume'],{encoding:'utf8'});
  assert.equal(driver.status,2);assert.match(driver.stderr,/只能作废最后一个文字应答/);
});

test('notify classifies refactor discard blocks as stuck',async()=>{
  const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
  for(const reason of ['refactor_analysis_invalid','refactor_unknown_effect','refactor_discard_limit','refactor_discard_not_last'])
    assert.equal(classifyDriveResult('cm-refactor',{result:{stage:'blocked',reason,recovery:{discards:[],lastAnswer:null,unknown:[]}}}),'stuck',reason);
});

test('a re-asked call is reconciled only as its own attempt; a receipt of the discarded attempt is refused',{timeout:60000},async t=>{
  const {config}=fixture(t);
  const lost=createCmRefactorHost(config,{call:async(kind,payload)=>{if(kind==='refactor_apply')throw Error('lost');return response(kind,payload);}});
  assert.equal((await lost.handle({operation:'start'})).stage,'blocked');
  let blocked=await createCmRefactorHost(config,{call:async kind=>{assert.equal(kind,'refactor_recover');return {decision:'unknown',evidence:'gone'};}}).handle({operation:'resume'});
  const first=blocked.recovery.unknown[0];let asked;
  blocked=await createCmRefactorHost(config,{call:async(kind,payload)=>{asked=payload;throw Error('lost again');}})
    .handle({operation:'resume',discard:{key:first.key,requestDigest:first.requestDigest,evidence:'session lost it'}});
  assert.deepEqual(asked.recovery,{key:first.key,attempt:2});
  const second=blocked.recovery.unknown[0];assert.equal(second.attempt,2);assert.notEqual(second.requestDigest,first.requestDigest);
  const proposal={value:response('refactor_apply',asked),durationMs:1};
  const stale=await createCmRefactorHost(config,{call:async(kind,payload)=>{assert.equal(payload.attempt,2);
    return {decision:'completed',result:proposal,evidence:'receipt of attempt 1'};}}).handle({operation:'resume'});
  assert.equal(stale.reason,'refactor_recover_attempt_mismatch');
  const done=await createCmRefactorHost(config,{call:async(kind,payload)=>kind==='refactor_recover'
    ?{decision:'completed',attempt:2,result:proposal,evidence:'receipt of attempt 2'}:response(kind,payload)}).handle({operation:'resume'});
  assert.equal(done.stage,'awaiting_finish',JSON.stringify(done));
});

test('real host: a non-empty but invalid review is not published and can be discarded and asked again',{timeout:60000},async t=>{
  const {config,temp,project}=fixture(t);let bad=1;
  const respond=message=>{const value=response(message.kind,message.payload);
    if(message.kind==='refactor_review'&&bad-->0)value.markdown=value.markdown.replace(/handoff_sha256: [0-9a-f]+/,'handoff_sha256: '+'0'.repeat(64));
    return value;};
  let run=await serve(t,config,temp,respond,[{operation:'start'}]);
  const blocked=run.results[0];assert.equal(blocked.reason,'refactor_review_invalid',JSON.stringify(blocked));
  const review=path.join(project,'docs/refactors/.reviews/refactor-extract-T-REFACTOR-extract-r1.md');assert.equal(fs.existsSync(review),false);
  const {key,requestDigest}=blocked.recovery.lastAnswer;assert.equal(key,'host/a1/review');
  run=await serve(t,config,temp,respond,[{operation:'resume',discard:{key,requestDigest,evidence:'handoff digest was wrong'}}]);
  assert.equal(run.results[0].stage,'awaiting_finish',JSON.stringify(run.results[0]));assert.ok(fs.existsSync(review));
});

test('a lost confirmation is asked again at most twice, each time recorded; then refactor_confirm_reask_limit',{timeout:60000},async t=>{
  const {config,project}=fixture(t);
  assert.equal((await createCmRefactorHost(config,{call:async(kind,payload)=>response(kind,payload)}).handle({operation:'start'})).stage,'awaiting_finish');
  const asked=[];
  const lose=createCmRefactorHost(config,{call:async(kind,payload)=>{asked.push(payload);throw Error('confirmation lost');}});
  assert.equal((await lose.handle({operation:'finish'})).stage,'blocked');
  for(let n=1;n<=2;n++){
    const result=await createCmRefactorHost(config,{call:async(kind,payload)=>{asked.push(payload);throw Error('lost again');}}).handle({operation:'finish'});
    assert.equal(result.stage,'blocked');assert.notEqual(result.reason,'refactor_confirm_reask_limit');
  }
  assert.deepEqual(asked.map(item=>item.recovery?.attempt??1),[1,2,3]);
  const limited=await createCmRefactorHost(config,{call:async()=>assert.fail('no third re-ask')}).handle({operation:'finish'});
  assert.equal(limited.reason,'refactor_confirm_reask_limit');assert.match(limited.guidance.summary,/2 次/);
  const discards=rows(project).filter(row=>row.type==='discard');
  assert.deepEqual(discards.map(row=>[row.kind,row.reason,row.attempt]),[['refactor_confirm','answer_missing',1],['refactor_confirm','answer_missing',2]]);
  // Replay rebuilds both records (the shared per-kind limit is enforced on replay, see the over-limit test).
  const records=openRefactorRecords(path.dirname(journalFile(project)),{discardable:refactorDiscardable});
  assert.equal(records.discards.length,2);
});
