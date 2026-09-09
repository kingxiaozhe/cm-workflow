import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {createFixRegression,compareFixBaseline} from '../runtime/js/cm-fix/regression.mjs';
import {inspectFixRegressionFailure} from '../runtime/js/cm-fix/regression-evidence.mjs';

test('real repaired target and existing suites distinguish pass, regression, unresolved failure and unfixed defect',async()=>{
  for(const mode of ['passed','regressed','unresolved','improved','unfixed']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-regression-')));
    const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
    const identity={repositoryId:'fixture',runId:'regression-run',taskId:'T-FIX-demo',attempt:1};
    const control={authorized:true,signal:new AbortController().signal},request={identity};
    fs.writeFileSync(path.join(cwd,'value.json'),'1');
    fs.writeFileSync(path.join(cwd,'suite-exit.json'),['unresolved','improved'].includes(mode)?'1':'0');
    fs.writeFileSync(path.join(cwd,'red.mjs'),"import fs from 'node:fs';if(JSON.parse(fs.readFileSync('value.json'))!==2){console.error('TARGET BUG');process.exit(1)}");
    fs.writeFileSync(path.join(cwd,'existing.mjs'),"import fs from 'node:fs';process.exit(JSON.parse(fs.readFileSync('suite-exit.json')))");
    const redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:2000};
    const baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000};
    try{
      const redEvidence=await createFixRedTest(redTest,{identity,specsRoot})(request,control);
      const beforeBaseline=await createFixBaseline(baseline)(request,control);
      fs.writeFileSync(path.join(cwd,'value.json'),mode==='unfixed'?'1':'2');
      fs.writeFileSync(path.join(cwd,'suite-exit.json'),['regressed','unresolved'].includes(mode)?'1':'0');
      const run=createFixRegression({identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline});
      await assert.rejects(run(request,{...control,authorized:false}),{code:'regression_authorization_required'});
      const result=await run(request,control);
      assert.equal(result.status,mode==='unresolved'?'inconclusive':mode==='improved'?'passed':mode==='unfixed'?'defect_remaining':mode);
      assert.equal(result.completionEligible,false);
      const failure={identity,packageDigest:'1'.repeat(64),redTest,baseline,beforeBaseline,result};
      const binding={identity,packageDigest:failure.packageDigest,priorHandoff:{status:'ready_for_review',
        verification:[redTest.command,...baseline.commands.map(row=>row.command)].map(command=>({command:JSON.stringify(command),status:'passed'}))}};
      if(['regressed','unfixed'].includes(mode)){
        assert.deepEqual(inspectFixRegressionFailure(failure,binding),failure);
        assert.throws(()=>inspectFixRegressionFailure({...failure,packageDigest:'2'.repeat(64)},binding),{code:'fix_regression_failure_mismatch'});
        const unavailable=structuredClone(failure);
        unavailable.result.baseline.status='blocked';
        Object.assign(unavailable.result.baseline.observations[0],{outcome:'unavailable',exitCode:null});
        unavailable.result.comparison=compareFixBaseline(beforeBaseline,unavailable.result.baseline,baseline);
        unavailable.result.status=mode==='unfixed'?'defect_remaining':'blocked';
        assert.throws(()=>inspectFixRegressionFailure(unavailable,binding),{code:'fix_regression_failure_unavailable'});
      }else assert.throws(()=>inspectFixRegressionFailure(failure,binding),{code:'fix_regression_failure_unavailable'});
      assert.equal(result.comparison.comparisons[0].status,mode==='regressed'?'regressed':mode==='unresolved'?'unresolved_failure':mode==='improved'?'now_passed':'still_passed');
      await assert.rejects(run(request,control),{code:'regression_already_attempted'});
      if(mode==='passed'){
        const changed=structuredClone(result.baseline);changed.observations[0].command.push('different-command');
        assert.throws(()=>compareFixBaseline(beforeBaseline,changed,baseline),{code:'baseline_mismatch'});
        const guarded=createFixRegression({identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline});
        fs.appendFileSync(path.join(cwd,'red.mjs'),'\n// modified test');
        await assert.rejects(guarded(request,control),{code:'red_test_files_changed'});
      }
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});
