import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {openRefactorRecords} from '../runtime/js/cm-refactor/records.mjs';
import {fixture,fullResponse,original,replacement} from './fixtures/cm-refactor.mjs';

const initialRules='Named functions; preserve values; do not fix bugs.';
const revisedRules=initialRules+' Preserve negative-input guards before additions.';
const generated=replacement+'// REFACTOR STATUS: confidence=high todos=0\n';
const foreign=Buffer.from('// foreign edit: 请保留\r\nexport const owner = "other";\r\n');
const batchKey='a1/batch-1-1';
const generationKey=`host/${batchKey}/unit-input.mjs`;

function batchFixture(t,names=['input.mjs']){
  const value=fixture(t),{config,project}=value;
  for(const name of names)if(name!=='input.mjs')fs.writeFileSync(path.join(project,name),'export const helper = 1;\n');
  // Same isolated Git fixture as cm-refactor-host.test.mjs; never touches checkout Git state.
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]){
    const out=spawnSync('git',args,{cwd:project});assert.equal(out.status,0,out.stderr.toString());
  }
  config.scope=names;config.batch={assemblyFiles:[],cheapCommands:[{id:'syntax',command:[process.execPath,'--check','{file}']}],maxPasses:3};
  return {...value,directory:path.join(project,'docs/refactors/extract')};
}
function answer(kind,payload){
  const value=fullResponse(kind,payload);
  // The shared full-track fixture normally requests entry assembly and AGENTS writeback.
  // These tests authorize only source files, so return the same generator without those needs.
  if(kind==='refactor_batch'&&payload.action==='generate')value.needs=[];
  if(kind==='refactor_retrospective'){
    value.learning={status:'no_new_lesson',candidates:[],reason:null};value.conventions=[];
  }
  return value;
}
const journal=directory=>fs.readFileSync(path.join(directory,'execution.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
const report=(directory,name)=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8').replace(/^```json\n/,'').replace(/\n```\n$/,''));

for(const verdicts of [['rule_correct'],['rule_missing'],['rule_wrong'],['rule_correct','rule_missing','rule_wrong']]){
  test(`bakeoff accepts ${verdicts.join('+')}, publishes all decisions and forwards adjudicated rules`,async t=>{
    const names=['input.mjs','helper.mjs','other.mjs'].slice(0,verdicts.length);
    const {config,directory}=batchFixture(t,names),calls=[];
    const decisions=names.map((name,i)=>({path:name,verdict:verdicts[i],reason:`Preserve the boundary in ${name}`}));
    const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
      calls.push({kind,payload});const value=answer(kind,payload);
      if(payload.action==='plan')value.sample=names;
      if(payload.action==='bakeoff'&&payload.variant==='blind')value.files.forEach(file=>{file.content+='// alternate structure\n';});
      if(payload.action==='adjudicate')Object.assign(value,{rulebook:revisedRules,decisions});
      return value;
    }});
    const result=await host.handle({operation:'start'});
    assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
    assert.equal(calls.find(row=>row.payload.gate==='g0').payload.analysis.decision,'proceed');
    assert.ok(result.reports.includes(path.join(directory,'a1-bakeoff.md')));
    assert.deepEqual(report(directory,'a1-bakeoff.md').adjudication,{channelId:'third',rulebook:revisedRules,decisions});
    const index=calls.findIndex(row=>row.payload.action==='adjudicate');
    assert.equal(calls[index].payload.rulebook,initialRules);
    const next=calls.slice(index+1).find(row=>Object.hasOwn(row.payload,'rulebook'));
    assert.equal(next.payload.action,'generate');assert.equal(next.payload.rulebook,revisedRules);
    assert.ok(calls.slice(index+1).filter(row=>Object.hasOwn(row.payload,'rulebook')).every(row=>row.payload.rulebook===revisedRules));
    assert.equal(Object.hasOwn(calls.find(row=>row.payload.variant==='blind').payload,'rulebook'),false);
  });
}

const revisionRefusals=[
  {name:'rule_missing with unchanged rules',verdicts:['rule_missing']},
  {name:'rule_wrong with unchanged rules',verdicts:['rule_wrong']},
  {name:'mixed verdicts with unchanged rules',verdicts:['rule_correct','rule_missing']},
  {name:'rule_missing with trailing whitespace only',transform:rules=>rules.split('\n').map(line=>line+' \t').join('\n')},
  {name:'rule_missing with CRLF only',transform:rules=>rules.replaceAll('\n','\r\n')},
  {name:'rule_missing with outer blank lines only',transform:rules=>'\n\n'+rules+'\n\n'},
  {name:'rule_missing with combined whitespace only',transform:rules=>' \t\r\n\r\n'+rules.replaceAll('\n',' \t\r\n')+' \t\r\n\r\n'}
];
for(const scenario of revisionRefusals)test(`bakeoff refuses ${scenario.name} with refactor_rule_revision_required`,async t=>{
  const verdicts=scenario.verdicts??['rule_missing'];
  const names=['input.mjs','helper.mjs'].slice(0,verdicts.length);
  const {config,project,directory}=batchFixture(t,names),calls=[];
  const rules=initialRules+'\nKeep boundary behavior.';
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    calls.push({kind,payload});const value=answer(kind,payload);
    if(payload.action==='plan')Object.assign(value,{sample:names,rulebook:rules});
    if(payload.action==='bakeoff'&&payload.variant==='blind')value.files.forEach(file=>{file.content+='// different\n';});
    if(payload.action==='adjudicate')Object.assign(value,{rulebook:scenario.transform?.(rules)??rules,
      decisions:names.map((name,i)=>({path:name,verdict:verdicts[i],reason:'Check negative bounds'}))});
    return value;
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(result.reason,'refactor_rule_revision_required');assert.equal(result.stage,'blocked');
  assert.equal(fs.existsSync(path.join(directory,'a1-bakeoff.md')),false);
  assert.equal(result.reports.some(file=>file.endsWith('a1-bakeoff.md')),false);
  assert.equal(calls.some(row=>row.payload.action==='generate'),false,'no pilot request');
  const rows=journal(directory);
  assert.equal(rows.some(row=>row.key?.includes('/pilot-')),false);
  assert.equal(rows.some(row=>row.key==='publish/a1-bakeoff'),false);
  assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
});

test('bakeoff accepts all rule_correct with unchanged rules',async t=>{
  const {config,directory}=batchFixture(t),calls=[];
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    calls.push({kind,payload});const value=answer(kind,payload);
    if(payload.action==='bakeoff'&&payload.variant==='blind')value.files[0].content+='// different\n';
    if(payload.action==='adjudicate')Object.assign(value,{rulebook:initialRules,
      decisions:[{path:'input.mjs',verdict:'rule_correct',reason:'Keep existing guard order'}]});
    return value;
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  assert.equal(report(directory,'a1-bakeoff.md').adjudication.rulebook,initialRules);
  assert.ok(calls.some(row=>row.payload.action==='generate'));
  assert.ok(calls.filter(row=>Object.hasOwn(row.payload,'rulebook')).every(row=>row.payload.rulebook===initialRules));
});

const refusals=[
  {name:'fourth verdict',code:'refactor_bakeoff_coverage',judge:value=>{value.decisions[0].verdict='rule_ok';}},
  {name:'uppercase verdict',code:'refactor_bakeoff_coverage',judge:value=>{value.decisions[0].verdict='RULE_CORRECT';}},
  {name:'empty reason',code:'refactor_bakeoff_coverage',judge:value=>{value.decisions[0].reason='';}},
  {name:'whitespace reason',code:'refactor_bakeoff_coverage',judge:value=>{value.decisions[0].reason=' \t\n';}},
  {name:'missing differing-file decision',code:'refactor_bakeoff_coverage',judge:value=>{value.decisions=[];}},
  ...['guided','blind'].map(variant=>({name:`missing ${variant} file`,code:'refactor_bakeoff_coverage',author:(value,payload)=>{
    if(payload.variant===variant)value.files=[];
  }})),
  {name:'same author channel',code:'refactor_bakeoff_not_independent',author:value=>{value.channelId='shared';}},
  ...['guided','blind'].map(channel=>({name:`adjudicator reuses ${channel} channel`,code:'refactor_bakeoff_invalid',judge:value=>{value.channelId=channel;}})),
  {name:'empty adjudicated rulebook',code:'refactor_bakeoff_invalid',judge:value=>{value.rulebook='';}},
  {name:'whitespace adjudicated rulebook',code:'refactor_bakeoff_invalid',judge:value=>{value.rulebook=' \n';}},
  {name:'missing decisions array',code:'refactor_bakeoff_invalid',judge:value=>{delete value.decisions;}}
];
for(const scenario of refusals)test(`bakeoff refuses ${scenario.name} with ${scenario.code}`,async t=>{
  const {config,project,directory}=batchFixture(t);let generations=0;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    const value=answer(kind,payload);
    if(payload.action==='generate')generations++;
    if(payload.action==='bakeoff'){
      if(payload.variant==='blind')value.files[0].content+='// different\n';
      scenario.author?.(value,payload);
    }
    if(payload.action==='adjudicate'){
      Object.assign(value,{rulebook:revisedRules,decisions:[{path:'input.mjs',verdict:'rule_correct',reason:'Keep guard order'}]});
      scenario.judge?.(value);
    }
    return value;
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(result.stage,'blocked');assert.equal(result.reason,scenario.code);
  assert.equal(generations,0);assert.equal(fs.existsSync(path.join(directory,'a1-bakeoff.md')),false);
  assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
});

test('bakeoff identical outputs require no decision',async t=>{
  const {config,directory}=batchFixture(t),host=createCmRefactorHost(config,{call:async(kind,payload)=>answer(kind,payload)});
  const result=await host.handle({operation:'start'});assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));
  const value=report(directory,'a1-bakeoff.md');
  assert.deepEqual(value.trial.guided.files,value.trial.blind.files);assert.deepEqual(value.adjudication.decisions,[]);
  assert.equal(value.adjudication.rulebook,initialRules);
});

function assertHalted(result,directory,code,target,calls){
  assert.equal(result.stage,'blocked',JSON.stringify(result));assert.equal(result.reason,code);
  assert.deepEqual(fs.readFileSync(target),foreign,'foreign bytes must survive');
  assert.equal(fs.existsSync(path.join(directory,'a1-batch-1-1-failure.md')),false);
  assert.equal(result.reports.some(file=>file.endsWith('a1-batch-1-1-failure.md')),false);
  const rows=journal(directory);
  assert.equal(rows.some(row=>row.key?.includes(`${batchKey}/failed-restore`)),false);
  assert.equal(rows.some(row=>/a1\/(?:batch-1-[2-9]|batch-2-|pilot-2)/.test(row.key??'')),false);
  assert.deepEqual(rows.filter(row=>row.type==='intent'&&row.kind==='log'&&row.input.event==='task_start')
    .map(row=>[row.input.data.batch,row.input.data.cycle]),[[1,1]]);
  assert.equal(calls.some(row=>['diagnose','plan','generate','assemble'].includes(row.payload.action)),false,'no further batch/cycle');
}

// Interrupt a real production invocation. Pilot, judge and rulebook approval have completed.
async function interruptGeneration(config){
  let generations=0,pending;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    if(payload.action==='generate'&&++generations===2){pending={kind,payload};throw Error('fixture connection lost');}
    return answer(kind,payload);
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(result.stage,'blocked');assert.equal(result.reason,'fixture connection lost');assert.ok(pending);
  return pending;
}

for(const code of ['refactor_source_changed','refactor_out_of_scope_change','refactor_unknown_effect']){
  test(`${code} during production recovery preserves foreign bytes and halts without retry`,async t=>{
    const {config,project,directory}=batchFixture(t,['input.mjs','helper.mjs']);
    const pending=await interruptGeneration(config),calls=[];
    const target=path.join(project,code==='refactor_source_changed'?'input.mjs':'foreign.mjs');
    const resumed=createCmRefactorHost(config,{call:async(kind,payload)=>{
      calls.push({kind,payload});assert.equal(kind,'refactor_recover');
      assert.equal(payload.kind,'host');assert.deepEqual(payload.input,{kind:pending.kind,payload:pending.payload});
      fs.writeFileSync(target,foreign);
      if(code==='refactor_unknown_effect')return {decision:'unknown',evidence:'Original invocation receipt unavailable'};
      // recover() validates before calling the host. A completed receipt is persisted, then
      // the real pre-apply guard sees this edit, with no pending host/command to mask the code.
      return {decision:'completed',evidence:'Synthetic original invocation receipt',result:{value:answer(pending.kind,pending.payload),durationMs:1}};
    }});
    const result=await resumed.handle({operation:'resume'});
    assertHalted(result,directory,code,target,calls);assert.equal(calls.length,1);
    const rows=journal(directory),completed=rows.some(row=>row.type==='result'&&row.key===generationKey);
    assert.equal(completed,code!=='refactor_unknown_effect');
    assert.equal(fs.readFileSync(path.join(project,'helper.mjs'),'utf8'),'export const helper = 1;\n');
  });
}

test('refactor_write_conflict during atomic batch write preserves the third value and halts',async t=>{
  const {config,project,directory}=batchFixture(t,['input.mjs','helper.mjs']);
  const target=path.join(project,'input.mjs');let generations=0,armed=false,injections=0;const afterConflict=[];
  const realFsync=fs.fsyncSync;
  // Fault injection at the real atomic-write boundary, not a mocked guard or synthetic error.
  // The journal intent and staged replacement have been fsynced; another writer wins before
  // replaceText's second comparison. Match the real staged inode without touching its fd.
  t.mock.method(fs,'fsyncSync',function(fd){
    const result=realFsync(fd);
    if(armed&&fs.fstatSync(fd).isFile()&&fs.fstatSync(fd).size===Buffer.byteLength(generated)){
      const stat=fs.fstatSync(fd),staged=fs.readdirSync(project).filter(name=>name.startsWith('.cm-refactor-'))
        .map(name=>path.join(project,name)).find(file=>fs.statSync(file).ino===stat.ino&&fs.statSync(file).dev===stat.dev);
      if(staged&&fs.readFileSync(staged,'utf8')===generated){armed=false;injections++;fs.writeFileSync(target,foreign);}
    }
    return result;
  });
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    if(injections)afterConflict.push({kind,payload});
    if(payload.action==='generate'&&++generations===2)armed=true;
    return answer(kind,payload);
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(injections,1);assertHalted(result,directory,'refactor_write_conflict',target,afterConflict);
  assert.equal(afterConflict.length,0);
  const key=`write/${batchKey}/unit-input.mjs/input.mjs`,rows=journal(directory);
  const intent=rows.find(row=>row.type==='intent'&&row.key===key);
  assert.equal(intent.input.before,original);assert.equal(intent.input.after,generated);
  assert.equal(rows.some(row=>row.type==='result'&&row.key===key),false);
  // Startup guard must also refuse this authentic interrupted write before replay or host calls.
  const reopened=createCmRefactorHost(config,{call:async()=>assert.fail('conflicted write cannot resume')});
  assertHalted(await reopened.handle({operation:'resume'}),directory,'refactor_write_conflict',target,[]);
});

test('ordinary cheap-check failure restores the production batch, reports it and retries successfully',async t=>{
  const {config,project,directory}=batchFixture(t,['input.mjs','helper.mjs']);let generations=0,diagnoses=0;
  const host=createCmRefactorHost(config,{call:async(kind,payload)=>{
    const value=answer(kind,payload);
    if(payload.action==='generate'&&payload.files[0].path==='input.mjs'){
      generations++;
      if(generations===2)value.files[0].content='export const calc = ;\n// REFACTOR STATUS: confidence=low todos=0\n';
      if(generations===3){assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);assert.equal(payload.files[0].content,original);}
    }
    if(payload.action==='diagnose'){
      diagnoses++;assert.equal(payload.failure,'refactor_cheap_check_failed');
      assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),original);
      const failure=report(directory,'a1-batch-1-1-failure.md');
      assert.equal(failure.failure,'refactor_cheap_check_failed');assert.equal(failure.output.observed.outcome,'failed');assert.equal(failure.pilot,false);
    }
    return value;
  }});
  const result=await host.handle({operation:'start'});
  assert.equal(result.stage,'awaiting_finish',JSON.stringify(result));assert.equal(generations,3);assert.equal(diagnoses,1);
  assert.equal(fs.readFileSync(path.join(project,'input.mjs'),'utf8'),generated);
  assert.ok(result.reports.includes(path.join(directory,'a1-batch-1-1-failure.md')));
  const rows=journal(directory);
  assert.ok(rows.some(row=>row.type==='result'&&row.key===`write/${batchKey}/failed-restore/input.mjs`));
  assert.ok(rows.some(row=>row.type==='result'&&row.key==='host/a1/batch-1-2/unit-input.mjs'));
  assert.ok(rows.some(row=>row.type==='result'&&row.key==='host/a1/batch-2-1/unit-helper.mjs'));
});

test('records refuses recovery of an interrupted effect without a recovery handler',async t=>{
  const {temp}=fixture(t),directory=path.join(temp,'records'),target=path.join(temp,'foreign.txt');
  const first=openRefactorRecords(directory);first.acquire();
  try{await assert.rejects(first.effect('hash','hash',{},()=>{throw Error('interrupted');}),/interrupted/);}finally{first.release();}
  fs.writeFileSync(target,foreign);
  const reopened=openRefactorRecords(directory);reopened.acquire();
  try{
    await assert.rejects(reopened.effect('hash','hash',{},()=>assert.fail('must not repeat')),{code:'refactor_unknown_effect'});
    assert.deepEqual(fs.readFileSync(target),foreign);
  }finally{reopened.release();}
});
