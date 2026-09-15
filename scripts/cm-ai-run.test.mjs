import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {PassThrough,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';

const cli=fileURLToPath(new URL('./cm-ai-run.mjs',import.meta.url));
const identity={repositoryId:'control-fixture',runId:'control-run',taskId:'T-001',attempt:1};
const request=(operation,requestId=operation)=>({version:1,operation,requestId,identity});
const platform=process.platform==='darwin'&&Number(process.versions.node.split('.')[0])>=24;
test('fixed Codex assembly requires review preflight and denies developer dispatch without host approval',()=>fixture(async f=>{
  const {createCodexExecution}=await import('./cm-ai-run.mjs');
  const {configFingerprint}=await import('../runtime/js/cm-ai/codex-config.mjs');
  const {requestFor}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const config={codeProject:f.codeProject,developerModel:'fixture',reviewerModel:'fixture',hostContextId:'main',
    developerContextId:'author',checkCommands:[{id:'check',command:[process.execPath,'--version']}],timeoutMs:1000,reviewerPreflight:null};
  let decisions=0;const authority={authorizeDevelopment:()=>{decisions++;return {status:'denied'};},
    authorizeReview:()=>({status:'denied',code:'permission_denied'}),hostDecision:{status:'denied',code:'permission_denied'}};
  await assert.rejects(createCodexExecution(config,authority),{code:'tool_preflight_missing'});
  config.reviewerPreflight={passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})};
  const execution=await createCodexExecution(config,authority);assert.equal(decisions,0);
  const request=requestFor({invocationId:'dev-1',identity,role:'developer',provider:'codex',requestedModel:'fixture',
    contextId:'author',payload:{scope:['a.js'],requirements:[],priorReview:null}});
  await assert.rejects(execution.developer.run(request,{signal:new AbortController().signal}),{code:'permission_denied'});
  assert.equal(decisions,1);assert.equal(fs.readFileSync(path.join(f.codeProject,'a.js'),'utf8'),'old\n');
  assert.equal(execution.reviewInvocation.authorize,authority.authorizeReview);
}));
for(const [mode,nested] of [...['manual','approved','denied','awaiting','blocked','repair','review_limit'].map(mode=>[mode,false]),['approved',true],['blocked',true]])
test(`trusted host execution uses the same entry and sole gate: ${mode} nested=${nested}`,
  {skip:!platform},()=>fixture(async f=>{
    const {main}=await import('./cm-ai-run.mjs');
    const {createCodexDeveloperRun}=await import('../runtime/js/cm-ai/codex-developer-adapter.mjs');
    const {createHostCheck}=await import('../runtime/js/cm-ai/host-check.mjs');
    const input=new PassThrough(),output=new PassThrough(),error=new PassThrough();
    const {digest}=await import('../runtime/js/cm-ai/effect-contract.mjs');
    const {reviewPaths}=await import('../runtime/js/cm-ai/review-runner.mjs');
    // A worktree root has a .git file; the host must neither reject it nor
    // include/follow its external metadata in the provider review package.
    fs.writeFileSync(path.join(f.codeProject,'.git'),'gitdir: /nonexistent/cm-synthetic-worktree-metadata\n');
    let stdout='',stderr='',calls=0,reviews=0;output.on('data',x=>stdout+=x);error.on('data',x=>stderr+=x);
    const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['main'],
      developer:{provider:'codex',requestedModel:'fixture',contextId:'dev',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
        calls++;fs.writeFileSync(path.join(f.codeProject,'a.js'),'new\n');
        return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
          retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
      }})},
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
        allowed:true,available:true,contexts:['review-1','review-2'],run:(request,{onEvent})=>{
          assert(['approved','blocked','repair','review_limit'].includes(mode));reviews++;
          assert(!JSON.stringify(request.payload.reviewPackage).includes('cm-synthetic-worktree-metadata'));
          if(mode==='approved'&&!nested){
            assert(request.payload.reviewPackage.changes.some(change=>change.path==='README.md'));
            assert.equal(fs.readFileSync(path.join(f.codeProject,'README.md'),'utf8'),'# Updated fixture docs\n');
          }
          onEvent({event:'thread.started',provider_thread:`actual-review-${request.identity.attempt}`});
          onEvent({event:'turn.started',item_type:null});
          onEvent({event:'item.completed',item_type:'agent_message'});
          onEvent({event:'turn.completed',item_type:null});
          onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
          const verdict=mode==='review_limit'||(mode==='repair'&&request.identity.attempt===1)?'changes_requested':
            mode==='repair'?'approved':mode;
          return {status:'succeeded',value:{verdict,packageDigest:request.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(request.payload.reviewPackage),findings:verdict==='changes_requested'
              ?[{id:'F1',severity:'P2',path:'a.js',message:'Synthetic repair required',evidence:'First implementation'}]:[],summary:'Synthetic review'}};
        }}],
      reviewInvocation:{developerThreadId:'host-author',excludedThreadIds:['main'],
        authorize:(request,{authorizationAt})=>{
          assert(['approved','blocked','repair','review_limit'].includes(mode));
          const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.identity.attempt}`,adapterId:'codex-review-adapter',
            invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,
            reviewerId:'reviewer',logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
            hostContextId:'main',decisionId:`decision-${request.identity.attempt}`,decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
          return {...body,grantDigest:digest(body)};
        }},
      hostDecision:mode==='awaiting'?null:['approved','blocked','repair','review_limit'].includes(mode)?{status:'approved'}:{status:'denied',code:'permission_denied'},
      check:createHostCheck({cwd:f.codeProject,commands:[{id:'content',command:[process.execPath,'-e',
        "require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'),'new\\n')"]}]})};
    let qaCalls=0,qaRuns=0,docInspections=0,docWrites=0,reviewDecisions=0;
    const dynamicQa=mode==='approved'&&!nested;
    const dynamicReview=dynamicQa||mode==='repair';
    if(dynamicReview){
      const {createHostReviewAuthority}=await import('../runtime/js/cm-ai/host-review-authority.mjs');
      const authority=createHostReviewAuthority({hostContextId:'main',reviewerId:'reviewer',adapterId:'codex-review-adapter',
        timeoutMs:1000,decide:async(binding,signal)=>{
          reviewDecisions++;await Promise.resolve();assert.equal(signal.aborted,false);
          assert.equal(binding.identity.attempt,reviewDecisions);
          const handoff=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews',`login-T-001-a${binding.identity.attempt}-handoff.json`),'utf8'));
          assert.equal(handoff.status,'ready_for_review');assert.match(binding.packageDigest,/^[a-f0-9]{64}$/);
          return {status:'approved'};
        }});
      execution.hostDecision=null;execution.hostDecisionProvider=authority.hostDecisionProvider;
      execution.reviewInvocation.authorize=authority.authorize;
    }
    if(dynamicQa){
      const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));
      definition.scope.push('README.md');fs.writeFileSync(f.config,JSON.stringify(definition));
      execution.documentationSync={paths:['README.md'],run:async(request,signal)=>{
        assert.equal(signal.aborted,false);assert.deepEqual(request.paths,['README.md']);docWrites++;
        fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Updated fixture docs\n');
        return {status:'completed'};
      }};
      execution.qaLogHome=path.join(f.specsDir,'synthetic-log-home');
      execution.qaDecisionProvider={timeoutMs:1000,decide:async binding=>{
        qaCalls++;assert.deepEqual(binding.identity,identity);
        assert.match(binding.packageDigest,/^[a-f0-9]{64}$/);
        assert(fs.readFileSync(path.join(f.specsDir,'1.login','tasks.md'),'utf8').includes('[x]'));
        return {decisionId:'host-qa',identity:binding.identity,packageDigest:binding.packageDigest,
          status:'triggered',reason:'feature_complete',score:null,at:'2026-09-07T20:00:00Z'};
      }};
      execution.applicableAgentFiles=[];
      execution.documentationProvider={timeoutMs:1000,inspect:async binding=>{
        docInspections++;
        assert.equal(fs.readFileSync(path.join(f.codeProject,'requirements.md'),'utf8'),'fixture\n');
        return {syncId:binding.syncId,identity:binding.identity,packageDigest:binding.packageDigest,
          contextDigest:binding.contextDigest,status:'completed',reason:'Synthetic fixture docs already current',at:'2026-09-07T20:00:00Z'};
      }};
      execution.qaExecutor={mode:'commands',caseCount:1,timeoutMs:2000,run:async(binding,signal)=>{
        qaRuns++;
        const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.at(-1).phase,'start');assert.equal(rows.at(-1).operation_id,binding.testRunId);
        // Actual isolated subprocess, not a model claiming tests passed.
        const checked=await execution.check({identity:binding.identity},{signal});
        assert.equal(checked[0].outcome,'passed');
        const report=path.join(f.specsDir,'.reviews',`${binding.testRunId}.md`);
        fs.writeFileSync(report,'# QA command evidence\n'+checked[0].evidence+'\n');
        return {result:'PASS',passed:1,failed:0,blocked:0,report};
      }};
    }
    input.end(JSON.stringify(request(mode==='manual'?'start':'advance'))+'\n');
    if(nested){
      const deniedInput=new PassThrough(),deniedOutput=new PassThrough(),deniedError=new PassThrough();let reason='';
      deniedError.on('data',x=>reason+=x);deniedInput.end(JSON.stringify(request('advance'))+'\n');
      assert.equal(await main(['serve','--config',f.config,'--mode','create'],{input:deniedInput,
        output:deniedOutput,error:deniedError,execution:{...execution,configuration:{codeProject:f.codeProject}}}),1);
      assert.match(reason,/nested_specs_protection_required/);assert.equal(calls,0);
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    }
    assert.equal(await main(['serve','--config',f.config,'--mode','create'],{input,output,error,execution}),0,stderr);
    const repaired=['repair','review_limit'].includes(mode),completed=['approved','repair'].includes(mode);
    const expected=dynamicQa?'run_done':completed?'fixture_completed':['blocked','review_limit'].includes(mode)?'blocked':'awaiting_review';
    assert.equal(JSON.parse(stdout).result.state,expected,stdout);assert.equal(calls,repaired?2:1);
    if(completed){
      assert.equal(JSON.parse(stdout).result.code,dynamicQa?'run_done':'qa_decision_required');
      assert.equal(JSON.parse(stdout).result.outcome,dynamicQa?'finalized':'awaiting');
    }
    assert.equal(reviews,repaired?2:['approved','blocked'].includes(mode)?1:0);
    if(repaired)assert.equal(JSON.parse(stdout).result.identity.attempt,2);
    if(mode==='review_limit')assert.equal(JSON.parse(stdout).result.code,'review_limit');
    if(mode==='denied')assert.equal(JSON.parse(stdout).result.outcome,'denied');
    if(mode==='awaiting')assert.equal(JSON.parse(stdout).result.code,'decision_required');
    assert.equal(fs.readFileSync(path.join(f.specsDir,'1.login','tasks.md'),'utf8').includes('[x]'),completed);
    assert(fs.existsSync(path.join(f.specsDir,'.reviews','login-T-001-a1-handoff.json')));
    assert.equal(f.invoke('resume',[request('status')]).status,1);
    if(mode!=='manual'){
      const resumedInput=new PassThrough(),resumedOutput=new PassThrough();let resumed='';
      resumedOutput.on('data',x=>resumed+=x);resumedInput.end(JSON.stringify(request('advance'))+'\n');
      assert.equal(await main(['serve','--config',f.config,'--mode','resume'],
        {input:resumedInput,output:resumedOutput,error,execution}),0,stderr);
      assert.equal(JSON.parse(resumed).result.state,expected,resumed);
      assert.equal(calls,repaired?2:1);assert.equal(reviews,repaired?2:['approved','blocked'].includes(mode)?1:0);
      if(dynamicReview)assert.equal(reviewDecisions,repaired?2:1,'reopen must not reauthorize completed review');
      if(dynamicQa){
        assert.equal(qaCalls,1);assert.equal(qaRuns,1);assert.equal(docInspections,2);assert.equal(docWrites,1);
        assert.equal(JSON.parse(resumed).result.code,'run_done');
        const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.filter(row=>row.event==='run_done').length,1);
      }
    }
  },{nested}));
async function fixture(fn,{nested=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-control-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(nested?codeProject:root,'specs'),feature='1.login';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject,{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.js'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['a.js'],requirements:['requirements.md']};
  const config=path.join(root,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
  const invoke=(mode,requests)=>{
    const child=spawnSync(process.execPath,[cli,'serve','--config',config,'--mode',mode],{
      encoding:'utf8',input:requests.map(value=>JSON.stringify(value)).join('\n')+'\n',timeout:10000});
    return {...child,rows:child.stdout.trim().split('\n').filter(Boolean).map(JSON.parse)};
  };
  try{await fn({root,specsDir,codeProject,definition,config,invoke});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('fixed CLI creates the real runner, blocks dispatch, cancels and resumes the same journal',
  {skip:!platform},()=>fixture(async f=>{
    const first=f.invoke('create',[request('status'),request('start'),request('cancel')]);
    assert.equal(first.status,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='status').result.state,'pending_review');
    assert.equal(first.rows.find(row=>row.requestId==='start').result.code,'execution_adapter_required');
    assert.equal(first.rows.find(row=>row.requestId==='start').result.providerCalls,0);
    assert.equal(first.rows.find(row=>row.requestId==='cancel').result.state,'cancelled');
    const journal=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
    const before=fs.readFileSync(journal);
    const resumed=f.invoke('resume',[request('status')]);
    assert.equal(resumed.status,0,resumed.stderr);
    assert.equal(resumed.rows[0].result.state,'cancelled');
    assert.deepEqual(fs.readFileSync(journal),before);
    assert.match(fs.readFileSync(path.join(f.specsDir,'1.login','tasks.md'),'utf8'),/\[ \]/);
    assert.equal(f.invoke('create',[request('status')]).status,1);
  }));

test('unapproved specs and mismatched task reject before creating a run',
  {skip:!platform},()=>fixture(async f=>{
    fs.writeFileSync(f.config,JSON.stringify({...f.definition,identity:{...identity,taskId:'T-999'}}));
    const wrong=f.invoke('create',[request('start')]);assert.equal(wrong.status,1);
    assert.match(wrong.stderr,/task_selection_mismatch/);
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    fs.writeFileSync(f.config,JSON.stringify(f.definition));
    fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login']}));
    const blocked=f.invoke('create',[request('start')]);assert.equal(blocked.status,1);
    assert.equal(blocked.rows[0].outcome,'blocked');
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
  }));

test('control config does not accept executable callbacks or self-reported authorization',()=>fixture(async f=>{
  fs.writeFileSync(f.config,JSON.stringify({...f.definition,hostDecision:{status:'approved'}}));
  const result=f.invoke('create',[request('start')]);assert.equal(result.status,1);
  assert.match(result.stderr,/invalid_config/);
  assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
}));

for(const operation of ['start','advance'])
test(`JSONL status and cancel bypass an in-flight real runner effect: ${operation}`, {skip:!platform},()=>fixture(async f=>{
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const {createCmAiHost}=await import('../runtime/js/cm-ai/host.mjs');
  const {digest}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const reviewsDir=path.join(f.specsDir,'.reviews');fs.mkdirSync(reviewsDir);
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,'1.login','tasks.md'),feature:'login',
    specsRoot:f.specsDir,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('transport-test'),config:digest('test'),inputs:digest('task')},create:true});
  let entered,aborted=false;const started=new Promise(resolve=>{entered=resolve;});
  const host=createCmAiHost({runner:{root:f.codeProject,identity,scope:['a.js'],requirements:['requirements.md'],
    excludedContexts:['main'],timeoutMs:1000,taskLearning:{feature:'1.login'},
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:(_request,{signal})=>new Promise(resolve=>{
      signal.addEventListener('abort',()=>{aborted=true;resolve({status:'cancelled'});},{once:true});entered();
    })},reviewers:[{id:'review',provider:'codex',requestedModel:'fixture',contexts:['review1','review2'],
      available:true,allowed:true,run:()=>assert.fail('no review dispatch')}],check:()=>assert.fail('no checks after cancellation'),
    taskCompletion:{reviewsDir,handoffs:[1,2].map(a=>path.join(reviewsDir,`login-T-001-a${a}-handoff.json`))},
    persistence:{store,mode:'create',version:2}},
    entry:{specsDir:f.specsDir,codeProject:f.codeProject,feature:'1.login',identity}});
  const input=new PassThrough(),output=new PassThrough(),rows=[];
  output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))rows.push(JSON.parse(line));});
  try{
    const serving=serveCmAiHost({host,input,output});
    input.write(JSON.stringify(request(operation))+'\n');await started;
    input.write(JSON.stringify(request('resume'))+'\n');
    input.write(JSON.stringify(request('status'))+'\n');
    input.end(JSON.stringify(request('cancel'))+'\n');
    await serving;
    assert(aborted);assert.equal(rows.find(row=>row.requestId==='resume').error.code,'host_busy');
    assert.equal(rows.find(row=>row.requestId==='cancel').result.state,'cancelled');
    assert(rows.findIndex(row=>row.requestId==='status')<rows.findIndex(row=>row.requestId===operation));
    assert.equal(rows.find(row=>row.requestId===operation).result.state,'cancelled');
    assert(!store.snapshot().records.some(row=>row.payload.type==='task-commit-result'));
  }finally{store.close();}
}));

test('malformed and oversized control input cannot invoke host code',async()=>{
  const input=new PassThrough(),output=new PassThrough();let calls=0,text='';
  output.on('data',chunk=>{text+=chunk;});
  const serving=serveCmAiHost({host:{handle:()=>{calls++;}},input,output});
  input.end('not json\n'+JSON.stringify({requestId:'bad',operation:'shell',command:'unsafe'})+'\n');
  await serving;assert.equal(calls,0);assert.equal(text.trim().split('\n').length,2);
  const huge=new PassThrough();const rejected=serveCmAiHost({host:{handle:()=>{calls++;}},input:huge,output});
  huge.end('x'.repeat(64*1024+1));await assert.rejects(rejected,/request_too_large/);assert.equal(calls,0);
});

test('output failure rejects the session without leaking an unhandled stream error',async()=>{
  const input=new PassThrough();
  const output=new Writable({write(_chunk,_encoding,callback){callback(new Error('fixture broken output'));}});
  const serving=serveCmAiHost({host:{handle:async()=>({state:'ready'})},input,output});
  input.end(JSON.stringify(request('status'))+'\n');
  await assert.rejects(serving,/fixture broken output/);
});

test('duplicate paths reject before writes and a genuine empty initializer can resume',
  {skip:!platform},()=>fixture(async f=>{
    fs.writeFileSync(f.config,JSON.stringify({...f.definition,scope:['a.js','a.js']}));
    assert.equal(f.invoke('create',[request('status')]).status,1);
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    fs.writeFileSync(f.config,JSON.stringify(f.definition));
    const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
    const {digest}=await import('../runtime/js/cm-ai/contracts.mjs');
    const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,'1.login','tasks.md'),feature:'login',
      specsRoot:f.specsDir,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
      fingerprints:{workflow:digest('cm-ai-control-v1'),config:digest(f.definition),
        inputs:digest({feature:f.definition.feature,task:identity.taskId})},create:true});
    assert.equal(store.snapshot().records.length,0);store.close();
    const resumed=f.invoke('resume',[request('status')]);assert.equal(resumed.status,0,resumed.stderr);
    assert.equal(resumed.rows[0].result.state,'pending_review');
  }));

test('configuration object key order does not change durable identity', {skip:!platform},()=>fixture(async f=>{
  assert.equal(f.invoke('create',[request('status')]).status,0);
  const reordered=Object.fromEntries(Object.entries(f.definition).reverse());
  reordered.identity=Object.fromEntries(Object.entries(reordered.identity).reverse());
  fs.writeFileSync(f.config,JSON.stringify(reordered,null,2));
  const resumed=f.invoke('resume',[request('status')]);assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(resumed.rows[0].result.state,'pending_review');
}));

test('a stalled status response cannot prevent the following cancel from reaching the host',async()=>{
  const input=new PassThrough();let flush,release,cancelled=false;
  const output=new Writable({write(_chunk,_encoding,callback){if(!flush)flush=callback;else callback();}});
  const host={handle:async value=>{
    if(value.operation==='start')return new Promise(resolve=>{release=resolve;});
    if(value.operation==='cancel'){cancelled=true;release({state:'cancelled'});}
    return {state:value.operation==='cancel'?'cancelled':'running'};
  }};
  const serving=serveCmAiHost({host,input,output});
  for(const op of ['start','status','cancel'])input.write(JSON.stringify(request(op))+'\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert(flush);assert(cancelled,'cancel must arrive before the status response is flushed');
  flush();input.end();await serving;
});

test('stalled response backlog is bounded and fails explicitly',async()=>{
  const input=new PassThrough();
  const output=new Writable({write(){/* Deliberately never acknowledge a write. */}});
  const serving=serveCmAiHost({host:{handle:async()=>({state:'ready'})},input,output});
  const rejected=assert.rejects(serving,/output_backlog_exceeded/);
  input.end(Array.from({length:70},(_,i)=>JSON.stringify(request('status',`status-${i}`))).join('\n')+'\n');
  await rejected;
});
