// Launch-time browser capability gate. The host cannot probe whether the
// launching session can drive a browser; these tests cover the declaration
// contract only, not any detection claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {loadConfig} from './cm-workflow-config.mjs';

const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const identity={repositoryId:'gate','runId':'gate-run',taskId:'T-001',attempt:1};

function fixture(browserCase){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-capability-gate-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:[{id:'TC-001',kind:browserCase?'browser':'logic',blocking:true,origin:'user',acIds:['AC-001'],taskIds:['T-001'],
      title:'Synthetic',preconditions:[],steps:['Observe fixture'],expected:['Fixture works'],cleanup:[]}]}));
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),
    JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const config=path.join(root,'run.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,
    scope:['target.mjs'],requirements:['requirements.md']}));
  const workflow=path.join(root,'workflow.json');
  fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],
    qa:{commands:[{id:'unit',command:[process.execPath,'--version'],caseIds:['TC-001']}],
      environment:{kind:'web',carrier:'browser',target:'https://example.invalid/fixture',scope:'local'}}}));
  return {root,specsDir,config,workflow,
    args:['serve','--config',config,'--mode','create','--host-context','gate-fixture','--allow-development',
      '--workflow-config',workflow,'--allow-qa']};
}

const launch=(f,...extra)=>spawnSync(process.execPath,[cli,...f.args,...extra],{encoding:'utf8',timeout:20000});

test('the browser gate fires exactly when the approved contract can select a browser case',()=>{
  const withBrowser=fixture(true);
  try{
    assert.match(launch(withBrowser).stderr,/browser_capability_required/);
    assert.match(launch(withBrowser,'--browser-qa','unavailable').stderr,/browser_capability_unavailable/);
    assert.match(launch(withBrowser,'--browser-qa','sometimes').stderr,/invalid_arguments/);
    // available must clear the gate: any later failure is not the capability check.
    const allowed=launch(withBrowser,'--browser-qa','available');
    assert.doesNotMatch(allowed.stderr,/browser_capability/);
  }finally{fs.rmSync(withBrowser.root,{recursive:true,force:true});}
  const withoutBrowser=fixture(false);
  try{
    assert.match(launch(withoutBrowser,'--browser-qa','available').stderr,/invalid_arguments/);
    assert.doesNotMatch(launch(withoutBrowser).stderr,/browser_capability/);
  }finally{fs.rmSync(withoutBrowser.root,{recursive:true,force:true});}
});

test('the gate applies to resume as well, because the assertion is never persisted',()=>{
  const f=fixture(true);
  try{
    launch(f,'--browser-qa','available');
    const resume=[...f.args];resume[4]='resume';
    const refused=spawnSync(process.execPath,[cli,...resume],{encoding:'utf8',timeout:20000});
    assert.match(refused.stderr,/browser_capability_required/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
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
    const logicOnly=structuredClone(missing);logicOnly.policies.tests=['logic'];
    write(logicOnly);
    assert.deepEqual(loadConfig({projectRoot:root}).policies.tests,['logic']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
