// Launch-time browser capability gate. The host cannot probe whether the
// launching session can drive a browser; these tests cover the declaration
// contract only, not any detection claim.
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {loadConfig} from './cm-workflow-config.mjs';

const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-capability-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));

const batchCli=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const identity={repositoryId:'gate','runId':'gate-run',taskId:'T-001',attempt:1};

function fixture(browserCase,{blocking=true,tests=['logic','commands','browser']}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-capability-gate-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'- [AC-001]: fixture\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{tests}}));
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:[{id:'TC-001',kind:browserCase?'browser':'logic',blocking,origin:'user',acIds:['AC-001'],taskIds:['T-001'],
      title:'Synthetic',preconditions:[],steps:['Observe fixture'],expected:['Fixture works'],cleanup:[]}]}));
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),
    JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const config=path.join(root,'run.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,
    scope:['target.mjs'],requirements:['requirements.md']}));
  const workflow=path.join(root,'workflow.json');
  fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],
    qa:{commands:[{id:'unit',command:[process.execPath,'--version'],caseIds:browserCase?[]:['TC-001']}],
      environment:{kind:'web',carrier:'browser',target:'https://example.invalid/fixture',scope:'local'}}}));
  return {root,specsDir,codeProject,config,workflow,
    args:['serve','--config',config,'--mode','create','--host-context','gate-fixture','--allow-development',
      '--workflow-config',workflow,'--allow-qa']};
}

const launch=(f,...extra)=>spawnSync(process.execPath,[cli,...f.args,...extra],{encoding:'utf8',timeout:20000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
function rejected(result,code){
  assert.equal(result.error,undefined);assert.equal(result.status,1,result.stderr);
  assert.deepEqual(JSON.parse(result.stderr),{error:{code}});
}
function started(f,...extra){
  const result=launch(f,...extra);
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  const runDir=path.join(f.specsDir,'.reviews','.execution',identity.runId);
  assert(fs.statSync(path.join(runDir,'writer.sqlite')).isFile());
  const state=JSON.parse(fs.readFileSync(path.join(runDir,'state.json'),'utf8'));
  assert.equal(state.version,1);assert.deepEqual(state.identity,{repositoryId:identity.repositoryId,runId:identity.runId});
  return state;
}

test('the browser gate fires exactly when the approved contract can select a browser case',()=>{
  const withBrowser=fixture(true);
  try{
    rejected(launch(withBrowser),'browser_capability_required');
    rejected(launch(withBrowser,'--browser-qa','unavailable'),'browser_capability_unavailable');
    rejected(launch(withBrowser,'--browser-qa','sometimes'),'invalid_arguments');
    started(withBrowser,'--browser-qa','available');
  }finally{fs.rmSync(withBrowser.root,{recursive:true,force:true});}
  const withoutBrowser=fixture(false);
  try{
    rejected(launch(withoutBrowser,'--browser-qa','available'),'invalid_arguments');
    started(withoutBrowser);
  }finally{fs.rmSync(withoutBrowser.root,{recursive:true,force:true});}
});

test('resume requires a fresh assertion and reopens the run created by available',()=>{
  const f=fixture(true);
  try{
    const created=started(f,'--browser-qa','available');
    f.args[4]='resume';
    rejected(launch(f),'browser_capability_required');
    rejected(launch(f,'--browser-qa','unavailable'),'browser_capability_unavailable');
    const resumed=started(f,'--browser-qa','available');
    assert.deepEqual(resumed.fingerprints,created.fingerprints);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const [blocking,tests,applicable] of [
  [false,['logic'],false], [false,['logic','browser'],true], [true,['logic'],true],
])test(`single-task applicability: blocking=${blocking}, tests=${tests}`,()=>{
  const f=fixture(true,{blocking,tests});
  try{
    // T-001 remains pending: deferral must not remove an applicable capability gate.
    if(applicable){
      rejected(launch(f),'browser_capability_required');
      started(f,'--browser-qa','available');
    }else{
      rejected(launch(f,'--browser-qa','available'),'invalid_arguments');
      started(f);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

function batchFixture(options){
  const f=fixture(true,options),feature='2.browser';
  fs.renameSync(path.join(f.specsDir,'1.work'),path.join(f.specsDir,feature));
  const source=path.join(f.specsDir,feature,'test-cases.json');
  const contract=JSON.parse(fs.readFileSync(source,'utf8'));contract.feature='browser';
  fs.writeFileSync(source,JSON.stringify(contract));
  fs.mkdirSync(path.join(f.specsDir,'1.work'));
  for(const name of ['requirements.md','design.md','tasks.md'])
    fs.copyFileSync(path.join(f.specsDir,feature,name),path.join(f.specsDir,'1.work',name));
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',
    features:['1.work',feature],specFiles:buildManifest(f.specsDir)}));
  const batch={version:1,repositoryId:'gate',batchId:'batch-gate',specsDir:f.specsDir,codeProject:f.codeProject,
    tasks:['1.work',feature].map(feature=>({feature,taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']}))};
  const workflow=JSON.parse(fs.readFileSync(f.workflow,'utf8'));
  fs.writeFileSync(f.config,JSON.stringify({batch,workflows:Object.fromEntries(
    batch.tasks.map(task=>[`${task.feature}/${task.taskId}`,workflow]))}));
  // Intentionally withhold QA authorization: passing the capability gate must
  // reach this exact later error, before any batch Git/provider side effects.
  f.args=['serve','--config',f.config,'--host-context','gate-fixture','--allow-development'];
  return f;
}
const launchBatch=(f,...extra)=>spawnSync(process.execPath,[batchCli,...f.args,...extra],{encoding:'utf8',timeout:20000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
for(const [blocking,tests,applicable] of [
  [false,['logic'],false], [false,['logic','browser'],true], [true,['logic'],true],
])test(`batch checks the second feature: blocking=${blocking}, tests=${tests}`,()=>{
  const f=batchFixture({blocking,tests});
  try{
    if(applicable){
      rejected(launchBatch(f),'browser_capability_required');
      rejected(launchBatch(f,'--browser-qa','unavailable'),'browser_capability_unavailable');
      rejected(launchBatch(f,'--browser-qa','available'),'qa_authorization_required');
    }else{
      rejected(launchBatch(f,'--browser-qa','available'),'invalid_arguments');
      rejected(launchBatch(f),'qa_authorization_required');
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const [name,contents] of [['JSON','{'],['UTF-8',Buffer.from([0xff])]])
  test(`malformed ${name} test contracts retain a specific error at both entrypoints`,()=>{
    for(const batch of [false,true]){
      const f=batch?batchFixture({}):fixture(true);
      try{
        fs.writeFileSync(path.join(f.specsDir,batch?'2.browser':'1.work','test-cases.json'),contents);
        rejected((batch?launchBatch:launch)(f,'--browser-qa','available'),'test_cases_invalid');
      }finally{fs.rmSync(f.root,{recursive:true,force:true});}
    }
  });

test('declaring browser tests requires the role that serves them',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-capability-config-')));
  const write=body=>fs.writeFileSync(path.join(root,'.cm-workflow.json'),JSON.stringify(body));
  const base={version:1,runtimes:{available:'codex'},
    roles:{coder:{adapter:'codex-cli',model:'default',source:'subscription'},
      reviewer:{adapter:'codex-cli',model:'default',source:'subscription'},
      browser_qa:{adapter:'browser',model:'none',source:'local'}},
    policies:{tests:['logic','browser']}};
  try{
    write(base);
    assert.deepEqual(loadConfig({projectRoot:root}).policies.tests,['logic','browser']);
    const missing=structuredClone(base);missing.roles.browser_qa={adapter:'local',model:'none',source:'local'};
    write(missing);
    assert.throws(()=>loadConfig({projectRoot:root}),/roles\.browser_qa\.adapter is not browser/);
    const defaultPolicy=structuredClone(missing);delete defaultPolicy.policies;
    write(defaultPolicy);
    assert.throws(()=>loadConfig({projectRoot:root}),/roles\.browser_qa\.adapter is not browser/);
    delete defaultPolicy.roles.browser_qa;write(defaultPolicy);
    assert.equal(loadConfig({projectRoot:root}).roles.browser_qa.adapter,'browser');
    const logicOnly=structuredClone(missing);logicOnly.policies.tests=['logic'];
    write(logicOnly);
    assert.deepEqual(loadConfig({projectRoot:root}).policies.tests,['logic']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
