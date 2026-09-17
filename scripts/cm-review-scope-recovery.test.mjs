import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const identity={repositoryId:'fixture',runId:'scope-recovery',taskId:'T-001',attempt:1};
const terminal=(r,result)=>({version:1,invocationId:r.invocationId,contextId:r.contextId,provider:r.provider,
  effectiveModel:'fixture',status:'succeeded',accepted:true,result});
async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-scope-recovery-')));
  try{
    fs.writeFileSync(path.join(root,'code.js'),'before');fs.writeFileSync(path.join(root,'AGENTS.md'),'unchanged instructions');
    fs.writeFileSync(path.join(root,'requirements.md'),'fixture');
    // V1 fixture journal: no native task writes or real provider calls.
    const records=[];
    const store={snapshot:()=>structuredClone({identity,records,revision:digest(records)}),
      append:({expectedRevision,...record})=>{assert.equal(expectedRevision,digest(records));records.push(structuredClone(record));}};
    let commits=0;
    const options={root,identity,scope:['code.js','AGENTS.md'],requirements:['requirements.md'],excludedContexts:['main'],
      developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:r=>{
        fs.writeFileSync(path.join(root,'code.js'),'after');return terminal(r,{outcome:'implemented'});}},
      reviewers:[{id:'reviewer',provider:'claude',requestedModel:'fixture',allowed:true,available:true,contexts:['r1','r2'],
        run:r=>terminal(r,{verdict:'approved',packageDigest:r.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(r.payload.reviewPackage),findings:[],summary:'Synthetic independent review'})}],
      check:()=>[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}],
      commit:()=>{commits++;return {outcome:'fixture_completed'};}};
    const make=mode=>createTaskRunner({...options,persistence:{store,mode}});
    const effect=kind=>({version:1,id:kind,identity,kind});
    await fn({records,make,effect,commits:()=>commits});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

for(const legacy of [false,true])test(`scope package resumes review and completion, legacy=${legacy}`,()=>fixture(async f=>{
  assert.equal((await f.make('create').executeEffect(f.effect('develop'))).state,'awaiting_review');
  if(legacy){
    const checkpoint=f.records.at(-1).payload.checkpoint;
    const {unchangedScope,packageDigest,...body}=checkpoint.reviewPackage;
    checkpoint.reviewPackage={...body,packageDigest:digest(body)};
    checkpoint.cache.at(-1).result.packageDigest=checkpoint.reviewPackage.packageDigest;
  }
  const runner=f.make('resume'),reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,'approved');
  assert.equal(reviewed.receipt.result.examinedPaths.includes('AGENTS.md'),!legacy);
  const receipt=JSON.stringify(reviewed.receipt);
  assert.equal((await f.make('resume').executeEffect(f.effect('complete'))).state,'fixture_completed');
  assert.equal(JSON.stringify(f.make('resume').status().receipt),receipt);
  assert.equal(f.commits(),1);
}));

test('replay rejects resealed false or incomplete unchanged scope against the original baseline',()=>fixture(async f=>{
  await f.make('create').executeEffect(f.effect('develop'));
  for(const mutate of [p=>{p.unchangedScope[0].sha256='a'.repeat(64);},p=>{p.unchangedScope=[];}]){
    const records=structuredClone(f.records),pkg=records.at(-1).payload.checkpoint.reviewPackage;
    mutate(pkg);const {packageDigest,...body}=pkg;pkg.packageDigest=digest(body);
    records.at(-1).payload.checkpoint.cache.at(-1).result.packageDigest=pkg.packageDigest;
    assert.throws(()=>readRunnerHistory(records,records[0].payload.config));
  }
}));
