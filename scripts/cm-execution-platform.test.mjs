import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';

test('execution admission allows only Darwin/Linux at the existing Node floor',()=>{
  for(const platform of ['darwin','linux']){
    for(const version of ['24.14.0','24.15.0','25.0.0'])
      assert.equal(isSupportedExecutionPlatform(platform,version),true,`${platform}/${version}`);
    for(const version of ['18.20.0','23.11.0','24.0.0','24.13.99'])
      assert.equal(isSupportedExecutionPlatform(platform,version),false,`${platform}/${version}`);
  }
  for(const platform of ['win32','freebsd','aix',''])
    assert.equal(isSupportedExecutionPlatform(platform,'25.0.0'),false,platform);
  assert.equal(isSupportedExecutionPlatform(),isSupportedExecutionPlatform(process.platform,process.versions.node));
});

test('unsupported platform/version cannot create raw-store or task-owner artifacts',{
  skip:!isSupportedExecutionPlatform('darwin',process.versions.node)
},async()=>{
  const {openExecutionStore}=await import('../runtime/js/cm-ai/execution-store.mjs');
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-platform-gate-')));
  const tasksPath=path.join(root,'tasks.md'),original='- [ ] T-001 Synthetic task\n';
  fs.writeFileSync(tasksPath,original);
  const options={specsRoot:root,identity:{repositoryId:'synthetic',runId:'platform-gate'},
    fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)},create:true};
  const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform');
  const versionDescriptor=Object.getOwnPropertyDescriptor(process.versions,'node');
  try{
    // These are rejection-path fixtures, never evidence of executing on Linux.
    for(const [platform,version] of [['win32','24.14.0'],['freebsd','25.0.0'],['linux','24.13.99'],['darwin','24.13.99']]){
      Object.defineProperty(process,'platform',{...platformDescriptor,value:platform});
      Object.defineProperty(process.versions,'node',{...versionDescriptor,value:version});
      assert.throws(()=>openExecutionStore(options),{code:'unsupported_platform'});
      assert.throws(()=>openTaskExecutionStore({...options,tasksPath,feature:'sample'}),{code:'unsupported_platform'});
      assert.deepEqual(fs.readdirSync(root),['tasks.md']);
      assert.equal(fs.readFileSync(tasksPath,'utf8'),original);
    }
  }finally{
    Object.defineProperty(process,'platform',platformDescriptor);
    Object.defineProperty(process.versions,'node',versionDescriptor);
    fs.rmSync(root,{recursive:true,force:true});
  }
});
