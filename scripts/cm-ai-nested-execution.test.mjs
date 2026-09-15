import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCodexExecution,openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution,conversationProtection} from './cm-ai-host.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const supported=process.platform==='darwin'&&Number(process.versions.node.split('.')[0])>=24;
const identity={repositoryId:'fixture',runId:'nested-run',taskId:'T-001',attempt:1};
const request=operation=>({version:1,operation,requestId:operation,identity});

function workflowCli(args,codeProject,documentationStatus='completed'){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),...args]);
    let buffer='',stderr='',result;const calls=[];
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('workflow timeout'));},15000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;
        try{
          const row=JSON.parse(line);
          if(row.type==='host_request'){
            calls.push(row.kind);let value;
            if(row.kind==='qa_assess')value={scores:{scope:1,risk:1,accumulation:1,boundary:1},
              changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}};
            else{
              assert.equal(row.kind,'documentation_inspect','no unprotected write/check request');
              assert.equal(fs.readFileSync(path.join(codeProject,'README.md'),'utf8'),'# Updated\n');
              const {syncId,identity,packageDigest,contextDigest}=row.payload;
              value={syncId,identity,packageDigest,contextDigest,status:documentationStatus,reason:'Fixture document read back',
                at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
            }
            send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:value});
          }
          if(row.requestId==='advance'&&row.result){result=row.result;child.stdin.end();}
        }catch(error){clearTimeout(timer);child.kill('SIGTERM');reject(error);}
      }
    });
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr));else resolve({result,calls});});
    send(request('advance'));
  });
}

async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-nested-factory-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(codeProject,'specs'),feature='1.demo';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.js'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Synthetic requirement\n');
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['a.js'],requirements:['requirements.md']};
  const config={codeProject,specsRoot:specsDir,developerModel:'synthetic',reviewerModel:'synthetic',hostContextId:'host',
    developerContextId:'author',timeoutMs:5000,
    checkCommands:[{id:'value',command:[process.execPath,'-e',
      "require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'),'new\\n')"]}],
    reviewerPreflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
      config_fingerprint:configFingerprint({cwd:codeProject,model:'synthetic'})}};
  const authority={authorizeDevelopment:()=>({status:'approved'}),
    authorizeReview:()=>assert.fail('No real review authorization'),hostDecision:{status:'denied',code:'permission_denied'}};
  try{await fn({root,definition,config,authority});}finally{fs.rmSync(root,{recursive:true,force:true});}
}

for(const runtime of ['codex','claude'])test(`protected ${runtime} conversation retains host identity, scope protection and no redispatch on resume`,
  {skip:!supported},()=>fixture(async({definition,config})=>{
    let calls=0;
    const bridge={async call(kind,payload){
      assert.equal(kind,'develop');assert.equal(payload.request.provider,runtime);calls++;
      assert.equal(payload.editMode,'protected-text-v1');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
      edits:[{path:'a.js',beforeSha256:payload.expected['a.js'],content:'new\n'}]};
    }};
    const options={protection:{checkCommands:config.checkCommands,timeoutMs:config.timeoutMs}};
    const make=()=>createConversationExecution(definition,'host',bridge,null,null,null,false,runtime,options);
    const execution=make();assert(Object.isFrozen(execution));
    const provenance=conversationProtection(execution);assert(Object.isFrozen(provenance));
    assert.throws(()=>{provenance.definitionDigest='0'.repeat(64);},TypeError);
    assert.equal(conversationProtection(execution),provenance);
    await assert.rejects(openControlRun(definition,'create',{...execution}),{code:'nested_specs_protection_required'});
    const wrong={...definition,scope:['b.js']};
    await assert.rejects(openControlRun(wrong,'create',execution),{code:'execution_definition_mismatch'});
    let run=await openControlRun(definition,'create',execution);
    try{const result=await run.host.handle(request('advance'));assert.equal(result.code,'decision_required',JSON.stringify(result));}
    finally{run.close();}
    assert.equal(fs.readFileSync(path.join(definition.codeProject,'a.js'),'utf8'),'new\n');
    assert.equal(calls,1);
    run=await openControlRun(definition,'resume',make());
    try{const result=await run.host.handle(request('advance'));assert.equal(result.code,'decision_required');assert.equal(calls,1);}
    finally{run.close();}
    assert.match(fs.readFileSync(path.join(definition.specsDir,definition.feature,'tasks.md'),'utf8'),/\[ \]/);
  }));

test('protected factory binds exact roots and rejects copied/mutable claims before creating a store',
  {skip:!supported},()=>fixture(async({root,definition,config,authority})=>{
    const execution=await createCodexExecution(config,authority);
    assert(Object.isFrozen(execution));assert(Object.isFrozen(execution.developer));
    assert.throws(()=>{execution.check=()=>[];},TypeError);
    assert.throws(()=>{execution.developer.run=()=>{};},TypeError);
    assert.throws(()=>{execution.qaExecutor={run:()=>{}};},TypeError);
    await assert.rejects(openControlRun(definition,'create',{...execution}),{code:'nested_specs_protection_required'});
    const other=path.join(root,'other-specs');fs.mkdirSync(other);
    await assert.rejects(openControlRun({...definition,specsDir:other},'create',execution),{code:'execution_specs_mismatch'});
    const {specsRoot,...legacy}=config;
    const unprotected=await createCodexExecution(legacy,authority);
    await assert.rejects(openControlRun(definition,'create',unprotected),{code:'nested_specs_protection_required'});
    const workflow=await createCodexExecution({...config,workflow:{definition,
      configuration:{qa:null,documentationPaths:[],applicableAgentFiles:[]}}},
    {...authority,workflow:{bridge:{call:()=>assert.fail('Construction never requests tools')},allowQa:false}});
    assert(Object.isFrozen(workflow.documentationProvider));
    await assert.rejects(openControlRun({...definition,scope:['different.js']},'create',workflow),{code:'execution_definition_mismatch'});
    assert(!fs.existsSync(path.join(specsRoot,'.reviews')));
    fs.renameSync(specsRoot,specsRoot+'-original');fs.symlinkSync(specsRoot+'-original',specsRoot);
    await assert.rejects(openControlRun(definition,'create',execution),{code:'unsupported_path'});
  }));

for(const launch of ['factory','host','revision','workflow'])test(`${launch}: synthetic coding CLI receives native protection; real sandbox checks feed original runner and recovery`,
  {skip:!supported},()=>fixture(async({root,definition,config,authority})=>{
    if(launch==='workflow'){
      definition.scope.push('README.md');fs.writeFileSync(path.join(definition.codeProject,'README.md'),'# Old\n');
      fs.writeFileSync(path.join(definition.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
    }
    // Never execute real `codex exec`: the shim emits synthetic provider events.
    // It forwards only sandbox commands to the installed native sandbox.
    const located=spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'});
    assert.equal(located.status,0);const realCodex=located.stdout.trim();assert(path.isAbsolute(realCodex));
    const bin=path.join(root,'bin'),calls=path.join(root,'calls');fs.mkdirSync(bin);
    const code="const fs=require('node:fs'),a=require('node:assert/strict');"
      +"const denied=fn=>a.throws(fn,e=>['EPERM','EACCES'].includes(e.code));"
      +"a.match(fs.readFileSync('specs/1.demo/tasks.md','utf8'),/\\[ \\]/);"
      +"denied(()=>fs.writeFileSync('specs/1.demo/tasks.md','forged'));"
      +"denied(()=>fs.writeFileSync('specs/.reviews/forged','bad'));"
      +"denied(()=>fs.renameSync('specs','moved-specs'));"
      +"denied(()=>fs.writeFileSync('AGENTS.md','bad'));"
      +"const child=require('node:child_process').spawnSync(process.execPath,['-e',"
      +"\"require('node:fs').writeFileSync('specs/1.demo/tasks.md','bad')\"]);a.notEqual(child.status,0);"
      +(launch==='revision'?"fs.writeFileSync('a.js',fs.readFileSync('a.js','utf8')==='old\\n'?'new\\n':'new\\n// reviewed fix\\n');"
        :"fs.writeFileSync('a.js','new\\n');")
      +(launch==='workflow'?"fs.writeFileSync('README.md','# Updated\\n');":"");
    fs.writeFileSync(path.join(bin,'codex'),String.raw`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');
const args=process.argv.slice(2),real=${JSON.stringify(realCodex)};
if(args[0]==='sandbox'){
  const result=cp.spawnSync(real,args,{stdio:'inherit'});process.exit(result.status??1);
}
a.equal(args[0],'exec');a.equal(args.at(-1),'-');
const review=args.includes('--sandbox');
if(review)a.equal(args[args.indexOf('--sandbox')+1],'read-only');
const profile=[];
for(let i=0;i<args.length;i++)if(args[i]==='-c'&&(/^(default_permissions=|permissions.cm-specs=)/).test(args[i+1]))profile.push(args[i],args[i+1]);
if(!review){a.equal(profile.length,4);a(profile.join(' ').includes(${JSON.stringify(config.specsRoot)}));}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  if(review){
    const data=JSON.parse(input.split('<cm-review-data-json>\n')[1]);
    if(${launch==='workflow'}){a(data.examinedPaths.includes('README.md'));a.equal(fs.readFileSync('README.md','utf8'),'# Updated\n');}
    const changes=${launch==='revision'}&&data.reviewPackage.identity.attempt===1;
    fs.appendFileSync(${JSON.stringify(calls)},'review\n');
    emit({type:'thread.started',thread_id:'synthetic-independent-review-'+data.reviewPackage.identity.attempt});emit({type:'turn.started'});
    emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:changes?'changes_requested':'approved',
      packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
      findings:changes?[{id:'F1',severity:'P2',path:'a.js',message:'Add reviewed comment',evidence:'Synthetic first-round finding'}]:[],summary:'Synthetic review only'})}});
    emit({type:'turn.completed'});return;
  }
  a(input.includes('<cm-developer-data-json>'));fs.appendFileSync(${JSON.stringify(calls)},'developer\n');
  if(${launch==='workflow'}){a(input.includes('synchronize these already-approved ordinary documentation paths'));a(input.includes('["README.md"]'));}
  const run=cp.spawnSync(real,['sandbox','-P','cm-specs','--include-managed-config','-C',process.cwd(),...profile,'--',${JSON.stringify(process.execPath)},'-e',${JSON.stringify(code)}],{encoding:'utf8'});
  if(run.status!==0){process.stderr.write(run.stderr??'');process.exit(1);}
  emit({type:'thread.started',thread_id:'synthetic-protected-author'});emit({type:'turn.started'});
  emit({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}})}});
  emit({type:'turn.completed'});
});
`,{mode:0o700});
    const previousPath=process.env.PATH;let run;
    process.env.PATH=bin+path.delimiter+previousPath;
    try{
      if(launch!=='factory'){
        const runFile=path.join(root,'run.json'),protectedFile=path.join(root,'protected.json'),reviewFile=path.join(root,'review.json');
        fs.writeFileSync(runFile,JSON.stringify(definition));
        const checkCommands=launch==='revision'?[{id:'value',command:[process.execPath,'-e',
          "require('node:assert/strict')(require('node:fs').readFileSync('a.js','utf8').startsWith('new\\n'))"]}]:config.checkCommands;
        fs.writeFileSync(protectedFile,JSON.stringify({model:config.developerModel,checkCommands,timeoutMs:config.timeoutMs}));
        const disabledSkills=[path.join(root,'disabled-skill')];
        fs.writeFileSync(reviewFile,JSON.stringify({model:config.reviewerModel,disabledSkills,
          preflight:{...config.reviewerPreflight,config_fingerprint:configFingerprint({cwd:config.codeProject,model:config.reviewerModel,disabledSkills})}}));
        if(launch==='workflow'){
          const workflowFile=path.join(root,'workflow.json');
          const qaCommand="const fs=require('node:fs'),a=require('node:assert/strict');"
            +"a.equal(fs.readFileSync('README.md','utf8'),'# Updated\\n');"
            +"a.match(fs.readFileSync('specs/1.demo/tasks.md','utf8'),/\\[x\\]/);"
            +"a.throws(()=>fs.writeFileSync('specs/1.demo/tasks.md','forged'),e=>['EPERM','EACCES'].includes(e.code));"
            +"a.throws(()=>fs.writeFileSync('AGENTS.md','forged'),e=>['EPERM','EACCES'].includes(e.code));";
          const workflow={qa:{commands:[{id:'protected-qa',command:[process.execPath,'-e',qaCommand],caseIds:[]}],
            environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1:3000',scope:'local'}},
            documentationPaths:['README.md'],applicableAgentFiles:[]};
          fs.writeFileSync(workflowFile,JSON.stringify(workflow));
          const args=['serve','--config',runFile,'--mode','create','--host-context','host','--allow-development',
            '--protected-config',protectedFile,'--allow-provider-development-attempt','1','--review-config',reviewFile,
            '--allow-review-attempt','1','--workflow-config',workflowFile,'--allow-qa'];
          const denied=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),...args.slice(0,-1)],{encoding:'utf8',timeout:5000});
          assert.equal(denied.status,1);assert(denied.stderr.includes('qa_authorization_required'));
          assert(!fs.existsSync(path.join(config.specsRoot,'.reviews')));
          fs.writeFileSync(workflowFile,JSON.stringify({...workflow,documentationPaths:['requirements.md']}));
          const invalid=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),...args],{encoding:'utf8',timeout:5000});
          assert.equal(invalid.status,1);assert(invalid.stderr.includes('documentation_scope_required'));
          assert(!fs.existsSync(path.join(config.specsRoot,'.reviews')));
          fs.writeFileSync(workflowFile,JSON.stringify(workflow));
          const blocked=await workflowCli(args,definition.codeProject,'blocked');
          assert.equal(blocked.result.code,'documentation_sync_blocked');
          assert.deepEqual(blocked.calls,['qa_assess','documentation_inspect']);
          assert(!fs.readFileSync(path.join(config.specsRoot,'运行日志.jsonl'),'utf8').includes('"event":"run_done"'));
          args[4]='resume';
          const first=await workflowCli(args,definition.codeProject);
          assert.equal(first.result.code,'run_done',JSON.stringify(first));
          assert.deepEqual(first.calls,['documentation_inspect']);
          const handoff=JSON.parse(fs.readFileSync(path.join(config.specsRoot,'.reviews','demo-T-001-a1-handoff.json')));
          assert(handoff.changed_files.includes('README.md'));
          args[4]='resume';const resumed=await workflowCli(args,definition.codeProject);
          assert.equal(resumed.result.code,'run_done');assert.deepEqual(resumed.calls,['documentation_inspect']);
          assert.equal(fs.readFileSync(calls,'utf8'),'developer\nreview\n');
          const logs=fs.readFileSync(path.join(config.specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
          assert.equal(logs.filter(row=>row.event==='test_run'&&row.phase==='start').length,1);
          assert.equal(logs.filter(row=>row.event==='run_done').length,1);
          assert.equal(logs.find(row=>row.event==='test_run'&&row.phase==='complete').result,'PASS');
          return;
        }
        const invoke=(mode,flags=[],attempt='1')=>{
          const child=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),
            'serve','--config',runFile,'--mode',mode,'--host-context','host','--allow-development',
            '--protected-config',protectedFile,'--allow-provider-development-attempt',attempt,'--review-config',reviewFile,...flags],
          {encoding:'utf8',input:JSON.stringify(request('advance'))+'\n',timeout:12000});
          assert.equal(child.status,0,child.stderr);
          const rows=child.stdout.trim().split('\n').map(JSON.parse);
          assert(!rows.some(row=>row.type==='host_request'),'protected mode never asks current host to perform unprotected writes');
          return rows.find(row=>row.requestId==='advance').result;
        };
        assert.equal(invoke('create').state,'awaiting_review');
        assert.equal(fs.readFileSync(calls,'utf8'),'developer\n');
        assert.equal(invoke('resume').state,'awaiting_review');
        assert.equal(fs.readFileSync(calls,'utf8'),'developer\n');
        let result=invoke('resume',['--allow-review-attempt','1']);
        if(launch==='revision'){
          assert.equal(result.state,'changes_requested');assert.equal(result.identity.attempt,2);
          assert.equal(result.code,'provider_development_authorization_required');
          assert.equal(fs.readFileSync(calls,'utf8'),'developer\nreview\n');
          const journal=path.join(config.specsRoot,'.reviews','.execution',identity.runId,'state.json');
          const before=fs.readFileSync(journal);assert(!before.includes('"id":"develop-2"'));
          assert.equal(invoke('resume').code,'provider_development_authorization_required');
          assert.deepEqual(fs.readFileSync(journal),before,'waiting for permission does not mutate the journal');
          result=invoke('resume',[],'2');assert.equal(result.state,'awaiting_review');
          assert.equal(fs.readFileSync(calls,'utf8'),'developer\nreview\ndeveloper\n');
          result=invoke('resume',['--allow-review-attempt','2'],'2');
        }
        assert.equal(result.state,'fixture_completed',JSON.stringify(result));
        assert.equal(result.code,'qa_decision_required');
        const expectedCalls=launch==='revision'?'developer\nreview\ndeveloper\nreview\n':'developer\nreview\n';
        assert.equal(fs.readFileSync(calls,'utf8'),expectedCalls);
        assert(fs.readFileSync(path.join(config.specsRoot,definition.feature,'tasks.md'),'utf8').includes('[x]'));
        assert.equal(invoke('resume').state,'fixture_completed');
        assert.equal(fs.readFileSync(calls,'utf8'),expectedCalls);
        return;
      }
      const execution=await createCodexExecution(config,authority);
      run=await openControlRun(definition,'create',execution);
      const result=await run.host.handle(request('advance'));
      assert.equal(result.state,'awaiting_review',JSON.stringify(result));assert.equal(result.outcome,'denied');
      assert.equal(fs.readFileSync(calls,'utf8'),'developer\n');
      assert.equal(fs.readFileSync(path.join(definition.codeProject,'a.js'),'utf8'),'new\n');
      const task=path.join(definition.specsDir,definition.feature,'tasks.md');
      assert.equal(fs.readFileSync(task,'utf8'),'- [ ] T-001: implement\n');
      assert(!fs.existsSync(path.join(definition.specsDir,'.reviews','forged')));
      const handoff=JSON.parse(fs.readFileSync(path.join(definition.specsDir,'.reviews','demo-T-001-a1-handoff.json'),'utf8'));
      assert(handoff.verification.every(row=>row.status==='passed'));
      assert(!handoff.changed_files.some(file=>file.startsWith('specs/')));
      run.close();run=null;
      run=await openControlRun(definition,'resume',await createCodexExecution(config,authority));
      assert.equal((await run.host.handle(request('advance'))).state,'awaiting_review');
      assert.equal(fs.readFileSync(calls,'utf8'),'developer\n');
      assert.equal(fs.readFileSync(task,'utf8'),'- [ ] T-001: implement\n');
    }finally{run?.close();process.env.PATH=previousPath;}
  }));

test('ordinary protected entry rejects missing authority and unsupported combinations before state creation',
  {skip:!supported},()=>fixture(async({root,definition,config})=>{
    const runFile=path.join(root,'run.json'),protectedFile=path.join(root,'protected.json'),reviewFile=path.join(root,'review.json');
    fs.writeFileSync(runFile,JSON.stringify(definition));
    fs.writeFileSync(protectedFile,JSON.stringify({model:config.developerModel,checkCommands:config.checkCommands,timeoutMs:config.timeoutMs}));
    fs.writeFileSync(reviewFile,JSON.stringify({model:config.reviewerModel,preflight:config.reviewerPreflight}));
    const protectedArgs=['--protected-config',protectedFile],authorization=['--allow-provider-development-attempt','1'];
    const unsafeFix=path.join(root,'unsafe-fix.json');fs.writeFileSync(unsafeFix,JSON.stringify({configuration:{}}));
    for(const [flags,code] of [[protectedArgs,'provider_development_authorization_required'],
      [authorization,'protected_configuration_required'],
      [[...protectedArgs,...authorization,'--runtime','claude'],'protected_runtime_unsupported'],
      [[...protectedArgs,'--allow-provider-development-attempt','2'],'invalid_development_attempt'],
      [[...protectedArgs,...authorization,'--qa-fix-owner-config',unsafeFix],'protected_fix_required'],
      [[], 'nested_specs_protection_required']]){
      const child=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),
        'serve','--config',runFile,'--mode','create','--host-context','host','--allow-development','--review-config',reviewFile,...flags],
      {encoding:'utf8',input:'',timeout:5000});
      assert.equal(child.status,1);assert.equal(JSON.parse(child.stderr.trim().split('\n').at(-1)).error.code,code);
      assert(!fs.existsSync(path.join(config.specsRoot,'.reviews')));
    }
  }));
