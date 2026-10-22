import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createClaudeReviewStream} from '../runtime/js/cm-ai/claude-review-stream.mjs';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {createReviewVerificationSession} from '../runtime/js/cm-fix/review-verification.mjs';

const session_id='diagnostic-fixture';
const init={type:'system',subtype:'init',session_id};
const assistant={type:'assistant',session_id,parent_tool_use_id:null,
  message:{role:'assistant',content:[{type:'text',text:'synthetic review'}]}};
const success={type:'result',subtype:'success',session_id,is_error:false,num_turns:1,structured_output:{verdict:'approved'}};
const api=(error='invalid_request',text='API Error',extra={})=>({...assistant,error,
  message:{role:'assistant',content:[{type:'text',text}]},...extra});
function failure(message,prefix=[init],allowedTools=[]){
  const events=[],stream=createClaudeReviewStream(event=>events.push(event),null,allowedTools);
  prefix.forEach(value=>stream.accept(value));
  let caught;try{stream.accept(message);}catch(error){caught=error;}
  assert.ok(caught);assert.throws(()=>stream.finish(),{code:'incomplete_result'});
  return {error:caught,events};
}
const privateText='PRIVATE-BODY-SENTINEL sk-private-credential https://private.invalid/secret /private/secret';
test('API diagnostics preserve failure classes and expose only fixed categories, status and bounded token limits',()=>{
  for(const [kind,code] of [['authentication_failed','reviewer_auth_failed'],['billing_error','reviewer_billing_error'],
    ['rate_limit','reviewer_rate_limited'],['server_error','reviewer_server_error'],['model_not_found','reviewer_model_not_found'],
    ...['invalid_request','invalid_request_error','api_error','overloaded_error','context_window_exceeded','unknown'].map(kind=>[kind,'reviewer_api_error'])]){
    const text='API Error: 400 '+JSON.stringify({type:'error',error:{type:'invalid_request_error',
      message:'prompt is too long: 210123 tokens > 200000 maximum '+privateText},request_id:privateText});
    const {error,events}=failure(api(kind,text));
    assert.equal(error.code,code);
    assert.deepEqual(error.failureDetail,{version:1,check:'api_error',stage:'assistant',eventType:'assistant',eventTypeLength:9,
      eventSubtype:'absent',eventSubtypeLength:0,noticeCount:0,thinkingCount:0,progressCount:0,apiErrorClass:kind,apiErrorClassLength:kind.length,
      providerErrorClass:'invalid_request_error',httpStatus:400,errorFlags:['prompt_too_long'],tokenBudget:{inputTokens:210123,maximumTokens:200000}});
    assert.deepEqual(events.map(value=>value.event),['thread.started','turn.started']);
    assert(!JSON.stringify(error.failureDetail).includes('PRIVATE'));
    assert(Buffer.byteLength(JSON.stringify(error.failureDetail))<1024);
  }
});
test('unknown or malformed provider fields and oversized API bodies never enter diagnostics',()=>{
  for(const text of [privateText,'API Error: 400 '+JSON.stringify({error:{type:privateText,message:privateText}}),
    'API Error: 400 '+privateText.repeat(200),
    'API Error: 400 '+JSON.stringify({error:{type:'api_error',message:'prompt is too long: 1234567890 tokens > 200000 maximum'}})]){
    const {error}=failure(api(privateText,text,{subtype:privateText,status_code:'401',error_status:999,api_error_status:99}));
    assert.equal(error.code,'reviewer_api_error');assert.equal(error.failureDetail.apiErrorClass,'other');
    assert.equal(error.failureDetail.eventSubtype,'other');assert.equal(error.failureDetail.tokenBudget,null);
    assert.equal(error.failureDetail.httpStatus,text.startsWith('API Error: 400 ')?400:null);
    assert(!JSON.stringify(error.failureDetail).includes('PRIVATE'));
    assert(!JSON.stringify(error.failureDetail).includes('https:'));
    assert(!JSON.stringify(error.failureDetail).includes('/private/'));
  }
  const explicit=failure(api('unknown','context_length_exceeded '+privateText,{api_error_status:413})).error.failureDetail;
  assert.equal(explicit.httpStatus,413);assert.deepEqual(explicit.errorFlags,['context_length_exceeded']);
  const huge=failure({type:privateText.repeat(15000),subtype:privateText.repeat(15000),session_id}).error.failureDetail;
  assert.equal(huge.eventType,'other');assert.equal(huge.eventSubtype,'other');
  assert.equal(huge.eventTypeLength,1_000_001);assert.equal(huge.eventSubtypeLength,1_000_001);
  assert(Buffer.byteLength(JSON.stringify(huge))<1024);
});
test('locally known but unsupported protocol enums are diagnosed without accepting them',()=>{
  for(const subtype of ['compact_boundary','status','task_started','task_progress','task_notification',
    'files_persisted','hook_progress','local_command_output']){
    const {error}=failure({type:'system',subtype,session_id,body:privateText});
    assert.equal(error.code,'unexpected_event');assert.equal(error.failureDetail.check,'unknown_system_subtype');
    assert.equal(error.failureDetail.eventType,'system');assert.equal(error.failureDetail.eventSubtype,subtype);
  }
  for(const type of ['auth_status','keep_alive','stream_event','tool_use_summary']){
    const {error}=failure({type,session_id,body:privateText});
    assert.equal(error.code,'unexpected_event');assert.equal(error.failureDetail.check,'unknown_message_type');
    assert.equal(error.failureDetail.eventType,type);
  }
});
test('unexpected_event distinguishes exact existing notice, thinking and terminal boundaries',()=>{
  const notice={type:'system',subtype:'api_retry',session_id};
  const heartbeat={type:'system',subtype:'thinking_tokens',session_id};
  for(const [message,prefix,check,count] of [
    [notice,[init,...Array(32).fill(notice)],'notice_limit',32],
    [heartbeat,[init,...Array(4096).fill(heartbeat)],'thinking_limit',4096],
    [notice,[init,assistant,success],'terminal_stage',0],
  ]){
    const {error}=failure(message,prefix);assert.equal(error.code,'unexpected_event');assert.equal(error.failureDetail.check,check);
    if(check==='notice_limit')assert.equal(error.failureDetail.noticeCount,count);
    if(check==='thinking_limit')assert.equal(error.failureDetail.thinkingCount,count);
    if(check==='terminal_stage')assert.equal(error.failureDetail.stage,'done');
  }
});

async function run(wire,onDiagnostic){
  const config={cwd:'/tmp',model:'diagnostic-fixture',cli:'never-execute-provider'};
  const events=[],kills=[],terminals=[];
  const worker=claudeWorker({...config,onDiagnostic,timeoutMs:5000,
    preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(config)},
    killProcess:(pid,signal)=>kills.push({pid,signal}),
    spawnProcess:()=>{
      const child=new EventEmitter();
      // No PID: owned-process cleanup cannot reach a real process.
      child.kill=()=>true;
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin.resume();
      child.stdin.once('finish',()=>queueMicrotask(()=>{
        child.stderr.end(privateText);
        child.stdout.end(wire.map(JSON.stringify).join('\n')+'\n');
        child.emit('close',wire.at(-1)===success?0:null,wire.at(-1)===success?null:'SIGKILL');
      }));return child;
    }});
  const result=await worker({prompt:'synthetic-only'},{signal:new AbortController().signal,onEvent:event=>events.push(event),onTerminal:value=>terminals.push(value)});
  return {result,events,kills:kills.map(value=>value.signal),terminals};
}
test('worker diagnostic sidecar preserves strict receipts, cleanup signals and first failure',async()=>{
  const wire=[init,api('invalid_request','API Error: 400 '+JSON.stringify({error:{type:'invalid_request_error',message:'prompt_too_long '+privateText}})),
    {type:'system',subtype:'status',session_id}];
  const rows=[];
  const [baseline,withDiagnostic,throwing]=await Promise.all([run(wire),run(wire,row=>rows.push(row)),
    run(wire,()=>{throw Error(privateText);})]);
  assert.deepEqual(withDiagnostic,baseline);assert.deepEqual(throwing,baseline);
  assert.deepEqual(baseline.result,{status:'failed',code:'reviewer_api_error'});
  assert.deepEqual(baseline.events.map(value=>value.event),['thread.started','turn.started','process_closed']);
  assert.equal(baseline.events.at(-1).signal,'SIGKILL');assert.equal(baseline.events.at(-1).timed_out,false);
  assert.deepEqual(baseline.kills,['SIGTERM','SIGKILL']);assert.deepEqual(baseline.terminals,[]);
  assert.equal(rows.length,1);assert.equal(rows[0].code,'reviewer_api_error');
  assert.equal(rows[0].failureDetail.providerErrorClass,'invalid_request_error');
  assert(!JSON.stringify(rows).includes('PRIVATE'));assert.deepEqual(Object.keys(baseline.result),['status','code']);
});
test('worker exposes unsupported subtype, reports no success diagnostic and cannot accept a diagnostic verdict',async()=>{
  const rows=[];
  const actual=await run([init,{type:'system',subtype:'status',session_id}],row=>{rows.push(row);return {status:'succeeded',value:{verdict:'approved'}};});
  assert.deepEqual(actual.result,{status:'failed',code:'unexpected_event'});
  assert.equal(rows.length,1);assert.equal(rows[0].failureDetail.eventSubtype,'status');assert.deepEqual(actual.terminals,[]);
  const successRows=[],passed=await run([init,assistant,success],row=>successRows.push(row));
  assert.deepEqual(passed.result,{status:'succeeded',value:{verdict:'approved'}});assert.deepEqual(successRows,[]);
  assert.deepEqual(passed.kills,[]);
});

const reviewTools=['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__mutate_check'];
const toolCall=(name=reviewTools[1],id='pending-tool')=>({...assistant,
  message:{role:'assistant',content:[{type:'tool_use',id,name,input:{id:'long'}}]}});
const toolResult=(id='pending-tool')=>({type:'user',session_id,
  message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:false,content:'synthetic result'}]}});
const progress=(extra={})=>({type:'tool_progress',session_id,tool_use_id:'pending-tool',
  tool_name:reviewTools[1],parent_tool_use_id:null,elapsed_time_seconds:1,...extra});
test('progress is bound to an allowed pending tool and never emits review events or clears its result',()=>{
  for(const name of [...reviewTools,'StructuredOutput']){
    const events=[],notices=[],stream=createClaudeReviewStream(event=>events.push(event),value=>notices.push(value),reviewTools);
    stream.accept(init);stream.accept(toolCall(name));
    for(const elapsed of [0,1,10])stream.accept(progress({tool_name:name,elapsed_time_seconds:elapsed,payload:privateText}));
    assert.deepEqual(events.map(value=>value.event),['thread.started','turn.started']);assert.deepEqual(notices,[]);
    stream.accept(toolResult());stream.accept(success);assert.deepEqual(stream.finish(),{status:'succeeded',value:{verdict:'approved'}});
  }
  const {error}=failure(success,[init,toolCall(),progress()],reviewTools);
  assert.equal(error.code,'unexpected_result');assert.equal(error.failureDetail.progressCount,1);
  const stream=createClaudeReviewStream(()=>{},null,reviewTools);
  [init,toolCall(),progress()].forEach(value=>stream.accept(value));assert.throws(()=>stream.finish(),{code:'incomplete_result'});
});
test('progress rejects wrong sessions, missing calls, mismatched names, unapproved tools and invalid elapsed time',()=>{
  for(const [message,prefix,code,check] of [
    [progress({session_id:'different'}),[init,toolCall()],'session_mismatch','session_mismatch'],
    [progress({session_id:''}),[init,toolCall()],'invalid_session','invalid_session'],
    [progress(),[],'missing_init','missing_init'],
    [progress(),[init],'unexpected_event','tool_progress_stage'],
    [progress({tool_use_id:'unregistered'}),[init,toolCall()],'unexpected_event','tool_progress_identity'],
    [progress({tool_use_id:null}),[init,toolCall()],'unexpected_event','tool_progress_identity'],
    [progress({tool_name:reviewTools[0]}),[init,toolCall()],'unexpected_event','tool_progress_tool'],
    [progress({tool_name:'Bash'}),[init,toolCall('Bash')],'unexpected_event','tool_progress_tool'],
    [progress({parent_tool_use_id:'child'}),[init,toolCall()],'unexpected_event','tool_progress_parent'],
    [progress({parent_tool_use_id:undefined}),[init,toolCall()],'unexpected_event','tool_progress_parent'],
    [progress(),[init,toolCall(),toolResult()],'unexpected_event','tool_progress_identity'],
    [progress(),[init,toolCall(),toolResult(),success],'unexpected_event','terminal_stage'],
    ...[-1,0.5,Infinity,NaN,'1',null,Number.MAX_SAFE_INTEGER+1].map(elapsed_time_seconds=>[
      progress({elapsed_time_seconds}),[init,toolCall()],'unexpected_event','tool_progress_elapsed']),
  ]){
    const {error}=failure(message,prefix,reviewTools);assert.equal(error.code,code);assert.equal(error.failureDetail.check,check);
  }
  assert.equal(failure(progress(),[init,toolCall()]).error.failureDetail.check,'tool_progress_tool');
});
test('progress has a separate bounded budget while notices, thinking and pending tool rules stay intact',()=>{
  const prefix=[init,toolCall(),...Array(32).fill({type:'system',subtype:'api_retry',session_id}),
    ...Array(4096).fill({type:'system',subtype:'thinking_tokens',session_id}),...Array(4096).fill(progress())];
  const stream=createClaudeReviewStream(()=>{},null,reviewTools);prefix.forEach(value=>stream.accept(value));
  stream.accept(toolResult());stream.accept(success);assert.equal(stream.finish().status,'succeeded');
  const {error}=failure(progress(),prefix,reviewTools);assert.equal(error.code,'unexpected_event');
  assert.equal(error.failureDetail.check,'tool_progress_limit');assert.equal(error.failureDetail.progressCount,4096);
  assert.equal(error.failureDetail.noticeCount,32);assert.equal(error.failureDetail.thinkingCount,4096);
});
test('a real isolated MCP check remains pending across progress and finishes through its original tool result',
  {skip:process.platform!=='darwin',timeout:15000},async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'claude-progress-')));
  const source="import {value} from './value.mjs'; await new Promise(resolve=>setTimeout(resolve,300)); if(value!==1)process.exit(1);\n";
  fs.writeFileSync(path.join(root,'long.test.mjs'),source);
  fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;\n');
  const verification={files:['value.mjs','long.test.mjs'],checks:[{id:'long',command:[process.execPath,'long.test.mjs']}],mutationPaths:['value.mjs'],timeoutMs:5000};
  let session,server,closed,pendingReply;
  try{
    session=createReviewVerificationSession({codeProject:root,configuration:verification,
      request:{requestDigest:'a'.repeat(64),provider:'claude',payload:{reviewPackage:{packageDigest:'b'.repeat(64),files:[]}}}});
    const transport=JSON.parse(session.transport.mcpConfig).mcpServers.cm_review;
    server=spawn(transport.command,transport.args,{stdio:['pipe','pipe','pipe']});server.stderr.resume();
    closed=new Promise(resolve=>server.once('close',resolve));
    const reply=new Promise((resolve,reject)=>{pendingReply={resolve,reject};});
    createInterface({input:server.stdout}).on('line',line=>{
      try{const value=JSON.parse(line);if(value.id===1)pendingReply.resolve(value.result);}catch(error){pendingReply.reject(error);}
    });
    server.once('error',error=>pendingReply.reject(error));
    const events=[],diagnostics=[],config={cwd:root,model:'diagnostic-fixture',cli:'never-execute-provider',verification};
    let transportError=null;
    const worker=claudeWorker({...config,verificationTransport:session.transport,timeoutMs:10000,
      preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(config)},
      onDiagnostic:value=>diagnostics.push(value),killProcess:()=>{throw Error('unexpected fixture stop');},
      spawnProcess:()=>{
        const child=new EventEmitter();child.kill=()=>true;
        child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.resume();
        child.stdin.once('finish',()=>{void(async()=>{
          const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
          try{
            emit(init);emit(toolCall());
            server.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_check',arguments:{id:'long'}}})+'\n');
            let finished=false;void reply.then(()=>{finished=true;});
            for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,25));assert.equal(finished,false);emit(progress({elapsed_time_seconds:0}));}
            const value=await reply;assert.equal(value.isError,undefined);assert.equal(JSON.parse(value.content[0].text).exitCode,0);
            emit(toolResult());emit(success);child.stdout.end();child.emit('close',0,null);
          }catch(error){transportError=error;child.emit('close',1,null);}
        })();});return child;
      }});
    const result=await worker({prompt:'synthetic-only'},{signal:new AbortController().signal,onEvent:value=>events.push(value)});
    assert.equal(transportError,null);assert.deepEqual(result,{status:'succeeded',value:{verdict:'approved'}});
    assert.deepEqual(diagnostics,[]);assert.deepEqual(events.map(value=>value.event),['thread.started','turn.started','item.completed','turn.completed','process_closed']);
    assert.equal(fs.readFileSync(path.join(root,'long.test.mjs'),'utf8'),source);
  }finally{
    if(server){server.stdin.end();await closed;}
    await session?.close();fs.rmSync(root,{recursive:true,force:true});
  }
});
