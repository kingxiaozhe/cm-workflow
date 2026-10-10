// Shared real-batch fixture for the cm-ai-batch-run*.test.mjs files: one approved
// feature, a fresh Git code project per call and the real batch runner with
// synthetic developer, reviewer, QA and documentation providers.
// Not a test file itself; every call works in its own temporary root.
// The tests were split across files so they run in separate processes; batchFixture
// patches Date.now and fs.existsSync for some modes, so tests of one file stay serial.
import {buildManifest} from './cm-spec-manifest.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createParallelMemberQaDecisionProvider} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import path from 'node:path';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createHostQaDecisionProvider} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';

export async function batchFixture(mode,options={}){
  const parallel=mode.startsWith('parallel');
  const recovery=mode==='parallel-recovery',blockedIds=options.blockedIds??['T-002'];
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-')));
  // parallel-grant-expired: right after T-002's first grant, registration reads the
  // authorization instant and the dispatch clock reads past the 1 ms grant.
  const realNow=Date.now;let expiry=null,expiredOnce=false,reviewDispatches=0;
  if(mode==='parallel-grant-expired')Date.now=()=>{const now=realNow.call(Date);
    if(expiry===null)return now;return expiry.reads++===0?expiry.at:Math.max(now,expiry.at+2);};
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
    for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n'+(parallel?'- [ ] T-003: final\n\n- T-003 依赖 T-001, T-002\n':''));
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
    const git=(cwd,args)=>{const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
    {git(codeProject,['init','-b','main']);git(codeProject,['config','user.name','Fixture']);git(codeProject,['config','user.email','fixture@example.invalid']);
      fs.writeFileSync(path.join(codeProject,parallel?'base.js':'file0.js'),'base\n');git(codeProject,['add','-A']);git(codeProject,['commit','-m','fixture baseline']);}
    const config={version:1,repositoryId:'batch-fixture',batchId:'batch-fixture',specsDir,codeProject,
      ...(options.executionPolicy?{executionPolicy:EXECUTION_POLICY_V1}:{}),
      ...(parallel?{parallel:[[`${feature}/T-001`,`${feature}/T-002`]]}:{}),
      tasks:(parallel?['T-001','T-002','T-003']:['T-001','T-002']).map((taskId,index)=>({feature,taskId,scope:[`file${index}.js`],requirements:['requirements.md']}))};
    const calls=[],qaCalls=[],assessments=[],blockedEvidence=[],checkCalls=new Map();let qaReady=mode!=='qa-resume',started;
    const began=new Promise(resolve=>{started=resolve;});
    let conflictHead=null,interrupted=false,reviewFailed=false,redoThrown=false;
    const developerModel=mode==='parallel-redo'?'current-session':'fixture';
    const executionFor=async(definition,{parallelMember=false}={})=>({configuration:{kind:'batch-fixture-v1',...(parallelMember?{parallelMember:true}:{})},timeoutMs:3000,
      excludedContexts:['host'],hostDecision:{status:'approved'},applicableAgentFiles:[],
      developer:{provider:'codex',requestedModel:developerModel,contextId:'author',run:createCodexDeveloperRun({requestedModel:developerModel,
        worker:async({prompt},{signal})=>{
          const data=JSON.parse(prompt.split('<cm-developer-data-json>\n')[1]),material=data.specification;
          assert.equal(material.task.id,definition.identity.taskId);
          assert.deepEqual(material.sources,buildManifest(specsDir));
          if(recovery&&!parallelMember&&blockedIds.includes(definition.identity.taskId)){
            const key=`${feature}/${definition.identity.taskId}`;
            assert.equal(definition.codeProject,codeProject);
            assert.equal(definition.identity.runId,`task-${digest({batchId:config.batchId,task:key,generation:2}).slice(0,48)}`);
            const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
            const blocked=rows.find(row=>row.phase==='batch_member_blocked'&&row.from_key===key);
            const expectedReason=options.withReason?'Expected stub throws; waiting for peer':'failed';
            assert(blocked);assert.equal(blocked.generation,2);assert.equal(blocked.code,'failed');
            assert(!fs.existsSync(blocked.worktree));
            assert.match(git(codeProject,['log','-1','--format=%s',blocked.branch]),/^WIP .*: blocked \(failed\)$/);
            blockedEvidence.push({reason:blocked.reason,body:git(codeProject,['log','-1','--format=%b',blocked.branch]),
              expectedReason,description:definition.identity.taskId==='T-001'?'first':'second'});
            assert.equal(git(codeProject,['show',`${blocked.branch}:${definition.scope[0]}`]),'implemented');
            for(const id of ['T-001','T-002'].filter(id=>!blockedIds.includes(id))){
              const merged=rows.find(row=>row.phase==='batch_handoff'&&row.from_key===`${feature}/${id}`);
              assert(merged);assert(rows.indexOf(merged)<rows.indexOf(blocked));
              assert.equal(fs.readFileSync(path.join(codeProject,config.tasks.find(task=>task.taskId===id).scope[0]),'utf8'),'implemented\n');
            }
          }
          // A second attempt must change the rejected bytes (develop_unchanged_after_review).
          calls.push(definition.identity.taskId);fs.writeFileSync(path.join(definition.codeProject,definition.scope[0]),
            data.identity.attempt===1?'implemented\n':'implemented again\n');
          // The session wrote, then the conversation dropped: no answer (develop_answer_missing).
          if(mode==='parallel-redo'&&parallelMember&&definition.identity.taskId==='T-002'&&!redoThrown){
            redoThrown=true;throw Object.assign(new Error('host_disconnected'),{code:'host_disconnected'});}
          if(recovery&&blockedIds.includes(definition.identity.taskId)&&(parallelMember||options.terminalAgain))
            return {status:'succeeded',value:{outcome:'blocked',...(options.withReason?{reason:'Expected stub throws; waiting for peer'}:{})}};
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
      check:async()=>{
        const key=definition.identity.taskId,count=(checkCalls.get(key)??0)+1;checkCalls.set(key,count);
        const failed=parallelMember&&key==='T-002'
          &&(mode==='parallel-completion-retry'&&count===2||mode==='parallel-develop-check-retry'&&count===1);
        return [{id:'fixture',command:['fixture'],outcome:failed?'failed':'passed',exitCode:failed?1:0,
          evidence:failed?'Synthetic transient failure':'Synthetic task check'}];
      },
      reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,
        contexts:['review-1','review-2'],run:(request,{onEvent})=>{
          if(request.identity.taskId==='T-002')reviewDispatches++;
          assert.equal(request.payload.reviewPackage.specification.task.id,definition.identity.taskId);
          assert.deepEqual(request.payload.reviewPackage.specification.sources,buildManifest(specsDir));
          if(mode==='learning'&&request.identity.taskId==='T-001')
            assert(request.payload.reviewPackage.changes.some(change=>change.path==='AGENTS.md'));
          // The reviewer started, then its process vanished without any terminal event: unknown.
          if(mode==='parallel-unknown'&&request.identity.taskId==='T-002'){
            onEvent({event:'thread.started',provider_thread:'review-lost'});throw Error('Synthetic lost reviewer');}
          if(mode.endsWith('review-provider-retry')&&request.identity.taskId==='T-001'&&!reviewFailed){
            reviewFailed=true;
            // Claude CLI rate limit: no tool call, no verdict, process exited.
            for(const event of [{event:'thread.started',provider_thread:'review-rate-limited'},{event:'turn.started',item_type:null},
              {event:'process_closed',exit_code:1,signal:null,timed_out:false}])onEvent(event);
            return {status:'failed',code:'reviewer_rate_limited'};
          }
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
        if(mode==='parallel-denied'&&request.identity.taskId==='T-002')return {status:'denied',code:'permission_denied'};
        if(mode==='parallel-grant-expired'&&request.identity.taskId==='T-002'&&!expiredOnce){
          expiredOnce=true;body.expiresAt=authorizationAt+1;expiry={at:authorizationAt,reads:0};}
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
    const open=(extra={})=>createCmAiBatch({configuration:config,executionFor,logHome:path.join(root,'logs'),...extra});
    if(mode==='parallel-existing'){
      // T-002's scope file is committed on HEAD, so it is an edit, not a new file.
      fs.writeFileSync(path.join(codeProject,'file1.js'),'existing\n');git(codeProject,['add','file1.js']);git(codeProject,['commit','-m','existing file']);
      await assert.rejects(open().handle({operation:'advance',requestId:'existing'}),error=>error.code==='parallel_scope_existing_file');
      assert.deepEqual(calls,[]);assert(!fs.existsSync(path.join(root,'.cm-worktrees')));
      assert.equal(git(codeProject,['status','--porcelain']),'');return;
    }
    if(mode==='parallel-dirty'){
      fs.writeFileSync(path.join(codeProject,'dirty.txt'),'user-owned\n');
      const result=await open().handle({operation:'advance',requestId:'dirty'});
      assert.equal(result.code,'batch_main_dirty');assert.match(result.reason,/dirty\.txt/);assert.deepEqual(result.files,['?? dirty.txt']);
      assert.deepEqual(calls,[]);assert(!fs.existsSync(path.join(root,'.cm-worktrees')));
      assert(!fs.existsSync(path.join(specsDir,'运行日志.jsonl')));
      assert.equal(git(codeProject,['status','--porcelain']),'?? dirty.txt');return;
    }
    const originalRead=fs.readFileSync,originalExists=fs.existsSync;
    const crashExists=function(file,...args){
      if(!interrupted&&(options.crashAt==='serial'?String(file).endsWith('state.json'):String(file).endsWith('T-002'))){
        const logfile=path.join(specsDir,'运行日志.jsonl');
        if(originalExists(logfile)&&originalRead(logfile,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(row=>row.phase==='batch_member_blocked')){
          interrupted=true;throw Object.assign(new Error('simulated interrupt'),{code:'simulated_interrupt'});
        }
      }return originalExists.call(fs,file,...args);
    };
    if(recovery&&options.crashAt)fs.existsSync=crashExists;
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
    if(mode==='parallel-unknown'){
      const logfile=path.join(specsDir,'运行日志.jsonl'),rows=()=>fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      const runId=`task-${digest({batchId:config.batchId,task:`${feature}/T-002`}).slice(0,48)}`;
      const statePath=path.join(specsDir,'.reviews','.execution',runId,'state.json');
      for(const requestId of ['advance-unknown-1','advance-unknown-2']){
        assert.equal(result.code,'batch_parallel_member_unresolved',JSON.stringify(result));
        assert.equal(result.memberState,'unknown');assert.equal(result.currentTask,`${feature}/T-002`);
        assert.match(result.reason,/不改排串行/);
        // Batch 4 review round 2: the hint follows the real entry conditions (probed
        // below). This fixture's member journals carry no strict configuration (the
        // fixture execution is not the protected strict factory), so the guard does not
        // refuse them and supersede is the named exit; the strict refusal is covered with
        // real strict journals in cm-external-model-recovery.test.mjs.
        for(const text of [result.reason,result.guidance.nextStep]){
          assert.doesNotMatch(text,/reconcile_review|abandon_|--allow-/);assert.match(text,/--supersede-reviewed-evidence/);
        }
        // Kept in its original run: no second generation, no WIP removal, no redispatch.
        assert.equal(rows().filter(row=>row.phase==='batch_member_blocked').length,0);
        assert(fs.existsSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002')));
        assert(!fs.existsSync(path.join(specsDir,'.reviews','.execution',`task-${digest({batchId:config.batchId,task:`${feature}/T-002`,generation:2}).slice(0,48)}`)));
        assert(fs.existsSync(statePath));
        const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
        assert.equal(classifyDriveResult('cm-ai-batch',{result}),'stuck');
        const before=fs.readFileSync(statePath);
        result=await open().handle({operation:'advance',requestId});
        assert.deepEqual(fs.readFileSync(statePath),before,'an unresolved member is not redispatched');
      }
      assert.deepEqual(calls,['T-001','T-002']);
      // Probe the exits the hint names (or withholds) through the real entry checks.
      const {prepareReviewedEvidenceSupersession}=await import('../runtime/js/cm-ai/reviewed-evidence-supersede.mjs');
      const {acquireExternalRunGuard,externalRunGuardExists}=await import('../runtime/js/cm-ai/external-run-guard.mjs');
      const worktree=path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002');
      const identity={repositoryId:config.repositoryId,runId:'task-supersede-probe',taskId:'T-002',attempt:1};
      prepareReviewedEvidenceSupersession({specsDir,codeProject:worktree,feature,identity,reason:'probe',
        tasksPath:path.join(specsDir,feature,'tasks.md'),acceptSupersededCodeDrift:true});
      // The named exit is an ordinary single-task launch: the guard it takes where a strict
      // binding exists on that root (strictOnly) does not refuse this prior run.
      if(!options.executionPolicy)assert.equal(externalRunGuardExists(specsDir,worktree),false,'an ordinary single-task supersede takes no external run guard');
      acquireExternalRunGuard({specsDir,codeProject:worktree,identity,feature},{strictOnly:true}).close();
      return;
    }
    if(mode==='parallel-denied'){
      assert.deepEqual([result.code,result.memberState,result.memberCode,result.rawState],
        ['batch_parallel_member_unresolved','pending_review','permission_denied','pending_review/permission_denied'],JSON.stringify(result));
      for(const text of [result.reason,result.guidance.nextStep]){
        assert.doesNotMatch(text,/--supersede-reviewed-evidence|reconcile_review|abandon_|--allow-/);assert.match(text,/目前都没有/);}
      assert(fs.existsSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002')));
      assert.equal(fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').includes('batch_member_blocked'),false);
      return;
    }
    if(mode==='parallel-grant-expired'){
      const logfile=path.join(specsDir,'运行日志.jsonl'),rows=()=>fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert(expiredOnce);
      assert.deepEqual([result.state,result.code,result.pendingAction,result.identity.taskId],['pending_review','grant_expired','resume','T-002'],JSON.stringify(result));
      assert.equal(reviewDispatches,0);
      // Kept in its run: no reschedule, worktree and delivery stay.
      assert.equal(rows().filter(row=>row.phase==='batch_member_blocked').length,0);
      assert.equal(fs.readFileSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002','file1.js'),'utf8'),'implemented\n');
      result=await open().handle({operation:'advance',requestId:'after-grant-expired'});
      assert.equal(result.code,'run_done',JSON.stringify(result));
      assert.equal(reviewDispatches,1);assert.deepEqual(calls,['T-001','T-002','T-003']);
      assert.equal(rows().filter(row=>row.phase==='batch_member_blocked').length,0);
      const runId=`task-${digest({batchId:config.batchId,task:`${feature}/T-002`}).slice(0,48)}`;
      const records=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',runId,'state.json'),'utf8')).records;
      assert.deepEqual(records.filter(row=>row.payload.type==='review-invocation-result').map(row=>row.payload.outcome),['not_dispatched','observed']);
      return;
    }
    if(mode==='parallel-redo'){
      const logfile=path.join(specsDir,'运行日志.jsonl'),rows=()=>fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(result.code,'batch_parallel_member_recovery_required',JSON.stringify(result));
      assert.deepEqual([result.currentTask,result.pendingAction,result.memberCode],[`${feature}/T-002`,'develop_redo','develop_answer_missing']);
      assert.match(result.reason,/--allow-develop-redo 1\.work\/T-002/);assert.equal(result.guidance.authorizationGranted,false);
      // Kept in place: no serial reschedule, its worktree and edits stay for the redo.
      assert.equal(rows().filter(row=>row.phase==='batch_member_blocked').length,0);
      const worktree=path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002');
      assert.equal(fs.readFileSync(path.join(worktree,'file1.js'),'utf8'),'implemented\n');
      const redo={operation:'develop_redo',requestId:'redo',taskKey:`${feature}/T-002`,reason:'会话已停止修改代码'};
      const refused=await open().handle(redo);
      assert.deepEqual([refused.outcome,refused.code],['rejected','batch_member_action_authorization_required']);
      assert.match(refused.reason,/--allow-develop-redo 1\.work\/T-002/);
      const other=await open({memberActions:{develop_redo:[`${feature}/T-001`]}}).handle({...redo,taskKey:`${feature}/T-001`});
      assert.deepEqual([other.outcome,other.code],['rejected','batch_member_action_not_current']);
      const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
      for(const value of [result,refused,other])assert.equal(classifyDriveResult('cm-ai-batch',{result:value}),'stuck',value.code);
      const granted=open({memberActions:{develop_redo:[`${feature}/T-002`]}});
      const recorded=await granted.handle(redo);
      assert.deepEqual([recorded.outcome,recorded.code,recorded.pendingAction,recorded.taskKey],['recorded','develop_answer_missing','resume',`${feature}/T-002`],JSON.stringify(recorded));
      // One-shot: the same launch cannot record a second confirmation.
      const again=await granted.handle(redo);assert.equal(again.code,'batch_member_action_authorization_required');
      result=await granted.handle({operation:'advance',requestId:'after-redo'});
      assert.equal(result.code,'run_done',JSON.stringify(result));
      assert.deepEqual(calls,['T-001','T-002','T-002','T-003']);
      assert.equal(rows().filter(row=>row.phase==='batch_member_blocked').length,0);
      assert.equal(rows().filter(row=>row.phase==='batch_handoff').length,2);
      const runId=`task-${digest({batchId:config.batchId,task:`${feature}/T-002`}).slice(0,48)}`;
      const records=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',runId,'state.json'),'utf8')).records;
      assert.equal(records.filter(row=>row.payload.type==='develop-answer-redo').length,1);
      return;
    }
    if(mode==='parallel-completion-retry'){
      assert.equal(result.code,'completion_checks_changed',JSON.stringify(result));
      const logfile=path.join(specsDir,'运行日志.jsonl');
      let rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.phase==='batch_member_blocked').length,0);
      assert(fs.existsSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),'T-002')));
      result=await open().handle({operation:'advance',requestId:'retry-completion'});
      assert.equal(result.code,'run_done',JSON.stringify(result));
      rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.phase==='batch_member_blocked').length,0);
      assert.equal(checkCalls.get('T-002'),3);
      assert.deepEqual(calls,['T-001','T-002','T-003']);
      return;
    }
    if(mode==='parallel-develop-check-retry'){
      assert.equal(result.code,'develop_checks_not_passed',JSON.stringify(result));
      const logfile=path.join(specsDir,'运行日志.jsonl');
      let rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.phase==='batch_member_blocked').length,0);
      result=await open().handle({operation:'advance',requestId:'retry-develop-check'});
      assert.equal(result.code,'run_done',JSON.stringify(result));
      rows=fs.readFileSync(logfile,'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.phase==='batch_member_blocked').length,0);
      assert.equal(checkCalls.get('T-002'),3);
      assert.equal(calls.filter(task=>task==='T-002').length,2);
      return;
    }
    // Review round 1 (major): a batch (strict or ordinary) stops right after
    // rescheduling, before dispatching anything to the new second-generation run;
    // the next advance runs it. A crash while preserving the WIP (cleanup) happens
    // inside the rescheduling advance; the resume then finds the logged decision.
    if(recovery&&options.crashAt!=='cleanup'){
      assert.equal(result.code,'batch_member_rescheduled',JSON.stringify(result));
      assert.deepEqual(result.rescheduled,blockedIds.map(id=>`${feature}/${id}`));
      assert.match(result.reason,/下一次 advance/);assert.equal(result.guidance.authorizationGranted,false);
      assert.equal(blockedEvidence.length,0,'no second-generation develop in the rescheduling advance');
      assert(!fs.existsSync(path.join(specsDir,'.reviews','.execution',`task-${digest({batchId:config.batchId,task:`${feature}/${blockedIds[0]}`,generation:2}).slice(0,48)}`)));
      const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
      assert.equal(classifyDriveResult('cm-ai-batch',{result}),'stuck');
      // crashAt serial: the interrupt hits the second-generation start in this advance.
      if(options.crashAt)fs.existsSync=crashExists;
      try{result=await open().handle({operation:'advance',requestId:'after-reschedule'});}
      catch(error){if(!(options.crashAt&&error.code==='simulated_interrupt'))throw error;}
      finally{fs.existsSync=originalExists;}
    }
    if(recovery&&options.crashAt){assert(interrupted);result=await open().handle({operation:'advance',requestId:'resume-recovery'});}
    if(recovery){
      // Assert outside the worker: worker exceptions intentionally become unknown terminals.
      assert(blockedEvidence.length>0);
      for(const evidence of blockedEvidence){
        assert.equal(evidence.reason,evidence.expectedReason);
        assert.equal(evidence.body,evidence.description+'\n\n'+evidence.expectedReason);
      }
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
      for(const task of ['T-001','T-002'])assert(fs.existsSync(path.join(root,'.cm-worktrees',config.batchId.slice(0,8),task)));
      // Kept member branches are namespaced per batch, so a later batch of the same
      // tasks does not collide with the WIP branches this one leaves behind.
      const segment=config.batchId.slice(0,8).replace(/\./g,'-');
      const heads=git(codeProject,['for-each-ref','--format=%(refname:short)','refs/heads/cm']).split('\n').filter(Boolean);
      assert.deepEqual(heads.sort(),[`cm/${segment}/work/T-001`,`cm/${segment}/work/T-002`]);
      for(const name of heads)git(codeProject,['check-ref-format','--branch',name]);
      for(const task of ['T-001','T-002'])assert.throws(()=>git(codeProject,['rev-parse','--verify',`refs/heads/cm/work/${task}`]));
      return;
    }
    if(mode.endsWith('review-provider-retry')){
      assert.equal(result.state,'pending_review',JSON.stringify(result));assert.equal(result.code,'review_provider_failed');
      assert.match(result.reason,/^reviewer_rate_limited: /);assert.deepEqual(calls,parallel?['T-001','T-002']:['T-001']);
      result=await open().handle({operation:'advance',requestId:'retry-review'});
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
    if(mode==='resources-open'){
      const {batchTaskRunId}=await import('./cm-ai-batch-run.mjs');
      const runId=batchTaskRunId(config.batchId,`${feature}/T-001`),writer=new URL('./cm-log-event.py',import.meta.url).pathname;
      const resource=(phase,data)=>{const written=spawnSync('python3',[writer,'--workflow','cm-ai','--event','resource','--phase',phase,
        '--runtime','codex','--project-root',codeProject,'--specs-dir',specsDir,'--run-id',runId,'--detail','fixture','--data-json',JSON.stringify(data)],
        {encoding:'utf8',timeout:10000,env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});assert.equal(written.status,0,written.stderr);};
      const gone=spawnSync(process.execPath,['-e','0']).pid;
      for(const id of ['qa-command-gone','qa-command-legacy'])resource('acquired',{resource_id:id,resource_kind:'qa_command',cleanup_required:true});
      resource('cleanup_failed',{resource_id:'qa-command-gone',resource_kind:'qa_command',pid:gone,process_start_time:'Mon Jan  1 00:00:00 2001'});
      resource('cleanup_failed',{resource_id:'qa-command-legacy',resource_kind:'qa_command'});
      // The batch owner throws; the batch host turns it into {outcome:'blocked',code,reason}.
      let blocked;
      await assert.rejects(open().handle({operation:'advance',requestId:'resources'}),error=>{
        blocked={outcome:'blocked',code:error.code,reason:error.reason};return error.code==='batch_resources_open';});
      assert.match(blocked.reason,/qa-command-legacy（cleanup_failed，没有记录进程身份）/);assert.doesNotMatch(blocked.reason,/qa-command-gone/);
      const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row=>row.event==='resource'&&row.phase==='released'&&row.resource_id==='qa-command-gone'&&row.verification==='process_group_gone').length,1);
      const {classifyDriveResult}=await import('../runtime/js/notify.mjs');
      assert.equal(classifyDriveResult('cm-ai-batch',{result:blocked}),'stuck');
      return;
    }
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
  }finally{Date.now=realNow;fs.rmSync(root,{recursive:true,force:true});}
}
