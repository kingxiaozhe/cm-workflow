import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {prepareFixTestAuthor} from '../runtime/js/cm-fix/test-author.mjs';
import {composeFixReviewBaseline,continueFixReviewBaseline} from '../runtime/js/cm-fix/review-baseline.mjs';
import {fixLearningReviewBaseline} from '../runtime/js/cm-fix/learning-writeback.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

test('one original review baseline includes authored test and business repair, rejecting interstage drift',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-baseline-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'combined-review',taskId:'T-FIX-demo',attempt:1};
  const options={codeProject:cwd,specsRoot,identity,testFiles:['red.mjs'],requirements:['value.mjs'],defect:'Constant bug',diagnosis:{},reproduction:{}};
  try{
    const author=prepareFixTestAuthor(options,{assertReviewReady(){},bridge:{async call(){
      fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2)process.exit(1)");return {outcome:'authored'};
    }}});
    const authorResult=await author.execute({authorized:true,signal:new AbortController().signal,register(){}});
    const capture=()=>captureReviewBaseline({root:cwd,specsRoot,identity,scope:['value.mjs'],requirements:['value.mjs']});
    const repairBaseline=capture();
    const input={authorBaseline:author.baseline,authorResult,repairBaseline};
    const combined=composeFixReviewBaseline(input);
    assert.deepEqual(combined.scope,['red.mjs','value.mjs']);assert(!combined.files.some(file=>file.path==='red.mjs'));
    assert.deepEqual(composeFixReviewBaseline({authorBaseline:null,authorResult:null,repairBaseline}),repairBaseline);
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
    const checks=await createHostCheck({cwd,commands:[{id:'target',command:[process.execPath,'red.mjs']}]})({identity},{signal:new AbortController().signal});
    assert.equal(checks[0].outcome,'passed');
    const pkg=createReviewPackage({root:cwd,baseline:combined,checks});
    assert.deepEqual(pkg.changes.map(change=>change.path),['red.mjs','value.mjs']);
    assert.equal(pkg.changes[0].before,null);assert.equal(pkg.changes[1].before.contentBase64,Buffer.from('export const value=1;').toString('base64'));
    assert.throws(()=>composeFixReviewBaseline({...input,repairBaseline:capture()}),{code:'fix_review_interstage_drift'});
    const {baselineDigest,...wrong}=repairBaseline;wrong.rootDigest='0'.repeat(64);
    assert.throws(()=>composeFixReviewBaseline({...input,repairBaseline:{...wrong,baselineDigest:digest(wrong)}}),{code:'fix_review_baseline_mismatch'});
    fs.writeFileSync(path.join(cwd,'AGENTS.md'),'# Synthetic first-round lesson\n');
    fs.appendFileSync(path.join(cwd,'value.mjs'),' // second repair');
    const nextIdentity={...identity,attempt:2},expanded=fixLearningReviewBaseline(combined);
    const continued=continueFixReviewBaseline(expanded,nextIdentity);
    assert.deepEqual(continued.files,expanded.files);assert.deepEqual(continued.scope,expanded.scope);
    const cumulative=createReviewPackage({root:cwd,baseline:continued,checks});
    assert.equal(cumulative.identity.attempt,2);
    assert.deepEqual(cumulative.changes.map(change=>change.path),['AGENTS.md','red.mjs','value.mjs']);
    assert.equal(cumulative.changes[0].before,null);assert.equal(cumulative.changes[1].before,null);
    assert.equal(Buffer.from(cumulative.changes[2].before.contentBase64,'base64').toString(),'export const value=1;');
    assert.match(Buffer.from(cumulative.changes[2].after.contentBase64,'base64').toString(),/second repair/);
    assert.throws(()=>continueFixReviewBaseline(expanded,{...nextIdentity,runId:'different'}),{code:'fix_review_baseline_mismatch'});
    assert.throws(()=>continueFixReviewBaseline(continued,nextIdentity),{code:'fix_review_baseline_mismatch'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
