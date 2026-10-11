// Synthetic, hash-valid historical envelopes exercise the actual CLI before
// fingerprint reconstruction. They are refusal fixtures, not review evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t,payload){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-legacy-history-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const specsDir=path.join(dir,'specs'),codeProject=path.join(dir,'code'),identity={repositoryId:'fixture',runId:'old-run-fixture',taskId:'T-001',attempt:1};
  fs.mkdirSync(codeProject);fs.mkdirSync(specsDir);
  const execution=path.join(specsDir,'.reviews','.execution',identity.runId);
  fs.mkdirSync(execution,{recursive:true,mode:0o700});
  fs.chmodSync(path.join(specsDir,'.reviews','.execution'),0o700);
  const body={version:1,seq:1,id:'registration',kind:'intent',payload,previousDigest:null};
  const state={version:1,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('old-workflow'),config:digest('old-config'),inputs:digest('old-inputs')},records:[{...body,digest:digest(body)}]};
  const file=path.join(execution,'state.json');fs.writeFileSync(file,JSON.stringify({...state,revision:digest(state)})+'\n',{mode:0o600});
  const config=path.join(dir,'run.json');fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature:'1.work',identity,scope:['a.js'],requirements:[]}));
  const before=fs.readFileSync(file);
  const invoke=(script,args)=>spawnSync(process.execPath,[path.join(root,'scripts',script),...args],{encoding:'utf8',input:'',timeout:10000,
    env:{...process.env,CM_WORKFLOW_HOME:path.join(dir,'home'),CM_WORKFLOW_LOG_HOME:path.join(dir,'logs')}});
  return {config,file,before,invoke,execution};
}
for(const field of ['grant','authorizationAt'])test(`legacy ${field} refuses at both CLI entries before fingerprint/preflight and never writes`,t=>{
  const f=fixture(t,{type:'review-invocation-registered',[field]:field==='grant'?{kind:'cm-review-dispatch-grant'}:1});
  for(const [script,args] of [
    ['cm-ai-run.mjs',['serve','--config',f.config,'--mode','resume']],
    ['cm-ai-host.mjs',['serve','--config',f.config,'--mode','resume','--host-context','fixture-host','--allow-development']],
  ]){
    const run=f.invoke(script,args);assert.equal(run.status,1,run.stderr);
    const error=JSON.parse(run.stderr.trim().split('\n').at(-1)).error;
    assert.equal(error.code,'runner_invocation');assert.match(error.reason,/旧授权协议不支持恢复/);
    assert.match(error.reason,/inspect-history --config/);assert.doesNotMatch(error.reason,/沿用原文件和参数/);
    assert.equal(run.stdout,'');assert.deepEqual(fs.readFileSync(f.file),f.before);
    assert.deepEqual(fs.readdirSync(f.execution),['state.json']);
  }
  const inspected=f.invoke('cm-ai-run.mjs',['inspect-history','--config',f.config]);assert.equal(inspected.status,0,inspected.stderr);
  const history=JSON.parse(inspected.stdout);assert.equal(history.records[0].type,'review-invocation-registered');
  assert.equal(history.records[0].legacyReviewGrant,true);assert.deepEqual(fs.readFileSync(f.file),f.before);
  assert.equal(Object.hasOwn(history.records[0],'grant'),false);
});
test('read-only history validates store digest and never bypasses corrupt evidence',t=>{
  const f=fixture(t,{type:'review-invocation-registered',grant:{}});
  const raw=JSON.parse(f.before);raw.records[0].payload.grant.changed=true;fs.writeFileSync(f.file,JSON.stringify(raw)+'\n');
  const bytes=fs.readFileSync(f.file),run=f.invoke('cm-ai-run.mjs',['inspect-history','--config',f.config]);
  assert.equal(run.status,1);assert.match(run.stderr,/store_corrupt/);assert.equal(run.stdout,'');assert.deepEqual(fs.readFileSync(f.file),bytes);
});
