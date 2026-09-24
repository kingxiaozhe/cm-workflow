import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCodexReviewRun,createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';

import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {MAX_FIX_JOINED_HOSTS} from '../runtime/js/cm-fix/cause-invocation.mjs';

// A run is created in session A, a later session B signs a review grant, and a
// third session C resumes it. C was only ever told about A, so without a durable
// trace of B, B's grant looks like a stranger's and the run cannot be opened
// again. The fix records each session that signs something before it signs.
const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',
  requestedModel:'synthetic',contextId:'logical-review',excludedThreadIds:[]};
const diagnosis={status:'diagnosed',rootCause:'Cross-layer constant',plan:'Correct source after red test',
  affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};
const bridge={async call(){return diagnosis;}};
const prepare=async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),
  status:'no_relevant_lesson',summary:'No fixture instructions'}});

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-session-chain-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'session-chain',taskId:'T-FIX-chain',attempt:1};
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'session-A',defect:'Synthetic value mismatch',
    causeReview:reviewer,reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:5000}}};
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  options.configuration.redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:5000};
  options.configuration.baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:5000};
  options.configuration.repair={scope:['value.mjs'],requirements:['value.mjs']};
  const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  const records=()=>JSON.parse(fs.readFileSync(statePath)).records;
  return {options,identity,records,statePath,cwd};
}
function causeReviewSignedBy(hostContextId){
  const authority=createHostReviewAuthority({hostContextId,reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>({status:'approved'})});
  return {authority,causeReview:{authorize:authority.authorize,run:createCauseReviewRun(async({prompt},{onEvent})=>{
    const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    onEvent({event:'thread.started',provider_thread:'actual-fresh-review'});
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'No finding in synthetic package'}};
  },'codex')}};
}
// A creates and diagnoses; B resumes and gets the cause review approved.
async function reviewedInSession(f,afterA=()=>{},hostContextId='session-B'){
  let owner=openFixExecution(f.options,{bridge,prepare});
  try{assert.equal((await owner.advance({authorized:true})).stage,'cause_review_required');}finally{owner.close();}
  afterA();
  const {authority,causeReview}=causeReviewSignedBy(hostContextId);
  owner=openFixExecution({...f.options,create:false,hostContextId},{bridge,causeReview});
  try{
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.causeReviewPackage().packageDigest},
      new AbortController().signal);
    assert.equal((await owner.reviewCause()).stage,'red_test_required');
  }finally{owner.close();}
}

test('a third session reopens a run whose review was signed by the second',async t=>{
  const f=fixture(t);await reviewedInSession(f);
  const owner=openFixExecution({...f.options,create:false,hostContextId:'session-C'},{bridge});
  try{assert.equal(owner.status().stage,'red_test_required');}finally{owner.close();}
  // And the session that created it can still come back too.
  openFixExecution({...f.options,create:false},{bridge}).close();
});

test('the first signing session is recorded before its grant; read-only reopen writes nothing',async t=>{
  const f=fixture(t);let before;
  await reviewedInSession(f,()=>{before=f.records();});
  const after=f.records();
  // Nothing already written moves.
  assert.deepEqual(after.slice(0,before.length),before);
  const added=after.slice(before.length).map(row=>row.id);
  assert.deepEqual(added.slice(0,2),['fix-host-joined-1','fix-cause-registered']);
  assert.deepEqual(after.find(row=>row.id==='fix-host-joined-1').payload,{hostContextId:'session-B'});
  assert.equal(after.find(row=>row.id==='fix-cause-registered').payload.grant.hostContextId,'session-B');
  // Coming back as B, or only looking as C, signs nothing and so adds nothing.
  for(const hostContextId of ['session-B','session-C']){
    const owner=openFixExecution({...f.options,create:false,hostContextId},{bridge});
    try{owner.status();}finally{owner.close();}
  }
  assert.deepEqual(f.records(),after);
});

test('the original session is never written down as a newcomer',async t=>{
  const f=fixture(t);
  let owner=openFixExecution(f.options,{bridge,prepare});
  try{await owner.advance({authorized:true});}finally{owner.close();}
  const {authority,causeReview}=causeReviewSignedBy('session-A');
  owner=openFixExecution({...f.options,create:false},{bridge,causeReview});
  try{
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.causeReviewPackage().packageDigest},
      new AbortController().signal);
    assert.equal((await owner.reviewCause()).stage,'red_test_required');
  }finally{owner.close();}
  assert(!f.records().some(row=>row.id.startsWith('fix-host-joined-')));
});

test('a session that was the reviewer cannot come back as a host',async t=>{
  const f=fixture(t);await reviewedInSession(f);
  // The recorded reviewer thread is not independent of the work it reviewed.
  assert.throws(()=>openFixExecution({...f.options,create:false,hostContextId:'actual-fresh-review'},{bridge}),
    {code:'cause_registration_mismatch'});
  // Nor can a configured reviewer context pose as a host.
  assert.throws(()=>openFixExecution({...f.options,create:false,hostContextId:reviewer.contextId},{bridge}),
    {code:'invalid_cause_reviewer'});
});

// Rebuild only this synthetic store, using the same checksum procedure as the
// legacy observation fixtures. Never edit a real run or bypass store validation.
function rewriteHistory(f,change){
  const state=JSON.parse(fs.readFileSync(f.statePath));
  const rows=change(state.records);let previousDigest=null;
  state.records=rows.map((row,index)=>{
    const {digest:ignored,...value}=row;value.seq=index+1;value.previousDigest=previousDigest;
    previousDigest=digest(value);return {...value,digest:previousDigest};
  });
  const {revision:ignored,...value}=state;state.revision=digest(value);
  fs.writeFileSync(f.statePath,JSON.stringify(state)+'\n');
}
function addJoinedHosts(f,count){
  const state=JSON.parse(fs.readFileSync(f.statePath));
  const store=openExecutionStore({specsRoot:f.options.specsRoot,identity:state.identity,fingerprints:state.fingerprints,create:false});
  try{for(let index=1;index<=count;index++)store.append({id:`fix-host-joined-${index}`,kind:'result',
    payload:{hostContextId:`prior-session-${index}`},expectedRevision:store.snapshot().revision});}finally{store.close();}
}
async function prepareFinalReview(f,causeHost='session-B'){
  await reviewedInSession(f,()=>{},causeHost);
  const owner=openFixExecution({...f.options,create:false,hostContextId:causeHost},{prepare,assertReviewReady(){},
    bridge:{async call(kind){
      if(kind==='fix_repair'){fs.writeFileSync(path.join(f.cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
      assert.equal(kind,'fix_retrospective');return {status:'no_new_lesson',candidates:[],reason:null};
    }}});
  try{
    await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});
    await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();
    assert.equal(owner.createHandoff().stage,'final_review_required');
  }finally{owner.close();}
}
async function finalReviewedInSessionB(f,causeHost='session-B'){
  await prepareFinalReview(f,causeHost);
  const authority=createHostReviewAuthority({hostContextId:'session-B',reviewerId:'fix-final-reviewer',
    adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  const owner=openFixExecution({...f.options,create:false,hostContextId:'session-B'},{prepare,assertReviewReady(){},
    finalReview:{authorize:authority.authorize,run:createCodexReviewRun(async({prompt},{onEvent})=>{
      const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
      for(const event of [{event:'thread.started',provider_thread:'actual-final-review'},{event:'turn.started',item_type:null},
        {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
        {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
      return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
        examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic final review'}};
    })}});
  try{
    const before=f.records();
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.finalReviewPackage().packageDigest},new AbortController().signal);
    assert.equal((await owner.reviewFinal()).stage,'final_review_evidence_required');
    assert.deepEqual(f.records().slice(0,before.length),before);
    assert.equal(f.records().find(row=>row.id==='fix-final-registered').payload.grant.hostContextId,'session-B');
  }finally{owner.close();}
}

test('B signs a second grant on the ordinary final-review path without a second join; C reopens',async t=>{
  const f=fixture(t);await finalReviewedInSessionB(f);
  const rows=f.records();
  assert.equal(rows.find(row=>row.id==='fix-cause-registered').payload.grant.hostContextId,'session-B');
  assert.deepEqual(rows.filter(row=>row.id.startsWith('fix-host-joined-')).map(row=>row.payload),[{hostContextId:'session-B'}]);
  const bytes=fs.readFileSync(f.statePath);
  for(const hostContextId of ['session-A','session-B','session-C']){
    const owner=openFixExecution({...f.options,create:false,hostContextId});
    try{assert.equal(owner.status().stage,'final_review_evidence_required');}finally{owner.close();}
  }
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

for(const kind of ['cause','final'])for(const history of ['later','absent']){
  for(const live of ['session-C','session-B'])test(`${kind} grant with ${history} join reopened as ${live}`,async t=>{
    const f=fixture(t);
    if(kind==='cause')await reviewedInSession(f);else await finalReviewedInSessionB(f,'session-A');
    rewriteHistory(f,rows=>{
      const join=rows.find(row=>row.id==='fix-host-joined-1');
      const kept=rows.filter(row=>row!==join);
      return history==='later'?[...kept,join]:kept;
    });
    const bytes=fs.readFileSync(f.statePath);
    const reopen=()=>{
      const owner=openFixExecution({...f.options,create:false,hostContextId:live});
      try{assert.equal(owner.status().stage,kind==='cause'?'red_test_required':'final_review_evidence_required');}finally{owner.close();}
    };
    if(live==='session-C')assert.throws(reopen,{code:'fix_host_not_joined'});else reopen();
    assert.deepEqual(fs.readFileSync(f.statePath),bytes);
  });
}

test('the sixteenth joined session can sign',async t=>{
  const f=fixture(t);await reviewedInSession(f,()=>addJoinedHosts(f,MAX_FIX_JOINED_HOSTS-1));
  const rows=f.records();assert.equal(rows.filter(row=>row.id.startsWith('fix-host-joined-')).length,16);
  assert.deepEqual(rows.find(row=>row.id==='fix-host-joined-16').payload,{hostContextId:'session-B'});
  const owner=openFixExecution({...f.options,create:false,hostContextId:'session-C'});
  try{assert.equal(owner.status().stage,'red_test_required');}finally{owner.close();}
});

test('the seventeenth distinct signing session gets fix_host_limit and writes nothing',async t=>{
  const f=fixture(t);let owner=openFixExecution(f.options,{bridge,prepare});
  try{await owner.advance({authorized:true});}finally{owner.close();}
  addJoinedHosts(f,MAX_FIX_JOINED_HOSTS);
  const {authority,causeReview}=causeReviewSignedBy('session-17');
  const bytes=fs.readFileSync(f.statePath);
  owner=openFixExecution({...f.options,create:false,hostContextId:'session-17'},{causeReview});
  try{
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.causeReviewPackage().packageDigest},new AbortController().signal);
    await assert.rejects(owner.reviewCause(),{code:'fix_host_limit'});
    assert.equal(owner.status().stage,'cause_review_required');
  }finally{owner.close();}
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});


test('the seventeenth final-review signing session gets fix_host_limit and writes nothing',async t=>{
  const f=fixture(t);await prepareFinalReview(f,'session-A');
  addJoinedHosts(f,MAX_FIX_JOINED_HOSTS);
  const authority=createHostReviewAuthority({hostContextId:'session-17',reviewerId:'fix-final-reviewer',
    adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  const bytes=fs.readFileSync(f.statePath);let calls=0;
  const owner=openFixExecution({...f.options,create:false,hostContextId:'session-17'},{assertReviewReady(){},
    finalReview:{authorize:authority.authorize,run:async()=>{calls++;throw Error('Must not dispatch');}}});
  try{
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.finalReviewPackage().packageDigest},new AbortController().signal);
    await assert.rejects(owner.reviewFinal(),{code:'fix_host_limit'});
    assert.equal(owner.status().stage,'final_review_required');
    assert.equal(calls,0);
  }finally{owner.close();}
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});
