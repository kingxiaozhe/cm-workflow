import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {main as hostMain,withHandoffDiagnostic} from './cm-ai-host.mjs';
import {prepareReviewedEvidenceSupersession} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';

// Reuse the isolated handoff shape from cm-host-handoff.test.mjs. The old
// receipt deliberately consumes a different byte sequence at the same name.
test('reviewed handoff collision retains its code and explains both exits',()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-supersede-')));
  try{
    const root=path.join(temp,'code'),reviews=path.join(temp,'reviews');
    fs.mkdirSync(root);fs.mkdirSync(reviews);
    fs.writeFileSync(path.join(root,'a.mjs'),'old');
    fs.writeFileSync(path.join(root,'requirements.md'),'fixture');
    const handoffPath=path.join(reviews,'work-T-002-a1-handoff.json');
    const publish=content=>{
      fs.writeFileSync(path.join(root,'a.mjs'),'old');
      const baseline=captureReviewBaseline({root,
        identity:{repositoryId:'fixture',runId:'run-one',taskId:'T-002',attempt:1},
        scope:['a.mjs'],requirements:['requirements.md']});
      fs.writeFileSync(path.join(root,'a.mjs'),content);
      return createHostHandoff({root,baseline,handoffPath,
        checks:[{id:'unit',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'fixture'}]});
    };
    publish('run one');
    fs.writeFileSync(path.join(reviews,'work-T-002-r1.md'),
      '---\nverdict: approved\nhandoff: work-T-002-a1-handoff.json\n---\n');
    assert.throws(()=>publish('run two'),error=>{
      assert.equal(error.code,'handoff_exists');
      assert.match(error.reason,/--revise-qa-config/);
      assert.match(error.reason,/--rerun-blocked-qa/);
      assert.match(error.reason,/--supersede-reviewed-evidence/);
      return true;
    });
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

function runFixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-supersede-run-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,tasksPath:path.join(specsDir,feature,'tasks.md'),
    reviewsDir:path.join(specsDir,'.reviews')};
}
const identityFor=runId=>({repositoryId:'supersede-fixture',runId,taskId:'T-002',attempt:1});
const requestFor=identity=>({version:1,operation:'advance',requestId:'advance',identity});
function executionFor(f,content,verdict='blocked',qaResult=null){
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(request,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:`thread-${request.identity.runId}`});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict,packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};
    }};
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:2000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({
      requestedModel:'fixture',worker:async()=>{fs.writeFileSync(path.join(f.codeProject,'a.mjs'),content);
        return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
          retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    reviewers:[reviewer],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],
      authorize:(request,{authorizationAt})=>{
        const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.identity.runId}`,
          adapterId:'codex-review-adapter',invocationId:request.invocationId,requestDigest:request.requestDigest,
          identity:request.identity,reviewerId:'reviewer',logicalContextId:request.contextId,
          packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'control',decisionId:'approved',
          decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
        return {...body,grantDigest:digest(body)};
      }},hostDecision:{status:'approved'},check:createHostCheck({cwd:f.codeProject,
      commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]})};
  if(qaResult){
    execution.qaDecisionProvider={timeoutMs:1000,decide:async binding=>({decisionId:'qa-decision',
      identity:binding.identity,packageDigest:binding.packageDigest,status:'triggered',
      reason:'fixture qa',score:null,at:'2026-09-24T00:00:00Z'})};
    execution.qaExecutor={mode:'commands',caseCount:1,timeoutMs:2000,run:async binding=>{
      const report=path.join(f.reviewsDir,`${binding.testRunId}-execution.md`);
      fs.writeFileSync(report,`# Fixture ${qaResult} QA\n`);
      return {result:qaResult,passed:qaResult==='PASS'?1:0,failed:0,blocked:qaResult==='BLOCKED'?1:0,report};
    }};
  }
  return execution;
}
async function start(f,runId,content,options={},verdict='blocked',qaResult=null){
  const identity=identityFor(runId),definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,
    feature:f.feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const run=await openControlRun(definition,'create',executionFor(f,content,verdict,qaResult),options);
  try{return await run.host.handle(requestFor(identity));}finally{run.close();}
}

test('explicit restart archives reviewed bytes and records a new-run authorization',async()=>{
  const f=runFixture();
  try{
    const first=await start(f,'run-one-0001','first\n');
    assert.equal(first.state,'blocked');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-a2-handoff.json'),'{}\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-correction-r1.md'),'# Old correction evidence\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-qa-extra.json'),'{}\n');
    fs.writeFileSync(path.join(f.reviewsDir,'work-T-002-r2.md'),'# Old second review\n');
    const oldNames=['work-T-002-a1-handoff.json','work-T-002-a2-handoff.json',
      'work-T-002-correction-r1.md','work-T-002-qa-extra.json','work-T-002-r1.md','work-T-002-r2.md'];
    const old=new Map(oldNames.map(name=>[name,fs.readFileSync(path.join(f.reviewsDir,name))]));
    const priorJournal=fs.readFileSync(path.join(f.reviewsDir,'.execution','run-one-0001','state.json'));
    const without=await start(f,'run-two-0002','second\n');
    assert.equal(without.code,'handoff_exists');assert.equal(without.outcome,'blocked');
    assert.match(without.reason,/--supersede-reviewed-evidence/);
    assert(oldNames.every(name=>fs.existsSync(path.join(f.reviewsDir,name))));
    const plainState=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-two-0002','state.json')));
    assert(plainState.records.every(row=>row.payload.type!=='evidence-superseded'));
    assert.equal(plainState.records[0].payload.version,3);
    const second=await start(f,'run-three-0003','third\n',{supersedeReason:'Operator confirmed genuine restart'});
    assert.equal(second.state,'blocked');
    const archive=path.join(f.reviewsDir,'.superseded');
    for(const [name,bytes] of old){
      const sha=createHash('sha256').update(bytes).digest('hex');
      assert.deepEqual(fs.readFileSync(path.join(archive,`${name}.${sha.slice(0,16)}`)),bytes);
    }
    const state=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-three-0003','state.json')));
    const record=state.records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.deepEqual(record.previousRunIds,['run-one-0001','run-two-0002']);
    assert.deepEqual(record.files.map(file=>file.name),oldNames);
    for(const file of record.files)assert.equal(file.sha256,
      createHash('sha256').update(old.get(file.name)).digest('hex'));
    assert.equal(record.reason,'Operator confirmed genuine restart');
    assert.deepEqual(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-one-0001','state.json')),priorJournal);
    assert(fs.existsSync(path.join(f.reviewsDir,'work-T-002-r1.md')));
    const newStateFile=path.join(f.reviewsDir,'.execution','run-three-0003','state.json');
    const beforeResume=fs.readFileSync(newStateFile);
    const identity=identityFor('run-three-0003');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const resumed=await openControlRun(definition,'resume',executionFor(f,'third\n'));
    resumed.close();assert.deepEqual(fs.readFileSync(newStateFile),beforeResume);
    const events=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      .filter(row=>row.event==='supersede'&&row.run_id==='run-three-0003');
    assert.equal(events.length,1);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('reviewed run with BLOCKED QA reproduces the collision after the task is reopened',async()=>{
  const f=runFixture();
  try{
    const first=await start(f,'run-qa-one-0001','first\n',{},'approved','BLOCKED');
    assert.equal(first.code,'qa_result_blocked');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/);
    await assert.rejects(start(f,'run-qa-refused-0002','second\n',{supersedeReason:'restart'}),error=>
      error.code==='supersede_unavailable'&&/先将该任务改回 - \[ \]/.test(error.reason)
        &&/--supersede-reviewed-evidence/.test(error.reason)&&/--supersede-reason/.test(error.reason));
    // N5 checked the task before N6. The explicit restart rule requires an
    // operator to reopen it; this test keeps that precondition visible.
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    const without=await start(f,'run-qa-two-0002','second\n');
    assert.equal(without.code,'handoff_exists');assert.match(without.reason,/--rerun-blocked-qa/);
    const restarted=await start(f,'run-qa-three-0003','third\n',{supersedeReason:'Reopen after blocked QA'});
    assert.equal(restarted.state,'blocked');
    const record=JSON.parse(fs.readFileSync(path.join(f.reviewsDir,'.execution','run-qa-three-0003','state.json')))
      .records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.deepEqual(record.previousRunIds,['run-qa-one-0001','run-qa-two-0002']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a normally completed previous task cannot be superseded',async()=>{
  const f=runFixture();
  try{
    const completed=await start(f,'run-complete-0001','done\n',{},'approved');
    assert.equal(completed.state,'fixture_completed');
    assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[x\] T-002/);
    await assert.rejects(start(f,'run-refused-0002','again\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/已将任务标为完成/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('a completed journal with passed QA still refuses supersession after the task is reopened',async()=>{
  const f=runFixture();
  try{
    const completed=await start(f,'run-complete-reopened-0001','done\n',{},'approved','PASS');
    assert.equal(completed.state,'fixture_completed');
    const rows=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(rows.some(row=>row.run_id==='run-complete-reopened-0001'&&row.event==='test_run'
      &&row.phase==='complete'&&row.result==='PASS'));
    fs.writeFileSync(f.tasksPath,'- [ ] T-002: fixture\n');
    await assert.rejects(start(f,'run-refused-reopened-0002','again\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/已完成或 QA 已通过/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersession recognizes the optional task strikethrough used by admission',async()=>{
  const f=runFixture();
  try{
    assert.equal((await start(f,'run-struck-0001','first\n')).state,'blocked');
    fs.writeFileSync(f.tasksPath,'- [ ] ~~T-002: fixture\n');
    const record=prepareReviewedEvidenceSupersession({specsDir:f.specsDir,codeProject:f.codeProject,
      feature:f.feature,identity:identityFor('run-struck-0002'),reason:'restart',tasksPath:f.tasksPath});
    assert.deepEqual(record.previousRunIds,['run-struck-0001']);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('lsof warnings do not hide a closed writer, but other diagnostics fail closed',async()=>{
  const {oldWriterOpen}=await import('../runtime/js/cm-ai/reviewed-evidence-supersede.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-lsof-')));
  try{
    const tool=path.join(root,'lsof');
    const write=(warning,code,stdout='')=>{fs.writeFileSync(tool,`#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(warning)});process.stdout.write(${JSON.stringify(stdout)});process.exit(${code});\n`);fs.chmodSync(tool,0o755);};
    write("lsof: WARNING: can't stat() fuse file system\n",1);
    assert.equal(oldWriterOpen(root,'old-run',{lsofPath:tool}),false);
    write("lsof: WARNING: can't stat() network file system\n",0,'p123\n');
    assert.equal(oldWriterOpen(root,'old-run',{lsofPath:tool}),true);
    write('lsof: unexpected error\n',1);
    assert.throws(()=>oldWriterOpen(root,'old-run',{lsofPath:tool}),
      error=>error.code==='supersede_unavailable'&&/无法核对/.test(error.reason));
    fs.chmodSync(tool,0o644);
    assert.throws(()=>oldWriterOpen(root,'old-run',{lsofPath:tool}),
      error=>error.code==='supersede_unavailable'&&/无法核对/.test(error.reason));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a terminal journal is not supersedable while its old writer is still open',async()=>{
  const f=runFixture();
  try{
    const identity=identityFor('run-held-0001');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const held=await openControlRun(definition,'create',executionFor(f,'first\n'));
    try{
      assert.equal((await held.host.handle(requestFor(identity))).state,'blocked');
      await assert.rejects(start(f,'run-refused-0002','second\n',{supersedeReason:'restart'}),
        error=>error.code==='supersede_unavailable'&&/writer 仍被进程持有/.test(error.reason));
    }finally{held.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('supersede refuses missing reason, no prior evidence, an active run, and a checked task',async()=>{
  const f=runFixture();
  try{
    await assert.rejects(start(f,'run-empty-0001','new\n',{supersedeReason:'restart'}),{code:'supersede_unavailable'});
    const identity=identityFor('run-active-0002');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const active=await openControlRun(definition,'create',executionFor(f,'first\n'));
    try{
      await assert.rejects(start(f,'run-refused-0003','second\n',{supersedeReason:'restart'}),
        error=>error.code==='supersede_unavailable'&&/仍可继续/.test(error.reason));
    }finally{active.close();}
    const first=await start(f,'run-blocked-0004','first\n');assert.equal(first.state,'blocked');
    await assert.rejects(start(f,'run-refused-0005','second\n',{supersedeReason:''}),
      error=>error.code==='supersede_unavailable'&&/500 字节/.test(error.reason));
    await assert.rejects(start(f,'run-refused-0007','second\n',{supersedeReason:'汉'.repeat(167)}),
      error=>error.code==='supersede_unavailable'&&/500 字节/.test(error.reason));
    fs.writeFileSync(f.tasksPath,'- [x] T-002: fixture\n');
    await assert.rejects(start(f,'run-refused-0006','second\n',{supersedeReason:'restart'}),
      error=>error.code==='supersede_unavailable'&&/已将任务标为完成/.test(error.reason));
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test('CLI requires both create-time supersession flags before opening a run',async()=>{
  const output=new PassThrough(),error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
  const base=['serve','--config','/missing/run.json','--mode','create','--host-context','fixture','--allow-development'];
  assert.equal(await hostMain([...base,'--supersede-reviewed-evidence'],
    {input:new PassThrough(),output,error}),1);
  assert.match(stderr,/supersede_unavailable/);
  stderr='';
  assert.equal(await hostMain([...base,'--supersede-reason','restart'],
    {input:new PassThrough(),output,error}),1);
  assert.match(stderr,/supersede_unavailable/);
});

test('host stderr carries the handoff recovery hint while the result keeps its code',async()=>{
  const error=new PassThrough();let stderr='';error.on('data',chunk=>stderr+=chunk);
  const host=withHandoffDiagnostic({handle:async()=>({outcome:'blocked',code:'handoff_exists'})},error);
  assert.equal((await host.handle({operation:'advance'})).code,'handoff_exists');
  assert.match(stderr,/\[host\].*--revise-qa-config.*--rerun-blocked-qa.*--supersede-reviewed-evidence/);
});

test('resume completes an interrupted archive from the durable new-run record',async()=>{
  const f=runFixture();
  try{
    await start(f,'run-first-0001','first\n');
    const identity=identityFor('run-next-0002');
    const definition={version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
      identity,scope:['a.mjs'],requirements:['requirements.md']};
    const originalLink=fs.linkSync;
    fs.linkSync=function(source,target){
      if(source.endsWith('work-T-002-r1.md'))throw Object.assign(new Error('injected archival crash'),{code:'EIO'});
      return originalLink.call(fs,source,target);
    };
    try{await assert.rejects(openControlRun(definition,'create',executionFor(f,'second\n'),
      {supersedeReason:'restart after blocked review'}),/injected archival crash/);}
    finally{fs.linkSync=originalLink;}
    const stateFile=path.join(f.reviewsDir,'.execution',identity.runId,'state.json');
    const before=fs.readFileSync(stateFile);
    const record=JSON.parse(before).records.find(row=>row.payload.type==='evidence-superseded')?.payload.record;
    assert(record);assert.equal(record.files.length,2);
    const resumed=await openControlRun(definition,'resume',executionFor(f,'second\n'));
    try{
      assert.deepEqual(fs.readFileSync(stateFile),before);
      assert(record.files.every(file=>fs.existsSync(path.join(f.reviewsDir,'.superseded',
        `${file.name}.${file.sha256.slice(0,16)}`))));
      assert(record.files.every(file=>!fs.existsSync(path.join(f.reviewsDir,file.name))));
      const result=await resumed.host.handle(requestFor(identity));
      assert.equal(result.state,'blocked');assert(fs.existsSync(path.join(f.reviewsDir,'work-T-002-r1.md')));
    }finally{resumed.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
