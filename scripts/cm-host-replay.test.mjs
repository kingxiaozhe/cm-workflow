import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {captureBeforeSnapshot,replayDelivery,encodeHostReplayEvidence,notReplayed,HOST_REPLAY_EVIDENCE_PREFIX} from '../runtime/js/cm-ai/host-replay.mjs';
import {autoVerificationVerdict} from '../runtime/js/cm-ai/verification-auto.mjs';
import {splitRequirementReport} from '../runtime/js/cm-ai/requirement-evidence.mjs';

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
  const entry=encodeHostReplayEvidence({identity,facts});
  assert.ok(entry.startsWith(HOST_REPLAY_EVIDENCE_PREFIX));
  assert.equal(JSON.parse(entry.slice(HOST_REPLAY_EVIDENCE_PREFIX.length)).facts.red.outcome,'failed');
});

test('without declared test files there is no test-files-only run; without a snapshot or checks nothing is replayed',async t=>{
  const {code,specs}=project(t),scope=['src/sum.js'];
  const snapshot=captureBeforeSnapshot(code,scope);deliver(code);
  const base={codeProject:code,specsDir:specs,scope,checkCommands:commands,timeoutMs:30000,identity,greenChecks:passed,
    signal:new AbortController().signal,makeCheck:directCheck};
  const facts=await replayDelivery({...base,snapshot,tests:[]});
  assert.equal(facts.status,'replayed');assert.deepEqual(facts.red,{skipped:'no_test_files'});

  assert.equal((await replayDelivery({...base,snapshot:null,tests:[]})).reason,'no_before_snapshot');
  assert.equal((await replayDelivery({...base,snapshot,checkCommands:[],tests:[]})).reason,'no_host_checks');
  fs.symlinkSync(path.join(code,'src/sum.js'),path.join(code,'src/link.js'));
  assert.deepEqual(captureBeforeSnapshot(code,['src/link.js']),{unavailable:'snapshot_unsupported_file'});
  assert.equal((await replayDelivery({...base,snapshot:{unavailable:'snapshot_unsupported_file'},tests:[]})).reason,'snapshot_unsupported_file');
  assert.equal(notReplayed('multi_root',passed).green.outcome,'passed');
  // A path added to the scope after the snapshot has no known prior state: not replayed, never assumed absent.
  assert.equal((await replayDelivery({...base,scope:['src/sum.js','src/extra.js'],snapshot,tests:[]})).reason,'snapshot_scope_changed');
});

test('the developer report is split off the value; malformed reports are kept as invalid, not dropped silently',()=>{
  const item={requirement:'RED 先失败',satisfied:true,evidence:'test/sum.test.js 在旧实现下失败'};
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[item]}),{value:{outcome:'implemented'},items:[item]});
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:null}),{value:{outcome:'implemented'},items:null});
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[]}),{value:{outcome:'implemented'},items:null});
  assert.deepEqual(splitRequirementReport({outcome:'implemented'}),{value:{outcome:'implemented'},items:null});
  // An invalid report names the first broken rule, never the reported text.
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[{requirement:'x'}]}),
    {value:{outcome:'implemented'},items:'invalid',problem:'item 1: missing satisfied'});
});

test('the auto gate checks tagged run claims against the host runs, never free text',()=>{
  const replayed=(red,extra={})=>({version:1,status:'replayed',baseline:{outcome:'passed',evidence:'b'},red,green:{outcome:'passed',evidence:'g'},...extra});
  const redItem={requirement:'T-002: RED 必须因占位体抛错失败',satisfied:true,evidence:'test/sum.test.js',run:'red'};
  const plain={requirement:'只改 src/sum.js',satisfied:true,evidence:'diff'};
  assert.deepEqual(autoVerificationVerdict({report:[redItem,plain],facts:replayed({outcome:'failed',evidence:'r'})}),
    {satisfied:true,items:[redItem,plain]});
  for(const [report,facts,match] of [
    [null,replayed({outcome:'failed',evidence:'r'}),/没有逐条要求/],
    ['invalid',replayed({outcome:'failed',evidence:'r'}),/格式不合法/],
    [[{...plain,satisfied:false}],replayed({outcome:'failed',evidence:'r'}),/只改 src\/sum\.js/],
    [[redItem],replayed({outcome:'passed',evidence:'r'}),/只放入测试文件时检查 passed/],
    [[redItem],replayed({outcome:'unavailable',evidence:'r'}),/只放入测试文件时检查 unavailable/],
    [[redItem],replayed({skipped:'no_test_files'}),/未写测试文件/],
    [[redItem],notReplayed('no_before_snapshot',passed),/未实跑（no_before_snapshot）/],
    [[{...plain,run:'baseline'}],notReplayed('replay_failed',passed),/没有实跑基线：replay_failed/],
    [[{...plain,run:'baseline'}],replayed({skipped:'no_test_files'},{baseline:{outcome:'unavailable',evidence:'spawn_failed'}}),/基线没有跑起来：unavailable/],
    [[{...plain,run:'baseline',result:'passed'}],replayed({skipped:'no_test_files'},{baseline:{outcome:'failed',evidence:'b'}}),/标记基线 passed，宿主实跑基线 failed/],
    [[{...plain,run:'baseline',result:'failed'}],replayed({skipped:'no_test_files'}),/标记基线 failed，宿主实跑基线 passed/],
    [[plain],{...replayed({outcome:'failed',evidence:'r'}),green:{outcome:'failed',evidence:'g'}},/全部放入后检查 failed/],
  ]){
    const verdict=autoVerificationVerdict({report,facts});
    assert.equal(verdict.satisfied,false);assert.match(verdict.unsatisfied.join('\n'),match);
  }
  // Untagged text is never parsed: neither a behaviour that mentions failure nor a prose run claim.
  for(const evidence of ['校验失败时显示错误','新增测试先失败后通过','基线：失败 2 项'])
    assert.equal(autoVerificationVerdict({report:[{...plain,evidence}],facts:replayed({outcome:'passed',evidence:'r'})}).satisfied,true);
  // A baseline tag without a result needs only a baseline that ran.
  assert.equal(autoVerificationVerdict({report:[{...plain,run:'baseline'}],facts:replayed({skipped:'no_test_files'},{baseline:{outcome:'failed',evidence:'b'}})}).satisfied,true);
  assert.equal(autoVerificationVerdict({report:[plain],facts:notReplayed('multi_root',passed)}).satisfied,true);
  // Tags are validated (known values only); a result off a baseline item is dropped, never voids the report
  // (the first real run tagged its red item with result "failed"); the handoff text drops tags.
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[{...plain,run:'red',result:'failed'}]}).items,[{...plain,run:'red'}]);
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[{...plain,result:'passed'}]}).items,[plain]);
  assert.equal(splitRequirementReport({outcome:'implemented',requirements:[{...plain,run:'baseline',result:'green'}]}).items,'invalid');
  assert.equal(splitRequirementReport({outcome:'implemented',requirements:[{...plain,run:'baseline',result:'green'}]}).problem,
    'item 1: result is not passed, failed or null');
  assert.equal(splitRequirementReport({outcome:'implemented',requirements:[{...plain,run:'green'}]}).items,'invalid');
  assert.deepEqual(splitRequirementReport({outcome:'implemented',requirements:[{...plain,run:null,result:null}]}).items,[plain]);
});

test('each run uses a fresh copy: a check that plants a link cannot make the host write outside the copy',async t=>{
  const {code,specs}=project(t),scope=['src/sum.js','test/sum.test.js'];
  const victim=path.join(path.dirname(code),'victim.txt');fs.writeFileSync(victim,'untouched\n');
  const snapshot=captureBeforeSnapshot(code,scope);deliver(code);
  // The baseline check replaces the test file in its copy with a link to a file outside it.
  const planting=[{id:'plant',command:['node','-e',`const fs=require('fs');fs.rmSync('test/sum.test.js',{force:true});fs.symlinkSync(${JSON.stringify(victim)},'test/sum.test.js');`]}];
  const facts=await replayDelivery({codeProject:code,specsDir:specs,snapshot,scope,tests:['test/sum.test.js'],checkCommands:planting,
    timeoutMs:30000,identity,greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck});
  assert.equal(facts.status,'replayed');assert.equal(fs.readFileSync(victim,'utf8'),'untouched\n');
  // A link already on a scope path in the project is never written through.
  const outside=path.join(path.dirname(code),'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'sum.js'),'outside\n');
  fs.rmSync(path.join(code,'src'),{recursive:true});fs.symlinkSync(outside,path.join(code,'src'));
  const linked=await replayDelivery({codeProject:code,specsDir:specs,snapshot,scope,tests:[],checkCommands:commands,
    timeoutMs:30000,identity,greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck});
  assert.equal(linked.reason,'scope_link');assert.equal(fs.readFileSync(path.join(outside,'sum.js'),'utf8'),'outside\n');
});

test('the baseline restores file permissions, and a failed copy leaves no private directory behind',async t=>{
  const {code,specs}=project(t);
  fs.writeFileSync(path.join(code,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o644});
  const snapshot=captureBeforeSnapshot(code,['run.sh']);fs.chmodSync(path.join(code,'run.sh'),0o755);
  const executable=[{id:'exec',command:['node','-e',"process.exit(require('fs').statSync('run.sh').mode&0o111?0:1)"]}];
  const facts=await replayDelivery({codeProject:code,specsDir:specs,snapshot,scope:['run.sh'],tests:[],checkCommands:executable,
    timeoutMs:30000,identity,greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck});
  assert.equal(facts.baseline.outcome,'failed','the copy has the 0644 the file had before development');
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-replay-tmp-')));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const unreadable=path.join(code,'secret.bin');fs.writeFileSync(unreadable,'x');fs.chmodSync(unreadable,0o000);
  const previous=process.env.TMPDIR;process.env.TMPDIR=tmp;
  try{
    const failed=await replayDelivery({codeProject:code,specsDir:specs,snapshot,scope:['run.sh'],tests:[],checkCommands:executable,
      timeoutMs:30000,identity,greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck});
    assert.equal(failed.reason,'replay_failed');assert.deepEqual(fs.readdirSync(tmp),[]);
  }finally{fs.chmodSync(unreadable,0o600);if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
});

test('a check that could read the real project is not replayed; a link that stays inside the copy is',async t=>{
  const {code,specs}=project(t),scope=['src/sum.js','test/sum.test.js'];
  const snapshot=captureBeforeSnapshot(code,scope);deliver(code);
  const base={codeProject:code,specsDir:specs,snapshot,scope,tests:['test/sum.test.js'],timeoutMs:30000,identity,
    greenChecks:passed,signal:new AbortController().signal,makeCheck:directCheck};
  // A command naming the project by absolute path would run the real project.
  assert.equal((await replayDelivery({...base,checkCommands:[{id:'abs',command:['node','--test',path.join(code,'test/sum.test.js')]}]})).reason,
    'absolute_project_path');
  // A relative link inside the project (node_modules/.bin style) resolves inside the copy: replayed.
  fs.symlinkSync('src',path.join(code,'lib'));
  fs.writeFileSync(path.join(code,'test/sum.test.js'),"import test from 'node:test';import assert from 'node:assert';import {sum} from '../lib/sum.js';test('sum',()=>assert.equal(sum(1,2),3));\n");
  const relative=await replayDelivery({...base,checkCommands:commands});
  assert.equal(relative.status,'replayed');assert.equal(relative.red.outcome,'failed');
  // An absolute link into the project, or a chain that leaves and re-enters it, would read the real project.
  fs.rmSync(path.join(code,'lib'));fs.symlinkSync(path.join(code,'src'),path.join(code,'lib'));
  assert.equal((await replayDelivery({...base,checkCommands:commands})).reason,'internal_link');
  const alias=path.join(path.dirname(code),'alias');fs.symlinkSync(path.join(code,'src'),alias);
  fs.rmSync(path.join(code,'lib'));fs.symlinkSync(path.relative(code,alias),path.join(code,'lib'));
  assert.equal((await replayDelivery({...base,checkCommands:commands})).reason,'internal_link');
  assert.equal(fs.readlinkSync(path.join(code,'lib')),path.relative(code,alias),'the real link is untouched');
});
