// A completed task may finish its approving review after another task has
// delivered unrelated code. Prove the entire ordered chain from a trusted
// first-review anchor; matching the current file to an old after-state is not
// sufficient evidence.
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
import {approvedReviewAt,completedReviewedDeliveries} from '../runtime/js/cm-ai/reviewed-deliveries.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {explainCompletedDelivery,firstReviewAt} from '../runtime/js/cm-ai/fix-code-association.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-prefinal-delivery-'));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(isolated,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(isolated,{recursive:true,force:true});
});
const checks=[{id:'synthetic',command:['true'],outcome:'passed',exitCode:0,evidence:'Synthetic fixture'}];

function unitRoot(files={'parent.mjs':'0\n','other.mjs':'A\n'}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'unit-')));
  const edit=changes=>{for(const [name,value] of Object.entries(changes)){
    const file=path.join(root,name);
    if(value===null)fs.rmSync(file);else if(typeof value==='number')fs.chmodSync(file,value);
    else fs.writeFileSync(file,value);
  }};
  edit({...files,'req.md':'Synthetic requirements\n'});
  const write=(runId,scope,changes)=>{
    const baseline=captureReviewBaseline({root,identity:{repositoryId:'fixture',runId,taskId:`T-${runId}`,attempt:1},
      scope,requirements:['req.md']});
    edit(changes);
    return {baseline,pkg:createReviewPackage({root,baseline,checks})};
  };
  return {root,edit,write};
}
const delivered=(runId,item,reviewedAt)=>({runId,packages:[{pkg:item.pkg,reviewedAt}]});
const inspect=(f,parent,deliveries,extra={})=>explainCompletedDelivery({root:f.root,baseline:parent.baseline,
  parentPackage:parent.pkg,since:10,after:30,deliveries,...extra});

test('the lower anchor uses the first validated registration for exactly this task identity',()=>{
  const identity={repositoryId:'fixture',runId:'parent',taskId:'T-parent',attempt:2};
  const registration=(registeredAt,extra={})=>({payload:{protocol:'cm-task-runner',version:3,type:'review-invocation-registered',
    registeredAt,binding:{identity:{...identity,attempt:1}},...extra}});
  assert.equal(firstReviewAt([registration(10),registration(30)],identity),10);
  assert.equal(firstReviewAt([],identity),null);
  for(const extra of [{version:2},{registeredAt:10.5},{protocol:'other-protocol'},
    ...['repositoryId','runId','taskId'].map(key=>({binding:{identity:{...identity,[key]:'different'}}})),
    {binding:{identity:{...identity,attempt:0}}}]){
    assert.equal(firstReviewAt([registration(10,extra),registration(30)],identity),null);
  }
});

test('a completed delivery between the first and final parent reviews explains unrelated code',()=>{
  const f=unitRoot(),parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const early=f.write('early',['other.mjs'],{'other.mjs':'B\n'});
  assert.doesNotThrow(()=>inspect(f,parent,[delivered('early',early,20)]));
});

test('all early deliveries compose in review order before the parent and every later delivery',()=>{
  const f=unitRoot(),parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const one=f.write('one',['other.mjs'],{'other.mjs':'B\n'});
  const two=f.write('two',['other.mjs'],{'other.mjs':'C\n'});
  const later=f.write('later',['other.mjs','parent.mjs'],{'other.mjs':'D\n','parent.mjs':'2\n'});
  const deliveries=[delivered('later',later,40),delivered('two',two,25),delivered('one',one,20)];
  assert.doesNotThrow(()=>inspect(f,parent,deliveries));
  assert.throws(()=>inspect(f,parent,deliveries.filter(item=>item.runId!=='one')));
  assert.throws(()=>inspect(f,parent,deliveries.filter(item=>item.runId!=='two')));
  f.edit({'other.mjs':'C\n'});
  assert.throws(()=>inspect(f,parent,deliveries),'a completed later delivery cannot be omitted to match current content');
});

test('the early window is open at both anchors and requires a valid earlier first-review time',()=>{
  const f=unitRoot(),parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const early=f.write('early',['other.mjs'],{'other.mjs':'B\n'});
  for(const reviewedAt of [0,10,30])assert.throws(()=>inspect(f,parent,[delivered('early',early,reviewedAt)]),String(reviewedAt));
  for(const since of [undefined,null,NaN,9.5,30,31])
    assert.throws(()=>inspect(f,parent,[delivered('early',early,20)],{since}),String(since));
  for(const after of [null,NaN,29.5])
    assert.throws(()=>inspect(f,parent,[delivered('early',early,20)],{after}),String(after));
  assert.doesNotThrow(()=>inspect(f,parent,[delivered('early',early,20)]));
});

test('the historical strict proof succeeds without reconsidering irrelevant early packages',()=>{
  const f=unitRoot(),parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const bad={...parent.pkg,packageDigest:'0'.repeat(64)};
  assert.doesNotThrow(()=>inspect(f,parent,[{runId:'irrelevant',packages:[{pkg:bad,reviewedAt:20}]}]));
  const later=f.write('later',['other.mjs'],{'other.mjs':'B\n'});
  assert.doesNotThrow(()=>inspect(f,parent,[{runId:'irrelevant',packages:[{pkg:bad,reviewedAt:20}]},delivered('later',later,40)]));
});

test('early changes to parent scope never override the parent final reviewed bytes, including unchanged scope',()=>{
  const f=unitRoot({'parent.mjs':'0\n','unchanged.mjs':'stable\n','other.mjs':'A\n'});
  const parent=f.write('parent',['parent.mjs','unchanged.mjs'],{'parent.mjs':'1\n'});
  // The other task saw the original parent bytes, and its complete early chain
  // is valid. The parent's own final review is authoritative for its full scope.
  f.edit({'parent.mjs':'0\n'});
  const early=f.write('early',['parent.mjs','unchanged.mjs','other.mjs'],
    {'parent.mjs':'2\n','unchanged.mjs':'different\n','other.mjs':'B\n'});
  const deliveries=[delivered('early',early,20)];
  f.edit({'parent.mjs':'1\n','unchanged.mjs':'stable\n'});
  assert.doesNotThrow(()=>inspect(f,parent,deliveries));
  f.edit({'parent.mjs':'2\n'});
  assert.throws(()=>inspect(f,parent,deliveries),'an early after-state cannot hide a rollback of the final parent');
  f.edit({'parent.mjs':'1\n','unchanged.mjs':'different\n'});
  assert.throws(()=>inspect(f,parent,deliveries),'unchanged parent scope is still bound to the final review');
});

test('early A to B to A does not justify a later manual return to B or a discontinuous package',()=>{
  const f=unitRoot({'parent.mjs':'0\n','other.mjs':'A\n','marker.mjs':'0\n'});
  const parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const one=f.write('one',['other.mjs','marker.mjs'],{'other.mjs':'B\n','marker.mjs':'1\n'});
  const two=f.write('two',['other.mjs'],{'other.mjs':'A\n'});
  const deliveries=[delivered('one',one,15),delivered('two',two,20)];
  assert.doesNotThrow(()=>inspect(f,parent,deliveries));
  f.edit({'other.mjs':'B\n'});
  assert.throws(()=>inspect(f,parent,deliveries),'must not select only the historical package whose after-state happens to match');
  f.edit({'other.mjs':'unreviewed gap\n'});
  const gap=f.write('gap',['other.mjs'],{'other.mjs':'C\n'});
  assert.throws(()=>inspect(f,parent,[...deliveries,delivered('gap',gap,25)]),'each early before-state is mandatory');
});

test('a digest mismatch or another code root cannot explain the current early drift',()=>{
  const f=unitRoot(),parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const early=f.write('early',['other.mjs'],{'other.mjs':'B\n'});
  assert.throws(()=>inspect(f,parent,[delivered('early',{pkg:{...early.pkg,packageDigest:'0'.repeat(64)}},20)]));
  const other=unitRoot(),foreign=other.write('foreign',['other.mjs'],{'other.mjs':'B\n'});
  assert.throws(()=>inspect(f,parent,[delivered('foreign',foreign,20)]));
});

test('early additions, deletions and executable mode changes require the exact resulting inventory',()=>{
  const f=unitRoot({'parent.mjs':'0\n','remove.mjs':'gone\n','mode.mjs':'export const n=1;\n'});
  const parent=f.write('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const changes={'added.mjs':'new\n','remove.mjs':null,...(process.platform==='win32'?{}:{'mode.mjs':0o755})};
  const early=f.write('early',Object.keys(changes),changes),deliveries=[delivered('early',early,20)];
  assert.doesNotThrow(()=>inspect(f,parent,deliveries));
  f.edit({'remove.mjs':'gone\n'});assert.throws(()=>inspect(f,parent,deliveries));f.edit({'remove.mjs':null});
  f.edit({'added.mjs':'manual\n'});assert.throws(()=>inspect(f,parent,deliveries));f.edit({'added.mjs':'new\n'});
  if(process.platform!=='win32'){
    f.edit({'mode.mjs':0o644});assert.throws(()=>inspect(f,parent,deliveries));f.edit({'mode.mjs':0o755});
  }
  assert.doesNotThrow(()=>inspect(f,parent,deliveries));
});

const events=(onEvent,thread)=>{
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
};

async function twoReviewFixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'integration-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');fs.mkdirSync(codeProject);
  for(const [feature,task] of [['1.parent','T-001'],['2.other','T-002']]){
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
    for(const name of ['requirements','design'])fs.writeFileSync(path.join(specsDir,feature,`${name}.md`),'# Synthetic fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),`- [ ] ${task}: implement\n`);
  }
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.parent','2.other'],
    specFiles:buildManifest(specsDir)}));
  const edit=(file,bytes)=>fs.writeFileSync(path.join(codeProject,file),bytes);
  edit('parent.mjs','export const n=0;\n');edit('other.mjs','export const n=0;\n');edit('req.md','Synthetic requirement\n');
  edit('.cm-workflow.json',JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const calls={develop:0,review:0,check:0},definitions={},executions={};
  for(const [name,task] of [['parent','T-001'],['other','T-002']]){
    const identity={repositoryId:'fixture',runId:`${name}-run`,taskId:task,attempt:1};
    definitions[name]={version:1,specsDir,codeProject,feature:name==='parent'?'1.parent':'2.other',identity,
      featureSelection:{version:1,feature:name==='parent'?'1.parent':'2.other'},
      scope:[`${name}.mjs`],requirements:['req.md']};
    let develops=0;
    const check=createHostCheck({cwd:codeProject,commands:[{id:'syntax',command:[process.execPath,'--check',`${name}.mjs`]}]});
    executions[name]={configuration:{kind:'synthetic-prefinal-delivery'},timeoutMs:3000,excludedContexts:['fixture-host'],
      developer:{provider:'codex',requestedModel:'synthetic',contextId:`${name}-author`,
        run:createCodexDeveloperRun({requestedModel:'synthetic',worker:async()=>{
          calls.develop++;develops++;edit(`${name}.mjs`,`export const n=${develops};\n`);
          return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
            retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
        }})},
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
        contexts:[`${name}-review-1`,`${name}-review-2`],run:async(request,{onEvent})=>{
          calls.review++;events(onEvent,`synthetic-${request.identity.runId}-${request.identity.attempt}`);
          const revise=name==='parent'&&request.identity.attempt===1;
          return {status:'succeeded',value:{verdict:revise?'changes_requested':'approved',
            packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),
            findings:revise?[{id:'F1',severity:'P2',path:'parent.mjs',message:'Use the second value',evidence:'Synthetic first-round finding'}]:[],
            summary:'Synthetic review'}};
        }}],
      reviewInvocation:{developerThreadId:`${name}-author`,excludedThreadIds:['fixture-host']},
      check:async(...args)=>{calls.check++;return check(...args);},applicableAgentFiles:[]};
  }
  const statePath=name=>path.join(specsDir,'.reviews','.execution',definitions[name].identity.runId,'state.json');
  const history=name=>{
    const saved=JSON.parse(fs.readFileSync(statePath(name),'utf8'));
    return {saved,...readRunnerHistory(saved.records,saved.records[0].payload.config,3)};
  };
  const request=(name,operation,attempt=1,extra={})=>({version:1,requestId:`${name}-${operation}-${attempt}`,operation,
    identity:{...definitions[name].identity,attempt},...extra});
  const invoke=async(run,name,operation,attempt=1,extra={})=>{
    assert.ok(run.host,JSON.stringify(run.blocked));
    return run.host.handle(request(name,operation,attempt,extra));
  };
  let parent,other;
  try{
    parent=await openControlRun(definitions.parent,'create',executions.parent);
    const first=await invoke(parent,'parent','start');assert.equal(first.state,'awaiting_review',JSON.stringify(first));
    const rejected=await invoke(parent,'parent','decision',1,{packageDigest:first.packageDigest});
    assert.equal(rejected.state,'changes_requested',JSON.stringify(rejected));
    const second=await invoke(parent,'parent','resume',2);assert.equal(second.state,'awaiting_review',JSON.stringify(second));
    parent.close();parent=null;

    // The second parent's candidate exists before this independent task begins.
    // Its review registers between the parent's two review registrations.
    other=await openControlRun(definitions.other,'create',executions.other);
    const start=await invoke(other,'other','start');assert.equal(start.state,'awaiting_review',JSON.stringify(start));
    const approved=await invoke(other,'other','decision',1,{packageDigest:start.packageDigest});
    assert.equal(approved.state,'approved',JSON.stringify(approved));other.close();other=null;
    const reviewedOther=fs.readFileSync(path.join(codeProject,'other.mjs'));
    // Fixture-only shelving: the parent's final review still checks its own
    // original code inventory. Then restore the other's exact reviewed bytes
    // and finish that task through the normal owner. No unreviewed edit remains.
    edit('other.mjs','export const n=0;\n');
    parent=await openControlRun(definitions.parent,'resume',executions.parent);
    const finalReview=await invoke(parent,'parent','decision',2,{packageDigest:second.packageDigest});
    assert.equal(finalReview.state,'approved',JSON.stringify(finalReview));
    const completed=await invoke(parent,'parent','complete',2,{packageDigest:second.packageDigest});
    assert.equal(completed.state,'fixture_completed',JSON.stringify(completed));parent.close();parent=null;
    edit('other.mjs',reviewedOther);
    const approvedBytes=fs.readFileSync(statePath('other'));
    // Discovery must not count an approved review before normal task completion.
    assert.deepEqual(completedReviewedDeliveries({specsRoot:specsDir,root:codeProject,identity:definitions.parent.identity}),[]);
    other=await openControlRun(definitions.other,'resume',executions.other);
    const delivered=await invoke(other,'other','complete',1,{packageDigest:start.packageDigest});
    assert.equal(delivered.state,'fixture_completed',JSON.stringify(delivered));other.close();other=null;
    return {root,codeProject,specsDir,calls,definitions,executions,statePath,history,request,approvedBytes};
  }finally{parent?.close();other?.close();}
}

test('real two-review resume proves the early completed delivery without changing history or provider counts',{timeout:30000},async()=>{
  const f=await twoReviewFixture(),parent=f.history('parent');
  const registrations=parent.saved.records.filter(row=>row.payload.type==='review-invocation-registered');
  assert.equal(registrations.length,2);
  const first=registrations[0].payload.registeredAt;
  const final=approvedReviewAt(parent.state);
  const deliveries=completedReviewedDeliveries({specsRoot:f.specsDir,root:f.codeProject,identity:f.definitions.parent.identity});
  assert.equal(deliveries.length,1);
  assert(first<deliveries[0].packages[0].reviewedAt&&deliveries[0].packages[0].reviewedAt<final);
  const before=fs.readFileSync(f.statePath('parent')),counts={...f.calls};
  const status=async()=>{
    const run=await openControlRun(f.definitions.parent,'resume',f.executions.parent);
    try{return await run.host.handle(f.request('parent','status',2));}finally{run.close();}
  };
  const accepted=await status();
  assert.deepEqual([accepted.state,accepted.code,accepted.identity.attempt],['fixture_completed',null,2],JSON.stringify(accepted));
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),before);assert.deepEqual(f.calls,counts);
  // A reviewed but unfinished run cannot justify the same current bytes.
  const completedBytes=fs.readFileSync(f.statePath('other'));
  try{
    fs.writeFileSync(f.statePath('other'),f.approvedBytes);
    const refused=await status();assert.equal(refused.code,'correction_review_required');
  }finally{fs.writeFileSync(f.statePath('other'),completedBytes);}
  // Discovery preserves repository, task and code-root identity boundaries.
  const discover=overrides=>completedReviewedDeliveries({specsRoot:f.specsDir,root:f.codeProject,
    identity:f.definitions.parent.identity,...overrides});
  assert.deepEqual(discover({identity:{...f.definitions.parent.identity,repositoryId:'other-repository'}}),[]);
  assert.deepEqual(discover({identity:{...f.definitions.parent.identity,taskId:'T-002'}}),[]);
  assert.deepEqual(discover({root:path.join(f.root,'other-root')}),[]);
  fs.writeFileSync(path.join(f.codeProject,'other.mjs'),'export const n=99;\n');
  const unreviewed=await status();assert.equal(unreviewed.code,'correction_review_required');
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),before);assert.deepEqual(f.calls,counts);
});
