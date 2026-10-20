import {exerciseProviderRecovery} from './provider-review-recovery-fixture.mjs';
// Uses the real formal driver, owner lock, store, adapter, task gate and QA.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {digest} from '../../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,effectSlotFree} from '../../runtime/js/cm-ai/durable-runner-state.mjs';
import {evidenceContinuationSource} from '../../runtime/js/cm-ai/valid-review-evidence-continuation.mjs';
import {openExecutionStore} from '../../runtime/js/cm-ai/execution-store.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function exerciseValidEvidenceContinuation({f,drive,read,state,sourceRoot,png,frozen,expectedCalls}){
 const shown=drive('status'),initial=read(),held=fs.readFileSync(state),old=readRunnerHistory(initial.records,initial.records[0].payload.config,3);
 assert.equal(shown.value.state,'blocked');assert.equal(shown.value.code,'review_blocked');
 const source=shown.value.evidenceContinuation?.source;assert(source,'valid blocked owner must expose evidence-only source');
 for(const changed of [{...old.state,state:'approved'},{...old.state,state:'changes_requested'},{...old.state,receipt:{...old.state.receipt,result:{...old.state.receipt.result,verdict:'approved'}}},{...old.state,receipt:{...old.state.receipt,result:{...old.state.receipt.result,findings:[]}}}])assert.throws(()=>evidenceContinuationSource(initial.records,changed,{...initial.records[0].payload.config,scope:old.effectiveScope},old.original,old.nativeCorrection));
 assert.equal(source.revision,initial.revision);assert.equal(source.oldReceiptDigest,old.state.receipt.receiptDigest);
 const oldFiles=['work-T-001-native-correction-1-material-1.md','work-T-001-native-correction-1-material-1-receipt.json'].map(name=>({file:path.join(f.specsDir,'.reviews',name),bytes:fs.readFileSync(path.join(f.specsDir,'.reviews',name))}));
 const root=path.join(f.root,'new-evidence');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'supplemental.png'),png);
 const text=Buffer.from('{"visualObservation":"new exact evidence, not acceptance"}\n');fs.writeFileSync(path.join(root,'observation.json'),text);
 const manifest={version:2,report:'New evidence author claims only, original source unchanged',sourceFiles:old.state.reviewPackage.checks.find(c=>c.kind==='native-evidence').material.sourceFiles,
  images:[{path:'supplemental.png',sha256:sha(png),size:png.length,description:'New synthetic observation'}],
  textEvidence:{version:1,sourceRoot:root,files:[{id:'observation',path:'observation.json',mediaType:'application/json',sha256:sha(text),size:text.length,description:'Exact observation'}],requirements:[{id:'observation-complete',fileId:'observation',pointers:['/visualObservation']}]}};
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
 const value={version:1,reason:'User authorizes data registration only',evidenceContinuation:true,source,nativeEvidence:{version:1,sourceRoot:root,manifest:'manifest.json'},
  manifestDigest:sha(fs.readFileSync(path.join(root,'manifest.json'))),findings:[{id:'C1',disposition:'Author supplies evidence for independent reassessment; not resolved',evidenceIds:['observation','supplemental.png']}]};
 const file=path.join(f.root,'evidence-register.json'),save=v=>fs.writeFileSync(file,JSON.stringify(v));save(value);
 const launch=shown.value.launchControlTarget,register=(v=value,target=launch)=>{save(v);return drive('status',{evidenceRequestFile:file,target});};
 if(process.env.CM_VALID_EVIDENCE_BASELINE){
  const plan=path.join(f.root,'PLAN-evidence-red.json');
  // Preserve the exact original configuration/permissions used by the fixture.
  const prior=JSON.parse(fs.readFileSync(path.join(f.root,'PLAN-'+(fs.readdirSync(f.root).filter(n=>/^PLAN-[0-9]+\.json$/.test(n)).length)+'.json')));
  fs.writeFileSync(path.join(f.root,'launch.json'),JSON.stringify(launch));
  fs.writeFileSync(plan,JSON.stringify({...prior,permissions:[...prior.permissions,'--native-correction',file,'--expected-control','launch.json']}));
  const red=spawnSync(process.execPath,[path.join(process.env.CM_VALID_EVIDENCE_BASELINE,'scripts/cm-ai-drive.mjs'),'--plan',plan,'status'],{env:f.env,encoding:'utf8',timeout:40000});
  assert.notEqual(red.status,0);assert.deepEqual(fs.readFileSync(state),held);process.stderr.write('[red baseline] valid blocked evidence-only registration rejected without mutation or new calls\n');
 }
 for(const key of ['hostContextId','revision','oldReceiptDigest','oldPackageDigest','configDigest','baselineDigest','candidateDigest']){
  const changed={...source,[key]:key==='hostContextId'?'wrong-owner':'0'.repeat(64)};assert.notEqual(register({...value,source:changed}).status,0,key);assert.deepEqual(fs.readFileSync(state),held);
 }
 assert.notEqual(register({...value,manifestDigest:'0'.repeat(64)}).status,0);assert.deepEqual(fs.readFileSync(state),held);
 const mfile=path.join(root,'manifest.json'),mbytes=fs.readFileSync(mfile);fs.writeFileSync(mfile,JSON.stringify({...manifest,report:'Changed after preview'}));assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),held);fs.writeFileSync(mfile,mbytes);
 assert.notEqual(register({...value,findings:[]}).status,0);assert.deepEqual(fs.readFileSync(state),held);
 assert.notEqual(register({...value,findings:[{...value.findings[0],evidenceIds:['invented']}]}).status,0);assert.deepEqual(fs.readFileSync(state),held);
 const code=path.join(f.codeProject,'target.mjs'),codeBytes=fs.readFileSync(code);fs.writeFileSync(code,'export const value = 999;\n');
 assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),held);fs.writeFileSync(code,codeBytes);
 const writer=openExecutionStore({specsRoot:f.specsDir,identity:initial.identity,fingerprints:initial.fingerprints,create:false});
 try{assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),held);}finally{writer.close();}
 const registered=register();assert.equal(registered.status,0,registered.stderr);assert.equal(registered.value.state,'blocked');assert.equal(registered.value.evidenceContinuation.remainingReview,0);
 const data=read(),h=readRunnerHistory(data.records,data.records[0].payload.config,3);assert.equal(h.state.calls.length,expectedCalls);assert.deepEqual(h.nativeCorrection,old.nativeCorrection);
 assert.equal(h.state.reviewPackage.packageDigest,old.state.reviewPackage.packageDigest);assert.equal(h.evidenceContinuation.reviewPackage.baseIdentity,old.state.reviewPackage.baseIdentity);
 const registeredBytes=fs.readFileSync(state);assert.equal(register().status,0,'exact duplicate registration is accepted idempotently');assert.deepEqual(fs.readFileSync(state),registeredBytes);
 assert.notEqual(drive('decision',{packageDigest:old.state.reviewPackage.packageDigest}).value?.state,'approved');assert.deepEqual(fs.readFileSync(state),registeredBytes,'registration grants no model authority');
 const authStatus=drive('status'),auth={version:1,reason:'User separately authorizes one new independent review',evidenceReview:true,source:authStatus.value.evidenceContinuation.reviewSource};
 assert(auth.source);
 for(const key of ['hostContextId','oldReceiptDigest','candidateDigest']){save({...auth,source:{...auth.source,[key]:key==='hostContextId'?'wrong-owner':'0'.repeat(64)}});assert.notEqual(drive('status',{evidenceRequestFile:file,target:authStatus.value.launchControlTarget}).status,0);assert.deepEqual(fs.readFileSync(state),registeredBytes);}
 const sourceImage=path.join(root,'supplemental.png'),imageBytes=fs.readFileSync(sourceImage);fs.writeFileSync(sourceImage,Buffer.alloc(imageBytes.length));save(auth);assert.notEqual(drive('status',{evidenceRequestFile:file,target:authStatus.value.launchControlTarget}).status,0);assert.deepEqual(fs.readFileSync(state),registeredBytes);fs.writeFileSync(sourceImage,imageBytes);
 save(auth);const authorize=()=>drive('status',{evidenceRequestFile:file,target:authStatus.value.launchControlTarget});
 const granted=authorize();assert.equal(granted.status,0,granted.stderr);assert.equal(granted.value.state,'awaiting_review');
 const grant=read(),g=readRunnerHistory(grant.records,grant.records[0].payload.config,3);assert.equal(g.state.calls.length,expectedCalls);assert.deepEqual(g.nativeCorrection,old.nativeCorrection);
 assert.equal(authorize().status,0);assert.deepEqual(read(),grant,'duplicate authority cannot grant twice');
 const result=drive('decision',{packageDigest:g.state.reviewPackage.packageDigest}),verdict=fs.existsSync(path.join(f.root,'evidence-verdict.json'))?JSON.parse(fs.readFileSync(path.join(f.root,'evidence-verdict.json'),'utf8')):process.env.CM_VALID_EVIDENCE_VERDICT??'approved';
 if(process.env.CM_PROVIDER_RECOVERY_FIXTURE==='1'){exerciseProviderRecovery({f,drive,read,state,frozen});return;}
 assert.equal(result.status,0,result.stderr+' '+JSON.stringify(result.value));
 const accepted=read(),a=readRunnerHistory(accepted.records,accepted.records[0].payload.config,3);
 assert.equal(a.state.calls.length,expectedCalls+1);assert.deepEqual(a.state.calls.slice(0,expectedCalls),old.state.calls);assert.equal(a.evidenceContinuation.consumed,true);
 assert.deepEqual(a.nativeCorrection,old.nativeCorrection);assert.equal(a.state.receipt.result.verdict,verdict);assert.equal(a.state.receipts.length,old.state.receipts.length+1);
 assert.notEqual(a.state.calls.at(-1).providerThreadId,old.state.calls.at(-1).providerThreadId);
 assert.equal(effectSlotFree('develop',a.state.cache,a.state.calls,[],null,'develop',a.state,a.nativeCorrection,a.evidenceContinuation),false);
 assert.equal(effectSlotFree('review',a.state.cache,a.state.calls,[],null,a.evidenceContinuation.authorization.reviewEffectId,a.state,a.nativeCorrection,a.evidenceContinuation),false);
 for(const row of oldFiles)assert.deepEqual(fs.readFileSync(row.file),row.bytes,'old valid blocked publication immutable');
 for(const end of [accepted.records.findLastIndex(r=>r.payload.type==='effect-intent')+1,accepted.records.length]){
  const prefix=accepted.records.slice(0,end),p=readRunnerHistory(prefix,prefix[0].payload.config,3);assert.equal(p.evidenceContinuation.consumed,true,'intent consumes slot at every crash prefix');
 }
 if(verdict!=='approved'){
  assert.equal(result.value.state,'blocked');assert.equal(result.value.code,verdict==='blocked'?'review_blocked':'review_limit');
  assert.equal(drive('status').value.evidenceContinuation.source,null,'no second evidence registration');
  assert.notEqual(drive('complete',{packageDigest:a.state.reviewPackage.packageDigest}).value?.state,'fixture_completed');
  assert.doesNotMatch(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\]/);return;
 }
 // Exact same-call saved result is recovered without another invocation.
 const startedIndex=accepted.records.findLastIndex(r=>r.payload.type==='review-invocation-started');
 const {revision,...prefixBody}=accepted,prefix={...prefixBody,records:accepted.records.slice(0,startedIndex+1)};prefix.revision=digest(prefix);
 const last=prefix.records.at(-1),cancelBody={version:1,seq:prefix.records.length+1,id:`runner.${String(prefix.records.length+1).padStart(6,'0')}`,kind:'cancel',payload:{version:3,protocol:'cm-task-runner',type:'control',event:'cancel'},previousDigest:last.digest};
 const {revision:prefixRevision,...prefixData}=prefix,cancelData={...prefixData,records:[...prefix.records,{...cancelBody,digest:digest(cancelBody)}]},cancelled={...cancelData,revision:digest(cancelData)};fs.writeFileSync(state,JSON.stringify(cancelled)+'\n');
 const cancelStatus=drive('status'),cancelBytes=fs.readFileSync(state);assert.notEqual(cancelStatus.value.reviewReconciliation?.available,true);assert.notEqual(drive('reconcile_review',{wireTarget:cancelStatus.value.controlTarget,invocationId:a.state.receipt.id}).status,0);assert.deepEqual(fs.readFileSync(state),cancelBytes,'cancelled continuation cannot accept a saved result');
 fs.writeFileSync(state,JSON.stringify(prefix)+'\n');
 const waiting=drive('status');assert.equal(waiting.value.pendingAction,'reconcile_review',JSON.stringify(waiting.value));
 const resumed=drive('reconcile_review',{wireTarget:waiting.value.controlTarget,invocationId:a.state.receipt.id});assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.value.state,'approved');
 assert.equal(readRunnerHistory(read().records,read().records[0].payload.config,3).state.calls.length,expectedCalls+1);
 const observed=read(),resultAt=observed.records.findLastIndex(row=>row.payload.type==='review-invocation-result'),{revision:observedRevision,...observedBody}=observed,resultPrefix={...observedBody,records:observed.records.slice(0,resultAt+1)};resultPrefix.revision=digest(resultPrefix);fs.writeFileSync(state,JSON.stringify(resultPrefix)+'\n');
 const observedResume=drive('status');assert.equal(observedResume.status,0,observedResume.stderr);assert.equal(observedResume.value.state,'approved');const observedRecovered=read();assert.deepEqual(observedRecovered.records.slice(0,resultPrefix.records.length),resultPrefix.records);assert.equal(readRunnerHistory(observedRecovered.records,observedRecovered.records[0].payload.config,3).state.calls.length,expectedCalls+1);
 const stable=fs.readFileSync(state);assert.equal(drive('status').value.state,'approved');assert.deepEqual(fs.readFileSync(state),stable);
 const completed=drive('complete',{packageDigest:a.state.reviewPackage.packageDigest});assert.equal(completed.status,0,completed.stderr);assert.equal(completed.value.state,'fixture_completed',JSON.stringify(completed.value));
 const qa=drive('advance');assert.equal(qa.status,0,qa.stderr);assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/^- \[x\] T-001/m);
 const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.node==='N6'&&r.event==='test_run'&&r.phase==='complete'&&r.result==='PASS').length,1);
 for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);
}

// These cases share one exact native owner and immutable publication paths.
// They must be queued; each completed branch is retained before restoring the
// temporary fixture seed. No production state is ever reset or copied here.
export function exerciseValidEvidenceScenarios(context){
 const {f,read,state,drive}=context,seed=fs.readFileSync(state),tasks=path.join(f.specsDir,'1.work/tasks.md'),taskBytes=fs.readFileSync(tasks);
 const archive=path.join(f.root,'evidence-scenario-results');fs.mkdirSync(archive,{mode:0o700});
 const actualCalls=readRunnerHistory(read().records,read().records[0].payload.config,3).state.calls.length;
 if(process.env.CM_PROVIDER_RECOVERY_FIXTURE==='1'){fs.writeFileSync(path.join(f.root,'evidence-verdict.json'),JSON.stringify('provider_failed'));exerciseValidEvidenceContinuation(context);return;}
 for(const verdict of ['blocked','changes_requested','approved']){
  fs.writeFileSync(path.join(f.root,'evidence-verdict.json'),JSON.stringify(verdict));
  exerciseValidEvidenceContinuation(context);
  // A synchronous driver has exited before returning. Reacquiring its actual
  // writer lock also proves no owner descriptor survives before seed restore.
  const snapshot=read(),lock=openExecutionStore({specsRoot:f.specsDir,identity:snapshot.identity,fingerprints:snapshot.fingerprints,create:false});lock.close();
  const destination=path.join(archive,verdict);fs.mkdirSync(destination,{mode:0o700});
  fs.writeFileSync(path.join(destination,'state.json'),fs.readFileSync(state),{mode:0o600});
  for(const name of ['evidence-register.json','evidence-verdict.json','launch.json'])fs.copyFileSync(path.join(f.root,name),path.join(destination,name));
  const output=drive('status');fs.writeFileSync(path.join(destination,'status.json'),JSON.stringify({status:output.status,result:output.value})+'\n',{mode:0o600});
  for(const name of ['work-T-001-native-correction-1-evidence-1.md','work-T-001-native-correction-1-evidence-1-receipt.json']){
   const source=path.join(f.specsDir,'.reviews',name);fs.renameSync(source,path.join(destination,name));
  }
  process.stderr.write(`[evidence scenario] ${verdict}: original ${actualCalls} calls retained, one fresh review, owner receipt and branch journal preserved\n`);
  if(verdict!=='approved'){fs.writeFileSync(state,seed);assert.deepEqual(fs.readFileSync(tasks),taskBytes);}
  else {
   // Keep the successful branch's active projection after recording its copy.
   for(const name of ['work-T-001-native-correction-1-evidence-1.md','work-T-001-native-correction-1-evidence-1-receipt.json'])fs.copyFileSync(path.join(destination,name),path.join(f.specsDir,'.reviews',name));
  }
 }
}
