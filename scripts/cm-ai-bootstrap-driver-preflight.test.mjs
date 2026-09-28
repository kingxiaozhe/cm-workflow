import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {bootstrapDriverGap} from './cm-ai-drive.mjs';
import {hostResponseFailed} from '../runtime/js/cm-ai/drive-core.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-bootstrap-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),feature='1.bootstrap';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# iOS SwiftUI scaffold and rules\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Split specs5/app roots\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 和 .claude/ 规范（cm-init）\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const configuration=path.join(root,'bootstrap.json');
  fs.writeFileSync(configuration,JSON.stringify({selection:{versionControl:'local',modules:[],analysis:'SwiftUI iOS app'}}));
  const definition={specsDir,codeProject,feature,identity:{repositoryId:'app',runId:'t002',taskId:'T-002',attempt:1}};
  return {configuration,definition};
}

test('rules bootstrap requires live init_verify on first and second attempt',t=>{
  const f=fixture(t),permissions=['--bootstrap-config',f.configuration,'--allow-bootstrap-write'];
  for(const attempt of [1,2])for(const operation of ['advance','start','resume']){
    const error=bootstrapDriverGap(operation,{...f.definition,identity:{...f.definition.identity,attempt}},permissions);
    assert.match(error,/init_verify/);
    assert.match(error,/cm-ai-host\.mjs serve/);
  }
  assert.equal(bootstrapDriverGap('advance',{...f.definition,identity:{...f.definition.identity,taskId:'T-001'}},permissions),null);
  assert.equal(bootstrapDriverGap('advance',f.definition,[]),null);
  assert.equal(bootstrapDriverGap('status',f.definition,permissions),null);
  assert.match(bootstrapDriverGap('advance',{...f.definition,identity:{...f.definition.identity,taskId:'T-999'}},permissions),/预检失败.*宿主未启动/);
});

test('unknown and reconcile host responses are failures even when a result is returned',()=>{
  assert.equal(hostResponseFailed({result:{state:'unknown',code:'execution_error',pendingAction:'reconcile'}}),true);
  assert.equal(hostResponseFailed({result:{state:'unknown',code:'execution_error',pendingAction:null}}),true);
  assert.equal(hostResponseFailed({result:{state:'blocked',pendingAction:'reconcile'}}),true);
  assert.equal(hostResponseFailed({result:{state:'awaiting_review',pendingAction:'decision'}}),false);
  assert.equal(hostResponseFailed({error:{code:'invalid_input'}}),true);
});
