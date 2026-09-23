import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'ai-chain-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const identity={repositoryId:'chain-fixture',runId:'chain-run',taskId:'T-001',attempt:1};
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ai-session-chain-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['target.mjs'],requirements:['requirements.md']};
  const config=path.join(root,'run.json');fs.writeFileSync(config,JSON.stringify(definition));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  // Synthetic diagnostic receipt and fake CLI only: no real preflight/model/network.
  const fake=path.join(bin,'codex');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),fake);fs.chmodSync(fake,0o700);
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture',disabledSkills:[],promptTransport:'stdin'})}};
  const reviewFile=path.join(root,'review.json');fs.writeFileSync(reviewFile,JSON.stringify(review));
  const stateFile=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  const records=()=>JSON.parse(fs.readFileSync(stateFile)).records;
  return {root,definition,codeProject,specsDir,config,review,reviewFile,records,fake,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}};
}
function launch(f,{host='session-A',original,mode='resume',operation='status',review=false}={}){
  return new Promise((resolve,reject)=>{
    const args=['serve','--config',f.config,'--mode',mode,'--host-context',host,'--allow-development','--review-config',f.reviewFile,
      ...(original===undefined?[]:['--original-host-context',original]),...(review?['--allow-review-attempt',String(review===true?1:review)]:[])];
    const child=spawn(process.execPath,[cli,...args],{env:f.env,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='';const rows=[];
    const timer=setTimeout(()=>{child.kill();reject(Error('session chain timeout'));},15000);
    child.on('error',reject);child.stderr.on('data',chunk=>stderr+=chunk);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;let index;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
        try{
          const row=JSON.parse(line);rows.push(row);
          if(row.type==='host_request'){
            let result;
            if(row.kind==='develop'){
              fs.writeFileSync(path.join(f.codeProject,'target.mjs'),'export const value = 42;\n');
              result={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
                retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
            }else{
              assert.equal(row.kind,'check');const command=[process.execPath,'--check',path.join(f.codeProject,'target.mjs')];
              assert.equal(spawnSync(command[0],command.slice(1)).status,0);
              result=[{id:'syntax',command,outcome:'passed',exitCode:0,evidence:'Isolated node --check passed'}];
            }
            send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
          }
          if(row.requestId===operation&&row.result)send({type:'host_close',sessionId:rows.find(r=>r.type==='host_ready').sessionId});
        }catch(error){child.kill();clearTimeout(timer);reject(error);}
      }
    });
    child.once('close',code=>{clearTimeout(timer);resolve({code,stderr,rows,result:rows.find(r=>r.requestId===operation)?.result});});
    send({version:1,operation,requestId:operation,identity});
  });
}
const ok=run=>{assert.equal(run.code,0,run.stderr);return run.result;};
async function created(t){const f=fixture(t);assert.equal(ok(await launch(f,{mode:'create',operation:'advance'})).code,'decision_required');return f;}
async function reviewed(t,host='session-B'){
  const f=await created(t);f.before=f.records().map(row=>JSON.stringify(row));
  assert.equal(ok(await launch(f,{host,original:'session-A',operation:'advance',review:true})).state,'fixture_completed');return f;
}

test('CLI cross-session resume preserves same-session stage and requires original flag',async t=>{
  const f=await created(t),before=f.records();
  const same=ok(await launch(f)),cross=ok(await launch(f,{host:'session-B',original:'session-A'}));
  assert.deepEqual(cross,same);assert.deepEqual(f.records(),before);
  const wrong=await launch(f,{host:'session-B'});assert.equal(wrong.code,1);assert.match(wrong.stderr,/fingerprint_mismatch/);
  assert.deepEqual(ok(await launch(f,{original:'session-A'})),same);
});

test('original-host-context on create fails before opening store, including equal ids',async t=>{
  for(const original of ['session-A','session-B']){
    const f=fixture(t),run=await launch(f,{mode:'create',original});
    assert.equal(run.code,1);assert.match(run.stderr,/original_host_context_unavailable/);
    assert(!fs.existsSync(path.join(f.specsDir,'.reviews')));
  }
});

test('A creates, B signs review, C declaring only A replays the completed run',async t=>{
  const f=await reviewed(t),before=f.records();
  for(const host of ['session-C','session-B','session-A']){
    assert.equal(ok(await launch(f,{host,original:'session-A'})).state,'fixture_completed');
    assert.deepEqual(f.records(),before);
  }
});

test('joining host is journaled once immediately before its grant; old records keep exact bytes',async t=>{
  const f=await reviewed(t),rows=f.records(),joins=rows.filter(r=>r.payload.type==='host-joined');
  assert.equal(joins.length,1);assert.equal(joins[0].kind,'result');
  assert.deepEqual(joins[0].payload,{version:3,protocol:'cm-task-runner',type:'host-joined',hostContextId:'session-B'});
  const index=rows.indexOf(joins[0]);assert.equal(rows[index+1].payload.type,'review-invocation-registered');
  assert.equal(rows[index+1].payload.grant.hostContextId,'session-B');
  assert.deepEqual(rows.slice(0,f.before.length).map(row=>JSON.stringify(row)),f.before);
  for(const host of ['session-B','session-C'])ok(await launch(f,{host,original:'session-A'}));
  assert.deepEqual(f.records(),rows);
});

test('durable session signing adds no joined record',async t=>{
  const f=await reviewed(t,'session-A');assert(!f.records().some(r=>r.payload.type==='host-joined'));
});

test('a recorded reviewer thread cannot reopen as live host',async t=>{
  const f=await reviewed(t,'session-A'),before=f.records();
  const host=before.find(r=>r.payload.type==='review-invocation-started').payload.providerThreadId;
  const result=await launch(f,{host,original:'session-A'});assert.equal(result.code,1);assert.match(result.stderr,/not_independent/);
  assert.deepEqual(f.records(),before);
});

test('conversation factory keeps durable metadata but live author identity and authority',async t=>{
  const f=fixture(t),bridge={async call(){return {status:'failed',code:'synthetic'};}};
  const a=createConversationExecution(f.definition,'session-A',bridge,f.review);
  const b=createConversationExecution(f.definition,'session-B',bridge,f.review,null,null,false,'codex',{originalHostContextId:'session-A'});
  assert.deepEqual(b.configuration,a.configuration);assert.deepEqual(b.excludedContexts,a.excludedContexts);
  assert.deepEqual(b.reviewInvocation.excludedThreadIds,a.reviewInvocation.excludedThreadIds);
  assert.equal(b.reviewInvocation.hostContextId,'session-B');
  for(const host of ['cm-conversation-author','cm-conversation-review-1']){
    assert.throws(()=>createConversationExecution(f.definition,host,bridge,null,null,null,false,'codex',{originalHostContextId:'session-A'}),{code:'not_independent'});
    assert.throws(()=>createConversationExecution(f.definition,'session-B',bridge,null,null,null,false,'codex',{originalHostContextId:host}),{code:'not_independent'});
  }
});

// Rehash synthetic grammar vectors, never edit an actual run or manufacture a grant.
function chain(rows){let previousDigest=null;return rows.map((row,index)=>{
  const body={version:1,seq:index+1,id:`runner.${String(index+1).padStart(6,'0')}`,kind:row.kind,payload:row.payload,previousDigest};
  const record={...body,digest:digest(body)};previousDigest=record.digest;return record;
});}
test('V3 joined-host grammar rejects misplaced, duplicate, durable and extra records',async t=>{
  const f=await reviewed(t),rows=f.records(),config=rows[0].payload.config;
  const at=rows.findIndex(r=>r.payload.type==='host-joined'),join=rows[at];assert(at>0);
  const read=items=>readRunnerHistory(chain(items),config,3);
  const prefix=rows.slice(0,at);
  assert.deepEqual(runnerStatus(read(prefix).state,config),runnerStatus(read([...prefix,join]).state,config));
  assert.throws(()=>read([rows[0],join]),{code:'runner_invocation'});
  assert.throws(()=>read([...prefix,join,join]),{code:'runner_invocation'});
  assert.throws(()=>read([...prefix,{...join,payload:{...join.payload,hostContextId:'session-A'}}]),{code:'runner_invocation'});
  assert.throws(()=>read([...prefix,{...join,payload:{...join.payload,extra:true}}]),{code:'invalid_input'});
  assert.throws(()=>read([...rows.slice(0,at+2),{...join,payload:{...join.payload,hostContextId:'session-C'}}]),{code:'runner_invocation'});

});

test('V3 joined-host grammar rejects an earlier reviewer joining before a later review registration',async t=>{
  const f=await created(t);reviewerResult(f,{thread:'earlier-reviewer',changes:true});
  const revised=ok(await launch(f,{host:'session-B',original:'session-A',operation:'advance',review:true}));
  assert.equal(revised.state,'awaiting_review');assert.equal(revised.code,'decision_required');
  const rows=f.records(),config=rows[0].payload.config;
  const reviewerThread=rows.find(r=>r.payload.type==='review-invocation-started').payload.providerThreadId;
  const firstIntent=rows.find(r=>r.payload.type==='effect-intent'&&r.payload.effect.kind==='review');
  const join=rows.find(r=>r.payload.type==='host-joined');
  // Only synthetic copies enter chain(): the on-disk run remains untouched.
  const prefix=[...rows,{...firstIntent,payload:{...firstIntent.payload,effect:{...firstIntent.payload.effect,
    id:'synthetic-review-2',identity:{...identity,attempt:2}}}}];
  const read=hostContextId=>readRunnerHistory(chain([...prefix,{...join,payload:{...join.payload,hostContextId}}]),config,3);
  // An independent host at the same location is legal, so the failing vector
  // reaches reviewer independence rather than ordering, identity or chain checks.
  const legal=read('independent-new-host');
  assert.equal(legal.pending.kind,'review');assert.equal(legal.pending.identity.attempt,2);
  assert.equal(legal.joinedHosts.at(-1),'independent-new-host');
  assert.throws(()=>read(reviewerThread),{code:'not_independent'});
  assert.deepEqual(f.records(),rows);
});


test('development after cross-session reopen reports live provider thread without changing init',async t=>{
  const f=fixture(t);ok(await launch(f,{mode:'create'}));const before=f.records();
  assert.equal(ok(await launch(f,{host:'session-B',original:'session-A',operation:'advance'})).code,'decision_required');
  const rows=f.records();assert.deepEqual(rows.slice(0,before.length),before);
  assert.deepEqual(rows[0].payload.config.reviewInvocation,{developerThreadId:'cm-conversation-author',excludedThreadIds:['session-A']});
  const call=rows.filter(r=>r.payload.type==='effect-checkpoint').at(-1).payload.checkpoint.calls[0];
  assert.equal(call.providerThreadId,'session-B');assert(!rows.some(r=>r.payload.type==='host-joined'));
});

function reviewerResult(f,{thread,changes=false}){
  let source=fs.readFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),'utf8');
  if(thread)source=source.replace('thread_id:randomUUID()',`thread_id:${JSON.stringify(thread)}`);
  if(changes)source=source.replace("verdict:'approved'","verdict:'changes_requested'")
    .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Synthetic revision',evidence:'Fixture evidence'}]");
  fs.writeFileSync(f.fake,source);
}
for(const thread of ['session-A','session-B'])test(`live reviewer cannot be durable or live host: ${thread}`,async t=>{
  const f=await created(t);reviewerResult(f,{thread});
  const result=ok(await launch(f,{host:'session-B',original:'session-A',operation:'advance',review:true}));
  assert.equal(result.state,'unknown');
  assert(!f.records().some(r=>r.payload.type==='review-invocation-started'));
  // Invalid observations also remain replayable from a third session.
  assert.equal(ok(await launch(f,{host:'session-C',original:'session-A'})).state,'unknown');
});

test('second review excludes earlier joined host even when the current host is C',async t=>{
  const f=await created(t);reviewerResult(f,{changes:true});
  const revised=ok(await launch(f,{host:'session-B',original:'session-A',operation:'advance',review:true}));
  // advance also develops attempt 2, then waits for its separate review grant.
  assert.equal(revised.state,'awaiting_review');assert.equal(revised.code,'decision_required');
  reviewerResult(f,{thread:'session-B'});
  const result=ok(await launch(f,{host:'session-C',original:'session-A',operation:'advance',review:2}));
  assert.equal(result.state,'unknown');
  const rows=f.records();assert.equal(rows.filter(r=>r.payload.type==='review-invocation-started').length,1);
  assert.deepEqual(rows.filter(r=>r.payload.type==='host-joined').map(r=>r.payload.hostContextId),['session-B','session-C']);
  assert.equal(ok(await launch(f,{host:'session-D',original:'session-A'})).state,'unknown');
});


// Exercise the grant/history defect independently of the new CLI flag. Assemble
// the durable and live factory outputs at the trusted host boundary: old code
// can open B with these unchanged bytes, but rejects B's grant as unauthorized.
test('runner session chain without CLI reaches B grant and replays it in C',async t=>{
  const f=fixture(t);
  const bridge={async call(kind){
    if(kind==='develop'){
      fs.writeFileSync(path.join(f.codeProject,'target.mjs'),'export const value = 42;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
        retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
    }
    assert.equal(kind,'check');
    return [{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'Synthetic runner fixture'}];
  }};
  const durable=createConversationExecution(f.definition,'session-A',bridge,f.review);
  const execution=(host,allow=false)=>{
    const live=createConversationExecution(f.definition,host,bridge,f.review,allow?1:null);
    return {...live,configuration:durable.configuration,excludedContexts:durable.excludedContexts,
      reviewInvocation:{...live.reviewInvocation,excludedThreadIds:durable.reviewInvocation.excludedThreadIds},
      reviewers:live.reviewers.map(reviewer=>({...reviewer,run(request,{onEvent}){
        for(const event of [{event:'thread.started',provider_thread:'synthetic-reviewer'},
          {event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
          {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
        return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic runner fixture'}};
      }}))};
  };
  async function session(host,mode,operation,allow=false){
    const run=await openControlRun(f.definition,mode,execution(host,allow));
    try{return await run.host.handle({version:1,operation,requestId:operation,identity});}finally{run.close();}
  }
  assert.equal((await session('session-A','create','advance')).code,'decision_required');
  const reviewed=await session('session-B','resume','advance',true);
  assert.equal(reviewed.state,'fixture_completed',JSON.stringify(reviewed));
  assert.equal((await session('session-C','resume','status')).state,'fixture_completed');
});
