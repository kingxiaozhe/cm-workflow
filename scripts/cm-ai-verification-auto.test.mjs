import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

// Keep runtime declarations and log mirrors independent of the invoking user's home.
const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-verification-auto-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));

// Protected writes and checks run in the native sandbox, as in cm-ai-nested-execution.
const supported=process.platform==='darwin'&&Number(process.versions.node.split('.')[0])>=24;
const identity={repositoryId:'fixture',runId:'auto-run',taskId:'T-001',attempt:1};
const request=operation=>({version:1,operation,requestId:operation,identity});
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled',verification:'auto'};
const TEST="require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'),'new\\n');\n";

async function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-verification-auto-')));
  const codeProject=path.join(root,'code'),specsDir=path.join(codeProject,'specs'),feature='1.demo';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.js'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'Synthetic requirement\n');
  fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'codex'}}));
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# Requirements\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Design\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: 实现 a.js\n  - 范围: `a.js`, `a.test.js`\n  - 测试文件: `a.test.js`\n\n'
    +'## 验证要求\n\n- T-001: RED 必须先失败；全部放入后检查通过。\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['a.js','a.test.js'],requirements:['requirements.md'],
    specification:{specsRoot:specsDir,feature}};
  const protection={checkCommands:[{id:'unit',command:[process.execPath,'a.test.js']}],timeoutMs:5000};
  try{await fn({definition,protection});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const develop=(requirements,test=TEST)=>({async call(kind,payload){
  assert.equal(kind,'develop');
  return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:null},...(requirements===undefined?{}:{requirements})},
    edits:[{path:'a.js',beforeSha256:payload.expected['a.js'],content:'new\n'},{path:'a.test.js',beforeSha256:null,content:test}]};
}});
const run=async(definition,bridge,protection)=>{
  const execution=createConversationExecution(definition,'host',bridge,null,null,null,false,'codex',{protection,controlPolicy:policy});
  const control=await openControlRun(definition,'create',execution);
  try{return await control.host.handle(request('start'));}finally{control.close();}
};
const handoff=definition=>JSON.parse(fs.readFileSync(path.join(definition.specsDir,'.reviews',`${definition.feature.replace(/^\d+\./,'')}-T-001-a1-handoff.json`),'utf8'));

test('auto gate: a failing-first claim the host replay confirms passes, and the handoff carries the host record',
  {skip:!supported},()=>fixture(async({definition,protection})=>{
    const result=await run(definition,develop([{requirement:'T-001: RED 必须先失败',satisfied:true,evidence:'a.test.js 在旧 a.js 下失败'},
      {requirement:'全部放入后检查通过',satisfied:true,evidence:'unit 检查'}]),protection);
    assert.equal(result.state,'awaiting_review',JSON.stringify(result));
    const entries=handoff(definition).evidence;
    assert.match(entries.find(entry=>entry.startsWith('cm-requirement-evidence-v1: ')),/RED 必须先失败/);
    // The host record is its own entry, not one of the developer's items.
    const record=JSON.parse(entries.find(entry=>entry.startsWith('cm-host-replay-v1: ')).slice('cm-host-replay-v1: '.length));
    assert.deepEqual([record.facts.status,record.facts.baseline.outcome,record.facts.red.outcome,record.facts.green.outcome],
      ['replayed','failed','failed','passed']);
    assert.deepEqual(record.identity,{...identity,attempt:1});
    assert.equal(fs.readFileSync(path.join(definition.codeProject,'a.js'),'utf8'),'new\n','the replay never writes the real project');
  }));

test('auto gate: no report from the developer stops before review, with nothing to hand off',
  {skip:!supported},()=>fixture(async({definition,protection})=>{
    const result=await run(definition,develop(undefined),protection);
    assert.equal(result.state,'blocked');assert.equal(result.code,'verification_precheck_failed');
    assert.equal(fs.existsSync(path.join(definition.specsDir,'.reviews',`${definition.feature.replace(/^\d+\./,'')}-T-001-a1-handoff.json`)),false);
  }));

test('auto gate: a failing-first claim the host replay contradicts stops before review',
  {skip:!supported},()=>fixture(async({definition,protection})=>{
    // This test passes with the old a.js too, so the test-files-only run passes.
    const result=await run(definition,develop([{requirement:'T-001: RED 必须先失败',satisfied:true,evidence:'a.test.js'}],
      "process.exit(0);\n"),protection);
    assert.equal(result.state,'blocked');assert.equal(result.code,'verification_precheck_failed');
  }));
