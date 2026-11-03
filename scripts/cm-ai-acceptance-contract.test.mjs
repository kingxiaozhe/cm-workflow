import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildAcceptanceContract,acceptanceProblems,acceptanceCoverage,encodeAcceptanceEvidence,verifyAcceptanceEvidence} from '../runtime/js/cm-ai/acceptance-contract.mjs';
import {captureSpecificationMaterial,verifySpecificationMaterial,taskScopeText} from '../runtime/js/cm-ai/specification-material.mjs';
import {autoVerificationVerdict} from '../runtime/js/cm-ai/verification-auto.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-acceptance-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const identity={repositoryId:'acceptance-fixture',runId:'acceptance-run',taskId:'T-001',attempt:1};
const contract=(extra='')=>buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement AC-001\n  - preserve state\n'+extra,
  requirementsText:'- [ ] [AC-001] output correct\n  - no partial result',testCases:[]});
const report=c=>c.obligations.map(item=>({...item,satisfied:true,evidence:'Synthetic evidence for this isolated fixture'}));
const facts={status:'replayed',baseline:{outcome:'passed'},red:{outcome:'failed',skipped:false},green:{outcome:'passed'}};

test('frozen set includes task children and AC continuation; missing, repeated and invented IDs reject',()=>{
  const c=contract(),items=report(c);assert.equal(c.obligations.length,4);
  assert.deepEqual(acceptanceProblems(c,items,facts),[]);
  for(const changed of [items.slice(0,1),[...items,items[0]],[...items,{...items[0],id:'fake'}]])
    assert.ok(acceptanceProblems(c,changed,facts).length);
  assert.equal(autoVerificationVerdict({report:items.slice(0,1),facts,contract:c}).satisfied,false);
});
test('removing RED tag cannot replace missing host facts, and baseline claims agree with host facts',()=>{
  const c=contract('  - RED 必须先失败\n  - 实现前基线\n'),items=report(c);
  assert.deepEqual(acceptanceProblems(c,items,facts),[]);
  assert.ok(acceptanceProblems(c,items.map(item=>({...item,run:null})),facts).length);
  assert.ok(acceptanceProblems(c,items,null).length);
  assert.ok(acceptanceProblems(c,items.map(item=>item.run==='baseline'?{...item,result:'failed'}:item),facts).length);
});
test('environment and evidence type cannot replace approved device acceptance with static checks',()=>{
  const c=contract('  - 真机验证\n'),items=report(c),device=items.find(item=>item.environment==='device');
  assert.ok(device);device.environment='local';device.evidenceType='review';
  assert.ok(acceptanceProblems(c,items,facts).some(item=>item.includes('mismatch')));
});
test('compound environment/run requirements remain unresolved rather than dropping one obligation',()=>{
  for(const line of ['真机上先观察 RED 失败','实现前基线必须通过，RED 必须先失败']){
    const c=contract(`  - ${line}\n`);
    assert.ok(c.unresolved.some(item=>item.includes('compound')));
    assert.ok(acceptanceProblems(c,report(c),null).length);
    assert.ok(acceptanceProblems(c,report(c),{...facts,baseline:{outcome:'unavailable'}}).length);
  }
});
test('removing the claimed baseline result cannot waive the approved baseline outcome',()=>{
  const c=contract('  - 实现前基线必须失败\n'),items=report(c).map(({result,...item})=>item);
  assert.ok(acceptanceProblems(c,items,facts).some(item=>item.includes('required baseline outcome')));
});
test('unmapped ACs remain explicit unresolved obligations and cannot be waved through',()=>{
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement',requirementsText:'- [ ] [AC-001] exact result'});
  assert.match(c.unresolved[0],/mapping/);assert.ok(acceptanceProblems(c,report(c),facts).length);
});
test('nested heading preserves its task clauses even when they mention another task',()=>{
  const source='- [ ] T-001: implement\n  ### 验收\n  - must preserve T-002 output\n- [ ] T-002: unrelated\n  - other content\n';
  const scoped=taskScopeText(source,'T-001',undefined,true);
  assert.match(scoped,/preserve T-002/);assert.doesNotMatch(scoped,/other content/);
});
test('nested AC headings and shared requirement prose cannot lose acceptance clauses',()=>{
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement AC-001',
    requirementsText:'Shared: no data loss\n- [ ] [AC-001] complete\n  ### 验收环境\n  - 必须在真机完成保存回读\n- [ ] [AC-002] another task\n  - other clause'});
  assert.ok(c.obligations.some(item=>item.environment==='device'));
  assert.ok(c.obligations.some(item=>item.requirement==='Shared: no data loss'));
  assert.equal(c.obligations.some(item=>item.requirement.includes('other clause')),false);
});
test('mandatory test declarations in associated ACs and cases use the same frozen selection gate',()=>{
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement AC-001',
    requirementsText:'- [ ] [AC-001] correct\n  - 必跑测试: `tests/a.test.js`',
    testCases:[{id:'TC-001',blocking:true,kind:'logic',title:'specific coverage',acIds:['AC-001'],
      steps:['必跑测试: `tests/b.test.js`'],expected:['passes']}]});
  assert.deepEqual(c.requiredTests,['tests/a.test.js','tests/b.test.js']);
});
test('explicit approved commands cannot be replaced by a smaller successful check',()=>{
  const c=contract('  - 执行 `node --test a.test.mjs b.test.mjs`\n');
  assert.deepEqual(c.requiredCommands,[['node','--test','a.test.mjs','b.test.mjs']]);
  assert.equal(acceptanceCoverage(c,[{command:[process.execPath,'--test','a.test.mjs'],outcome:'passed'}]).satisfied,false);
  assert.equal(acceptanceCoverage(c,[{command:[process.execPath,'--test','a.test.mjs','b.test.mjs'],outcome:'passed'}]).satisfied,true);
  assert.equal(acceptanceCoverage(c,[{command:['/project/node','--test','a.test.mjs','b.test.mjs'],outcome:'passed'}]).satisfied,false);
  assert.equal(acceptanceCoverage(c,[{command:['node','--test','a.test.mjs','b.test.mjs'],outcome:'passed'}]).satisfied,false);
});
test('a referenced optional case still supplies its approved expected behavior',()=>{
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: run TC-001',requirementsText:'',
    testCases:[{id:'TC-001',title:'save',blocking:false,kind:'logic',expected:['saved content readable']}]});
  assert.ok(c.obligations.some(item=>item.requirement==='expected: saved content readable'));
});
test('parameterless scripts are frozen, but prohibited or conditional command contexts require mapping',()=>{
  assert.deepEqual(contract('  - 执行 `./scripts/test.sh`\n').requiredCommands,[['./scripts/test.sh']]);
  assert.deepEqual(contract('  - 必跑检查：\n    - ./scripts/test.sh\n').requiredCommands,[['./scripts/test.sh']]);
  const c=contract('  - 禁止运行 `npm test`；只运行 `node --test focused.test.mjs`\n');
  assert.ok(c.unresolved.length);assert.deepEqual(c.requiredCommands,[]);
});
test('indirect same-task case references preserve the referenced expected clauses',()=>{
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: run TC-001',requirementsText:'',
    testCases:[{id:'TC-002',title:'read',blocking:false,kind:'logic',expected:['read exact saved bytes']},
      {id:'TC-001',title:'save',blocking:true,kind:'logic',steps:['then TC-002'],expected:['save succeeded']}]});
  assert.ok(c.obligations.some(item=>item.requirement==='expected: read exact saved bytes'));
});
test('blocking cases of every origin freeze steps, expected results, environment and stable IDs',()=>{
  const cases=[{id:'TC-001',blocking:true,origin:'generated',kind:'browser',title:'submit',acIds:['AC-001'],
    preconditions:['signed out'],steps:['submit'],expected:['rejected'],cleanup:[]}];
  const c=buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement',requirementsText:'- [ ] [AC-001] correct',testCases:cases});
  assert.ok(c.obligations.some(item=>item.requirement==='expected: rejected'&&item.environment==='browser'));
  assert.deepEqual(c,buildAcceptanceContract({taskId:'T-001',taskText:'- [ ] T-001: implement',requirementsText:'- [ ] [AC-001] correct',testCases:cases}));
});
test('completion evidence binds exact contract and identity, rejects missing or duplicated receipts',()=>{
  const c=contract(),evidence=[encodeAcceptanceEvidence({contract:c,identity,items:report(c),facts,coverage:{satisfied:true}})];
  assert.equal(verifyAcceptanceEvidence({contract:c,identity,evidence}),true);
  for(const changed of [[],[...evidence,...evidence]])assert.throws(()=>verifyAcceptanceEvidence({contract:c,identity,evidence:changed}));
  assert.throws(()=>verifyAcceptanceEvidence({contract:contract('  - extra\n'),identity,evidence}));
  assert.throws(()=>verifyAcceptanceEvidence({contract:c,identity:{...identity,attempt:2},evidence}));
});

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-acceptance-run-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.demo';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  const file=name=>path.join(specsDir,feature,name);
  fs.writeFileSync(file('requirements.md'),'- [ ] [AC-001] export 2\n');fs.writeFileSync(file('design.md'),'simple\n');
  fs.writeFileSync(file('tasks.md'),'- [ ] T-001: 必验: implement AC-001\n  - preserve existing export name\n- [ ] T-002: next task\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {codeProject,specsDir,feature,file,definition:{version:1,codeProject,specsDir,feature,identity,scope:['a.mjs'],requirements:['requirements.md']}};
}
function execution(f,mode='valid'){
  const e={configuration:{kind:'synthetic-host-v1'},timeoutMs:4000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'export const a=2;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    check:createHostCheck({cwd:f.codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]}),
    verificationGate:async request=>({satisfied:true,items:mode==='missing'?report(request.acceptanceContract).slice(0,1):report(request.acceptanceContract)}),
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-one','review-two'],run:(request,{onEvent})=>{
        onEvent({event:'thread.started',provider_thread:'independent-fixture'});onEvent({event:'turn.started',item_type:null});
        onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});
        onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic independent fixture review'}};
      }}],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control']}};
  if(mode==='disabled')delete e.verificationGate;
  return e;
}
const ask=(opened,operation)=>opened.host.handle({version:1,operation,requestId:operation,identity});
for(const mode of ['missing','disabled'])test(`real owner refuses ${mode} verification despite successful checks`,async t=>{
  const f=fixture(t),opened=await openControlRun(f.definition,'create',execution(f,mode));
  try{const result=await ask(opened,'start');assert.equal(result.code,'verification_precheck_failed',JSON.stringify(result));
    assert.match(result.reason,/^verification_precheck_failed: /);
    assert.match(result.reason,mode==='missing'?/missing acceptance obligation/:/verificationGate/);
    assert.match(fs.readFileSync(f.file('tasks.md'),'utf8'),/\[ \] T-001/);
  }finally{opened.close();}
});
test('original-run retry, independent review and native completion preserve frozen evidence across restart',async t=>{
  const f=fixture(t);let opened=await openControlRun(f.definition,'create',execution(f,'missing'));
  try{assert.equal((await ask(opened,'start')).code,'verification_precheck_failed');}finally{opened.close();}
  opened=await openControlRun(f.definition,'resume',execution(f));
  try{const result=await ask(opened,'start');assert.equal(result.state,'awaiting_review',JSON.stringify(result));}finally{opened.close();}
  opened=await openControlRun(f.definition,'resume',execution(f),{decision:{status:'approved'}});
  try{const result=await ask(opened,'advance');assert.equal(result.state,'fixture_completed',JSON.stringify(result));
    assert.match(fs.readFileSync(f.file('tasks.md'),'utf8'),/\[x\] T-001/);
  }finally{opened.close();}
});
test('verification details survive original owner restart and status consumes no records or calls',async t=>{
  const f=fixture(t);let opened=await openControlRun(f.definition,'create',execution(f,'missing')),failure;
  try{failure=await ask(opened,'start');assert.match(failure.reason,/AC-001.*missing acceptance obligation/);
    assert.match(failure.reason,/preserve existing export name/);}
  finally{opened.close();}
  opened=await openControlRun(f.definition,'resume',execution(f));
  try{
    const state=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
    const before=fs.readFileSync(state),mtime=fs.statSync(state).mtimeMs;
    const status=await ask(opened,'status');
    assert.equal(status.code,'verification_precheck_failed');assert.equal(status.reason,failure.reason);
    assert.deepEqual(fs.readFileSync(state),before);assert.equal(fs.statSync(state).mtimeMs,mtime);
    assert.match(fs.readFileSync(f.file('tasks.md'),'utf8'),/\[ \] T-001/);
  }finally{opened.close();}
});
test('legacy frozen material keeps verifying without retroactive contract or invented protection',t=>{
  const f=fixture(t),selection={specsRoot:f.specsDir,feature:f.feature,taskId:identity.taskId};
  const old=captureSpecificationMaterial({...selection,acceptance:false});assert.equal(Object.hasOwn(old,'acceptanceContract'),false);
  assert.deepEqual(verifySpecificationMaterial({specification:old,specificationRoot:f.specsDir,identity}),old);
});
