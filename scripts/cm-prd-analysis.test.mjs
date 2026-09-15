import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('user cases survive generate_cases=false and require coverage and unchanged bytes',async t=>{
  const {dir,input}=fixture(t);input.cases=path.join(dir,'cases.md');
  const content='用户用例：取消后不可保存。';fs.writeFileSync(input.cases,content);
  fs.writeFileSync(path.join(dir,'.cm-workflow.json'),JSON.stringify({version:1,policies:{generate_cases:false}}));
  for(const mode of ['accepted','omitted','changed']){
    const host=createCmPrdAnalysis({input,runtime:'codex',record:async()=>{},analyze:async payload=>{
      assert.equal(payload.generateCases,false);
      assert.equal(payload.sources.userCases.content,content);
      assert.equal(payload.sources.userCases.origin,'user');
      if(mode==='changed')fs.writeFileSync(input.cases,'新用户用例');
      return {status:'analyzed',summary:'Preserve cancellation check',
        sourcePaths:mode==='omitted'?['docs/input.md']:['docs/input.md',input.cases],openQuestions:[]};
    }});
    if(mode==='accepted')assert.equal((await host.advance('Analyze')).stage,'analysis_ready');
    else{await assert.rejects(host.advance('Analyze'));assert.equal(host.status().stage,'blocked');}
  }
});
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-analysis-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic product');
  return {dir,input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir}};
}
test('current host question then analysis retains answers and exact source coverage',async t=>{
  const {dir,input}=fixture(t),events=[];let calls=0;
  const host=createCmPrdAnalysis({input,runtime:'codex',record:async event=>events.push(event),
    analyze:async payload=>{
      calls++;assert.equal(events.length,calls);assert.equal(payload.messages.length,calls===1?1:3);
      assert.equal(payload.sources.sources[0].content,'Synthetic product');
      return calls===1?{status:'question',question:'Who is the user?'}:
        {status:'analyzed',summary:'Developer workflow',sourcePaths:['docs/input.md'],openQuestions:[]};
    }});
  assert.equal((await host.advance('Analyze this need')).stage,'awaiting_user');
  assert.equal((await host.advance('Developers')).stage,'analysis_ready');
  assert.equal(host.status().completionAuthorized,false);
  assert.deepEqual(fs.readdirSync(dir),['docs']);
});
test('invalid config and failed logging never dispatch analysis',async t=>{
  const {dir,input}=fixture(t);let calls=0;
  const analyze=async()=>{calls++;};
  fs.writeFileSync(path.join(dir,'.cm-workflow.json'),'invalid');
  assert.throws(()=>createCmPrdAnalysis({input,runtime:'claude',analyze,record:async()=>{}}));
  fs.unlinkSync(path.join(dir,'.cm-workflow.json'));
  const host=createCmPrdAnalysis({input,runtime:'claude',analyze,record:async()=>{throw Error('log unavailable');}});
  await assert.rejects(host.advance('Analyze'),/log unavailable/);assert.equal(calls,0);
});
test('missing coverage, unprocessed HTML and changed sources cannot reach analysis_ready',async t=>{
  const {dir,input}=fixture(t);
  for(const mode of ['coverage','html','drift']){
    if(mode==='html')fs.writeFileSync(path.join(dir,'docs/prototype.html'),'<button>Save</button>');
    const host=createCmPrdAnalysis({input,runtime:'codex',record:async()=>{},analyze:async()=>{
      if(mode==='drift')fs.writeFileSync(path.join(dir,'docs/input.md'),'New requirements');
      return {status:'analyzed',summary:'Synthetic summary',sourcePaths:mode==='coverage'?[]:
        ['docs/input.md','docs/prototype.html'],openQuestions:[]};
    }});
    await assert.rejects(host.advance('Analyze'));
    assert.equal(host.status().stage,'blocked');
  }
});
