import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseFeatureTaskText,validDependencies} from '../runtime/js/cm-ai/cm-ai-admission.mjs';

const entry=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-product-admission-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),'- [ ] T-001: implement login\n');
  try{return run({root,specs,code});}finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('product admission selects one approved task across every code project',()=>fixture(({root,specs,code})=>{
  const backend=path.join(root,'backend');fs.mkdirSync(backend);fs.writeFileSync(path.join(backend,'README.md'),'existing\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.login'],testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--code-project',backend],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const admission=JSON.parse(result.stdout);
  assert.deepEqual(admission.nextTask,{feature:'1.login',id:'T-001',description:'implement login'});
  assert.deepEqual(admission.codeProjects,[code,backend]);
  assert.deepEqual(admission.projectAdmissions.map(item=>item.state),['ready','ready']);
}));

test('product admission reports generic continuation without approving or writing specs',()=>fixture(({root,specs,code})=>{
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const before=fs.readFileSync(path.join(specs,'.cm-specs-status'));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approval-response','继续'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).reason,'spec_approval_required');
  assert.deepEqual(fs.readFileSync(path.join(specs,'.cm-specs-status')),before);
  assert.equal(fs.readdirSync(root).length,2);
}));

function writeFeature(specs,name,source){
  const target=path.join(specs,name);fs.mkdirSync(target,{recursive:true});
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(target,file),'# Fixture\n');
  fs.writeFileSync(path.join(target,'tasks.md'),source);
}

function admission(specs,code,names,exitCode=0){
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:names,testCases:[]}));
  const result=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code],{encoding:'utf8'});
  assert.equal(result.status,exitCode,result.stderr||result.stdout);
  return JSON.parse(result.stdout);
}

const threeTasks='- [x] T-001: first\n- [ ] T-002: second\n- [ ] T-003: third\n';

test('dependency parser accepts sentence punctuation per ID and preserves internal ID characters',()=>{
  for(const suffix of ['。','．','.','；',';','、',' 。 ．.；;、 \t']){
    const parsed=parseFeatureTaskText(threeTasks+`- T-002 依赖 T-001${suffix}\n- T-003 依赖 T-001${suffix}，T-002${suffix}\n`,
      {allowDependencyPunctuation:true});
    assert.equal(parsed.error,undefined);
    assert.deepEqual([...parsed.dependencies],[['T-002',['T-001']],['T-003',['T-001','T-002']]]);
    assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
  }
  const parsed=parseFeatureTaskText('- [x] T-api.v1_beta-2: first\n- [ ] T-next: next\n- T-next 依赖 T-api.v1_beta-2。\n',
    {allowDependencyPunctuation:true});
  assert.deepEqual(parsed.dependencies.get('T-next'),['T-api.v1_beta-2']);
  assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
});

test('shared parser defaults preserve cm-prd strict dependency validation',()=>{
  const source=threeTasks+'- T-002 依赖 T-001。\n';
  assert.equal(parseFeatureTaskText(source).error,'dependencies_invalid');
  const parsed=parseFeatureTaskText(source.replace('T-001。','T-001'));
  assert.equal(parsed.error,undefined);assert.equal(validDependencies(parsed.tasks,parsed.dependencies),true);
});

test('product admission selects the same task with single and multiple punctuated dependencies',()=>fixture(({specs,code})=>{
  const source=threeTasks+'- T-002 依赖 T-001。\n- T-003 依赖 T-001，T-002。\n';
  writeFeature(specs,'1.login',source);
  let result=admission(specs,code,['1.login']);
  assert.equal(result.state,'ready');assert.equal(result.nextTask.id,'T-002');
  writeFeature(specs,'1.login',source.replace('[ ] T-002','[x] T-002'));
  result=admission(specs,code,['1.login']);
  assert.equal(result.state,'ready');assert.equal(result.nextTask.id,'T-003');
}));

for(const [label,source,reason,line] of [
  ['internal punctuation',threeTasks+'- T-002 依赖 T-001。T-003\n','dependencies_invalid',4],
  ['punctuation only',threeTasks+'- T-002 依赖 。；\n','dependencies_invalid',4],
  ['punctuation-only second ID',threeTasks+'- T-002 依赖 T-001,。\n','dependencies_invalid',4],
  ['duplicate dependency',threeTasks+'- T-002 依赖 T-001。\n- T-002 依赖 T-003。\n','dependencies_invalid',5],
  ['unknown dependency',threeTasks+'- T-002 依赖 T-999。\n','dependencies_invalid',4],
  ['unknown dependent',threeTasks+'- T-999 依赖 T-001。\n','dependencies_invalid',4],
  ['self dependency',threeTasks+'- T-002 依赖 T-002。\n','dependencies_invalid',4],
  ['cycle',threeTasks+'- T-002 依赖 T-003。\n- T-003 依赖 T-002。\n','dependencies_invalid',4],
  ['duplicate task',threeTasks+`- [ ] T-002: ${'重复'.repeat(100)}\n`,'tasks_invalid',4],
  ['no tasks','\n# Empty task list\n','tasks_invalid',2],
  ['empty file','','tasks_invalid',1],
])test(`product admission locates ${label} and preserves earlier feature summaries`,()=>fixture(({specs,code})=>{
  writeFeature(specs,'1.login','- [x] T-001: historical completion\n');
  writeFeature(specs,'2.broken',source.replace(/\n/g,'\r\n'));
  writeFeature(specs,'3.later','- [ ] T-001: must not skip broken feature\n');
  const result=admission(specs,code,['1.login','2.broken','3.later'],1);
  assert.equal(result.state,'blocked');assert.equal(result.reason,reason);assert.equal(result.nextTask,null);
  assert.deepEqual(result.detail,{feature:'2.broken',line,text:source.split('\n')[line-1].slice(0,120)});
  assert(result.detail.text.length<=120);
  assert.deepEqual(result.features,[{name:'1.login',total:1,completed:1,dropped:0,pending:0}]);
  assert.equal(result.warnings.length,1);
}));

for(const source of [threeTasks+'- T-002 依赖 T-001。T-003\n',threeTasks+'- [ ] T-002: duplicate\n'])
test('bootstrap parse failures keep their diagnostic location in a non-empty project',()=>fixture(({specs,code})=>{
  writeFeature(specs,'0.bootstrap',source);
  const result=admission(specs,code,['0.bootstrap','1.login'],1);
  assert.equal(result.state,'blocked');assert.equal(result.nextTask,null);
  assert.equal(result.reason,source.includes('依赖')?'dependencies_invalid':'tasks_invalid');
  assert.deepEqual(result.detail,{feature:'0.bootstrap',line:4,text:source.split('\n')[3]});
}));

test('three punctuated historical features admit the new feature without changing selection order',()=>fixture(({specs,code})=>{
  const names=['1.login','2.profile','3.settings','4.todo-priority'];
  const historical='- [x] T-001: first\n- [x] T-002: second\n- [x] T-003: third\n'
    +'- T-002 依赖 T-001。\n- T-003 依赖 T-001，T-002。\n';
  for(const name of names.slice(0,3))writeFeature(specs,name,historical);
  writeFeature(specs,names[3],'- [ ] ~~T-000: removed~~ [DROPPED v2]\n'+threeTasks
    +'- T-002 依赖 T-001\n- T-003 依赖 T-001,T-002\n');
  let result=admission(specs,code,names);
  assert.equal(result.state,'ready');
  assert.deepEqual(result.nextTask,{feature:'4.todo-priority',id:'T-002',description:'second'});
  assert.deepEqual(result.features.map(item=>item.name),names);
  assert.equal(result.features[3].dropped,1);
  writeFeature(specs,'2.profile',historical.replace('[x] T-002','[ ] T-002'));
  result=admission(specs,code,names);
  assert.equal(result.state,'ready');
  assert.deepEqual(result.nextTask,{feature:'2.profile',id:'T-002',description:'second'});
  assert.deepEqual(result.features.map(item=>item.name),names.slice(0,2));
}));
