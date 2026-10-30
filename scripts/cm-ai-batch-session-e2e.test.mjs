// End to end: a v2 provider batch whose only member is a session task (task grammar 3,
// `开发: 会话`) is developed through the live develop channel by the test acting as the
// current session, reviewed by a fixture Codex, and completed by the real batch host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const BATCH=fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url));
const key='1.work/T-001',identity={repositoryId:'session-e2e-fixture'};

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-session-e2e-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'app'),bin=path.join(root,'bin'),witness=path.join(root,'witness.jsonl');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),'- [ ] T-001: walk the page\n  - 范围: `target.mjs`\n  - 开发: 会话\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],
    specFiles:buildManifest(specsDir),taskGrammar:3}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'codex'},
    roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'codex-cli'}}}));
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const r=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({batch:{version:1,repositoryId:identity.repositoryId,batchId:'session-e2e-batch',
    specsDir,codeProject,tasks:[{feature:'1.work',taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']}],
    memberDevelopment:{[key]:'session'}},
    workflows:{[key]:{qa:null,documentationPaths:[],applicableAgentFiles:[]}}}));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({version:2,development:'provider',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(root,'protected.json'),JSON.stringify({model:'fixture',timeoutMs:5000,
    checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
  const answers=path.join(root,'answers','1.work','T-001');fs.mkdirSync(answers,{recursive:true});
  fs.writeFileSync(path.join(answers,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected'}));
  // Fixture Codex: sandboxed checks and independent review only. A develop prompt
  // reaching it would mean the session member was handed to the provider.
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),record=row=>fs.appendFileSync(${JSON.stringify(witness)},JSON.stringify(row)+'\\n');
if(args[0]==='sandbox'){
  const command=args.slice(args.indexOf('--')+1);record({type:'check'});
  const checked=cp.spawnSync(command[0],command.slice(1),{cwd:process.cwd(),encoding:'utf8'});
  process.stdout.write(checked.stdout??'');process.stderr.write(checked.stderr??'');process.exit(checked.status??1);
}
let prompt='';process.stdin.on('data',part=>prompt+=part);process.stdin.on('end',()=>{
  if(prompt.includes('<cm-developer-data-json>')){record({type:'provider_develop'});process.exit(1);}
  const data=JSON.parse(prompt.split('<cm-review-data-json>\\n')[1]);
  const value={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic independent review'};
  record({type:'review',attempt:data.reviewPackage.identity.attempt});
  for(const event of [{type:'thread.started',thread_id:'fixture-session-member-review'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])
    process.stdout.write(JSON.stringify(event)+'\\n');
});
`,{mode:0o700});
  const plan=path.join(root,'plan.json');
  fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'create',hostContext:'session-e2e-host',controlConfig:'control.json',
    permissions:['--review-config','review.json','--protected-config','protected.json'],answers:'answers',
    liveEvidence:{directory:'exchange',kinds:['develop'],timeoutMs:60000}}));
  return {root,specsDir,codeProject,plan,witness,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
    CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}};
}

// The test plays the current session: it answers each live develop request with a
// protected-text proposal bound to the host's expected hashes.
function answerLiveRequests(exchange,seen){
  if(!fs.existsSync(exchange))return;
  for(const dir of fs.readdirSync(exchange)){
    const sub=path.join(exchange,dir);if(!fs.statSync(sub).isDirectory())continue;
    for(const name of fs.readdirSync(sub).filter(item=>item.endsWith('.request.json'))){
      const file=path.join(sub,name);if(seen.has(file))continue;seen.add(file);
      const request=JSON.parse(fs.readFileSync(file,'utf8'));
      assert.equal(request.kind,'develop');
      const payload=request.payload;
      assert.equal(payload.editMode,'protected-text-v1');assert.deepEqual(payload.request.payload.scope,['target.mjs']);
      const result={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
        edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'}]};
      const target=file.replace(/\.request\.json$/,'.result.json'),tmp=target+'.tmp';
      fs.writeFileSync(tmp,JSON.stringify({type:'host_result',sessionId:request.sessionId,callId:request.callId,
        requestDigest:request.requestDigest,result}),{mode:0o600});fs.renameSync(tmp,target);
    }
  }
}

test('a v2 provider batch completes its session member through live develop and an independent review',async t=>{
  const f=fixture(t),exchange=path.join(f.root,'exchange'),seen=new Set();
  const child=spawn(process.execPath,[BATCH,'--plan',f.plan,'advance'],{env:f.env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  const timer=setInterval(()=>{try{answerLiveRequests(exchange,seen);}catch(error){stderr+=`\n[test] ${error.stack}`;}},50);
  const code=await new Promise(resolve=>{const kill=setTimeout(()=>child.kill('SIGKILL'),90000);child.on('exit',value=>{clearTimeout(kill);resolve(value);});});
  clearInterval(timer);
  assert.equal(code,0,stderr);
  assert.equal(seen.size,1,'exactly one live develop request reached the session');
  const result=JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1)).result;
  const rows=fs.readFileSync(f.witness,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.type==='provider_develop').length,0,'the session member never reaches the provider');
  assert.deepEqual(rows.filter(row=>row.type==='review').map(row=>row.attempt),[1]);
  assert.ok(rows.some(row=>row.type==='check'),'the protected checks ran');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\] T-001/);
  // qa:"disabled" still asks the mandatory feature-completion QA decision (existing v2 rule),
  // so the batch stops there, before run_done and the final commit; the member itself is complete.
  assert.deepEqual([result.state,result.code,result.pendingAction],['fixture_completed','qa_triggered','qa_execution']);
});

// Round 2: the first review asks for changes; the session gets a fresh live request
// carrying the prior review and the current hashes, and answers it anew.
test('a session member rejected once gets a fresh round-2 live develop request with the prior review',async t=>{
  const f=fixture(t),exchange=path.join(f.root,'exchange'),seen=new Set(),payloads=[];
  // Fixture reviewer: changes_requested on attempt 1, approved on attempt 2.
  const codex=path.join(f.root,'bin','codex');
  fs.writeFileSync(codex,fs.readFileSync(codex,'utf8').replace("const value={verdict:'approved',",
    "const first=data.reviewPackage.identity.attempt===1;const value={verdict:first?'changes_requested':'approved',")
    .replace("findings:[],summary:'Synthetic independent review'}",
      "findings:first?[{id:'F1',severity:'P2',path:'target.mjs',message:'Use 43',evidence:'Synthetic finding'}]:[],summary:'Synthetic independent review'}"));
  const answer=(file,request)=>{
    const payload=request.payload;payloads.push({callId:request.callId,payload});
    const round=payloads.length;
    const result={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
      retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
      edits:[{path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:`export const value = ${41+round};\n`}]};
    const target=file.replace(/\.request\.json$/,'.result.json'),tmp=target+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({type:'host_result',sessionId:request.sessionId,callId:request.callId,requestDigest:request.requestDigest,result}),{mode:0o600});
    fs.renameSync(tmp,target);
  };
  const child=spawn(process.execPath,[BATCH,'--plan',f.plan,'advance'],{env:f.env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
  const timer=setInterval(()=>{try{
    if(!fs.existsSync(exchange))return;
    for(const dir of fs.readdirSync(exchange))for(const name of fs.readdirSync(path.join(exchange,dir)).filter(item=>item.endsWith('.request.json'))){
      const file=path.join(exchange,dir,name);if(seen.has(file))continue;seen.add(file);answer(file,JSON.parse(fs.readFileSync(file,'utf8')));
    }
  }catch(error){stderr+=`\n[test] ${error.stack}`;}},50);
  const code=await new Promise(resolve=>{const kill=setTimeout(()=>child.kill('SIGKILL'),90000);child.on('exit',value=>{clearTimeout(kill);resolve(value);});});
  clearInterval(timer);
  assert.equal(code,0,stderr);
  assert.equal(payloads.length,2,'one live request per round');
  assert.notEqual(payloads[0].callId,payloads[1].callId,'round 2 is a fresh call, never the round-1 reply');
  assert.equal(payloads[0].payload.request.payload.priorReview,null);
  assert.equal(payloads[1].payload.request.payload.priorReview?.verdict,'changes_requested');
  assert.equal(payloads[1].payload.request.identity.attempt,2);
  assert.notEqual(payloads[1].payload.expected['target.mjs'],payloads[0].payload.expected['target.mjs'],'round 2 expects the round-1 bytes');
  const rows=fs.readFileSync(f.witness,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.type==='provider_develop').length,0);
  assert.deepEqual(rows.filter(row=>row.type==='review').map(row=>row.attempt),[1,2]);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
});

// Mixed batch with QA: a provider member then the session final member; the feature
// QA runs at the end and the batch reaches run_done with the session member committed.
test('a mixed v2 batch runs the provider member, then the session final member, through QA to run_done and commits both',async t=>{
  const f=fixture(t),exchange=path.join(f.root,'exchange'),seen=new Set(),kinds=[];
  const feature=path.join(f.specsDir,'1.work');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# Fixture\n\n- [ ] [AC-001] value is 43\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),'- [ ] T-001: implement\n  - 范围: `lib.mjs`\n- [ ] T-002: walk the page\n  - 范围: `qa.md`\n  - 开发: 会话\n\n## 依赖关系\n\n- T-002 依赖 T-001\n');
  fs.writeFileSync(path.join(feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases:[{id:'TC-001',origin:'generated',kind:'logic',
    blocking:true,acIds:['AC-001'],taskIds:['T-001'],title:'value is 43',preconditions:[],steps:['import lib.mjs'],expected:['value is 43'],cleanup:[]}]},null,1)+'\n');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir),taskGrammar:3}));
  const qa={commands:[{id:'value',caseIds:['TC-001'],command:[process.execPath,'-e',"import('./lib.mjs').then(m=>{if(m.value!==43)process.exit(1)})"]}],
    environment:{kind:'web',carrier:'browser',target:'local',scope:'local'},timeoutMs:60000};
  const workflow={qa,documentationPaths:[],applicableAgentFiles:[]};
  fs.writeFileSync(path.join(f.root,'run.json'),JSON.stringify({batch:{version:1,repositoryId:identity.repositoryId,batchId:'session-e2e-mixed',
    specsDir:f.specsDir,codeProject:f.codeProject,tasks:[
      {feature:'1.work',taskId:'T-001',scope:['lib.mjs'],requirements:['requirements.md']},
      {feature:'1.work',taskId:'T-002',scope:['qa.md'],requirements:['requirements.md']}],
    memberDevelopment:{'1.work/T-002':'session'}},
    workflows:{'1.work/T-001':workflow,'1.work/T-002':workflow}}));
  fs.writeFileSync(path.join(f.root,'control.json'),JSON.stringify({version:2,development:'provider',bootstrap:'disabled',qa:'run',qaFix:'disabled'}));
  fs.writeFileSync(path.join(f.root,'protected.json'),JSON.stringify({model:'fixture',timeoutMs:5000,
    checkCommands:[{id:'syntax',command:[process.execPath,'-e',"require('node:fs').existsSync('lib.mjs')&&process.exit(0)"]}]}));
  for(const task of ['T-001','T-002']){
    const dir=path.join(f.root,'answers','1.work',task);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected'}));
    fs.writeFileSync(path.join(dir,'qa-assess.json'),JSON.stringify({confirmed:true}));
  }
  // The fixture Codex now also develops the provider member T-001.
  const codex=path.join(f.root,'bin','codex');
  fs.writeFileSync(codex,fs.readFileSync(codex,'utf8').replace("if(prompt.includes('<cm-developer-data-json>')){record({type:'provider_develop'});process.exit(1);}",
    `if(prompt.includes('<cm-developer-data-json>')){
    const data=JSON.parse(prompt.split('<cm-developer-data-json>\\n')[1].split('\\n')[0]);
    record({type:'provider_develop',task:data.specification.task.id});fs.writeFileSync('lib.mjs','export const value = 43;\\n');
    const value={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
    for(const event of [{type:'thread.started',thread_id:'fixture-provider-author'},{type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])process.stdout.write(JSON.stringify(event)+'\\n');
    return;}`));
  fs.writeFileSync(f.plan,JSON.stringify({config:'run.json',mode:'create',hostContext:'session-e2e-host',controlConfig:'control.json',
    permissions:['--review-config','review.json','--protected-config','protected.json'],answers:'answers',
    liveEvidence:{directory:'exchange',kinds:['develop','qa_logic'],timeoutMs:60000}}));
  const reply=(file,request,result)=>{const target=file.replace(/\.request\.json$/,'.result.json'),tmp=target+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({type:'host_result',sessionId:request.sessionId,callId:request.callId,requestDigest:request.requestDigest,result}),{mode:0o600});
    fs.renameSync(tmp,target);};
  const answer=(file,request)=>{kinds.push(request.kind);
    if(request.kind==='develop'){
      assert.equal(request.payload.request.identity.taskId,'T-002');
      reply(file,request,{status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
        edits:[{path:'qa.md',beforeSha256:request.payload.expected['qa.md'],content:'# Walkthrough\n\nTC-001 checked.\n'}]});
    }else reply(file,request,{verdict:'SUPPORTED',evidence:['fixture: lib.mjs exports value 43']});
  };
  // Advance until the batch stops on its own; each advance may hand off to the next member.
  let last=null;
  for(let round=0;round<6;round++){
    if(round>0)fs.writeFileSync(f.plan,JSON.stringify({...JSON.parse(fs.readFileSync(f.plan,'utf8')),mode:'resume',originalHostContext:'session-e2e-host'}));
    const child=spawn(process.execPath,[BATCH,'--plan',f.plan,'advance'],{env:f.env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);
    const timer=setInterval(()=>{try{
      if(!fs.existsSync(exchange))return;
      for(const dir of fs.readdirSync(exchange))for(const name of fs.readdirSync(path.join(exchange,dir)).filter(item=>item.endsWith('.request.json'))){
        const file=path.join(exchange,dir,name);if(seen.has(file))continue;seen.add(file);answer(file,JSON.parse(fs.readFileSync(file,'utf8')));
      }
    }catch(error){stderr+=`\n[test] ${error.stack}`;}},50);
    const code=await new Promise(resolve=>{const kill=setTimeout(()=>child.kill('SIGKILL'),120000);child.on('exit',value=>{clearTimeout(kill);resolve(value);});});
    clearInterval(timer);
    assert.equal(code,0,stderr);
    last=JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1)).result;
    if(last.state==='run_done'||last.state==='blocked')break;
  }
  assert.equal(last.state,'run_done',JSON.stringify(last).slice(0,800));
  const rows=fs.readFileSync(f.witness,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row=>row.type==='provider_develop').map(row=>row.task),['T-001'],'only the provider member reaches the provider');
  assert.equal(kinds.filter(kind=>kind==='develop').length,1,'the session member is developed once through the live channel');
  assert.ok(kinds.includes('qa_logic'),'the feature QA asked the session for its logic case');
  const log=spawnSync('git',['-C',f.codeProject,'log','--format=%s'],{encoding:'utf8'}).stdout;
  assert.match(log,/T-002/,`the batch committed the session final member: ${log}`);
  assert.match(log,/T-001/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'qa.md'),'utf8'),'# Walkthrough\n\nTC-001 checked.\n');
});
