import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
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
