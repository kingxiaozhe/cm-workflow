import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {qaFixIdentity} from '../runtime/js/cm-fix/qa-source.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

// Real parent/child stores and grants; synthetic provider results. No native
// Codex sandbox, network, install or user's runtime configuration is needed.
const home=fs.mkdtempSync(path.join(os.tmpdir(),'qa-fix-session-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const A='session-A',B='session-B',C='session-C';
const prepare=async()=>({files:[],contextDigest:digest([]),application:{contextDigest:digest([]),
  status:'no_relevant_lesson',summary:'Synthetic fixture'}});
const diagnosis={status:'diagnosed',rootCause:'Wrong constant across layers',affectedPaths:['value.mjs'],
  affectedModules:['value'],plan:'Set value to 2 after review',crossLayer:true};
function events(onEvent,thread){
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
}
async function fixture(t,{childHost=A,causeContext=null}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qa-fix-session-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.value';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=0;');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Value must be 2.');
  fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Fixture');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement value\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const identity={repositoryId:'fixture',runId:'qa-parent',taskId:'T-001',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['value.mjs'],requirements:['requirements.md']};
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',disabledSkills:[],promptTransport:'stdin'})}};
  const workflow={documentationPaths:[],applicableAgentFiles:[],qa:{commands:[{id:'value',command:[process.execPath,'red.mjs'],caseIds:[]}],
    environment:{kind:'web',carrier:'browser',target:'synthetic-local',scope:'local'}}};
  const bridge={async call(kind){
    assert.equal(kind,'develop');fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
    return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
  }};
  const executionFor=live=>{
    const execution=createConversationExecution(definition,live,bridge,review,1,workflow,true,'codex',
      live===A?{}:{originalHostContextId:A});
    execution.check=createHostCheck({cwd:codeProject,commands:[{id:'existing',command:[process.execPath,'existing.mjs']}]});
    execution.reviewers[0].run=async(request,{onEvent})=>{
      events(onEvent,'synthetic-parent-review');
      return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};
    };
    execution.qaDecisionProvider={...execution.qaDecisionProvider,decide:async binding=>({decisionId:'qa-parent',identity:binding.identity,
      packageDigest:binding.packageDigest,status:'triggered',reason:'feature_complete',score:null,at:'2026-09-08T01:00:00Z'})};
    execution.qaExecutor={...execution.qaExecutor,run:async()=>{
      const report=path.join(specsDir,'.reviews','qa-failure.md');fs.writeFileSync(report,'Synthetic QA FAIL: value must be 2.');
      return {result:'FAIL',passed:0,failed:1,blocked:0,report};
    }};
    return execution;
  };
  let parent=null,owner=null;
  t.after(()=>{owner?.close();parent?.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=operation=>({version:1,requestId:operation,operation,identity});
  parent=await openControlRun(definition,'create',executionFor(A));
  const failed=await parent.host.handle(request('advance'));
  assert.equal(failed.code,'qa_failed',JSON.stringify(failed));parent.close();parent=null;
  const qaSource={feature,identity,packageDigest:failed.packageDigest,testRunId:failed.fixHandoff.source.testRunId,
    handoffDigest:failed.fixHandoff.handoffDigest};
  const permissions=['--allow-cause-review'];
  const reviewHost=live=>createFixReviewHost({codeProject,hostContextId:live,review,permissions,workerFactory:()=>async({prompt},{onEvent})=>{
    const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);events(onEvent,'synthetic-child-review');
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
      examinedPaths:['value.mjs'],findings:[],summary:'Synthetic cause review'}};
  }});
  const configuration={hostContextId:childHost,defect:'Value must be 2',qaSource,
    causeReview:{...reviewHost(A).reviewer,...(causeContext?{contextId:causeContext}:{})},
    reproduction:{cwd:codeProject,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000}};
  const fix={specsRoot:specsDir,identity:qaFixIdentity(qaSource),configuration};
  const childDir=path.join(specsDir,'.reviews','.execution',fix.identity.runId),statePath=path.join(childDir,'state.json');
  const bound=operation=>({...request(operation),packageDigest:failed.packageDigest,testRunId:qaSource.testRunId});
  const close=()=>{owner?.close();owner=null;};
  const open=async(live,{allowStart=true,template=false,allowAbandon=false,lostDiagnosis=false}={})=>{
    close();const execution=executionFor(live);assert.equal(execution.configuration.hostContextId,A);
    parent=await openControlRun(definition,'resume',execution);
    const rh=reviewHost(live);
    const {qaSource:ignored,...templateConfiguration}=configuration;
    owner=createQaFixOwnerHost({parent,hostContextId:live,parentHostContextId:execution.configuration.hostContextId,
      reopenParent:()=>openControlRun(definition,'resume',execution),allowStart,
      ...(template?{template:{specsRoot:specsDir,feature,identity,configuration:templateConfiguration}}:{fix}),
      fixPermissions:allowAbandon?[...permissions,'--allow-abandon']:permissions,
      fixAuthorities:{authority:rh.authority,finalAuthority:rh.finalAuthority},
      fixExecution:{...rh.execution,prepare,bridge:{async call(kind){assert.equal(kind,'fix_diagnose');
        if(lostDiagnosis)throw Error('Synthetic lost diagnosis');return diagnosis;}}}});
    parent=null;return owner;
  };
  const records=()=>JSON.parse(fs.readFileSync(statePath)).records;
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const fake=path.join(bin,'codex');fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);fs.chmodSync(fake,0o700);
  for(const [name,value] of Object.entries({run:definition,review,workflow,fix}))fs.writeFileSync(path.join(root,`${name}.json`),JSON.stringify(value));
  return {open,close,bound,fix,childDir,statePath,records,reviewHost,root,bin,request};
}

// Exercise the actual CLI assembly as well as the direct owner. The CLI only
// resumes/status/reviews here: these operations do not require a native sandbox.
async function cli(f,live,operation,{runtime='codex',flags=[]}={}){
  f.close();fs.writeFileSync(path.join(f.root,'fix.json'),JSON.stringify(f.fix));
  const args=['serve','--config',path.join(f.root,'run.json'),'--mode','resume','--host-context',live,'--allow-development',
    '--original-host-context',A,'--review-config',path.join(f.root,'review.json'),'--workflow-config',path.join(f.root,'workflow.json'),'--allow-qa',
    '--qa-fix-owner-config',path.join(f.root,'fix.json'),'--allow-qa-fix-start','--runtime',runtime,
    '--qa-fix-review-config',path.join(f.root,'review.json'),'--allow-qa-fix-cause-review',...flags];
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),...args],
      {env:{...process.env,PATH:f.bin+path.delimiter+process.env.PATH},stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',sessionId;const rows=[];
    const timer=setTimeout(()=>{child.kill();reject(Error('QA-fix CLI timed out'));},15000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      while(buffer.includes('\n')){
        const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
        try{
          const row=JSON.parse(line);rows.push(row);
          if(row.type==='host_ready')sessionId=row.sessionId;
          if(row.type==='host_request'){
            assert(['fix_learning','fix_diagnose'].includes(row.kind),row.kind);
            const result=row.kind==='fix_learning'
              ?{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'Synthetic fixture'}:diagnosis;
            child.stdin.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,
              requestDigest:row.requestDigest,result})+'\n');
          }
          if(row.requestId===operation.requestId)child.stdin.write(JSON.stringify({type:'host_close',sessionId})+'\n');
        }catch(error){child.kill();clearTimeout(timer);reject(error);}
      }
    });
    child.on('close',code=>{clearTimeout(timer);resolve({code,stderr,rows,result:rows.find(row=>row.requestId===operation.requestId)?.result});});
    child.stdin.write(JSON.stringify(operation)+'\n');
  });
}

test('A creates; B advances and signs; C reads the same child without writing',async t=>{
  const f=await fixture(t);
  let owner=await f.open(A);assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
  f.close();const before=f.records();
  owner=await f.open(B);assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
  assert.equal((await owner.handle({...f.bound('fix_action'),fixOperation:'cause_review'})).fixStage,'red_test_required');
  f.close();const after=f.records();assert.deepEqual(after.slice(0,before.length),before);
  assert.deepEqual(after.slice(before.length,before.length+2).map(row=>row.id),['fix-host-joined-1','fix-cause-registered']);
  assert.deepEqual(after.find(row=>row.id==='fix-host-joined-1').payload,{hostContextId:B});
  assert.equal(after.find(row=>row.id==='fix-cause-registered').payload.grant.hostContextId,B);
  const bytes=fs.readFileSync(f.statePath);
  owner=await f.open(C,{allowStart:false});assert.equal((await owner.handle(f.bound('fix_status'))).fixStage,'red_test_required');f.close();
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

for(const template of [false,true])for(const childHost of [A,B,'session-X'])test(`new ${template?'template':'fixed'} child host ${childHost} from B`,async t=>{
  const f=await fixture(t,{childHost}),owner=await f.open(B,{template});
  if(childHost==='session-X'){
    await assert.rejects(owner.handle(f.bound('fix_advance')),{code:'qa_fix_host_mismatch'});
    assert.equal(fs.existsSync(f.childDir),false);
    assert.equal((await owner.handle(f.request('status'))).state,'fixture_completed');
  }else assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
});

for(const operation of ['fix_status','fix_advance'])test(`live cause reviewer is rejected on ${operation}, parent reopens`,async t=>{
  const f=await fixture(t,{causeContext:B});
  let owner=await f.open(A);await owner.handle(f.bound('fix_advance'));f.close();
  const bytes=fs.readFileSync(f.statePath);owner=await f.open(B,{allowStart:operation!=='fix_status'});
  await assert.rejects(owner.handle(f.bound(operation)),{code:'invalid_cause_reviewer'});
  assert.equal((await owner.handle(f.request('status'))).state,'fixture_completed');f.close();
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

test('owner requires a valid live host id',async t=>{
  const f=await fixture(t);
  for(const hostContextId of [undefined,'invalid host'])assert.throws(()=>createQaFixOwnerHost({hostContextId,parentHostContextId:A,
    fix:f.fix,parent:null,reopenParent:()=>{}}),{code:'invalid_input'});
});

test('reviewer metadata is independent of live host identity',async t=>{
  const f=await fixture(t);assert.deepEqual(f.reviewHost(A).reviewer,f.reviewHost(B).reviewer);
});

test('CLI resumes A child in B and signs the child grant as B; C reopens',async t=>{
  const f=await fixture(t),owner=await f.open(A);await owner.handle(f.bound('fix_advance'));f.close();
  const signed=await cli(f,B,{...f.bound('fix_action'),fixOperation:'cause_review'});
  assert.equal(signed.code,0,signed.stderr);assert.equal(signed.result?.fixStage,'red_test_required',JSON.stringify(signed));
  assert.equal(f.records().find(row=>row.id==='fix-cause-registered').payload.grant.hostContextId,B);
  assert.deepEqual(f.records().find(row=>row.id==='fix-host-joined-1').payload,{hostContextId:B});
  const bytes=fs.readFileSync(f.statePath),read=await cli(f,C,f.bound('fix_status'));
  assert.equal(read.code,0,read.stderr);assert.equal(read.result?.fixStage,'red_test_required',JSON.stringify(read));
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

test('CLI still refuses a child runtime differing from the host runtime',async t=>{
  const f=await fixture(t,{childHost:B});f.fix.configuration.runtime='claude';
  const result=await cli(f,B,f.bound('fix_status'));
  assert.equal(result.code,1);assert.match(result.stderr,/"code":"qa_fix_host_mismatch"/);
  assert.equal(fs.existsSync(f.childDir),false);
});

for(const childHost of [A,B,'session-X'])test(`CLI new child host ${childHost} from resumed parent B`,async t=>{
  const f=await fixture(t,{childHost}),result=await cli(f,B,f.bound('fix_advance'));
  if(childHost==='session-X'){
    assert.match(result.stderr,/qa_fix_host_mismatch/);assert.equal(fs.existsSync(f.childDir),false);
  }else{
    assert.equal(result.code,0,result.stderr);assert.equal(result.result?.fixStage,'cause_review_required',JSON.stringify(result));
  }
});

test('existing child creator B is accepted by C, but configuration drift is refused',async t=>{
  const f=await fixture(t,{childHost:B});let owner=await f.open(B);
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');f.close();
  const bytes=fs.readFileSync(f.statePath);owner=await f.open(C);
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');f.close();
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
  f.fix.configuration.hostContextId=C;owner=await f.open(C);
  await assert.rejects(owner.handle(f.bound('fix_status')),{code:'fingerprint_mismatch'});
  assert.equal((await owner.handle(f.request('status'))).state,'fixture_completed');f.close();
  assert.deepEqual(fs.readFileSync(f.statePath),bytes);
});

test('QA-fix child abandons a lost local diagnosis only with its dedicated CLI flag',async t=>{
  const f=await fixture(t);
  let owner=await f.open(A,{lostDiagnosis:true});
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'unknown');
  assert.equal(f.records().at(-1).id,'fix-diagnose-intent');
  f.close();
  const request={...f.bound('fix_action'),fixOperation:'abandon_step',reason:'Child diagnosis response lost'};
  const before=fs.readFileSync(f.statePath);
  const denied=await cli(f,A,request);
  assert.match(denied.stderr,/fix_abandon_unavailable/);
  assert.deepEqual(fs.readFileSync(f.statePath),before);
  const allowed=await cli(f,A,request,{flags:['--allow-qa-fix-abandon']});
  assert.equal(allowed.code,0,allowed.stderr);
  assert.equal(allowed.result?.fixStage,'diagnose');
  assert(f.records().some(row=>row.id==='fix-abandoned-1'));
  owner=await f.open(A);
  assert.equal((await owner.handle(f.bound('fix_advance'))).fixStage,'cause_review_required');
  assert(f.records().some(row=>row.id==='fix-diagnose-retry-1-result'));
});
