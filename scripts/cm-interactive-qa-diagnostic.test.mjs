import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readBrowserCapability} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {main as hostMain} from './cm-ai-host.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

test('interactive QA capability failure names iOS simulator and the compatible flag',()=>{
  assert.throws(()=>readBrowserCapability(undefined,['ios-simulator']),error=>{
    assert.equal(error.code,'browser_capability_required');
    assert.match(error.reason,/ios-simulator/);
    assert.match(error.reason,/--browser-qa available\|unavailable/);
    assert.match(error.reason,/interactive QA/);
    return true;
  });
  assert.equal(readBrowserCapability('available',['ios-simulator']),'available');
});

test('interactive carrier diagnostic rejects undeclared carrier text',()=>{
  assert.throws(()=>readBrowserCapability(undefined,['/private/synthetic-secret']),{code:'invalid_arguments'});
});

test('single-task CLI names ios-simulator before opening a host',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ios-carrier-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'- [AC-001]: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:[{id:'TC-001',kind:'browser',blocking:true,origin:'user',acIds:['AC-001'],taskIds:['T-001'],
      title:'Simulator check',preconditions:[],steps:['Open app'],expected:['App opens'],cleanup:[]}]}));
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],
    specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const config=path.join(root,'run.json'),workflow=path.join(root,'workflow.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'fixture',runId:'ios-carrier',taskId:'T-001',attempt:1},
    scope:['target.mjs'],requirements:['requirements.md']}));
  fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],
    qa:{commands:[],environment:{kind:'app',carrier:'ios-simulator',target:'fixture-app',scope:'local'}}}));
  let stderr='',stdout='';
  const exit=await hostMain(['serve','--config',config,'--mode','create','--host-context','fixture-host',
    '--allow-development','--workflow-config',workflow,'--allow-qa'],{
    output:{write:text=>{stdout+=text;}},error:{write:text=>{stderr+=text;}}});
  assert.equal(exit,1);assert.equal(stdout,'');
  const error=JSON.parse(stderr).error;
  assert.equal(error.code,'browser_capability_required');
  assert.match(error.reason,/ios-simulator/);
});
