import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {runConfigMaterial} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const identity={repositoryId:'default-qa',runId:'default-qa-run',taskId:'T-001',attempt:1};
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-default-qa-'))),codeProject=path.join(root,'app'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=42;\n');fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [x] T-001: completed fixture\n- [ ] T-002: pending fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const definition={version:1,codeProject,specsDir,feature:'1.work',identity,scope:['target.mjs'],requirements:[]};
  return {definition,execution:(bridge,workflow=null,options={controlPolicy:policy})=>createConversationExecution(definition,'default-qa-author',bridge,null,null,workflow,false,'codex',options)};
}
test('v2 implicit QA assessment preserves exact old material without gaining executor or documentation',t=>{
  const f=fixture(t),execution=f.execution({call:async()=>({confirmed:true})});
  assert.equal(typeof execution.qaDecisionProvider?.decide,'function');assert.equal(execution.qaExecutor,undefined);
  assert.equal(execution.qaLogHome,undefined,'implicit decision preserves original log mirror selection');
  assert.equal(execution.documentationProvider,undefined);assert.equal(execution.documentationSync,undefined);assert.deepEqual(execution.applicableAgentFiles,[]);
  assert(!Object.hasOwn(execution.configuration,'workflow'));const expected={definition:f.definition,execution:execution.configuration,applicableAgentFiles:[]};
  assert.deepEqual(runConfigMaterial(f.definition,execution),expected,'implicit fixed provider must retain old config material exactly');
  const custom={...execution,qaDecisionProvider:{...execution.qaDecisionProvider,timeoutMs:1234}};
  assert.deepEqual(runConfigMaterial(f.definition,custom),{...expected,qaDecisionProvider:'host-v1',qaTimeoutMs:1234},'custom providers cannot opt out of fingerprint binding');
  for(const altered of [
    {...execution,configuration:{...execution.configuration,workflow:{qa:null,documentationPaths:[],applicableAgentFiles:[]}}},
    {...execution,qaExecutor:{timeoutMs:60000,mode:'fixture',caseCount:0}},
    {...execution,configuration:{...execution.configuration,kind:'custom'}},
    {...execution,configuration:{...execution.configuration,controlPolicy:null}},
  ])assert.equal(runConfigMaterial(f.definition,altered).qaDecisionProvider,'host-v1','provider provenance alone cannot hide a configured/custom context');

});
test('legacy absent workflow and explicit v2 workflow keep their original fingerprint contracts',t=>{
  const f=fixture(t),bridge={call:async()=>({confirmed:true})},legacy=f.execution(bridge,null,{});
  assert.equal(legacy.qaDecisionProvider,undefined);assert(!Object.hasOwn(runConfigMaterial(f.definition,legacy),'qaDecisionProvider'));
  const explicit=f.execution(bridge,{qa:null,documentationPaths:[],applicableAgentFiles:[]});
  assert.equal(typeof explicit.qaDecisionProvider.decide,'function');const material=runConfigMaterial(f.definition,explicit);
  assert.equal(material.qaDecisionProvider,'host-v1');assert.equal(material.qaTimeoutMs,60000);assert(material.documentationProvider);
});
for(const failure of [null,'timeout','invalid'])test(`v2 implicit assessment consumes bound package inventory and preserves ${failure??'confirmed-only'} semantics`,async t=>{
  const f=fixture(t),seen=[],execution=f.execution({call:async(kind,request,signal,options)=>{
    seen.push({kind,request,options});assert.equal(kind,'qa_assess');assert.equal(options.timeoutMs,60000);assert.equal(signal.aborted,false);
    if(failure==='timeout')throw Object.assign(Error('synthetic request timeout'),{code:'host_request_timeout'});
    return failure==='invalid'?{confirmed:true,status:'skipped'}:{confirmed:true};
  }});assert.equal(typeof execution.qaDecisionProvider?.decide,'function');
  const binding={...f.definition,packageDigest:'a'.repeat(64),changedFiles:{paths:['target.mjs'],source:'review_package'}};
  const {version,scope,requirements,...request}=binding;
  const promise=execution.qaDecisionProvider.decide(request,new AbortController().signal);
  if(failure)await assert.rejects(promise,{code:failure==='timeout'?'qa_decision_timeout':'invalid_input'});
  else{const result=await promise;assert.equal(result.status,'skipped');assert.equal(result.reason,'no_fixed_trigger');assert.equal(result.packageDigest,request.packageDigest);}
  assert.equal(seen.length,1);assert.deepEqual(seen[0].request.changedFiles,request.changedFiles);assert.deepEqual(seen[0].request.criticalPaths,{});
  assert(!fs.existsSync(path.join(f.definition.specsDir,'运行日志.jsonl')),'provider alone cannot fabricate an owner decision');
});

test('v2 no-workflow parallel members keep their original absent assessment contract',t=>{
  const f=fixture(t),execution=f.execution({call:()=>{throw Error('must not dispatch');}},null,{controlPolicy:policy,parallelMember:true});
  assert.equal(execution.qaDecisionProvider,undefined);
  assert.deepEqual(runConfigMaterial(f.definition,execution),{definition:f.definition,execution:execution.configuration,applicableAgentFiles:[]});
});
