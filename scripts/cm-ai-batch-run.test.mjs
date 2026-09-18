import {buildManifest} from './cm-spec-manifest.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createParallelMemberQaDecisionProvider} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import path from 'node:path';
import {createCmAiBatch,taskCommitArgs} from './cm-ai-batch-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createHostQaDecisionProvider} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';

for(const mode of ['continuous','qa-resume','failed-qa','cancel','learning','policy','executor'])
test(`real multi-task runner keeps QA and recovery authoritative: ${mode}`,()=>batchFixture(mode));

for(const mode of ['parallel','parallel-retry','parallel-conflict','parallel-resume'])
test(`parallel batch runs real isolated members: ${mode}`,()=>batchFixture(mode));

test('ready member merges before blocked member preserves WIP and falls back only once',()=>
  batchFixture('parallel-recovery',{terminalAgain:true}));
test('serial fallback resumes from log and automatically commits its completed task',async()=>{
  for(const options of [{crashAt:'cleanup'},{crashAt:'serial'},
    {blockedIds:['T-001']},{blockedIds:['T-001','T-002']}])await batchFixture('parallel-recovery',options);
});
test('final serial task commits durably and commit information survives resume',()=>batchFixture('final-commit'));
test('dirty batch entry lists files and creates no member worktrees',()=>batchFixture('parallel-dirty'));

test('task commit subjects are single-line and bounded while bodies preserve descriptions',()=>{
  const cases=[
    ['简短任务','T-001: 简短任务'],
    ['完成 `接口` **实现** ~15min；保留后续。\n完整正文','T-001: 完成 `接口` **实现**'],
    ['首句。后续 ~20min','T-001: 首句'],
    ['首行\n第二行 ~10min','T-001: 首行'],
    ['~20min 开头估算','T-001: 开头估算'],
    ['~20min','T-001: T-001'],
    ['ASCII task ~5min','T-001: ASCII task'],
    ['x'.repeat(65),'T-001: '+'x'.repeat(65)],
    ['x'.repeat(66),'T-001: '+'x'.repeat(63)+'…'],
    ['中文任务'.repeat(30)+' ~25min',null],
    ['A'.repeat(100)+' ~30min',null],
  ];
  for(const [description,expected] of cases){
    const args=taskCommitArgs('T-001',description);
    assert.equal(args.length,4);assert.equal(args[0],'-m');assert.equal(args[2],'-m');
    assert.doesNotMatch(args[1],/[\r\n\u2028\u2029]/u);
    assert(Array.from(args[1]).reduce((sum,char)=>sum+(char.codePointAt(0)<=127?1:2),0)<=72);
    assert.doesNotMatch(args[1],/~\d+min/u);assert.equal(args[3],description);
    if(expected!==null)assert.equal(args[1],expected);else assert(args[1].endsWith('…'));
    assert.deepEqual(taskCommitArgs('T-001',description,'failed'),['-m','WIP T-001: blocked (failed)','-m',description]);
  }
});

async function batchFixture(mode,options={}){
  const parallel=mode.startsWith('parallel');
  const recovery=mode==='parallel-recovery',blockedIds=options.blockedIds??['T-002'];
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-')));
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
    for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n'+(parallel?'- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n':''));
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
    const git=(cwd,args)=>{const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
    {git(codeProject,['init','-b','main']);git(codeProject,['config','user.name','Fixture']);git(codeProject,['config','user.email','fixture@example.invalid']);
      fs.writeFileSync(path.join(codeProject,'file0.js'),'base\n');git(codeProject,['add','-A']);git(codeProject,['commit','-m','fixture baseline']);}
    const config={version:1,repositoryId:'batch-fixture',batchId:'batch-fixture',specsDir,codeProject,
      ...(parallel?{parallel:[[`${feature}/T-001`,`${feature}/T-002`]]}:{}),
      tasks:(parallel?['T-001','T-002','T-003']:['T-001','T-002']).map((taskId,index)=>({feature,taskId,scope:[`file${index}.js`],requirements:['requirements.md']}))};
    const calls=[],qaCalls=[],assessments=[];let qaReady=mode!=='qa-resume',started;
    const began=new Promise(resolve=>{started=resolve;});
    let conflictHead=null,interrupted=false;
    const executionFor=async(definition,{parallelMember=false}={})=>({configuration:{kind:'batch-fixture-v1',...(parallelMember?{parallelMember:true}:{})},timeoutMs:3000,
      excludedContexts:['host'],hostDecision:{status:'approved'},applicableAgentFiles:[],
      developer:{provider:'codex',requestedModel:'fixture',contextId:'author',run:createCodexDeveloperRun({requestedModel:'fixture',
        worker:async({prompt},{signal})=>{
          const material=JSON.parse(prompt.split('<cm-developer-data-json>\n')[1]).specification;
          assert.equal(material.task.id,definition.identity.taskId);
          assert.deepEqual(material.sources,buildManifest(specsDir));
          if(recovery&&!parallelMember&&blockedIds.includes(definition.identity.taskId)){
            const key=`${feature}/${definition.identity.taskId}`;
            assert.equal(definition.codeProject,codeProject);
            assert.equal(definition.identity.runId,`task-${digest({batchId:config.batchId,task:key,generation:2}).slice(0,48)}`);
            const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
            const blocked=rows.find(row=>row.phase==='batch_member_blocked'&&row.from_key===key);
            assert(blocked);assert.equal(blocked.generation,2);assert.equal(blocked.code,'failed');assert.equal(blocked.reason,'failed');
            assert(!fs.existsSync(blocked.worktree));
            assert.match(git(codeProject,['log','-1','--format=%s',blocked.branch]),/^WIP .*: blocked \(failed\)$/);
            assert.equal(git(codeProject,['log','-1','--format=%b',blocked.branch]),definition.identity.taskId==='T-001'?'first':'second');
            assert.equal(git(codeProject,['show',`${blocked.branch}:${definition.scope[0]}`]),'implemented');
            for(const id of ['T-001','T-002'].filter(id=>!blockedIds.includes(id))){
              const merged=rows.find(row=>row.phase==='batch_handoff'&&row.from_key===`${feature}/${id}`);
              assert(merged);assert(rows.indexOf(merged)<rows.indexOf(blocked));
              assert.equal(fs.readFileSync(path.join(codeProject,config.tasks.find(task=>task.taskId===id).scope[0]),'utf8'),'implemented\n');
            }
          }
          calls.push(definition.identity.taskId);fs.writeFileSync(path.join(definition.codeProject,definition.scope[0]),'implemented\n');
          if(recovery&&blockedIds.includes(definition.identity.taskId)&&(parallelMember||options.terminalAgain))
            return {status:'succeeded',value:{outcome:'blocked',reason:'Expected stub throws; waiting for peer'}};
          if(parallel&&definition.identity.taskId==='T-002')await new Promise(resolve=>setTimeout(resolve,50));
          if(mode==='parallel-conflict'&&definition.identity.taskId==='T-002'){
            fs.writeFileSync(path.join(codeProject,'file0.js'),'main conflict\n');git(codeProject,['add','file0.js']);git(codeProject,['commit','-m','concurrent main change']);conflictHead=git(codeProject,['rev-parse','HEAD']);
          }
          if(mode==='cancel'){started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}
          const application={status:'no_relevant_lesson',note:null};
          let retrospective={status:'no_new_lesson',candidates:[],reason:null};
          if(mode==='learning'&&definition.identity.taskId==='T-001')retrospective={status:'lesson_candidate',reason:null,
            candidates:[{classification:'structured',trigger:'Synthetic task input requires explicit validation',
              action:'Read the validated input before writing the next fixture',evidence:['file0.js']}]};
          if(mode==='learning'&&definition.identity.taskId==='T-002'){
            const source=fs.readFileSync(path.join(codeProject,'AGENTS.md'),'utf8');
            assert(source.includes('Synthetic task input requires explicit validation'));
            assert(prompt.includes('AGENTS.md'));
            application.status='applied';application.note='Read and applied the T-001 synthetic input-validation lesson from AGENTS.md';
          }
          return {status:'succeeded',value:{outcome:'implemented',application,retrospective}};
        }})},
      check:async()=>[{id:'fixture',command:['fixture'],outcome:'passed',exitCode:0,evidence:'Synthetic task check'}],
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
        contexts:['review-1','review-2'],run:(request,{onEvent})=>{
          assert.equal(request.payload.reviewPackage.specification.task.id,definition.identity.taskId);
          assert.deepEqual(request.payload.reviewPackage.specification.sources,buildManifest(specsDir));
          if(mode==='learning'&&request.identity.taskId==='T-001')
            assert(request.payload.reviewPackage.changes.some(change=>change.path==='AGENTS.md'));
          for(const event of [{event:'thread.started',provider_thread:`review-${request.identity.taskId}`},
            {event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
            {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
          const retry=mode==='parallel-retry'&&request.identity.taskId==='T-001'&&request.identity.attempt===1;
          return {status:'succeeded',value:{verdict:retry?'changes_requested':'approved',packageDigest:request.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(request.payload.reviewPackage),findings:retry?[{id:'F1',severity:'P2',path:'file0.js',message:'Synthetic repair',evidence:'First implementation'}]:[],summary:'Synthetic independent review'}};
        }}],
      reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host'],authorize:(request,{authorizationAt})=>{
        const body={version:1,kind:'cm-review-dispatch-grant',grantId:'grant',adapterId:'codex-review-adapter',
          invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,reviewerId:'reviewer',
          logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'host',
          decisionId:'decision',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
        return {...body,grantDigest:digest(body)};
      }},
      qaDecisionProvider:parallelMember?createParallelMemberQaDecisionProvider():mode==='policy'?createHostQaDecisionProvider({timeoutMs:1000,assess:async binding=>{
        assessments.push(binding.identity.taskId);
        return {scores:{scope:1,risk:1,accumulation:1,boundary:1},
          changes:{api:binding.identity.taskId==='T-001',migration:false,authentication:false,authorization:false,payment:false}};
      }}):{timeoutMs:1000,decide:async binding=>{
        if(!qaReady)throw Object.assign(new Error('await QA decision'),{code:'qa_decision_required'});
        const skip=binding.identity.taskId==='T-001'&&mode!=='failed-qa';
        return {decisionId:`qa-${binding.identity.taskId}`,identity:binding.identity,packageDigest:binding.packageDigest,
          status:skip?'skipped':'triggered',reason:'synthetic',score:skip?4:null,at:'2026-09-08T01:00:00Z'};
      }},
      qaExecutor:mode==='executor'?(()=>{
        const executor=createHostQaExecutor({specsDir,codeProject,feature,runtime:'codex',requirements:definition.requirements,
          commands:[{id:'fixture-command',command:[process.execPath,'-e',
            "require('node:assert/strict').equal(require('node:fs').readFileSync(process.argv[1],'utf8'),'implemented\\n')",
            definition.scope[0]],caseIds:[]}],environment:{kind:'web',carrier:'browser',target:'fixture-command-only',scope:'local'},
          timeoutMs:5000,logHome:path.join(root,'logs')});
        return {...executor,run:(binding,signal)=>{qaCalls.push(binding.identity.taskId);return executor.run(binding,signal);}};
      })():{mode:'commands',caseCount:1,timeoutMs:1000,run:async binding=>{
        qaCalls.push(binding.identity.taskId);
        const report=path.join(specsDir,'.reviews',`${binding.testRunId}.md`);fs.writeFileSync(report,'# Synthetic QA\n');
        const fail=mode==='failed-qa';return {result:fail?'FAIL':'PASS',passed:fail?0:1,failed:fail?1:0,blocked:0,report};
      }},
      documentationProvider:{timeoutMs:1000,inspect:async binding=>({syncId:binding.syncId,identity:binding.identity,
        packageDigest:binding.packageDigest,contextDigest:binding.contextDigest,status:'completed',reason:'Synthetic docs',at:'2026-09-08T01:00:00Z'})},
    });
    const open=()=>createCmAiBatch({configuration:config,executionFor,logHome:path.join(root,'logs')});
    if(mode==='parallel-dirty'){
      fs.writeFileSync(path.join(codeProject,'dirty.txt'),'user-owned\n');
      const result=await open().handle({operation:'advance',requestId:'dirty'});
      assert.equal(result.code,'batch_main_dirty');assert.match(result.reason,/dirty\.txt/);assert.deepEqual(result.files,['?? dirty.txt']);
      assert.deepEqual(calls,[]);assert(!fs.existsSync(path.join(root,'.cm-worktrees')));
      assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));
      assert.equal(git(codeProject,['status','--porcelain']),'?? dirty.txt');return;
    }
    const originalRead=fs.readFileSync,originalExists=fs.existsSync;
    if(recovery&&options.crashAt)fs.existsSync=function(file,...args){
      if(!interrupted&&(options.crashAt==='serial'?String(file).endsWith('state.json'):String(file).endsWith('T-002'))){
        const logfile=path.join(specsDir,'运行日志.jsonl');
        if(originalExists(logfile)&&originalRead(logfile,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(row=>row.phase==='batch_member_blocked')){
          interrupted=true;throw Object.assign(new Error('simulated interrupt'),{code:'simulated_interrupt'});
        }
      }return originalExists.call(fs,file,...args);
    };
    if(mode==='parallel-resume'||mode==='final-commit')fs.existsSync=function(file,...args){
      if(!interrupted&&String(file).endsWith('state.json')){
        const logfile=path.join(specsDir,'运行日志.jsonl');
        if(originalExists(logfile)&&originalRead(logfile,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(row=>row.phase==='batch_handoff')){
          interrupted=true;throw Object.assign(new Error('simulated interrupt'),{code:'simulated_interrupt'});
        }
      }return originalExists.call(fs,file,...args);
    };
    const batch=open(),pending=batch.handle({operation:'advance',requestId:'advance-1'});
    if(mode==='cancel'){
      await began;await batch.handle({operation:'cancel',requestId:'cancel'});
      assert.equal((await pending).code,'cancelled');
      assert.equal((await open().handle({operation:'advance',requestId:'resume'})).code,'cancelled');
      assert.deepEqual(calls,['T-001']);return;
    }
    let result;
    try{result=await pending;}catch(error){if(!(mode==='parallel-resume'||mode==='final-commit'||recovery&&options.crashAt)||error.code!=='simulated_interrupt')throw error;}finally{fs.existsSync=originalExists;}
    if(mode==='final-commit'){
      assert(interrupted);
      const logfile=path.join(specsDir,'运行日志.jsonl');
      const rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      const commit=rows.find(row=>row.phase==='batch_task_committed');assert(commit);
      // Restore the crash prefix before handoff; the next task has not started.
      fs.writeFileSync(logfile,rows.filter(row=>row.phase!=='batch_handoff').map(row=>JSON.stringify(row)+'\n').join(''));
      result=await open().handle({operation:'advance',requestId:'resume-commit-prefix'});
      const recovered=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(recovered.find(row=>row.phase==='batch_handoff').task_commit,commit.task_commit);
    }
    if(recovery&&options.crashAt){assert(interrupted);result=await open().handle({operation:'advance',requestId:'resume-recovery'});}
    if(recovery){
      assert.equal(result.code,options.terminalAgain?'failed':'run_done',JSON.stringify(result));
      const before=[...calls];
      const resumed=await open().handle({operation:'advance',requestId:'resume-recovery-done'});
      assert.equal(resumed.code,result.code);assert.deepEqual(calls,before);
      const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.phase==='batch_member_blocked').length,blockedIds.length);
      for(const id of blockedIds){
        assert.equal(calls.filter(task=>task===id).length,2);
        const key=`${feature}/${id}`,row=rows.find(row=>row.phase==='batch_handoff'&&row.from_key===key);
        if(options.terminalAgain){assert.equal(row,undefined);continue;}
        assert.match(row.task_commit,/^[a-f0-9]{40}$/);
        assert.equal(git(codeProject,['show',`${row.task_commit}:${config.tasks.find(task=>task.taskId===id).scope[0]}`]),'implemented');
        assert.equal(git(codeProject,['show','-s','--format=%s',row.task_commit]),`${id}: ${id==='T-001'?'first':'second'}`);
        const runId=`task-${digest({batchId:config.batchId,task:key,generation:2}).slice(0,48)}`;
        const state=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',runId,'state.json'),'utf8'));
        assert.equal(state.revision,row.checkpoint);
      }
      return;
    }
    if(mode==='parallel-resume'){assert(interrupted);const before=[...calls];result=await open().handle({operation:'advance',requestId:'resume-parallel'});assert.deepEqual(calls.slice(0,before.length),before);}
    if(mode==='parallel-conflict'){
      assert.equal(result.code,'merge_conflict',JSON.stringify(result));assert.equal(git(codeProject,['rev-parse','HEAD']),conflictHead);
      for(const task of ['T-001','T-002'])assert(fs.existsSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),task)));return;
    }
    if(mode==='qa-resume'){
      assert.equal(result.code,'qa_decision_required');assert.deepEqual(calls,['T-001']);
      assert(fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8').includes('[x] T-001'));
      const changed=structuredClone(config);changed.tasks[1].scope=['other.js'];
      await assert.rejects(createCmAiBatch({configuration:changed,executionFor,logHome:path.join(root,'logs')})
        .handle({operation:'advance',requestId:'changed-plan'}),{code:'batch_plan_mismatch'});
      qaReady=true;result=await open().handle({operation:'advance',requestId:'advance-2'});
    }
    assert.equal(result.code,mode==='failed-qa'?'qa_failed':'run_done',JSON.stringify(result));
    assert.deepEqual(calls,parallel?(mode==='parallel-retry'?['T-001','T-002','T-001','T-003']:['T-001','T-002','T-003']):mode==='failed-qa'?['T-001']:['T-001','T-002']);
    if(parallel){
      const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const ready=rows.filter(row=>row.phase==='batch_member_ready'),handoffs=rows.filter(row=>row.phase==='batch_handoff');
      assert.equal(ready.length,2);assert.equal(handoffs.length,2);assert.deepEqual(handoffs.map(row=>row.from_key),ready.map(row=>row.from_key));
      assert(handoffs.every(row=>/^[a-f0-9]{40}$/.test(row.merge_commit)&&row.post_merge_check==='skipped'));
      assert.equal(rows.filter(row=>row.event==='qa'&&row.reason==='parallel_member_deferred'&&row.status==='skipped').length,2);
      assert.deepEqual(qaCalls,['T-003']);
      assert(fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8').includes('[x] T-003'));
      assert.equal(git(codeProject,['branch','--show-current']),'main');
    }
    if(mode==='learning'){
      const handoff=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','work-T-002-a1-handoff.json'),'utf8'));
      assert(handoff.evidence.some(item=>typeof item==='string'&&item.includes('"status":"applied"')));
    }
    if(mode==='final-commit'){
      const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const commits=rows.filter(row=>row.phase==='batch_task_committed');
      assert.deepEqual(commits.map(row=>row.from_key),[`${feature}/T-001`,`${feature}/T-002`]);
      assert(rows.indexOf(commits[0])<rows.findIndex(row=>row.phase==='batch_handoff'));
      assert.equal(result.task_commit,commits[1].task_commit);
      assert.equal(result.task_commit,git(codeProject,['rev-parse','HEAD']));
      assert.equal(git(codeProject,['show','-s','--format=%s',result.task_commit]),'T-002: second');
      assert.equal(git(codeProject,['show','-s','--format=%b',result.task_commit]),'second');
      assert.equal(git(codeProject,['show',`${result.task_commit}:file1.js`]),'implemented');
      assert.equal(git(codeProject,['status','--porcelain']),'');
      const resumedFinal=await open().handle({operation:'advance',requestId:'resume-final-commit'});
      assert.equal(resumedFinal.code,result.code);assert.equal(resumedFinal.task_commit,result.task_commit);
      assert.equal(fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n')
        .map(JSON.parse).filter(row=>row.phase==='batch_task_committed').length,2);

    }
    const before=[...calls],qaBefore=[...qaCalls];
    const resumed=await open().handle({operation:'advance',requestId:'resume'});
    assert.equal(resumed.code,result.code);assert.deepEqual(calls,before);assert.deepEqual(qaCalls,qaBefore);
    if(mode==='final-commit'){
      const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      const commit=rows.find(row=>row.phase==='batch_task_committed');
      assert.equal(rows.find(row=>row.phase==='batch_handoff').task_commit,commit.task_commit);
      assert.equal(git(codeProject,['status','--porcelain']),'');
    }
    if(mode==='executor'){
      assert.deepEqual(qaCalls,['T-002']);
      const reports=fs.readdirSync(path.join(specsDir,'.reviews')).filter(name=>name.endsWith('-execution.md'));
      assert.equal(reports.length,1);assert(fs.readFileSync(path.join(specsDir,'.reviews',reports[0]),'utf8').includes('host check exited 0'));
    }
    if(mode==='policy'){
      assert.deepEqual(assessments,['T-001','T-002']);assert.deepEqual(qaCalls,['T-002']);
      const log=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert(log.some(row=>row.event==='qa'&&row.task==='T-001'&&row.reason==='merged_to_feature_qa'));
      assert.equal(log.filter(row=>row.event==='decision'&&row.phase==='qa_merge'&&row.task==='T-001').length,1);
      assert(log.some(row=>row.event==='qa'&&row.task==='T-002'&&row.reason==='feature_complete'));
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
