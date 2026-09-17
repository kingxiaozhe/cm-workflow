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
  assert.equal(decode([init,...Array.from({length:64},thinkingTokens),
    assistant([...thoughts.message.content,...text.message.content]),thoughts,result]).status,'succeeded');
  assert.throws(()=>decode([init,thoughts,result]),{code:'unexpected_result'});
  assert.throws(()=>decode([init,...Array.from({length:65},thinkingTokens),text,result]),{code:'unexpected_event'});
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
  for(const structured of [true,false])for(const count of [1,8]){
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
    [Array.from({length:9},()=>rateLimit()),'unexpected_event',8],
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
  for(let i=0;i<8;i++)noCallback.accept(rateLimit());
  assert.throws(()=>noCallback.accept(rateLimit()),{code:'unexpected_event'});
});
