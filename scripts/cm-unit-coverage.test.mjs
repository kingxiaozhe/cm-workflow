import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseUnitCoverage,summarizeUnitCoverage,runUnitCoverage,prepareUnitSupplement,verifyUnitSupplement,changedUnitLines} from '../runtime/js/cm-test/unit-coverage.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
function fixture(t){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-unit-'))),project=path.join(temp,'project');fs.mkdirSync(project);
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const git=(...args)=>{const r=spawnSync('git',['-C',project,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const write=(file,text)=>{const p=path.join(project,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);};
  const commit=()=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');};
  git('init','-q','-b','main');write('.gitignore','coverage/\n');
  write('source.mjs',"export function classify(value) {\n  if (value < 0) return 'negative';\n  return 'positive';\n}\n");
  write('source.test.mjs',"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {classify} from './source.mjs';\ntest('positive',()=>assert.equal(classify(1),'positive'));\n");
  write('package.json',JSON.stringify({scripts:{'test:coverage':'node --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --test source.test.mjs'}}));
  fs.mkdirSync(path.join(project,'coverage'));commit();git('checkout','-qb','topic');
  write('source.mjs',"export function classify(value) {\n  if (value < 0) return 'negative';\n  if (value === 0) return 'zero';\n  return 'positive';\n}\n");commit();
  const config={project,target:'head',outputDir:'coverage',report:'coverage/lcov.info',format:'lcov',command:{id:'unit',command:['npm','run','test:coverage'],declaration:{path:'package.json',line:1}}};
  return {temp,project,write,git,commit,config};
}

test('LCOV computes actual changed-line/branch hits, gaps and exclusions without invented 100%',()=>{
  const files=parseUnitCoverage('TN:\nSF:source.mjs\nDA:2,1\nDA:3,0\nBRDA:3,0,0,1\nBRDA:3,0,1,-\nend_of_record\n','lcov','/project');
  const result=summarizeUnitCoverage([{path:'source.mjs',lines:[2,3,4]},{path:'unmeasured.mjs',lines:[1]},{path:'README.md',lines:[1]}],files,[{path:'README.md',reason:'documentation'}]);
  assert.equal(result.status,'PARTIAL');assert.deepEqual(result.lines,{total:2,covered:1,percent:50});
  assert.equal(result.branches.percent,null);assert.equal(result.branches.measuredPercent,50);
  assert.deepEqual(result.files[0].uncoveredLines,[3]);assert.deepEqual(result.files[0].unmappedLines,[4]);assert.equal(result.files[1].status,'missing');
  const empty=summarizeUnitCoverage([{path:'source.mjs',lines:[8]}],files);assert.equal(empty.lines.percent,null);assert.equal(empty.branches.percent,null);
});
test('mixed LCOV branch evidence stays unknown; explicit zero branches is distinct',()=>{
  const known='SF:a.mjs\nDA:1,1\nBRDA:1,0,0,1\nBRDA:1,0,1,1\nBRF:2\nend_of_record\n';
  const selection=[{path:'a.mjs',lines:[1]},{path:'b.mjs',lines:[1]}];
  for(const missing of ['', 'BRF:2\n']){
    const report=known+`SF:b.mjs\nDA:1,1\n${missing}end_of_record\n`;
    const result=summarizeUnitCoverage(selection,parseUnitCoverage(report,'lcov','/project'));
    assert.equal(result.status,'PARTIAL');assert.equal(result.branches.percent,null);assert.equal(result.branches.measuredPercent,100);
    assert.deepEqual(result.branchGaps,['b.mjs']);assert.equal(result.files[1].branchStatus,'missing');
  }
  const zero=known+'SF:b.mjs\nDA:1,1\nBRF:0\nend_of_record\n';
  const result=summarizeUnitCoverage(selection,parseUnitCoverage(zero,'lcov','/project'));
  assert.equal(result.status,'MEASURED');assert.equal(result.branches.percent,100);assert.equal(result.files[1].branchStatus,'not_applicable');
});
test('Istanbul statement start-line max and branch counts; malformed reports rejected',()=>{
  const item={path:'/project/input.ts',statementMap:{0:{start:{line:2}},1:{start:{line:2}}},s:{0:0,1:2},
    branchMap:{0:{line:2,locations:[{},{}]}},b:{0:[1,0]}};
  const result=summarizeUnitCoverage([{path:'input.ts',lines:[2]}],parseUnitCoverage(JSON.stringify({x:item}),'istanbul','/project'));
  assert.equal(result.lines.percent,100);assert.equal(result.branches.percent,50);
  for(const bad of ['SF:input.ts\nDA:2,NaN\nend_of_record','SF:input.ts\nDA:2,1','DA:1,0'])assert.throws(()=>parseUnitCoverage(bad,'lcov','/project'));
  assert.throws(()=>parseUnitCoverage(JSON.stringify({x:{...item,b:{0:[-1,0]}}}),'istanbul','/project'));
});
test('actual Node coverage runner -> identify missing branch -> test-only supplement -> rerun',async t=>{
  const f=fixture(t),before=await runUnitCoverage(f.config);
  assert.ok(['MEASURED','PARTIAL'].includes(before.status),JSON.stringify(before));assert.equal(before.testsExecuted,true);
  assert.ok(before.files[0].uncoveredBranches.length>0,JSON.stringify(before));assert.equal(before.completionAuthorized,false);
  const baseline=prepareUnitSupplement({project:f.project,authorized:true,tests:['source.test.mjs'],outputDir:'coverage'});
  fs.appendFileSync(path.join(f.project,'source.test.mjs'),"test('zero',()=>assert.equal(classify(0),'zero'));\n");
  assert.equal(verifyUnitSupplement(baseline).status,'REVIEW_REQUIRED');
  const after=await runUnitCoverage({...f.config,supplement:baseline});assert.equal(after.observed.exitCode,0);
  assert.ok(after.branches.covered>before.branches.covered,JSON.stringify({before,after}));assert.equal(after.completionAuthorized,false);
});
test('no runner is NOT_MEASURED; dirty production cannot be measured as committed HEAD',async t=>{
  const f=fixture(t);const result=await runUnitCoverage({project:f.project});assert.equal(result.status,'NOT_MEASURED');assert.equal(result.testsExecuted,false);
  f.write('source.mjs','dirty source');await assert.rejects(runUnitCoverage(f.config),/coverage_dirty_head/);
});
test('HEAD rejects new execution inputs; only exact reports and authorized new tests are allowed',async t=>{
  const f=fixture(t);
  f.write('package.json',JSON.stringify({scripts:{'test:coverage':'node --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --test'}}));f.commit();
  f.write('extra.test.mjs',"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {classify} from './source.mjs';\ntest('zero',()=>assert.equal(classify(0),'zero'));\n");
  await assert.rejects(runUnitCoverage(f.config),/coverage_untracked_head/);
  assert.equal(fs.existsSync(path.join(f.project,'coverage/lcov.info')),false);
  fs.unlinkSync(path.join(f.project,'extra.test.mjs'));
  f.write('extra.mjs','export const newProductInput = 1;\n');
  await assert.rejects(runUnitCoverage(f.config),/coverage_untracked_head/);fs.unlinkSync(path.join(f.project,'extra.mjs'));
  f.write('docs/test-reports/run/impact.md','# Current impact\n');
  await assert.rejects(runUnitCoverage(f.config),/coverage_untracked_head/);
  const config={...f.config,auditFiles:['docs/test-reports/run/impact.md']};
  assert.equal((await runUnitCoverage(config)).testsExecuted,true);
  f.write('docs/test-reports/run/extra.mjs','export const x=1;\n');
  await assert.rejects(runUnitCoverage(config),/coverage_untracked_head/);
  await assert.rejects(runUnitCoverage({...config,auditFiles:[...config.auditFiles,'docs/test-reports/run/extra.mjs']}),/coverage_audit_files_invalid/);
  fs.unlinkSync(path.join(f.project,'docs/test-reports/run/extra.mjs'));
  const baseline=prepareUnitSupplement({project:f.project,authorized:true,tests:['extra.test.mjs'],outputDir:'coverage'});
  f.write('extra.test.mjs',"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {classify} from './source.mjs';\ntest('zero',()=>assert.equal(classify(0),'zero'));\n");
  assert.equal((await runUnitCoverage({...config,supplement:baseline})).testsExecuted,true);
});
test('stale coverage and failing tests never count as a successful measurement',async t=>{
  const f=fixture(t);await runUnitCoverage(f.config);
  f.write('package.json',JSON.stringify({scripts:{'test:coverage':'node --version'}}));f.commit();
  await assert.rejects(runUnitCoverage(f.config),/coverage_report_not_fresh/);
  f.write('package.json',JSON.stringify({scripts:{'test:coverage':'node missing-file.mjs'}}));f.commit();
  const result=await runUnitCoverage(f.config);assert.equal(result.status,'TESTS_FAILED');assert.ok(!Object.hasOwn(result,'lines'));
});
test('working-tree scope includes new uncommitted files and excludes other user work',t=>{
  const f=fixture(t);f.write('new.mjs','export const x = 1;\n');f.write('other.mjs','user work');
  const changes=changedUnitLines(f.project,{base:f.git('rev-parse','main'),head:f.git('rev-parse','HEAD'),target:'working-tree',scope:['new.mjs']});
  assert.deepEqual(changes.map(row=>row.path),['new.mjs']);assert.ok(changes[0].lines.includes(1));
  assert.throws(()=>changedUnitLines(f.project,{base:f.git('rev-parse','main'),target:'working-tree',scope:[]}),/coverage_worktree_scope_required/);
});
test('supplement refuses missing authorization, product paths, symlinks, deletion, staging and source edits',t=>{
  const f=fixture(t),config={project:f.project,authorized:true,tests:['source.test.mjs'],outputDir:'coverage'};
  assert.throws(()=>prepareUnitSupplement({...config,authorized:false}),/authorization_required/);
  assert.throws(()=>prepareUnitSupplement({...config,tests:['source.mjs']}),/scope_invalid/);
  assert.throws(()=>prepareUnitSupplement({...config,tests:['.codex/tests/hook.mjs']}),/scope_invalid/);
  fs.symlinkSync('source.mjs',path.join(f.project,'alias.test.mjs'));assert.throws(()=>prepareUnitSupplement({...config,tests:['alias.test.mjs']}),/scope_invalid/);fs.unlinkSync(path.join(f.project,'alias.test.mjs'));
  const b=prepareUnitSupplement(config);fs.appendFileSync(path.join(f.project,'source.test.mjs'),'// test addition\n');
  f.write('source.mjs','product edit');assert.throws(()=>verifyUnitSupplement(b),/out_of_scope/);f.git('restore','source.mjs');
  f.git('add','source.test.mjs');assert.throws(()=>verifyUnitSupplement(b),/unit_git_changed/);f.git('reset','-q','HEAD','source.test.mjs');
  fs.unlinkSync(path.join(f.project,'source.test.mjs'));assert.throws(()=>verifyUnitSupplement(b),/unit_test_missing/);
});
test('runner output cannot whitelist tracked source, report aliases or mutate product files',async t=>{
  const f=fixture(t);
  await assert.rejects(runUnitCoverage({...f.config,outputDir:'.'}),/coverage_output_invalid/);
  f.write('coverage/owned.txt','tracked');f.git('add','-f','coverage/owned.txt');await assert.rejects(runUnitCoverage(f.config),/coverage_output_tracked/);f.git('reset','-q','HEAD','coverage/owned.txt');
  f.write('mutate.mjs',"import fs from 'node:fs';fs.writeFileSync('source.mjs','changed');\n");
  f.write('package.json',JSON.stringify({scripts:{'test:coverage':'node mutate.mjs'}}));f.commit();
  await assert.rejects(runUnitCoverage(f.config),/coverage_source_changed/);assert.equal(fs.readFileSync(path.join(f.project,'source.mjs'),'utf8'),'changed');
});
test('public CLI executes existing runner and emits bound machine result',t=>{
  const f=fixture(t),file=path.join(f.temp,'config.json');fs.writeFileSync(file,JSON.stringify(f.config));
  const r=spawnSync(process.execPath,[path.join(root,'scripts/cm-unit-coverage.mjs'),'run','--config',file],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.testsExecuted,true);assert.ok(result.reportDigest);
});
