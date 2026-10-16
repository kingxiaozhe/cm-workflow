import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createFixCausePackage} from '../runtime/js/cm-fix/cause-package.mjs';
import {validateReviewDispatchGrant} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-assembly-home-'));
const previousHome=process.env.CM_WORKFLOW_HOME;
process.env.CM_WORKFLOW_HOME=isolatedHome;
after(()=>{if(previousHome===undefined)delete process.env.CM_WORKFLOW_HOME;else process.env.CM_WORKFLOW_HOME=previousHome;
  fs.rmSync(isolatedHome,{recursive:true,force:true});});

for(const runtime of ['codex','claude'])test(`${runtime} fix assembly keeps child review permissions separate and lazy`,async()=>{
  const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-assembly-')));
  try{
    let workers=0;
    const model='synthetic',review={model,disabledSkills:[],preflight:runtime==='codex'
      ?{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model,disabledSkills:[],promptTransport:'stdin'})}
      :{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd:codeProject,model})}};
    const base={codeProject,hostContextId:'child-host',runtime,review,workerFactory:()=>{workers++;throw Error('No provider dispatch in this fixture');}};
    const binding={identity:{repositoryId:'fixture',runId:'child-run',taskId:'T-FIX-qa',attempt:1},packageDigest:'a'.repeat(64)};
    for(const allowed of ['--allow-cause-review','--allow-final-review']){
      const permissions=[allowed],host=createFixReviewHost({...base,permissions});
      permissions.push(allowed==='--allow-cause-review'?'--allow-final-review':'--allow-cause-review');
      const signal=new AbortController().signal;
      assert.equal((await host.authority.hostDecisionProvider.decide(binding,signal)).status,
        allowed==='--allow-cause-review'?'approved':'denied');
      assert.equal((await host.finalAuthority.hostDecisionProvider.decide(binding,signal)).status,
        allowed==='--allow-final-review'?'approved':'denied');
      assert.equal(host.reviewer.provider,runtime);host.execution.assertReviewReady();
    }
    assert.throws(()=>createFixReviewHost({...base,review:null,permissions:['--allow-repair']}),{code:'review_configuration_required'});
    assert.throws(()=>createFixReviewHost({...base,review:{...review,preflight:{...review.preflight,passed:false}},
      permissions:['--allow-final-review']}),{code:'tool_preflight_missing'});
    assert.equal(workers,0);
  }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
});


function reviewConfig(codeProject,provider,{model='synthetic',effort}={}){
  const options={cwd:codeProject,model,disabledSkills:[],promptTransport:'stdin',...(effort===undefined?{}:{effort})};
  return {model,disabledSkills:[],...(effort===undefined?{}:{effort}),preflight:provider==='codex'
    ?{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint(options)}
    :{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(options)}};
}
function writeRoles(codeProject,runtime,reviewRuntime){
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'},
    roles:{coder:{adapter:`${runtime}-cli`},reviewer:{adapter:`${reviewRuntime}-cli`}},runtimes:{available:'both'}}));
}
function causeRequest(codeProject,provider){
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'cross-assembly',taskId:'T-FIX-cross',attempt:1};
  const pkg=createFixCausePackage({codeProject,defect:'Fixture value mismatch',status:{identity,stage:'cause_review_required',learning:null,
    reproduction:{status:'reproduced',next:'diagnose',observation:{id:'reproduce',command:['fixture'],outcome:'failed',exitCode:1,evidence:'fixture failure',signatureMatched:true}},
    diagnosis:{status:'diagnosed',rootCause:'Cross-layer constant',plan:'Correct source after red test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true}}});
  const body={version:1,invocationId:'cross-cause-call',identity,role:'reviewer',provider,requestedModel:'synthetic',contextId:'fresh-review',payload:{reviewPackage:pkg,priorReview:null}};
  return {...body,requestDigest:digest(body)};
}

for(const [runtime,reviewRuntime] of [['codex','claude'],['claude','codex']]){
  test(`${runtime}/${reviewRuntime} fix assembly binds reviewer diagnostics, adapters and immutable worker options`,async()=>{
    const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-assembly-')));
    try{
      writeRoles(codeProject,runtime,reviewRuntime);
      const review=reviewConfig(codeProject,reviewRuntime),captured=[];
      let dispatches=0;
      const base={codeProject,hostContextId:'author-host',runtime,reviewRuntime,review,permissions:['--allow-cause-review','--allow-final-review'],
        workerFactory:options=>{captured.push(options);return async()=>{dispatches++;return {status:'failed',code:'reviewer_auth_failed'};};}};
      const host=createFixReviewHost(base),request=causeRequest(codeProject,reviewRuntime);
      assert.equal(host.reviewer.provider,reviewRuntime);
      assert.equal(host.reviewer.adapterId,`${reviewRuntime}-cause-review-adapter`);
      assert.equal(host.reviewer.requestedModel,review.model);
      assert.equal(host.reviewer.workerConfigurationDigest,digest({cwd:codeProject,model:review.model,disabledSkills:[],promptTransport:'stdin',...(reviewRuntime==='claude'?{runtime:reviewRuntime}:{})}));
      assert.equal(captured.length,0,'construction is not provider dispatch');
      // Caller mutation cannot change a prepared review's provider/model/receipt.
      review.model='caller-mutated';review.preflight.passed=false;
      const control={signal:new AbortController().signal,onEvent:()=>true};
      assert.deepEqual(await host.execution.causeReview.run(request,control),{status:'failed',code:'reviewer_auth_failed'});
      assert.equal(dispatches,1,'provider failure is preserved, never an approved review');
      assert.equal(captured[0].model,'synthetic');assert.equal(captured[0].preflight.passed,true);
      assert.equal(captured[0].cwd,codeProject);assert.equal(captured[0].promptTransport,'stdin');
      const wrongBody={...request,provider:runtime};delete wrongBody.requestDigest;
      const wrongRequest={...wrongBody,requestDigest:digest(wrongBody)};
      for(const phase of ['causeReview','finalReview'])assert.throws(()=>host.execution[phase].run(wrongRequest,control),{code:'review_request_invalid'});
      assert.equal(dispatches,1,'wrong provider cannot reach the native worker');
      assert.throws(()=>createFixReviewHost({...base,review:reviewConfig(codeProject,runtime)}),{code:'tool_preflight_missing'});
      assert.throws(()=>createFixReviewHost({...base,review:null}),{code:'review_configuration_required'});
      for(const mutate of [r=>{r.preflight.passed=false;},r=>{r.model='different-model';},r=>{r.preflight.prompt_transport='argument';},r=>{r.preflight.config_fingerprint='0'.repeat(64); }]){
        const bad=reviewConfig(codeProject,reviewRuntime);mutate(bad);
        assert.throws(()=>createFixReviewHost({...base,review:bad}),{code:'tool_preflight_missing'});
      }
      const elsewhere=fs.mkdtempSync(path.join(codeProject,'different-root-'));
      assert.throws(()=>createFixReviewHost({...base,review:reviewConfig(elsewhere,reviewRuntime)}),{code:'tool_preflight_missing'});
    }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
  });

  test(`${runtime}/${reviewRuntime} fix assembly rejects live role drift before readiness and both dispatch phases`,()=>{
    const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-drift-')));
    try{
      writeRoles(codeProject,runtime,reviewRuntime);let workers=0;
      const base={codeProject,hostContextId:'author-host',runtime,reviewRuntime,review:reviewConfig(codeProject,reviewRuntime),permissions:[],
        workerFactory:()=>{workers++;throw Error('must not create worker after role drift');}};
      assert.throws(()=>createFixReviewHost({...base,reviewRuntime:null}),{code:'invalid_runtime'});
      const host=createFixReviewHost(base);host.execution.assertReviewReady();
      writeRoles(codeProject,reviewRuntime,runtime);
      assert.throws(()=>createFixReviewHost(base),{code:'fix_review_runtime_mismatch'});
      assert.throws(()=>host.execution.assertReviewReady(),{code:'fix_review_runtime_mismatch'});
      for(const phase of ['causeReview','finalReview'])assert.throws(()=>host.execution[phase].run({},{}),{code:'fix_review_runtime_mismatch'});
      assert.equal(workers,0);
      fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),'invalid json');
      assert.throws(()=>createFixReviewHost(base),{code:'invalid_workflow_config'});
      writeRoles(codeProject,reviewRuntime,runtime);
      // A run without the new field retains the prior same-tool contract even
      // when the project's current role declarations describe another route.
      const legacy=createFixReviewHost({...base,reviewRuntime:undefined,review:reviewConfig(codeProject,runtime)});
      assert.equal(legacy.reviewer.provider,runtime);legacy.execution.assertReviewReady();
      assert.equal(workers,0);
    }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
  });

  test(`${runtime}/${reviewRuntime} fix assembly selects only reviewer external model and effort`,()=>{
    const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-model-')));
    try{
      writeRoles(codeProject,runtime,reviewRuntime);
      const externalModels={schemaVersion:1,providers:{codex:{model:'codex-model',effort:'high'},claude:{model:'claude-model',effort:'max'}}};
      const pair=externalModels.providers[reviewRuntime],review=reviewConfig(codeProject,reviewRuntime,pair);
      const base={codeProject,hostContextId:'author-host',runtime,reviewRuntime,review,externalModels};
      const host=createFixReviewHost(base);
      assert.equal(host.reviewer.requestedModel,pair.model);
      assert.equal(host.reviewer.workerConfigurationDigest,digest({cwd:codeProject,model:pair.model,effort:pair.effort,disabledSkills:[],promptTransport:'stdin',...(reviewRuntime==='claude'?{runtime:reviewRuntime}:{})}));
      assert.throws(()=>createFixReviewHost({...base,review:{...review,model:externalModels.providers[runtime].model}}),{code:'external_model_pair_conflict'});
      assert.throws(()=>createFixReviewHost({...base,review:{...review,effort:'low'}}),{code:'external_model_pair_conflict'});
      assert.throws(()=>createFixReviewHost({...base,externalModels:{schemaVersion:1,providers:{[runtime]:externalModels.providers[runtime]}}}),{code:'external_model_setup_required'});
      const stale=reviewConfig(codeProject,reviewRuntime,{...pair,effort:'low'});stale.effort=pair.effort;
      assert.throws(()=>createFixReviewHost({...base,review:stale}),{code:'tool_preflight_missing'});
    }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
  });

  test(`${runtime}/${reviewRuntime} cause and final grants bind reviewer while expired or reused grants stay rejected`,async()=>{
    const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-grant-')));
    try{
      writeRoles(codeProject,runtime,reviewRuntime);
      const host=createFixReviewHost({codeProject,hostContextId:'author-host',runtime,reviewRuntime,review:reviewConfig(codeProject,reviewRuntime),permissions:['--allow-cause-review','--allow-final-review']});
      const request=causeRequest(codeProject,reviewRuntime),packageDigest=request.payload.reviewPackage.packageDigest;
      for(const [authority,reviewerId,adapterId] of [[host.authority,'fix-cause-reviewer',`${reviewRuntime}-cause-review-adapter`],[host.finalAuthority,'fix-final-reviewer',`${reviewRuntime}-review-adapter`]]){
        const signal=new AbortController().signal;
        await authority.hostDecisionProvider.decide({identity:request.identity,packageDigest},signal);
        const authorizationAt=Date.now(),grant=authority.authorize(request,{authorizationAt});
        const expected={request,reviewerId,adapterId,packageDigest,hostContextIds:['author-host'],authorizationAt,registeredAt:authorizationAt};
        assert.deepEqual(validateReviewDispatchGrant(grant,expected),grant);
        assert.equal(grant.hostContextId,'author-host');assert.equal(grant.adapterId,adapterId);
        assert.throws(()=>validateReviewDispatchGrant(grant,{...expected,registeredAt:grant.expiresAt}),{code:'runner_grant'});
        assert.throws(()=>validateReviewDispatchGrant(grant,{...expected,adapterId:`${runtime}-review-adapter`}),{code:'runner_grant'});
        assert.throws(()=>validateReviewDispatchGrant(grant,{...expected,packageDigest:'0'.repeat(64)}),{code:'runner_grant'});
        assert.deepEqual(authority.authorize(request,{authorizationAt}),{status:'denied',code:'permission_denied'});
        await authority.hostDecisionProvider.decide({identity:request.identity,packageDigest},signal);
        assert.deepEqual(authority.authorize(request,{authorizationAt:Date.now()+60000}),{status:'denied',code:'permission_denied'});
      }
    }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
  });
}

for(const [runtime,reviewRuntime] of [['codex','claude'],['claude','codex']]){
  test(`${runtime}/${reviewRuntime} owner rejects route drift before cause registration without consuming review history`,async()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-owner-drift-')));
    const codeProject=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(codeProject);fs.mkdirSync(specsRoot);
    let owner,workers=0;
    try{
      writeRoles(codeProject,runtime,reviewRuntime);fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
      const host=createFixReviewHost({codeProject,hostContextId:'author-host',runtime,reviewRuntime,review:reviewConfig(codeProject,reviewRuntime),permissions:['--allow-cause-review'],
        workerFactory:()=>{workers++;throw Error('must not dispatch after route drift');}});
      const identity={repositoryId:'fixture',runId:'cross-owner',taskId:'T-FIX-cross',attempt:1};
      owner=openFixExecution({specsRoot,identity,create:true,configuration:{hostContextId:'author-host',defect:'Wrong value',
        ...(runtime==='claude'?{runtime}:{}),reviewRuntime,causeReview:host.reviewer,
        reproduction:{cwd:codeProject,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}}},
      {...host.execution,bridge:{async call(){return {status:'diagnosed',rootCause:'Cross-layer value',plan:'Set value to 2',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};}}});
      await owner.advance({authorized:true});assert.equal(owner.status().stage,'cause_review_required');
      const pkg=owner.causeReviewPackage();await host.authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
      const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'),before=fs.readFileSync(statePath);
      writeRoles(codeProject,reviewRuntime,runtime);
      await assert.rejects(owner.reviewCause(),{code:'fix_review_runtime_mismatch'});
      assert.equal(owner.status().stage,'cause_review_required');assert.equal(workers,0);
      assert.deepEqual(fs.readFileSync(statePath),before,'local rejection must not consume a review slot or append a grant');
    }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
  });

  test(`${runtime}/${reviewRuntime} default worker launches the selected CLI protocol fixture`,async()=>{
    const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cross-native-'))),previousPath=process.env.PATH;
    try{
      writeRoles(codeProject,runtime,reviewRuntime);
      const bin=path.join(codeProject,'bin');fs.mkdirSync(bin);
      for(const provider of ['codex','claude']){
        const fixture=new URL(`./fixtures/${provider}-review-process.mjs`,import.meta.url);
        const original=fs.readFileSync(fixture,'utf8'),end=original.indexOf('\n');
        const marker=path.join(codeProject,`${provider}.called`);
        fs.writeFileSync(path.join(bin,provider),original.slice(0,end+1)+
          `import {writeFileSync as markCalled} from 'node:fs';markCalled(${JSON.stringify(marker)},'called');\n`+original.slice(end+1),{mode:0o700});
      }
      process.env.PATH=bin+path.delimiter+previousPath;
      const host=createFixReviewHost({codeProject,hostContextId:'author-host',runtime,reviewRuntime,review:{...reviewConfig(codeProject,reviewRuntime),timeoutMs:5000},permissions:['--allow-cause-review']});
      const result=await host.execution.causeReview.run(causeRequest(codeProject,reviewRuntime),{signal:new AbortController().signal,onEvent:()=>true});
      assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.value.verdict,'approved');
      assert.equal(fs.existsSync(path.join(codeProject,`${reviewRuntime}.called`)),true);
      assert.equal(fs.existsSync(path.join(codeProject,`${runtime}.called`)),false);
    }finally{if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;fs.rmSync(codeProject,{recursive:true,force:true});}
  });
}

test('isolated verification changes only reviewer fingerprint and refuses legacy diagnostics or Codex reviewer',{skip:process.platform!=='darwin'},()=>{
 const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-tools-')));
 try{
  writeRoles(codeProject,'codex','claude');
  const verification={files:['value.mjs'],checks:[{id:'unit',command:['node','--test']}],mutationPaths:['value.mjs'],timeoutMs:1000};
  const review=reviewConfig(codeProject,'claude');
  const args={codeProject,hostContextId:'author-host',runtime:'codex',reviewRuntime:'claude',review,permissions:['--allow-cause-review'],verification};
  assert.throws(()=>createFixReviewHost(args),{code:'tool_preflight_missing'});
  review.preflight.config_fingerprint=claudeReviewFingerprint({cwd:codeProject,model:review.model,verification});
  const host=createFixReviewHost(args);assert.equal(host.reviewer.provider,'claude');host.execution.assertReviewReady();
  assert.notEqual(host.reviewer.workerConfigurationDigest,createFixReviewHost({...args,verification:null,review:reviewConfig(codeProject,'claude')}).reviewer.workerConfigurationDigest);
  assert.throws(()=>createFixReviewHost({...args,reviewRuntime:'codex'}),{code:'review_verification_provider'});
  assert.throws(()=>createFixReviewHost({...args,verification:{...verification,timeoutMs:2000}}),{code:'tool_preflight_missing'});
 }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
});
