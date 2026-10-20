import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {scopeRevisionBinding} from '../runtime/js/cm-ai/scope-revision.mjs';
import {readReviewPackage,verifyReviewPackage,captureReviewBaseline,readReviewBaseline,extendReviewBaseline,captureScopeRevisionSources} from '../runtime/js/cm-ai/review-package.mjs';

const DRIVE=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const REVIEW=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
function fixture(t,{qa=false,protectedMode=false,selected=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-scope-revision-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=path.join(root,'app'),specs=path.join(root,'specs'),answers=path.join(root,'answers'),bin=path.join(root,'bin');
  for(const directory of [app,answers,bin,path.join(specs,'1.work')])fs.mkdirSync(directory,{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specs,'1.work',name),'# Synthetic fixture\n');
  fs.writeFileSync(path.join(specs,'1.work/tasks.md'),'- [ ] T-001: synthetic local task\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specs)}));
  fs.writeFileSync(path.join(app,'requirements.md'),'# Synthetic fixture\n');
  const scope=Array.from({length:28},(_,n)=>`part-${String(n).padStart(2,'0')}.mjs`);
  for(const file of scope)fs.writeFileSync(path.join(app,file),'export const value = 0;\n');
  const added='pagination.test.mjs';fs.writeFileSync(path.join(app,added),'export const value = 0;\n');
  const identity={repositoryId:'scope-fixture',runId:'scope-fixture-original',taskId:'T-001',attempt:1};
  const definition={version:1,codeProject:app,specsDir:specs,feature:'1.work',identity,scope,requirements:['requirements.md']};
  if(selected){
    const admission=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url)),
      '--specs-dir',specs,'--code-project',app,'--print-run-definition','--feature','1.work','--task',identity.taskId,
      '--scope',scope.join(','),'--requirements','requirements.md','--run-id',identity.runId,'--repository-id',identity.repositoryId],{encoding:'utf8'});
    assert.equal(admission.status,0,admission.stderr);Object.assign(definition,JSON.parse(admission.stdout));
    assert.deepEqual(definition.taskSelection,{version:1,taskId:identity.taskId});
    assert.deepEqual(definition.featureSelection,{version:1,feature:'1.work'});
  }
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(definition));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({version:2,development:'conversation',bootstrap:'disabled',qa:qa?'run':'disabled',qaFix:'disabled'}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:app,model:'fixture'})}}));
  fs.writeFileSync(path.join(bin,'codex'),fs.readFileSync(REVIEW),{mode:0o700});
  fs.writeFileSync(path.join(answers,'new.txt'),'export const value = 1;\n');
  const value={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
  const deliver=edits=>fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value,edits}));
  deliver(Object.fromEntries(scope.map(file=>[file,'new.txt'])));
  const command=[process.execPath,'-e',"import('./pagination.test.mjs').then(m=>process.exit(m.value===1?0:1))"];
  if(qa)fs.writeFileSync(path.join(root,'workflow.json'),JSON.stringify({qa:{commands:[{id:'local',caseIds:[],command}],
    environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]}));
  if(protectedMode)fs.writeFileSync(path.join(root,'protected.json'),JSON.stringify({checkCommands:[{id:'local',command}],timeoutMs:30000}));
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const drive=(operation='status',extra={})=>{
    const plan=path.join(root,'plan.json');
    let startup=false;
    if(operation==='revise_scope'){
      startup=true;operation='status';
      const {scope,reason,expectedControl,...rest}=extra;
      fs.writeFileSync(path.join(root,'launch.json'),JSON.stringify(expectedControl??null));
      fs.writeFileSync(path.join(root,'scope.json'),JSON.stringify(scope));
      extra={...rest,permissions:['--review-config','review.json',...(qa?['--workflow-config','workflow.json']:[]),
        ...(protectedMode?['--protected-conversation-config','protected.json']:[]),
        '--revise-scope','scope.json','--scope-revision-reason',reason,'--expected-control','launch.json']};
    }
    fs.writeFileSync(plan,JSON.stringify({config:'run.json',controlConfig:'control.json',mode:'resume',hostContext:'scope-fixture-host',
      permissions:['--review-config','review.json',...(qa?['--workflow-config','workflow.json']:[]),...(protectedMode?['--protected-conversation-config','protected.json']:[])],
      answers:'answers',checks:[{id:'local',command}],...extra}));
    const result=spawnSync(process.execPath,[DRIVE,'--plan',plan,operation],{encoding:'utf8',timeout:60000,env});
    const value=result.stdout.trim()?JSON.parse(result.stdout).result:null;
    if(startup&&value){assert.equal(result.status,0,result.stderr);assert.equal(rows().at(-1).payload.type,'scope-revised');}
    const failure=result.stderr.match(/\"code\":\"([^\"]+)\"/);
    return {...result,value:startup&&value?{...value,outcome:'recorded'}:value??(failure?{outcome:'rejected',code:failure[1]}:null)};
  };
  const stateFile=path.join(specs,'.reviews','.execution',identity.runId,'state.json');
  const rows=()=>JSON.parse(fs.readFileSync(stateFile)).records;
  return {root,app,specs,answers,identity,scope,added,drive,deliver,stateFile,rows};
}
function blocked(t,options){
  const f=fixture(t,options),r=f.drive('start',{mode:'create'});
  assert.equal(r.status,0,r.stderr);assert.equal(r.value.code,'develop_checks_not_passed',JSON.stringify(r.value));
  f.target=f.drive().value.launchControlTarget;return f;
}
const revise=(f,extra={})=>f.drive('revise_scope',{scope:[...f.scope,f.added],reason:'Approve the local test scope',expectedControl:f.target,...extra});
function reseal(rows){
  return rows.map((row,index)=>{
    const {digest:discard,...body}=row;body.previousDigest=index?rows[index-1].digest:null;
    const next={...body,digest:digest(body)};rows[index]=next;return next;
  });
}
test('real admission single-task CLI adds a path without rebasing 28 business edits',t=>{
  const f=fixture(t,{selected:true}),config=fs.readFileSync(path.join(f.root,'run.json')),policy=fs.readFileSync(path.join(f.root,'control.json'));
  const started=f.drive('start',{mode:'create'});assert.equal(started.status,0,started.stderr);assert.equal(started.value.code,'develop_checks_not_passed');
  const before=f.rows(),target=f.drive().value.launchControlTarget;
  const revised=f.drive('revise_scope',{scope:[...f.scope,f.added],reason:'Include the existing local regression test',expectedControl:target});
  assert.equal(revised.status,0,revised.stderr);assert.equal(revised.value.outcome,'recorded',JSON.stringify(revised.value));
  assert.deepEqual(revised.value.identity,f.identity);assert.deepEqual(revised.value.effectiveScope,[...f.scope,f.added].sort());
  assert.deepEqual(f.rows().slice(0,before.length),before,'all original failure records remain exact');
  const revision=f.rows().at(-1).payload;
  assert.equal(revision.reason,'Include the existing local regression test');
  assert.equal(new Date(revision.at).toISOString(),revision.at);
  const snapshot=f.rows(),history=readRunnerHistory(snapshot,snapshot[0].payload.config,3);
  const original=before[0].payload.baseline;
  for(const file of f.scope)assert.deepEqual(history.original.files.find(row=>row.path===file),original.files.find(row=>row.path===file));
  f.deliver({[f.added]:'new.txt'});
  const delivered=f.drive('start');assert.equal(delivered.status,0,delivered.stderr);assert.equal(delivered.value.state,'awaiting_review',JSON.stringify(delivered.value));
  const rows=f.rows(),checkpoint=rows.findLast(row=>row.payload.type==='effect-checkpoint').payload.checkpoint;
  assert.equal(checkpoint.reviewPackage.changes.length,29);
  assert.deepEqual(checkpoint.reviewPackage.changes.map(item=>item.path),[...f.scope,f.added].sort());
  assert.ok(checkpoint.reviewPackage.changes.every(item=>Buffer.from(item.before.contentBase64,'base64').toString()==='export const value = 0;\n'));
  const handoff=JSON.parse(fs.readFileSync(path.join(f.specs,'.reviews','work-T-001-a1-handoff.json')));
  assert.deepEqual([...handoff.changed_files].sort(),[...f.scope,f.added].sort());
  const decision=f.drive('decision',{packageDigest:delivered.value.packageDigest});assert.equal(decision.value.state,'approved',JSON.stringify(decision.value));
  const complete=f.drive('complete',{packageDigest:decision.value.packageDigest});assert.equal(complete.value.state,'fixture_completed',JSON.stringify(complete.value));
  assert.match(fs.readFileSync(path.join(f.specs,'1.work/tasks.md'),'utf8'),/\[x\] T-001/);
  assert.ok(fs.readFileSync(path.join(f.root,'run.json')).equals(config));assert.ok(fs.readFileSync(path.join(f.root,'control.json')).equals(policy));
});
test('real qa:run policy permits N3 scope recovery; a new file is still a creation diff',t=>{
  const f=blocked(t,{qa:true,selected:true}),newPath='testdata/viewport.json';
  const policy=fs.readFileSync(path.join(f.root,'control.json'));
  assert.equal(revise(f,{scope:[...f.scope,f.added,newPath]}).value.outcome,'recorded');
  const snapshot=f.rows(),history=readRunnerHistory(snapshot,snapshot[0].payload.config,3);
  assert.equal(history.original.files.some(file=>file.path===newPath),false);
  assert.equal(history.scopeRevisions,1);assert.equal(history.state.attempt,1);
  f.deliver({[f.added]:'new.txt',[newPath]:'viewport.txt'});
  fs.writeFileSync(path.join(f.answers,'viewport.txt'),'{"rows":6}\n');
  const next=f.drive('start');assert.equal(next.value.state,'awaiting_review',JSON.stringify(next.value));
  const rows=f.rows(),pkg=readRunnerHistory(rows,rows[0].payload.config,3).state.reviewPackage;
  assert.equal(pkg.changes.length,30);assert.equal(pkg.changes.find(file=>file.path===newPath).before,null);
  assert.equal(Buffer.from(pkg.changes.find(file=>file.path===newPath).after.contentBase64,'base64').toString(),'{"rows":6}\n');
  const decision=f.drive('decision',{packageDigest:next.value.packageDigest});assert.equal(decision.value.state,'approved',JSON.stringify(decision.value));
  const complete=f.drive('complete',{packageDigest:decision.value.packageDigest});assert.equal(complete.value.state,'fixture_completed',JSON.stringify(complete.value));
  assert.ok(fs.readFileSync(path.join(f.root,'control.json')).equals(policy));
});
test('newly scoped unchanged files retain complete bytes and modes in review material',t=>{
  const f=fixture(t),unchanged='unchanged.test.mjs',content='export const untouched = true;\n';
  fs.writeFileSync(path.join(f.app,unchanged),content,{mode:0o755});
  const first=f.drive('start',{mode:'create'});assert.equal(first.value.code,'develop_checks_not_passed');
  f.target=f.drive().value.launchControlTarget;
  assert.equal(revise(f,{scope:[...f.scope,f.added,unchanged]}).value.outcome,'recorded');
  f.deliver({[f.added]:'new.txt'});const delivered=f.drive('start');assert.equal(delivered.value.state,'awaiting_review',JSON.stringify(delivered.value)+'\n'+delivered.stderr);
  const rows=f.rows(),history=readRunnerHistory(rows,rows[0].payload.config,3),pkg=history.state.reviewPackage;
  const material=pkg.unchangedScope.find(file=>file.path===unchanged);assert.equal(material.mode,0o755);
  assert.equal(Buffer.from(material.contentBase64,'base64').toString(),content);readReviewPackage(pkg);
  fs.chmodSync(path.join(f.app,unchanged),0o644);
  assert.throws(()=>verifyReviewPackage({root:f.app,baseline:history.original,checks:history.state.currentChecks,reviewPackage:pkg,expectedDigest:pkg.packageDigest,
    handoffPath:path.join(f.specs,'.reviews','work-T-001-a1-handoff.json')}));
});
test('scope refusal leaves source records intact for stale, shrinking, protected and changed additions',t=>{
  const f=blocked(t),before=fs.readFileSync(f.stateFile);
  const refused=(extra,code)=>{
    const r=revise(f,extra);assert.equal(r.status,71,r.stderr);assert.equal(r.value.code,code,JSON.stringify(r.value));
    assert.ok(fs.readFileSync(f.stateFile).equals(before),'rejection must not append a record');
  };
  refused({expectedControl:{...f.target,revision:'0'.repeat(64)}},'snapshot_changed');
  refused({expectedControl:{...f.target,identity:{...f.identity,taskId:'T-002'}}},'snapshot_changed');
  refused({scope:[f.added]},'scope_revision_shrink');
  refused({scope:f.scope},'scope_revision_no_additions');
  refused({scope:[...f.scope,f.added,f.scope[0]]},'invalid_input');
  refused({scope:[...f.scope,'../escape.mjs']},'invalid_input');
  refused({scope:[...f.scope,'AGENTS.md']},'protected_scope');
  refused({scope:[...f.scope,'.env']},'unsupported_path');
  refused({scope:[...f.scope,'.build/new.mjs']},'excluded_snapshot_path');
  fs.writeFileSync(path.join(f.app,f.added),'changed without scope\n');
  refused({},'scope_revision_source_changed');fs.writeFileSync(path.join(f.app,f.added),'export const value = 0;\n');
  fs.chmodSync(path.join(f.app,f.added),0o755);refused({},'scope_revision_source_changed');fs.chmodSync(path.join(f.app,f.added),0o644);
  fs.unlinkSync(path.join(f.app,f.added));fs.symlinkSync(f.scope[0],path.join(f.app,f.added));refused({},'unsupported_file');
  fs.unlinkSync(path.join(f.app,f.added));fs.writeFileSync(path.join(f.app,f.added),'export const value = 0;\n');
  fs.mkdirSync(path.join(f.app,'alias'));fs.symlinkSync('../'+f.added,path.join(f.app,'alias','test.mjs'));
  refused({scope:[...f.scope,'alias/test.mjs']},'scope_revision_source_changed');
  fs.symlinkSync('.',path.join(f.app,'linked'));refused({scope:[...f.scope,'linked/new.mjs']},'unsupported_path');
  const missing=f.drive('revise_scope',{scope:[...f.scope,f.added],reason:'Scope',expectedControl:undefined});assert.equal(missing.status,71);assert.match(missing.stderr,/invalid_input/);
  const legacy=f.drive('revise_scope',{controlConfig:undefined,scope:[...f.scope,f.added],reason:'Scope',expectedControl:f.target});assert.equal(legacy.status,71);assert.match(legacy.stderr,/invalid_input/);
  assert.equal(revise(f).value.outcome,'recorded');
  assert.equal(revise(f).value.code,'snapshot_changed');
  f.target=f.drive().value.launchControlTarget;assert.equal(revise(f,{scope:[...f.scope,f.added,'another.mjs']}).value.code,'scope_revision_unavailable');
});
test('replay validates the revision source and handles prefixes before and after append without filesystem reads',t=>{
  const f=blocked(t);assert.equal(revise(f).value.outcome,'recorded');
  const rows=f.rows(),config=rows[0].payload.config,last=rows.at(-1);
  assert.equal(last.payload.type,'scope-revised');
  const before=readRunnerHistory(rows.slice(0,-1),config,3),after=readRunnerHistory(rows,config,3);
  assert.equal(before.scopeRevisions,0);assert.equal(after.scopeRevisions,1);assert.deepEqual(after.state,before.state);
  fs.writeFileSync(path.join(f.app,f.added),'later approved edit\n');
  assert.deepEqual(readRunnerHistory(rows,config,3).original,after.original,'replay uses recorded original bytes');
  for(const mutate of [p=>p.previousScopeDigest='0'.repeat(64),p=>p.failedCheckpointDigest='0'.repeat(64),p=>p.baselineDigest='0'.repeat(64),
    p=>p.fromDigest='0'.repeat(64),p=>p.scope=[f.added],p=>p.reason='',p=>p.files[0].mode=0o755,p=>p.files[0].contentBase64=Buffer.from('false').toString('base64')]){
    const bad=structuredClone(rows);mutate(bad.at(-1).payload);assert.throws(()=>readRunnerHistory(reseal(bad),config,3));
  }
  const repeated=structuredClone(rows);repeated.push({...last,id:`runner.${String(rows.length+1).padStart(6,'0')}`,seq:rows.length+1,
    payload:{...last.payload,fromDigest:last.digest}});assert.throws(()=>readRunnerHistory(reseal(repeated),config,3),{code:'scope_revision_unavailable'});
  for(const change of [{state:'ready',code:null},{state:'approved',code:null},{attempt:2},{reviewPackage:{}},{receipt:{}},{receipts:[{}]},
    {reviewInvocation:{}},{priorReview:{verdict:'approved'}},{taskCommit:{}},{cancellationRequested:true},{workflowError:'workflow_error'}])
    assert.throws(()=>scopeRevisionBinding({...before.state,...change},config),{code:'scope_revision_unavailable'});
  for(const policy of [{...config.controlPolicy,development:'provider'},{...config.controlPolicy,bootstrap:'write'},
    {...config.controlPolicy,qa:'run',qaFix:'manual'}])assert.throws(()=>scopeRevisionBinding(before.state,{...config,controlPolicy:policy}),{code:'scope_revision_unavailable'});
});
test('a protected conversation cannot expand its scope through the v2 recovery route',t=>{
  const f=fixture(t,{protectedMode:true,selected:true});
  const status=f.drive('status',{mode:'create'});assert.equal(status.status,0,status.stderr);
  f.target=status.value.launchControlTarget;const before=fs.readFileSync(f.stateFile);
  const r=revise(f);assert.equal(r.status,71,r.stderr);assert.equal(r.value.code,'recovery_launch_unavailable');
  assert.ok(fs.readFileSync(f.stateFile).equals(before));
  const completion=f.drive('completion_rework',{reason:'Synthetic completion request',expectedControl:status.value.controlTarget});
  assert.equal(completion.status,0,completion.stderr);
  assert.equal(completion.value.code,'completion_rework_authorization_required');
  assert.ok(fs.readFileSync(f.stateFile).equals(before));
});
test('a trusted parallel batch cannot revise scope after a failed develop checkpoint',async t=>{
  const f=fixture(t),definition=JSON.parse(fs.readFileSync(path.join(f.root,'run.json')));
  fs.writeFileSync(path.join(f.specs,'1.work/tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n');
  fs.writeFileSync(path.join(f.specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specs)}));
  const {openControlRun,controlLaunchTarget}=await import('./cm-ai-run.mjs');
  const {createCodexDeveloperRun}=await import('../runtime/js/cm-ai/codex-developer-adapter.mjs');
  const parallelSelection={version:1,group:['T-001','T-002']};
  const execution={configuration:{kind:'scope-batch-fixture',controlPolicy:JSON.parse(fs.readFileSync(path.join(f.root,'control.json')))},
    timeoutMs:2000,excludedContexts:['host'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'author',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      fs.writeFileSync(path.join(f.app,f.scope[0]),'export const value = 1;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    check:async()=>[{id:'local',command:['fixture'],outcome:'failed',exitCode:1,evidence:'synthetic failed check'}],
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-1','review-2'],run:async()=>{throw new Error('review must not run');}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host']}};
  let run=await openControlRun(definition,'create',execution,{parallelSelection});
  try{
    const result=await run.controlHost.handle({version:2,operation:'start',requestId:'batch-start',identity:f.identity});
    assert.equal(result.code,'develop_checks_not_passed',JSON.stringify(result));
  }finally{run.close();}
  run=await openControlRun(definition,'resume',execution,{parallelSelection});
  try{
    const status=await run.controlHost.handle({version:2,operation:'status',requestId:'batch-status',identity:f.identity});
    const before=fs.readFileSync(f.stateFile);
    const result=await run.controlHost.handle({version:2,operation:'revise_scope',requestId:'batch-revise',identity:f.identity,
      expectedControl:status.controlTarget,scope:[...f.scope,f.added],reason:'Synthetic requested scope addition'});
    assert.equal(result.code,'scope_revision_authorization_required',JSON.stringify(result));
    const completion=await run.controlHost.handle({version:2,operation:'completion_rework',requestId:'batch-completion',identity:f.identity,
      expectedControl:status.controlTarget,reason:'Synthetic batch completion request'});
    assert.equal(completion.code,'completion_rework_authorization_required',JSON.stringify(completion));
    assert.ok(fs.readFileSync(f.stateFile).equals(before));
  }finally{run.close();}
  const before=fs.readFileSync(f.stateFile);
  for(const recovery of [{scopeRevision:{scope:[...f.scope,f.added],reason:'Explicit batch scope request'}},
    {developmentReworkReason:'Explicit batch development request'}]){
    await assert.rejects(openControlRun(definition,'resume',execution,{parallelSelection,...recovery,
      expectedControl:controlLaunchTarget(JSON.parse(before))}),{code:'recovery_launch_unavailable'});
    assert.ok(fs.readFileSync(f.stateFile).equals(before));
  }
});
test('ready, reviewed and completed runs refuse revisions without replacing evidence',t=>{
  const f=fixture(t);assert.equal(f.drive('status',{mode:'create'}).value.state,'ready');
  f.target=f.drive().value.launchControlTarget;const readyBytes=fs.readFileSync(f.stateFile);
  assert.equal(revise(f).value.code,'scope_revision_unavailable');assert.ok(fs.readFileSync(f.stateFile).equals(readyBytes));
  const g=fixture(t);fs.writeFileSync(path.join(g.app,g.added),'export const value = 1;\n');
  const start=g.drive('start',{mode:'create'});assert.equal(start.value.state,'awaiting_review');
  const deny=()=>{
    g.target=g.drive().value.launchControlTarget;const bytes=fs.readFileSync(g.stateFile);
    assert.equal(revise(g).value.code,'scope_revision_unavailable');assert.ok(fs.readFileSync(g.stateFile).equals(bytes));
  };
  deny();const review=g.drive('decision',{packageDigest:start.value.packageDigest});assert.equal(review.value.state,'approved');
  deny();assert.equal(g.drive('complete',{packageDigest:review.value.packageDigest}).value.state,'fixture_completed');deny();
});
test('pending developer crash prefixes cannot accept an appended scope revision',t=>{
  const f=blocked(t);assert.equal(revise(f).value.outcome,'recorded');
  const rows=f.rows(),config=rows[0].payload.config;
  const checkpoint=rows.findLastIndex(row=>row.payload.type==='effect-checkpoint');
  const prefix=structuredClone(rows.slice(0,checkpoint));
  assert.notEqual(readRunnerHistory(prefix,config,3).pending,null);
  const revision=structuredClone(rows.at(-1));revision.id=`runner.${String(prefix.length+1).padStart(6,'0')}`;
  revision.seq=prefix.length+1;revision.payload.fromDigest=prefix.at(-1).digest;prefix.push(revision);
  assert.throws(()=>readRunnerHistory(reseal(prefix),config,3),{code:'scope_revision_unavailable'});
});
test('v1 baseline reading stays compatible but cannot authorize a scope extension',t=>{
  const f=fixture(t),baseline=captureReviewBaseline({root:f.app,identity:f.identity,scope:f.scope,requirements:['requirements.md'],version:1});
  assert.equal(readReviewBaseline(baseline).version,1);
  assert.throws(()=>extendReviewBaseline(baseline,[...f.scope,f.added],[]),{code:'scope_revision_unsupported_baseline'});
  assert.throws(()=>captureScopeRevisionSources(f.app,baseline,[...f.scope,'new.mjs']),{code:'scope_revision_unsupported_baseline'});
  const legacyIgnore=captureReviewBaseline({root:f.app,identity:f.identity,scope:f.scope,requirements:['requirements.md']},false,1);
  assert.equal(readReviewBaseline(legacyIgnore).ignorePolicy.version,1,'ordinary legacy reading remains compatible');
  assert.throws(()=>extendReviewBaseline(legacyIgnore,[...f.scope,'new.mjs'],[]),{code:'scope_revision_unsupported_baseline'},
    'legacy ignore evidence has no frozen omitted-path inventory');
});
test('replay refuses additions excluded by the creation baseline',t=>{
  const f=fixture(t);
  const git=spawnSync('git',['-C',f.app,'init','-b','main'],{encoding:'utf8'});assert.equal(git.status,0,git.stderr);
  fs.writeFileSync(path.join(f.app,'.gitignore'),'ignored/\nignored-file.mjs\n');
  fs.mkdirSync(path.join(f.app,'ignored'));fs.writeFileSync(path.join(f.app,'ignored','existing.mjs'),'ignored source\n');
  fs.writeFileSync(path.join(f.app,'ignored-file.mjs'),'ignored source\n');
  fs.mkdirSync(path.join(f.app,'Pods','Pods.xcodeproj'),{recursive:true});
  fs.writeFileSync(path.join(f.app,'Pods','Manifest.lock'),'synthetic lock\n');fs.writeFileSync(path.join(f.app,'Podfile.lock'),'synthetic lock\n');
  const start=f.drive('start',{mode:'create'});assert.equal(start.value.code,'develop_checks_not_passed',JSON.stringify(start.value));
  f.target=f.drive().value.launchControlTarget;
  const excluded=['node_modules/new.mjs','.venv/new.py','__pycache__/new.py','.build/new.mjs','.swiftpm/new.mjs',
    '.DS_Store','ignored/new.mjs','ignored-file.mjs','Pods/new.mjs'];
  const originalBytes=fs.readFileSync(f.stateFile);
  for(const name of excluded){
    const result=revise(f,{scope:[...f.scope,f.added,name]});assert.equal(result.value.code,'excluded_snapshot_path',name);
    assert.ok(fs.readFileSync(f.stateFile).equals(originalBytes));
  }
  assert.equal(revise(f).value.outcome,'recorded');
  const rows=f.rows(),config=rows[0].payload.config,baseline=rows[0].payload.baseline;
  assert.ok(baseline.ignorePolicy.ignoredPaths.includes('ignored-file.mjs'));
  assert.ok(baseline.ignorePolicy.ignoredDirectories.includes('ignored'));
  for(const name of excluded){
    const altered=structuredClone(rows);altered.at(-1).payload.scope.push(name);altered.at(-1).payload.scope.sort();
    assert.throws(()=>readRunnerHistory(reseal(altered),config,3),{code:'excluded_snapshot_path'},name);
  }
});
test('scope revisions reject ignored case aliases and preserve directory boundaries',t=>{
  const f=fixture(t);
  const git=spawnSync('git',['-C',f.app,'init','-b','main'],{encoding:'utf8'});assert.equal(git.status,0,git.stderr);
  fs.writeFileSync(path.join(f.app,'.gitignore'),'ignored/\nignored-file.mjs\n');
  fs.mkdirSync(path.join(f.app,'ignored'));fs.writeFileSync(path.join(f.app,'ignored','existing.mjs'),'ignored source\n');
  fs.writeFileSync(path.join(f.app,'ignored-file.mjs'),'ignored source\n');
  assert.equal(f.drive('start',{mode:'create'}).value.code,'develop_checks_not_passed');
  f.target=f.drive().value.launchControlTarget;
  const excluded=['IGNORED/new.mjs','IgNoReD/nested/new.mjs','IGNORED-FILE.MJS','IgNoReD-FiLe.mjs',
    'ignored','IGNORED','IgNoReD','ignored/new.mjs'];
  const originalBytes=fs.readFileSync(f.stateFile);
  for(const name of excluded){
    const result=revise(f,{scope:[...f.scope,f.added,name]});assert.equal(result.value.code,'excluded_snapshot_path',name);
    assert.ok(fs.readFileSync(f.stateFile).equals(originalBytes));
  }
  const adjacent=['ignored-other/new.mjs','IGNOREDNESS/new.mjs','ignored-file.mjs-extra'];
  assert.equal(revise(f,{scope:[...f.scope,f.added,...adjacent]}).value.outcome,'recorded');
  const rows=f.rows(),config=rows[0].payload.config;
  assert.deepEqual(readRunnerHistory(rows,config,3).effectiveScope,[...f.scope,f.added,...adjacent].sort());
  for(const name of excluded){
    const altered=structuredClone(rows);altered.at(-1).payload.scope.push(name);altered.at(-1).payload.scope.sort();
    assert.throws(()=>readRunnerHistory(reseal(altered),config,3),{code:'excluded_snapshot_path'},name);
  }
  // A frozen directory exclusion stands on its own, even without an exact-path row.
  const {baselineDigest:discard,...directoryOnly}=structuredClone(rows[0].payload.baseline);
  directoryOnly.ignorePolicy.ignoredPaths=[];
  const baseline={...directoryOnly,baselineDigest:digest(directoryOnly)};
  for(const name of ['ignored','IGNORED','ignored/new.mjs','IGNORED/new.mjs']){
    assert.throws(()=>extendReviewBaseline(baseline,[...f.scope,name],[]),{code:'excluded_snapshot_path'},name);
    assert.throws(()=>captureScopeRevisionSources(f.app,baseline,[...f.scope,name]),{code:'excluded_snapshot_path'},name);
  }
  assert.deepEqual(captureScopeRevisionSources(f.app,baseline,[...f.scope,...adjacent]),[]);
  assert.deepEqual(extendReviewBaseline(baseline,[...f.scope,...adjacent],[]).scope,[...baseline.scope,...adjacent].sort());
});
