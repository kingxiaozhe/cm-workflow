import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {snapshotSource,sourceChanges,readSourceFiles} from '../runtime/js/cm-test/source-snapshot.mjs';
import {openTestSession} from '../runtime/js/cm-test/session.mjs';
import {createCmTestHost} from '../runtime/js/cm-test/host.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const item=(id,kind)=>({id,kind,origin:'user',blocking:true,acIds:[],taskIds:[],title:'Synthetic behavior',preconditions:[],steps:['Observe'],expected:['Expected result'],cleanup:[]});
function fixture(t,{specs=false}={}){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-test-session-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const counter=path.join(temp,'count');
  fs.writeFileSync(path.join(project,'check.mjs'),`import fs from 'node:fs';const p=${JSON.stringify(counter)};fs.appendFileSync(p,'executed\\n');console.log('synthetic command');`);
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Declared command: node check.mjs\n');
  const cases=path.join(temp,'cases.json'),contract={schemaVersion:'1.0',feature:'example',cases:[item('TC-001','logic'),item('TC-002','browser')]};
  fs.writeFileSync(cases,JSON.stringify(contract));
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',arguments:{cases,all:true},sources:['check.mjs','AGENTS.md'],
    commands:[{id:'check',command:['node','check.mjs'],caseIds:['TC-001'],declaration:{path:'AGENTS.md',line:1}}],
    environment:{scope:'local',kind:'web',carrier:'browser',target:'http://127.0.0.1:3000'},logHome:path.join(temp,'logs')};
  if(specs){const base=path.join(project,'specs'),feature=path.join(base,'1.example');fs.mkdirSync(feature,{recursive:true});
    for(const name of ['requirements.md','design.md','tasks.md'])fs.writeFileSync(path.join(feature,name),'# Synthetic\n');
    fs.writeFileSync(path.join(feature,'test-cases.json'),JSON.stringify(contract));config.arguments={specs:base,feature:'1.example',all:true};}
  const configPath=path.join(temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  return {temp,project,counter,config,configPath,directory:path.join(temp,'session')};
}
async function client(t,f,respond){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-test-host.mjs'),'serve','--config',f.configPath,'--session-dir',f.directory],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
  let sessionId,seq=0,stderr='';const pending=new Map(),closed=once(child,'close');
  let acceptReady,rejectReady;const ready=new Promise((yes,no)=>{acceptReady=yes;rejectReady=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',bytes=>stderr+=bytes);
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;acceptReady();}
    else if(message.type==='host_request')Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(rejectReady);
    else if(pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)rejectReady(Error(stderr));for(const resolve of pending.values())resolve({closed:code});pending.clear();});
  await ready;
  return {child,request:(operation,fields={})=>new Promise(resolve=>{
    const requestId=`request-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});}),
    close:async()=>{send({type:'host_close',sessionId});const [code]=await closed;assert.equal(code,0,stderr);}};
}
const logic=payload=>({contractDigest:payload.contractDigest,results:[{id:'TC-001',verdict:'SUPPORTED',evidence:[{path:'check.mjs',line:1}],explanation:'Synthetic characterization'}]});
test('CLI resumes original specs run after command; unknown browser never redispatched, evidence and log preserved',{timeout:20000},async t=>{
  const f=fixture(t,{specs:true});let browserResult;
  let c=await client(t,f,(message,child)=>{
    if(message.kind==='qa_logic')return logic(message.payload);
    assert.equal(message.kind,'qa_browser');fs.mkdirSync(message.payload.reportDir,{recursive:true});
    const evidence=path.join(message.payload.reportDir,'browser.md');fs.writeFileSync(evidence,'Synthetic original observation');
    browserResult={verdict:'PASS',evidence:[evidence],environment:message.payload.environment,cleanup:'not_needed'};
    setImmediate(()=>child.kill('SIGKILL'));
  });
  await c.request('start');assert.equal(fs.readFileSync(f.counter,'utf8'),'executed\n');
  c=await client(t,f,()=>assert.fail('prior calls must not redispatch'));
  const status=(await c.request('status')).result;assert.equal(status.pending.kind,'host');assert.ok(status.logFile);
  assert.ok((await c.request('start')).error);
  assert.equal((await c.request('resume',{resolution:null})).result.stage,'interrupted');
  const receipt={...status.pending,result:browserResult,evidence:'Synthetic original browser receipt',cleanup:'completed'};delete receipt.kind;
  assert.equal((await c.request('resume',{resolution:{...receipt,requestDigest:'0'.repeat(64)}})).result.stage,'interrupted');
  const result=(await c.request('resume',{resolution:receipt})).result;
  assert.equal(result.overall,'PASS',JSON.stringify(result));assert.equal(result.runId,status.runId);await c.close();
  assert.equal(fs.readFileSync(f.counter,'utf8'),'executed\n');
  const events=fs.readFileSync(result.logFile,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row=>row.event==='run_start').length,1);assert.equal(events.filter(row=>row.event==='run_done').length,1);
  assert.equal(events.filter(row=>row.event==='resource'&&row.phase==='acquired').length,1);
  c=await client(t,f,()=>assert.fail('completed history is read-only'));
  assert.equal((await c.request('resume',{resolution:null})).result.historical,true);
  fs.appendFileSync(result.report,'changed report');assert.ok((await c.request('resume',{resolution:null})).error);await c.close();
});
test('pending logic rejects source/config drift and cancellation survives another process',{timeout:12000},async t=>{
  const f=fixture(t);let response;
  let c=await client(t,f,(message,child)=>{response=logic(message.payload);setImmediate(()=>child.kill('SIGKILL'));});await c.request('start');
  c=await client(t,f,()=>assert.fail('must not redispatch'));
  const pending=(await c.request('status')).result.pending;
  const target=path.join(f.project,'AGENTS.md');fs.appendFileSync(target,'User change\n');
  const resolution={key:pending.key,requestDigest:pending.requestDigest,result:response,evidence:'Synthetic receipt',cleanup:'completed'};
  assert.equal((await c.request('resume',{resolution})).result.reason,'cm_test_resume_source_changed');
  await c.request('cancel');await c.close();
  c=await client(t,f,()=>assert.fail('cancel persists'));assert.equal((await c.request('status')).result.stage,'cancelled');
  assert.ok((await c.request('resume',{resolution})).error);await c.close();
  fs.writeFileSync(f.configPath,JSON.stringify({...f.config,commands:[]}));
  await assert.rejects(()=>client(t,f,()=>assert.fail()),/cm_test_session_binding_changed/);
  assert.equal(fs.existsSync(f.counter),false);assert.match(fs.readFileSync(target,'utf8'),/User change/);
});
test('recursive initialized submodule snapshot detects dirty content, index and HEAD; missing checkout blocks',t=>{
  const f=fixture(t),repo=path.join(f.temp,'library');fs.mkdirSync(repo);
  const git=(cwd,...args)=>{const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  const commit=cwd=>git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  git(repo,'init','-q');fs.writeFileSync(path.join(repo,'lib.mjs'),'export const value=1;\n');git(repo,'add','.');commit(repo);
  git(f.project,'init','-q');git(f.project,'-c','protocol.file.allow=always','submodule','add',repo,'deps/lib');git(f.project,'add','.');commit(f.project);
  const child=path.join(f.project,'deps/lib'),report=path.join(f.temp,'reports'),file=path.join(child,'lib.mjs');
  const before=snapshotSource(f.project,report);assert.equal(readSourceFiles(f.project,['deps/lib/lib.mjs'],before)[0].path,'deps/lib/lib.mjs');
  fs.writeFileSync(file,'first dirty content');const dirty=snapshotSource(f.project,report);fs.writeFileSync(file,'second dirty content');
  assert.ok(sourceChanges(dirty,snapshotSource(f.project,report)).includes('deps/lib/lib.mjs'));
  git(child,'add','.');const staged=snapshotSource(f.project,report);commit(child);
  assert.ok(sourceChanges(staged,snapshotSource(f.project,report)).includes('deps/lib'));
  fs.renameSync(child,path.join(f.temp,'preserved-checkout'));
  assert.throws(()=>snapshotSource(f.project,report),/cm_test_submodule_uninitialized/);
});
test('unknown command accepts only bound original result after cleanup; it never invokes perform twice',async t=>{
  const f=fixture(t),source=snapshotSource(f.project,path.join(f.temp,'reports')),binding={fixture:'synthetic'};
  let record=openTestSession(f.directory,f.config),calls=0;
  record.initialize({runId:'test-00000000-0000-0000-0000-000000000001',binding,source,inputs:[]});record.begin(source,null);
  const input={command:f.config.commands[0]},original={observed:{id:'check',command:['node','check.mjs'],outcome:'passed',exitCode:0,evidence:'Synthetic recorded exit'},output:['stdout: synthetic']};
  await assert.rejects(()=>record.effect('command',input,()=>{calls++;throw Error('synthetic crash before result persistence');},()=>source));
  const pending=record.pending;record.close();record=openTestSession(f.directory,f.config);record.validate(binding);
  record.begin(source,null);await assert.rejects(()=>record.effect('command',input,()=>assert.fail('must not rerun'),()=>source),/cm_test_outcome_unknown/);
  const receipt={key:pending.key,requestDigest:pending.requestDigest,result:original,evidence:'Synthetic original process exit and cleanup evidence',cleanup:'completed'};
  assert.throws(()=>record.begin(source,{...receipt,cleanup:'unknown'}),/cm_test_resolution_invalid/);
  record.begin(source,receipt);assert.deepEqual(await record.effect('command',input,()=>assert.fail('must not rerun'),()=>source),original);
  record.close();assert.equal(calls,1);
  const saved=fs.readFileSync(path.join(f.directory,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(row=>row.type==='result');
  assert.deepEqual(saved.result.reconciliation,{source:'trusted_host_original_result',key:pending.key,requestDigest:pending.requestDigest,evidence:receipt.evidence,cleanup:'completed'});
});
test('recorded report and closed specs log survive interruption immediately before final progress save',{timeout:12000},async t=>{
  const f=fixture(t,{specs:true});f.config.arguments={...f.config.arguments,all:false,logic:true};
  // Use the same original config on both launches; only execution progress is interrupted.
  fs.writeFileSync(f.configPath,JSON.stringify(f.config));
  let session=openTestSession(f.directory,f.config),calls=0;
  const broken=new Proxy(session,{get:(target,key)=>key==='save'?()=>{throw Error('synthetic crash before final progress');}:Reflect.get(target,key)});
  const host=createCmTestHost(f.config,{session:broken,call:async(kind,payload)=>{calls++;assert.equal(kind,'qa_logic');return logic(payload);}});
  await assert.rejects(async()=>{const result=await host.handle({requestId:'first',operation:'start'});assert.fail(JSON.stringify(result));},/synthetic crash/);
  assert.equal(session.pending,null);assert.equal(session.progress,null);const logFile=session.logFile;
  const logBytes=fs.readFileSync(logFile);session.close();
  const c=await client(t,f,()=>assert.fail('completed effects must not redispatch'));
  const result=(await c.request('resume',{resolution:null})).result;
  assert.equal(result.overall,'REVIEWED',JSON.stringify(result));assert.equal(calls,1);
  assert.ok(fs.readFileSync(logFile).equals(logBytes));assert.ok(fs.readFileSync(result.report,'utf8').includes('REVIEWED'));await c.close();
});
