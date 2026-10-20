// Real owner/driver/native apply and checks; reviewer output is synthetic local
// protocol evidence, never fresh independent review of this implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {protectedResultFixture,implementedValue} from './cm-ai-host-fixture.mjs';
import {digest,JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const BEFORE='original bounded text\n'+'a'.repeat(286000);
const AFTER='updated bounded text\n'+'b'.repeat(286000);
const TEST_BEFORE='export const value = 0;\n'+'// scoped test fixture padding\n'.repeat(140);
const TEST_AFTER='export const value = 1;\n'+'// scoped test fixture padding\n'.repeat(140);
const size=value=>Buffer.byteLength(JSON.stringify(value));
function fixture(t,{revision=false}={}){
  const f=protectedResultFixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const definition=JSON.parse(fs.readFileSync(f.config));definition.scope=revision?['existing.txt','revision.txt']:['existing.txt'];
  fs.writeFileSync(f.config,JSON.stringify(definition));
  fs.writeFileSync(path.join(f.codeProject,'existing.txt'),BEFORE);
  if(revision)fs.writeFileSync(path.join(f.codeProject,'revision.txt'),'export const revision = 1;\n');
  fs.writeFileSync(path.join(f.codeProject,'other-protected.txt'),'preserve me\n');
  const additions=Array.from({length:6},(_,i)=>`tests/added-${i+1}.test.mjs`);
  fs.mkdirSync(path.join(f.codeProject,'tests'));
  for(const name of additions)fs.writeFileSync(path.join(f.codeProject,name),TEST_BEFORE);
  const baselineFile=path.join(f.root,'baseline.json');
  fs.writeFileSync(baselineFile,JSON.stringify({protectedFiles:[additions[0],'other-protected.txt'].map(name=>
    ({path:name,sha256:sha(fs.readFileSync(path.join(f.codeProject,name)))}))}));
  const command=[process.execPath,'-e',
    "const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');"
    +`const scope=new Set(JSON.parse(fs.readFileSync('${f.config}','utf8')).scope);`
    +`const baseline=JSON.parse(fs.readFileSync('${baselineFile}','utf8'));`
    +"for(const file of baseline.protectedFiles){if(scope.has(file.path))continue;assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),file.sha256,'protected file changed: '+file.path);}"
    +`assert.equal(crypto.createHash('sha256').update(fs.readFileSync('existing.txt')).digest('hex'),'${sha(AFTER)}','business invariant');`
    +`for(const name of ${JSON.stringify(additions)})assert.equal(crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex'),'${sha(TEST_AFTER)}','new regression not updated');`];
  // The exact original script and its business assertions must survive. Only
  // its registered scope Set input may be supplemented by the new capability.
  const protectedFile=f.args[f.args.indexOf('--protected-conversation-config')+1];
  fs.writeFileSync(protectedFile,JSON.stringify({timeoutMs:10000,checkCommands:[{id:'check',command}]}));
  const policyFile=path.join(f.root,'POLICY.json'),workflowFile=path.join(f.root,'workflow.json');
  fs.writeFileSync(policyFile,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
  fs.writeFileSync(workflowFile,JSON.stringify({qa:{commands:[{id:'check',caseIds:[],command}],
    environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
  const answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'after.txt'),AFTER);fs.writeFileSync(path.join(answers,'wrong.txt'),'wrong\n');
  fs.writeFileSync(path.join(answers,'test.txt'),TEST_AFTER);
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Synthetic fixture inspected its empty documentation scope'}));
  const deliver=(edits,attempt=1)=>fs.writeFileSync(path.join(answers,attempt===1?'develop.json':`develop-a${attempt}.json`),JSON.stringify({status:'succeeded',value:implementedValue(),edits}));
  deliver({'existing.txt':'after.txt'});
  const basePermissions=['--input-limit','4194304','--review-config',f.reviewFile,'--protected-conversation-config',protectedFile,'--workflow-config',workflowFile];
  const originalPlan=path.join(f.root,'PLAN-original.json');
  fs.writeFileSync(originalPlan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode:'create',
    hostContext:'native-host-fixture',permissions:basePermissions,answers:'answers'}));
  const frozenFiles=[f.config,originalPlan,protectedFile,policyFile,workflowFile,f.reviewFile,baselineFile];
  let planSequence=0;
  const frozen=()=>frozenFiles.map(file=>({path:file,bytes:fs.readFileSync(file)}));
  const stateFile=path.join(f.specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
  const rows=()=>JSON.parse(fs.readFileSync(stateFile)).records;
  const drive=(operation,{mode='resume',registration=false,supplement=true,target,packageDigest}={})=>{
    const permissions=[...basePermissions];
    if(registration){
      fs.writeFileSync(path.join(f.root,'SCOPE.json'),JSON.stringify([...definition.scope,...additions].sort()));
      fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));
      fs.writeFileSync(path.join(f.root,'scope-check.json'),JSON.stringify({version:1,definitionFile:f.config,checkIds:['check']}));
      permissions.push('--revise-scope','SCOPE.json','--scope-revision-reason','Approve six exact test paths',
        '--expected-control','launch.json');
      if(supplement)permissions.push('--scope-check-supplement','scope-check.json');
    }
    const planFile=mode==='create'?originalPlan:path.join(f.root,`PLAN-resume-${++planSequence}.json`);
    if(mode!=='create')fs.writeFileSync(planFile,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode,hostContext:'native-host-fixture',
      permissions,answers:'answers',...(packageDigest?{packageDigest}:{})}));
    const run=spawnSync(process.execPath,[DRIVER,'--plan',planFile,operation],{encoding:'utf8',env:f.env,timeout:30000});
    return {...run,result:run.stdout.trim()?JSON.parse(run.stdout).result:null};
  };
  const begin=()=>{
    const started=drive('start',{mode:'create'});assert.equal(started.status,0,started.stderr);
    assert.equal(started.result.code,'develop_checks_not_passed',JSON.stringify(started.result));
    const before=JSON.parse(fs.readFileSync(stateFile));
    const status=drive('status');assert.equal(status.status,0,status.stderr);
    return {before,target:status.result.launchControlTarget};
  };
  const register=target=>{
    const registered=drive('status',{registration:true,target});assert.equal(registered.status,0,registered.stderr);
    assert.deepEqual(registered.result.effectiveScope,[...definition.scope,...additions].sort());return registered;
  };
  return {...f,definition,additions,protectedFile,policyFile,workflowFile,stateFile,rows,drive,deliver,frozen,begin,register};
}


// This fixture intentionally exceeds inline package+reserve while retaining the
// original 1MiB per journal payload and all full material bytes. Only the new
// protected-supplement path may use the archive representation.
test('large protected supplemented owner archives one full checkpoint and completes with exact package references',async t=>{
  const f=fixture(t),frozen=f.frozen(),{before,target}=f.begin();
  f.register(target);const accepted=JSON.parse(fs.readFileSync(f.stateFile));
  assert.equal(accepted.records.at(-1).payload.type,'scope-revised');
  assert.ok(accepted.records.at(-1).payload.protectedSupplement);
  f.deliver(Object.fromEntries(f.additions.map(file=>[file,'test.txt'])));
  const developed=f.drive('start');
  assert.equal(developed.status,0,developed.stderr);
  assert.equal(developed.result.state,'awaiting_review',JSON.stringify(developed.result)+'\n'+developed.stderr);
  const developedState=JSON.parse(fs.readFileSync(f.stateFile));
  assert.deepEqual(developedState.records.slice(0,accepted.records.length),accepted.records);
  assert.deepEqual(developedState.fingerprints,before.fingerprints);
  const archives=developedState.records.filter(row=>row.payload.packageMaterial===true);
  assert.equal(archives.length,1,'the first full package is retained in one atomic checkpoint');
  const material=archives[0],pkg=material.payload.checkpoint.reviewPackage;
  assert.equal(material.payload.type,'effect-checkpoint');
  assert.equal(material.payload.packageRef,undefined);
  assert.equal(material.payload.checkpoint.state,'awaiting_review');
  assert.ok(size(material.payload)<=JOURNAL_PAYLOAD_LIMIT,'archive itself remains within the original journal limit');
  assert.equal(developedState.records.at(-1).id,material.id,'no separate archive record or second-checkpoint gap');
  const reserve=developCheckpointReserve({examinedPathsBytes:size(reviewPaths(pkg)),receiptsBytes:size(material.payload.checkpoint.receipts),
    callsBytes:size(material.payload.checkpoint.calls),writebackBytes:size(material.payload.checkpoint.learningResult?.writeback??null)});
  assert.ok(size(material.payload)+reserve>JOURNAL_PAYLOAD_LIMIT,'the old inline+review reserve must actually exceed the unchanged limit');
  const originalChange=pkg.changes.find(change=>change.path==='existing.txt');
  assert.equal(Buffer.from(originalChange.before.contentBase64,'base64').toString(),BEFORE);
  assert.equal(Buffer.from(originalChange.after.contentBase64,'base64').toString(),AFTER);
  const fullPackageBytes=JSON.stringify(pkg);
  const approved=f.drive('decision',{packageDigest:developed.result.packageDigest});
  assert.equal(approved.status,0,approved.stderr);assert.equal(approved.result.state,'approved',JSON.stringify(approved.result));
  const completed=f.drive('complete',{packageDigest:approved.result.packageDigest});
  assert.equal(completed.status,0,completed.stderr);assert.equal(completed.result.state,'fixture_completed',JSON.stringify(completed.result));
  const completedState=JSON.parse(fs.readFileSync(f.stateFile));
  const refs=completedState.records.filter(row=>row.payload.packageRef);
  assert.ok(refs.length>=2,'review and completion must use the same archived material');
  for(const row of refs){
    assert.equal(row.payload.type,'effect-checkpoint');assert.equal(row.payload.checkpoint.reviewPackage,null);
    assert.deepEqual(row.payload.packageRef,{recordId:material.id,recordDigest:material.digest,packageDigest:pkg.packageDigest});
  }
  for(const row of completedState.records)assert.ok(size(row.payload)<=JOURNAL_PAYLOAD_LIMIT,'no journal payload limit increase');
  assert.deepEqual(completedState.records.slice(0,accepted.records.length),accepted.records);
  assert.deepEqual(completedState.fingerprints,before.fingerprints);
  const resumed=f.drive('status');assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(resumed.result.state,'fixture_completed',JSON.stringify(resumed.result));
  assert.deepEqual(f.rows(),completedState.records,'normal resume neither rewrites nor repeats work');
  const restored=readRunnerHistory(completedState.records,completedState.records[0].payload.config,3);
  assert.equal(JSON.stringify(restored.state.reviewPackage),fullPackageBytes,'replay restores the exact complete package, not a manifest');
  const qa=f.drive('advance');assert.equal(qa.status,0,qa.stderr);
  assert.match(qa.stderr,/检查结束.*check.*passed/);
  const qaRows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(qaRows.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'));
  const afterQa=f.drive('status');assert.equal(afterQa.status,0,afterQa.stderr);assert.equal(afterQa.result.state,'fixture_completed');
  assert.deepEqual(f.frozen(),frozen,'all original configurations, commands and fixed inputs remain exact');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).fingerprints,before.fingerprints);
  await t.test('resealed wrong material reference is rejected by pure replay without running another owner',()=>{
    const rows=structuredClone(completedState.records),row=rows.findLast(entry=>entry.payload.packageRef);
    row.payload.packageRef.recordDigest='0'.repeat(64);
    for(let i=0;i<rows.length;i++){
      const {digest:discard,...body}=rows[i];body.previousDigest=i?rows[i-1].digest:null;rows[i]={...body,digest:digest(body)};
    }
    assert.throws(()=>readRunnerHistory(rows,completedState.records[0].payload.config,3));
  });
});


test('supplemented capacity owner preserves r1 changes_requested through failed r2 and finishes the original second attempt',t=>{
  const f=fixture(t,{revision:true}),frozen=f.frozen(),{before,target}=f.begin();f.register(target);
  const originalRecords=f.rows();
  // Reuse the existing synthetic protocol fixture. Only review output is
  // synthetic; the original wrapper still delegates sandbox to actual Codex.
  const originalSource=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
  const fake=fs.readFileSync(originalSource,'utf8')
    .replace("verdict:'approved'","verdict:data.reviewPackage.identity.attempt===1?'changes_requested':'approved'")
    .replace('findings:[]',"findings:data.reviewPackage.identity.attempt===1?[{id:'capacity-r1',severity:'P2',path:'revision.txt',message:'Synthetic r2 requested',evidence:'Synthetic protocol contract only'}]:[]");
  const fakeSource=path.join(f.root,'capacity-r2-review.mjs');fs.writeFileSync(fakeSource,fake);
  const wrapper=path.join(f.root,'synthetic-review-bin','codex'),wrapperBytes=fs.readFileSync(wrapper,'utf8');
  const originalUrl=new URL('file://'+originalSource).href;
  assert.equal(wrapperBytes.split(JSON.stringify(originalUrl)).length,2,'replace only the registered review fixture import');
  fs.writeFileSync(wrapper,wrapperBytes.replace(JSON.stringify(originalUrl),JSON.stringify(new URL('file://'+fakeSource).href)),{mode:0o700});
  f.deliver(Object.fromEntries(f.additions.map(file=>[file,'test.txt'])));
  const developed=f.drive('start');assert.equal(developed.status,0,developed.stderr);
  assert.equal(developed.result.state,'awaiting_review',JSON.stringify(developed.result));
  const r1Rows=f.rows(),r1Material=r1Rows.find(row=>row.payload.packageMaterial===true);
  assert.ok(r1Material);const pkg1=r1Material.payload.checkpoint.reviewPackage;
  assert.ok(size(r1Material.payload)+developCheckpointReserve({examinedPathsBytes:size(reviewPaths(pkg1))})>JOURNAL_PAYLOAD_LIMIT);
  assert.ok(size(r1Material.payload)<=JOURNAL_PAYLOAD_LIMIT);
  const rejected=f.drive('decision',{packageDigest:developed.result.packageDigest});
  assert.equal(rejected.status,0,rejected.stderr);
  assert.equal(rejected.result.state,'changes_requested',JSON.stringify(rejected.result)+'\n'+rejected.stderr);
  assert.equal(rejected.result.identity.attempt,2);
  const rejectedRows=f.rows(),rejectedReplay=readRunnerHistory(rejectedRows,rejectedRows[0].payload.config,3);
  assert.equal(rejectedReplay.state.attempt,2);assert.equal(rejectedReplay.state.reviewPackage.packageDigest,pkg1.packageDigest);
  assert.deepEqual(rejectedRows.slice(0,r1Rows.length),r1Rows,'r1 material/registration/result history is immutable');
  f.deliver({'existing.txt':'wrong.txt'},2);
  const failed=f.drive('start');assert.equal(failed.status,0,failed.stderr);
  assert.equal(failed.result.state,'blocked',JSON.stringify(failed.result));assert.equal(failed.result.code,'develop_checks_not_passed');
  const failedRows=f.rows(),failedReplay=readRunnerHistory(failedRows,failedRows[0].payload.config,3);
  assert.equal(failedReplay.state.attempt,2);assert.equal(failedReplay.state.reviewPackage.packageDigest,pkg1.packageDigest);
  assert.equal(f.drive('status').status,0,'failed r2 checkpoint must remain resumable instead of poisoning the store');
  fs.writeFileSync(path.join(f.root,'answers','revision-after.txt'),'export const revision = 2;\n');
  f.deliver({'existing.txt':'after.txt','revision.txt':'revision-after.txt'},2);
  const second=f.drive('start');assert.equal(second.status,0,second.stderr);
  assert.equal(second.result.state,'awaiting_review',JSON.stringify(second.result)+'\n'+second.stderr);
  const secondRows=f.rows(),materials=secondRows.filter(row=>row.payload.packageMaterial===true);
  assert.equal(materials.length,2,'r2 archives its own complete exact package');
  const pkg2=materials[1].payload.checkpoint.reviewPackage;
  assert.equal(pkg2.identity.attempt,2);assert.notEqual(pkg2.packageDigest,pkg1.packageDigest);
  assert.equal(Buffer.from(pkg2.changes.find(c=>c.path==='existing.txt').before.contentBase64,'base64').toString(),BEFORE);
  assert.equal(Buffer.from(pkg2.changes.find(c=>c.path==='existing.txt').after.contentBase64,'base64').toString(),AFTER);
  const approved=f.drive('decision',{packageDigest:second.result.packageDigest});assert.equal(approved.status,0,approved.stderr);
  assert.equal(approved.result.state,'approved',JSON.stringify(approved.result));
  const completed=f.drive('complete',{packageDigest:approved.result.packageDigest});assert.equal(completed.status,0,completed.stderr);
  assert.equal(completed.result.state,'fixture_completed',JSON.stringify(completed.result)+'\n'+completed.stderr);
  const finalRows=f.rows();for(const row of finalRows)assert.ok(size(row.payload)<=JOURNAL_PAYLOAD_LIMIT);
  assert.deepEqual(finalRows.slice(0,originalRecords.length),originalRecords);assert.deepEqual(f.frozen(),frozen);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).fingerprints,before.fingerprints);
  const resumed=f.drive('status');assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.result.identity.attempt,2);
  assert.equal(resumed.result.state,'fixture_completed');assert.deepEqual(f.rows(),finalRows);
});
