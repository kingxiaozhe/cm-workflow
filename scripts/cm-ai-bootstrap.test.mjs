import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHostBootstrap} from '../runtime/js/cm-ai/host-bootstrap.mjs';
import {cmInitRuleTargets} from '../runtime/js/cm-init/draft-generation.mjs';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {createDeveloperRun,validateDeveloperScope} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {inspectCmAiAdmission} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {inspectCmAiContextRefresh,inspectCmAiTaskLearningInput} from '../runtime/js/cm-ai/cm-ai-context-refresh.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const workflowRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const selection={versionControl:'none',modules:['frontend'],analysis:'Approved synthetic JavaScript project'};
const checks=()=>Object.fromEntries(['commands','globs','file_references','constraint_preservation','rule_applicability']
  .map(name=>[name,{status:'verified',evidence:'Synthetic semantic report for the local fixture'}]));
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-bootstrap-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,'0.bootstrap'),{recursive:true});fs.mkdirSync(path.join(specsDir,'.reviews'));
  fs.writeFileSync(path.join(specsDir,'0.bootstrap','requirements.md'),'# Requirements\nSynthetic approved scaffold and project instructions.\n');
  fs.writeFileSync(path.join(specsDir,'0.bootstrap','design.md'),'# Design\nJavaScript; no Git; frontend module.\n');
  fs.writeFileSync(path.join(specsDir,'0.bootstrap','tasks.md'),'- [ ] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 .claude/ 规范（cm-init）\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['0.bootstrap']}));
  return {root,codeProject,specsDir,calls:[],reviews:[],businessCalls:0};
}
function definition(f,taskId){
  return {version:1,codeProject:f.codeProject,specsDir:f.specsDir,feature:'0.bootstrap',
    identity:{repositoryId:'bootstrap-fixture',runId:'run-'+taskId,taskId,attempt:1},
    scope:taskId==='T-001'?['app.mjs']:[...cmInitRuleTargets(selection)],requirements:[]};
}
function reply(f,kind,payload){
  f.calls.push(kind);
  if(kind==='init_generate')return {status:'generated',documents:payload.targets.map(file=>({path:file,
    content:file==='AGENTS.md'&&fs.existsSync(path.join(f.codeProject,file))?fs.readFileSync(path.join(f.codeProject,file),'utf8'):
      file==='.claude/CLAUDE.md'?'# Fixture instructions\n'+payload.targets.filter(p=>p.startsWith('.claude/rules/'))
      .map(p=>'@rules/'+path.basename(p)).join('\n')+'\n':'# Fixture instructions\nUse approved scope.\n'}))};
  if(kind==='init_verify')return {checks:checks(),constraintChanges:[],application:{status:'no_relevant_lesson',note:null},
    retrospective:f.lesson&&f.calls.filter(kind=>kind==='init_verify').length===1
      ?{status:'lesson_candidate',candidates:[{classification:'structured',trigger:'Bootstrap recovery',
        action:'Preserve reviewed instruction lessons across attempts',evidence:['app.mjs']}],reason:null}
      :{status:'no_new_lesson',candidates:[],reason:null}};
  assert.fail('unexpected host call '+kind);
}
function open(f,taskId,mode='create',overrides={}){
  const d=definition(f,taskId),bridge={call:async(kind,payload)=>overrides.reply?overrides.reply(kind,payload):reply(f,kind,payload)};
  const bootstrap=createHostBootstrap({definition:d,workflowRoot,selection:taskId==='T-001'?null:selection,bridge,
    allowWrite:overrides.allowWrite??true});
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,'0.bootstrap','tasks.md'),feature:'bootstrap',specsRoot:f.specsDir,
    identity:{repositoryId:d.identity.repositoryId,runId:d.identity.runId},
    fingerprints:{workflow:digest('bootstrap-test'),config:digest({d,bootstrap:bootstrap.configuration}),inputs:digest(taskId)},create:mode==='create'});
  const developer={provider:'codex',requestedModel:'synthetic',contextId:'scaffold-author',run:createDeveloperRun({provider:'codex',requestedModel:'synthetic',worker:async request=>{
    f.businessCalls++;assert(!request.prompt.includes('"scope":["AGENTS.md"'));
    assert(request.prompt.includes(Buffer.from('JavaScript; no Git; frontend module.').toString('base64').slice(0,12))
      ||request.prompt.includes('0.bootstrap/design.md'));
    fs.writeFileSync(path.join(f.codeProject,'app.mjs'),'export const fixture = true;\n');
    return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
  }})};
  const runner=createTaskRunner({root:f.codeProject,identity:d.identity,scope:d.scope,requirements:d.requirements,bootstrap,
    taskLearning:{feature:'0.bootstrap',hostHandoff:true},developer,excludedContexts:['main'],timeoutMs:5000,
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic-review',allowed:true,available:true,contexts:['review-one','review-two'],
      run:async(request,{onEvent})=>{f.reviews.push(request.payload.reviewPackage);
        onEvent({event:'thread.started',provider_thread:'actual-review-'+request.identity.attempt});
        onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
        onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
        const revise=f.requestRevision&&taskId==='T-002'&&request.identity.attempt===1;
        return {status:'succeeded',value:{verdict:revise?'changes_requested':'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:revise?[{id:'F1',severity:'P2',path:'AGENTS.md',
            message:'Reverify instruction applicability',evidence:'Synthetic revision fixture'}]:[],summary:'Synthetic independent review'}};}}],
    reviewInvocation:{developerThreadId:'scaffold-author',excludedThreadIds:['main'],authorize:(request,{authorizationAt})=>{
      const body={version:1,kind:'cm-review-dispatch-grant',grantId:'grant-'+request.identity.attempt,adapterId:'codex-review-adapter',
        invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,reviewerId:'reviewer',
        logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'main',
        decisionId:'decision-'+request.identity.attempt,decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
      return {...body,grantDigest:digest(body)};
    }},
    check:createHostCheck({cwd:f.codeProject,timeoutMs:1000,commands:[{id:'syntax',command:[process.execPath,'--check','app.mjs']}]}),
    taskCompletion:{reviewsDir:path.join(f.specsDir,'.reviews'),handoffs:[1,2].map(a=>path.join(f.specsDir,'.reviews',`bootstrap-${taskId}-a${a}-handoff.json`))},
    persistence:{store,mode,version:3}});
  return {runner,store,definition:d,close:()=>store.close(),effect:kind=>{
    const identity=runner.status().identity;
    return runner.executeEffect({version:1,id:kind+'-'+identity.attempt,kind,identity,...(kind==='develop'?{
      learningInput:inspectCmAiTaskLearningInput({specsDir:f.specsDir,codeProject:f.codeProject,feature:'0.bootstrap',identity,
        applicableAgentFiles:[]},{admission:runner.inspectBootstrapAdmission()})}:{})});
  }};
}

function prepareCli(f){
  const config=path.join(f.root,'run.json'),bin=path.join(f.root,'bin');fs.mkdirSync(bin);
  const realCodex=spawnSync('which',['codex'],{encoding:'utf8'});assert.equal(realCodex.status,0);
  // Only the sandbox subcommand reaches native Codex. All review/preflight
  // processes use the existing synthetic fixture, never a provider endpoint.
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\n`
    +`const {spawnSync}=await import('node:child_process');\n`
    +`if(process.argv[2]==='sandbox'){const r=spawnSync(${JSON.stringify(realCodex.stdout.trim())},process.argv.slice(2),{stdio:'inherit'});process.exitCode=r.status??1;}`
    +`else await import(${JSON.stringify(new URL('./fixtures/codex-review-process.mjs',import.meta.url).href)});\n`,{mode:0o700});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_LOG_HOME:path.join(f.root,'mirror')};
  fs.writeFileSync(config,JSON.stringify(definition(f,'T-002')));
  const cli=path.join(workflowRoot,'scripts/cm-ai-host.mjs');
  const preflight=spawnSync(process.execPath,[cli,'preflight','--config',config,'--review-model','synthetic-review'],
    {env,encoding:'utf8',timeout:10000});assert.equal(preflight.status,0,preflight.stderr);
  const receipt=JSON.parse(preflight.stdout);assert.equal(receipt.preflight.real_model_requests,0);
  const files={review:receipt,bootstrap:{selection},protection:{checkCommands:[{id:'syntax',command:[process.execPath,'--check','app.mjs']}],timeoutMs:5000},
    workflow:{qa:{commands:[{id:'bootstrap-qa',command:[process.execPath,'--check','app.mjs'],caseIds:[]}],
      environment:{kind:'web',carrier:'browser',target:'isolated fixture; command QA only',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}};
  for(const [name,value] of Object.entries(files))fs.writeFileSync(path.join(f.root,name+'.json'),JSON.stringify(value));
  return {cli,env,args:['serve','--config',config,'--mode','create','--host-context','bootstrap-current-host','--allow-development',
    '--protected-conversation-config',path.join(f.root,'protection.json'),'--bootstrap-config',path.join(f.root,'bootstrap.json'),
    '--allow-bootstrap-write','--review-config',path.join(f.root,'review.json'),'--allow-review-attempt','1',
    '--workflow-config',path.join(f.root,'workflow.json'),'--allow-qa']};
}

function runCli(f,config,mode,operation){
  return new Promise((resolve,reject)=>{
    const args=[...config.args];args[4]=mode;
    const child=spawn(process.execPath,[config.cli,...args],{env:config.env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',sessionId;const calls=[];let result;
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('bootstrap CLI timeout: '+stderr));},15000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stderr.on('data',chunk=>{stderr+=chunk;});child.once('error',reject);
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let index;
      while((index=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
        try{
          const row=JSON.parse(line);
          if(row.type==='host_ready')sessionId=row.sessionId;
          if(row.type==='host_request'){
            calls.push(row.kind);let response;
            if(['init_generate','init_verify'].includes(row.kind)){assert.equal(mode,'create');response=reply(f,row.kind,row.payload);}
            else if(row.kind==='qa_assess')response={scores:{scope:5,risk:5,accumulation:5,boundary:5},
              changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}};
            else if(row.kind==='documentation_inspect'){
              const {syncId,identity,packageDigest,contextDigest}=row.payload;
              response={syncId,identity,packageDigest,contextDigest,status:'completed',reason:'Fixture instructions inspected; no documentation paths configured',
                at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
            }else assert.fail('unexpected bootstrap CLI host call '+row.kind);
            send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:response});
          }
          if(row.requestId===operation){assert(!row.error,JSON.stringify(row));result=row.result;send({type:'host_close',sessionId});}
        }catch(error){clearTimeout(timer);child.kill('SIGTERM');reject(error);return;}
      }
    });
    child.once('close',code=>{clearTimeout(timer);resolve({code,stderr,calls,result});});
    send({version:1,operation,requestId:operation,identity:definition(f,'T-002').identity});
  });
}

test('empty T001 then protected current-host CLI rules task, actual QA and N7 use original gates',{timeout:30000},async t=>{
  const f=fixture(t);assert.deepEqual(fs.readdirSync(f.codeProject),[]);
  let run=open(f,'T-001');
  assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  assert.equal(inspectCmAiAdmission(f).reason,'bootstrap_conflict');
  run=open(f,'T-001','resume');assert.equal(run.runner.inspectBootstrapAdmission().state,'ready');
  assert.equal(run.runner.status().state,'awaiting_review');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
  assert.equal(f.businessCalls,1);assert.equal(f.calls.length,0);
  assert.equal(f.reviews[0].bootstrapRequirements.files.length,2);assert.deepEqual(f.reviews[0].requirements,[]);
  assert.equal(inspectCmAiAdmission(f).nextTask.id,'T-002');
  const cli=prepareCli(f),completed=await runCli(f,cli,'create','advance');
  assert.equal(completed.code,0,JSON.stringify(completed));assert.equal(completed.result.state,'run_done',JSON.stringify(completed));
  assert(completed.calls.includes('qa_assess'));
  assert.equal(f.businessCalls,1);assert.deepEqual(f.calls,['init_generate','init_verify']);
  const handoff=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','bootstrap-T-002-a1-handoff.json'),'utf8'));
  assert.deepEqual(handoff.changed_files.sort(),[...cmInitRuleTargets(selection)].sort());
  const qaReports=fs.readdirSync(path.join(f.specsDir,'.reviews')).filter(file=>file.endsWith('-execution.md'));
  assert.equal(qaReports.length,1);assert.match(fs.readFileSync(path.join(f.specsDir,'.reviews',qaReports[0]),'utf8'),/Overall: PASS/);
  const refresh=inspectCmAiContextRefresh({codeProject:f.codeProject,specsDir:f.specsDir,feature:'0.bootstrap',applicableAgentFiles:[]});
  assert.equal(refresh.state,'complete');assert(refresh.contextFiles.some(file=>file.path==='.claude/rules/frontend.md'));
  const resumed=await runCli(f,cli,'resume','status');assert.equal(resumed.code,0,resumed.stderr);
  assert.equal(resumed.result.state,'fixture_completed');assert.deepEqual(resumed.calls,[]);
  assert.throws(()=>validateDeveloperScope(['AGENTS.md']),{code:'protected_scope'});
  assert.match(fs.readFileSync(path.join(f.specsDir,'0.bootstrap','tasks.md'),'utf8'),/\[x\] T-002/);
});

test('bootstrap denies missing authority before intent and a newly authorized launch can continue',{timeout:15000},async t=>{
  const f=fixture(t);
  let run=open(f,'T-001');await run.effect('develop');await run.effect('review');await run.effect('complete');run.close();
  run=open(f,'T-002','create',{allowWrite:false});
  const revision=run.store.snapshot().revision;
  assert.deepEqual(await run.effect('develop'),{outcome:'rejected',code:'bootstrap_write_authorization_required'});
  assert.equal(run.runner.status().state,'ready');assert.equal(run.store.snapshot().revision,revision);
  assert.equal(f.calls.length,0);run.close();assert.equal(fs.existsSync(path.join(f.codeProject,'AGENTS.md')),false);
  f.lesson=true;f.requestRevision=true;
  run=open(f,'T-002','resume');assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  run=open(f,'T-002','resume');assert.equal((await run.effect('review')).state,'changes_requested');run.close();
  const originalAgents=fs.readFileSync(path.join(f.codeProject,'AGENTS.md'),'utf8');assert.match(originalAgents,/Bootstrap recovery/);
  run=open(f,'T-002','resume',{allowWrite:false});const retryRevision=run.store.snapshot().revision,callCount=f.calls.length;
  assert.deepEqual(await run.effect('develop'),{outcome:'rejected',code:'bootstrap_write_authorization_required'});
  assert.equal(run.runner.status().state,'changes_requested');assert.equal(run.store.snapshot().revision,retryRevision);
  assert.equal(f.calls.length,callCount);run.close();
  run=open(f,'T-002','resume');assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  assert.equal(fs.readFileSync(path.join(f.codeProject,'AGENTS.md'),'utf8'),originalAgents);
  run=open(f,'T-002','resume');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
});

for(const scenario of ['existing-instructions','failed-verification','target-drift'])
test('rules task preserves files and original unknown outcome: '+scenario,{timeout:5000},async t=>{
  const f=fixture(t),tasks=path.join(f.specsDir,'0.bootstrap','tasks.md');
  // A previously accepted scaffold is test setup, not a second execution path.
  fs.writeFileSync(tasks,fs.readFileSync(tasks,'utf8').replace('[ ] T-001','[x] T-001'));
  fs.writeFileSync(path.join(f.codeProject,'app.mjs'),'export const fixture = true;\n');
  const agents=path.join(f.codeProject,'AGENTS.md');
  if(scenario==='existing-instructions')fs.writeFileSync(agents,'# User-owned rules\n');
  const run=open(f,'T-002','create',{reply:(kind,payload)=>{
    const response=reply(f,kind,payload);
    if(kind==='init_verify'){
      if(scenario==='failed-verification')response.checks.commands.status='unverified';
      if(scenario==='target-drift')fs.writeFileSync(agents,'# Concurrent user rules\n');
    }
    return response;
  }});
  const result=await run.effect('develop');assert.equal(result.state,'unknown');run.close();
  assert.equal(fs.existsSync(path.join(f.codeProject,'.claude')),false);
  if(scenario==='failed-verification')assert.equal(fs.existsSync(agents),false);
  else assert.match(fs.readFileSync(agents,'utf8'),/user|User/);
  const before=[...f.calls],resumed=open(f,'T-002','resume');
  assert.equal(resumed.runner.status().state,'unknown');resumed.close();assert.deepEqual(f.calls,before);
});
