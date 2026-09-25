import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
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
  // Republishing the same bytes is the crash-after-link case: already published.
  const before=fs.readFileSync(input.handoffPath);
  assert.equal(createHostHandoff(input).status,'ready_for_review');
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

// A run that dies before review leaves a handoff behind. Refusing to replace it
// blocks every later attempt of that task forever, which is what #81 reported.
// Approval evidence still must never be overwritten, so the receipt decides.
function collisionFixture(fn){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-handoff-collision-')));
  const root=path.join(temp,'code'),reviews=path.join(temp,'reviews');fs.mkdirSync(root);fs.mkdirSync(reviews);
  fs.writeFileSync(path.join(root,'a.mjs'),'old');fs.writeFileSync(path.join(root,'requirements.md'),'synthetic task');
  const handoffPath=path.join(reviews,'9.demo-T-001-a1-handoff.json');
  const build=body=>{
    fs.writeFileSync(path.join(root,'a.mjs'),'old');
    const baseline=captureReviewBaseline({root,identity:{repositoryId:'test',runId:'run',taskId:'T-001',attempt:1},
      scope:['a.mjs'],requirements:['requirements.md']});
    fs.writeFileSync(path.join(root,'a.mjs'),body);
    return {root,baseline,handoffPath,
      checks:[{id:'unit',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'host fixture check'}]};
  };
  try{fn({reviews,handoffPath,build});}finally{fs.rmSync(temp,{recursive:true,force:true});}
}

test('an unreviewed handoff from a dead run is archived so the retry can publish',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const stale=fs.readFileSync(f.handoffPath);
  assert.equal(createHostHandoff(f.build('second attempt')).status,'ready_for_review');
  const republished=fs.readFileSync(f.handoffPath);
  assert.notDeepEqual(republished,stale);
  const archive=path.join(f.reviews,'.superseded');
  const archived=fs.readdirSync(archive);
  assert.equal(archived.length,1);
  assert.match(archived[0],/^9\.demo-T-001-a1-handoff\.json\.[0-9a-f]{16}$/);
  assert.deepEqual(fs.readFileSync(path.join(archive,archived[0])),stale);
}));

test('stale handoff archival preserves exact bytes and tolerates an existing crash-after-link archive',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const stale=fs.readFileSync(f.handoffPath);
  const staleStat=fs.statSync(f.handoffPath);
  const name=path.basename(f.handoffPath);
  const stamp=createHash('sha256').update(stale).digest('hex').slice(0,16);
  const archive=path.join(f.reviews,'.superseded');
  const target=path.join(archive,`${name}.${stamp}`);
  const unrelated=path.join(f.reviews,'unrelated-r1.md');
  fs.writeFileSync(unrelated,Buffer.from([0,255,10,42]));
  const unrelatedBytes=fs.readFileSync(unrelated),unrelatedStat=fs.statSync(unrelated);
  assert.equal(fs.existsSync(archive),false);

  const retry=f.build('second attempt');
  assert.equal(createHostHandoff(retry).status,'ready_for_review');
  assert.equal(fs.statSync(archive).mode&0o777,0o700);
  assert.deepEqual(fs.readdirSync(archive),[`${name}.${stamp}`]);
  assert.deepEqual(fs.readFileSync(target),stale);
  assert.equal(fs.statSync(target).ino,staleStat.ino);
  const published=fs.readFileSync(f.handoffPath);
  assert.notDeepEqual(published,stale);
  assert.equal(fs.statSync(f.handoffPath).nlink,1);
  assert.notEqual(fs.statSync(f.handoffPath).ino,staleStat.ino);
  assert.equal(loadHandoff(f.handoffPath).implementation_sha256,implementationSha256(retry.root,['a.mjs']));

  fs.unlinkSync(f.handoffPath);
  fs.linkSync(target,f.handoffPath); // Crash after archive link, before source unlink.
  assert.equal(createHostHandoff(retry).status,'ready_for_review');
  assert.deepEqual(fs.readFileSync(f.handoffPath),published);
  assert.deepEqual(fs.readdirSync(archive),[`${name}.${stamp}`]);
  assert.deepEqual(fs.readdirSync(f.reviews).sort(),['.superseded',name,'unrelated-r1.md'].sort());
  assert.deepEqual(fs.readFileSync(unrelated),unrelatedBytes);
  assert.equal(fs.statSync(unrelated).ino,unrelatedStat.ino);
  assert.equal(fs.statSync(unrelated).mtimeMs,unrelatedStat.mtimeMs);
}));

test('a handoff the matching receipt names is never replaced',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const reviewed=fs.readFileSync(f.handoffPath);
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),
    ['---','at: 2026-01-01T00:00:00.000Z','reviewer: claude-cli','independent: true','task: T-001',
     'attempt: 1','round: 1','verdict: approved','handoff: 9.demo-T-001-a1-handoff.json',
     'handoff_sha256: '+'0'.repeat(64),'blocking_findings: 0','---',''].join('\n'));
  assert.throws(()=>createHostHandoff(f.build('second attempt')),error=>error.code==='handoff_exists');
  assert.deepEqual(fs.readFileSync(f.handoffPath),reviewed);
  assert.equal(fs.existsSync(path.join(f.reviews,'.superseded')),false);
}));

test('a receipt for another handoff does not protect this one',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),
    ['---','verdict: approved','handoff: 9.demo-T-002-a1-handoff.json','---',''].join('\n'));
  assert.equal(createHostHandoff(f.build('second attempt')).status,'ready_for_review');
  assert.equal(fs.readdirSync(path.join(f.reviews,'.superseded')).length,1);
}));

// The receipt names the handoff it reviewed inside its front matter, and the
// scope list after that line is as long as the task's changed file list. Reading
// a fixed number of lines made the decision depend on field order; a reordering
// would silently turn reviewed evidence into a supersedable leftover.
const receipt=(handoffName,scopeLength,{order='handoff-first',terminated=true}={})=>{
  const head=['---','at: 2026-01-01T00:00:00.000Z','reviewer: claude-cli','independent: true',
    'task: T-001','attempt: 1','round: 1','verdict: approved'];
  const bound=[`handoff: ${handoffName}`,'handoff_sha256: '+'0'.repeat(64),'blocking_findings: 0'];
  const scope=['scope:',...Array.from({length:scopeLength},(_,i)=>`  - src/file${i}.mjs`)];
  return [...head,...(order==='handoff-first'?[...bound,...scope]:[...scope,...bound]),
    ...(terminated?['---','','No blocking findings.']:[])].join('\n');
};

test('a reviewed handoff stays protected however long the scope list is',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const reviewed=fs.readFileSync(f.handoffPath);
  // 200 scope entries push the handoff line far past any fixed window.
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),
    receipt('9.demo-T-001-a1-handoff.json',200));
  assert.throws(()=>createHostHandoff(f.build('second attempt')),error=>error.code==='handoff_exists');
  assert.deepEqual(fs.readFileSync(f.handoffPath),reviewed);
}));

test('a reviewed handoff stays protected if the front matter is reordered',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const reviewed=fs.readFileSync(f.handoffPath);
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),
    receipt('9.demo-T-001-a1-handoff.json',40,{order:'scope-first'}));
  assert.throws(()=>createHostHandoff(f.build('second attempt')),error=>error.code==='handoff_exists');
  assert.deepEqual(fs.readFileSync(f.handoffPath),reviewed);
}));

test('a receipt that is not recognisable front matter fails closed',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const reviewed=fs.readFileSync(f.handoffPath);
  for(const body of [
    receipt('9.demo-T-001-a1-handoff.json',3,{terminated:false}),   // 未闭合
    'no front matter at all\nhandoff: 9.demo-T-001-a1-handoff.json\n', // 没有起始 ---
  ]){
    fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),body);
    assert.throws(()=>createHostHandoff(f.build('second attempt')),error=>error.code==='handoff_exists');
    assert.deepEqual(fs.readFileSync(f.handoffPath),reviewed);
  }
}));

test('a handoff line in the body rather than the front matter does not protect',()=>collisionFixture(f=>{
  // Only the front matter binds a receipt to a handoff; prose must not.
  createHostHandoff(f.build('first attempt'));
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),
    ['---','verdict: approved','---','','handoff: 9.demo-T-001-a1-handoff.json'].join('\n'));
  assert.equal(createHostHandoff(f.build('second attempt')).status,'ready_for_review');
  assert.equal(fs.readdirSync(path.join(f.reviews,'.superseded')).length,1);
}));

test('an oversized receipt fails closed instead of being parsed',()=>collisionFixture(f=>{
  createHostHandoff(f.build('first attempt'));
  const reviewed=fs.readFileSync(f.handoffPath);
  fs.writeFileSync(path.join(f.reviews,'9.demo-T-001-r1.md'),'x'.repeat(256*1024+1));
  assert.throws(()=>createHostHandoff(f.build('second attempt')),error=>error.code==='handoff_exists');
  assert.deepEqual(fs.readFileSync(f.handoffPath),reviewed);
}));
