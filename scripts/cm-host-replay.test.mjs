import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {captureBeforeSnapshot,replayDelivery,replayFactItem,notReplayed} from '../runtime/js/cm-ai/host-replay.mjs';
import {autoVerificationVerdict} from '../runtime/js/cm-ai/verification-auto.mjs';
import {splitRequirementReport,readRequirementItems} from '../runtime/js/cm-ai/requirement-evidence.mjs';

const identity={repositoryId:'replay',runId:'replay-run',taskId:'T-001',attempt:1};
// Unit tests run the check directly; production passes the same specs sandbox as the task's own checks.
const directCheck=({specsRoot,...rest})=>createHostCheck(rest);
const passed=[{id:'unit',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'host check exited 0 (pass 2)'}];

function project(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-replay-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'code'),specs=path.join(root,'specs');
  fs.mkdirSync(path.join(code,'src'),{recursive:true});fs.mkdirSync(path.join(code,'test'));fs.mkdirSync(specs);
  fs.writeFileSync(path.join(code,'package.json'),'{"type":"module"}\n');
  fs.writeFileSync(path.join(code,'src/sum.js'),'export const sum=(a,b)=>0;\n');
  fs.writeFileSync(path.join(code,'test/old.test.js'),"import test from 'node:test';test('old',()=>{});\n");
  return {code,specs};
}
const deliver=code=>{
  fs.writeFileSync(path.join(code,'src/sum.js'),'export const sum=(a,b)=>a+b;\n');
  fs.writeFileSync(path.join(code,'test/sum.test.js'),"import test from 'node:test';import assert from 'node:assert';import {sum} from '../src/sum.js';test('sum',()=>assert.equal(sum(1,2),3));\n");
};
const commands=[{id:'unit',command:['node','--test']}];

test('baseline, test-files-only and full delivery: the test fails first, the real project is never written',async t=>{
  const {code,specs}=project(t),scope=['src/sum.js','test/sum.test.js'];
  const snapshot=captureBeforeSnapshot(code,scope);
  assert.equal(snapshot.files.get('test/sum.test.js'),null);
  deliver(code);
  const before=fs.readFileSync(path.join(code,'src/sum.js'));
  const facts=await replayDelivery({codeProject:code,specsDir:specs,snapshot,scope,tests:['test/sum.test.js'],checkCommands:commands,
    timeoutMs:30000,identity,greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck});
  assert.equal(facts.status,'replayed');
  assert.equal(facts.baseline.outcome,'passed');
  assert.equal(facts.red.outcome,'failed');assert.match(facts.red.evidence,/^unit: host check exited 1/);
  assert.equal(facts.green.outcome,'passed');
  assert.deepEqual(fs.readFileSync(path.join(code,'src/sum.js')),before);
  assert.equal(fs.readdirSync(os.tmpdir()).some(name=>name.startsWith('cm-host-replay-')&&fs.existsSync(path.join(os.tmpdir(),name,'project','src','sum.js'))
    &&fs.readFileSync(path.join(os.tmpdir(),name,'project','src','sum.js'),'utf8').includes('a+b')),false,'the private copy is removed');
  const item=replayFactItem(facts);
  assert.deepEqual(readRequirementItems([item]).length,1);assert.match(item.evidence,/只放入测试文件：failed/);
});

test('without declared test files there is no test-files-only run; without a snapshot or checks nothing is replayed',async t=>{
  const {code,specs}=project(t),scope=['src/sum.js'];
  const snapshot=captureBeforeSnapshot(code,scope);deliver(code);
  const base={codeProject:code,specsDir:specs,scope,checkCommands:commands,timeoutMs:30000,identity,greenChecks:passed,
    signal:new AbortController().signal,makeCheck:directCheck};
  const facts=await replayDelivery({...base,snapshot,tests:[]});
  assert.equal(facts.status,'replayed');assert.deepEqual(facts.red,{skipped:'no_test_files'});
  assert.match(replayFactItem(facts).evidence,/跳过（tasks.md 未写测试文件）/);
  assert.equal((await replayDelivery({...base,snapshot:null,tests:[]})).reason,'no_before_snapshot');
  assert.equal((await replayDelivery({...base,snapshot,checkCommands:[],tests:[]})).reason,'no_host_checks');
  fs.symlinkSync(path.join(code,'src/sum.js'),path.join(code,'src/link.js'));
  assert.deepEqual(captureBeforeSnapshot(code,['src/link.js']),{unavailable:'snapshot_unsupported_file'});
  assert.equal((await replayDelivery({...base,snapshot:{unavailable:'snapshot_unsupported_file'},tests:[]})).reason,'snapshot_unsupported_file');
  assert.match(replayFactItem(notReplayed('multi_root',passed)).evidence,/^未实跑：multi_root/);
});

test('the developer report is split off the value; malformed reports are kept as invalid, not dropped silently',()=>{
  const item={requirement:'RED 先失败',satisfied:true,evidence:'test/sum.test.js 在旧实现下失败'};
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[item]}),{value:{outcome:'implemented'},items:[item]});
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:null}),{value:{outcome:'implemented'},items:null});
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[]}),{value:{outcome:'implemented'},items:null});
  assert.deepEqual(splitRequirementReport({outcome:'implemented'}),{value:{outcome:'implemented'},items:null});
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[{requirement:'x'}]}),{value:{outcome:'implemented'},items:'invalid'});
});

test('the auto gate passes only a complete report that matches the host runs',()=>{
  const replayed=(red,extra={})=>({version:1,status:'replayed',baseline:{outcome:'passed',evidence:'b'},red,green:{outcome:'passed',evidence:'g'},...extra});
  const redItem={requirement:'T-002: RED 必须因占位体抛错失败',satisfied:true,evidence:'test/sum.test.js'};
  const plain={requirement:'只改 src/sum.js',satisfied:true,evidence:'diff'};
  assert.deepEqual(autoVerificationVerdict({report:[redItem,plain],facts:replayed({outcome:'failed',evidence:'r'})}),
    {satisfied:true,items:[redItem,plain]});
  for(const [report,facts,match] of [
    [null,replayed({outcome:'failed',evidence:'r'}),/没有逐条要求/],
    ['invalid',replayed({outcome:'failed',evidence:'r'}),/格式不合法/],
    [[{...plain,satisfied:false}],replayed({outcome:'failed',evidence:'r'}),/只改 src\/sum\.js/],
    [[redItem],replayed({outcome:'passed',evidence:'r'}),/只放入测试文件时检查 passed/],
    [[redItem],replayed({skipped:'no_test_files'}),/未写测试文件/],
    [[redItem],notReplayed('no_before_snapshot',passed),/未实跑（no_before_snapshot）/],
    [[{requirement:'记录改代码前基线',satisfied:true,evidence:'x'}],notReplayed('replay_failed',passed),/没有实跑基线：replay_failed/],
    [[plain],{...replayed({outcome:'failed',evidence:'r'}),green:{outcome:'failed',evidence:'g'}},/全部放入后检查 failed/],
  ]){
    const verdict=autoVerificationVerdict({report,facts});
    assert.equal(verdict.satisfied,false);assert.match(verdict.unsatisfied.join('\n'),match);
  }
  // A plain requirement needs no replay; a baseline claim is matched by any replayed baseline.
  assert.equal(autoVerificationVerdict({report:[plain],facts:notReplayed('multi_root',passed)}).satisfied,true);
  assert.equal(autoVerificationVerdict({report:[{requirement:'baseline 用例数',satisfied:true,evidence:'5'}],facts:replayed({skipped:'no_test_files'})}).satisfied,true);
});
