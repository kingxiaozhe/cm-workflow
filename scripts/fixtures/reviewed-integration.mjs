// Synthetic fixture support. Every provider response and verification receipt
// below is test data, never a real review or product completion claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildManifest} from '../cm-spec-manifest.mjs';
import {openControlRun} from '../cm-ai-run.mjs';
import {createDeveloperRun} from '../../runtime/js/cm-ai/developer-adapter.mjs';
import {createHostCheck} from '../../runtime/js/cm-ai/host-check.mjs';
import {createHostHandoff} from '../../runtime/js/cm-ai/host-handoff.mjs';
import {createHostReviewAuthority} from '../../runtime/js/cm-ai/host-review-authority.mjs';
import {captureReviewBaseline,createReviewPackage} from '../../runtime/js/cm-ai/review-package.mjs';
import {reviewPaths} from '../../runtime/js/cm-ai/review-runner.mjs';
import {readExecutionSnapshot} from '../../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../../runtime/js/cm-ai/durable-runner-state.mjs';
import {digest} from '../../runtime/js/cm-ai/effect-contract.mjs';
import {createFixFinalReview,fixFinalReviewConfiguration} from '../../runtime/js/cm-fix/final-review.mjs';

export const canonical=value=>JSON.stringify(value)+'\n';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const fileRecord=(name,bytes,mode=0o644)=>({path:name,type:'file',mode,size:Buffer.byteLength(bytes),sha256:sha(bytes)});
export const syntheticEvents=(onEvent,thread)=>{
  for(const event of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
    {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},
    {event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
};
const checks=[{id:'synthetic',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Synthetic fixture only'}];

function git(cwd,...args){
  const run=spawnSync('/usr/bin/git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],
    {cwd,encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);return run.stdout.trim();
}
function put(root,file,bytes){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),bytes);}

export async function syntheticIntegrationReview(root,plan,documentBytes,{includeVerification=true,threadId='synthetic-integration-review-thread',snapshotEvidence=null}={}){
  const proofRoot=fs.mkdtempSync(path.join(root,'proof-'));
  const planPath='integration/plan.json',probe='integration/probe.mjs';
  put(proofRoot,planPath,canonical(plan));put(proofRoot,probe,'export const probe=0;\n');
  const requirements=[planPath];
  if(snapshotEvidence!==null){
    const provenancePath='integration/snapshot-provenance.json';
    put(proofRoot,provenancePath,snapshotEvidence.provenance);requirements.push(provenancePath);
    for(const [hash,bytes] of Object.entries(snapshotEvidence.contents)){
      assert.match(hash,/^[a-f0-9]{64}$/);assert.equal(sha(bytes),hash);
      const name=`integration/snapshots/${hash}.txt`;put(proofRoot,name,bytes);requirements.push(name);
    }
  }
  for(const [file,bytes] of Object.entries(documentBytes))put(proofRoot,`integration/documents/${file}`,bytes.before);
  const identity={repositoryId:plan.target.identity.repositoryId,runId:'synthetic-integration-review',taskId:'T-FIX-integration',attempt:1};
  const baseline=captureReviewBaseline({root:proofRoot,identity,
    scope:[probe,...Object.keys(documentBytes).map(file=>`integration/documents/${file}`)],requirements});
  put(proofRoot,probe,'export const probe=1;\n');
  for(const [file,bytes] of Object.entries(documentBytes))put(proofRoot,`integration/documents/${file}`,bytes.after);
  const handoffPath=path.join(root,`synthetic-handoff-${path.basename(proofRoot)}.json`);
  createHostHandoff({root:proofRoot,baseline,checks,handoffPath,
    evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson','Synthetic integration test only']});
  const pkg=createReviewPackage({root:proofRoot,baseline,checks,handoffPath});
  const materials=[...pkg.changes.filter(c=>c.after).map(c=>({...c.after,path:c.path})),
    ...(pkg.unchangedScope??[]),...pkg.requirements,...(pkg.instructions??[])];
  const files=[...new Map(materials.map(file=>[file.path,{path:file.path,sha256:file.sha256,mode:file.mode}])).values()]
    .sort((a,b)=>a.path.localeCompare(b.path));
  const verification={files:files.map(file=>file.path),checks:[{id:'unit',command:[process.execPath,'--check',probe]}],
    mutationPaths:[probe],timeoutMs:1000};
  const causeReview={reviewerId:'synthetic-cause-reviewer',adapterId:'claude-cause-review-adapter',provider:'claude',
    requestedModel:'synthetic',contextId:'synthetic-cause-review',excludedThreadIds:[]};
  const configuration=fixFinalReviewConfiguration({hostContextId:plan.author.contextId,causeReview,
    ...(includeVerification?{reviewVerification:verification}:{})});
  const authority=createHostReviewAuthority({hostContextId:configuration.hostContextId,
    reviewerId:configuration.reviewer.reviewerId,adapterId:configuration.reviewer.adapterId,
    decide:async()=>({status:'approved'})});
  await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
  let registration,started;
  const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:1000},{authorize:authority.authorize,
    async run(request,{onEvent,onVerification}){
      syntheticEvents(onEvent,threadId);
      if(includeVerification){
        const before=files.find(file=>file.path===probe).sha256;
        onVerification({version:1,requestDigest:request.requestDigest,packageDigest:pkg.packageDigest,
          profileDigest:digest(verification),providerThreadId:threadId,files,snapshotDigest:digest(files),
          checks:[{id:'unit',commandDigest:digest(verification.checks[0].command),exitCode:0,outputSha256:sha('synthetic check'),startedAt:1,endedAt:2}],
          mutations:[{path:probe,beforeSha256:before,afterSha256:sha('synthetic mutation'),checkId:'unit',
            baselineExitCode:0,mutatedExitCode:1,restoredExitCode:0,restoredSha256:before,startedAt:3,endedAt:4}]});
      }
      return {status:'succeeded',value:{verdict:'approved',packageDigest:pkg.packageDigest,
        examinedPaths:reviewPaths(pkg),findings:[],summary:'Synthetic integration test observation, not independent review'}};
    }});
  const result=await review({signal:new AbortController().signal,register(value){registration=value;},onStarted(value){started=value;}});
  assert.equal(result.inspection?.review?.verdict,'approved',JSON.stringify(result));
  return {configuration,registration,started,result:result.value};
}

export async function createReviewedIntegrationFixture(t,{unrelated=false,premature=false,controlPolicy=null,sourceBeforeRename=false,providerDevelopment=false,developerProvider='claude'}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-reviewed-integration-')));
  const env={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
  process.env.CM_WORKFLOW_HOME=path.join(root,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'logs');
  t.after(()=>{
    for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    fs.rmSync(root,{recursive:true,force:true});
  });
  const codeProject=path.join(root,'code'),sourceRoot=path.join(root,'source'),specsDir=path.join(root,'specs');
  fs.mkdirSync(codeProject);
  const originalFiles={'parent.mjs':'export const parent=0;\n','source.mjs':'export const source=0;\n',
    'next.mjs':'export const next=0;\n','docs/guide.md':'# Guide\n','req.md':'Synthetic requirements\n',
    'package.json':canonical({name:'oldrepo'}),'.cm-workflow.json':canonical({version:1,policies:{delivery:'diff'}})};
  for(const [file,bytes] of Object.entries(originalFiles))put(codeProject,file,bytes);
  git(codeProject,'init','--quiet');git(codeProject,'add','.');
  git(codeProject,'-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Synthetic baseline');
  git(codeProject,'worktree','add','--quiet','--detach',sourceRoot);
  const names=['parent','cross','rename','renamed',...(premature?['premature']:[]),...(unrelated?['unrelated']:[])];
  const features=names.map((name,index)=>`${index+1}.${name}`);
  for(const [index,name] of names.entries()){
    const feature=features[index],taskId=`T-${String(index+1).padStart(3,'0')}`;
    for(const file of ['requirements.md','design.md'])put(specsDir,`${feature}/${file}`,'# Synthetic fixture\n');
    put(specsDir,`${feature}/tasks.md`,`- [ ] ${taskId}: implement ${name}\n`);
  }
  put(specsDir,'.cm-specs-status',canonical({status:'approved',features,specFiles:buildManifest(specsDir)}));
  let unrelatedRoot=null;
  if(unrelated){
    unrelatedRoot=path.join(root,'unrelated');fs.mkdirSync(unrelatedRoot);
    for(const [file,bytes] of Object.entries(originalFiles))put(unrelatedRoot,file,bytes);
    git(unrelatedRoot,'init','--quiet');git(unrelatedRoot,'add','.');
    git(unrelatedRoot,'-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Separate synthetic baseline');
  }
  const calls={develop:0,review:0,check:0},definitions={},executions={},approvedBytes={};let sealed=false;
  const changes={parent:{'parent.mjs':'export const parent=1;\n','docs/guide.md':'# Guide\nParent reviewed paragraph.\n'},
    cross:{'source.mjs':'export const source=1;\n'},rename:{'package.json':canonical({name:'newrepo'})},
    renamed:{'next.mjs':'export const next=1;\n'},premature:{'next.mjs':'export const next=1;\n'},unrelated:{'source.mjs':'export const source=1;\n'}};
  const statePath=name=>path.join(specsDir,'.reviews','.execution',definitions[name].identity.runId,'state.json');
  const snapshot=name=>readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:definitions[name].identity.repositoryId,
    runId:definitions[name].identity.runId}});
  const history=name=>{const saved=snapshot(name);return {saved,...readRunnerHistory(saved.records,saved.records[0].payload.config,3)};};
  const request=(name,operation,extra={})=>({version:1,requestId:`synthetic-${name}-${operation}`,operation,identity:definitions[name].identity,...extra});
  for(const [index,name] of names.entries()){
    const targetRoot=name==='cross'?sourceRoot:name==='unrelated'?unrelatedRoot:codeProject;
    const identity={repositoryId:['renamed','premature'].includes(name)?'newrepo':'oldrepo',runId:`integration-${name}`,taskId:`T-${String(index+1).padStart(3,'0')}`,attempt:1};
    definitions[name]={version:1,specsDir,codeProject:targetRoot,feature:features[index],identity,
      featureSelection:{version:1,feature:features[index]},scope:Object.keys(changes[name]),requirements:['req.md']};
    const check=createHostCheck({cwd:targetRoot,commands:[{id:'syntax',command:[process.execPath,'--check','parent.mjs']}]});
    executions[name]={configuration:{kind:'synthetic-integration-fixture',...(controlPolicy?{controlPolicy}:{}),
      ...(providerDevelopment?{providerDevelopment:true}:{})},timeoutMs:3000,excludedContexts:['synthetic-host'],
      developer:{provider:developerProvider,requestedModel:'synthetic',contextId:`${name}-author`,
        run:createDeveloperRun({provider:developerProvider,requestedModel:'synthetic',worker:async()=>{
          assert.equal(sealed,false,'adoption must not call a developer');calls.develop++;
          for(const [file,bytes] of Object.entries(changes[name]))put(targetRoot,file,bytes);
          return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
            retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
        }})},
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'synthetic',allowed:true,available:true,
        contexts:[`${name}-review-1`,`${name}-review-2`],run:async(reviewRequest,{onEvent})=>{
          assert.equal(sealed,false,'adoption must not call a reviewer');calls.review++;
          syntheticEvents(onEvent,`synthetic-${name}-review-thread`);
          return {status:'succeeded',value:{verdict:'approved',packageDigest:reviewRequest.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(reviewRequest.payload.reviewPackage),findings:[],summary:'Synthetic fixture review'}};
        }}],reviewInvocation:{developerThreadId:`${name}-author`,excludedThreadIds:['synthetic-host']},
      check:async(...args)=>{assert.equal(sealed,false,'adoption must not execute checks');calls.check++;return check(...args);},applicableAgentFiles:[]};
  }
  // All operations use real durable V3 owners. No journal is fabricated to make
  // a source eligible, and no product provider is invoked.
  const runOrder=sourceBeforeRename?names.filter(name=>name!=='rename').concat('rename'):
    premature?['parent','cross','premature',...names.filter(name=>!['parent','cross','premature'].includes(name))]:names;
  for(const name of runOrder){
    const run=await openControlRun(definitions[name],'create',executions[name]);
    try{
      assert.ok(run.host,JSON.stringify(run.blocked));
      const start=await run.host.handle(request(name,'start'));assert.equal(start.state,'awaiting_review',JSON.stringify(start));
      const decision=await run.host.handle(request(name,'decision',{packageDigest:start.packageDigest}));
      assert.equal(decision.state,'approved',JSON.stringify(decision));approvedBytes[name]=fs.readFileSync(statePath(name));
      const complete=await run.host.handle(request(name,'complete',{packageDigest:start.packageDigest}));
      assert.equal(complete.state,'fixture_completed',JSON.stringify(complete));
    }finally{run.close();}
    // Fixture-only shelving retains a valid historical package with an earlier
    // new-name review. The later legitimate source starts from the same bytes.
    if(name==='premature')put(codeProject,'next.mjs',originalFiles['next.mjs']);
  }
  sealed=true;
  const parent=history('parent'),before=changes.parent['docs/guide.md'],after=before+'Reviewed integration paragraph.\n';
  const documents={'docs/guide.md':{before,after}};
  const makePlan=(targetName='parent',sourceNames=['cross','renamed'],withDocument=true)=>{
    const target=history(targetName);
    return {version:1,kind:'cm-reviewed-integration-v1',author:{provider:'codex',contextId:'synthetic-integration-author'},target:{identity:target.state.reviewPackage.identity,
      rootDigest:target.original.rootDigest,baselineDigest:target.original.baselineDigest,packageDigest:target.state.reviewPackage.packageDigest,
      recordCount:target.saved.records.length,lastDigest:target.saved.records.at(-1).digest},
      sources:sourceNames.map(name=>{const source=history(name);return {identity:source.state.reviewPackage.identity,
        root:definitions[name].codeProject,revision:source.saved.revision,packageDigest:source.state.reviewPackage.packageDigest};}),
      documents:withDocument?[{path:'docs/guide.md',before:fileRecord('docs/guide.md',before),after:fileRecord('docs/guide.md',after)}]:[]};
  };
  const plan=makePlan(),review=await syntheticIntegrationReview(root,plan,documents);
  put(codeProject,'source.mjs',changes.cross['source.mjs']);put(codeProject,'docs/guide.md',after);
  const evidenceFile=path.join(root,'integration-evidence.json');fs.writeFileSync(evidenceFile,canonical({plan,review}),{mode:0o600});
  const input={root:codeProject,specsRoot:specsDir,baseline:parent.original,parentPackage:parent.state.reviewPackage,
    records:parent.saved.records,plan,review};
  const record={version:1,plan,reviewFile:{path:evidenceFile,sha256:sha(fs.readFileSync(evidenceFile))},
    reason:'Explicit reviewed integration',planDigest:digest(plan)};
  return {root,codeProject,sourceRoot,unrelatedRoot,specsDir,definitions,executions,calls,approvedBytes,
    statePath,snapshot,history,request,makePlan,plan,review,documents,evidenceFile,record,input,
    write:(file,bytes)=>put(codeProject,file,bytes),
    openParent:(options={})=>openControlRun(definitions.parent,'resume',executions.parent,options)};
}
