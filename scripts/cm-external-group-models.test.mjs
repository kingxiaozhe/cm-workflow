import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readBatchExternalModels,freezeBatchExternalModels,batchModelsFile,readFixExternalModels} from '../runtime/js/cm-ai/external-group-models.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const models={schemaVersion:1,providers:{codex:{model:'fake-codex',effort:'low'},claude:{model:'fake-claude',effort:null}}};
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-external-groups-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');fs.mkdirSync(specsDir);fs.mkdirSync(codeProject);const inputFile=path.join(root,'models.json');fs.writeFileSync(inputFile,JSON.stringify(models));return {root,specsDir,codeProject,inputFile};}
test('batch freezes all selected providers before later members, ignores defaults and binds original plan',t=>{
  const f=fixture(t),batch={batchId:'fake-batch',repositoryId:'fixture',specsDir:f.specsDir,codeProject:f.codeProject,tasks:['a','b']};
  const selected=readBatchExternalModels({batch,started:false,enabled:true,inputFile:f.inputFile,providers:['codex','claude']});
  freezeBatchExternalModels(batch,selected);assert(fs.existsSync(batchModelsFile(batch)));
  fs.writeFileSync(f.inputFile,'bad changed defaults');
  assert.deepEqual(readBatchExternalModels({batch,started:true,providers:['codex']}),models);
  freezeBatchExternalModels(batch,selected);
  assert.throws(()=>readBatchExternalModels({batch:{...batch,tasks:['a','c']},started:true,providers:['codex']}),{code:'external_model_batch_binding'});
  assert.throws(()=>readBatchExternalModels({batch,started:true,inputFile:f.inputFile,providers:['codex']}),{code:'external_model_resume_selection_forbidden'});
});
test('old batch remains legacy and cannot adopt new selections',t=>{
  const f=fixture(t),batch={batchId:'legacy-batch',specsDir:f.specsDir};
  assert.equal(readBatchExternalModels({batch,started:true,providers:['codex']}),null);
  assert.throws(()=>readBatchExternalModels({batch,started:true,enabled:true,providers:['codex']}),{code:'external_model_resume_selection_forbidden'});
  assert.throws(()=>readBatchExternalModels({batch,started:false,inputFile:f.inputFile,providers:['codex']}),{code:'external_model_feature_required'});
});
for(const runtime of ['codex','claude'])test(`${runtime} fix cause and final adapters share exact frozen pair and preflight`,async t=>{
  const f=fixture(t),pair=models.providers[runtime],review={...pair,disabledSkills:[],timeoutMs:100,preflight:{passed:true,prompt_transport:'stdin',cli_model:pair.model,...(runtime==='claude'?{provider:'claude'}:{}),config_fingerprint:(runtime==='claude'?claudeReviewFingerprint:configFingerprint)({cwd:f.codeProject,...pair})}};
  const sent=[],host=createFixReviewHost({codeProject:f.codeProject,hostContextId:'fake-host',runtime,review,externalModels:models,permissions:['--allow-cause-review','--allow-final-review'],workerFactory:options=>{sent.push(options);return async()=>({status:'failed',code:'fake-stop'});}});
  assert.equal(host.reviewer.requestedModel,pair.model);
  assert.throws(()=>createFixReviewHost({codeProject:f.codeProject,hostContextId:'fake-host',runtime,review:{...review,effort:runtime==='claude'?'low':'high'},externalModels:models}),{code:'external_model_pair_conflict'});
  // Worker creation is lazy; no subprocess or paid provider is called.
  assert.equal(sent.length,0);
  const first=createFixReviewHost({codeProject:f.codeProject,hostContextId:'fake-host',runtime,review:{...review,preflight:{...review.preflight,config_fingerprint:'0'.repeat(64)}},externalModels:models});
  assert.throws(()=>first.execution.assertReviewReady(),{code:'tool_preflight_missing'});
});
test('fix native snapshot resumes its pair without loading changed defaults; legacy cannot be migrated',t=>{
  const f=fixture(t),identity={repositoryId:'fixture',runId:'fix-frozen'},config={specsRoot:f.specsDir,identity,reproduction:{cwd:f.codeProject}};
  const hash=digest('fixture'),store=openExecutionStore({specsRoot:f.specsDir,identity,create:true,fingerprints:{workflow:hash,config:hash,inputs:hash}});
  store.append({id:'fix-configuration',kind:'result',payload:{configuration:{externalModels:models}},expectedRevision:store.snapshot().revision});store.close();
  assert.deepEqual(readFixExternalModels({config,mode:'resume'}),models);
  assert.throws(()=>readFixExternalModels({config,mode:'resume',inputFile:f.inputFile}),{code:'external_model_resume_selection_forbidden'});
  const old={...identity,runId:'fix-legacy'},legacy=openExecutionStore({specsRoot:f.specsDir,identity:old,create:true,fingerprints:{workflow:hash,config:hash,inputs:hash}});
  legacy.append({id:'fix-configuration',kind:'result',payload:{configuration:{}},expectedRevision:legacy.snapshot().revision});legacy.close();
  assert.equal(readFixExternalModels({config:{...config,identity:old},mode:'resume'}),null);
  assert.throws(()=>readFixExternalModels({config:{...config,identity:old},mode:'resume',enabled:true}),{code:'external_model_resume_selection_forbidden'});
});

test('batch protected configuration keeps Claude review routing when development stays in current session',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\nruntimes:\n  available: both\n');
  const {createConversationExecution}=await import('../runtime/js/cm-ai/host-conversation-execution.mjs');
  const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:'1.work',identity:{repositoryId:'fixture',runId:'dual-current-session',taskId:'T-001',attempt:1},scope:['target.mjs'],requirements:['requirements.md']};
  const pair=models.providers.claude,review={...pair,disabledSkills:[],preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd:f.codeProject,...pair})}};
  const execution=createConversationExecution(definition,'fixture-host',{call(){assert.fail('read-only factory must not dispatch');}},review,null,null,false,'codex',{externalModels:models,reviewerRuntime:'claude',protection:{checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],timeoutMs:1000}});
  assert.equal(execution.developer.requestedModel,'current-session');assert.equal(execution.reviewers[0].provider,'claude');assert.equal(execution.reviewers[0].requestedModel,'fake-claude');
  assert.throws(()=>createConversationExecution(definition,'fixture-host',{},review,null,null,false,'codex',{reviewerRuntime:'claude'}),{code:'runtime_selection_mismatch'});
});
