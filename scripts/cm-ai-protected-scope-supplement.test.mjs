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
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,{scopeInput=true}={}){
  const f=protectedResultFixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const definition=JSON.parse(fs.readFileSync(f.config));definition.scope=['existing.txt'];
  fs.writeFileSync(f.config,JSON.stringify(definition));
  fs.writeFileSync(path.join(f.codeProject,'existing.txt'),'before\n');
  fs.writeFileSync(path.join(f.codeProject,'other-protected.txt'),'preserve me\n');
  const additions=Array.from({length:6},(_,i)=>`tests/added-${i+1}.test.mjs`);
  fs.mkdirSync(path.join(f.codeProject,'tests'));
  for(const name of additions)fs.writeFileSync(path.join(f.codeProject,name),'export const value = 0;\n');
  const baselineFile=path.join(f.root,'baseline.json');
  fs.writeFileSync(baselineFile,JSON.stringify({protectedFiles:[additions[0],'other-protected.txt'].map(name=>
    ({path:name,sha256:sha(fs.readFileSync(path.join(f.codeProject,name)))})).filter(row=>scopeInput||row.path==='other-protected.txt')}));
  const command=[process.execPath,'-e',
    "const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');"
    +(scopeInput?`const scope=new Set(JSON.parse(fs.readFileSync('${f.config}','utf8')).scope);`:'')
    +`const baseline=JSON.parse(fs.readFileSync('${baselineFile}','utf8'));`
    +"for(const file of baseline.protectedFiles){"+(scopeInput?"if(scope.has(file.path))continue;":"")+"assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'),file.sha256,'protected file changed: '+file.path);}"
    +`assert.equal(fs.readFileSync('existing.txt','utf8'),${JSON.stringify('after\n')},'business invariant');`
    +`for(const name of ${JSON.stringify(additions)})assert.equal(fs.readFileSync(name,'utf8'),${JSON.stringify('export const value = 1;\n')},'new regression not updated');`];
  // The exact original script and its business assertions must survive. Only
  // its registered scope Set input may be supplemented by the new capability.
  const protectedFile=f.args[f.args.indexOf('--protected-conversation-config')+1];
  fs.writeFileSync(protectedFile,JSON.stringify({timeoutMs:10000,checkCommands:[{id:'check',command}]}));
  const policyFile=path.join(f.root,'POLICY.json'),workflowFile=path.join(f.root,'workflow.json');
  fs.writeFileSync(policyFile,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
  fs.writeFileSync(workflowFile,JSON.stringify({qa:{commands:[{id:'check',caseIds:[],command}],
    environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
  const answers=path.join(f.root,'answers');fs.mkdirSync(answers);
  fs.writeFileSync(path.join(answers,'after.txt'),'after\n');fs.writeFileSync(path.join(answers,'wrong.txt'),'wrong\n');
  fs.writeFileSync(path.join(answers,'test.txt'),'export const value = 1;\n');
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Synthetic fixture inspected its empty documentation scope'}));
  const deliver=edits=>fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:implementedValue(),edits}));
  deliver({'existing.txt':'after.txt'});
  const basePermissions=['--review-config',f.reviewFile,'--protected-conversation-config',protectedFile,'--workflow-config',workflowFile];
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
      fs.writeFileSync(path.join(f.root,'scope-check.json'),JSON.stringify({version:1,definitionFile:f.config,checkIds:scopeInput?['check']:[]}));
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

for(const scopeInput of [true,false])test(scopeInput?'native protected owner appends six scoped tests and check supplement without rewriting frozen inputs'
  :'native protected owner appends scope with unchanged checks and no scope input through completion QA and resume',t=>{
  const f=fixture(t,{scopeInput}),frozen=f.frozen(),{before,target}=f.begin(),productBefore=fs.readFileSync(path.join(f.codeProject,'existing.txt'));
  const beforeLegacy=fs.readFileSync(f.stateFile);
  const legacy=f.drive('status',{registration:true,supplement:false,target});
  assert.notEqual(legacy.status,0,'the legacy protected recovery route must remain unavailable without an explicit supplement');
  assert.match(legacy.stderr,/recovery_launch_unavailable|scope_revision_unavailable/);
  assert.deepEqual(fs.readFileSync(f.stateFile),beforeLegacy,'refusal must leave all original records byte exact');
  f.register(target);
  const revised=JSON.parse(fs.readFileSync(f.stateFile));
  assert.deepEqual(revised.fingerprints,before.fingerprints);
  assert.deepEqual(revised.records.slice(0,before.records.length),before.records);
  assert.equal(revised.records.length,before.records.length+1,'registration must append one bounded recovery record');
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,'existing.txt')),productBefore,'registration must not execute development or checks');
  for(const file of f.additions)assert.equal(fs.readFileSync(path.join(f.codeProject,file),'utf8'),'export const value = 0;\n');
  // A normal resume carries the original config only: it must derive the
  // effective scope and check supplement from its accepted append-only record.
  const status=f.drive('status');assert.equal(status.status,0,status.stderr);
  assert.deepEqual(status.result.effectiveScope,[...f.definition.scope,...f.additions].sort());
  f.deliver(Object.fromEntries(f.additions.map(file=>[file,'test.txt'])));
  const developed=f.drive('start');assert.equal(developed.status,0,developed.stderr);
  assert.equal(developed.result.state,'awaiting_review',JSON.stringify(developed.result)+'\n'+developed.stderr);
  const pkg=f.rows().findLast(row=>row.payload.type==='effect-checkpoint').payload.checkpoint.reviewPackage;
  assert.deepEqual(pkg.scope,['AGENTS.md',...f.definition.scope,...f.additions].sort(),
    'Learning review visibility includes AGENTS.md without granting it to the developer');
  assert.deepEqual(pkg.changes.map(change=>change.path),[...f.definition.scope,...f.additions].sort());
  const approved=f.drive('decision',{packageDigest:developed.result.packageDigest});assert.equal(approved.status,0,approved.stderr);
  assert.equal(approved.result.state,'approved',JSON.stringify(approved.result));
  const completed=f.drive('complete',{packageDigest:approved.result.packageDigest});assert.equal(completed.status,0,completed.stderr);
  assert.equal(completed.result.state,'fixture_completed',JSON.stringify(completed.result));
  const completedRows=f.rows(),completedResume=f.drive('status');
  assert.equal(completedResume.status,0,completedResume.stderr);
  assert.equal(completedResume.result.state,'fixture_completed',JSON.stringify(completedResume.result));
  assert.deepEqual(completedResume.result.effectiveScope,[...f.definition.scope,...f.additions].sort());
  assert.deepEqual(f.rows(),completedRows,'normal completed resume must not append or repeat development');
  const qa=f.drive('advance');assert.equal(qa.status,0,qa.stderr);
  assert.match(qa.stderr,/检查结束.*check.*passed/,'QA must actually execute the original projected guard command');
  const qaRows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(qaRows.some(row=>row.node==='N6'&&row.event==='test_run'&&row.phase==='complete'&&row.result==='PASS'),
    'the original owner must accept the actual N6 commands QA result');
  const afterQaResume=f.drive('status');assert.equal(afterQaResume.status,0,afterQaResume.stderr);
  assert.equal(afterQaResume.result.state,'fixture_completed',JSON.stringify(afterQaResume.result));
  assert.deepEqual(afterQaResume.result.effectiveScope,[...f.definition.scope,...f.additions].sort());
  assert.deepEqual(f.frozen(),frozen,'run/protection/workflow/policy and original checks remain byte exact');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).fingerprints,before.fingerprints);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'other-protected.txt'),'utf8'),'preserve me\n');
});

test('native protected supplement still rejects other protected paths and failing business assertions',t=>{
  const f=fixture(t),{before,target}=f.begin();f.register(target);
  f.deliver({...Object.fromEntries(f.additions.map(file=>[file,'test.txt'])),'other-protected.txt':'wrong.txt'});
  const outside=f.drive('start');assert.notEqual(outside.status,0,'driver must refuse an out-of-scope protected edit before owner writes');
  assert.match(outside.stderr,/范围|scope|out_of_scope/);
  for(const file of f.additions)assert.equal(fs.readFileSync(path.join(f.codeProject,file),'utf8'),'export const value = 0;\n');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'other-protected.txt'),'utf8'),'preserve me\n');
  f.deliver({...Object.fromEntries(f.additions.map(file=>[file,'test.txt'])),'existing.txt':'wrong.txt'});
  const failing=f.drive('start');assert.equal(failing.status,0,failing.stderr);
  assert.equal(failing.result.code,'develop_checks_not_passed',JSON.stringify(failing.result)+'\n'+failing.stderr);
  assert.equal(failing.result.state,'blocked');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[ \] T-001/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).fingerprints,before.fingerprints);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'other-protected.txt'),'utf8'),'preserve me\n');
});


test('native protected supplement refuses stale launch, changed frozen config, and a resealed record missing its supplement',t=>{
  const f=fixture(t),frozen=f.frozen(),{target}=f.begin();
  const before=fs.readFileSync(f.stateFile);
  const product=()=>['existing.txt','other-protected.txt',...f.additions].map(file=>
    ({path:file,bytes:fs.readFileSync(path.join(f.codeProject,file))}));
  const originalProduct=product();
  const stale=f.drive('status',{registration:true,target:{...target,revision:'0'.repeat(64)}});
  assert.notEqual(stale.status,0,stale.stderr);assert.match(stale.stderr,/snapshot_changed/);
  assert.deepEqual(fs.readFileSync(f.stateFile),before,'stale registration cannot append records');
  const config=fs.readFileSync(f.config);
  try{
    fs.writeFileSync(f.config,JSON.stringify({...f.definition,scope:[...f.definition.scope,f.additions[5]]}));
    const changed=f.drive('status',{registration:true,target});
    assert.notEqual(changed.status,0,changed.stderr);assert.match(changed.stderr,/fingerprint_mismatch|scope_check_supplement_drift/);
    assert.deepEqual(fs.readFileSync(f.stateFile),before,'changed original config cannot rebind the old run');
  }finally{fs.writeFileSync(f.config,config);}
  assert.deepEqual(product(),originalProduct,'refused registration cannot alter product files');
  f.register(target);
  const accepted=fs.readFileSync(f.stateFile),state=JSON.parse(accepted),last=state.records.at(-1);
  assert.equal(last.payload.type,'scope-revised');assert.ok(last.payload.protectedSupplement);
  // An adversarial fixture can recompute ordinary journal checksums. The owner
  // must still enforce the protected-record contract, not trust a valid seal.
  delete last.payload.protectedSupplement;
  for(let i=0;i<state.records.length;i++){
    const {digest:discard,...body}=state.records[i];
    body.previousDigest=i?state.records[i-1].digest:null;
    state.records[i]={...body,digest:digest(body)};
  }
  const {revision:discard,...body}=state;
  fs.writeFileSync(f.stateFile,JSON.stringify({...body,revision:digest(body)})+'\n');
  const tampered=fs.readFileSync(f.stateFile);
  try{
    const missing=f.drive('status');assert.notEqual(missing.status,0,missing.stderr);
    assert.match(missing.stderr,/scope_check_supplement_drift/);
    assert.deepEqual(fs.readFileSync(f.stateFile),tampered,'rejected replay must not append or repair fixture records');
    assert.deepEqual(product(),originalProduct,'rejected replay must not execute development');
  }finally{fs.writeFileSync(f.stateFile,accepted);}
  const restored=f.drive('status');assert.equal(restored.status,0,restored.stderr);
  assert.deepEqual(restored.result.effectiveScope,[...f.definition.scope,...f.additions].sort());
  assert.deepEqual(fs.readFileSync(f.stateFile),accepted,'restored exact original record resumes without mutation');
  assert.deepEqual(f.frozen(),frozen);
});
