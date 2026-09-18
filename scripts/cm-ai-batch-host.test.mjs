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

function execute(f,approvals,{cancel=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...f.args,...approvals.flatMap(value=>['--allow-review',value])],
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
          if(row.requestId==='advance'&&(row.result||row.error))send({type:'host_close',sessionId});
        }catch(error){clearTimeout(timer);child.kill('SIGTERM');reject(error);}
      }
    });
    child.once('close',code=>{clearTimeout(timer);resolve({code,stderr,calls,rows,result:rows.find(row=>row.requestId==='advance')?.result});});
    send({operation:'advance',requestId:'advance'});
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
    const workerModule=new URL('../runtime/js/cm-ai/codex-config.mjs',import.meta.url).href;
    fs.writeFileSync(stub,`
import {configFingerprint} from ${JSON.stringify(workerModule)};
export {readConversationReviewConfiguration,readConversationProtection} from ${JSON.stringify(hostModule)};
export const calls=[];export let scheduler;
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
