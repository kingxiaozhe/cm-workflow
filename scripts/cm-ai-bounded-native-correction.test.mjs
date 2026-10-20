// Real native owner/check/QA; synthetic provider verdicts are protocol evidence only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {protectedResultFixture,implementedValue} from './cm-ai-host-fixture.mjs';
import {readRunnerHistory,runnerStatus,effectSlotFree,nativeCorrectionReviewExhausted,applyNativeReviewRetry} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {inspectContinuationPlan} from '../runtime/js/cm-ai/continuation-preflight.mjs';
import {exerciseValidEvidenceScenarios} from './fixtures/valid-evidence-continuation-fixture.mjs';
const evidenceMode=process.env.CM_VALID_EVIDENCE_FIXTURE==='1';
const timeoutMode=process.env.CM_NATIVE_MATERIAL_TIMEOUT_FIXTURE==='1';
const expectedCalls=timeoutMode?13:12;
const chainMode=process.env.CM_NATIVE_MATERIAL_CHAIN_FIXTURE==='1';
const chainVerdict=process.env.CM_NATIVE_MATERIAL_CHAIN_VERDICT??'approved';
const materialReviewMode=process.env.CM_NATIVE_MATERIAL_REVIEW_FIXTURE==='1';
const transportRetryMode=process.env.CM_NATIVE_TRANSPORT_RETRY_FIXTURE==='1'||materialReviewMode;
const technicalRetryMode=process.env.CM_NATIVE_REVIEW_RETRY_FIXTURE==='1'||transportRetryMode;
const failureMode=process.env.CM_NATIVE_REVIEW_FAILURE_FIXTURE==='1'||technicalRetryMode;
const driver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
test(technicalRetryMode?'original failed correction grants only one technical review of the unchanged package and completes QA':failureMode?'original correction failure resumes its checkpoint without new model calls or budget':'original double-blocked native run grants exactly one separate correction and preserves all six spent calls through N5 QA replay',t=>{
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
 const priorAdditions=Array.from({length:8},(_,i)=>'helper-'+i+'.json');
 const priorScope=[...priorAdditions,'target.mjs'];
 for(const name of priorAdditions)fs.writeFileSync(path.join(f.codeProject,name),'{}\n');
 const addedScope=['mobile/package-lock.json','mobile/package.json'];
 const beforeDependency={
  'mobile/package.json':JSON.stringify({dependencies:{fixture:'1.0.0'}})+'\n',
  'mobile/package-lock.json':JSON.stringify({name:'fixture',lockfileVersion:3,packages:Object.fromEntries(Array.from({length:4000},(_,i)=>['node_modules/fixture-'+i,{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',integrity:'sha512-'+('a'.repeat(40))}]))})+'\n'
 };
 fs.mkdirSync(path.join(f.codeProject,'mobile'));
 for(const [name,text]of Object.entries(beforeDependency))fs.writeFileSync(path.join(f.codeProject,name),text);
 assert(Buffer.byteLength(beforeDependency['mobile/package-lock.json'])>640*1024);
 const policy=path.join(f.root,'POLICY.json'),workflow=path.join(f.root,'workflow.json');
 fs.writeFileSync(policy,JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
 if(timeoutMode){const review=JSON.parse(fs.readFileSync(f.reviewFile));review.timeoutMs=6000;fs.writeFileSync(f.reviewFile,JSON.stringify(review));}
 const protection=f.args[f.args.indexOf('--protected-conversation-config')+1];
 const protectedConfig=JSON.parse(fs.readFileSync(protection));protectedConfig.checkCommands[0].command=[process.execPath,'-e',"import('./target.mjs').then(m=>process.exit([41,44].includes(m.value)?1:0))"];fs.writeFileSync(protection,JSON.stringify(protectedConfig));const checks=protectedConfig.checkCommands;
 fs.writeFileSync(workflow,JSON.stringify({qa:{commands:checks.map(c=>({...c,caseIds:[]})),environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
 const answers=path.join(f.root,'answers');fs.mkdirSync(answers);const deliver=n=>{
  fs.writeFileSync(path.join(answers,'target.mjs'),`export const value = ${n};\n`);
  fs.writeFileSync(path.join(answers,n<=42?'develop.json':'develop-a2.json'),JSON.stringify({status:'succeeded',value:implementedValue(),edits:{'target.mjs':'target.mjs'}}));
 };deliver(41);
 fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
 fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture empty documentation checked'}));
 const fake=path.join(f.root,'synthetic-review-bin','codex');
 const originalFake=fs.readFileSync(fake,'utf8');
 const sandbox=originalFake.slice(originalFake.indexOf('if(process.argv[2]'),originalFake.indexOf('\nelse'));
 fs.writeFileSync(fake,`#!${process.execPath}\nimport fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';const {spawnSync}=await import('node:child_process');\n${sandbox}\nelse {let p='';for await(const s of process.stdin)p+=s;const helper=await import(${JSON.stringify(new URL('./fixtures/material-review-codex-helper.mjs',import.meta.url).href)});const initialManifest=p.includes('<cm-review-material-manifest>')?JSON.parse(p.split('<cm-review-material-manifest>\\n')[1]):null;const incomplete=${chainMode}&&fs.existsSync(${JSON.stringify(path.join(f.root,'partial-material-armed'))})&&p.includes('<cm-review-material-manifest>')&&!fs.existsSync(${JSON.stringify(path.join(f.root,'partial-material-consumed'))});const timeoutRead=${timeoutMode}&&fs.existsSync(${JSON.stringify(path.join(f.root,'timeout-material-armed'))})&&!fs.existsSync(${JSON.stringify(path.join(f.root,'timeout-material-consumed'))});p=await helper.expandMaterialFixturePrompt(process.argv.slice(2),p,{pageLimit:incomplete||timeoutRead?1:Infinity});if(timeoutRead&&p!==null){fs.writeFileSync(${JSON.stringify(path.join(f.root,'timeout-material-consumed'))},'consumed');console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));console.log(JSON.stringify({type:'turn.started'}));await new Promise(resolve=>setTimeout(resolve,20000));process.exit(1);}if(p===null)process.exit(1);if(incomplete){fs.writeFileSync(${JSON.stringify(path.join(f.root,'partial-material-consumed'))},'consumed');const manifest=JSON.parse(p.split('<cm-review-material-manifest>\\n')[1]);const value={verdict:'approved',packageDigest:manifest.packageDigest,examinedPaths:['target.mjs'],findings:[],summary:'Synthetic premature terminal; must be rejected'};for(const event of [{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])console.log(JSON.stringify(event));process.exit(0);}const continuationVerdict=${JSON.stringify(chainVerdict)};const data=JSON.parse(p.split('<cm-review-data-json>\\n')[1]),pkg=data.reviewPackage;const paths=[...new Set([...pkg.changes.map(c=>c.path),...pkg.requirements.map(c=>c.path),...(pkg.unchangedScope??[]).map(c=>c.path)])].sort();const images=process.argv.slice(2).filter((v,i,a)=>a[i-1]==='--image');if(pkg.identity.attempt===2){assert.equal(images.length,pkg.evidenceContinuation?2:1);assert.equal(createHash('sha256').update(fs.readFileSync(images[0])).digest('hex'),${JSON.stringify('IMAGE_SHA')});assert.equal(pkg.checks.filter(c=>c.kind==='native-evidence').length,1);}if(pkg.handoff.path.includes('native-correction-1')){assert.equal(data.presentation.kind,'complete-inline-content-table');const lock=pkg.changes.find(c=>c.path==='mobile/package-lock.json');for(const [side,version]of [['before','1.0.0'],['after','1.0.1']]){const entry=data.contents[lock[side].contentRef];assert.equal(entry.encoding,'utf8');const full=entry.content;assert.equal(Buffer.byteLength(full),lock[side].size);assert.equal(createHash('sha256').update(full).digest('hex'),lock[side].sha256);const parsed=JSON.parse(full);assert.equal(Object.keys(parsed.packages).length,4000);for(const row of Object.values(parsed.packages))assert.equal(row.version,version);}}if(${failureMode}&&pkg.handoff.path.includes('native-correction-1')&&(!${technicalRetryMode}||Number(fs.existsSync(${JSON.stringify(path.join(f.root,'synthetic-review-failed-once'))})?fs.readFileSync(${JSON.stringify(path.join(f.root,'synthetic-review-failed-once'))},'utf8'):0)<${transportRetryMode?2:1})){if(${technicalRetryMode})fs.writeFileSync(${JSON.stringify(path.join(f.root,'synthetic-review-failed-once'))},String(Number(fs.existsSync(${JSON.stringify(path.join(f.root,'synthetic-review-failed-once'))})?fs.readFileSync(${JSON.stringify(path.join(f.root,'synthetic-review-failed-once'))},'utf8'):0)+1));console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));process.exit(1);}const supplementMissing=${materialReviewMode}&&pkg.handoff.path.includes('native-correction-1')&&!pkg.checks.some(c=>c.material?.version===2);const r={verdict:supplementMissing?'blocked':pkg.identity.attempt===1?'blocked':(pkg.handoff.path.includes('native-correction-1')?'approved':'blocked'),packageDigest:pkg.packageDigest,examinedPaths:paths,findings:supplementMissing||!pkg.handoff.path.includes('native-correction-1')?[{id:'R1',severity:'P1',path:'target.mjs',message:'Missing native material and scoped correction',evidence:'Synthetic first round, no business verdict'}]:[],summary:'Synthetic protocol only; native evidence integrity is not visual acceptance'};if(pkg.evidenceContinuation){r.verdict=fs.existsSync(${JSON.stringify(path.join(f.root,'evidence-verdict.json'))})?JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root,'evidence-verdict.json'))},'utf8')):${JSON.stringify(process.env.CM_VALID_EVIDENCE_VERDICT??'approved')};r.findings=r.verdict==='approved'?[]:[{id:'E1',severity:'P1',path:'target.mjs',message:'Still unresolved',evidence:'Independent synthetic evidence result'}];assert.equal(data.nativeTextEvidence.length,2);assert.equal(pkg.evidenceContinuation.oldReceipt.result.verdict,'blocked');assert.equal(pkg.evidenceContinuation.findings[0].id,'C1');}if(${chainMode}&&!pkg.evidenceContinuation&&pkg.checks.some(c=>c.material?.version===2)&&continuationVerdict!=='approved'){r.verdict=continuationVerdict;r.findings=[{id:'C1',severity:'P1',path:'target.mjs',message:'Synthetic unresolved finding',evidence:'Must retain actual verdict'}];}if(r.verdict==='provider_failed'){const traceFile=${JSON.stringify(path.join(f.root,'provider-failure-processes.jsonl'))};const trace=event=>fs.appendFileSync(traceFile,JSON.stringify({event,pid:process.pid,ppid:process.ppid,at:Date.now()})+'\\n');const pgid=spawnSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).stdout.trim();fs.appendFileSync(traceFile,JSON.stringify({event:'started',pid:process.pid,pgid,at:Date.now()})+'\\n');const stopped=new Promise(resolve=>{const timer=setTimeout(resolve,2000);process.once('SIGTERM',()=>{trace('sigterm');clearTimeout(timer);resolve();});});process.once('exit',()=>trace('exit'));for(const event of [{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'},{type:'error',message:'context_length_exceeded'},{type:'turn.failed',error:{message:'context_length_exceeded'}}])console.log(JSON.stringify(event));await stopped;process.exit(1);}const finalThread=randomUUID();if(${chainMode}&&initialManifest&&continuationVerdict==='approved'&&fs.existsSync(${JSON.stringify(path.join(f.root,'partial-material-consumed'))})&&!fs.existsSync(${JSON.stringify(path.join(f.root,'publication-fault-armed'))})){const {digest:artifactDigest}=await import(${JSON.stringify(new URL('../runtime/js/cm-ai/effect-contract.mjs',import.meta.url).href)});const blocker=${JSON.stringify(path.join(f.specsDir,'.reviews'))}+'/material-'+artifactDigest({request:initialManifest.requestDigest,thread:finalThread})+'.json';fs.writeFileSync(blocker,'synthetic publish collision',{mode:0o600});fs.writeFileSync(${JSON.stringify(path.join(f.root,'publication-fault-armed'))},blocker);}for(const v of [{type:'thread.started',thread_id:finalThread},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(r)}},{type:'turn.completed'}])console.log(JSON.stringify(v));}\n`,{mode:0o700});
 const sourceRoot=path.join(f.root,'native');fs.mkdirSync(sourceRoot);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lZ0AAAAASUVORK5CYII=','base64');
 fs.writeFileSync(path.join(sourceRoot,'after.png'),png);fs.writeFileSync(fake,fs.readFileSync(fake,'utf8').replace('IMAGE_SHA',sha(png)));
 const material={version:1,report:'Synthetic isolated fixture screenshot only; never physical iPhone or visual acceptance.',sourceFiles:[{path:'target.mjs',sha256:sha(Buffer.from('export const value = 43;\n'))},...priorAdditions.map(name=>({path:name,sha256:sha(Buffer.from('{}\n'))}))],images:[{path:'after.png',sha256:sha(png),size:png.length,description:'Synthetic one-pixel fixture'}]};
 material.sourceFiles.sort((a,b)=>a.path.localeCompare(b.path));
 fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify(material));
 const recovery=path.join(f.root,'recovery.json');fs.writeFileSync(recovery,JSON.stringify({version:1,reason:'User explicitly authorizes bounded evidence recovery; original blocked remains',nativeEvidence:{version:1,sourceRoot,manifest:'manifest.json'}}));
 const correctionRequest=path.join(f.root,'correction.json');
 fs.writeFileSync(correctionRequest,JSON.stringify({...JSON.parse(fs.readFileSync(recovery)),scope:[...priorScope,...addedScope].sort(),checkSupplement:{version:1,definitionFile:f.config,checkIds:[]}}));
 const state=path.join(f.specsDir,'.reviews/.execution/host-fixture-run/state.json');const read=()=>JSON.parse(fs.readFileSync(state));
 let seq=0;const basePermissions=['--input-limit','1048576','--review-config',f.reviewFile,'--protected-conversation-config',protection,'--workflow-config',workflow];
 const drive=(op,{mode='resume',registration=false,correction=false,technicalReviewRetry=false,transportReviewRetry=false,scopeRegistration=false,textEvidenceReview=false,materialContinuation=false,timeoutContinuation=false,evidenceRequestFile=null,target,wireTarget,invocationId,packageDigest}={})=>{
  const permissions=[...basePermissions];
  if(scopeRegistration){
   fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));
   const requested=path.join(f.root,'scope.json'),supplement=path.join(f.root,'supplement.json');
   fs.writeFileSync(requested,JSON.stringify(priorScope));fs.writeFileSync(supplement,JSON.stringify({version:1,definitionFile:f.config,checkIds:[]}));
   permissions.push('--revise-scope',requested,'--scope-revision-reason','User authorizes exact original helper scope','--scope-check-supplement',supplement,'--expected-control','launch.json');
  }
  if(evidenceRequestFile){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',evidenceRequestFile,'--expected-control','launch.json');}
  if(registration){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--recover-blocked-review',recovery,'--expected-control','launch.json');}
  if(correction){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',correctionRequest,'--expected-control','launch.json');}
  if(timeoutContinuation){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',path.join(f.root,'material-timeout-continuation.json'),'--expected-control','launch.json');}
  if(materialContinuation){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',path.join(f.root,'material-continuation.json'),'--expected-control','launch.json');}
  if(textEvidenceReview){fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',path.join(f.root,'material-review.json'),'--expected-control','launch.json');}
  if(technicalReviewRetry||transportReviewRetry){const request=path.join(f.root,'technical-review-retry.json');fs.writeFileSync(request,JSON.stringify({version:1,reason:'Human explicitly authorizes one technical review only; retain original eight invocations',[transportReviewRetry?'transportReviewRetry':'technicalReviewRetry']:true}));fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));permissions.push('--native-correction',request,'--expected-control','launch.json');}
  const plan=path.join(f.root,`PLAN-${++seq}.json`);fs.writeFileSync(plan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode,hostContext:'native-host-fixture',permissions,answers:'answers',...(wireTarget?{expectedControl:wireTarget}:{}),...(invocationId?{invocationId}:{}),...(packageDigest?{packageDigest}:{})}));
  const p=spawnSync(process.execPath,[driver,'--plan',plan,op],{env:f.env,encoding:'utf8',timeout:40000});let value=null;try{value=JSON.parse(p.stdout).result;}catch{}
  return {...p,value};
 };
 const preflight=({correction=false,technicalReviewRetry=false,transportReviewRetry=false,target}={})=>{
  const permissions=[...basePermissions];
  if(correction){fs.writeFileSync(path.join(f.root,'preflight-target.json'),JSON.stringify(target));
   permissions.push('--native-correction',correctionRequest,'--expected-control','preflight-target.json');}
  if(technicalReviewRetry||transportReviewRetry){fs.writeFileSync(path.join(f.root,'preflight-target.json'),JSON.stringify(target));permissions.push('--native-correction',path.join(f.root,'technical-review-retry.json'),'--expected-control','preflight-target.json');}
  const plan=path.join(f.root,'PREFLIGHT.json');fs.writeFileSync(plan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',
   mode:'resume',hostContext:'native-host-fixture',permissions,answers:'answers'}));
  const snapshot=()=>{const rows=[];const visit=dir=>{for(const name of fs.readdirSync(dir).sort()){
   const file=path.join(dir,name),st=fs.lstatSync(file,{bigint:true});
   rows.push({path:path.relative(f.root,file),mode:String(st.mode),mtime:String(st.mtimeNs),size:String(st.size),sha:st.isFile()?sha(fs.readFileSync(file)):null});
   if(st.isDirectory())visit(file);
  }};visit(f.root);return rows;};
  const before=snapshot(),report=inspectContinuationPlan(plan);assert.deepEqual(snapshot(),before,'preflight never changes project, state, evidence or archives');
  return report;
 };
 const frozen=[f.config,policy,protection,workflow,f.reviewFile].map(p=>({p,bytes:fs.readFileSync(p)}));
 const failedFirst=drive('start',{mode:'create'});assert.equal(failedFirst.value.code,'develop_checks_not_passed',JSON.stringify(failedFirst.value)+' '+failedFirst.stderr);
 const priorPreview=drive('status'),revised=drive('status',{scopeRegistration:true,target:priorPreview.value.launchControlTarget});assert.equal(revised.status,0,revised.stderr);assert.deepEqual(revised.value.effectiveScope,priorScope);
 const failedAgain=drive('start');assert.equal(failedAgain.value.code,'develop_checks_not_passed');deliver(42);const started=drive('start');assert.equal(started.status,0,JSON.stringify(started.value)+'\n'+started.stderr);assert.equal(started.value.state,'awaiting_review',JSON.stringify(started.value));
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
 const blockedSecond=drive('decision',{packageDigest:pkg.packageDigest});assert.equal(blockedSecond.value.code,'review_blocked',JSON.stringify(blockedSecond.value));
 const originalSecond=read();const checkpointSecond=originalSecond.records.at(-1).payload.checkpoint;assert.equal(checkpointSecond.calls.length,6);assert.equal(checkpointSecond.receipts.length,2);
 const oldFiles=['a1-handoff.json','r1.md','a2-handoff.json','r2.md'].map(suffix=>{const file=path.join(f.specsDir,'.reviews','work-T-001-'+suffix);return {file,bytes:fs.readFileSync(file)};});
 // Prepare future answer files only; the owner tree and retained second review
 // remain unchanged while the read-only projection checks the final candidate.
 deliver(45);
 const correctedDependencies=Object.fromEntries(Object.entries(beforeDependency).map(([name,text])=>[name,text.replaceAll('1.0.0','1.0.1')]));
 const correctionAnswer=path.join(answers,'develop-a2.json'),answer=JSON.parse(fs.readFileSync(correctionAnswer));
 for(const [name,text]of Object.entries(correctedDependencies)){const input=path.basename(name);fs.writeFileSync(path.join(answers,input),text);answer.edits[name]=input;}
 fs.writeFileSync(correctionAnswer,JSON.stringify(answer));
 material.sourceFiles.push(...addedScope.map(name=>({path:name,sha256:sha(Buffer.from(correctedDependencies[name]))})));
 material.sourceFiles.find(row=>row.path==='target.mjs').sha256=sha(Buffer.from('export const value = 45;\n'));material.sourceFiles.sort((a,b)=>a.path.localeCompare(b.path));fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify(material));
 const preview=drive('status'),candidate=preflight({correction:true,target:preview.value.launchControlTarget});
 assert.deepEqual(candidate.issues,[],JSON.stringify(candidate));assert.equal(candidate.nativeCorrection.registered,false);
 assert.deepEqual(candidate.effectiveScope,[...priorScope,...addedScope].sort());assert.equal(candidate.budget.calls,6);assert.equal(candidate.budget.effects,6);
 assert.equal(candidate.nativeCorrection.remainingDevelop,1);assert.equal(candidate.nativeCorrection.remainingReview,1);
 assert.deepEqual(candidate.actions,[]);assert.equal(candidate.nativeCorrection.authorizationGranted,false);
 assert.equal(candidate.nativeCorrection.ownerRevalidationRequired,true);assert.deepEqual(candidate.target,preview.value.launchControlTarget);
 assert.equal(candidate.capacity.fits,null);assert.equal(candidate.capacity.nativeArchiveVerified,false);
 assert.equal(candidate.nativeEvidence.sourceFiles.length,11);assert(candidate.unknown.some(text=>text.includes('under writer lock')));
 const stale=preflight({correction:true,target:{...preview.value.launchControlTarget,revision:'0'.repeat(64)}});
 assert(stale.issues.some(row=>row.code==='snapshot_changed'));assert.deepEqual(stale.actions,[]);
 const grant=drive('status',{correction:true,target:preview.value.launchControlTarget});assert.equal(grant.status,0,grant.stderr);assert.equal(grant.value.identity.attempt,2);
 assert.deepEqual(read().records.slice(0,originalSecond.records.length),originalSecond.records);
 const grantBytes=fs.readFileSync(state);assert.notEqual(drive('status',{correction:true,target:preview.value.launchControlTarget}).status,0);assert.deepEqual(fs.readFileSync(state),grantBytes);
 const grantRecord=read().records.at(-1).payload;
 assert.equal(grantRecord.type,'native-correction-authorized');assert.deepEqual(grantRecord.scope,[...priorScope,...addedScope].sort());
 assert.deepEqual(grantRecord.files.map(file=>file.path),addedScope);assert.equal(grantRecord.scopeDigest,digest(priorScope));
 for(const file of grantRecord.files)assert.equal(file.sha256,sha(Buffer.from(beforeDependency[file.path])));
 assert.equal(grantRecord.protectedSupplement.material.definition.scope.length,1);
 assert.equal(grantRecord.countedCalls,6);assert.equal(grantRecord.countedEffects,6);assert.equal(grantRecord.callLimit,8);assert.equal(grantRecord.effectLimit,8);
 const replayGrant=mutate=>{const records=structuredClone(read().records),last=records.at(-1);mutate(last.payload);const {digest:oldDigest,...envelope}=last;last.digest=digest(envelope);return readRunnerHistory(records,records[0].payload.config,3);};
 assert.throws(()=>replayGrant(record=>record.files.pop()),'every added existing path needs full baseline material');
 assert.throws(()=>replayGrant(record=>delete record.protectedSupplement),'scope cannot replay without frozen check protection');
 assert.throws(()=>replayGrant(record=>{record.protectedSupplement.material.execution.protection.timeoutMs++;}),'protection material stays bound to original fingerprint');
 const legacy=replayGrant(record=>{delete record.scope;delete record.files;delete record.protectedSupplement;});
 assert.deepEqual(legacy.effectiveScope,priorScope,'prior correction records without a scope extension still replay');
 const resumedGrant=drive('status');assert.equal(resumedGrant.status,0,resumedGrant.stderr);assert.deepEqual(resumedGrant.value.effectiveScope,grantRecord.scope);
 const grantedPreview=preflight();assert.deepEqual(grantedPreview.issues,[],JSON.stringify(grantedPreview));
 assert.equal(grantedPreview.taskBaseline.digest,candidate.taskBaseline.digest);assert.equal(grantedPreview.budget.calls,6);
 const correctionStart=drive('start');assert.equal(correctionStart.status,0,correctionStart.stderr);assert.equal(correctionStart.value.state,'awaiting_review',JSON.stringify(correctionStart.value));
 const correctionPkg=read().records.findLast(r=>r.payload.type==='effect-checkpoint').payload.checkpoint.reviewPackage;
 assert.equal(correctionPkg.identity.attempt,2);assert.match(correctionPkg.handoff.path,/native-correction-1/);assert.deepEqual(correctionPkg.changes.find(c=>c.path==='target.mjs').before,pkg.changes[0].before,'full original baseline retained');
 assert.deepEqual(correctionPkg.changes.map(c=>c.path),[...addedScope,'target.mjs']);
 for(const name of addedScope){const change=correctionPkg.changes.find(c=>c.path===name);assert.equal(change.before.sha256,sha(Buffer.from(beforeDependency[name])));assert.equal(change.after.sha256,sha(Buffer.from(correctedDependencies[name])));}
 assert.equal(readRunnerHistory(read().records,read().records[0].payload.config,3).scopeRevisions,1,'correction consumes no separate scope revision');
 const answerBytes=fs.readFileSync(correctionAnswer);fs.writeFileSync(correctionAnswer,'obsolete developer answer, no longer JSON');
 const awaitingPreview=preflight();assert.deepEqual(awaitingPreview.issues,[],JSON.stringify(awaitingPreview));
 assert.equal(awaitingPreview.currentPackage.packageDigest,correctionPkg.packageDigest);assert.equal(awaitingPreview.currentPackage.stored,true);
 fs.writeFileSync(correctionAnswer,answerBytes);
 // Replay the reachable unchanged-delivery failure using the exact real prefix; no new dispatch.
 const unchanged=structuredClone(read().records),last=unchanged.at(-1),cp=last.payload.checkpoint;
 cp.state='blocked';cp.code='develop_unchanged_after_review';cp.reason='Synthetic unchanged correction replay assertion';
 cp.reviewPackage=checkpointSecond.reviewPackage;cp.cache.at(-1).result=runnerStatus(cp,unchanged[0].payload.config);
 const {digest:previousDigest,...envelope}=last;last.digest=digest(envelope);
 const replayed=readRunnerHistory(unchanged,unchanged[0].payload.config,3);
 assert.equal(replayed.state.state,'blocked');assert.equal(replayed.state.code,'develop_unchanged_after_review');
 assert.equal(replayed.nativeCorrection.developConsumed,true);assert.equal(replayed.nativeCorrection.reviewConsumed,false);
 let approved=drive('decision',{packageDigest:correctionPkg.packageDigest});
 if(failureMode){
  assert.equal(approved.value.code,'native_correction_exhausted',JSON.stringify(approved.value));
  const failed=read(),last=failed.records.at(-1);
  assert.equal(last.payload.type,'effect-checkpoint');
  assert.equal(last.payload.checkpoint.calls.length,8);
  assert.deepEqual(last.payload.checkpoint.receipts.map(r=>r.result.verdict),['blocked','blocked']);
  assert.equal(last.payload.checkpoint.calls.at(-1).terminal,'failed');
  assert.equal(failed.records.at(-2).payload.type,'review-invocation-result');
  // Reproduce the old store-failure prefix only in this disposable fixture.
  const {revision:unused,...prefix}=failed;prefix.records=prefix.records.slice(0,-1);
  fs.writeFileSync(state,JSON.stringify({...prefix,revision:digest(prefix)})+'\n');
  const sealed=drive('status');assert.equal(sealed.status,0,sealed.stderr);
  assert.equal(sealed.value.state,'blocked');assert.equal(sealed.value.code,'native_correction_exhausted');
  const recovered=read();assert.deepEqual(recovered.records.slice(0,prefix.records.length),prefix.records);
  assert.equal(recovered.records.length,prefix.records.length+1);
  const cp=recovered.records.at(-1).payload.checkpoint;
  assert.equal(cp.calls.length,8);assert.equal(typeof cp.calls.at(-1).invocationId,'string');assert.equal(cp.calls.at(-1).invocationId,last.payload.checkpoint.calls.at(-1).invocationId);
  assert.equal(cp.calls.at(-1).terminal,'failed');assert.equal(cp.receipts.length,2);
  const history=readRunnerHistory(recovered.records,recovered.records[0].payload.config,3);
  assert.equal(history.pending,null);assert.equal(history.nativeCorrection.reviewConsumed,true);
  const stable=fs.readFileSync(state);assert.equal(drive('status').value.code,'native_correction_exhausted');
  assert.deepEqual(fs.readFileSync(state),stable,'repeated status does not duplicate the checkpoint');
  const retry=drive('decision',{packageDigest:correctionPkg.packageDigest});assert.notEqual(retry.value?.state,'approved');
  assert.deepEqual(fs.readFileSync(state),stable,'spent correction never dispatches a ninth call');
  for(const {file,bytes}of oldFiles)assert.deepEqual(fs.readFileSync(file),bytes);
  for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);
  assert.deepEqual(recovered.records.slice(0,originalSecond.records.length),originalSecond.records);
  if(!technicalRetryMode){fixtureSucceeded=true;return;}
  const preview=drive('status'),originalFailedCall=cp.calls.at(-1);
  const stale=drive('status',{technicalReviewRetry:true,target:{...preview.value.launchControlTarget,revision:'0'.repeat(64)}});
  assert.notEqual(stale.status,0);assert.deepEqual(fs.readFileSync(state),stable);
  fs.writeFileSync(correctionAnswer,'obsolete no-longer-valid developer JSON');
  const retryPreview=preflight({technicalReviewRetry:true,target:preview.value.launchControlTarget});
  assert.deepEqual(retryPreview.issues,[],JSON.stringify(retryPreview));assert.equal(retryPreview.nativeReviewRetry.remainingDevelop,0);
  assert.equal(retryPreview.nativeReviewRetry.remainingReview,1);assert.equal(retryPreview.nativeReviewRetry.authorizationGranted,false);
  assert.equal(retryPreview.currentPackage.packageDigest,correctionPkg.packageDigest);
  fs.writeFileSync(correctionAnswer,answerBytes);
  if(process.env.CM_NATIVE_REVIEW_RETRY_BASELINE){
   const oldPlan=path.join(f.root,'BASELINE-RETRY.json');fs.writeFileSync(oldPlan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode:'resume',hostContext:'native-host-fixture',permissions:[...basePermissions,'--native-correction',path.join(f.root,'technical-review-retry.json'),'--expected-control',path.join(f.root,'preflight-target.json')],answers:'answers'}));
   const red=spawnSync(process.execPath,[path.join(process.env.CM_NATIVE_REVIEW_RETRY_BASELINE,'scripts/cm-ai-drive.mjs'),'--plan',oldPlan,'status'],{env:f.env,encoding:'utf8',timeout:40000});
   assert.notEqual(red.status,0,'old installed contract really refuses new technical grant');assert.deepEqual(fs.readFileSync(state),stable);
   process.stderr.write('[red baseline] original native-correction contract rejects technical-review request; state unchanged\n');
  }
  const grant=drive('status',{technicalReviewRetry:true,target:preview.value.launchControlTarget});
  assert.equal(grant.status,0,grant.stderr+' '+JSON.stringify(grant.value));assert.equal(grant.value.state,'pending_review');
  const granted=read();assert.equal(granted.records.at(-1).payload.type,'native-review-retry-authorized');
  assert.deepEqual(granted.records.slice(0,recovered.records.length),recovered.records);
  const grantHistory=readRunnerHistory(granted.records,granted.records[0].payload.config,3);
  assert.equal(grantHistory.nativeCorrection.reviewConsumed,true);assert.equal(grantHistory.nativeCorrection.reviewRetry.consumed,false);
  assert.equal(effectSlotFree('develop',[],[],[],null,null,null,grantHistory.nativeCorrection),false);
  const grantStable=fs.readFileSync(state);assert.notEqual(drive('status',{technicalReviewRetry:true,target:preview.value.launchControlTarget}).status,0);
  assert.deepEqual(fs.readFileSync(state),grantStable);
  assert.equal(drive('status').value.state,'pending_review');
  approved=drive('decision',{packageDigest:correctionPkg.packageDigest});
  if(transportRetryMode){
   assert.equal(approved.value.code,'native_correction_exhausted',JSON.stringify(approved.value));
   const failedNine=read(),nineHistory=readRunnerHistory(failedNine.records,failedNine.records[0].payload.config,3);
   assert.equal(nineHistory.state.calls.length,9);assert.equal(nineHistory.nativeCorrection.reviewRetry.consumed,true);
   const nineBytes=fs.readFileSync(state),target=drive('status').value.launchControlTarget;
   // No authority or reused old authority can create another call.
   assert.notEqual(drive('decision',{packageDigest:correctionPkg.packageDigest}).value?.state,'approved');
   assert.notEqual(drive('status',{technicalReviewRetry:true,target}).status,0);
   assert.notEqual(drive('status',{transportReviewRetry:true,target:{...target,revision:'0'.repeat(64)}}).status,0);
   assert.deepEqual(fs.readFileSync(state),nineBytes);
   // Build only the request file and prove the old installed contract refuses it.
   fs.writeFileSync(path.join(f.root,'technical-review-retry.json'),JSON.stringify({version:1,reason:'Human explicitly authorizes one review after repaired transport; retain nine calls',transportReviewRetry:true}));
   const projection=preflight({transportReviewRetry:true,target});
   assert.deepEqual(projection.issues,[],JSON.stringify(projection));assert.equal(projection.nativeReviewRetry.callCount,9);
   assert.equal(projection.nativeReviewRetry.remainingDevelop,0);assert.equal(projection.nativeReviewRetry.remainingReview,1);
   assert.equal(projection.currentReviewInput.transport,'read_material');
   if(process.env.CM_NATIVE_TRANSPORT_RETRY_BASELINE){
    const oldPlan=path.join(f.root,'BASELINE-TRANSPORT-RETRY.json');fs.writeFileSync(oldPlan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode:'resume',hostContext:'native-host-fixture',permissions:[...basePermissions,'--native-correction',path.join(f.root,'technical-review-retry.json'),'--expected-control',path.join(f.root,'preflight-target.json')],answers:'answers'}));
    const red=spawnSync(process.execPath,[path.join(process.env.CM_NATIVE_TRANSPORT_RETRY_BASELINE,'scripts/cm-ai-drive.mjs'),'--plan',oldPlan,'status'],{env:f.env,encoding:'utf8',timeout:40000});
    assert.notEqual(red.status,0);assert.deepEqual(fs.readFileSync(state),nineBytes);
    process.stderr.write('[red baseline] prior installed contract rejects additional transport review authority; nine calls unchanged\n');
   }
   const added=drive('status',{transportReviewRetry:true,target});assert.equal(added.status,0,added.stderr+' '+JSON.stringify(added.value));
   const tenGrant=read();assert.deepEqual(tenGrant.records.slice(0,failedNine.records.length),failedNine.records);
   assert.equal(tenGrant.records.at(-1).payload.type,'native-review-transport-retry-authorized');
   const grantHistory=readRunnerHistory(tenGrant.records,tenGrant.records[0].payload.config,3);
   assert.equal(grantHistory.nativeCorrection.reviewRetry.consumed,true);assert.equal(grantHistory.nativeCorrection.transportReviewRetry.consumed,false);
   assert.equal(applyNativeReviewRetry(nineHistory.state,{...failedNine.records[0].payload.config,scope:nineHistory.effectiveScope},nineHistory.original,nineHistory.nativeCorrection,tenGrant.records.at(-1).payload,true).state,'pending_review');
   for(const key of ['priorRetryDigest','failedCheckpointDigest','invocationId','resultDigest','packageDigest','correctionDigest','configDigest','baselineDigest','scopeDigest','callCount','retryEffectId']){
    const bad={...tenGrant.records.at(-1).payload,[key]:key==='callCount'?8:'bad'};
    assert.throws(()=>applyNativeReviewRetry(nineHistory.state,{...failedNine.records[0].payload.config,scope:nineHistory.effectiveScope},nineHistory.original,nineHistory.nativeCorrection,bad,true),key+' remains bound');
   }
   const grantTenBytes=fs.readFileSync(state);assert.notEqual(drive('status',{transportReviewRetry:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),grantTenBytes);
   approved=drive('decision',{packageDigest:correctionPkg.packageDigest});
   const ten=read(),tenHistory=readRunnerHistory(ten.records,ten.records[0].payload.config,3);
   assert.equal(tenHistory.state.calls.length,10);assert.deepEqual(tenHistory.state.calls.slice(0,9),nineHistory.state.calls);
   assert.equal(tenHistory.nativeCorrection.transportReviewRetry.consumed,true);
   assert.equal(effectSlotFree('review',[],[],[],null,tenHistory.nativeCorrection.transportReviewRetry.effectId,null,tenHistory.nativeCorrection),false);
   assert.equal(effectSlotFree('develop',[],[],[],null,null,null,tenHistory.nativeCorrection),false);
   const tenBytes=fs.readFileSync(state);assert.notEqual(drive('status',{transportReviewRetry:true,target:drive('status').value.launchControlTarget}).status,0);assert.deepEqual(fs.readFileSync(state),tenBytes);
   assert.equal(nativeCorrectionReviewExhausted({state:'blocked',code:'review_provider_failed',cache:[{effect:{kind:'review'}}]},tenHistory.nativeCorrection),true);
   if(materialReviewMode){
    assert.equal(approved.value.code,'review_blocked');assert.equal(tenHistory.state.receipts.length,3);
    const fixed=JSON.parse(fs.readFileSync(path.join(sourceRoot,'manifest.json')));
    const textRoot=path.join(f.root,'complete-text');fs.mkdirSync(textRoot);
    const full=JSON.stringify({corners:[[0,0],[1,1]],method:'all original data'});fs.writeFileSync(path.join(textRoot,'calibration.json'),full);
    const textEvidence={version:1,sourceRoot:textRoot,files:[{id:'calibration',path:'calibration.json',mediaType:'application/json',sha256:sha(Buffer.from(full)),size:Buffer.byteLength(full),description:'Complete original calibration data'}],requirements:[{id:'corners',fileId:'calibration',pointers:['/corners/0/0']}]};
    const manifest={...fixed,version:2,textEvidence};fs.writeFileSync(path.join(sourceRoot,'supplement.json'),JSON.stringify(manifest));
    const request={version:1,reason:'Human authorizes only original run one review with complete text; no development',textEvidenceReview:true,nativeEvidence:{version:1,sourceRoot,manifest:'supplement.json'},textManifestDigest:digest(textEvidence)};
    fs.writeFileSync(path.join(f.root,'material-review.json'),JSON.stringify(request));
    const target=drive('status').value.launchControlTarget;
    const held=fs.readFileSync(state);
    assert.notEqual(drive('status',{textEvidenceReview:true,target:{...target,revision:'0'.repeat(64)}}).status,0);
    assert.deepEqual(fs.readFileSync(state),held);
    if(process.env.CM_NATIVE_MATERIAL_REVIEW_BASELINE){
     const plan=path.join(f.root,'RED-MATERIAL.json');fs.writeFileSync(plan,JSON.stringify({config:f.config,controlConfig:'POLICY.json',mode:'resume',hostContext:'native-host-fixture',permissions:[...basePermissions,'--native-correction',path.join(f.root,'material-review.json'),'--expected-control',path.join(f.root,'launch.json')],answers:'answers'}));
     fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(target));
     const red=spawnSync(process.execPath,[path.join(process.env.CM_NATIVE_MATERIAL_REVIEW_BASELINE,'scripts/cm-ai-drive.mjs'),'--plan',plan,'status'],{env:f.env,encoding:'utf8',timeout:40000});
     assert.notEqual(red.status,0);assert.deepEqual(fs.readFileSync(state),held);
     process.stderr.write('[red baseline] installed owner rejects valid-blocked material supplement; ten calls unchanged\n');
    }
    const oldCorrectionFiles=['work-T-001-native-correction-1.md','work-T-001-native-correction-1-receipt.json'].map(name=>({file:path.join(f.specsDir,'.reviews',name),bytes:fs.readFileSync(path.join(f.specsDir,'.reviews',name))}));
    // Changed original report and manifest commitment must fail before any registration.
    fs.writeFileSync(path.join(sourceRoot,'supplement.json'),JSON.stringify({...manifest,report:'changed old report'}));
    assert.notEqual(drive('status',{textEvidenceReview:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),held);
    fs.writeFileSync(path.join(sourceRoot,'supplement.json'),JSON.stringify(manifest));
    const badRequest={...request,textManifestDigest:'0'.repeat(64)};fs.writeFileSync(path.join(f.root,'material-review.json'),JSON.stringify(badRequest));
    assert.notEqual(drive('status',{textEvidenceReview:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),held);
    fs.writeFileSync(path.join(f.root,'material-review.json'),JSON.stringify(request));
    const granted=drive('status',{textEvidenceReview:true,target});assert.equal(granted.status,0,granted.stderr+' '+JSON.stringify(granted.value));
    const newSnapshot=read();assert.deepEqual(newSnapshot.records.slice(0,ten.records.length),ten.records);
    assert.equal(newSnapshot.records.at(-1).payload.type,'native-material-review-authorized');
    const h=readRunnerHistory(newSnapshot.records,newSnapshot.records[0].payload.config,3);
    assert.equal(h.state.calls.length,10);assert.equal(h.state.receipts.length,3);assert.equal(h.nativeCorrection.materialReview.consumed,false);
    assert.equal(h.state.reviewPackage.changes[0].before.sha256,tenHistory.state.reviewPackage.changes[0].before.sha256);
    assert.notEqual(h.state.reviewPackage.packageDigest,correctionPkg.packageDigest);
    const registeredBytes=fs.readFileSync(state);assert.notEqual(drive('status',{textEvidenceReview:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),registeredBytes);
    const status=drive('status');assert.equal(status.value.state,'awaiting_review');
    if(chainMode)fs.writeFileSync(path.join(f.root,'partial-material-armed'),'armed for material grant only');
    approved=drive('decision',{packageDigest:h.state.reviewPackage.packageDigest});assert.equal(approved.status,chainMode?1:0,approved.stderr+' '+JSON.stringify(approved.value));
    if(chainMode){
     const failed=read(),failureBytes=fs.readFileSync(state),failedCp=failed.records.at(-1).payload.checkpoint;
     assert.equal(failedCp.state,'unknown');assert.equal(failedCp.reviewInvocation.result.observation.result.code,'review_material_incomplete');
     assert.equal(failedCp.calls.length,11);assert.equal(failedCp.receipts.length,3);
     const shown=drive('status');assert.equal(shown.value.pendingAction,'none');assert.equal(shown.value.materialReviewFailure,true);
     assert.doesNotMatch(shown.stderr,/使用 reconcile_review|发送 abandon_review|新建运行重做/);
     const source=shown.value.materialContinuationSource;assert(source);assert.equal(source.revision,failed.revision);
     const denied=drive('decision',{packageDigest:h.state.reviewPackage.packageDigest});assert.notEqual(denied.value?.state,'approved');assert.deepEqual(fs.readFileSync(state),failureBytes,'no grant, no intent or call');
     const authorization={version:1,reason:'Separate human authority for one NEW material review opportunity, never a refund',materialReadContinuation:true,source,oldInvocationStopped:true};
     const authFile=path.join(f.root,'material-continuation.json');const saveAuth=a=>fs.writeFileSync(authFile,JSON.stringify(a));saveAuth(authorization);
     const launch=shown.value.launchControlTarget;
     assert.notEqual(drive('status',{materialContinuation:true,target:{...launch,revision:'0'.repeat(64)}}).status,0);assert.deepEqual(fs.readFileSync(state),failureBytes);
     for(const changed of [{...source,hostContextId:'wrong-host'},{...source,requestDigest:'0'.repeat(64)}, {...source,packageDigest:'0'.repeat(64)}, {...source,identity:{...source.identity,taskId:'T-999'}}, {...source,fingerprints:{...source.fingerprints,config:'0'.repeat(64)}}]){
      saveAuth({...authorization,source:changed});assert.notEqual(drive('status',{materialContinuation:true,target:launch}).status,0);assert.deepEqual(fs.readFileSync(state),failureBytes);
     }
     saveAuth(authorization);
     const sourceFile=path.join(f.codeProject,'target.mjs'),sourceBytes=fs.readFileSync(sourceFile);fs.writeFileSync(sourceFile,'export const value = 999;\n');
     assert.notEqual(drive('status',{materialContinuation:true,target:launch}).status,0);assert.deepEqual(fs.readFileSync(state),failureBytes);fs.writeFileSync(sourceFile,sourceBytes);
     const cfgBytes=fs.readFileSync(f.reviewFile),cfg=JSON.parse(cfgBytes);fs.writeFileSync(f.reviewFile,JSON.stringify({...cfg,model:'different-reviewer'}));
     assert.notEqual(drive('status',{materialContinuation:true,target:launch}).status,0);assert.deepEqual(fs.readFileSync(state),failureBytes);fs.writeFileSync(f.reviewFile,cfgBytes);
     const writer=openExecutionStore({specsRoot:f.specsDir,identity:failed.identity,fingerprints:failed.fingerprints,create:false});
     try{const occupied=drive('status',{materialContinuation:true,target:launch});assert.notEqual(occupied.status,0);assert.match(occupied.stderr,/store_busy|host_busy/);assert.deepEqual(fs.readFileSync(state),failureBytes);}finally{writer.close();}
     const registered=drive('status',{materialContinuation:true,target:launch});assert.equal(registered.status,0,registered.stderr);assert.equal(registered.value.state,'awaiting_review');
     const granted=read();assert.deepEqual(granted.records.slice(0,failed.records.length),failed.records);assert.equal(granted.records.length,failed.records.length+1);
     assert.equal(granted.records.at(-1).payload.type,'material-review-continuation-authorized');
     assert.notEqual(drive('status',{materialContinuation:true,target:launch}).status,0);assert.deepEqual(read(),granted,'duplicate cannot register twice');
     if(timeoutMode){
      fs.writeFileSync(path.join(f.root,'timeout-material-armed'),'fixture timeout only');
      const timedOut=drive('decision',{packageDigest:h.state.reviewPackage.packageDigest});
      assert.equal(timedOut.value.state,'blocked');
      const timeoutFailure=read(),timeoutCp=timeoutFailure.records.at(-1).payload.checkpoint;
      assert.equal(timeoutCp.code,'review_transport_timeout');assert.equal(timeoutCp.calls.length,12);
      assert.equal(timeoutCp.reviewInvocation.result.outcome,'timed_out');
      const status=drive('status'),source=status.value.materialTimeoutContinuationSource;assert(source,JSON.stringify(status));
      assert.equal(source.revision,timeoutFailure.revision);assert(source.transportProfileDigest);assert.equal(source.invocationId,timeoutCp.calls.at(-1).invocationId);
      const bytes=fs.readFileSync(state),target=status.value.launchControlTarget;
      assert.notEqual(drive('decision').value?.state,'approved');assert.deepEqual(fs.readFileSync(state),bytes,'timeout does not refund authority');
      const request={version:1,reason:'Explicit separate authority to prepare one batch-bound opportunity; not a refund',materialTimeoutContinuation:true,source,oldInvocationStopped:true};
      const file=path.join(f.root,'material-timeout-continuation.json'),save=v=>fs.writeFileSync(file,JSON.stringify(v));save(request);
      assert.notEqual(drive('status',{timeoutContinuation:true,target:{...target,revision:'0'.repeat(64)}}).status,0);assert.deepEqual(fs.readFileSync(state),bytes);
      for(const changed of [{...source,transportProfileDigest:'0'.repeat(64)},{...source,packageDigest:'0'.repeat(64)},{...source,hostContextId:'wrong-host'}]){save({...request,source:changed});assert.notEqual(drive('status',{timeoutContinuation:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),bytes);}save(request);
      const writer=openExecutionStore({specsRoot:f.specsDir,identity:timeoutFailure.identity,fingerprints:timeoutFailure.fingerprints,create:false});
      try{assert.notEqual(drive('status',{timeoutContinuation:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),bytes);}finally{writer.close();}
      const heldSource=path.join(f.codeProject,'target.mjs'),heldBytes=fs.readFileSync(heldSource);fs.appendFileSync(heldSource,'// drift\n');
      assert.notEqual(drive('status',{timeoutContinuation:true,target}).status,0);assert.deepEqual(fs.readFileSync(state),bytes);fs.writeFileSync(heldSource,heldBytes);
      const grant=drive('status',{timeoutContinuation:true,target});assert.equal(grant.status,0,grant.stderr);assert.equal(grant.value.state,'awaiting_review');
      const recorded=read();assert.deepEqual(recorded.records.slice(0,timeoutFailure.records.length),timeoutFailure.records);assert.equal(recorded.records.length,timeoutFailure.records.length+1);assert.equal(recorded.records.at(-1).payload.type,'material-review-timeout-continuation-authorized');
      assert.notEqual(drive('status',{timeoutContinuation:true,target}).status,0);assert.deepEqual(read(),recorded);
     }
     approved=drive('decision',{packageDigest:h.state.reviewPackage.packageDigest});
     if(chainVerdict==='approved'){
      assert.equal(approved.status,1,approved.stderr);assert.equal(approved.value.state,'unknown');assert.equal(approved.value.pendingAction,'reconcile_review',JSON.stringify(approved.value));
      const interrupted=read(),lost=interrupted.records.at(-1).payload.checkpoint;
      assert.equal(lost.calls.length,expectedCalls);assert.equal(lost.calls.at(-1).terminal,'unknown');assert.equal(lost.receipt,null);
      const blocker=fs.readFileSync(path.join(f.root,'publication-fault-armed'),'utf8');assert.equal(path.dirname(blocker),path.join(f.specsDir,'.reviews'));assert.equal(fs.readFileSync(blocker,'utf8'),'synthetic publish collision');fs.unlinkSync(blocker);
      const shown=drive('status');approved=drive('reconcile_review',{wireTarget:shown.value.controlTarget,invocationId:lost.calls.at(-1).invocationId});
      assert.equal(approved.status,0,approved.stderr);assert.equal(approved.value.state,'approved');
      assert.deepEqual(read().records.slice(0,interrupted.records.length),interrupted.records,'failed publication and unknown result stay in history');
     }else assert.equal(approved.status,0,approved.stderr);
     const accepted=read(),acceptedHistory=readRunnerHistory(accepted.records,accepted.records[0].payload.config,3);
     assert.deepEqual(accepted.records.slice(0,failed.records.length),failed.records);assert.equal(acceptedHistory.state.calls.length,expectedCalls);
     assert.deepEqual(acceptedHistory.state.calls.slice(0,11),failedCp.calls);assert.equal(acceptedHistory.state.receipt.result.verdict,chainVerdict);
     assert.equal(acceptedHistory.state.reviewPackage.packageDigest,h.state.reviewPackage.packageDigest);
     assert.equal(acceptedHistory.nativeCorrection.materialContinuation.consumed,true);if(timeoutMode)assert.equal(acceptedHistory.nativeCorrection.materialTimeoutContinuation.consumed,true);
     const continuationIntent=accepted.records.findLastIndex(r=>r.payload.type==='effect-intent'&&r.payload.effect.kind==='review');
     for(let end=continuationIntent+1;end<=accepted.records.length;end++){
      const prefix=accepted.records.slice(0,end),replayed=readRunnerHistory(prefix,prefix[0].payload.config,3);
      assert.equal(replayed.nativeCorrection.materialContinuation.consumed,true);if(timeoutMode)assert.equal(replayed.nativeCorrection.materialTimeoutContinuation.consumed,true);
      assert.equal(effectSlotFree('review',replayed.state.cache,replayed.state.calls,[],null,'new',replayed.state,replayed.nativeCorrection),false);
     }

     assert.equal(effectSlotFree('review',[],[],[],null,'new',null,acceptedHistory.nativeCorrection),false);
     // Crash after the adapter saved the exact result, before owner journal acceptance.
     // The trusted invocation/started records remain. Explicit reconciliation must not invoke the provider.
     if(chainVerdict==='approved'){
      const startedIndex=accepted.records.findLastIndex(r=>r.payload.type==='review-invocation-started');
      const prefix={...accepted,records:accepted.records.slice(0,startedIndex+1)};const {revision,...body}=prefix;prefix.revision=digest(body);
      fs.writeFileSync(state,JSON.stringify(prefix)+'\n');
      // A durable cancel after started must exclude even a valid saved result before any observed result is appended.
      const last=prefix.records.at(-1),cancelBody={version:1,seq:prefix.records.length+1,id:`runner.${String(prefix.records.length+1).padStart(6,'0')}`,kind:'cancel',
       payload:{version:3,protocol:'cm-task-runner',type:'control',event:'cancel'},previousDigest:last.digest};
      const cancelled={...prefix,records:[...prefix.records,{...cancelBody,digest:digest(cancelBody)}]};
      const {revision:cancelRevision,...cancelData}=cancelled;cancelled.revision=digest(cancelData);fs.writeFileSync(state,JSON.stringify(cancelled)+'\n');
      const stoppedBytes=fs.readFileSync(state),stopped=drive('status');assert.notEqual(stopped.value?.reviewReconciliation?.available,true);
      assert.notEqual(drive('reconcile_review',{wireTarget:stopped.value.controlTarget,invocationId:acceptedHistory.state.receipt.id}).status,0);
      assert.deepEqual(fs.readFileSync(state),stoppedBytes,'cancelled prefix rejects before recording an observed result');
      const stoppedHistory=readRunnerHistory(read().records,read().records[0].payload.config,3);assert.equal(stoppedHistory.state.cancellationRequested,true);assert.equal(stoppedHistory.pendingObservedReview,null);
      fs.writeFileSync(state,JSON.stringify(prefix)+'\n');
      const waiting=drive('status');assert.equal(waiting.status,1,waiting.stderr);assert.equal(waiting.value.pendingAction,'reconcile_review',JSON.stringify(waiting.value));
      const bytes=fs.readFileSync(state);assert.notEqual(drive('reconcile_review',{wireTarget:waiting.value.controlTarget,invocationId:'wrong-call'}).status,0);assert.deepEqual(fs.readFileSync(state),bytes);
      const recovered=drive('reconcile_review',{wireTarget:waiting.value.controlTarget,invocationId:acceptedHistory.state.receipt.id});
      assert.equal(recovered.status,0,recovered.stderr);assert.equal(recovered.value.state,'approved');
      assert.equal(read().records.at(-1).payload.checkpoint.calls.length,expectedCalls);
     }
     // Crash after an observed result, before checkpoint: recover that original result without a new provider call.
     if(chainVerdict==='approved'){
      const observedSnapshot=read(),resultIndex=observedSnapshot.records.findLastIndex(r=>r.payload.type==='review-invocation-result');
      const prefix={...observedSnapshot,records:observedSnapshot.records.slice(0,resultIndex+1)};const {revision,...body}=prefix;prefix.revision=digest(body);
      fs.writeFileSync(state,JSON.stringify(prefix)+'\n');
      const resumed=drive('status');assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.value.state,'approved');
      const recovered=read();assert.deepEqual(recovered.records.slice(0,prefix.records.length),prefix.records);assert.equal(recovered.records.at(-1).payload.checkpoint.calls.length,expectedCalls);
      const afterBytes=fs.readFileSync(state);assert.equal(drive('status').value.state,'approved');assert.deepEqual(fs.readFileSync(state),afterBytes,'saved response loss is idempotent');
     }else{
      if(evidenceMode){exerciseValidEvidenceScenarios({f,drive,read,state,sourceRoot,png,frozen,expectedCalls});fixtureSucceeded=true;return;}
      assert.equal(approved.value.state,'blocked');assert.notEqual(approved.value.materialReviewFailure,true,'accepted business rejection is not a transport failure');
      const acceptedStatus=drive('status');assert.notEqual(acceptedStatus.value.materialReviewFailure,true,'status preserves accepted rejection');assert(!/材料传输|未被接受/.test(acceptedStatus.value.reason??''));
      assert.equal(approved.value.code,chainVerdict==='blocked'?'review_blocked':'review_limit');
      const held=fs.readFileSync(state);assert.notEqual(drive('complete',{packageDigest:h.state.reviewPackage.packageDigest}).value?.state,'fixture_completed');assert.deepEqual(fs.readFileSync(state),held);
      assert.doesNotMatch(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\]/);
      for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);fixtureSucceeded=true;return;
     }
    }
    const after=read(),a=readRunnerHistory(after.records,after.records[0].payload.config,3);
    assert.equal(a.state.calls.length,chainMode?expectedCalls:11);assert.equal(a.state.receipts.length,4);assert.equal(a.nativeCorrection.materialReview.consumed,true);
    assert.deepEqual(a.state.calls.slice(0,10),tenHistory.state.calls);
    assert.equal(effectSlotFree('review',[],[],[],null,h.nativeCorrection.materialReview.effectId,null,a.nativeCorrection),false);
    assert.equal(effectSlotFree('develop',[],[],[],null,null,null,a.nativeCorrection),false);
    const intentIndex=after.records.findIndex(row=>row.payload.type==='effect-intent'&&row.payload.effect?.id===h.nativeCorrection.materialReview.effectId);
    for(let end=intentIndex+1;end<=after.records.length;end++){
      const prefix=after.records.slice(0,end),ph=readRunnerHistory(prefix,prefix[0].payload.config,3);
      assert.equal(ph.nativeCorrection.materialReview.consumed,true,'intent consumes authority through every crash prefix');
      assert.equal(effectSlotFree('review',ph.state.cache,ph.state.calls,[],null,h.nativeCorrection.materialReview.effectId,ph.state,ph.nativeCorrection),false);
    }
    for(const row of oldCorrectionFiles)assert.deepEqual(fs.readFileSync(row.file),row.bytes);
    const protectedState=fs.readFileSync(state);assert.notEqual(drive('status',{textEvidenceReview:true,target:drive('status').value.launchControlTarget}).status,0);assert.deepEqual(fs.readFileSync(state),protectedState);
    correctionPkg.packageDigest=h.state.reviewPackage.packageDigest;
   }

  }
  assert.equal(approved.status,0,approved.stderr);assert.equal(approved.value.state,'approved',JSON.stringify(approved.value));
  const reviewed=read(),newCp=reviewed.records.at(-1).payload.checkpoint;
  assert.equal(newCp.calls.length,chainMode?expectedCalls:materialReviewMode?11:transportRetryMode?10:9);assert.deepEqual(newCp.calls.slice(0,8),cp.calls);
  assert.notEqual(newCp.calls.at(-1).providerThreadId,originalFailedCall.providerThreadId);
  assert.equal(newCp.reviewPackage.packageDigest,correctionPkg.packageDigest);
  if(!transportRetryMode)assert.equal(newCp.cache.at(-1).effect.id,granted.records.at(-1).payload.retryEffectId);
  assert.equal(nativeCorrectionReviewExhausted({state:'blocked',code:'review_provider_failed',cache:[{effect:{kind:'review'}}]}, {reviewConsumed:true,reviewRetry:{consumed:true}}),true,'failed technical retry is terminal, without automatic redispatch guidance');
  const retryHistory=readRunnerHistory(reviewed.records,reviewed.records[0].payload.config,3);
  assert.equal(retryHistory.nativeCorrection.reviewRetry.consumed,true);
  assert.equal(effectSlotFree('review',[],[],[],null,retryHistory.nativeCorrection.reviewRetry.effectId,null,retryHistory.nativeCorrection),false);
  const spent=fs.readFileSync(state);assert.notEqual(drive('status',{technicalReviewRetry:true,target:drive('status').value.launchControlTarget}).status,0);
  assert.deepEqual(fs.readFileSync(state),spent,'technical retry cannot be renewed after it starts');
 }
 assert.equal(approved.status,0,approved.stderr);assert.equal(approved.value.state,'approved',JSON.stringify(approved.value));
 fs.writeFileSync(correctionAnswer,'obsolete developer answer, no longer JSON');
 const approvedPreview=preflight();assert.deepEqual(approvedPreview.issues,[],JSON.stringify(approvedPreview));assert.equal(approvedPreview.stage,'approved');
 fs.writeFileSync(correctionAnswer,answerBytes);
 pkg.packageDigest=correctionPkg.packageDigest;
 for(const {file,bytes}of oldFiles)assert.deepEqual(fs.readFileSync(file),bytes,'old verdicts and handoffs never overwritten');
 const completed=drive('complete',{packageDigest:pkg.packageDigest});assert.equal(completed.status,0,completed.stderr);assert.equal(completed.value.state,'fixture_completed',JSON.stringify(completed.value)+'\n'+completed.stderr);
 const final=drive('advance');assert.equal(final.status,0,final.stderr);assert.match(final.stderr,/检查结束.*syntax.*passed/);
 if(chainMode){const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.node==='N6'&&r.event==='test_run'&&r.phase==='complete'&&r.result==='PASS').length,1,'original QA must actually pass exactly once');assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/^- \[x\] T-001/m);}
 fs.renameSync(sourceRoot,sourceRoot+'-retained-after-complete');
 const terminal=drive('status');assert.equal(terminal.status,0,terminal.stderr);assert.equal(terminal.value.state,'fixture_completed');
 fs.writeFileSync(correctionAnswer,'obsolete developer answer, no longer JSON');
 const completedPreview=preflight();assert.deepEqual(completedPreview.issues,[],JSON.stringify(completedPreview));assert.equal(completedPreview.stage,'fixture_completed');
 const completedBytes=fs.readFileSync(state);assert.notEqual(drive('status',{correction:true,target:terminal.value.launchControlTarget}).status,0,'single correction cannot renew after completion');const forbidden=drive('status',{registration:true,target:terminal.value.launchControlTarget});assert.notEqual(forbidden.status,0,'no third round or second registration');assert.deepEqual(fs.readFileSync(state),completedBytes);
 const finish=read();assert.deepEqual(finish.records.slice(0,originalSecond.records.length),originalSecond.records);assert.deepEqual(finish.records.slice(0,before.records.length),before.records);assert.deepEqual(finish.fingerprints,before.fingerprints);
 const checkpoint=finish.records.findLast(r=>r.payload.type==='effect-checkpoint').payload.checkpoint;
 assert.deepEqual(checkpoint.receipts.map(r=>r.result.verdict),(materialReviewMode?['blocked','blocked','blocked','approved']:['blocked','blocked','approved']));assert(checkpoint.calls.length===(chainMode?expectedCalls:materialReviewMode?11:transportRetryMode?10:technicalRetryMode?9:8),'all original calls and explicitly authorized technical review retained');
 for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);
 fixtureSucceeded=true;
});
