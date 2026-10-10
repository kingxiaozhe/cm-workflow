import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readRunDefinition,openControlRun} from './cm-ai-run.mjs';
import {cli,identity,request,fixture,runCli,installDispatchFakes,protectedResultFixture,implementedValue,lastCheckpoint,installTimeoutReviewer} from './cm-ai-host-fixture.mjs';

for(const [available,coder,reviewer,runtime] of [
  ['codex','codex','codex','codex'],['codex','codex','codex','claude'],['claude','claude','claude','codex'],
  ['both','codex','claude','claude'],['both','claude','codex','codex'],
])test(`protected dispatch ${available}: ${runtime} host -> ${coder} coder -> ${reviewer} reviewer`,async()=>{
  const f=fixture();
  try{
    installDispatchFakes(f);
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available},
      roles:{coder:{adapter:`${coder}-cli`},reviewer:{adapter:`${reviewer}-cli`}}}));
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',reviewer],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const reviewFile=path.join(f.root,'review.json'),protectedFile=path.join(f.root,'protected.json');
    fs.writeFileSync(reviewFile,preview.stdout);
    fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,
      checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
    f.args.push('--runtime',runtime,'--review-config',reviewFile,'--protected-config',protectedFile);
    const denied=await runCli(f,'normal');assert.equal(denied.code,1);assert.match(denied.stderr,/provider_development_authorization_required/);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    f.args.push('--allow-provider-development-attempt','1');
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'decision_required');assert.deepEqual(first.calls,[]);
    assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
    const readRoutes=()=>fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.phase==='route'&&row.event==='decision');
    assert.equal(readRoutes().filter(row=>row.role==='coder'&&row.route_state===(coder===runtime?'current-runtime':'cli-dispatch')).length,1);
    assert.equal(readRoutes().filter(row=>row.role==='reviewer').length,0);
    f.args.push('--allow-review-attempt','2');
    const wrong=await runCli(f,'normal','resume');assert.equal(wrong.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    assert.equal(readRoutes().filter(row=>row.role==='reviewer').length,0);
    f.args[f.args.length-1]='1';
    const reviewed=await runCli(f,'normal','resume');assert.equal(reviewed.code,0,reviewed.stderr);
    assert.equal(reviewed.rows.find(row=>row.requestId==='advance').result.state,'fixture_completed',JSON.stringify(reviewed.rows));
    const route=readRoutes().find(row=>row.role==='reviewer');assert(route);
    assert.equal(route.adapter,`${reviewer}-cli`);assert.equal(route.route_state,reviewer===runtime?'current-runtime':'cli-dispatch');
    const receipt=fs.readFileSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md'),'utf8');
    assert.match(receipt,new RegExp(`reviewer: ${reviewer}-cli`));assert.match(receipt,/independent: true/);
    const gate=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-task-gate.mjs',import.meta.url)),'check-n4',
      '--handoff',path.join(f.specsDir,'.reviews','work-T-001-a1-handoff.json'),
      '--reviews-dir',path.join(f.specsDir,'.reviews'),'--feature','work','--task','T-001','--project-root',f.codeProject],{encoding:'utf8'});
    assert.equal(gate.status,0,gate.stderr);assert.equal(JSON.parse(gate.stdout).content_bound,true);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const available of ['unknown','codex'])test(`legacy protected ${available} run resumes with its original fingerprint and contexts`,async()=>{
  const f=fixture();
  try{
    installDispatchFakes(f);
    const projectConfig=path.join(f.codeProject,'.cm-workflow.json');
    const declaration={version:1,...(available==='codex'?{runtimes:{available}}:{})};
    fs.writeFileSync(projectConfig,JSON.stringify(declaration));
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture'],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const reviewFile=path.join(f.root,'review.json'),protectedFile=path.join(f.root,'protected.json');
    fs.writeFileSync(reviewFile,preview.stdout);
    fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,
      checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
    // The original unmodified createCodexExecution constructs a genuine old run;
    // no hand-written fingerprints, journals or approval receipts.
    const initializer=path.join(f.root,'old-host.mjs');
    fs.writeFileSync(initializer,`
import fs from 'node:fs';
import {readRunDefinition,createCodexExecution,openControlRun} from ${JSON.stringify(new URL('./cm-ai-run.mjs',import.meta.url).href)};
import {createHostReviewAuthority} from ${JSON.stringify(new URL('../runtime/js/cm-ai/host-review-authority.mjs',import.meta.url).href)};
const definition=readRunDefinition(${JSON.stringify(f.config)}),review=JSON.parse(fs.readFileSync(${JSON.stringify(reviewFile)}));
const config=JSON.parse(fs.readFileSync(${JSON.stringify(protectedFile)}));
const authority=createHostReviewAuthority({hostContextId:'native-host-fixture',reviewerId:'reviewer',adapterId:'codex-review-adapter',decide:async()=>null});
const execution=await createCodexExecution({codeProject:definition.codeProject,specsRoot:definition.specsDir,
 developerModel:config.model,checkCommands:config.checkCommands,timeoutMs:config.timeoutMs,
 hostContextId:'native-host-fixture',developerContextId:'cm-protected-author',reviewerModel:review.model,
 reviewerPreflight:review.preflight,disabledSkills:review.disabledSkills},
 {hostDecision:null,developmentAttempt:1,hostDecisionProvider:authority.hostDecisionProvider,authorizeReview:authority.authorize,
 authorizeDevelopment:()=>({status:'approved'})});
const run=await openControlRun(definition,'create',execution);
try{console.log(JSON.stringify(await run.host.handle(${JSON.stringify(request('advance'))})));}finally{run.close();}
`);
    const old=spawnSync(process.execPath,[initializer],{encoding:'utf8',env:f.env,timeout:10000});
    assert.equal(old.status,0,old.stderr);assert.equal(JSON.parse(old.stdout).code,'decision_required');
    f.args.push('--protected-config',protectedFile,'--allow-provider-development-attempt','1','--review-config',reviewFile,'--allow-review-attempt','1');
    // A changed two-provider declaration cannot recover through Codex-only compatibility.
    fs.writeFileSync(projectConfig,JSON.stringify({version:1,runtimes:{available:'both'},
      roles:{coder:{adapter:'claude-cli'},reviewer:{adapter:'codex-cli'}}}));
    const mismatch=await runCli(f,'normal','resume');assert.equal(mismatch.code,1);assert.match(mismatch.stderr,/fingerprint_mismatch/);
    assert(!fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x]'));
    fs.writeFileSync(projectConfig,JSON.stringify(declaration));
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.match(resumed.stderr,/resumed original Codex protected execution after exact fingerprint validation/);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,'fixture_completed');
    assert.deepEqual(resumed.calls,[]);
    assert.match(fs.readFileSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md'),'utf8'),/reviewer: codex-cli/);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


test('protected local invalid_result writes nothing and corrected CLI resume keeps run and attempt',async()=>{
  const f=protectedResultFixture(),target=path.join(f.codeProject,'target.mjs');
  try{
    f.develop=payload=>{
      assert.equal(payload.editMode,'protected-text-v1');assert.equal(payload.expected['target.mjs'],null);
      return {status:'succeeded',value:{...implementedValue(),
        retrospective:{status:'no_new_lesson',candidates:[],reason:'No new lesson'}},
      edits:[{path:'target.mjs',beforeSha256:null,content:'export const value = 42;\n'}]};
    };
    for(const mode of ['create',...Array(6).fill('resume')]){
      const rejected=await runCli(f,'normal',mode);assert.equal(rejected.code,0,rejected.stderr);
      const result=rejected.rows.find(row=>row.requestId==='advance').result;
      assert.equal(result.state,'blocked');assert.equal(result.code,'developer_result_invalid');
      assert.equal(result.pendingAction,'resume');assert.deepEqual(result.identity,identity);
      assert(!fs.existsSync(target));
      const checkpoint=lastCheckpoint(f);assert.equal(checkpoint.calls.at(-1).terminal,'failed');
      assert.deepEqual(checkpoint.calls.at(-1).failureResult,{code:'invalid_result',reason:'invalid_input',retryable:true});
    }
    f.develop=payload=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]});
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    const result=resumed.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,'awaiting_review');assert.equal(result.code,'decision_required');
    assert.deepEqual(result.identity,identity);assert.equal(fs.readFileSync(target,'utf8'),'export const value = 42;\n');
    assert.deepEqual(lastCheckpoint(f).calls.map(call=>call.terminal),[...Array(7).fill('failed'),'succeeded']);
    const reopened=await runCli(f,'normal','resume');assert.equal(reopened.code,0,reopened.stderr);
    assert.deepEqual(reopened.calls,[]);assert.equal(reopened.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const matches of [true,false])test(`protected old proposal compares exact output with expected disk hashes: matches=${matches}`,async()=>{
  const f=protectedResultFixture(),target=path.join(f.codeProject,'target.mjs');
  try{
    // Simulate a proposal already applied before this invocation was rejected.
    const content='export const value = 42;\n';
    f.develop=()=>({status:'succeeded',value:{...implementedValue(),
      retrospective:{status:'no_new_lesson',candidates:[],reason:'invalid'}},edits:[]});
    const failed=await runCli(f,'normal');assert.equal(failed.code,0,failed.stderr);
    assert.equal(failed.rows.find(row=>row.requestId==='advance').result.code,'developer_result_invalid');
    fs.writeFileSync(target,matches?content:'export const value = 99;\n');
    const before=fs.readFileSync(target);
    f.develop=()=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:null,content}]});
    const run=await runCli(f,'normal','resume');assert.equal(run.code,0,run.stderr);
    const result=run.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,matches?'awaiting_review':'blocked');
    assert.equal(result.code,matches?'decision_required':'protected_edit_stale');
    assert.deepEqual(fs.readFileSync(target),before);
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,result.code);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const mode of ['blocked','disconnect'])test(`protected ${mode} cannot use the local invalid-result retry entry`,async()=>{
  const f=protectedResultFixture();
  try{
    f.develop=()=>({status:'succeeded',value:{...implementedValue(),outcome:'blocked'},edits:[]});
    const result=await runCli(f,mode==='disconnect'?'disconnect':'normal');assert.equal(result.code,0,result.stderr);
    const status=result.rows.find(row=>row.requestId==='advance').result;
    assert.equal(status.state,mode==='blocked'?'blocked':'unknown');
    assert.equal(status.code,mode==='blocked'?'failed':'unknown');
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.deepEqual(resumed.calls,[]);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.state,status.state);
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const variant of ['delete-absent','missing-edits','extra-field'])test(`protected malformed proposal ${variant} fails before sandbox writes`,async()=>{
  const f=protectedResultFixture();
  try{
    f.develop=()=>({status:'succeeded',value:implementedValue(),
      ...(variant==='missing-edits'?{}:{edits:[{path:'target.mjs',beforeSha256:null,
        content:variant==='delete-absent'?null:'export const value = 42;\n'}]}),
      ...(variant==='extra-field'?{extra:true}:{})});
    const result=await runCli(f,'normal');assert.equal(result.code,0,result.stderr);
    const status=result.rows.find(row=>row.requestId==='advance').result;
    assert.equal(status.state,'blocked');assert.equal(status.code,'developer_result_invalid');
    assert.equal(lastCheckpoint(f).calls.at(-1).terminal,'failed');
    assert(!fs.existsSync(path.join(f.codeProject,'target.mjs')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


for(const [runtime,second] of [['codex','approved'],['claude','approved'],['codex','timeout'],['codex','result'],['claude','result']])
test(`protected conversation review timeout ${runtime} -> ${second}`,async()=>{
  const f=protectedResultFixture();
  try{
    f.runtime=runtime;f.args.push('--runtime',runtime);
    const setMode=installTimeoutReviewer(f,runtime);
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',runtime],
      {encoding:'utf8',env:f.env,timeout:5000});assert.equal(preview.status,0,preview.stderr);
    const review=JSON.parse(preview.stdout);assert.equal(review.timeoutMs,900000);
    delete review.timeoutMs;
    const config=path.join(f.root,'review.json');fs.writeFileSync(config,JSON.stringify(review));
    f.args.push('--review-config',config,'--allow-review-attempt','1');
    f.develop=payload=>({status:'succeeded',value:implementedValue(),
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]});
    setMode(second==='result'?'result':'timeout');
    const start=Date.now(),first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    const result=first.rows.find(row=>row.requestId==='advance').result;
    // A legacy review config without timeoutMs inherits the protected conversation's 5s reviewer budget.
    assert(Date.now()-start>=4900);assert(Date.now()-start<14000);
    assert.equal(result.state,second==='result'?'unknown':'pending_review');
    assert.equal(result.code,second==='result'?'transport_timeout':'review_transport_timeout');
    // A final message cut off by the timeout is never retried by itself; its
    // only exit is the explicit, audited abandon_review (see cm-ai-review-failure).
    assert.equal(result.pendingAction,second==='result'?'abandon_review':'resume');
    const before=lastCheckpoint(f),original=before.reviewInvocation;
    assert.equal(before.calls.at(-1).terminal,second==='result'?'unknown':'failed');
    assert.equal(original.result.outcome,'timed_out');
    assert.equal(original.result.reconciliationRequired,second==='result');
    assert.equal(original.result.inspection.code,'transport_timeout');
    assert.equal(original.result.observation.events.at(-1).event,'process_closed');
    assert.equal(original.result.observation.events.at(-1).timed_out,true);
    const snapshot=()=>JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json')));
    const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
    const history=snapshot(),configuration=history.records[0].payload.config;
    assert.equal(readRunnerHistory(history.records,configuration,3).state.state,result.state);
    // Prefix recovery never redispatches an invocation whose checkpoint is absent.
    for(const type of ['review-invocation-registered','review-invocation-started','review-invocation-result']){
      const index=history.records.findIndex(row=>row.payload.type===type);
      const recovered=readRunnerHistory(history.records.slice(0,index+1),configuration,3);
      assert.equal(recovered.state.state,'unknown');assert.equal(recovered.state.code,'reconciliation_required');
    }
    setMode(second==='result'?'approved':second);
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    const end=resumed.rows.find(row=>row.requestId==='advance').result,after=lastCheckpoint(f);
    assert.deepEqual(end.identity,identity);assert.deepEqual(resumed.calls,[]);
    if(second==='result'){
      assert.equal(end.state,'unknown');assert.deepEqual(after,before);
    }else{
      assert.equal(end.state,second==='approved'?'fixture_completed':'blocked');
      assert.equal(end.code,second==='approved'?'qa_decision_required':'review_transport_timeout');
      assert.equal(after.cache.find(entry=>entry.effect.id==='review-1-retry-1').effect.identity.attempt,1);
      assert.notEqual(after.reviewInvocation.registration.grant.invocationId,original.registration.grant.invocationId);
      assert.notEqual(after.reviewInvocation.registration.grant.grantId,original.registration.grant.grantId);
      assert.notEqual(after.reviewInvocation.started,original.started);
      assert.deepEqual(after.calls.slice(0,before.calls.length),before.calls);
      assert.deepEqual(after.cache.slice(0,before.cache.length),before.cache);
      if(second==='timeout'){
        const blocked=await runCli(f,'normal','resume');assert.equal(blocked.code,0,blocked.stderr);
        assert.equal(blocked.rows.find(row=>row.requestId==='advance').result.state,'blocked');
        assert.deepEqual(lastCheckpoint(f),after);
      }else assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
