import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createTaskRunner} from './task-runner.mjs';
import {readRunnerHistory,runnerPayload} from './durable-runner-state.mjs';
import {digest} from './effect-contract.mjs';

// Pure grammar fixtures; this fake storage deliberately makes NO durability claim.
async function history(fn,{twoAttempts=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-runner-grammar-'));
  const identity={repositoryId:'fixture',runId:'grammar',taskId:'T-1',attempt:1};
  let records=[],effects=0;
  const snapshot=()=>({identity:{repositoryId:'fixture',runId:'grammar'},records:structuredClone(records),revision:digest(records)});
  const store={snapshot,append:r=>{assert.equal(r.expectedRevision,digest(records));records.push({id:r.id,kind:r.kind,payload:r.payload});}};
  const terminal=(r,result)=>({version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
    effectiveModel:'fixture',status:'succeeded',accepted:true,result});
  fs.writeFileSync(path.join(root,'a'),'before');fs.writeFileSync(path.join(root,'req'),'requirements');
  const options={root,identity,scope:['a'],requirements:['req'],excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:r=>{effects++;fs.writeFileSync(path.join(root,'a'),'after');return terminal(r,{outcome:'implemented'});}},
    reviewers:[{id:'reviewer',provider:'claude',requestedModel:'fixture',contexts:['r1','r2'],allowed:true,available:true,
      run:r=>{effects++;const findings=twoAttempts&&r.identity.attempt===1?
        [{id:'F1',severity:'P2',path:'a',message:'synthetic',evidence:'fixture'}]:[];
        return terminal(r,{verdict:findings.length?'changes_requested':'approved',packageDigest:r.payload.reviewPackage.packageDigest,
        examinedPaths:['a','req'],findings,summary:'fixture'});}}],
    check:()=>[{id:'unit',command:['unit'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    commit:()=>{effects++;return {outcome:'fixture_completed'};}};
  try {
    const runner=createTaskRunner({...options,persistence:{store,mode:'create'}});
    await runner.run();assert.equal(runner.status().state,'fixture_completed');assert.equal(effects,twoAttempts?5:3);
    const config=records[0].payload.config;
    return await fn({records,config,root,options,store,read:raw=>readRunnerHistory(raw,config)});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('S3b2b every valid prefix is recoverable and unmatched intent is never success',()=>history(({records,read})=>{
  const expected=['ready','unknown','awaiting_review','unknown','approved','unknown','fixture_completed'];
  for(let n=1;n<=records.length;n++) {
    const r=read(records.slice(0,n));assert.equal(r.state.state,expected[n-1]);
    if(n%2===0){assert.equal(r.state.code,'reconciliation_required');assert(r.pending);}
  }
}));

const corruptions={
  'version':r=>{r[0].payload.version=2;},
  'session absent':r=>{delete r[0].payload.session;},
  'session invalid':r=>{r[0].payload.session='bad';},
  'session conflict':r=>{r[2].payload.checkpoint.session='bad';},
  'missing checkpoint cancel flag':r=>{delete r[2].payload.checkpoint.cancellationRequested;},
  'missing cache cancel flag':r=>{delete r[2].payload.checkpoint.cache[0].result.cancellationRequested;},
  'invented cancel flag':r=>{r[2].payload.checkpoint.cancellationRequested=true;r[2].payload.checkpoint.cache[0].result.cancellationRequested=true;},
  'baseline changed':r=>{r[0].payload.baseline.files[0].contentBase64='AA==';},
  'baseline root':r=>{r[0].payload.baseline.rootDigest=digest('other');},
  'config model':r=>{r[0].payload.config.developer.requestedModel='different';},
  'config route':r=>{r[0].payload.config.reviewers[0].allowed=false;},
  'id collision':r=>{r[1].id=r[0].id;},
  'second init':r=>{r[1]=structuredClone(r[0]);r[1].id='runner.000002';},
  'kind mix':r=>{r[3].kind='commit';},
  'extra field':r=>{r[3].payload.extra=true;},
  'checkpoint no intent':r=>{r.splice(1,1);r.forEach((x,i)=>x.id=`runner.${String(i+1).padStart(6,'0')}`);},
  'intent overlap':r=>{r[2]={...r[1],id:r[2].id};},
  'stage':r=>{r[1].payload.effect.kind='complete';},
  'identity':r=>{r[1].payload.effect.identity.taskId='other';},
  'checkpoint intent id':r=>{r[2].payload.effectId='other';},
  'third attempt':r=>{r[4].payload.checkpoint.attempt=3;},
  'call context':r=>{r[4].payload.checkpoint.calls[1].contextId='dev';},
  'call model':r=>{r[4].payload.checkpoint.calls[1].requestedModel='different';},
  'call request':r=>{r[4].payload.checkpoint.calls[1].requestDigest=digest('forged');},
  'call number':r=>{r[4].payload.checkpoint.calls[1].invocationId='fake.2';},
  'call sequence':r=>{r[4].payload.checkpoint.sequence=99;},
  'erase calls':r=>{r[4].payload.checkpoint.calls=[];},
  'prior receipt removed':r=>{r[6].payload.checkpoint.receipts=[];},
  'receipt digest':r=>{r[4].payload.checkpoint.receipt.receiptDigest=digest('forged');},
  'receipt route':r=>{r[4].payload.checkpoint.receipts[0].route.mode='same-provider';},
  'receipt result':r=>{r[4].payload.checkpoint.receipts[0].result.summary='other';},
  'prior review':r=>{r[4].payload.checkpoint.priorReview=null;},
  'old cache replaced':r=>{r[4].payload.checkpoint.cache[0].result.state='approved';},
  'new cache differs':r=>{r[4].payload.checkpoint.cache.at(-1).result.state='fixture_completed';},
  'cache effect':r=>{r[4].payload.checkpoint.cache.at(-1).effect.kind='complete';},
  'checks':r=>{r[4].payload.checkpoint.currentChecks[0].outcome='failed';},
  'package':r=>{r[4].payload.checkpoint.reviewPackage.baseIdentity=digest('forged');},
  'control erase':r=>{r.splice(2,0,{kind:'cancel',payload:{version:1,protocol:'cm-task-runner',type:'control',event:'cancel'}});
    r.forEach((x,i)=>x.id=`runner.${String(i+1).padStart(6,'0')}`);},
};
for(const [name,mutate] of Object.entries(corruptions))test(`S3b2b rejects corrupt ${name}`,()=>history(({records,read})=>{
  const copy=structuredClone(records);mutate(copy);assert.throws(()=>read(copy));
}));

test('S3b2b receipt/request reconstruction is not circular checksum validation',()=>history(({records,read})=>{
  const copy=structuredClone(records),checkpoint=copy[4].payload.checkpoint;
  const forged=checkpoint.calls[1];forged.requestDigest=digest('fabricated request');
  checkpoint.receipt.execution=structuredClone(forged);checkpoint.receipts[0].execution=structuredClone(forged);
  for(const receipt of [checkpoint.receipt,checkpoint.receipts[0]]) {
    const {receiptDigest,...data}=receipt;receipt.receiptDigest=digest(data);
  }
  checkpoint.cache.at(-1).result.calls=structuredClone(checkpoint.calls);
  checkpoint.cache.at(-1).result.receipt=structuredClone(checkpoint.receipt);
  checkpoint.cache.at(-1).result.receipts=structuredClone(checkpoint.receipts);
  assert.throws(()=>read(copy.slice(0,5)),{code:'runner_request'});
}));

test('S3b2b changed source refuses before new dispatch; completed history stays historical',()=>history(({records,root,options,store})=>{
  const before=JSON.stringify(records);fs.writeFileSync(path.join(root,'a'),'later edit');
  const completed=createTaskRunner({...options,persistence:{store,mode:'resume'}});
  assert.equal(completed.status().state,'fixture_completed');assert.equal(JSON.stringify(records),before);
  const stable=records.slice(0,5),approvedStore={snapshot:()=>({identity:{repositoryId:'fixture',runId:'grammar'},records:stable,revision:digest(stable)}),append:()=>assert.fail('no new record')};
  const approved=createTaskRunner({...options,persistence:{store:approvedStore,mode:'resume'}});
  return approved.executeEffect({version:1,id:'complete-1',kind:'complete',identity:options.identity})
    .then(r=>assert.equal(r.code,'package_mismatch'));
}));

// Construct synthetic V2 grammar vectors from isolated fixture execution facts.
// This is not a runtime history migration/reader projection or write authority.
function chain(items){let previousDigest=null;return items.map((r,index)=>{
  const body={version:1,seq:index+1,id:`runner.${String(index+1).padStart(6,'0')}`,kind:r.kind,payload:structuredClone(r.payload),previousDigest};
  const record={...body,digest:digest(body)};previousDigest=record.digest;return record;
});}
async function v2History(fn,{attempt=1}={}){return history(h=>{
  const config=structuredClone(h.config),specsRoot=h.root+'.specs',reviewsDir=path.join(specsRoot,'.reviews');
  const owner={tasksPath:path.join(specsRoot,'login/tasks.md'),feature:'login',specsRoot};
  const fingerprints={workflow:digest('wf'),config:digest('cfg'),inputs:digest('inputs')};
  const handoffs=[1,2].map(n=>path.join(reviewsDir,`login-T-1-a${n}-handoff.json`));
  config.completion={version:1,mode:'fixture-task',owner,fingerprints,reviewsDir,handoffs};
  const records=structuredClone(h.records);
  for(const r of records){r.payload.version=2;if(r.payload.type==='effect-checkpoint'){
    r.payload.checkpoint.taskCommit=null;for(const c of r.payload.checkpoint.cache)c.result.taskCommit=null;
  }}
  records[0].payload.config=config;
  const approved=records.at(-3).payload.checkpoint,outer=chain(records.slice(0,-1)),effect=outer.at(-1).payload.effect;
  const before=Buffer.from('- [ ] T-1: fixture\r\n'),after=Buffer.from('- [x] T-1: fixture\r\n');
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const body={version:1,protocol:'cm-mark-done-plan',feature:'login',taskId:'T-1',attempt,tasksPath:owner.tasksPath,mode:0o640,
    beforeBase64:before.toString('base64'),afterBase64:after.toString('base64'),beforeDigest:sha(before),afterDigest:sha(after),taskRevision:digest('task revision'),
    evidence:handoffs.slice(0,attempt).map(p=>({path:p,revision:digest(p)}))};
  const plan={...body,planDigest:digest(body)},original=records[0].payload.baseline;
  const {baselineDigest,...base}=original,attemptBody={...base,identity:{...base.identity,attempt}};
  const commit={version:1,protocol:'cm-task-commit',type:'intent',identity:effect.identity,owner,fingerprints,plan,
    proof:{root:config.root,baselineDigest:digest(attemptBody),packageDigest:approved.reviewPackage.packageDigest,
      receiptDigest:approved.receipt.receiptDigest,checksDigest:approved.reviewPackage.checksDigest},
    parent:{path:path.dirname(owner.tasksPath),dev:'1',ino:'2',mode:0o755},temporaryName:'.cm-task.12345678-1234-4567-89ab-123456789abc.tmp'};
  const fields={effectId:effect.id,completeIntentDigest:outer.at(-1).digest};
  const withIntent=chain([...outer,{kind:'commit-intent',payload:{version:2,protocol:'cm-task-runner',type:'task-commit-intent',...fields,commit}}]);
  const intent=withIntent.at(-1),resultCommit={version:1,protocol:'cm-task-commit',type:'result',intentDigest:intent.digest,planDigest:plan.planDigest,outcome:'fixture_committed'};
  const withResult=chain([...withIntent,{kind:'commit-result',payload:{version:2,protocol:'cm-task-runner',type:'task-commit-result',...fields,commit:resultCommit}}]);
  const ref={intentDigest:intent.digest,planDigest:plan.planDigest,resultDigest:withResult.at(-1).digest,outcome:'fixture_committed'};
  const final=records.at(-1);final.payload.checkpoint.taskCommit=ref;final.payload.checkpoint.cache.at(-1).result.taskCommit=ref;
  const all=chain([...withResult,final]);
  return fn({records:all,config,read:r=>readRunnerHistory(r,config,2),outerCount:outer.length,intentIndex:outer.length,
    resultIndex:outer.length+1,ref,chain,attempt});
},{twoAttempts:attempt===2});}

for(const attempt of [1,2])test(`C3a V2 every composed prefix and attempt${attempt} retains unknown until checkpoint`,()=>v2History(v=>{
  const complete=v.read(v.records);assert.equal(complete.state.state,'fixture_completed');assert.deepEqual(complete.state.taskCommit,v.ref);
  assert.equal(complete.transaction.intentRecord.digest,v.ref.intentDigest);
  for(const n of [v.outerCount,v.outerCount+1,v.outerCount+2]){
    const restored=v.read(v.records.slice(0,n));assert.equal(restored.state.state,'unknown');assert.equal(restored.state.code,'reconciliation_required');
    assert.equal(restored.state.cache.length,attempt===1?2:4);
    assert.equal(restored.state.taskCommit?.resultDigest??null,n===v.outerCount+2?v.ref.resultDigest:null);
  }
  assert.throws(()=>readRunnerHistory(v.records,v.config));
},{attempt}));

const v2Corruptions={
  'chain digest':v=>{v.records[0].digest=digest('other');},
  'chain previous':v=>{v.records[1].previousDigest=digest('other');},
  'envelope extra':v=>{v.records[0].extra=true;},
  'mixed version':v=>{v.records[0].payload.version=1;},
  'complete association':v=>{v.records[v.intentIndex].payload.completeIntentDigest=digest('other');},
  'effect association':v=>{v.records[v.intentIndex].payload.effectId='other';},
  'proof baseline':v=>{v.records[v.intentIndex].payload.commit.proof.baselineDigest=digest('other');},
  'proof receipt':v=>{v.records[v.intentIndex].payload.commit.proof.receiptDigest=digest('other');},
  'proof checks':v=>{v.records[v.intentIndex].payload.commit.proof.checksDigest=digest('other');},
  'result association':v=>{v.records[v.resultIndex].payload.commit.intentDigest=digest('other');},
  'checkpoint reference':v=>{v.records.at(-1).payload.checkpoint.taskCommit=null;v.records.at(-1).payload.checkpoint.cache.at(-1).result.taskCommit=null;},
  'past cache rewrite':v=>{v.records.at(-1).payload.checkpoint.cache[0].result.taskCommit=v.ref;},
};
for(const [name,mutate] of Object.entries(v2Corruptions))test(`C3a V2 rejects ${name}`,()=>v2History(v=>{
  mutate(v);if(!name.startsWith('chain')&&name!=='envelope extra')v.records=chain(v.records);
  assert.throws(()=>v.read(v.records));
}));

// Update only test-vector chain/reference fields after inserting legitimate
// controls or changing a synthetic before/result ending. Never used by runtime.
function linked(items){
  const out=[];let outer=null,intent=null,result=null,ref=null;
  for(const item of items){
    const p=structuredClone(item.payload);
    if(p.type==='task-commit-intent'||p.type==='task-commit-result'){
      p.completeIntentDigest=outer.digest;p.effectId=outer.payload.effect.id;
      if(p.type==='task-commit-result')p.commit.intentDigest=intent.digest;
    }
    if(p.type==='effect-checkpoint'){
      p.checkpoint.taskCommit=ref;p.checkpoint.cache.at(-1).result.taskCommit=ref;
    }
    const record=chain([...out,{kind:item.kind,payload:p}]).at(-1);out.push(record);
    if(p.type==='effect-intent'&&p.effect.kind==='complete')outer=record;
    if(p.type==='task-commit-intent'){intent=record;ref={intentDigest:record.digest,planDigest:p.commit.plan.planDigest,resultDigest:null,outcome:null};}
    if(p.type==='task-commit-result'){result=record;ref={...ref,resultDigest:result.digest,outcome:'fixture_committed'};}
  }return out;
}
const control=event=>({kind:'cancel',payload:{version:2,protocol:'cm-task-runner',type:'control',event}});
function ended(v,{result=true,state='unknown',late=false}={}){
  const prefix=v.records.slice(0,v.intentIndex+(result?2:1)),cp=structuredClone(v.records.at(-1));
  const s=cp.payload.checkpoint,c=s.cache.at(-1).result;
  s.state=c.state=state;s.code=c.code=state==='unknown'?'commit_unknown':null;
  if(late){prefix.splice(v.intentIndex+1,0,control('late-cancel'));s.cancelAfterCommit=c.cancelAfterCommit=true;s.cancellationRequested=c.cancellationRequested=true;}
  return linked([...prefix,cp]);
}

for(const kind of ['wrong directory','missing handoff','wrong handoff','missing prior handoff'])
test(`C3a V2 selectors reject rehashed ${kind}`,()=>v2History(v=>{
  const rows=structuredClone(v.records),plan=rows[v.intentIndex].payload.commit.plan;
  if(kind==='wrong directory')for(const e of plan.evidence)e.path=e.path.replace('/.reviews/','/other/');
  if(kind==='missing handoff'||kind==='wrong handoff')plan.evidence.at(-1).path=path.join(v.config.completion.reviewsDir,'unselected.json');
  if(kind==='missing prior handoff')plan.evidence.shift();
  plan.evidence.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  const {planDigest,...body}=plan;plan.planDigest=digest(body);
  assert.throws(()=>v.read(linked(rows.slice(0,v.intentIndex+1))),{code:'runner_commit_selectors'});
},{attempt:2}));

for(const result of [false,true])for(const late of [false,true])
test(`C3a V2 unknown is sticky after workflow error result=${result} late=${late}`,()=>v2History(v=>{
  const rows=ended(v,{result,late}),before=v.read(rows),after=v.read(chain([...rows,control('workflow-error')]));
  assert.equal(after.state.state,'unknown');assert.equal(after.state.code,'commit_unknown');assert.equal(after.state.workflowError,'workflow_error');
  assert.equal(after.state.cancelAfterCommit,late);assert.equal(after.state.cancellationRequested,late);
  assert.deepEqual(after.state.cache,before.state.cache);assert.deepEqual(after.state.taskCommit,before.state.taskCommit);
  for(const event of ['cancel','late-cancel','workflow-error'])assert.throws(()=>v.read(chain([...rows,control('workflow-error'),control(event)])),{code:'runner_control'});
  const again={kind:'intent',payload:{version:2,protocol:'cm-task-runner',type:'effect-intent',effect:{version:1,id:'again',identity:v.config.identity,kind:'complete'}}};
  assert.throws(()=>v.read(chain([...rows,again])),{code:'runner_stage'});
}));

for(const where of ['before intent','between','after result'])for(const event of ['late-cancel','workflow-error'])
test(`C3a V2 preserves valid ${event} ${where}`,()=>v2History(v=>{
  const rows=structuredClone(v.records),s=rows.at(-1).payload.checkpoint,c=s.cache.at(-1).result;
  const at=where==='before intent'?v.intentIndex:where==='between'?v.resultIndex:v.resultIndex+1;
  rows.splice(at,0,control(event));
  if(event==='late-cancel'){s.cancelAfterCommit=c.cancelAfterCommit=true;s.cancellationRequested=c.cancellationRequested=true;}
  else s.workflowError=c.workflowError='workflow_error';
  const all=linked(rows),final=v.read(all);assert.equal(final.state.state,'fixture_completed');
  const interrupted=v.read(all.slice(0,-1));assert.equal(interrupted.state.state,'unknown');assert.equal(interrupted.state.code,'reconciliation_required');
  assert.deepEqual(interrupted.state.taskCommit,final.state.taskCommit);
}));

for(const stage of ['before intent','between','after result'])test(`C3a V2 cancel cannot precede nested write ${stage}`,()=>v2History(v=>{
  const rows=structuredClone(v.records),at=stage==='before intent'?v.intentIndex:stage==='between'?v.resultIndex:v.resultIndex+1;
  rows.splice(at,0,control('cancel'));assert.throws(()=>v.read(linked(rows)));
}));

test('C3a V2 known pre-write blocked/cancelled endings need no commit records',()=>v2History(v=>{
  for(const state of ['blocked','unknown','cancelled']){
    const cp=structuredClone(v.records.at(-1)),s=cp.payload.checkpoint,c=s.cache.at(-1).result;
    s.state=c.state=state;s.code=c.code=state==='cancelled'?'cancelled':'fixture_failure';
    s.taskCommit=c.taskCommit=null;
    const rows=v.records.slice(0,v.outerCount);
    if(state==='cancelled'){rows.push(control('cancel'));s.cancellationRequested=c.cancellationRequested=true;}
    const final=v.read(chain([...rows,cp]));assert.equal(final.state.state,state);assert.equal(final.transaction,null);
  }
  const cp=structuredClone(v.records.at(-1));cp.payload.checkpoint.taskCommit=null;cp.payload.checkpoint.cache.at(-1).result.taskCommit=null;
  assert.throws(()=>v.read(chain([...v.records.slice(0,v.outerCount),cp])),{code:'runner_commit'});
}));

for(const state of ['fixture_completed','blocked','cancelled'])test(`C3a V2 intent-only cannot checkpoint ${state}`,()=>v2History(v=>{
  assert.throws(()=>v.read(ended(v,{result:false,state})),{code:'runner_commit'});
}));
for(const state of ['blocked','cancelled'])test(`C3a V2 result cannot checkpoint ${state}`,()=>v2History(v=>{
  assert.throws(()=>v.read(ended(v,{result:true,state})),{code:'runner_commit'});
}));

for(const size of [1024*1024,1024*1024+1])test(`C3a V2 complete nested envelope boundary ${size}`,()=>v2History(v=>{
  const rows=structuredClone(v.records.slice(0,v.intentIndex+1)),record=rows.at(-1),baseSize=Buffer.byteLength(JSON.stringify(record));
  record.payload.commit.parent.dev='1'.repeat(size-baseSize+1);
  const all=chain(rows);assert.equal(Buffer.byteLength(JSON.stringify(all.at(-1))),size);
  if(size===1024*1024)assert.equal(v.read(all).state.state,'unknown');
  else assert.throws(()=>v.read(all),{code:'limit_exceeded'});
}));

test('C3a V2 explicit version and whole-history bound refuse invalid input',()=>v2History(v=>{
  for(const version of [0,3,'2']){
    assert.throws(()=>readRunnerHistory(v.records,v.config,version),{code:'runner_version'});
    assert.throws(()=>runnerPayload('init',{},version),{code:'runner_version'});
  }
  assert.equal(runnerPayload('control',{event:'cancel'},2).version,2);
  assert.equal(runnerPayload('control',{event:'cancel'}).version,1);
  const rows=structuredClone(v.records);rows.push({padding:'x'.repeat(16*1024*1024)});
  assert.throws(()=>v.read(rows),{code:'limit_exceeded'});
  const wrong=structuredClone(v.config);wrong.completion.handoffs[1]=wrong.completion.handoffs[0];
  assert.throws(()=>readRunnerHistory(v.records,wrong,2),{code:'runner_completion'});
}));

for(const kind of ['duplicate intent','duplicate result','result without intent','wrong phase','no result','unknown record'])
test(`C3a V2 accounts for every nested record: ${kind}`,()=>v2History(v=>{
  let rows=structuredClone(v.records);
  if(kind==='duplicate intent')rows.splice(v.resultIndex,0,structuredClone(rows[v.intentIndex]));
  if(kind==='duplicate result')rows.splice(v.resultIndex+1,0,structuredClone(rows[v.resultIndex]));
  if(kind==='result without intent')rows.splice(v.intentIndex,1);
  if(kind==='wrong phase')rows=[...rows.slice(0,2),rows[v.intentIndex]];
  if(kind==='no result')rows.splice(v.resultIndex,1);
  if(kind==='unknown record')rows[v.intentIndex].payload.type='unrecognized';
  assert.throws(()=>v.read(chain(rows)));
}));

test('C3a V2 metadata refuses extra top-level configuration fields',()=>v2History(v=>{
  const config={...v.config,extra:true},rows=structuredClone(v.records);rows[0].payload.config=config;
  assert.throws(()=>readRunnerHistory(chain(rows.slice(0,1)),config,2));
}));

test('P1 restored baseline cannot invent a specs exclusion different from the task owner',()=>v2History(v=>{
  const init=structuredClone(v.records[0]);
  const {baselineDigest,...body}=init.payload.baseline;
  body.specsPath='invented-specs';
  init.payload.baseline={...body,baselineDigest:digest(body)};
  assert.throws(()=>readRunnerHistory(chain([init]),v.config,2),{code:'runner_history_mismatch'});
}));

const invalidInitialization={
  'initial attempt2':c=>{c.identity.attempt=2;},
  'zero timeout':c=>{c.timeoutMs=0;},
  'large timeout':c=>{c.timeoutMs=3600001;},
  'fraction timeout':c=>{c.timeoutMs=1.5;},
  'empty exclusions':c=>{c.excludedContexts=[];},
  'bad exclusion ID':c=>{c.excludedContexts=['bad id'];},
  'developer extra':c=>{c.developer.extra=true;},
  'developer provider':c=>{c.developer.provider='other';},
  'developer model':c=>{c.developer.requestedModel=' ';},
  'developer context':c=>{c.developer.contextId='bad id';},
  'reviewer count':c=>{c.reviewers=[c.reviewers[0],c.reviewers[0],c.reviewers[0]];},
  'reviewer duplicate ID':c=>{c.reviewers.push({...c.reviewers[0],contexts:['r3','r4']});},
  'reviewer bad ID':c=>{c.reviewers[0].id='bad id';},
  'reviewer extra':c=>{c.reviewers[0].extra=true;},
  'reviewer provider':c=>{c.reviewers[0].provider='other';},
  'reviewer model':c=>{c.reviewers[0].requestedModel='';},
  'string allowed':c=>{c.reviewers[0].allowed='false';},
  'number available':c=>{c.reviewers[0].available=1;},
  'reviewer contexts count':c=>{c.reviewers[0].contexts=['r1'];},
  'reviewer context ID':c=>{c.reviewers[0].contexts[0]='bad id';},
  'reviewer developer context':c=>{c.reviewers[0].contexts[0]=c.developer.contextId;},
  'reviewer excluded context':c=>{c.reviewers[0].contexts[0]=c.excludedContexts[0];},
  'reviewer repeated context':c=>{c.reviewers[0].contexts[1]=c.reviewers[0].contexts[0];},
};
for(const [name,mutate] of Object.entries(invalidInitialization))test(`C3a V2 inherited initialization rejects ${name}`,()=>v2History(v=>{
  const config=structuredClone(v.config),init=structuredClone(v.records[0]);mutate(config);init.payload.config=config;
  if(name==='initial attempt2'){
    const {baselineDigest,...body}=init.payload.baseline;body.identity={...body.identity,attempt:2};
    init.payload.baseline={...body,baselineDigest:digest(body)};
  }
  assert.throws(()=>readRunnerHistory(chain([init]),config,2));
  let callbacks=0;const never=()=>{callbacks++;throw Error('must not run');};
  const {completion,...metadata}=config;
  assert.throws(()=>createTaskRunner({...metadata,developer:{...metadata.developer,run:never},
    reviewers:metadata.reviewers.map(r=>({...r,run:never})),check:never,commit:never}));
  assert.equal(callbacks,0);
}));

test('C3a V2 inherited initialization admits unavailable/absent reviewer routes as pending',()=>v2History(v=>{
  for(const reviewers of [[],v.config.reviewers.map(r=>({...r,allowed:false})),v.config.reviewers.map(r=>({...r,available:false}))]){
    const config={...v.config,reviewers},init=structuredClone(v.records[0]);init.payload.config=config;
    const r=readRunnerHistory(chain([init]),config,2);assert.equal(r.state.state,'pending_review');assert.equal(r.state.attempt,1);
  }
}));
