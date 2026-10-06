// Explicit batch (feature) selection. An approved cross-feature order may run a
// later feature while an earlier one still has pending tasks: the 2026-10-06
// AI潮 6.api-native-reading batch before 5.author-column T-009/T-010. Without an
// explicit selection, admission still picks the lowest-numbered pending feature.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {inspectCmAiAdmission,isFinalCmAiTask} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {inspectCmAiContextRefresh} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {openControlRun,validateRunDefinition} from './cm-ai-run.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';

const platform=isSupportedExecutionPlatform();
const test=(name,fn)=>nodeTest(name,{skip:!platform},fn);
const admissionCli=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
const runCli=fileURLToPath(new URL('./cm-ai-run.mjs',import.meta.url));
const EARLY='5.author',LATER='6.reader';

function project(t,{later='- [ ] T-001: reader contract\n- [ ] T-002: mapping\n\n## 依赖\n\n- T-002 依赖 T-001\n'}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-feature-selection-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(codeProject);fs.writeFileSync(path.join(codeProject,'a.js'),'old\n');
  for(const [feature,tasks] of [[EARLY,'- [x] T-008: done\n- [ ] T-009: after the reader batch\n'],[LATER,later]]){
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
    for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),`# ${feature}\n`);
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),tasks);
  }
  const approve=()=>fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',
    features:[EARLY,LATER],specFiles:buildManifest(specsDir)}));
  approve();
  const admission=(...args)=>{
    const out=spawnSync(process.execPath,[admissionCli,'--specs-dir',specsDir,'--code-project',codeProject,...args],{encoding:'utf8'});
    return {...out,json:out.stdout.trim()?JSON.parse(out.stdout):null};
  };
  const definition=(taskId,extra={})=>({version:1,specsDir,codeProject,feature:LATER,
    identity:{repositoryId:'fixture',runId:`reader-${taskId}-run`,taskId,attempt:1},scope:['a.js'],requirements:[],...extra});
  const selected={featureSelection:{version:1,feature:LATER}};
  return {root,specsDir,codeProject,approve,admission,definition,selected};
}

test('without an explicit choice admission still selects the lowest-numbered pending feature',t=>{
  const f=project(t);
  const result=f.admission();
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.json.nextTask,{feature:EARLY,id:'T-009',description:'after the reader batch'});
  assert.equal(Object.hasOwn(result.json,'requestedFeatureComplete'),false);
});

test('an explicit later feature is selected with its own dependency rule and the earlier feature untouched',t=>{
  const f=project(t);
  const tasksBefore=fs.readFileSync(path.join(f.specsDir,EARLY,'tasks.md'));
  const result=f.admission('--feature',LATER);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.json.state,'ready');
  assert.deepEqual(result.json.nextTask,{feature:LATER,id:'T-001',description:'reader contract'});
  // T-002 depends on T-001: only T-001 is eligible.
  assert.deepEqual(result.json.eligibleTasks,[{feature:LATER,id:'T-001'}]);
  assert.deepEqual(result.json.features.map(item=>[item.name,item.pending]),[[EARLY,1],[LATER,2]]);
  assert.deepEqual(fs.readFileSync(path.join(f.specsDir,EARLY,'tasks.md')),tasksBefore);
  const printed=f.admission('--feature',LATER,'--print-run-definition','--scope','a.js');
  assert.equal(printed.status,0,printed.stderr);
  assert.deepEqual(printed.json.featureSelection,{version:1,feature:LATER});
  assert.equal(printed.json.feature,LATER);assert.equal(printed.json.identity.taskId,'T-001');
  const blocked=f.admission('--feature',LATER,'--print-run-definition','--scope','a.js','--task','T-002');
  assert.equal(blocked.status,1);assert.match(blocked.stderr,/task_selection_mismatch/);assert.match(blocked.stderr,/T-001 尚未完成/);
  const missing=f.admission('--feature','7.missing');
  assert.equal(missing.status,1);assert.equal(missing.json.reason,'feature_selection_invalid');
});

test('an explicit choice keeps every approval gate: manifest drift and unapproved specs still block',t=>{
  const f=project(t);
  fs.appendFileSync(path.join(f.specsDir,EARLY,'requirements.md'),'drift\n');
  const drift=f.admission('--feature',LATER);
  assert.equal(drift.status,1);assert.equal(drift.json.reason,'spec_drift');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:[EARLY,LATER]}));
  const pending=f.admission('--feature',LATER);
  assert.equal(pending.json.state,'awaiting_spec_approval');assert.equal(pending.json.nextTask,null);
});

test('a completed selected feature is reported and never yields another feature definition or run',async t=>{
  const f=project(t,{later:'- [x] T-001: reader contract\n'});
  const result=f.admission('--feature',LATER);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.json.requestedFeatureComplete,LATER);
  assert.equal(result.json.nextTask.feature,EARLY);
  assert.match(result.json.warnings.join(' '),new RegExp(`所选 feature ${LATER} 已无待办任务`));
  const printed=f.admission('--feature',LATER,'--print-run-definition','--scope','a.js');
  assert.equal(printed.status,1);assert.equal(printed.stdout,'');assert.match(printed.stderr,/feature_tasks_terminal/);
  await assert.rejects(openControlRun(validateRunDefinition(f.definition('T-001',f.selected)),'create'),
    error=>error.code==='task_selection_mismatch'&&/已无待办任务/.test(error.reason));
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution')),false);
});

test('a run creates for an explicit later feature, refuses without it, and refuses a task whose dependency is pending',async t=>{
  const f=project(t);
  // Unchanged 0.16.7 behaviour without an explicit choice.
  await assert.rejects(openControlRun(validateRunDefinition(f.definition('T-001')),'create'),
    error=>error.code==='task_selection_mismatch'&&error.reason.includes(`当前 feature ${EARLY}`)&&error.reason.includes('--feature'));
  await assert.rejects(openControlRun(validateRunDefinition(f.definition('T-002',f.selected)),'create'),
    error=>error.code==='task_selection_mismatch'&&error.reason.includes('T-001 尚未完成'));
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution')),false);
  const config=path.join(f.root,'run.json');fs.writeFileSync(config,JSON.stringify(f.definition('T-001',f.selected)));
  const invoke=mode=>{
    const out=spawnSync(process.execPath,[runCli,'serve','--config',config,'--mode',mode],{encoding:'utf8',timeout:20000,
      input:[{version:1,operation:'status',requestId:'status',identity:f.definition('T-001').identity}].map(JSON.stringify).join('\n')+'\n'});
    return {...out,rows:out.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};
  };
  const created=invoke('create');
  assert.equal(created.status,0,created.stderr);
  assert.equal(created.rows.find(row=>row.requestId==='status').result.identity.taskId,'T-001');
  const journal=path.join(f.specsDir,'.reviews','.execution','reader-T-001-run','state.json');
  const before=fs.readFileSync(journal);
  const resumed=invoke('resume');
  assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(resumed.rows.find(row=>row.requestId==='status').result.identity.taskId,'T-001');
  assert.deepEqual(fs.readFileSync(journal),before);
  // The selection is part of the durable definition: dropping it changes the run.
  fs.writeFileSync(config,JSON.stringify(f.definition('T-001')));
  const dropped=invoke('resume');assert.equal(dropped.status,1);assert.match(dropped.stderr,/fingerprint_mismatch/);
  assert.match(fs.readFileSync(path.join(f.specsDir,EARLY,'tasks.md'),'utf8'),/- \[ \] T-009/);
});

test('in-run admission for an explicit run reads the selected feature (context refresh and last-task check)',t=>{
  const f=project(t,{later:'- [ ] T-001: reader contract\n'});
  const input={specsDir:f.specsDir,codeProject:f.codeProject,feature:LATER,applicableAgentFiles:[]};
  assert.throws(()=>inspectCmAiContextRefresh(input),{code:'context_invalid'});
  const refresh=inspectCmAiContextRefresh({...input,featureSelection:LATER});
  assert.deepEqual(refresh.nextTask,{feature:LATER,id:'T-001',description:'reader contract'});
  assert.throws(()=>inspectCmAiContextRefresh({...input,featureSelection:EARLY}),{code:'context_invalid'});
  assert.throws(()=>isFinalCmAiTask({specsDir:f.specsDir,codeProject:f.codeProject,feature:LATER,taskId:'T-001'}),
    {code:'documentation_admission_required'});
  // Two tasks are pending in the project (T-009 too): not the final task.
  assert.equal(isFinalCmAiTask({specsDir:f.specsDir,codeProject:f.codeProject,feature:LATER,taskId:'T-001',featureSelection:LATER}),false);
  assert.equal(inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject}).nextTask.feature,EARLY);
});

test('run definitions accept featureSelection only for their own feature',t=>{
  const f=project(t);
  assert.deepEqual(validateRunDefinition(f.definition('T-001',f.selected)).featureSelection,{version:1,feature:LATER});
  for(const bad of [{version:1,feature:EARLY},{version:2,feature:LATER},{version:1,feature:LATER,extra:true},null])
    assert.throws(()=>validateRunDefinition(f.definition('T-001',{featureSelection:bad})),{code:'invalid_feature_selection'});
});

test('the human approval phrase 可以，请开始开发 is an explicit start; looser phrasings are not',t=>{
  const f=project(t);
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:[EARLY,LATER]}));
  for(const reply of ['可以，请开始开发','可以，请开始开发。'])
    assert.equal(f.admission('--approval-response',reply).json.approvalIntent,'explicit',reply);
  for(const reply of ['开始开发','请开始开发','可以，请开始开发，但别现在做','可以'])
    assert.equal(f.admission('--approval-response',reply).json.approvalIntent,'not_approval',reply);
});

test('after its last task an explicit run still refreshes context; the next task is the project own one',t=>{
  const f=project(t,{later:'- [x] T-001: reader contract\n'});
  const refresh=inspectCmAiContextRefresh({specsDir:f.specsDir,codeProject:f.codeProject,feature:LATER,applicableAgentFiles:[],featureSelection:LATER});
  assert.equal(refresh.state,'ready');assert.equal(refresh.nextTask.feature,EARLY);
  assert(refresh.contextFiles.some(file=>file.path===`${LATER}/tasks.md`));
  const admission=inspectCmAiAdmission({specsDir:f.specsDir,codeProject:f.codeProject,feature:LATER});
  assert.deepEqual(admission.features.map(item=>item.name),[EARLY,LATER]);
});

test('with every task done an explicit feature still refuses to print or create, not exit 0',async t=>{
  const f=project(t,{later:'- [x] T-001: reader contract\n'});
  fs.writeFileSync(path.join(f.specsDir,EARLY,'tasks.md'),'- [x] T-008: done\n- [x] T-009: done\n');f.approve();
  const admission=f.admission('--feature',LATER);
  assert.equal(admission.json.state,'complete');assert.equal(admission.json.requestedFeatureComplete,LATER);
  const printed=f.admission('--feature',LATER,'--print-run-definition','--scope','a.js');
  assert.equal(printed.status,1);assert.equal(printed.stdout,'');assert.match(printed.stderr,/feature_tasks_terminal/);
  await assert.rejects(openControlRun(validateRunDefinition(f.definition('T-001',f.selected)),'create'),
    error=>error.code==='task_selection_mismatch'&&/已无待办任务/.test(error.reason));
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution')),false);
});
