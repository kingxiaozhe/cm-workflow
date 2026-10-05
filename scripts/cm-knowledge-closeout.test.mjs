import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {CLOSEOUT_AREAS,readCloseoutReport,readCloseoutPolicy} from '../runtime/js/cm-ai/knowledge-closeout.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {recordCmAiQaDecision} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {openControlRun,runConfigMaterial} from './cm-ai-run.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {createCmAiHost} from '../runtime/js/cm-ai/host.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const identity={repositoryId:'closeout',runId:'closeout-run',taskId:'T-001',attempt:1};
const policy={version:1,enabled:true},packageDigest='8'.repeat(64);
const report=()=>({version:1,items:CLOSEOUT_AREAS.map(area=>({area,
  status:area==='memory'?'out_of_scope':area==='runtime'?'not_applicable':'checked',
  evidence:['README.md'],detail:area==='memory'?'Personal memory is outside this run':'Controlled fixture evidence'}))});
const op=operation=>({version:1,operation,requestId:operation,identity,packageDigest,testRunId:null});
async function fixture(fn,{pending=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-closeout-'))),specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.fixture';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(codeProject,'README.md'),'# Fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),`- [${pending?' ':'x'}] T-001: fixture\n`);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const current={state:'fixture_completed',code:null,identity,packageDigest};let effects=0;
  const runner={status:()=>current,executeEffect:()=>{effects++;throw Error('unexpected effect');},run:async()=>current,cancel:()=>current};
  const entry=extra=>createCmAiConversationEntry({specsDir,codeProject,feature,identity,runner,applicableAgentFiles:[],knowledgeCloseout:policy,...extra});
  const seedQa=()=>recordCmAiQaDecision({specsDir,codeProject,feature,identity,packageDigest,logHome:path.join(root,'logs'),
    decision:{decisionId:'old-qa-skip',identity,packageDigest,status:'skipped',reason:'Historical fixture',score:4,at:'2026-09-04T22:00:00Z'}});
  const response=(request,extra={})=>({syncId:request.syncId,identity:request.identity,packageDigest:request.packageDigest,
    contextDigest:request.contextDigest,status:'completed',reason:'Required docs verified in fixture',at:'2026-10-04T12:00:00Z',...extra});
  const stateFile=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  const definition={version:1,specsDir,codeProject,feature,identity,scope:['README.md'],requirements:[]};
  const execution=(enabled)=>({configuration:{kind:'synthetic-host-v1',...(enabled===undefined?{}:{workflow:{knowledgeCloseout:enabled}})},timeoutMs:1000,
    excludedContexts:['main'],hostDecision:null,check:()=>[],applicableAgentFiles:[],documentationProvider:{timeoutMs:1000,inspect:async()=>{throw Error('unexpected inspection');}},
    developer:{provider:'codex',requestedModel:'fixture',contextId:'author',run:async()=>{throw Error('unexpected dispatch');}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
      contexts:['review-1','review-2'],run:async()=>{throw Error('unexpected review');}}],
    reviewInvocation:{developerThreadId:'author',excludedThreadIds:['main'],hostContextId:'main',authorize:async()=>{throw Error('unexpected grant');}}});
  try{return await fn({root,specsDir,codeProject,feature,definition,entry,seedQa,response,stateFile,execution,effects:()=>effects});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('six-face report requires evidence and distinguishes denied reads and scope',()=>{
  assert.deepEqual(readCloseoutReport(report()),report());
  const denied=report();denied.items[2]={area:'documentation',status:'unverified',evidence:[],detail:'README.md: EACCES; not read'};
  assert.equal(readCloseoutReport(denied).items[2].status,'unverified');
  for(const mutation of [r=>r.items.pop(),r=>r.items[1].area='code',r=>r.items[0].evidence=[],
    r=>r.items[0].status='passed',r=>r.items[0].grant=true,r=>r.version=2]){
    const value=report();mutation(value);assert.throws(()=>readCloseoutReport(value));
  }
  assert.throws(()=>readCloseoutPolicy({version:2,enabled:true}),{code:'closeout_policy_unsupported'});
});
test('one inspection reports six faces; repeated finish/finalize deduplicates without writes to reviewed files',()=>fixture(async f=>{
  f.seedQa();let calls=0;const before=fs.readFileSync(path.join(f.codeProject,'README.md'));
  const entry=f.entry({documentationProvider:{timeoutMs:1000,inspect:async request=>{
    calls++;assert.deepEqual(request.closeout,policy);return f.response(request,{closeout:report()});}}});
  const finished=await entry.handle(op('finish'));assert.equal(finished.code,'documentation_synced');
  assert.equal(finished.knowledgeCloseout.status,'reported');assert.equal(finished.knowledgeCloseout.items.length,6);
  const final=await entry.handle(op('run_finalize'));assert.equal(final.state,'run_done');
  assert.deepEqual(final.knowledgeCloseout,finished.knowledgeCloseout);
  assert.equal((await entry.handle(op('run_finalize'))).deduplicated,true);assert.equal(calls,1);assert.equal(f.effects(),0);
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,'README.md')),before);
}));
test('legacy answer on enabled run is explicitly not_completed and does not replace mandatory documentation block',()=>fixture(async f=>{
  f.seedQa();let blocked=true;
  const entry=f.entry({documentationProvider:{timeoutMs:1000,inspect:async request=>f.response(request,{status:blocked?'blocked':'completed'})}});
  const first=await entry.handle(op('run_finalize'));assert.equal(first.code,'documentation_sync_blocked');
  assert.equal(first.knowledgeCloseout.status,'not_completed');assert(!fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').includes('run_done'));
  blocked=false;const second=await entry.handle(op('run_finalize'));assert.equal(second.state,'run_done');
  assert.equal(second.knowledgeCloseout.status,'not_completed');assert.equal(second.knowledgeCloseout.reason,'report_not_provided');
}));
test('explicit OFF still performs mandatory inspection and records disabled',()=>fixture(async f=>{
  f.seedQa();let calls=0;
  const entry=f.entry({knowledgeCloseout:{version:1,enabled:false},documentationProvider:{timeoutMs:1000,inspect:async request=>{
    calls++;assert.equal(request.closeout.enabled,false);return f.response(request);}}});
  const result=await entry.handle(op('run_finalize'));assert.equal(result.state,'run_done');
  assert.equal(result.knowledgeCloseout.status,'disabled');assert.equal(calls,1);
}));
for(const kind of ['timeout','cancel','failure','stale','drift','invalid_report'])
test(`inspection ${kind} cannot write run_done or accept a late report`,()=>fixture(async f=>{
  f.seedQa();let resolve,entered;const started=new Promise(r=>entered=r);
  const entry=f.entry({documentationProvider:{timeoutMs:kind==='timeout'?20:1000,inspect:async request=>{
    entered();if(['timeout','cancel'].includes(kind))return new Promise(r=>resolve=()=>r(f.response(request,{closeout:report()})));
    if(kind==='failure')throw Object.assign(Error('read denied'),{code:'EACCES'});
    if(kind==='drift')fs.appendFileSync(path.join(f.specsDir,f.feature,'design.md'),'Changed after request\n');
    const value=f.response(request,{closeout:report()});
    if(kind==='stale')value.syncId='old-report';if(kind==='invalid_report')value.closeout.items[0].evidence=[];
    return value;
  }}});
  const work=entry.handle(op('run_finalize'));await started;
  if(kind==='cancel')await entry.handle({version:1,operation:'cancel',requestId:'cancel',identity});
  const result=await work;assert.equal(result.outcome,'rejected',JSON.stringify(result));
  assert.equal(result.knowledgeCloseout.status,'not_completed');assert.equal(f.effects(),0);
  if(resolve){resolve();await new Promise(r=>setImmediate(r));}
  assert(!fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').includes('run_done'));
}));
test('concurrent inspection is refused; restart inspects again under the original deduplicated finalizer',()=>fixture(async f=>{
  f.seedQa();let release,request,entered;const started=new Promise(r=>entered=r);let calls=0;
  const provider={timeoutMs:1000,inspect:async r=>{calls++;request=r;entered();return new Promise(resolve=>release=resolve);}};
  const entry=f.entry({documentationProvider:provider});const active=entry.handle(op('finish'));await started;
  assert.equal((await entry.handle(op('finish'))).code,'documentation_pending');release(f.response(request,{closeout:report()}));await active;
  const first=await entry.handle(op('run_finalize'));assert.equal(first.state,'run_done');
  const reopened=f.entry({documentationProvider:{timeoutMs:1000,inspect:async r=>{calls++;return f.response(r,{closeout:report()});}}});
  assert.equal((await reopened.handle(op('run_finalize'))).deduplicated,true);assert.equal(calls,2);
}));
for(const enabled of [undefined,false])
test(`real store freezes create policy ${enabled===undefined?'default ON':'explicit OFF'} and refuses change`,()=>fixture(async f=>{
  let run=await openControlRun(f.definition,'create',f.execution(enabled));run.close();
  const before=fs.readFileSync(f.stateFile),snapshot=JSON.parse(before),saved=snapshot.records[0].payload.config.knowledgeCloseout;
  assert.deepEqual(saved,{version:1,enabled:enabled!==false});
  run=await openControlRun(f.definition,'resume',f.execution(enabled));run.close();assert.deepEqual(fs.readFileSync(f.stateFile),before);
  await assert.rejects(openControlRun(f.definition,'resume',f.execution(enabled===false?true:false)),{code:'closeout_policy_changed'});
  assert.deepEqual(fs.readFileSync(f.stateFile),before);
},{pending:true}));
test('real legacy init without closeout resumes byte-identically; explicit activation cannot migrate it',()=>fixture(async f=>{
  const execution=f.execution(),material=runConfigMaterial(f.definition,execution);
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),feature:'fixture',specsRoot:f.specsDir,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},create:true,
    fingerprints:{workflow:digest('cm-ai-host-execution-v1'),config:digest(material),inputs:digest({feature:f.feature,task:identity.taskId})}});
  try{createCmAiHost({runner:{root:f.codeProject,identity,scope:f.definition.scope,requirements:[],specification:{specsRoot:f.specsDir,feature:f.feature},
    excludedContexts:execution.excludedContexts,developer:execution.developer,reviewers:execution.reviewers,reviewInvocation:execution.reviewInvocation,
    check:()=>[],timeoutMs:1000,taskCompletion:{reviewsDir:path.join(f.specsDir,'.reviews'),handoffs:[1,2].map(n=>path.join(f.specsDir,'.reviews',`fixture-T-001-a${n}-handoff.json`))},
    taskLearning:{feature:f.feature,hostHandoff:true},persistence:{store,mode:'create',version:3}},entry:{specsDir:f.specsDir,codeProject:f.codeProject,
    feature:f.feature,identity,hostDecision:null,applicableAgentFiles:[],documentationProvider:execution.documentationProvider}});}finally{store.close();}
  const before=fs.readFileSync(f.stateFile);assert(!Object.hasOwn(JSON.parse(before).records[0].payload.config,'knowledgeCloseout'));
  const resumed=await openControlRun(f.definition,'resume',execution);resumed.close();assert.deepEqual(fs.readFileSync(f.stateFile),before);
  await assert.rejects(openControlRun(f.definition,'resume',f.execution(true)),{code:'closeout_policy_changed'});
  assert.deepEqual(fs.readFileSync(f.stateFile),before);
},{pending:true}));
for(const saved of [policy,{version:1,enabled:false},null])
test(`empty original initializer selects only its original fingerprint: ${saved?.enabled??'legacy'}`,()=>fixture(async f=>{
  const execution=f.execution(),material=runConfigMaterial(f.definition,execution,{knowledgeCloseout:saved});
  const store=openTaskExecutionStore({tasksPath:path.join(f.specsDir,f.feature,'tasks.md'),feature:'fixture',specsRoot:f.specsDir,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},create:true,
    fingerprints:{workflow:digest('cm-ai-host-execution-v1'),config:digest(material),inputs:digest({feature:f.feature,task:identity.taskId})}});store.close();
  const run=await openControlRun(f.definition,'resume',execution);run.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).records[0].payload.config.knowledgeCloseout??null,saved);
},{pending:true}));

for(const mutation of ['unsupported-version','stripped-policy','changed-boolean'])
test(`resume refuses ${mutation} without falling back or changing evidence`,()=>fixture(async f=>{
  const run=await openControlRun(f.definition,'create',f.execution());run.close();
  const snapshot=JSON.parse(fs.readFileSync(f.stateFile));
  const config=snapshot.records[0].payload.config;
  if(mutation==='unsupported-version')config.knowledgeCloseout.version=2;
  if(mutation==='stripped-policy')delete config.knowledgeCloseout;
  if(mutation==='changed-boolean')config.knowledgeCloseout.enabled=false;
  // Even a fully recomputed journal hash chain cannot authorize a different
  // policy than the original configuration fingerprint.
  let previousDigest=null;
  for(const row of snapshot.records){row.previousDigest=previousDigest;const {digest:checksum,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  const {revision,...body}=snapshot;snapshot.revision=digest(body);
  fs.writeFileSync(f.stateFile,JSON.stringify(snapshot)+'\n');const before=fs.readFileSync(f.stateFile);
  await assert.rejects(openControlRun(f.definition,'resume',f.execution()),error=>
    error.code===(mutation==='unsupported-version'?'closeout_policy_unsupported':'fingerprint_mismatch'));
  assert.deepEqual(fs.readFileSync(f.stateFile),before);
},{pending:true}));
