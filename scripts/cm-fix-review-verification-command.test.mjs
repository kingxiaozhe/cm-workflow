import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {runVerificationCommand,writeInsideCopy} from '../runtime/js/cm-fix/review-verification-command.mjs';

const supported=process.platform==='darwin';
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-command-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'copy');fs.mkdirSync(cwd);
  return {root,cwd};
}
function run(cwd,source,extra={}){
  return runVerificationCommand({cwd,command:[process.execPath,'-e',source],timeoutMs:5000,
    signal:new AbortController().signal,...extra});
}
test('verification command refuses a symlink working directory',async t=>{
  const {root,cwd}=fixture(t),link=path.join(root,'alias');fs.symlinkSync(cwd,link);
  const result=await run(link,'process.exit(0)');
  assert.equal(result.outcome,'unavailable');assert.equal(result.code,'verification_path_invalid');
});
test('verification command rejects system and home roots before cancellation',async()=>{
  const controller=new AbortController();controller.abort();
  for(const directory of ['/', '/usr', '/usr/local', '/private', os.homedir(),path.dirname(os.homedir())]){
    if(!fs.existsSync(directory))continue;
    const cwd=fs.realpathSync(directory),result=await run(cwd,'process.exit(8)',{signal:controller.signal});
    assert.equal(result.code,'verification_path_invalid',directory);
  }
});
test('verification sandbox does not read the local administrator prefix',{skip:!supported||!fs.existsSync('/usr/local')},async t=>{
  const {cwd}=fixture(t);
  const result=await run(cwd,`try{require('node:fs').readdirSync('/usr/local');process.exit(8)}
    catch(error){process.exit(error.code==='EPERM'||error.code==='EACCES'?0:9)}`);
  assert.equal(result.outcome,'passed',result.output);
});
test('verification sandbox rejects the data volume alias of an external fixture',{skip:!supported},async t=>{
  const {root,cwd}=fixture(t),secret=path.join(root,'synthetic-secret');fs.writeFileSync(secret,'synthetic-private-value');
  const alias='/System/Volumes/Data'+secret;
  assert.equal(fs.readFileSync(alias,'utf8'),'synthetic-private-value');
  const result=await run(cwd,`const fs=require('node:fs');let denied=0;
    for(const target of ${JSON.stringify([alias,fs.realpathSync(alias)])}){
      try{fs.readFileSync(target)}catch(error){if(['EPERM','EACCES'].includes(error.code))denied++;}
    }process.exit(denied===2?0:8);`);
  assert.equal(result.outcome,'passed',result.output);
});
test('verification sandbox denies credential and other Mach service lookups without contacting services',{skip:!supported},async t=>{
  const {cwd}=fixture(t),source=path.join(cwd,'probe.c'),binary=path.join(cwd,'probe');
  // sandbox_check only examines the current policy. It neither connects to a
  // service nor asks Keychain for credentials. GLOBAL_NAME is filter value 2.
  fs.writeFileSync(source,`#include <unistd.h>\n#include <stdio.h>\n
    extern int sandbox_check(pid_t,const char *,int,...);
    int main(void){const char *names[]={"com.apple.securityd","com.apple.securityd.xpc","cm.synthetic.nonexistent"};
      for(int i=0;i<3;i++)if(sandbox_check(getpid(),"mach-lookup",2,names[i])!=1)return 8;
      puts("lookup-denied");return 0;}`);
  const compiled=spawnSync('/usr/bin/clang',[source,'-o',binary,'-lsandbox'],{encoding:'utf8',timeout:10000});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=await run(cwd,'',{command:[binary]});
  assert.equal(result.outcome,'passed',result.output);assert.match(result.output,/lookup-denied/);
});
test('verification command preserves exit status and uses a private environment',{skip:!supported},async t=>{
  const {cwd}=fixture(t);
  const result=await run(cwd,`const fs=require('node:fs');
    if(process.env.ANTHROPIC_API_KEY||process.env.CODEX_HOME||process.env.NODE_OPTIONS)process.exit(8);
    if(!process.env.HOME.startsWith(process.cwd()+'/'))process.exit(9);
    fs.writeFileSync('artifact','ok');console.log('verification-output');`);
  assert.equal(result.outcome,'passed');assert.equal(result.exitCode,0);assert.equal(result.code,null);
  assert.match(result.output,/verification-output/);assert.equal(fs.readFileSync(path.join(cwd,'artifact'),'utf8'),'ok');
  assert.deepEqual(fs.readdirSync(cwd),['artifact']);
  const failed=await run(cwd,'process.exit(7)');
  assert.equal(failed.outcome,'failed');assert.equal(failed.exitCode,7);
});
test('verification runs a real script entry without granting ancestor file contents',{skip:!supported},async t=>{
  const {cwd,root}=fixture(t),entry=path.join(cwd,'entry.mjs'),secret=path.join(root,'secret');
  fs.writeFileSync(secret,'private-fixture');
  fs.writeFileSync(entry,`import fs from 'node:fs';console.log('real-entry');
    try{fs.readFileSync(${JSON.stringify(secret)});process.exit(8)}catch{}`);
  const result=await run(cwd,'',{command:[process.execPath,entry]});
  assert.equal(result.outcome,'passed',result.output);assert.match(result.output,/real-entry/);
});
test('verification runs a real Node test file without Mach service access',{skip:!supported},async t=>{
  const {cwd}=fixture(t),entry=path.join(cwd,'sample.test.mjs');
  fs.writeFileSync(entry,"import test from 'node:test';import assert from 'node:assert/strict';test('isolated',()=>assert.equal(2+2,4));");
  const result=await run(cwd,'',{command:[process.execPath,'--test',entry]});
  assert.equal(result.outcome,'passed',result.output);assert.match(result.output,/pass 1/);
});
test('verification sandbox rejects external reads, source writes and symlink escapes',{skip:!supported},async t=>{
  const {root,cwd}=fixture(t),secret=path.join(root,'secret'),source=path.join(root,'original');
  fs.writeFileSync(secret,'private-fixture');fs.writeFileSync(source,'original');
  fs.symlinkSync(root,path.join(cwd,'escape'));
  const result=await run(cwd,`const fs=require('node:fs');let refused=0;
    for(const p of [${JSON.stringify(secret)},'escape/secret'])try{fs.readFileSync(p)}catch{refused++}
    for(const p of [${JSON.stringify(source)},'escape/original'])try{fs.writeFileSync(p,'bad')}catch{refused++}
    console.log(refused);process.exit(refused===4?0:5);`);
  assert.equal(result.outcome,'passed',result.output);assert.equal(result.output.trim(),'4');
  assert.equal(fs.readFileSync(source,'utf8'),'original');
});
const PROCARGS_PROBE=`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
int main(int argc,char**argv){int mib[3]={CTL_KERN,KERN_PROCARGS2,atoi(argv[1])};size_t size=0;
if(sysctl(mib,3,NULL,&size,NULL,0)!=0){perror("sysctl");return 2;}char*b=malloc(size);
if(sysctl(mib,3,b,&size,NULL,0)!=0){perror("sysctl");return 3;}size_t n=strlen(argv[2]);
for(size_t i=0;i+n<=size;i++)if(!memcmp(b+i,argv[2],n)){puts("FOUND");return 0;}puts("NOTFOUND");return 0;}`;
test('verification sandbox cannot read another process environment through a native helper',{skip:!supported||!fs.existsSync('/usr/bin/clang')},async t=>{
  const {root,cwd}=fixture(t),source=path.join(root,'probe.c'),probe=path.join(cwd,'probe');
  fs.writeFileSync(source,PROCARGS_PROBE);
  const built=spawnSync('/usr/bin/clang',['-o',probe,source],{encoding:'utf8'});
  if(built.status!==0){t.skip('clang cannot build the probe here');return;}
  const secret=`cm-probe-${process.pid}-${Date.now()}`;
  const holder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,CM_PROBE_SECRET:secret},stdio:'ignore'});
  t.after(()=>holder.kill('SIGKILL'));
  // The fixture is valid only if the same probe does find the secret outside the sandbox.
  const outside=spawnSync(probe,[String(holder.pid),secret],{encoding:'utf8'});
  assert.equal(outside.stdout.trim(),'FOUND');
  const inside=await runVerificationCommand({cwd,command:[probe,String(holder.pid),secret],timeoutMs:20000,signal:new AbortController().signal});
  assert.equal(inside.outcome,'failed');
  assert.doesNotMatch(inside.output,/FOUND/);
  assert.match(inside.output,/Operation not permitted/);
  // The same rules still let ordinary Node code inspect its own machine and spawn children.
  const node=await run(cwd,"const os=require('os');const r=require('child_process').spawnSync(process.execPath,['-e','process.exit(0)']);process.exit(os.cpus().length>0&&r.status===0?0:9)");
  assert.equal(node.outcome,'passed');
});
test('verification sandbox rejects loopback network access',{skip:!supported},async t=>{
  const {cwd}=fixture(t);let requests=0;
  const server=http.createServer((_req,res)=>{requests++;res.end('unexpected');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=server.address().port;
    const result=await run(cwd,`const http=require('node:http');
      const req=http.get('http://127.0.0.1:${port}',()=>process.exit(8));
      req.once('error',()=>process.exit(0));req.setTimeout(1000,()=>process.exit(9));`);
    assert.equal(result.outcome,'passed',result.output);assert.equal(requests,0);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('verification command timeout and cancellation are unavailable, never passed',{skip:!supported},async t=>{
  const {cwd}=fixture(t),controller=new AbortController();
  const timed=await run(cwd,'setInterval(()=>{},1000)',{timeoutMs:250});
  assert.equal(timed.outcome,'unavailable');assert.equal(timed.code,'verification_timeout');
  const pending=run(cwd,'setInterval(()=>{},1000)',{signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),250);
  const cancelled=await pending;clearTimeout(timer);
  assert.equal(cancelled.outcome,'unavailable');assert.equal(cancelled.code,'verification_cancelled');
  assert.deepEqual(fs.readdirSync(cwd),[]);
});
test('verification command bounds retained output and rejects output floods',{skip:!supported},async t=>{
  const {cwd}=fixture(t);
  const bounded=await run(cwd,"process.stdout.write('x'.repeat(20000))");
  assert.equal(bounded.outcome,'passed');assert.equal(bounded.output.length,8192);
  const flood=await run(cwd,"process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)");
  assert.equal(flood.outcome,'unavailable');assert.equal(flood.code,'verification_output_limit');
  assert.equal(flood.output.length,8192);
});
test('verification timeout cleans its owned child process group',{skip:!supported},async t=>{
  const {cwd}=fixture(t);
  const result=await run(cwd,`const cp=require('node:child_process');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);setInterval(()=>{},1000);`,{timeoutMs:300});
  assert.equal(result.outcome,'unavailable');assert.equal(result.code,'verification_timeout');
  const pid=Number(result.output.trim());assert(Number.isInteger(pid)&&pid>0);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('verification sandbox cannot signal its outer host',{skip:!supported},async t=>{
  const {cwd}=fixture(t);
  const result=await run(cwd,`try{process.kill(${process.pid},0);process.exit(8)}
    catch(error){process.exit(error.code==='EPERM'?0:9)}`);
  assert.equal(result.outcome,'passed',result.output);
});
test('verification setup failures and pre-cancellation never become failing test evidence',{skip:!supported},async t=>{
  const {cwd}=fixture(t),controller=new AbortController();controller.abort();
  const cancelled=await run(cwd,'process.exit(8)',{signal:controller.signal});
  assert.equal(cancelled.code,'verification_cancelled');assert.deepEqual(fs.readdirSync(cwd),[]);
  const missing=await run(cwd,'',{command:['/nonexistent-cm-verification-command']});
  assert.equal(missing.outcome,'unavailable');assert.equal(missing.code,'verification_isolation_failed');
  const invalid=await run(cwd,'',{timeoutMs:0});
  assert.equal(invalid.outcome,'unavailable');assert.equal(invalid.code,'verification_command_invalid');
});
test('verification reports process ownership and cleans up when its observer rejects',{skip:!supported},async t=>{
  const {cwd}=fixture(t),events=[];
  const result=await run(cwd,'process.exit(0)',{onSpawn:pid=>{events.push(['spawn',pid]);},onClose:pid=>{events.push(['close',pid]);}});
  assert.equal(result.outcome,'passed');assert.equal(events.length,2);assert.equal(events[0][1],events[1][1]);
  assert.equal(events[0][0],'spawn');assert.equal(events[1][0],'close');
  let pid,closed;
  const failed=await run(cwd,'setInterval(()=>{},1000)',{onSpawn:value=>{pid=value;throw Error('synthetic observer error');},
    onClose:value=>{closed=value;}});
  assert.equal(failed.outcome,'unavailable');assert.equal(failed.code,'verification_observer_failed');
  assert.equal(closed,pid);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('verification does not claim cleanup when a detached descendant holds its output open',{skip:!supported},async t=>{
  const {cwd}=fixture(t);let closed=false,pid;
  try{
    const result=await run(cwd,`const cp=require('node:child_process');
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
      console.log(child.pid);child.unref();`,{onClose:()=>{closed=true;}});
    pid=Number(result.output.trim());
    assert.equal(result.outcome,'unavailable');assert.equal(result.code,'verification_cleanup_unknown');
    assert.equal(closed,false);assert(Number.isInteger(pid)&&pid>0);
  }finally{if(Number.isInteger(pid)&&pid>0)try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
});
test('copy writes run inside the sandbox and cannot follow a link out of the copy',{skip:!supported},async t=>{
  const {root,cwd}=fixture(t),outside=path.join(root,'outside.txt');
  fs.writeFileSync(outside,'keep');
  fs.writeFileSync(path.join(cwd,'a.txt'),'old',{mode:0o644});
  writeInsideCopy({cwd,file:'a.txt',data:Buffer.from('new'),mode:0o600});
  assert.equal(fs.readFileSync(path.join(cwd,'a.txt'),'utf8'),'new');
  assert.equal(fs.statSync(path.join(cwd,'a.txt')).mode&0o7777,0o600);
  writeInsideCopy({cwd,file:'a.txt',data:Buffer.from('kept mode'),mode:null});
  assert.equal(fs.statSync(path.join(cwd,'a.txt')).mode&0o7777,0o600);
  fs.symlinkSync(outside,path.join(cwd,'link.txt'));
  assert.throws(()=>writeInsideCopy({cwd,file:'link.txt',data:Buffer.from('escaped'),mode:null}),{message:'review_verification_copy_drift'});
  fs.mkdirSync(path.join(root,'outdir'));fs.writeFileSync(path.join(root,'outdir','b.txt'),'keep');
  fs.symlinkSync(path.join(root,'outdir'),path.join(cwd,'dir'));
  assert.throws(()=>writeInsideCopy({cwd,file:'dir/b.txt',data:Buffer.from('escaped'),mode:null}),{message:'review_verification_copy_drift'});
  assert.equal(fs.readFileSync(outside,'utf8'),'keep');
  assert.equal(fs.readFileSync(path.join(root,'outdir','b.txt'),'utf8'),'keep');
  for(const file of ['../outside.txt','/etc/hosts','a/../../x',''])
    assert.throws(()=>writeInsideCopy({cwd,file,data:Buffer.from('x'),mode:null}),{message:'verification_write_invalid'});
});
test('verification command rejects unsupported isolation without executing',{skip:supported},async t=>{
  const {cwd}=fixture(t),result=await run(cwd,'process.exit(0)');
  assert.equal(result.outcome,'unavailable');assert.equal(result.code,'verification_isolation_unsupported');
});
