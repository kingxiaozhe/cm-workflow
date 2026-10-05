// Fault injection only: no real process enumeration, listener or provider call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {main} from './cm-ai-host.mjs';
import {runLiveDriver} from './fixtures/live-evidence-driver.mjs';

function temporary(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-efficiency-diagnostic-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
for(const [systemCode,syscall,address,expected] of [
  ['EPERM','listen','127.0.0.1',true],['EACCES','listen','127.0.0.1',true],
  ['EPERM','open','127.0.0.1',false],['EPERM','listen','192.0.2.1',false],
])test(`preflight safe fault diagnostic: ${systemCode}/${syscall}/${address}`,async t=>{
  const root=temporary(t),codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(specsDir);
  const definition=path.join(root,'run.json');fs.writeFileSync(definition,JSON.stringify({version:1,
    codeProject,specsDir,feature:'1.work',identity:{repositoryId:'fixture',runId:'diagnostic-run',taskId:'T-1',attempt:1},
    scope:['target.mjs'],requirements:[]}));
  const savedCreate=http.createServer,savedExists=fs.existsSync,platform=Object.getOwnPropertyDescriptor(process,'platform');
  let listened=0,closed=0,stdout='',stderr='';
  class FailedListener extends EventEmitter{
    listen(port,host){assert.equal(port,0);assert.equal(host,'127.0.0.1');listened++;
      queueMicrotask(()=>this.emit('error',Object.assign(Error('private synthetic error details'),{code:systemCode,syscall,address})));return this;}
    address(){throw Error('worker dispatch must not be reached');}
    closeAllConnections(){}
    close(callback){closed++;callback();}
  }
  try{
    // Model the supported platform without invoking its isolation primitive.
    Object.defineProperty(process,'platform',{...platform,value:'darwin'});
    fs.existsSync=value=>value==='/usr/bin/sandbox-exec'||savedExists(value);
    http.createServer=()=>new FailedListener();
    const status=await main(['preflight','--config',definition,'--review-model','fixture','--runtime','claude'],
      {output:{write:value=>{stdout+=value;}},error:{write:value=>{stderr+=value;}}});
    assert.equal(status,1);assert.equal(stdout,'');assert.equal(listened,1);assert.equal(closed,1);
    const expectedError={code:'host_launch_failed',...(expected?{diagnostic:{operation:'listen',systemCode,address:'loopback'}}:{})};
    assert.deepEqual(JSON.parse(stderr),{error:expectedError});
    assert(!stderr.includes('private synthetic'));assert.equal(savedExists(path.join(specsDir,'.reviews')),false);
  }finally{http.createServer=savedCreate;fs.existsSync=savedExists;Object.defineProperty(process,'platform',platform);}
});

for(const mode of ['missing','not-executable','failed-command'])test(`process listing fails closed with bounded diagnostic: ${mode}`,t=>{
  const root=temporary(t),bin=path.join(root,'bin');fs.mkdirSync(bin);
  if(mode==='not-executable')fs.writeFileSync(path.join(bin,'ps'),'synthetic',{mode:0o600});
  if(mode==='failed-command')fs.writeFileSync(path.join(bin,'ps'),`#!${process.execPath}\nprocess.stderr.write('private synthetic process detail');process.exit(7);\n`,{mode:0o700});
  const helper=new URL('./fixtures/process-cleanup.mjs',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {fixtureProcesses} from ${JSON.stringify(helper)};
    try{fixtureProcesses(${JSON.stringify(root)});process.exitCode=2;}
    catch(error){process.stdout.write(JSON.stringify({code:error.code,diagnostic:error.diagnostic}));}`],
    {encoding:'utf8',env:{...process.env,PATH:bin},timeout:5000});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{code:'fixture_process_listing_failed',diagnostic:{command:'ps',
    status:mode==='failed-command'?7:null,signal:null,systemCode:mode==='missing'?'ENOENT':mode==='not-executable'?'EACCES':null}});
  assert(!result.stdout.includes('private synthetic'));assert.equal(result.stderr,'');
});

test('live fixture watchdog remains a failure and retains only bounded diagnostics',async t=>{
  const root=temporary(t),driver=path.join(root,'driver.mjs');
  fs.writeFileSync(driver,"process.stdout.write('private synthetic stdout');process.stderr.write('private synthetic stderr');setInterval(()=>{},1000);\n");
  await assert.rejects(runLiveDriver(driver,path.join(root,'plan.json'),'advance',()=>{throw Error('no request expected');},{timeoutMs:700}),error=>{
    assert.equal(error.code,'fixture_driver_timeout');assert.equal(error.diagnostic.timeoutMs,700);
    assert(error.diagnostic.elapsedMs>=700);assert.equal(error.diagnostic.requestCount,0);
    assert(error.diagnostic.stdoutBytes>0);assert(error.diagnostic.stderrBytes>0);
    assert(!JSON.stringify(error).includes('private synthetic'));return true;
  });
});
