import {buildManifest} from './cm-spec-manifest.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const FIXTURE_TIMEOUT_MS=Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000);

// Keep runtime declarations and log mirrors independent of the invoking user's home.
const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-bootstrap-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));

const workflowRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const selection={versionControl:'none',modules:['frontend'],analysis:'Approved synthetic JavaScript project'};
const checks=()=>Object.fromEntries(['commands','globs','file_references','constraint_preservation','rule_applicability']
  .map(name=>[name,{status:'verified',evidence:'Synthetic semantic report for the local fixture'}]));
function fixture(t,feature='0.bootstrap'){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-bootstrap-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(path.join(specsDir,'.reviews'));
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\nSynthetic approved scaffold and project instructions.\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\nJavaScript; no Git; frontend module.\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 和 .claude/ 规范（cm-init）\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,calls:[],reviews:[],businessCalls:0};
}
function definition(f,taskId){
  return {version:1,codeProject:f.codeProject,specsDir:f.specsDir,feature:f.feature,
    identity:{repositoryId:'bootstrap-fixture',runId:'run-'+taskId,taskId,attempt:1},
    scope:taskId==='T-001'?['app.mjs']:[...cmInitRuleTargets(selection)],requirements:[]};
}
function reply(f,kind,payload){
  f.calls.push(kind);
  if(kind==='init_generate')return {status:'generated',documents:payload.targets.map(file=>({path:file,
    content:file==='AGENTS.md'&&f.replaceAgentsDraft?'# Generated project rules\n':
      file==='AGENTS.md'&&fs.existsSync(path.join(f.codeProject,file))?fs.readFileSync(path.join(f.codeProject,file),'utf8'):
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
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),feature:'bootstrap',specsRoot:f.specsDir,
    identity:{repositoryId:d.identity.repositoryId,runId:d.identity.runId},
    fingerprints:{workflow:digest('bootstrap-test'),config:digest({d,bootstrap:bootstrap.configuration}),inputs:digest(taskId)},create:mode==='create'});
  const developer={provider:'codex',requestedModel:'synthetic',contextId:'scaffold-author',run:createDeveloperRun({provider:'codex',requestedModel:'synthetic',worker:async request=>{
    f.businessCalls++;assert(!request.prompt.includes('"scope":["AGENTS.md"'));
    assert(request.prompt.includes(Buffer.from('JavaScript; no Git; frontend module.').toString('base64').slice(0,12))
      ||request.prompt.includes(`${f.feature}/design.md`));
    fs.writeFileSync(path.join(f.codeProject,'app.mjs'),'export const fixture = true;\n');
    return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:f.scaffoldLesson?{status:'lesson_candidate',candidates:[{classification:'structured',
        trigger:'T-001 scaffold',action:'Preserve the original Learning section',evidence:['app.mjs']}],reason:null}
        :{status:'no_new_lesson',candidates:[],reason:null}}};
  }})};
  const runner=createTaskRunner({root:f.codeProject,identity:d.identity,scope:d.scope,requirements:d.requirements,bootstrap,
    taskLearning:{feature:f.feature,hostHandoff:true},developer,excludedContexts:['main'],timeoutMs:5000,
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
      learningInput:inspectCmAiTaskLearningInput({specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,identity,
        applicableAgentFiles:[]},{admission:runner.inspectBootstrapAdmission()})}:{})});
  }};
}


for(const feature of ['1.bootstrap','0.bootstrap'])
test(`approved ${feature} completes T-001 and T-002 with Learning preserved through fake independent review`,{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=fixture(t,feature);f.scaffoldLesson=true;
  assert.equal(inspectCmAiAdmission(f).nextTask.feature,feature);
  let run=open(f,'T-001');assert.equal((await run.effect('develop')).state,'awaiting_review');
  const before=fs.readFileSync(path.join(f.codeProject,'AGENTS.md'),'utf8');
  const lesson=before.slice(before.indexOf('## 项目教训'));
  assert.match(lesson,/T-001 scaffold/);run.close();
  run=open(f,'T-001','resume');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
  f.replaceAgentsDraft=true;
  run=open(f,'T-002','create',{allowWrite:false});
  assert.deepEqual(await run.effect('develop'),{outcome:'rejected',code:'bootstrap_write_authorization_required'});
  run.close();
  run=open(f,'T-002','resume');assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  const after=fs.readFileSync(path.join(f.codeProject,'AGENTS.md'),'utf8');
  assert(after.includes(lesson));assert.match(after,/# Generated project rules/);
  assert(fs.existsSync(path.join(f.codeProject,'.claude','CLAUDE.md')));
  assert(fs.existsSync(path.join(f.codeProject,'.claude','rules','testing.md')));
  assert.throws(()=>validateDeveloperScope(['AGENTS.md']),{code:'protected_scope'});
  run=open(f,'T-002','resume');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
  assert.equal(f.reviews.length,2);
  assert.match(fs.readFileSync(path.join(f.specsDir,feature,'tasks.md'),'utf8'),/\[x\] T-002/);
});

test('numbered bootstrap still refuses pre-existing non-Learning instructions',async t=>{
  const f=fixture(t,'1.bootstrap');
  let run=open(f,'T-001');assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  run=open(f,'T-001','resume');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
  const agents=path.join(f.codeProject,'AGENTS.md');fs.writeFileSync(agents,'# Existing user rules\n');
  run=open(f,'T-002');const result=await run.effect('develop');run.close();
  assert.equal(result.state,'unknown');assert.equal(result.code,'execution_error');
  assert.equal(fs.readFileSync(agents,'utf8'),'# Existing user rules\n');
  assert.equal(fs.existsSync(path.join(f.codeProject,'.claude')),false);
});

test('Learning appearing after the task baseline cannot be adopted as bootstrap input',async t=>{
  const f=fixture(t,'1.bootstrap');
  let run=open(f,'T-001');assert.equal((await run.effect('develop')).state,'awaiting_review');run.close();
  run=open(f,'T-001','resume');assert.equal((await run.effect('review')).state,'approved');
  assert.equal((await run.effect('complete')).state,'fixture_completed');run.close();
  run=open(f,'T-002');
  const agents=path.join(f.codeProject,'AGENTS.md');fs.writeFileSync(agents,'## 项目教训\n\n- late change\n');
  const result=await run.effect('develop');run.close();
  assert.deepEqual(result,{outcome:'rejected',code:'package_mismatch'});
  assert.equal(fs.existsSync(path.join(f.codeProject,'.claude')),false);
  assert.equal(fs.readFileSync(agents,'utf8'),'## 项目教训\n\n- late change\n');
});
