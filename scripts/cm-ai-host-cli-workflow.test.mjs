import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {cli,identity,request,fixture,runCli} from './cm-ai-host-fixture.mjs';

for(const variant of ['codex','claude','protected'])test(`automatic fix ${variant} CLI starts before QA and finishes through original transport`,async()=>{
  const runtime=variant==='protected'?'codex':variant;
  const f=fixture();f.workflow=true;f.fix=true;f.runtime=runtime;
  try{
    f.protected=variant==='protected';
    const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));definition.scope.push('README.md');
    if(f.protected){const nested=path.join(f.codeProject,'specs');fs.renameSync(f.specsDir,nested);f.specsDir=nested;definition.specsDir=nested;}
    fs.writeFileSync(f.config,JSON.stringify(definition));
    fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.json'),JSON.stringify({version:1,...(f.protected?{runtimes:{available:'codex'}}:{}),policies:{auto_fix:'auto',delivery:'diff'}}));
    fs.writeFileSync(path.join(f.codeProject,'red.mjs'),"import {value} from './target.mjs';if(value!==43){console.error('BUG');process.exit(1)}");
    fs.writeFileSync(path.join(f.codeProject,'baseline.mjs'),"import {value} from './target.mjs';if(typeof value!=='number')process.exit(1)");
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,runtime);fs.copyFileSync(fileURLToPath(new URL(`./fixtures/${runtime}-review-process.mjs`,import.meta.url)),fake);fs.chmodSync(fake,0o700);
    if(f.protected){
      const located=spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'});assert.equal(located.status,0);
      const real=located.stdout.trim(),reviewFixture=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
      fs.writeFileSync(fake,String.raw`#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=require('node:assert/strict');
const args=process.argv.slice(2),real=${JSON.stringify(real)};
if(args[0]==='sandbox'){const r=cp.spawnSync(real,args,{stdio:'inherit'});process.exit(r.status??1);}
let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
  if(!input.includes('<cm-developer-data-json>')){
    const r=cp.spawnSync(process.execPath,[${JSON.stringify(reviewFixture)},...args],{input,encoding:'utf8'});
    process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
  }
  const profile=[];for(let i=0;i<args.length;i++)if(args[i]==='-c'&&/^(default_permissions=|permissions.cm-specs=)/.test(args[i+1]))profile.push(args[i],args[i+1]);
  a.equal(profile.length,4);
  const code="const fs=require('node:fs');fs.writeFileSync('target.mjs','export const value = 42;\\n');fs.writeFileSync('README.md','# Before fix\\n');";
  const r=cp.spawnSync(real,['sandbox','-P','cm-specs','--include-managed-config','-C',process.cwd(),...profile,'--',process.execPath,'-e',code],{encoding:'utf8'});
  if(r.status!==0){process.stderr.write(r.stderr??'');process.exit(1);}
  for(const row of [{type:'thread.started',thread_id:'synthetic-protected-developer'},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}})}},{type:'turn.completed'}])process.stdout.write(JSON.stringify(row)+'\n');
});
`,{mode:0o700});
      // Every original fix command also asserts actual native specs/instruction protection.
      const assertion="import fs from 'node:fs';import a from 'node:assert/strict';"
        +"for(const file of ['specs/1.work/tasks.md','AGENTS.md'])a.throws(()=>fs.writeFileSync(file,'forged'),e=>['EPERM','EACCES'].includes(e.code));\n";
      for(const name of ['red.mjs','baseline.mjs'])fs.writeFileSync(path.join(f.codeProject,name),assertion+fs.readFileSync(path.join(f.codeProject,name),'utf8'));
    }
    f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_LOG_HOME:path.join(f.root,'private-logs')};
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture','--runtime',runtime],
      {encoding:'utf8',env:f.env,timeout:5000});
    assert.equal(preview.status,0,preview.stderr);
    const review=JSON.parse(preview.stdout),reviewFile=path.join(f.root,'review.json');
    fs.writeFileSync(reviewFile,JSON.stringify(review));
    const command=[process.execPath,'red.mjs'];
    const workflowFile=path.join(f.root,'workflow.json');
    fs.writeFileSync(workflowFile,JSON.stringify({documentationPaths:['README.md'],applicableAgentFiles:[],
      qa:{commands:[{id:'value-check',command,caseIds:[]}],environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
    const permissions=['red-test','baseline','repair','regression','final-review','walkthrough','finish'];
    const reviewHost=createFixReviewHost({codeProject:f.codeProject,hostContextId:'native-host-fixture',runtime,review,
      permissions:permissions.map(name=>`--allow-${name}`)});
    const configuration={hostContextId:'native-host-fixture',...(runtime==='claude'?{runtime}:{}),defect:'Exported value must be 43',
      ...(f.protected?{protectSpecs:true}:{}),
      causeReview:reviewHost.reviewer,reproduction:{cwd:f.codeProject,command,expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      redTest:{cwd:f.codeProject,testFiles:['red.mjs'],command,expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
      baseline:{cwd:f.codeProject,testFiles:['baseline.mjs'],commands:[{id:'baseline',command:[process.execPath,'baseline.mjs']}],timeoutMs:2000},
      repair:{scope:['target.mjs','README.md'],requirements:['requirements.md']},
      walkthrough:{timeoutMs:2000,flows:[{id:'value',modules:['value'],steps:['Read exported value'],expected:['43'],kind:'commands',command}]}};
    const template=path.join(f.root,'template.json');fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration}));
    f.args.push('--runtime',runtime,'--review-config',reviewFile,'--allow-review-attempt','1','--workflow-config',workflowFile,'--allow-qa',
      '--qa-fix-template-config',template,'--qa-fix-review-config',reviewFile,'--allow-qa-fix-start','--auto-qa-fix',
      ...permissions.map(name=>`--allow-qa-fix-${name}`));
    if(f.protected){
      const protectedFile=path.join(f.root,'protected.json');
      fs.writeFileSync(protectedFile,JSON.stringify({model:'fixture',timeoutMs:5000,checkCommands:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}]}));
      f.args.push('--protected-config',protectedFile,'--allow-provider-development-attempt','1');
      fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration:{...configuration,protectSpecs:false}}));
      const denied=await runCli(f,'normal');assert.equal(denied.code,1);assert(denied.stderr.includes('protected_fix_required'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));fs.writeFileSync(template,JSON.stringify({specsRoot:f.specsDir,feature:'1.work',identity,configuration}));
    }
    assert.equal(fs.existsSync(path.join(f.specsDir,'运行日志.jsonl')),false);
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'run_done',JSON.stringify(first.rows.at(-1)));
    for(const kind of [...(f.protected?[]:['develop']),'fix_diagnose','fix_repair','fix_retrospective'])assert.equal(first.calls.filter(item=>item===kind).length,1,kind);
    if(f.protected)assert(!first.calls.some(kind=>['develop','check','documentation_sync'].includes(kind)));
    assert(first.calls.includes('fix_learning')); // Original owner refreshes Learning before multiple stages.
    const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
    assert.equal(resumed.rows.find(row=>row.requestId==='advance').result.code,'run_done');
    assert.deepEqual(resumed.calls,['documentation_inspect']);
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.workflow==='cm-ai'&&row.event==='test_run'&&row.phase==='start').length,2);
    assert.equal(rows.filter(row=>row.workflow==='cm-ai'&&row.event==='run_done').length,1);
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

for(const runtime of ['codex','claude'])for(const initialWorkflow of ['absent','qa-null','qa'])test(`configured ${runtime} CLI waits for the authorized attempt and resumes via the original review worker/gate workflow=${initialWorkflow}`,async()=>{
  const workflow=initialWorkflow==='qa';
  const f=fixture();
  try{
    f.workflow=workflow;
    if(runtime==='claude'){f.runtime=runtime;f.args.push('--runtime',runtime);}
    if(workflow){
      const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));definition.scope.push('README.md');
      fs.writeFileSync(f.config,JSON.stringify(definition));
    }
    const bin=path.join(f.root,'bin');fs.mkdirSync(bin);
    const fake=path.join(bin,runtime);fs.copyFileSync(fileURLToPath(new URL(`./fixtures/${runtime}-review-process.mjs`,import.meta.url)),fake);
    fs.chmodSync(fake,0o700);f.env={...process.env,PATH:bin+path.delimiter+process.env.PATH};
    // Actual separate CLI and loopback diagnostic process; the executable is synthetic.
    let review;
    const preview=spawnSync(process.execPath,[cli,'preflight','--config',f.config,'--review-model','fixture',
      ...(runtime==='claude'?['--runtime','claude']:[])],
      {encoding:'utf8',env:f.env,timeout:5000});
    assert.equal(preview.status,0,preview.stderr);
    review=JSON.parse(preview.stdout);assert.equal(review.preflight.passed,true);
    if(runtime==='codex')assert.equal(review.preflight.real_model_requests,0);
    else assert.equal(review.preflight.isolation,'macos-loopback-sandbox');
    assert.equal(review.preflight.listener_closed,true);
    const config=path.join(f.root,'review.json');fs.writeFileSync(config,JSON.stringify(review));
    f.args.push('--review-config',config);
    if(runtime==='claude'){
      fs.writeFileSync(config,JSON.stringify({...review,preflight:{...review.preflight,provider:'codex'}}));
      const denied=spawnSync(process.execPath,[cli,...f.args,'--allow-review-attempt','1'],{encoding:'utf8',env:f.env,timeout:3000});
      assert.equal(denied.status,1);assert(denied.stderr.includes('tool_preflight_missing'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
      fs.writeFileSync(config,JSON.stringify(review));
    }
    if(workflow){
      const workflowFile=path.join(f.root,'workflow.json');
      fs.writeFileSync(workflowFile,JSON.stringify({documentationPaths:['README.md'],applicableAgentFiles:[],
        qa:{commands:[{id:'value-check',command:[process.execPath,'-e',"import('./target.mjs').then(m=>{if(m.value!==42)process.exit(1)})"],caseIds:[]}],
          environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}}));
      f.args.push('--workflow-config',workflowFile);
      const denied=spawnSync(process.execPath,[cli,...f.args],{encoding:'utf8',env:f.env,timeout:5000});
      assert.equal(denied.status,1);assert(denied.stderr.includes('qa_authorization_required'));
      assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
      f.args.push('--allow-qa');
    }
    if(!workflow)fs.writeFileSync(path.join(f.codeProject,'README.md'),'# Fixture value 42\n');
    const attachmentFile=path.join(f.root,'attachment.json');
    const attachmentConfig={documentationPaths:[],applicableAgentFiles:[],
      qa:{commands:[{id:'syntax',command:[process.execPath,'--check','target.mjs'],caseIds:[]}],
        environment:{kind:'web',carrier:'browser',target:'http://127.0.0.1',scope:'local'}}};
    if(initialWorkflow==='qa-null'){
      fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
      f.args.push('--workflow-config',attachmentFile);
    }
    const first=await runCli(f,'normal');assert.equal(first.code,0,first.stderr);
    assert.equal(first.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    const initialArgs=[...f.args];
    const attemptAttachment=()=>{
      fs.writeFileSync(attachmentFile,JSON.stringify(attachmentConfig));
      if(initialWorkflow==='absent')f.args.push('--workflow-config',attachmentFile);
      f.args.push('--allow-qa');
    };
    if(!workflow){
      attemptAttachment();
      const early=await runCli(f,'normal','resume');
      assert.equal(early.code,1);assert.match(early.stderr,/qa_attach_not_completed/);assert.deepEqual(early.calls,[]);
      f.args=[...initialArgs];
      if(initialWorkflow==='qa-null')fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
    }

    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[ ] T-001'));
    // An approved different round cannot authorize this pending round.
    f.args.push('--allow-review-attempt','2');
    const wrong=await runCli(f,'normal','resume');assert.equal(wrong.code,0,wrong.stderr);
    assert.deepEqual(wrong.calls,[]);assert.equal(wrong.rows.find(row=>row.requestId==='advance').result.code,'decision_required');
    f.args[f.args.length-1]='1';
    const completed=await runCli(f,'authorized-review','resume');assert.equal(completed.code,0,completed.stderr);
    assert.deepEqual(completed.calls,workflow?['check','qa_assess','documentation_inspect']:['check']);
    const result=completed.rows.find(row=>row.requestId==='advance').result;
    assert.equal(result.state,workflow?'run_done':'fixture_completed');assert.equal(result.code,workflow?'run_done':'qa_decision_required');
    assert(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8').includes('[x] T-001'));
    const reopened=await runCli(f,'normal','resume');assert.equal(reopened.code,0,reopened.stderr);
    assert.deepEqual(reopened.calls,workflow?['documentation_inspect']:[]);
    assert.equal(reopened.rows.find(row=>row.requestId==='advance').result.code,workflow?'run_done':'qa_decision_required');
    if(!workflow){
      const stateFile=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');
      const before=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      attemptAttachment();
      // Explicit QA permission is still required, even though task work is done.
      f.args.pop();
      const denied=await runCli(f,'normal','resume');assert.equal(denied.code,1);
      assert.match(denied.stderr,/qa_authorization_required/);assert.deepEqual(denied.calls,[]);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),before);
      f.args.push('--allow-qa');
      // No hidden host-context or definition changes can ride the attachment.
      const originalHost=f.args[6];f.args[6]='different-host';
      const changedHost=await runCli(f,'normal','resume');assert.equal(changedHost.code,1);
      assert.match(changedHost.stderr,/fingerprint_mismatch/);f.args[6]=originalHost;
      const originalDefinition=fs.readFileSync(f.config,'utf8');
      for(const field of ['scope','requirements']){
        const changed=JSON.parse(originalDefinition);changed[field].push('extra.md');
        fs.writeFileSync(f.config,JSON.stringify(changed));
        const rejected=await runCli(f,'normal','resume');assert.equal(rejected.code,1);
        assert.match(rejected.stderr,/fingerprint_mismatch/);fs.writeFileSync(f.config,originalDefinition);
      }
      f.workflow=true;
      const {readRunnerHistory}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
      const {digest}=await import('../runtime/js/cm-ai/effect-contract.mjs');
      const history=readRunnerHistory(before.records,before.records[0].payload.config,3);
      f.request={...request('qa','advance'),packageDigest:history.state.reviewPackage.packageDigest};
      const attached=await runCli(f,'authorized-review','resume');assert.equal(attached.code,0,attached.stderr);
      assert.deepEqual(attached.calls,['qa_assess']);
      assert.equal(attached.rows.find(row=>row.requestId==='advance').result.code,'qa_triggered');
      delete f.request;
      // A killed no-result N6 run needs a fresh, explicit resume permission.
      // The option is transport authority, never part of the stored fingerprint.
      const {recordCmAiQaRun}=await import('../runtime/js/cm-ai/cm-ai-qa-log.mjs');
      recordCmAiQaRun({specsDir:f.specsDir,codeProject:f.codeProject,feature:'1.work',identity,
        packageDigest:history.state.reviewPackage.packageDigest,testRunId:'interrupted-qa',mode:'commands',caseCount:1,
        phase:'start',logHome:path.join(f.root,'logs')});
      const unknown=await runCli(f,'normal','resume');assert.equal(unknown.code,0,unknown.stderr);
      assert.equal(unknown.rows.find(row=>row.requestId==='advance').result.code,'qa_execution_unknown');
      assert.deepEqual(unknown.calls,[]);
      f.args.push('--rerun-unknown-qa');
      const finished=await runCli(f,'normal','resume');assert.equal(finished.code,0,finished.stderr);
      f.args.pop();
      assert.deepEqual(finished.calls,['documentation_inspect']);
      assert.equal(finished.rows.find(row=>row.requestId==='advance').result.state,'run_done');
      const qaRows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
        .filter(row=>row.event==='test_run');
      assert.deepEqual(qaRows.filter(row=>row.phase==='start').map(row=>row.attempt),[1,1]);
      assert.equal(qaRows.filter(row=>row.phase==='abandoned').length,1);
      const after=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      assert.deepEqual(after.fingerprints,before.fingerprints);
      assert.deepEqual(after.records.slice(0,before.records.length),before.records);
      const records=after.records.filter(row=>row.payload.type==='qa-attached');assert.equal(records.length,1);
      assert.deepEqual(Object.keys(records[0].payload.record).sort(),['attachedAt','hostContextId','qaFingerprint','version']);
      assert.equal(records[0].payload.record.hostContextId,'native-host-fixture');
      // Replay rejects a duplicate even with a correctly recalculated hash chain.
      const last=records[0],body={...last,seq:after.records.length+1,
        id:`runner.${String(after.records.length+1).padStart(6,'0')}`,previousDigest:after.records.at(-1).digest};
      delete body.digest;
      assert.throws(()=>readRunnerHistory([...after.records,{...body,digest:digest(body)}],
        after.records[0].payload.config,3),{code:'qa_attachment_duplicate'});
      assert.equal(readRunnerHistory(after.records,after.records[0].payload.config,3).state.state,'fixture_completed');
      // Crash prefix: attachment durable, audit row absent. Resume repairs it.
      const log=path.join(f.specsDir,'运行日志.jsonl');
      fs.writeFileSync(log,fs.readFileSync(log,'utf8').trim().split('\n')
        .filter(line=>JSON.parse(line).phase!=='qa_attach').join('\n')+'\n');
      const again=await runCli(f,'normal','resume');assert.equal(again.code,0,again.stderr);
      assert.deepEqual(again.calls,['documentation_inspect']);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),after);
      const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const attachLogs=logs.filter(row=>row.event==='decision'&&row.phase==='qa_attach');assert.equal(attachLogs.length,1);
      assert.equal(attachLogs[0].qaFingerprint,records[0].payload.record.qaFingerprint);
      assert.equal(logs.filter(row=>row.event==='test_run'&&row.phase==='start').length,2);
      // Removing QA after it was bound cannot fall back to the original config.
      const attachedArgs=[...f.args];f.args=[...initialArgs];
      if(initialWorkflow==='qa-null')fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:null}));
      const removed=await runCli(f,'normal','resume');assert.equal(removed.code,1);assert.match(removed.stderr,/fingerprint_mismatch/);
      f.args=attachedArgs;
      fs.writeFileSync(attachmentFile,JSON.stringify({...attachmentConfig,qa:{...attachmentConfig.qa,
        commands:[{id:'different',command:[process.execPath,'--version'],caseIds:[]}]}}));
      const changed=await runCli(f,'normal','resume');assert.equal(changed.code,1);assert.match(changed.stderr,/fingerprint_mismatch/);
      assert.deepEqual(changed.calls,[]);assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),after);
    }
    if(workflow){
      const file=f.args[f.args.indexOf('--workflow-config')+1];
      const config=JSON.parse(fs.readFileSync(file,'utf8'));config.qa.commands[0].id='different';
      fs.writeFileSync(file,JSON.stringify(config));
      const changed=await runCli(f,'normal','resume');assert.equal(changed.code,1);assert.match(changed.stderr,/fingerprint_mismatch/);
      const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.event==='run_done').length,1);
      assert.equal(rows.filter(row=>row.event==='test_run'&&row.phase==='start').length,1);
    }
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
