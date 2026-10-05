import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {externalPair,readExternalModels,loadExternalModels,externalModelsPath,externalSettingsRecord,saveExternalModels} from '../runtime/js/cm-ai/external-models.mjs';
import {previewLegacyExternalModels} from '../runtime/js/cm-ai/legacy-model-settings.mjs';
import {commonArgs,configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewArgs,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {main} from './cm-model-setup.mjs';
import {previewLegacyModelRun} from '../runtime/js/cm-ai/legacy-model-run-preview.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const old={schemaVersion:2,presetVersion:'two-tier-v1',choices:{codex:{developer:{model:'fixture-a',effort:'low'},reviewer:{model:'fixture-b',effort:'high'}}}};
test('historical experimental and policy snapshots are read-only, digest-checked and never auto-adopted',()=>{
  const body={schemaVersion:1,kind:'cm-model-preview',executionAvailable:false,activation:{enabled:true,source:'explicit'},
    stages:{developer:{tuple:{provider:'codex',model:'old-dev',effort:'low'},mode:'manual',source:'task'},
      reviewer:{tuple:{provider:'claude',model:'old-review',effort:null},mode:'manual',source:'project'}},limits:{allowedModels:[]}};
  const selection={...body,previewDigest:digest(body)},identity={repositoryId:'fixture',runId:'old-run-1',taskId:'T-001',attempt:1};
  for(const population of ['experimental-model-v1','model-policy-v2']){
    const snapshotBody={...(population==='experimental-model-v1'?{schemaVersion:1,kind:'cm-model-run-snapshot',population}:
      {version:2,kind:'cm-model-policy-snapshot',resolverVersion:'model-policy-resolver-v1'}),
      locked:true,definition:{version:2,population,identity},selection};
    const raw={...snapshotBody,snapshotDigest:digest(snapshotBody)},before=JSON.stringify(raw),preview=previewLegacyModelRun(raw);
    assert(preview.readOnly);assert.equal(preview.stages.reviewer.model,'old-review');assert.equal(preview.providerConfirmed,false);
    assert.match(preview.resume,/original executor/);assert.equal(JSON.stringify(raw),before);
    assert.throws(()=>previewLegacyModelRun({...raw,locked:false}));
    const corrupt=structuredClone(raw);corrupt.selection.stages.developer.tuple.model='changed';assert.throws(()=>previewLegacyModelRun(corrupt));
  }
});
async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-external-settings-'))),prior=process.env.CM_WORKFLOW_HOME;
  process.env.CM_WORKFLOW_HOME=root;
  try{await fn(root);}finally{if(prior===undefined)delete process.env.CM_WORKFLOW_HOME;else process.env.CM_WORKFLOW_HOME=prior;fs.rmSync(root,{recursive:true,force:true});}
}
test('only one pair per provider; no role/default model/catalog and unsupported effort cannot disappear',()=>{
  assert.deepEqual(externalPair('codex',{model:'fixture'}),{model:'fixture',effort:'high'});
  assert.deepEqual(externalPair('claude',{model:'fixture'}),{model:'fixture',effort:null});
  for(const raw of [{schemaVersion:1,providers:{codex:{developer:{model:'a'},reviewer:{model:'b'}}}},
    {schemaVersion:1,providers:{codex:{model:'current-session'}}},
    {schemaVersion:1,providers:{codex:{model:'a',effort:'max'}}},
    {schemaVersion:1,providers:{claude:{model:'a',effort:'minimal'}}},
    {schemaVersion:1,providers:{codex:{effort:'high'}}}])assert.throws(()=>readExternalModels(raw));
  const options={cwd:'/tmp',model:'fixture'};
  assert(commonArgs({...options,effort:'low'}).includes('model_reasoning_effort="low"'));
  assert.notEqual(configFingerprint(options),configFingerprint({...options,effort:'low'}));
  assert(!claudeReviewArgs('fixture').includes('--effort'));
  assert(claudeReviewArgs('fixture','max').includes('--effort'));
  assert.notEqual(claudeReviewFingerprint(options),claudeReviewFingerprint({...options,effort:'max'}));
});
test('provider-only setup preserves other provider and refuses all removed six-role/catalog commands',()=>fixture(async root=>{
  const output=new PassThrough(),error=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);
  const call=argv=>main(argv,{input:new PassThrough(),output,error});
  assert.throws(()=>loadExternalModels(),{code:'external_model_setup_required'});
  assert.equal(await call(['configure','--provider','codex','--model','fixture-a','--effort','low','--yes']),0);
  assert.equal(await call(['configure','--provider','claude','--model','fixture-b','--yes']),0);
  const before=fs.readFileSync(externalModelsPath());
  assert.deepEqual(loadExternalModels(),{schemaVersion:1,providers:{codex:{model:'fixture-a',effort:'low'},claude:{model:'fixture-b',effort:null}}});
  for(const argv of [['refresh-codex'],['list'],['install'],['configure','--provider','codex','--purpose','reviewer','--model','other','--yes']])assert.equal(await call(argv),1);
  assert.deepEqual(fs.readFileSync(externalModelsPath()),before);
  assert(!fs.existsSync(path.join(root,'model-picker-catalog-v1.json')));assert(!text.includes('gpt-6'));
}));
test('CAS and cancellation keep exact bytes, including concurrent formatting-only changes',()=>fixture(async()=>{
  const value={schemaVersion:1,providers:{codex:{model:'a',effort:'high'}}};saveExternalModels(value,{expectedSha256:null});
  const prior=externalSettingsRecord(),file=externalModelsPath(),before=fs.readFileSync(file);
  const input=new PassThrough(),output=new PassThrough(),error=new PassThrough();input.isTTY=true;output.isTTY=true;
  const pending=main(['configure','--provider','codex','--model','b'],{input,output,error});
  input.write('n\n');assert.equal(await pending,0);assert.deepEqual(fs.readFileSync(file),before);
  fs.writeFileSync(file,JSON.stringify(value)+'\n');const changed=fs.readFileSync(file);
  assert.throws(()=>saveExternalModels({...value,providers:{codex:{model:'b'}}},{expectedSha256:prior.sha256}),{code:'model_configuration_changed'});
  assert.deepEqual(fs.readFileSync(file),changed);
}));
test('legacy partial defaults and effective task/project/global stages are compared, without migration',()=>fixture(async root=>{
  const preview=previewLegacyExternalModels({settings:old});assert(preview.codex.conflict);assert.equal(preview.codex.pair,null);
  const project={schemaVersion:1,stages:{reviewer:{mode:'manual',provider:'codex',model:'fixture-a',effort:'low'}}};
  const withAnalysis={schemaVersion:1,stages:{...project.stages,test_analysis:{mode:'manual',provider:'claude',model:'analysis-fixture',effort:'low'}}};
  assert.deepEqual(previewLegacyExternalModels({settings:old,project:withAnalysis}),previewLegacyExternalModels({settings:old,project}));
  assert.throws(()=>previewLegacyExternalModels({settings:old,project:{schemaVersion:1,stages:{analysis:{mode:'recommended'}}}}),{code:'legacy_stage_invalid'});
  const equal=previewLegacyExternalModels({settings:old,project});assert(!equal.codex.conflict);assert.deepEqual(equal.codex.pair,{model:'fixture-a',effort:'low'});
  const task={schemaVersion:1,stages:{reviewer:{mode:'manual',provider:'codex',model:'fixture-b',effort:'high'}}};
  assert(previewLegacyExternalModels({settings:old,project,task}).codex.conflict);
  const oldFile=path.join(root,'model-defaults-v2.json');fs.writeFileSync(oldFile,JSON.stringify(old));const bytes=fs.readFileSync(oldFile);
  const io={input:new PassThrough(),output:new PassThrough(),error:new PassThrough()};
  assert.equal(await main(['adopt-legacy','--provider','codex','--input',oldFile,'--yes'],io),1);assert(!fs.existsSync(externalModelsPath()));assert.deepEqual(fs.readFileSync(oldFile),bytes);
  const sparse={schemaVersion:2,presetVersion:'two-tier-v1',choices:{codex:{developer:{effort:'high'}}}};
  fs.writeFileSync(oldFile,JSON.stringify(sparse));const sparseBytes=fs.readFileSync(oldFile);
  assert.equal(await main(['adopt-legacy','--provider','codex','--input',oldFile,'--yes'],io),0);
  assert.deepEqual(fs.readFileSync(oldFile),sparseBytes);assert.equal(loadExternalModels().providers.codex.model,'gpt-6.1-sol');
}));
