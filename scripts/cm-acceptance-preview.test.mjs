import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectAcceptancePreview,buildAcceptancePreview,currentAcceptancePreview,summaryAcceptancePreview}
  from '../runtime/js/cm-prd/acceptance-preview.mjs';
import {captureSpecificationMaterial} from '../runtime/js/cm-ai/specification-material.mjs';
import {approveCmAiSpecs} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const cli=fileURLToPath(new URL('./cm-acceptance-preview.mjs',import.meta.url));
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-acceptance-preview-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const feature='1.work';fs.mkdirSync(path.join(root,feature));
  const documents=[
    {path:'requirements.md',content:'# Requirements\n- [ ] [AC-001] Read a\n  - 必跑测试: `a.test.mjs`\n- [ ] [AC-002] Read b\n'},
    {path:'design.md',content:'# Design\nRead values\n'},
    {path:'tasks.md',content:'- [ ] T-001: Read a [AC-001]\n  - 执行 `node --test a.test.mjs`\n- [ ] T-002: 必验: Read b [AC-002]\n'},
    {path:'test-cases.json',content:JSON.stringify({cases:[{id:'TC-001',title:'Read a',kind:'logic',blocking:true,taskIds:['T-001'],
      acIds:['AC-001'],steps:['Read a'],expected:['a is returned']}]})},
  ];
  for(const doc of documents)fs.writeFileSync(path.join(root,feature,doc.path),doc.content);
  const approve=(grammar=3)=>fs.writeFileSync(path.join(root,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],
    specFiles:buildManifest(root),...(grammar===1?{}:{taskGrammar:grammar})}));
  return {root,feature,documents,approve,file:name=>path.join(root,feature,name)};
}
function snapshot(root){
  const files={};const walk=directory=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
    if(entry.isDirectory())walk(file);else files[path.relative(root,file)]={bytes:fs.readFileSync(file).toString('base64'),mtime:stat.mtimeMs,mode:stat.mode};
  }};walk(root);return files;
}
test('draft preview and approved capture freeze the same contracts and exact task selection',t=>{
  const f=fixture(t),before=snapshot(f.root),preview=inspectAcceptancePreview({specs:f.root});
  assert.equal(preview.status,'ready');assert.equal(preview.sourceStatus,'draft');
  assert.deepEqual(snapshot(f.root),before);assert.equal(preview.approvalAuthorized,false);assert.equal(preview.executionAuthorized,false);
  f.approve();
  for(const task of preview.features[0].tasks){
    const actual=captureSpecificationMaterial({specsRoot:f.root,feature:f.feature,taskId:task.taskId});
    assert.deepEqual(task.contract,actual.acceptanceContract);assert.equal(task.contractDigest,digest(actual.acceptanceContract));
  }
  const [a,b]=preview.features[0].tasks;
  assert.deepEqual(a.contract.requiredTests,['a.test.mjs']);assert.deepEqual(b.contract.requiredTests,[]);
  assert.deepEqual(a.testCases,['TC-001']);assert.deepEqual(b.testCases,[]);
  assert.deepEqual(a.acceptanceCriteria,['AC-001']);assert.deepEqual(b.acceptanceCriteria,['AC-002']);
  assert(a.humanReviewIds.length>0);
  assert(a.contract.obligations.some(item=>a.locations[item.id].some(at=>at.pointer==='/cases/0/expected/0')));
});
test('ambiguous requirements preserve raw source locations and do not rewrite approval or specs',t=>{
  const f=fixture(t);fs.appendFileSync(f.file('tasks.md'),'\n  - 真机先红后绿\n');
  const before=snapshot(f.root),preview=inspectAcceptancePreview({specs:f.root});
  assert.equal(preview.status,'needs_clarification');
  const task=preview.features[0].tasks.find(task=>task.taskId==='T-002');
  assert(task.issues.some(issue=>issue.message.includes('compound evidence')&&issue.locations.some(at=>at.path==='1.work/tasks.md'&&at.line===5)));
  assert.deepEqual(snapshot(f.root),before);
});
test('real CLI is read-only, supports scoped JSON and returns separate ambiguity/input exits',t=>{
  const f=fixture(t),before=snapshot(f.root);
  const run=args=>spawnSync(process.execPath,[cli,'--specs',f.root,...args],{encoding:'utf8',timeout:10000});
  const full=run([]);assert.equal(full.status,0,full.stderr);assert.match(full.stdout,/未执行测试/);assert.match(full.stdout,/requirements.md:3/);
  const selected=run(['--feature',f.feature,'--task','T-001','--json']);assert.equal(selected.status,0,selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout).scope,{features:[f.feature],taskId:'T-001'});
  assert.equal(JSON.parse(selected.stdout).features[0].tasks.length,1);
  assert.equal(run(['--task','T-001']).status,2);assert.equal(run(['--feature','../escape']).status,2);
  assert.deepEqual(snapshot(f.root),before);
  fs.appendFileSync(f.file('tasks.md'),'\n  - 真机先红\n');assert.equal(run([]).status,1);
});
test('old recorded grammar is retained and future defaults cannot reinterpret its declarations',t=>{
  const f=fixture(t);fs.appendFileSync(f.file('tasks.md'),'\n- [ ] T-003： legacy prose\n');f.approve(1);
  const preview=inspectAcceptancePreview({specs:f.root});assert.equal(preview.taskGrammar,1);
  assert.deepEqual(preview.features[0].tasks.map(task=>task.taskId),['T-001','T-002']);
  for(const task of preview.features[0].tasks)assert.deepEqual(task.contract,
    captureSpecificationMaterial({specsRoot:f.root,feature:f.feature,taskId:task.taskId}).acceptanceContract);
});
test('grammar 2, shared verification sections and task-bound cases match formal capture',t=>{
  const f=fixture(t);
  fs.appendFileSync(f.file('tasks.md'),'\n## 验证要求\nT-001 基线必须通过\nT-002 基线检查\n');
  const cases=JSON.parse(fs.readFileSync(f.file('test-cases.json')));
  cases.cases.push({...cases.cases[0],id:'TC-002',title:'Only b',taskIds:['T-002'],acIds:['AC-002']});
  fs.writeFileSync(f.file('test-cases.json'),JSON.stringify(cases));f.approve(2);
  const preview=inspectAcceptancePreview({specs:f.root});assert.equal(preview.taskGrammar,2);
  for(const task of preview.features[0].tasks)assert.deepEqual(task.contract,
    captureSpecificationMaterial({specsRoot:f.root,feature:f.feature,taskId:task.taskId}).acceptanceContract);
  assert.deepEqual(preview.features[0].tasks[0].testCases,['TC-001']);
});
test('approval drift rejects CLI; saved preview becomes stale without changing historical evidence',t=>{
  const f=fixture(t);f.approve();const preview=inspectAcceptancePreview({specs:f.root}),saved=JSON.stringify(preview);
  assert.equal(currentAcceptancePreview({specs:f.root,preview}).status,'ready');
  fs.appendFileSync(f.file('requirements.md'),'New requirement\n');
  assert.equal(currentAcceptancePreview({specs:f.root,preview}).status,'stale');assert.equal(JSON.stringify(preview),saved);
  const result=spawnSync(process.execPath,[cli,'--specs',f.root,'--json'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,2);assert.match(result.stderr,/acceptance_preview_approved_sources_changed/);
});
test('whole feature inventory is bound separately from the displayed current feature scope',t=>{
  const f=fixture(t),preview=inspectAcceptancePreview({specs:f.root});
  fs.mkdirSync(path.join(f.root,'2.other'));
  for(const doc of f.documents)fs.writeFileSync(path.join(f.root,'2.other',doc.path),doc.content);
  assert.equal(currentAcceptancePreview({specs:f.root,preview}).status,'stale');
  const next=inspectAcceptancePreview({specs:f.root,feature:f.feature});
  assert.deepEqual(next.scope.features,['1.work']);assert.deepEqual(next.featureInventory,['1.work','2.other']);
  assert.equal(currentAcceptancePreview({specs:f.root,preview:next}).status,'ready');
  fs.renameSync(path.join(f.root,'2.other'),path.join(f.root,'old-other'));
  assert.equal(currentAcceptancePreview({specs:f.root,preview:next}).status,'stale');
});
test('legacy awaiting-review migration conflict matches approval without changing its grammar or state',t=>{
  const f=fixture(t);fs.appendFileSync(f.file('tasks.md'),'\n- [ ] T-003： new [NEW]\n');
  const status={status:'awaiting_review',features:[f.feature],specFiles:buildManifest(f.root)};
  fs.writeFileSync(path.join(f.root,'.cm-specs-status'),JSON.stringify(status));
  const before=snapshot(f.root),preview=inspectAcceptancePreview({specs:f.root});
  assert.equal(preview.taskGrammar,1);assert.equal(preview.status,'needs_clarification');
  assert.deepEqual(preview.features[0].tasks.map(task=>task.taskId),['T-001','T-002']);
  const issue=preview.features[0].issues.find(issue=>issue.message==='task_grammar_conflict');
  assert.deepEqual(issue.locations,[{path:'1.work/tasks.md',line:5}]);
  assert.deepEqual(snapshot(f.root),before);
  const result=approveCmAiSpecs({specsDir:f.root,codeProjects:[f.root],approvalResponse:'开始'});
  assert.equal(result.approveRefused,'task_grammar_conflict',JSON.stringify(result));assert.deepEqual(snapshot(f.root),before);
  f.approve(1);const approved=inspectAcceptancePreview({specs:f.root});
  assert.equal(approved.status,'ready','already approved legacy capture keeps its original grammar');
  assert.equal(approved.approvalTransition,false);
});
test('source replacement during a preview read never returns a ready mixed snapshot',t=>{
  const f=fixture(t),original=fs.readSync;let reads=0;
  fs.readSync=function(...args){
    const count=original.apply(this,args);
    if(++reads===4)fs.appendFileSync(f.file('requirements.md'),'Changed during read\n');
    return count;
  };
  try{assert.throws(()=>inspectAcceptancePreview({specs:f.root}),/acceptance_preview_sources_changed/);}
  finally{fs.readSync=original;}
  assert(reads>=4);
});
test('missing mappings and malformed task declarations are visible diagnostics',t=>{
  const f=fixture(t);fs.writeFileSync(f.file('tasks.md'),'- [ ] T-003: 必验: Unmapped task\n');
  let preview=inspectAcceptancePreview({specs:f.root});assert.equal(preview.status,'needs_clarification');
  assert(preview.features[0].tasks[0].issues.some(issue=>issue.message.includes('no explicit task/case mapping')));
  fs.appendFileSync(f.file('tasks.md'),'- [ ] T-003: Duplicate\n');preview=inspectAcceptancePreview({specs:f.root});
  assert.equal(preview.status,'needs_clarification');assert.equal(preview.features[0].issues[0].locations[0].line,2);
});
test('linked source and invalid status refuse; preview never follows a source alias',t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.writeFileSync(outside,'external');
  fs.unlinkSync(f.file('design.md'));fs.symlinkSync(outside,f.file('design.md'));
  assert.throws(()=>inspectAcceptancePreview({specs:f.root}));
  fs.unlinkSync(f.file('design.md'));fs.writeFileSync(f.file('design.md'),'Design');
  fs.writeFileSync(path.join(f.root,'.cm-specs-status'),'{}');assert.throws(()=>inspectAcceptancePreview({specs:f.root}),/acceptance_preview_status_invalid/);
});
test('summary previews are bounded and old summaries without a preview remain readable',t=>{
  const f=fixture(t),features=[{directory:f.feature,documents:f.documents}];
  assert.equal(buildAcceptancePreview({features}).status,'ready');
  assert.equal(summaryAcceptancePreview({documents:features,statusBytes:null,taskGrammar:3}).status,'ready');
  assert.equal(summaryAcceptancePreview({documents:features,statusBytes:Buffer.from('{}'),taskGrammar:3}).status,'unavailable');
  assert.equal(currentAcceptancePreview({specs:f.root,preview:undefined}),null);
});
