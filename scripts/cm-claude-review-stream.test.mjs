import test from 'node:test';
import assert from 'node:assert/strict';
import {createClaudeReviewStream} from '../runtime/js/cm-ai/claude-review-stream.mjs';

const transcript = () => [
  {type:'system', subtype:'init', session_id:'fresh-review'},
  {type:'assistant', session_id:'fresh-review', parent_tool_use_id:null,
    message:{role:'assistant', content:[{type:'text', text:'Review follows.'}]}},
  {type:'result', subtype:'success', session_id:'fresh-review', is_error:false,
    num_turns:1, structured_output:{verdict:'approved'}},
];
test('Claude result maps to original observer syntax, never invents process close', () => {
  for (const structured of [true, false]) {
    const events=[], stream=createClaudeReviewStream(event=>events.push(event));
    const messages=transcript();
    if (!structured) { delete messages[2].structured_output; messages[2].result='{"verdict":"approved"}'; }
    messages.forEach(message=>stream.accept(message));
    assert.deepEqual(stream.finish(), {status:'succeeded',value:{verdict:'approved'}});
    assert.deepEqual(events,[
      {event:'thread.started',provider_thread:'fresh-review'},
      {event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},
      {event:'turn.completed',item_type:null},
    ]);
  }
});
test('wrong session, tools, child agents, errors, repeated or incomplete terminals fail closed', () => {
  const mutations=[
    m=>{m[1].session_id='other';},
    m=>{m[1].message.content=[{type:'tool_use',name:'Bash'}];},
    m=>{m[1].parent_tool_use_id='child';},
    m=>{m[2].is_error=true;},
    m=>{m[2].num_turns=21;},
    m=>{m[2].structured_output=null;},
    m=>{m.push(m[2]);},
    m=>{m.splice(1,1);},
    m=>{m.pop();},
    m=>{m.unshift(null);},
  ];
  for (const mutate of mutations) {
    const stream=createClaudeReviewStream(()=>{}), messages=transcript(); mutate(messages);
    assert.throws(()=>{messages.forEach(m=>stream.accept(m));stream.finish();});
    assert.throws(()=>stream.finish(), {code:'incomplete_result'});
  }
});

const thinkingTokens = () => ({type:'system',subtype:'thinking_tokens',session_id:'fresh-review',estimated_tokens:10});
const assistant = content => ({...transcript()[1],message:{role:'assistant',content}});
const tool = (id,name='StructuredOutput') => ({type:'tool_use',id,name,input:{}});
const toolResult = (id,is_error=false) => ({type:'user',session_id:'fresh-review',
  message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error,content:'synthetic result'}]}});
function decode(messages) {
  const stream=createClaudeReviewStream(()=>{});
  messages.forEach(m=>stream.accept(m));
  return stream.finish();
}
test('thinking and redacted thinking preserve stage before and after substantive output',()=>{
  const [init,text,result]=transcript();
  const thoughts=assistant([{type:'thinking',thinking:'private',signature:'sig'},{type:'redacted_thinking',data:'private'}]);
  assert.equal(decode([init,rateLimit(),thinkingTokens(),thinkingTokens(),thoughts,text,result]).status,'succeeded');
  assert.equal(decode([init,...Array.from({length:4096},thinkingTokens),
    assistant([...thoughts.message.content,...text.message.content]),thoughts,result]).status,'succeeded');
  assert.throws(()=>decode([init,thoughts,result]),{code:'unexpected_result'});
  assert.throws(()=>decode([init,...Array.from({length:4097},thinkingTokens),text,result]),{code:'unexpected_event'});
  for(const subtype of ['unknown','init'])assert.throws(()=>decode([init,{...thinkingTokens(),subtype}]),{code:'unexpected_event'});
  assert.throws(()=>decode([init,{...thinkingTokens(),session_id:'other'}]),{code:'session_mismatch'});
  assert.throws(()=>decode([thinkingTokens(),init]),{code:'missing_init'});
  assert.throws(()=>decode([init,text,result,thinkingTokens()]),{code:'unexpected_event'});
});
test('paired rejected tool attempts and CLI StructuredOutput permit multiple turns',()=>{
  const [init,text,result]=transcript();
  const calls=[];
  for(let i=0;i<16;i++)calls.push(assistant([tool(`denied-${i}`,i%2?'Bash':'Read')]),toolResult(`denied-${i}`,true));
  const wire=[init,text,...calls,assistant([{type:'thinking',thinking:'private'},tool('output')]),toolResult('output'),
    {...result,num_turns:20,result:'not JSON: structured_output takes precedence'}];
  assert.equal(decode(wire).status,'succeeded');
  assert.equal(decode([init,assistant([tool('bash','Bash')]),toolResult('bash',true),{...result,num_turns:2}]).status,'succeeded');
  assert.throws(()=>decode([init,...calls,assistant([tool('denied-17','Glob')])]),{code:'unexpected_tool_or_content'});
});
test('non-StructuredOutput success or ambiguous result fails immediately, including mixed tool batches',()=>{
  for(const name of ['Bash','bash','Read','Grep','Glob','LS','structuredoutput'])for(const flag of [false,undefined,null,'true']){
    const stream=createClaudeReviewStream(()=>{});
    stream.accept(transcript()[0]);stream.accept(assistant([tool('output'),tool('bad',name)]));
    stream.accept(toolResult('output'));
    const result=toolResult('bad',flag);
    if(flag===undefined)delete result.message.content[0].is_error;
    assert.throws(()=>stream.accept(result),{code:'unexpected_tool_or_content'});
    assert.throws(()=>stream.finish(),{code:'incomplete_result'});
  }
});
test('tool identities, result contents and unresolved calls fail closed',()=>{
  const [init,,result]=transcript();
  for(const extra of [
    [toolResult('missing',true)],
    [assistant([tool('a')]),toolResult('wrong')],
    [assistant([tool('a')]),toolResult('a'),toolResult('a')],
    [assistant([tool('a'),tool('a','Bash')])],
    [assistant([tool('a')]),toolResult('a'),assistant([tool('a','Bash')])],
    [assistant([{type:'image'}])],
    [assistant([null])],
    [{...toolResult('a'),message:{role:'user',content:[{type:'text',text:'tool succeeded'}]}}],
    [{...toolResult('a'),message:{role:'user',content:[]}}],
  ])assert.throws(()=>decode([init,...extra,result]),{code:'unexpected_tool_or_content'});
  assert.throws(()=>decode([init,assistant([tool('pending')]),result]),{code:'unexpected_result'});
  for(const num_turns of [0,-1,1.5,'2',21])assert.throws(()=>decode([...transcript().slice(0,2),{...result,num_turns}]),{code:'unexpected_result'});
  for(const structured_output of [null,[],true,'{}'])assert.throws(()=>decode([
    ...transcript().slice(0,2),{...result,structured_output,result:'{"verdict":"approved"}'},
  ]),{code:'invalid_output_json'});
});

const rateLimit = (overrides={}) => ({type:'rate_limit_event',session_id:'fresh-review',
  rate_limit_info:{status:'allowed',rateLimitType:'five_hour',resetsAt:123,active:true,reason:null,
    nested:{text:'private provider payload'},list:['private provider payload']},...overrides});
const expectedNotice = {kind:'rate_limit',info:{status:'allowed',rateLimitType:'five_hour',
  resetsAt:123,active:true,reason:null}};
test('rate limit notices preserve both output formats, stage and exact observer events',()=>{
  const baseline=[],original=createClaudeReviewStream(e=>baseline.push(e));
  transcript().forEach(m=>original.accept(m));
  for(const structured of [true,false])for(const count of [1,8,32]){
    const events=[],notices=[],stream=createClaudeReviewStream(e=>events.push(e),n=>notices.push(n));
    const messages=transcript();
    if(!structured){delete messages[2].structured_output;messages[2].result='{"verdict":"approved"}';}
    stream.accept(messages[0]);
    for(let i=0;i<count;i++){
      if(i===1)stream.accept(messages[1]);
      stream.accept(rateLimit());
    }
    if(count===1)stream.accept(messages[1]);
    stream.accept(messages[2]);
    assert.deepEqual(notices,Array.from({length:count},()=>expectedNotice));
    assert.deepEqual(stream.finish(),original.finish());assert.deepEqual(events,baseline);
  }
});
test('optional or throwing notice callbacks and non-object info do not affect results',()=>{
  for(const callback of [undefined,null,()=>{throw Error('notice consumer');}]){
    const stream=createClaudeReviewStream(()=>{},callback),messages=transcript();
    stream.accept(messages[0]);stream.accept(rateLimit());
    messages.slice(1).forEach(m=>stream.accept(m));assert.equal(stream.finish().status,'succeeded');
  }
  for(const info of [undefined,null,'raw text',['raw text'],{bad:Infinity,missing:undefined}]){
    const notices=[],stream=createClaudeReviewStream(()=>{},n=>notices.push(n));
    stream.accept(transcript()[0]);stream.accept(rateLimit({rate_limit_info:info}));
    assert.deepEqual(notices,[{kind:'rate_limit',info:{}}]);
  }
});
test('rate limit session, count, whitelist and terminal boundaries fail closed',()=>{
  for(const [extra,code,count] of [
    [[rateLimit({session_id:'other'})],'session_mismatch',0],
    [[rateLimit({session_id:''})],'invalid_session',0],
    [Array.from({length:33},()=>rateLimit()),'unexpected_event',32],
    [[rateLimit({type:'foo_event'})],'unexpected_event',0],
  ]){
    const notices=[],stream=createClaudeReviewStream(()=>{},n=>notices.push(n));
    stream.accept(transcript()[0]);
    assert.throws(()=>extra.forEach(m=>stream.accept(m)),{code});assert.equal(notices.length,count);
    assert.throws(()=>stream.finish(),{code:'incomplete_result'});
  }
  const before=createClaudeReviewStream(()=>{});
  assert.throws(()=>before.accept(rateLimit()),{code:'missing_init'});
  const after=createClaudeReviewStream(()=>{});
  transcript().forEach(m=>after.accept(m));
  assert.throws(()=>after.accept(rateLimit()),{code:'unexpected_event'});
  const noAssistant=createClaudeReviewStream(()=>{}),messages=transcript();
  noAssistant.accept(messages[0]);noAssistant.accept(rateLimit());
  assert.throws(()=>noAssistant.accept(messages[2]),{code:'unexpected_result'});
  const noCallback=createClaudeReviewStream(()=>{});
  noCallback.accept(messages[0]);
  for(let i=0;i<32;i++)noCallback.accept(rateLimit());
  assert.throws(()=>noCallback.accept(rateLimit()),{code:'unexpected_event'});
});

const systemNotice = (subtype='api_retry',extra={}) => ({type:'system',subtype,session_id:'fresh-review',...extra});
function observe(messages,callback) {
  const events=[],notices=[];
  const stream=createClaudeReviewStream(e=>events.push(e),callback ?? (n=>notices.push(n)));
  messages.forEach(m=>stream.accept(m));
  return {result:stream.finish(),events,notices};
}
test('88-heartbeat dogfood event counts preserve structured findings and exact observation',()=>{
  const [init,text,result]=transcript();
  const value={verdict:'changes_requested',packageDigest:'a'.repeat(64),examinedPaths:['code.mjs'],
    findings:Array.from({length:6},(_,i)=>({id:`F${i+1}`,severity:'P2',path:'code.mjs',
      message:'Synthetic finding',evidence:'Synthetic evidence'})),summary:'Synthetic six findings'};
  // Reconstruct the observed event counts, without private provider text.
  const wire=[init,...Array.from({length:44},thinkingTokens),rateLimit(),
    assistant([{type:'thinking',thinking:'synthetic',signature:'sig'}]),
    assistant([tool('denied','Read')]),toolResult('denied',true),
    ...Array.from({length:44},thinkingTokens),text,
    assistant([tool('output')]),toolResult('output'),rateLimit(),
    {...result,num_turns:4,structured_output:value,result:'structured output is authoritative'}];
  const actual=observe(wire);
  assert.deepEqual(actual.result,{status:'succeeded',value});
  assert.deepEqual(actual.events,observe(transcript()).events);
  assert.deepEqual(actual.notices,[expectedNotice,expectedNotice]);
});
test('thinking budget is cumulative across stages and cannot advance a verdict',()=>{
  const [init,text,result]=transcript();
  const half=Array.from({length:2048},thinkingTokens);
  const actual=observe([init,...half,text,...half,result]);
  assert.deepEqual(actual,observe(transcript()));
  assert.throws(()=>decode([init,...half,text,...half,thinkingTokens(),result]),{code:'unexpected_event'});
  assert.throws(()=>decode([init,...Array.from({length:4096},thinkingTokens),result]),{code:'unexpected_result'});
});
test('dogfood retry, thinking, StructuredOutput and rate limit sequence succeeds without extra observer events',()=>{
  const [init,text,result]=transcript();
  const actual=observe([init,systemNotice('api_retry',{attempt:1,max_retries:3,error_status:529,
    retry_delay_ms:1000,error:'private error'}),thinkingTokens(),thinkingTokens(),text,
    assistant([tool('output')]),toolResult('output'),rateLimit(),
    {...result,result:'not JSON: structured_output is authoritative'}]);
  const baseline=observe(transcript());
  assert.deepEqual(actual.result,baseline.result);assert.deepEqual(actual.events,baseline.events);
  assert.deepEqual(actual.notices,[{kind:'claude_system_notice',subtype:'api_retry',attempt:1,max_retries:3,error_status:529},expectedNotice]);
});
test('hook and commands notifications emit only allowlisted summaries at every nonterminal stage',()=>{
  const [init,text,result]=transcript();
  const subtypes=['hook_started','hook_response','commands_changed'];
  const notices=subtypes.map(subtype=>systemNotice(subtype,{hook_name:'SessionStart:fixture',
    output:'private output',stdout:'private stdout',stderr:'private stderr',commands:['private command'],
    error:'private error',unknown:{verdict:'approved'}}));
  const actual=observe([init,notices[0],text,assistant([tool('output')]),notices[1],toolResult('output'),notices[2],result]);
  const baseline=observe(transcript());
  assert.deepEqual(actual.result,baseline.result);assert.deepEqual(actual.events,baseline.events);
  assert.deepEqual(actual.notices,subtypes.map(subtype=>({kind:'claude_system_notice',subtype,hook_name:'SessionStart:fixture'})));
  for(const callback of [()=>{},()=>{throw Error('notice consumer');}]){
    assert.deepEqual(observe([init,...notices,text,result],callback).result,baseline.result);
  }
  assert.deepEqual(decode([init,...notices,text,result]),baseline.result);
  const malformed=observe([init,systemNotice('api_retry',{attempt:{text:'private'},max_retries:['private'],
    error_status:Infinity,hook_name:{stdout:'private'}}),text,result]);
  assert.deepEqual(malformed.notices,[{kind:'claude_system_notice',subtype:'api_retry'}]);
});
test('all system notices retain initialization, session, stage and terminal boundaries',()=>{
  const [init,text,result]=transcript();
  for(const subtype of ['api_retry','hook_started','hook_response','commands_changed']){
    const notice=systemNotice(subtype);
    assert.throws(()=>decode([notice,init,text,result]),{code:'missing_init'});
    assert.throws(()=>decode([init,{...notice,session_id:'other'},text,result]),{code:'session_mismatch'});
    assert.throws(()=>decode([init,{...notice,session_id:''},text,result]),{code:'invalid_session'});
    assert.throws(()=>decode([init,notice,result]),{code:'unexpected_result'});
    assert.throws(()=>decode([init,text,result,notice]),{code:'unexpected_event'});
    assert.throws(()=>decode([init,notice]),{code:'incomplete_result'});
    assert.throws(()=>decode([init,assistant([tool('bad','Bash')]),notice,toolResult('bad'),result]),{code:'unexpected_tool_or_content'});
  }
  for(const subtype of ['future_notice','API_RETRY','init',null,undefined]){
    const notices=[],stream=createClaudeReviewStream(()=>{},n=>notices.push(n));
    stream.accept(init);
    assert.throws(()=>stream.accept({...systemNotice(),subtype}),{code:'unexpected_event'});
    assert.deepEqual(notices,[]);
    assert.throws(()=>stream.accept(systemNotice()),{code:'unexpected_event'});
  }
});
test('rate limit and system notices share exactly 32 slots independent of thinking and callbacks',()=>{
  const [init,text,result]=transcript();
  const kinds=['api_retry','hook_started','hook_response','commands_changed','rate_limit'];
  for(const mixed of [false,true]){
    const notices=Array.from({length:32},(_,i)=>mixed&&i%5===4?rateLimit():systemNotice(kinds[mixed?i%5:i%4]));
    const actual=observe([init,...notices,...Array.from({length:4096},thinkingTokens),text,result]);
    assert.equal(actual.notices.length,32);assert.deepEqual(actual.result,decode(transcript()));
    for(const extra of [rateLimit(),systemNotice()])for(const callbackEnabled of [true,false]){
      const received=[],stream=createClaudeReviewStream(()=>{},callbackEnabled?n=>received.push(n):null);
      [init,...notices,text].forEach(m=>stream.accept(m));
      assert.throws(()=>stream.accept(extra),{code:'unexpected_event'});
      assert.equal(received.length,callbackEnabled?32:0);
      assert.throws(()=>stream.finish(),{code:'incomplete_result'});
    }
  }
});
test('exhausted retries do not decide success or suppress provider failure',()=>{
  const [init,text,result]=transcript();
  for(const attempt of [3,4]){
    const notice=systemNotice('api_retry',{attempt,max_retries:3,error_status:529});
    assert.deepEqual(decode([init,notice,text,result]),decode(transcript()));
    for(const failed of [{...result,subtype:'error_during_execution',is_error:true},{...result,is_error:true}]){
      const notices=[],stream=createClaudeReviewStream(()=>{},n=>notices.push(n));
      [init,notice,text].forEach(m=>stream.accept(m));
      assert.equal(notices.length,1);
      assert.throws(()=>stream.accept(failed),{code:'provider_failed'});
    }
  }
});
