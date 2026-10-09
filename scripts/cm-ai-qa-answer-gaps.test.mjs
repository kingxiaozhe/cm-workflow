import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {releaseVerifiedQaResources,inspectOpenQaResources} from '../runtime/js/cm-ai/qa-resource-release.mjs';
import {readProcessStartTime,inspectWorkerGroup} from '../runtime/js/cm-ai/worker-process-identity.mjs';
import {qaRoundDeadlineMs} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {qaRoundLimit} from '../runtime/js/cm-ai/qa-round-budget.mjs';
import {inspectRunClosure} from './cm-log-event.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-gaps-home-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(home,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(home,{recursive:true,force:true});});
const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
const POSIX={skip:process.platform==='win32'};

function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-gaps-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(specsDir);fs.mkdirSync(codeProject);
  const log=path.join(specsDir,'运行日志.jsonl'),runId='qa-gap-run-0001';
  const write=(phase,data)=>{const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event','resource','--phase',phase,
    '--runtime','codex','--project-root',codeProject,'--specs-dir',specsDir,'--run-id',runId,'--detail','fixture',
    '--data-json',JSON.stringify(data)],{timeout:10000});assert.equal(result.status,0,String(result.stderr));};
  return {root,specsDir,codeProject,log,runId,write};
}
const until=async(predicate,ms=5000)=>{const end=Date.now()+ms;while(Date.now()<end&&!predicate())await new Promise(r=>setTimeout(r,25));};

// Q13/Q26: a cleanup_failed QA command resource is released by the host only
// with the proof its journaled process group is gone; anything else stays open.
test('cleanup_failed QA command resources are released only once their process group is proven gone',POSIX,async()=>{
  const f=fixture();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
  try{
    const pid=child.pid,startTime=readProcessStartTime(pid);assert.notEqual(startTime,null);
    for(const id of ['qa-command-live','qa-command-legacy']){
      f.write('acquired',{resource_id:id,resource_kind:'qa_command',cleanup_required:true});
      f.write('cleanup_failed',{resource_id:id,resource_kind:'qa_command',...(id==='qa-command-live'?{pid,process_start_time:startTime}:{})});
    }
    assert.equal(inspectRunClosure(f.log,f.runId).closed,false);
    let result=releaseVerifiedQaResources({specsDir:f.specsDir,codeProject:f.codeProject,runId:f.runId});
    assert.deepEqual(result.released,[]);
    assert.deepEqual(result.open.map(item=>[item.resourceId,item.verdict]),[['qa-command-live','alive'],['qa-command-legacy','unrecorded']]);
    process.kill(-pid,'SIGKILL');
    await until(()=>{try{process.kill(-pid,0);return false;}catch(error){return error.code==='ESRCH';}});
    result=releaseVerifiedQaResources({specsDir:f.specsDir,codeProject:f.codeProject,runId:f.runId});
    assert.deepEqual(result.released,['qa-command-live']);assert.deepEqual(result.open.map(item=>item.resourceId),['qa-command-legacy']);
    const released=fs.readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse).findLast(row=>row.phase==='released');
    assert.equal(released.verification,'process_group_gone');assert.equal(released.pid,pid);
    // Idempotent: nothing left to release; the legacy row still keeps the run open.
    assert.deepEqual(releaseVerifiedQaResources({specsDir:f.specsDir,codeProject:f.codeProject,runId:f.runId}).released,[]);
    assert.equal(inspectRunClosure(f.log,f.runId).closed,false);
    assert.deepEqual(inspectOpenQaResources({specsDir:f.specsDir,runId:f.runId}).map(row=>row.resource_id),['qa-command-legacy']);
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{}fs.rmSync(f.root,{recursive:true,force:true});}
});

test('worker group inspection treats Windows, permission errors and unreadable start times as unknown',()=>{
  const fail=code=>()=>{throw Object.assign(new Error(code),{code});};
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'x'},{platform:'win32'}),'unknown');
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'x'},{platform:'darwin',kill:fail('EPERM')}),'unknown');
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'x'},{platform:'darwin',kill:fail('ESRCH')}),'gone');
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'Mon'},{platform:'darwin',kill:()=>true,startTimeOf:()=>'Mon'}),'alive');
  // The pid now belongs to a process started at another time: the recorded group ended.
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'Mon'},{platform:'darwin',kill:()=>true,startTimeOf:()=>'Tue'}),'gone');
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'Mon'},{platform:'darwin',kill:()=>true,startTimeOf:()=>null}),'unknown');
  assert.equal(inspectWorkerGroup({pid:4242,startTime:null},{platform:'darwin',kill:()=>true}),'unknown');
  let calls=0;
  assert.equal(inspectWorkerGroup({pid:4242,startTime:'Mon'},{platform:'darwin',kill:target=>{calls++;if(target>0)fail('ESRCH')();return true;}}),'alive',
    'members of the group outlive the leader');
  assert.equal(calls,2);
  for(const pid of [0,1,-5,1.5,2**31])assert.equal(inspectWorkerGroup({pid,startTime:'x'},{platform:'darwin'}),'unknown');
});

// Q12: the whole-round deadline scales with the per-case limit and the case count.
test('QA round deadline scales with commands, logic and browser cases',()=>{
  const plan={modes:['commands','logic','browser'],commands:[{id:'a'},{id:'b'}],
    cases:[{kind:'logic'},{kind:'browser'},{kind:'browser'},{kind:'browser'}]};
  assert.equal(qaRoundDeadlineMs({timeoutMs:1800000,requestTimeoutMs:3600000,configuration:{plan}}),
    2*1800000+3600000+3*2*3600000+60000);
  assert.equal(qaRoundDeadlineMs({timeoutMs:1800000,requestTimeoutMs:60000,configuration:{plan:{modes:['browser'],commands:[],cases:[{kind:'browser'}]}}}),1800000);
  assert.equal(qaRoundDeadlineMs({timeoutMs:1800000,requestTimeoutMs:3600000,configuration:{plan:{...plan,cases:Array(40).fill({kind:'browser'})}}}),24*3600000);
  assert.equal(qaRoundDeadlineMs({timeoutMs:2000}),2000);
  assert.deepEqual([0,1,2,3].map(qaRoundLimit),[3,4,5,5]);
});
