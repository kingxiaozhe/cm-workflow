import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixReproduction} from '../runtime/js/cm-fix/reproduce.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
const identity={repositoryId:'fix-fixture',runId:'fix-demo',taskId:'T-FIX-demo',attempt:1};
async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-owner-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  const configuration={hostContextId:'actual-fixture-host',defect:'Synthetic failure',reproduction:{cwd,
    command:[process.execPath,'-e',"require('node:fs').appendFileSync('visits','1');process.stderr.write('BUG');process.exit(3)"],
    expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}};
  try{await fn({specsRoot,identity,configuration,create:true},cwd);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const cause={status:'diagnosed',rootCause:'Synthetic constant differs from expectation',affectedPaths:['value.mjs'],
  plan:'Correct the constant after the red test',crossLayer:false,affectedModules:['value']};
test('durable reproduce/diagnose uses bridge and reopens without executing again',()=>fixture(async(options,cwd)=>{
  let calls=0;const bridge=createHostToolBridge();
  bridge.attach(row=>{if(row.type==='host_request'){
    calls++;assert.equal(row.kind,'fix_diagnose');assert.equal(row.payload.reproduction.status,'reproduced');
    bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:cause});
  }});
  let owner=openFixExecution(options,{bridge});
  try{
    await assert.rejects(owner.advance(),{code:'fix_execution_authorization_required'});
    assert.equal((await owner.advance({authorized:true})).stage,'red_test_required');
    assert.equal(owner.status().completionEligible,false);owner.close();
    owner=openFixExecution({...options,create:false},{bridge});
    assert.equal((await owner.advance()).stage,'red_test_required');
    assert.equal(calls,1);assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
  }finally{owner.close();bridge.close();}
}));
test('lost diagnosis and pre-dispatch intent reopen unknown, never redispatch',async()=>{
  for(const prefix of ['reproduce','diagnose'])await fixture(async(options,cwd)=>{
    const bridge=createHostToolBridge();bridge.attach(row=>{if(row.type==='host_request')bridge.close();});
    let owner=openFixExecution(options,{bridge});
    if(prefix==='diagnose')assert.equal((await owner.advance({authorized:true})).stage,'unknown');
    owner.close();
    if(prefix==='reproduce'){
      const state=JSON.parse(fs.readFileSync(path.join(options.specsRoot,'.reviews','.execution',identity.runId,'state.json')));
      const store=openExecutionStore({specsRoot:options.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
      store.append({id:'fix-reproduce-intent',kind:'intent',payload:{stage:'reproduce'},expectedRevision:store.snapshot().revision});store.close();
    }
    owner=openFixExecution({...options,create:false});
    try{assert.equal((await owner.advance({authorized:true})).stage,'unknown');
      if(prefix==='reproduce')assert.equal(fs.existsSync(path.join(cwd,'visits')),false);
      else assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    }finally{owner.close();bridge.close();}
  });
});
test('cancel remains durable and changed host configuration cannot reopen',()=>fixture(async(options)=>{
  let owner=openFixExecution(options);
  const running=owner.advance({authorized:true});owner.cancel();
  assert.equal((await running).stage,'cancelled');owner.close();
  assert.throws(()=>openFixExecution({...options,create:false,
    configuration:{...options.configuration,hostContextId:'other-host'}}),{code:'fingerprint_mismatch'});
  owner=openFixExecution({...options,create:false});
  try{assert.equal((await owner.advance({authorized:true})).stage,'cancelled');}
  finally{owner.close();}
}));

test('legacy observation without attempts can publish, finish and resume without rewriting its archive',()=>fixture(async(options,cwd)=>{
  options.configuration.reproduction.command=[process.execPath,'-e',"require('node:fs').appendFileSync('visits','1')"];
  let owner=openFixExecution(options);owner.close();
  // The old producer's exact shape, backed by a real command observation.
  const run=createFixReproduction(options.configuration.reproduction);
  const {attempts,...legacy}=await run({identity},{signal:new AbortController().signal,authorized:true});
  assert.equal(legacy.status,'not_reproduced');
  const state=JSON.parse(fs.readFileSync(path.join(options.specsRoot,'.reviews','.execution',identity.runId,'state.json')));
  const store=openExecutionStore({specsRoot:options.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
  try{
    store.append({id:'fix-reproduce-intent',kind:'intent',payload:{stage:'reproduce'},expectedRevision:store.snapshot().revision});
    store.append({id:'fix-reproduce-result',kind:'result',payload:{stage:'reproduce',value:legacy},expectedRevision:store.snapshot().revision});
  }finally{store.close();}
  owner=openFixExecution({...options,create:false});
  try{
    assert.equal(owner.status().stage,'observation');assert.equal(owner.status().reproduction.attempts,undefined);
    const published=owner.publishDossier(),bytes=fs.readFileSync(published.dossier.path);
    assert.doesNotMatch(bytes.toString(),/复现尝试/);
    startFixRun(options);
    assert.equal(owner.finish({authorized:true}).observationRunEnded,true);
    owner.close();owner=openFixExecution({...options,create:false});
    assert.deepEqual(fs.readFileSync(owner.publishDossier().dossier.path),bytes);
    fs.writeFileSync(path.join(options.specsRoot,'failure.txt'),'Observed new failure evidence');
    assert.equal(owner.resume({authorized:true,evidenceFiles:['failure.txt']}).stage,'observation_resume_prepared');
    assert.deepEqual(fs.readFileSync(published.dossier.path),bytes);
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
  }finally{owner.close();}
}));

const reviewer={reviewerId:'fix-cause-reviewer',adapterId:'codex-cause-review-adapter',provider:'codex',
  requestedModel:'gpt-6-astra',contextId:'fix-cause-review-context',excludedThreadIds:[]};
const statePath=options=>path.join(options.specsRoot,'.reviews','.execution',identity.runId,'state.json');

test('a later session resumes the original run without rewriting its records',()=>fixture(async(options,cwd)=>{
  const bridge=createHostToolBridge();
  bridge.attach(row=>{if(row.type==='host_request')bridge.accept({type:'host_result',sessionId:row.sessionId,
    callId:row.callId,requestDigest:row.requestDigest,result:cause});});
  let owner=openFixExecution(options,{bridge});
  try{assert.equal((await owner.advance({authorized:true})).stage,'red_test_required');}finally{owner.close();}
  const before=fs.readFileSync(statePath(options));
  // The chat session that created the run is gone; the durable record keeps it.
  owner=openFixExecution({...options,create:false,hostContextId:'actual-resumed-host'},{bridge});
  try{
    assert.equal((await owner.advance()).stage,'red_test_required');
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
  }finally{owner.close();bridge.close();}
  assert.deepEqual(fs.readFileSync(statePath(options)),before);
  assert.equal(JSON.parse(before).records[0].payload.configuration.hostContextId,'actual-fixture-host');
}));

test('resuming never rewrites the durable host or accepts a reviewer-shaped session',()=>fixture(async(options)=>{
  const configuration={...options.configuration,causeReview:reviewer};
  openFixExecution({...options,configuration}).close();
  // Moving the durable host is still a different run configuration.
  assert.throws(()=>openFixExecution({...options,configuration,create:false,
    configuration:{...configuration,hostContextId:'other-host'}}),{code:'fingerprint_mismatch'});
  // A resumed session is still a host, so it cannot be the independent reviewer.
  assert.throws(()=>openFixExecution({...options,configuration,create:false,
    hostContextId:reviewer.contextId}),{code:'invalid_cause_reviewer'});
  openFixExecution({...options,configuration,create:false,hostContextId:'actual-resumed-host'}).close();
}));

// 证据文件名由任务 slug 和轮次拼出来，跟 runId 无关，所以两次运行用同一个 taskId
// 就会写同一批文件。这个冲突原本要等红灯测试去发布输出时才炸——那时候 intent
// 已经登记，运行直接留在 unknown 且不可重派。名字在建运行时全都算得出来。
test('a run whose evidence filenames are already taken is refused before anything is recorded',()=>fixture(async(options)=>{
  const reviews=path.join(options.specsRoot,'.reviews');
  fs.mkdirSync(reviews,{recursive:true,mode:0o700});
  const taken=path.join(reviews,`fix-demo-${identity.taskId}-r1.md`);
  fs.writeFileSync(taken,'another run already published under this task id');
  assert.throws(()=>openFixExecution(options),{code:'fix_evidence_name_taken'});
  // 拒绝发生在任何记录之前：没有留下半个运行
  assert.equal(fs.existsSync(path.join(reviews,'.execution',identity.runId)),false);
  // 换一个任务编号就能正常建起来，说明拦的是重名而不是别的
  const renamed={...options,identity:{...identity,taskId:'T-FIX-demo-two'}};
  openFixExecution(renamed).close();
  // 已经建起来的运行，恢复时不会被自己写下的证据挡住
  fs.writeFileSync(path.join(reviews,'fix-demo-two-T-FIX-demo-two-r1.md'),'its own evidence');
  openFixExecution({...renamed,create:false}).close();
}));

// 走查声明的模块必须和诊断结论对得上。这条规矩一直有，但原来只在走查那一步才查
// ——那已经在花钱做完独立审查之后，整轮白跑。诊断一落盘就判得出来。
test('a walkthrough that does not line up with the diagnosis stops right after diagnosis',async()=>{
  for(const [modules,expected] of [[['value','not-diagnosed'],'walkthrough_configuration_mismatch'],
    [['value'],'red_test_required']])
    await fixture(async(options)=>{
      const bridge=createHostToolBridge();
      bridge.attach(row=>{if(row.type==='host_request')bridge.accept({type:'host_result',sessionId:row.sessionId,
        callId:row.callId,requestDigest:row.requestDigest,result:cause});});
      const configuration={...options.configuration,walkthrough:{timeoutMs:2000,
        flows:[{id:'value-flow',modules,steps:['Exercise the repaired value'],expected:['Value is 2'],
          kind:'commands',command:[process.execPath,'-e','0']}]}};
      const owner=openFixExecution({...options,configuration},{bridge});
      try{
        const status=await owner.advance({authorized:true});
        assert.equal(status.stage,expected,JSON.stringify(modules));
        // 诊断照常留底，停住不等于把证据弄丢
        assert.equal(status.diagnosis.status,'diagnosed');
      }finally{owner.close();bridge.close();}
    });
});

// 「重名当场拦下」（建运行时检查）原本一刀切：名字被占就永久不能再用，而且没有
// 释放的办法——cancel 只标记状态，证据文件照样留着。这跟 host-handoff 早就定下的
// 规则不一致：那边是「被审查消费过的证据绝不动，其余归档让路」。照同一条规则来。
test('a dead run releases its name by archiving, but a reviewed one keeps it',()=>fixture(async(options)=>{
  const reviews=path.join(options.specsRoot,'.reviews');
  fs.mkdirSync(reviews,{recursive:true,mode:0o700});

  // 半路死掉的运行只留下红灯输出，没有任何审查结论 —— 让路
  const redOutput=path.join(reviews,'fix-demo-a1-red-output.md');
  const leftover='{"stdoutBase64":"","stderrBase64":"ZGVhZCBydW4="}';
  fs.writeFileSync(redOutput,leftover);
  const configuration={...options.configuration,
    redTest:{cwd:options.configuration.reproduction.cwd,testFiles:['red.mjs'],
      command:[process.execPath,'-e','process.stderr.write("BUG");process.exit(1)'],
      expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  openFixExecution({...options,configuration}).close();
  assert.equal(fs.existsSync(redOutput),false,'占位的红灯输出该让开');
  const archived=fs.readdirSync(path.join(reviews,'.superseded'));
  assert.equal(archived.length,1,'让开不等于删掉');
  assert.equal(fs.readFileSync(path.join(reviews,'.superseded',archived[0]),'utf8'),leftover,'原字节要留着');

  // 真做过审查的名字仍然占住：那份结论不许被挪开
  fs.writeFileSync(path.join(reviews,`fix-demo-${identity.taskId}-r1.md`),'verdict: approved');
  assert.throws(()=>openFixExecution({...options,configuration,create:true}),{code:'fix_evidence_name_taken'});
}));
