import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildAcceptanceContract,acceptanceProblems} from '../runtime/js/cm-ai/acceptance-contract.mjs';
import {buildTaskAcceptanceContract,captureSpecificationMaterial,verifySpecificationMaterial,inspectSpecificationDrift} from '../runtime/js/cm-ai/specification-material.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
const texts=task=>({'tasks.md':task,'requirements.md':'# Requirements\n- [ ] [AC-001] matching output\n  - preserve all bytes\n','design.md':'# Design\n'});
const compile=line=>buildAcceptanceContract({taskId:'T-001',taskText:line,requirementsText:''});
const items=c=>c.obligations.map(item=>({...item,satisfied:true,evidence:'synthetic fixture evidence'}));
const facts=outcome=>({status:'replayed',baseline:{outcome},red:{skipped:true}});

test('B1 old task prose without explicit mandatory contract remains legacy even with unmapped ACs',()=>{
  assert.equal(buildTaskAcceptanceContract({texts:texts('- [ ] T-001: implement old feature\n'),taskId:'T-001'}),null);
  assert.equal(buildTaskAcceptanceContract({texts:texts('- [ ] T-001: implement AC-001\n  - 测试文件: `tests/a.test.mjs`\n'),taskId:'T-001'}),null);
  const oversized=texts('- [ ] T-001: implement AC-001\n');oversized['requirements.md']='- [ ] [AC-001] 必验: '+ 'x'.repeat(2100);
  const active=buildTaskAcceptanceContract({texts:oversized,taskId:'T-001'});assert.notEqual(active,null);assert(active.unresolved.length>0);
});

test('M1 mandatory task selection excludes shared metadata and other task mentions',()=>{
  const source=texts('# Tasks\n| version | T-001 historical note |\n- [ ] T-001: 必验: implement AC-001\n  - own clause\n- [ ] T-002: migration acceptance same as T-001 baseline\n  - delete old table\n');
  source['requirements.md']='# Product\n| version | TC-999 background |\n'+Array.from({length:80},(_,i)=>`F-${i}: unrelated background`).join('\n')+'\n- [ ] [AC-001] exact output\n  - own AC clause\n- [ ] [AC-002] other AC\n  - unrelated AC clause\n';
  const c=buildTaskAcceptanceContract({texts:source,taskId:'T-001'});
  assert.equal(c.unresolved.length,0);assert.equal(c.obligations.length,4);
  assert(c.obligations.some(item=>item.requirement==='- own clause'));
  assert(c.obligations.some(item=>item.requirement==='- own AC clause'));
  assert(c.obligations.every(item=>!/(migration|historical|background|delete|other AC)/.test(item.requirement)));
});

test('M2 negated baseline and RED clauses never reverse the required observed result',()=>{
  for(const line of ['- 基线不通过（旧代码下检查应当不通过）','- baseline must not pass']){
    const c=compile(line);assert.equal(c.obligations[0].result,'failed');
    assert.equal(acceptanceProblems(c,items(c),facts('failed')).length,0);
    assert(acceptanceProblems(c,items(c),facts('passed')).some(message=>message.includes('outcome mismatch')));
  }
  const baseline=compile('- 开发前基线不要求通过');assert.notEqual(baseline.obligations[0].result,'passed');
  const red=compile('- 本任务不要求先失败（纯重构）');assert.equal(red.obligations[0].run,null);
  for(const line of ['- baseline must never pass','- baseline must not have passed','- RED must not be run','- 基线不必通过','- baseline does not have to pass']){
    const unknown=compile(line);assert(unknown.unresolved.length>0,'unmodeled negation must require clarification');
    assert.notEqual(unknown.obligations[0].result,'passed');
  }
});

test('M3 executable-name prose and prohibited bare commands are never frozen executable argv',()=>{
  for(const line of ['- node --test a.test.mjs must not be run on CI','- node --test a.test.mjs cannot be run on CI','- node --test a.test.mjs is prohibited on CI','- go to settings and toggle dark mode','- node and npm must be installed','- sh scripts should be removed']){
    const c=compile(line);assert.deepEqual(c.requiredCommands,[],line);assert.notEqual(c.obligations[0].evidenceType,'host-check',line);
  }
  const prohibited=compile('- node --test a.test.mjs must not be run on CI');assert(prohibited.unresolved.length>0);
  assert.deepEqual(compile('- 运行：node --test a.test.mjs').requiredCommands,[['node','--test','a.test.mjs']]);
});

test('N1 prohibited parent clauses never freeze child commands in Chinese or English',async t=>{
  for(const [language,parent,command,constraint] of [
    ['Chinese','下面命令禁止运行：','npm run deploy','不要更改公共 API'],
    ['English','Do not run the following on CI:','node scripts/wipe.mjs','Do not change public API'],
  ])await t.test(language,()=>{
    const task=`- [ ] T-001: 必验: 发布前检查\n  - ${parent}\n    - ${command}\n`;
    const c=buildTaskAcceptanceContract({texts:{...texts(task),'requirements.md':''},taskId:'T-001'});
    assert.notEqual(c,null);
    assert.deepEqual(c.requiredCommands,[]);
    assert(c.unresolved.some(message=>message.includes('command context')));
    assert.equal(c.obligations.find(item=>item.requirement===`- ${command}`).evidenceType,'review');
    const sibling=buildTaskAcceptanceContract({texts:{...texts(task+'  - 必跑检查：\n    - npm run check\n'),
      'requirements.md':''},taskId:'T-001'});
    assert.deepEqual(sibling.requiredCommands,[['npm','run','check']]);
    const allowed=buildTaskAcceptanceContract({texts:{...texts(
      `- [ ] T-001: 必验: ${constraint}\n  - 必跑检查：\n    - npm run check\n`),
      'requirements.md':''},taskId:'T-001'});
    assert.deepEqual(allowed.requiredCommands,[['npm','run','check']]);
    assert.deepEqual(allowed.unresolved,[]);
  });
});

test('N1 R3 all reported non-mandatory parents and headings leave commands unresolved',async t=>{
  const contexts=['下面命令禁止运行：','Do not run the following on CI:','Never run these:',
    '下面的命令不能运行：','严禁执行以下命令：','以下命令不可执行：','以下脚本不许跑：',
    'The following must not be run:','These must never be executed:','Avoid running:','Forbidden commands:',
    '### 禁止运行的命令','参考示例：','For reference:'];
  for(const context of contexts)await t.test(context,()=>{
    for(const command of ['npm run deploy','node scripts/wipe.mjs'])for(const quoted of [false,true]){
      const value=quoted?'`'+command+'`':command;
      const task=`- [ ] T-001: 必验: 发布前检查\n  ${context.startsWith('#')?context:'- '+context}\n${context.startsWith('#')?'  ':'    '}- ${value}\n`;
      const c=buildTaskAcceptanceContract({texts:{...texts(task),'requirements.md':''},taskId:'T-001'});
      assert.notEqual(c,null);assert.deepEqual(c.requiredCommands,[],task);
      assert(c.unresolved.some(message=>message.includes('command context')),task);
      assert.equal(c.obligations.find(item=>item.requirement===`- ${value}`).evidenceType,'review');
    }
  });
});

test('N1 R3 commands require a positive inline parent or heading declaration',()=>{
  for(const command of ['node --test a.test.mjs','./scripts/test.sh']){
    const bare=compile('- '+command);
    assert.deepEqual(bare.requiredCommands,[]);assert(bare.unresolved.length>0);
    for(const label of ['必跑检查：','运行：','mandatory acceptance:']){
      for(const value of [command,'`'+command+'`'])for(const task of [
        `- ${label} ${value}`,`- ${label}\n  - ${value}`,`### ${label}\n- ${value}`,
      ]){
        const c=compile(task);assert.deepEqual(c.requiredCommands,[command.split(' ')],task);assert.deepEqual(c.unresolved,[],task);
      }
    }
  }
});

test('N1 R3 the nearest context shadows distant mandatory declarations and resets at boundaries',()=>{
  for(const task of [
    '- 必跑检查：\n  - 参考示例：\n    - npm run deploy',
    '### 必跑检查\n#### Forbidden commands\n- npm run deploy',
    '### 必跑检查\n- 参考示例：\n  - npm run deploy',
    '### 必跑检查\n### 参考示例\n- npm run deploy',
    '  ### 必跑检查\n- npm run deploy',
  ]){const c=compile(task);assert.deepEqual(c.requiredCommands,[],task);assert(c.unresolved.length>0,task);}
  const sibling=compile('### 参考示例\n- npm run deploy\n### 运行：\n- npm run check');
  assert.deepEqual(sibling.requiredCommands,[['npm','run','check']]);assert(sibling.unresolved.length>0);
  const sourceBoundary=buildAcceptanceContract({taskId:'T-001',taskText:'- 必跑检查：\n  - npm run check\n- AC-001',
    requirementsText:'- [ ] [AC-001] reference\n  - npm run deploy'});
  assert.deepEqual(sourceBoundary.requiredCommands,[['npm','run','check']]);assert(sourceBoundary.unresolved.length>0);
});

test('G2 a frozen contract is validated against its approved sources rather than recompiled on resume',t=>{
  const specsRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm019-frozen-contract-')));t.after(()=>fs.rmSync(specsRoot,{recursive:true,force:true}));
  const feature='1.demo';fs.mkdirSync(path.join(specsRoot,feature));
  const input=texts('- [ ] T-001: 必验: implement AC-001\n- [ ] T-002: old other task\n');for(const [name,content] of Object.entries(input))fs.writeFileSync(path.join(specsRoot,feature,name),content);
  fs.writeFileSync(path.join(specsRoot,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsRoot)}));
  const material=captureSpecificationMaterial({specsRoot,feature,taskId:'T-001'});
  // Historical v1 parser included shared prose. Its stored, structurally valid
  // projection remains authoritative while the exact approved source stays bound.
  const historical={...material,acceptanceContract:{...material.acceptanceContract,obligations:[...material.acceptanceContract.obligations,
    {id:'requirements:shared:historical:1',requirement:'# historical parser projection',evidenceType:'review',environment:'local',run:null,result:null}]}};
  const baseline={specificationRoot:specsRoot,identity:{repositoryId:'fixture',runId:'old',taskId:'T-001',attempt:1},specification:historical};
  assert.deepEqual(verifySpecificationMaterial(baseline),historical);
  const tasks=path.join(specsRoot,feature,'tasks.md');fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replace('old other task','new other task'));
  fs.writeFileSync(path.join(specsRoot,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsRoot)}));
  const drift=inspectSpecificationDrift(baseline);assert.equal(drift.rebindable,true);assert.deepEqual(drift.fields,[]);
  fs.appendFileSync(path.join(specsRoot,feature,'tasks.md'),'changed');assert.throws(()=>verifySpecificationMaterial(baseline),{code:'spec_drift'});
});
