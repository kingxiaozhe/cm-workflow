import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectCmAiQaTaskContext} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {createHostQaDecisionProvider,decideHostQaPolicy} from '../runtime/js/cm-ai/host-qa-policy.mjs';

const low=()=>({scores:{scope:1,risk:1,accumulation:1,boundary:1},
  changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}});
test('N6 enforces mandatory triggers ahead of low scores and bounds the API merge exemption',()=>{
  const input={assessment:low(),pending:2,mergeEligible:false,unassessedTasks:1};
  assert.equal(decideHostQaPolicy(input).status,'skipped');
  assert.equal(decideHostQaPolicy({...input,pending:0}).reason,'feature_complete');
  assert.equal(decideHostQaPolicy({...input,unassessedTasks:5}).reason,'five_tasks_without_qa');
  for(const field of Object.keys(input.assessment.changes)){
    const assessment=low();assessment.changes[field]=true;
    assert.equal(decideHostQaPolicy({...input,assessment}).status,'triggered',field);
  }
  const assessment=low();assessment.changes.api=true;
  assert.equal(decideHostQaPolicy({...input,assessment,pending:1,mergeEligible:true}).reason,'merged_to_feature_qa');
  assessment.changes.payment=true;
  assert.equal(decideHostQaPolicy({...input,assessment,pending:1,mergeEligible:true}).reason,'payment');
  const high=low();high.scores.risk=5;
  assert.deepEqual(decideHostQaPolicy({...input,assessment:high}),{status:'triggered',score:8,reason:'risk_score'});
  high.scores.risk=0;assert.throws(()=>decideHostQaPolicy({...input,assessment:high}),{code:'qa_assessment_invalid'});
});

test('N6 derives consecutive work from original task inventory and QA log without a counter store',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-policy-')));
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
    fs.writeFileSync(path.join(codeProject,'source.js'),'// fixture\n');
    for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),Array.from({length:7},(_,i)=>`- [${i<5?'x':' '}] T-00${i+1}: task`).join('\n'));
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
    const binding={specsDir,codeProject,feature,identity:{repositoryId:'fixture',runId:'run-current',taskId:'T-005',attempt:1},packageDigest:'a'.repeat(64)};
    const seen=[];
    const provider=createHostQaDecisionProvider({timeoutMs:1000,assess:async input=>{seen.push(input.unassessedTasks);return low();}});
    const decide=()=>provider.decide(binding,new AbortController().signal);
    assert.equal((await decide()).reason,'five_tasks_without_qa');
    const rows=Array.from({length:4},(_,i)=>({schema_version:1,workflow:'cm-ai',event:'qa',node:'N6',feature,
      repository_id:'fixture',run_id:`run-task-${i}`,task:`T-00${i+1}`,attempt:1,package_digest:'b'.repeat(64),
      decision_id:`decision-${i}`,status:i===3?'triggered':'skipped',reason:'fixture',score:i===3?null:4,at:'2026-09-07T01:00:00+00:00'}));
    const log=path.join(specsDir,'运行日志.jsonl');
    fs.writeFileSync(log,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    assert.equal((await decide()).status,'skipped');assert.deepEqual(seen,[5,1]);
    // Omitting old decisions cannot silently pretend those tasks were covered.
    fs.writeFileSync(log,JSON.stringify(rows[3])+'\n');
    await decide();assert.equal(seen.at(-1),4);
    const oldCurrent={...rows[3],task:'T-005',run_id:'old-run',package_digest:'c'.repeat(64)};
    const skips=rows.map(row=>({...row,status:'skipped',score:4}));
    fs.writeFileSync(log,[oldCurrent,...skips].map(row=>JSON.stringify(row)).join('\n')+'\n');
    assert.equal((await decide()).reason,'five_tasks_without_qa');assert.equal(seen.at(-1),5);
    const stale=createHostQaDecisionProvider({timeoutMs:1000,assess:async()=>{
      fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-005: task\n');return low();}});
    await assert.rejects(stale.decide(binding,new AbortController().signal),{code:'stale_qa'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('step30 unseen excludes closed features, includes other open features, and preserves since-trigger skips',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-policy-')));
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');fs.mkdirSync(codeProject);
    fs.writeFileSync(path.join(codeProject,'source.js'),'// fixture\n');
    const features=['1.closed-a','2.closed-b','3.closed-c','4.current','5.later'];
    for(const [index,feature] of features.entries()){
      const dir=path.join(specsDir,feature);fs.mkdirSync(dir,{recursive:true});
      for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(dir,name),'# Fixture\n');
      const count=index<2?4:index===2?3:index===3?4:1;
      fs.writeFileSync(path.join(dir,'tasks.md'),Array.from({length:count},(_,i)=>
        `- [${index<3||index===3&&i===0?'x':' '}] T-00${i+1}: task`).join('\n')+'\n');
    }
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features}));
    const log=path.join(specsDir,'运行日志.jsonl');fs.writeFileSync(log,'');
    const binding={specsDir,codeProject,feature:'4.current',identity:{repositoryId:'fixture',runId:'run-current',taskId:'T-001',attempt:1},packageDigest:'a'.repeat(64)};
    const seen=[],provider=createHostQaDecisionProvider({timeoutMs:1000,assess:async input=>{seen.push(input.unassessedTasks);return low();}});
    const decide=()=>provider.decide(binding,new AbortController().signal);
    assert.equal((await decide()).status,'skipped');assert.equal(seen.at(-1),1);
    const legacyCompletedWithoutQa=inspectCmAiQaTaskContext({...binding,taskId:binding.identity.taskId}).completed.length;
    assert.equal(legacyCompletedWithoutQa,12);
    console.log('STEP30 history',JSON.stringify({legacyCompletedWithoutQa,unassessedTasks:seen.at(-1),closedFeatures:3}));
    fs.writeFileSync(path.join(specsDir,'5.later','tasks.md'),'- [x] T-001: done\n- [ ] T-002: pending\n');
    await decide();assert.equal(seen.at(-1),2);
    const row={schema_version:1,workflow:'cm-ai',event:'qa',node:'N6',feature:'1.closed-a',task:'T-001',
      repository_id:'fixture',run_id:'historical',attempt:1,package_digest:'b'.repeat(64),decision_id:'old-decision',
      status:'skipped',reason:'fixture',score:4,at:'2026-09-07T01:00:00Z'};
    fs.writeFileSync(log,JSON.stringify(row)+'\n');await decide();assert.equal(seen.at(-1),3);
    fs.appendFileSync(log,JSON.stringify({...row,feature:'2.closed-b',status:'triggered',score:null})+'\n');
    await decide();assert.equal(seen.at(-1),2);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
