// Real native owner/check/QA; synthetic provider verdicts are protocol evidence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {protectedResultFixture,implementedValue} from './cm-ai-host-fixture.mjs';
const driver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
test('native original blocked review preserves verdict and budgets while evidence recovery uses only round two then completes QA and resume',t=>{
 const f=protectedResultFixture();let fixtureSucceeded=false;
 t.after(()=>{
  if(fixtureSucceeded){fs.rmSync(f.root,{recursive:true,force:true});return;}
  // Keep the original isolated owner evidence after failure, never a product run.
  // Bound diagnostic fields exclude source text, model messages and environment.
  const file=path.join(f.specsDir,'.reviews/.execution/host-fixture-run/state.json');let rows=[];
  try{const st=fs.lstatSync(file);if(st.size<=16*1024*1024){const snap=JSON.parse(fs.readFileSync(file));
   rows=snap.records.slice(-4).map(r=>({id:r.id,type:r.payload.type,
    checkpoint:r.payload.checkpoint?{state:r.payload.checkpoint.state,code:r.payload.checkpoint.code,
     calls:r.payload.checkpoint.calls?.slice(-2).map(c=>({id:c.id,role:c.role,terminal:c.terminal,code:c.code??null}))}:null}));}}
  catch(error){rows=[{diagnosticCode:typeof error.code==='string'?error.code:'diagnostic_unavailable'}];}
  fs.writeFileSync(path.join(f.root,'failure-summary.json'),JSON.stringify({fixtureRoot:f.root,rows}).slice(0,8192)+'\n');
  process.stderr.write('[fixture] original isolated failure retained: '+f.root+'\n');
 });
 const policy=path.join(f.root,'POLICY.json'),workflow=path.join(f.root,'workflow.json');
 fs.writeFileSync(policy,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
 const protection=f.args[f.args.indexOf('--protected-conversation-config')+1];
 const checks=JSON.parse(fs.readFileSync(protection)).checkCommands;
 fs.writeFileSync(workflow,JSON.stringify({qa:{commands:checks.map(c=>({...c,caseIds:[]})),environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
 const answers=path.join(f.root,'answers');fs.mkdirSync(answers);const deliver=n=>{
  fs.writeFileSync(path.join(answers,'target.mjs'),`export const value = ${n};\n`);
  fs.writeFileSync(path.join(answers,n===42?'develop.json':'develop-a2.json'),JSON.stringify({status:'succeeded',value:implementedValue(),edits:{'target.mjs':'target.mjs'}}));
 };deliver(42);
 fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
 fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture empty documentation checked'}));
 const fake=path.join(f.root,'synthetic-review-bin','codex');
 const originalFake=fs.readFileSync(fake,'utf8');
 const sandbox=originalFake.slice(originalFake.indexOf('if(process.argv[2]'),originalFake.indexOf('\nelse'));
 fs.writeFileSync(fake,`#!${process.execPath}\nimport fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';const {spawnSync}=await import('node:child_process');\n${sandbox}\nelse {let p='';for await(const s of process.stdin)p+=s;const pkg=JSON.parse(p.split('<cm-review-data-json>\\n')[1]).reviewPackage;const paths=[...new Set([...pkg.changes.map(c=>c.path),...pkg.requirements.map(c=>c.path),...(pkg.unchangedScope??[]).map(c=>c.path)])].sort();const images=process.argv.slice(2).filter((v,i,a)=>a[i-1]==='--image');if(pkg.identity.attempt===2){assert.equal(images.length,1);assert.equal(createHash('sha256').update(fs.readFileSync(images[0])).digest('hex'),${JSON.stringify('IMAGE_SHA')});assert.equal(pkg.checks.filter(c=>c.kind==='native-evidence').length,1);}const r={verdict:pkg.identity.attempt===1?'blocked':'approved',packageDigest:pkg.packageDigest,examinedPaths:paths,findings:pkg.identity.attempt===1?[{id:'R1',severity:'P1',path:'target.mjs',message:'Missing native material and scoped correction',evidence:'Synthetic first round, no business verdict'}]:[],summary:'Synthetic protocol only; native evidence integrity is not visual acceptance'};for(const v of [{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(r)}},{type:'turn.completed'}])console.log(JSON.stringify(v));}\n`,{mode:0o700});
 const sourceRoot=path.join(f.root,'native');fs.mkdirSync(sourceRoot);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lZ0AAAAASUVORK5CYII=','base64');
 fs.writeFileSync(path.join(sourceRoot,'after.png'),png);fs.writeFileSync(fake,fs.readFileSync(fake,'utf8').replace('IMAGE_SHA',sha(png)));
 const material={version:1,report:'Synthetic isolated fixture screenshot only; never physical iPhone or visual acceptance.',sourceFiles:[{path:'target.mjs',sha256:sha(Buffer.from('export const value = 43;\n'))}],images:[{path:'after.png',sha256:sha(png),size:png.length,description:'Synthetic one-pixel fixture'}]};
 fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify(material));
 const recovery=path.join(f.root,'recovery.json');fs.writeFileSync(recovery,JSON.stringify({version:1,reason:'User explicitly authorizes bounded evidence recovery; original blocked remains',nativeEvidence:{version:1,sourceRoot,manifest:'manifest.json'}}));
 const state=path.join(f.specsDir,'.reviews/.execution/host-fixture-run/state.json');const read=()=>JSON.parse(fs.readFileSync(state));
 let seq=0;const basePermissions=['--review-config',f.reviewFile,'--protected-conversation-config',protection,'--workflow-config',workflow];
 const drive=(op,{mode='resume',registration=false,target,packageDigest}={})=>{
  const permissions=[...basePermissions];if(registration){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--recover-blocked-review',recovery,'--expected-control','launch.json');}
  const plan=path.join(f.root,`PLAN-${++seq}.json`);fs.writeFileSync(plan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode,hostContext:'native-host-fixture',permissions,answers:'answers',...(packageDigest?{packageDigest}:{})}));
  const p=spawnSync(process.execPath,[driver,'--plan',plan,op],{env:f.env,encoding:'utf8',timeout:40000});let value=null;try{value=JSON.parse(p.stdout).result;}catch{}
  return {...p,value};
 };
 const frozen=[f.config,policy,protection,workflow,f.reviewFile].map(p=>({p,bytes:fs.readFileSync(p)}));
 const started=drive('start',{mode:'create'});assert.equal(started.status,0,JSON.stringify(started.value)+'\n'+started.stderr);assert.equal(started.value.state,'awaiting_review',JSON.stringify(started.value));
 const rejected=drive('decision',{packageDigest:started.value.packageDigest});assert.equal(rejected.status,0,rejected.stderr);assert.equal(rejected.value.code,'review_blocked');
 const before=read(),oldReceipt=before.records.at(-1).payload.checkpoint.receipt;
 const inspected=drive('status');assert.equal(inspected.status,0,inspected.stderr);
 const registered=drive('status',{registration:true,target:inspected.value.launchControlTarget});assert.equal(registered.status,0,registered.stderr);assert.equal(registered.value.identity.attempt,2);
 const rows=read();assert.deepEqual(rows.records.slice(0,before.records.length),before.records);assert.deepEqual(rows.fingerprints,before.fingerprints);assert.equal(rows.records.length,before.records.length+1);
 assert.equal(rows.records.at(-1).payload.type,'review-evidence-recovered');assert.equal(rows.records.at(-1).payload.receiptDigest,oldReceipt.receiptDigest);
 const bytes=fs.readFileSync(state);const duplicate=drive('status',{registration:true,target:inspected.value.launchControlTarget});assert.notEqual(duplicate.status,0);assert.deepEqual(fs.readFileSync(state),bytes,'stale registration cannot write twice');
 const resumed=drive('status');assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.value.identity.attempt,2);
 deliver(43);const changed=drive('start');assert.equal(changed.status,0,changed.stderr);assert.equal(changed.value.state,'awaiting_review',JSON.stringify(changed.value));
 const pkg=read().records.findLast(r=>r.payload.type==='effect-checkpoint').payload.checkpoint.reviewPackage;
 assert.equal(pkg.identity.attempt,2);assert.equal(pkg.checks.filter(c=>c.kind==='native-evidence').length,1);
 const approved=drive('decision',{packageDigest:pkg.packageDigest});assert.equal(approved.status,0,approved.stderr);assert.equal(approved.value.state,'approved',JSON.stringify(approved.value));
 const completed=drive('complete',{packageDigest:pkg.packageDigest});assert.equal(completed.status,0,completed.stderr);assert.equal(completed.value.state,'fixture_completed',JSON.stringify(completed.value)+'\n'+completed.stderr);
 const final=drive('advance');assert.equal(final.status,0,final.stderr);assert.match(final.stderr,/检查结束.*syntax.*passed/);
 fs.renameSync(sourceRoot,sourceRoot+'-retained-after-complete');
 const terminal=drive('status');assert.equal(terminal.status,0,terminal.stderr);assert.equal(terminal.value.state,'fixture_completed');
 const completedBytes=fs.readFileSync(state);const forbidden=drive('status',{registration:true,target:terminal.value.launchControlTarget});assert.notEqual(forbidden.status,0,'no third round or second registration');assert.deepEqual(fs.readFileSync(state),completedBytes);
 const finish=read();assert.deepEqual(finish.records.slice(0,before.records.length),before.records);assert.deepEqual(finish.fingerprints,before.fingerprints);
 const checkpoint=finish.records.findLast(r=>r.payload.type==='effect-checkpoint').payload.checkpoint;
 assert.deepEqual(checkpoint.receipts.map(r=>r.result.verdict),['blocked','approved']);assert(checkpoint.calls.length<=6,'no call budget reset');
 for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);
 fixtureSucceeded=true;
});
