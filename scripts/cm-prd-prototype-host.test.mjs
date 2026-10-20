import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sessionId='prd-prototype-blocked-original';
const FIXTURE_TIMEOUT_MS=Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000);
async function fixture(t,{pending=false,claude=false,planningBlocked=true,ready=false}={}){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-prototype-host-'))),clients=[];
  const previousHome=process.env.CM_WORKFLOW_HOME,cmHome=path.join(directory,'cm-home');fs.mkdirSync(cmHome);process.env.CM_WORKFLOW_HOME=cmHome;
  t.after(async()=>{try{for(const client of clients)await client.stop();}finally{
    if(previousHome===undefined)delete process.env.CM_WORKFLOW_HOME;else process.env.CM_WORKFLOW_HOME=previousHome;
    fs.rmSync(directory,{recursive:true,force:true});}});
  const project=path.join(directory,'project'),old=path.join(directory,'old-plugin');
  fs.mkdirSync(path.join(project,'docs'),{recursive:true});fs.mkdirSync(path.join(old,'templates'),{recursive:true});
  for(const relative of ['VERSION','skills/cm-prd/SKILL.md','runtime/project-context.md','runtime/review.md','runtime/logging.md','scripts/cm-prd-entry.mjs']){
    fs.mkdirSync(path.dirname(path.join(old,relative)),{recursive:true});fs.copyFileSync(path.join(root,relative),path.join(old,relative));
  }
  fs.writeFileSync(path.join(project,'docs/input.md'),'The confirmed three screens are the pixel baseline');
  if(claude)fs.writeFileSync(path.join(project,'.cm-workflow.json'),JSON.stringify({version:1,roles:{reviewer:{adapter:'claude-cli',model:'default',source:'subscription'}}}));
  const entry={skillDir:path.join(old,'skills/cm-prd'),project,specs:project},identity={entry,runtime:'codex'};
  const analysis=createCmPrdAnalysis({input:entry,runtime:'codex',record:()=>{},
    analyze:async()=>({status:'analyzed',summary:'Native app using the confirmed warm-glass prototype',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async()=>({status:'blocked',reason:'No formal pixel-baseline asset import'})});
  if(!ready)await analysis.advance('Confirmed: two warm skins, round font, pixel reference; do not ask again');
  if(!ready&&planningBlocked)await analysis.plan('Import baseline before design',{designOnly:true});
  const owner=openPrdSession({specs:project,sessionId,identity});
  owner.checkpoint({analysis:analysis.checkpoint(),change:null,started:!ready,routeTurn:ready?0:2,reviewState:null,summaryState:null,publishedSummary:false});
  if(pending)owner.begin({requestId:'pending-plan',operation:'plan_design',text:'Pending caller'},owner.state.checkpoint);
  const original=owner.state;owner.close();
  const stateFile=path.join(project,'.reviews/prd-sessions',sessionId,'state.json');
  return {directory,project,old,entry,original,stateFile,clients,cmHome,read:()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))};
}
async function client(f,{permissions=[],hostContext=null}={}){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--session-skill-dir',f.entry.skillDir,'--project',f.project,'--specs',f.project,'--runtime','codex','--allow-log-write','--session',sessionId,...permissions,...(hostContext?['--host-context',hostContext]:[])],
  {env:{...process.env,CM_WORKFLOW_HOME:f.cmHome,CM_WORKFLOW_LOG_HOME:path.join(f.directory,'mirror')},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout}),queue=[],waiters=[],requests=[];let stderr='',ended=false,seq=0;
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const rejectAll=error=>{for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(error);}};
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{ended=true;lines.close();rejectAll(Error(`Host exited (${code}/${signal}): ${stderr}`));resolve({code,signal});}));
  child.once('error',error=>rejectAll(error));
  lines.on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{rejectAll(Error('Host returned non-JSON output'));return;}
    if(message.type==='host_request')requests.push(message);
    if(message.error&&message.requestId===null){rejectAll(Error(`Transport rejected operation: ${message.error.code}`));return;}
    const index=waiters.findIndex(waiter=>waiter.match(message));
    if(index<0)queue.push(message);else{const waiter=waiters.splice(index,1)[0];clearTimeout(waiter.timer);waiter.resolve(message);}
  });
  const wait=match=>{
    const index=queue.findIndex(match);if(index>=0)return Promise.resolve(queue.splice(index,1)[0]);
    if(ended)return Promise.reject(Error(`Host already exited: ${stderr}`));
    return new Promise((resolve,reject)=>{const waiter={match,resolve,reject};waiter.timer=setTimeout(()=>{
      const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);child.kill();reject(Error(`Bounded host fixture wait expired: ${stderr}`));
    },Math.min(FIXTURE_TIMEOUT_MS,15000));waiters.push(waiter);});
  };
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  let ready=null;
  const result={wait,send,requests,request:(operation,fields={})=>{const requestId=`host-request-${++seq}`;
    const reply=wait(message=>message.requestId===requestId);send({requestId,operation,...fields});return reply;},
  answer:(call,value)=>send({type:'host_result',sessionId:ready.sessionId,callId:call.callId,requestDigest:call.requestDigest,result:value}),
  stop:async()=>{if(!ended)child.kill();await closed;},
  close:async({force=false}={})=>{send({type:'host_close',sessionId:ready.sessionId,...(force?{force:true}:{})});const endedResult=await closed;assert.equal(endedResult.code,0,stderr);}};
  f.clients.push(result);ready=await wait(message=>message.type==='host_ready');return result;
}
function response(message){assert.equal(message.error,undefined,JSON.stringify(message));return message.result;}
function refusal(message,reason){const result=response(message);assert.equal(result.status,'blocked');assert.equal(result.reason,reason);assert.equal(result.completionAuthorized,false);}
const bindingOf=value=>value.binding??value;

test('actual new host recovers original plugin-root identity without dispatch or approval and keeps history', {timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t);let c=await client(f);
  const beforeBytes=fs.readFileSync(f.stateFile,'utf8'),binding={...bindingOf(response(await c.request('inspect_planning_recovery'))),reason:'The missing baseline import entry is available'};
  assert.equal(binding.sessionId,sessionId);assert.equal(binding.checkpointDigest,digest(f.original.checkpoint));
  assert.equal(fs.readFileSync(f.stateFile,'utf8'),beforeBytes,'inspection must be read-only');
  const recovered=response(await c.request('recover_planning',{binding}));assert.equal(recovered.outcome,'planning_recovered');
  assert.equal(recovered.completionAuthorized,false);assert.deepEqual(recovered.recovery.originalCheckpoint,f.original.checkpoint);
  const status=response(await c.request('status'));assert.equal(status.stage,'analysis_ready');assert.equal(status.completionAuthorized,false);
  assert.equal(status.draft,null);assert.equal(status.designDraft,null);assert.equal(status.reviewState,null);
  const state=f.read(),expected=structuredClone(f.original);expected.checkpoint.analysis.stage='analysis_ready';expected.planningRecoveries=state.planningRecoveries;
  assert.deepEqual(state,expected);assert.deepEqual(state.identity,f.original.identity);
  assert.equal(state.checkpoint.analysis.sourceDigest,f.original.checkpoint.analysis.sourceDigest);assert.equal(c.requests.length,0);
  assert.equal(fs.existsSync(path.join(f.project,'.cm-specs-status')),false);assert.equal(fs.readdirSync(f.project).some(name=>/^\d+\./.test(name)),false);
  await c.close();c=await client(f);const saved=fs.readFileSync(f.stateFile,'utf8');
  assert.deepEqual(response(await c.request('recover_planning',{binding})),recovered);assert.equal(fs.readFileSync(f.stateFile,'utf8'),saved);
  refusal(await c.request('recover_planning',{binding:{...binding,reason:'Different reason'}}),'prd_planning_recovery_conflict');
  assert.equal(c.requests.length,0);await c.close();
});
test('after explicit recovery, fresh generation reads the new execution Skill while keeping the old source identity',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t),c=await client(f);
  const binding={...bindingOf(response(await c.request('inspect_planning_recovery'))),reason:'Formal baseline owner route exists'};
  response(await c.request('recover_planning',{binding}));assert.equal(c.requests.length,0);
  const planned=c.request('plan_design',{text:'Use the already confirmed requirements and baseline'});
  const call=await c.wait(message=>message.type==='host_request');assert.equal(call.kind,'prd_generate');assert.equal(call.payload.phase,'design');
  assert.equal(call.payload.reference,path.join(root,'skills/cm-prd/SKILL.md'));assert.notEqual(call.payload.reference,path.join(f.old,'skills/cm-prd/SKILL.md'));
  assert.equal(call.payload.analysis.summary,f.original.checkpoint.analysis.result.summary);
  assert.deepEqual(call.payload.userAnswers,f.original.checkpoint.analysis.messages.filter(message=>message.role==='user'));
  c.answer(call,{status:'question',question:'Fixture only: planning is not approval'});
  assert.equal(response(await planned).stage,'awaiting_design_user');assert.deepEqual(f.read().identity,f.original.identity);
  assert.deepEqual(f.read().planningRecoveries[0].originalCheckpoint,f.original.checkpoint);await c.close();
});
for(const mode of ['binding','config','active'])test(`actual host refuses ${mode} recovery and retains the original blocked history`,{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t,{pending:mode==='active'}),c=await client(f),before=f.read();
  if(mode==='active'){
    refusal(await c.request('inspect_planning_recovery'),'prd_planning_recovery_not_ready');
  }else{
    const binding={...bindingOf(response(await c.request('inspect_planning_recovery'))),reason:'Repair proven'};
    if(mode==='binding')binding.checkpointDigest='f'.repeat(64);
    if(mode==='config')fs.writeFileSync(path.join(f.project,'.cm-workflow.json'),JSON.stringify({version:1,policies:{generate_cases:false}}));
    refusal(await c.request('recover_planning',{binding}),mode==='binding'?'prd_planning_recovery_binding':'prd_inputs_changed');
  }
  assert.deepEqual(f.read(),before);assert.equal(c.requests.length,0);await c.close();
});
test('driver transports no-answer inspection and recovery using the original sessionSkillDir',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t),answers=path.join(f.directory,'answers');fs.mkdirSync(answers);
  const plan={project:f.project,specs:f.project,runtime:'codex',session:sessionId,sessionSkillDir:f.entry.skillDir,answers,request:{}};
  const file=path.join(f.directory,'PLAN.json');
  const drive=(operation,request={})=>{
    fs.writeFileSync(file,JSON.stringify({...plan,request}));
    const out=spawnSync(process.execPath,[path.join(root,'scripts/cm-prd-drive.mjs'),'--plan',file,operation],
      {encoding:'utf8',env:{...process.env,CM_WORKFLOW_HOME:f.cmHome,CM_WORKFLOW_LOG_HOME:path.join(f.directory,'mirror')},timeout:30000});
    assert.equal(out.error,undefined);assert.equal(out.status,0,out.stderr);return JSON.parse(out.stdout);
  };
  const before=f.read(),binding={...bindingOf(response(drive('inspect_planning_recovery'))),reason:'Baseline capability restored'};
  const recovered=response(drive('recover_planning',{binding}));assert.equal(recovered.outcome,'planning_recovered');
  const state=f.read();assert.equal(state.checkpoint.analysis.stage,'analysis_ready');assert.deepEqual(state.identity,before.identity);
  assert.deepEqual(state.planningRecoveries[0].originalCheckpoint,before.checkpoint);assert.deepEqual(fs.readdirSync(answers),[]);
});

const sha=value=>createHash('sha256').update(value).digest('hex');
function baselineInput(f){
  const prototypeRoot=path.join(f.project,'prototype');fs.mkdirSync(prototypeRoot);
  const html='<button>Next</button>',image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMuoAAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(prototypeRoot,'index.html'),html);fs.writeFileSync(path.join(prototypeRoot,'screen.png'),image);
  const font=Buffer.alloc(32);font.write('wOF2');font.writeUInt32BE(32,8);fs.writeFileSync(path.join(prototypeRoot,'font.woff2'),font);
  return {prototypeRoot,captureRoot:null,confirmation:{reference:'synthetic-user-message',
    messageDigest:digest(f.original.checkpoint.analysis.messages[0].text),level:'pixel',nativeDifferences:'list_each_platform_difference'},
    sources:[{sourcePath:'index.html',sha256:sha(html)}],
    screenshots:[{id:'main',sourcePath:'screen.png',sha256:sha(image),width:1,height:1,page:'main',skin:'warm',state:'default'}],
    fonts:[{id:'round',sourcePath:'font.woff2',sha256:sha(font),license:'Synthetic fixture only',source:'Synthetic test fixture'}],
    specSheet:{source:'rendered-computed',channel:'codex-in-app',url:'https://prototype.example/',viewport:{width:390,height:844,deviceScaleFactor:1},
      elements:[{sel:'button',geo:{x:0,y:0,w:20,h:20},font:null,style:{color:'rgb(0, 0, 0)'}}]},
    interaction:{status:'complete',channel:'codex-in-app',coverage:['main'],steps:[{id:'tap',action:'Synthetic fixture click',result:'Synthetic fixture next state',screenshots:['main']}]},cssSource:null};
}
const nativeDesign=()=>({status:'design',summary:'Synthetic native pixel reference',features:[{name:'native',documents:[
  {path:'requirements.md',content:'## 功能需求\n1. [F-001] Use the confirmed prototype pixels.\n- [ ] [AC-001] Preserve interactions and list native differences.'},
  {path:'design.md',content:'## 方案摘要\nUse the frozen design-baseline/ assets.\n## 原生平台差异\nList every native platform difference; pending independent review and user approval.'}]}]});
async function preparedBaselineHost(t){
  const f=await fixture(t,{claude:true}),c=await client(f,{permissions:['--allow-spec-write']});
  const input=baselineInput(f),imported=response(await c.request('import_baseline',{baseline:input}));
  assert.equal(imported.stage,'blocked');assert.equal(imported.designBaseline.ready,true);assert.equal(c.requests.length,0);
  const inspected=response(await c.request('inspect_baseline'));assert.equal(inspected.reference.manifestDigest,imported.designBaseline.manifestDigest);
  assert.deepEqual(inspected.manifest.input.confirmation,input.confirmation);
  assert.deepEqual(inspected.manifest.input.interaction,input.interaction,'interaction source declaration is preserved inside the hash-bound manifest');
  const importedState=f.read(),binding={...bindingOf(response(await c.request('inspect_planning_recovery'))),reason:'Formal import completed with bound assets'};
  assert.equal(response(await c.request('recover_planning',{binding})).stage,'analysis_ready');
  const planned=c.request('plan_design',{text:'Continue from the confirmed prototype without asking the choices again'});
  const call=await c.wait(message=>message.type==='host_request');assert.equal(call.kind,'prd_generate');assert.equal(call.payload.phase,'design');
  assert.equal(call.payload.reference,path.join(root,'skills/cm-prd/SKILL.md'));c.answer(call,nativeDesign());
  assert.equal(response(await planned).stage,'design_ready');
  assert.equal(response(await c.request('save_design')).status,'design_saved');
  const prepared=response(await c.request('final_review_package',{stage:'design',feature:'1.native'}));
  assert.equal(prepared.reviewPackage.reviewRoute.adapter,'claude-cli');assert.equal(prepared.reviewPackage.reviewRoute.hostRuntime,'codex');
  assert.equal(prepared.reviewPackage.reviewRoute.model,'default');assert.equal(prepared.packageDigest,digest(prepared.reviewPackage));
  assert.equal(prepared.reviewPackage.designBaseline.manifestDigest,imported.designBaseline.manifestDigest);
  assert.deepEqual(prepared.reviewPackage.designBaseline.confirmation,input.confirmation);assert.equal(prepared.reviewPackage.designBaseline.artifacts.length,4);
  assert.deepEqual(f.read().planningRecoveries[0].originalCheckpoint,importedState.checkpoint);assert.deepEqual(f.read().identity,f.original.identity);
  assert.equal(f.read().checkpoint.analysis.selfCheckRound,0);assert.equal(c.requests.filter(row=>row.kind==='prd_review').length,0);
  for(const artifact of prepared.reviewPackage.designBaseline.artifacts){
    assert.equal(sha(fs.readFileSync(path.join(f.project,artifact.path))),artifact.sha256);
  }
  assert.equal(fs.existsSync(path.join(f.project,'1.native/tasks.md')),false);assert.equal(fs.existsSync(path.join(f.project,'.cm-specs-status')),false);
  assert.equal(fs.existsSync(path.join(f.project,'.reviews/prd-native-design-r1.md')),false);
  return {f,c,input,prepared};
}
test('actual host transports import, inspection, original-run recovery and saved pixel/Claude package binding',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const {f,c}=await preparedBaselineHost(t);assert.equal(response(await c.request('status')).completionAuthorized,false);
  assert.deepEqual(fs.readdirSync(path.join(f.project,'1.native/design-baseline')).sort(),['font-1.woff2','manifest.json','screenshot-1.png','spec-sheet.json'].sort());
  await c.close();
});
test('driver accepts a synthetic Claude-declared answer under the frozen route without claiming a real CLI review',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const {f,c,prepared}=await preparedBaselineHost(t);await c.close();
  const answers=path.join(f.directory,'review-answers');fs.mkdirSync(answers);
  const answer={reviewer:'claude-cli',contextId:'synthetic-claude-independent-context',independent:true,at:'2026-10-16T00:00:00.000Z',
    result:{verdict:'changes_requested',packageDigest:prepared.packageDigest,examinedPaths:['1.native/design.md','1.native/requirements.md'],
      findings:[{id:'R1',severity:'P2',path:'1.native/design.md',message:'Specify one native difference',evidence:'Synthetic route fixture only'}],
      summary:'Synthetic Claude source declaration; no real CLI or browser execution is claimed'}};
  fs.writeFileSync(path.join(answers,'review.json'),JSON.stringify(answer));
  const plan={project:f.project,specs:f.project,runtime:'codex',session:sessionId,sessionSkillDir:f.entry.skillDir,answers,
    hostContext:'synthetic-codex-author-context',permissions:['--allow-review-write'],request:{stage:'design',feature:'1.native',mode:'independent'}};
  const file=path.join(f.directory,'review-plan.json');fs.writeFileSync(file,JSON.stringify(plan));
  const out=spawnSync(process.execPath,[path.join(root,'scripts/cm-prd-drive.mjs'),'--plan',file,'final_review'],
    {encoding:'utf8',env:{...process.env,CM_WORKFLOW_HOME:f.cmHome,CM_WORKFLOW_LOG_HOME:path.join(f.directory,'mirror')},timeout:30000});
  assert.equal(out.error,undefined);assert.equal(out.status,0,out.stderr);const result=response(JSON.parse(out.stdout));
  assert.equal(result.reviewState.status,'review_recorded');assert.equal(result.reviewState.verdict,'changes_requested');assert.equal(result.completionAuthorized,false);
  const archive=fs.readFileSync(path.join(f.project,'.reviews/prd-native-design-r1.md'),'utf8');
  const stored=JSON.parse(archive.match(/```json\n([^]*?)\n```/)[1]);assert.deepEqual(stored.response,answer);
  assert.equal(stored.reviewPackage.reviewRoute.adapter,'claude-cli');assert.equal(digest(stored.reviewPackage),prepared.packageDigest);
  assert.deepEqual(f.read().identity,f.original.identity);assert.equal(f.read().checkpoint.analysis.selfCheckRound,0);
  assert.equal(fs.existsSync(path.join(f.project,'.cm-specs-status')),false);assert.equal(fs.existsSync(path.join(f.project,'1.native/tasks.md')),false);
});

test('full-draft baseline flow saves bound assets before split review preparation',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t,{claude:true,planningBlocked:false}),c=await client(f,{permissions:['--allow-spec-write']});
  const input=baselineInput(f),imported=response(await c.request('import_baseline',{baseline:input}));assert.equal(imported.stage,'analysis_ready');
  const planned=c.request('advance',{text:'Generate the original full specification draft using the confirmed pixels'});
  const generate=await c.wait(message=>message.type==='host_request');assert.equal(generate.kind,'prd_generate');assert.equal(generate.payload.phase,'full_draft');
  const full=nativeDesign();full.status='draft';full.features[0].testCasesReason='no_observable_behavior';
  full.features[0].documents.push({path:'tasks.md',content:'- [ ] T-001: Preserve documented pixel baseline and list native differences (F-001, AC-001)'});
  c.answer(generate,full);assert.equal(response(await planned).stage,'draft_ready');
  const checked=c.request('advance',{text:'Perform the original complete self-check'});
  const check=await c.wait(message=>message.type==='host_request');assert.equal(check.kind,'prd_self_check');const draft=check.payload.draft;
  c.answer(check,{draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
    checks:draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic context check; no real QA claim']}))}))});
  assert.equal(response(await checked).stage,'self_check_reported_passed');
  assert.equal(response(await c.request('save_draft')).status,'draft_saved');
  const prepared=response(await c.request('final_review_package',{stage:'split',feature:'1.native'}));
  assert.equal(prepared.reviewPackage.designBaseline.manifestDigest,imported.designBaseline.manifestDigest);
  assert.equal(prepared.reviewPackage.reviewRoute.adapter,'claude-cli');assert.equal(prepared.packageDigest,digest(prepared.reviewPackage));
  for(const artifact of prepared.reviewPackage.designBaseline.artifacts)assert.equal(sha(fs.readFileSync(path.join(f.project,artifact.path))),artifact.sha256);
  assert.equal(response(await c.request('status')).completionAuthorized,false);assert.equal(c.requests.some(row=>row.kind==='prd_review'),false);
  assert.equal(fs.existsSync(path.join(f.project,'.cm-specs-status')),false);await c.close();
});
test('new-root analysis request can resume its original pending result after host restart',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t,{ready:true});let c=await client(f);
  const pending=c.request('start',{text:'Analyze through the new execution assets while retaining the old identity'});
  const call=await c.wait(message=>message.type==='host_request');assert.equal(call.kind,'prd_analyze');
  const frozenPending=f.read(),registration=frozenPending.active.calls[0];
  assert.equal(registration.callId,call.payload.recovery.callId);
  await c.close({force:true});assert.equal((await pending).error.code,'host_request_failed');
  c=await client(f);
  const originalResult={status:'analyzed',summary:'Original bounded analysis reply',sourcePaths:['docs/input.md'],openQuestions:[]};
  const resumed=response(await c.request('resume',{resolution:{callId:registration.callId,requestDigest:registration.requestDigest,
    result:originalResult,evidence:'Original result recovered from the test fixture; no redispatch'}}));
  assert.equal(call.payload.reference,path.join(root,'skills/cm-prd/SKILL.md'));
  assert.equal(resumed.stage,'analysis_ready');assert.deepEqual(resumed.result,originalResult);assert.equal(c.requests.length,0);
  assert.deepEqual(f.read().identity,f.original.identity);assert.equal(f.read().active,null);
  assert.equal(f.read().checkpoint.analysis.sourceDigest,f.original.checkpoint.analysis.sourceDigest);
  assert.equal(f.read().checkpoint.analysis.configDigest,f.original.checkpoint.analysis.configDigest);await c.close();
});

test('explicit execution-root upgrade uses the original session reader limit for accumulated history',{timeout:FIXTURE_TIMEOUT_MS},async t=>{
  const f=await fixture(t),saved=f.read();saved.checkpoint.analysis.messages.push({role:'user',text:'x'.repeat(1100000)});
  fs.writeFileSync(f.stateFile,JSON.stringify(saved),{mode:0o600});const bytes=fs.readFileSync(f.stateFile);
  const c=await client(f);assert.deepEqual(fs.readFileSync(f.stateFile),bytes);assert.equal(c.requests.length,0);
  assert.equal(response(await c.request('status')).stage,'blocked');await c.close();
});
