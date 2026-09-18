import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createDeveloperRun} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {digest,terminalFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {invalidDeveloperCall,readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const reason='等待接口授权\n\tPeer implementation is unavailable';
async function fixture(value,provider,fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-blocked-reason-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'a.js'),'base\n');
  const identity={repositoryId:'blocked-fixture',runId:'blocked-run',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.js'],requirements:[]};
  let dispatched=0,terminal,request,run;
  const adapter=createDeveloperRun({provider,requestedModel:'fixture',worker:async()=>{
    dispatched++;return {status:'succeeded',value};
  }});
  const execution={configuration:{kind:'blocked-fixture-v1'},timeoutMs:3000,excludedContexts:['host'],
    hostDecision:{status:'approved'},applicableAgentFiles:[],qaLogHome:path.join(root,'logs'),
    developer:{provider,requestedModel:'fixture',contextId:'author',run:async(r,c)=>{
      request=r;terminal=await adapter(r,c);return terminal;
    }},
    check:()=>assert.fail('blocked must not run checks'),
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
      allowed:true,available:true,contexts:['review-1','review-2'],run:()=>assert.fail('blocked must not run review')}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host'],authorize:()=>assert.fail('blocked must not authorize review')},
  };
  const statePath=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  const read=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
  const handle=operation=>run.host.handle({version:1,operation,requestId:operation,identity});
  const close=()=>{run?.close();run=null;};
  const open=async(mode='resume')=>{close();run=await openControlRun(definition,mode,execution);assert(!run.blocked);return run;};
  try{
    await open('create');const status=await handle('start');
    await fn({status,terminal,request,read,handle,open,close,statePath,dispatched:()=>dispatched});
  }finally{close();fs.rmSync(root,{recursive:true,force:true});}
}

test('blocked reason preserves terminal, call digest and entry blocked/failed with or without reason',async()=>{
  for(const provider of ['codex','claude'])for(const value of [{outcome:'blocked',reason},{outcome:'blocked'}]){
    await fixture(value,provider,async f=>{
      assert.equal(f.terminal.status,'failed');assert.equal(f.terminal.accepted,true);assert.equal(f.terminal.result,null);
      assert.deepEqual([f.status.state,f.status.code],['blocked','failed']);
      const call=f.read().records.at(-1).payload.checkpoint.calls.at(-1);
      assert.equal(call.blockedReason,value.reason);assert.equal(f.terminal.blockedReason,value.reason);
      assert.equal(Object.hasOwn(call,'blockedReason'),Object.hasOwn(value,'reason'));
      assert.equal(Object.hasOwn(f.terminal,'blockedReason'),Object.hasOwn(value,'reason'));
      assert.equal(call.resultDigest,digest(null));assert(!Object.hasOwn(call,'failureResult'));
      assert.equal(invalidDeveloperCall(call),false);
      await f.handle('resume');assert.equal(f.dispatched(),1);
      const base={...f.terminal,blockedReason:reason};
      for(const invalid of ['', ' \n\t',null,1,'x'.repeat(1001),'界'.repeat(334),
        ...Array.from({length:32},(_,i)=>i).filter(i=>i!==9&&i!==10).map(i=>'text'+String.fromCharCode(i))])
        assert.throws(()=>terminalFor({...base,blockedReason:invalid},f.request));
      for(const valid of ['x'.repeat(1000),'界'.repeat(333)+'x','  reason\n\t'])
        assert.equal(terminalFor({...base,blockedReason:valid},f.request).blockedReason,valid);
      for(const status of ['succeeded','unknown','cancelled','unavailable','auth_required','permission_denied'])
        assert.throws(()=>terminalFor({...base,status,result:status==='succeeded'?{outcome:'implemented'}:null,
          accepted:!['unavailable','auth_required','permission_denied'].includes(status)},f.request));
      assert.throws(()=>terminalFor(base,{...f.request,role:'reviewer'}));
      assert.throws(()=>terminalFor({...base,result:{code:'invalid_result',reason:'invalid_input'}},f.request));
    });
  }
});

test('blocked reason survives reopen, legacy absence replays and changed reason bytes fail the record chain',async()=>{
  for(const value of [{outcome:'blocked',reason},{outcome:'blocked'}])await fixture(value,'codex',async f=>{
    const original=f.read();await f.open();
    const status=await f.handle('status');assert.deepEqual([status.state,status.code],['blocked','failed']);
    assert.deepEqual(f.read(),original);assert.equal(f.dispatched(),1);
    const checkpoint=original.records.at(-1).payload.checkpoint;
    assert.equal(checkpoint.calls.at(-1).blockedReason,value.reason);
    const replay=readRunnerHistory(original.records,original.records[0].payload.config,3);
    assert.equal(replay.state.calls.at(-1).blockedReason,value.reason);
    if(!Object.hasOwn(value,'reason'))return;
    // Recompute the outer checksum only: rejection must come from the existing record chain.
    f.close();const tampered=structuredClone(original);
    tampered.records.at(-1).payload.checkpoint.calls.at(-1).blockedReason+='!';
    const {revision,...body}=tampered;
    fs.writeFileSync(f.statePath,JSON.stringify({...body,revision:digest(body)}));
    await assert.rejects(f.open(),{code:'store_corrupt'});
    // Even with valid record hashes, replay still enforces the optional field's grammar.
    for(const mutate of [call=>{call.blockedReason=' ';},call=>{call.blockedReason='bad\rtext';},
      call=>{call.blockedReason='界'.repeat(334);},call=>{call.blockedReason=null;},
      call=>{call.terminal='unknown';},call=>{call.failureResult={code:'invalid_result',reason:'invalid_input'};
        call.resultDigest=digest(call.failureResult);},call=>{call.resultDigest=digest(reason);}]){
      const records=structuredClone(original.records);mutate(records.at(-1).payload.checkpoint.calls.at(-1));
      for(let i=0;i<records.length;i++){
        const {digest:checksum,...record}=records[i];record.previousDigest=i?records[i-1].digest:null;
        records[i]={...record,digest:digest(record)};
      }
      assert.throws(()=>readRunnerHistory(records,records[0].payload.config,3));
    }
  });
});
