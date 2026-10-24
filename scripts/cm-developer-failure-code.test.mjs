import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createDeveloperRun} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {terminalFor,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';

// A developer call that ends without a result keeps the worker's own code in the
// run archive (timeout, missing_init...); before, only "unknown" survived.
async function fixture(response,fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-failure-code-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'a.js'),'base\n');
  const identity={repositoryId:'failure-code-fixture',runId:'failure-code-run',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.js'],requirements:[]};
  const adapter=createDeveloperRun({provider:'claude',requestedModel:'fixture',worker:async()=>response()});
  const execution={configuration:{kind:'failure-code-fixture-v1'},timeoutMs:3000,excludedContexts:['host'],applicableAgentFiles:[],qaLogHome:path.join(root,'logs'),
    developer:{provider:'claude',requestedModel:'fixture',contextId:'author',run:(r,c)=>adapter(r,c)},
    check:()=>assert.fail('no checks after a failed develop'),
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
      allowed:true,available:true,contexts:['review-1','review-2'],run:()=>assert.fail('no review')}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host']}};
  const statePath=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  let run;
  try{
    run=await openControlRun(definition,'create',execution);
    const status=await run.host.handle({version:1,operation:'start',requestId:'start',identity});
    await fn({status,call:JSON.parse(fs.readFileSync(statePath,'utf8')).records.at(-1).payload.checkpoint.calls.at(-1)});
  }finally{run?.close();fs.rmSync(root,{recursive:true,force:true});}
}

test('an unknown or failed developer call keeps the worker code in the archive',async()=>{
  for(const [response,terminal] of [[{status:'unknown',code:'missing_init'},'unknown'],[{status:'failed',code:'provider_failed'},'failed']]){
    await fixture(()=>response,async({call})=>{
      assert.equal(call.terminal,terminal);assert.equal(call.failureCode,response.code);
    });
  }
  // A thrown worker error keeps its code too; a code that is not a plain identifier is dropped, never stored.
  await fixture(()=>{throw Object.assign(new Error('x'),{code:'timeout'});},async({call})=>{
    assert.equal(call.terminal,'unknown');assert.equal(call.failureCode,'timeout');});
  await fixture(()=>({status:'unknown',code:'Bad Code!'}),async({call})=>{
    assert.equal(call.terminal,'unknown');assert.equal(Object.hasOwn(call,'failureCode'),false);});
});

test('failureCode is only valid on a developer failed/unknown terminal without a result',()=>{
  const request=role=>requestFor({invocationId:'s.1',identity:{repositoryId:'r',runId:'u',taskId:'T-001',attempt:1},
    role,provider:'claude',requestedModel:'fixture',contextId:'author',payload:{}});
  const base={version:1,invocationId:'s.1',contextId:'author',provider:'claude',effectiveModel:'unknown',accepted:true,result:null};
  assert.equal(terminalFor({...base,status:'unknown',failureCode:'missing_init'},request('developer')).failureCode,'missing_init');
  for(const [value,role] of [[{...base,status:'unknown',failureCode:'missing_init'},'reviewer'],
    [{...base,status:'succeeded',result:{outcome:'implemented'},failureCode:'x'},'developer'],
    [{...base,status:'failed',blockedReason:'why',failureCode:'x'},'developer'],
    [{...base,status:'unknown',failureCode:'Bad'},'developer']])
    assert.throws(()=>terminalFor(value,request(role)));
});
