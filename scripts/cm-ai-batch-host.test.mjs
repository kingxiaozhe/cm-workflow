import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {preflightMatches} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const cli=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
test('batch host input limit reaches transport without opening a host',async()=>{
  const {serveHostTransport}=await import('./cm-ai-batch-host.mjs');
  assert.equal(typeof serveHostTransport,'function');
  let seen;
  await serveHostTransport({host:{}},'1048576',async options=>{seen=options.inputLimit;});
  assert.equal(seen,1048576);
  for(const raw of ['65535','4194305','1.5'])
    await assert.rejects(serveHostTransport({host:{}},raw,async()=>{}),/invalid_arguments/);
});
test('batch host help documents input limit',()=>{
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--input-limit BYTES/);
});
test('batch host CLI rejects out-of-range and non-integer input limits before opening a run',()=>{
  const f=fixture();
  try{
    for(const raw of ['65535','4194305','1.5']){
      const run=spawnSync(process.execPath,[cli,...f.args,'--input-limit',raw],{encoding:'utf8'});
      assert.equal(run.status,1);assert.match(run.stderr,/invalid_arguments/);
      assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
function fixture(runtime='codex'){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-host-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work',bin=path.join(root,'bin');
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Synthetic batch\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Two synthetic exports and README\n');
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','fixture baseline']]){
    const result=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  const batch={version:1,repositoryId:'batch-host',batchId:'batch-host-run',specsDir,codeProject,
    tasks:[1,2].map(n=>({feature,taskId:`T-00${n}`,scope:[`task${n}.mjs`,...(n===2?['README.md']:[])],requirements:['requirements.md']}))};
  const workflows=Object.fromEntries(batch.tasks.map((task,index)=>[`${feature}/${task.taskId}`,{
    documentationPaths:index===1?['README.md']:[],applicableAgentFiles:[],qa:{
      commands:[{id:'value',caseIds:[],command:[process.execPath,'-e',
        `import('./task${index+1}.mjs').then(m=>{if(m.value!==${41+index})process.exit(1)})`]}],
      environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}]));
  const config=path.join(root,'batch.json');fs.writeFileSync(config,JSON.stringify({batch,workflows}));
  const review=path.join(root,'review.json');
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    ...(runtime==='claude'?{provider:runtime}:{}),prompt_transport:'stdin',
    config_fingerprint:(runtime==='claude'?claudeReviewFingerprint:configFingerprint)({cwd:codeProject,model:'fixture'})}}));
  const fake=path.join(bin,runtime);fs.copyFileSync(fileURLToPath(new URL(`./fixtures/${runtime}-review-process.mjs`,import.meta.url)),fake);fs.chmodSync(fake,0o700);
  return {runtime,root,specsDir,codeProject,config,review,batch,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},
    args:['serve','--config',config,'--host-context','current-batch-host','--allow-development','--review-config',review,'--allow-qa',
      ...(runtime==='claude'?['--runtime','claude']:[])]};
}

// operations are sent one after another (each after the previous reply); the
// session closes after the last. failDevelop: task ids whose next develop
// answer is a bare failure after the session wrote (develop_answer_missing).
function execute(f,approvals,{cancel=false,args=[],operations=[{operation:'advance',requestId:'advance'}],failDevelop=new Set()}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...f.args,...args,...approvals.flatMap(value=>['--allow-review',value])],
      {env:f.env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='',sessionId;const calls=[],rows=[];
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('batch host timeout'));},Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??60000));
    child.stderr.on('data',part=>{stderr+=part;});child.once('error',reject);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    const respond=(row,result)=>send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
    child.stdout.on('data',part=>{
      buffer+=part;let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;
        try{
          const row=JSON.parse(line);rows.push(row);
          if(row.type==='host_ready')sessionId=row.sessionId;
          if(row.type==='host_request'){
            const payload=row.payload,identity=payload.identity??payload.request.identity;
            const cwd=f.parallel&&identity.taskId!=='T-003'
              ?path.join(f.root,'.cm-worktrees',f.batch.batchId.slice(0,8),identity.taskId):f.codeProject;
            calls.push(`${identity.taskId}:${row.kind}`);
            if(cancel){send({operation:'status',requestId:'status'});send({operation:'cancel',requestId:'cancel'});continue;}
            if(row.kind==='develop'){
              assert.equal(payload.request.provider,f.runtime);
              const n=Number(identity.taskId.slice(-1));
              assert.deepEqual(payload.request.payload.scope,f.batch.tasks[n-1].scope);
              assert.equal(payload.request.payload.specification.task.id,identity.taskId);
              assert.deepEqual(payload.request.payload.specification.sources,buildManifest(f.specsDir));
              const content=`export const value = ${40+n};\n`;
              if(!f.protected)fs.writeFileSync(path.join(cwd,`task${n}.mjs`),content);
              if(failDevelop.delete(identity.taskId)){respond(row,{status:'failed',code:'session_error'});continue;}
              respond(row,{status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
                retrospective:{status:'no_new_lesson',candidates:[],reason:null}},...(f.protected?{edits:
                  payload.request.payload.scope.map(file=>({path:file,beforeSha256:payload.expected[file],
                    content:file==='README.md'?'# Exports 41 and 42\n':content}))}:{})});
            }else if(row.kind==='check'){
              const checks=payload.scope.filter(file=>file.endsWith('.mjs')).map(file=>{
                const command=[process.execPath,'--check',path.join(cwd,file)];
                const result=spawnSync(command[0],command.slice(1));assert.equal(result.status,0);
                return {id:'syntax',command,outcome:'passed',exitCode:0,evidence:'Actual Node syntax check exited 0'};
              });respond(row,checks);
            }else if(row.kind==='qa_assess')respond(row,{scores:{scope:2,risk:2,accumulation:2,boundary:2},
              changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}});
            else if(row.kind==='documentation_sync'){
              assert.equal(identity.taskId,'T-002');assert.deepEqual(payload.paths,['README.md']);
              fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Exports 41 and 42\n');respond(row,{status:'completed'});
            }else if(row.kind==='documentation_inspect'){
              assert.equal(fs.readFileSync(path.join(f.codeProject,'README.md'),'utf8'),'# Exports 41 and 42\n');
              const {syncId,packageDigest,contextDigest}=payload;
              respond(row,{syncId,identity,packageDigest,contextDigest,status:'completed',reason:'Actual README checked',
                at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')});
            }else assert.fail(`Unexpected ${row.kind}`);
          }
          const index=operations.findIndex(item=>item.requestId===row.requestId);
          if(index>=0&&(row.result||row.error)){
            if(index+1<operations.length)send(operations[index+1]);else send({type:'host_close',sessionId});
          }
        }catch(error){clearTimeout(timer);child.kill('SIGTERM');reject(error);}
      }
    });
    child.once('close',code=>{clearTimeout(timer);resolve({code,stderr,calls,rows,
      results:Object.fromEntries(operations.map(item=>[item.requestId,rows.find(row=>row.requestId===item.requestId)?.result])),
      result:rows.find(row=>row.requestId===operations.at(-1).requestId)?.result});});
    send(operations[0]);
  });
}

test('protected Claude batch uses actual sandbox edits/checks and original two-task completion with nested specs',
  {skip:process.platform!=='darwin'},async()=>{
  const f=fixture('claude');f.protected=true;
  try{
    const nested=path.join(f.codeProject,'specs');fs.renameSync(f.specsDir,nested);f.specsDir=nested;f.batch.specsDir=nested;
    fs.writeFileSync(path.join(f.codeProject,'.gitignore'),'specs/\n');
    for(const args of [['add','.gitignore'],['commit','-m','ignore nested runtime specs']]){
      const result=spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    }
    const bundle=JSON.parse(fs.readFileSync(f.config,'utf8'));bundle.batch=f.batch;fs.writeFileSync(f.config,JSON.stringify(bundle));
    const protection=path.join(f.root,'protection.json');
    fs.writeFileSync(protection,JSON.stringify({timeoutMs:5000,checkCommands:[{id:'syntax',command:[process.execPath,'-e',
      "const fs=require('node:fs'),a=require('node:assert/strict');a.throws(()=>fs.writeFileSync('specs/1.work/tasks.md','bad'));a.throws(()=>fs.writeFileSync('AGENTS.md','bad'));for(const p of fs.readdirSync('.').filter(p=>/^task.*mjs$/.test(p)))a.match(fs.readFileSync(p,'utf8'),/export const value = 4[12];/);"]}]}));
    f.args.push('--protected-conversation-config',protection);
    const result=await execute(f,['1.work/T-001:1','1.work/T-002:1']);
    assert.equal(result.code,0,result.stderr);assert.equal(result.result.state,'run_done',JSON.stringify(result.result));
    assert.deepEqual(result.calls,['T-001:develop','T-001:qa_assess','T-002:develop','T-002:qa_assess','T-002:documentation_inspect']);
    assert.equal(fs.readFileSync(path.join(nested,'1.work/tasks.md'),'utf8').match(/\[x\]/g).length,2);
    const resume=await execute(f,[]);assert.equal(resume.result.state,'run_done');assert.deepEqual(resume.calls,['T-002:documentation_inspect']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const runtime of ['codex','claude'])test(`${runtime} batch CLI preserves per-task review authorization and reaches one original run_done without redispatch`,async()=>{
  const f=fixture(runtime);
  try{
    const first=await execute(f,['1.work/T-001:1']);assert.equal(first.code,0,first.stderr);
    assert.equal(first.result.identity.taskId,'T-002');assert.equal(first.result.code,'decision_required');
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[ ] T-002'));
    assert.deepEqual(first.calls,['T-001:develop','T-001:check','T-001:check','T-001:qa_assess',
      'T-002:develop','T-002:documentation_sync','T-002:check']);
    const original=fs.readFileSync(f.config,'utf8'),changed=JSON.parse(original);
    changed.workflows['1.work/T-002'].documentationPaths=[];
    fs.writeFileSync(f.config,JSON.stringify(changed));
    const drift=await execute(f,['1.work/T-002:1']);
    assert.equal(drift.result.outcome,'blocked');assert.deepEqual(drift.calls,[]);
    fs.writeFileSync(f.config,original);
    if(runtime==='claude'){
      const saved=[...f.args];f.args[f.args.length-1]='codex';
      const wrongRuntime=await execute(f,[]);assert.equal(wrongRuntime.result.outcome,'blocked');
      assert.deepEqual(wrongRuntime.calls,[]);f.args=saved;
    }
    const second=await execute(f,['1.work/T-002:1']);assert.equal(second.code,0,second.stderr);
    assert.equal(second.result.state,'run_done',JSON.stringify(second.result));
    assert.deepEqual(second.calls,['T-002:check','T-002:qa_assess','T-002:documentation_inspect']);
    const reopened=await execute(f,[]);assert.equal(reopened.code,0,reopened.stderr);
    assert.equal(reopened.result.state,'run_done',JSON.stringify(reopened.result));
    assert.deepEqual(reopened.calls,['T-002:documentation_inspect']);
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.event==='run_done').length,1);
    assert.equal(rows.filter(row=>row.event==='decision'&&row.phase==='batch_handoff').length,1);
    assert.equal(rows.filter(row=>row.event==='test_run'&&row.phase==='start').length,2);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const runtime of ['codex','claude'])test(`${runtime} batch CLI cancellation remains durable and an unknown task approval rejects before execution`,async()=>{
  const f=fixture(runtime);
  try{
    const bad=spawnSync(process.execPath,[cli,...f.args,'--allow-review','1.work/T-999:1'],{env:f.env,encoding:'utf8',timeout:3000});
    assert.equal(bad.status,1);assert(bad.stderr.includes('review_task_mismatch'));assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
    const stopped=await execute(f,[],{cancel:true});assert.equal(stopped.code,0,stopped.stderr);
    assert.equal(stopped.result.code,'cancelled');assert.equal(stopped.calls.length,1);
    assert(stopped.rows.some(row=>row.requestId==='status'));
    const reopened=await execute(f,[]);assert.equal(reopened.result.code,'cancelled');assert.deepEqual(reopened.calls,[]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});


test('parallel member loopback preflights bind worktree cwd, stop before start and reuse on resume',async()=>{
  const f=fixture();f.parallel=true;
  try{
    f.batch.tasks=[1,2,3].map(n=>({feature:'1.work',taskId:`T-00${n}`,scope:[`task${n}.mjs`],requirements:['requirements.md']}));
    f.batch.parallel=[['1.work/T-001','1.work/T-002']];
    fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
    fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
    const original=JSON.parse(fs.readFileSync(f.config,'utf8')).workflows['1.work/T-001'];
    fs.writeFileSync(f.config,JSON.stringify({batch:f.batch,workflows:Object.fromEntries(f.batch.tasks.map(task=>[`1.work/${task.taskId}`,original]))}));
    const git=args=>{const result=spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
    git(['init','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
    git(['add','-A']);git(['commit','--allow-empty','-m','synthetic baseline']);
    const log=path.join(f.root,'probe-cwds.jsonl'),fail=path.join(f.root,'fail-probe');
    fs.writeFileSync(fail,'fail second member');
    const processFixture=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
    fs.writeFileSync(path.join(f.root,'bin','codex'),`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(cwd)+'\\n');
if(cwd.endsWith('T-002')&&fs.existsSync(${JSON.stringify(fail)}))process.exit(1);
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
  const result=cp.spawnSync(process.execPath,[${JSON.stringify(processFixture)},...args],{input,encoding:'utf8'});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);
});
`,{mode:0o700});
    const probes=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    const failed=await execute(f,['1.work/T-001:1','1.work/T-002:1']);
    assert.equal(failed.result.code,'review_preflight_failed',JSON.stringify(failed));
    assert.equal(failed.result.currentTask,'1.work/T-002');assert.deepEqual(failed.calls,[]);
    assert.equal(probes().length,2);
    fs.unlinkSync(fail);
    const first=await execute(f,[]);assert.equal(first.result.code,'decision_required',JSON.stringify(first));
    assert.equal(first.calls.filter(call=>call.endsWith(':develop')).length,2,JSON.stringify(first));
    const directory=path.join(f.specsDir,'.reviews','.execution',f.batch.batchId);
    const receipts=[1,2].map(n=>fs.readFileSync(path.join(directory,`preflight-T-00${n}.json`),'utf8'));
    for(const [index,bytes] of receipts.entries()){
      const config=JSON.parse(bytes),cwd=path.join(f.root,'.cm-worktrees',f.batch.batchId.slice(0,8),`T-00${index+1}`);
      assert(preflightMatches(config.preflight,{cwd,model:'fixture',disabledSkills:[],promptTransport:'stdin'}));
      assert(!preflightMatches(config.preflight,{cwd:f.codeProject,model:'fixture',disabledSkills:[],promptTransport:'stdin'}));
      assert.equal(config.preflight.real_model_requests,0);assert.equal(config.preflight.listener_closed,true);
      assert(probes().includes(cwd));
    }
    assert.equal(probes().length,3);
    const resumed=await execute(f,[]);assert.equal(resumed.result.code,'decision_required');assert.deepEqual(resumed.calls,[]);
    assert.equal(probes().length,3);
    assert.deepEqual([1,2].map(n=>fs.readFileSync(path.join(directory,`preflight-T-00${n}.json`),'utf8')),receipts);
    const stale=JSON.parse(receipts[1]);stale.preflight.config_fingerprint='0'.repeat(64);
    fs.writeFileSync(path.join(directory,'preflight-T-002.json'),JSON.stringify(stale));
    const refreshed=await execute(f,[]);assert.equal(refreshed.result.code,'decision_required');assert.deepEqual(refreshed.calls,[]);
    assert.equal(probes().length,4);
    assert.equal(fs.readFileSync(path.join(directory,'preflight-T-002.json'),'utf8'),receipts[1]);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// 53c385e moved the execution-policy member preflight cache out of .reviews/.execution.
// A batch that had already cached there (old layout) was refused by the external run
// guard on every later launch. The exact old cache now moves to the current location
// and is reused without a new loopback; anything else is refused with a reason.
function legacyParallelFixture(){
  const f=fixture();f.parallel=true;
  f.batch.tasks=[1,2,3].map(n=>({feature:'1.work',taskId:`T-00${n}`,scope:[`task${n}.mjs`],requirements:['requirements.md']}));
  f.batch.parallel=[['1.work/T-001','1.work/T-002']];
  fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  const original=JSON.parse(fs.readFileSync(f.config,'utf8')).workflows['1.work/T-001'];
  fs.writeFileSync(f.config,JSON.stringify({batch:f.batch,workflows:Object.fromEntries(f.batch.tasks.map(task=>[`1.work/${task.taskId}`,original]))}));
  f.legacy=path.join(f.specsDir,'.reviews','.execution',f.batch.batchId);
  f.current=path.join(f.specsDir,'.reviews','external-preflight',f.batch.batchId);
  f.worktree=taskId=>path.join(f.root,'.cm-worktrees',f.batch.batchId.slice(0,8),taskId);
  return f;
}
const legacyReceipt=(f,taskId,extra={})=>JSON.stringify({model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',
  config_fingerprint:configFingerprint({cwd:f.worktree(taskId),model:'fixture',disabledSkills:[]}),prompt_transport:'stdin',
  real_model_requests:0,listener_closed:true,...extra}})+'\n';
function writeLegacy(f,files){
  fs.mkdirSync(f.legacy,{recursive:true,mode:0o700});fs.chmodSync(f.legacy,0o700);
  for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(f.legacy,name),bytes,{mode:0o600});
}
test('execution-policy batch moves an exact old-layout member preflight cache out of the run directory and reuses it',async()=>{
  const f=legacyParallelFixture();
  try{
    const log=path.join(f.root,'probe-cwds.jsonl'),fail=path.join(f.root,'fail-probe');
    fs.writeFileSync(fail,'fail second member');
    const processFixture=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
    fs.writeFileSync(path.join(f.root,'bin','codex'),`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),cwd=args[args.indexOf('--cd')+1];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(cwd)+'\\n');
if(cwd.endsWith('T-002')&&fs.existsSync(${JSON.stringify(fail)}))process.exit(1);
let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>{
  const result=cp.spawnSync(process.execPath,[${JSON.stringify(processFixture)},...args],{input,encoding:'utf8'});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);
});
`,{mode:0o700});
    const probes=()=>fs.readFileSync(log,'utf8').trim().split('\n').length;
    const policy=['--execution-optimizations'];
    // Stop before any member run exists (T-002's loopback fails): T-001 gets a real receipt.
    const failed=await execute(f,['1.work/T-001:1','1.work/T-002:1'],{args:policy});
    assert.equal(failed.result.code,'review_preflight_failed',JSON.stringify(failed));
    fs.unlinkSync(fail);
    const real=fs.readFileSync(path.join(f.current,'preflight-T-001.json'),'utf8');
    // Old layout: the same receipts under .reviews/.execution/<batchId>, nothing at the new place.
    const second=JSON.parse(real);second.preflight.config_fingerprint=configFingerprint({cwd:f.worktree('T-002'),model:'fixture',disabledSkills:[]});
    const receipts={'preflight-T-001.json':real,'preflight-T-002.json':JSON.stringify(second)+'\n'};
    assert.deepEqual(Object.keys(JSON.parse(receipts['preflight-T-002.json'])),Object.keys(JSON.parse(real)));
    fs.rmSync(path.dirname(f.current),{recursive:true});writeLegacy(f,receipts);
    const before=probes();
    const resumed=await execute(f,[],{args:policy});
    assert.equal(resumed.code,0,resumed.stderr);
    assert.equal(resumed.result.code,'decision_required',JSON.stringify(resumed.result));
    assert.equal(resumed.calls.filter(call=>call.endsWith(':develop')).length,2,JSON.stringify(resumed.calls));
    assert.equal(probes(),before,'migrated receipts are reused without a new loopback');
    assert(!fs.existsSync(f.legacy));
    for(const [name,bytes] of Object.entries(receipts))assert.equal(fs.readFileSync(path.join(f.current,name),'utf8'),bytes);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('old-layout preflight cache that is not the exact old shape or binding is refused with a reason and left untouched',async()=>{
  const {migrateLegacyPreflightCache}=await import('./cm-ai-batch-host.mjs');
  const review={model:'fixture',preflight:{},disabledSkills:[]};
  const cases=[
    ['an unrelated entry',f=>({'preflight-T-001.json':legacyReceipt(f,'T-001'),'state.json':'{}'}),/state\.json/],
    ['a non-member task',f=>({'preflight-T-003.json':legacyReceipt(f,'T-003')}),/preflight-T-003\.json/],
    ['a stale fingerprint',f=>({'preflight-T-001.json':legacyReceipt(f,'T-001',{config_fingerprint:'0'.repeat(64)})}),/指纹/],
    ['another member cwd',f=>({'preflight-T-002.json':legacyReceipt(f,'T-001')}),/指纹/],
    ['a reviewer budget',f=>({'preflight-T-001.json':JSON.stringify({...JSON.parse(legacyReceipt(f,'T-001')),timeoutMs:5})}),/不一致/],
    ['not a cache',f=>({'preflight-T-001.json':'{"model":"fixture"}'}),/格式/],
  ];
  for(const [label,files,pattern] of cases){
    const f=legacyParallelFixture();
    try{
      const content=files(f);writeLegacy(f,content);
      assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),error=>error.code==='legacy_preflight_cache_invalid'
        &&pattern.test(error.reason)&&/下一步/.test(error.reason)&&error.reason.includes(f.legacy),label);
      assert.deepEqual(fs.readdirSync(f.legacy).sort(),Object.keys(content).sort(),label);
      assert(!fs.existsSync(f.current),label);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
  const f=legacyParallelFixture();
  try{
    // Symlinked file, loose directory mode, and a differing file at the new place: refused.
    writeLegacy(f,{});fs.symlinkSync(path.join(f.root,'review.json'),path.join(f.legacy,'preflight-T-001.json'));
    assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),/legacy_preflight_cache_invalid/);
    fs.unlinkSync(path.join(f.legacy,'preflight-T-001.json'));
    writeLegacy(f,{'preflight-T-001.json':legacyReceipt(f,'T-001'),'preflight-T-002.json':legacyReceipt(f,'T-002')});
    fs.chmodSync(f.legacy,0o755);
    assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),/legacy_preflight_cache_invalid/);
    fs.chmodSync(f.legacy,0o700);
    fs.mkdirSync(f.current,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(f.current,'preflight-T-002.json'),legacyReceipt(f,'T-002',{listener_closed:false}),{mode:0o600});
    assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),error=>/已有不同内容/.test(error.reason));
    assert.equal(fs.readdirSync(f.legacy).length,2);
    assert.throws(()=>migrateLegacyPreflightCache(f.batch,null,'codex'),/legacy_preflight_cache_invalid/);
    // An identical copy already at the new place drops the old one; the other one moves.
    fs.writeFileSync(path.join(f.current,'preflight-T-002.json'),legacyReceipt(f,'T-002'));
    assert.deepEqual(migrateLegacyPreflightCache(f.batch,review,'codex'),{moved:['preflight-T-001.json'],dropped:['preflight-T-002.json']});
    assert(!fs.existsSync(f.legacy));
    assert.equal(fs.readFileSync(path.join(f.current,'preflight-T-001.json'),'utf8'),legacyReceipt(f,'T-001'));
    // Idempotent: nothing left to migrate.
    assert.deepEqual(migrateLegacyPreflightCache(f.batch,review,'codex'),{moved:[],dropped:[]});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
// Batch 4 review round 1: the migration commits without overwriting, validates the
// exact bytes it moves, re-checks both sides before dropping a duplicate and leaves
// a resumable state when it stops part way. fs is patched at the commit step only.
test('old-layout preflight migration never overwrites, re-checks what it commits and resumes an interrupted move',async()=>{
  const {migrateLegacyPreflightCache}=await import('./cm-ai-batch-host.mjs');
  const review={model:'fixture',preflight:{},disabledSkills:[]};
  const {linkSync,unlinkSync}=fs;
  const run=async(label,files,patch,check)=>{
    const f=legacyParallelFixture();
    try{
      writeLegacy(f,files(f));
      if(patch.existing){fs.mkdirSync(f.current,{recursive:true,mode:0o700});
        for(const [name,bytes] of Object.entries(patch.existing(f)))fs.writeFileSync(path.join(f.current,name),bytes,{mode:0o600});}
      if(patch.link)fs.linkSync=(...args)=>{patch.link(f,...args);return linkSync.apply(fs,args);};
      if(patch.unlink)fs.unlinkSync=(...args)=>{patch.unlink(f,...args);return unlinkSync.apply(fs,args);};
      let error=null;try{migrateLegacyPreflightCache(f.batch,review,'codex');}catch(cause){error=cause;}
      finally{fs.linkSync=linkSync;fs.unlinkSync=unlinkSync;}
      await check(f,error,label);
    }finally{fs.linkSync=linkSync;fs.unlinkSync=unlinkSync;fs.rmSync(f.root,{recursive:true,force:true});}
  };
  const one=f=>({'preflight-T-001.json':legacyReceipt(f,'T-001')});
  const refused=(error,pattern,label)=>assert(error?.code==='legacy_preflight_cache_invalid'&&pattern.test(error.reason),`${label}: ${error?.code} ${error?.reason}`);
  // A different file appears at the target between planning and commit: not replaced.
  await run('target appears',one,{link:(f,from,to)=>{if(!fs.existsSync(to))fs.writeFileSync(to,'other\n',{mode:0o600});}},(f,error,label)=>{
    refused(error,/在迁移时出现/,label);
    assert.equal(fs.readFileSync(path.join(f.current,'preflight-T-001.json'),'utf8'),'other\n');
    assert.equal(fs.readFileSync(path.join(f.legacy,'preflight-T-001.json'),'utf8'),legacyReceipt(f,'T-001'));
  });
  // The source changes in place (same inode) after validation: the link is undone.
  await run('source rewritten',one,{link:(f,from)=>fs.writeFileSync(from,legacyReceipt(f,'T-001',{listener_closed:false}))},(f,error,label)=>{
    refused(error,/被改动/,label);
    assert(!fs.existsSync(path.join(f.current,'preflight-T-001.json')));
    assert(fs.existsSync(path.join(f.legacy,'preflight-T-001.json')));
  });
  // A duplicate's new copy changes after planning: the old copy is kept.
  await run('duplicate changed',f=>({'preflight-T-001.json':legacyReceipt(f,'T-001'),'preflight-T-002.json':legacyReceipt(f,'T-002')}),
    {existing:f=>({'preflight-T-002.json':legacyReceipt(f,'T-002')}),
      link:f=>fs.writeFileSync(path.join(f.current,'preflight-T-002.json'),legacyReceipt(f,'T-002',{listener_closed:false}))},(f,error,label)=>{
      refused(error,/被改动/,label);
      assert(fs.existsSync(path.join(f.legacy,'preflight-T-002.json')));
    });
  // A stop after the link (both names on one inode) is finished by the next launch.
  await run('interrupted move',one,{unlink:(f,file)=>{if(file.startsWith(f.legacy))throw Object.assign(new Error('crash'),{code:'synthetic_crash'});}},(f,error,label)=>{
    assert.equal(error?.code,'synthetic_crash',label);
    const a=fs.lstatSync(path.join(f.legacy,'preflight-T-001.json')),b=fs.lstatSync(path.join(f.current,'preflight-T-001.json'));
    assert.deepEqual([a.ino,a.nlink],[b.ino,2]);
    assert.deepEqual(migrateLegacyPreflightCache(f.batch,review,'codex'),{moved:['preflight-T-001.json'],dropped:[]});
    assert(!fs.existsSync(f.legacy));
    assert.equal(fs.lstatSync(path.join(f.current,'preflight-T-001.json')).nlink,1);
    assert.equal(fs.readFileSync(path.join(f.current,'preflight-T-001.json'),'utf8'),legacyReceipt(f,'T-001'));
  });
});
// Batch 4 review round 1: the target directory and its parent are checked before any
// delete or move, also when every old file is a duplicate (nothing to move).
test('old-layout preflight migration refuses a symlinked target even when every old file is a duplicate',async()=>{
  const {migrateLegacyPreflightCache}=await import('./cm-ai-batch-host.mjs');
  const review={model:'fixture',preflight:{},disabledSkills:[]};
  for(const linked of ['target','parent']){
    const f=legacyParallelFixture();
    try{
      const files={'preflight-T-001.json':legacyReceipt(f,'T-001'),'preflight-T-002.json':legacyReceipt(f,'T-002')};
      writeLegacy(f,files);
      // The real directory holds identical copies; the expected path only links to it.
      const elsewhere=path.join(f.root,'elsewhere'),real=path.join(elsewhere,linked==='target'?'':f.batch.batchId);
      fs.mkdirSync(real,{recursive:true,mode:0o700});fs.chmodSync(elsewhere,0o700);
      for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(real,name),bytes,{mode:0o600});
      if(linked==='target'){fs.mkdirSync(path.dirname(f.current),{recursive:true,mode:0o700});fs.symlinkSync(elsewhere,f.current);}
      else fs.symlinkSync(elsewhere,path.dirname(f.current));
      assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),
        error=>error.code==='legacy_preflight_cache_invalid'&&/不是权限 0700 的普通目录/.test(error.reason),linked);
      assert.deepEqual(fs.readdirSync(f.legacy).sort(),Object.keys(files).sort(),linked);
      for(const [name,bytes] of Object.entries(files))assert.equal(fs.readFileSync(path.join(f.legacy,name),'utf8'),bytes);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  }
  // A target copy that breaks the file constraints (mode, links) is refused too.
  const f=legacyParallelFixture();
  try{
    writeLegacy(f,{'preflight-T-001.json':legacyReceipt(f,'T-001')});
    fs.mkdirSync(f.current,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(f.current,'preflight-T-001.json'),legacyReceipt(f,'T-001'),{mode:0o644});
    assert.throws(()=>migrateLegacyPreflightCache(f.batch,review,'codex'),/legacy_preflight_cache_invalid/);
    assert(fs.existsSync(path.join(f.legacy,'preflight-T-001.json')));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('provider development grants select worktree runtimes and keep the serial task on protected conversation transport',async()=>{
  const f=fixture();
  try{
    const worktree=path.join(f.root,'member');fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree,'.cm-workflow.yml'),
      'version: 1\nruntimes:\n  available: both\nroles:\n  coder:\n    adapter: claude-cli\n  reviewer:\n    adapter: codex-cli\n');
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\nruntimes:\n  available: codex\n');
    const protection={model:'fixture-coder',checkCommands:[{id:'syntax',command:[process.execPath,'--check','task1.mjs']}],timeoutMs:12345};
    const protectedFile=path.join(f.root,'protected.json');fs.writeFileSync(protectedFile,JSON.stringify(protection));
    const stub=path.join(f.root,'stub.mjs'),host=path.join(f.root,'batch-host.mjs');
    const hostModule=new URL('./cm-ai-host.mjs',import.meta.url).href;
    const sessionModule=new URL('../runtime/js/cm-ai/host-session.mjs',import.meta.url).href;
    const workerModule=new URL('../runtime/js/cm-ai/codex-config.mjs',import.meta.url).href;
    fs.writeFileSync(stub,`
import {configFingerprint} from ${JSON.stringify(workerModule)};
export {readConversationReviewConfiguration,readConversationReviewConfigurationValue,readConversationProtection} from ${JSON.stringify(hostModule)};
export {parseHostInputLimit,inputLimitReason} from ${JSON.stringify(sessionModule)};
export const calls=[];export let scheduler;
export {batchTaskRunId,BATCH_MEMBER_ACTIONS} from ${JSON.stringify(new URL('./cm-ai-batch-run.mjs',import.meta.url).href)};
export function createConversationExecution(...args){calls.push(args);return {};}
export async function runReviewPreflight(definition,{model}){return {model,disabledSkills:[],preflight:{passed:true,
  cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:definition.codeProject,model})}};}
export function createCmAiBatch(options){scheduler=options;return {async handle(){
  for(const [index,task] of options.configuration.tasks.entries())await options.executionFor({feature:task.feature,
    identity:{taskId:task.taskId},codeProject:index===0?${JSON.stringify(worktree)}:options.configuration.codeProject},
    {parallelMember:index===0});return {};}};}
export async function serveCmAiHost({host}){await host.handle({});}
`);
    // Keep production parsing and executionFor intact; capture the factory boundary without launching a CLI.
    const stubUrl=pathToFileURL(stub).href;
    const source=fs.readFileSync(cli,'utf8').replace(/from '([^']+)'/g,(match,specifier)=>{
      if(['./cm-ai-batch-run.mjs','./cm-ai-host.mjs','../runtime/js/cm-ai/host-session.mjs'].includes(specifier))return `from '${stubUrl}'`;
      return specifier.startsWith('.')?`from '${new URL(specifier,new URL('./cm-ai-batch-host.mjs',import.meta.url)).href}'`:match;
    });
    fs.writeFileSync(host,source);
    const {main}=await import(pathToFileURL(host).href),capture=await import(stubUrl);
    let stderr='';const io={input:{},output:{write(){}},error:{write(value){stderr+=value;}}};
    const args=[...f.args,'--protected-config',protectedFile,'--allow-provider-development','1.work/T-001:2'];
    assert.equal(await main(args,io),0,stderr);
    assert.equal(capture.calls.length,2);
    const member=capture.calls[0][8],serial=capture.calls[1][8];
    assert.equal(member.parallelMember,true);
    assert.deepEqual(member.protection,{checkCommands:protection.checkCommands,timeoutMs:12345});
    assert.deepEqual(member.providerDevelopment,{model:'fixture-coder',attempt:2,coderRuntime:'claude',reviewerRuntime:'codex'});
    assert.equal(serial.parallelMember,false);
    assert.deepEqual(serial.protection,{checkCommands:protection.checkCommands,timeoutMs:12345});
    assert.equal(Object.hasOwn(serial,'providerDevelopment'),false);
    assert.deepEqual(capture.scheduler.checkCommands,protection.checkCommands);
    assert.equal(capture.scheduler.checkTimeoutMs,12345);
    for(const extra of [
      ['--allow-provider-development','1.work/T-001:1'],
      ['--allow-provider-development','1.work/T-999:1'],
      ['--allow-provider-development','1.work/T-002:3'],
      ['--protected-conversation-config',protectedFile],
    ]){
      stderr='';assert.equal(await main([...args,...extra],io),1);
      assert.equal(JSON.parse(stderr).error.code,'invalid_arguments');
      assert.equal(capture.calls.length,2);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

// Q24 (real host): a serial member whose develop answer came back as a bare failure
// after the session wrote stops at develop_redo. The batch host used to accept only
// advance/status/cancel/reconcile_review, so the batch stayed stuck there. Now the
// batch host forwards develop_redo to that member's run (same cm-ai entry, one-shot
// per-member grant) and the next advance redoes the round and finishes the batch.
test('Q24 batch host recovers a serial member stopped at develop_redo and continues the batch',async()=>{
  const f=fixture();
  try{
    const approvals=['1.work/T-001:1','1.work/T-002:1'];
    const first=await execute(f,approvals,{failDevelop:new Set(['T-001'])});
    assert.equal(first.code,0,first.stderr);
    assert.deepEqual([first.result.state,first.result.code,first.result.pendingAction],['blocked','develop_answer_missing','develop_redo'],JSON.stringify(first.result));
    assert.match(first.result.guidance.nextStep,/--allow-develop-redo 1\.work\/T-001/);assert.deepEqual(first.calls,['T-001:develop']);
    const redo={operation:'develop_redo',requestId:'redo',taskKey:'1.work/T-001',reason:'会话已停止修改代码'};
    // advance alone never redispatches; the operation needs its per-member grant.
    const refused=await execute(f,approvals,{operations:[{operation:'advance',requestId:'advance'},redo]});
    assert.equal(refused.results.advance.pendingAction,'develop_redo');
    assert.deepEqual([refused.result.outcome,refused.result.code],['rejected','batch_member_action_authorization_required']);
    assert.match(refused.result.reason,/--allow-develop-redo 1\.work\/T-001/);assert.deepEqual(refused.calls,[]);
    const bad=spawnSync(process.execPath,[cli,...f.args,'--allow-develop-redo','1.work/T-999'],{env:f.env,encoding:'utf8',timeout:5000});
    assert.equal(bad.status,1);assert.match(bad.stderr,/invalid_arguments/);assert.match(bad.stderr,/FEATURE\/TASK/);
    for(const [flag,code] of [['--revise-qa-config','batch_qa_revision_unavailable'],['--rebind-spec-material','batch_spec_rebind_unavailable']]){
      const unsupported=spawnSync(process.execPath,[cli,...f.args,flag,'x'],{env:f.env,encoding:'utf8',timeout:5000});
      assert.equal(unsupported.status,1);assert.match(unsupported.stderr,new RegExp(code));assert.match(unsupported.stderr,/出口/);
    }
    const recovered=await execute(f,approvals,{args:['--allow-develop-redo','1.work/T-001'],
      operations:[redo,{operation:'advance',requestId:'advance'}]});
    assert.equal(recovered.code,0,recovered.stderr);
    assert.deepEqual([recovered.results.redo.outcome,recovered.results.redo.pendingAction,recovered.results.redo.taskKey],
      ['recorded','resume','1.work/T-001'],JSON.stringify(recovered.results.redo));
    assert.equal(recovered.result.state,'run_done',JSON.stringify(recovered.result));
    assert.deepEqual(recovered.calls.slice(0,2),['T-001:develop','T-001:check']);
    assert(recovered.calls.includes('T-002:develop'));
    assert.equal(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').match(/\[x\]/g).length,2);
    const {batchTaskRunId}=await import('./cm-ai-batch-run.mjs');
    const records=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','.execution',batchTaskRunId(f.batch.batchId,'1.work/T-001'),'state.json'),'utf8')).records;
    assert.equal(records.filter(row=>row.payload.type==='develop-answer-redo').length,1);
    // After cancel the batch stays stopped; a forwarded operation cannot reopen it.
    const g=fixture();
    try{
      const stopped=await execute(g,[],{cancel:true});assert.equal(stopped.result.code,'cancelled');
      const after=await execute(g,[],{args:['--allow-develop-redo','1.work/T-001'],operations:[redo]});
      assert.deepEqual([after.result.outcome,after.result.code],['blocked','cancelled']);
    }finally{fs.rmSync(g.root,{recursive:true,force:true});}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
