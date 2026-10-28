// Which self-check rule a draft is judged under. A reply registered by an
// operation that began before rules were recorded is replayed under rule 1.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {openPrdSession,prdSessionVersions} from '../runtime/js/cm-prd/session.mjs';
import {PRD_SELF_CHECK_RULES,PRD_SELF_CHECK_RULE_VERSIONS} from '../runtime/js/cm-prd/self-check.mjs';
import {TASK_GRAMMAR} from '../runtime/js/spec-task-line.mjs';
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
  assert.match(host,/session\.begin\(request,checkpoint\(\),\{selfCheckRules:session\.versions\(\)\.selfCheckRules\}\)/);
  assert.doesNotMatch(host,/PRD_SELF_CHECK_RULES/,'a new operation never re-reads the current rule');
  assert.match(host,/publishPrdAwaitingReview\(\{[^}]*taskGrammar:session\.versions\(\)\.taskGrammar\}\)/);
  const drive=fs.readFileSync(path.join(root,'scripts/cm-prd-drive.mjs'),'utf8');
  assert.match(drive,/ctx\.state\.active\?\.selfCheckRules\?\?1:prdSessionVersions\(ctx\.state\)\.selfCheckRules/);
  assert.equal([...host.matchAll(/selfCheckRules:\(\)=>session\.selfCheckRules\(\)/g)].length,2);
  const change=fs.readFileSync(path.join(root,'runtime/js/cm-prd/change.mjs'),'utf8');
  assert.match(change,/inspectPrdChangeProposal\(state\.before,response,state\.selected,config,\{rules:selfCheckRules\(\)\}\)/);
});

// Design 3.7: a session binds the task grammar and self-check rule when it is created;
// they govern only operations it starts later.
const stateFile=(dir,sessionId)=>path.join(dir,'.reviews/prd-sessions',sessionId,'state.json');
const created=open=>{const session=open();try{session.segment('context_load');}finally{session.close();}};
const edit=(file,change)=>{const state=JSON.parse(fs.readFileSync(file,'utf8'));change(state);fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});};
test('a new session records the current task grammar and self-check rule',t=>{
  const {dir,entry}=specs(t),sessionId='prd-bound-fixture',session=openPrdSession({specs:dir,sessionId,identity:{entry,runtime:'codex'}});
  // Written with the first saved state (nothing is persisted before that).
  try{assert.deepEqual(session.versions(),{taskGrammar:TASK_GRAMMAR,selfCheckRules:PRD_SELF_CHECK_RULES});session.segment('context_load');}
  finally{session.close();}
  const state=JSON.parse(fs.readFileSync(stateFile(dir,sessionId),'utf8'));
  assert.equal(state.taskGrammar,TASK_GRAMMAR);assert.equal(state.selfCheckRules,PRD_SELF_CHECK_RULES);
  assert.deepEqual(prdSessionVersions(null),{taskGrammar:TASK_GRAMMAR,selfCheckRules:PRD_SELF_CHECK_RULES});
});
test('a session created before the fields existed keeps the literal grammar 2 and rule 3, unrewritten',t=>{
  const {dir,entry}=specs(t),sessionId='prd-legacy-fixture',open=()=>openPrdSession({specs:dir,sessionId,identity:{entry,runtime:'codex'}});
  created(open);edit(stateFile(dir,sessionId),state=>{delete state.taskGrammar;delete state.selfCheckRules;});
  const session=open();
  try{assert.deepEqual(session.versions(),{taskGrammar:2,selfCheckRules:3});
    session.begin({requestId:'r1',operation:'plan'},null,{selfCheckRules:session.versions().selfCheckRules});
    assert.equal(session.selfCheckRules(),3);}finally{session.close();}
  const state=JSON.parse(fs.readFileSync(stateFile(dir,sessionId),'utf8'));
  assert.equal(Object.hasOwn(state,'taskGrammar')||Object.hasOwn(state,'selfCheckRules'),false,'an old session is not upgraded');
  assert.deepEqual(prdSessionVersions(state),{taskGrammar:2,selfCheckRules:3});
});
test('an active operation keeps its own rule over the session binding; one without a rule replays rule 1',t=>{
  const {dir,entry}=specs(t),sessionId='prd-active-fixture',open=()=>openPrdSession({specs:dir,sessionId,identity:{entry,runtime:'codex'}});
  let session=open();
  try{session.begin({requestId:'r1',operation:'plan'},null,{selfCheckRules:2});}finally{session.close();}
  session=open();try{assert.equal(session.selfCheckRules(),2);assert.equal(session.versions().selfCheckRules,PRD_SELF_CHECK_RULES);}
  finally{session.close();}
  edit(stateFile(dir,sessionId),state=>{delete state.active.selfCheckRules;});
  session=open();try{assert.equal(session.selfCheckRules(),1);}finally{session.close();}
});
test('a session binding outside the known versions is refused',t=>{
  const {dir,entry}=specs(t),sessionId='prd-invalid-fixture',open=()=>openPrdSession({specs:dir,sessionId,identity:{entry,runtime:'codex'}});
  created(open);
  for(const change of [state=>{delete state.taskGrammar;},state=>{state.taskGrammar=1;},state=>{state.taskGrammar=TASK_GRAMMAR+1;},
    state=>{state.selfCheckRules=PRD_SELF_CHECK_RULES+1;},state=>{state.selfCheckRules='3';}]){
    const file=stateFile(dir,sessionId),bytes=fs.readFileSync(file);edit(file,change);
    assert.throws(open,/prd_session_versions_invalid/);fs.writeFileSync(file,bytes,{mode:0o600});
  }
  open().close();
});
test('the historical rule set lists rule 3 explicitly, so raising the current rule keeps it',()=>{
  for(const rules of [3,2,1,PRD_SELF_CHECK_RULES])assert.ok(PRD_SELF_CHECK_RULE_VERSIONS.includes(rules));
  assert.equal(new Set(PRD_SELF_CHECK_RULE_VERSIONS).size,PRD_SELF_CHECK_RULE_VERSIONS.length);
  const source=fs.readFileSync(path.join(root,'runtime/js/cm-prd/self-check.mjs'),'utf8');
  assert.match(source,/new Set\(\[PRD_SELF_CHECK_RULES,3,2,1\]\)/);
  assert.doesNotMatch(source,/\[PRD_SELF_CHECK_RULES,2,1\]|\[1,2,PRD_SELF_CHECK_RULES\]/);
});
