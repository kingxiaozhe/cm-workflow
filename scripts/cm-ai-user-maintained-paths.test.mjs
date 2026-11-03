// AI潮 specs7 (2026-11-03): the user hand-maintains Baseline/glass-verdicts.json
// (project rule: only the user edits it). Their direct commit could never be
// explained by a reviewed delivery, so completed runs stayed at
// correction_review_required. A code project may now declare such files.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {USER_MAINTAINED_FILE,readUserMaintainedPaths} from '../runtime/js/cm-ai/user-maintained-paths.mjs';
import {captureReviewBaseline,compareReviewInventoryToBaseline} from '../runtime/js/cm-ai/review-package.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-user-maintained-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const events=(onEvent,thread)=>{
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
};
const declare=(root,value)=>fs.writeFileSync(path.join(root,USER_MAINTAINED_FILE),
  typeof value==='string'?value:JSON.stringify(value));

// A completed run of one feature whose QA failed; status() reopens it read-only.
async function completedRun(initialDeclaration=null){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'project-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  fs.mkdirSync(path.join(specsDir,'1.value'),{recursive:true});
  for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,'1.value',`${name}.md`),'# Synthetic fixture');
  fs.writeFileSync(path.join(specsDir,'1.value','tasks.md'),'- [ ] T-001: implement\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.value'],specFiles:buildManifest(specsDir)}));
  fs.mkdirSync(path.join(codeProject,'Baseline'));
  fs.writeFileSync(path.join(codeProject,'Baseline','verdicts.json'),'{"approved":[]}');
  fs.writeFileSync(path.join(codeProject,'other.md'),'# Other\n');
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Synthetic requirements.');
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),'process.exit(0)');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  if(initialDeclaration)declare(codeProject,initialDeclaration);
  const execution={configuration:{kind:'synthetic-user-maintained'},timeoutMs:2000,excludedContexts:['parent-host'],
    developer:{provider:'codex',requestedModel:'synthetic',contextId:'author',run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
      fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
      contexts:['review-1','review-2'],run:async(request,{onEvent})=>{
        events(onEvent,`synthetic-review-${request.identity.runId}`);
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['parent-host']},
    check:createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]}),
    qaLogHome:path.join(root,'logs'),qaDecisionProvider:{timeoutMs:1000,decide:async binding=>({decisionId:`qa-${binding.identity.runId}`,
      identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-11-03T01:00:00Z'})},
    qaExecutor:{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
      const report=path.join(specsDir,'.reviews',`${binding.testRunId}.md`);fs.writeFileSync(report,'Synthetic QA FAIL');
      return {result:'FAIL',passed:0,failed:1,blocked:0,report};}},
    applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async binding=>({
      syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,
      status:'completed',reason:'Synthetic documentation unchanged',at:'2026-11-03T02:00:00Z'})}};
  const identity={repositoryId:'fixture',runId:'feature1-T001',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature:'1.value',identity,scope:['value.mjs'],requirements:['requirements.md']};
  let run=await openControlRun(definition,'create',execution),before;
  try{
    assert.equal((await run.host.handle({version:1,requestId:'p',operation:'advance',identity})).code,'qa_failed');
    before=await run.host.handle({version:1,requestId:'b',operation:'status',identity});
  }finally{run.close();}
  const status=async()=>{
    const opened=await openControlRun(definition,'resume',execution);
    try{return await opened.host.handle({version:1,requestId:'s',operation:'status',identity});}finally{opened.close();}
  };
  const same=result=>assert.deepEqual([result.state,result.code,result.pendingAction],[before.state,before.code,before.pendingAction],JSON.stringify(result));
  return {codeProject,status,same};
}
// Replace the declaration right after the reader closed it, before the tree scan.
async function swappedDuring(codeProject,status,replacement){
  const declaration=path.join(codeProject,USER_MAINTAINED_FILE),open=fs.openSync,close=fs.closeSync;
  let watched=null;
  fs.openSync=(file,...rest)=>{const fd=open(file,...rest);
    if(file===declaration&&watched===null&&new Error().stack.includes('user-maintained-paths.mjs'))watched=fd;return fd;};
  fs.closeSync=fd=>{close(fd);if(fd===watched){watched=-1;declare(codeProject,replacement);}};
  try{return await status();}finally{fs.openSync=open;fs.closeSync=close;assert.equal(watched,-1);}
}

test('a declared user-maintained file is tolerated on a completed run; nothing else is',async()=>{
  const {codeProject,status,same}=await completedRun();

  // The user records a verdict by hand: unexplained until it is declared.
  fs.writeFileSync(path.join(codeProject,'Baseline','verdicts.json'),'{"approved":["glass"]}');
  let result=await status();
  assert.equal(result.code,'correction_review_required');assert.equal(result.reason,'未经审查的改动：Baseline/verdicts.json');
  declare(codeProject,{version:1,paths:['Baseline/verdicts.json']});
  same(await status());

  // Only the declared file: another unreviewed edit is still reported alone.
  fs.appendFileSync(path.join(codeProject,'other.md'),'hand edit\n');
  result=await status();
  assert.equal(result.code,'correction_review_required');assert.equal(result.reason,'未经审查的改动：other.md');
  fs.writeFileSync(path.join(codeProject,'other.md'),'# Other\n');same(await status());

  // The run's own delivered file can never be declared away.
  declare(codeProject,{version:1,paths:['Baseline/verdicts.json','value.mjs']});
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');
  result=await status();
  assert.equal(result.code,'correction_review_required');assert.equal(result.reason,'未经审查的改动：value.mjs');
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');

  // A case variant of the run's own file is never declared away either.
  declare(codeProject,{version:1,paths:['Baseline/verdicts.json','VALUE.mjs']});same(await status());
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=3;');
  result=await status();
  assert.equal(result.code,'correction_review_required');assert.equal(result.reason,'未经审查的改动：value.mjs');
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');

  // A declaration replaced after the reader read it and before the tree is compared is refused.
  declare(codeProject,{version:1,paths:['Baseline/verdicts.json']});same(await status());
  result=await swappedDuring(codeProject,status,{version:1,paths:['other.md']});
  assert.equal(result.code,'correction_review_required');assert.match(result.reason,/核对期间声明已变化/);
  declare(codeProject,{version:1,paths:['Baseline/verdicts.json']});same(await status());

  // A malformed declaration tolerates nothing and says why.
  declare(codeProject,{version:1,paths:['../escape']});
  result=await status();
  assert.equal(result.code,'correction_review_required');assert.match(result.reason,/\.cm-user-maintained\.json/);
  fs.rmSync(path.join(codeProject,USER_MAINTAINED_FILE));
  result=await status();
  assert.equal(result.code,'correction_review_required');assert.equal(result.reason,'未经审查的改动：Baseline/verdicts.json');
});

test('a declaration already in the baseline binds to the same scan, unchanged or replaced',async()=>{
  const {codeProject,status,same}=await completedRun({version:1,paths:['Baseline/verdicts.json']});
  fs.writeFileSync(path.join(codeProject,'Baseline','verdicts.json'),'{"approved":["glass"]}');
  same(await status());
  const result=await swappedDuring(codeProject,status,{version:1,paths:['other.md']});
  assert.equal(result.code,'correction_review_required');assert.match(result.reason,/核对期间声明已变化/);
});

test('an inventory probe reports one path from the same scan, present or not',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'probe-')));
  fs.writeFileSync(path.join(root,'kept.md'),'kept');fs.writeFileSync(path.join(root,'req.md'),'req');
  const baseline=captureReviewBaseline({root,identity:{repositoryId:'unit',runId:'probe-run',taskId:'T-001',attempt:1},
    scope:['kept.md'],requirements:['req.md']});
  assert.deepEqual(compareReviewInventoryToBaseline(root,baseline),[]);
  const [kept]=compareReviewInventoryToBaseline(root,baseline,{probe:'kept.md'});
  assert.equal(kept.probe,true);assert.equal(kept.path,'kept.md');assert.match(kept.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(compareReviewInventoryToBaseline(root,baseline,{probe:'missing.md'}),[{path:'missing.md',sha256:null,probe:true}]);
});

test('the declaration is strict: exact relative files, no instructions, config or itself',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'reader-')));
  assert.deepEqual(readUserMaintainedPaths(root),{paths:[],sha256:null});
  declare(root,{version:1,paths:['Baseline/glass-verdicts.json','notes.md']});
  const read=readUserMaintainedPaths(root);
  assert.deepEqual(read.paths,['Baseline/glass-verdicts.json','notes.md']);assert.match(read.sha256,/^[0-9a-f]{64}$/);
  fs.mkdirSync(path.join(root,'folder'));
  for(const value of [
    {version:2,paths:['a.md']},{version:1,paths:[]},{version:1,paths:['a.md'],extra:true},{version:1},
    {version:1,paths:['/abs.md']},{version:1,paths:['a/../b.md']},{version:1,paths:['./a.md']},{version:1,paths:['a//b.md']},
    {version:1,paths:['dir/']},{version:1,paths:['a\\b.md']},{version:1,paths:['a.md','a.md']},{version:1,paths:[7]},
    {version:1,paths:['AGENTS.md']},{version:1,paths:['sub/CLAUDE.md']},{version:1,paths:['.cm-workflow.yml']},
    {version:1,paths:[USER_MAINTAINED_FILE]},{version:1,paths:['.git/config']},
    {version:1,paths:['agents.md']},{version:1,paths:['Sub/Claude.MD']},{version:1,paths:['.CM-Workflow.YML']},
    {version:1,paths:['.CM-USER-MAINTAINED.JSON']},{version:1,paths:['.GIT/config']},{version:1,paths:['.env']},
    {version:1,paths:['a*.md']},{version:1,paths:['a:b.md']},{version:1,paths:['a\nb.md']},
    {version:1,paths:['cafe\u0301.md']},{version:1,paths:['a.md','A.md']},{version:1,paths:['folder']},
    '{"version":1,"version":1,"paths":["a.md"]}','not json',
  ]){
    declare(root,value);
    assert.throws(()=>readUserMaintainedPaths(root),{code:'user_maintained_invalid'},JSON.stringify(value));
  }
  fs.rmSync(path.join(root,USER_MAINTAINED_FILE));
  fs.writeFileSync(path.join(root,'real.json'),JSON.stringify({version:1,paths:['a.md']}));
  fs.symlinkSync('real.json',path.join(root,USER_MAINTAINED_FILE));
  assert.throws(()=>readUserMaintainedPaths(root),{code:'user_maintained_invalid'});
});
