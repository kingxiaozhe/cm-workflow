import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EXECUTION_POLICY_V1,readExecutionPolicy,readBatchExecutionPolicy,freezeBatchExecutionPolicy,readFixExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-policy-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),cwd=path.join(root,'code');fs.mkdirSync(specsDir);fs.mkdirSync(cwd);
  return {root,specsDir,cwd};
}
test('versioned policy rejects incomplete, unknown and altered versions',()=>{
  assert.deepEqual(readExecutionPolicy(EXECUTION_POLICY_V1),EXECUTION_POLICY_V1);
  for(const raw of [{...EXECUTION_POLICY_V1,version:2},{version:1},{...EXECUTION_POLICY_V1,usage:'estimated'},{...EXECUTION_POLICY_V1,unknown:true}])assert.throws(()=>readExecutionPolicy(raw),{code:'execution_policy_invalid'});
});
test('batch policy is opt-in, immutable, binding checked and retained after disabling flag',async t=>{
  const f=fixture(t),batch={repositoryId:'fixture',batchId:'batch-original',specsDir:f.specsDir,codeProject:f.cwd,tasks:[]};
  assert.equal(readBatchExecutionPolicy({batch,started:false}),null);
  const policy=readBatchExecutionPolicy({batch,started:false,enabled:true});await freezeBatchExecutionPolicy(batch,policy);
  const dir=path.join(f.specsDir,'.cm-execution-policy-v1','.reviews','.execution'),run=fs.readdirSync(dir)[0],file=path.join(dir,run,'state.json'),bytes=fs.readFileSync(file);
  assert.deepEqual(readBatchExecutionPolicy({batch,started:true}),EXECUTION_POLICY_V1);
  await freezeBatchExecutionPolicy(batch,policy);assert.deepEqual(fs.readFileSync(file),bytes);
  assert.throws(()=>readBatchExecutionPolicy({batch:{...batch,tasks:['changed']},started:true}),{code:'execution_policy_batch_binding'});assert.deepEqual(fs.readFileSync(file),bytes);
});
test('legacy batch cannot acquire policy after starting and creates no namespace',t=>{
  const f=fixture(t),batch={repositoryId:'fixture',batchId:'batch-original',specsDir:f.specsDir};
  assert.equal(readBatchExecutionPolicy({batch,started:true}),null);
  assert.throws(()=>readBatchExecutionPolicy({batch,started:true,enabled:true}),{code:'execution_policy_legacy_run'});
  assert(!fs.existsSync(path.join(f.specsDir,'.cm-execution-policy-v1')));
});
for(const optimized of [false,true])test(`${optimized?'new':'legacy'} fix policy resumes without mutating original configuration bytes`,t=>{
  const f=fixture(t),config={specsRoot:f.specsDir,identity:{repositoryId:'fixture',runId:'fix-policy',taskId:'T-FIX-policy',attempt:1},
    reproduction:{cwd:f.cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:1000}};
  const policy=readFixExecutionPolicy({config,mode:'create',enabled:optimized});
  const owner=openFixExecution({specsRoot:f.specsDir,identity:config.identity,create:true,configuration:{hostContextId:'original-host',defect:'Fixture',reproduction:config.reproduction,...(policy?{executionPolicy:policy}:{})}});owner.close();
  const file=path.join(f.specsDir,'.reviews','.execution','fix-policy','state.json'),bytes=fs.readFileSync(file);
  assert.deepEqual(readFixExecutionPolicy({config,mode:'resume'}),policy);
  if(!optimized)assert.throws(()=>readFixExecutionPolicy({config,mode:'resume',enabled:true}),{code:'execution_policy_legacy_run'});
  assert.deepEqual(fs.readFileSync(file),bytes);
});

test('batch start log alone prevents retrofitting a legacy execution policy',t=>{
  const f=fixture(t),batch={repositoryId:'fixture',batchId:'batch-log-only',specsDir:f.specsDir};
  const file=path.join(f.specsDir,'运行日志.jsonl'),bytes=JSON.stringify({workflow:'cm-ai',run_id:batch.batchId,event:'decision',phase:'batch_start'})+'\n';fs.writeFileSync(file,bytes);
  assert.throws(()=>readBatchExecutionPolicy({batch,started:false,enabled:true}),{code:'execution_policy_legacy_run'});
  assert.equal(fs.readFileSync(file,'utf8'),bytes);assert(!fs.existsSync(path.join(f.specsDir,'.cm-execution-policy-v1')));
});
