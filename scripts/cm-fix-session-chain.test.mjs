import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';

// A run is created in session A, a later session B signs a review grant, and a
// third session C resumes it. C was only ever told about A, so without a durable
// trace of B, B's grant looks like a stranger's and the run cannot be opened
// again. The fix records each session that signs something before it signs.
const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',
  requestedModel:'synthetic',contextId:'logical-review',excludedThreadIds:[]};
const diagnosis={status:'diagnosed',rootCause:'Cross-layer constant',plan:'Correct source after red test',
  affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};
const bridge={async call(){return diagnosis;}};

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-session-chain-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'session-chain',taskId:'T-FIX-chain',attempt:1};
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'session-A',defect:'Synthetic value mismatch',
    causeReview:reviewer,reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}}};
  const records=()=>JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records;
  return {options,identity,records};
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
async function reviewedInSessionB(f,afterA=()=>{}){
  let owner=openFixExecution(f.options,{bridge});
  try{assert.equal((await owner.advance({authorized:true})).stage,'cause_review_required');}finally{owner.close();}
  afterA();
  const {authority,causeReview}=causeReviewSignedBy('session-B');
  owner=openFixExecution({...f.options,create:false,hostContextId:'session-B'},{bridge,causeReview});
  try{
    await authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:owner.causeReviewPackage().packageDigest},
      new AbortController().signal);
    assert.equal((await owner.reviewCause()).stage,'red_test_required');
  }finally{owner.close();}
}

test('a third session reopens a run whose review was signed by the second',async t=>{
  const f=fixture(t);await reviewedInSessionB(f);
  const owner=openFixExecution({...f.options,create:false,hostContextId:'session-C'},{bridge});
  try{assert.equal(owner.status().stage,'red_test_required');}finally{owner.close();}
  // And the session that created it can still come back too.
  openFixExecution({...f.options,create:false},{bridge}).close();
});

test('the signing session is written down once, before the grant it signs',async t=>{
  const f=fixture(t);let before;
  await reviewedInSessionB(f,()=>{before=f.records();});
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
  let owner=openFixExecution(f.options,{bridge});
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
  const f=fixture(t);await reviewedInSessionB(f);
  // The recorded reviewer thread is not independent of the work it reviewed.
  assert.throws(()=>openFixExecution({...f.options,create:false,hostContextId:'actual-fresh-review'},{bridge}),
    {code:'cause_registration_mismatch'});
  // Nor can a configured reviewer context pose as a host.
  assert.throws(()=>openFixExecution({...f.options,create:false,hostContextId:reviewer.contextId},{bridge}),
    {code:'invalid_cause_reviewer'});
});
