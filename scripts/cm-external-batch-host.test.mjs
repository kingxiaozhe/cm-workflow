import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
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
      environment:{kind:'web',carrier:'browser',target:'synthetic-local',scope:'local'}}}]));
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


for(const runtime of ['codex','claude'])test(`${runtime} real batch host freezes pair for later tasks and sends exact args`,async()=>{
  const f=fixture(runtime);
  try{
    const pair={model:'fixture',effort:runtime==='codex'?'low':null};
    const models={schemaVersion:1,providers:{[runtime]:pair}},home=path.join(f.root,'private-home');fs.mkdirSync(home);
    const settings=path.join(home,'external-models-v1.json');fs.writeFileSync(settings,JSON.stringify(models));f.env.CM_WORKFLOW_HOME=home;f.env.CM_WORKFLOW_LOG_HOME=path.join(f.root,'logs');
    const sent=path.join(f.root,'sent.jsonl'),fake=path.join(f.root,'bin',runtime);
    fs.writeFileSync(fake,fs.readFileSync(fake,'utf8').replace("import {randomUUID}",`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(sent)},JSON.stringify(process.argv.slice(2))+'\\n');\nimport {randomUUID}`));
    const review=JSON.parse(fs.readFileSync(f.review));review.effort=pair.effort;review.preflight.config_fingerprint=(runtime==='claude'?claudeReviewFingerprint:configFingerprint)({cwd:f.codeProject,...pair});fs.writeFileSync(f.review,JSON.stringify(review));f.args.push('--external-models');
    const first=await execute(f,[]);assert.equal(first.result.state,'awaiting_review',first.stderr+JSON.stringify(first.result));
    const {batchTaskRunId}=await import('./cm-ai-batch-run.mjs');const statePath=n=>path.join(f.specsDir,'.reviews','.execution',batchTaskRunId(f.batch.batchId,'1.work/T-00'+n),'state.json');
    assert(!fs.existsSync(statePath(2)));assert.deepEqual(JSON.parse(fs.readFileSync(statePath(1))).records[0].payload.config.externalModels,models);
    fs.writeFileSync(settings,'invalid new user defaults');
    const end=await execute(f,['1.work/T-001:1','1.work/T-002:1']);assert.equal(end.result.code,'run_done',end.stderr+JSON.stringify(end.result));
    for(const n of [1,2])assert.deepEqual(JSON.parse(fs.readFileSync(statePath(n))).records[0].payload.config.externalModels,models);
    const calls=fs.readFileSync(sent,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);
    for(const args of calls){if(runtime==='codex'){assert(args.includes('model_reasoning_effort="low"'));assert(args.includes('--ephemeral'));}else{assert(!args.includes('--effort'));assert(args.includes('--no-session-persistence'));}}
    const tracked=spawnSync('git',['-C',f.codeProject,'ls-files'],{encoding:'utf8'});assert(!tracked.stdout.includes('.cm-external-models-v1.json'));assert(!tracked.stdout.includes('.cm-model-config.lock'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('new parallel batch merges reviewed members without committing private bindings',async()=>{
  const f=fixture();f.parallel=true;
  try{
    f.batch.tasks=[1,2,3].map(n=>({feature:'1.work',taskId:`T-00${n}`,scope:[`task${n}.mjs`],requirements:['requirements.md']}));f.batch.parallel=[['1.work/T-001','1.work/T-002']];
    fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n');
    fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
    const original=JSON.parse(fs.readFileSync(f.config)).workflows['1.work/T-001'];fs.writeFileSync(f.config,JSON.stringify({batch:f.batch,workflows:Object.fromEntries(f.batch.tasks.map(task=>[`1.work/${task.taskId}`,original]))}));
    const home=path.join(f.root,'home');fs.mkdirSync(home);f.env.CM_WORKFLOW_HOME=home;f.env.CM_WORKFLOW_LOG_HOME=path.join(f.root,'logs');
    fs.writeFileSync(path.join(home,'external-models-v1.json'),JSON.stringify({schemaVersion:1,providers:{codex:{model:'fixture',effort:'low'}}}));
    const review=JSON.parse(fs.readFileSync(f.review));review.effort='low';review.preflight.config_fingerprint=configFingerprint({cwd:f.codeProject,model:'fixture',effort:'low'});fs.writeFileSync(f.review,JSON.stringify(review));f.args.push('--external-models');
    fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Exports 41 and 42\n');
    for(const args of [['add','README.md'],['commit','-m','fixture documentation']])assert.equal(spawnSync('git',['-C',f.codeProject,...args]).status,0);
    const end=await execute(f,['1.work/T-001:1','1.work/T-002:1','1.work/T-003:1']);assert.equal(end.result.code,'run_done',end.stderr+JSON.stringify(end.result));
    const tracked=spawnSync('git',['-C',f.codeProject,'ls-files'],{encoding:'utf8'}).stdout;assert(!tracked.includes('.cm-external-models-v1.json'));assert(!tracked.includes('.cm-model-config.lock'));
    for(const n of [1,2])assert(!fs.existsSync(path.join(f.root,'.cm-worktrees',f.batch.batchId.slice(0,8),'T-00'+n)));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('optimization-only serial batch freezes policy for later members after removing launch flag',async()=>{
  const f=fixture();f.args.push('--execution-optimizations');f.env.CM_WORKFLOW_HOME=path.join(f.root,'home');f.env.CM_WORKFLOW_LOG_HOME=path.join(f.root,'logs');
  try{
    const first=await execute(f,[]);assert.equal(first.result.state,'awaiting_review',first.stderr+JSON.stringify(first.result));
    const {batchTaskRunId}=await import('./cm-ai-batch-run.mjs');
    const statePath=n=>path.join(f.specsDir,'.reviews','.execution',batchTaskRunId(f.batch.batchId,'1.work/T-00'+n),'state.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath(1))).records[0].payload.config.executionPolicy,EXECUTION_POLICY_V1);
    f.args=f.args.filter(arg=>arg!=='--execution-optimizations');
    const end=await execute(f,['1.work/T-001:1','1.work/T-002:1']);assert.equal(end.result.code,'run_done',end.stderr+JSON.stringify(end.result));
    for(const n of [1,2])assert.deepEqual(JSON.parse(fs.readFileSync(statePath(n))).records[0].payload.config.executionPolicy,EXECUTION_POLICY_V1);
    const tracked=spawnSync('git',['-C',f.codeProject,'ls-files'],{encoding:'utf8'});assert(!tracked.stdout.includes('.cm-external-models-v1.json'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
