import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readDecision,recordCmAiQaDecision,findCmAiQaDecision} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
const identity={repositoryId:'fixture',runId:'fixed-log',taskId:'T-001',attempt:1},packageDigest='a'.repeat(64);
const decision=(status,score,reason)=>({decisionId:'qa-fixed',identity,packageDigest,status,score,reason,at:'2026-10-12T00:00:00Z'});
test('N6 decision accepts null scores for every status and preserves legacy thresholds',()=>{
  for(const [status,reason] of [['skipped','no_fixed_trigger'],['skipped','merged_to_feature_qa'],['triggered','payment,api'],['blocked','host_request_timeout']])
    assert.equal(readDecision(decision(status,null,reason),identity,packageDigest).score,null);
  for(const [status,score] of [['skipped',4],['skipped',7],['triggered',8],['triggered',20],['blocked',4],['blocked',20]])
    assert.equal(readDecision(decision(status,score,'historical'),identity,packageDigest).score,score);
});
test('N6 legacy decision rejects illegal non-null scores including coercible values',()=>{
  for(const status of ['skipped','triggered','blocked'])for(const score of [undefined,'4','8',false,true,{},[],3,21,4.5])
    assert.throws(()=>readDecision(decision(status,score,'historical'),identity,packageDigest),`${status}/${JSON.stringify(score)}`);
  for(const [status,score] of [['skipped',8],['triggered',7]])
    assert.throws(()=>readDecision(decision(status,score,'historical'),identity,packageDigest));
});
test('N6 null skip logs reason and changed file source, keeps old bytes and merge event',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fixed-log-')));
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');fs.mkdirSync(specsDir);fs.mkdirSync(codeProject);
    const log=path.join(specsDir,'运行日志.jsonl'),old='{"historical":"byte exact"}\n';fs.writeFileSync(log,old);
    const binding={specsDir,codeProject,feature:'1.work',identity,packageDigest,logHome:path.join(root,'logs')};
    const value={...decision('skipped',null,'no_fixed_trigger'),changedFilesSource:'handoff_only'};
    recordCmAiQaDecision({...binding,decision:value});
    recordCmAiQaDecision({...binding,decision:value});
    assert(fs.readFileSync(log,'utf8').startsWith(old));
    const row=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(row.detail,'跳过:no_fixed_trigger');assert.equal(row.changed_files_source,'handoff_only');assert.equal(row.score,null);
    const {codeProject:_,logHome:__,...query}=binding;
    assert.equal(findCmAiQaDecision(query).changedFilesSource,'handoff_only');
    const merged={...binding,identity:{...identity,runId:'fixed-merge'},decision:{...decision('skipped',null,'merged_to_feature_qa'),identity:{...identity,runId:'fixed-merge'}}};
    recordCmAiQaDecision(merged);
    const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.phase==='qa_merge').length,1);
    assert.equal(rows.at(-1).reason,'merged_to_feature_qa');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
