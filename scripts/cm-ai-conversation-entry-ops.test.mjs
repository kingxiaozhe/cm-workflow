import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {recordCmAiQaDecision} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'fixture',runId:'conversation-ops',taskId:'T-001',attempt:1};
const packageDigest='8'.repeat(64);
const operation=(name,requestId=name)=>({version:1,operation:name,requestId,identity,packageDigest,testRunId:null});

async function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-conversation-ops-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.login';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: finished\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  fs.writeFileSync(path.join(codeProject,'README.md'),'existing project\n');
  let current={state:'ready',code:null,identity,packageDigest},effects=0;
  const runner={status:()=>current,executeEffect:async()=>{effects++;throw Error('unexpected runner effect');},
    cancel:()=>current,run:async()=>current};
  const entry=extra=>createCmAiConversationEntry({specsDir,codeProject,feature,identity,runner,
    applicableAgentFiles:[],...extra});
  const complete=()=>{current={...current,state:'fixture_completed'};};
  const seedQa=()=>recordCmAiQaDecision({specsDir,codeProject,feature,identity,packageDigest,
    logHome:path.join(root,'logs'),decision:{decisionId:'qa-skipped',identity,packageDigest,
      status:'skipped',reason:'fixture',score:4,at:'2026-09-04T15:10:00-07:00'}});
  try{return await run({root,specsDir,codeProject,entry,complete,seedQa,effects:()=>effects});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('context_refresh requires a completed task and returns its bound context summary',()=>fixture(async f=>{
  const request=operation('context_refresh');
  assert.equal((await f.entry().handle(request)).code,'context_not_ready');
  f.complete();f.seedQa();
  const result=await f.entry().handle(request);
  assert.deepEqual(result,{version:1,workflow:'cm-ai',operation:'context_refresh',requestDigest:digest(request),
    identity,outcome:'refreshed',state:'fixture_completed',code:'context_complete',packageDigest,
    pendingAction:'finish',nextTask:null,contextDigest:result.contextDigest,contextFiles:result.contextFiles});
  assert.match(result.contextDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.contextFiles.map(file=>file.path),[
    '1.login/design.md','1.login/requirements.md','1.login/tasks.md']);
  assert.equal(f.effects(),0);
}));

test('run_finalize requires documentation sync and returns the final outcome without runner effects',()=>fixture(async f=>{
  f.complete();f.seedQa();
  const refresh=await f.entry().handle(operation('context_refresh'));
  const request=operation('run_finalize');
  assert.equal((await f.entry().handle(request)).code,'run_not_ready');
  const documentationResult={syncId:'docs-completed',identity,packageDigest,contextDigest:refresh.contextDigest,
    status:'completed',reason:'documentation synced',at:'2026-09-04T15:20:00-07:00'};
  const result=await f.entry({documentationResult,qaLogHome:path.join(f.root,'logs')}).handle(request);
  assert.deepEqual(result,{version:1,workflow:'cm-ai',operation:'run_finalize',requestDigest:digest(request),
    identity,outcome:'finalized',state:'run_done',code:'run_done',packageDigest,pendingAction:'none',
    contextDigest:refresh.contextDigest,deduplicated:false,degraded:false});
  assert.equal(f.effects(),0);
}));
