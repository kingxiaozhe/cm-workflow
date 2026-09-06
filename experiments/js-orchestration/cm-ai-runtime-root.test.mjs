import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const experimentRoot=import.meta.dirname;
const runtimeRoot=path.resolve(experimentRoot,'../../runtime/js/cm-ai');
const promoted=[
  'cm-ai-admission.mjs','cm-ai-context-refresh.mjs','cm-ai-conversation-entry.mjs',
  'cm-ai-learning-handoff-writer.mjs','cm-ai-learning-writer.mjs','cm-ai-qa-log.mjs',
  'cm-ai-run-finalizer.mjs','codex-config.mjs','codex-review-adapter.mjs','contracts.mjs',
  'durable-runner-state.mjs','effect-contract.mjs','execution-store.mjs','gate-bridge.mjs',
  'provider-review-observation.mjs','review-package.mjs','review-runner.mjs',
  'task-commit-codec.mjs','task-commit.mjs','task-owner.mjs','task-runner.mjs','worker-codex.mjs',
];

test('runtime/js/cm-ai is the sole implementation root and old module paths are thin re-exports',async()=>{
  for(const name of promoted){
    const runtimePath=path.join(runtimeRoot,name),compatPath=path.join(experimentRoot,name);
    assert(fs.statSync(runtimePath).isFile(),name);
    assert(!fs.readFileSync(runtimePath,'utf8').includes('experiments/js-orchestration'),name);
    assert.match(fs.readFileSync(compatPath,'utf8'),
      /^\/\/ Compatibility re-export; runtime\/js\/cm-ai is authoritative\.\nexport \* from '\.\.\/\.\.\/runtime\/js\/cm-ai\/.+\.mjs';\n$/);
    const canonical=await import(runtimePath),compat=await import(compatPath);
    assert.deepEqual(Object.keys(compat).sort(),Object.keys(canonical).sort(),name);
    for(const key of Object.keys(canonical))assert.equal(compat[key],canonical[key],`${name}:${key}`);
  }
  assert(fs.statSync(path.join(runtimeRoot,'review-result.schema.json')).isFile());
});

test('public host composes the existing runner and conversation entry without a second control surface',async()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-runtime-root-')));
  try{
    fs.writeFileSync(path.join(temp,'code.js'),'fixture\n');
    fs.writeFileSync(path.join(temp,'requirements.md'),'fixture\n');
    const identity={repositoryId:'fixture',runId:'runtime-root',taskId:'T-001',attempt:1};
    const api=await import(path.join(runtimeRoot,'index.mjs'));
    assert.deepEqual(Object.keys(api).sort(),[
      'codexReviewResultSchemaPath','codexWorker','configFingerprint','createCmAiHost',
      'createCodexReviewRun',
    ]);
    assert.equal(api.codexReviewResultSchemaPath,path.join(runtimeRoot,'review-result.schema.json'));
    const host=api.createCmAiHost({
      runner:{root:temp,identity,scope:['code.js'],requirements:['requirements.md'],
        excludedContexts:['main'],developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',
          run:()=>{throw new Error('must not run');}},reviewers:[],check:()=>[],commit:()=>{}},
      entry:{specsDir:temp,codeProject:temp,feature:'1.fixture',identity},
    });
    assert.deepEqual(Object.keys(host),['handle']);
    const result=await host.handle({version:1,operation:'status',requestId:'status-1',identity});
    assert.equal(result.workflow,'cm-ai');
    assert.equal(result.operation,'status');
    assert.equal(result.state,'pending_review');
    assert.equal(result.pendingAction,'decision');
    assert.throws(()=>api.createCmAiHost({runner:{},entry:{},extra:true}));
    assert.throws(()=>api.createCmAiHost({runner:{},entry:{runner:{}}}));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
