// Which self-check rule a draft is judged under. A reply registered by an
// operation that began before rules were recorded is replayed under rule 1.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {PRD_SELF_CHECK_RULES} from '../runtime/js/cm-prd/self-check.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-rules-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'user');
after(()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));
function specs(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-rules-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'docs'));fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic requirement');
  return {dir,entry:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir}};
}
// A legal T-001 plus a line rule 1 skips and rule 2 rejects.
const reply={status:'draft',summary:'Synthetic',features:[{name:'guide',testCasesReason:'no_observable_behavior',documents:[
  {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Explain setup.'},
  {path:'design.md',content:'## 方案摘要\nDocumentation'},
  {path:'tasks.md',content:'- [ ] T-001: Explain setup\n- [ ] T-002/a: Hidden task'}]}]};
async function planned(t,options={}){
  const {entry}=specs(t);
  const analysis=createCmPrdAnalysis({input:entry,runtime:'codex',record:()=>{},
    analyze:async()=>({status:'analyzed',summary:'Synthetic',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async()=>structuredClone(reply),...options});
  await analysis.advance('Analyze');return analysis.plan('Draft');
}
test('a fresh draft round is judged under rule 2 by default',async t=>{
  const status=await planned(t);
  assert.equal(status.stage,'draft_self_check_failed');
  assert.ok(status.draft.mechanicalSelfCheck.findings.some(item=>item.code==='tasks_invalid'));
});
test('a draft replayed for an operation begun under rule 1 is judged as then',async t=>{
  const status=await planned(t,{selfCheckRules:()=>1});
  assert.equal(status.stage,'draft_ready');
});
test('an operation records its rule; one recorded before rules existed reports rule 1',t=>{
  const {dir,entry}=specs(t);const sessionId='prd-rules-fixture',identity={entry,runtime:'codex'};
  const open=()=>openPrdSession({specs:dir,sessionId,identity});
  let session=open();
  try{assert.equal(session.selfCheckRules(),1);
    session.begin({requestId:'r1',operation:'plan'},null,{selfCheckRules:PRD_SELF_CHECK_RULES});
    assert.equal(session.selfCheckRules(),PRD_SELF_CHECK_RULES);}finally{session.close();}
  session=open();try{assert.equal(session.selfCheckRules(),PRD_SELF_CHECK_RULES);
    assert.equal(session.replay().selfCheckRules,PRD_SELF_CHECK_RULES);}finally{session.close();}
  // The state an older host left: the same operation without the field.
  const file=path.join(dir,'.reviews/prd-sessions',sessionId,'state.json');
  const state=JSON.parse(fs.readFileSync(file,'utf8'));delete state.active.selfCheckRules;
  fs.writeFileSync(file,JSON.stringify(state));
  session=open();try{assert.equal(session.selfCheckRules(),1);assert.equal(session.replay().request.requestId,'r1');}
  finally{session.close();}
});
test('the host binds both draft entries to the operation rule',()=>{
  const host=fs.readFileSync(path.join(root,'scripts/cm-prd-host.mjs'),'utf8');
  assert.match(host,/session\.begin\(request,checkpoint\(\),\{selfCheckRules:PRD_SELF_CHECK_RULES\}\)/);
  assert.equal([...host.matchAll(/selfCheckRules:\(\)=>session\.selfCheckRules\(\)/g)].length,2);
  const change=fs.readFileSync(path.join(root,'runtime/js/cm-prd/change.mjs'),'utf8');
  assert.match(change,/inspectPrdChangeProposal\(state\.before,response,state\.selected,config,\{rules:selfCheckRules\(\)\}\)/);
});
