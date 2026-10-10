// External answer gaps, batch 3 (O21): in --session-dir mode a refused or lost
// change_impact/test_cases answer is discarded and asked again (V1); qa_logic and
// qa_browser also need cleanup:"completed" (V4). Main paths drive cm-test-host.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {openTestSession} from '../runtime/js/cm-test/session.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const item=(id,kind)=>({id,kind,origin:'user',blocking:true,acIds:[],taskIds:[],title:'Synthetic behavior',preconditions:[],steps:['Observe'],expected:['Expected result'],cleanup:[]});
function fixture(t,{generate=false}={}){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-test-gaps-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  fs.writeFileSync(path.join(project,'input.mjs'),'export const valid = value => value !== null;\n');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Synthetic project\n');
  const cases=path.join(temp,'cases.json'),contract={schemaVersion:'1.0',feature:'example',cases:[item('TC-001','logic'),item('TC-002','browser')]};
  fs.writeFileSync(cases,JSON.stringify(contract));
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',
    arguments:generate?{description:'Validation',generateCases:true}:{cases,logic:true,browser:true},sources:['input.mjs','AGENTS.md'],commands:[],
    environment:{scope:'local',kind:'web',carrier:'browser',target:'http://127.0.0.1:3000'},logHome:path.join(temp,'logs')};
  const configPath=path.join(temp,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));
  return {temp,project,config,configPath,contract,directory:path.join(temp,'session')};
}
async function client(t,f,respond){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-test-host.mjs'),'serve','--config',f.configPath,'--session-dir',f.directory],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&!child.killed)child.kill();});
  let sessionId,seq=0,stderr='';const pending=new Map(),closed=once(child,'close'),asked=[];
  let acceptReady,rejectReady;const ready=new Promise((yes,no)=>{acceptReady=yes;rejectReady=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');child.stderr.on('data',bytes=>stderr+=bytes);
  createInterface({input:child.stdout}).on('line',line=>{
    const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;acceptReady();}
    else if(message.type==='host_request'){asked.push(message);Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(rejectReady);}
    else if(pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)rejectReady(Error(stderr));for(const resolve of pending.values())resolve({closed:code});pending.clear();});
  await ready;
  return {child,asked,request:(operation,fields={})=>new Promise(resolve=>{
    const requestId=`request-${++seq}`;pending.set(requestId,resolve);send({requestId,operation,...fields});}),
    close:async()=>{send({type:'host_close',sessionId});const [code]=await closed;assert.equal(code,0,stderr);}};
}
const logic=payload=>({contractDigest:payload.contractDigest,results:[{id:'TC-001',verdict:'SUPPORTED',evidence:[{path:'input.mjs',line:1}],explanation:'Synthetic characterization'}]});
const browser=payload=>{fs.mkdirSync(payload.reportDir,{recursive:true});const evidence=path.join(payload.reportDir,'browser.md');
  fs.writeFileSync(evidence,'Synthetic observation');return {verdict:'PASS',evidence:[evidence],environment:payload.environment,cleanup:'not_needed'};};
const rows=f=>fs.readFileSync(path.join(f.directory,'execution.jsonl'),'utf8').trimEnd().split('\n').map(JSON.parse);

test('real host V1: a refused test_cases answer is discarded and asked again; the run reports GENERATED',{timeout:30000},async t=>{
  const f=fixture(t,{generate:true});let bad=1;
  const respond=()=>bad-->0?{contract:{schemaVersion:'1.0'},report:'x'}:{contract:f.contract,report:'# Generation\nScope: synthetic.'};
  let c=await client(t,f,respond);
  const first=(await c.request('start')).result;assert.equal(first.stage,'interrupted');assert.equal(first.reason,'cm_test_contract_invalid');
  assert.equal(first.recovery.lastAnswer.kind,'test_cases');assert.match(first.guidance.nextStep,/discard:true/);await c.close();
  c=await client(t,f,respond);
  assert.equal((await c.request('resume',{resolution:null})).result.reason,'cm_test_contract_invalid');assert.equal(c.asked.length,0);
  const {key,requestDigest}=(await c.request('status')).result.recovery.lastAnswer;
  const done=(await c.request('resume',{resolution:{key,requestDigest,discard:true,evidence:'contract had no cases'}})).result;
  assert.equal(done.overall,'GENERATED',JSON.stringify(done));assert.equal(c.asked.length,1);await c.close();
  const discard=rows(f).find(row=>row.type==='discard');assert.equal(discard.kind,'test_cases');assert.equal(discard.released,null);
});

test('real host V4: a lost qa_browser answer is re-asked only after cleanup:"completed" is recorded',{timeout:30000},async t=>{
  const f=fixture(t);
  let c=await client(t,f,(message,child)=>{if(message.kind==='qa_logic')return logic(message.payload);setImmediate(()=>child.kill('SIGKILL'));});
  await c.request('start');
  c=await client(t,f,message=>browser(message.payload));
  const status=(await c.request('status')).result;
  const unknown=status.recovery.unknown[0];assert.equal(unknown.callKind,'qa_browser');
  assert.match(status.guidance.nextStep,/设备可能仍在使用/);
  const binding={key:unknown.key,requestDigest:unknown.requestDigest,discard:true,evidence:'session lost the browser case'};
  const refused=(await c.request('resume',{resolution:binding})).result;
  assert.equal(refused.reason,'cm_test_resource_release_required');assert.equal(c.asked.length,0);
  const done=(await c.request('resume',{resolution:{...binding,cleanup:'completed'}})).result;
  // Static logic alone is not execution PASS, so overall stays BLOCKED; the re-asked browser case passed.
  assert.equal(done.stage,'reported',JSON.stringify(done));assert.equal(done.rows.find(row=>row.kind==='browser').verdict,'PASS');
  assert.deepEqual(c.asked.map(item=>item.kind),['qa_browser']);await c.close();
  const discard=rows(f).find(row=>row.type==='discard');
  assert.equal(discard.reason,'answer_missing');assert.equal(discard.released.source,'operator_confirmed');
});

test('a recorded invalid qa_logic answer also needs release before it is asked again; the limit is two',{timeout:30000},async t=>{
  const f=fixture(t);let bad=3;
  const respond=message=>message.kind==='qa_logic'?(bad-->0?{contractDigest:message.payload.contractDigest,results:[]}:logic(message.payload)):browser(message.payload);
  const c=await client(t,f,respond);
  assert.equal((await c.request('start')).result.stage,'interrupted');
  for(let n=1;n<=3;n++){
    const {key,requestDigest}=(await c.request('status')).result.recovery.lastAnswer;
    const result=(await c.request('resume',{resolution:{key,requestDigest,discard:true,evidence:'no results',cleanup:'completed'}})).result;
    assert.equal(result.stage,'interrupted');if(n===3)assert.equal(result.reason,'cm_test_discard_limit');
  }
  assert.equal(c.asked.filter(item=>item.kind==='qa_logic').length,3);await c.close();
});

test('replay refuses a qa discard without a release, a forged digest and a third discard; an old journal is unchanged',{timeout:30000},async t=>{
  const f=fixture(t,{generate:true});
  let c=await client(t,f,()=>({contract:{schemaVersion:'1.0'},report:'x'}));await c.request('start');await c.close();
  const file=path.join(f.directory,'execution.jsonl'),base=fs.readFileSync(file,'utf8'),list=rows(f);
  const intent=list.filter(row=>row.type==='intent').at(-1),result=list.find(row=>row.type==='result'&&row.key===intent.key);
  const append=body=>{const all=rows(f),row={...body,previous:all.at(-1).hash};fs.appendFileSync(file,JSON.stringify({...row,hash:digest(row)})+'\n');};
  const good={type:'discard',key:intent.key,kind:'test_cases',reason:'answer_rejected',attempt:1,requestDigest:digest(intent.input),resultDigest:digest(result.result),
    evidence:{sha256:digest('x'),length:1},released:null,at:'2026-10-09T00:00:00.000Z'};
  const open=()=>{const session=openTestSession(f.directory,f.config);session.close();};
  for(const [name,row] of Object.entries({forgedDigest:{...good,resultDigest:'0'.repeat(64)},
    releaseOnReadOnly:{...good,released:{source:'operator_confirmed',evidence:digest('y')}},qaKind:{...good,kind:'qa_browser'}})){
    fs.writeFileSync(file,base,{mode:0o600});append(row);assert.throws(open,/refactor_journal_invalid/,name);
  }
  fs.writeFileSync(file,base,{mode:0o600});append(good);assert.doesNotThrow(open);
  fs.writeFileSync(file,base,{mode:0o600});
  c=await client(t,f,()=>assert.fail('recorded answers replay'));
  assert.equal((await c.request('resume',{resolution:null})).result.reason,'cm_test_contract_invalid');await c.close();
  assert.equal(fs.readFileSync(file,'utf8'),base);
  // Driver: discarding the recorded test_cases answer re-asks it from the answer file.
  const plan=path.join(f.temp,'plan.json');
  fs.writeFileSync(plan,JSON.stringify({config:'config.json',sessionDir:'session',answers:'answers',
    resolution:{key:intent.key,requestDigest:digest(intent.input),discard:true,evidence:'x'}}));
  fs.mkdirSync(path.join(f.temp,'answers'));fs.writeFileSync(path.join(f.temp,'answers/test-cases.json'),JSON.stringify({contract:f.contract,report:'# r'}));
  const ok=spawnSync(process.execPath,[path.join(root,'scripts/cm-test-drive.mjs'),'--plan',plan,'resume'],{encoding:'utf8',
    env:{...process.env}});
  assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/GENERATED/);
});

test('notify classifies cm-test discard blocks as stuck',async()=>{
  const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
  for(const reason of ['cm_test_resource_release_required','cm_test_discard_limit','cm_test_contract_invalid'])
    assert.equal(classifyDriveResult('cm-test',{result:{stage:'interrupted',reason,recovery:{discards:[],lastAnswer:null,unknown:[]}}}),'stuck',reason);
});

test('real host: after a qa_browser discard, the late receipt of the discarded attempt is refused; the receipt of the new attempt is accepted',{timeout:30000},async t=>{
  const f=fixture(t);let first;
  let c=await client(t,f,(message,child)=>{if(message.kind==='qa_logic')return logic(message.payload);first=message;setImmediate(()=>child.kill('SIGKILL'));});
  await c.request('start');
  c=await client(t,f,(message,child)=>{setImmediate(()=>child.kill('SIGKILL'));});
  const old=(await c.request('status')).result.pending;
  await c.request('resume',{resolution:{key:old.key,requestDigest:old.requestDigest,discard:true,evidence:'lost',cleanup:'completed'}});
  c=await client(t,f,()=>assert.fail('receipts only'));
  const now=(await c.request('status')).result;
  assert.equal(now.recovery.unknown[0].attempt,2);assert.notEqual(now.pending.requestDigest,old.requestDigest);
  const late={key:old.key,requestDigest:old.requestDigest,result:browser(first.payload),evidence:'late receipt of attempt 1',cleanup:'completed'};
  assert.equal((await c.request('resume',{resolution:late})).result.reason,'cm_test_resolution_abandoned');
  const done=(await c.request('resume',{resolution:{...late,requestDigest:now.pending.requestDigest,evidence:'receipt of attempt 2'}})).result;
  assert.equal(done.stage,'reported',JSON.stringify(done));await c.close();
  const reask=rows(f).filter(row=>row.type==='intent'&&row.key===old.key);
  assert.deepEqual(reask.map(row=>row.attempt??1),[1,2]);
});
