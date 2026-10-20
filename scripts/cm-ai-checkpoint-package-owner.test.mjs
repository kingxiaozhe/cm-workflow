// Real owner/driver and local checks; reviewer output is synthetic protocol
// evidence, never independent review of this implementation. No Codex sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest,JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {readRunJournal,developPreview} from './cm-ai-drive.mjs';
const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const REVIEWER=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const developValue={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const size=value=>Buffer.byteLength(JSON.stringify(value??null));
const CONTENT='//'+'x'.repeat(594000)+'\n';
function fixture(t,{scope=['target.mjs'],runId='drive-gaps-run',files={}}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),feature='1.work';
  const identity={repositoryId:'drive-gaps',runId,taskId:'T-001',attempt:1};
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  for(const [file,content] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(codeProject,file)),{recursive:true});
    fs.writeFileSync(path.join(codeProject,file),content);fs.chmodSync(path.join(codeProject,file),0o644);
  }
  const config=path.join(root,'run.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope,requirements:['requirements.md']}));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);
  // create requires a bound review configuration; reviewer() replaces it with the
  // same model and a real preflight, so the durable fingerprint is unchanged.
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{}}));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
    CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const content=(name,bytes)=>fs.writeFileSync(path.join(answers,name),bytes);
  const develop=(edits,name='develop.json')=>write(name,{status:'succeeded',value:developValue,edits});
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    const value={config:'run.json',mode:'create',hostContext:'drive-host-a',
      permissions:[],answers:'answers',checks:[{id:'noop',command:[process.execPath,'-e','0']}],...extra};
    if(!value.permissions.includes('--review-config'))value.permissions=[...value.permissions,'--review-config','review.json'];
    fs.writeFileSync(file,JSON.stringify(value));
    return file;};
  const drive=(file,operation,timeout=60000,umask=null)=>umask===null
    ?spawnSync(process.execPath,[DRIVER,'--plan',file,operation],{encoding:'utf8',timeout,env})
    :spawnSync('/bin/sh',['-c',`umask ${umask}; exec "$0" "$@"`,process.execPath,DRIVER,'--plan',file,operation],{encoding:'utf8',timeout,env});
  const store=path.join(specsDir,'.reviews','.execution',runId,'state.json');
  const reviewer=verdict=>{
    let fake=fs.readFileSync(REVIEWER,'utf8');
    if(verdict==='changes_requested')fake=fake.replace("verdict:'approved'","verdict:data.reviewPackage.identity.attempt===1?'changes_requested':'approved'")
      .replace('findings:[]',"findings:data.reviewPackage.identity.attempt===1?[{id:'F1',severity:'P2',path:'"+scope[0]+"',message:'Revise',evidence:'Fixture finding'}]:[]");
    fs.writeFileSync(path.join(bin,'codex'),fake,{mode:0o700});
    fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,
      cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  };
  reviewer('approved');
  return {root,specsDir,codeProject,config,answers,bin,env,identity,write,content,develop,plan,drive,store,reviewer};
}
const result=run=>JSON.parse(run.stdout).result;
const records=f=>JSON.parse(fs.readFileSync(f.store,'utf8')).records;

function capacityFixture(t){
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});
  fs.writeFileSync(path.join(f.root,'control.json'),JSON.stringify(policy));
  f.content('target.txt',CONTENT);f.develop({'target.mjs':'target.txt'});
  return f;
}
// SIGKILL the actual owner after its persisted reply, before host_close. Resume
// must release the stale writer and replay the same records without redoing work.
function developAndKill(f,{enabled=true}={}){
  return new Promise((resolve,reject)=>{
    const args=['serve','--config',f.config,'--mode','create','--host-context','drive-host-a',
      ...(enabled?['--control-config',path.join(f.root,'control.json')]:['--allow-development']),
      '--review-config',path.join(f.root,'review.json')];
    const child=spawn(process.execPath,[HOST,...args],{env:f.env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',reply=null,failed=null;
    const timer=setTimeout(()=>{failed=new Error('capacity owner timed out');child.kill('SIGKILL');},30000);
    const send=row=>child.stdin.write(JSON.stringify(row)+'\n');
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      try{let index;while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const row=JSON.parse(line);
        if(row.type==='host_ready')send({version:enabled?2:1,operation:'start',requestId:'capacity',identity:f.identity});
        if(row.type==='host_request'){
          let result;
          if(row.kind==='develop'){fs.writeFileSync(path.join(f.codeProject,'target.mjs'),CONTENT);result={status:'succeeded',value:developValue};}
          else{
            assert.equal(row.kind,'check');
            const command=[process.execPath,'--check',path.join(f.codeProject,'target.mjs')];
            const checked=spawnSync(command[0],command.slice(1),{encoding:'utf8',timeout:3000});assert.equal(checked.status,0,checked.stderr);
            result=[{id:'noop',command,outcome:'passed',exitCode:0,evidence:'Actual isolated syntax check passed'}];
          }
          send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
        }
        if(row.requestId==='capacity'&&row.result){reply=row.result;child.kill('SIGKILL');}
      }}catch(error){failed=error;child.kill('SIGKILL');}
    });
    child.on('close',(code,signal)=>{clearTimeout(timer);
      if(failed)reject(failed);else if(!reply)reject(new Error('owner exited without reply: '+stderr));
      else {assert.equal(signal,'SIGKILL');resolve(reply);}
    });
  });
}

test('review-capacity: eligible 800 KB-class delivery exceeds inline reserve, survives owner kill, review and completion',async t=>{
  const f=capacityFixture(t),developed=await developAndKill(f);
  t.diagnostic(JSON.stringify({state:developed.state,code:developed.code,reason:developed.reason}));
  assert.equal(developed.state,'awaiting_review',JSON.stringify(developed));
  const developedRows=records(f),material=developedRows.at(-1),checkpoint=material.payload.checkpoint;
  assert.equal(material.payload.packageMaterial,true);
  assert.equal(material.payload.type,'effect-checkpoint');
  const pkg=checkpoint.reviewPackage,fullPackageBytes=JSON.stringify(pkg);
  const reserve=developCheckpointReserve({examinedPathsBytes:size(reviewPaths(pkg)),receiptsBytes:size(checkpoint.receipts),
    callsBytes:size(checkpoint.calls),writebackBytes:size(checkpoint.learningResult?.writeback)});
  assert(size(material.payload)>JOURNAL_PAYLOAD_LIMIT-reserve);
  assert(size(material.payload)<=JOURNAL_PAYLOAD_LIMIT);
  assert.equal(Buffer.from(pkg.changes.find(c=>c.path==='target.mjs').after.contentBase64,'base64').toString(),CONTENT);
  t.diagnostic(JSON.stringify({developBytes:size(material.payload),reserve,budget:JOURNAL_PAYLOAD_LIMIT-reserve}));
  const resume={mode:'resume',controlConfig:'control.json',checks:undefined};
  const status=f.drive(f.plan(resume),'status');assert.equal(status.status,0,status.stderr);
  assert.equal(result(status).state,'awaiting_review');assert.deepEqual(records(f),developedRows);
  const approved=f.drive(f.plan({...resume,packageDigest:developed.packageDigest}),'decision');
  assert.equal(approved.status,0,approved.stderr);assert.equal(result(approved).state,'approved',approved.stdout);
  const completed=f.drive(f.plan({...resume,packageDigest:developed.packageDigest,
    checks:[{id:'noop',command:[process.execPath,'--check',path.join(f.codeProject,'target.mjs')]}]}),'complete');
  assert.equal(completed.status,0,completed.stderr);assert.equal(result(completed).state,'fixture_completed',completed.stdout);
  const completedRows=records(f),refs=completedRows.filter(row=>row.payload.packageRef);
  assert(refs.length>=2);
  for(const row of refs){assert.equal(row.payload.checkpoint.reviewPackage,null);
    assert.deepEqual(row.payload.packageRef,{recordId:material.id,recordDigest:material.digest,packageDigest:pkg.packageDigest});}
  for(const row of completedRows)assert(size(row.payload)<=JOURNAL_PAYLOAD_LIMIT);
  assert.deepEqual(completedRows.slice(0,developedRows.length),developedRows);
  const restored=readRunnerHistory(completedRows,completedRows[0].payload.config,3);
  assert.equal(JSON.stringify(restored.state.reviewPackage),fullPackageBytes);
  const final=f.drive(f.plan(resume),'status');assert.equal(final.status,0,final.stderr);
  assert.equal(result(final).state,'fixture_completed');assert.deepEqual(records(f),completedRows);
  t.diagnostic(JSON.stringify({maxPayloadBytes:Math.max(...completedRows.map(row=>size(row.payload))),referenceCount:refs.length}));
  const damaged=structuredClone(completedRows),row=damaged.findLast(entry=>entry.payload.packageRef);
  row.payload.packageRef.recordDigest='0'.repeat(64);
  for(let i=0;i<damaged.length;i++){const {digest:discard,...body}=damaged[i];body.previousDigest=i?damaged[i-1].digest:null;damaged[i]={...body,digest:digest(body)};}
  assert.throws(()=>readRunnerHistory(damaged,completedRows[0].payload.config,3),{code:'checkpoint_package_material_invalid'});
  // Replay refuses the stored representation for a run that is not eligible. The
  // prefix ends at the material checkpoint, so no later packageRef can fail first.
  const forged=structuredClone(developedRows);forged[0].payload.config.controlPolicy.development='provider';
  for(let i=0;i<forged.length;i++){const {digest:discard,...body}=forged[i];body.previousDigest=i?forged[i-1].digest:null;forged[i]={...body,digest:digest(body)};}
  assert.throws(()=>readRunnerHistory(forged,forged[0].payload.config,3),{code:'checkpoint_package_material_invalid'});
});

test('review-capacity: ineligible legacy run with the identical delivery still blocks develop_package_too_large',async t=>{
  const f=capacityFixture(t),blocked=await developAndKill(f,{enabled:false});
  assert.equal(blocked.state,'blocked');assert.equal(blocked.code,'develop_package_too_large');
  const [,bytes,budget]=/checkpoint would be (\d+) bytes, above (\d+)/.exec(blocked.reason).map(Number);
  assert(bytes>budget&&bytes<=JOURNAL_PAYLOAD_LIMIT);
  assert(records(f).every(row=>!Object.hasOwn(row.payload,'packageMaterial')&&!Object.hasOwn(row.payload,'packageRef')));
  const restored=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.equal(restored.state.code,'develop_package_too_large');
  t.diagnostic(JSON.stringify({bytes,budget,code:blocked.code}));
});

test('review-capacity: resume driver and owner admit the same large eligible delivery',t=>{
  const f=capacityFixture(t);
  const created=f.drive(f.plan({controlConfig:'control.json'}),'status');assert.equal(created.status,0,created.stderr);
  const started=f.drive(f.plan({mode:'resume',controlConfig:'control.json'}),'start');
  assert.equal(started.status,0,started.stderr);assert.equal(result(started).state,'awaiting_review',started.stdout);
  assert.equal(records(f).at(-1).payload.packageMaterial,true);
  // The driver budgets an already archived package as a reference, so its digest
  // must reach the preview from the real journal, not only exist in the store.
  const definition=JSON.parse(fs.readFileSync(f.config,'utf8')),journal=readRunJournal(definition);
  const archived=[records(f).at(-1).payload.checkpoint.reviewPackage.packageDigest];
  assert.equal(journal.packageMaterialEnabled,true);assert.deepEqual(journal.archivedPackageDigests,archived);
  assert.deepEqual(developPreview({definition,journal}).archivedPackageDigests,archived);
});


test('review-capacity: create driver and owner also admit the same eligible delivery without an existing journal',t=>{
  const f=capacityFixture(t),started=f.drive(f.plan({controlConfig:'control.json'}),'start');
  assert.equal(started.status,0,started.stderr);assert.equal(result(started).state,'awaiting_review',started.stdout);
  assert.equal(records(f).at(-1).payload.packageMaterial,true);
});
