import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCauseReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';

for(const outcome of ['approved','incomplete','denied','timeout','cancelled'])test(`cause invocation ${outcome} uses original grant and durable registration`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cause-call-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'cause-review-run',taskId:'T-FIX-cause',attempt:1};
  const reviewer={reviewerId:'cause-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',
    contextId:'logical-review',excludedThreadIds:['other-author']};
  fs.symlinkSync(root,path.join(root,'parent-alias'));
  const options={specsRoot:outcome==='approved'?path.join(root,'parent-alias','specs'):specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Synthetic value mismatch',causeReview:reviewer,
    reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}}};
  const authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    decide:async()=>outcome==='denied'?{status:'denied',code:'permission_denied'}:{status:'approved'}});
  let calls=0,owner,lateEvent=null;
  const causeReview={authorize:authority.authorize,run:createCauseReviewRun(async({prompt},{onEvent})=>{
    const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    calls++;
    const records=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records;
    assert.equal(records.at(-1).id,'fix-cause-registered');
    assert.equal(onEvent({event:'thread.started',provider_thread:'actual-fresh-review'}),true);
    if(['timeout','cancelled'].includes(outcome)){
      lateEvent=onEvent;
      if(outcome==='cancelled')setImmediate(()=>owner.cancel());
      return new Promise(()=>{}); // Deliberately ignores abort: owner must still release its lock.
    }
    if(outcome==='incomplete')throw Error('synthetic disconnect');
    for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'No finding in synthetic package'}};
  },'codex')};
  try{
    owner=openFixExecution(options,{causeReview,bridge:{async call(){return {status:'diagnosed',rootCause:'Cross-layer constant',
      plan:'Correct source after red test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};}}});
    await owner.advance({authorized:true});const pkg=owner.causeReviewPackage();
    await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    const result=await owner.reviewCause();
    assert.equal(result.stage,outcome==='approved'?'red_test_required':outcome==='denied'?'cause_review_required':outcome==='cancelled'?'cancelled':'unknown');
    assert.equal(result.completionEligible,false);assert.equal(calls,outcome==='denied'?0:1);
    if(outcome==='denied')assert.equal(result.reason,'permission_denied');
    owner.close();owner=openFixExecution({...options,create:false},{causeReview});
    if(lateEvent)assert.equal(lateEvent({event:'turn.started',item_type:null}),false);
    assert.equal((await owner.reviewCause()).stage,result.stage);assert.equal(calls,outcome==='denied'?0:1);
    if(outcome==='approved'){
      const evidence=path.join(specsRoot,'.reviews','fix-cause-cause-r1.md');
      const bytes=fs.readFileSync(evidence);
      assert.match(bytes.toString(),/phase: cause\nround: 1\nverdict: approved/);
      assert.match(bytes.toString(),/not N4 implementation approval/);
      fs.unlinkSync(evidence); // Simulate a durable result whose file projection is absent.
      assert.equal(owner.status().stage,'cause_review_evidence_required');
      assert.equal((await owner.reviewCause()).stage,'red_test_required');
      assert.deepEqual(fs.readFileSync(evidence),bytes);assert.equal(calls,1);
      fs.writeFileSync(evidence,'conflicting evidence');
      assert.equal(owner.status().stage,'cause_review_evidence_required');
      await assert.rejects(owner.reviewCause(),{code:'review_file_conflict'});
      assert.equal(fs.readFileSync(evidence,'utf8'),'conflicting evidence');assert.equal(calls,1);
      fs.writeFileSync(evidence,bytes);
      fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
      assert.equal(owner.status().stage,'cause_review_drift');
      assert.equal((await owner.reviewCause()).stage,'cause_review_drift');assert.equal(calls,1);
    }
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
