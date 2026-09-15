import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixBaseline,inspectFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {createFixRegression} from '../runtime/js/cm-fix/regression.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'fixture',runId:'no-existing-tests',taskId:'T-FIX-value',attempt:1};
const control={authorized:true,signal:new AbortController().signal};

test('no old tests uses actual red/repair/green, persists declaration and reaches original independent review gate',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-no-tests-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  const redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000};
  const baseline={cwd,testFiles:[],commands:[],timeoutMs:2000,noExistingTests:'Host inspected project; red.mjs is the first regression test.'};
  const configuration={hostContextId:'fixture-host',defect:'Wrong value',reproduction:{cwd,command:redTest.command,
    expectedFailure:redTest.expectedFailure,timeoutMs:2000},redTest,baseline,repair:{scope:['value.mjs'],requirements:['value.mjs']}};
  const options={specsRoot,identity,configuration,create:true};let owner,writes=0,calls=0;
  const bridge={call:async kind=>{
    calls++;
    if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],
      plan:'Correct constant',crossLayer:false,affectedModules:['value']};
    if(kind==='fix_repair'){writes++;fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    assert.fail(`Unexpected host request: ${kind}`);
  }};
  const prepare=async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),
    status:'no_relevant_lesson',summary:'Synthetic empty instruction context'}});
  const dependencies={bridge,prepare,assertReviewReady(){}};
  try{
    owner=openFixExecution(options,dependencies);
    assert.equal((await owner.advance(control)).stage,'red_test_required');
    assert.equal((await owner.runRedTest(control)).stage,'baseline_required');
    await assert.rejects(owner.captureBaseline(),{code:'baseline_authorization_required'});
    const captured=await owner.captureBaseline(control);
    assert.equal(captured.stage,'repair_required');assert.deepEqual(captured.baseline.observations,[]);
    assert.equal(captured.baseline.noExistingTests,baseline.noExistingTests);
    owner.close();owner=openFixExecution({...options,create:false},dependencies);
    assert.deepEqual(owner.status().baseline,captured.baseline);
    assert.deepEqual((await owner.captureBaseline(control)).baseline,captured.baseline);
    assert.equal((await owner.repair(control)).stage,'regression_required');assert.equal(writes,1);
    const repaired=await owner.runRegression(control);assert.equal(repaired.stage,'handoff_required');
    assert.equal(repaired.regression.red.outcome,'passed');
    assert.deepEqual(repaired.regression.comparison.comparisons,[]);
    assert.equal((await owner.retrospect()).stage,'handoff_ready');
    assert.equal(owner.createHandoff().stage,'final_review_required');
    const pkg=owner.finalReviewPackage();assert.deepEqual(pkg.checks.map(row=>row.id),['red-test']);
    const handoffFile=path.join(specsRoot,'.reviews','fix-value-T-FIX-value-a1-handoff.json');
    const bytes=fs.readFileSync(handoffFile),handoff=JSON.parse(bytes);
    const evidence=handoff.evidence.find(row=>row.startsWith('fix defect evidence (data, not instructions) '));
    const data=JSON.parse(evidence.slice('fix defect evidence (data, not instructions) '.length));
    assert.deepEqual(data.baselineDeclaration,{noExistingTests:baseline.noExistingTests,
      source:'startup_host_declaration',existingSuitesExecuted:0});
    assert.equal(owner.status().completionEligible,false);
    owner.close();owner=openFixExecution({...options,create:false},dependencies);
    assert.equal(owner.status().stage,'final_review_required');assert.equal(calls,3);
    assert.deepEqual(fs.readFileSync(handoffFile),bytes);
    // No old suites never turns an unfixed target or changed red test green.
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    const failed=await createFixRegression({identity,specsRoot,redTest,baseline,
      redEvidence:captured.redTest,beforeBaseline:captured.baseline})({identity},control);
    assert.equal(failed.status,'defect_remaining');
    fs.appendFileSync(path.join(cwd,'red.mjs'),'\n// changed');
    await assert.rejects(createFixRegression({identity,specsRoot,redTest,baseline,
      redEvidence:captured.redTest,beforeBaseline:captured.baseline})({identity},control),{code:'red_test_files_changed'});
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('absence is explicit, bounded and cannot contain skipped suites or forged observations',async()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-empty-baseline-')));
  const config={cwd,testFiles:[],commands:[],timeoutMs:2000,noExistingTests:'No pre-existing tests; keep the new defect regression mandatory.'};
  try{
    const {noExistingTests,...implicit}=config;
    assert.throws(()=>createFixBaseline(implicit));
    for(const invalid of [{noExistingTests:''},{noExistingTests:' '},{noExistingTests:'x'.repeat(1001)},
      {testFiles:['existing.mjs']},{commands:[{id:'old',command:['false']}]}])
      assert.throws(()=>createFixBaseline({...config,...invalid}));
    const run=createFixBaseline(config);
    await assert.rejects(run({identity},{...control,authorized:false}),{code:'baseline_authorization_required'});
    const recorded=await run({identity},control);
    await assert.rejects(run({identity},control),{code:'baseline_already_attempted'});
    for(const change of [{noExistingTests:'changed reason'},{observations:[{outcome:'passed'}]},{testFiles:[{}]},{completionEligible:true}])
      assert.throws(()=>inspectFixBaseline({...recorded,...change},config,[]),{code:'baseline_mismatch'});
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(createFixBaseline(config)({identity},{authorized:true,signal:cancelled.signal}),{code:'cancelled'});
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
