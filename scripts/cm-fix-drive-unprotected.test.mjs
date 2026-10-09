// F11: outside protected mode the fix driver must answer like a session: write
// the planned files inside the supplied scope and return only {outcome}. It used
// to return the protected {outcome,edits} proposal, which the host always
// refused (shape), so the step went unknown and abandon_step was spent each time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareFixTestAuthor} from '../runtime/js/cm-fix/test-author.mjs';
import {answerFor} from './cm-fix-drive.mjs';

test('fix driver answers a non-protected fix_test_author through the real test-author step',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-drive-unprotected-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs'),answers=path.join(root,'answers');
  for(const dir of [cwd,specsRoot,answers])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');fs.writeFileSync(path.join(cwd,'requirements.md'),'fixture');
  fs.writeFileSync(path.join(answers,'red.mjs'),"import {value} from './value.mjs';if(value!==2)process.exit(1)\n");
  const identity={repositoryId:'fixture',runId:'driver-unprotected',taskId:'T-FIX-demo',attempt:1};
  const options={codeProject:cwd,specsRoot,identity,testFiles:['red.mjs'],requirements:['requirements.md'],defect:'Constant bug',diagnosis:{},reproduction:{}};
  const driverAnswers={'test-edits':{'red.mjs':'red.mjs'}},paths={answers,round:1};
  let asked=null;
  const author=prepareFixTestAuthor(options,{assertReviewReady(){},bridge:{async call(kind,payload){
    asked=payload;return answerFor({kind,payload},driverAnswers,paths);}}});
  const result=await author.execute({authorized:true,signal:new AbortController().signal,register(){}});
  assert.equal(asked.editMode,undefined,'non-protected request');
  assert.deepEqual([result.outcome,result.changedFiles],['authored',['red.mjs']]);
  assert.equal(fs.readFileSync(path.join(cwd,'red.mjs'),'utf8'),fs.readFileSync(path.join(answers,'red.mjs'),'utf8'));
  // A planned file outside the supplied scope is a legal blocked answer, nothing written.
  assert.deepEqual(answerFor({kind:'fix_repair',payload:{identity,codeProject:cwd,scope:['value.mjs']}},
    {'repair-edits':{'other.mjs':'red.mjs'}},paths),{outcome:'blocked'});
  assert.equal(fs.existsSync(path.join(cwd,'other.mjs')),false);
  // Protected mode keeps the proposal shape.
  const proposal=answerFor({kind:'fix_test_author',payload:{identity,editMode:'protected-text-v1',expected:{'red.mjs':null}}},driverAnswers,paths);
  assert.deepEqual(Object.keys(proposal),['outcome','edits']);assert.equal(proposal.edits[0].path,'red.mjs');
});
