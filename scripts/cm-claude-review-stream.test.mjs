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
    m=>{m[2].num_turns=2;},
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
