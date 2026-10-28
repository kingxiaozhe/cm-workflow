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
