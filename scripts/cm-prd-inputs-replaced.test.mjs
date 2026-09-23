import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {savePrdDraft} from '../runtime/js/cm-prd/draft-save.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
import {inspectPrdFindings} from '../runtime/js/cm-prd/review-findings.mjs';
import {recordPrdHostDisposition} from '../runtime/js/cm-prd/review-disposition.mjs';
import {assertPrdReviewsSettled} from '../runtime/js/cm-prd/change.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-replaced-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'user');
after(()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));
const checked=({draft})=>({draftDigest:draft.draftDigest,features:draft.features.map(f=>({directory:f.directory,
  checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic fixture']}))}))});
async function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-replaced-')));
  let session,closed=false; const close=()=>{if(!closed){session?.close();closed=true;}}; t.after(()=>{close();fs.rmSync(dir,{recursive:true,force:true});});
  for(const name of ['old/docs','new/docs'])fs.mkdirSync(path.join(dir,name),{recursive:true});
  fs.writeFileSync(path.join(dir,'old/docs/input.md'),'Original synthetic requirement');
  fs.writeFileSync(path.join(dir,'new/docs/input.md'),'Corrected synthetic requirement');
  const entry={skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:path.join(dir,'old')};
  const options={input:entry,runtime:'codex',record:()=>{},
    analyze:async()=>({status:'analyzed',summary:'Synthetic batch',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async()=>({status:'draft',summary:'Synthetic batch',features:['alpha','beta'].map(name=>({name,
      testCasesReason:'no_observable_behavior',documents:[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Explain setup.'},
        {path:'design.md',content:'## 方案摘要\nDocumentation'},{path:'tasks.md',content:'- [ ] T-001: Explain setup'}]}))}),checkContext:async p=>checked(p)};
  const analysis=createCmPrdAnalysis(options);await analysis.advance('Analyze');await analysis.plan('Draft');await analysis.verify();
  savePrdDraft({specs:entry.specs,writeEnabled:true,getDraft:()=>analysis.currentDraftForSave()});
  const prepare=()=>analysis.prepareReview('split','1.alpha');
  await runPrdHostReview({specs:entry.specs,prepared:prepare(),authorContextId:'author',writeEnabled:true,mode:'independent',
    revalidate:prepare,signal:new AbortController().signal,review:async p=>({reviewer:'codex-subagent',contextId:'reviewer',
      independent:true,at:'2026-09-08T00:00:00.000Z',result:{verdict:'approved',packageDigest:p.package.packageDigest,
        examinedPaths:p.examinedPaths,findings:[],summary:'Synthetic review'}})});
  const findings=inspectPrdFindings({specs:entry.specs,stage:'split',feature:'1.alpha'});
  recordPrdHostDisposition({specs:entry.specs,stage:'split',feature:'1.alpha',packageDigest:findings.packageDigest,
    decisions:[],artifacts:findings.reviewedArtifacts,writeEnabled:true});
  const sessionId='prd-old-fixture',identity={entry,runtime:'codex'};
  session=openPrdSession({specs:entry.specs,sessionId,identity});
  session.checkpoint({analysis:analysis.checkpoint(),change:null,started:true,routeTurn:0,reviewState:null,summaryState:null,publishedSummary:false});
  const change=()=>fs.writeFileSync(path.join(entry.specs,'docs/input.md'),'Corrected synthetic requirement');
  return {dir,entry,options,analysis,session,sessionId,identity,change,close,successorSpecs:path.join(dir,'new')};
}
test('F8 current-main probe: changed source blocks B review, revision and process restore',async t=>{
  const f=await fixture(t);f.change();
  assert.throws(()=>f.analysis.prepareReview('split','2.beta'),/prd_inputs_changed/);
  assert.throws(()=>assertPrdReviewsSettled(f.entry.specs,['1.alpha','2.beta'],{requireSplit:true}),/prd_revision_original_split_required/);
  assert.throws(()=>createCmPrdAnalysis({...f.options,restored:f.analysis.checkpoint()}),/prd_inputs_changed/);
  console.log('F8 probe: A=disposition_recorded; B=prd_inputs_changed; revision=prd_revision_original_split_required; restore=prd_inputs_changed');
});

const replacementModule=()=>import('../runtime/js/cm-prd/inputs-replaced.mjs');
const replaceArgs=f=>({session:f.session,sessionId:f.sessionId,approved:true,reason:'User corrected the source requirement',
  successorSpecs:f.successorSpecs,successorSessionId:'prd-new-fixture'});
const fileBytes=f=>Object.fromEntries(fs.readdirSync(path.join(f.entry.specs,'.reviews')).filter(n=>fs.statSync(path.join(f.entry.specs,'.reviews',n)).isFile())
  .map(n=>[n,fs.readFileSync(path.join(f.entry.specs,'.reviews',n)).toString('base64')]));
test('drifted checkpoint can open read-only without accepting changed inputs or rewriting baseline',async t=>{
  const f=await fixture(t),before=f.analysis.checkpoint();f.change();
  const restored=createCmPrdAnalysis({...f.options,restored:before,allowInputDrift:true});
  assert.deepEqual(restored.checkpoint(),before);
  assert.throws(()=>restored.validateCurrent(),/prd_inputs_changed/);
  for(const key of ['sourceDigest','configDigest'])for(const value of [null,'invalid']){
    const corrupt={...before,[key]:value};
    assert.throws(()=>createCmPrdAnalysis({...f.options,restored:corrupt,allowInputDrift:true}),/prd_inputs_changed/);
  }
});
test('replacement requires explicit approval, reason, actual change and a fresh successor',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule(),args=replaceArgs(f);
  assert.throws(()=>replacePrdInputs(args),/prd_inputs_not_changed/);f.change();
  for(const bad of [{approved:false},{approved:'true'},{reason:' '},{successorSpecs:f.entry.specs},{successorSessionId:f.sessionId}])
    assert.throws(()=>replacePrdInputs({...args,...bad}));
  fs.mkdirSync(path.join(f.successorSpecs,'1.alpha'));
  assert.throws(()=>replacePrdInputs(args),/prd_successor_not_fresh/);
});
test('terminal receipt preserves reviews, pending stages and exact original checkpoint immutably',async t=>{
  const f=await fixture(t),{replacePrdInputs,readPrdInputsReplacement}=await replacementModule();f.change();
  const before=fileBytes(f),state=fs.readFileSync(path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/state.json'));
  const receipt=replacePrdInputs(replaceArgs(f));
  assert.equal(receipt.status,'inputs_replaced');assert.equal(receipt.reason,replaceArgs(f).reason);
  assert.deepEqual(receipt.unreviewed,[{feature:'2.beta',stage:'split',outcome:'dispatch_once'}]);
  assert.equal(receipt.oldInputs.sourceDigest,f.analysis.checkpoint().sourceDigest);
  assert.notEqual(receipt.oldInputs.sourceDigest,receipt.replacementInputs.sourceDigest);
  assert.deepEqual(receipt.sessionState,f.session.state);assert.deepEqual(fileBytes(f),before);
  assert.deepEqual(fs.readFileSync(path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/state.json')),state);
  assert.equal(receipt.reviewRecords.length,Object.keys(before).length);
  assert.ok(receipt.reviewRecords.length>=3);
  for(const record of receipt.reviewRecords)assert.equal(record.bytes,before[path.basename(record.path)]);
  const file=path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/inputs-replaced.json'),bytes=fs.readFileSync(file);
  assert.deepEqual(replacePrdInputs(replaceArgs(f)),receipt);
  assert.throws(()=>replacePrdInputs({...replaceArgs(f),reason:'Different reason'}),/prd_replacement_conflict/);
  assert.deepEqual(fs.readFileSync(file),bytes);
  // Reading history does not require current input files.
  fs.unlinkSync(path.join(f.entry.specs,'docs/input.md'));
  assert.deepEqual(readPrdInputsReplacement(f.entry.specs,f.sessionId),receipt);
});
test('ended batch refuses summary publication and review even through direct owners',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule();f.change();replacePrdInputs(replaceArgs(f));
  const {inspectPrdSummaryEvidence,publishPrdAwaitingReview}=await import('../runtime/js/cm-prd/summary.mjs');
  const {preparePrdReview}=await import('../runtime/js/cm-prd/review-preparation.mjs');
  assert.throws(()=>inspectPrdSummaryEvidence(f.entry.specs),/prd_batch_inputs_replaced/);
  assert.throws(()=>publishPrdAwaitingReview({specs:f.entry.specs,summary:{},writeEnabled:true}),/prd_batch_inputs_replaced/);
  assert.throws(()=>preparePrdReview({specs:f.entry.specs,stage:'split',feature:'2.beta',draft:f.analysis.status().draft}),/prd_batch_inputs_replaced/);
});
test('successor binds exact new inputs and predecessor, inherits no approvals and reports lineage',async t=>{
  const f=await fixture(t),{replacePrdInputs,bindPrdPredecessor,readPrdPredecessor}=await replacementModule();f.change();
  const receipt=replacePrdInputs(replaceArgs(f));
  const predecessor=path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/inputs-replaced.json');
  const entry={...f.entry,specs:f.successorSpecs},args={entry,runtime:'codex',sessionId:'prd-new-fixture',predecessor};
  assert.throws(()=>bindPrdPredecessor({...args,sessionId:'prd-other'}),/prd_predecessor_binding/);
  fs.appendFileSync(path.join(f.successorSpecs,'docs/input.md'),' drift');
  assert.throws(()=>bindPrdPredecessor(args),/prd_predecessor_inputs_changed/);
  fs.writeFileSync(path.join(f.successorSpecs,'docs/input.md'),'Corrected synthetic requirement');
  const link=bindPrdPredecessor(args);assert.equal(link.receiptDigest,receipt.receiptDigest);
  const linkFile=path.join(entry.specs,'.reviews/prd-predecessor.json'),linkBytes=fs.readFileSync(linkFile);
  fs.writeFileSync(linkFile,JSON.stringify({...link,reason:'Forged predecessor reason'}));
  assert.throws(()=>readPrdPredecessor(entry.specs),/prd_predecessor_binding/);fs.writeFileSync(linkFile,linkBytes);
  const next=createCmPrdAnalysis({...f.options,input:entry});
  assert.equal(next.status().stage,'ready');assert.equal(next.status().selfCheckRound,0);
  await next.advance('Analyze');await next.plan('Draft');await next.verify();
  savePrdDraft({specs:entry.specs,writeEnabled:true,getDraft:()=>next.currentDraftForSave()});
  const {createPrdSummaryOwner}=await import('../runtime/js/cm-prd/summary.mjs');
  const owner=createPrdSummaryOwner({summarize:async({evidence,evidenceDigest})=>({evidenceDigest,deliveryForm:'Docs',estimatedTime:'Unknown',
    openQuestions:'None',risks:'Synthetic',contextScope:'Fixture',platformReadiness:'N/A',uiBaseline:'N/A',
    designRisk:evidence.features.map(f=>({feature:f.directory,evidence:['Existing documentation'],signals:{greenfieldAdr:false,
      architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,publicContractDataOrSecurity:false,fiveOrMoreFunctions:false}}))})});
  const summary=await owner(entry.specs,{currentFeatures:['1.alpha','2.beta']});
  assert.equal(summary.predecessor.receiptDigest,receipt.receiptDigest);
  assert.match(summary.details.risks,/prd-old-fixture/);
  assert.equal(summary.readyForAwaitingReview,false);
  assert.ok(summary.blockers.includes('1.alpha: split_review_disposition_required'));
  assert.ok(summary.features.every(f=>f.reviews.split.gate.outcome==='dispatch_once'));
  const originalReviews=fileBytes(f);
  for(const feature of ['1.alpha','2.beta']){
    const prepare=()=>next.prepareReview('split',feature);
    await runPrdHostReview({specs:entry.specs,prepared:prepare(),authorContextId:'new-author',writeEnabled:true,mode:'independent',
      revalidate:prepare,signal:new AbortController().signal,review:async p=>({reviewer:'codex-subagent',contextId:'new-reviewer',
        independent:true,at:'2026-09-09T00:00:00.000Z',result:{verdict:'approved',packageDigest:p.package.packageDigest,
          examinedPaths:p.examinedPaths,findings:[],summary:'New independent fixture review'}})});
    const findings=inspectPrdFindings({specs:entry.specs,stage:'split',feature});
    recordPrdHostDisposition({specs:entry.specs,stage:'split',feature,packageDigest:findings.packageDigest,
      decisions:[],artifacts:findings.reviewedArtifacts,writeEnabled:true});
  }
  const reviewed=await owner(entry.specs,{currentFeatures:['1.alpha','2.beta']});assert.equal(reviewed.readyForAwaitingReview,true);
  const {publishPrdAwaitingReview}=await import('../runtime/js/cm-prd/summary.mjs');
  assert.equal(publishPrdAwaitingReview({specs:entry.specs,summary:reviewed,writeEnabled:true}).status,'awaiting_review');
  assert.deepEqual(fileBytes(f),originalReviews);

});

async function client(t,f,{specs=f.entry.specs,sessionId=f.sessionId,predecessor}={}){
  fs.mkdirSync(path.join(f.dir,'mirror'),{recursive:true});
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',f.entry.skillDir,
    '--project',f.dir,'--specs',specs,'--runtime','codex','--allow-log-write','--session',sessionId,
    ...(predecessor?['--predecessor',predecessor]:[])],
    {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.dir,'mirror')},stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout}),queue=[],waiters=[];let stderr='',seq=0;
  child.stderr.on('data',chunk=>stderr+=chunk);
  lines.on('line',line=>{const value=JSON.parse(line),i=waiters.findIndex(w=>w.match(value));
    if(i<0)queue.push(value);else waiters.splice(i,1)[0].resolve(value);});
  const wait=match=>{const i=queue.findIndex(match);return i<0?new Promise(resolve=>waiters.push({match,resolve})):Promise.resolve(queue.splice(i,1)[0]);};
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;lines.close();});
  const ready=await Promise.race([wait(m=>m.type==='host_ready'),closed.then(()=>{throw Error(stderr);})]);
  return {request:async(operation,fields={})=>{const requestId=`request-${++seq}`,reply=wait(m=>m.requestId===requestId);
    send({requestId,operation,...fields});return reply;},
    close:async()=>{send({type:'host_close',sessionId:ready.sessionId});assert.equal((await closed)[0],0,stderr);}};
}
test('actual CLI: changed-input restart, authorized end, read after sources deleted, and linked fresh start', {timeout:30000},async t=>{
  const f=await fixture(t);f.close();f.change();let c=await client(t,f);
  assert.equal((await c.request('status')).result.stage,'self_check_reported_passed');
  const blocked=await c.request('final_review_package',{stage:'split',feature:'2.beta'});assert.equal(blocked.result?.reason,'prd_inputs_changed',JSON.stringify(blocked));
  assert.equal((await c.request('prepare_revision',{reason:'Cannot skip beta'})).result.reason,'prd_inputs_changed');
  const args={approved:true,reason:'Corrected requirement',successorSpecs:f.successorSpecs,successorSessionId:'prd-new-fixture'};
  assert.equal((await c.request('replace_inputs',{...args,approved:false})).result.reason,'prd_replacement_authorization_required');
  assert.equal((await c.request('replace_inputs',args)).result.stage,'inputs_replaced');
  const archived=(await c.request('read_batch')).result;
  for(const operation of ['prepare_summary','publish_summary','prepare_revision','final_review','review_disposition','resume','cancel','advance'])
    assert.equal((await c.request(operation)).result.reason,'prd_batch_inputs_replaced',operation);
  await c.close();fs.unlinkSync(path.join(f.entry.specs,'docs/input.md'));c=await client(t,f);
  assert.equal((await c.request('status')).result.stage,'inputs_replaced');
  assert.deepEqual((await c.request('read_batch')).result,archived);await c.close();
  c=await client(t,f,{specs:f.successorSpecs,sessionId:'prd-new-fixture',predecessor:path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/inputs-replaced.json')});
  const next=(await c.request('status')).result;assert.equal(next.stage,'ready');assert.equal(next.selfCheckRound,0);
  assert.equal(next.predecessor.sessionId,'prd-old-fixture');assert.equal(next.reviewState,null);await c.close();
});
test('replacement archives an interrupted review as unknown and never replays its pending call',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule();
  f.session.begin({requestId:'pending',operation:'final_review',stage:'split',feature:'2.beta',mode:'independent'},f.session.state.checkpoint);
  await assert.rejects(f.session.call('prd_review',{synthetic:true},new AbortController().signal,async()=>{throw Error('fixture disconnect');}));
  f.change();const receipt=replacePrdInputs(replaceArgs(f));
  assert.equal(receipt.sessionState.active.calls.length,1);
  assert.equal(Object.hasOwn(receipt.sessionState.active.calls[0],'result'),false);
  assert.ok(receipt.unreviewed.some(r=>r.feature==='2.beta'));
});

test('terminal blocks stale prepared review, draft saves and session replacement bypasses',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule();
  const prepared=f.analysis.prepareReview('split','2.beta');f.change();replacePrdInputs(replaceArgs(f));
  assert.throws(()=>savePrdDraft({specs:f.entry.specs,writeEnabled:true,getDraft:()=>f.analysis.status().draft}),/prd_batch_inputs_replaced/);
  let calls=0;
  await assert.rejects(runPrdHostReview({specs:f.entry.specs,prepared,authorContextId:'author',writeEnabled:true,mode:'independent',
    signal:new AbortController().signal,revalidate:()=>prepared,review:async()=>{calls++;throw Error('must not dispatch');}}),/prd_batch_inputs_replaced/);
  assert.equal(calls,0);
  assert.throws(()=>createCmPrdAnalysis(f.options),/prd_batch_inputs_replaced/);
});
test('successor link alone cannot accept later inputs before a durable session starts',async t=>{
  const f=await fixture(t),{replacePrdInputs,bindPrdPredecessor}=await replacementModule();f.change();replacePrdInputs(replaceArgs(f));
  const args={entry:{...f.entry,specs:f.successorSpecs},runtime:'codex',sessionId:'prd-new-fixture',
    predecessor:path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/inputs-replaced.json')};
  bindPrdPredecessor(args);fs.appendFileSync(path.join(f.successorSpecs,'docs/input.md'),' drift after link write');
  assert.throws(()=>bindPrdPredecessor(args),/prd_predecessor_inputs_changed/);
});

test('effective configuration changes can terminate without rebasing the restored checkpoint',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule(),before=f.analysis.checkpoint();
  fs.writeFileSync(path.join(f.successorSpecs,'docs/input.md'),'Original synthetic requirement');
  fs.writeFileSync(path.join(f.dir,'.cm-workflow.json'),JSON.stringify({version:1,policies:{generate_cases:false}}));
  const restored=createCmPrdAnalysis({...f.options,restored:before,allowInputDrift:true});
  assert.deepEqual(restored.checkpoint(),before);assert.throws(()=>restored.validateCurrent(),/prd_inputs_changed/);
  const receipt=replacePrdInputs(replaceArgs(f));
  assert.notEqual(receipt.oldInputs.configDigest,receipt.replacementInputs.configDigest);
});

test('replacement refuses an already published batch even when its session checkpoint predates publication',async t=>{
  const f=await fixture(t),{replacePrdInputs}=await replacementModule();f.change();
  // Crash prefix: the status owner wrote publication before the session committed it.
  fs.writeFileSync(path.join(f.entry.specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.alpha','2.beta']}));
  assert.throws(()=>replacePrdInputs(replaceArgs(f)),/prd_replacement_not_ready/);
  assert.equal(fs.existsSync(path.join(f.entry.specs,'.reviews/prd-sessions/prd-old-fixture/inputs-replaced.json')),false);
});
