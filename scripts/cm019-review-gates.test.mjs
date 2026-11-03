import test from 'node:test';
import assert from 'node:assert/strict';
import {mandatoryCheckCoverage} from '../runtime/js/check-coverage.mjs';
import {buildAcceptanceContract,acceptanceCoverage,encodeAcceptanceEvidence} from '../runtime/js/cm-ai/acceptance-contract.mjs';
import {checkCompletion} from '../runtime/js/cm-ai/gate-bridge.mjs';
import {reviewReceipt,reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const identity={repositoryId:'gate-regression',runId:'original-run',taskId:'T-001',attempt:1};
function gateInput({evidence='valid',binary=process.execPath,recordedCoverage=null}={}){
  const contract=buildAcceptanceContract({taskId:identity.taskId,taskText:'- [ ] T-001: fixture\n  - 必跑测试: `a.test.mjs`\n  - 运行 `node --test a.test.mjs`',requirementsText:''});
  const checks=[{id:'native',command:[binary,'--test','a.test.mjs'],outcome:'passed',exitCode:0,evidence:'host observed'}];
  const items=contract.obligations.map(o=>({...o,satisfied:true,evidence:'bound evidence'}));
  const coverage=recordedCoverage??acceptanceCoverage(contract,checks);
  const encoded=encodeAcceptanceEvidence({contract,identity,items,facts:null,coverage});
  const data=JSON.parse(encoded.slice(encoded.indexOf(': ')+2));
  if(evidence==='foreign')data.identity={...identity,runId:'foreign'};
  if(evidence==='missing-item')data.items=data.items.slice(1);
  const prefix=encoded.slice(0,encoded.indexOf(': ')+2);
  const handoff={evidence:evidence==='absent'?[]:[prefix+JSON.stringify(data)]};
  const pkgBody={baseIdentity:'b'.repeat(64),artifactDigest:'c'.repeat(64),requirementsDigest:'d'.repeat(64),checksDigest:digest(checks),
    identity,scope:['code.mjs'],changes:[{path:'code.mjs'}],requirements:[{path:'requirements.md'}],checks,
    specification:{acceptanceContract:contract},handoff:{path:'.reviews/handoff.json',contentBase64:Buffer.from(JSON.stringify(handoff)).toString('base64')}};
  const pkg={...pkgBody,packageDigest:digest(pkgBody)};
  const result={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'registered fixture review'};
  const request={identity,requestDigest:'e'.repeat(64)};
  const call={invocationId:'review-original',started:true,terminal:'succeeded',requestDigest:request.requestDigest,resultDigest:digest(result),
    provider:'claude',contextId:'reviewer',requestedModel:'fixture',effectiveModel:'fixture',channel:'fixture'};
  const receipt=reviewReceipt({request,call,result,reviewPackage:pkg,developerProvider:'codex',fallbackReasons:[]});
  return {receipt,registered:receipt,execution:call,reviewPackage:pkg,identity};
}

test('M4: scheme defaults and explicit selectors cannot prove resolved XCTest inventory from argv alone',()=>{
  for(const args of [[],['-configuration','Debug'],['-only-testing:OtherTarget/FooTests'],['-only-testing:OtherTarget']]){
    const result=mandatoryCheckCoverage({requiredTests:['OtherTarget/FooTests'],commands:[['/usr/bin/xcodebuild','test','-scheme','App',...args]]});
    assert.deepEqual(result,{satisfied:false,missing:['OtherTarget/FooTests'],unverifiable:['OtherTarget/FooTests']});
  }
});

test('M5: registered historical completion keeps its recorded selection after the host Node path changes',()=>{
  const input=gateInput(),original=process.execPath;
  try{
    process.execPath='/fixture/new-node-version/bin/node';
    assert.equal(checkCompletion({...input,historical:true}).outcome,'eligible');
    assert.throws(()=>checkCompletion(input),{code:'verification_precheck_failed'},'a new live completion still needs current host checks');
  }finally{process.execPath=original;}
});

test('G1: completion gate rejects validly registered packages with absent foreign or incomplete acceptance evidence',()=>{
  assert.equal(checkCompletion(gateInput()).outcome,'eligible');
  for(const evidence of ['absent','foreign','missing-item'])
    assert.throws(()=>checkCompletion(gateInput({evidence})),{code:'verification_precheck_failed'},evidence);
});

test('M5: actual completed journal and completion summary replay after a Node upgrade without rewriting history',async t=>{
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
  const {buildManifest}=await import('./cm-spec-manifest.mjs');
  const {openControlRun}=await import('./cm-ai-run.mjs');
  const {createCodexDeveloperRun}=await import('../runtime/js/cm-ai/codex-developer-adapter.mjs');
  const {createHostCheck}=await import('../runtime/js/cm-ai/host-check.mjs');
  const {readExecutionSnapshot}=await import('../runtime/js/cm-ai/execution-snapshot.mjs');
  const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const {completionSummary}=await import('../runtime/js/cm-ai/completion-summary.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-node-upgrade-'))),codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.demo';
  const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
  process.env.CM_WORKFLOW_HOME=path.join(root,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'logs');
  t.after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  fs.writeFileSync(path.join(codeProject,'test.mjs'),"import {a} from './a.mjs';import assert from 'node:assert/strict';assert.equal(a,2);\n");
  for(const [name,body] of [['requirements.md','# R\n'],['design.md','# D\n'],['tasks.md','- [ ] T-001: 必验: export 2\n  - 必跑测试: `test.mjs`\n  - 运行 `node --test test.mjs`\n- [ ] T-002: remaining\n']])fs.writeFileSync(path.join(specsDir,feature,name),body);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:4000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=2;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    check:createHostCheck({cwd:codeProject,commands:[{id:'unit',command:[process.execPath,'--test','test.mjs']}]}),
    verificationGate:async request=>({satisfied:true,items:request.acceptanceContract.obligations.map(o=>({...o,satisfied:true,evidence:'Synthetic host observation'}))}),
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,contexts:['review1','review2'],run:(request,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:'independent-fixture'});onEvent({event:'turn.started',item_type:null});
      onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic independent review'}};
    }}],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control']}};
  let opened=await openControlRun(definition,'create',execution);
  try{assert.equal((await opened.host.handle({version:1,operation:'start',requestId:'start',identity})).state,'awaiting_review');}finally{opened.close();}
  opened=await openControlRun(definition,'resume',execution,{decision:{status:'approved'}});let result;
  try{result=await opened.host.handle({version:1,operation:'advance',requestId:'advance',identity});assert.equal(result.state,'fixture_completed',JSON.stringify(result));}finally{opened.close();}
  const file=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json'),before=fs.readFileSync(file),mtime=fs.statSync(file).mtimeMs;
  const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:identity.repositoryId,runId:identity.runId}}),init=snapshot.records[0].payload;
  const original=process.execPath;
  try{process.execPath='/fixture/new-node-version/bin/node';
    assert.equal(readRunnerHistory(snapshot.records,init.config,init.version).state.state,'fixture_completed');
    assert.equal(completionSummary({specsDir,feature,result}).task.status,'completed');
  }finally{process.execPath=original;}
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.statSync(file).mtimeMs,mtime);
});
