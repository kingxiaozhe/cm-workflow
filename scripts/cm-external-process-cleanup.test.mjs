import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readModelJson,writeModelJson} from '../runtime/js/cm-ai/model-configuration-file.mjs';
const fixture=t=>{const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-security-fix-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const options=root=>({cwd:root,model:'synthetic-reviewer',effort:'high',schemaPath:path.join(root,'schema.json')});
const worker=(root,extra={})=>{const config=options(root);return codexWorker({...config,preflight:{passed:true,cli_model:config.model,config_fingerprint:configFingerprint(config)},...extra});};

for(const uncertain of [false,true])test(`Claude terminal receipt requires owned descendant cleanup: ${uncertain?'unknown':'confirmed'}`,
  {skip:process.platform==='win32'},async t=>{
  const root=fixture(t),script=path.join(root,'claude-leader.mjs'),pidFile=path.join(root,'descendant.pid');let leader;
  t.after(()=>{if(leader?.pid)try{process.kill(-leader.pid,'SIGKILL');}catch{}});
  fs.writeFileSync(script,`import {spawn} from 'node:child_process';import fs from 'node:fs';
for await(const chunk of process.stdin){};
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
child.on('message',()=>{
 fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
 const session_id='original-session',out=value=>console.log(JSON.stringify({...value,session_id}));
 out({type:'system',subtype:'init'});
 out({type:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'done'}]}});
 out({type:'result',subtype:'success',is_error:false,num_turns:1,structured_output:{ok:true}});process.exit(0);
});`);
  const options={cwd:root,model:'fixture'};let receipt=null;
  const run=claudeWorker({...options,timeoutMs:3000,preflight:{passed:true,provider:'claude',prompt_transport:'stdin',
    config_fingerprint:claudeReviewFingerprint(options)},
    ...(uncertain?{killProcess:()=>{throw Object.assign(new Error('fixture permission denied'),{code:'EPERM'});}}:{}),
    spawnProcess:(_cli,_args,opts)=>leader=spawn(process.execPath,[script],opts)});
  const result=await run({prompt:'fixture'},{signal:new AbortController().signal,onEvent:()=>{},onTerminal:value=>{
    assert.equal(alive(Number(fs.readFileSync(pidFile,'utf8'))),false);receipt=value;
  }});
  const descendant=Number(fs.readFileSync(pidFile,'utf8'));
  if(uncertain){assert.equal(result.code,'process_cleanup_unknown');assert.equal(receipt,null);assert.equal(alive(descendant),true);}
  else {assert.deepEqual(result,{status:'succeeded',value:{ok:true}});assert.deepEqual(receipt,result);assert.equal(alive(descendant),false);}
});


test('Windows old reviewer keeps successful dispatch; termination uncertainty cannot become cancelled',async t=>{
  const root=fixture(t),original=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{value:'win32'});
  try{
    let kills=0;
    for(const mode of ['success','timeout','cancel']){
      const good=mode==='success',controller=new AbortController();
      const spawnProcess=(_cli,_args,opts)=>{
        assert.equal(opts.detached,false);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
        child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null,'SIGTERM'));};
        if(good)queueMicrotask(()=>{
          for(const row of [{type:'thread.started',thread_id:'fresh'},{type:'turn.started'},
            {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed'}])child.stdout.write(JSON.stringify(row)+'\n');
          child.emit('close',0,null);
        });return child;
      };
      const timer=mode==='cancel'?setTimeout(()=>controller.abort(),10):null;
      try{
        const result=await worker(root,{spawnProcess,timeoutMs:mode==='cancel'?1000:20})({prompt:'fixture'},
          {signal:controller.signal,onEvent:()=>{},onTerminal:()=>assert.fail('Windows cannot attest process-tree cleanup')});
        assert.deepEqual(result,good?{status:'succeeded',value:{ok:true}}:{status:'failed',code:'process_cleanup_unknown'});
      }finally{clearTimeout(timer);}
    }
    assert.equal(kills,2);
  }finally{Object.defineProperty(process,'platform',original);}
});
