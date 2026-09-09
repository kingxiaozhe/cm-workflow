import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {loadHandoff,implementationSha256} from './cm-task-gate.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {writeCmAiProjectLearning} from '../runtime/js/cm-ai/cm-ai-learning-writer.mjs';
import {writeCmAiTaskLearningHandoff,verifyCmAiTaskLearningHandoff} from '../runtime/js/cm-ai/cm-ai-learning-handoff-writer.mjs';

function fixture(fn){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-host-handoff-')));
  const root=path.join(temp,'code'),reviews=path.join(temp,'reviews');fs.mkdirSync(root);fs.mkdirSync(reviews);
  fs.writeFileSync(path.join(root,'a.mjs'),'old');fs.writeFileSync(path.join(root,'requirements.md'),'synthetic task');
  const baseline=captureReviewBaseline({root,identity:{repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},
    scope:['a.mjs'],requirements:['requirements.md']});
  fs.writeFileSync(path.join(root,'a.mjs'),'new');
  const input={root,baseline,handoffPath:path.join(reviews,'task-handoff.json'),
    checks:[{id:'unit',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'host fixture check'}]};
  try{fn(input);}finally{fs.rmSync(temp,{recursive:true,force:true});}
}

test('host handoff uses existing gate and binds actual changed bytes',()=>fixture(input=>{
  assert.equal(createHostHandoff(input).status,'ready_for_review');
  const handoff=loadHandoff(input.handoffPath,{task:'T-001',attempt:1});
  assert.deepEqual(handoff.changed_files,['a.mjs']);
  assert.equal(handoff.implementation_sha256,implementationSha256(input.root,['a.mjs']));
  const before=fs.readFileSync(input.handoffPath);
  assert.throws(()=>createHostHandoff(input),{code:'EEXIST'});
  assert.deepEqual(fs.readFileSync(input.handoffPath),before);
}));
test('failed host check produces blocked handoff rather than invented success',()=>fixture(input=>{
  input.checks[0]={...input.checks[0],outcome:'failed',exitCode:1};
  assert.equal(createHostHandoff(input).status,'blocked');
  assert.equal(loadHandoff(input.handoffPath).blockers.length,1);
}));
test('out-of-scope change rejects without publishing a handoff',()=>fixture(input=>{
  fs.writeFileSync(path.join(input.root,'outside.mjs'),'not authorized');
  assert.throws(()=>createHostHandoff(input));assert.equal(fs.existsSync(input.handoffPath),false);
}));

test('new host handoff feeds existing Learning writer and verifier',()=>fixture(input=>{
  createHostHandoff(input);
  const identity=input.baseline.identity,feature='1.fixture',learningFiles=[];
  const learningDigest=digest({version:1,feature,identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature,identity,learningDigest,learningFiles};
  const binding={feature,identity,learningDigest};
  const application=createCmAiTaskLearningApplication({...binding,status:'no_relevant_lesson',note:null});
  const retrospective=createCmAiTaskLearningRetrospective({...binding,status:'no_new_lesson',candidates:[],reason:null});
  const writeback=writeCmAiProjectLearning({codeProject:input.root,learningInput,retrospective});
  const args={handoffPath:input.handoffPath,feature,identity,learningInput,application,retrospective,writeback};
  writeCmAiTaskLearningHandoff(args);verifyCmAiTaskLearningHandoff(args);
  const evidence=loadHandoff(input.handoffPath).evidence;
  assert.equal(evidence.filter(x=>x.startsWith('cm-learning-')).length,2);
}));
