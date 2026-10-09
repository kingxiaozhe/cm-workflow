// Shared real-host fixture for the answer-gap tests (cm-ai-answer-gap-*.test.mjs):
// one approved feature, one in-scope file, the real control run and host entry.
// Not a test file itself; it never touches the user's real directories.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

export const learning={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
export function gapFixture(t,name='gap'){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),`cm-answer-${name}-`)));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,file),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,calls:{developer:0,check:0},
    store:path.join(specsDir,'.reviews','.execution','answer-gap-run','state.json')};
}
export const identity=attempt=>({repositoryId:'answer-gap',runId:'answer-gap-run',taskId:'T-002',attempt});
export const definition=f=>({version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
  identity:identity(1),scope:['a.mjs'],requirements:['requirements.md']});
// developer: one item per developer call: a string is written to a.mjs and
// answered; 'hang' never answers; {write,response} writes (when given) and
// returns the raw worker response; {write,throw:code} writes then fails the call.
// checks: one item per check request: 'hang' never answers, 'invalid' answers a
// malformed result, anything else (or an empty queue) runs the real host check.
// verdicts: one per review (default changes_requested).
export function gapExecution(f,{developer=[],checks=[],verdicts=[]}={}){
  const queue=[...developer],checkQueue=[...checks],verdictQueue=[...verdicts];
  const realCheck=createHostCheck({cwd:f.codeProject,commands:[{id:'syntax',command:[process.execPath,'-e','0']}]});
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(value,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:`review-thread-${value.identity.attempt}-${Math.random().toString(36).slice(2,8)}`});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      const pkg=value.payload.reviewPackage,verdict=verdictQueue.shift()??'changes_requested';
      return {status:'succeeded',value:verdict==='approved'
        ?{verdict,packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'Fixture approval'}
        :{verdict,packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),
          findings:[{id:'F1',severity:'P2',path:'a.mjs',message:'Revise',evidence:'Fixture finding'}],summary:'Fixture review'}};
    }};
  const developerRun=createCodexDeveloperRun({requestedModel:'current-session',worker:async()=>{
    f.calls.developer++;
    const item=queue.shift();
    if(item===undefined)throw Object.assign(new Error('unexpected developer call'),{code:'unexpected_developer_call'});
    if(item==='hang')return new Promise(()=>{});
    if(typeof item==='string'){fs.writeFileSync(path.join(f.codeProject,'a.mjs'),item);return {status:'succeeded',value:learning};}
    if(item.write!==undefined)fs.writeFileSync(path.join(f.codeProject,'a.mjs'),item.write);
    if(item.throw)throw Object.assign(new Error(item.throw),{code:item.throw});
    return item.response;
  }});
  return {configuration:{kind:'answer-gap-v1'},timeoutMs:1500,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'current-session',contextId:'developer',run:(request,control)=>{
      // {beforeDispatch:code} fails the developer run itself before any worker
      // starts, as the host's own role routing does (e.g. role_log_failed).
      if(queue[0]?.beforeDispatch){const {beforeDispatch}=queue.shift();f.calls.beforeDispatch=(f.calls.beforeDispatch??0)+1;
        throw Object.assign(new Error(beforeDispatch),{code:beforeDispatch});}
      return developerRun(request,control);
    }},
    reviewers:[reviewer],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],
      authorize:(value,{authorizationAt})=>{const body={version:1,kind:'cm-review-dispatch-grant',
        grantId:'grant',adapterId:'codex-review-adapter',invocationId:value.invocationId,
        requestDigest:value.requestDigest,identity:value.identity,reviewerId:'reviewer',
        logicalContextId:value.contextId,packageDigest:value.payload.reviewPackage.packageDigest,
        hostContextId:'control',decisionId:'approved',decision:'approved',issuedAt:authorizationAt,
        expiresAt:authorizationAt+60000};return {...body,grantDigest:digest(body)};}},
    hostDecision:{status:'approved'},check:(request,control)=>{
      f.calls.check++;
      const item=checkQueue.shift();
      if(item==='hang')return new Promise(()=>{});
      if(item==='invalid')return [{id:'syntax',outcome:'passed'}];
      return realCheck(request,control);
    }};
}
export async function gapSession(f,mode,execution,operations,options={}){
  const run=await openControlRun(definition(f),mode,execution,options);
  const results=[];
  try{
    for(const [operation,attempt,extra] of operations)
      results.push(await run.host.handle({version:1,operation,requestId:`${operation}-${results.length}`,identity:identity(attempt),...extra}));
  }finally{run.close();}
  return results;
}
export const records=f=>JSON.parse(fs.readFileSync(f.store,'utf8')).records;
export const added=(f,before)=>records(f).slice(before.length)
  .map(row=>row.payload.type==='effect-intent'?`intent:${row.payload.effect.id}`:row.payload.type);
