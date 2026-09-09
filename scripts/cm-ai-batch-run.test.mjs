import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createHostQaDecisionProvider} from '../runtime/js/cm-ai/host-qa-policy.mjs';
import {createHostQaExecutor} from '../runtime/js/cm-ai/host-qa-executor.mjs';

for(const mode of ['continuous','qa-resume','failed-qa','cancel','learning','policy','executor'])
test(`real multi-task runner keeps QA and recovery authoritative: ${mode}`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-')));
  try{
    const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
    fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
    for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: first\n- [ ] T-002: second\n');
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
    const config={version:1,repositoryId:'batch-fixture',batchId:'batch-fixture',specsDir,codeProject,
      tasks:['T-001','T-002'].map((taskId,index)=>({feature,taskId,scope:[`file${index}.js`],requirements:['requirements.md']}))};
    const calls=[],qaCalls=[],assessments=[];let qaReady=mode!=='qa-resume',started;
    const began=new Promise(resolve=>{started=resolve;});
    const executionFor=async definition=>({configuration:{kind:'batch-fixture-v1'},timeoutMs:3000,
      excludedContexts:['host'],hostDecision:{status:'approved'},applicableAgentFiles:[],
      developer:{provider:'codex',requestedModel:'fixture',contextId:'author',run:createCodexDeveloperRun({requestedModel:'fixture',
        worker:async({prompt},{signal})=>{
          calls.push(definition.identity.taskId);fs.writeFileSync(path.join(codeProject,definition.scope[0]),'implemented\n');
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
          if(mode==='learning'&&request.identity.taskId==='T-001')
            assert(request.payload.reviewPackage.changes.some(change=>change.path==='AGENTS.md'));
          for(const event of [{event:'thread.started',provider_thread:`review-${request.identity.taskId}`},
            {event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
            {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
          return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
            examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic independent review'}};
        }}],
      reviewInvocation:{developerThreadId:'author',excludedThreadIds:['host'],authorize:(request,{authorizationAt})=>{
        const body={version:1,kind:'cm-review-dispatch-grant',grantId:'grant',adapterId:'codex-review-adapter',
          invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,reviewerId:'reviewer',
          logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'host',
          decisionId:'decision',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
        return {...body,grantDigest:digest(body)};
      }},
      qaDecisionProvider:mode==='policy'?createHostQaDecisionProvider({timeoutMs:1000,assess:async binding=>{
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
    const batch=open(),pending=batch.handle({operation:'advance',requestId:'advance-1'});
    if(mode==='cancel'){
      await began;await batch.handle({operation:'cancel',requestId:'cancel'});
      assert.equal((await pending).code,'cancelled');
      assert.equal((await open().handle({operation:'advance',requestId:'resume'})).code,'cancelled');
      assert.deepEqual(calls,['T-001']);return;
    }
    let result=await pending;
    if(mode==='qa-resume'){
      assert.equal(result.code,'qa_decision_required');assert.deepEqual(calls,['T-001']);
      assert(fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8').includes('[x] T-001'));
      const changed=structuredClone(config);changed.tasks[1].scope=['other.js'];
      await assert.rejects(createCmAiBatch({configuration:changed,executionFor,logHome:path.join(root,'logs')})
        .handle({operation:'advance',requestId:'changed-plan'}),{code:'batch_plan_mismatch'});
      qaReady=true;result=await open().handle({operation:'advance',requestId:'advance-2'});
    }
    assert.equal(result.code,mode==='failed-qa'?'qa_failed':'run_done',JSON.stringify(result));
    assert.deepEqual(calls,mode==='failed-qa'?['T-001']:['T-001','T-002']);
    if(mode==='learning'){
      const handoff=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','work-T-002-a1-handoff.json'),'utf8'));
      assert(handoff.evidence.some(item=>typeof item==='string'&&item.includes('"status":"applied"')));
    }
    const before=[...calls],qaBefore=[...qaCalls];
    const resumed=await open().handle({operation:'advance',requestId:'resume'});
    assert.equal(resumed.code,result.code);assert.deepEqual(calls,before);assert.deepEqual(qaCalls,qaBefore);
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
});
