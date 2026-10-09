import test from 'node:test';
import assert from 'node:assert/strict';
import {createClaudeReviewStream} from '../runtime/js/cm-ai/claude-review-stream.mjs';
import {reviewerBoundaryExit,abandonableReviewerExit,REVIEWER_REJECTION_CHECKS} from '../runtime/js/cm-ai/provider-review-observation.mjs';

// Claude CLI 2.1.x injects user-role reminders of its own (isSynthetic: true):
// e.g. "[structured-output-enforce] You MUST call the StructuredOutput tool"
// after a text-only answer, or "[Your previous response had no visible
// output…]" after a thinking-only one. The model cannot author user messages.
// They carry no verdict and run nothing, so the decoder counts them as notices
// and ignores their body instead of killing the reviewer (the T-009 incident).
const init=()=>({type:'system',subtype:'init',session_id:'fresh-review'});
const assistant=content=>({type:'assistant',session_id:'fresh-review',parent_tool_use_id:null,message:{role:'assistant',content}});
const text=t=>({type:'text',text:t});
const tool=(id,name='StructuredOutput')=>({type:'tool_use',id,name,input:{}});
const toolResult=(id,is_error=false)=>({type:'user',session_id:'fresh-review',parent_tool_use_id:null,
  message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error,content:'synthetic result'}]}});
const synthetic=(body='[structured-output-enforce] You MUST call the StructuredOutput tool to provide your final answer.',over={})=>({
  type:'user',session_id:'fresh-review',parent_tool_use_id:null,isSynthetic:true,
  message:{role:'user',content:[text(body)]},...over});
const result=(over={})=>({type:'result',subtype:'success',session_id:'fresh-review',is_error:false,num_turns:2,
  structured_output:{verdict:'approved'},...over});
function run(messages){
  const events=[],notices=[],stream=createClaudeReviewStream(e=>events.push(e),n=>notices.push(n));
  messages.forEach(m=>stream.accept(m));
  return {value:stream.finish(),events,notices};
}
function rejected(messages){
  const stream=createClaudeReviewStream(()=>{});
  try{messages.forEach(m=>stream.accept(m));}catch(error){return error;}
  assert.fail('expected a rejection');
}
const OBSERVER=[{event:'thread.started',provider_thread:'fresh-review'},{event:'turn.started',item_type:null},
  {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null}];

test('a CLI reminder after text, after thinking only, or before any output is a notice; the verdict still comes from StructuredOutput',()=>{
  const tail=[assistant([tool('out')]),toolResult('out'),result()];
  const wires={
    afterText:[init(),assistant([{type:'thinking',thinking:'private'}]),assistant([text('Review follows.')]),synthetic(),...tail],
    afterThinking:[init(),assistant([{type:'thinking',thinking:'private'}]),synthetic('[Your previous response had no visible output. Please respond with text or tool calls.]'),...tail],
    beforeOutput:[init(),synthetic(),...tail],
    twice:[init(),assistant([text('a')]),synthetic(),assistant([text('b')]),synthetic('The previous response failed to produce a valid tool call. Try again.'),...tail],
  };
  for(const [name,wire] of Object.entries(wires)){
    const {value,events,notices}=run(wire);
    assert.deepEqual(value,{status:'succeeded',value:{verdict:'approved'}},name);
    assert.deepEqual(events,OBSERVER,name);
    assert.ok(notices.length>=1&&notices.every(n=>n.kind==='claude_system_notice'&&n.subtype==='synthetic_user'&&!('text' in n)),name);
  }
});

test('a reminder never becomes a verdict: text in result after a reminder is invalid_output_json',()=>{
  const error=rejected([init(),assistant([text('Review follows.')]),synthetic(),assistant([text('{"verdict":"approved"}')]),
    {...result({num_turns:2}),structured_output:undefined,result:'{"verdict":"approved"}'}]);
  assert.equal(error.code,'invalid_output_json');
});

test('synthetic messages are narrowly admitted: shape, size, pending tools and the 32 notice slots',()=>{
  const big='x'.repeat(1025);
  for(const [name,message] of Object.entries({
    twoBlocks:synthetic('a',{message:{role:'user',content:[text('a'),text('b')]}}),
    notText:synthetic('a',{message:{role:'user',content:[{type:'image'}]}}),
    tooLong:synthetic(big),
    childAgent:synthetic('a',{parent_tool_use_id:'child'}),
    wrongRole:synthetic('a',{message:{role:'assistant',content:[text('a')]}}),
    noText:synthetic('a',{message:{role:'user',content:[{type:'text'}]}}),
  })){
    const error=rejected([init(),assistant([text('a')]),message]);
    assert.equal(error.code,'unexpected_tool_or_content',name);
    assert.deepEqual(error.detail,{k:'user_content',m:'user',b:name==='notText'?'image':name==='twoBlocks'||name==='tooLong'||name==='childAgent'||name==='wrongRole'||name==='noText'?'text':null,t:null,e:null},name);
  }
  // Nothing may be injected between a tool call and its result.
  const pending=rejected([init(),assistant([tool('out')]),synthetic()]);
  assert.equal(pending.code,'unexpected_tool_or_content');assert.equal(pending.detail.k,'user_content');
  // A user text that the CLI did not mark synthetic is still a boundary break.
  const unmarked=rejected([init(),assistant([text('a')]),synthetic('a',{isSynthetic:undefined})]);
  assert.equal(unmarked.code,'unexpected_tool_or_content');assert.equal(unmarked.detail.k,'user_content');
  // Notice slots are shared with rate limit and system notices.
  const many=[init(),assistant([text('a')])];for(let i=0;i<32;i++)many.push(synthetic());
  assert.equal(run([...many,assistant([tool('out')]),toolResult('out'),result()]).value.status,'succeeded');
  assert.equal(rejected([...many,synthetic()]).code,'unexpected_event');
});

test('every rejection point reports a fixed, body-free summary',()=>{
  const cases=[
    [[init(),assistant([])],{k:'empty_content',m:'assistant',b:null,t:null,e:null}],
    [[init(),assistant([{type:'image'}])],{k:'block_type',m:'assistant',b:'image',t:null,e:null}],
    [[init(),assistant([{type:'tool_use',name:'Bash'}])],{k:'block_type',m:'assistant',b:'tool_use',t:'Bash',e:null}],
    [[init(),assistant([tool('a'),tool('a','Bash')])],{k:'duplicate_tool_id',m:'assistant',b:'tool_use',t:'Bash',e:null}],
    [[init(),{...toolResult('a'),message:{role:'user',content:[]}}],{k:'user_content',m:'user',b:null,t:null,e:null}],
    [[init(),{...toolResult('a'),message:{role:'user',content:[text('tool succeeded')]}}],{k:'user_content',m:'user',b:'text',t:null,e:null}],
    [[init(),toolResult('missing',true)],{k:'unknown_tool_result',m:'user',b:'tool_result',t:null,e:null}],
    [[init(),assistant([tool('b','Bash')]),toolResult('b',false)],{k:'tool_result_not_error',m:'user',b:'tool_result',t:'Bash',e:false}],
    [[init(),assistant([tool('b','Read')]),{...toolResult('b'),message:{role:'user',content:[{type:'tool_result',tool_use_id:'b',content:'x'}]}}],
      {k:'tool_result_not_error',m:'user',b:'tool_result',t:'Read',e:null}],
  ];
  for(const [wire,detail] of cases){
    const error=rejected(wire);
    assert.equal(error.code,'unexpected_tool_or_content');assert.deepEqual(error.detail,detail,JSON.stringify(detail));
    assert.ok(!JSON.stringify(error.detail).includes('synthetic result'));
  }
  const limit=[init()];for(let i=0;i<17;i++)limit.push(assistant([tool(`d${i}`,'Bash')]),toolResult(`d${i}`,true));
  assert.deepEqual(rejected(limit).detail,{k:'tool_attempt_limit',m:'assistant',b:'tool_use',t:'Bash',e:null});
  // Hostile tool names and block types never reach the summary.
  const hostile=rejected([init(),assistant([tool('h','Bash; rm -rf / '+'x'.repeat(80))]),toolResult('h',false)]);
  assert.deepEqual(hostile.detail,{k:'tool_result_not_error',m:'user',b:'tool_result',t:null,e:false});
  assert.deepEqual(rejected([init(),assistant([{type:'weird type!'}])]).detail,{k:'block_type',m:'assistant',b:null,t:null,e:null});
});

// The worker appends the summary to the base code; the observation reader
// parses it strictly and decides whether the operator may abandon the exit.
test('boundary exit codes parse strictly; only exits that cannot have run a tool, with the process closed and nothing received, are abandonable',()=>{
  const suffix=d=>`unexpected_tool_or_content:${JSON.stringify(d)}`;
  assert.deepEqual(reviewerBoundaryExit('unexpected_tool_or_content'),{check:null,message:null,block:null,tool:null,isError:null});
  assert.deepEqual(reviewerBoundaryExit(suffix({k:'user_content',m:'user',b:'text',t:null,e:null})),{check:'user_content',message:'user',block:'text',tool:null,isError:null});
  for(const bad of [null,'','timeout','unexpected_assistant','unexpected_tool_or_content:',
    'unexpected_tool_or_content:{}',suffix({k:'bogus',m:'user',b:null,t:null,e:null}),suffix({k:'user_content',m:'system',b:null,t:null,e:null}),
    suffix({k:'user_content',m:'user',b:'bad type',t:null,e:null}),suffix({k:'user_content',m:'user',b:null,t:'rm -rf',e:null}),
    suffix({k:'user_content',m:'user',b:null,t:null,e:'true'}),suffix({k:'user_content',m:'user',b:null,t:null,e:null,x:1}),
    suffix({k:'user_content',m:'user',b:null,t:null}),'unexpected_tool_or_content:[]','unexpected_tool_or_content:'+'{"k":"user_content","m":"user","b":null,"t":null,"e":null,"pad":"'+'x'.repeat(300)+'"}'])
    assert.equal(reviewerBoundaryExit(bad),null,String(bad).slice(0,60));
  assert.deepEqual(REVIEWER_REJECTION_CHECKS,['empty_content','block_type','tool_attempt_limit','duplicate_tool_id','user_content','unknown_tool_result','tool_result_not_error']);
  const closed={event:'process_closed',exit_code:null,signal:'SIGKILL',timed_out:false};
  const started=[{event:'thread.started',provider_thread:'t'},{event:'turn.started',item_type:null}];
  const observation=(code,events=[...started,closed],status='failed')=>({version:1,kind:'cm-provider-review-observation',requestDigest:'0'.repeat(64),events,result:{status,code}});
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content')),true,'legacy code without summary');
  for(const k of ['user_content','empty_content','tool_attempt_limit'])
    assert.equal(abandonableReviewerExit(observation(suffix({k,m:'user',b:null,t:null,e:null}))),true,k);
  for(const k of ['tool_result_not_error','unknown_tool_result','duplicate_tool_id','block_type'])
    assert.equal(abandonableReviewerExit(observation(suffix({k,m:'user',b:null,t:null,e:null}))),false,k);
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[...started])),false,'no process_closed');
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[...started,{...closed,timed_out:true}])),false,'timed out');
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[...started,{event:'item.completed',item_type:'agent_message'},closed])),false,'final message received');
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[...started,{event:'turn.failed',item_type:null},closed])),false,'terminal observed');
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[...started,closed],'cancelled')),false,'not failed');
  assert.equal(abandonableReviewerExit(observation('output_limit')),false,'other code');
  assert.equal(abandonableReviewerExit(observation('unexpected_tool_or_content',[{event:'bogus'}])),false,'invalid stream');
  assert.equal(abandonableReviewerExit(null),false);
});

test('the 1024-byte limit is measured in UTF-8 bytes; synthetic, rate limit and system notices share the 32 slots',()=>{
  const tail=[assistant([tool('out')]),toolResult('out'),result()];
  const cjk='审'.repeat(341)+'x'; // 341*3+1 = 1024 bytes
  assert.equal(run([init(),assistant([text('a')]),synthetic(cjk),...tail]).value.status,'succeeded');
  assert.equal(rejected([init(),assistant([text('a')]),synthetic('审'.repeat(342))]).detail.k,'user_content'); // 1026 bytes
  assert.equal(run([init(),assistant([text('a')]),synthetic('x'.repeat(1024)),...tail]).value.status,'succeeded');
  const rateLimit=()=>({type:'rate_limit_event',session_id:'fresh-review',rate_limit_info:{status:'allowed'}});
  const system=()=>({type:'system',subtype:'api_retry',session_id:'fresh-review',attempt:1});
  const mixed=[init(),assistant([text('a')])];
  for(let i=0;i<32;i++)mixed.push(i%3===0?synthetic():i%3===1?rateLimit():system());
  const ok=run([...mixed,...tail]);
  assert.equal(ok.value.status,'succeeded');assert.equal(ok.notices.length,32);
  assert.equal(rejected([...mixed,synthetic()]).code,'unexpected_event');
  assert.equal(rejected([...mixed,rateLimit()]).code,'unexpected_event');
});
