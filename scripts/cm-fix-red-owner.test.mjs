import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {redTestFiles} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixLearningPreparation} from '../runtime/js/cm-fix/learning.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-red-owner-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  const identity={repositoryId:'fixture',runId:'red-owner',taskId:'T-FIX-demo',attempt:1};
  fs.writeFileSync(path.join(cwd,'regression.mjs'),"import fs from 'node:fs';fs.appendFileSync('calls','1');console.error('EXPECTED BUG');process.exit(1)");
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Synthetic bug',
    reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['regression.mjs'],command:[process.execPath,'regression.mjs'],expectedFailure:{exitCode:1,outputIncludes:'EXPECTED BUG'},timeoutMs:2000}}};
  const bridge={call:async()=>({status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['regression.mjs'],
    plan:'Fix constant',crossLayer:false,affectedModules:['one']})};
  try{await fn(options,bridge,cwd);}finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('red owner persists real execution and verifies restored evidence without re-running',()=>fixture(async(options,bridge,cwd)=>{
  let owner=openFixExecution(options,{bridge});
  try{
    await owner.advance({authorized:true});
    await assert.rejects(owner.runRedTest(),{code:'red_test_authorization_required'});
    assert.equal(fs.existsSync(path.join(cwd,'calls')),false);
    assert.equal((await owner.runRedTest({authorized:true})).stage,'baseline_required');
    const saved=owner.status().redTest;assert.equal(owner.status().completionEligible,false);owner.close();
    owner=openFixExecution({...options,create:false});
    assert.equal((await owner.runRedTest({authorized:true})).stage,'baseline_required');
    assert.equal(fs.readFileSync(path.join(cwd,'calls'),'utf8'),'1');
    const output=path.join(options.specsRoot,saved.output.path),bytes=fs.readFileSync(output);
    fs.unlinkSync(output);assert.equal(owner.status().stage,'red_test_evidence_required');
    assert.equal((await owner.runRedTest({authorized:true})).stage,'red_test_evidence_required');
    fs.writeFileSync(output,bytes,{mode:0o600});assert.equal(owner.status().stage,'baseline_required');
    fs.chmodSync(output,0o644);assert.equal(owner.status().stage,'red_test_evidence_required');fs.chmodSync(output,0o600);
    fs.writeFileSync(output,'tampered');assert.equal(owner.status().stage,'red_test_evidence_required');fs.writeFileSync(output,bytes);
    const source=fs.readFileSync(path.join(cwd,'regression.mjs'));fs.appendFileSync(path.join(cwd,'regression.mjs'),'\n// drift');
    assert.equal(owner.status().stage,'red_test_evidence_required');assert.deepEqual(owner.status().redTest,saved);
    fs.writeFileSync(path.join(cwd,'regression.mjs'),source);assert.equal(owner.status().stage,'baseline_required');
    assert.equal(fs.readFileSync(path.join(cwd,'calls'),'utf8'),'1');
  }finally{owner.close();}
}));

test('red intent without result reopens unknown and never executes again',()=>fixture(async(options,bridge,cwd)=>{
  let owner=openFixExecution(options,{bridge});await owner.advance({authorized:true});owner.close();
  const state=JSON.parse(fs.readFileSync(path.join(options.specsRoot,'.reviews','.execution',options.identity.runId,'state.json')));
  const store=openExecutionStore({specsRoot:options.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
  store.append({id:'fix-red-test-intent',kind:'intent',payload:{testFiles:redTestFiles(options.configuration.redTest)},expectedRevision:store.snapshot().revision});store.close();
  owner=openFixExecution({...options,create:false});
  try{
    assert.equal((await owner.runRedTest({authorized:true})).stage,'unknown');assert.equal(owner.status().pending,'red_test');
    assert.equal(fs.existsSync(path.join(cwd,'calls')),false);
  }finally{owner.close();}
}));

test('green and unrelated failure never advance red owner to baseline',async()=>{
  for(const command of [[process.execPath,'-e',"console.log('ok')"],[process.execPath,'-e',"console.error('other');process.exit(1)"]]){
    await fixture(async(options,bridge)=>{
      options.configuration.redTest.command=command;const owner=openFixExecution(options,{bridge});
      try{await owner.advance({authorized:true});assert.equal((await owner.runRedTest({authorized:true})).stage,'red_test_not_confirmed');}
      finally{owner.close();}
    });
  }
});

test('red Learning timeout is explicit, cancellation stays cancelled, neither registers or runs',async()=>{
  for(const mode of ['timeout','cancel'])await fixture(async(options,bridge,cwd)=>{
    options.configuration.redTest.timeoutMs=100;
    const learningBridge=createHostToolBridge();let answer=true,requestSeen;
    const pending=new Promise(resolve=>{requestSeen=resolve;});
    learningBridge.attach(row=>{
      if(row.type!=='host_request')return;
      if(!answer){requestSeen();return;}
      learningBridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,
        result:{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'No relevant lesson'}});
    });
    let owner=openFixExecution(options,{bridge,prepare:createFixLearningPreparation({bridge:learningBridge,codeProject:cwd})});
    try{
      await owner.advance({authorized:true});answer=false;
      const running=owner.runRedTest({authorized:true});await pending;
      if(mode==='cancel'){
        owner.cancel();assert.equal((await running).stage,'cancelled');
      }else await assert.rejects(running,{code:'fix_learning_interrupted'});
      assert.equal(fs.existsSync(path.join(cwd,'calls')),false);
      owner.close();owner=openFixExecution({...options,create:false});
      assert.equal(owner.status().stage,mode==='cancel'?'cancelled':'red_test_required');
      assert.equal(owner.status().pending,null);
    }finally{owner.close();learningBridge.close();}
  });
});

function addBaseline(options,cwd,missing=false){
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import fs from 'node:fs';fs.appendFileSync('baseline-calls',process.argv[2]);process.exit(Number(process.argv[2]))");
  options.configuration.baseline={cwd,testFiles:['existing.mjs'],timeoutMs:2000,commands:[
    {id:'existing-failure',command:missing?['/nonexistent/cm-fixture']:[process.execPath,'existing.mjs','1']},
    {id:'existing-pass',command:[process.execPath,'existing.mjs','0']}]};
}

test('baseline records existing failure and later passing suite, persists without rerun and checks drift',()=>fixture(async(options,bridge,cwd)=>{
  addBaseline(options,cwd);let owner=openFixExecution(options,{bridge});
  try{
    assert.equal((await owner.captureBaseline({authorized:true})).stage,'reproduce');
    await owner.advance({authorized:true});await owner.runRedTest({authorized:true});
    await assert.rejects(owner.captureBaseline(),{code:'baseline_authorization_required'});
    assert.equal(fs.existsSync(path.join(cwd,'baseline-calls')),false);
    assert.equal((await owner.captureBaseline({authorized:true})).stage,'repair_required');
    const baseline=owner.status().baseline;
    assert.deepEqual(baseline.observations.map(row=>row.outcome),['failed','passed']);
    assert.equal(owner.status().completionEligible,false);owner.close();
    owner=openFixExecution({...options,create:false});
    assert.equal((await owner.captureBaseline({authorized:true})).stage,'repair_required');
    assert.equal(fs.readFileSync(path.join(cwd,'baseline-calls'),'utf8'),'10');
    fs.appendFileSync(path.join(cwd,'existing.mjs'),'\n// drift');
    assert.equal(owner.status().stage,'baseline_evidence_required');assert.deepEqual(owner.status().baseline,baseline);
  }finally{owner.close();}
}));

test('baseline unavailable blocks, and interrupted registered baseline never redispatches',async()=>{
  for(const mode of ['missing','intent'])await fixture(async(options,bridge,cwd)=>{
    addBaseline(options,cwd,mode==='missing');let owner=openFixExecution(options,{bridge});
    await owner.advance({authorized:true});await owner.runRedTest({authorized:true});
    if(mode==='missing'){
      const state=await owner.captureBaseline({authorized:true});assert.equal(state.stage,'baseline_blocked');
      assert.equal(state.baseline.observations.length,1);owner.close();
    }else{
      const redDigest=digest(owner.status().redTest);owner.close();
      const state=JSON.parse(fs.readFileSync(path.join(options.specsRoot,'.reviews','.execution',options.identity.runId,'state.json')));
      const store=openExecutionStore({specsRoot:options.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
      store.append({id:'fix-baseline-intent',kind:'intent',payload:{testFiles:redTestFiles(options.configuration.baseline),redDigest},expectedRevision:store.snapshot().revision});store.close();
    }
    owner=openFixExecution({...options,create:false});
    try{
      assert.equal((await owner.captureBaseline({authorized:true})).stage,mode==='missing'?'baseline_blocked':'unknown');
      assert.equal(fs.existsSync(path.join(cwd,'baseline-calls')),false);
    }finally{owner.close();}
  });
});
