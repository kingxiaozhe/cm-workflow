import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,replacement} from './fixtures/cm-refactor.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const driver=path.join(root,'scripts/cm-refactor-drive.mjs');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function setup(t){
  const {temp,project,config}=fixture(t),answers=path.join(temp,'answers');fs.mkdirSync(answers);
  const configPath=path.join(temp,'config.json');write(configPath,config);
  write(path.join(answers,'analyze.json'),{decision:'proceed',metric:{name:'nesting',before:2,unit:'levels'},impact:[],claimedMemos:[],reason:'Extract function'});
  write(path.join(answers,'confirm.json'),{g0:'approved',finish:'approved'});
  fs.writeFileSync(path.join(answers,'replacement.mjs'),replacement);
  write(path.join(answers,'apply.json'),{files:[{path:'input.mjs',contentFile:'replacement.mjs'}],summary:'Extract function',
    metricAfter:1,unfixedDefects:[],conventions:[],learningApplication:'No relevant lesson',learningRetrospective:'no_new_lesson'});
  write(path.join(answers,'review.json'),{at:'2026-09-08T18:00:00+00:00',reviewer:'codex-subagent',verdict:'approved',
    blocking_findings:0,body:'Zero findings in independently authored fixture review.'});
  const planPath=path.join(temp,'plan.json');write(planPath,{config:'config.json',answers:'answers'});
  const store=path.join(project,'docs/refactors/extract/execution.jsonl');
  const run=(operation,which=driver)=>spawnSync(process.execPath,[which,'--plan',planPath,operation],{encoding:'utf8',timeout:120000});
  return {temp,project,config,answers,planPath,store,run};
}
test('real light host: start, status, new-process resume, finish',t=>{
  const f=setup(t);let out=f.run('status');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.stage,'ready');
  assert.equal(fs.existsSync(f.store),false);
  out=f.run('start');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.stage,'awaiting_finish');
  assert.equal(fs.readFileSync(path.join(f.project,'input.mjs'),'utf8'),replacement);
  out=f.run('resume');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.stage,'awaiting_finish');
  out=f.run('finish');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.stage,'done');
});
test('missing, malformed and out-of-scope answers refuse before store creation',t=>{
  for(const change of ['missing','malformed','scope']){
    const f=setup(t),file=path.join(f.answers,'apply.json');
    if(change==='missing')fs.unlinkSync(file);
    if(change==='malformed')write(file,{files:'invalid'});
    if(change==='scope')write(file,{...JSON.parse(fs.readFileSync(file)),files:[{path:'outside.mjs',contentFile:'replacement.mjs'}]});
    const out=f.run('start');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/apply\.json/);
    assert.equal(fs.existsSync(f.store),false);
  }
});
test('unknown command evidence has no static recovery path',t=>{
  const f=setup(t);let out=f.run('start');assert.equal(out.status,0,out.stderr);
  const rows=fs.readFileSync(f.store,'utf8').trim().split('\n');
  const last=rows.findLast(line=>JSON.parse(line).type==='result'&&JSON.parse(line).key.startsWith('command/'));
  assert.ok(last);const key=JSON.parse(last).key;
  const index=rows.findIndex(line=>JSON.parse(line).type==='intent'&&JSON.parse(line).key===key);
  // Use a valid crash prefix: the original command intent has no result.
  fs.writeFileSync(f.store,rows.slice(0,index+1).join('\n')+'\n');const before=fs.readFileSync(f.store);
  write(path.join(f.answers,'recover.json'),{decision:'completed',result:{observed:{outcome:'passed',exitCode:0}}});
  out=f.run('resume');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/缺少原执行回执 runner: command/);
  assert.deepEqual(fs.readFileSync(f.store),before);
});
test('resume config digest remains bound before launch',t=>{
  const f=setup(t);assert.equal(f.run('start').status,0);
  const altered={...f.config,target:'Changed target'};write(path.join(f.temp,'config.json'),altered);
  const before=fs.readFileSync(f.store),out=f.run('resume');assert.equal(out.status,2,out.stderr);
  assert.match(out.stderr,/resume 配置绑定不匹配/);assert.deepEqual(fs.readFileSync(f.store),before);
});
test('mutation probes catch skipped answer preflight and dropped resume binding',t=>{
  const f=setup(t),source=fs.readFileSync(driver,'utf8');
  const mutant=(from,to)=>{
    assert.ok(source.includes(from));const file=path.join(root,'scripts',`.cm-refactor-drive-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file,source.replace(from,to));t.after(()=>fs.rmSync(file,{force:true}));return file;
  };
  fs.unlinkSync(path.join(f.answers,'apply.json'));
  let out=f.run('start');assert.equal(out.status,2);assert.equal(fs.existsSync(f.store),false);
  out=f.run('start',mutant('preflightAnswers(asks,kind=>','preflightAnswers([],kind=>'));
  assert.notEqual(out.status,2,'mutation escaped preflight and changed the refusal');
  const g=setup(t);assert.equal(g.run('start').status,0);
  write(path.join(g.temp,'config.json'),{...g.config,target:'Changed target'});
  out=g.run('resume');assert.equal(out.status,2);
  out=g.run('resume',mutant('records.context.configDigest!==digest(config)','false'));
  assert.notEqual(out.status,2,'mutation reached host instead of rejecting resume binding');
});

// V7: the driver never pre-answers a re-asked confirmation. The host registers the
// new attempt, the driver stops naming key/attempt/gate/requestDigest, and only a
// decision file bound to exactly that call is used on the next resume.
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {openRefactorRecords,effectDigest} from '../runtime/js/cm-refactor/records.mjs';
import {refactorDiscardable} from '../runtime/js/cm-refactor/workflow.mjs';
const lastConfirm=f=>{const records=openRefactorRecords(path.dirname(f.store),{discardable:refactorDiscardable});
  const [key,entry]=[...records.effects].filter(([,item])=>item.kind==='host'&&item.input.kind==='refactor_confirm').at(-1);
  return {key,attempt:entry.attempt??1,gate:entry.input.payload.gate,requestDigest:effectDigest(entry),answered:Object.hasOwn(entry,'result')};};
async function reaskFlow(t,crashWindow){
  const f=setup(t);assert.equal(f.run('start').status,0);
  const lost=await createCmRefactorHost(f.config,{call:async()=>{throw Error('finish confirmation lost');}}).handle({operation:'finish'});
  assert.equal(lost.stage,'blocked');
  if(crashWindow){
    // The host appended the lost confirmation's discard and exited before the re-asked intent.
    const records=openRefactorRecords(path.dirname(f.store),{discardable:refactorDiscardable});records.acquire();
    try{const entry=records.effects.get('host/finish-1');
      records.discard({key:'host/finish-1',requestDigest:effectDigest(entry),evidence:'confirmation lost; host exited before re-asking'});}
    finally{records.release();}
    assert.equal(fs.readFileSync(f.store,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line)).at(-1).type,'discard');
  }
  // confirm.json still says finish: approved; the driver must not use it for the re-ask.
  let out=f.run('finish');assert.notEqual(out.status,0);
  const asked=lastConfirm(f);assert.deepEqual([asked.key,asked.attempt,asked.gate,asked.answered],['host/finish-1',2,'finish',false]);
  assert.match(out.stderr,/confirm_reask_decision_required/);assert.match(out.stderr,new RegExp(asked.requestDigest));
  out=f.run('resume');assert.equal(out.status,2);assert.match(out.stderr,/confirm_reask_decision_required/);
  const reask=path.join(f.answers,'confirm-reask.json');
  // A wrong gate, another attempt and another digest are refused and never used.
  for(const stale of [{...asked,gate:'g0'},{...asked,attempt:1},{...asked,requestDigest:'0'.repeat(64)}]){
    write(reask,{key:stale.key,attempt:stale.attempt,gate:stale.gate,requestDigest:stale.requestDigest,decision:'approved'});
    out=f.run('resume');assert.equal(out.status,2);assert.match(out.stderr,/confirm_reask_decision_stale/);
    assert.equal(lastConfirm(f).answered,false);
  }
  write(reask,{key:asked.key,attempt:asked.attempt,gate:asked.gate,requestDigest:asked.requestDigest,decision:'rejected'});
  out=f.run('resume');assert.equal(out.status,0,out.stderr);assert.equal(lastConfirm(f).answered,true);
  assert.equal(JSON.parse(out.stdout).result.stage,'awaiting_finish');
  // The new decision (rejected) is the one recorded, not confirm.json's approved.
  const rows=fs.readFileSync(f.store,'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  const adopted=rows.findLast(row=>row.type==='result'&&row.key==='host/finish-1');
  assert.equal(adopted.result.value.decision,'rejected');assert.equal(adopted.result.confirmation.source,'operator_confirmed');
}
test('a re-asked confirmation is registered first, then answered only from a decision bound to that call',t=>reaskFlow(t,false));
test('crash between the discard and the re-asked intent: the same stop, the same bound decision',t=>reaskFlow(t,true));
